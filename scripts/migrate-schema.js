#!/usr/bin/env node
/**
 * Firestore Schema Migration — Legacy → New Taxonomy
 *
 * Maps legacy category/confirmed_type fields to the new 4-category taxonomy:
 *   Categories: SNS, Image, Mail, Page
 *   SNS confirmedType: 'contents' or 'post' (lowercase)
 *   Image/Mail/Page confirmedType: '' (empty)
 *
 * Usage:
 *   node scripts/migrate-schema.js --project=dev --dry-run
 *   node scripts/migrate-schema.js --project=dev --execute
 *   node scripts/migrate-schema.js --project=prod --dry-run
 *   node scripts/migrate-schema.js --project=prod --execute
 *
 * Safety:
 *   - --dry-run mode reads only, produces a plan without writing
 *   - --execute mode writes, but waits 10 seconds with a countdown for Ctrl+C
 *   - Documents already in new schema are skipped (no-op)
 *   - Only category and confirmed_type fields are modified; all other fields
 *     (url, img_url, img_url_method, createdAt, etc.) are untouched
 *   - Uses Firestore batch writes for atomicity
 *   - Uses listDocuments() to find virtual/non-existent parent documents
 *     (users where only subcollections exist but the user doc itself
 *     was never created as a real document)
 */

import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ──────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const projectFlag = args.find((a) => a.startsWith('--project='));
const isDryRun = args.includes('--dry-run');
const isExecute = args.includes('--execute');

if (!projectFlag) {
  console.error('ERROR: --project=dev or --project=prod is required');
  process.exit(1);
}

const project = projectFlag.split('=')[1];
if (project !== 'dev' && project !== 'prod') {
  console.error(`ERROR: Invalid --project value: "${project}". Must be "dev" or "prod".`);
  process.exit(1);
}

if (!isDryRun && !isExecute) {
  console.error('ERROR: Must specify either --dry-run (safe) or --execute (writes)');
  process.exit(1);
}

if (isDryRun && isExecute) {
  console.error('ERROR: Cannot specify both --dry-run and --execute');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────
// Firebase Admin SDK initialization
// ──────────────────────────────────────────────────────────────────────────
const serviceAccountFile = project === 'dev'
  ? 'server/service-account-dev.json'
  : 'server/service-account-prod.json';

const serviceAccountPath = path.resolve(__dirname, '..', serviceAccountFile);

if (!fs.existsSync(serviceAccountPath)) {
  console.error(`ERROR: Service account key not found at ${serviceAccountPath}`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
const expectedProjectId = project === 'dev' ? 'saveurl-a8593' : 'saveurl-prod';

if (serviceAccount.project_id !== expectedProjectId) {
  console.error(
    `ERROR: Service account project_id mismatch. ` +
    `File has "${serviceAccount.project_id}", expected "${expectedProjectId}".`
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

const db = admin.firestore();

// ──────────────────────────────────────────────────────────────────────────
// Normalization logic — MUST match sidepanel.js's normalizeItemCategoryAndType
// ──────────────────────────────────────────────────────────────────────────
function normalizeCategoryAndType(rawCategory, rawType) {
  const cat = (rawCategory || '').trim();
  const type = (rawType || '').trim();

  // Legacy 'Contents' → Image (if Image confirmed_type) or Page (anything else)
  if (cat === 'Contents') {
    if (type === 'Image') return { category: 'Image', confirmed_type: '' };
    return { category: 'Page', confirmed_type: '' };
  }

  // SNS: normalize confirmedType to 'contents' or 'post'
  if (cat === 'SNS') {
    if (type === 'Image' || type === 'Video' || type === 'contents') {
      return { category: 'SNS', confirmed_type: 'contents' };
    }
    return { category: 'SNS', confirmed_type: 'post' };
  }

  // Image, Mail, Page, or anything else — return as-is
  // Make sure confirmed_type is '' for non-SNS new schema categories
  if (cat === 'Image' || cat === 'Mail' || cat === 'Page') {
    return { category: cat, confirmed_type: '' };
  }

  // Unknown category — leave both as-is (do not modify)
  return { category: cat, confirmed_type: type, _skip: true };
}

function needsUpdate(existing, normalized) {
  if (normalized._skip) return false;
  const existingCategory = (existing.category || '').trim();
  const existingType = (existing.confirmed_type || '').trim();
  return (
    existingCategory !== normalized.category ||
    existingType !== normalized.confirmed_type
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Main migration logic
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const mode = isDryRun ? 'DRY-RUN' : 'EXECUTE';
  console.log('\n──────────────────────────────────────────────────────');
  console.log(`  Firestore Schema Migration — ${mode} MODE`);
  console.log(`  Project: ${serviceAccount.project_id}`);
  console.log('──────────────────────────────────────────────────────\n');

  // ────── Step 1: List all users (including virtual documents) ──────
  // Using listDocuments() instead of .get() — this captures parent docs
  // that don't exist as actual documents but have subcollections beneath them.
  // Firestore creates such "virtual documents" when you write to
  // users/{userId}/items/... without ever writing to users/{userId} itself.
  const userRefs = await db.collection('users').listDocuments();
  console.log(`Found ${userRefs.length} users (including virtual documents)\n`);

  let totalItemsScanned = 0;
  let totalItemsToUpdate = 0;
  const updatePlan = []; // { userId, docId, before, after }

  // ────── Step 2: Scan all items under every user ──────
  for (const userRef of userRefs) {
    const userId = userRef.id;
    const itemsSnapshot = await userRef.collection('items').get();

    totalItemsScanned += itemsSnapshot.size;

    for (const itemDoc of itemsSnapshot.docs) {
      const data = itemDoc.data();
      const rawCategory = data.category;
      const rawType = data.confirmed_type;

      const normalized = normalizeCategoryAndType(rawCategory, rawType);

      if (!needsUpdate(data, normalized)) continue;

      totalItemsToUpdate++;
      updatePlan.push({
        userId,
        docId: itemDoc.id,
        url: data.url || '(no url)',
        title: (data.title || '').slice(0, 50),
        before: {
          category: rawCategory ?? '(unset)',
          confirmed_type: rawType ?? '(unset)',
        },
        after: {
          category: normalized.category,
          confirmed_type: normalized.confirmed_type,
        },
      });
    }
  }

  // ────── Step 3: Print migration plan ──────
  console.log(`Scanned: ${totalItemsScanned} items`);
  console.log(`To update: ${totalItemsToUpdate} items`);
  console.log(`To skip (already in new schema or unknown): ${totalItemsScanned - totalItemsToUpdate} items\n`);

  if (totalItemsToUpdate === 0) {
    console.log('✅ No documents need updating. Migration complete (no-op).\n');
    process.exit(0);
  }

  console.log('Migration plan (first 20 shown):');
  console.log('──────────────────────────────────────────────────────');
  updatePlan.slice(0, 20).forEach((item, i) => {
    console.log(`[${i + 1}] ${item.userId.slice(0, 8)}.../${item.docId.slice(0, 8)}...`);
    console.log(`    ${item.title || '(no title)'}`);
    console.log(`    ${item.url.slice(0, 80)}`);
    console.log(
      `    BEFORE: category="${item.before.category}", confirmed_type="${item.before.confirmed_type}"`
    );
    console.log(
      `    AFTER:  category="${item.after.category}", confirmed_type="${item.after.confirmed_type}"`
    );
    console.log('');
  });
  if (updatePlan.length > 20) {
    console.log(`  ... and ${updatePlan.length - 20} more\n`);
  }

  // ────── Step 4: Dry-run exit ──────
  if (isDryRun) {
    console.log('🟡 DRY-RUN complete — no changes written.');
    console.log(`To apply changes, re-run with --execute instead of --dry-run.\n`);
    process.exit(0);
  }

  // ────── Step 5: Confirmation countdown (execute mode) ──────
  console.log('⚠️  EXECUTE MODE — Firestore will be modified.');
  console.log(`Writing ${totalItemsToUpdate} updates to project ${serviceAccount.project_id}.`);
  console.log('Press Ctrl+C within 10 seconds to cancel.\n');

  for (let i = 10; i > 0; i--) {
    process.stdout.write(`\r  Starting in ${i}s... `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write('\r  Starting migration now.                  \n\n');

  // ────── Step 6: Execute batch writes ──────
  // Firestore batch limit is 500 operations per batch.
  const BATCH_SIZE = 400;
  let batch = db.batch();
  let inBatch = 0;
  let totalWritten = 0;

  for (const item of updatePlan) {
    const ref = db.doc(`users/${item.userId}/items/${item.docId}`);
    batch.update(ref, {
      category: item.after.category,
      confirmed_type: item.after.confirmed_type,
    });
    inBatch++;

    if (inBatch >= BATCH_SIZE) {
      await batch.commit();
      totalWritten += inBatch;
      console.log(`  Committed batch: ${totalWritten}/${totalItemsToUpdate}`);
      batch = db.batch();
      inBatch = 0;
    }
  }

  if (inBatch > 0) {
    await batch.commit();
    totalWritten += inBatch;
    console.log(`  Committed batch: ${totalWritten}/${totalItemsToUpdate}`);
  }

  console.log(`\n✅ Migration complete. ${totalWritten} documents updated.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});