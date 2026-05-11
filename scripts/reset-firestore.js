#!/usr/bin/env node
/**
 * Firestore + Firebase Auth Reset — Fresh start for KickClip re-submission
 *
 * Deletes all user data from a KickClip Firebase project's Firestore
 * (top-level users/ collection plus all nested subcollections) and
 * Firebase Authentication, preserving exactly one specified user UID
 * (the developer's own account, for ongoing testing).
 *
 * Usage:
 *   node scripts/reset-firestore.js --project=dev --keep-user=<uid> --dry-run
 *   node scripts/reset-firestore.js --project=dev --keep-user=<uid> --execute
 *   node scripts/reset-firestore.js --project=prod --keep-user=<uid> --dry-run
 *   node scripts/reset-firestore.js --project=prod --keep-user=<uid> --execute
 *
 * Safety:
 *   - --dry-run mode reads only, produces a plan without writing
 *   - --execute mode writes, but waits 10 seconds with a countdown for Ctrl+C
 *   - The specified --keep-user is preserved in both Firestore (the user
 *     doc itself is left untouched; nested subcollections under it are
 *     not touched) and Firebase Auth
 *   - All other users are fully deleted: nested subcollections discovered
 *     dynamically via listCollections(), then the user doc, then the
 *     Auth account
 *   - Uses listDocuments() instead of get() on users/ collection so that
 *     virtual parent documents (where only subcollections exist) are
 *     captured
 *   - Firestore batch writes used for subcollection doc deletion
 *
 * Authentication:
 *   Uses server/service-account-<project>.json (the existing service
 *   account files already in the repo, matching migrate-schema.js's
 *   pattern).
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
const keepUserFlag = args.find((a) => a.startsWith('--keep-user='));
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

if (!keepUserFlag) {
  console.error('ERROR: --keep-user=<uid> is required (the user to preserve)');
  process.exit(1);
}

const keepUserUid = keepUserFlag.split('=')[1];
if (!keepUserUid) {
  console.error('ERROR: --keep-user value is empty');
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
const auth = admin.auth();

// ──────────────────────────────────────────────────────────────────────────
// Firestore reset planning + execution
// ──────────────────────────────────────────────────────────────────────────
async function collectNestedDocumentPaths(docRef, paths = []) {
  const subcollections = await docRef.listCollections();

  for (const subcollection of subcollections) {
    // Use listDocuments() so virtual documents are included in deeper levels too.
    const childDocRefs = await subcollection.listDocuments();
    for (const childDocRef of childDocRefs) {
      await collectNestedDocumentPaths(childDocRef, paths);
      paths.push(childDocRef.path);
    }
  }

  return paths;
}

async function planFirestoreReset() {
  // Use listDocuments() to capture virtual parent docs (matches
  // migrate-schema.js).
  const userRefs = await db.collection('users').listDocuments();
  const plan = {
    usersTotal: userRefs.length,
    usersToDelete: [],
    usersToKeep: [],
    // Each entry of usersToDelete:
    //   { uid, label, subcollectionDocPaths: [...] }
  };

  for (const userRef of userRefs) {
    const uid = userRef.id;
    let label = uid;

    try {
      const snap = await userRef.get();
      if (snap.exists) {
        const data = snap.data() || {};
        label = data.email || data.displayName || uid;
      } else {
        label = `${uid} (virtual)`;
      }
    } catch {
      label = `${uid} (read error)`;
    }

    if (uid === keepUserUid) {
      plan.usersToKeep.push({ uid, label });
      continue;
    }

    const subcollectionDocPaths = await collectNestedDocumentPaths(userRef);

    plan.usersToDelete.push({
      uid,
      label,
      subcollectionDocPaths,
    });
  }

  return plan;
}

async function executeFirestoreReset(plan) {
  let totalDocsDeleted = 0;
  let totalUsersDeleted = 0;

  for (const user of plan.usersToDelete) {
    // Firestore batch limit is 500 operations per batch.
    const BATCH_SIZE = 400;
    let batch = db.batch();
    let inBatch = 0;

    for (const docPath of user.subcollectionDocPaths) {
      batch.delete(db.doc(docPath));
      inBatch++;

      if (inBatch >= BATCH_SIZE) {
        try {
          await batch.commit();
          totalDocsDeleted += inBatch;
        } catch (e) {
          console.error(`  [BATCH ERROR] user ${user.uid}: ${e.message}`);
        }
        batch = db.batch();
        inBatch = 0;
      }
    }

    if (inBatch > 0) {
      try {
        await batch.commit();
        totalDocsDeleted += inBatch;
      } catch (e) {
        console.error(`  [BATCH ERROR] user ${user.uid}: ${e.message}`);
      }
    }

    // Delete the user doc itself (safe even if it is virtual / missing).
    try {
      await db.collection('users').doc(user.uid).delete();
      totalUsersDeleted++;
      console.log(
        `  [DELETED] user ${user.uid} (${user.label}) + ` +
        `${user.subcollectionDocPaths.length} nested docs`
      );
    } catch (e) {
      console.error(`  [ERROR] deleting user ${user.uid}: ${e.message}`);
    }
  }

  return { totalDocsDeleted, totalUsersDeleted };
}

// ──────────────────────────────────────────────────────────────────────────
// Auth reset planning + execution
// ──────────────────────────────────────────────────────────────────────────
async function planAuthReset() {
  const plan = {
    usersTotal: 0,
    usersToDelete: [],
    usersToKeep: [],
  };

  let pageToken;
  do {
    const list = await auth.listUsers(1000, pageToken);
    plan.usersTotal += list.users.length;

    for (const user of list.users) {
      const label = user.email || user.displayName || user.uid;

      if (user.uid === keepUserUid) {
        plan.usersToKeep.push({ uid: user.uid, label });
      } else {
        plan.usersToDelete.push({ uid: user.uid, label });
      }
    }

    pageToken = list.pageToken;
  } while (pageToken);

  return plan;
}

async function executeAuthReset(plan) {
  let deleted = 0;

  for (const user of plan.usersToDelete) {
    try {
      await auth.deleteUser(user.uid);
      deleted++;
      console.log(`  [DELETED] auth user ${user.uid} (${user.label})`);
    } catch (e) {
      console.error(`  [ERROR] deleting auth user ${user.uid}: ${e.message}`);
    }
  }

  return deleted;
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const mode = isDryRun ? 'DRY-RUN' : 'EXECUTE';
  console.log('\n──────────────────────────────────────────────────────');
  console.log(`  KickClip Firestore + Auth Reset — ${mode} MODE`);
  console.log(`  Project:     ${serviceAccount.project_id}`);
  console.log(`  Keep UID:    ${keepUserUid}`);
  console.log('──────────────────────────────────────────────────────\n');

  // ───── Firestore planning ─────
  console.log('Scanning Firestore...');
  const firestorePlan = await planFirestoreReset();
  const totalSubcollectionDocs = firestorePlan.usersToDelete.reduce(
    (sum, user) => sum + user.subcollectionDocPaths.length, 0
  );

  console.log('\nFirestore plan:');
  console.log(`  Total users found:             ${firestorePlan.usersTotal}`);
  console.log(`  Users to delete:               ${firestorePlan.usersToDelete.length}`);
  console.log(`  Users to keep:                 ${firestorePlan.usersToKeep.length}`);
  console.log(`  Nested docs to delete:         ${totalSubcollectionDocs}`);

  if (firestorePlan.usersToKeep.length > 0) {
    console.log('  Kept users:');
    for (const user of firestorePlan.usersToKeep) {
      console.log(`    - ${user.uid} (${user.label})`);
    }
  }

  console.log('  Users to delete (first 20 shown):');
  for (const user of firestorePlan.usersToDelete.slice(0, 20)) {
    console.log(`    - ${user.uid} (${user.label}) [${user.subcollectionDocPaths.length} nested docs]`);
  }

  if (firestorePlan.usersToDelete.length > 20) {
    console.log(`    ... and ${firestorePlan.usersToDelete.length - 20} more\n`);
  } else {
    console.log('');
  }

  // ───── Auth planning ─────
  console.log('Scanning Firebase Auth...');
  const authPlan = await planAuthReset();

  console.log('\nAuth plan:');
  console.log(`  Total auth users found:        ${authPlan.usersTotal}`);
  console.log(`  Users to delete:               ${authPlan.usersToDelete.length}`);
  console.log(`  Users to keep:                 ${authPlan.usersToKeep.length}`);

  if (authPlan.usersToKeep.length > 0) {
    console.log('  Kept auth users:');
    for (const user of authPlan.usersToKeep) {
      console.log(`    - ${user.uid} (${user.label})`);
    }
  }

  console.log('  Auth users to delete (first 20 shown):');
  for (const user of authPlan.usersToDelete.slice(0, 20)) {
    console.log(`    - ${user.uid} (${user.label})`);
  }

  if (authPlan.usersToDelete.length > 20) {
    console.log(`    ... and ${authPlan.usersToDelete.length - 20} more\n`);
  } else {
    console.log('');
  }

  // ───── Dry-run exit ─────
  if (isDryRun) {
    console.log('🟡 DRY-RUN complete — no changes written.');
    console.log('To apply changes, re-run with --execute instead of --dry-run.\n');
    process.exit(0);
  }

  // ───── Confirmation countdown ─────
  console.log('⚠️  EXECUTE MODE — Firestore and Auth will be modified.');
  console.log(`Project: ${serviceAccount.project_id}`);
  console.log('Press Ctrl+C within 10 seconds to cancel.\n');

  for (let i = 10; i > 0; i--) {
    process.stdout.write(`\r  Starting in ${i}s... `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  process.stdout.write('\r  Starting reset now.                       \n\n');

  // ───── Execute Firestore reset ─────
  console.log('=== Executing Firestore reset ===');
  const firestoreResult = await executeFirestoreReset(firestorePlan);
  console.log('\nFirestore reset summary:');
  console.log(`  Users deleted:              ${firestoreResult.totalUsersDeleted}`);
  console.log(`  Nested docs deleted:        ${firestoreResult.totalDocsDeleted}\n`);

  // ───── Execute Auth reset ─────
  console.log('=== Executing Auth reset ===');
  const authDeleted = await executeAuthReset(authPlan);
  console.log('\nAuth reset summary:');
  console.log(`  Users deleted:              ${authDeleted}\n`);

  console.log('✅ Reset complete.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Reset failed:', err);
  process.exit(1);
});
