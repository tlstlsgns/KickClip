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
  updateCoreHighlightClass,
  hideCoreHighlight,
  clearCoreSelection,
  ensureClusterCacheFromState,
  showMetadataTooltip,
  setAiTooltipContent,
  clearAiTooltipContent,
  positionMetadataTooltip,
  showCoreStatusBadge,
  setCoreBadgeTexts,
  setCoreStatusBadgeText,
  hideCoreStatusBadge,
  positionCoreStatusBadge,
  renderItemMapCandidates,
  hideMetadataTooltip,
  detectItemCategory,
  triggerShutterEffect,
} from './coreEngine.js';
import {
  extractYouTubeShortcodeFromUrl,
  getYouTubeThumbnailUrl,
} from './dataExtractor.js';
import {
  getKCShadowRoot,
  getKCShadowElement,
  findKCElement,
} from './uiManager.js';

let _kcUserReady = false; // true when kickclipUserId is confirmed
/** Readable gate for signed-in save / optimistic UI (signed-out = clipboard-only exploration). */
function isSignedIn() {
  return _kcUserReady === true;
}
// Cached keyboard shortcut display string, derived from
// chrome.storage.local.kickclipShortcut (written by background.js
// runShortcutPoll). Updated on init and via storage.onChanged so toast
// and status-badge text can be built synchronously.
let _shortcutDisplay = '';

let scanTimer = 0;
let lastFingerprint = '';
let lastRenderedElementSet = null;
let _retryScanTimer = 0;    // setTimeout handle for pending retry scan
let _retryScanCount  = 0;   // number of retries attempted for current navigation
let _forceFullScanOnMutation = false; // true after navigation: next MutationObserver trigger uses full document scan
let lastPointerX = null;
let lastPointerY = null;
let _lastMouseoverTarget = null;
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

/**
 * Convert a raw shortcut string ("Ctrl+Shift+S" / "MacCtrl+Shift+S")
 * to the platform-appropriate display: glyphs on Mac, plain text elsewhere.
 */
function formatShortcutForDisplay(raw) {
  const r = String(raw || 'Ctrl+Shift+S');
  const isMac =
    navigator.platform.toUpperCase().includes('MAC') ||
    navigator.userAgent.includes('Mac');
  return isMac
    ? r
        .replace(/MacCtrl/gi, '⌃')
        .replace(/Ctrl/gi, '⌘')
        .replace(/Command/gi, '⌘')
        .replace(/Shift/gi, '⇧')
        .replace(/Alt/gi, '⌥')
        .replace(/\+/g, '')
    : r;
}

/**
 * Populate _shortcutDisplay from chrome.storage and keep it in sync
 * with future updates. Idempotent — safe to call once at module init.
 */
function initShortcutCache() {
  try {
    _shortcutDisplay = formatShortcutForDisplay('Ctrl+Shift+S');
    syncCoreBadgeTexts();
    chrome.storage.local.get('kickclipShortcut', (result) => {
      try {
        _shortcutDisplay = formatShortcutForDisplay(result?.kickclipShortcut);
        syncCoreBadgeTexts();
      } catch (_) {}
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('kickclipShortcut' in changes) {
        try {
          _shortcutDisplay = formatShortcutForDisplay(
            changes.kickclipShortcut?.newValue
          );
          syncCoreBadgeTexts();
        } catch (_) {}
      }
    });
  } catch (_) {}
}

/**
 * Build the current status_badge texts from the cached shortcut and
 * register them with uiManager. Called at init and whenever the
 * shortcut changes via storage.onChanged.
 */
function syncCoreBadgeTexts() {
  const shortcut = _shortcutDisplay || 'shortcut';
  setCoreBadgeTexts({
    defaultText: `Press ${shortcut} to clip`,
    failedText: 'Clip failed',
  });
}

initShortcutCache();

// Waits for the browser to complete two paint frames.
// Used to ensure DOM visibility changes are reflected on screen.
function waitForRepaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Temporarily hides purple overlay + metadata tooltip (opacity 0, layout preserved).
 * @returns {Array<{ el: HTMLElement, prevOpacity: string, prevTransition: string }>}
 */
/** Hides only the metadata tooltip during save; purple/full-page shutter flash is `triggerShutterEffect`. */
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

/** Ensures a minimum visible shutter duration, then restores save-feedback UI and re-applies purple. */
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

function coreClear() {
  _aiAnalyzeSession++;
  if (IS_IFRAME) {
    state.activeCoreItem = null;
    state.activeHoverUrl = null;
    state.lastExtractedMetadata = null;
    try { hideCoreHighlight(); } catch (e) {}
  } else {
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
      ? extractMetadataForCoreItem(coreItem, closestAtag, target, cacheOverrides) || {}
      : extractMetadataForCoreItem(coreItem, closestAtag, target) || {};

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
  // Phase 27b: Type E has no descendant anchor, so force
  //   meta.activeHoverUrl = window.location.href for the clip path.
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
    meta = { ...meta, activeHoverUrl: String(window.location.href || '') };
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
      const { category, platform, confirmedType } = detectItemCategory(
        syncedMeta.activeHoverUrl,
        window.location.href,
        htmlCtx
      );
      syncedMeta = { ...syncedMeta, category };
      if (platform) syncedMeta = { ...syncedMeta, platform };
      if (confirmedType) syncedMeta = { ...syncedMeta, confirmedType };
    } catch (e) {}
  }

  // === PHASE27F_TYPE_E_CATEGORY ===
  // Type E activeCoreItem represents a standalone <img>. The
  // generic category enrichment above calls detectItemCategory
  // with pageUrl as both arguments and an <img>-internal htmlCtx,
  // which cannot reliably infer a category and typically returns
  // undefined. Per Phase 27f user decision, Type E saves are
  // always category: 'Image'. Override unconditionally.
  // Note: platform / confirmedType are left as-is so any genuine
  // signal detectItemCategory produced is preserved.
  if (evidenceType === 'E') {
    syncedMeta = { ...syncedMeta, category: 'Image' };
  }
  // === END PHASE27F_TYPE_E_CATEGORY ===

  // Final activation. The iframe-vs-top split is preserved.
  if (IS_IFRAME) {
    state.activeCoreItem = coreItem;
    state.activeHoverUrl = syncedMeta.activeHoverUrl;
    state.lastExtractedMetadata = syncedMeta;
    showCoreHighlight(coreItem, false);
    showCoreStatusBadge('default');
    if (evidenceType === 'B') {
      requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, null, null);
    }
    return true;
  }
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  showCoreHighlight(coreItem, false);
  showCoreStatusBadge('default');
  if (evidenceType === 'B') {
    requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  if (evidenceType === EVIDENCE_TYPE_IMAGE_ANCHOR) {
    requestInstagramThumbnail(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  return true;
  // === END PHASE27B_HOVER_DISPATCH ===
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
        // React to <img src> attribute mutations (lazy-load real swap).
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'src' &&
          mutation.target?.nodeType === 1 &&
          String(mutation.target.tagName || '').toUpperCase() === 'IMG'
        ) {
          // Skip noise sources
          if (mutation.target.closest?.('#video-preview') || mutation.target.closest?.('ytd-miniplayer')) continue;
          schedulePreScan(document, false, 'mutation-img-src');
          return;
        }
        // === END PHASE20_HOTFIX_SRC_MUTATION ===
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
      attributeFilter: ['src'],
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

async function saveActiveCoreItem(request = {}) {
    const activeItem = state.activeCoreItem;
    const activeUrl = String(state.activeHoverUrl || '').trim();

    // No CoreItem active → complete silent ignore
    if (!activeItem || !activeUrl) {
      return { success: false, reason: 'no-core-item' };
    }

    const saveShutterStatus = await resolveSaveShutterStatus();

    // CoreItem active → existing logic
    const meta = state.lastExtractedMetadata;

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
        const freshResult = extractImageFromCoreItem(activeCoreEl);
        const freshUrl = String(freshResult?.image?.url || '').trim();
        if (freshUrl) {
          freshImage = freshResult.image;
        }
      }
    } catch (e) { /* keep cached image */ }
    // === END PHASE20_HOTFIX_CLIP_TIME_IMAGE ===

    // Relay mode: top-frame is processing a clip that originated inside a
    // cross-origin iframe. The iframe handler already drew shutter +
    // status_badge text in its own Shadow DOM (Phase 11a). The top frame
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
    const imgUrl = isYouTubeSave
      ? youtubeThumbnailUrl
      : String(request?.img_url || freshImage?.url || '').trim();

    // === D3: image-less silent guard ===
    // CoreItem is active but no image is resolvable at clip time:
    //   - extractImageFromCoreItem() yielded nothing (cached or fresh),
    //   - request.img_url (iframe-relay path) is empty,
    //   - and the URL is not a YouTube watch/short URL (whose thumbnail
    //     would always be present via youtubeThumbnailUrl).
    // KickClip now clips only image-bearing CoreItems and SNS posts.
    // Return silently — no clipboard, no shutter, no optimistic card,
    // no server fetch — so the user sees nothing happen, mirroring the
    // 'no-core-item' early-return shape above.
    if (!imgUrl) {
      return { success: false, reason: 'no-image' };
    }

    // Step 1: hide CoreHighlight + StatusBadge for screenshot.
    // Skipped in relay mode — iframe owns the visible UI.
    const coreOverlayEl = !isIframeRelay
      ? getKCShadowElement('kickclip-highlight-overlay')
      : null;
    const coreBadgeEl = !isIframeRelay
      ? getKCShadowElement('kickclip-status-badge-core')
      : null;
    if (coreOverlayEl) { coreOverlayEl.style.transition = ''; coreOverlayEl.style.opacity = '0'; }
    if (coreBadgeEl)   { coreBadgeEl.style.transition = '';   coreBadgeEl.style.opacity = '0'; }

    // Reflects whether extractImageFromCoreItem() produced a result —
    // independent of which URL is ultimately used as img_url.
    const isExtractedImg = !!(meta?.image?.url && String(meta.image.url).trim().length > 0);

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

    // Clipboard copy: start async copy without blocking. Result is combined
    // with save result (from saveShutterStatus) after triggerShutterEffect
    // to produce a single unified Toast.
    const coreClipboardCategory = String(meta?.category || '').trim();
    const coreClipboardPromise = (window.self === window.top)
      ? performClipboardCopy(
          coreClipboardCategory,
          url,
          activeItem instanceof Element ? activeItem : document.body,
          {
            confirmedType: String(meta?.confirmedType || '').trim(),
            imageUrl: String(faviconImgUrl || meta?.image?.url || imgUrl || '').trim(),
          }
        )
      : Promise.resolve({ success: false });

    // Generate tempId for end-to-end matching: Optimistic Card ↔ Firestore doc
    // Only generated in top-level frame (iframes skip Optimistic Card dispatch).
    const tempId = window.self === window.top
      ? `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      : '';

    // Immediately update _savedUrlSet before shutter so checkIsSavedSync() returns true
    // even if saved-urls-updated arrives before fetch completes.
    if (isSignedIn()) {
      try {
        const savedUrl = normalizeUrlForSavedCheck(url);
        if (savedUrl) _savedUrlSet.add(savedUrl);
      } catch (e) {}
    }

    if (!isIframeRelay) {
      const effectiveCoreSaveShutterStatus = isSignedIn() ? saveShutterStatus : 'success';
      triggerShutterEffect('core', effectiveCoreSaveShutterStatus);

      // CoreItem clip feedback lives in the per-item status_badge.
      // We wait for the clipboard result, then write the
      // category-aware "clipped" wording on success. Failure text is already
      // applied automatically by triggerShutterEffect('core', 'error') via
      // the registered _coreBadgeFailedText.
      //
      // Skipped entirely in relay mode — the iframe handler already drew
      // shutter and badge text in its own Shadow DOM (Phase 11a).
      if (window.self === window.top) {
        (async () => {
          try {
            const clipboardResult = await coreClipboardPromise;
            if (clipboardResult?.success) {
              const successText = coreClipboardCategory === 'Image'
                ? 'Image clipped'
                : 'URL clipped';
              setCoreStatusBadgeText(successText);
            } else if (!isSignedIn()) {
              triggerShutterEffect('core', 'error');
            }
            // Signed-in case where clipboard fails but save might succeed:
            // shutter already reflects save status correctly via
            // saveShutterStatus; "Clip failed" text would be wrong because
            // save did clip something to Firestore. Keep current behavior
            // (text was set by triggerShutterEffect based on save status).
          } catch (_) { /* silent */ }
        })();
      }
    }

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
          domImgSrc = String(
            domImg.getAttribute?.('src') || domImg.src || ''
          ).trim();
        }
      }
    } catch (e) {
      // defensive — leave domImgSrc empty
    }
    // === END PHASE27G_DOM_IMG_SRC ===

    // Extract HTML context from the active CoreItem for AI type inference
    const htmlContext = extractCoreItemHtmlContext(activeItem);
    const payload = {
      url,
      title: title || url,
      timestamp: Date.now(),
      saved_by: 'browser-extension',
      userLanguage: navigator.language || 'en',
      pageUrl: meta?._pageUrl || window.location.href,
      ...(tempId ? { temp_id: tempId } : {}),
      ...(htmlContext ? { htmlContext } : {}),
      ...(faviconImgUrl ? { img_url: faviconImgUrl } : {}),
      // === PHASE27G_PAYLOAD_DOM ===
      ...(domImgSrc && domImgSrc !== faviconImgUrl
        ? { img_url_dom: domImgSrc }
        : {}),
      // === END PHASE27G_PAYLOAD_DOM ===
      ...(userId ? { userId } : {}),
      ...(meta?.category      ? { category:       meta.category }      : {}),
      ...(meta?.platform      ? { platform:        meta.platform }      : {}),
      ...(meta?.confirmedType ? { confirmed_type:  meta.confirmedType } : {}),
      img_url_method: isYouTubeSave
        ? 'youtube-thumbnail'
        : (isExtractedImg ? 'extracted' : 'favicon'),
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
          imgUrl:             faviconImgUrl || '',
          // === PHASE27G_OPTIMISTIC_DOM ===
          ...(domImgSrc && domImgSrc !== faviconImgUrl
            ? { imgUrlDom: domImgSrc }
            : {}),
          // === END PHASE27G_OPTIMISTIC_DOM ===
          category:           String(meta?.category      || '').trim(),
          platform:           String(meta?.platform      || '').trim(),
          confirmedType:      String(meta?.confirmedType || '').trim(),
          img_url_method: isYouTubeSave
            ? 'youtube-thumbnail'
            : (isExtractedImg ? 'extracted' : 'favicon'),
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

/**
 * Find the dominant <img> element within rootElement.
 * An image is dominant if its width/height ratio vs rootElement is >= 75%/40%
 * (or 40%/75%) — same thresholds as dataExtractor.js getDominantMediaType().
 */
function getDominantImageElement(rootElement) {
  const root = rootElement || document.body;
  try {
    const rootRect = root.getBoundingClientRect();
    const coreW = rootRect.width;
    const coreH = rootRect.height;
    if (coreW <= 0 || coreH <= 0) return null;

    const imgs = Array.from(root.querySelectorAll('img'));
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      const mw = r.width || img.naturalWidth || 0;
      const mh = r.height || img.naturalHeight || 0;
      if (mw <= 0 || mh <= 0) continue;

      const wr = mw / coreW;
      const hr = mh / coreH;
      if ((wr >= 0.75 && hr >= 0.4) || (hr >= 0.75 && wr >= 0.4)) {
        return img;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Fetch an image URL and convert it to a clipboard-compatible PNG Blob.
 * Used by SNS contents and Image clipboard copy (Phase 19d+). Tries KickClip
 * image-proxy first (same-origin HTTPS, server-side upstream fetch), then
 * direct content-script fetch, then background fetch-image, with PNG/canvas
 * re-encode as needed for ClipboardItem.
 * Returns null if all paths fail.
 */
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

/**
 * Perform clipboard copy based on category. Returns success/fail info without
 * showing any Toast. Toast display is handled separately by the caller after
 * combining with save result.
 *
 * For 'Image' category: prefers binary copy via imageUrlToPngBlob on the saved
 *   img_url (e.g. Google image search /imgres original URL), then falls back
 *   to imgElementToBlob. Does NOT fall back to URL copy — returns { success: false }
 *   if both fail so the caller can decide how to communicate the failure.
 * For 'SNS' with confirmedType 'contents': tries binary copy from options.imageUrl
 *   (same URL as saved img_url); on failure falls back to URL plain text.
 * For other categories: copies the URL as plain text.
 */
async function performClipboardCopy(category, url, rootElementForDominant, options = {}) {
  const { confirmedType, imageUrl } = options;
  try {
    if (category === 'Image') {
      // Phase 19e: prefer URL-based fetch first. For Google image
      // search results, the saved img_url is the original-resolution
      // URL extracted from the /imgres anchor — fetching it directly
      // produces a much higher quality blob than the inline base64
      // thumbnail in the DOM <img>. For other Image clips, URL-based
      // fetch and DOM-based fetch produce the same result, so this
      // is a no-op.
      if (imageUrl) {
        try {
          const blob = await imageUrlToPngBlob(imageUrl);
          if (blob) {
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type]: blob })
            ]);
            return { success: true };
          }
        } catch (_) { /* fall through to DOM-based copy */ }
      }
      // DOM-based copy (existing behavior; fallback if URL fetch fails)
      const imgEl = getDominantImageElement(rootElementForDominant);
      if (imgEl) {
        const blob = await imgElementToBlob(imgEl);
        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);
          return { success: true };
        }
      }
      // Image binary copy failed — do not fall back to URL; caller will handle.
      return { success: false };
    }

    // SNS contents: try image binary copy via the saved img_url.
    // On failure, fall back to URL text (the post URL is still useful).
    if (category === 'SNS' && confirmedType === 'contents' && imageUrl) {
      try {
        const blob = await imageUrlToPngBlob(imageUrl);
        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);
          return { success: true };
        }
      } catch (_) { /* fall through to URL text */ }
      // Fall through: copy URL as text fallback
    }

    await navigator.clipboard.writeText(url);
    return { success: true };
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
                confirmedType: iframeRelayData.confirmedType || '',
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
          if (!e.data || !e.data[KC_MSG_PREFIX] || e.data[KC_SAVE_QUERY] !== true) return;
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

            // Signed-out users get clipboard-only treatment in the top frame
            // (Phase 2). Force success shutter here so the iframe's visual matches —
            // no userId/server check is meaningful when no save will be attempted.
            const saveShutterStatus = isSignedIn()
              ? await resolveSaveShutterStatus()
              : 'success';
            triggerShutterEffect('core', saveShutterStatus);

            // Mirror the top-frame Phase 10b behavior: set the per-item
            // status_badge text in this iframe so the user sees "Image clipped"
            // / "URL clipped" instead of the stale default. Each frame owns its
            // own badge element, so the top-frame's setCoreStatusBadgeText call
            // does NOT reach this iframe's UI. We only set success text on the
            // success path — failure ('error') would already have written
            // "Clip failed" via _coreBadgeFailedText through triggerShutterEffect.
            if (saveShutterStatus === 'success') {
              const iframeCategory = String(state.lastExtractedMetadata?.category || '').trim();
              const successText = iframeCategory === 'Image' ? 'Image clipped' : 'URL clipped';
              setCoreStatusBadgeText(successText);
            }
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
                confirmedType: String(meta?.confirmedType || '').trim(),
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

  window.addEventListener('scroll', async () => {
    const active = state.activeCoreItem;

    if (!active) return;
    // Compute current rect for the active CoreItem and pass it as rectOverride
    // so showCoreHighlight() treats this as a scroll update (isScrollUpdate = true).
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
        const ids = [
          'kickclip-highlight-overlay',
          'kickclip-status-badge-core',
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
  }
}

// === PHASE27B_REMOVED_GLOBAL ===
// window.__kcApplyCoreItem was an out-of-band activation entry
// point with no in-repo callers. It maintained its own copy of
// the URL gate and a divergent metadata path. Phase 27 removes
// it to keep activation flow in a single canonical place
// (updateCoreSelectionFromTarget).
// === END PHASE27B_REMOVED_GLOBAL ===

// Do not run in Electron-based desktop apps (e.g. Claude Desktop, VS Code, Notion).
// These apps embed a Chromium engine but are not regular browser tabs —
// KickClip should only operate in a real browser context.
const _isElectronApp = typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Electron');

if (!_isElectronApp) {
  checkKcUserAndInit();
}
