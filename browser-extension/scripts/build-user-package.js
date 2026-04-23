#!/usr/bin/env node
/**
 * build-user-package.js
 *
 * Produces a user-facing distribution bundle for preview/beta testers:
 *
 *   kickclip-v1.0.0-prod.zip/
 *   ├── README.md            (Korean install + usage guide, built from template)
 *   └── kickclip-prod.zip    (the actual Chrome extension to load)
 *
 * Steps:
 *   1. Run `npm run build:prod` to refresh dist/kickclip-prod.zip.
 *   2. Read docs/user-install-guide.md template and substitute {{BUILD_DATE}}.
 *   3. Create a wrapper zip containing the rendered README.md + the extension zip.
 *
 * Output: dist/kickclip-v1.0.0-prod.zip
 *
 * Run with: `npm run build:user-package` (from browser-extension/).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');

// ---------- paths ----------
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const GUIDE_TEMPLATE = path.join(REPO_ROOT, 'docs', 'user-install-guide.md');
const EXTENSION_ZIP = path.join(DIST_DIR, 'kickclip-prod.zip');

// ---------- derive version + output name ----------
function readExtensionVersion() {
  const manifestPath = path.join(REPO_ROOT, 'chromium', 'manifest.prod.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('manifest.prod.json has no "version" field');
  }
  return manifest.version;
}

const VERSION = readExtensionVersion();
const WRAPPER_BASENAME = `kickclip-v${VERSION}-prod`;
const WRAPPER_ZIP = path.join(DIST_DIR, `${WRAPPER_BASENAME}.zip`);

// ---------- step 1: refresh kickclip-prod.zip ----------
console.log('Step 1/3: running `npm run build:prod` to refresh extension zip...');
execSync('npm run build:prod', {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

if (!fs.existsSync(EXTENSION_ZIP)) {
  console.error(`ERROR: expected ${EXTENSION_ZIP} after build:prod, but not found.`);
  process.exit(1);
}

// ---------- step 2: render README.md from template ----------
console.log('Step 2/3: rendering README.md from template...');

if (!fs.existsSync(GUIDE_TEMPLATE)) {
  console.error(`ERROR: guide template not found at ${GUIDE_TEMPLATE}`);
  process.exit(1);
}

const template = fs.readFileSync(GUIDE_TEMPLATE, 'utf8');

// YYYY-MM-DD for display; use local time since the guide is end-user facing.
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const buildDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const rendered = template.replaceAll('{{BUILD_DATE}}', buildDate);

if (rendered === template) {
  console.warn('WARNING: template had no {{BUILD_DATE}} placeholder to replace.');
}

// Verify all placeholders (any remaining {{...}}) are filled.
const unfilled = rendered.match(/\{\{[A-Z_]+\}\}/g);
if (unfilled && unfilled.length > 0) {
  console.error(`ERROR: unfilled placeholders remain in rendered guide: ${unfilled.join(', ')}`);
  process.exit(1);
}

// ---------- step 3: create wrapper zip ----------
console.log(`Step 3/3: creating wrapper zip ${WRAPPER_BASENAME}.zip ...`);

fs.mkdirSync(DIST_DIR, { recursive: true });

if (fs.existsSync(WRAPPER_ZIP)) {
  fs.unlinkSync(WRAPPER_ZIP);
}

const output = fs.createWriteStream(WRAPPER_ZIP);
const archive = archiver('zip', { zlib: { level: 9 } });

let finished = false;
output.on('close', () => {
  finished = true;
  const sizeKB = (archive.pointer() / 1024).toFixed(2);
  console.log('');
  console.log('User package build complete.');
  console.log(`Output: ${WRAPPER_ZIP}`);
  console.log(`Size: ${sizeKB} KB`);
  console.log(`Contains:`);
  console.log(`  - README.md (built ${buildDate})`);
  console.log(`  - kickclip-prod.zip (the extension)`);
});

output.on('error', (err) => {
  console.error('ERROR writing wrapper zip:', err);
  process.exit(1);
});

archive.on('warning', (err) => {
  if (err.code === 'ENOENT') {
    console.warn('archiver warning:', err);
  } else {
    throw err;
  }
});

archive.on('error', (err) => {
  console.error('archiver error:', err);
  process.exit(1);
});

archive.pipe(output);

archive.append(rendered, { name: 'README.md' });
archive.file(EXTENSION_ZIP, { name: 'kickclip-prod.zip' });

archive.finalize();

process.on('beforeExit', () => {
  if (!finished) {
    console.error('ERROR: build exited before wrapper zip finished writing.');
    process.exit(1);
  }
});
