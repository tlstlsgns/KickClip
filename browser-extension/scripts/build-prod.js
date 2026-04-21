/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const repoRoot = path.resolve(__dirname, '..', '..');
const extensionRoot = path.join(repoRoot, 'browser-extension');
const srcDir = path.join(extensionRoot, 'chromium');
const distDir = path.join(extensionRoot, 'dist');
const outDir = path.join(distDir, 'prod');
const zipPath = path.join(distDir, 'kickclip-prod.zip');

const excludedBasenames = new Set([
  'manifest.json',
  'manifest.dev.json',
  'manifest.prod.json',
  'config.js',
  'config.dev.js',
  'config.prod.js',
  '.DS_Store',
]);

function shouldExclude(entryName) {
  if (entryName.startsWith('.')) return true;
  return excludedBasenames.has(entryName);
}

function removePreviousOutputs() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fallbackCopyRecursive(src, dest) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldExclude(entry.name)) continue;
      const entrySrc = path.join(src, entry.name);
      const entryDest = path.join(dest, entry.name);
      fallbackCopyRecursive(entrySrc, entryDest);
    }
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copySource() {
  ensureDir(outDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(outDir, entry.name);
    fallbackCopyRecursive(from, to);
  }
}

function writeProdManifest() {
  const prodManifestPath = path.join(srcDir, 'manifest.prod.json');
  const outManifestPath = path.join(outDir, 'manifest.json');
  const manifestContent = fs.readFileSync(prodManifestPath, 'utf8');
  fs.writeFileSync(outManifestPath, manifestContent, 'utf8');
}

function writeProdConfig() {
  const prodConfigPath = path.join(srcDir, 'config.prod.js');
  const outConfigPath = path.join(outDir, 'config.js');
  const content = fs.readFileSync(prodConfigPath, 'utf8');
  fs.writeFileSync(outConfigPath, content, 'utf8');

  const written = fs.readFileSync(outConfigPath, 'utf8');
  if (!written.includes('const KC_IS_DEV = false;')) {
    console.error('ERROR: dist/prod/config.js must contain `const KC_IS_DEV = false;` after writeProdConfig');
    process.exit(1);
  }
}

function warnIfPlaceholdersRemain() {
  const outManifestPath = path.join(outDir, 'manifest.json');
  const manifestContent = fs.readFileSync(outManifestPath, 'utf8');
  const hasProdKeyPlaceholder = manifestContent.includes('__PROD_KEY_PLACEHOLDER__');
  const hasProdOauthPlaceholder = manifestContent.includes(
    '__PROD_OAUTH_CLIENT_ID_PLACEHOLDER__'
  );

  if (hasProdKeyPlaceholder || hasProdOauthPlaceholder) {
    console.warn('⚠️  WARNING: manifest.prod.json still contains placeholder values.');
    console.warn('    The built extension will NOT be able to authenticate until you');
    console.warn('    replace __PROD_KEY_PLACEHOLDER__ and __PROD_OAUTH_CLIENT_ID_PLACEHOLDER__');
    console.warn('    with real values. See browser-extension/BUILD.md for instructions.');
  }
}

function countFilesRecursive(dirPath) {
  let count = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      count += countFilesRecursive(fullPath);
    } else {
      count += 1;
    }
  }
  return count;
}

function createZip() {
  return new Promise((resolve, reject) => {
    ensureDir(distDir);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(outDir, false);
    archive.finalize();
  });
}

async function main() {
  removePreviousOutputs();
  copySource();
  writeProdManifest();
  writeProdConfig();
  warnIfPlaceholdersRemain();
  await createZip();

  const fileCount = countFilesRecursive(outDir);
  const zipBytes = fs.statSync(zipPath).size;
  const zipKb = (zipBytes / 1024).toFixed(2);

  console.log('');
  console.log('Build complete.');
  console.log(`Output directory: ${outDir}`);
  console.log(`ZIP file: ${zipPath}`);
  console.log(`File count: ${fileCount}`);
  console.log(`ZIP size: ${zipKb} KB`);
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
