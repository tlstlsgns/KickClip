// Content script loader (MV3)
// Chrome content_scripts don't support static `import` syntax reliably across environments.
// We use dynamic import() to load our ESM entry (`coreEntry.js`) and its dependency graph.

// Loader-only guard (do NOT share the same flag as coreEntry.js)
if (window.__kickclipContentScriptLoaderLoaded) {
  // Loader already ran, exit early
} else {
  window.__kickclipContentScriptLoaderLoaded = true;

  // Do not run in Electron-based desktop apps (e.g. Claude Desktop, VS Code, Notion).
  // These apps embed a Chromium engine but are not regular browser tabs —
  // KickClip should only operate in a real browser context.
  const _isElectronApp = typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Electron');

  if (!_isElectronApp) {
    // Import the ESM entrypoint from the extension origin
    const src = chrome.runtime.getURL('coreEntry.js');

    import(src).catch(() => {
      // Failed to import coreEntry.js
    });
  }
}

