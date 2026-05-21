#!/usr/bin/env node
/**
 * Firestore Migration — Remove Legacy Fields
 *
 * Removes three legacy fields from every document under
 * users/{uid}/items/{docId} via batched updates:
 *   - img_url_method (image source method tag — pre-image-pivot legacy)
 *   - saved_by       (clip source marker — pre-Chrome-extension legacy)
 *   - confirmed_type (SNS post/contents distinction — pre-image-pivot legacy)
 *
 * Uses admin.firestore.FieldValue.delete() for each field present.
 * Other fields are not touched.
 *
 * Usage:
 *   node scripts/migrate-remove-legacy-fields.js --project=dev --dry-run
 *   node scripts/migrate-remove-legacy-fields.js --project=dev --execute
 *   node scripts/migrate-remove-legacy-fields.js --project=prod --dry-run
 *   node scripts/migrate-remove-legacy-fields.js --project=prod --execute
 *
 * Safety:
 *   - --dry-run reads only
 *   - --execute waits 10s with countdown for Ctrl+C
 *   - Documents without any of the three fields are skipped
 *   - Uses listDocuments() to capture virtual parent documents
 *   - Batched updates (400 per batch)
 */

import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEGACY_FIELDS = ['img_url_method', 'saved_by', 'confirmed_type'];

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
  ? 'credentials/service-account-dev.json'
  : 'credentials/service-account-prod.json';

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
// Per-document logic
// ──────────────────────────────────────────────────────────────────────────
function fieldsPresent(data) {
  return LEGACY_FIELDS.filter((f) => f in data);
}

function needsUpdate(data) {
  return fieldsPresent(data).length > 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Main migration logic
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const mode = isDryRun ? 'DRY-RUN' : 'EXECUTE';
  console.log('\n──────────────────────────────────────────────────────');
  console.log(`  Remove legacy fields — ${mode} MODE`);
  console.log(`  Project: ${serviceAccount.project_id}`);
  console.log(`  Fields: ${LEGACY_FIELDS.join(', ')}`);
  console.log('──────────────────────────────────────────────────────\n');

  const userRefs = await db.collection('users').listDocuments();
  console.log(`Found ${userRefs.length} users (including virtual documents)\n`);

  let totalItemsScanned = 0;
  let totalItemsToUpdate = 0;
  const updatePlan = [];

  for (const userRef of userRefs) {
    const userId = userRef.id;
    const itemsSnapshot = await userRef.collection('items').get();

    totalItemsScanned += itemsSnapshot.size;

    for (const itemDoc of itemsSnapshot.docs) {
      const data = itemDoc.data();
      if (!needsUpdate(data)) continue;

      const present = fieldsPresent(data);

      totalItemsToUpdate++;
      updatePlan.push({
        userId,
        docId: itemDoc.id,
        url: data.url || '(no url)',
        title: (data.title || '').slice(0, 50),
        fieldsToRemove: present,
      });
    }
  }

  console.log(`Scanned: ${totalItemsScanned} items`);
  console.log(`To update: ${totalItemsToUpdate} items (at least one legacy field present)`);
  console.log(
    `To skip (no legacy fields): ${totalItemsScanned - totalItemsToUpdate} items\n`
  );

  if (totalItemsToUpdate === 0) {
    console.log('✅ No documents need updating. Migration complete (no-op).\n');
    process.exit(0);
  }

  const removalSummary = { img_url_method: 0, saved_by: 0, confirmed_type: 0 };
  for (const item of updatePlan) {
    for (const f of item.fieldsToRemove) {
      removalSummary[f]++;
    }
  }

  console.log('Field removal summary:');
  console.log(`  img_url_method: ${removalSummary.img_url_method} documents`);
  console.log(`  saved_by:       ${removalSummary.saved_by} documents`);
  console.log(`  confirmed_type: ${removalSummary.confirmed_type} documents`);
  console.log('');

  console.log('Migration plan (first 20 shown):');
  console.log('──────────────────────────────────────────────────────');
  updatePlan.slice(0, 20).forEach((item, i) => {
    console.log(`[${i + 1}] ${item.userId.slice(0, 8)}.../${item.docId.slice(0, 8)}...`);
    console.log(`    ${item.title || '(no title)'}`);
    console.log(`    ${String(item.url).slice(0, 80)}`);
    console.log(`    fieldsToRemove: [${item.fieldsToRemove.join(', ')}]`);
    console.log('');
  });
  if (updatePlan.length > 20) {
    console.log(`  ... and ${updatePlan.length - 20} more\n`);
  }

  if (isDryRun) {
    console.log('🟡 DRY-RUN complete — no changes written.');
    console.log('To apply changes, re-run with --execute instead of --dry-run.\n');
    process.exit(0);
  }

  console.log('⚠️  EXECUTE MODE — Firestore will be modified.');
  console.log(`Writing field deletions to ${totalItemsToUpdate} documents in project ${serviceAccount.project_id}.`);
  console.log('Press Ctrl+C within 10 seconds to cancel.\n');

  for (let i = 10; i > 0; i--) {
    process.stdout.write(`\r  Starting in ${i}s... `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write('\r  Starting migration now.                  \n\n');

  const BATCH_SIZE = 400;
  let batch = db.batch();
  let inBatch = 0;
  let totalWritten = 0;

  for (const item of updatePlan) {
    const ref = db.doc(`users/${item.userId}/items/${item.docId}`);
    const updatePayload = {};
    for (const f of item.fieldsToRemove) {
      updatePayload[f] = admin.firestore.FieldValue.delete();
    }
    batch.update(ref, updatePayload);
    inBatch++;

    if (inBatch >= BATCH_SIZE) {
      await batch.commit();
      totalWritten += inBatch;
      console.log(`  Committed batch: ${totalWritten}/${updatePlan.length}`);
      batch = db.batch();
      inBatch = 0;
    }
  }

  if (inBatch > 0) {
    await batch.commit();
    totalWritten += inBatch;
    console.log(`  Committed batch: ${totalWritten}/${updatePlan.length}`);
  }

  console.log(`\n✅ Migration complete. ${totalWritten} documents updated.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
