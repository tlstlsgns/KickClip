import { state } from './stateLite.js';
import {
  detectItemMaps,
  EVIDENCE_TYPE_C,
  getItemMapFingerprint,
  findClusterContainerFromTarget,
  getItemMapEvidenceType,
  getItemMapEntryByElement,
  resolveTypeACoreItem,
  isValidTypeAAnchor,
  extractMetadataForCoreItem,
  extractShortcode,
  mountInstagramShortcodeObserver,
  getCurrentPlatform,
  normalizeShortcodeExtractionResult,
  showCoreHighlight,
  updateCoreHighlightClass,
  hideCoreHighlight,
  updateFullPageHighlightClass,
  clearCoreSelection,
  ensureClusterCacheFromState,
  showMetadataTooltip,
  setAiTooltipContent,
  clearAiTooltipContent,
  positionMetadataTooltip,
  showPageStatusBadge,
  showPageStatusBadgeText,
  hidePageStatusBadge,
  showCoreStatusBadge,
  hideCoreStatusBadge,
  positionCoreStatusBadge,
  renderItemMapCandidates,
  showFullPageHighlight,
  hideFullPageHighlight,
  resetFullPageHideTimer,
  hideMetadataTooltip,
  detectItemCategory,
  triggerShutterEffect,
} from './coreEngine.js';
import {
  extractYouTubeShortcodeFromUrl,
  getYouTubeThumbnailUrl,
} from './dataExtractor.js';

let _kcUserReady = false; // true when kickclipUserId is confirmed
let _pageMetaInitialized = false;

let scanTimer = 0;
let lastFingerprint = '';
let _retryScanTimer = 0;    // setTimeout handle for pending retry scan
let _retryScanCount  = 0;   // number of retries attempted for current navigation
let _forceFullScanOnMutation = false; // true after navigation: next MutationObserver trigger uses full document scan
let lastPointerX = null;
let lastPointerY = null;
let _lastMouseoverTarget = null;
const instagramFetchInFlightByElement = new WeakMap();

let _isCapturing = false; // true while captureVisibleTab is in progress

const IS_IFRAME = window.self !== window.top;
let _windowFocused = true; // false while the browser window is not focused
let _sidePanelFocused = false; // true while the KickClip Side Panel has focus
let _sidePanelOpen = false;
let _mouseHasMovedOnPage = false; // true after first mousemove detected on current page
let _mouseInsideDocument = false; // true while mouse pointer is inside the viewport
const KC_MSG_PREFIX = '__kc__';
const KC_SAVE_QUERY = '__kc_save_query__';
const KC_SAVE_HANDLED = '__kc_save_handled__';
const KC_SAVE_RELAY = '__kc_save_relay__';

/** Metadata tooltip id — hidden briefly during save (shutter uses overlay fills in uiManager). */
const METADATA_TOOLTIP_ID = 'blink-metadata-tooltip';
const SAVE_FEEDBACK_KC_MIN_MS = 80;

function postHighlightToTop(type, payload = {}) {
  try {
    window.top.postMessage({ [KC_MSG_PREFIX]: true, type, ...payload }, '*');
  } catch (e) {}
}

let _savedUrlSet = new Set(); // saved URLs

/**
 * Synchronously checks _savedUrlSet (kept fresh via get-saved-urls / saved-urls-updated).
 * Returns true if the URL is already saved, false otherwise.
 */
function checkIsSavedSync(url) {
  try {
    const u = normalizeUrlForSavedCheck(url);
    if (!u) return false;
    return _savedUrlSet.has(u);
  } catch (e) {
    return false;
  }
}

/**
 * Normalizes a URL string for consistent saved-URL matching.
 * Decodes percent-encoded characters so that encoded and decoded
 * forms of the same URL (e.g. %EA%B5%AC vs 구) are treated as equal.
 * Falls back to the original string if decoding fails (malformed encoding).
 */
function normalizeUrlForSavedCheck(url) {
  try {
    return decodeURIComponent(String(url || '').trim());
  } catch {
    return String(url || '').trim();
  }
}

function normalizeSavedUrlsResponse(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) =>
      typeof e === 'string'
        ? normalizeUrlForSavedCheck(e)
        : normalizeUrlForSavedCheck(e?.url || '')
    )
    .filter(Boolean);
}

function initPageLevelMetadata() {
  try {
    const pageUrl = String(window?.location?.href || '').trim();
    if (!pageUrl) return;
    const { category, platform, confirmedType } = detectItemCategory(pageUrl, pageUrl, null);
    state.lastExtractedMetadata = {
      ...(state.lastExtractedMetadata || {}),
      activeHoverUrl: '',
      category,
      ...(platform      ? { platform }      : {}),
      ...(confirmedType ? { confirmedType }  : {}),
    };
    if (!IS_IFRAME) {
      // Pass refreshPageStatusBadge as callback so badge text is resolved
      // at display time (after the 80 ms delay) using the current
      // _kcUserReady state, preventing any pre-display flash.
      showFullPageHighlight(false, refreshPageStatusBadge);
    }
  } catch (e) {}
}

/**
 * Refreshes the page status badge text based on current login state.
 * When logged in: shows default 'Save It!' text.
 * When not logged in: re-shows the non-login shortcut prompt.
 * Use this instead of calling showPageStatusBadge('default') directly.
 */
function refreshPageStatusBadge() {
  if (_kcUserReady) {
    try { showPageStatusBadge('default'); } catch (e) {}
    return;
  }
  // Read the cached shortcut from storage (written by background.js
  // runShortcutPoll) to avoid an async sendMessage round-trip that
  // would cause the text to arrive late and flash visibly.
  try {
    chrome.storage.local.get('kickclipShortcut', (result) => {
      try {
        const raw = result?.kickclipShortcut || 'Ctrl+Shift+S';
        const isMac = navigator.platform.toUpperCase().includes('MAC') ||
          navigator.userAgent.includes('Mac');
        const display = isMac
          ? raw
              .replace(/MacCtrl/gi, '⌃')
              .replace(/Ctrl/gi, '⌘')
              .replace(/Command/gi, '⌘')
              .replace(/Shift/gi, '⇧')
              .replace(/Alt/gi, '⌥')
              .replace(/\+/g, '')
          : raw;
        showPageStatusBadgeText(`click ${display} to start KickClip`);
      } catch (e) {}
    });
  } catch (e) {
    try { showPageStatusBadgeText('click shortcut to start KickClip'); } catch (_) {}
  }
}

// Waits for the browser to complete two paint frames.
// Used to ensure DOM visibility changes are reflected on screen
// before captureVisibleTab fires.
function waitForRepaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Temporarily hides purple overlay + metadata tooltip (opacity 0, layout preserved).
 * @returns {Array<{ el: HTMLElement, prevOpacity: string, prevTransition: string }>}
 */
/** Hides only the metadata tooltip during save; purple/full-page “blink” is `triggerShutterEffect`. */
function hideKCSaveFeedbackUi() {
  const hidden = [];
  for (const id of [METADATA_TOOLTIP_ID]) {
    try {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') {
        hidden.push({ el, prevOpacity: el.style.opacity, prevTransition: el.style.transition });
        el.style.opacity = '0';
      }
    } catch (e) {}
  }
  return hidden;
}

function restoreKCSaveFeedbackUi(hiddenEls) {
  for (const { el, prevOpacity, prevTransition } of hiddenEls) {
    try {
      el.style.transition = prevTransition;
      el.style.opacity = prevOpacity;
    } catch (e) {}
  }
}

/** Ensures a minimum visible “blink” duration, then restores save-feedback UI and re-applies purple. */
async function finalizeKCSaveFeedback(hiddenEls, startedAt) {
  const elapsed = Date.now() - startedAt;
  const wait = Math.max(0, SAVE_FEEDBACK_KC_MIN_MS - elapsed);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  restoreKCSaveFeedbackUi(hiddenEls);
  try {
    const currentActive = state.activeCoreItem;
    if (currentActive && currentActive.nodeType === 1) {
      const overlay = document.getElementById('blink-highlight-overlay');
      const hasShutter = overlay &&
        (overlay.classList.contains('shutter-success') ||
         overlay.classList.contains('shutter-error'));
      if (!hasShutter) {
        showCoreHighlight(currentActive, false);
      }
    }
  } catch (e) {}
}

/**
 * Requests a Gmail OAuth token from background.js via chrome.identity.
 * Returns the token string or null if unavailable.
 */
async function getGmailAuthToken() {
  try {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-gmail-token' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response?.token || null);
        }
      });
    });
  } catch {
    return null;
  }
}

/**
 * Collects Naver login cookies from the browser for server-side Puppeteer injection.
 * Returns an array of cookie objects or null if unavailable.
 */
async function getNaverCookies() {
  try {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-naver-cookies' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response?.cookies || null);
        }
      });
    });
  } catch {
    return null;
  }
}

/**
 * Finds the minimum content container within a CoreItem using top-down traversal.
 * Starting from the root element, descends as long as there is exactly one
 * "meaningful" child — a child that has a visible bounding box AND contains
 * text, images, or further meaningful children.
 * Stops and returns the current node when:
 *   - 2+ meaningful children exist (this node IS the minimum container), OR
 *   - 0 meaningful children exist (leaf/empty — falls back to parent)
 *
 * Only applies to CoreItem screenshots. Page screenshots use the full viewport.
 *
 * @param {Element} root - The CoreItem element to search within
 * @returns {{ container: Element, hasPadding: boolean, paddingValue: number }}
 */
function findMinContentContainer(root) {
  const DEFAULT_PADDING = 6;
  const fallback = { container: root, hasPadding: false, paddingValue: DEFAULT_PADDING };
  try {
    if (!root || root.nodeType !== 1) return fallback;

    function isMeaningfulElement(el) {
      try {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        // Has direct text content
        const hasText = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && String(n.textContent || '').trim().length > 0
        );
        if (hasText) return true;
        // Has an img descendant with a visible rect
        const imgs = Array.from(el.querySelectorAll('img'));
        if (imgs.some((img) => {
          const ir = img.getBoundingClientRect();
          return ir.width > 0 && ir.height > 0;
        })) return true;
        // Has meaningful child elements
        const children = Array.from(el.children || []);
        return children.some((c) => isMeaningfulElement(c));
      } catch (e) {
        return false;
      }
    }

    let current = root;
    for (let depth = 0; depth < 8; depth++) {
      const children = Array.from(current.children || []);
      const meaningful = children.filter(isMeaningfulElement);
      if (meaningful.length === 1) {
        // Exactly one meaningful child — descend into it
        current = meaningful[0];
      } else {
        // 0 or 2+ meaningful children — stop here
        break;
      }
    }

    // Detect computed padding on the found container
    const cs = window.getComputedStyle ? window.getComputedStyle(current) : null;
    const paddingTop    = cs ? parseFloat(cs.paddingTop)    || 0 : 0;
    const paddingRight  = cs ? parseFloat(cs.paddingRight)  || 0 : 0;
    const paddingBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
    const paddingLeft   = cs ? parseFloat(cs.paddingLeft)   || 0 : 0;
    const maxPadding    = Math.max(paddingTop, paddingRight, paddingBottom, paddingLeft);
    const hasPadding    = maxPadding >= 4;

    return {
      container:    current,
      hasPadding,
      // If container already has padding >= 4px, no extra padding needed on DataCard.
      // Otherwise apply DEFAULT_PADDING for visual consistency.
      paddingValue: hasPadding ? 0 : DEFAULT_PADDING,
    };
  } catch (e) {
    return fallback;
  }
}

async function captureScreenshotBase64(element) {
  try {
    if (!element || element.nodeType !== 1) return null;

    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;

    const KC_UI_IDS = [
      'blink-highlight-overlay',
      'blink-metadata-tooltip',
      'blink-green-candidate-layer',
      'blink-fullpage-highlight-overlay',
    ];
    const hiddenEls = [];
    for (const id of KC_UI_IDS) {
      try {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') {
          // Use opacity:0 instead of display:none so the element stays in
          // the layout (no visual jump) but is excluded from the screenshot.
          hiddenEls.push({ el, prevOpacity: el.style.opacity, prevTransition: el.style.transition });
          el.style.opacity = '0';
        }
      } catch (e) {}
    }

    _isCapturing = true;
    try {
      // One rAF is enough since opacity change (no layout reflow needed).
      await waitForRepaint();
      await new Promise((resolve) => setTimeout(resolve, 32));

      let dataUrl = null;
      let backgroundColor = '#ffffff';
      try {
        const result = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ action: 'capture-visible-tab' }, (response) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve(response);
            });
          } catch (e) {
            resolve(null);
          }
        });

        if (!result?.success || !result?.dataUrl) return null;

        const dpr = window.devicePixelRatio || 1;
        const img = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('img load failed'));
          image.src = result.dataUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(
          img,
          Math.round(rect.left * dpr),
          Math.round(rect.top * dpr),
          Math.round(rect.width * dpr),
          Math.round(rect.height * dpr),
          0,
          0,
          Math.round(rect.width * dpr),
          Math.round(rect.height * dpr)
        );
        dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        // Sample background color from the cropped canvas pixels.
        // Average the RGB values of 3 corners (top-left, top-right, bottom-left)
        // to get a representative background color, avoiding content-heavy center.
        try {
          const cw = canvas.width;
          const ch = canvas.height;
          const samples = [
            ctx.getImageData(0, 0, 1, 1).data, // top-left
            ctx.getImageData(cw - 1, 0, 1, 1).data, // top-right
            ctx.getImageData(0, ch - 1, 1, 1).data, // bottom-left
          ];
          const avgR = Math.round(samples.reduce((s, p) => s + p[0], 0) / samples.length);
          const avgG = Math.round(samples.reduce((s, p) => s + p[1], 0) / samples.length);
          const avgB = Math.round(samples.reduce((s, p) => s + p[2], 0) / samples.length);
          backgroundColor = `rgb(${avgR},${avgG},${avgB})`;
        } catch (_) {
          backgroundColor = '#ffffff';
        }
      } catch (e) {
        dataUrl = null;
      }

      if (!dataUrl) return null;
      return { dataUrl, backgroundColor };
    } finally {
      _isCapturing = false;
      for (const { el, prevOpacity, prevTransition } of hiddenEls) {
        try {
          el.style.transition = prevTransition;
          el.style.opacity    = prevOpacity;
        } catch (e) {}
      }
    }
  } catch (e) {
    return null;
  }
}

async function capturePageScreenshotBase64() {
  const KC_UI_IDS = [
    'blink-highlight-overlay',
    'blink-metadata-tooltip',
    'blink-green-candidate-layer',
    'blink-fullpage-highlight-overlay',
  ];

  // Temporarily hide KickClip UI elements
  const hiddenEls = [];
  for (const id of KC_UI_IDS) {
    try {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') {
        hiddenEls.push({ el, prevOpacity: el.style.opacity, prevTransition: el.style.transition });
        el.style.transition = '';
        el.style.opacity = '0';
      }
    } catch (e) {}
  }

  _isCapturing = true;
  try {
    // Wait for the browser to repaint with hidden KickClip UI before capturing.
    // Two rAFs ensure layout/paint; the extra 32ms settles compositor flush.
    await waitForRepaint();
    await new Promise((resolve) => setTimeout(resolve, 32));

    const result = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'capture-visible-tab' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve(null);
      }
    });

    if (!result?.success || !result?.dataUrl) return null;

    const dpr = window.devicePixelRatio || 1;

    // Sample background color from 3 corners of the captured full-page image.
    // Uses pixel sampling instead of DOM computed style for accuracy.
    let backgroundColor = '#ffffff';
    try {
      const fullImg = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('img load failed'));
        image.src = result.dataUrl;
      });
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width  = fullImg.naturalWidth  || fullImg.width;
      sampleCanvas.height = fullImg.naturalHeight || fullImg.height;
      const sCtx = sampleCanvas.getContext('2d');
      if (sCtx) {
        sCtx.drawImage(fullImg, 0, 0);
        const cw = sampleCanvas.width;
        const ch = sampleCanvas.height;
        const samples = [
          sCtx.getImageData(0, 0, 1, 1).data,
          sCtx.getImageData(cw - 1, 0, 1, 1).data,
          sCtx.getImageData(0, ch - 1, 1, 1).data,
        ];
        const avgR = Math.round(samples.reduce((s, p) => s + p[0], 0) / samples.length);
        const avgG = Math.round(samples.reduce((s, p) => s + p[1], 0) / samples.length);
        const avgB = Math.round(samples.reduce((s, p) => s + p[2], 0) / samples.length);
        backgroundColor = `rgb(${avgR},${avgG},${avgB})`;
      }
    } catch (_) {
      backgroundColor = '#ffffff';
    }

    // Crop out scrollbars if present.
    // clientWidth/clientHeight excludes scrollbars; innerWidth/innerHeight includes them.
    // If they differ, the difference is the scrollbar thickness — crop the image accordingly.
    const scrollbarX = Math.max(0, Math.round((window.innerWidth  - document.documentElement.clientWidth)  * dpr));
    const scrollbarY = Math.max(0, Math.round((window.innerHeight - document.documentElement.clientHeight) * dpr));

    if (scrollbarX > 0 || scrollbarY > 0) {
      try {
        const fullImg = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload  = () => resolve(image);
          image.onerror = () => reject(new Error('img load failed'));
          image.src = result.dataUrl;
        });
        const cropW = (fullImg.naturalWidth  || fullImg.width)  - scrollbarX;
        const cropH = (fullImg.naturalHeight || fullImg.height) - scrollbarY;
        if (cropW > 0 && cropH > 0) {
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width  = cropW;
          cropCanvas.height = cropH;
          const cropCtx = cropCanvas.getContext('2d');
          if (cropCtx) {
            cropCtx.drawImage(fullImg, 0, 0);
            const croppedDataUrl = cropCanvas.toDataURL('image/jpeg', 0.8);
            return { dataUrl: croppedDataUrl, backgroundColor };
          }
        }
      } catch (_) {
        // Crop failed — fall back to original
      }
    }

    return { dataUrl: result.dataUrl, backgroundColor };
  } finally {
    _isCapturing = false;
    // Always restore KickClip UI elements
    for (const { el, prevOpacity, prevTransition } of hiddenEls) {
      try {
        el.style.transition = prevTransition;
        el.style.opacity    = prevOpacity;
      } catch (e) {}
    }
    try {
      const currentActive = state.activeCoreItem;
      if (currentActive && currentActive.nodeType === 1) {
        showCoreHighlight(
          currentActive,
          checkIsSavedSync(
            String(state.lastExtractedMetadata?.activeHoverUrl || state.activeHoverUrl || '')
          )
        );
      }
    } catch (e) {}
  }
}

function withInstagramActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'INSTAGRAM') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const shortcode = String(meta?.shortcode || '').trim() || extracted.shortcode;
  if (!shortcode) return meta;
  const currentUrl = String(meta?.activeHoverUrl || '').trim();
  if (currentUrl) return meta;
  const assignedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
  return { ...meta, shortcode, activeHoverUrl: assignedUrl };
}

function withLinkedInCanonicalActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'LINKEDIN') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const shortcode = String(meta?.shortcode || '').trim() || extracted.shortcode;
  if (!/^\d{19}$/.test(shortcode)) return { ...meta, shortcode: null };
  const currentUrl = String(meta?.activeHoverUrl || '').trim();
  const assignedUrl =
    extracted.activeHoverUrl ||
    currentUrl ||
    `https://www.linkedin.com/feed/update/urn:li:activity:${shortcode}`;
  return { ...meta, shortcode, activeHoverUrl: assignedUrl };
}

function withThreadsActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'THREADS') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const activeHoverUrl = String(extracted.activeHoverUrl || meta?.activeHoverUrl || '').trim();
  if (!activeHoverUrl) return meta;
  const shortcode = String(meta?.shortcode || extracted.shortcode || activeHoverUrl).trim();
  const username = String(extracted.username || meta?.username || '').trim();
  const rawMessage = String(extracted.title || meta?.title || '').trim();
  const alreadyComposed = !!(username && rawMessage.startsWith(`${username}'s post\n`));
  const message = rawMessage.length > 180 ? `${rawMessage.slice(0, 180).trimEnd()}...` : rawMessage;
  let title = 'Threads post';
  if (alreadyComposed) {
    title = message;
  } else if (username && message) {
    title = `${username}'s post\n${message}`;
  } else if (message) {
    title = message;
  } else if (username) {
    title = `${username}'s post`;
  }
  return { ...meta, activeHoverUrl, shortcode, ...(username ? { username } : {}), title };
}

function withFacebookTimestampActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'FACEBOOK') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const fallbackUrl = String(meta?.activeHoverUrl || '').trim();
  const activeHoverUrl = String(extracted.activeHoverUrl || '').trim() || fallbackUrl;
  if (!activeHoverUrl) return meta;
  const imageUrl = String(extracted.imageUrl || '').trim();
  const rawTitle = String(extracted.title || meta?.title || '').trim();
  const username = String(extracted.username || meta?.username || '').trim();
  const nextMeta = { ...meta, activeHoverUrl };
  if (imageUrl) {
    nextMeta.image = { ...(meta?.image || {}), url: imageUrl };
  }
  if (username) {
    nextMeta.username = username;
    nextMeta.title = rawTitle ? `${username}'s post\n${rawTitle}` : `${username}'s post`;
  } else if (rawTitle) {
    nextMeta.title = rawTitle;
  } else {
    nextMeta.title = "Facebook's post";
  }
  if ('shortcode' in nextMeta) delete nextMeta.shortcode;
  return nextMeta;
}

function applyInstagramFallbackMetadata(meta = {}) {
  const baseTitle = String(meta?.title || '').trim();
  const fallbackTitle = baseTitle || String(document?.title || '').trim() || String(meta?.activeHoverUrl || '').trim() || '(No title)';
  const imageUrl = String(meta?.image?.url || meta?.thumbnail || '').trim();
  return {
    ...meta,
    title: fallbackTitle,
    ...(imageUrl ? { thumbnail: imageUrl, image: { ...(meta?.image || {}), url: imageUrl } } : {}),
  };
}

function requestInstagramPostDataForTypeB(coreItem, meta, clientX = null, clientY = null) {
  if (!coreItem || coreItem.nodeType !== 1) return;
  if (!chrome?.runtime?.sendMessage) return;
  const platform = String(meta?.platform || '').toUpperCase();
  const shortcode = String(meta?.shortcode || '').trim();
  if (platform !== 'INSTAGRAM' || !shortcode) return;

  const alreadyRequestedFor = instagramFetchInFlightByElement.get(coreItem);
  if (alreadyRequestedFor === shortcode) return;
  instagramFetchInFlightByElement.set(coreItem, shortcode);

  chrome.runtime.sendMessage(
    { action: 'get-instagram-post-data', shortcode },
    (result) => {
      instagramFetchInFlightByElement.delete(coreItem);
      const activeMeta = state.lastExtractedMetadata || {};
      const stillSameCoreItem = state.activeCoreItem === coreItem;
      const stillSameTarget =
        stillSameCoreItem &&
        String(activeMeta?.platform || '').toUpperCase() === 'INSTAGRAM' &&
        String(activeMeta?.shortcode || '').trim() === shortcode;

      if (!stillSameTarget) return;

      if (chrome?.runtime?.lastError) {
        state.lastExtractedMetadata = applyInstagramFallbackMetadata(activeMeta);
        // showMetadataTooltip disabled — CoreItem hover uses status badge only
        return;
      }

      const caption = String(result?.caption || '').trim();
      const thumbnailUrl = String(result?.thumbnailUrl || '').trim();
      const postUrl = String(result?.postUrl || '').trim();
      const hasUpdates = Boolean(caption || thumbnailUrl);
      if (!result?.success || !hasUpdates) {
        let fallbackMeta = applyInstagramFallbackMetadata(activeMeta);
        if (postUrl && !String(fallbackMeta?.activeHoverUrl || '').trim()) {
          fallbackMeta = { ...fallbackMeta, activeHoverUrl: postUrl };
        }
        state.lastExtractedMetadata = fallbackMeta;
        state.activeHoverUrl = String(state.lastExtractedMetadata?.activeHoverUrl || '').trim() || state.activeHoverUrl;
        // showMetadataTooltip disabled — CoreItem hover uses status badge only
        return;
      }

      const mergedMeta = {
        ...activeMeta,
        ...(caption ? { title: caption } : {}),
        ...(thumbnailUrl
          ? {
              thumbnail: thumbnailUrl,
              image: { ...(activeMeta?.image || {}), url: thumbnailUrl },
            }
          : {}),
        ...(postUrl ? { activeHoverUrl: postUrl } : {}),
      };
      state.lastExtractedMetadata = mergedMeta;
      state.activeHoverUrl = String(mergedMeta?.activeHoverUrl || '').trim() || state.activeHoverUrl;
      // showMetadataTooltip disabled — CoreItem hover uses status badge only
    }
  );
}

/**
 * For Type A CoreItems whose activeHoverUrl is an Instagram post URL,
 * fetches the thumbnail via background.js and updates the tooltip image.
 */
function requestInstagramThumbnailForTypeA(coreItem, meta, clientX = null, clientY = null) {
  try {
    const activeHoverUrl = String(meta?.activeHoverUrl || '').trim();
    // Only process Instagram post URLs
    const instagramPostMatch = activeHoverUrl.match(
      /^https?:\/\/(?:www\.)?instagram\.com\/p\/([^/?#]+)\/?/i
    );
    if (!instagramPostMatch) return;
    // Skip if image already present
    if (meta?.image?.url) return;

    const shortcode = instagramPostMatch[1];
    if (!shortcode) return;

    // Deduplicate: skip if already in flight for this element + shortcode
    const alreadyRequestedFor = instagramFetchInFlightByElement.get(coreItem);
    if (alreadyRequestedFor === shortcode) return;
    instagramFetchInFlightByElement.set(coreItem, shortcode);

    chrome.runtime.sendMessage(
      { action: 'get-instagram-post-data', shortcode },
      (result) => {
        instagramFetchInFlightByElement.delete(coreItem);
        if (chrome.runtime.lastError || !result?.success) return;

        const thumbnailUrl = String(result?.thumbnailUrl || '').trim();
        if (!thumbnailUrl) return;

        // Verify the CoreItem is still the active one
        const activeMeta = state.lastExtractedMetadata;
        const stillActive =
          state.activeCoreItem === coreItem &&
          String(activeMeta?.activeHoverUrl || '').trim() === activeHoverUrl;
        if (!stillActive) return;

        // Update metadata with fetched thumbnail
        state.lastExtractedMetadata = {
          ...activeMeta,
          image: { ...(activeMeta?.image || {}), url: thumbnailUrl },
        };
        state.activeHoverUrl = String(activeMeta?.activeHoverUrl || '').trim() || state.activeHoverUrl;

        // showMetadataTooltip disabled — CoreItem hover uses status badge only
      }
    );
  } catch (e) {}
}

function coreClear() {
  _aiAnalyzeSession++;
  if (IS_IFRAME) {
    state.activeCoreItem = null;
    state.activeHoverUrl = null;
    state.lastExtractedMetadata = null;
    try { hideCoreHighlight(); } catch (e) {}
    postHighlightToTop('show-fullpage');
  } else {
    clearCoreSelection();
    initPageLevelMetadata();
    // refreshPageStatusBadge() removed — badge is shown with correct
    // text inside the showFullPageHighlight() 80 ms timer callback.
  }
  _lastMouseoverTarget = null;
}

/**
 * Finds the first valid Type A anchor within a container (primary signal anchor).
 * Used as fallback when the hovered anchor fails validation.
 */
async function findPrimaryTypeAAnchor(container) {
  if (!container || container.nodeType !== 1) return null;
  const anchors = container.querySelectorAll?.('a[href]') || [];
  for (const a of anchors) {
    if (await isValidTypeAAnchor(a)) return a;
  }
  const getRoleLinkHrefLocal = (el) =>
    String(el.getAttribute?.('data-href')     || '').trim() ||
    String(el.getAttribute?.('data-url')      || '').trim() ||
    String(el.getAttribute?.('data-link')     || '').trim() ||
    String(el.getAttribute?.('data-href-url') || '').trim();

  // Fallback: role="link" + URL-bearing data attributes
  if (container.getAttribute?.('role') === 'link' && getRoleLinkHrefLocal(container)) {
    return container;
  }
  const roleLinkEls = Array.from(
    container.querySelectorAll?.('[role="link"]') || []
  ).filter((el) => !!getRoleLinkHrefLocal(el));
  if (roleLinkEls.length > 0) return roleLinkEls[0];
  return null;
}

async function updateCoreSelectionFromTarget(target, clientX = null, clientY = null) {
  if (!target || target.nodeType !== 1) {
    if (state.activeCoreItem) coreClear();
    return false;
  }
  ensureClusterCacheFromState();
  const coreItemContainer = findClusterContainerFromTarget(target);
  const active = state.activeCoreItem;
  if (!coreItemContainer) {
    if (state.activeCoreItem) coreClear();
    return false;
  }
  const evidenceType = getItemMapEvidenceType(coreItemContainer);
  if (evidenceType === 'A') {
    const anchor = target?.matches?.('a') ? target : target?.closest?.('a');
    const hasAnchor = !!anchor;
    const contained = hasAnchor && !!coreItemContainer.contains?.(anchor);

    // Also accept role="link" + URL data attributes as valid anchor signal
    const roleLinkEl = target?.closest?.('[role="link"][data-href], [role="link"][data-url], [role="link"][data-link], [role="link"][data-href-url]');
    const hasRoleLink = !!roleLinkEl && !!coreItemContainer.contains?.(roleLinkEl);

    const hasPointerCursor =
      target && window.getComputedStyle ? window.getComputedStyle(target).cursor === 'pointer' : false;
    const shouldExit =
      (hasAnchor && !contained) ||
      (!hasAnchor && !hasRoleLink && !hasPointerCursor);
    if (shouldExit) {
      if (state.activeCoreItem) coreClear();
      return false;
    }
  }

  // Type C: the hovered element itself is the CoreItem — no anchor traversal
  if (evidenceType === EVIDENCE_TYPE_C) {
    let mailUrl   = '';
    let mailTitle = '';
    let mailSender = '';

    const currentHref = String(window?.location?.href || '');

    if (currentHref.startsWith('https://mail.google.com/')) {
      // Gmail: build URL from data-legacy-thread-id
      const threadIdEl = coreItemContainer.querySelector?.('[data-legacy-thread-id]');
      const threadId   = threadIdEl?.getAttribute?.('data-legacy-thread-id') || '';
      mailUrl   = threadId
        ? `${window.location.origin}${window.location.pathname}#inbox/${threadId}`
        : '';
      mailTitle = threadId
        ? String(threadIdEl?.textContent || '').trim() || 'Gmail message'
        : 'Gmail message';
      // Extract sender — ordered fallback chain:
      // 1) span.yP[name] → name attribute (most reliable, Gmail standard)
      // 2) span.yP[email] → textContent
      // 3) any span[email] inside td.yX → name or textContent
      // 4) first span[email] anywhere in CoreItem → name or textContent
      try {
        const yPEl = coreItemContainer.querySelector?.('span.yP[name]')
          || coreItemContainer.querySelector?.('span.yP[email]');
        if (yPEl) {
          mailSender = yPEl.getAttribute?.('name')?.trim()
            || yPEl.textContent?.trim()
            || '';
        }
        if (!mailSender) {
          const tdSenderEl = coreItemContainer.querySelector?.('td.yX span[email]');
          mailSender = tdSenderEl?.getAttribute?.('name')?.trim()
            || tdSenderEl?.textContent?.trim()
            || '';
        }
        if (!mailSender) {
          const anyEmailEl = coreItemContainer.querySelector?.('span[email]');
          mailSender = anyEmailEl?.getAttribute?.('name')?.trim()
            || anyEmailEl?.textContent?.trim()
            || '';
        }
      } catch (_) {}

    } else if (currentHref.startsWith('https://mail.naver.com/')) {
      // Naver Mail: get href from .mail_title > a
      const anchor = coreItemContainer.querySelector?.('.mail_title a');
      const rawHref     = anchor?.getAttribute?.('href') || '';
      const cleanedHref = rawHref.replace('/popup/', '/');
      mailUrl = cleanedHref
        ? `${window.location.origin}${cleanedHref}`
        : '';
      // Title from .mail_title .text span
      const titleEl = coreItemContainer.querySelector?.('.mail_title .text');
      mailTitle = titleEl
        ? String(titleEl.textContent || '').trim() || 'Naver message'
        : 'Naver message';
      // Extract sender from button.button_sender — text nodes only (exclude .blind span)
      try {
        const senderBtn = coreItemContainer.querySelector?.('button.button_sender');
        if (senderBtn) {
          mailSender = Array.from(senderBtn.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => String(n.textContent || '').trim())
            .filter(Boolean)
            .join('') || '';
        }
      } catch (_) {}
    }

    state.activeCoreItem = coreItemContainer;
    state.activeHoverUrl = mailUrl;

    let mailCategory      = '';
    let mailPlatform      = '';
    let mailConfirmedType = '';
    if (mailUrl) {
      try {
        const mailCatResult = detectItemCategory(mailUrl, window.location.href, null);
        mailCategory      = mailCatResult?.category      || '';
        mailPlatform      = mailCatResult?.platform      || '';
        mailConfirmedType = mailCatResult?.confirmedType || '';
      } catch (_) {}
    }

    state.lastExtractedMetadata = {
      activeHoverUrl: mailUrl,
      title:          mailTitle,
      ...(mailCategory      ? { category:      mailCategory }      : {}),
      ...(mailPlatform      ? { platform:      mailPlatform }      : {}),
      ...(mailConfirmedType ? { confirmedType: mailConfirmedType } : {}),
      sender: mailSender,
    };
    if (IS_IFRAME) {
      postHighlightToTop('hide-fullpage');
      showCoreHighlight(coreItemContainer, false);
      if (!_isCapturing) {
        showCoreStatusBadge('default');
      }
      return true;
    }
    hideFullPageHighlight();
    showCoreHighlight(coreItemContainer, false);
    if (!_isCapturing) {
      // showMetadataTooltip disabled — CoreItem hover uses status badge only
      showCoreStatusBadge('default');
    }
    return true;
  }

  const platformForB = evidenceType === 'B' ? getCurrentPlatform() : '';

  // LinkedIn Type B detection is disabled until dedicated URL/image extraction
  // logic is implemented. Fall through to coreClear() to avoid
  // showing an incorrect CoreItem highlight or saving the wrong URL.
  if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    if (state.activeCoreItem) coreClear();
    return false;
  }

  const typeBEntry = evidenceType === 'B' ? getItemMapEntryByElement(coreItemContainer) : null;
  const cachedExtraction = typeBEntry?.cachedShortcodeNormalized ?? null;

  // ── Instagram: dedicated shortcode extraction runs FIRST ─────────────────
  // Extract shortcode without any visual/size/visibility checks.
  // If found, build the canonical post URL immediately and use it as the
  // authoritative activeHoverUrl regardless of what generic logic would find.
  let instagramPreresolvedUrl = '';
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    const shortcodeResult =
      cachedExtraction ??
      normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    const shortcode = String(shortcodeResult?.shortcode || '').trim();
    if (shortcode) {
      instagramPreresolvedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const shortcodeForB =
    evidenceType === 'B' && platformForB === 'INSTAGRAM'
      ? (cachedExtraction?.shortcode || '').trim() ||
        normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB).shortcode
      : '';
  let coreItem = coreItemContainer;
  let closestAtag = null;
  if (evidenceType === 'A') {
    const anchor = target?.matches?.('a') ? target : target?.closest?.('a');
    const anchorValid = anchor && (await isValidTypeAAnchor(anchor));
    const effectiveTarget = anchorValid ? target : await findPrimaryTypeAAnchor(coreItemContainer);
    if (!effectiveTarget) {
      if (state.activeCoreItem) coreClear();
      return false;
    }
    const itemMapElementsSet = new Set(
      (Array.isArray(state.itemMap) ? state.itemMap : [])
        .map((x) => x?.element)
        .filter(Boolean)
    );
    coreItem = await resolveTypeACoreItem(coreItemContainer, effectiveTarget, itemMapElementsSet);
    // Guard rail: if the resolved coreItem does not contain target, reject it.
    // This catches cases where resolveTypeACoreItem() returns a childWithClosest
    // that target is not actually inside.
    if (coreItem && coreItem !== coreItemContainer && !coreItem.contains?.(target)) {
      if (state.activeCoreItem) coreClear();
      return false;
    }
    closestAtag = anchorValid ? anchor : effectiveTarget;
  }
  const cacheOverrides =
    evidenceType === 'B' && typeBEntry?.cachedMetadata
      ? {
          cachedImage:
            typeBEntry.cachedMetadata.imageIsCustom && typeBEntry.cachedMetadata.image != null
              ? { value: typeBEntry.cachedMetadata.image, usedCustomLogic: true }
              : null,
          cachedTitle:
            typeBEntry.cachedMetadata.titleIsCustom && typeBEntry.cachedMetadata.title != null
              ? { value: typeBEntry.cachedMetadata.title, usedCustomLogic: true }
              : null,
        }
      : null;
  let meta =
    evidenceType === 'B' && typeBEntry?.cachedMetadata
      ? extractMetadataForCoreItem(coreItem, closestAtag, target, cacheOverrides) || {}
      : extractMetadataForCoreItem(coreItem, closestAtag, target) || {};

  // ── Instagram: override activeHoverUrl with pre-resolved URL ─────────────
  // If dedicated shortcode extraction succeeded, always use that URL.
  // Generic logic result is used only as fallback when shortcode was not found.
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM' && instagramPreresolvedUrl) {
    meta = {
      ...meta,
      activeHoverUrl: instagramPreresolvedUrl,
      platform: platformForB,
      shortcode: shortcodeForB,
    };
  } else if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    // Shortcode extraction failed — fall back to generic withInstagramActiveHoverUrl
    meta = withInstagramActiveHoverUrl(
      { ...meta, platform: platformForB, ...(shortcodeForB ? { shortcode: shortcodeForB } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    const li = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    meta = withLinkedInCanonicalActiveHoverUrl(
      { ...meta, platform: platformForB, ...(li.shortcode ? { shortcode: li.shortcode } : {}), ...(li.activeHoverUrl ? { activeHoverUrl: li.activeHoverUrl } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'THREADS') {
    const th = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    meta = withThreadsActiveHoverUrl(
      { ...meta, platform: platformForB, ...(th.shortcode ? { shortcode: th.shortcode } : {}), ...(th.activeHoverUrl ? { activeHoverUrl: th.activeHoverUrl } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'FACEBOOK') {
    const fb = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    meta = withFacebookTimestampActiveHoverUrl(
      { ...meta, platform: platformForB, ...(fb.activeHoverUrl ? { activeHoverUrl: fb.activeHoverUrl } : {}), ...(fb.imageUrl ? { image: { ...(meta?.image || {}), url: fb.imageUrl } } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  }
  if (!meta?.activeHoverUrl) {
    // Keep current state briefly to avoid flicker around tiny DOM gaps.
    if (active && active.contains?.(target)) {
      hideFullPageHighlight();
      showCoreHighlight(
        active,
        false
      );
      // positionMetadataTooltip disabled — CoreItem hover uses status badge only
      return true;
    }
    if (state.activeCoreItem) coreClear();
    return false;
  }
  let syncedMeta = meta;
  if (evidenceType === 'B') {
    const platform = getCurrentPlatform();
    syncedMeta = { ...syncedMeta, platform };
    if (platform !== 'FACEBOOK') {
      const shortcodeResult = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
      if (shortcodeResult?.shortcode) {
        syncedMeta = {
          ...syncedMeta,
          shortcode: shortcodeResult.shortcode,
          ...(shortcodeResult.activeHoverUrl ? { activeHoverUrl: shortcodeResult.activeHoverUrl } : {}),
        };
      }
    }
    // If instagramPreresolvedUrl was already set, skip withInstagramActiveHoverUrl
    // to prevent it from being overridden or blocked
    if (instagramPreresolvedUrl) {
      syncedMeta = {
        ...syncedMeta,
        activeHoverUrl: instagramPreresolvedUrl,
      };
    } else {
      syncedMeta = withInstagramActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
    }
    syncedMeta = withLinkedInCanonicalActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
    syncedMeta = withThreadsActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
    syncedMeta = withFacebookTimestampActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
  }
  // Detect category at hover time so it can be included in the save payload
  if (syncedMeta.activeHoverUrl) {
    try {
      const htmlCtx = extractCoreItemHtmlContext(coreItem);
      const { category, platform, confirmedType } = detectItemCategory(
        syncedMeta.activeHoverUrl,
        window.location.href,
        htmlCtx
      );
      syncedMeta = { ...syncedMeta, category };
      if (platform)      syncedMeta = { ...syncedMeta, platform };
      if (confirmedType) syncedMeta = { ...syncedMeta, confirmedType };
    } catch (e) {}
  }
  if (IS_IFRAME) {
    state.activeCoreItem = coreItem;
    state.activeHoverUrl = syncedMeta.activeHoverUrl;
    state.lastExtractedMetadata = syncedMeta;
    postHighlightToTop('hide-fullpage');
    showCoreHighlight(coreItem, false);
    if (!_isCapturing) {
      showCoreStatusBadge('default');
    }
    if (evidenceType === 'B') {
      requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, null, null);
    }
    return true;
  }
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  hideFullPageHighlight();
  showCoreHighlight(coreItem, false);
  if (!_isCapturing) {
    // showMetadataTooltip disabled — CoreItem hover uses status badge only
    showCoreStatusBadge('default');
  }
  if (evidenceType === 'B') {
    requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  if (evidenceType === 'A') {
    requestInstagramThumbnailForTypeA(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  return true;
}

/**
 * Analyzes a URL via the AI server and updates the tooltip with Type + Summary.
 * Uses a session token to discard stale responses when the user has already
 * moved to a different CoreItem.
 */
let _aiAnalyzeSession = 0;
const _aiUrlCache = new Map(); // url → { type, summary }

async function analyzeUrlForTooltip(url) {
  if (!url) return;
  const session = ++_aiAnalyzeSession;

  // Cache hit — show result instantly without calling the API
  if (_aiUrlCache.has(url)) {
    const cached = _aiUrlCache.get(url);
    setAiTooltipContent({ type: cached.type, summary: cached.summary });
    return;
  }

  clearAiTooltipContent(); // show "Analyzing..." immediately
  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'ai-analyze-url', url },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.success) {
            reject(new Error(response?.error || 'Unknown error'));
            return;
          }
          resolve(response.data);
        }
      );
    });
    // Discard if user has moved to a different CoreItem
    if (session !== _aiAnalyzeSession) return;
    _aiUrlCache.set(url, { type: result.type, summary: result.summary });
    setAiTooltipContent({ type: result.type, summary: result.summary });
  } catch (e) {
    if (session !== _aiAnalyzeSession) return;
    setAiTooltipContent({ type: '', summary: 'Analysis unavailable.' });
  }
}

function schedulePreScan(scope = document, force = false, trigger = 'unknown') {
  if (scanTimer) return;
  // Use requestIdleCallback so detectItemMaps() only runs when the browser
  // is idle — this prevents it from blocking rAF-based overlay animations.
  // timeout: 2000 ensures it still runs within 2 seconds even if the browser
  // stays busy (e.g. on heavy pages like YouTube).
  const idleCallback = async () => {
    console.log(`[KC:preScan] trigger="${trigger}" scope=${scope === document ? 'document' : 'scoped'} force=${force}`);
    scanTimer = 0;
    // Clear navigation flag — this scan is now running, so the next
    // MutationObserver trigger should use scoped scan again.
    _forceFullScanOnMutation = false;
    const isFullScan = scope === document;
    const newCandidates = await detectItemMaps(scope);
    let candidates;
    if (isFullScan) {
      // Full scan: detectItemMaps() already updated state.itemMap — use as-is.
      candidates = newCandidates;
    } else {
      // Scoped scan: merge new candidates with existing items outside the scope.
      // detectItemMaps() did not overwrite state.itemMap when root !== document,
      // so we merge here and update state.itemMap manually.
      const existing = Array.isArray(state.itemMap) ? state.itemMap : [];
      const outsideScope = existing.filter(
        (item) => item?.element && !scope.contains(item.element)
      );
      candidates = [...outsideScope, ...newCandidates];
      state.itemMap = candidates;
    }
    const attrAwarePart = Array.isArray(candidates)
      ? candidates
          .map((c) => `${c.signature || c.key || ''}`)
          .sort()
          .slice(0, 80)
          .join('|')
      : '';
    const fp = `${getItemMapFingerprint(candidates)}::${attrAwarePart}`;
    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;
    renderItemMapCandidates(candidates);

    // Retry logic: when a forced full-document scan finds no candidates,
    // schedule another forced scan after 500ms (up to 3 retries).
    // This handles SPA frameworks (e.g. Vue keep-alive) that restore DOM
    // asynchronously after navigation — the first scan may run before
    // the framework has finished mounting the list.
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 500;
    if (force && isFullScan && candidates.length === 0 && _retryScanCount < MAX_RETRIES) {
      _retryScanCount += 1;
      if (_retryScanTimer) window.clearTimeout(_retryScanTimer);
      _retryScanTimer = window.setTimeout(() => {
        _retryScanTimer = 0;
        if (scanTimer) {
          if (typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(scanTimer);
          } else {
            window.clearTimeout(scanTimer);
          }
          scanTimer = 0;
        }
        schedulePreScan(document, true, 'retry');
      }, RETRY_DELAY_MS);
    }
  };
  if (force) {
    // Force scans (SPA navigation, PiP transition, etc.) run immediately —
    // DOM is already updated so there is no need to wait for idle time.
    scanTimer = window.setTimeout(idleCallback, 0);
  } else if (typeof window.requestIdleCallback === 'function') {
    scanTimer = window.requestIdleCallback(idleCallback, { timeout: 2000 });
  } else {
    // Fallback for browsers that do not support requestIdleCallback (e.g. Safari)
    scanTimer = window.setTimeout(idleCallback, 80);
  }
}

function mountObservers() {
  function registerObserver(isRecovery = false) {
    const targetNode = window.document.documentElement || window.document.body;
    if (!targetNode) return;

    const obs = new MutationObserver((mutations) => {
      // Only call schedulePreScan() when a meaningful content node is added.
      // Non-visual tags and text/comment nodes do not affect ItemMap detection.
      const NON_VISUAL_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT']);
      // On YouTube, all mutations inside #video-preview are thumbnail preview
      // rendering and are unrelated to ItemMap detection — skip them entirely.
      const isYouTube = /^https:\/\/www\.youtube\.com(\/|$)/.test(
        String(window.location.href || '')
      );
      for (const mutation of mutations) {
        if (isYouTube && mutation.target?.closest?.('#video-preview')) continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (NON_VISUAL_TAGS.has(String(node.tagName || '').toUpperCase())) continue;
          // Skip DOM changes inside #video-preview and ytd-miniplayer —
          // these are YouTube's thumbnail preview and miniplayer overlays
          // which are unrelated to ItemMap detection.
          // Other ytd-app subtree changes (e.g. PiP transition, related videos)
          // are allowed through so ItemMap re-scans correctly.
          if (node.closest?.('#video-preview') || node.closest?.('ytd-miniplayer')) continue;
          // After a SPA navigation, always run a full document scan with force=true
          // so that frameworks like Vue that re-render the full list are correctly detected.
          // Otherwise, run a full document scan on meaningful DOM additions.
          if (_forceFullScanOnMutation) {
            _forceFullScanOnMutation = false;
            schedulePreScan(document, true, 'mutation-force');
          } else {
            schedulePreScan(document, false, 'mutation-normal');
          }
          return;
        }
      }
    });

    obs.observe(targetNode, { childList: true, subtree: true });

    // Detect document.open(): after document.open(), document.documentElement
    // is replaced. Poll every 200ms; if the live document's root differs from
    // our observed node, disconnect, re-register on the new document, and continue.
    const checkInterval = window.setInterval(() => {
      const liveRoot = window.document.documentElement;
      if (liveRoot !== targetNode) {
        obs.disconnect();
        window.clearInterval(checkInterval);
        schedulePreScan(document, false, 'doc-open-recovery');
        window.__kcWindowListenersMounted = false;
        mountWindowListeners();
        registerObserver(true);
      }
    }, 200);
  }
  registerObserver();
}

function extractPageOpenGraphMeta() {
  const url = String(window.location.href || '').trim();
  const title =
    String(document.querySelector('meta[property="og:title"]')?.content || '').trim() ||
    String(document.title || '').trim() ||
    url;
  return { url, title };
}

/**
 * Extracts a lightweight visual context object from a CoreItem element.
 * Used to help AI infer the content type based on what the element contains.
 */
function extractCoreItemHtmlContext(element) {
  if (!element) return null;
  try {
    const rect = element.getBoundingClientRect();
    const totalArea = rect.width * rect.height;

    const MIN_CONTENT_SIZE = Math.max(
      32,
      typeof window !== 'undefined' ? Math.max(0, (window.innerWidth || 0) * 0.03) : 0
    );
    const isVisuallySignificantImage = (w, h) => {
      if (w < MIN_CONTENT_SIZE || h < MIN_CONTENT_SIZE) return false;
      const ratio = h > 0 ? w / h : Infinity;
      return ratio >= 0.2 && ratio <= 5.0;
    };

    const getMinimalMediaContainerRect = (img, boundary) => {
      try {
        const isMeaningfulSibling = (el) => {
          try {
            if (!el || el.nodeType !== 1) return false;
            if (el === img) return false;
            const tag = String(el.tagName || '').toUpperCase();
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) return false;
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || (r.width <= 0 && r.height <= 0)) return false;
            const hasChildren = el.children && el.children.length > 0;
            const hasText = (el.textContent || '').trim().length > 0;
            if (!hasChildren && !hasText) return false;
            return true;
          } catch (e) {
            return false;
          }
        };

        let current = img;
        let bestRect = img.getBoundingClientRect ? img.getBoundingClientRect() : null;

        while (current && current !== boundary && current.parentElement && current.parentElement !== boundary) {
          const parent = current.parentElement;
          const siblings = Array.from(parent.children || []).filter((c) => c !== current);
          const hasMeaningfulSibling = siblings.some(isMeaningfulSibling);
          if (hasMeaningfulSibling) break;
          const pr = parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
          if (pr && (pr.width > 0 || pr.height > 0)) bestRect = pr;
          current = parent;
        }

        if (bestRect && (bestRect.width < 10 || bestRect.height < 10) && img.parentElement) {
          const pr = img.parentElement.getBoundingClientRect?.();
          if (pr && pr.width >= 10 && pr.height >= 10) return pr;
        }

        return bestRect;
      } catch (e) {
        return img.getBoundingClientRect ? img.getBoundingClientRect() : null;
      }
    };

    // Collect images with size info (visually significant only)
    const images = Array.from(element.querySelectorAll('img')).map((img) => {
      const r = getMinimalMediaContainerRect(img, element);
      const rectW = r?.width  || 0;
      const rectH = r?.height || 0;
      // Fallback: when getBoundingClientRect() returns an incomplete size
      // (e.g. height:auto not yet computed, or container clipping),
      // use naturalWidth/naturalHeight or data-thumb-* attributes.
      const fallbackW = img.naturalWidth  || Number(img.getAttribute('data-thumb-width'))  || 0;
      const fallbackH = img.naturalHeight || Number(img.getAttribute('data-thumb-height')) || 0;
      const w = rectW > 10 ? Math.round(rectW) : Math.round(fallbackW);
      const h = rectH > 10 ? Math.round(rectH) : Math.round(fallbackH);
      return {
        src:    (img.src || img.getAttribute('data-src') || '').substring(0, 200),
        width:  w,
        height: h,
        alt:    (img.alt || '').substring(0, 80),
      };
    }).filter(i => isVisuallySignificantImage(i.width, i.height));

    // Collect videos
    const videos = Array.from(element.querySelectorAll('video, [data-video], iframe[src*="youtube"], iframe[src*="vimeo"]')).map((v) => {
      const r = v.getBoundingClientRect();
      return {
        src:    (v.src || v.getAttribute('data-src') || v.getAttribute('src') || '').substring(0, 200),
        width:  Math.round(r.width),
        height: Math.round(r.height),
      };
    }).filter(v => v.width > 0 || v.src);

    // Dominant media area ratio (0–1)
    const mediaArea = [...images, ...videos].reduce((sum, m) => sum + (m.width * m.height), 0);
    const mediaRatio = totalArea > 0 ? Math.round((mediaArea / totalArea) * 100) / 100 : 0;

    // Inner text (trimmed, max 200 chars)
    const innerText = (element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ').trim().substring(0, 200);

    // Tag name and key attributes
    const tagName = element.tagName || '';
    const href    = (element.href || element.getAttribute('href') || '').substring(0, 200);
    const role    = element.getAttribute('role') || '';
    const ariaLabel = element.getAttribute('aria-label') || '';

    return {
      tagName,
      href,
      role,
      ariaLabel: ariaLabel.substring(0, 80),
      boundingBox: { width: Math.round(rect.width), height: Math.round(rect.height) },
      mediaRatio,
      imageCount:  images.length,
      videoCount:  videos.length,
      images:      images.slice(0, 3),  // max 3 images
      videos:      videos.slice(0, 2),  // max 2 videos
      innerText,
    };
  } catch {
    return null;
  }
}

async function getCachedUserIdForShutter() {
  try {
    const r = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    });
    if (r?.userId) return r.userId;
    await new Promise((res) => setTimeout(res, 150));
    const r2 = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    });
    return r2?.userId || null;
  } catch {
    return null;
  }
}

async function isKCLocalServerReachable() {
  return true;
}

async function isKCLocalServerReachableViaBackground() {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-server-status' }, (res) => {
        resolve(chrome.runtime.lastError ? null : res);
      });
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

/** `'success'` | `'error'` — passed to `triggerShutterEffect` for green/red shutter + status badge. */
async function resolveSaveShutterStatus() {
  const [uid, serverOk] = await Promise.all([
    getCachedUserIdForShutter(),
    IS_IFRAME ? isKCLocalServerReachableViaBackground() : isKCLocalServerReachable(),
  ]);
  return uid && serverOk ? 'success' : 'error';
}

/**
 * Extracts the sender name from the DOM when viewing a specific email thread.
 * Only applies to Gmail and Naver Mail email thread pages.
 * Returns empty string if not on an email thread page or sender not found.
 */
function extractPageMailSender() {
  try {
    const href = String(window?.location?.href || '');

    // Gmail: real thread page has hash with two segments e.g. #inbox/{id}
    if (href.startsWith('https://mail.google.com/')) {
      const hash = window.location.hash || '';
      const parts = hash.replace(/^#/, '').split('/').filter(Boolean);
      if (parts.length < 2) return ''; // folder page, not a thread
      // span.gD[name] or span.gD[email] — first match wins
      const senderEl = document.querySelector('span.gD[name], span.gD[email]');
      if (senderEl) {
        return (
          senderEl.getAttribute('name') ||
          senderEl.textContent ||
          ''
        ).trim();
      }
      return '';
    }

    // Naver Mail: real thread page is /v2/read/{folderId}/{mailId}
    if (href.startsWith('https://mail.naver.com/')) {
      const pathname = window.location.pathname.toLowerCase();
      if (!pathname.startsWith('/v2/read/')) return ''; // folder page
      // .mail_option_item.sender .button_user — first text node only
      const btn = document.querySelector('.mail_option_item.sender .button_user');
      if (btn) {
        const textNode = Array.from(btn.childNodes).find(
          (n) => n.nodeType === Node.TEXT_NODE && String(n.textContent || '').trim().length > 0
        );
        return textNode ? String(textNode.textContent || '').trim() : '';
      }
      return '';
    }
  } catch (e) {}
  return '';
}

async function saveActiveCoreItem(request = {}) {
  const saveShutterStatus = await resolveSaveShutterStatus();
    const activeItem = state.activeCoreItem;
    const activeUrl = String(state.activeHoverUrl || '').trim();

    // No CoreItem active → save current page via OpenGraph metadata
    if (!activeItem || !activeUrl) {
      // Step 1: hide FullPageHighlight + StatusBadge for screenshot
      const pageOverlayEl = document.getElementById('blink-fullpage-highlight-overlay');
      const pageBadgeEl = document.getElementById('blink-status-badge-page');
      if (pageOverlayEl) { pageOverlayEl.style.transition = ''; pageOverlayEl.style.opacity = '0'; }
      if (pageBadgeEl)   { pageBadgeEl.style.transition = '';   pageBadgeEl.style.opacity = '0'; }

      const { url, title } = extractPageOpenGraphMeta();
      if (!url) {
        if (pageOverlayEl) { pageOverlayEl.style.transition = ''; pageOverlayEl.style.opacity = '1'; }
        if (pageBadgeEl)   { pageBadgeEl.style.transition = '';   pageBadgeEl.style.opacity = ''; }
        return { success: false, reason: 'missing-url' };
      }

      const youtubeShortcode = extractYouTubeShortcodeFromUrl(url);
      const youtubeThumbnailUrl = youtubeShortcode ? getYouTubeThumbnailUrl(youtubeShortcode) : '';
      const isYouTubeSave = !!youtubeThumbnailUrl;

      let pageScreenshotBase64 = null;
      let pageScreenshotBgColor = null;
      if (!isYouTubeSave) {
        // capturePageScreenshotBase64 handles waitForRepaint + 32ms internally
        const pageScreenshotResult = await capturePageScreenshotBase64();
        if (pageScreenshotResult) {
          pageScreenshotBase64 = pageScreenshotResult.dataUrl;
          pageScreenshotBgColor = pageScreenshotResult.backgroundColor;
        }
      } else {
        pageScreenshotBase64 = null;
        pageScreenshotBgColor = null;
      }

      // Request userId from background.js (cached from sidepanel sign-in)
      let userId = null;
      try {
        // First attempt — service worker may be asleep
        const userIdResponse = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
            if (chrome.runtime.lastError) {
              // Service worker was asleep or not ready — resolve with null to trigger retry
              resolve(null);
            } else {
              resolve(response);
            }
          });
        });

        if (userIdResponse?.userId) {
          userId = userIdResponse.userId;
        } else {
          // Retry once after a short delay to allow service worker to wake up
          await new Promise((r) => setTimeout(r, 150));
          const retryResponse = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
              if (chrome.runtime.lastError) {
                resolve(null);
              } else {
                resolve(response);
              }
            });
          });
          userId = retryResponse?.userId || null;
        }
      } catch {
        userId = null;
      }

      // Gmail: fetch auth token so server can read mail content
      let gmailToken = null;
      if (url.startsWith('https://mail.google.com/')) {
        gmailToken = await getGmailAuthToken();
      }

      // Naver Mail: collect login cookies for server-side Puppeteer injection
      let naverCookies = null;
      if (url.startsWith('https://mail.naver.com/')) {
        naverCookies = await getNaverCookies();
      }

      const pageCategory      = String(state.lastExtractedMetadata?.category      || '').trim();
      const pagePlatform      = String(state.lastExtractedMetadata?.platform      || '').trim();
      const pageConfirmedType = String(state.lastExtractedMetadata?.confirmedType || '').trim();
      // Extract sender from DOM when saving a real email thread page
      const pageSender = pageCategory === 'Mail' ? extractPageMailSender() : '';
      // Fetch page description via background.js HTTP fetch —
      // more reliable than DOM-based extraction since it reads
      // the raw HTML source, the same way chat app link previews work.
      let pageDescription = '';
      if (pageCategory === 'Page') {
        try {
          const metaResponse = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { action: 'fetch-metadata', url },
              (response) => {
                resolve(chrome.runtime.lastError ? null : response);
              }
            );
          });
          if (metaResponse?.success && metaResponse.description) {
            pageDescription = String(metaResponse.description).trim();
          }
        } catch (e) {}
      }
      const payload = {
        url,
        title: title || url,
        timestamp: Date.now(),
        saved_by: 'browser-extension',
        userLanguage: navigator.language || 'en',
        page_save: true,
        ...(pageScreenshotBase64 ? { screenshot_base64: pageScreenshotBase64 } : {}),
        ...(pageScreenshotBgColor ? { screenshot_bg_color: pageScreenshotBgColor } : {}),
        ...(pageCategory      ? { category:       pageCategory }      : {}),
        ...(pagePlatform      ? { platform:        pagePlatform }      : {}),
        ...(pageConfirmedType ? { confirmed_type:  pageConfirmedType } : {}),
        ...(pageSender        ? { sender:          pageSender }        : {}),
        ...(pageCategory === 'Page' ? { page_description: pageDescription } : {}),
        is_portrait: !isYouTubeSave && pageCategory === 'Page' && !!pageScreenshotBase64,
        img_url_method: isYouTubeSave ? 'youtube-thumbnail' : 'screenshot',
        ...(isYouTubeSave ? { img_url: youtubeThumbnailUrl } : {}),
        ...(userId ? { userId } : {}),
        ...(gmailToken ? { gmail_token: gmailToken } : {}),
        ...(naverCookies ? { naver_cookies: naverCookies } : {}),
      };

      // Optimistic UI: notify Side Panel to show a temporary card immediately
      // Skip if running inside an iframe — only the top-level frame should create optimistic cards
      if (window.self === window.top) {
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
          chrome.runtime.sendMessage({
            action:             'optimistic-card',
            tempId,
            url,
            title:              title || url,
            imgUrl:             isYouTubeSave ? youtubeThumbnailUrl : (pageScreenshotBase64 || ''),
            isScreenshot:       !isYouTubeSave && !!pageScreenshotBase64,
            screenshotPadding:  0,
            screenshotBgColor:  pageScreenshotBgColor || '',
            category:           pageCategory || '',
            platform:           pagePlatform || '',
            confirmedType:      pageConfirmedType || '',
            sender:             pageSender || '',
            page_description:   pageDescription || '',
            img_url_method:     isYouTubeSave ? 'youtube-thumbnail' : 'screenshot',
            createdAt:           Date.now(),
          });
        } catch { /* Side Panel may not be open — silently ignore */ }
      }

      // Immediately update _savedUrlSet before shutter so checkIsSavedSync() returns true
      // even if saved-urls-updated arrives before fetch completes.
      try {
        const savedUrl = normalizeUrlForSavedCheck(url);
        if (savedUrl) _savedUrlSet.add(savedUrl);
      } catch (e) {}

      triggerShutterEffect('page', saveShutterStatus);

      if (pageOverlayEl) { pageOverlayEl.style.transition = ''; pageOverlayEl.style.opacity = '1'; }
      if (pageBadgeEl)   { pageBadgeEl.style.transition = '';   pageBadgeEl.style.opacity = ''; }
      resetFullPageHideTimer();

      const response = await fetch(`${KC_SERVER_URL}/api/v1/save-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`save failed: ${response.status}`);
      }

      return { success: true, payload };
    }

    // CoreItem active → existing logic
    const meta = state.lastExtractedMetadata;
    const url = String(meta?.activeHoverUrl || activeUrl).trim();
    if (!url) return { success: false, reason: 'missing-url' };
    const youtubeShortcode = extractYouTubeShortcodeFromUrl(url);
    const youtubeThumbnailUrl = youtubeShortcode ? getYouTubeThumbnailUrl(youtubeShortcode) : '';
    const isYouTubeSave = !!youtubeThumbnailUrl;

    // Step 1: hide CoreHighlight + StatusBadge for screenshot
    const coreOverlayEl = document.getElementById('blink-highlight-overlay');
    const coreBadgeEl = document.getElementById('blink-status-badge-core');
    if (coreOverlayEl) { coreOverlayEl.style.transition = ''; coreOverlayEl.style.opacity = '0'; }
    if (coreBadgeEl)   { coreBadgeEl.style.transition = '';   coreBadgeEl.style.opacity = '0'; }

    const title = String(meta?.title || document.title || url).trim();
    const imgUrl = isYouTubeSave
      ? youtubeThumbnailUrl
      : String(request?.img_url || meta?.image?.url || '').trim();
    // Reflects whether extractImageFromCoreItem() produced a result —
    // independent of which URL is ultimately used as img_url.
    const isExtractedImg = !!(meta?.image?.url && String(meta.image.url).trim().length > 0);

    const isPage = meta?.category === 'Page';

    // Calculate overlay_ratio from the active CoreItem's bounding rect
    let overlayRatio;
    try {
      const activeCoreEl = state.activeCoreItem; // the DOM element currently highlighted
      if (activeCoreEl && typeof activeCoreEl.getBoundingClientRect === 'function') {
        const rect = activeCoreEl.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          overlayRatio = parseFloat((rect.width / rect.height).toFixed(4));
        }
      }
    } catch (e) {}

    // For iframe relay saves, activeCoreItem is a stub {} — fall back to relayed ratio
    if (!Number.isFinite(overlayRatio)) {
      const relayedRatio = meta?._overlayRatio;
      if (Number.isFinite(relayedRatio)) {
        overlayRatio = relayedRatio;
      }
    }

    const isPortraitExtracted =
      isPage &&
      isExtractedImg;

    // CoreItem saves never capture a screenshot — just wait for repaint.
    await waitForRepaint();
    await new Promise((resolve) => setTimeout(resolve, 32));

    // When no image was extracted from the CoreItem, resolve the
    // best available favicon URL from the page DOM.
    // Priority:
    //   1. <link rel="apple-touch-icon">          — 180×180, high quality
    //   2. <link rel="icon"> with largest sizes    — site-specified HD icon
    //   3. <link rel="icon"> or "shortcut icon"    — generic icon fallback
    //   4. {origin}/apple-touch-icon.png           — same-origin direct URL
    //   5. {origin}/favicon.ico                    — last resort
    // All sources are either DOM-read or same-origin, so server-side
    // IP blocking and CORS restrictions do not apply.
    const faviconImgUrl = imgUrl || (() => {
      try {
        // In an iframe the content script runs in the iframe's document,
        // which has no <link> icon tags. Derive the correct page origin
        // from the relayed parent page URL instead of window.location.
        const isInIframe = IS_IFRAME || window.self !== window.top;
        const pageUrl = meta?._pageUrl || window.location.href;
        const origin = (() => {
          try { return new URL(pageUrl).origin; } catch (e) { return window.location.origin; }
        })();

        // 0. Custom bundled assets for known domains — checked first,
        // regardless of iframe context. Keyed by service name and
        // matched against any subdomain or TLD variant of that name.
        const CUSTOM_FAVICON_MAP = {
          'google': 'assets/favicons/google.png',
          'naver':  'assets/favicons/naver.png',
        };
        try {
          const hostname = new URL(pageUrl).hostname.toLowerCase();
          for (const [service, assetPath] of Object.entries(CUSTOM_FAVICON_MAP)) {
            if (
              hostname === service ||
              hostname.startsWith(`${service}.`) ||
              hostname.includes(`.${service}.`) ||
              hostname.endsWith(`.${service}`)
            ) {
              const assetUrl = chrome.runtime?.getURL?.(assetPath);
              if (assetUrl) return assetUrl;
            }
          }
        } catch (e) { /* fall through to DOM-based extraction */ }

        if (!isInIframe) {
          // Top-frame: read <link> tags from the live page DOM.

          // 1. apple-touch-icon link tag
          const appleTouchIcon = document.querySelector(
            'link[rel="apple-touch-icon"]'
          );
          if (appleTouchIcon?.href) return String(appleTouchIcon.href).trim();

          // 2. link[rel="icon"] with explicit sizes — pick largest
          const iconLinks = Array.from(
            document.querySelectorAll('link[rel="icon"][sizes]')
          );
          if (iconLinks.length > 0) {
            const sorted = iconLinks.slice().sort((a, b) => {
              const sizeOf = (el) => {
                const s = String(el.getAttribute('sizes') || '').toLowerCase();
                if (s === 'any') return 9999;
                const m = s.match(/(\d+)/);
                return m ? parseInt(m[1], 10) : 0;
              };
              return sizeOf(b) - sizeOf(a);
            });
            const best = sorted[0];
            if (best?.href) return String(best.href).trim();
          }

          // 3. generic icon or shortcut icon
          const genericIcon = document.querySelector(
            'link[rel="icon"], link[rel="shortcut icon"]'
          );
          if (genericIcon?.href) return String(genericIcon.href).trim();
        }

        // 4. same-origin apple-touch-icon.png (works for both top and iframe,
        //    using the correct parent page origin).
        if (origin) return `${origin}/apple-touch-icon.png`;

        // 5. same-origin favicon.ico
        if (origin) return `${origin}/favicon.ico`;

        return '';
      } catch (e) {
        return '';
      }
    })();

    // Immediately update _savedUrlSet before shutter so checkIsSavedSync() returns true
    // even if saved-urls-updated arrives before fetch completes.
    try {
      const savedUrl = normalizeUrlForSavedCheck(url);
      if (savedUrl) _savedUrlSet.add(savedUrl);
    } catch (e) {}

    triggerShutterEffect('core', saveShutterStatus);

    if (coreOverlayEl) { coreOverlayEl.style.transition = ''; coreOverlayEl.style.opacity = '1'; }
    if (coreBadgeEl)   { coreBadgeEl.style.transition = '';   coreBadgeEl.style.opacity = ''; }

    // Request userId from background.js (cached from sidepanel sign-in)
    let userId = null;
    try {
      // First attempt — service worker may be asleep
      const userIdResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
          if (chrome.runtime.lastError) {
            // Service worker was asleep or not ready — resolve with null to trigger retry
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });

      if (userIdResponse?.userId) {
        userId = userIdResponse.userId;
      } else {
        // Retry once after a short delay to allow service worker to wake up
        await new Promise((r) => setTimeout(r, 150));
        const retryResponse = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
            if (chrome.runtime.lastError) {
              resolve(null);
            } else {
              resolve(response);
            }
          });
        });
        userId = retryResponse?.userId || null;
      }
    } catch {
      userId = null;
    }

    // Gmail: fetch auth token so server can read mail content
    let gmailToken = null;
    if (url.startsWith('https://mail.google.com/')) {
      gmailToken = await getGmailAuthToken();
    }

    // Naver Mail: collect login cookies for server-side Puppeteer injection
    let naverCookies = null;
    if (url.startsWith('https://mail.naver.com/')) {
      naverCookies = await getNaverCookies();
    }

    // Extract HTML context from the active CoreItem for AI type inference
    const htmlContext = extractCoreItemHtmlContext(activeItem);
    // Fetch page_description via background.js HTTP fetch when
    // category is Page — same approach as the full-page save path.
    let coreItemPageDescription = '';
    if (isPage) {
      try {
        const coreMetaResponse = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'fetch-metadata', url },
            (response) => {
              resolve(chrome.runtime.lastError ? null : response);
            }
          );
        });
        if (coreMetaResponse?.success && coreMetaResponse.description) {
          coreItemPageDescription = String(coreMetaResponse.description).trim();
        }
      } catch (e) {}
    }

    const payload = {
      url,
      title: title || url,
      timestamp: Date.now(),
      saved_by: 'browser-extension',
      userLanguage: navigator.language || 'en',
      pageUrl: meta?._pageUrl || window.location.href,
      ...(htmlContext ? { htmlContext } : {}),
      ...(faviconImgUrl ? { img_url: faviconImgUrl } : {}),
      is_extracted_img: isExtractedImg,
      ...(userId ? { userId } : {}),
      ...(meta?.category      ? { category:       meta.category }      : {}),
      ...(meta?.platform      ? { platform:        meta.platform }      : {}),
      ...(meta?.confirmedType ? { confirmed_type:  meta.confirmedType } : {}),
      sender: meta?.sender ?? '',
      ...(gmailToken ? { gmail_token: gmailToken } : {}),
      ...(naverCookies ? { naver_cookies: naverCookies } : {}),
      ...(Number.isFinite(overlayRatio) ? { overlay_ratio: overlayRatio } : {}),
      is_portrait: isPortraitExtracted,
      ...(isPage ? { page_description: coreItemPageDescription } : {}),
      img_url_method: isYouTubeSave
        ? 'youtube-thumbnail'
        : (isExtractedImg ? 'extracted' : 'favicon'),
    };

    // Optimistic UI: notify Side Panel to show a temporary card immediately
    // Skip if running inside an iframe — only the top-level frame should create optimistic cards
    if (window.self === window.top) {
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        chrome.runtime.sendMessage({
          action:             'optimistic-card',
          tempId,
          url,
          title:              title || url,
          imgUrl:             faviconImgUrl || '',
          isScreenshot:       false,
          screenshotPadding:  0,
          screenshotBgColor:  '',
          category:           String(meta?.category      || '').trim(),
          platform:           String(meta?.platform      || '').trim(),
          confirmedType:      String(meta?.confirmedType || '').trim(),
          sender:             String(meta?.sender        || '').trim(),
          ...(isPage ? { page_description: coreItemPageDescription } : {}),
          img_url_method: isYouTubeSave
            ? 'youtube-thumbnail'
            : (isExtractedImg ? 'extracted' : 'favicon'),
          createdAt:          Date.now(),
        });
      } catch { /* Side Panel may not be open — silently ignore */ }
    }

    const response = await fetch(`${KC_SERVER_URL}/api/v1/save-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`save failed: ${response.status}`);
    }

    return { success: true, payload };
}

function mountSaveMessageListener() {
  if (window.__kcSaveMessageListenerMounted) return;
  if (!chrome?.runtime?.onMessage?.addListener) return;
  window.__kcSaveMessageListenerMounted = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === 'sidepanel-opened') {
      _sidePanelFocused = true;
      _sidePanelOpen = true;
      return false;
    }
    if (request?.action === 'sidepanel-closed') {
      _sidePanelFocused = false;
      _sidePanelOpen = false;
      return false;
    }
    if (request?.action === 'saved-urls-updated') {
      chrome.runtime.sendMessage({ action: 'get-saved-urls' }, (response) => {
        if (chrome.runtime.lastError) return;
        const entries = response?.urls;
        if (Array.isArray(entries)) {
          const normalized = normalizeSavedUrlsResponse(entries);
          // Merge with existing set to preserve locally pre-added URLs
          // that may not yet be reflected in Firestore at this point.
          _savedUrlSet = new Set([..._savedUrlSet, ...normalized]);
        }
        if (IS_IFRAME || window.self !== window.top) return;
        try {
          if (!_pageMetaInitialized) {
            _pageMetaInitialized = true;
            // initPageLevelMetadata() calls showFullPageHighlight() which
            // handles badge show via its 80 ms timer callback.
            initPageLevelMetadata();
          } else if (!state.activeCoreItem && _kcUserReady) {
            // Only re-trigger the overlay + badge when the user is logged in.
            // In the non-logged-in state, saved-urls-updated is fired by the
            // Side Panel opening (stopListeners → syncSavedUrlsToSession([])),
            // not by a real data change — refreshing the badge here would race
            // against _kcUserReady and briefly show "Save It!" instead of the
            // shortcut prompt.
            const pageOverlay = document.getElementById('blink-fullpage-highlight-overlay');
            if (pageOverlay && pageOverlay.style.opacity === '1') {
              showFullPageHighlight(false, refreshPageStatusBadge);
            }
          }
        } catch (e) {}
      });
      return false;
    }
    if (request?.action !== 'save-url') return false;
    if (!_kcUserReady) {
      sendResponse({ success: false, reason: 'not-signed-in' });
      return false;
    }

    // Iframes must never handle save-url directly — only via KC_SAVE_QUERY postMessage.
    // Fetching localhost from a cross-origin iframe is blocked by CORS.
    if (IS_IFRAME) return false;

    (async () => {
      try {
        if (!state.activeCoreItem && !state.activeHoverUrl) {
          // Attempt to re-identify CoreItem at current pointer position.
          // This handles the case where clear grace timer fired between the
          // keyboard shortcut and the save-url message arriving.
          try {
            const x = Number(lastPointerX);
            const y = Number(lastPointerY);
            if (isFinite(x) && isFinite(y)) {
              const pointerEl = document.elementFromPoint(x, y);
              if (pointerEl) {
                await updateCoreSelectionFromTarget(pointerEl, x, y);
              }
            }
          } catch (e) {}
        }

        // If top frame has no active CoreItem, check if any iframe does
        if (!state.activeCoreItem && !state.activeHoverUrl) {
          let iframeHandled = false;
          let iframeRelayData = null;

          const handleIframeResponse = (e) => {
            try {
              if (!e.data || !e.data[KC_MSG_PREFIX] || e.data[KC_SAVE_HANDLED] !== true) return;
              iframeHandled = true;
              if (e.data[KC_SAVE_RELAY] === true) {
                iframeRelayData = e.data;
              }
            } catch (e) {}
          };
          window.addEventListener('message', handleIframeResponse, { passive: true });

          try {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            for (const iframe of iframes) {
              try {
                iframe.contentWindow?.postMessage(
                  { [KC_MSG_PREFIX]: true, [KC_SAVE_QUERY]: true },
                  '*'
                );
              } catch (e) {}
            }
          } catch (e) {}

          await new Promise((resolve) => setTimeout(resolve, 80));
          window.removeEventListener('message', handleIframeResponse);

          if (iframeHandled && iframeRelayData) {
            const prevActiveCoreItem = state.activeCoreItem;
            const prevActiveHoverUrl = state.activeHoverUrl;
            const prevLastExtractedMetadata = state.lastExtractedMetadata;
            try {
              const relayRequest = {
                img_url: iframeRelayData.imgUrl || '',
              };
              state.activeCoreItem = {};
              state.activeHoverUrl = iframeRelayData.url || '';
              state.lastExtractedMetadata = {
                activeHoverUrl: iframeRelayData.url || '',
                title: iframeRelayData.title || '',
                category: iframeRelayData.category || '',
                platform: iframeRelayData.platform || '',
                confirmedType: iframeRelayData.confirmedType || '',
                image: iframeRelayData.imgUrl ? { url: iframeRelayData.imgUrl } : null,
                _screenshotBase64: iframeRelayData.screenshotBase64 || null,
                _screenshotBgColor: iframeRelayData.screenshotBgColor || null,
                _overlayRatio: Number.isFinite(iframeRelayData.overlay_ratio)
                  ? iframeRelayData.overlay_ratio
                  : null,
                _pageUrl: iframeRelayData.pageUrl || '',
                _isExtractedImg: typeof iframeRelayData.isExtractedImg === 'boolean'
                  ? iframeRelayData.isExtractedImg
                  : !!(iframeRelayData.imgUrl && String(iframeRelayData.imgUrl).trim().length > 0),
                _isIframeRelay: true,
              };

              const result = await saveActiveCoreItem(relayRequest);
              sendResponse(result);
            } catch (err) {
              sendResponse({ success: false, error: String(err?.message || err) });
            } finally {
              state.activeCoreItem = prevActiveCoreItem;
              state.activeHoverUrl = prevActiveHoverUrl;
              state.lastExtractedMetadata = prevLastExtractedMetadata;
            }
            return;
          }

          if (iframeHandled) {
            sendResponse({ success: true, handledByIframe: true });
            return;
          }
        }

        const result = await saveActiveCoreItem(request);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: String(error?.message || error) });
      }
    })();

    return true;
  });

  if (IS_IFRAME) {
    window.addEventListener(
      'message',
      async (e) => {
        try {
          if (!e.data || !e.data[KC_MSG_PREFIX] || e.data[KC_SAVE_QUERY] !== true) return;
          const activeItem = state.activeCoreItem;
          const activeUrl = String(state.activeHoverUrl || '').trim();
          if (!activeItem || !activeUrl) return;

          const saveFeedbackHidden = hideKCSaveFeedbackUi();
          const saveBlinkStartedAt = Date.now();
          try {
            const saveShutterStatus = await resolveSaveShutterStatus();
            triggerShutterEffect('core', saveShutterStatus);
            await waitForRepaint();

            const meta = state.lastExtractedMetadata || {};
            const imgUrl = String(meta?.image?.url || '').trim();

            let screenshotBase64 = null;
            let screenshotBgColor = null;
            if (!imgUrl && activeItem && activeItem.nodeType === 1) {
              const screenshotResult = await captureScreenshotBase64(activeItem);
              if (screenshotResult) {
                screenshotBase64 = screenshotResult.dataUrl;
                screenshotBgColor = screenshotResult.backgroundColor;
              }
            }

            // Calculate overlay_ratio from the iframe's active CoreItem bounding rect
            let overlayRatioRelay;
            try {
              const iframeCoreEl = state.activeCoreItem;
              if (iframeCoreEl && typeof iframeCoreEl.getBoundingClientRect === 'function') {
                const iframeRect = iframeCoreEl.getBoundingClientRect();
                if (iframeRect && iframeRect.width > 0 && iframeRect.height > 0) {
                  overlayRatioRelay = parseFloat((iframeRect.width / iframeRect.height).toFixed(4));
                }
              }
            } catch (e) {}

            window.top.postMessage(
              {
                [KC_MSG_PREFIX]: true,
                [KC_SAVE_HANDLED]: true,
                [KC_SAVE_RELAY]: true,
                url: activeUrl,
                title: String(meta?.title || '').trim(),
                imgUrl,
                screenshotBase64,
                screenshotBgColor,
                category: String(meta?.category || '').trim(),
                platform: String(meta?.platform || '').trim(),
                confirmedType: String(meta?.confirmedType || '').trim(),
                ...(Number.isFinite(overlayRatioRelay) ? { overlay_ratio: overlayRatioRelay } : {}),
                isExtractedImg: !!(meta?.image?.url && String(meta.image.url || '').trim().length > 0),
                pageUrl: String(window.location.href || '').trim(),
              },
              '*'
            );
          } finally {
            await finalizeKCSaveFeedback(saveFeedbackHidden, saveBlinkStartedAt);
          }
        } catch (err) {}
      },
      { passive: true }
    );
  }
}

function mountWindowListeners() {
  if (window.__kcWindowListenersMounted) return;
  window.__kcWindowListenersMounted = true;

  window.addEventListener('load', () => schedulePreScan(document, false, 'window-load'), { passive: true });
  window.addEventListener('scroll', async () => {
    const active = state.activeCoreItem;

    if (!active) return;
    // Compute current rect for the active CoreItem and pass it as rectOverride
    // so showCoreHighlight() treats this as a scroll update (isScrollUpdate = true),
    // skipping updateBorderSvg() and animation restart.
    const scrollRect = active.getBoundingClientRect?.();
    const rectOverride = scrollRect && scrollRect.width > 0 && scrollRect.height > 0
      ? { top: scrollRect.top, left: scrollRect.left, width: scrollRect.width, height: scrollRect.height, right: scrollRect.right }
      : null;
    // Keep highlight stable while scrolling, even before next hover event.
    showCoreHighlight(
      active,
      false,
      rectOverride
    );
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => schedulePreScan(document, false, 'window-resize'), { passive: true });
  window.addEventListener('mouseover', async (e) => {
    if (!_kcUserReady) return;
    if (!_windowFocused) return;
    lastPointerX = e?.clientX ?? lastPointerX;
    lastPointerY = e?.clientY ?? lastPointerY;
    const target = e?.target && e.target.nodeType === 1 ? e.target : null;
    if (target === _lastMouseoverTarget) return;
    _lastMouseoverTarget = target;
    // On YouTube, ignore mouseover events whose target is inside #video-preview —
    // the preview overlay renders on top of thumbnails and intercepts mouse events,
    // causing CoreHighlight to be incorrectly dismissed.
    if (
      target?.closest?.('#video-preview') &&
      /^https:\/\/www\.youtube\.com(\/|$)/.test(String(window.location.href || ''))
    ) return;
    // Skip if the target is inside the already-active CoreItem —
    // no highlight change is needed and coreClear must not fire.
    const active = state.activeCoreItem;
    if (active && target && active.contains(target)) return;
    await updateCoreSelectionFromTarget(target, e.clientX, e.clientY);
  }, { passive: true, capture: true });
  window.addEventListener('mousemove', (e) => {
    lastPointerX = e?.clientX ?? lastPointerX;
    lastPointerY = e?.clientY ?? lastPointerY;

    // StatusBadge: show on first mousemove (top frame only)
    if (!_mouseHasMovedOnPage) {
      _mouseHasMovedOnPage = true;
      _mouseInsideDocument = true;
    }
    if (state.activeCoreItem) {
      positionCoreStatusBadge(e.clientX, e.clientY);
    }
    // Page badge stays fixed — no repositioning needed

    // positionMetadataTooltip disabled — CoreItem hover uses status badge only
  }, { passive: true, capture: true });

  // mouseout with null relatedTarget means the pointer truly left the document
  // (e.g. moved to address bar, side panel, or another app).
  // This is more reliable than mouseleave for browser UI transitions.
  document.addEventListener('mouseout', (e) => {
    if (IS_IFRAME) {
      // iframe context: when the pointer leaves the iframe document,
      // clean up any active CoreHighlight and notify the top frame to
      // restore the FullPageHighlight. coreClear() handles both.
      try {
        const to = e.relatedTarget || e.toElement;
        if ((!to || !document.contains(to)) && state.activeCoreItem) {
          coreClear();
        }
      } catch (_) {}
      return;
    }
    // top-frame context: pointer left the browser viewport entirely.
    if (!e.relatedTarget && !e.toElement) {
      _mouseInsideDocument = false;
      try { hidePageStatusBadge(); hideCoreStatusBadge(); } catch (_) {}
      try { hideFullPageHighlight(); hideCoreHighlight(); } catch (_) {}
    }
  }, { passive: true });

  // mouseover fires when pointer re-enters from outside the document.
  document.addEventListener('mouseover', (e) => {
    if (!_mouseInsideDocument) {
      _mouseInsideDocument = true;
      if (IS_IFRAME) return; // top frame handles badge state
      if (!_mouseHasMovedOnPage) return;
      try {
      if (state.activeCoreItem) {
        showCoreHighlight(state.activeCoreItem, false);
        showCoreStatusBadge('default');
      } else {
        initPageLevelMetadata();
      }
      } catch (e) {}
    }
  }, { passive: true });

  // ── SPA navigation detection ──────────────────────────────────────────────
  // Forces a full document re-scan when the URL changes without a page reload.
  // Resets lastFingerprint and cancels any pending scanTimer so the new page's
  // content is always scanned from scratch.
  function resetAndFullScan() {
    _mouseHasMovedOnPage = false;
    _mouseInsideDocument = false;
    // Cancel any pending idle/timeout scan before scheduling a new one
    if (scanTimer) {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(scanTimer);
      } else {
        window.clearTimeout(scanTimer);
      }
      scanTimer = 0;
    }
    // Cancel any pending retry and reset counter for this new navigation
    if (_retryScanTimer) {
      window.clearTimeout(_retryScanTimer);
      _retryScanTimer = 0;
    }
    _retryScanCount = 0;
    lastFingerprint = '';
    _forceFullScanOnMutation = true;
    schedulePreScan(document, true, 'spa-navigation');
  }

  // popstate: browser back/forward navigation
  window.addEventListener('popstate', resetAndFullScan, { passive: true });

  // hashchange: hash-only URL changes (e.g. Gmail folder switching #inbox → #sent)
  window.addEventListener('hashchange', resetAndFullScan, { passive: true });

  // yt-navigate-finish: YouTube's custom SPA navigation complete event.
  // Fires after YouTube has fully rendered the new page content — more accurate
  // than pushState which fires before rendering. Only active on youtube.com.
  window.addEventListener('yt-navigate-finish', () => {
    if (/^https:\/\/www\.youtube\.com(\/|$)/.test(String(window.location.href || ''))) {
      resetAndFullScan();
    }
  }, { passive: true });

  // pushState / replaceState: SPA routing (patch history methods)
  // Guard against double-patching if mountWindowListeners() is called again
  if (!window.__blinkHistoryPatched) {
    window.__blinkHistoryPatched = true;
    const _isYouTubeOrigin = () =>
      /^https:\/\/www\.youtube\.com(\/|$)/.test(String(window.location.href || ''));
    const _origPushState = history.pushState.bind(history);
    history.pushState = (...args) => {
      _origPushState(...args);
      // On YouTube, yt-navigate-finish handles the scan after rendering is complete.
      // Calling resetAndFullScan() here would scan before content is ready.
      if (!_isYouTubeOrigin()) resetAndFullScan();
    };
    const _origReplaceState = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      _origReplaceState(...args);
      if (!_isYouTubeOrigin()) resetAndFullScan();
    };
  }

  // Suppress CoreHighlight / hover when the tab is hidden or window loses focus; restore when back.
  if (!IS_IFRAME) {
    // Shared hide logic for when the browser loses focus or tab becomes hidden.
    const onBrowserHidden = () => {
      _windowFocused = false;
      try { hideFullPageHighlight(); } catch (e) {}
      try { hideCoreHighlight(); }   catch (e) {}
      try { hideMetadataTooltip(); }   catch (e) {}
      try { if (!IS_IFRAME) { hidePageStatusBadge(); hideCoreStatusBadge(); } }       catch (e) {}
      state.activeCoreItem       = null;
      state.activeHoverUrl       = null;
      state.lastExtractedMetadata = null;
    };

    // Shared restore logic for when the browser regains focus or tab becomes visible.
    const onBrowserVisible = () => {
      _windowFocused = true;
      try { initPageLevelMetadata(); } catch (e) {}
      if (_mouseHasMovedOnPage) {
        try {
          refreshPageStatusBadge();
        } catch (e) {}
      }
    };

    // Case 1: tab switch (visibilitychange fires, window.blur also fires but
    // document.hasFocus() check below will handle dedup correctly)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        onBrowserHidden();
      } else {
        onBrowserVisible();
      }
    }, { passive: true });

    // Case 2: focus moved to another app or window (visibilitychange does NOT fire).
    // Use a short delay then check document.hasFocus() to distinguish real app-level
    // blur from in-page focus shifts (e.g. clicking an input, iframe gaining focus).
    window.addEventListener('blur', () => {
      setTimeout(() => {
        // Do not treat as not-focused if the Side Panel has taken focus —
        // the Side Panel is part of the KickClip Chrome extension, not an external app.
        if (!document.hasFocus() && !_sidePanelFocused) {
          onBrowserHidden();
        }
      }, 100);
    }, { passive: true });

    // Restore when the window regains focus from another app/window.
    window.addEventListener('focus', () => {
      if (document.visibilityState !== 'hidden') {
        onBrowserVisible();
      }
    }, { passive: true });
  }
}

function mountIframeSaveQueryListener() {
  if (window.__kcIframeSaveQueryListenerMounted) return;
  window.__kcIframeSaveQueryListenerMounted = true;
  window.addEventListener(
    'message',
    (e) => {
      try {
        if (!e.data || !e.data[KC_MSG_PREFIX] || e.data[KC_SAVE_HANDLED] !== true) return;
        // An iframe reported it handled the save — nothing to do in top frame
      } catch (e) {}
    },
    { passive: true }
  );
}

function mountIframeFullPageListener() {
  if (window.__kcIframeFullPageListenerMounted) return;
  window.__kcIframeFullPageListenerMounted = true;
  window.addEventListener('message', (e) => {
    try {
      const data = e.data;
      if (!data || !data[KC_MSG_PREFIX]) return;
      if (data.type === 'hide-fullpage') {
        hideFullPageHighlight();
      } else if (data.type === 'show-fullpage') {
        initPageLevelMetadata();
      }
    } catch (err) {}
  }, { passive: true });
}

async function checkKcUserAndInit() {
  try {
    const result = await new Promise((resolve) => {
      chrome.storage.local.get('kickclipUserId', resolve);
    });
    const hasUser = !!result?.kickclipUserId;
    _kcUserReady = hasUser;
  } catch (e) {
    _kcUserReady = false;
  }
  // Always mount lifecycle regardless of login state.
  // CoreItem features are gated by _kcUserReady inside their handlers.
  mountLifecycle();
  window.__kcMainLoaded = true;
  mountKcAuthWatcher();
}

function mountKcAuthWatcher() {
  if (window.__kcAuthWatcherMounted) return;
  window.__kcAuthWatcherMounted = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Sign-in detected
    if (changes.kickclipUserId?.newValue && !_kcUserReady) {
      _kcUserReady = true;
      return;
    }

    // Sign-out detected
    if ('kickclipUserId' in changes && !changes.kickclipUserId?.newValue && _kcUserReady) {
      _kcUserReady = false;
      // Force-hide all KickClip UI immediately
      try {
        const ids = [
          'blink-highlight-overlay',
          'blink-fullpage-highlight-overlay',
          'blink-status-badge-page',
          'blink-status-badge-core',
        ];
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el) { el.style.transition = ''; el.style.opacity = '0'; }
        }
      } catch (e) {}
    }
  });
}

function mountLifecycle() {
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => schedulePreScan(document, false, 'DOMContentLoaded'),
      { once: true }
    );
  } else {
    schedulePreScan(document, false, 'lifecycle-immediate');
  }
  mountWindowListeners();
  mountObservers();
  mountSaveMessageListener();
  mountInstagramShortcodeObserver();
  // Only show full-page highlight and init page metadata in the top frame.
  // iframe contexts still run CoreItem detection but must not render the
  // full-page overlay.
  if (window.self === window.top) {
    // Populate _savedUrlSet from background cache (restored from chrome.storage.local)
    // before running initPageLevelMetadata() so the first isSaved check is accurate.
    try {
      chrome.runtime.sendMessage({ action: 'get-saved-urls' }, (response) => {
        if (!chrome.runtime.lastError && Array.isArray(response?.urls)) {
          const normalized = normalizeSavedUrlsResponse(response.urls);
          _savedUrlSet = new Set(normalized);
        }
        // Only init page meta here if saved-urls-updated hasn't
        // already done it (e.g. on normal page load without sign-in delay)
        if (!_pageMetaInitialized) {
          _pageMetaInitialized = true;
          initPageLevelMetadata();
        }
      });
    } catch (e) {
      if (!_pageMetaInitialized) {
        _pageMetaInitialized = true;
        initPageLevelMetadata();
      }
    }
    mountIframeSaveQueryListener();
    mountIframeFullPageListener();
  }
}

window.__kcApplyCoreItem = (coreItem) => {
  const evidenceType = getItemMapEvidenceType(coreItem);
  const platformForB = evidenceType === 'B' ? getCurrentPlatform() : '';
  const shortcodeForB =
    evidenceType === 'B' && platformForB === 'INSTAGRAM'
      ? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB).shortcode
      : '';
  let meta = extractMetadataForCoreItem(coreItem, null, coreItem) || {};
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    meta = withInstagramActiveHoverUrl({ ...meta, platform: platformForB, ...(shortcodeForB ? { shortcode: shortcodeForB } : {}) }, coreItem);
  } else if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    const li = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withLinkedInCanonicalActiveHoverUrl(
      { ...meta, platform: platformForB, ...(li.shortcode ? { shortcode: li.shortcode } : {}), ...(li.activeHoverUrl ? { activeHoverUrl: li.activeHoverUrl } : {}) },
      coreItem
    );
  } else if (evidenceType === 'B' && platformForB === 'THREADS') {
    const th = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withThreadsActiveHoverUrl(
      { ...meta, platform: platformForB, ...(th.shortcode ? { shortcode: th.shortcode } : {}), ...(th.activeHoverUrl ? { activeHoverUrl: th.activeHoverUrl } : {}) },
      coreItem
    );
  } else if (evidenceType === 'B' && platformForB === 'FACEBOOK') {
    const fb = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withFacebookTimestampActiveHoverUrl(
      { ...meta, platform: platformForB, ...(fb.activeHoverUrl ? { activeHoverUrl: fb.activeHoverUrl } : {}), ...(fb.imageUrl ? { image: { ...(meta?.image || {}), url: fb.imageUrl } } : {}) },
      coreItem
    );
  }
  if (!meta?.activeHoverUrl) {
    _aiAnalyzeSession++;
    if (IS_IFRAME) {
      state.activeCoreItem = null;
      state.activeHoverUrl = null;
      state.lastExtractedMetadata = null;
      try { hideCoreHighlight(); } catch (e) {}
      postHighlightToTop('show-fullpage');
    } else {
      clearCoreSelection();
      initPageLevelMetadata();
    }
    return null;
  }
  let syncedMeta = meta;
  if (evidenceType === 'B') {
    const platform = getCurrentPlatform();
    syncedMeta = { ...syncedMeta, platform };
    if (platform !== 'FACEBOOK') {
      const shortcodeResult = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
      if (shortcodeResult.shortcode) {
        syncedMeta = {
          ...syncedMeta,
          shortcode: shortcodeResult.shortcode,
          ...(shortcodeResult.activeHoverUrl ? { activeHoverUrl: shortcodeResult.activeHoverUrl } : {}),
        };
      }
    }
    syncedMeta = withInstagramActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withLinkedInCanonicalActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withThreadsActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withFacebookTimestampActiveHoverUrl(syncedMeta, coreItem);
  }
  // Detect category at hover time so it can be included in the save payload
  if (syncedMeta.activeHoverUrl) {
    try {
      const htmlCtx = extractCoreItemHtmlContext(coreItem);
      const { category, platform, confirmedType } = detectItemCategory(
        syncedMeta.activeHoverUrl,
        window.location.href,
        htmlCtx
      );
      syncedMeta = { ...syncedMeta, category };
      if (platform)      syncedMeta = { ...syncedMeta, platform };
      if (confirmedType) syncedMeta = { ...syncedMeta, confirmedType };
    } catch (e) {}
  }
  if (IS_IFRAME) {
    state.activeCoreItem = coreItem;
    state.activeHoverUrl = syncedMeta.activeHoverUrl;
    state.lastExtractedMetadata = syncedMeta;
    postHighlightToTop('hide-fullpage');
    showCoreHighlight(coreItem, false);
    if (!_isCapturing) {
      showCoreStatusBadge('default');
    }
    const coreRect = coreItem.getBoundingClientRect ? coreItem.getBoundingClientRect() : null;
    let tipX = null;
    let tipY = null;
    if (coreRect && coreRect.width > 0 && coreRect.height > 0) {
      tipX = coreRect.right;
      tipY = coreRect.top;
    }
    if (evidenceType === 'B') {
      requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, tipX, tipY);
    }
    return syncedMeta;
  }
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  showCoreHighlight(coreItem, false);
  const rect = coreItem.getBoundingClientRect ? coreItem.getBoundingClientRect() : null;
  const x = rect ? rect.right : null;
  const y = rect ? rect.top : null;
  // showMetadataTooltip disabled — CoreItem hover uses status badge only
  showCoreStatusBadge('default');
  if (evidenceType === 'B') {
    requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, x, y);
  }
  return syncedMeta;
};

// Do not run in Electron-based desktop apps (e.g. Claude Desktop, VS Code, Notion).
// These apps embed a Chromium engine but are not regular browser tabs —
// KickClip should only operate in a real browser context.
const _isElectronApp = typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Electron');

if (!_isElectronApp) {
  checkKcUserAndInit();
}
