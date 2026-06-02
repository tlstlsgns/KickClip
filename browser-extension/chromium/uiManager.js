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
// === PHASE_BADGE_ANCHOR_OVERLAY ===
// Target viewport x of the badge's RIGHT edge (overlay right − inset), stored
// by positionCoreStatusBadgeToOverlay so setCoreStatusBadgeText can re-pin the
// right edge (via a viewport-coord left) when clip-time text changes the badge
// width — without depending on innerWidth or a fixed containing block.
let _badgeAnchorRightX = null;
// === END PHASE_BADGE_ANCHOR_OVERLAY ===
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

// === PHASE_BADGE_SHADOW_SEPARATE ===
// Status badge and metadata tooltip live in a SEPARATE shadow host so
// their compositor layer is independent of #kickclip-shadow-host's
// dynamic z-index (PHASE_OVERLAY_STACKING_ZINDEX in showCoreHighlight
// lowers the main host below sticky headers; the badge should stay on
// top regardless). The badge host's z-index is fixed at max and never
// modified at runtime.
const KC_BADGE_SHADOW_HOST_ID = 'kickclip-badge-shadow-host';
let _kcBadgeShadowRoot = null;

function getKCBadgeShadowRoot() {
  if (_kcBadgeShadowRoot) return _kcBadgeShadowRoot;

  let host = document.getElementById(KC_BADGE_SHADOW_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = KC_BADGE_SHADOW_HOST_ID;
    host.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 0',
      'height: 0',
      'pointer-events: none',
      'z-index: 2147483647',
    ].join(';');
    (document.body || document.documentElement).appendChild(host);
  }

  _kcBadgeShadowRoot = host.shadowRoot || host.attachShadow({ mode: 'closed' });

  try {
    if (_kcBadgeShadowRoot && !_kcBadgeShadowRoot.getElementById('kickclip-overlay-styles')) {
      const styleEl = buildOverlayStyleElement();
      if (styleEl) _kcBadgeShadowRoot.appendChild(styleEl);
    }
  } catch (_) {
    // defensive: style injection must not block badge creation
  }

  return _kcBadgeShadowRoot;
}

export function getKCBadgeShadowElement(id) {
  const root = getKCBadgeShadowRoot();
  return root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);
}
// === END PHASE_BADGE_SHADOW_SEPARATE ===

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
#kickclip-highlight-overlay {
  transition: box-shadow 0.15s ease, opacity 0.15s ease,
              top 0.05s ease, left 0.05s ease,
              width 0.05s ease, height 0.05s ease;
}
#kickclip-highlight-overlay.kickclip-default {
  box-shadow: 0 2px 12px 2px rgba(188, 19, 254, 0.40);
}
#kickclip-highlight-overlay.kickclip-default.kickclip-size-medium {
  box-shadow: 0 4px 24px 3px rgba(188, 19, 254, 0.50);
}
#kickclip-highlight-overlay.kickclip-default.kickclip-size-large {
  box-shadow: 0 6px 36px 5px rgba(188, 19, 254, 0.60);
}
#kickclip-highlight-overlay.kickclip-default.kickclip-clipped {
  box-shadow: 0 0 0 2px rgba(188, 19, 254, 1);
}

/* ── StatusBadge colors ── */
#kickclip-status-badge-core {
  background: ${BRAND.KEY_COLOR_HEX};
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

const GREEN_LAYER_ID = 'kickclip-green-candidate-layer';
const METADATA_TOOLTIP_ID = 'kickclip-metadata-tooltip';
const EVIDENCE_TYPE_INTERACTION = 'B';
const EVIDENCE_TYPE_IMAGE_ANCHOR = 'D';
// === TYPED_REDESIGN_PHASE20_TYPEE ===
const EVIDENCE_TYPE_E = 'E';
// === END TYPED_REDESIGN_PHASE20_TYPEE ===

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

// === PHASE_OVERLAY_STACKING_ZINDEX ===
// Compute the effective stacking z-index for an element by walking its
// ancestor chain (up to but not including document.body) and tracking
// the maximum positive explicit z-index. Negative z-indices are ignored
// — the overlay should not sink below page background. Returns 0 when
// no positive explicit z-index is found in the chain, meaning the
// overlay sits just above page normal flow (and below any sticky header
// that has its own positive z-index).
//
// Used by showCoreHighlight to sync the shadow host's z-index to the
// coreItem's stacking context so page chrome (sticky headers, modal
// shells, etc.) renders above the overlay when appropriate.
function computeStackingZIndexForElement(el) {
  if (!el || el.nodeType !== 1) return 0;
  let cur = el;
  let maxZ = -Infinity;
  let depth = 0;
  const maxDepth = 50; // defensive: avoid pathological deep trees
  while (cur && cur !== document.body && depth < maxDepth) {
    try {
      const cs = window.getComputedStyle?.(cur);
      if (cs) {
        const zStr = cs.zIndex;
        if (zStr && zStr !== 'auto') {
          const z = parseInt(zStr, 10);
          if (Number.isFinite(z) && z > maxZ) {
            maxZ = z;
          }
        }
      }
    } catch (e) {
      // defensive: getComputedStyle on disconnected nodes
    }
    cur = cur.parentElement;
    depth++;
  }
  return Number.isFinite(maxZ) && maxZ > 0 ? maxZ : 0;
}
// === END PHASE_OVERLAY_STACKING_ZINDEX ===

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
  // === PHASE_BADGE_SHADOW_SEPARATE ===
  let el = getKCBadgeShadowElement(CORE_BADGE_ID);
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
  getKCBadgeShadowRoot().appendChild(el);
  return el;
  // === END PHASE_BADGE_SHADOW_SEPARATE ===
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
 * "URL clipped"). Does not change overlay visual state — the thick
 * clipped ring is applied via markCoreHighlightClipped().
 */
export function setCoreStatusBadgeText(text) {
  try {
    const el = getKCBadgeShadowElement(CORE_BADGE_ID);
    if (!el) return;
    el.textContent = String(text || '');
    // === PHASE_BADGE_ANCHOR_OVERLAY ===
    // Width changed -> re-pin right edge (viewport left coord; no innerWidth /
    // containing-block dependency).
    _reanchorBadgeLeft();
    // === END PHASE_BADGE_ANCHOR_OVERLAY ===
  } catch (_) {}
}

export function showCoreStatusBadge(badgeState = 'default') {
  try {
    const el = ensureCoreBadge();
    el.textContent = _coreBadgeDefaultText;
    el.style.opacity = '1';
  } catch (e) {}
}

export function hideCoreStatusBadge() {
  try {
    const el = getKCBadgeShadowElement(CORE_BADGE_ID);
    if (el) {
      // Keep opacity transition for fade-out; disable only background transition for instant color reset
      el.style.transition = 'opacity 0.15s ease';
      el.style.opacity = '0';
      // Re-enable transition after reset so next show animates correctly
      requestAnimationFrame(() => {
        try { el.style.transition = ''; } catch (e) {}
      });
    }
  } catch (e) {}
}

// === PHASE_BADGE_ANCHOR_OVERLAY ===
// Bottom (viewport y) of the lowest TOP-ANCHORED fixed/sticky page chrome
// (e.g. a site header, possibly multi-row) covering column `x`, or 0 if none.
// Relies on our overlay/host/badge being pointer-events:none, so
// elementFromPoint returns page elements. Jumps from each chrome occluder's
// bottom (deterministic; clears tall/multi-row headers in a few hops).
// Occluder counts as chrome only if it (or an ancestor within 6 hops) is
// position:fixed|sticky AND is contiguous from the top — static content above
// the media, and non-top fixed elements (e.g. a right sidebar), are excluded.
function _topChromeBottomAt(x, coreItem) {
  const PAD = 8;
  const MAX_JUMPS = 8;
  const hostId = KC_SHADOW_HOST_ID;
  const isFixedOrSticky = (el) => {
    let cur = el, hops = 0;
    while (cur && cur.nodeType === 1 && hops < 6) {
      let pos = '';
      try { pos = getComputedStyle(cur).position; } catch (_) {}
      if (pos === 'fixed' || pos === 'sticky') return true;
      cur = cur.parentElement; hops++;
    }
    return false;
  };
  let y = 1;
  let bottom = 0;
  for (let i = 0; i < MAX_JUMPS; i++) {
    if (y < 0 || y > window.innerHeight) break;
    let topEl = null;
    try { topEl = document.elementFromPoint(x, y); } catch (_) { break; }
    if (!topEl) break;
    if (topEl.id === hostId) break; // our own UI (defensive; should be pointer-events:none)
    if (coreItem && (topEl === coreItem || coreItem.contains?.(topEl))) break; // reached the media
    if (!isFixedOrSticky(topEl)) break; // benign static content above the media
    const r = topEl.getBoundingClientRect?.();
    if (!r) break;
    if (r.top > bottom + PAD) break; // not contiguous from the top (e.g. side panel)
    const nb = Math.round(r.bottom);
    if (nb <= bottom) break; // no downward progress
    bottom = nb;
    y = nb + 1; // jump just below this chrome row and re-probe
  }
  return bottom;
}

// === PHASE_BADGE_ANCHOR_OVERLAY ===
// Re-pin the badge right edge to the last stored target x using a viewport
// left coordinate (right:auto). Called when text-only changes alter width.
function _reanchorBadgeLeft() {
  try {
    if (_badgeAnchorRightX == null) return;
    const el = getKCBadgeShadowElement(CORE_BADGE_ID);
    if (!el || el.style.opacity === '0') return;
    const PAD = 8;
    const w = el.getBoundingClientRect().width || 0;
    let left = Math.round(_badgeAnchorRightX - w);
    if (left < PAD) left = PAD;
    el.style.right = 'auto';
    el.style.left = `${left}px`;
  } catch (_) {}
}
// === END PHASE_BADGE_ANCHOR_OVERLAY ===

// Anchors the status_badge to the OUTER TOP-RIGHT of the overlay rect: badge
// right edge aligned to overlay right edge (inset), badge above the overlay's
// unoccluded visible top. If that top would be clipped above the visible
// region, the badge drops INTO the visible top instead (so it follows the
// overlay down as the overlay scrolls off the top behind page chrome).
export function positionCoreStatusBadgeToOverlay(overlayRect, coreItem) {
  try {
    const el = getKCBadgeShadowElement(CORE_BADGE_ID);
    if (!el || el.style.opacity === '0') return;
    if (!overlayRect || overlayRect.width <= 0 || overlayRect.height <= 0) return;
    const PAD = 8;
    const GAP = 6;
    const RIGHT_INSET = 2;
    const r = el.getBoundingClientRect();
    const badgeW = r.width || 0;
    const badgeH = r.height || 0;
    const probeX = Math.min(Math.round(overlayRect.right) - 1, window.innerWidth - PAD);
    const chromeBottom = _topChromeBottomAt(probeX, coreItem);
    const floor = chromeBottom > 0 ? chromeBottom + GAP : PAD;
    // === PHASE_BADGE_ANCHOR_OVERLAY ===
    // Horizontal: pin the badge RIGHT edge to the overlay right edge (minus
    // inset) using a VIEWPORT-coordinate left (right:auto) — the same model
    // the overlay uses (left + width) — so the badge aligns to the overlay
    // regardless of any fixed containing block on the page. _badgeAnchorRightX
    // is stored so setCoreStatusBadgeText can re-pin on text-width changes.
    const targetRightX = Math.min(Math.round(overlayRect.right) - RIGHT_INSET, window.innerWidth - PAD);
    _badgeAnchorRightX = targetRightX;
    let left = Math.round(targetRightX - badgeW);
    if (left < PAD) left = PAD;
    // === END PHASE_BADGE_ANCHOR_OVERLAY ===
    // Default: outer top-right, above the overlay. Clamp below top chrome /
    // viewport top so the badge is never hidden behind a fixed header; when
    // clamped it sits just inside the visible region and follows the overlay
    // down as it scrolls off the top.
    let top = Math.round(overlayRect.top - badgeH - GAP);
    if (top < floor) top = Math.round(floor);
    const maxTop = window.innerHeight - PAD - badgeH;
    if (top > maxTop) top = Math.round(Math.max(PAD, maxTop));
    el.style.right = 'auto';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  } catch (e) {}
}
// === END PHASE_BADGE_ANCHOR_OVERLAY ===

function ensureMetadataTooltip() {
  // === PHASE_BADGE_SHADOW_SEPARATE ===
  let el = getKCBadgeShadowElement(METADATA_TOOLTIP_ID);
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
  getKCBadgeShadowRoot().appendChild(el);
  return el;
  // === END PHASE_BADGE_SHADOW_SEPARATE ===
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
    const el = getKCBadgeShadowElement(METADATA_TOOLTIP_ID);
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
    const el = getKCBadgeShadowElement(METADATA_TOOLTIP_ID);
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
  const el = getKCBadgeShadowElement(METADATA_TOOLTIP_ID);
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
    // === PHASE_OVERLAY_STACKING_ZINDEX ===
    // Sync the shadow host's z-index to coreItem's effective stacking
    // context (max positive z-index in its ancestor chain, or 0 if none).
    // Page chrome with higher explicit z-index (e.g. sticky headers
    // typically at 100–9999) then renders above the overlay naturally,
    // instead of being painted over by the host's previous near-max
    // z-index. Applied to the host element only — the badge and
    // overlay div retain their relative z-indices within the shadow.
    try {
      const host = document.getElementById(KC_SHADOW_HOST_ID);
      if (host) {
        const targetZ = computeStackingZIndexForElement(coreItem);
        host.style.zIndex = String(targetZ + 1);
      }
    } catch (e) {
      // defensive: never let stacking sync block the highlight
    }
    // === END PHASE_OVERLAY_STACKING_ZINDEX ===
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
    // === PHASE_BADGE_ANCHOR_OVERLAY ===
    showCoreStatusBadge('default');
    // Anchor badge to the overlay's outer top-right (occlusion-aware), using
    // the same rect `r` that positioned the overlay. Runs on every overlay
    // (re)position: activation, scroll watcher, ResizeObserver, hover gate.
    positionCoreStatusBadgeToOverlay(r, coreItem);
    // === END PHASE_BADGE_ANCHOR_OVERLAY ===

    const isScrollUpdate = rectOverride !== null && !forceRestart;

    if (!isScrollUpdate) {
      // Reset clipped ring immediately (no transition) before applying new state.
      // Handles adjacent CoreItem hover where hideCoreHighlight() is not called.
      overlay.classList.remove('kickclip-clipped');
      // Phase 17: classify element by size (sqrt(area) — equivalent
      // square side length) and apply the matching size class. The
      // CSS scales box-shadow blur/spread so larger elements get more
      // visually prominent hover feedback.
      const sizeMetric = Math.sqrt(r.width * r.height);
      overlay.classList.remove(
        'kickclip-size-small',
        'kickclip-size-medium',
        'kickclip-size-large'
      );
      if (sizeMetric < 400) {
        overlay.classList.add('kickclip-size-small');
      } else if (sizeMetric < 700) {
        overlay.classList.add('kickclip-size-medium');
      } else {
        overlay.classList.add('kickclip-size-large');
      }
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
    overlay.classList.remove('kickclip-clipped');
    _activeCoreHighlightItem = null;
  }
  hideCoreStatusBadge();
}

// === PHASE_OVERLAY_LIFECYCLE_DECOUPLING ===
// Returns true when the CoreHighlight overlay is currently shown
// (showCoreHighlight succeeded most recently and no hideCoreHighlight
// has cleared it since). Used by the clip gate in coreEntry's
// saveActiveCoreItem to refuse clipping when the pointer is outside
// the overlay region (overlay/tooltip hidden but activeCoreItem still
// alive).
export function isCoreHighlightShown() {
  return _activeCoreHighlightItem != null;
}
// === END PHASE_OVERLAY_LIFECYCLE_DECOUPLING ===

// === PHASE_SHUTTER_REMOVAL ===
// Apply the "clipped" visual state to the active core highlight overlay.
// This is the thick purple ring that signals clipboard success. Called
// from the badge IIFE in saveActiveCoreItem after navigator.clipboard.write
// resolves successfully. Idempotent — re-applying does nothing.
//
// The class is cleared by the next hover cycle via showCoreHighlight's
// existing class-reset logic. No explicit clear needed in normal flow.
export function markCoreHighlightClipped() {
  try {
    const overlay = getKCShadowElement(PURPLE_OVERLAY_ID);
    if (!overlay) return;
    overlay.classList.add('kickclip-clipped');
  } catch (e) {}
}
// === END PHASE_SHUTTER_REMOVAL ===

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
      // === TYPED_PHASE20_RENDERER START ===
      // Phase 20 image-first Type D system uses similarityType 'typeD-image-first'.
      // Render those with black outline to distinguish from legacy Type D (orange).
      const isPhase20TypeD = item?.similarityType === 'typeD-image-first';
      const color =
        item?.evidenceType === EVIDENCE_TYPE_INTERACTION   ? 'red'     :
        item?.evidenceType === EVIDENCE_TYPE_IMAGE_ANCHOR ?
          (isPhase20TypeD ? '#3B82F6' : '#FFA500') :
        // === TYPED_REDESIGN_PHASE20_TYPEE — yellow for Type E fallback ===
        item?.evidenceType === EVIDENCE_TYPE_E             ? '#FACC15' :
        // === END TYPED_REDESIGN_PHASE20_TYPEE ===
        'green';
      // === TYPED_PHASE20_RENDERER END ===
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
