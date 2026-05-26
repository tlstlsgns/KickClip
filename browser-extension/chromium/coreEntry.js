import { state } from './stateLite.js';
import {
  detectItemMaps,
  EVIDENCE_TYPE_IMAGE_ANCHOR,
  getItemMapFingerprint,
  findItemByImage,
  getItemMapEntryByElement,
  isValidImageAnchor,
  extractMetadataForCoreItem,
  extractImageFromCoreItem,
  extractShortcode,
  mountInstagramShortcodeObserver,
  getCurrentPlatform,
  normalizeShortcodeExtractionResult,
  showCoreHighlight,
  markCoreHighlightClipped,
  hideCoreHighlight,
  clearCoreSelection,
  ensureClusterCacheFromState,
  showMetadataTooltip,
  positionMetadataTooltip,
  showCoreStatusBadge,
  setCoreBadgeTexts,
  setCoreStatusBadgeText,
  hideCoreStatusBadge,
  positionCoreStatusBadge,
  renderItemMapCandidates,
  hideMetadataTooltip,
  detectItemCategory,
  resolveAnchorUrl,
} from './coreEngine.js';
import {
  extractYouTubeShortcodeFromUrl,
  getYouTubeThumbnailUrl,
  resolveAbsoluteImageUrl,
  extractVideoMediaInfo,
  resolveClipImageUrl,
} from './dataExtractor.js';
import {
  getKCShadowRoot,
  getKCShadowElement,
  getKCBadgeShadowElement,
  isCoreHighlightShown,
} from './uiManager.js';
import {
  determineTypeDOverlayElement,
  findDominantImagesInElement,
  findHoverCompanions,
  isMediaElement,
} from './itemDetector.js';
import { getShortcut, onShortcutChange, matchesShortcut, formatShortcut } from './shortcutStore.js';

let _kcUserReady = false; // true when kickclipUserId is confirmed
/** Readable gate for signed-in save / optimistic UI (signed-out = clipboard-only exploration). */
function isSignedIn() {
  return _kcUserReady === true;
}
// === PHASE_BADGE_SHORTCUT_SYNC ===
// Module-level cache of the active clip shortcut. Shared by:
//   - syncCoreBadgeTexts() — for the in-page "Press X to clip" badge.
//   - The keydown listener in PHASE_KEYDOWN_SHORTCUT — for shortcut matching.
//
// Backed by shortcutStore.js (chrome.storage.local.kickclipShortcutV2).
// Initialized at module load below; refreshed via onShortcutChange.
let _activeShortcut = null;
// === END PHASE_BADGE_SHORTCUT_SYNC ===

let scanTimer = 0;
let lastFingerprint = '';
let lastRenderedElementSet = null;
let _retryScanTimer = 0;    // setTimeout handle for pending retry scan
let _retryScanCount  = 0;   // number of retries attempted for current navigation
let _forceFullScanOnMutation = false; // true after navigation: next MutationObserver trigger uses full document scan
let lastPointerX = null;
let lastPointerY = null;
let _lastMouseoverTarget = null;
// === PHASE_COREITEM_LIVE_METADATA ===
// MutationObserver for live refresh of state.lastExtractedMetadata when the
// hovered activeCoreItem's <a> descendants change (added / removed / href).
// Lazy DOM updates (e.g., Google Images populating <a href> with the
// imgurl=ENCODED_FULL_URL parameter via JavaScript after hover) would
// otherwise leave the frozen hover-snapshot stale until next hover.
//
// Observer is attached on hover-set, detached on every hover-clear path
// (coreClear top + iframe branches, onBrowserHidden).
//
// Debounce ~50ms — burst mutations during framework render cycles collapse
// to a single refresh.
let _coreItemMutationObserver = null;
let _coreItemMetadataDebounceTimer = null;
let _observedCoreItemElement = null;
// === END PHASE_COREITEM_LIVE_METADATA ===
const instagramFetchInFlightByElement = new WeakMap();

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
// === PHASE_IFRAME_HOVER_PROPAGATION ===
const KC_IFRAME_HOVER = '__kc_iframe_hover__';
const KC_IFRAME_HOVER_END = '__kc_iframe_hover_end__';
const KC_IFRAME_CLIPBOARD_RESULT = '__kc_iframe_clipboard_result__';
// === END PHASE_IFRAME_HOVER_PROPAGATION ===
// === PHASE_IFRAME_CLIP_REQUEST ===
const KC_IFRAME_CLIP_REQUEST = '__kc_iframe_clip_request__';
// === END PHASE_IFRAME_CLIP_REQUEST ===

/** Metadata tooltip id — hidden briefly during save (shutter uses overlay fills in uiManager). */
const METADATA_TOOLTIP_ID = 'kickclip-metadata-tooltip';
const SAVE_FEEDBACK_KC_MIN_MS = 80;

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

// === PHASE_BADGE_SHORTCUT_SYNC ===
// Initialize the shared _activeShortcut cache from shortcutStore.js, then
// keep the in-page badge text in sync as the user changes the shortcut.
// The same _activeShortcut is read by the keydown listener (no separate
// subscription needed there).
function initShortcutSync() {
  // Initial fetch.
  (async () => {
    try {
      _activeShortcut = await getShortcut();
      syncCoreBadgeTexts();
    } catch (_) {
      // _activeShortcut stays null; syncCoreBadgeTexts falls back to 'shortcut'.
    }
  })();
  // Subscribe to changes.
  try {
    onShortcutChange((shortcut) => {
      _activeShortcut = shortcut;
      syncCoreBadgeTexts();
    });
  } catch (_) {}
}
// === END PHASE_BADGE_SHORTCUT_SYNC ===

/**
 * Build the current status_badge texts from the cached shortcut and
 * register them with uiManager. Called at init and whenever the
 * shortcut changes via onShortcutChange.
 */
function syncCoreBadgeTexts() {
  const display = _activeShortcut ? formatShortcut(_activeShortcut) : 'shortcut';
  setCoreBadgeTexts({
    defaultText: `Press ${display} to clip`,
    failedText: 'Clip failed',
  });
}

initShortcutSync();

// Waits for the browser to complete two paint frames.
// Used to ensure DOM visibility changes are reflected on screen.
function waitForRepaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// === PHASE_KC_UI_HIDE_FOR_SCREENSHOT ===
// Hide all KickClip overlays (highlight, badge, metadata tooltip) before
// a tab screenshot capture. Returns the array of hidden elements with
// their previous opacity values, to pass to restoreKCAfterScreenshot.
function hideKCForScreenshot() {
  const hidden = [];
  try {
    // Highlight overlay (main shadow root)
    const overlay = getKCShadowElement('kickclip-highlight-overlay');
    if (overlay && overlay.style.opacity !== '0') {
      hidden.push({ el: overlay, prevOpacity: overlay.style.opacity });
      overlay.style.opacity = '0';
    }
    // Status badge (badge shadow root)
    const badge = getKCBadgeShadowElement('kickclip-status-badge-core');
    if (badge && badge.style.opacity !== '0') {
      hidden.push({ el: badge, prevOpacity: badge.style.opacity });
      badge.style.opacity = '0';
    }
    // Metadata tooltip (badge shadow root)
    const tooltip = getKCBadgeShadowElement(METADATA_TOOLTIP_ID);
    if (tooltip && tooltip.style.opacity !== '0') {
      hidden.push({ el: tooltip, prevOpacity: tooltip.style.opacity });
      tooltip.style.opacity = '0';
    }
  } catch (_) { /* defensive */ }
  return hidden;
}

function restoreKCAfterScreenshot(hidden) {
  if (!Array.isArray(hidden)) return;
  for (const { el, prevOpacity } of hidden) {
    try { el.style.opacity = prevOpacity; } catch (_) {}
  }
}
// === END PHASE_KC_UI_HIDE_FOR_SCREENSHOT ===

/**
 * Temporarily hides purple overlay + metadata tooltip (opacity 0, layout preserved).
 * @returns {Array<{ el: HTMLElement, prevOpacity: string, prevTransition: string }>}
 */
/** Hides only the metadata tooltip during save. */
function hideKCSaveFeedbackUi() {
  const hidden = [];
  for (const id of [METADATA_TOOLTIP_ID]) {
    try {
      // === PHASE_BADGE_SHADOW_REGRESSION_FIX ===
      // Metadata tooltip lives in the badge shadow root (closed mode), not
      // light DOM. document.getElementById always returned null here.
      const el = getKCBadgeShadowElement(id);
      // === END PHASE_BADGE_SHADOW_REGRESSION_FIX ===
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

/** Ensures a minimum visible save-feedback duration, then restores UI and re-applies purple. */
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
      const overlay = getKCShadowElement('kickclip-highlight-overlay');
      // === PHASE_SHUTTER_REMOVAL ===
      const hasClippedHighlight = overlay &&
        overlay.classList.contains('kickclip-clipped');
      if (!hasClippedHighlight) {
        showCoreHighlight(currentActive, false);
      }
      // === END PHASE_SHUTTER_REMOVAL ===
    }
  } catch (e) {}
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

      // DOM extraction priority: only set background-fetched image
      // when DOM extraction produced no image URL. This keeps the
      // user-visible Instagram slide image (when present) instead
      // of overwriting it with the /media/?size=l cover redirect.
      const hasExistingImage = !!(
        activeMeta?.image?.url &&
        String(activeMeta.image.url).trim()
      );
      const mergedMeta = {
        ...activeMeta,
        ...(caption ? { title: caption } : {}),
        ...(thumbnailUrl && !hasExistingImage
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
function requestInstagramThumbnail(coreItem, meta, clientX = null, clientY = null) {
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

// === PHASE_COREITEM_LIVE_METADATA ===
// Sync re-extraction + sync-safe enrichment of activeCoreItem metadata.
// Called from observer's debounced callback on <a> mutation. Does NOT
// touch UI, does NOT trigger Instagram async refetch. In iframe context,
// re-broadcasts KC_IFRAME_HOVER with the fresh payload so top's
// iframeHoverInfo stays current.
function refreshCoreItemMetadata(coreItem) {
  try {
    if (!coreItem || coreItem !== state.activeCoreItem) return;

    const typeBEntry = getItemMapEntryByElement(coreItem);
    const evidenceType = typeBEntry?.evidenceType || '';
    const platformForB = evidenceType === 'B' ? getCurrentPlatform() : '';
    const cachedExtraction = typeBEntry?.cachedShortcodeNormalized ?? null;
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
        ? extractMetadataForCoreItem(coreItem, null, _lastMouseoverTarget, cacheOverrides, evidenceType) || {}
        : extractMetadataForCoreItem(coreItem, null, _lastMouseoverTarget, null, evidenceType) || {};

    let instagramPreresolvedUrl = '';
    if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
      const shortcodeResult =
        cachedExtraction ??
        normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
      const shortcode = String(shortcodeResult?.shortcode || '').trim();
      if (shortcode) {
        instagramPreresolvedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
      }
    }
    const shortcodeForB =
      evidenceType === 'B' && platformForB === 'INSTAGRAM'
        ? (cachedExtraction?.shortcode || '').trim() ||
          normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB).shortcode
        : '';

    if (evidenceType === 'B' && platformForB === 'INSTAGRAM' && instagramPreresolvedUrl) {
      meta = {
        ...meta,
        activeHoverUrl: instagramPreresolvedUrl,
        platform: platformForB,
        shortcode: shortcodeForB,
      };
    } else if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
      meta = withInstagramActiveHoverUrl(
        { ...meta, platform: platformForB, ...(shortcodeForB ? { shortcode: shortcodeForB } : {}) },
        coreItem,
        cachedExtraction
      );
    } else if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
      const li = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
      meta = withLinkedInCanonicalActiveHoverUrl(
        { ...meta, platform: platformForB, ...(li.shortcode ? { shortcode: li.shortcode } : {}), ...(li.activeHoverUrl ? { activeHoverUrl: li.activeHoverUrl } : {}) },
        coreItem,
        cachedExtraction
      );
    } else if (evidenceType === 'B' && platformForB === 'THREADS') {
      const th = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
      meta = withThreadsActiveHoverUrl(
        { ...meta, platform: platformForB, ...(th.shortcode ? { shortcode: th.shortcode } : {}), ...(th.activeHoverUrl ? { activeHoverUrl: th.activeHoverUrl } : {}) },
        coreItem,
        cachedExtraction
      );
    } else if (evidenceType === 'B' && platformForB === 'FACEBOOK') {
      const fb = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
      meta = withFacebookTimestampActiveHoverUrl(
        { ...meta, platform: platformForB, ...(fb.activeHoverUrl ? { activeHoverUrl: fb.activeHoverUrl } : {}), ...(fb.imageUrl ? { image: { ...(meta?.image || {}), url: fb.imageUrl } } : {}) },
        coreItem,
        cachedExtraction
      );
    }

    if (evidenceType === 'E') {
      if (!meta?.image) {
        try {
          const imgResult = extractImageFromCoreItem(coreItem);
          if (imgResult?.image) {
            meta = { ...meta, image: imgResult.image };
          }
        } catch (e) {
          // defensive
        }
      }
      let typeEActiveUrl = '';
      try {
        const wrappingAnchor = coreItem?.closest?.('a[href]') || null;
        if (wrappingAnchor) {
          const resolved = resolveAnchorUrl(wrappingAnchor);
          if (typeof resolved === 'string' && resolved.length > 0) {
            typeEActiveUrl = resolved;
          }
        }
      } catch (e) {
        // defensive
      }
      if (!typeEActiveUrl) {
        typeEActiveUrl = String(window.location.href || '');
      }
      meta = { ...meta, activeHoverUrl: typeEActiveUrl };
    }

    if (!meta?.activeHoverUrl) return;

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

    if (syncedMeta.activeHoverUrl) {
      try {
        const htmlCtx = extractCoreItemHtmlContext(coreItem);
        const { category, platform } = detectItemCategory(
          syncedMeta.activeHoverUrl,
          window.location.href,
          htmlCtx
        );
        syncedMeta = { ...syncedMeta, category };
        if (platform) syncedMeta = { ...syncedMeta, platform };
      } catch (e) {}
    }

    if (evidenceType === 'E') {
      syncedMeta = { ...syncedMeta, category: 'Image' };
    }

    state.lastExtractedMetadata = syncedMeta;
    const freshUrl = String(syncedMeta.activeHoverUrl || '').trim();
    if (freshUrl && freshUrl !== state.activeHoverUrl) {
      state.activeHoverUrl = freshUrl;
    }

    // === PHASE_OVERLAY_REFRESH_REEVAL ===
    // Re-evaluate overlay element after metadata refresh. Carousel slide
    // changes mutate the DOM but don't trigger mouseover (pointer stays
    // put), so without this the overlay stays on the prior slide's
    // dominant img. We recompute seedImages, hoverCompanions, rebuild
    // imageToItem map for activation key consistency, then resolve a new
    // overlay element. Show or hide based on pointer hit-test against
    // the new rect.
    try {
      const itemEntry = getItemMapEntryByElement(coreItem);
      const evType = itemEntry?.evidenceType || '';
      if (itemEntry && (evType === 'B' || evType === EVIDENCE_TYPE_IMAGE_ANCHOR)) {
        const newSeedImages = findDominantImagesInElement(coreItem);

        const newHoverCompanions = new Set();
        for (const seedImg of newSeedImages) {
          try {
            for (const comp of findHoverCompanions(seedImg, coreItem)) {
              newHoverCompanions.add(comp);
            }
          } catch (e) { /* defensive */ }
        }

        itemEntry.seedImages = newSeedImages;
        itemEntry.hoverCompanions = newHoverCompanions;

        ensureClusterCacheFromState();

        const newDominantImg = newSeedImages.values().next().value || null;
        const newAnchor = newDominantImg?.closest?.('a') || null;

        const newOverlay = newDominantImg
          ? determineTypeDOverlayElement(coreItem, newDominantImg, newAnchor)
          : null;

        state.activeOverlayElement = newOverlay;

        if (newOverlay === null) {
          hideCoreHighlight();
        } else if (
          newOverlay !== coreItem &&
          !isPointerInsideOverlay(newOverlay, lastPointerX, lastPointerY, null)
        ) {
          hideCoreHighlight();
        } else {
          const newOverlayRect = newOverlay === coreItem
            ? null
            : newOverlay.getBoundingClientRect?.();
          if (newOverlayRect && newOverlayRect.width > 0 && newOverlayRect.height > 0) {
            showCoreHighlight(coreItem, false, newOverlayRect);
          } else {
            showCoreHighlight(coreItem, false);
          }
        }
      }
    } catch (_) { /* refresh re-eval failures non-fatal */ }
    // === END PHASE_OVERLAY_REFRESH_REEVAL ===

    // === PHASE_HOVER_IMAGE_PREFETCH ===
    // Re-run image prefetch after metadata refresh. The MutationObserver fires
    // when <a href> changes (e.g., Google Images lazy-populates the link
    // target). If the refreshed image URL differs from the original hover-time
    // URL, this prefetches the fresh URL into the LRU cache so clip-time has
    // a cache hit. Same URL → cache hit returns existing promise, no extra
    // fetch.
    try {
      const refreshedUrl = syncedMeta?.image?.url;
      if (refreshedUrl) {
        const fallbackImgEl = pickDominantImageElement(coreItem);
        prefetchImageBlob(refreshedUrl, fallbackImgEl);
      }
    } catch (_) { /* defensive — prefetch failures are non-fatal */ }
    // === END PHASE_HOVER_IMAGE_PREFETCH ===

    if (IS_IFRAME) {
      try {
        window.top.postMessage({
          [KC_MSG_PREFIX]: true,
          [KC_IFRAME_HOVER]: true,
          url: String(state.activeHoverUrl || '').trim(),
          imageUrl: String(syncedMeta?.image?.url || '').trim(),
          category: String(syncedMeta?.category || '').trim(),
          title: String(syncedMeta?.title || '').trim(),
          platform: String(syncedMeta?.platform || '').trim(),
          pageUrl: String(window.location.href || '').trim(),
        }, '*');
      } catch (_) { /* defensive */ }
    }
  } catch (_) { /* defensive — refresh failures are non-fatal */ }
}

// Extracts the value of the `transform` property from a style attribute string,
// or '' if absent. Used by mountActiveCoreItemMutationObserver to compare
// transform-only changes (e.g. carousel slide via translateX/translate3d) while
// ignoring unrelated style mutations (opacity, color, layout).
//
// Implementation: minimal regex match on the inline `transform:` declaration.
// Inline `style` attribute values are semicolon-separated declarations; this
// captures everything between `transform:` and the next `;` or end of string.
function extractTransformFromStyle(styleString) {
  if (!styleString || typeof styleString !== 'string') return '';
  const match = styleString.match(/(?:^|;)\s*transform\s*:\s*([^;]*)/i);
  return match ? match[1].trim() : '';
}

function mountActiveCoreItemMutationObserver(coreItem) {
  unmountActiveCoreItemMutationObserver();

  if (!coreItem || typeof MutationObserver === 'undefined') return;

  const cb = (mutations) => {
    let relevant = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const tagName = String(m.target?.tagName || '').toUpperCase();
        const attrName = m.attributeName;

        // href on anchor: original behavior.
        if (attrName === 'href' && tagName === 'A') {
          relevant = true;
          break;
        }

        // src on img: lazy-load swap or carousel image change.
        if (attrName === 'src' && tagName === 'IMG') {
          relevant = true;
          break;
        }

        // style: only the transform portion. Carousel slide via
        // translateX/translate3d/matrix; ignore opacity/color/layout.
        if (attrName === 'style') {
          const oldTransform = extractTransformFromStyle(m.oldValue || '');
          const newTransform = extractTransformFromStyle(
            m.target?.getAttribute?.('style') || ''
          );
          if (oldTransform !== newTransform) {
            relevant = true;
            break;
          }
        }
      } else if (m.type === 'childList') {
        const isAnchorOrContainsAnchor = (node) =>
          node?.nodeType === 1 &&
          (String(node.tagName || '').toUpperCase() === 'A' || node.querySelector?.('a') != null);
        for (const n of m.addedNodes) {
          if (isAnchorOrContainsAnchor(n)) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
        for (const n of m.removedNodes) {
          if (isAnchorOrContainsAnchor(n)) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
    }
    if (!relevant) return;

    if (_coreItemMetadataDebounceTimer) {
      clearTimeout(_coreItemMetadataDebounceTimer);
    }
    _coreItemMetadataDebounceTimer = setTimeout(() => {
      _coreItemMetadataDebounceTimer = null;
      refreshCoreItemMetadata(coreItem);
    }, 50);
  };

  const observer = new MutationObserver(cb);
  observer.observe(coreItem, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'src', 'style'],
    attributeOldValue: true,
  });

  _coreItemMutationObserver = observer;
  _observedCoreItemElement = coreItem;
}

function unmountActiveCoreItemMutationObserver() {
  if (_coreItemMetadataDebounceTimer) {
    try { clearTimeout(_coreItemMetadataDebounceTimer); } catch (_) {}
    _coreItemMetadataDebounceTimer = null;
  }
  if (_coreItemMutationObserver) {
    try { _coreItemMutationObserver.disconnect(); } catch (_) {}
    _coreItemMutationObserver = null;
  }
  _observedCoreItemElement = null;
}
// === END PHASE_COREITEM_LIVE_METADATA ===

function coreClear() {
  // === PHASE_OVERLAY_ON_IMAGE ===
  state.activeOverlayElement = null;
  // === END PHASE_OVERLAY_ON_IMAGE ===
  if (IS_IFRAME) {
    // === PHASE_COREITEM_LIVE_METADATA ===
    unmountActiveCoreItemMutationObserver();
    // === END PHASE_COREITEM_LIVE_METADATA ===
    state.activeCoreItem = null;
    state.activeHoverUrl = null;
    state.lastExtractedMetadata = null;
    try { hideCoreHighlight(); } catch (e) {}
    // === PHASE_IFRAME_HOVER_PROPAGATION ===
    // Notify top frame to clear its stored iframeHoverInfo.
    try {
      window.top.postMessage({
        [KC_MSG_PREFIX]: true,
        [KC_IFRAME_HOVER_END]: true,
      }, '*');
    } catch (_) { /* defensive */ }
    // === END PHASE_IFRAME_HOVER_PROPAGATION ===
  } else {
    // === PHASE_COREITEM_LIVE_METADATA ===
    unmountActiveCoreItemMutationObserver();
    // === END PHASE_COREITEM_LIVE_METADATA ===
    clearCoreSelection();
  }
}

/**
 * Finds the first valid Type A anchor within a container (primary signal anchor).
 * Used as fallback when the hovered anchor fails validation.
 */
async function findPrimaryImageAnchor(container) {
  if (!container || container.nodeType !== 1) return null;
  const anchors = container.querySelectorAll?.('a[href]') || [];
  for (const a of anchors) {
    if (await isValidImageAnchor(a)) return a;
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

// === PHASE_OVERLAY_HOVER_GATE (helper) ===
// Visual hit-test for the overlay gate. Rect-based using pointer coords
// is the source of truth because DOM `contains` fails on layouts that
// stack sibling overlay elements above the image (e.g. ArtStation's
// gallery-grid-overlay on top of gallery-grid-background-image — the
// pointer is over the image visually, but `event.target` lands on the
// stacked overlay div, which is a sibling of the image, not a descendant).
//
// Returns true if the gate should pass (pointer inside, or info missing).
// Returns false only when coords are finite, the overlay rect is valid,
// and the pointer is clearly outside. Falls back to DOM `contains` when
// coords are unavailable (no current call site, but defaults allow it).
function isPointerInsideOverlay(overlayEl, x, y, fallbackTarget) {
  if (!overlayEl) return true;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    try {
      const r = overlayEl.getBoundingClientRect?.();
      if (r && r.width > 0 && r.height > 0) {
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }
    } catch (e) {
      // defensive: getBoundingClientRect on disconnected nodes
    }
  }
  return !!overlayEl.contains?.(fallbackTarget);
}
// === END PHASE_OVERLAY_HOVER_GATE (helper) ===

async function updateCoreSelectionFromTarget(target, clientX = null, clientY = null) {
  // === PHASE27B_HOVER_DISPATCH ===
  // Phase 27 image-keyed activation:
  // - Hover guard upstream already filtered to <img> targets.
  // - Lookup is O(1) through the image-keyed candidate map.
  // - Type B / D / E share the same simple flow.
  // - Type D has no anchor/role/pointer pre-guard and no
  //   child-refinement step; the candidate's element is taken
  //   as-is.
  // - Type E forces meta.activeHoverUrl = window.location.href
  //   so clip path has a usable URL.
  // - Type D does NOT fabricate a URL. If extraction yields no
  //   activeHoverUrl, activation does not proceed (preserves
  //   Type D's purpose: clip the linked resource, not the page).
  // - Type B keeps its existing cache + platform enrichment.

  if (!target || target.nodeType !== 1) {
    if (state.activeCoreItem) coreClear();
    return false;
  }

  // Image-keyed lookup. ensureClusterCacheFromState() rebuilds
  // both clusterLookup and imageToItem from state.itemMap on
  // every dispatch, so the lookup is always fresh.
  ensureClusterCacheFromState();
  const itemEntry = findItemByImage(target);
  const active = state.activeCoreItem;
  if (!itemEntry || !itemEntry.element) {
    if (state.activeCoreItem) coreClear();
    return false;
  }

  const evidenceType = itemEntry.evidenceType;
  const coreItem = itemEntry.element;
  const closestAtag = null;

  // Type B LinkedIn block (preserved from prior implementation).
  const platformForB = evidenceType === 'B' ? getCurrentPlatform() : '';
  if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    if (state.activeCoreItem) coreClear();
    return false;
  }

  // Type B cache hookup (preserved).
  const typeBEntry = evidenceType === 'B' ? getItemMapEntryByElement(coreItem) : null;
  const cachedExtraction = typeBEntry?.cachedShortcodeNormalized ?? null;
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
      ? extractMetadataForCoreItem(coreItem, closestAtag, target, cacheOverrides, evidenceType) || {}
      : extractMetadataForCoreItem(coreItem, closestAtag, target, null, evidenceType) || {};

  // Instagram pre-resolved URL (Type B only, preserved).
  let instagramPreresolvedUrl = '';
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    const shortcodeResult =
      cachedExtraction ??
      normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    const shortcode = String(shortcodeResult?.shortcode || '').trim();
    if (shortcode) {
      instagramPreresolvedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
    }
  }
  const shortcodeForB =
    evidenceType === 'B' && platformForB === 'INSTAGRAM'
      ? (cachedExtraction?.shortcode || '').trim() ||
        normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB).shortcode
      : '';

  // Type B platform-specific URL enrichment (preserved).
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM' && instagramPreresolvedUrl) {
    meta = {
      ...meta,
      activeHoverUrl: instagramPreresolvedUrl,
      platform: platformForB,
      shortcode: shortcodeForB,
    };
  } else if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    meta = withInstagramActiveHoverUrl(
      { ...meta, platform: platformForB, ...(shortcodeForB ? { shortcode: shortcodeForB } : {}) },
      coreItem,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    const li = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withLinkedInCanonicalActiveHoverUrl(
      { ...meta, platform: platformForB, ...(li.shortcode ? { shortcode: li.shortcode } : {}), ...(li.activeHoverUrl ? { activeHoverUrl: li.activeHoverUrl } : {}) },
      coreItem,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'THREADS') {
    const th = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withThreadsActiveHoverUrl(
      { ...meta, platform: platformForB, ...(th.shortcode ? { shortcode: th.shortcode } : {}), ...(th.activeHoverUrl ? { activeHoverUrl: th.activeHoverUrl } : {}) },
      coreItem,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'FACEBOOK') {
    const fb = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withFacebookTimestampActiveHoverUrl(
      { ...meta, platform: platformForB, ...(fb.activeHoverUrl ? { activeHoverUrl: fb.activeHoverUrl } : {}), ...(fb.imageUrl ? { image: { ...(meta?.image || {}), url: fb.imageUrl } } : {}) },
      coreItem,
      cachedExtraction
    );
  }

  // === PHASE27F_TYPE_E_OVERRIDES ===
  // Phase 27b (historical): Type E was treated as having no descendant
  //   anchor, so meta.activeHoverUrl was forced to window.location.href.
  //   PHASE_TYPE_E_ANCHOR_URL below now upgrades this: when the Type E
  //   <img> has a wrapping <a href> with a meaningful navigation URL
  //   (per resolveAnchorUrl), use that URL instead. window.location.href
  //   remains the fallback for anchor-less Type E (the original Phase 27b
  //   case).
  // Phase 27f: extractMetadataForCoreItem returns null for an
  //   <img>-only coreItem (no activeHoverUrl inside the <img>),
  //   so meta.image is typically absent. With the new <img>
  //   short-circuit in extractImageFromCoreItem (Phase 27f
  //   Edit 1), we can populate meta.image directly here so the
  //   clip path has a usable image URL at clip time.
  if (evidenceType === 'E') {
    if (!meta?.image) {
      try {
        const imgResult = extractImageFromCoreItem(coreItem);
        if (imgResult?.image) {
          meta = { ...meta, image: imgResult.image };
        }
      } catch (e) {
        // defensive
      }
    }
    // === PHASE_TYPE_E_ANCHOR_URL ===
    // Type E activeHoverUrl: prefer the image-wrapping <a href>'s resolved
    // URL when one exists and resolveAnchorUrl qualifies it as a meaningful
    // navigation URL. Fall back to window.location.href otherwise (no
    // wrapping anchor, no href, or anchor's URL filtered out as empty /
    // fragment / javascript: / internal redirect / same-document).
    let typeEActiveUrl = '';
    try {
      const wrappingAnchor = coreItem?.closest?.('a[href]') || null;
      if (wrappingAnchor) {
        const resolved = resolveAnchorUrl(wrappingAnchor);
        if (typeof resolved === 'string' && resolved.length > 0) {
          typeEActiveUrl = resolved;
        }
      }
    } catch (e) {
      // defensive: closest can throw on disconnected nodes
    }
    if (!typeEActiveUrl) {
      typeEActiveUrl = String(window.location.href || '');
    }
    meta = { ...meta, activeHoverUrl: typeEActiveUrl };
    // === END PHASE_TYPE_E_ANCHOR_URL ===
  }
  // === END PHASE27F_TYPE_E_OVERRIDES ===

  // Type B no-URL gate (preserved). Type B without a URL must not
  // activate; the prior Instagram/Threads/Facebook enrichment was
  // its only chance to produce one.
  // Type D no-URL gate (Phase 27 decision 5-γ): if extraction
  // yields no activeHoverUrl for Type D, activation does not
  // proceed. Type D's purpose is to clip the linked resource,
  // not the page.
  // Type E never reaches this gate because the override above
  // always assigns a URL.
  if (!meta?.activeHoverUrl) {
    if (active && active.contains?.(target)) {
      showCoreHighlight(active, false);
      return true;
    }
    if (state.activeCoreItem) coreClear();
    return false;
  }

  // Type B post-extraction shortcode + Facebook timestamp
  // enrichment (preserved).
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

  // Category enrichment (preserved, runs for any type with a URL).
  if (syncedMeta.activeHoverUrl) {
    try {
      const htmlCtx = extractCoreItemHtmlContext(coreItem);
      const { category, platform } = detectItemCategory(
        syncedMeta.activeHoverUrl,
        window.location.href,
        htmlCtx
      );
      syncedMeta = { ...syncedMeta, category };
      if (platform) syncedMeta = { ...syncedMeta, platform };
    } catch (e) {}
  }

  // === PHASE27F_TYPE_E_CATEGORY ===
  // Type E activeCoreItem represents a standalone <img>. The
  // generic category enrichment above calls detectItemCategory
  // with pageUrl as both arguments and an <img>-internal htmlCtx,
  // which cannot reliably infer a category and typically returns
  // undefined. Per Phase 27f user decision, Type E saves are
  // always category: 'Image'. Override unconditionally.
  // Note: platform from detectItemCategory is preserved when set.
  if (evidenceType === 'E') {
    syncedMeta = { ...syncedMeta, category: 'Image' };
  }
  // === END PHASE27F_TYPE_E_CATEGORY ===

  // Final activation. The iframe-vs-top split is preserved.
  // === PHASE_OVERLAY_ON_IMAGE ===
  // Type B and Type D overlays target the dominant image region, not the
  // full card. Both types' seedImages now contain only dominant <img>
  // (per the dominance unification — isImageDominantInCoreItem axial
  // ratio + center-X gates). The same resolver applies to both: anchor +
  // seed intersection → determineTypeDOverlayElement. Type E remains on
  // coreItem (the <img> itself is the overlay target).
  let overlayElement = coreItem;
  if (evidenceType === EVIDENCE_TYPE_IMAGE_ANCHOR || evidenceType === 'B') {
    // Resolve the relevant dominantImg + anchor for the hover target.
    //
    // Strategy: prefer the anchor closest to the hover target, then find
    // the seedImage that anchor wraps. If the closest anchor doesn't
    // contain any seedImage (rare — e.g. target is outside the image
    // region but still inside the card), fall back to the first seedImage
    // and that image's closest anchor.
    let anchor = null;
    let dominantImg = null;
    try {
      anchor = target?.closest?.('a') || null;
    } catch (e) {
      anchor = null;
    }
    const seeds = itemEntry?.seedImages instanceof Set ? itemEntry.seedImages : null;
    if (anchor && seeds) {
      for (const img of seeds) {
        try {
          if (img && anchor.contains?.(img)) {
            dominantImg = img;
            break;
          }
        } catch (e) {
          // ignore disconnected nodes
        }
      }
    }
    if (!dominantImg && seeds && seeds.size > 0) {
      dominantImg = seeds.values().next().value || null;
      if (!anchor && dominantImg) {
        try {
          anchor = dominantImg.closest?.('a') || null;
        } catch (e) {
          anchor = null;
        }
      }
    }
    overlayElement = determineTypeDOverlayElement(coreItem, dominantImg, anchor);
  }
  // === PHASE_OVERLAY_HOVER_GATE ===
  // Lifecycle decoupling: activeCoreItem stays alive regardless of
  // overlay outcome. The overlay element (and its companion status
  // badge) follows a narrower lifecycle — shown only when (a) the
  // resolver returns a non-null overlay AND (b) the pointer is inside
  // that overlay's rect (or overlay === coreItem, a degenerate case
  // for Type E). Both failure cases call hideCoreHighlight; clip is
  // naturally gated by isCoreHighlightShown from the prior commit.
  // === END PHASE_OVERLAY_HOVER_GATE ===
  state.activeOverlayElement = overlayElement;
  if (overlayElement === null) {
    hideCoreHighlight();
  } else if (
    overlayElement !== coreItem &&
    !isPointerInsideOverlay(overlayElement, clientX, clientY, target)
  ) {
    hideCoreHighlight();
  } else {
    const overlayRect = overlayElement === coreItem
      ? null
      : overlayElement.getBoundingClientRect?.();
    if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
      showCoreHighlight(coreItem, false, overlayRect);
    } else {
      showCoreHighlight(coreItem, false);
    }
  }
  // === END PHASE_OVERLAY_ON_IMAGE ===
  // === PHASE_HOVER_IMAGE_PREFETCH ===
  // Kick off image blob prefetch in the background. Cache is keyed by
  // URL so subsequent hovers on the same item are no-ops, and the clip-
  // time path can await the cached promise directly without the 1000ms
  // race. Failure is silent — clip-time fallback (DOM image for Image
  // category, race-timeout for SNS contents) still handles errors.
  try {
    const prefetchUrl = syncedMeta?.image?.url;
    if (prefetchUrl) {
      // Pass the active item's dominant <img> as a fallback for prefetch.
      // If the original URL fetch fails (CORS, 404, etc.), prefetch tries
      // imgElementToBlob on the DOM element directly.
      const fallbackImgEl = coreItem instanceof Element
        ? pickDominantImageElement(coreItem)
        : null;
      prefetchImageBlob(prefetchUrl, fallbackImgEl);
    }
  } catch (_) {
    // defensive — never block hover on prefetch
  }
  // === END PHASE_HOVER_IMAGE_PREFETCH ===
  if (IS_IFRAME) {
    state.activeCoreItem = coreItem;
    state.activeHoverUrl = syncedMeta.activeHoverUrl;
    state.lastExtractedMetadata = syncedMeta;
    // === PHASE_COREITEM_LIVE_METADATA ===
    mountActiveCoreItemMutationObserver(coreItem);
    // === END PHASE_COREITEM_LIVE_METADATA ===
    // Only show status badge if the overlay was successfully shown
    // above (consistent with non-iframe path where showCoreHighlight
    // is the sole badge entry point).
    if (state.activeOverlayElement !== null) {
      showCoreStatusBadge('default');
    }
    if (evidenceType === 'B') {
      requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, null, null);
    }
    // === PHASE_IFRAME_HOVER_PROPAGATION ===
    // Broadcast hover info to top frame so top-frame keydown can clip
    // iframe-internal images even when iframe Permissions Policy blocks
    // navigator.clipboard.write. Top stores this and uses it as a
    // fallback gate when its own state.activeCoreItem is empty.
    try {
      window.top.postMessage({
        [KC_MSG_PREFIX]: true,
        [KC_IFRAME_HOVER]: true,
        url: String(syncedMeta?.activeHoverUrl || '').trim(),
        imageUrl: String(syncedMeta?.image?.url || '').trim(),
        category: String(syncedMeta?.category || '').trim(),
        title: String(syncedMeta?.title || '').trim(),
        platform: String(syncedMeta?.platform || '').trim(),
        pageUrl: String(window.location.href || '').trim(),
      }, '*');
    } catch (_) { /* defensive */ }
    // === END PHASE_IFRAME_HOVER_PROPAGATION ===
    return true;
  }
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  // === PHASE_COREITEM_LIVE_METADATA ===
  mountActiveCoreItemMutationObserver(coreItem);
  // === END PHASE_COREITEM_LIVE_METADATA ===
  if (state.activeOverlayElement !== null) {
    showCoreStatusBadge('default');
  }
  if (evidenceType === 'B') {
    requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  if (evidenceType === EVIDENCE_TYPE_IMAGE_ANCHOR) {
    requestInstagramThumbnail(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  return true;
  // === END PHASE27B_HOVER_DISPATCH ===
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

    // === PHASE_OUTLINE_FP_ELEMENT_GATE ===
    // fp alone is insufficient: when the page swaps <img> nodes via lazy-load/
    // hydration but the new candidate set produces an identical fingerprint
    // (same length, same sorted signature keys), the renderer was skipped and
    // outlines were never re-applied to the new nodes. Require element identity
    // to match as well; otherwise re-render so outlines follow the live DOM.
    const currentElementSet = new Set();
    if (Array.isArray(candidates)) {
      for (const c of candidates) {
        if (c?.element) currentElementSet.add(c.element);
      }
    }
    const sameElements =
      lastRenderedElementSet !== null &&
      lastRenderedElementSet.size === currentElementSet.size &&
      (() => {
        for (const el of currentElementSet) {
          if (!lastRenderedElementSet.has(el)) return false;
        }
        return true;
      })();
    if (!force && fp === lastFingerprint && sameElements) return;
    // === END PHASE_OUTLINE_FP_ELEMENT_GATE ===

    lastFingerprint = fp;
    lastRenderedElementSet = currentElementSet;
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
        // === PHASE20_HOTFIX_SRC_MUTATION ===
        // React to <img src> / <video src> attribute mutations (lazy-load real swap).
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'src' &&
          mutation.target?.nodeType === 1
        ) {
          const srcTag = String(mutation.target.tagName || '').toUpperCase();
          if (srcTag === 'IMG' || srcTag === 'VIDEO') {
            // Skip noise sources
            if (mutation.target.closest?.('#video-preview') || mutation.target.closest?.('ytd-miniplayer')) continue;
            schedulePreScan(document, false, 'mutation-media-src');
            return;
          }
        }
        // === END PHASE20_HOTFIX_SRC_MUTATION ===

        // === PHASE_VIDEO_STYLE_MUTATION ===
        // <video> style toggles (display:none ↔ block on Dribbble's
        // hover-play pattern, carousel slide visibility, etc.) change
        // the video's layout rect. The dominant-image computation
        // depends on layout rect, so a video that becomes visible (or
        // hidden) must trigger a rescan to refresh seedImages and
        // hoverCompanions. attributeFilter includes 'style' (above);
        // other elements' style mutations are filtered out here to
        // bound noise — only <video> style changes trigger rescan.
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'style' &&
          mutation.target?.nodeType === 1 &&
          String(mutation.target.tagName || '').toUpperCase() === 'VIDEO'
        ) {
          if (mutation.target.closest?.('#video-preview') || mutation.target.closest?.('ytd-miniplayer')) continue;
          schedulePreScan(document, false, 'mutation-video-style');
          return;
        }
        // === END PHASE_VIDEO_STYLE_MUTATION ===
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

    // === PHASE20_HOTFIX_SRC_MUTATION ===
    // Also observe attribute changes filtered to 'src'. Lazy-loaded images
    // mutate their src attribute when they become visible (placeholder→real
    // swap). Without this, Phase 20 may run before src is set and miss the
    // image. attributeFilter limits noise to only src changes.
    obs.observe(targetNode, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'style'],
    });
    // === END PHASE20_HOTFIX_SRC_MUTATION ===

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

async function saveActiveCoreItem(request = {}) {
    const activeItem = state.activeCoreItem;
    const activeUrl = String(state.activeHoverUrl || '').trim();

    // No CoreItem active → complete silent ignore
    if (!activeItem || !activeUrl) {
      return { success: false, reason: 'no-core-item' };
    }

    // CoreItem active → existing logic
    const meta = state.lastExtractedMetadata;

    // === PHASE_OVERLAY_LIFECYCLE_DECOUPLING ===
    // Clip gate: refuse clip when the overlay is not currently shown
    // (pointer outside the overlay rect, even if activeCoreItem is alive).
    // Iframe-relay clips originate from a child iframe and bypass the
    // local overlay state — those are handled by the iframe's own gate.
    const isRelayClip = meta?._isIframeRelay === true;
    if (!isRelayClip && !isCoreHighlightShown()) {
      return { success: false, reason: 'overlay-hidden' };
    }
    // === END PHASE_OVERLAY_LIFECYCLE_DECOUPLING ===

    // === PHASE20_HOTFIX_CLIP_TIME_IMAGE ===
    // Re-extract image at clip time. The cached `meta.image` was computed at
    // hover-start (mouseover event). If the user hovered further and the page
    // swapped the visible image (e.g., Temu's side-stacked carousel hover-swap),
    // the cached URL points to the no-longer-visible image. Re-extracting here
    // allows hotfix v8's coreItem-rect inside check to evaluate against the
    // current rect snapshot, selecting the image actually visible at clip time.
    //
    // Guard: state.activeCoreItem may be a stub `{}` in iframe-relay mode
    // (no DOM methods). Re-extraction is skipped in that case; cached image
    // is used.
    let freshImage = meta?.image;
    try {
      const activeCoreEl = state.activeCoreItem;
      if (activeCoreEl && typeof activeCoreEl.getBoundingClientRect === 'function') {
        const itemEntry = getItemMapEntryByElement(activeCoreEl);
        const evType = itemEntry?.evidenceType || '';
        if (evType === 'B' || evType === 'D') {
          const dominantImgs = findDominantImagesInElement(activeCoreEl);
          const dominantImg = dominantImgs.values().next().value || null;
          if (dominantImg) {
            const dominantTag = String(dominantImg.tagName || '').toUpperCase();
            if (dominantTag === 'VIDEO') {
              const info = extractVideoMediaInfo(dominantImg);
              const r = dominantImg.getBoundingClientRect?.();
              const width = info?.width || Math.round(r?.width || 0);
              const height = info?.height || Math.round(r?.height || 0);
              if (width > 0 && height > 0) {
                freshImage = {
                  // url is set later from clipResult.dataUrlPromise
                  // (canvas frame base64). See PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL
                  // in saveActiveCoreItem imgUrl resolution.
                  url: '',
                  width,
                  height,
                };
              }
            } else {
              const r = dominantImg.getBoundingClientRect?.();
              const src = resolveClipImageUrl(activeCoreEl, dominantImg);
              if (src && r && r.width > 0 && r.height > 0) {
                freshImage = {
                  url: src,
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                };
              }
            }
          }
        } else {
          const freshResult = extractImageFromCoreItem(activeCoreEl);
          const freshUrl = String(freshResult?.image?.url || '').trim();
          if (freshUrl) {
            freshImage = freshResult.image;
          }
        }
      }
    } catch (e) { /* keep cached image */ }
    // === END PHASE20_HOTFIX_CLIP_TIME_IMAGE ===

    // Relay mode: top-frame is processing a clip that originated inside a
    // cross-origin iframe. The iframe handler posts metadata only (no UI).
    // The top frame
    // must not paint anything on its own highlight overlay / status_badge
    // here — doing so would tint whatever stale UI happens to be left
    // over from a previous top-frame hover, including completely
    // unrelated CoreItems. Top-frame's job in relay mode is data only:
    // clipboard copy, _savedUrlSet update, Optimistic Card dispatch,
    // server fetch.
    const isIframeRelay = meta?._isIframeRelay === true;
    const url = String(meta?.activeHoverUrl || activeUrl).trim();
    if (!url) return { success: false, reason: 'missing-url' };
    const youtubeShortcode = extractYouTubeShortcodeFromUrl(url);
    const youtubeThumbnailUrl = youtubeShortcode ? getYouTubeThumbnailUrl(youtubeShortcode) : '';
    const isYouTubeSave = !!youtubeThumbnailUrl;

    const title = String(meta?.title || document.title || url).trim();
    let imgUrl = isYouTubeSave
      ? youtubeThumbnailUrl
      : String(request?.img_url || freshImage?.url || '').trim();

    // Step 1: hide CoreHighlight + StatusBadge for screenshot.
    // Skipped in relay mode — iframe owns the visible UI.
    const coreOverlayEl = !isIframeRelay
      ? getKCShadowElement('kickclip-highlight-overlay')
      : null;
    // === PHASE_BADGE_SHADOW_REGRESSION_FIX ===
    // Badge moved to separate shadow root by PHASE_BADGE_SHADOW_SEPARATE.
    // Main-shadow lookup returned null, making the save-time opacity
    // hide/restore at 1405/1581 a silent no-op. Use the badge accessor.
    const coreBadgeEl = !isIframeRelay
      ? getKCBadgeShadowElement('kickclip-status-badge-core')
      : null;
    // === END PHASE_BADGE_SHADOW_REGRESSION_FIX ===
    if (coreOverlayEl) { coreOverlayEl.style.transition = ''; coreOverlayEl.style.opacity = '0'; }
    if (coreBadgeEl)   { coreBadgeEl.style.transition = '';   coreBadgeEl.style.opacity = '0'; }

    // CoreItem saves never capture a screenshot — just wait for repaint.
    await waitForRepaint();
    await new Promise((resolve) => setTimeout(resolve, 32));

    // Clipboard copy: start async copy without blocking. Badge IIFE below
    // reports clipboard success/failure via markCoreHighlightClipped + text.
    const coreClipboardCategory = String(meta?.category || '').trim();
    // === PHASE_CLIPBOARD_SYNC_WRITE ===
    // When the keydown shortcut path already wrote to the clipboard
    // in its sync turn, reuse its promise here so the badge IIFE
    // below reports the correct success/failure. Legacy paths
    // (save-url message, iframe relay) still call performClipboardCopy.
    const coreClipboardPromise = (request?.skipClipboard)
      ? (request.clipboardPromise || Promise.resolve({ success: false }))
      : (window.self === window.top)
        ? performClipboardCopy(
            coreClipboardCategory,
            url,
            activeItem instanceof Element ? activeItem : document.body,
            {
              imageUrl: String(imgUrl || meta?.image?.url || '').trim(),
            }
          )
        : Promise.resolve({ success: false });
    // === END PHASE_CLIPBOARD_SYNC_WRITE ===

    // Generate tempId for end-to-end matching: Optimistic Card ↔ Firestore doc
    // Only generated in top-level frame (iframes skip Optimistic Card dispatch).
    const tempId = window.self === window.top
      ? `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      : '';

    // Immediately update _savedUrlSet so checkIsSavedSync() returns true
    // even if saved-urls-updated arrives before fetch completes.
    if (isSignedIn()) {
      try {
        const savedUrl = normalizeUrlForSavedCheck(url);
        if (savedUrl) _savedUrlSet.add(savedUrl);
      } catch (e) {}
    }

    if (!isIframeRelay) {
      // CoreItem clip feedback: clipboard result drives overlay ring + badge text.
      // Skipped in relay mode — top frame handles clipboard; iframe draws no UI.
      // === PHASE_IFRAME_CLIPBOARD ===
      // IIFE runs in iframe too (iframe keydown). Outer !isIframeRelay gates relay.
      // === PHASE_SHUTTER_REMOVAL ===
      // === PHASE_IFRAME_HOVER_PROPAGATION ===
      // When clipping via iframeHoverInfo propagation, visual feedback
      // (thick border + badge text) is owned by the iframe via
      // KC_IFRAME_CLIPBOARD_RESULT — top-frame should not paint its own.
      // === PHASE_IFRAME_CLIP_REQUEST ===
      // When iframe-focused keydown delegates clipboard to top via W2,
      // visual feedback also comes from top via KC_IFRAME_CLIPBOARD_RESULT.
      if (!request?.fromIframeHover && !request?.fromIframeClipRequest) {
      // === END PHASE_IFRAME_CLIP_REQUEST ===
      // === END PHASE_IFRAME_HOVER_PROPAGATION ===
        (async () => {
          try {
            const clipboardResult = await coreClipboardPromise;
            if (clipboardResult?.success) {
              markCoreHighlightClipped();
              const successText = 'Image clipped';
              setCoreStatusBadgeText(successText);
            } else {
              setCoreStatusBadgeText('Clip failed');
            }
          } catch (_) { /* silent */ }
        })();
      // === PHASE_IFRAME_HOVER_PROPAGATION ===
      }
      // === END PHASE_IFRAME_HOVER_PROPAGATION ===
      // === END PHASE_SHUTTER_REMOVAL ===
      // === END PHASE_IFRAME_CLIPBOARD ===
    }

    if (coreOverlayEl) { coreOverlayEl.style.transition = ''; coreOverlayEl.style.opacity = '1'; }
    if (coreBadgeEl)   { coreBadgeEl.style.transition = '';   coreBadgeEl.style.opacity = ''; }

    // Request userId from background.js (cached from sidepanel sign-in)
    // === PHASE27G_DOM_IMG_SRC ===
    // Capture the actual <img> src visible in the page at clip
    // time. For Cloudflare-protected origins where img_url cannot
    // be re-fetched by KickClip (proxy / direct / background all
    // blocked), the DOM src is what the user's browser actually
    // rendered and is therefore the only reliably-displayable
    // fallback. Saved alongside img_url so DataCard / file-save
    // can fall back when the original is unreachable. img_url
    // remains the full-resolution intent for downloads.
    let domImgSrc = '';
    try {
      const activeCoreEl = state.activeCoreItem;
      if (activeCoreEl && activeCoreEl.nodeType === 1) {
        let domImg = null;
        if (String(activeCoreEl.tagName || '').toUpperCase() === 'IMG') {
          domImg = activeCoreEl;
        } else if (typeof activeCoreEl.querySelectorAll === 'function') {
          const innerImgs = activeCoreEl.querySelectorAll('img[src]') || [];
          let largestArea = 0;
          for (const candidate of innerImgs) {
            try {
              const rect = candidate.getBoundingClientRect?.();
              if (!rect) continue;
              const area = (Number(rect.width) || 0) * (Number(rect.height) || 0);
              if (area > largestArea) {
                largestArea = area;
                domImg = candidate;
              }
            } catch (e) { /* ignore candidate */ }
          }
        }
        if (domImg) {
          domImgSrc = resolveAbsoluteImageUrl(
            domImg.getAttribute?.('src') || domImg.src
          );
        }
      }
    } catch (e) {
      // defensive — leave domImgSrc empty
    }
    // === END PHASE27G_DOM_IMG_SRC ===
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

    // Extract HTML context from the active CoreItem for AI type inference
    const htmlContext = extractCoreItemHtmlContext(activeItem);

    // === PHASE_IMAGE_URL_PIPELINE ===
    let imgThumbnailB64 = null;
    // === PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
    // When the dominant element is <video>, the same canvas frame
    // that produced the clipboard Blob is also exposed as a data URL
    // via clipResult.dataUrlPromise. We capture it here and override
    // the imgUrl variable (computed below) for the video case.
    let videoFrameDataUrl = null;
    // === END PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
    if (request?.clipboardPromise) {
      try {
        const clipResult = await Promise.resolve(request.clipboardPromise);
        if (clipResult?.thumbnailPromise) {
          imgThumbnailB64 = await Promise.race([
            clipResult.thumbnailPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
          ]);
        }
        // === PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
        if (clipResult?.dataUrlPromise) {
          videoFrameDataUrl = await Promise.race([
            clipResult.dataUrlPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
          ]);
        }
        // === END PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
      } catch (_) {
        imgThumbnailB64 = null;
        videoFrameDataUrl = null;
      }
    }
    // === PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
    // Resolution priority:
    //   1. YouTube special path (existing) — youtubeThumbnailUrl
    //   2. Video frame data URL from clipboard pipeline (new) — when present,
    //      this is the canvas frame captured at clip-time keystroke,
    //      matching the clipboard PNG and img_thumbnail_b64 exactly.
    //   3. Existing fallback: request.img_url, freshImage.url, or ''.
    if (isYouTubeSave) {
      imgUrl = youtubeThumbnailUrl;
    } else if (videoFrameDataUrl) {
      imgUrl = videoFrameDataUrl;
    } else {
      imgUrl = String(request?.img_url || freshImage?.url || '').trim();
    }
    // === END PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
    // === END PHASE_IMAGE_URL_PIPELINE ===


    const payload = {
      url,
      title: title || url,
      timestamp: Date.now(),
      userLanguage: navigator.language || 'en',
      pageUrl: meta?._pageUrl || window.location.href,
      ...(tempId ? { temp_id: tempId } : {}),
      ...(htmlContext ? { htmlContext } : {}),
      ...(imgUrl ? { img_url: imgUrl } : {}),
    // === PHASE27G_PAYLOAD_DOM ===
      ...(domImgSrc && domImgSrc !== imgUrl
        ? { img_url_dom: domImgSrc }
        : {}),
      // === END PHASE27G_PAYLOAD_DOM ===
      // === PHASE_IMAGE_URL_PIPELINE ===
      ...(imgThumbnailB64 ? { img_thumbnail_b64: imgThumbnailB64 } : {}),
      // === END PHASE_IMAGE_URL_PIPELINE ===
      ...(userId ? { userId } : {}),
      ...(meta?.category      ? { category:       meta.category }      : {}),
      ...(meta?.platform      ? { platform:        meta.platform }      : {}),
    };

    // Optimistic UI: notify Side Panel to show a temporary card immediately
    // Skip if running inside an iframe — only the top-level frame should create optimistic cards
    if (window.self === window.top && isSignedIn()) {
      try {
        chrome.runtime.sendMessage({
          action:             'optimistic-card',
          tempId,
          url,
          title:              title || url,
          imgUrl:             imgUrl || '',
    // === PHASE27G_OPTIMISTIC_DOM ===
          ...(domImgSrc && domImgSrc !== imgUrl
            ? { imgUrlDom: domImgSrc }
            : {}),
          // === END PHASE27G_OPTIMISTIC_DOM ===
          // === PHASE_IMAGE_URL_PIPELINE ===
          ...(imgThumbnailB64 ? { imgThumbnailB64 } : {}),
          // === END PHASE_IMAGE_URL_PIPELINE ===
          category:           String(meta?.category      || '').trim(),
          platform:           String(meta?.platform      || '').trim(),
          createdAt:          Date.now(),
        });
      } catch { /* Side Panel may not be open — silently ignore */ }
    }

    if (isSignedIn()) {
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

    return { success: true };
}

// === PHASE_DOMINANT_IMAGE_UNIFIED ===
// Single-element accessor for the dominant <img> inside a container.
// Wraps findDominantImagesInElement (which uses the unified
// isImageDominantInCoreItem predicate — axial ratio + center-X gate).
// Returns the first dominant <img>, or null if none exists or the
// input is not an Element. Replaces the prior getDominantImageElement
// which used an axial-ratio-only predicate inconsistent with the
// rest of the codebase's dominance definition.
function pickDominantImageElement(rootElement) {
  if (!rootElement || !(rootElement instanceof Element)) return null;
  try {
    // === PHASE_TYPE_E_DOMINANT_SELF ===
    // Type E candidate.element IS the media element (<img>/<video>),
    // not a container wrapper. findDominantImagesInElement searches
    // a container's media descendants — a <video> has no media
    // descendants, so the call returns empty for Type E. The dominant
    // for Type E IS the element itself; return it directly.
    //
    // Type B/D pass cards/wrappers as rootElement (not media elements),
    // so this branch is skipped and the descendant walk runs as before.
    //
    // Type E + image previously masked this gap: the clipboard pipeline
    // takes the URL-fetch path because extractImageFromCoreItem produces
    // a non-empty imageUrl for <img>. Type E + video has empty imageUrl
    // when there's no poster (Instagram never sets poster on
    // <video src="blob:...">), so it falls through to the
    // pickDominantImageElement → videoElementToBlob path — which is
    // where pickDominantImageElement(video) = null surfaced as
    // silent clipboard failure.
    if (isMediaElement(rootElement)) return rootElement;
    // === END PHASE_TYPE_E_DOMINANT_SELF ===
    const imgs = findDominantImagesInElement(rootElement);
    return imgs.values().next().value || null;
  } catch (_) {
    return null;
  }
}
// === END PHASE_DOMINANT_IMAGE_UNIFIED ===

/**
 * Fetch an image URL and convert it to a clipboard-compatible PNG Blob.
 * Used by SNS contents and Image clipboard copy (Phase 19d+). Tries KickClip
 * image-proxy first (same-origin HTTPS, server-side upstream fetch), then
 * direct content-script fetch, then background fetch-image, with PNG/canvas
 * re-encode as needed for ClipboardItem.
 * Returns null if all paths fail.
 */
// === PHASE_IMAGE_URL_PIPELINE ===
// Resize a clipboard-bound Blob to a 400x400 JPEG thumbnail data URL
// for storage in Firestore (img_thumbnail_b64 field).
async function blobToThumbnailDataUrl(blob) {
  if (!blob) return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const MAX = 400;
    const srcW = bitmap.width || 1;
    const srcH = bitmap.height || 1;
    const scale = Math.min(MAX / srcW, MAX / srcH, 1);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, dstW, dstH);
    bitmap.close?.();
    return await new Promise((resolve) => {
      canvas.toBlob((thumbBlob) => {
        if (!thumbBlob) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '') || null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(thumbBlob);
      }, 'image/jpeg', 0.8);
    });
  } catch (_) {
    return null;
  }
}

function attachThumbnailPromiseToClipboardWrite(blobPromise, dataUrlPromise = null) {
  // dataUrlPromise is the optional video img_url path: when the dominant
  // element is <video>, the same canvas drawImage produces both the
  // clipboard Blob and a base64 data URL for img_url. Image-case callers
  // (poster URL fetch, image URL fetch) pass nothing — img_url is the
  // original image URL string in those cases and doesn't need this path.
  const thumbnailPromise = Promise.resolve(blobPromise)
    .then((blob) => blobToThumbnailDataUrl(blob))
    .catch(() => null);
  return navigator.clipboard
    .write([new ClipboardItem({ 'image/png': blobPromise })])
    .then(() => ({ success: true, thumbnailPromise, dataUrlPromise }))
    .catch(() => ({ success: false, thumbnailPromise, dataUrlPromise }));
}
// === END PHASE_IMAGE_URL_PIPELINE ===

// === PHASE_HOVER_IMAGE_PREFETCH ===
// Image blob LRU cache for hover-time prefetch.
//
// Keyed by image URL. Stores in-flight or settled Promise<Blob>.
// On promise reject, the entry is removed so the next hover can retry.
// Eviction: simple LRU — oldest entry removed when size exceeds cap.
//
// Sized for typical SNS feed / image grid scrolling. 30 entries × ~200KB
// avg blob ≈ 6MB worst case. Browser GC will reclaim if pressure rises.
const KC_HOVER_BLOB_CACHE_MAX = 30;
const _hoverBlobCache = new Map();

function getCachedBlobPromise(imageUrl) {
  const key = String(imageUrl || '').trim();
  if (!key) return null;
  if (!_hoverBlobCache.has(key)) return null;
  // LRU touch: move to end.
  const promise = _hoverBlobCache.get(key);
  _hoverBlobCache.delete(key);
  _hoverBlobCache.set(key, promise);
  return promise;
}

function setCachedBlobPromise(imageUrl, promise) {
  const key = String(imageUrl || '').trim();
  if (!key || !promise) return;
  _hoverBlobCache.set(key, promise);
  // Auto-evict on both rejection and resolved-null. imageUrlToPngBlob
  // resolves null on failure rather than rejecting, so a .catch() alone
  // would leave failed entries cached until LRU eviction.
  promise.then(
    (result) => {
      if (result === null && _hoverBlobCache.get(key) === promise) {
        _hoverBlobCache.delete(key);
      }
    },
    () => {
      if (_hoverBlobCache.get(key) === promise) {
        _hoverBlobCache.delete(key);
      }
    }
  );
  // Evict oldest if cap exceeded.
  while (_hoverBlobCache.size > KC_HOVER_BLOB_CACHE_MAX) {
    const oldestKey = _hoverBlobCache.keys().next().value;
    if (oldestKey === undefined) break;
    _hoverBlobCache.delete(oldestKey);
  }
}

// Prefetch: start fetch if not cached, cache the promise, return it.
// Safe to call from hover handlers — does not throw on failure (catch
// auto-removes from cache).
function prefetchImageBlob(imageUrl, fallbackImgEl = null) {
  const key = String(imageUrl || '').trim();
  if (!key) return null;
  const cached = getCachedBlobPromise(key);
  if (cached) return cached;
  // Two-stage fetch: original URL via proxy/CORS/background, then if that
  // returns null, DOM <img> element via imgElementToBlob. This catches
  // CORS-blocked image hosts (e.g., Instagram crawler URLs on Google Image
  // Search) at hover time so clip-time has a cache hit.
  const promise = (async () => {
    try {
      const b = await imageUrlToPngBlob(key);
      if (b) return b;
    } catch (_) { /* fall through */ }
    if (fallbackImgEl) {
      try {
        const fallbackTag = String(fallbackImgEl.tagName || '').toUpperCase();
        let b;
        // === PHASE_VIDEO_CLIP_CLIPBOARD ===
        if (fallbackTag === 'VIDEO') {
          b = await videoElementToBlob(fallbackImgEl);
        } else {
          b = await imgElementToBlob(fallbackImgEl);
        }
        // === END PHASE_VIDEO_CLIP_CLIPBOARD ===
        if (b) return b;
      } catch (_) { /* fall through */ }
    }
    return null;
  })();
  setCachedBlobPromise(key, promise);
  return promise;
}
// === END PHASE_HOVER_IMAGE_PREFETCH ===

async function imageUrlToPngBlob(imageUrl) {
  if (!imageUrl) return null;

  // Skip proxy for special URLs that the server cannot fetch
  // (data: URLs are inline, chrome-extension:// is browser-internal).
  // For other URLs (http://, https://), route through the KickClip
  // image-proxy to avoid:
  //   - mixed content (HTTP image on HTTPS page)
  //   - CORS (image host without Access-Control-Allow-Origin)
  //   - CORP / CSP restrictions in the extension context
  // The server-side proxy fetches with extension-equivalent permissions
  // and streams bytes back as same-origin to the page.
  const skipProxy = (
    imageUrl.startsWith('data:') ||
    imageUrl.startsWith('chrome-extension://')
  );
  if (!skipProxy && typeof KC_SERVER_URL === 'string' && KC_SERVER_URL) {
    try {
      const proxyFetchUrl = `${KC_SERVER_URL}/api/v1/image-proxy?url=${encodeURIComponent(imageUrl)}`;
      const proxyRes = await fetch(proxyFetchUrl, { mode: 'cors' });
      if (proxyRes.ok) {
        const proxyBlob = await proxyRes.blob();
        if (proxyBlob.type === 'image/png') {
          return proxyBlob;
        }
        // Non-PNG — re-encode via canvas
        try {
          const objectUrl = URL.createObjectURL(proxyBlob);
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('Image decode failed'));
            img.src = objectUrl;
          });
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width || 0;
          canvas.height = img.naturalHeight || img.height || 0;
          URL.revokeObjectURL(objectUrl);
          if (canvas.width > 0 && canvas.height > 0) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0);
              const pngBlob = await new Promise((resolve) => {
                canvas.toBlob((b) => resolve(b || null), 'image/png');
              });
              if (pngBlob) return pngBlob;
            }
          }
        } catch (_) { /* fall through to other attempts */ }
      }
    } catch (_) { /* proxy fetch failed — fall through to other attempts */ }
  }

  // Attempt 1: direct content-script fetch
  try {
    const res = await fetch(imageUrl, { mode: 'cors' });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.type === 'image/png') {
        return blob;
      }
      // Non-PNG — re-encode via canvas
      try {
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Image decode failed'));
          img.src = objectUrl;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 0;
        canvas.height = img.naturalHeight || img.height || 0;
        URL.revokeObjectURL(objectUrl);
        if (canvas.width === 0 || canvas.height === 0) {
          // Fall through to background fetch
        } else {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            const pngBlob = await new Promise((resolve) => {
              canvas.toBlob((b) => resolve(b || null), 'image/png');
            });
            if (pngBlob) return pngBlob;
          }
        }
      } catch (_) { /* fall through */ }
    }
  } catch (_) { /* CORS-blocked — fall through */ }

  // Attempt 2: background-script fetch via 'fetch-image' action
  // (bypasses CORS via extension <all_urls> permission)
  try {
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: 'fetch-image', url: imageUrl },
          (r) => resolve(chrome.runtime.lastError ? null : r)
        );
      } catch (_) {
        resolve(null);
      }
    });
    if (response && response.success && response.dataUrl) {
      const pngBlob = await dataUrlToPngBlob(response.dataUrl);
      if (pngBlob) return pngBlob;
    }
  } catch (_) { /* fall through */ }

  return null;
}

/**
 * Convert an <img> element to a clipboard-compatible Blob.
 * Tries fetch() first (works when image is CORS-allowed), falls back to
 * canvas drawing (works for same-origin or crossOrigin-anonymous images).
 * Returns null if both methods fail.
 */
async function imgElementToBlob(imgEl) {
  if (!imgEl || !imgEl.src) return null;

  // Attempt 1: direct content-script fetch (works for same-origin and
  // CORS-enabled cross-origin images). Only returns PNG blobs directly;
  // non-PNG types fall through to Attempt 1.5 for re-encoding.
  try {
    const res = await fetch(imgEl.src, { mode: 'cors' });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.type === 'image/png') {
        return blob;
      }
      // jpeg/webp/gif/other — fall through
    }
  } catch (_) { /* CORS-blocked — fall through */ }

  // Attempt 1.5: background-script fetch (bypasses CORS via extension
  // <all_urls> permission). Gets raw image bytes as base64 data URL, then
  // re-encodes to PNG via canvas (required by Chrome's ClipboardItem).
  try {
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: 'fetch-image', url: imgEl.src },
          (r) => resolve(chrome.runtime.lastError ? null : r)
        );
      } catch (_) {
        resolve(null);
      }
    });
    if (response && response.success && response.dataUrl) {
      const pngBlob = await dataUrlToPngBlob(response.dataUrl);
      if (pngBlob) return pngBlob;
    }
  } catch (_) { /* background fetch failed — fall through */ }

  // Attempt 2: canvas from already-rendered <img> element (same-origin only;
  // cross-origin without crossOrigin attribute produces tainted canvas).
  try {
    const canvas = document.createElement('canvas');
    canvas.width  = imgEl.naturalWidth  || imgEl.width  || 0;
    canvas.height = imgEl.naturalHeight || imgEl.height || 0;
    if (canvas.width === 0 || canvas.height === 0) return null;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0);
    return await new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob || null), 'image/png');
    });
  } catch (_) {
    return null;
  }
}

// === PHASE_VIDEO_BLOB_HELPERS ===
// Canvas first-frame capture for <video>. Used by the clipboard +
// img_url paths when the dominant element is <video> and no poster
// URL was available (extractVideoMediaInfo returned posterUrl='').
//
// Mechanics:
//   - canvas.drawImage(video, ...) captures the current frame at the
//     video's currentTime. The Dribbble flow triggers this after the
//     hover state has played at least one frame, so capture is generally
//     usable; for unloaded videos (readyState < 2) the frame may be
//     blank — we detect via videoWidth/Height being 0 and return null.
//   - Cross-origin videos without explicit crossOrigin='anonymous' attr
//     produce tainted canvases; toBlob then throws. Caught and null
//     returned so the clipboard pipeline falls through to "no copy".
//   - Resizes to maxDim (default 800) preserving aspect ratio.
// === PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
// Single-pass canvas capture: one drawImage produces both the Blob
// (clipboard + thumbnail source) and the data URL (img_url source).
// Guarantees clipboard/thumbnail/img_url are all the same frame —
// the frame the user saw at clip-time keystroke.
//
// Returns { blob, dataUrl } or null on any failure. Either field may
// be null individually if its serialization (toBlob / toDataURL) fails
// (e.g., tainted canvas only fails some paths) — callers must guard.

// === PHASE_VIDEO_TAB_SCREENSHOT_FALLBACK ===
// Tab-screenshot fallback for <video> elements where:
// - Canvas serialization is tainted (cross-origin video without CORS)
// - Poster attribute is empty or proxy fetch fails
//
// Uses chrome.tabs.captureVisibleTab via background script to get a PNG
// of the visible viewport, then crops to the video's rect (DPR-adjusted)
// and resizes to maxDim. Returns { blob, dataUrl } or null.
//
// Hides KickClip overlays/badges/tooltip during capture so they don't
// appear in the cropped output. Uses 2 RAFs for repaint settle. Restore
// in finally block guarantees UI returns to prior state even on error.
async function captureVideoViaTabScreenshot(videoEl, maxDim) {
  // Viewport bounds check
  const rect = videoEl?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
  if (rect.right <= 0 || rect.left >= window.innerWidth) return null;

  const hidden = hideKCForScreenshot();
  let result = null;
  try {
    // Wait 2 RAFs for the opacity change to paint
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // 1. Request screenshot from background
    const screenshotDataUrl = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: 'capture-visible-tab' },
          (response) => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(response?.dataUrl || null);
          }
        );
      } catch (_) {
        resolve(null);
      }
    });

    if (!screenshotDataUrl) return null;

    // 2. Load screenshot into an Image
    const img = new Image();
    img.src = screenshotDataUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Screenshot image load failed'));
    });

    // 3. Compute crop rect (DPR-adjusted)
    const dpr = Number(window.devicePixelRatio) || 1;
    const sourceX = Math.max(0, Math.round(rect.left * dpr));
    const sourceY = Math.max(0, Math.round(rect.top * dpr));
    const sourceW = Math.round(rect.width * dpr);
    const sourceH = Math.round(rect.height * dpr);
    if (sourceW <= 0 || sourceH <= 0) return null;

    // 4. Crop + resize to maxDim
    const scale = Math.min(maxDim / sourceW, maxDim / sourceH, 1);
    const destW = Math.max(1, Math.round(sourceW * scale));
    const destH = Math.max(1, Math.round(sourceH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = destW;
    canvas.height = destH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, sourceX, sourceY, sourceW, sourceH, 0, 0, destW, destH);

    // 5. Serialize (tab screenshot is extension-origin — no taint)
    let dataUrl = null;
    try { dataUrl = canvas.toDataURL('image/png'); } catch (_) {}
    const blob = await new Promise((resolve) => {
      try { canvas.toBlob((b) => resolve(b || null), 'image/png'); }
      catch (_) { resolve(null); }
    });

    if (blob || dataUrl) {
      result = { blob, dataUrl };
    }
  } catch (_) {
    /* fall through to finally */
  } finally {
    restoreKCAfterScreenshot(hidden);
  }
  return result;
}
// === END PHASE_VIDEO_TAB_SCREENSHOT_FALLBACK ===

async function videoElementToBlobAndDataUrl(videoEl, maxDim = 1200) {
  if (!videoEl || String(videoEl.tagName || '').toUpperCase() !== 'VIDEO') return null;
  const srcW = Number(videoEl.videoWidth) || 0;
  const srcH = Number(videoEl.videoHeight) || 0;
  if (srcW <= 0 || srcH <= 0) return null;
  try {
    const scale = Math.min(maxDim / srcW, maxDim / srcH, 1);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(videoEl, 0, 0, dstW, dstH);
    // dataURL is sync (and throws SecurityError on tainted canvas)
    let dataUrl = null;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (_) {
      dataUrl = null;
    }
    // Blob is async via toBlob callback (also fails on tainted)
    const blob = await new Promise((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b || null), 'image/png');
      } catch (_) {
        resolve(null);
      }
    });
    if (blob || dataUrl) {
      return { blob, dataUrl };
    }
    // Canvas tainted (cross-origin <video> without CORS headers, no
    // crossOrigin="anonymous" attribute). drawImage works but
    // toDataURL/toBlob throw SecurityError. Fall back to tab screenshot
    // crop — see PHASE_VIDEO_TAB_SCREENSHOT_FALLBACK.
    try {
      const screenshotResult = await captureVideoViaTabScreenshot(videoEl, maxDim);
      if (screenshotResult) return screenshotResult;
    } catch (_) {
      // tab screenshot failed — fall through to null
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Backward-compatible wrapper: returns just the Blob.
// Existing callers (prefetchImageBlob, performClipboardCopy, etc.)
// don't need the data URL and continue to use this thin wrapper.
async function videoElementToBlob(videoEl, maxDim = 1200) {
  const result = await videoElementToBlobAndDataUrl(videoEl, maxDim);
  return result?.blob || null;
}
// === END PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL ===
// === END PHASE_VIDEO_BLOB_HELPERS ===

/**
 * Decode a data URL (from background fetch) into a fresh PNG Blob by rendering
 * it to an offscreen canvas. Because the image was fetched via the extension's
 * background context, loading it from the data URL does NOT taint the canvas,
 * so toBlob() works regardless of the original image's origin.
 */
async function dataUrlToPngBlob(dataUrl) {
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth  || img.width  || 0;
    canvas.height = img.naturalHeight || img.height || 0;
    if (canvas.width === 0 || canvas.height === 0) return null;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return await new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob || null), 'image/png');
    });
  } catch (_) {
    return null;
  }
}

// === PHASE_CLIPBOARD_SYNC_WRITE ===
// Sync entry point for the clipboard write, called from the keydown
// handler's sync turn BEFORE any await. Uses the W3C Async Clipboard
// API pattern of passing a Promise<Blob> inside ClipboardItem — the
// browser reserves the clipboard slot during user activation and
// resolves the blob asynchronously in the background, eliminating the
// fire-and-forget race that lets fast paste land before clipboard
// write completes.
//
// Returns a Promise<{success: boolean}> for image/URL paths, or null
// when there's nothing to copy. The legacy performClipboardCopy stays
// for the save-url message path (no user gesture there) and is invoked
// from saveActiveCoreItem when request.skipClipboard is falsy.
//
// Branches:
//   1. Image: Primary imageUrlToPngBlob(imageUrl), fallback to
//      imgElementToBlob(pickDominantImageElement(activeItem)). One
//      Promise<Blob> passed to ClipboardItem.
//   2. SNS contents + imageUrl: imageUrlToPngBlob only (no URL text
//      fallback in sync path per maintainer — instant clipboard
//      prioritized).
//   3. Default: navigator.clipboard.writeText(url).
//   4. Iframe: clipboard write is attempted in iframe contexts too.
//      Per PHASE_IFRAME_CLIPBOARD, the extension's clipboardWrite
//      permission generally permits content-script clipboard writes
//      from any frame given user activation in that frame. Cross-
//      origin iframes without an explicit clipboard-write Permissions
//      Policy may fail with NotAllowedError — handled as clipboard
//      failure (no thick border, badge text falls through to default).
// === PHASE_IFRAME_HOVER_PROPAGATION ===
// Build a synthetic state object from iframeHoverInfo so that
// performSyncClipboardWrite (which expects state.lastExtractedMetadata
// shape) can run without requiring local DOM access. Used in top-frame
// keydown when only iframeHoverInfo is set (iframe hover but top focus).
function buildSyntheticStateFromIframeHover(info) {
  return {
    activeCoreItem: {},  // stub — top frame has no Element ref; pickDominantImageElement won't fire
    activeHoverUrl: info.url,
    lastExtractedMetadata: {
      activeHoverUrl: info.url,
      category: info.category,
      image: info.imageUrl ? { url: info.imageUrl } : null,
      title: info.title,
      platform: info.platform,
    },
  };
}

// Post clipboard result back to the originating iframe so it can apply
// thick border + badge text feedback via markCoreHighlightClipped /
// setCoreStatusBadgeText. The iframe's sourceWindow was captured at
// hover-time. Defensive against window unload / cross-origin throw.
function notifyIframeClipboardResult(info, clipboardPromise) {
  if (!info || !clipboardPromise) return;
  Promise.resolve(clipboardPromise).then((result) => {
    const success = result?.success === true;
    const successText = success ? 'Image clipped' : null;
    try {
      info.sourceWindow?.postMessage({
        [KC_MSG_PREFIX]: true,
        [KC_IFRAME_CLIPBOARD_RESULT]: true,
        success,
        successText,
      }, '*');
    } catch (_) { /* defensive — iframe may have unloaded */ }
  }).catch(() => { /* silent */ });
}
// === END PHASE_IFRAME_HOVER_PROPAGATION ===

// === PHASE_CLIPBOARD_TIMEOUT_FALLBACK ===
// Race the external image fetch against a 1000ms timeout. On Google Images
// result tiles (and similar sites with lazy-populated href anchors), the
// extracted high-resolution URL can stall at the image proxy (504 Gateway
// Timeout) or the direct fetch (ERR_CONNECTION_TIMED_OUT). The Promise<Blob>
// inside ClipboardItem then never resolves quickly, the browser holds the
// clipboard slot until the eventual rejection, and the badge IIFE's
// success: false path is silent for signed-in users. Racing against a short
// timeout lets the buildImageBlobPromise chain fall through to its DOM-image
// fallback (which is fast because the <img>'s currentSrc is already loaded),
// preserving instant paste at the cost of slightly lower resolution.
//
// In-flight fetches that lose the race are not aborted — Q5: leave them to
// be GC'd. The next fetch of the same URL hits browser cache anyway.
const KC_SYNC_IMAGE_FETCH_TIMEOUT_MS = 1000;

// === PHASE_HOVER_IMAGE_PREFETCH ===
function raceImageUrlToPngBlob(imageUrl) {
  // Cache hit: hover-time prefetch already kicked off this fetch.
  // Await the cached promise directly — no race needed because the
  // prefetch had the full hover-to-clip interval (typically 200-2000ms)
  // to complete, far longer than the cold-path 1000ms race window.
  const cached = getCachedBlobPromise(imageUrl);
  if (cached) return cached;
  // Cache miss: fall through to existing race behavior.
  return Promise.race([
    imageUrlToPngBlob(imageUrl),
    new Promise((resolve) => setTimeout(() => resolve(null), KC_SYNC_IMAGE_FETCH_TIMEOUT_MS)),
  ]);
}
// === END PHASE_HOVER_IMAGE_PREFETCH ===
// === END PHASE_CLIPBOARD_TIMEOUT_FALLBACK ===

// === PHASE_IFRAME_CLIPBOARD ===
function performSyncClipboardWrite(state) {
  if (!state) return null;
  // === END PHASE_IFRAME_CLIPBOARD ===

  const meta = state.lastExtractedMetadata || {};
  const imageUrl = String(meta.image?.url || '').trim();
  const activeItem = state.activeCoreItem;

  // === PHASE_VIDEO_DOMINANT_AUTHORITATIVE ===
  // Dominant <video> takes precedence over any non-empty meta.image.url.
  // The user-locked decision is "video dominant → always clip-time canvas
  // frame for clipboard, img_url, and thumbnail." Any stale or fallback
  // value in meta.image.url (e.g., poster URL from a prior extraction,
  // race-condition snapshot) would otherwise route the flow to the
  // imageUrl branch below, which calls attachThumbnailPromiseToClipboardWrite
  // WITHOUT the dataUrlPromise second argument — meaning saveActiveCoreItem's
  // videoFrameDataUrl is null and img_url ends up empty, even when the
  // user clearly clipped a video. Checking dominant element type first
  // and routing to videoElementToBlobAndDataUrl restores correctness.
  if (activeItem instanceof Element) {
    const dominantElPriority = pickDominantImageElement(activeItem);
    if (dominantElPriority && String(dominantElPriority.tagName || '').toUpperCase() === 'VIDEO') {
      const combinedPromise = videoElementToBlobAndDataUrl(dominantElPriority, 1200)
        .catch(() => null);
      const blobPromise = combinedPromise.then((r) => r?.blob || null);
      const dataUrlPromise = combinedPromise.then((r) => r?.dataUrl || null);
      return attachThumbnailPromiseToClipboardWrite(blobPromise, dataUrlPromise);
    }
  }
  // === END PHASE_VIDEO_DOMINANT_AUTHORITATIVE ===

  if (imageUrl) {
    const blobPromise = (async () => {
      try {
        // === PHASE_CLIPBOARD_TIMEOUT_FALLBACK ===
        const raced = await raceImageUrlToPngBlob(imageUrl);
        // === END PHASE_CLIPBOARD_TIMEOUT_FALLBACK ===
        if (raced) return raced;
      } catch (_) { /* fall through */ }
      if (activeItem instanceof Element) {
        const dominantEl = pickDominantImageElement(activeItem);
        if (dominantEl) {
          try {
            const dominantTag = String(dominantEl.tagName || '').toUpperCase();
            let b;
            // === PHASE_VIDEO_CLIP_CLIPBOARD ===
            if (dominantTag === 'VIDEO') {
              b = await videoElementToBlob(dominantEl);
            } else {
              b = await imgElementToBlob(dominantEl);
            }
            // === END PHASE_VIDEO_CLIP_CLIPBOARD ===
            if (b) return b;
          } catch (_) { /* fall through */ }
        }
      }
      return null;
    })();
    // === PHASE_IMAGE_URL_PIPELINE ===
    return attachThumbnailPromiseToClipboardWrite(blobPromise);
    // === END PHASE_IMAGE_URL_PIPELINE ===
  }

  // Defensive fallback — under normal flow this branch is unreachable
  // because PHASE_VIDEO_DOMINANT_AUTHORITATIVE at the top of this function
  // returns early when the dominant element is <video>. Kept as a safety
  // net for edge cases (e.g., activeItem reassigned between the top check
  // and here in a defensive structure) and for code clarity.
  // Video dominant — always use canvas frame for clipboard+thumbnail+img_url.
  // (Poster URL is no longer consulted; canvas frame is the source of truth
  // for all three outputs. See PHASE_VIDEO_CANVAS_FRAME_AS_IMGURL.)
  if (activeItem instanceof Element) {
    const dominantEl = pickDominantImageElement(activeItem);
    if (dominantEl && String(dominantEl.tagName || '').toUpperCase() === 'VIDEO') {
      // Single drawImage produces both blob and dataUrl — same frame.
      const combinedPromise = videoElementToBlobAndDataUrl(dominantEl, 1200)
        .catch(() => null);
      const blobPromise = combinedPromise.then((r) => r?.blob || null);
      const dataUrlPromise = combinedPromise.then((r) => r?.dataUrl || null);
      return attachThumbnailPromiseToClipboardWrite(blobPromise, dataUrlPromise);
    }
  }

  return null;
}
// === END PHASE_CLIPBOARD_SYNC_WRITE ===

/**
 * Perform clipboard copy. Returns success/fail info without showing any Toast.
 * When imageUrl is set: URL race (KK prefetch cache) then DOM fallback.
 * Otherwise leaves clipboard empty (no URL-text fallback).
 */
async function performClipboardCopy(category, url, rootElementForDominant, options = {}) {
  const { imageUrl } = options;
  try {
    if (imageUrl) {
      try {
        let blob = null;
        try {
          // === PHASE_CLIPBOARD_TIMEOUT_FALLBACK ===
          blob = await raceImageUrlToPngBlob(imageUrl);
          // === END PHASE_CLIPBOARD_TIMEOUT_FALLBACK ===
        } catch (_) { /* fall through */ }
        if (!blob && rootElementForDominant instanceof Element) {
          const dominantEl = pickDominantImageElement(rootElementForDominant);
          if (dominantEl) {
            const dominantTag = String(dominantEl.tagName || '').toUpperCase();
            // === PHASE_VIDEO_CLIP_CLIPBOARD ===
            if (dominantTag === 'VIDEO') {
              blob = await videoElementToBlob(dominantEl);
            } else {
              blob = await imgElementToBlob(dominantEl);
            }
            // === END PHASE_VIDEO_CLIP_CLIPBOARD ===
          }
        }
        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type || 'image/png']: blob })
          ]);
          return { success: true };
        }
      } catch (_) { /* fall through */ }
    } else if (rootElementForDominant instanceof Element) {
      const dominantEl = pickDominantImageElement(rootElementForDominant);
      if (dominantEl && String(dominantEl.tagName || '').toUpperCase() === 'VIDEO') {
        try {
          const blob = await videoElementToBlob(dominantEl);
          if (blob) {
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type || 'image/png']: blob })
            ]);
            return { success: true };
          }
        } catch (_) { /* fall through */ }
      }
    }
    return { success: false };
  } catch (err) {
    console.warn('[KickClip] Clipboard copy failed:', err);
    return { success: false };
  }
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
          // UI re-trigger removed: saved-urls-updated should sync data only.
          // Save feedback is handled directly in save paths.
        } catch (e) {}
      });
      return false;
    }
    if (request?.action !== 'save-url') return false;

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
                image: iframeRelayData.imgUrl ? { url: iframeRelayData.imgUrl } : null,
                _pageUrl: iframeRelayData.pageUrl || '',
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
          if (!e.data || !e.data[KC_MSG_PREFIX]) return;
          // === PHASE_IFRAME_HOVER_PROPAGATION ===
          if (e.data[KC_IFRAME_CLIPBOARD_RESULT] === true) {
            try {
              if (e.data.success === true) {
                markCoreHighlightClipped();
                if (e.data.successText) {
                  setCoreStatusBadgeText(String(e.data.successText));
                }
              } else {
                setCoreStatusBadgeText('Clip failed');
              }
            } catch (_) { /* defensive */ }
            return;
          }
          // === END PHASE_IFRAME_HOVER_PROPAGATION ===
          if (e.data[KC_SAVE_QUERY] !== true) return;
          const activeItem = state.activeCoreItem;
          const activeUrl = String(state.activeHoverUrl || '').trim();
          if (!activeItem || !activeUrl) return;

          const saveFeedbackHidden = hideKCSaveFeedbackUi();
          const saveKickClipStartedAt = Date.now();
          try {
            const meta = state.lastExtractedMetadata || {};
            const imgUrl = String(meta?.image?.url || '').trim();

            // === D4: image-less silent guard (iframe-side parity) ===
            // The iframe's active CoreItem yielded no image at relay time.
            // Mirroring D3 on the parent: do not paint the shutter, do not
            // set the status badge, do not postMessage to window.top.
            // Returning here lets the outer try/finally run
            // finalizeKCSaveFeedback, which restores the metadata tooltip
            // and re-applies the highlight. Parent's 80ms broadcast wait
            // expires with no iframeHandled flag set, producing a silent
            // no-op end-to-end.
            if (!imgUrl) {
              return;
            }

            // === PHASE_SHUTTER_REMOVAL ===
            // Iframe relay does no visual feedback. The top frame's clipboard
            // result determines success; iframe has no path to know.
            // === END PHASE_SHUTTER_REMOVAL ===
            await waitForRepaint();

            window.top.postMessage(
              {
                [KC_MSG_PREFIX]: true,
                [KC_SAVE_HANDLED]: true,
                [KC_SAVE_RELAY]: true,
                url: activeUrl,
                title: String(meta?.title || '').trim(),
                imgUrl,
                category: String(meta?.category || '').trim(),
                platform: String(meta?.platform || '').trim(),
                pageUrl: String(window.location.href || '').trim(),
              },
              '*'
            );
          } finally {
            await finalizeKCSaveFeedback(saveFeedbackHidden, saveKickClipStartedAt);
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
  // === PHASE_IMG_LOAD_TRIGGER ===
  // Some sites (e.g. Behance) complete lazy-load by populating an
  // <img>'s underlying bytes without mutating its `src` attribute and
  // without inserting/removing any DOM node KickClip's MutationObserver
  // observes. The class swap on the parent <a> is filtered out by the
  // observer's attributeFilter: ['src']; the placeholder removal is a
  // removedNodes-only mutation the callback also does not check. The
  // net effect: no preScan trigger fires when lazy-load actually
  // completes, and detection does not catch up until an unrelated
  // event (resize, scroll-driven hover, popup) perturbs state.
  //
  // The <img>.load event fires reliably when any image's bytes finish
  // decoding, including <picture><source srcset> swaps that leave
  // <img src> unchanged. We listen at the document level in capture
  // phase because individual elements' `load` events do not bubble.
  // schedulePreScan() is already debounced via scanTimer, so even a
  // burst of simultaneous loads collapses to a single scan.
  document.addEventListener(
    'load',
    (e) => {
      const t = e?.target;
      if (!t || t.nodeType !== 1) return;
      if (String(t.tagName || '').toUpperCase() !== 'IMG') return;
      schedulePreScan(document, false, 'img-load');
    },
    { passive: true, capture: true }
  );
  // === END PHASE_IMG_LOAD_TRIGGER ===

// === PHASE_SCROLL_PRESCAN_TRIGGER ===
// Lazy-loaded images that already completed (class="lazyloaded") don't
// fire load events again. Without a scroll-time scan, an image rejected
// in the initial scan (e.g., for being off-screen with small rect)
// remains undetected until an unrelated trigger (resize, mutation)
// fires. Debounce at 500ms so scroll bursts don't flood schedulePreScan
// (which itself coalesces, but the additional bound keeps the call
// site cheap).
let lastScrollScanTime = 0;
const SCROLL_PRESCAN_DEBOUNCE_MS = 500;
function schedulePreScanScrollDebounced() {
  const now = Date.now();
  if (now - lastScrollScanTime < SCROLL_PRESCAN_DEBOUNCE_MS) return;
  lastScrollScanTime = now;
  schedulePreScan(document, false, 'window-scroll');
}
// === END PHASE_SCROLL_PRESCAN_TRIGGER ===

  window.addEventListener('scroll', async () => {
    // === PHASE_SCROLL_PRESCAN_TRIGGER_INTEGRATION ===
    // Trigger a debounced pre-scan on scroll so lazy-loaded images
    // newly entering the viewport get detected even without a fresh
    // load event. Acts before the activeCoreItem early-return so it
    // fires regardless of hover state.
    schedulePreScanScrollDebounced();
    // === END PHASE_SCROLL_PRESCAN_TRIGGER_INTEGRATION ===

    const active = state.activeCoreItem;

    if (!active) return;
    // Compute current rect for the active CoreItem and pass it as rectOverride
    // so showCoreHighlight() treats this as a scroll update (isScrollUpdate = true).
    // === PHASE_OVERLAY_ON_IMAGE ===
    // Scroll re-paint follows the overlay element (Type D may differ from
    // activeCoreItem), so the outline stays anchored to the image region
    // rather than jumping to the whole-card rect on scroll.
    const overlayElement = state.activeOverlayElement || active;
    const scrollRect = overlayElement.getBoundingClientRect?.();
    // === END PHASE_OVERLAY_ON_IMAGE ===
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
  // === PHASE_KEYDOWN_SHORTCUT ===
  // Custom clip shortcut. Listens for the user-configured shortcut
  // (stored via shortcutStore.js as 'kickclipShortcutV2') and, when
  // matched, conditionally triggers the clip flow:
  //   - If state.activeCoreItem and state.activeHoverUrl are set
  //     (overlay is active on a clippable item), preventDefault the
  //     keystroke and invoke saveActiveCoreItem directly.
  //   - Otherwise, do nothing — the keystroke proceeds to its default
  //     behavior (text copy for Cmd+C, save dialog for Cmd+S, etc.),
  //     so we don't interfere with Chrome's native shortcuts when the
  //     user isn't actively trying to clip.
  //
  // Capture phase (third arg = true) is used so KickClip evaluates the
  // gate before any page-level listener can preventDefault and steal
  // the event.
  //
  // _activeShortcut is module-level (initialized by PHASE_BADGE_SHORTCUT_SYNC
  // above). The keydown listener just reads it; no separate init needed.

  document.addEventListener('keydown', async (event) => {
    if (!_activeShortcut) return;
    if (!matchesShortcut(event, _activeShortcut)) return;
    // === PHASE_IFRAME_CLIP_REQUEST ===
    // Iframe-focused keydown: clipboard.write would be blocked by Permissions
    // Policy on most cross-origin iframes. Instead, delegate to top frame via
    // postMessage — per Chrome User Activation v2, iframe's keydown activates
    // all containing frames (including top), so top's clipboard.write succeeds.
    // DO NOT call performSyncClipboardWrite in iframe — that would consume
    // the transient activation bit on all frames in the tree.
    if (IS_IFRAME) {
      if (!state.activeCoreItem || !state.activeHoverUrl) return;
      event.preventDefault();
      event.stopPropagation();
      const meta = state.lastExtractedMetadata || {};
      try {
        window.top.postMessage({
          [KC_MSG_PREFIX]: true,
          [KC_IFRAME_CLIP_REQUEST]: true,
          url: String(state.activeHoverUrl || '').trim(),
          imageUrl: String(meta?.image?.url || '').trim(),
          category: String(meta?.category || '').trim(),
          title: String(meta?.title || '').trim(),
          platform: String(meta?.platform || '').trim(),
          pageUrl: String(window.location.href || '').trim(),
        }, '*');
      } catch (_) { /* defensive */ }
      try {
        await saveActiveCoreItem({
          action: 'save-url',
          skipClipboard: true,
          clipboardPromise: null,
          fromIframeClipRequest: true,
        });
      } catch (e) { /* defensive */ }
      return;
    }
    // === END PHASE_IFRAME_CLIP_REQUEST ===
    // === PHASE_IFRAME_HOVER_PROPAGATION ===
    const hasLocalHover = !!(state.activeCoreItem && state.activeHoverUrl);
    const iframeInfo = state.iframeHoverInfo;
    const hasIframeHover = !!(iframeInfo && iframeInfo.url);
    if (!hasLocalHover && !hasIframeHover) {
      // Inactive — fall through to native behavior.
      return;
    }
    // === END PHASE_IFRAME_HOVER_PROPAGATION ===
    // Active — claim the event and trigger clip.
    event.preventDefault();
    event.stopPropagation();
    // === PHASE_CLIPBOARD_SYNC_WRITE ===
    // Call clipboard write in the sync turn (before any await) to
    // preserve user activation. Blob fetch/encode runs async via
    // Promise<Blob> inside ClipboardItem; browser holds the slot
    // until resolution.
    let clipboardPromise = null;
    try {
      if (hasLocalHover) {
        clipboardPromise = performSyncClipboardWrite(state);
      } else {
        // === PHASE_IFRAME_HOVER_PROPAGATION ===
        const syntheticState = buildSyntheticStateFromIframeHover(iframeInfo);
        clipboardPromise = performSyncClipboardWrite(syntheticState);
        // === END PHASE_IFRAME_HOVER_PROPAGATION ===
      }
    } catch (e) {
      // defensive — sync helper should not throw, but never let
      // clipboard issues block the save dispatch.
    }
    // === END PHASE_CLIPBOARD_SYNC_WRITE ===
    // === PHASE_IFRAME_HOVER_PROPAGATION ===
    if (hasIframeHover && !hasLocalHover && clipboardPromise) {
      notifyIframeClipboardResult(iframeInfo, clipboardPromise);
    }
    // === END PHASE_IFRAME_HOVER_PROPAGATION ===
    try {
      if (hasLocalHover) {
        await saveActiveCoreItem({
          action: 'save-url',
          skipClipboard: true,
          clipboardPromise,
        });
      } else {
        // === PHASE_IFRAME_HOVER_PROPAGATION ===
        // Relay-style stub state for saveActiveCoreItem.
        const savedActive = state.activeCoreItem;
        const savedUrl = state.activeHoverUrl;
        const savedMeta = state.lastExtractedMetadata;
        state.activeCoreItem = {};
        state.activeHoverUrl = iframeInfo.url;
        state.lastExtractedMetadata = {
          activeHoverUrl: iframeInfo.url,
          category: iframeInfo.category,
          image: iframeInfo.imageUrl ? { url: iframeInfo.imageUrl } : null,
          title: iframeInfo.title,
          platform: iframeInfo.platform,
          _pageUrl: iframeInfo.pageUrl,
          _isIframeHoverPropagation: true,
        };
        try {
          await saveActiveCoreItem({
            action: 'save-url',
            skipClipboard: true,
            clipboardPromise,
            fromIframeHover: true,
          });
        } finally {
          state.activeCoreItem = savedActive;
          state.activeHoverUrl = savedUrl;
          state.lastExtractedMetadata = savedMeta;
        }
        // === END PHASE_IFRAME_HOVER_PROPAGATION ===
      }
    } catch (e) {
      // defensive — clip failures shouldn't crash the listener
    }
  }, true);
  // === END PHASE_KEYDOWN_SHORTCUT ===
  window.addEventListener('resize', () => schedulePreScan(document, false, 'window-resize'), { passive: true });
  window.addEventListener('mouseover', async (e) => {
    if (!_windowFocused) return;
    lastPointerX = e?.clientX ?? lastPointerX;
    lastPointerY = e?.clientY ?? lastPointerY;
    const target = e?.target && e.target.nodeType === 1 ? e.target : null;
    if (target === _lastMouseoverTarget) return;
    _lastMouseoverTarget = target;
    // YouTube #video-preview hover preview is a transient overlay that the
    // dispatcher should ignore — it appears and disappears too fast for
    // our purposes.
    if (target && target.closest?.('#video-preview, ytd-miniplayer')) return;
    // Already on the active CoreItem? Nothing to do.
    const active = state.activeCoreItem;
    if (active && typeof active.contains === 'function' && active.contains(target)) {
      // === PHASE_OVERLAY_HOVER_GATE ===
      // Pointer moved within the same coreItem (mouseover skip optimization).
      // For Type D, that's not enough — the pointer may have left the
      // image-region overlay but stayed inside the caption / byline /
      // other figure chrome. Re-check against state.activeOverlayElement
      // via rect+clientXY hit-test (DOM contains is fooled by sibling
      // overlay elements stacked above the image — see helper notes).
      // For Type B / Type E, activeOverlayElement === active, so the
      // condition `overlayEl !== active` short-circuits the gate.
      const overlayEl = state.activeOverlayElement;
      if (overlayEl && overlayEl !== active) {
        // === PHASE_OVERLAY_LIFECYCLE_DECOUPLING ===
        // Decoupled lifecycle: activeCoreItem stays alive as long as the
        // pointer is inside `active`. The overlay + status_badge follow a
        // narrower lifecycle: shown only while the pointer is inside the
        // overlay element's rect. Hovering caption / byline / action bar
        // (still inside `active`) hides them; returning to the image
        // region re-shows them. Both transitions are stateless: idempotent
        // show/hide on every mouseover.
        if (isPointerInsideOverlay(overlayEl, e.clientX, e.clientY, target)) {
          const overlayRect = overlayEl.getBoundingClientRect?.();
          if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
            showCoreHighlight(active, false, overlayRect);
          }
        } else {
          hideCoreHighlight();
        }
        // === END PHASE_OVERLAY_LIFECYCLE_DECOUPLING ===
      }
      // === END PHASE_OVERLAY_HOVER_GATE ===
      return;
    }
    // === PHASE27D_RELAXED_DISPATCH ===
    // Hovering off any candidate clears the active CoreItem rather than
    // letting it linger. The previous behavior left the highlight on
    // stale items when the pointer slid into an unrelated region of the
    // page; that surprised users and conflicted with the cluster cache
    // invariant.
    if (!target) {
      if (active) coreClear();
      return;
    }
    // === END PHASE27D_RELAXED_DISPATCH ===
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
      // clean up any active CoreHighlight via coreClear().
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
      try { hideCoreStatusBadge(); } catch (_) {}
      try { hideCoreHighlight(); } catch (_) {}
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
    lastRenderedElementSet = null;
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
  if (!window.__kickclipHistoryPatched) {
    window.__kickclipHistoryPatched = true;
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
      try { hideCoreHighlight(); }   catch (e) {}
      try { hideMetadataTooltip(); }   catch (e) {}
      try { if (!IS_IFRAME) { hideCoreStatusBadge(); } }       catch (e) {}
      // === PHASE_COREITEM_LIVE_METADATA ===
      unmountActiveCoreItemMutationObserver();
      // === END PHASE_COREITEM_LIVE_METADATA ===
      state.activeCoreItem       = null;
      state.activeHoverUrl       = null;
      state.lastExtractedMetadata = null;
    };

    // Shared restore logic for when the browser regains focus or tab becomes visible.
    const onBrowserVisible = () => {
      _windowFocused = true;
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

// === PHASE_IFRAME_HOVER_PROPAGATION ===
// Top-frame-only listener that maintains state.iframeHoverInfo based
// on KC_IFRAME_HOVER / KC_IFRAME_HOVER_END messages from iframe content
// scripts. Provides the bridge for top keydown to clip iframe-internal
// images when iframe Permissions Policy blocks navigator.clipboard.write.
function mountIframeHoverPropagationListener() {
  if (IS_IFRAME) return;
  if (window.__kcIframeHoverPropagationListenerMounted) return;
  window.__kcIframeHoverPropagationListenerMounted = true;
  window.addEventListener(
    'message',
    (event) => {
      try {
        const data = event?.data;
        if (!data || data[KC_MSG_PREFIX] !== true) return;
        if (data[KC_IFRAME_HOVER] === true) {
          state.iframeHoverInfo = {
            url: String(data.url || '').trim(),
            imageUrl: String(data.imageUrl || '').trim(),
            category: String(data.category || '').trim(),
            title: String(data.title || '').trim(),
            platform: String(data.platform || '').trim(),
            pageUrl: String(data.pageUrl || '').trim(),
            sourceWindow: event.source,
          };
        } else if (data[KC_IFRAME_HOVER_END] === true) {
          if (state.iframeHoverInfo?.sourceWindow === event.source) {
            state.iframeHoverInfo = null;
          }
        // === PHASE_IFRAME_CLIP_REQUEST ===
        } else if (data[KC_IFRAME_CLIP_REQUEST] === true) {
          // Iframe-focused clipboard delegation. Build synthetic state
          // from message payload (same shape as buildSyntheticStateFromIframeHover
          // expects) and call performSyncClipboardWrite in this message
          // handler's sync turn — per Chrome UAv2, iframe's keydown activation
          // is visible on top frame, so clipboard.write succeeds.
          const info = {
            url: String(data.url || '').trim(),
            imageUrl: String(data.imageUrl || '').trim(),
            category: String(data.category || '').trim(),
            title: String(data.title || '').trim(),
            platform: String(data.platform || '').trim(),
            pageUrl: String(data.pageUrl || '').trim(),
            sourceWindow: event.source,
          };
          const syntheticState = buildSyntheticStateFromIframeHover(info);
          let clipboardPromise = null;
          try {
            clipboardPromise = performSyncClipboardWrite(syntheticState);
          } catch (_) { /* defensive */ }
          if (clipboardPromise) {
            notifyIframeClipboardResult(info, clipboardPromise);
          } else {
            // Synthetic clipboard returned null — no image and no DOM (always
            // true in synthetic). Notify iframe of failure.
            try {
              event.source?.postMessage({
                [KC_MSG_PREFIX]: true,
                [KC_IFRAME_CLIPBOARD_RESULT]: true,
                success: false,
                successText: null,
              }, '*');
            } catch (_) { /* defensive */ }
          }
        }
        // === END PHASE_IFRAME_CLIP_REQUEST ===
      } catch (_) { /* defensive */ }
    },
    { passive: true }
  );
}
// === END PHASE_IFRAME_HOVER_PROPAGATION ===

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
  // Hover/detection runs signed-out; server save / optimistic UI use isSignedIn().
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
        // === PHASE_BADGE_SHADOW_REGRESSION_FIX ===
        // Badge lives in the badge shadow root (closed mode). Overlay lives
        // in main shadow. document.getElementById returned null for both.
        const ids = [
          'kickclip-highlight-overlay',
          'kickclip-status-badge-core',
        ];
        for (const id of ids) {
          const el = id === 'kickclip-status-badge-core'
            ? getKCBadgeShadowElement(id)
            : getKCShadowElement(id);
          if (el) { el.style.transition = ''; el.style.opacity = '0'; }
        }
        // === END PHASE_BADGE_SHADOW_REGRESSION_FIX ===
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
  // Create the Shadow DOM host up-front so it exists from page load,
  // before any UI function tries to use it. Idempotent — safe to call
  // here and later; subsequent calls return the cached shadow root.
  try { getKCShadowRoot(); } catch (_) { /* DOM unavailable — silent */ }

  mountWindowListeners();
  mountObservers();
  mountSaveMessageListener();
  mountInstagramShortcodeObserver();
  // Top-frame-only initialization. iframe contexts still run CoreItem
  // detection but must not render the full-page overlay.
  if (window.self === window.top) {
    // Populate _savedUrlSet from background cache (restored from chrome.storage.local)
    // so the first isSaved check is accurate.
    try {
      chrome.runtime.sendMessage({ action: 'get-saved-urls' }, (response) => {
        if (!chrome.runtime.lastError && Array.isArray(response?.urls)) {
          const normalized = normalizeSavedUrlsResponse(response.urls);
          _savedUrlSet = new Set(normalized);
        }
      });
    } catch (e) {}
    mountIframeSaveQueryListener();
    // === PHASE_IFRAME_HOVER_PROPAGATION ===
    mountIframeHoverPropagationListener();
    // === END PHASE_IFRAME_HOVER_PROPAGATION ===
  }
}

// === PHASE27B_REMOVED_GLOBAL ===
// window.__kcApplyCoreItem was an out-of-band activation entry
// point with no in-repo callers. It maintained its own copy of
// the URL gate and a divergent metadata path. Phase 27 removes
// it to keep activation flow in a single canonical place
// (updateCoreSelectionFromTarget).
// === END PHASE27B_REMOVED_GLOBAL ===

// === PHASE_AI_DOMAIN_UNLOCK ===
// Previously gated on !_isElectronApp to skip Electron-based desktop apps.
// Restriction removed; see content-loader.js for full rationale.
checkKcUserAndInit();
// === END PHASE_AI_DOMAIN_UNLOCK ===
