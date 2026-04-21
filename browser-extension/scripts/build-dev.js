/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const extensionRoot = path.join(repoRoot, 'browser-extension');
const chromiumDir = path.join(extensionRoot, 'chromium');

const srcManifest = path.join(chromiumDir, 'manifest.dev.json');
const srcConfig = path.join(chromiumDir, 'config.dev.js');
const outManifest = path.join(chromiumDir, 'manifest.json');
const outConfig = path.join(chromiumDir, 'config.js');

function main() {
  fs.copyFileSync(srcManifest, outManifest);
  fs.copyFileSync(srcConfig, outConfig);

  const configText = fs.readFileSync(outConfig, 'utf8');
  if (!configText.includes('const KC_IS_DEV = true;')) {
    console.error('ERROR: chromium/config.js must contain `const KC_IS_DEV = true;` after build:dev');
    process.exit(1);
  }

  const manifestText = fs.readFileSync(outManifest, 'utf8');
  try {
    JSON.parse(manifestText);
  } catch (e) {
    console.error('ERROR: chromium/manifest.json is not valid JSON:', e.message);
    process.exit(1);
  }

  console.log('[build:dev] manifest.dev.json → manifest.json');
  console.log('[build:dev] config.dev.js → config.js');
  console.log('[build:dev] ✅ DEV artifacts written to chromium/');
}

main();
