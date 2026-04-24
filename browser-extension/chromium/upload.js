// upload.js — local folder upload: markdown export, sanitization, File System Access API.
// Google Drive (Phase U3) is handled in sidepanel.js only.

import { getPrimaryHandle, clearPrimaryHandle } from './uploadStorage.js';

const KNOWN_IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

// Module-level cache of the primary folder handle from IndexedDB.
/** @type {FileSystemDirectoryHandle | null | undefined} */
let _cachedPrimaryHandle; // undefined = not loaded, null = explicitly none, else = handle

export async function preloadPrimaryHandle() {
  if (_cachedPrimaryHandle !== undefined) return _cachedPrimaryHandle;
  _cachedPrimaryHandle = (await getPrimaryHandle()) || null;
  return _cachedPrimaryHandle;
}

/** Synchronous cache read. Returns undefined if preload hasn't happened yet. */
export function getCachedPrimaryHandle() {
  return _cachedPrimaryHandle;
}

function _setCachedPrimaryHandle(handle) {
  if (handle === undefined) {
    _cachedPrimaryHandle = undefined;
  } else {
    _cachedPrimaryHandle = handle || null;
  }
}

export function resetPrimaryHandleCache() {
  _cachedPrimaryHandle = undefined;
}

/** @param {string} raw */
function sanitizeFilename(raw) {
  let s = String(raw).replace(/[/\\:*?"<>|]/g, '_');
  s = s.replace(/^\s+|\s+$/g, '');
  s = s.replace(/^\.+|\.+$/g, '');
  return s || '_';
}

/** @param {string} base */
function truncateFilenameBase(base) {
  const arr = [...String(base)];
  if (arr.length <= 100) return arr.join('');
  return arr.slice(0, 97).join('') + '...';
}

/** @param {object} item */
function toDateFromCreated(item) {
  const ca = item?.createdAt;
  if (ca == null) return new Date();
  try {
    if (typeof ca.toDate === 'function') return ca.toDate();
    if (typeof ca === 'object' && typeof ca.seconds === 'number') {
      return new Date(ca.seconds * 1000 + (ca.nanoseconds || 0) / 1e6);
    }
    if (typeof ca === 'number') return new Date(ca);
    if (typeof ca === 'string') {
      const d = new Date(ca);
      return Number.isNaN(d.getTime()) ? new Date() : d;
    }
  } catch (_) {}
  return new Date();
}

/** @param {object} item */
function fallbackFilenameBase(item) {
  let host = 'save';
  try {
    const u = new URL(String(item.url || '').trim() || 'https://invalid.invalid', 'https://example.com');
    host = (u.hostname || 'save').replace(/^www\./i, '') || 'save';
  } catch (_) {}
  const d = toDateFromCreated(item);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${host}_${y}${m}${day}`;
}

/**
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} desiredName
 */
async function uniqueFilenameInDir(dirHandle, desiredName) {
  const lastDot = desiredName.lastIndexOf('.');
  const ext = lastDot >= 0 ? desiredName.slice(lastDot) : '';
  const baseOnly = lastDot >= 0 ? desiredName.slice(0, lastDot) : desiredName;
  let candidate = desiredName;
  let n = 0;
  for (;;) {
    try {
      await dirHandle.getFileHandle(candidate, { create: false });
      n += 1;
      candidate = `${baseOnly} (${n})${ext}`;
    } catch (e) {
      if (e && e.name === 'NotFoundError') return candidate;
      throw e;
    }
  }
}

/** @param {string} imgUrl @param {Blob} blob */
function inferImageExtension(imgUrl, blob) {
  try {
    const u = new URL(imgUrl, 'https://example.com');
    const m = u.pathname.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    if (m) {
      let ext = m[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      if (KNOWN_IMG_EXT.has(ext)) return ext;
    }
  } catch (_) {}
  const t = (blob && blob.type) ? blob.type.toLowerCase() : '';
  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  if (mimeMap[t]) return mimeMap[t];
  return 'png';
}

/** @param {string} s */
function escapeYamlDoubleQuoted(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** @param {object} item */
function formatItemAsMarkdown(item) {
  const titleRaw = (item.title || '').trim() || 'untitled';
  const titleOneLine = titleRaw.replace(/\r?\n/g, ' ');
  const url = String(item.url || '').trim();
  const created = toDateFromCreated(item);
  const createdIso = created.toISOString();
  const category = String(item.category || '').trim();
  const confirmed = String(item.confirmed_type || item.confirmedType || '').trim();
  const sender = String(item.sender || '').trim();
  const platform = String(item.platform || '').trim();
  const imgUrl = String(item.img_url || '').trim();
  const pageDescription = String(item.page_description || '').trim();

  const fm = ['---'];
  fm.push(`title: "${escapeYamlDoubleQuoted(titleOneLine)}"`);
  fm.push(`url: "${escapeYamlDoubleQuoted(url)}"`);
  fm.push(`created: "${escapeYamlDoubleQuoted(createdIso)}"`);
  fm.push(`category: "${escapeYamlDoubleQuoted(category)}"`);
  if (category === 'SNS' && confirmed) {
    fm.push(`confirmed_type: "${escapeYamlDoubleQuoted(confirmed)}"`);
  }
  if (category === 'Mail' && sender) {
    fm.push(`sender: "${escapeYamlDoubleQuoted(sender)}"`);
  }
  if (platform) {
    fm.push(`platform: "${escapeYamlDoubleQuoted(platform)}"`);
  }
  fm.push('---');
  fm.push('');

  const lines = [...fm, `# ${titleOneLine}`, ''];
  if (imgUrl) {
    lines.push(`![preview](${imgUrl})`);
    lines.push('');
  }
  if (pageDescription) {
    lines.push(pageDescription);
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  const now = new Date();
  const krDate = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
  lines.push(`- **URL**: <${url}>`);
  lines.push(`- **저장 일시**: ${krDate}`);
  let catLine = `- **카테고리**: ${category || '(none)'}`;
  if (category === 'SNS' && confirmed) {
    catLine += ` (${confirmed})`;
  }
  lines.push(catLine);
  if (category === 'Mail' && sender) {
    lines.push(`- **보낸이**: ${sender}`);
  }
  if (platform) {
    lines.push(`- **플랫폼**: ${platform}`);
  }
  lines.push('');

  return lines.join('\n');
}

/** @param {string} imgUrl */
async function fetchImageAsBlob(imgUrl) {
  const response = await chrome.runtime.sendMessage({ action: 'fetch-image', url: imgUrl });
  if (!response || !response.success || !response.dataUrl) {
    throw new Error(response?.error || 'Image fetch failed (background relay)');
  }
  const res = await fetch(response.dataUrl);
  return await res.blob();
}

/** @param {FileSystemDirectoryHandle | null} handle */
async function ensureWritableHandle(handle) {
  if (!handle) return null;
  try {
    const opts = { mode: 'readwrite' };
    let perm = await handle.queryPermission(opts);
    if (perm === 'granted') return handle;
    perm = await handle.requestPermission(opts);
    return perm === 'granted' ? handle : null;
  } catch (e) {
    console.log('[KICKCLIP-LOG] ensureWritableHandle error:', e);
    return null;
  }
}

/** @param {FileSystemDirectoryHandle} dirHandle @param {string} filename @param {Blob} blob */
async function writeBlobToDir(dirHandle, filename, blob) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Phase 1 (sync-from-gesture path): decide whether we already have a handle.
 * Uses ONLY the sync cache. The caller must have invoked preloadPrimaryHandle()
 * earlier (at side-panel startup) for this to be meaningful.
 *
 * @returns {FileSystemDirectoryHandle | null} cached handle or null if none cached
 */
export function getPrimaryHandleForGesture() {
  const handle = getCachedPrimaryHandle();
  return handle || null;
}

/**
 * Opens a dedicated extension popup window (picker.html) for showDirectoryPicker.
 * Centered on the user's current display via window.screen.availWidth/availHeight.
 *
 * @returns {Promise<number | null>} created window id or null on failure
 */
export async function openPickerWindow() {
  try {
    const url = chrome.runtime.getURL('picker.html');
    const popupWidth = 480;
    const popupHeight = 320;

    let left;
    let top;
    try {
      const sw = (typeof window !== 'undefined' && window.screen) ? window.screen.availWidth : 1280;
      const sh = (typeof window !== 'undefined' && window.screen) ? window.screen.availHeight : 800;
      left = Math.max(0, Math.round((sw - popupWidth) / 2));
      top = Math.max(0, Math.round((sh - popupHeight) / 2));
    } catch (_) {
      left = 100;
      top = 100;
    }

    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: popupWidth,
      height: popupHeight,
      left,
      top,
      focused: true,
    });
    return win?.id ?? null;
  } catch (e) {
    console.log('[KICKCLIP-LOG] openPickerWindow error:', e);
    return null;
  }
}

/**
 * Refresh the cache from IndexedDB. Call this after the picker popup signals
 * that it has stored a new handle.
 */
export async function refreshPrimaryHandleCache() {
  resetPrimaryHandleCache();
  return await preloadPrimaryHandle();
}

/**
 * Save an item via chrome.downloads.download with saveAs:true.
 * Opens the OS-native save dialog. Can save to any folder (Desktop, Documents,
 * anywhere). Uses the existing markdown formatter / image blob pipeline /
 * filename sanitization.
 *
 * @param {object} item
 * @returns {Promise<{ ok: true, filename: string } | { ok: false, reason: string, message?: string }>}
 */
export async function saveItemViaDownloads(item) {
  try {
    const category = (item.category || '').trim();
    let blob;
    let ext;

    if (category === 'Image') {
      const imgUrl = (item.img_url || '').trim();
      if (!imgUrl) {
        return { ok: false, reason: 'generic', message: 'No image URL' };
      }
      blob = await fetchImageAsBlob(imgUrl);
      ext = inferImageExtension(imgUrl, blob);
    } else {
      const md = formatItemAsMarkdown(item);
      blob = new Blob([md], { type: 'text/markdown' });
      ext = 'md';
    }

    const rawTitle = (item.title || '').trim();
    let base = rawTitle ? rawTitle : fallbackFilenameBase(item);
    base = sanitizeFilename(truncateFilenameBase(base));
    if (!base) base = sanitizeFilename(fallbackFilenameBase(item));
    const suggestedName = `${base}.${ext}`;

    const url = URL.createObjectURL(blob);

    return await new Promise((resolve) => {
      chrome.downloads.download(
        {
          url,
          filename: suggestedName,
          saveAs: true,
          conflictAction: 'uniquify',
        },
        (downloadId) => {
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          const err = chrome.runtime.lastError;
          if (err) {
            const msg = err.message || 'Unknown download error';
            if (/cancel/i.test(msg) || /USER_CANCELED/i.test(msg)) {
              resolve({ ok: false, reason: 'cancelled', message: msg });
            } else {
              resolve({ ok: false, reason: 'generic', message: msg });
            }
            return;
          }
          if (downloadId == null) {
            resolve({ ok: false, reason: 'cancelled', message: 'No downloadId returned' });
            return;
          }
          resolve({ ok: true, filename: suggestedName });
        }
      );
    });
  } catch (e) {
    return { ok: false, reason: 'generic', message: e?.message || String(e) };
  }
}

/**
 * Phase 2 (async path): given a resolved handle (either from cache or from a
 * fresh picker call), perform permission checks and file write work.
 *
 * The caller is responsible for ensuring `handle` exists (via cache or picker).
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {object} item
 * @returns {Promise<{ ok: true, filename: string, primaryFolderName: string } | { ok: false, reason: string, message?: string }>}
 */
export async function writeItemToHandle(handle, item) {
  try {
    const writable = await ensureWritableHandle(handle);
    if (!writable) {
      return { ok: false, reason: 'permission', message: '' };
    }

    const category = (item.category || '').trim();
    let blob;
    let ext;

    if (category === 'Image') {
      const imgUrl = (item.img_url || '').trim();
      if (!imgUrl) {
        return { ok: false, reason: 'generic', message: 'No image URL' };
      }
      blob = await fetchImageAsBlob(imgUrl);
      ext = inferImageExtension(imgUrl, blob);
    } else {
      const md = formatItemAsMarkdown(item);
      blob = new Blob([md], { type: 'text/markdown' });
      ext = 'md';
    }

    const rawTitle = (item.title || '').trim();
    let base = rawTitle ? rawTitle : fallbackFilenameBase(item);
    base = sanitizeFilename(truncateFilenameBase(base));
    if (!base) base = sanitizeFilename(fallbackFilenameBase(item));
    const desired = `${base}.${ext}`;
    let finalName;
    try {
      finalName = await uniqueFilenameInDir(writable, desired);
    } catch (e) {
      return { ok: false, reason: 'generic', message: e?.message || String(e) };
    }

    try {
      await writeBlobToDir(writable, finalName, blob);
    } catch (e) {
      console.log('[KICKCLIP-LOG] writeItemToHandle write error:', e);
      await clearPrimaryHandle();
      _setCachedPrimaryHandle(null);
      return { ok: false, reason: 'folder-missing', message: e?.message || String(e) };
    }

    return {
      ok: true,
      filename: finalName,
      primaryFolderName: writable.name,
    };
  } catch (e) {
    return { ok: false, reason: 'generic', message: e?.message || String(e) };
  }
}
