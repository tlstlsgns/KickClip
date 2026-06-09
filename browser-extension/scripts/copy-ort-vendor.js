/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const WEBGPU_BUNDLE = 'ort.webgpu.bundle.min.mjs';
const ORT_WASM_RE = /^ort-wasm-.*\.(mjs|wasm)$/;

const srcModelsDir = path.join(__dirname, '..', 'chromium', 'vendor', 'models');

function resolveOrtDistFiles(ortDistDir) {
  const entries = fs.readdirSync(ortDistDir, { withFileTypes: true });
  const wasmFiles = entries
    .filter((e) => e.isFile() && ORT_WASM_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  return [WEBGPU_BUNDLE, ...wasmFiles];
}

function copyOrtVendor(destDir) {
  const ortDistDir = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
  const files = resolveOrtDistFiles(ortDistDir);
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of files) {
    const src = path.join(ortDistDir, name);
    if (!fs.existsSync(src)) {
      console.error(`ERROR: missing onnxruntime-web dist file: ${src}`);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(destDir, name));
  }
  console.log(`[copy-ort-vendor] ${files.length} file(s) → ${destDir}`);
  console.log(`[copy-ort-vendor] ${files.join(', ')}`);
  return files;
}

function copyVendorModels(destVendorDir) {
  if (!fs.existsSync(srcModelsDir)) {
    console.error(`ERROR: missing model dir: ${srcModelsDir} — run fetch-model first`);
    process.exit(1);
  }
  const destModelsDir = path.join(destVendorDir, 'models');
  fs.mkdirSync(destModelsDir, { recursive: true });
  const entries = fs.readdirSync(srcModelsDir, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(
      path.join(srcModelsDir, entry.name),
      path.join(destModelsDir, entry.name)
    );
    copied += 1;
  }
  if (copied === 0) {
    console.error(`ERROR: no model files in ${srcModelsDir}`);
    process.exit(1);
  }
  console.log(`[copy-ort-vendor] models (${copied} file(s)) → ${destModelsDir}`);
}

module.exports = { copyOrtVendor, copyVendorModels, resolveOrtDistFiles, WEBGPU_BUNDLE, ORT_WASM_RE };
