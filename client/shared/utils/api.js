/**
 * Shared utilities for Electron API access
 */

function checkElectronAPI() {
  if (!window.electronAPI) {
    console.error('electronAPI not available');
    return false;
  }
  return true;
}

function disableAlwaysOnTopForDrag() {
  try {
    if (window.electronAPI?.window?.disableAlwaysOnTop) {
      setTimeout(() => window.electronAPI.window.disableAlwaysOnTop(), 30);
    }
  } catch (e) {}
}

function enableAlwaysOnTopAfterDrag() {
  try {
    if (window.electronAPI?.window?.enableAlwaysOnTop) {
      setTimeout(() => window.electronAPI.window.enableAlwaysOnTop(), 60);
    }
  } catch (e) {}
}
