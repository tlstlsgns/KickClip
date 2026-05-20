// Content script loader (MV3)
// Chrome content_scripts don't support static `import` syntax reliably across environments.
// We use dynamic import() to load our ESM entry (`coreEntry.js`) and its dependency graph.

// Loader-only guard (do NOT share the same flag as coreEntry.js)
if (window.__kickclipContentScriptLoaderLoaded) {
  // Loader already ran, exit early
} else {
  window.__kickclipContentScriptLoaderLoaded = true;

  // === PHASE_AI_DOMAIN_UNLOCK ===
  // Previously gated on !_isElectronApp to skip Electron-based desktop apps
  // (Claude Desktop, VS Code, Notion). Restriction removed — KickClip is
  // allowed to attempt initialization in all contexts. In practice, Chrome
  // extensions are not loaded by Electron apps regardless of this guard,
  // so removing it has no effective impact on real Electron environments.
  const src = chrome.runtime.getURL('coreEntry.js');

  import(src).catch(() => {
    // Failed to import coreEntry.js
  });
  // === END PHASE_AI_DOMAIN_UNLOCK ===
}

