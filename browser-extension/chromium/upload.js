// upload.js — local folder upload: image export, sanitization, File System Access API.
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

/**
 * Sanitize a string to be safe for use as a filename across:
 * - Windows / macOS / Linux filesystems (removes fs-invalid characters)
 * - Chrome File System Access API (rejects emoji, certain unicode)
 *
 * Removes:
 * - Windows/Unix fs-invalid: / \ : * ? " < > | -> replaced with '_'
 * - Control characters (U+0000 to U+001F, U+007F) -> removed
 * - Emoji and pictographs (most common ranges) -> removed
 * - Variation selectors (U+FE00 to U+FE0F) -> removed
 * - Zero-width characters (ZWSP, ZWNJ, ZWJ, BOM) -> removed
 *
 * @param {string} raw
 * @returns {string} sanitized filename, never empty (returns '_' fallback)
 */
function sanitizeFilename(raw) {
  let s = String(raw);

  // 1. Filesystem-invalid ASCII characters -> underscore
  s = s.replace(/[/\\:*?"<>|]/g, '_');

  // 2. Control characters -> remove
  s = s.replace(/[\x00-\x1F\x7F]/g, '');

  // 3. Emoji and pictographs (major unicode ranges) -> remove
  //    Covers most emoji blocks in Unicode 15.1:
  //    - Miscellaneous Symbols and Pictographs (U+1F300-U+1F5FF)
  //    - Emoticons (U+1F600-U+1F64F)
  //    - Transport and Map (U+1F680-U+1F6FF)
  //    - Supplemental Symbols and Pictographs (U+1F900-U+1F9FF)
  //    - Symbols and Pictographs Extended-A (U+1FA70-U+1FAFF)
  //    - Dingbats (U+2700-U+27BF)
  //    - Miscellaneous Symbols (U+2600-U+26FF)
  s = s.replace(/[\u{1F300}-\u{1F5FF}]/gu, '');
  s = s.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
  s = s.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');
  s = s.replace(/[\u{1F900}-\u{1F9FF}]/gu, '');
  s = s.replace(/[\u{1FA70}-\u{1FAFF}]/gu, '');
  s = s.replace(/[\u{2600}-\u{26FF}]/gu, '');
  s = s.replace(/[\u{2700}-\u{27BF}]/gu, '');

  // 4. Variation selectors (VS1-VS16, controls emoji presentation)
  s = s.replace(/[\u{FE00}-\u{FE0F}]/gu, '');

  // 5. Zero-width characters (can cause parsing issues)
  s = s.replace(/[\u{200B}-\u{200D}\u{FEFF}]/gu, '');

  // 6. Trim whitespace (preserve internal spaces)
  s = s.replace(/^\s+|\s+$/g, '');

  // 7. Remove leading / trailing dots
  s = s.replace(/^\.+|\.+$/g, '');

  // 8. Collapse multiple spaces to single space
  s = s.replace(/\s{2,}/g, ' ');

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

/** @param {Blob} blob */
function extensionFromBlobType(blob) {
  const t = (blob && blob.type) ? blob.type.toLowerCase() : '';
  const mimeMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return mimeMap[t] || 'jpg';
}

/** @param {string} imgUrl @param {string} [fallbackUrl] */
// === PHASE27G_SAVE_FALLBACK ===
async function fetchImageAsBlob(imgUrl, fallbackUrl = '') {
  const tryOne = async (u) => {
    const response = await chrome.runtime.sendMessage({ action: 'fetch-image', url: u });
    if (response?.success && response.dataUrl) {
      const blobResponse = await fetch(response.dataUrl);
      return await blobResponse.blob();
    }
    throw new Error(response?.error || 'Image fetch failed (background relay)');
  };

  try {
    const blob = await tryOne(imgUrl);
    return { blob, usedFallback: false };
  } catch (_) {
    /* fall through */
  }

  const fb = String(fallbackUrl || '').trim();
  if (fb && fb !== imgUrl) {
    try {
      if (fb.startsWith('data:')) {
        const blobResponse = await fetch(fb);
        return { blob: await blobResponse.blob(), usedFallback: true };
      }
      const blob = await tryOne(fb);
      return { blob, usedFallback: true };
    } catch (_) {
      /* fall through */
    }
  }

  throw new Error('All image fetch attempts failed');
}
// === END PHASE27G_SAVE_FALLBACK ===

// === PHASE_UPLOAD_FORMAT ===
const KC_UPLOAD_FORMAT_KEY = 'kc_upload_format';

async function getUploadFormatSetting() {
  try {
    const r = await chrome.storage.local.get(KC_UPLOAD_FORMAT_KEY);
    const v = String(r?.[KC_UPLOAD_FORMAT_KEY] || '').trim().toLowerCase();
    if (v === 'jpg' || v === 'jpeg' || v === 'png' || v === 'webp') return v;
    return 'original';
  } catch (_) {
    return 'original';
  }
}

async function transcodeBlobToFormat(blob, fmt) {
  const f = String(fmt || '').trim().toLowerCase();
  if (!blob || !f || f === 'original') return { blob, forcedExt: null };
  const targetMime = (f === 'jpg' || f === 'jpeg')
    ? 'image/jpeg'
    : f === 'png'
      ? 'image/png'
      : f === 'webp'
        ? 'image/webp'
        : null;
  if (!targetMime) return { blob, forcedExt: null };
  const forcedExt = f === 'jpeg' ? 'jpeg' : f;
  try {
    if (String(blob.type || '').toLowerCase() === targetMime) {
      return { blob, forcedExt };
    }
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { blob, forcedExt: null };
      if (targetMime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bitmap, 0, 0);
      const out = await new Promise((resolve) => {
        canvas.toBlob(
          (b) => resolve(b || null),
          targetMime,
          (targetMime === 'image/jpeg' || targetMime === 'image/webp') ? 0.92 : undefined
        );
      });
      if (!out) return { blob, forcedExt: null };
      return { blob: out, forcedExt };
    } finally {
      bitmap.close?.();
    }
  } catch (_) {
    return { blob, forcedExt: null };
  }
}

function resolveUploadExtension(resolved, blob) {
  if (resolved?.forcedExt) return resolved.forcedExt;
  return resolved?.srcUrl
    ? inferImageExtension(resolved.srcUrl, blob)
    : extensionFromBlobType(blob);
}
// === END PHASE_UPLOAD_FORMAT ===

// === PHASE_UPLOAD_IMAGE_ONLY ===
// Every upload artifact is an image. Resolution order:
//   1) img_url via background fetch-image (img_thumbnail_b64 as fetch
//      fallback — existing fetchImageAsBlob behavior),
//   2) img_thumbnail_b64 alone when img_url is empty (clip-time 400x400
//      JPEG data URL; CORS-immune), usedFallback = true,
//   3) neither -> null (caller emits its existing no-image failure).
// The legacy non-Image -> markdown export (Phase U2) is removed: SNS and
// category-less clips now upload their image like everything else.
async function resolveItemImageBlob(item) {
  const imgUrl = String(item?.img_url || '').trim();
  const b64 = String(item?.img_thumbnail_b64 || '').trim();
  const applyFormat = async (base) => {
    const _fmt = await getUploadFormatSetting();
    const _t = await transcodeBlobToFormat(base.blob, _fmt);
    return {
      blob: _t.blob,
      usedFallback: base.usedFallback,
      srcUrl: base.srcUrl,
      forcedExt: _t.forcedExt,
    };
  };
  if (imgUrl) {
    const r = await fetchImageAsBlob(imgUrl, b64);
    return applyFormat({ blob: r.blob, usedFallback: r.usedFallback, srcUrl: imgUrl });
  }
  if (b64.startsWith('data:')) {
    const resp = await fetch(b64);
    return applyFormat({ blob: await resp.blob(), usedFallback: true, srcUrl: '' });
  }
  return null;
}
// === END PHASE_UPLOAD_IMAGE_ONLY ===

// === PHASE_CARD_CLIPBOARD_COPY ===
// Clipboard-copy resolver: original-quality-first with 3-tier fallback,
// ALWAYS transcoded to PNG (Clipboard API only accepts image/png for
// images). Deliberately independent of the kc_upload_format setting.
// proxiedUrl is built by the caller (side panel owns IMAGE_PROXY_BASE).
export async function resolveItemClipboardPngBlob(item, proxiedUrl = '') {
  const imgUrl = String(item?.img_url || '').trim();
  const b64 = String(item?.img_thumbnail_b64 || '').trim();
  let blob = null;
  // Tier 1: original URL via background fetch-image relay (no b64 here)
  if (imgUrl) {
    try {
      const r = await fetchImageAsBlob(imgUrl, '');
      blob = r.blob;
    } catch (_) { /* fall through */ }
  }
  // Tier 2: image proxy (server-side fetch; helps hotlink-protected CDNs)
  if (!blob && proxiedUrl && proxiedUrl !== imgUrl) {
    try {
      const resp = await fetch(proxiedUrl);
      if (resp.ok) blob = await resp.blob();
    } catch (_) { /* fall through */ }
  }
  // Tier 3: clip-time thumbnail
  if (!blob && b64.startsWith('data:')) {
    try {
      blob = await (await fetch(b64)).blob();
    } catch (_) { /* fall through */ }
  }
  if (!blob) return null;
  const out = await transcodeBlobToFormat(blob, 'png');
  return out && out.blob ? out.blob : null;
}
// === END PHASE_CARD_CLIPBOARD_COPY ===

/** @param {FileSystemDirectoryHandle | null} handle */
async function ensureWritableHandle(handle) {
  if (!handle) return null;
  try {
    const opts = { mode: 'readwrite' };
    let perm = await handle.queryPermission(opts);
    if (perm === 'granted') return handle;
    perm = await handle.requestPermission(opts);
    return perm === 'granted' ? handle : null;
  } catch (_) {
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
  } catch (_) {
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
 * Opens the OS-native save dialog and WAITS for actual completion
 * (Phase U3.3d UX hotfix): resolves ok:true only when the download
 * state transitions to 'complete'; reports 'cancelled' or 'generic'
 * errors for interrupted states.
 *
 * @param {object} item
 * @returns {Promise<{ ok: true, filename: string } | { ok: false, reason: string, message?: string }>}
 */
export async function saveItemViaDownloads(item) {
  try {
    let blob;
    let ext;
    let usedFallback = false;

    const resolved = await resolveItemImageBlob(item);
    if (!resolved) {
      return { ok: false, reason: 'generic', message: 'No image URL' };
    }
    blob = resolved.blob;
    usedFallback = resolved.usedFallback;
    ext = resolveUploadExtension(resolved, blob);

    const rawTitle = (item.title || '').trim();
    let base = rawTitle ? rawTitle : fallbackFilenameBase(item);
    base = sanitizeFilename(truncateFilenameBase(base));
    if (!base) base = sanitizeFilename(fallbackFilenameBase(item));
    const suggestedName = `${base}.${ext}`;

    const url = URL.createObjectURL(blob);

    return await new Promise((resolve) => {
      let currentDownloadId = null;
      let settled = false;
      let timeoutHandle = null;
      let finalName = suggestedName;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        try {
          chrome.downloads.onChanged.removeListener(onChanged);
        } catch (_) {}
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      };

      const onChanged = (delta) => {
        if (settled) return;
        if (delta.id !== currentDownloadId) return;

        if (delta.filename && delta.filename.current) {
          const parts = delta.filename.current.split(/[/\\]/);
          finalName = parts[parts.length - 1] || suggestedName;
        }

        if (delta.state && delta.state.current) {
          const newState = delta.state.current;
          if (newState === 'complete') {
            cleanup();
            resolve({ ok: true, filename: finalName, usedFallback });
          } else if (newState === 'interrupted') {
            cleanup();
            const err = delta.error?.current || '';
            if (/USER_CANCELED|user_canceled/i.test(err) || err === 'USER_CANCELED') {
              resolve({ ok: false, reason: 'cancelled', message: 'User cancelled save' });
            } else {
              resolve({ ok: false, reason: 'generic', message: `Download interrupted: ${err || 'unknown'}` });
            }
          }
        }
      };

      timeoutHandle = setTimeout(() => {
        if (settled) return;
        cleanup();
        resolve({ ok: false, reason: 'cancelled', message: 'Save dialog timed out (5 minutes)' });
      }, 5 * 60 * 1000);

      chrome.downloads.onChanged.addListener(onChanged);

      chrome.downloads.download(
        {
          url,
          filename: suggestedName,
          saveAs: true,
          conflictAction: 'uniquify',
        },
        (downloadId) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            const msg = lastErr.message || 'Unknown download error';
            cleanup();
            if (/cancel/i.test(msg) || /USER_CANCELED/i.test(msg)) {
              resolve({ ok: false, reason: 'cancelled', message: msg });
            } else {
              resolve({ ok: false, reason: 'generic', message: msg });
            }
            return;
          }
          if (downloadId == null) {
            cleanup();
            resolve({ ok: false, reason: 'cancelled', message: 'No downloadId returned (dialog dismissed)' });
            return;
          }
          currentDownloadId = downloadId;
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

    let blob;
    let ext;
    let usedFallback = false;

    const resolved = await resolveItemImageBlob(item);
    if (!resolved) {
      return { ok: false, reason: 'generic', message: 'No image URL' };
    }
    blob = resolved.blob;
    usedFallback = resolved.usedFallback;
    ext = resolveUploadExtension(resolved, blob);

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
      await clearPrimaryHandle();
      _setCachedPrimaryHandle(null);
      return { ok: false, reason: 'folder-missing', message: e?.message || String(e) };
    }

    return {
      ok: true,
      filename: finalName,
      primaryFolderName: writable.name,
      usedFallback,
    };
  } catch (e) {
    return { ok: false, reason: 'generic', message: e?.message || String(e) };
  }
}

// ─────────────────────────────────────────────────────────────
// Drive upload helper (Phase U3.3b)
// Builds the request payload for background.js drive-upload-file:
//   desiredName, mimeType, contentBase64
// Reuses existing sanitize/filename pipeline + image blob fetch.
// ─────────────────────────────────────────────────────────────

/**
 * Convert a Blob to base64 string (no data: prefix).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return string'));
        return;
      }
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Build a Drive upload payload for a given DataCard item. Does NOT
 * send to Drive — returns { desiredName, mimeType, contentBase64 } for
 * the caller to pass to background via drive-upload-file message.
 *
 * Naming and sanitization match the local upload pipeline.
 *
 * @param {object} item
 * @returns {Promise<{ ok: true, desiredName: string, mimeType: string, contentBase64: string }
 *   | { ok: false, reason: 'generic', message: string }>}
 */
export async function buildDriveUploadPayload(item) {
  try {
    let blob;
    let ext;
    let mimeType;

    const resolved = await resolveItemImageBlob(item);
    if (!resolved) {
      return { ok: false, reason: 'generic', message: 'No image URL' };
    }
    blob = resolved.blob;
    ext = resolveUploadExtension(resolved, blob);
    mimeType = blob.type || (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`);

    const rawTitle = (item.title || '').trim();
    let base = rawTitle ? rawTitle : fallbackFilenameBase(item);
    base = sanitizeFilename(truncateFilenameBase(base));
    if (!base) base = sanitizeFilename(fallbackFilenameBase(item));
    const desiredName = `${base}.${ext}`;

    const contentBase64 = await blobToBase64(blob);
    return { ok: true, desiredName, mimeType, contentBase64 };
  } catch (e) {
    return { ok: false, reason: 'generic', message: e?.message || String(e) };
  }
}

// === PHASE_DOWNLOADS_SUBFOLDER ===
// saveItemToDownloads — silent save to the user's Downloads folder root.
//
// Routes a DataCard item to chrome.downloads.download with a relative
// filename like 'my-image.jpg'. Chrome's downloads API:
//   - resolves the path relative to the user's default Downloads dir,
//   - applies conflictAction='uniquify' so repeated saves get (1)/(2)/...
// No OS save dialog (saveAs: false) and no user gesture required.
// Bypasses showDirectoryPicker's sensitive-directory blocklist.
//
// This is the path for destination.type === 'downloads' AND for the
// null/unconfigured default state (treated as 'downloads' implicitly
// by the caller in sidepanel.js — U4).
//
// Differs from saveItemViaDownloads (saveAs: true) which is the
// popover's "내 컴퓨터 폴더" option and prompts the user every time.
//
// @param {object} item — DataCard item shape (url, title, category,
//                        img_url, img_thumbnail_b64, createdAt, ...)
// @returns {Promise<{ ok: true, filename: string } |
//                   { ok: false, reason: 'cancelled' | 'generic',
//                                message?: string }>}
export async function saveItemToDownloads(item) {
  try {
    let blob;
    let ext;
    let usedFallback = false;

    const resolved = await resolveItemImageBlob(item);
    if (!resolved) {
      return { ok: false, reason: 'generic', message: 'No image URL' };
    }
    blob = resolved.blob;
    usedFallback = resolved.usedFallback;
    ext = resolveUploadExtension(resolved, blob);

    const rawTitle = (item.title || '').trim();
    let base = rawTitle ? rawTitle : fallbackFilenameBase(item);
    base = sanitizeFilename(truncateFilenameBase(base));
    if (!base) base = sanitizeFilename(fallbackFilenameBase(item));

    const filename = `${base}.${ext}`;

    const url = URL.createObjectURL(blob);

    return await new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      };

      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: false,
          conflictAction: 'uniquify',
        },
        (downloadId) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            cleanup();
            resolve({
              ok: false,
              reason: 'generic',
              message: lastErr.message || 'Unknown download error',
            });
            return;
          }
          if (downloadId == null) {
            cleanup();
            resolve({
              ok: false,
              reason: 'generic',
              message: 'No downloadId returned',
            });
            return;
          }
          // Fire-and-forget. chrome.downloads handles the actual write;
          // the URL object can be revoked once the download is queued.
          cleanup();
          resolve({ ok: true, filename, usedFallback });
        }
      );
    });
  } catch (e) {
    return { ok: false, reason: 'generic', message: e?.message || String(e) };
  }
}
// === END PHASE_DOWNLOADS_SUBFOLDER ===
