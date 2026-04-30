/**
 * UI highlight and tooltip DOM logic.
 * Handles purple highlight, green candidate outlines, metadata tooltip, and core selection.
 */

import { state } from './stateLite.js';
import { BRAND } from './brandConfig.js';

const PURPLE_OVERLAY_ID = 'kickclip-highlight-overlay';
const CORE_BADGE_ID = 'kickclip-status-badge-core';
// Externally-registered status_badge texts. Set once at content-script
// init (and refreshed if the keyboard shortcut changes). Keeps text
// decisions out of uiManager — text composition (which depends on
// platform-specific shortcut formatting) lives in coreEntry.
let _coreBadgeDefaultText = '';
let _coreBadgeFailedText = '';

// ── Debug flag ────────────────────────────────────────────────────────────
// Set to true to show ItemMap candidate outlines (green/red/blue) for debugging.
// Set to false to disable all debug outlines in production.
const ITEMMAP_DEBUG_OUTLINES = false;

let _activeCoreHighlightItem = null; // tracks which coreItem is currently highlighted

// ─────────────────────────────────────────────────────────────────────────
// Shadow DOM host — single isolation boundary for all injected UI
// ─────────────────────────────────────────────────────────────────────────
//
// All KickClip UI (highlights, badges, tooltips, etc.) will live inside a
// Shadow DOM attached to a single host element on the page. This isolates
// our styles from the hosting page's CSS (e.g. flaticon.com's global
// `body > * { width: 100% }` rule that was stretching our badge to the
// full viewport width).
//
// The host is a minimal <div id="kickclip-shadow-host"> appended to document.body.
// Only this empty host is exposed to page CSS; everything meaningful lives
// inside the closed shadow root and is unreachable from page scripts.
//
// NOTE: As of this phase (Phase 2), the shadow root is created but empty.
// UI elements are still rendered in document.body. Migration happens in Phase 3.

const KC_SHADOW_HOST_ID = 'kickclip-shadow-host';
let _kcShadowRoot = null;

/**
 * Returns the KickClip shadow root, creating the host + shadow if needed.
 * Idempotent — safe to call multiple times.
 *
 * The host element itself uses fixed positioning with zero size and
 * pointer-events: none, so it cannot affect page layout or intercept clicks.
 * Child elements inside the shadow root handle their own positioning and
 * pointer events as needed.
 */
export function getKCShadowRoot() {
  if (_kcShadowRoot) return _kcShadowRoot;

  let host = document.getElementById(KC_SHADOW_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = KC_SHADOW_HOST_ID;
    // The host itself is invisible and non-interactive. Inner children
    // restore pointer-events when needed (e.g. tooltips, highlights).
    host.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 0',
      'height: 0',
      'pointer-events: none',
      'z-index: 2147483647',
    ].join(';');
    // Append to body if available, else documentElement (edge cases where
    // body is replaced by the page).
    (document.body || document.documentElement).appendChild(host);
  }

  _kcShadowRoot = host.shadowRoot || host.attachShadow({ mode: 'closed' });
  return _kcShadowRoot;
}

/**
 * Lookup an element by id inside the KickClip shadow root.
 * Returns null if not found.
 */
export function getKCShadowElement(id) {
  const root = getKCShadowRoot();
  return root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);
}

/**
 * Look up an element by id, searching the shadow root first, then document.body.
 * Used by UI functions during the Phase 3 migration when some elements have
 * moved into the shadow root and others are still in document.body. Once the
 * migration is complete, callers that should only find shadow elements can
 * switch to using getKCShadowElement directly.
 */
export function findKCElement(id) {
  const fromShadow = getKCShadowElement(id);
  if (fromShadow) return fromShadow;
  return document.getElementById(id);
}

/**
 * Build a fresh <style> element with the overlay CSS. A new element is
 * returned each call so it can be independently appended to the head AND
 * to the shadow root (a DOM node can only have one parent).
 */
function buildOverlayStyleElement() {
  const style = document.createElement('style');
  style.id = 'kickclip-overlay-styles';
  style.textContent = `
#kickclip-highlight-overlay.kickclip-default {
  box-shadow: 0 2px 8px rgba(188, 19, 254, 0.25);
}
#kickclip-highlight-overlay.kickclip-default.shutter-success {
  box-shadow: 0 0 0 2px rgba(188, 19, 254, 1);
}
/* shutter-error: no override — falls through to .kickclip-default */

/* ── StatusBadge colors ── */
#kickclip-status-badge-core {
  background: ${BRAND.KEY_COLOR_HEX};
}
#kickclip-status-badge-core.shutter-error {
  background: rgb(239, 68, 68);
}

`;
  return style;
}

function injectKickClipOverlayStyles() {
  // All KickClip UI lives inside the shadow root, so the stylesheet is
  // injected only there. The head-injected copy from earlier migration
  // phases has been removed now that no UI elements render in document.body.
  try {
    const shadowRoot = getKCShadowRoot();
    // Guard: shadow root may not be ready in early edge cases.
    if (shadowRoot && !shadowRoot.getElementById('kickclip-overlay-styles')) {
      const shadowStyle = buildOverlayStyleElement();
      shadowRoot.appendChild(shadowStyle);
    }
  } catch (_) { /* shadow root unavailable — silent */ }
}

injectKickClipOverlayStyles();

/**
 * Update CoreHighlight class only — no position or opacity change.
 * Sync the status_badge to match the shutter state:
 *   - 'success' → success class only (TEXT NOT SET HERE — caller invokes
 *                 setCoreStatusBadgeText with category-aware wording).
 *   - 'error'   → error class + registered failed text.
 *   - 'none'    → no class + registered default text.
 * Used for: shutter feedback, hover restore.
 */
export function updateCoreHighlightClass(isSaved, shutterState = 'none', forceReplace = false) {
  try {
    const overlay = getKCShadowElement(PURPLE_OVERLAY_ID);
    if (!overlay) return;
    if (!forceReplace && shutterState === 'none' &&
        (overlay.classList.contains('shutter-success') ||
         overlay.classList.contains('shutter-error'))) return;
    overlay.classList.remove('shutter-success', 'shutter-error');
    if (shutterState === 'success') overlay.classList.add('shutter-success');
    else if (shutterState === 'error') overlay.classList.add('shutter-error');

    // Sync core status badge
    const coreBadge = getKCShadowElement(CORE_BADGE_ID);
    if (!coreBadge) return;
    coreBadge.style.transition = '';
    coreBadge.classList.remove('shutter-success', 'shutter-error');
    coreBadge.style.background = '';
    if (shutterState === 'success') {
      coreBadge.classList.add('shutter-success');
      // Text intentionally NOT set here — caller (coreEntry) invokes
      // setCoreStatusBadgeText with category-aware wording.
    } else if (shutterState === 'error') {
      coreBadge.classList.add('shutter-error');
      coreBadge.textContent = _coreBadgeFailedText;
    } else {
      coreBadge.textContent = _coreBadgeDefaultText;
    }
  } catch (e) {}
}

const GREEN_LAYER_ID = 'kickclip-green-candidate-layer';
const METADATA_TOOLTIP_ID = 'kickclip-metadata-tooltip';
const EVIDENCE_TYPE_INTERACTION = 'B';
const EVIDENCE_TYPE_C = 'C';

let greenOutlinedElements = new Set();

function normalizeText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function formatPlatformLabel(platform) {
  const key = normalizeText(platform || '').toUpperCase();
  if (!key) return '';
  switch (key) {
    case 'X_TWITTER':
      return 'X/Twitter';
    default:
      return key
        .split('_')
        .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
        .join(' ');
  }
}

function ensurePurpleOverlay() {
  injectKickClipOverlayStyles();
  let el = getKCShadowElement(PURPLE_OVERLAY_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = PURPLE_OVERLAY_ID;
  el.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483646;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    border-radius: 8px;
    box-sizing: border-box;
    overflow: visible;
    transition: top 0.05s ease, left 0.05s ease, width 0.05s ease, height 0.05s ease, box-shadow 0.15s ease, opacity 0.15s ease;
    display: block;
    opacity: 0;
  `;
  el.classList.add('kickclip-default');
  getKCShadowRoot().appendChild(el);
  return el;
}

function ensureCoreBadge() {
  let el = getKCShadowElement(CORE_BADGE_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = CORE_BADGE_ID;
  el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      font-size: 11px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.02em;
      opacity: 0;
      transition: background 0.15s ease, opacity 0.15s ease;
      color: #fff;
      top: 0;
      left: 0;
    `;
  getKCShadowRoot().appendChild(el);
  return el;
}

/**
 * Register the status_badge texts used for non-success states.
 * Called by coreEntry at init (and on shortcut change) so the badge's
 * 'default' (hover) and 'error' (clip failure) states render with
 * consistent, platform-correct wording without uiManager knowing
 * anything about clipboard semantics or platform glyphs.
 *
 * Success text (e.g. "Image clipped" / "URL clipped") is NOT registered
 * here because it depends on the per-item category, which is only
 * known at clip time — use setCoreStatusBadgeText() instead at that
 * moment.
 */
export function setCoreBadgeTexts({ defaultText, failedText } = {}) {
  if (typeof defaultText === 'string') _coreBadgeDefaultText = defaultText;
  if (typeof failedText === 'string') _coreBadgeFailedText = failedText;
}

/**
 * Imperatively set the status_badge text. Used by coreEntry after a
 * successful clip to render category-aware text ("Image clipped" /
 * "URL clipped"). Does not change visual state classes
 * (shutter-success / shutter-error) — those are still driven by
 * triggerShutterEffect.
 */
export function setCoreStatusBadgeText(text) {
  try {
    const el = getKCShadowElement(CORE_BADGE_ID);
    if (!el) return;
    el.textContent = String(text || '');
  } catch (_) {}
}

export function showCoreStatusBadge(badgeState = 'default') {
  try {
    const el = ensureCoreBadge();
    el.classList.remove('shutter-success', 'shutter-error');
    if (badgeState === 'success') {
      el.classList.add('shutter-success');
      // Text set by caller via setCoreStatusBadgeText.
    } else if (badgeState === 'error') {
      el.textContent = _coreBadgeFailedText;
      el.classList.add('shutter-error');
    } else {
      el.textContent = _coreBadgeDefaultText;
    }
    el.style.background = '';
    el.style.opacity = '1';
  } catch (e) {}
}

export function hideCoreStatusBadge() {
  try {
    const el = getKCShadowElement(CORE_BADGE_ID);
    if (el) {
      // Keep opacity transition for fade-out; disable only background transition for instant color reset
      el.style.transition = 'opacity 0.15s ease';
      el.style.opacity = '0';
      el.classList.remove('shutter-success', 'shutter-error');
      el.style.background = '';
      // Re-enable transition after reset so next show animates correctly
      requestAnimationFrame(() => {
        try { el.style.transition = ''; } catch (e) {}
      });
    }
  } catch (e) {}
}

export function positionCoreStatusBadge(clientX, clientY) {
  try {
    const el = getKCShadowElement(CORE_BADGE_ID);
    if (!el || el.style.opacity === '0') return;
    const x = Number(clientX);
    const y = Number(clientY);
    if (!isFinite(x) || !isFinite(y)) return;
    const pad = 12;
    const offset = 14;
    const r = el.getBoundingClientRect();
    let left = x + offset;
    let top = y + offset;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, x - r.width - offset);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, y - r.height - offset);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  } catch (e) {}
}

function ensureMetadataTooltip() {
  let el = getKCShadowElement(METADATA_TOOLTIP_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = METADATA_TOOLTIP_ID;
  el.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    top: 0;
    left: 0;
    width: 280px;
    max-width: min(320px, 70vw);
    border: 1px solid var(--kc-accent, ${BRAND.KEY_COLOR_HEX});
    background: rgba(var(--kc-accent-rgb, 188, 19, 254), 0.70);
    color: #fff;
    border-radius: 10px;
    box-sizing: border-box;
    padding: 8px;
    backdrop-filter: blur(2px);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
    display: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  el.innerHTML = `
    <div data-kc-tooltip-image-wrap style="width:100%;height:96px;border-radius:8px;overflow:hidden;background:rgba(255,255,255,0.18);display:flex;align-items:center;justify-content:center;">
      <img data-kc-tooltip-image alt="" style="display:none;width:100%;height:100%;object-fit:cover;" />
      <div data-kc-tooltip-image-placeholder style="font-size:12px;opacity:0.9;">No Image Found</div>
    </div>
    <div data-kc-tooltip-title style="margin-top:8px;font-size:13px;line-height:1.35;font-weight:600;max-height:3.9em;overflow:hidden;word-break:break-word;"></div>
    <div data-kc-tooltip-shortcode style="margin-top:6px;font-size:11px;line-height:1.35;opacity:0.95;display:none;"></div>
    <div data-kc-tooltip-category style="margin-top:6px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;opacity:0.75;display:none;"></div>
    <div data-kc-tooltip-url style="margin-top:6px;font-size:11px;line-height:1.35;opacity:0.95;max-height:2.8em;overflow:hidden;word-break:break-all;"></div>
    <div data-kc-tooltip-ai style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.25);display:none;">
      <div data-kc-tooltip-ai-type style="font-size:11px;font-weight:700;opacity:0.85;letter-spacing:0.03em;text-transform:uppercase;"></div>
      <div data-kc-tooltip-ai-summary style="margin-top:3px;font-size:11px;line-height:1.45;opacity:0.90;word-break:break-word;"></div>
    </div>
  `;
  getKCShadowRoot().appendChild(el);
  return el;
}

function setMetadataTooltipContent(meta) {
  const el = ensureMetadataTooltip();
  const titleEl = el.querySelector('[data-kc-tooltip-title]');
  const shortcodeEl = el.querySelector('[data-kc-tooltip-shortcode]');
  const categoryEl = el.querySelector('[data-kc-tooltip-category]');
  const urlEl = el.querySelector('[data-kc-tooltip-url]');
  const imgEl = el.querySelector('[data-kc-tooltip-image]');
  const phEl = el.querySelector('[data-kc-tooltip-image-placeholder]');

  const title = normalizeText(meta?.title || '') || '(No title)';
  const shortcode = normalizeText(meta?.shortcode || '');
  const platform = formatPlatformLabel(meta?.platform || '');
  const url = normalizeText(meta?.activeHoverUrl || '') || '(No url)';
  if (titleEl) titleEl.textContent = title;
  if (shortcodeEl) {
    if (shortcode) {
      shortcodeEl.textContent = platform ? `Source: ${platform} | ID: ${shortcode}` : `ID: ${shortcode}`;
      shortcodeEl.style.display = 'block';
    } else {
      shortcodeEl.textContent = '';
      shortcodeEl.style.display = 'none';
    }
  }
  const category = normalizeText(meta?.category || '');
  if (categoryEl) {
    if (category) {
      categoryEl.textContent = category;
      categoryEl.style.display = 'block';
    } else {
      categoryEl.textContent = '';
      categoryEl.style.display = 'none';
    }
  }
  if (urlEl) urlEl.textContent = url;

  const imageUrl = String(meta?.image?.url || '').trim();
  if (imgEl && phEl) {
    if (imageUrl) {
      imgEl.src = imageUrl;
      imgEl.style.display = 'block';
      phEl.style.display = 'none';
    } else {
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
      phEl.style.display = 'block';
    }
  }
}

export function setAiTooltipContent({ type, summary }) {
  try {
    const el = getKCShadowElement(METADATA_TOOLTIP_ID);
    if (!el) return;
    const aiWrap = el.querySelector('[data-kc-tooltip-ai]');
    const typeEl = el.querySelector('[data-kc-tooltip-ai-type]');
    const summaryEl = el.querySelector('[data-kc-tooltip-ai-summary]');
    if (!aiWrap || !typeEl || !summaryEl) return;
    typeEl.textContent = type ? `⬩ ${type}` : '';
    summaryEl.textContent = summary || '';
    aiWrap.style.display = (type || summary) ? 'block' : 'none';
  } catch (e) {}
}

export function clearAiTooltipContent() {
  try {
    const el = getKCShadowElement(METADATA_TOOLTIP_ID);
    if (!el) return;
    const aiWrap = el.querySelector('[data-kc-tooltip-ai]');
    const typeEl = el.querySelector('[data-kc-tooltip-ai-type]');
    const summaryEl = el.querySelector('[data-kc-tooltip-ai-summary]');
    if (!aiWrap || !typeEl || !summaryEl) return;
    typeEl.textContent = '';
    summaryEl.textContent = 'Analyzing...';
    aiWrap.style.display = 'block';
  } catch (e) {}
}

export function positionMetadataTooltip(clientX, clientY) {
  try {
    const el = ensureMetadataTooltip();
    const x = Number(clientX);
    const y = Number(clientY);
    if (!isFinite(x) || !isFinite(y)) return false;
    const pad = 12;
    const offset = 14;
    const r = el.getBoundingClientRect();
    let left = x + offset;
    let top = y + offset;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, x - r.width - offset);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, y - r.height - offset);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    return true;
  } catch (e) {
    return false;
  }
}

export function showMetadataTooltip(meta, clientX = null, clientY = null) {
  try {
    if (!meta || typeof meta !== 'object') return false;
    setMetadataTooltipContent(meta);
    const el = ensureMetadataTooltip();
    el.style.display = 'block';
    if (isFinite(Number(clientX)) && isFinite(Number(clientY))) {
      positionMetadataTooltip(clientX, clientY);
    }
    return true;
  } catch (e) {
    return false;
  }
}

export function hideMetadataTooltip() {
  const el = getKCShadowElement(METADATA_TOOLTIP_ID);
  if (el) el.style.display = 'none';
}

/**
 * Show CoreHighlight overlay on a CoreItem.
 * Handles position, opacity, class, and border animation.
 */
export function showCoreHighlight(coreItem, isSaved = false, rectOverride = null, forceRestart = false) {
  try {
    const r = rectOverride ?? (coreItem?.getBoundingClientRect?.());
    if (!r || r.width <= 0 || r.height <= 0) return false;
    const overlay = ensurePurpleOverlay();

    const isHidden = overlay.style.opacity !== '1';
    if (isHidden) {
      overlay.style.transition = 'none';
      overlay.style.top = `${r.top}px`;
      overlay.style.left = `${r.left}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
      overlay.style.borderRadius = '8px';
      void overlay.offsetHeight;
      overlay.style.transition = '';
    } else {
      overlay.style.top = `${r.top}px`;
      overlay.style.left = `${r.left}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
      overlay.style.borderRadius = '8px';
    }

    overlay.style.opacity = '1';
    showCoreStatusBadge('default');

    const isScrollUpdate = rectOverride !== null && !forceRestart;

    if (!isScrollUpdate) {
      // Reset shutter classes immediately (no transition) before applying new state.
      // Handles adjacent CoreItem hover where hideCoreHighlight() is not called.
      const coreBadge = getKCShadowElement(CORE_BADGE_ID);
      overlay.classList.remove('shutter-success', 'shutter-error');
      if (coreBadge) {
        coreBadge.style.transition = 'none';
        coreBadge.classList.remove('shutter-success', 'shutter-error');
        coreBadge.style.background = '';
        requestAnimationFrame(() => {
          try { coreBadge.style.transition = ''; } catch (e) {}
        });
      }
      updateCoreHighlightClass(false);
    }
    _activeCoreHighlightItem = coreItem;
    return true;
  } catch (e) {
    return false;
  }
}

export function hideCoreHighlight() {
  const overlay = getKCShadowElement(PURPLE_OVERLAY_ID);
  if (overlay) {
    overlay.style.opacity = '0';
    // Reset shutter classes immediately — no transition on reset
    overlay.classList.remove('shutter-success', 'shutter-error');
    _activeCoreHighlightItem = null;
  }
  hideCoreStatusBadge();
}

/**
 * Save confirmation “shutter”: status tint (green/red) on the core or full-page overlay.
 * @param {'core'|'page'} type
 * @param {'success'|'error'} status — from login + local server precheck
 */
export function triggerShutterEffect(type, status = 'error') {
  try {
    const shutterState = status === 'success' ? 'success' : 'error';
    if (type === 'core') {
      updateCoreHighlightClass(false, shutterState);
      return;
    }
  } catch (e) {}
}

function ensureGreenLayer() {
  let layer = getKCShadowElement(GREEN_LAYER_ID);
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = GREEN_LAYER_ID;
  layer.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    display: none;
  `;
  getKCShadowRoot().appendChild(layer);
  return layer;
}

export function renderItemMapCandidates(candidates) {
  ensureGreenLayer();
  for (const prev of greenOutlinedElements) {
    try {
      prev.style.removeProperty('outline');
      prev.style.removeProperty('outline-offset');
    } catch (e) {}
  }
  greenOutlinedElements = new Set();
  if (!ITEMMAP_DEBUG_OUTLINES) return;
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  for (const item of candidates) {
    const el = item?.element;
    if (!el) continue;
    try {
      const color =
        item?.evidenceType === EVIDENCE_TYPE_C           ? '#1a73e8' :
        item?.evidenceType === EVIDENCE_TYPE_INTERACTION ? 'red'     :
        'green';
      el.style.setProperty('outline', `2px solid ${color}`, 'important');
      el.style.setProperty('outline-offset', '-2px', 'important');
      greenOutlinedElements.add(el);
    } catch (e) {}
  }
}

export const showGreenCandidateOutline = renderItemMapCandidates;

export function clearCoreSelection() {
  state.activeCoreItem = null;
  state.activeHoverUrl = null;
  state.lastExtractedMetadata = null;
  hideCoreHighlight();
  hideMetadataTooltip();
}
