#!/usr/bin/env node
/**
 * Backfill users/{uid} Firestore documents with profile fields from
 * Firebase Auth metadata. Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node server/scripts/backfill-user-profiles.js --project dev [--dry-run] [--limit N] [--yes]
 *   node server/scripts/backfill-user-profiles.js --project prod [--dry-run] [--limit N] [--yes]
 *
 * Flags:
 *   --project dev|prod    Required. Selects which service account to use.
 *   --dry-run             Show planned changes without writing.
 *   --limit N             Process only first N users (for testing).
 *   --yes                 Skip the confirmation prompt.
 *
 * Behavior:
 *   - Iterates all Firebase Auth users via admin.auth().listUsers()
 *   - For each user, reads users/{uid} from Firestore
 *   - Builds profile fields from Auth metadata:
 *       uid, email, displayName, photoURL, emailVerified, provider,
 *       createdAt (from Auth.metadata.creationTime),
 *       lastLoginAt (from Auth.metadata.lastSignInTime or creationTime)
 *   - Writes with { merge: true }:
 *       - Existing fields are updated to latest Auth values
 *       - Missing fields are added
 *       - createdAt is preserved if document already has it (merge behavior)
 *   - Logs each user's action: created | updated | unchanged | error
 *   - Prints summary at the end.
 *
 * Security:
 *   Uses Firebase Admin SDK with service account credentials. Reads/writes
 *   with admin privileges, bypassing Firestore security rules. Handle
 *   service account JSON files carefully — never commit them.
 *
 * Note: server/package.json uses "type": "module"; this file uses ESM syntax.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = {
    project: null,
    dryRun: false,
    limit: null,
    yes: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--yes') {
      args.yes = true;
    } else if (arg === '--project') {
      args.project = argv[++i];
    } else if (arg === '--limit') {
      args.limit = parseInt(argv[++i], 10);
    } else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  if (!args.project || !['dev', 'prod'].includes(args.project)) {
    console.error('ERROR: --project dev|prod is required');
    console.error('Usage: node backfill-user-profiles.js --project dev|prod [--dry-run] [--limit N] [--yes]');
    process.exit(1);
  }
  if (args.limit !== null && (isNaN(args.limit) || args.limit < 1)) {
    console.error('ERROR: --limit must be a positive integer');
    process.exit(1);
  }
  return args;
}

async function confirm(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${message} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

function buildProfileFields(userRecord) {
  const creationTimeMs = userRecord.metadata?.creationTime
    ? new Date(userRecord.metadata.creationTime).getTime()
    : null;
  const lastSignInMs = userRecord.metadata?.lastSignInTime
    ? new Date(userRecord.metadata.lastSignInTime).getTime()
    : null;

  const createdAt = creationTimeMs
    ? admin.firestore.Timestamp.fromMillis(creationTimeMs)
    : admin.firestore.FieldValue.serverTimestamp();

  // lastLoginAt falls back to creationTime if no sign-in history
  const lastLoginAt = lastSignInMs
    ? admin.firestore.Timestamp.fromMillis(lastSignInMs)
    : creationTimeMs
      ? admin.firestore.Timestamp.fromMillis(creationTimeMs)
      : admin.firestore.FieldValue.serverTimestamp();

  return {
    uid: userRecord.uid,
    email: userRecord.email || null,
    displayName: userRecord.displayName || null,
    photoURL: userRecord.photoURL || null,
    emailVerified: !!userRecord.emailVerified,
    provider: userRecord.providerData?.[0]?.providerId || 'google.com',
    createdAt,
    lastLoginAt,
  };
}

function shouldUpdate(existingData, newFields) {
  // Determine if any field differs (ignoring createdAt since merge preserves it)
  if (!existingData) return { update: true, reason: 'document does not exist' };

  const scalarKeys = ['uid', 'email', 'displayName', 'photoURL', 'emailVerified', 'provider'];
  const diffs = [];
  for (const key of scalarKeys) {
    const existing = existingData[key] ?? null;
    const incoming = newFields[key] ?? null;
    if (existing !== incoming) {
      diffs.push(`${key}: ${JSON.stringify(existing)} → ${JSON.stringify(incoming)}`);
    }
  }
  if (existingData.createdAt === undefined) {
    diffs.push('createdAt: missing → will be set');
  }
  // lastLoginAt is always updated (it's the point of this field), so don't
  // count it as a reason to skip
  if (diffs.length === 0) {
    return { update: false, reason: 'all fields up-to-date' };
  }
  return { update: true, reason: diffs.join('; ') };
}

async function main() {
  const args = parseArgs(process.argv);

  const projectId = args.project === 'dev' ? 'saveurl-a8593' : 'saveurl-prod';
  const serviceAccountPath = path.resolve(
    __dirname,
    '..',
    args.project === 'dev' ? 'service-account-dev.json' : 'service-account-prod.json'
  );

  if (!fs.existsSync(serviceAccountPath)) {
    console.error(`ERROR: service account file not found: ${serviceAccountPath}`);
    process.exit(1);
  }

  console.log('========================================');
  console.log('Backfill User Profiles');
  console.log('========================================');
  console.log(`Project: ${args.project} (${projectId})`);
  console.log(`Service account: ${serviceAccountPath}`);
  console.log(`Dry run: ${args.dryRun}`);
  console.log(`Limit: ${args.limit || 'no limit (all users)'}`);
  console.log('========================================');

  if (!args.dryRun && !args.yes) {
    const confirmed = await confirm(
      `This will modify Firestore in ${args.project.toUpperCase()} project. Continue?`
    );
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId,
  });

  const db = admin.firestore();

  const stats = {
    total: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
  };

  let nextPageToken = undefined;
  let processed = 0;
  const limit = args.limit;

  console.log('\nStarting iteration...\n');

  try {
    do {
      const listResult = await admin.auth().listUsers(1000, nextPageToken);
      for (const userRecord of listResult.users) {
        if (limit !== null && processed >= limit) break;
        stats.total += 1;
        processed += 1;

        const uid = userRecord.uid;
        const email = userRecord.email || '(no email)';
        const userRef = db.collection('users').doc(uid);

        try {
          const docSnap = await userRef.get();
          const existingData = docSnap.exists ? docSnap.data() : null;
          const newFields = buildProfileFields(userRecord);
          const decision = shouldUpdate(existingData, newFields);

          const action = docSnap.exists
            ? decision.update
              ? 'UPDATE'
              : 'SKIP'
            : 'CREATE';

          if (action === 'SKIP') {
            stats.unchanged += 1;
            console.log(`[${stats.total}] ${action} ${uid} (${email}) — ${decision.reason}`);
            continue;
          }

          console.log(`[${stats.total}] ${action} ${uid} (${email})`);
          console.log(`    reason: ${decision.reason}`);

          if (!args.dryRun) {
            await userRef.set(newFields, { merge: true });
            if (action === 'CREATE') stats.created += 1;
            else stats.updated += 1;
          } else {
            if (action === 'CREATE') stats.created += 1;
            else stats.updated += 1;
          }
        } catch (err) {
          stats.errors += 1;
          console.error(`[${stats.total}] ERROR for ${uid} (${email}):`, err.message);
        }
      }
      if (limit !== null && processed >= limit) break;
      nextPageToken = listResult.pageToken;
    } while (nextPageToken);
  } catch (err) {
    console.error('FATAL iteration error:', err);
    stats.errors += 1;
  }

  console.log('\n========================================');
  console.log('Summary');
  console.log('========================================');
  console.log(`Project: ${args.project} (${projectId})`);
  console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Total users examined: ${stats.total}`);
  console.log(`Created (new docs): ${stats.created}`);
  console.log(`Updated (existing docs): ${stats.updated}`);
  console.log(`Unchanged (skipped): ${stats.unchanged}`);
  console.log(`Errors: ${stats.errors}`);
  console.log('========================================');

  if (stats.errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
