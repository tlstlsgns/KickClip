/**
 * Data extraction and metadata logic for core items.
 * Handles URL resolution, title/image extraction, and Type A core item resolution.
 */

import { getOriginalUrl, resolveCached, cleanTrackingParams, isNavigationUrl, getUrlIntent } from './urlResolver.js';
import { findDominantImagesInElement } from './itemDetector.js';

let lastExtractionLog = '';
let extractionLogShortcutInstalled = false;

function ensureExtractionLogShortcut() {
  try {
    if (extractionLogShortcutInstalled) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    extractionLogShortcutInstalled = true;
    window.addEventListener('keydown', async (event) => {
      try {
        const isCopyCombo = (event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyY';
        if (!isCopyCombo) return;
        event.preventDefault();
        const logText = String(lastExtractionLog || '').trim();
        if (!logText) return;
        if (!navigator?.clipboard?.writeText) return;
        await navigator.clipboard.writeText(logText);
      } catch (e) {}
    }, { capture: true });
  } catch (e) {}
}

function normalizeText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function getRootFontSizePx() {
  try {
    const root = document.documentElement;
    const cs = root && window.getComputedStyle ? window.getComputedStyle(root) : null;
    const px = parseFloat(String(cs?.fontSize || '16'));
    return isFinite(px) && px > 0 ? px : 16;
  } catch (e) {
    return 16;
  }
}

function hasBrSibling(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1) return false;
    const parent = anchor.parentElement;
    if (!parent || !parent.children) return false;
    for (const child of Array.from(parent.children)) {
      if (!child || child === anchor) continue;
      if (String(child.tagName || '').toUpperCase() === 'BR') return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function isEmptyAnchor(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1) return true;
    const text = normalizeText(anchor.innerText || anchor.textContent || '');
    if (text.length > 0) return false;

    const descendants = Array.from(anchor.querySelectorAll?.('*') || []);
    if (descendants.length === 0) return true;

    for (const node of descendants) {
      if (!node || node.nodeType !== 1) continue;
      const cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) continue;
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0) return false;
    }
    return true;
  } catch (e) {
    return true;
  }
}

function isInlineAnchor(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1) return false;
    const parent = anchor.parentElement;
    if (!parent || !parent.childNodes) return false;
    for (const node of Array.from(parent.childNodes)) {
      if (!node || node === anchor) continue;
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const txt = normalizeText(node.textContent || '');
      if (txt.length > 0) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function getRectIntersection(a, b) {
  try {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (left >= right || top >= bottom) return null;
    const width = right - left;
    const height = bottom - top;
    return { left, top, right, bottom, width, height, area: width * height };
  } catch (e) {
    return null;
  }
}

function isClippedByAncestors(anchor, anchorRect, maxLevels = 4) {
  try {
    if (!anchor || !anchorRect || !anchor.getBoundingClientRect) return false;
    const anchorArea = Math.max(0, anchorRect.width) * Math.max(0, anchorRect.height);
    if (anchorArea <= 0) return true;
    let visibleRect = {
      left: anchorRect.left,
      top: anchorRect.top,
      right: anchorRect.right,
      bottom: anchorRect.bottom,
      width: anchorRect.width,
      height: anchorRect.height,
    };
    let parent = anchor.parentElement;
    let level = 0;
    while (parent && level < maxLevels) {
      level += 1;
      const pCs = window.getComputedStyle ? window.getComputedStyle(parent) : null;
      if (!pCs) {
        parent = parent.parentElement;
        continue;
      }
      // If any ancestor is display:none or visibility:hidden, the anchor
      // is not visible regardless of overflow — treat as fully clipped.
      if (pCs.display === 'none' || pCs.visibility === 'hidden') return true;
      const overflow = String(pCs.overflow || '').toLowerCase();
      const overflowX = String(pCs.overflowX || overflow || '').toLowerCase();
      const overflowY = String(pCs.overflowY || overflow || '').toLowerCase();
      const isStrictClip = overflow === 'hidden' || overflowX === 'hidden' || overflowY === 'hidden';
      if (!isStrictClip) {
        parent = parent.parentElement;
        continue;
      }
      const parentRect = parent.getBoundingClientRect?.();
      if (!parentRect) {
        parent = parent.parentElement;
        continue;
      }
      const intersection = getRectIntersection(visibleRect, parentRect);
      if (!intersection || intersection.area <= 0) return true;
      if (intersection.area / anchorArea < 0.1) return true;
      visibleRect = intersection;
      parent = parent.parentElement;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function isEmptyOverlayAnchor(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1) return false;
    const text = normalizeText(anchor.innerText || anchor.textContent || '');
    if (text.length > 0) return false;
    const mediaChildren = anchor.querySelectorAll?.('img, svg, picture, video, canvas') || [];
    if (mediaChildren.length > 0) return false;
    const allChildren = anchor.querySelectorAll?.('*') || [];
    if (allChildren.length > 0) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function isPseudoElementOverlay(anchor, minSize) {
  try {
    if (!anchor || !anchor.parentElement || !window.getComputedStyle) return false;
    const parent = anchor.parentElement;
    const pCs = window.getComputedStyle(parent);
    if (pCs && (pCs.display === 'none' || pCs.visibility === 'hidden')) return false;
    const pr = parent.getBoundingClientRect?.();
    if (!pr || pr.width < minSize || pr.height < minSize) return false;
    const parentPos = String(pCs?.position || '').toLowerCase();
    if (parentPos !== 'relative' && parentPos !== 'absolute' && parentPos !== 'fixed') return false;

    const checkPseudo = (pseudo) => {
      try {
        const ps = window.getComputedStyle(anchor, pseudo);
        if (!ps) return false;
        const content = String(ps.content || '').toLowerCase().trim();
        if (content === 'none' || content === 'normal') return false;
        const pos = String(ps.position || '').toLowerCase();
        if (pos !== 'absolute' && pos !== 'fixed') return false;
        const inset = String(ps.inset || '').trim().toLowerCase();
        const hasInsetZero = inset === '0' || inset === '0px' || inset === '0px 0px 0px 0px';
        const top = parseFloat(ps.top || '0');
        const left = parseFloat(ps.left || '0');
        const right = parseFloat(ps.right || '0');
        const bottom = parseFloat(ps.bottom || '0');
        const hasCovering =
          hasInsetZero ||
          (top === 0 && left === 0 && (right === 0 || bottom === 0)) ||
          (ps.width === '100%' || ps.height === '100%');
        return hasCovering;
      } catch (e) {
        return false;
      }
    };

    return checkPseudo('::after') || checkPseudo('::before');
  } catch (e) {
    return false;
  }
}

function isOverlayCoveringSizedParent(anchor, minSize) {
  try {
    if (!anchor || !anchor.parentElement) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(anchor) : null;
    if (!cs) return false;
    const pos = String(cs.position || '').toLowerCase();
    if (pos !== 'absolute' && pos !== 'fixed') return false;
    const parent = anchor.parentElement;
    const pCs = window.getComputedStyle ? window.getComputedStyle(parent) : null;
    if (pCs && (pCs.display === 'none' || pCs.visibility === 'hidden')) return false;
    const pr = parent.getBoundingClientRect?.();
    if (!pr || pr.width < minSize || pr.height < minSize) return false;
    const inset = String(cs.inset || '').trim().toLowerCase();
    const hasInsetZero = inset === '0' || inset === '0px' || inset === '0px 0px 0px 0px';
    const top = parseFloat(cs.top || '0');
    const left = parseFloat(cs.left || '0');
    const right = parseFloat(cs.right || '0');
    const bottom = parseFloat(cs.bottom || '0');
    const hasCoveringPosition =
      hasInsetZero ||
      (top === 0 && left === 0 && (right === 0 || bottom === 0)) ||
      (top === 0 && left === 0 && (cs.width === '100%' || cs.height === '100%'));
    if (!hasCoveringPosition) {
      const r = anchor.getBoundingClientRect?.();
      if (r && pr) {
        const inter = getRectIntersection(r, pr);
        if (inter && inter.area > 0 && pr.width * pr.height > 0) {
          const coverRatio = inter.area / (pr.width * pr.height);
          if (coverRatio >= 0.8) return true;
        }
      }
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

export function isVisuallySignificant(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1 || !anchor.isConnected) return true;
    const cs = window.getComputedStyle ? window.getComputedStyle(anchor) : null;
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    const parent = anchor.parentElement;
    if (parent) {
      const pCs = window.getComputedStyle ? window.getComputedStyle(parent) : null;
      if (pCs && (pCs.display === 'none' || pCs.visibility === 'hidden')) return false;
    }
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    if (!r) return true;

    // Simplified: any anchor with non-zero renderable area is visually significant
    if (r.width > 0.1 && r.height > 0.1) {
      if (isClippedByAncestors(anchor, r, 4)) return false;
      return true;
    }

    // Fallback: anchor's own rect is 0 but ::after/::before covers a sized parent
    if (isPseudoElementOverlay(anchor, 1)) {
      const effectiveRect = parent?.getBoundingClientRect?.() || r;
      if (isClippedByAncestors(anchor, effectiveRect, 4)) return false;
      return true;
    }

    return false;
  } catch (e) {
    return true;
  }
}

export function resolveAnchorUrl(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1) return null;

    // Support [role="link"][data-href] elements used instead of <a href>
    if (anchor.getAttribute?.('role') === 'link' &&
        !anchor.getAttribute?.('href')) {
      return resolveRoleLinkUrl(anchor);
    }

    const rawAttr = String(anchor.getAttribute?.('href') || '').trim();
    if (!rawAttr || rawAttr.startsWith('#')) return null;
    const raw = getOriginalUrl(anchor) || rawAttr || String(anchor.href || '').trim();
    if (!raw || !isNavigationUrl(raw, anchor)) return null;
    const resolved = resolveCached(raw, { baseUrl: window.location.href }) || raw;
    const cleaned = cleanTrackingParams(resolved, { baseUrl: window.location.href }) || resolved;
    try {
      const u = new URL(cleaned, window.location.href);
      const cur = new URL(window.location.href);
      const sameDocument =
        String(u.origin || '').toLowerCase() === String(cur.origin || '').toLowerCase() &&
        String(u.pathname || '') === String(cur.pathname || '') &&
        String(u.search || '') === String(cur.search || '');
      if (sameDocument && !!u.hash) return null;
    } catch (e) {}

    // Step 1: Resolved URL content analysis takes priority.
    if (!isFunctionalUrl(cleaned)) return cleaned;

    // Step 2: Functional/ambiguous resolved URLs require absolute raw href.
    const isAbsoluteRawHref = /^(https?:\/\/|\/\/)/i.test(rawAttr);
    if (!isAbsoluteRawHref) return null;

    const intent = getUrlIntent(cleaned, window.location.href);
    if (intent && intent.group === 'DISCOVERY') return cleaned;

    // Step 4: External Domain Rescue - promote Non-Discovery URLs if they point to external domain
    const currentBase = getBaseDomain(window.location.hostname || '');
    const anchorBase = getBaseDomain(cleaned);
    if (!anchorBase) return null;
    if (anchorBase === currentBase) return null;
    const currentService = getServiceName(currentBase);
    const anchorService = getServiceName(anchorBase);
    if (
      currentService &&
      anchorService &&
      currentService.length >= 3 &&
      anchorService.length >= 3 &&
      currentService === anchorService
    ) {
      return null;
    }
    return cleaned;
  } catch (e) {
    return null;
  }
}

// === PHASE_IMAGE_URL_PIPELINE ===
// Image URL absolute resolution. dataExtractor's image extraction reads
// img.getAttribute('src') first (raw HTML attribute), which on many sites
// is relative ("../images/foo.jpg", "/images/bar.jpg", "images/baz.jpg").
// Downstream consumers (Firestore, sidepanel iframe at chrome-extension://
// origin) cannot resolve relatives against the original page. This helper
// guarantees an absolute URL by resolving against window.location.href.
//
// Returns the input unchanged if it's already absolute (https://...) or
// a data: URL. Returns empty string for invalid/empty input.
export function resolveAbsoluteImageUrl(rawSrc) {
  const raw = String(rawSrc || '').trim();
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;
  if (raw.startsWith('chrome-extension://')) return raw;
  try {
    return new URL(raw, window.location.href).href;
  } catch (_) {
    return raw;
  }
}
// === END PHASE_IMAGE_URL_PIPELINE ===

export function resolveAbsoluteAnchorUrl(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1) return null;
    if (hasBrSibling(anchor)) return null;
    if (isEmptyAnchor(anchor)) return null;
    if (isInlineAnchor(anchor)) return null;
    if (!isVisuallySignificant(anchor)) return null;
    const raw = String(getOriginalUrl(anchor) || anchor.getAttribute?.('href') || anchor.href || '').trim();
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return null;
    const u = new URL(raw, window.location.href);
    if (!/^https?:$/i.test(u.protocol)) return null;
    const cur = new URL(window.location.href);
    const sameDocument =
      String(u.origin || '').toLowerCase() === String(cur.origin || '').toLowerCase() &&
      String(u.pathname || '') === String(cur.pathname || '') &&
      String(u.search || '') === String(cur.search || '');
    if (sameDocument && !!u.hash) return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

function isFunctionalUrl(url) {
  try {
    const raw = String(url || '').trim();
    if (!raw) return true;
    if (raw.startsWith('#') || /^javascript:/i.test(raw) || /void\s*\(\s*0\s*\)/i.test(raw)) return true;
    const u = new URL(raw, window.location.href);
    const cur = new URL(window.location.href);
    const sameDocument =
      String(u.origin || '').toLowerCase() === String(cur.origin || '').toLowerCase() &&
      String(u.pathname || '') === String(cur.pathname || '') &&
      String(u.search || '') === String(cur.search || '');
    if (sameDocument && !!u.hash) return true;
    const host = String(u.hostname || '').toLowerCase().trim();
    const path = String(u.pathname || '').toLowerCase();
    const haystack = `${u.pathname} ${u.search} ${u.hash}`.toLowerCase();
    if (host === 'keep.naver.com') return true;
    if (path === '/search' || path.startsWith('/search/')) return true;
    if (path.startsWith('/imgres')) return true;
    if (/(login|logout|signup|sign-?up|share|report|edit|delete|subscribe|feedback)/.test(haystack)) return true;
    if (/(settings|help|faq|tos|terms|privacy)/.test(haystack)) return true;
    if (/\/api\//.test(haystack)) return true;
    if (u.pathname === '/' && /(?:^|[?&])(action|trigger|event|callback|op|cmd)=/i.test(u.search)) return true;
    // YouTube comment permalink: /watch?v=...&lc=... links anchor to a
    // specific comment, not to the video content itself.
    if (
      /(?:^|\.)youtube\.com$/i.test(host) &&
      path === '/watch' &&
      /(?:^|&)lc=/i.test(u.search)
    ) return true;

    // YouTube channel handle: /@username links to a channel profile page,
    // not to content. Treat the same way as Instagram profile links.
    if (
      /(?:^|\.)youtube\.com$/i.test(host) &&
      path.startsWith('/@')
    ) return true;

    // Instagram profile link: /{username}/ with a single path segment.
    // Excludes known content path prefixes so that /p/, /reel/, etc.
    // are still treated as valid content anchors.
    // Instagram comment permalink: /p/{shortcode}/c/{commentId}/ links to
    // a specific comment, not to the post content itself.
    if (/(?:^|\.)instagram\.com$/i.test(host)) {
      const INSTAGRAM_CONTENT_PREFIXES = new Set([
        'p', 'reel', 'reels', 'stories', 'explore',
        'tv', 'ar', 'a', 's', 'direct', 'accounts',
      ]);
      const segments = path.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
      if (segments.length === 1 && !INSTAGRAM_CONTENT_PREFIXES.has(segments[0])) return true;
      if (segments[0] === 'p' && segments[2] === 'c' && segments.length >= 4) return true;
    }

    // X/Twitter profile, analytics, and intent links are non-content
    // anchors that must not serve as Type A Signals.
    if (/(?:^|\.)(?:x\.com|twitter\.com)$/i.test(host)) {
      const X_NON_PROFILE_SEGMENTS = new Set([
        'i', 'home', 'explore', 'notifications', 'messages',
        'bookmarks', 'lists', 'compose', 'search',
        'settings', 'login', 'logout', 'signup', 'oauth',
      ]);
      const segments = path.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
      // Profile link: single segment that is not a known navigation path
      if (segments.length === 1 && !X_NON_PROFILE_SEGMENTS.has(segments[0])) return true;
      // Analytics link: /{username}/status/{numeric_id}/analytics
      if (
        segments.length >= 4 &&
        segments[1] === 'status' &&
        /^\d+$/.test(segments[2]) &&
        segments[3] === 'analytics'
      ) return true;
      // Intent link: /intent/...
      if (segments[0] === 'intent') return true;
    }

    return false;
  } catch (e) {
    return true;
  }
}

const KNOWN_2PART_PUBLIC_SUFFIXES = new Set([
  'co.kr', 'or.kr', 'go.kr', 'ne.kr', 'ac.kr', 'com.br', 'org.br', 'net.br',
  'co.uk', 'org.uk', 'me.uk', 'com.au', 'com.mx', 'co.jp', 'or.jp', 'ac.jp',
  'com.ar', 'co.nz', 'co.za', 'com.tw', 'com.hk', 'co.in', 'com.sg', 'com.ph',
  'com.vn', 'co.th', 'com.my', 'com.pk', 'org.uk', 'net.au', 'edu.au',
]);

function getBaseDomain(input) {
  try {
    let hostname = '';
    if (input && typeof input === 'object' && input.nodeType === 1 && 'hostname' in input) {
      hostname = String(input.hostname || '').toLowerCase().trim();
    } else if (typeof input === 'string') {
      const s = String(input || '').trim();
      if (!s) return '';
      try {
        const urlStr = /^https?:\/\//i.test(s) ? s : `https://${s}`;
        hostname = new URL(urlStr).hostname.toLowerCase();
      } catch (e) {
        hostname = s.toLowerCase();
      }
    }
    if (!hostname) return '';
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length <= 2) return hostname;
    const twoPartSuffix = parts.slice(-2).join('.');
    if (KNOWN_2PART_PUBLIC_SUFFIXES.has(twoPartSuffix) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  } catch (e) {
    return '';
  }
}

function getServiceName(baseDomain) {
  try {
    const b = String(baseDomain || '').toLowerCase().trim();
    if (!b) return '';
    const parts = b.split('.').filter(Boolean);
    return parts.length > 0 ? parts[0] : '';
  } catch (e) {
    return '';
  }
}

function toComparableHost(url) {
  try {
    const u = new URL(String(url || ''), window.location.href);
    return String(u.hostname || '').trim().toLowerCase();
  } catch (e) {
    return '';
  }
}

function toRootDomainKey(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const secondLevelSet = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && secondLevelSet.has(sld) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function getComparableHostFromAnchor(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1) return '';
    if (hasBrSibling(anchor)) return '';
    if (isEmptyAnchor(anchor)) return '';
    if (isInlineAnchor(anchor)) return '';
    if (!isVisuallySignificant(anchor)) return '';
    const rawHref = String(anchor.getAttribute?.('href') || anchor.href || '').trim();
    if (!rawHref || rawHref === '#' || /^javascript:/i.test(rawHref)) return '';
    if (isFunctionalUrl(rawHref)) return '';
    const abs = resolveAbsoluteAnchorUrl(anchor);
    if (!abs) return '';
    if (isFunctionalUrl(abs)) return '';
    return toRootDomainKey(toComparableHost(abs));
  } catch (e) {
    return '';
  }
}

function collectAnchorCandidates(root, itemMapElement, out, seen) {
  try {
    if (!root || root.nodeType !== 1 || !itemMapElement?.contains?.(root)) return;
    const push = (a) => {
      if (!a || a.nodeType !== 1) return;
      if (!itemMapElement.contains(a)) return;
      if (seen.has(a)) return;
      if (!getComparableHostFromAnchor(a)) return;
      seen.add(a);
      out.push(a);
    };
    if (root.matches?.('a[href]')) push(root);
    const anchors = Array.from(root.querySelectorAll?.('a[href]') || []);
    for (const a of anchors) push(a);
  } catch (e) {}
}

function getAnchorArea(anchor) {
  try {
    const r = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    if (!r) return 0;
    return Math.max(0, r.width) * Math.max(0, r.height);
  } catch (e) {
    return 0;
  }
}

function getNodeDepthWithin(node, boundary) {
  try {
    if (!node || !boundary) return Number.POSITIVE_INFINITY;
    let d = 0;
    let cur = node;
    while (cur && cur.nodeType === 1) {
      if (cur === boundary) return d;
      d += 1;
      cur = cur.parentElement;
    }
    return Number.POSITIVE_INFINITY;
  } catch (e) {
    return Number.POSITIVE_INFINITY;
  }
}

function getSortedAnchorCandidatesInItemMap(itemMapElement, hoveredTarget = null) {
  try {
    if (!itemMapElement || itemMapElement.nodeType !== 1) return [];
    const seen = new Set();
    const allAnchors = [];

    const push = (a) => {
      if (!a || a.nodeType !== 1) return;
      if (!itemMapElement.contains(a)) return;
      if (seen.has(a)) return;
      seen.add(a);
      allAnchors.push(a);
    };

    if (hoveredTarget && hoveredTarget.nodeType === 1 && itemMapElement.contains(hoveredTarget)) {
      const up = hoveredTarget.closest?.('a[href]');
      if (up) push(up);
    }

    const comparableAnchors = [];
    collectAnchorCandidates(itemMapElement, itemMapElement, comparableAnchors, new Set());
    for (const a of comparableAnchors) push(a);

    if (itemMapElement.matches?.('a[href]')) push(itemMapElement);
    const rawAnchors = Array.from(itemMapElement.querySelectorAll?.('a[href]') || []);
    for (const a of rawAnchors) push(a);

    // Also collect role="link" elements with URL-bearing data attributes
    const roleLinkEls = Array.from(
      itemMapElement.querySelectorAll?.('[role="link"]') || []
    ).filter((el) => !!getRoleLinkHref(el));
    if (itemMapElement.getAttribute?.('role') === 'link' &&
        getRoleLinkHref(itemMapElement)) {
      roleLinkEls.unshift(itemMapElement);
    }
    for (const el of roleLinkEls) {
      if (!el || el.nodeType !== 1) continue;
      if (!itemMapElement.contains(el) && el !== itemMapElement) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      allAnchors.push(el);
    }

    allAnchors.sort((a, b) => {
      const aContains = hoveredTarget && hoveredTarget.nodeType === 1 && a.contains?.(hoveredTarget) ? 1 : 0;
      const bContains = hoveredTarget && hoveredTarget.nodeType === 1 && b.contains?.(hoveredTarget) ? 1 : 0;
      if (aContains !== bContains) return bContains - aContains;
      const areaDiff = getAnchorArea(b) - getAnchorArea(a);
      if (Math.abs(areaDiff) > 0.001) return areaDiff;
      const depthA = getNodeDepthWithin(a, itemMapElement);
      const depthB = getNodeDepthWithin(b, itemMapElement);
      return depthA - depthB;
    });

    return allAnchors;
  } catch (e) {
    return [];
  }
}

function findClosestAnchorInItemMap(hoveredTarget, itemMapElement) {
  try {
    const candidates = getSortedAnchorCandidatesInItemMap(itemMapElement, hoveredTarget);
    if (candidates.length === 0) return null;
    for (const a of candidates) {
      if (resolveAnchorUrl(a)) return a;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function getVisibleTextContent(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    const hasOverlayLikeHint = (node) => {
      const bag = `${node.className || ''} ${node.id || ''} ${node.getAttribute?.('role') || ''} ${node.getAttribute?.('data-role') || ''}`.toLowerCase();
      return /(blind|hidden|tooltip|popup|popover|dialog|modal|hover)/.test(bag);
    };
    const isVisibleTextElement = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = String(node.tagName || '').toUpperCase();
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'IMG', 'VIDEO', 'CANVAS'].includes(tag)) return false;
      if (String(node.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') return false;
      if (hasOverlayLikeHint(node)) return false;
      const cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
      if (!cs) return false;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      if (cs.position === 'fixed' && /tooltip|popup|popover|dialog|modal/.test(`${node.className || ''} ${node.id || ''}`.toLowerCase())) return false;
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!r || r.width <= 0 || r.height <= 0) return false;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
      return true;
    };
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const p = node.parentElement;
      if (!p || !isVisibleTextElement(p)) {
        node = walker.nextNode();
        continue;
      }
      // Guard: if the parent has element children and every one of them
      // is invisible (e.g. screen-reader-only .place_blind spans), treat
      // the parent as a hidden-label container and skip its bare text nodes.
      const elementChildren = Array.from(p.children || []);
      if (
        elementChildren.length > 0 &&
        elementChildren.every((child) => !isVisibleTextElement(child))
      ) {
        node = walker.nextNode();
        continue;
      }
      const t = normalizeText(node.textContent || '');
      if (!t) {
        node = walker.nextNode();
        continue;
      }
      // Skip purely numeric text nodes — these are bare numbers that
      // appear alongside screen-reader-only labels (e.g. image counts,
      // distances, ratings). They have no standalone title value.
      if (/^[\d,.\s]+$/.test(t)) {
        node = walker.nextNode();
        continue;
      }
      out.push(t);
      node = walker.nextNode();
    }
    return out.join(' ');
  } catch (e) {
    return '';
  }
}

export function extractTitleFromCoreItem(coreItem, activeHoverUrl = null) {
  const rootLabel = (() => {
    if (!coreItem || coreItem.nodeType !== 1) return '(no-root)';
    const id = String(coreItem.id || '').trim();
    if (id) return `#${id}`;
    const cls = String(coreItem.className || '').trim().replace(/\s+/g, '.');
    if (cls) return `.${cls}`;
    return String(coreItem.tagName || 'UNKNOWN').toLowerCase();
  })();
  ensureExtractionLogShortcut();
  const debugLines = [];
  const fmt1 = (n) => Number(n || 0).toFixed(1);
  const fmtBonus = (n) => `${Number(n || 0) >= 0 ? '+' : ''}${fmt1(n)}`;
  const emitDebug = ({ reason, winnerText, returnValue, refinementMethod = 'none', error = null }) => {
    try {
      const header = [
        'Title Extraction',
        `Root: ${rootLabel}`,
        `Active URL: ${String(activeHoverUrl || '')}`,
        `Reason: ${reason || 'n/a'}`,
        `Candidate Count: ${debugLines.length}`,
      ].join('\n');
      const body = debugLines.length > 0 ? debugLines.join('\n\n') : '(no candidates)';
      const footer = [
        '---',
        `Final Winner: ${winnerText ? `"${winnerText}"` : 'null'}`,
        `Final Return: ${returnValue == null ? 'null' : `"${String(returnValue)}"`}`,
        `Refinement Method: ${refinementMethod}`,
        error ? `Error: ${String(error?.message || error)}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      const fullLog = [header, body, footer].join('\n');
      lastExtractionLog = fullLog;
      if (typeof window !== 'undefined') {
        window.__kickclipLastExtractionLog = fullLog;
      }
    } catch (e) {}
  };
  try {
    if (!coreItem || coreItem.nodeType !== 1) {
      emitDebug({ reason: 'invalid-core-item', winnerText: null, returnValue: null });
      return null;
    }

    const coreRect = coreItem.getBoundingClientRect ? coreItem.getBoundingClientRect() : null;
    if (!coreRect || coreRect.width <= 0 || coreRect.height <= 0) {
      emitDebug({ reason: 'invalid-core-rect', winnerText: null, returnValue: null });
      return null;
    }

    const styleCache = new Map();
    const findClosestAnchorWithinRoot = (startNode, rootNode) => {
      try {
        let cur = startNode && startNode.nodeType === 1 ? startNode : null;
        while (cur && cur.nodeType === 1) {
          if (cur.matches?.('a[href]')) return cur;
          if (cur === rootNode) return null;
          cur = cur.parentElement;
        }
        return null;
      } catch (e) {
        return null;
      }
    };
    const getStyle = (el) => {
      if (!el || el.nodeType !== 1) return null;
      if (styleCache.has(el)) return styleCache.get(el);
      const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      styleCache.set(el, cs);
      return cs;
    };
    const toWeightNumber = (value) => {
      const v = String(value || '').toLowerCase().trim();
      if (v === 'normal') return 400;
      if (v === 'bold') return 700;
      const n = parseFloat(v);
      return isFinite(n) ? n : 400;
    };
    const isOverlayLike = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      const ariaRole = String(el.getAttribute?.('aria-role') || '').toLowerCase();
      const ariaModal = String(el.getAttribute?.('aria-modal') || '').toLowerCase();
      const ariaHidden = String(el.getAttribute?.('aria-hidden') || '').toLowerCase();
      const ariaLive = String(el.getAttribute?.('aria-live') || '').toLowerCase();
      const hasPopup = String(el.getAttribute?.('aria-haspopup') || '').toLowerCase();
      const roles = `${role} ${ariaRole}`;
      if (ariaHidden === 'true') return true;
      if (ariaModal === 'true') return true;
      if (ariaLive && ariaLive !== 'off') return true;
      if (hasPopup && hasPopup !== 'false') return true;
      return /(tooltip|dialog|alertdialog|menu|listbox|combobox|popover|popup)/.test(roles);
    };
    const isVisibleElement = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (el.offsetWidth <= 1 || el.offsetHeight <= 1) return false;
      if (!el.getClientRects || el.getClientRects().length === 0) return false;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const cs = getStyle(el);
      if (!cs) return false;
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if ((parseFloat(String(cs.opacity || '1')) || 0) <= 0) return false;
      const clip = String(cs.clip || '').toLowerCase().replace(/\s+/g, '');
      const clipPath = String(cs.clipPath || '').toLowerCase().replace(/\s+/g, '');
      if (/^rect\((0(px)?,){3}0(px)?\)$/.test(clip)) return false;
      if (/^rect\((1(px)?,){3}1(px)?\)$/.test(clip)) return false;
      if (/^inset\(50%/.test(clipPath)) return false;
      const textIndent = parseFloat(String(cs.textIndent || '0'));
      if (isFinite(textIndent) && textIndent < -90) return false;
      if (isOverlayLike(el)) return false;
      if (el.closest?.('[role="tooltip"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]')) return false;
      return true;
    };
    const isDateTimeLike = (text) => {
      const t = String(text || '').trim();
      if (!t) return false;
      if (/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/.test(t)) return true;
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t)) return true;
      if (/\b\d{1,2}\s*(min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/i.test(t)) return true;
      if (/\b\d+\s*(분|시간|일|주|개월|달|년)\s*전\b/.test(t)) return true;
      return false;
    };
    const isFunctionalContainer = (el) => {
      if (!el || el.nodeType !== 1) return false;

      const roleContainer = el.closest?.('button, [role="button"], [role="menuitem"]');
      if (roleContainer) return true;

      const parent = el.parentElement;
      if (!parent) return false;

      const siblings = Array.from(parent.children || []).filter((s) => s && s !== el);
      const hasSmallIconSibling = siblings.some((s) => {
        const tag = String(s.tagName || '').toUpperCase();
        if (!['SVG', 'PATH', 'IMG'].includes(tag)) return false;
        const r = s.getBoundingClientRect ? s.getBoundingClientRect() : null;
        if (!r || r.width <= 0 || r.height <= 0) return false;
        return r.width < 24 && r.height < 24;
      });
      if (hasSmallIconSibling) return true;

      const pcs = getStyle(parent);
      if (!pcs) return false;
      const parentRect = parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
      if (!parentRect || parentRect.width <= 0 || parentRect.height <= 0) return false;

      const borderRadius = String(pcs.borderRadius || '').trim();
      const isCircleLike = borderRadius === '50%' || (parseFloat(borderRadius) || 0) >= Math.min(parentRect.width, parentRect.height) / 2;

      const display = String(pcs.display || '').toLowerCase();
      const centeredFlex =
        (display === 'flex' || display === 'inline-flex') &&
        String(pcs.justifyContent || '').toLowerCase() === 'center' &&
        String(pcs.alignItems || '').toLowerCase() === 'center';
      const verySmallContainer = parentRect.width <= 48 && parentRect.height <= 48;

      return isCircleLike || (centeredFlex && verySmallContainer);
    };
    const getSemanticHintScore = (el) => {
      if (!el || el.nodeType !== 1) return 0;
      const parent = el.parentElement;
      const bag = [
        String(el.className || ''),
        String(el.id || ''),
        String(parent?.className || ''),
        String(parent?.id || ''),
      ]
        .join(' ')
        .toLowerCase();
      const hasPositive = /(title|subject|headline|heading|toptext|tit|head|txt_title|bluelink|_tit|name)/i.test(bag);
      const hasNegative = /(desc|description|summary|info|metadata|sub|caption|source|url|site|favicon|ad_mark|ico_area)/i.test(bag);
      let score = 0;
      if (hasPositive) score += 15;
      if (hasNegative) score -= 15;
      return score;
    };
    const getStrictAnchorHref = (anchor) => {
      try {
        if (!anchor || anchor.nodeType !== 1) return '';
        const raw = String(anchor.getAttribute?.('href') || anchor.href || '').trim();
        if (!raw) return '';
        return new URL(raw, window.location.href).href;
      } catch (e) {
        return '';
      }
    };

    // When activeHoverUrl is set, collect all anchors whose resolved URL matches.
    // Text nodes are included only if inside at least one matched anchor.
    const traversalRoot = coreItem;
    let matchedAnchors = null;
    if (activeHoverUrl) {
      const allAnchors = Array.from(coreItem.querySelectorAll?.('a[href]') || []);
      const filtered = allAnchors.filter((a) => {
        try {
          const resolved = normalizeText(resolveAnchorUrl(a) || resolveAnchorUrlRelaxed(a) || '');
          return !!resolved && resolved === String(activeHoverUrl);
        } catch (e) {
          return false;
        }
      });
      if (filtered.length > 0) matchedAnchors = filtered;
    }

    const textByElement = new Map();
    const walker = document.createTreeWalker(traversalRoot, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && traversalRoot.contains(parent) && isVisibleElement(parent)) {
        const inScope = !matchedAnchors || matchedAnchors.some((a) => a.contains(parent));
        if (inScope) {
          const text = normalizeText(node.textContent || '');
          if (text) {
            const prev = textByElement.get(parent) || '';
            textByElement.set(parent, prev ? `${prev} ${text}` : text);
          }
        }
      }
      node = walker.nextNode();
    }

    let best = null;
    for (const [el, text] of textByElement.entries()) {
      const cs = getStyle(el);
      if (!cs) continue;

      const fontSize = parseFloat(String(cs.fontSize || '0')) || 0;
      const fontScore = fontSize * 4.5;
      let score = fontScore;

      const tag = String(el.tagName || '').toUpperCase();
      const weight = toWeightNumber(cs.fontWeight);
      const weightBonus = weight >= 600 || ['B', 'STRONG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag) ? 15 : 0;
      if (weight >= 600 || ['B', 'STRONG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) {
        score += weightBonus;
      }

      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect) continue;
      const rootRect = traversalRoot.getBoundingClientRect
        ? traversalRoot.getBoundingClientRect()
        : coreRect;
      const centerY = rect.top + rect.height / 2;
      const relativeY = (centerY - rootRect.top) / Math.max(1, rootRect.height);
      const positionBonus = relativeY <= 0.4 ? 20 : 0;
      if (positionBonus) score += positionBonus;

      let linkBonus = 0;
      if (activeHoverUrl) {
        const linked = findClosestAnchorWithinRoot(el, coreItem);
        const linkedHref = getStrictAnchorHref(linked);
        if (linkedHref && linkedHref === String(activeHoverUrl)) {
          linkBonus = 25;
          score += linkBonus;
        }
      }

      const lengthPenalty = text.length > 100 ? -40 : 0;
      if (lengthPenalty) score += lengthPenalty;
      const dateTimePenalty = isDateTimeLike(text) ? -50 : 0;
      if (dateTimePenalty) score += dateTimePenalty;
      const utilityPenalty = isFunctionalContainer(el) ? -15 : 0;
      if (utilityPenalty) score += utilityPenalty;
      const semanticHint = getSemanticHintScore(el);
      if (semanticHint) score += semanticHint;

      debugLines.push(
        [
          'Candidate',
          `Text: "${String(text).slice(0, 20)}${String(text).length > 20 ? '...' : ''}"`,
          'Score Breakdown:',
          `- Base(Font): ${fmtBonus(fontScore)}`,
          `- Weight: ${fmtBonus(weightBonus)}`,
          `- Position: ${fmtBonus(positionBonus)}`,
          `- Link: ${fmtBonus(linkBonus)}`,
          `- Semantic Hint: ${fmtBonus(semanticHint)}`,
          `- Length Penalty: ${fmt1(lengthPenalty)}`,
          `- Date/Time Penalty: ${fmt1(dateTimePenalty)}`,
          `- Utility Penalty: ${fmt1(utilityPenalty)}`,
          `= TOTAL: ${fmt1(score)}`,
        ].join('\n')
      );

      if (!best || score > best.score) {
        best = { el, text, score };
      }
    }

    if (!best || !best.text) {
      emitDebug({ reason: 'no-winner', winnerText: null, returnValue: null, refinementMethod: 'none' });
      return null;
    }

    const anchor = findClosestAnchorWithinRoot(best.el, coreItem);
    if (anchor) {
      const titleAttr = normalizeText(anchor.getAttribute?.('title') || '');
      const labelAttr = normalizeText(anchor.getAttribute?.('aria-label') || '');
      const winnerText = normalizeText(best.text).toLowerCase();
      if (titleAttr && normalizeText(titleAttr).toLowerCase().includes(winnerText)) {
        emitDebug({ reason: 'title-attr-refine', winnerText: best.text, returnValue: titleAttr, refinementMethod: 'title' });
        return titleAttr;
      }
      if (labelAttr && normalizeText(labelAttr).toLowerCase().includes(winnerText)) {
        emitDebug({ reason: 'aria-label-refine', winnerText: best.text, returnValue: labelAttr, refinementMethod: 'aria-label' });
        return labelAttr;
      }
    }

    const INLINE_TEXT_TAGS = new Set(['SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'SMALL', 'S', 'DEL', 'INS', 'SUB', 'SUP', 'CODE', 'KBD', 'SAMP', 'VAR', 'A', 'MARK', 'RUBY', 'RT', 'RP']);
    const collectSiblingText = (winnerEl) => {
      try {
        // Step 1: walk up from winnerEl to find the closest <a> within coreItem.
        const anchor = findClosestAnchorWithinRoot(winnerEl, coreItem);
        if (!anchor) return null;

        const anchorChildren = Array.from(anchor.children || []);
        if (anchorChildren.length === 0) return null;

        // Step 2: determine if <a> is text-only — every direct child element
        // is an inline text tag (may be empty).
        const isTextOnly = anchorChildren.every(
          (c) => c.nodeType === 1 && INLINE_TEXT_TAGS.has(String(c.tagName || '').toUpperCase())
        );

        if (isTextOnly) {
          // Step 3A: text-only structure.
          // An empty inline child acts as a separator — collect only the group
          // that contains winnerEl. Scan forward and backward from winnerEl's
          // position, stopping at the first empty sibling in each direction.
          const winnerIndex = anchorChildren.indexOf(winnerEl);
          if (winnerIndex === -1) {
            // winnerEl is not a direct child of anchor (it is deeper).
            // Collect all non-empty children as a single group — no separator logic.
            const parts = anchorChildren
              .map((c) => normalizeText(c.innerText || c.textContent || ''))
              .filter(Boolean);
            return parts.length >= 1 ? parts.join(' ') : null;
          }

          // Find the group boundaries by scanning outward from winnerIndex,
          // stopping before the first empty sibling.
          let groupStart = winnerIndex;
          let groupEnd = winnerIndex;

          for (let i = winnerIndex - 1; i >= 0; i--) {
            const text = normalizeText(anchorChildren[i].innerText || anchorChildren[i].textContent || '');
            if (!text) break; // empty sibling = separator
            groupStart = i;
          }
          for (let i = winnerIndex + 1; i < anchorChildren.length; i++) {
            const text = normalizeText(anchorChildren[i].innerText || anchorChildren[i].textContent || '');
            if (!text) break; // empty sibling = separator
            groupEnd = i;
          }

          const group = anchorChildren.slice(groupStart, groupEnd + 1);
          const parts = group
            .map((c) => normalizeText(c.innerText || c.textContent || ''))
            .filter(Boolean);
          return parts.length >= 1 ? parts.join(' ') : null;

        } else {
          // Step 3B: non-text (block) structure.
          // Collect visible text from ALL direct children of <a>, joining them
          // with a space. This handles cases like:
          //   <a><div>잼, 버터도 아닌</div><div>복음자리 넛츠앤</div></a>
          // where the winner is only one of several sibling text blocks.
          //
          // A child is included only when it contributes non-empty visible text.
          // Children that are pure media (img/svg/video/canvas with no text) are skipped.
          const isPureMedia = (el) => {
            try {
              const tag = String(el.tagName || '').toUpperCase();
              if (['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME'].includes(tag)) return true;
              const text = normalizeText(el.innerText || el.textContent || '');
              if (text) return false;
              // No text and contains only media descendants
              const nonMediaDescendants = Array.from(el.querySelectorAll?.('*') || []).filter((d) => {
                const dt = String(d.tagName || '').toUpperCase();
                return !['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'SCRIPT', 'STYLE'].includes(dt);
              });
              return nonMediaDescendants.length === 0;
            } catch (e) {
              return false;
            }
          };

          const parts = anchorChildren
            .filter((c) => !isPureMedia(c))
            .map((c) => normalizeText(c.innerText || c.textContent || ''))
            .filter(Boolean);

          return parts.length >= 1 ? parts.join(' ') : null;
        }
      } catch (e) {
        return null;
      }
    };
    const siblingText = collectSiblingText(best.el);
    if (siblingText) {
      emitDebug({ reason: 'sibling-text-join', winnerText: best.text, returnValue: siblingText, refinementMethod: 'sibling-join' });
      return siblingText;
    }

    const finalText = normalizeText(best.el.innerText || best.text) || null;
    emitDebug({ reason: 'winner-inner-text', winnerText: best.text, returnValue: finalText, refinementMethod: 'innerText' });
    return finalText;
  } catch (e) {
    emitDebug({ reason: 'exception', winnerText: null, returnValue: null, refinementMethod: 'none', error: e });
    return null;
  }
}

function extractInstagramCaptionFromCoreItem(coreItem) {
  try {
    if (!coreItem || coreItem.nodeType !== 1) {
      return { status: 'not_found', extracted_text: '', text_length: 0, username: '' };
    }

    const root = coreItem;
    const extractInstagramUsername = () => {
      try {
        const anchors = Array.from(root.querySelectorAll?.('a[href]') || []);
        for (const a of anchors) {
          const href = String(a.getAttribute?.('href') || '').trim();
          // Single-segment profile path: /{username}/
          const m = href.match(/^\/([^/?#]+)\/?$/);
          if (!m || !m[1]) continue;
          let name = '';
          // Prefer immediate text from anchor/direct children before full subtree text.
          const directText = Array.from(a.childNodes || [])
            .filter((n) => n?.nodeType === Node.TEXT_NODE)
            .map((n) => String(n.textContent || '').trim())
            .find((t) => !!t);
          if (directText) {
            name = directText;
          } else {
            const firstChild = Array.from(a.children || []).find((c) => normalizeText(c?.textContent || '').length > 0);
            name = normalizeText(firstChild?.textContent || a.textContent || a.innerText || '');
          }
          name = String(name || '').trim();
          if (name) return name;
        }
        return '';
      } catch (e) {
        return '';
      }
    };
    const username = extractInstagramUsername();

    const primarySelector = 'span._ap3a._aaco._aacu._aacx._aad7._aade';
    const primaryCandidate = root.querySelector?.(primarySelector) || null;

    const findFallbackCandidate = () => {
      try {
        const allButtons = Array.from(root.querySelectorAll?.('button, [role="button"]') || []);
        const actionButton = allButtons.find((btn) => {
          const bag = `${btn.getAttribute?.('aria-label') || ''} ${btn.textContent || ''}`.toLowerCase();
          return /(like|comment|share|좋아요|댓글|공유)/.test(bag);
        });
        const actionContainer = actionButton?.closest?.('section, div, nav') || null;
        let cursor = actionContainer?.nextElementSibling || null;
        let hops = 0;
        while (cursor && hops < 5) {
          hops += 1;
          const span = cursor.querySelector?.('span');
          if (span) return span;
          cursor = cursor.nextElementSibling;
        }
      } catch (e) {}
      return null;
    };

    const candidate = primaryCandidate || findFallbackCandidate();
    if (!candidate) {
      return { status: 'not_found', extracted_text: '', text_length: 0, username };
    }

    const clone = candidate.cloneNode(true);
    if (!clone || clone.nodeType !== 1) {
      return { status: 'not_found', extracted_text: '', text_length: 0, username };
    }

    // Remove UI controls and obvious non-caption nodes.
    const removeSelectors = [
      'button',
      '[role="button"]',
      '[aria-label*="more" i]',
      '[aria-label*="더 보기"]',
      '[aria-label*="See translation" i]',
      '[aria-label*="번역"]',
      'a[href*="/comments/"]',
      'a[href*="/p/"][role="link"] + span[role="link"]',
    ];
    for (const sel of removeSelectors) {
      const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
      for (const n of nodes) {
        try {
          n.remove();
        } catch (e) {}
      }
    }

    const rawText = String(clone.innerText || clone.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    const uiLineRe = /^(more|see more|더 보기|see translation|번역 보기|view all comments|댓글 모두 보기)$/i;
    const cleanedLines = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !!line && !uiLineRe.test(line));
    const text = cleanedLines.join('\n').trim();
    if (!text) {
      return { status: 'not_found', extracted_text: '', text_length: 0, username };
    }

    return {
      status: 'success',
      extracted_text: text,
      text_length: text.length,
      username,
    };
  } catch (e) {
    return { status: 'not_found', extracted_text: '', text_length: 0, username: '' };
  }
}

// === PHASE_VIDEO_CLIP ===
// Step 2 of <video> support: clip-time URL / thumbnail / clipboard
// generation when the dominant element is <video>. Three pieces work
// together: this helper extracts the static info (poster URL if any),
// extractImageFromCoreItem and extractMetadataForCoreItem branch on
// dominant element type, and coreEntry's videoElementToBlob handles
// canvas first-frame capture for the no-poster path.
//
// Returns null when the element isn't a <video> or no usable info is
// available. When the element is a <video>:
//   - posterUrl: resolveAbsoluteImageUrl(video.poster) or '' if absent
//   - width/height: video.videoWidth/Height (intrinsic) or layout rect
//     fallback for the rare videoWidth=0 case (video not yet loaded)
export function extractVideoMediaInfo(video) {
  try {
    if (!video) return null;
    const inputTag = String(video.tagName || '').toUpperCase();
    if (inputTag !== 'VIDEO' && inputTag !== 'SHREDDIT-PLAYER') return null;
    // For shreddit-player, poster attribute is on the host element,
    // but videoWidth/videoHeight live on the shadow <video> (open shadow).
    // Layout rect comes from the host (its visible box).
    const shadowVideo = inputTag === 'SHREDDIT-PLAYER'
      ? video.shadowRoot?.querySelector?.('video') || null
      : video;
    const posterRaw = video.getAttribute?.('poster') || '';
    const posterUrl = posterRaw ? resolveAbsoluteImageUrl(posterRaw) : '';
    const vw = Number(shadowVideo?.videoWidth) || 0;
    const vh = Number(shadowVideo?.videoHeight) || 0;
    if (vw > 0 && vh > 0) {
      return { posterUrl, width: vw, height: vh };
    }
    const r = video.getBoundingClientRect?.();
    const lw = Math.round(Math.max(0, Number(r?.width || 0)));
    const lh = Math.round(Math.max(0, Number(r?.height || 0)));
    if (lw > 0 && lh > 0) {
      return { posterUrl, width: lw, height: lh };
    }
    // Last resort: posterUrl alone, no dimensions (caller treats as
    // "best effort" and may compute dims downstream from the poster
    // image after fetch).
    return { posterUrl, width: 0, height: 0 };
  } catch (e) {
    return null;
  }
}
// === END PHASE_VIDEO_CLIP ===

// === PHASE_PLATFORM_ORIGINAL_URL_HELPER ===
// Shared image URL resolution for clip-time use.
//
// Centralizes platform-specific original-URL extraction (Google /imgres,
// Naver pstatic proxy) and a generic srcset parser that picks the highest
// descriptor URL (works for Pinterest 4x density descriptors, Dribbble
// 320w-1200w width descriptors, Instagram retina @2x, etc.). Falls back
// to Pinterest path transform (/236x/ → /originals/) for pins without
// srcset, then to dominantImg.src/currentSrc/src.
//
// Resolution order:
//   1. Google /imgres anchor's imgurl query parameter (host-gated)
//   2. Naver pstatic proxy ?src= query parameter (host-gated)
//   3. Generic srcset parser: highest descriptor URL (host-independent)
//   4. Pinterest /236x/ → /originals/ path transform (host-gated, fallback)
//   5. dominantImg.src / currentSrc / src
//
// Inputs:
//   - coreItem: card element (Type B/D) or media element itself (Type E)
//   - dominantImg: dominant <img> element; for Type E IMG shortcut, the
//     same element as coreItem
//
// Returns: absolute image URL string (or empty string if all paths fail).
// Width/height are NOT returned — callers compute from element rect.
export function resolveClipImageUrl(coreItem, dominantImg) {
  try {
    const hostname = String(window?.location?.hostname || '').toLowerCase().trim();

    // 1. Google Images: /imgres anchor (anchor-based, not srcset)
    const isGoogleHost = /^([\w-]+\.)*google\.[\w.]+$/i.test(hostname);
    if (isGoogleHost && coreItem && typeof coreItem.querySelector === 'function') {
      try {
        const imgresAnchor = coreItem.querySelector('a[href*="/imgres"]');
        if (imgresAnchor) {
          const href = String(imgresAnchor.getAttribute('href') || '').trim();
          if (href) {
            const u = new URL(href, window.location.origin);
            const imgurl = u.searchParams.get('imgurl');
            if (imgurl && /^https?:\/\//i.test(imgurl)) {
              return imgurl;
            }
          }
        }
      } catch (_) { /* fall through */ }
    }

    // 2. Naver image search: pstatic proxy ?src= (proxy-based, not srcset)
    const isNaverImageSearch = (
      /(?:^|\.)search\.naver\.com$/.test(hostname) &&
      String(window?.location?.pathname || '') === '/search.naver' &&
      new URLSearchParams(String(window?.location?.search || '')).get('where') === 'image'
    );
    if (isNaverImageSearch && coreItem && typeof coreItem.querySelector === 'function') {
      try {
        const naverImg = coreItem.querySelector('img[src*="search.pstatic.net"]');
        if (naverImg) {
          const proxySrc = String(
            naverImg.getAttribute('src') || naverImg.currentSrc || naverImg.src || ''
          ).trim();
          if (proxySrc) {
            const proxyUrl = new URL(proxySrc);
            const originalUrl = proxyUrl.searchParams.get('src');
            if (originalUrl && /^https?:\/\//i.test(originalUrl)) {
              return originalUrl;
            }
          }
        }
      } catch (_) { /* fall through */ }
    }

    // 3. Generic srcset parser: highest descriptor URL (host-independent)
    if (dominantImg) {
      const srcset = String(dominantImg.getAttribute?.('srcset') || '').trim();
      if (srcset) {
        const maxUrl = parseSrcsetMaxDescriptor(srcset);
        if (maxUrl) {
          const absolute = resolveAbsoluteImageUrl(maxUrl);
          if (absolute && /^https?:\/\//i.test(absolute)) {
            return absolute;
          }
        }
      }
    }

    // 4. Pinterest path transform: /236x/ → /originals/ (fallback for pins without srcset)
    const isPinterestHost = /^([\w-]+\.)*pinterest\.[\w.]+$/i.test(hostname);
    if (isPinterestHost && dominantImg) {
      try {
        const rawSrc = String(
          dominantImg.getAttribute?.('src') || dominantImg.currentSrc || dominantImg.src || ''
        ).trim();
        if (rawSrc && /pinimg\.com\/\d+x\//i.test(rawSrc)) {
          const transformed = rawSrc.replace(
            /^(https?:\/\/[^/]*pinimg\.com\/)\d+x\//i,
            '$1originals/'
          );
          const absolute = resolveAbsoluteImageUrl(transformed);
          if (absolute && /^https?:\/\//i.test(absolute)) {
            return absolute;
          }
        }
      } catch (_) { /* fall through */ }
    }

    // 5. Final fallback: dominantImg.src / currentSrc / src
    if (dominantImg) {
      return resolveAbsoluteImageUrl(
        dominantImg.getAttribute?.('src') || dominantImg.currentSrc || dominantImg.src || ''
      );
    }
    return '';
  } catch (_) {
    return '';
  }
}

// File-internal: parse srcset descriptors and return URL with highest
// descriptor value. Handles both density (`Nx`) and width (`Nw`) units.
// Uses the first unit seen; ignores candidates with a different unit
// (HTML spec mandates single-unit srcsets, so mixed-unit input is rare).
// Returns empty string on no valid candidate.
function parseSrcsetMaxDescriptor(srcset) {
  try {
    const candidates = String(srcset || '').split(',').map((s) => s.trim()).filter(Boolean);
    let bestUrl = '';
    let bestValue = -1;
    let bestUnit = null;  // 'x' or 'w'
    for (const candidate of candidates) {
      const parts = candidate.split(/\s+/);
      if (parts.length === 0) continue;
      const url = parts[0];
      if (!url) continue;
      const descriptor = parts[1] || '1x';  // bare URL means 1x default
      const match = descriptor.match(/^([\d.]+)([xw])$/);
      if (!match) continue;
      const value = parseFloat(match[1]);
      if (isNaN(value) || value < 0) continue;
      const unit = match[2];
      if (bestUnit === null) {
        bestUnit = unit;
        bestUrl = url;
        bestValue = value;
      } else if (unit === bestUnit && value > bestValue) {
        bestUrl = url;
        bestValue = value;
      }
      // mixed-unit candidates: ignore (keep current bestUnit's max)
    }
    return bestUrl;
  } catch (_) {
    return '';
  }
}
// === END PHASE_PLATFORM_ORIGINAL_URL_HELPER ===

export function extractImageFromCoreItem(coreItem) {
  try {
    if (!coreItem || !coreItem.querySelectorAll) return null;

    // === PHASE27F_TYPE_E_IMG_SHORTCUT ===
    // When the coreItem is itself an <img> (Type E case), the
    // generic descendant search returns nothing because <img>
    // has no children. Return the <img>'s own src directly.
    //
    // Width/height precedence:
    //   1. Layout rect (getBoundingClientRect) — current paint size
    //   2. naturalWidth / naturalHeight — falls back when the
    //      layout rect is 0×0 (lazy-load placeholder), matching
    //      the same fallback pattern used by
    //      getEffectiveImageRectForImageGate in itemDetector.js.
    if (String(coreItem.tagName || '').toUpperCase() === 'IMG') {
      // === PHASE_IMAGE_URL_PIPELINE ===
      const src = resolveClipImageUrl(coreItem, coreItem);
      // === END PHASE_IMAGE_URL_PIPELINE ===
      if (src) {
        const rect = coreItem.getBoundingClientRect?.();
        const layoutW = Number(rect?.width) || 0;
        const layoutH = Number(rect?.height) || 0;
        const naturalW = Number(coreItem.naturalWidth) || 0;
        const naturalH = Number(coreItem.naturalHeight) || 0;
        const width = layoutW > 0 ? layoutW : naturalW;
        const height = layoutH > 0 ? layoutH : naturalH;
        return {
          image: {
            url: src,
            width: Math.round(width),
            height: Math.round(height),
          },
          usedCustomLogic: false,
        };
      }
    }
    // === END PHASE27F_TYPE_E_IMG_SHORTCUT ===

    // === PHASE_VIDEO_CLIP_TYPE_E ===
    // Type E shortcut for <video>: parallel to the IMG branch above.
    // Returns the poster URL when present; canvas first-frame capture
    // and base64 fallback are handled by the clipboard pipeline in
    // coreEntry, not here. When no poster is set, image.url is '' and
    // the caller signals "no image URL available from extraction" so
    // downstream (extractMetadataForCoreItem) treats this as a video
    // that needs canvas capture at clip time.
    if (String(coreItem.tagName || '').toUpperCase() === 'VIDEO') {
      const info = extractVideoMediaInfo(coreItem);
      if (info) {
        return {
          image: {
            // Always '' — clip-time canvas frame replaces both posterUrl
            // and image URL paths. The actual img_url is produced at clip
            // time by videoElementToBlobAndDataUrl in coreEntry, ensuring
            // clipboard/thumbnail/img_url all come from the same captured
            // frame. extractVideoMediaInfo still reports posterUrl for
            // future use; this branch just ignores it.
            url: '',
            width: info.width,
            height: info.height,
          },
          usedCustomLogic: false,
        };
      }
    }
    // === END PHASE_VIDEO_CLIP_TYPE_E ===

    const platform = getCurrentPlatform();
    if (platform === SUPPORTED_PLATFORMS.INSTAGRAM) {
      // Carousel-aware extraction. Multi-slide carousels show all
      // slides in the DOM (one <li> each) but only one is visible
      // in the viewport. The user is viewing the slide whose center
      // is closest to the coreItem's center. Extract the image from
      // that slide. If that slide has no img (video-only slide),
      // return null so the background fetch in coreEntry.js
      // (requestInstagramPostDataForTypeB) can supply the poster
      // image as fallback.
      //
      // Single-image posts (no <ul> or <= 1 slide with media) fall
      // through to the generic logic below — no Instagram-specific
      // behavior needed for those.

      const carouselUl = coreItem.querySelector?.('ul');
      const allLis = carouselUl
        ? Array.from(carouselUl.querySelectorAll(':scope > li'))
        : [];
      // Only consider <li> that actually contain media (img or video).
      // This excludes invisible spacer <li> (e.g., width:1px) and
      // any unrelated <ul> lists that don't host the carousel.
      const slidesWithMedia = allLis.filter((li) =>
        li.querySelector?.('img[src], video')
      );

      if (slidesWithMedia.length >= 2) {
        const coreRect = coreItem.getBoundingClientRect
          ? coreItem.getBoundingClientRect()
          : null;
        if (coreRect && coreRect.width > 0) {
          const coreCenterX = coreRect.left + coreRect.width / 2;

          let visibleSlide = null;
          let minDist = Infinity;
          for (const slide of slidesWithMedia) {
            const r = slide.getBoundingClientRect
              ? slide.getBoundingClientRect()
              : null;
            if (!r || r.width <= 0 || r.height <= 0) continue;
            const slideCenterX = r.left + r.width / 2;
            const dist = Math.abs(slideCenterX - coreCenterX);
            if (dist < minDist) {
              minDist = dist;
              visibleSlide = slide;
            }
          }

          if (visibleSlide) {
            const img = visibleSlide.querySelector?.('img[src]');
            if (img) {
              const r = img.getBoundingClientRect
                ? img.getBoundingClientRect()
                : null;
              const src = resolveAbsoluteImageUrl(
                img.getAttribute?.('src') || img.currentSrc || img.src
              );
              if (src && r && r.width > 0 && r.height > 0) {
                return {
                  image: {
                    url: src,
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                  },
                  usedCustomLogic: true,
                };
              }
            }
            // Visible slide has no <img> (likely a video slide).
            // Return null so the background fetch falls back to
            // the /media/?size=l video poster via Phase 19b gate.
            return { image: null, usedCustomLogic: true };
          }
        }
      }

      // Single-image post (no <ul>, or <= 1 slide with media):
      // fall through to the generic logic below.
    }

    // Google image search: extract original-resolution URL from
    // /imgres anchor's imgurl query parameter. Without this, the
    // base64 thumbnail in <img src="data:image/...;base64,..."> is
    // saved as img_url, which is extremely low resolution.
    //
    // Detection: host is google.<tld> AND coreItem contains
    // <a href="/imgres?..."> with imgurl query.
    const googleHostname = String(window?.location?.hostname || '').toLowerCase().trim();
    const isGoogleHost = /^([\w-]+\.)*google\.[\w.]+$/i.test(googleHostname);
    if (isGoogleHost) {
      const imgresAnchor = coreItem.querySelector?.('a[href*="/imgres"]');
      if (imgresAnchor) {
        try {
          const href = String(
            imgresAnchor.getAttribute?.('href') || ''
          ).trim();
          if (href) {
            const u = new URL(href, window.location.origin);
            const imgurl = u.searchParams.get('imgurl');
            const w = u.searchParams.get('w');
            const h = u.searchParams.get('h');
            if (imgurl && /^https?:\/\//i.test(imgurl)) {
              return {
                image: {
                  url: imgurl,
                  width: parseInt(w, 10) || 0,
                  height: parseInt(h, 10) || 0,
                },
                usedCustomLogic: true,
              };
            }
          }
        } catch (e) {
          // URL parsing failed — fall through to generic logic
        }
      }
    }

    // Naver image search: extract original-resolution URL from
    // the pstatic CDN proxy <img> (?src=ENCODED_URL&type=a340 pattern).
    // Without this, the saved img_url is the proxy URL (340px
    // variant), not the original.
    //
    // Detection: host is search.naver.com AND pathname is
    // /search.naver AND where=image query parameter is set
    // (image search page only, not blog/news/cafe tabs).
    const isNaverImageSearch = (
      /(?:^|\.)search\.naver\.com$/.test(
        String(window?.location?.hostname || '').toLowerCase()
      ) &&
      String(window?.location?.pathname || '') === '/search.naver' &&
      new URLSearchParams(
        String(window?.location?.search || '')
      ).get('where') === 'image'
    );
    if (isNaverImageSearch) {
      const naverImg = coreItem.querySelector?.(
        'img[src*="search.pstatic.net"]'
      );
      if (naverImg) {
        try {
          const proxySrc = String(
            naverImg.getAttribute?.('src') || naverImg.currentSrc || naverImg.src || ''
          ).trim();
          if (proxySrc) {
            const proxyUrl = new URL(proxySrc);
            const originalUrl = proxyUrl.searchParams.get('src');
            const w = parseInt(
              naverImg.getAttribute?.('data-thumb-width'),
              10
            ) || 0;
            const h = parseInt(
              naverImg.getAttribute?.('data-thumb-height'),
              10
            ) || 0;
            if (originalUrl && /^https?:\/\//i.test(originalUrl)) {
              return {
                image: {
                  url: originalUrl,
                  width: w,
                  height: h,
                },
                usedCustomLogic: true,
              };
            }
          }
        } catch (e) {
          // URL parsing failed — fall through to generic logic
        }
      }
    }

    // Pinterest pin: extract original-resolution URL by either
    // parsing srcset's 4x descriptor or by replacing the size
    // segment in src.
    //
    // Pinterest serves images via i.pinimg.com with size variants
    // in the URL path: /236x/, /474x/, /736x/, /originals/, etc.
    // The /originals/ variant is the full resolution.
    //
    // Detection: host matches pinterest.<tld> AND coreItem contains
    // an <img> with i.pinimg.com URL (in src or srcset).
    //
    // URL extraction strategy:
    //   1. Parse srcset for the 4x descriptor (typically /originals/)
    //   2. Fallback: replace the size segment in src with "originals"
    const pinterestHostname = String(window?.location?.hostname || '').toLowerCase().trim();
    const isPinterestHost = /^([\w-]+\.)*pinterest\.[\w.]+$/i.test(pinterestHostname);
    if (isPinterestHost) {
      const pinterestImg = coreItem.querySelector?.(
        'img[src*="pinimg.com"], img[srcset*="pinimg.com"]'
      );
      if (pinterestImg) {
        let originalUrl = '';
        try {
          // Strategy 1: srcset's 4x descriptor (typically the
          // originals URL).
          const srcset = String(
            pinterestImg.getAttribute?.('srcset') || ''
          ).trim();
          if (srcset) {
            const match = srcset.match(/(\S+)\s+4x(?:\s*,|\s*$)/);
            if (match && match[1]) {
              originalUrl = match[1];
            }
          }
          // Strategy 2: fall back to src path conversion.
          if (!originalUrl) {
            const src = String(
              pinterestImg.getAttribute?.('src') || pinterestImg.currentSrc || pinterestImg.src || ''
            ).trim();
            if (src && /pinimg\.com\/\d+x\//i.test(src)) {
              originalUrl = src.replace(
                /^(https?:\/\/[^/]*pinimg\.com\/)\d+x\//i,
                '$1originals/'
              );
            }
          }
          originalUrl = resolveAbsoluteImageUrl(originalUrl);
          if (originalUrl && /^https?:\/\//i.test(originalUrl)) {
            return {
              image: {
                url: originalUrl,
                width: 0,
                height: 0,
              },
              usedCustomLogic: true,
            };
          }
        } catch (e) {
          // URL extraction failed — fall through to generic logic
        }
      }
    }

    const rootFontSize = getRootFontSizePx();
    const viewportBasedSize = Math.max(0, Number(window?.innerWidth || 0) * 0.03);
    // === PHASE20_HOTFIX_ROOTFONT_CAP ===
    // Cap rootFontSize at 16 (web standard) when computing min content size.
    // Mirrors itemDetector.js hotfix v10. Some pages (e.g., Temu mobile) set
    // <html style="font-size: 100px"> as a viewport-scaling trick, which would
    // otherwise inflate `rootFontSize * 2` to 200 and wrongly reject 184×184
    // product images at clip time, causing favicon fallback.
    const cappedRootFontSize = Math.min(rootFontSize, 16);
    const minContentSize = Math.max(cappedRootFontSize * 2, 32, viewportBasedSize);
    // === END PHASE20_HOTFIX_ROOTFONT_CAP ===
    const getBackgroundImageUrl = (el) => {
      try {
        const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        const bg = String(cs?.backgroundImage || '').trim();
        if (!bg || bg === 'none') return '';
        const m = bg.match(/url\((['"]?)(.*?)\1\)/i);
        // === PHASE_IMAGE_URL_PIPELINE ===
        return resolveAbsoluteImageUrl(String(m?.[2] || '').trim());
        // === END PHASE_IMAGE_URL_PIPELINE ===
      } catch (e) {
        return '';
      }
    };
    const getEffectiveImageRect = (img) => {
      const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
      if (r && (r.width < 10 || r.height < 10) && img.parentElement) {
        const pr = img.parentElement.getBoundingClientRect
          ? img.parentElement.getBoundingClientRect()
          : null;
        if (pr && pr.width >= 10 && pr.height >= 10) return pr;
      }
      return r;
    };

    const isVisuallySignificantImage = (r) => {
      try {
        if (!r) return false;
        const width = Math.max(0, Number(r.width || 0));
        const height = Math.max(0, Number(r.height || 0));
        const ratio = height > 0 ? width / height : Number.POSITIVE_INFINITY;
        const passSize = width >= minContentSize && height >= minContentSize;
        const passRatio = ratio >= 0.2 && ratio <= 5.0;
        if (!(passSize && passRatio)) return false;
        // Viewport visibility: rect center must be inside the viewport.
        // This excludes off-screen carousel slides (e.g., Instagram's
        // hidden slides) so that only the user-visible image wins.
        const vw = Math.max(0, Number(window?.innerWidth || 0));
        const vh = Math.max(0, Number(window?.innerHeight || 0));
        if (vw <= 0 || vh <= 0) return true;
        const centerX = r.left + width / 2;
        const centerY = r.top + height / 2;
        const passViewport =
          centerX >= 0 && centerX < vw && centerY >= 0 && centerY < vh;
        if (!passViewport) return false;
        // === PHASE20_HOTFIX_CAROUSEL_INSIDE_CARD ===
        // coreItem-rect inside check: the image's center must lie inside the
        // coreItem's bounding rect. This handles side-stacked carousel layouts
        // (e.g., Temu's hover-swap image positioned next to the visible image)
        // where ALL images pass the viewport check but only the user-visible
        // image is inside the card. Instagram's off-screen-slide pattern is
        // already handled by the platform-specific logic above; this check
        // adds protection for non-Instagram side-stacked layouts.
        const coreRect = coreItem?.getBoundingClientRect?.();
        if (coreRect && coreRect.width > 0 && coreRect.height > 0) {
          const insideCard =
            centerX >= coreRect.left && centerX <= coreRect.right &&
            centerY >= coreRect.top && centerY <= coreRect.bottom;
          if (!insideCard) return false;
        }
        // === END PHASE20_HOTFIX_CAROUSEL_INSIDE_CARD ===
        return true;
      } catch (e) {
        return false;
      }
    };

    const imgNodes = Array.from(coreItem.querySelectorAll('img[src]'));
    const bgNodes = Array.from(coreItem.querySelectorAll('[style*="background-image"]'));

    let best = null;
    let bestArea = 0;
    for (const img of imgNodes) {
      const r = getEffectiveImageRect(img);
      if (!isVisuallySignificantImage(r)) continue;
      const src = resolveAbsoluteImageUrl(img.getAttribute('src') || img.currentSrc || img.src);
      if (!src) continue;
      // Skip profile/avatar images — "profile_images" in the URL path is
      // a reliable cross-platform signal that the image is a user avatar,
      // not post content.
      if (src.includes('profile_images')) continue;
      const area = r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
      if (area > bestArea) {
        bestArea = area;
        best = { url: src, width: Math.round(r?.width || 0), height: Math.round(r?.height || 0) };
      }
    }
    for (const node of bgNodes) {
      if (!isVisuallySignificantImage(node.getBoundingClientRect ? node.getBoundingClientRect() : null)) continue;
      const src = getBackgroundImageUrl(node);
      if (!src) continue;
      // Skip profile/avatar images — same rule applied to imgNodes loop.
      if (src.includes('profile_images')) continue;
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      const area = r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
      if (area > bestArea) {
        bestArea = area;
        best = { url: src, width: Math.round(r?.width || 0), height: Math.round(r?.height || 0) };
      }
    }
    // Reddit fallback: use shreddit-player poster when generic img/background extraction fails.
    if (!best && platform === SUPPORTED_PLATFORMS.REDDIT) {
      const player = coreItem.querySelector?.('shreddit-player[poster]') || null;
      const rawPoster = String(player?.getAttribute?.('poster') || '').trim();
      if (rawPoster) {
        let normalizedPoster = rawPoster;
        try {
          normalizedPoster = new URL(rawPoster, 'https://www.reddit.com').href;
        } catch (e) {}
        if (normalizedPoster) {
          best = { url: normalizedPoster, width: 0, height: 0 };
          return { image: best, usedCustomLogic: true };
        }
      }
    }
    return { image: best, usedCustomLogic: false };
  } catch (e) {
    return { image: null, usedCustomLogic: false };
  }
}

function isStructurallyIdentical(el1, el2) {
  try {
    if (!el1 || !el2 || el1.nodeType !== 1 || el2.nodeType !== 1) return false;
    if (String(el1.tagName || '').toUpperCase() !== String(el2.tagName || '').toUpperCase()) return false;

    const cls1 = new Set(String(el1.className || '').split(/\s+/).map((t) => t.trim()).filter(Boolean));
    const cls2 = new Set(String(el2.className || '').split(/\s+/).map((t) => t.trim()).filter(Boolean));
    if (cls1.size !== cls2.size) return false;
    for (const token of cls1) {
      if (!cls2.has(token)) return false;
    }

    const MAX_DEPTH = 40;
    const TOP_DEPTH_FOCUS = 5;
    const EXCLUDED_TAGS = new Set(['TEMPLATE', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'META', 'LINK']);
    const shouldExcludeNode = (node) => {
      if (!node || node.nodeType !== 1) return true;
      const tag = String(node.tagName || '').toUpperCase();
      if (EXCLUDED_TAGS.has(tag)) return true;
      if (node.hasAttribute?.('hidden')) return true;
      if (String(node.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') return true;

      const tagLower = String(node.tagName || '').toLowerCase();
      if (tagLower.includes('dom-if') || tagLower.includes('dom-repeat')) return true;

      const marker = [
        String(node.getAttribute?.('is') || ''),
        String(node.getAttribute?.('role') || ''),
        String(node.getAttribute?.('aria-role') || ''),
        String(node.getAttribute?.('data-role') || ''),
        String(node.className || ''),
        String(node.id || ''),
      ]
        .join(' ')
        .toLowerCase();

      if (/dom-if|dom-repeat/.test(marker)) return true;
      if (/(tooltip|popover|popup|overlay|dialog|modal|helper)\b/.test(marker)) return true;
      return false;
    };
    const toTag = (node) => String(node?.tagName || '').toUpperCase();
    const isContainerTag = (node) => {
      const t = toTag(node);
      return t === 'DIV' || t === 'SPAN';
    };
    const elementChildren = (node) => Array.from(node?.children || []).filter((c) => c && c.nodeType === 1);
    const flattenContainerChain = (node) => {
      let cur = node;
      let collapsed = 0;
      while (cur && isContainerTag(cur)) {
        const eligible = elementChildren(cur).filter((c) => !shouldExcludeNode(c));
        if (eligible.length === 1 && isContainerTag(eligible[0])) {
          cur = eligible[0];
          collapsed += 1;
          continue;
        }
        break;
      }
      return { node: cur, collapsed };
    };
    const buildStructuralSequence = (root) => {
      const seq = [];
      const pushNode = (node, depth) => {
        if (!node || node.nodeType !== 1 || depth > MAX_DEPTH) return;
        if (shouldExcludeNode(node)) {
          const kids = elementChildren(node);
          for (const k of kids) pushNode(k, depth);
          return;
        }
        const { node: flatNode, collapsed } = flattenContainerChain(node);
        if (!flatNode || shouldExcludeNode(flatNode)) {
          const kids = elementChildren(node);
          for (const k of kids) pushNode(k, depth);
          return;
        }
        const kids = elementChildren(flatNode).filter((c) => !shouldExcludeNode(c));
        seq.push({
          tag: collapsed > 0 ? 'CONTAINER' : toTag(flatNode),
          depth,
          isLeaf: kids.length === 0,
        });
        for (const k of elementChildren(flatNode)) pushNode(k, depth + 1);
      };
      for (const child of elementChildren(root)) pushNode(child, 1);
      return seq;
    };
    const weightOf = (entry) => {
      if (!entry) return 0;
      let w = entry.depth <= TOP_DEPTH_FOCUS ? 1 : 0.35;
      if (entry.depth > TOP_DEPTH_FOCUS && entry.tag === 'SPAN') w *= 0.6;
      if (entry.depth > TOP_DEPTH_FOCUS && entry.isLeaf) w *= 0.6;
      return w;
    };
    const trailingLeafWeight = (entries, weights) => {
      let sum = 0;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (!entries[i].isLeaf) break;
        sum += weights[i];
      }
      return sum;
    };

    const aEntries = buildStructuralSequence(el1);
    const bEntries = buildStructuralSequence(el2);
    const maxLen = Math.max(aEntries.length, bEntries.length);
    if (maxLen === 0) return true;

    const aWeights = aEntries.map(weightOf);
    const bWeights = bEntries.map(weightOf);
    const a = aEntries.map((e) => e.tag);
    const b = bEntries.map((e) => e.tag);
    const m = b.length;
    let prev = new Array(m + 1).fill(0);
    let curr = new Array(m + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        if (a[i - 1] === b[j - 1]) {
          const matchWeight = (aWeights[i - 1] + bWeights[j - 1]) / 2;
          curr[j] = Math.max(prev[j], curr[j - 1], prev[j - 1] + matchWeight);
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
      curr.fill(0);
    }
    const weightedLcs = prev[m] || 0;
    const sumA = aWeights.reduce((acc, n) => acc + n, 0);
    const sumB = bWeights.reduce((acc, n) => acc + n, 0);
    const longer = Math.max(sumA, sumB);
    const diff = Math.abs(sumA - sumB);
    const tailTolerance = Math.min(
      diff,
      Math.max(trailingLeafWeight(aEntries, aWeights), trailingLeafWeight(bEntries, bWeights)) * 0.8
    );
    const denom = Math.max(0.0001, longer - tailTolerance);
    const similarityRatio = weightedLcs / denom;
    const result = similarityRatio >= 0.9;
    return result;
  } catch (e) {
    return false;
  }
}

function resolveAnchorUrlRelaxed(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1 || !anchor.matches?.('a[href]')) return null;
    const rawAttr = String(anchor.getAttribute?.('href') || '').trim();
    if (!rawAttr || rawAttr.startsWith('#')) return null;
    if (!/^(https?:\/\/|\/\/)/i.test(rawAttr)) return null;
    if (!isVisuallySignificant(anchor)) return null;
    const u = new URL(rawAttr, window.location.href);
    if (!/^https?:$/i.test(u.protocol)) return null;
    const anchorBase = getBaseDomain(u.hostname);
    const currentBase = getBaseDomain(window.location.hostname || '');
    if (anchorBase && currentBase && anchorBase === currentBase) return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

function getRoleLinkHref(el) {
  if (!el || el.nodeType !== 1) return '';
  // Try common URL-bearing data attributes in priority order
  return (
    String(el.getAttribute?.('data-href')     || '').trim() ||
    String(el.getAttribute?.('data-url')      || '').trim() ||
    String(el.getAttribute?.('data-link')     || '').trim() ||
    String(el.getAttribute?.('data-href-url') || '').trim()
  );
}

/**
 * Resolves the URL from a role="link" element (data-href, data-url, etc.).
 * Returns absolute URL string or null.
 */
function resolveRoleLinkUrl(el) {
  try {
    if (!el || el.nodeType !== 1) return null;
    if (el.getAttribute?.('role') !== 'link') return null;
    const raw = getRoleLinkHref(el);
    if (!raw) return null;
    const u = new URL(raw, window.location.href);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function isValidAnchor(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1 || !anchor.matches?.('a[href]')) return false;
    return !!resolveAnchorUrl(anchor) && isVisuallySignificant(anchor);
  } catch (e) {
    return false;
  }
}

function findImagesDeep(root) {
  const seen = new WeakSet();
  const out = [];
  const MAX_DEPTH = 20;
  function collect(node, depth) {
    if (!node || depth > MAX_DEPTH) return;
    try {
      const imgs = Array.from(node.querySelectorAll?.('img') || []);
      for (const img of imgs) {
        if (!seen.has(img)) {
          seen.add(img);
          out.push(img);
        }
      }
      const descendants = Array.from(node.querySelectorAll?.('*') || []);
      for (const el of descendants) {
        if (el.shadowRoot) {
          collect(el.shadowRoot, depth + 1);
        }
      }
    } catch (e) {}
  }
  if (root && (root.nodeType === 1 || root.nodeType === 11)) {
    collect(root, 0);
  }
  return out;
}

async function isImgVisuallySignificantForAnchor(img) {
  try {
    if (!img || String(img?.tagName || '').toUpperCase() !== 'IMG' || !img.getBoundingClientRect) return false;
    if (img.decode && typeof img.decode === 'function') {
      await img.decode().catch(() => {});
    }
    const rootFontSize = getRootFontSizePx();
    const viewportBasedSize = Math.max(0, Number(window?.innerWidth || 0) * 0.03);
    // === PHASE20_HOTFIX_ROOTFONT_CAP ===
    // Cap rootFontSize at 16 — same rationale as in extractImageFromCoreItem.
    // The 48 floor is preserved (stricter than the 32 floor used elsewhere
    // because anchor validation should reject smaller candidates).
    const cappedRootFontSize = Math.min(rootFontSize, 16);
    const minContentSize = Math.max(cappedRootFontSize * 2, 48, viewportBasedSize);
    // === END PHASE20_HOTFIX_ROOTFONT_CAP ===
    const r = img.getBoundingClientRect();
    if (!r) return false;
    const layoutWidth = Math.max(0, Number(r.width || 0));
    const layoutHeight = Math.max(0, Number(r.height || 0));
    const naturalWidth = Math.max(0, Number(img.naturalWidth || 0));
    const naturalHeight = Math.max(0, Number(img.naturalHeight || 0));
    const width = Math.max(layoutWidth, naturalWidth);
    const height = Math.max(layoutHeight, naturalHeight);
    const ratio = height > 0 ? width / height : Number.POSITIVE_INFINITY;
    const passSize = width >= minContentSize && height >= minContentSize;
    const passRatio = ratio >= 0.2 && ratio <= 5.0;
    return passSize && passRatio;
  } catch (e) {
    return false;
  }
}

export async function isValidImageAnchor(anchor) {
  try {
    if (!anchor || anchor.nodeType !== 1 || !anchor.matches?.('a[href]')) return false;
    const url = resolveAnchorUrl(anchor);
    if (!url) return false;
    const rawHref = String(anchor.getAttribute?.('href') || '').trim();

    // Fast-pass: explicitly absolute URL
    if (/^(https?:\/\/|\/\/)/i.test(rawHref)) return true;

    // Fast-pass: same-origin relative path with meaningful depth
    // Accepts paths like /rooms/123, /products/abc?q=1
    // Rejects bare fragments (#), mailto:, javascript:, and very short paths
    if (rawHref.startsWith('/') && rawHref.length > 1 && !/^\/\s*$/.test(rawHref)) {
      try {
        const resolved = new URL(rawHref, window.location.href);
        const current  = new URL(window.location.href);
        // Must be same origin
        if (resolved.origin === current.origin) {
          // Must have a pathname with at least one real segment (not just "/").
          // Skip functional URLs (e.g. comment permalinks, search pages) so
          // that isFunctionalUrl() exclusions are honoured by this fast-pass.
          const pathname = resolved.pathname.replace(/\/$/, '');
          if (pathname.length > 1 && !isFunctionalUrl(resolved.href)) return true;
        }
      } catch { /* fall through to image check */ }
    }

    const imgs = findImagesDeep(anchor);
    for (const img of imgs) {
      if (await isImgVisuallySignificantForAnchor(img)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

export async function resolveCoreItemFromImageAnchor(itemMapElement, hoveredTarget = null, itemMapElements = null) {
  try {
    if (!itemMapElement || itemMapElement.nodeType !== 1) return itemMapElement;
    const anchor =
      hoveredTarget?.matches?.('a[href]') ? hoveredTarget : hoveredTarget?.closest?.('a[href]');
    const contained = anchor && itemMapElement.contains?.(anchor);
    const validSignal = anchor && contained && (await isValidImageAnchor(anchor));
    const closestAtag = validSignal ? anchor : null;
    if (!closestAtag) return itemMapElement;

    const primaryUrl = resolveAnchorUrl(closestAtag) || resolveAnchorUrlRelaxed(closestAtag);
    const primaryHostname = primaryUrl ? toComparableHost(primaryUrl) : '';
    if (!primaryHostname) return itemMapElement;

    const siblingContainsValidOtherAtag = (node) => {
      try {
        if (!node || node.nodeType !== 1) return false;
        const anchors = [];
        if (node.matches?.('a[href]')) anchors.push(node);
        anchors.push(...Array.from(node.querySelectorAll?.('a[href]') || []));
        for (const a of anchors) {
          if (a === closestAtag || closestAtag.contains?.(a)) continue;
          const resolveMain = resolveAnchorUrl(a);
          const resolveRelaxed = resolveAnchorUrlRelaxed(a);
          if (!resolveMain || !resolveRelaxed) continue;
          const u = normalizeText(resolveMain);
          if (!u) continue;
          const candidateHostname = toComparableHost(u);
          if (!candidateHostname || candidateHostname === primaryHostname) continue;
          if (!isVisuallySignificant(a)) continue;
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    };

    const siblingIsOrContainsItemMap = (node) => {
      try {
        if (!itemMapElements || !(itemMapElements instanceof Set)) return false;
        if (!node || node.nodeType !== 1) return false;
        if (itemMapElements.has(node)) return true;
        for (const el of itemMapElements) {
          if (el && node.contains?.(el) && el !== node) return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    };

    let currentParent = closestAtag.parentElement;
    let climbLevel = 0;
    while (currentParent && itemMapElement.contains?.(currentParent)) {
      climbLevel += 1;
      const childWithClosest = Array.from(currentParent.children || []).find(
        (c) => c && (c === closestAtag || c.contains?.(closestAtag))
      );
      const siblings = Array.from(currentParent.children || []).filter((c) => c && c !== childWithClosest);

      let hasOtherAtag = false;
      let hasStructuralIdentity = false;
      let hasItemMapSibling = false;

      for (const sib of siblings) {
        const otherAtagResult = siblingContainsValidOtherAtag(sib);
        const itemMapSiblingHit = !otherAtagResult && siblingIsOrContainsItemMap(sib);
        const structuralMatch =
          !otherAtagResult && !itemMapSiblingHit && childWithClosest
            ? isStructurallyIdentical(childWithClosest, sib)
            : false;
        if (otherAtagResult) {
          hasOtherAtag = true;
          break;
        }
        if (itemMapSiblingHit) {
          hasItemMapSibling = true;
          break;
        }
        if (structuralMatch) {
          hasStructuralIdentity = true;
          break;
        }
      }

      if (hasOtherAtag || hasItemMapSibling || hasStructuralIdentity) {
        const coreItem = childWithClosest || closestAtag;
        return coreItem;
      }

      if (currentParent === itemMapElement) break;
      currentParent = currentParent.parentElement;
    }
    return itemMapElement;
  } catch (e) {
    return itemMapElement;
  }
}

/**
 * Parse a URL string and return the YouTube video shortcode if and only if
 * the URL is a recognized YouTube video or Shorts URL. Returns null otherwise.
 *
 * Handles:
 *   - https://www.youtube.com/watch?v={11-char-id}
 *   - https://youtube.com/watch?v={11-char-id}
 *   - https://m.youtube.com/watch?v={11-char-id}
 *   - https://music.youtube.com/watch?v={11-char-id}
 *   - https://www.youtube.com/shorts/{11-char-id}
 *   - https://www.youtube.com/embed/{11-char-id}
 *   - https://youtu.be/{11-char-id}
 *
 * The 11-character shortcode must match /^[a-zA-Z0-9_-]{11}$/.
 */
export function extractYouTubeShortcodeFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname;
    const shortcodeRegex = /^[a-zA-Z0-9_-]{11}$/;

    // youtu.be/{id}[/...]
    if (host === 'youtu.be') {
      const m = path.match(/^\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
      return m ? m[1] : null;
    }

    // youtube.com family
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (path === '/watch') {
        const v = u.searchParams.get('v');
        return v && shortcodeRegex.test(v) ? v : null;
      }
      const shortsMatch = path.match(/^\/shorts\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = path.match(/^\/embed\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
      if (embedMatch) return embedMatch[1];
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Build the canonical YouTube thumbnail URL for a shortcode.
 * Returns hqdefault.jpg (480×360, 4:3) which YouTube guarantees exists for
 * every public video. We intentionally avoid maxresdefault.jpg because it
 * is not generated for every video and YouTube's 404 response serves a
 * valid 120×90 JPEG body — which silently renders as a tiny gray image
 * that cannot be detected via img.onerror in the browser.
 */
export function getYouTubeThumbnailUrl(shortcode) {
  if (!shortcode || typeof shortcode !== 'string') return '';
  if (!/^[a-zA-Z0-9_-]{11}$/.test(shortcode)) return '';
  return `https://img.youtube.com/vi/${shortcode}/hqdefault.jpg`;
}

export const SUPPORTED_PLATFORMS = {
  INSTAGRAM: 'INSTAGRAM',
  X_TWITTER: 'X_TWITTER',
  REDDIT: 'REDDIT',
  UNKNOWN: 'UNKNOWN',
};

const PLATFORMS_WITH_CUSTOM_IMAGE_LOGIC = new Set([
  SUPPORTED_PLATFORMS.REDDIT,
  SUPPORTED_PLATFORMS.INSTAGRAM,
]);

const PLATFORMS_WITH_CUSTOM_TITLE_LOGIC = new Set([
  SUPPORTED_PLATFORMS.INSTAGRAM,
]);

export function hasCustomImageLogic(platform) {
  return platform && PLATFORMS_WITH_CUSTOM_IMAGE_LOGIC.has(platform);
}

export function hasCustomTitleLogic(platform) {
  return platform && PLATFORMS_WITH_CUSTOM_TITLE_LOGIC.has(platform);
}

export function getCurrentPlatform() {
  try {
    const rawHost = String(window?.location?.hostname || '').toLowerCase().trim();
    if (!rawHost) return SUPPORTED_PLATFORMS.UNKNOWN;

    const normalizeHost = (host) => {
      let h = String(host || '').toLowerCase().trim();
      // Normalize common mobile/web prefixes for robust domain matching.
      h = h.replace(/^(?:www|m)\./, '');
      return h;
    };
    const host = normalizeHost(rawHost);
    const DOMAIN_PLATFORM_MAP = {
      'instagram.com': SUPPORTED_PLATFORMS.INSTAGRAM,
      'x.com': SUPPORTED_PLATFORMS.X_TWITTER,
      'twitter.com': SUPPORTED_PLATFORMS.X_TWITTER,
      'reddit.com': SUPPORTED_PLATFORMS.REDDIT,
    };
    if (DOMAIN_PLATFORM_MAP[host]) return DOMAIN_PLATFORM_MAP[host];

    // Fallback for subdomains (e.g., help.instagram.com, old.reddit.com).
    for (const [domain, platform] of Object.entries(DOMAIN_PLATFORM_MAP)) {
      if (host.endsWith(`.${domain}`)) return platform;
    }
    return SUPPORTED_PLATFORMS.UNKNOWN;
  } catch (e) {
    return SUPPORTED_PLATFORMS.UNKNOWN;
  }
}

export function normalizeShortcodeExtractionResult(result, platform = '') {
  const p = String(platform || '').toUpperCase().trim();
  if (!result) return { shortcode: '', activeHoverUrl: '', imageUrl: '', title: '', username: '' };
  if (typeof result === 'string') {
    return { shortcode: String(result).trim(), activeHoverUrl: '', imageUrl: '', title: '', username: '' };
  }
  if (typeof result === 'object') {
    const shortcode = String(result?.shortcode || '').trim();
    const activeHoverUrl = String(result?.activeHoverUrl || '').trim();
    const imageUrl = String(result?.imageUrl || '').trim();
    const title = String(result?.title || '').trim();
    const username = String(result?.username || '').trim();
    return { shortcode, activeHoverUrl, imageUrl, title, username };
  }
  return { shortcode: '', activeHoverUrl: '', imageUrl: '', title: '', username: '' };
}

// ── Instagram shortcode proactive cache (WeakMap: article element → shortcode) ──
const _igShortcodeCache = new WeakMap();
const _igArticleObservers = new WeakMap();

const _IG_POST_PATTERNS = [/\/p\/([A-Za-z0-9_-]+)/i, /\/reels?\/([A-Za-z0-9_-]+)/i];
const _IG_SKIP_SEGMENTS = new Set(['audio', 'explore', 'stories', 'highlights', 'tv', 'live', 'ar', 'location']);

function _igExtractShortcodeFromArticle(article) {
  const anchors = Array.from(article.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const raw = String(a.getAttribute('href') || '').trim();
    for (const re of _IG_POST_PATTERNS) {
      const m = raw.match(re);
      if (m && m[1] && !_IG_SKIP_SEGMENTS.has(m[1].toLowerCase())) {
        return String(m[1]).trim();
      }
    }
  }
  return null;
}

function _igObserveArticle(article) {
  if (!article || article.nodeType !== 1) return;
  if (_igShortcodeCache.has(article)) return;
  if (_igArticleObservers.has(article)) return;

  const obs = new MutationObserver(() => {
    const shortcode = _igExtractShortcodeFromArticle(article);
    if (shortcode) {
      _igShortcodeCache.set(article, shortcode);
      obs.disconnect();
      _igArticleObservers.delete(article);
    }
  });
  obs.observe(article, { childList: true, subtree: true });
  _igArticleObservers.set(article, obs);
}

export function mountInstagramShortcodeObserver() {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (getCurrentPlatform() !== SUPPORTED_PLATFORMS.INSTAGRAM) return;

    const existing = Array.from(document.querySelectorAll('article'));
    for (const article of existing) {
      const shortcode = _igExtractShortcodeFromArticle(article);
      if (shortcode) {
        _igShortcodeCache.set(article, shortcode);
      } else {
        _igObserveArticle(article);
      }
    }

    const feedObs = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          const articles = node.matches?.('article')
            ? [node]
            : Array.from(node.querySelectorAll?.('article') || []);
          for (const article of articles) {
            if (_igShortcodeCache.has(article)) continue;
            const shortcode = _igExtractShortcodeFromArticle(article);
            if (shortcode) {
              _igShortcodeCache.set(article, shortcode);
            } else {
              _igObserveArticle(article);
            }
          }
        }
      }
    });

    const root = document.documentElement || document.body;
    feedObs.observe(root, { childList: true, subtree: true });
  } catch (e) {}
}

function extractInstagramShortcode(element) {
  try {
    if (!element || element.nodeType !== 1) return null;

    const article = element.closest?.('article') || element.querySelector?.('article');
    if (article && _igShortcodeCache.has(article)) {
      return _igShortcodeCache.get(article);
    }

    const anchors = [];
    if (element.matches?.('a[href]')) anchors.push(element);
    anchors.push(...Array.from(element.querySelectorAll?.('a[href]') || []));
    for (const a of anchors) {
      const raw = String(a.getAttribute?.('href') || a.href || '').trim();
      for (const re of _IG_POST_PATTERNS) {
        const m = raw.match(re);
        if (m && m[1] && !_IG_SKIP_SEGMENTS.has(m[1].toLowerCase())) {
          const shortcode = String(m[1]).trim();
          if (article) _igShortcodeCache.set(article, shortcode);
          return shortcode;
        }
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

function extractXTwitterShortcode(element) {
  try {
    if (!element || element.nodeType !== 1) return null;
    // The analytics link href="/{username}/status/{id}/analytics" is
    // the most reliable post URL source inside a tweet card.
    // It is present on both regular and ad cards.
    const STATUS_ANALYTICS_RE = /^\/([^/]+)\/status\/(\d+)\/analytics$/i;
    const anchors = Array.from(element.querySelectorAll?.('a[href]') || []);
    for (const a of anchors) {
      const href = String(a.getAttribute?.('href') || '').trim();
      const m = STATUS_ANALYTICS_RE.exec(href);
      if (!m) continue;
      const username  = m[1];
      const statusId  = m[2];
      const activeHoverUrl =
        `https://x.com/${username}/status/${statusId}`;
      return {
        shortcode:      statusId,
        activeHoverUrl,
        username,
        platform:       'X_TWITTER',
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}
function extractRedditShortcode(_element) { return null; }

const PLATFORM_CONFIG = {
  [SUPPORTED_PLATFORMS.INSTAGRAM]: extractInstagramShortcode,
  [SUPPORTED_PLATFORMS.X_TWITTER]: extractXTwitterShortcode,
  [SUPPORTED_PLATFORMS.REDDIT]: extractRedditShortcode,
};

export function extractShortcode(element) {
  try {
    if (!element || element.nodeType !== 1) return null;
    const platform = getCurrentPlatform();
    const extractor = PLATFORM_CONFIG[platform];
    if (!extractor) return null;
    return extractor(element);
  } catch (e) {
    return null;
  }
}

export function extractMetadataForCoreItem(coreItem, closestAtag = null, hoveredTarget = null, cacheOverrides = null, evidenceType = '') {
  try {
    if (!coreItem || coreItem.nodeType !== 1) return null;
    let activeHoverUrl = null;
    if (closestAtag && (coreItem === closestAtag || coreItem.contains?.(closestAtag))) {
      activeHoverUrl = normalizeText(resolveAnchorUrl(closestAtag) || resolveAnchorUrlRelaxed(closestAtag) || '');
    }
    if (!activeHoverUrl) {
      const candidates = getSortedAnchorCandidatesInItemMap(coreItem, hoveredTarget)
        .filter((a) => coreItem === a || coreItem.contains(a));
      for (let i = 0; i < candidates.length; i += 1) {
        const a = candidates[i];
        const resolved = resolveAnchorUrl(a) || resolveAnchorUrlRelaxed(a);
        if (!resolved) continue;
        activeHoverUrl = resolved;
        if (i > 0) {
          /* Metadata recovery: using secondary anchor */
        }
        break;
      }
    }
    // Fallback: coreItem itself or a descendant uses role="link" + URL data attrs
    if (!activeHoverUrl) {
      const roleLinkCandidates = [
        coreItem,
        ...Array.from(coreItem.querySelectorAll?.('[role="link"]') || [])
          .filter((el) => !!getRoleLinkHref(el)),
      ];
      for (const el of roleLinkCandidates) {
        const resolved = resolveRoleLinkUrl(el);
        if (resolved) {
          activeHoverUrl = resolved;
          break;
        }
      }
    }

// === PHASE_PLACEHOLDER_HREF_PAGE_URL_FALLBACK ===
// SPA grids (Canva templates, etc.) often wrap clickable tiles in
// <a href="#"> with a JS click handler that mutates router state.
// resolveAnchorUrl / resolveAnchorUrlRelaxed correctly reject these
// for dedup safety, but that leaves Type D extraction with no
// activeHoverUrl and aborts activation. Pattern scope is narrow:
// exact "#" only. Fragment anchors (#section), javascript:*, and
// missing-href anchors are intentionally NOT covered (legitimate
// in-page navigation or other intent). Falls back to the current
// page URL so the image can still be clipped; the dedup key is
// (page URL + image URL), which keeps multiple cards on the same
// page distinct via their distinct image URLs.
    if (!activeHoverUrl) {
      const placeholderCandidates = [
        closestAtag,
        ...getSortedAnchorCandidatesInItemMap(coreItem, hoveredTarget)
          .filter((a) => coreItem === a || coreItem.contains?.(a)),
      ];
      for (const a of placeholderCandidates) {
        if (!a || a.nodeType !== 1) continue;
        const rawAttr = String(a.getAttribute?.('href') || '').trim();
        if (rawAttr === '#') {
          activeHoverUrl = window.location.href;
          break;
        }
      }
    }
// === END PHASE_PLACEHOLDER_HREF_PAGE_URL_FALLBACK ===

    if (!activeHoverUrl) return null;

    let image;
    let imageIsCustom = false;
    // === PHASE_IMAGE_FROM_DOMINANT_PRIORITY ===
    // Branch order: Type B/D fresh dominant FIRST, then cachedImage,
    // then generic. Rationale: cachedImage (from typeBEntry.cachedMetadata
    // at scan time) freezes meta.image to the scan-time slide on Instagram
    // carousels — refresh re-runs but the cache path wins. Reordering so
    // findDominantImagesInElement runs on every refresh for Type B/D
    // restores per-slide tracking. cachedTitle (separate branch below)
    // remains: caption is post-level, not slide-level.
    if (evidenceType === 'B' || evidenceType === 'D') {
      // Dominant <img> based: meta.image follows the same predicate
      // (findDominantImagesInElement → isImageDominantInCoreItem) used
      // for seedImages and overlay. seedImages is typically 1 element
      // (center-X tolerance is tight). Empty set → image: null.
      const dominantImgs = findDominantImagesInElement(coreItem);
      const dominantImg = dominantImgs.values().next().value || null;
      if (dominantImg) {
        // === PHASE_VIDEO_CLIP_TYPE_BD ===
        // Branch on dominant element type. <video> uses the poster URL
        // when available; canvas first-frame capture happens later in
        // the clipboard pipeline (coreEntry videoElementToBlob). When
        // no poster, url is '' — the metadata still records the video's
        // layout dimensions so consumers can render placeholder UI, and
        // the clipboard pipeline still attempts canvas capture.
        const dominantTag = String(dominantImg.tagName || '').toUpperCase();
        if (dominantTag === 'VIDEO' || dominantTag === 'SHREDDIT-PLAYER') {
          const info = extractVideoMediaInfo(dominantImg);
          const r = dominantImg.getBoundingClientRect?.();
          const width = info?.width || Math.round(r?.width || 0);
          const height = info?.height || Math.round(r?.height || 0);
          if (width > 0 && height > 0) {
            image = {
              // Always '' — see extractImageFromCoreItem VIDEO branch
              // for the rationale. The clip-time img_url is produced
              // from videoElementToBlobAndDataUrl in coreEntry.
              url: '',
              width,
              height,
            };
            imageIsCustom = true;
          } else {
            image = null;
          }
        } else {
          const r = dominantImg.getBoundingClientRect?.();
          const src = resolveClipImageUrl(coreItem, dominantImg);
          if (src && r && r.width > 0 && r.height > 0) {
            image = {
              url: src,
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
            imageIsCustom = true;
          } else {
            image = null;
          }
        }
        // === END PHASE_VIDEO_CLIP_TYPE_BD ===
      } else {
        image = null;
      }
    } else if (cacheOverrides?.cachedImage?.usedCustomLogic && cacheOverrides.cachedImage.value != null) {
      image = cacheOverrides.cachedImage.value;
      imageIsCustom = true;
    } else {
      // Type E or unknown evidence type: preserve existing behavior.
      const imageResult = extractImageFromCoreItem(coreItem);
      image = imageResult?.image ?? imageResult;
      imageIsCustom = imageResult?.usedCustomLogic ?? false;
    }
    // === END PHASE_IMAGE_FROM_DOMINANT_PRIORITY ===

    const platform = getCurrentPlatform();
    const instagramCaption =
      platform === SUPPORTED_PLATFORMS.INSTAGRAM
        ? extractInstagramCaptionFromCoreItem(coreItem)
        : { status: 'not_found', extracted_text: '', text_length: 0 };
    const fullInstagramCaption =
      instagramCaption?.status === 'success' ? String(instagramCaption.extracted_text || '').trim() : '';
    const instagramUsername = String(instagramCaption?.username || '').trim();
    const instagramFirstLine = fullInstagramCaption
      ? String(fullInstagramCaption.split('\n').find((line) => String(line || '').trim()) || '').trim()
      : '';
    const truncatedInstagramTitle = instagramFirstLine
      ? (instagramFirstLine.length > 100
          ? `${instagramFirstLine.slice(0, 100).trimEnd()}...`
          : instagramFirstLine)
      : '';
    const instagramComposedTitle =
      instagramUsername && fullInstagramCaption
        ? `${instagramUsername}'s post\n${fullInstagramCaption}`
        : instagramUsername
          ? `${instagramUsername}'s post`
          : '';
    const genericTitle = extractTitleFromCoreItem(coreItem, activeHoverUrl);
    let title;
    let titleIsCustom = false;
    if (cacheOverrides?.cachedTitle?.usedCustomLogic && cacheOverrides.cachedTitle.value != null) {
      title = cacheOverrides.cachedTitle.value;
      titleIsCustom = true;
    } else {
      title =
        instagramComposedTitle ||
        fullInstagramCaption ||
        truncatedInstagramTitle ||
        String(genericTitle || '').trim() ||
        (platform === SUPPORTED_PLATFORMS.INSTAGRAM
          ? 'Instagram Post (No caption)'
          : null);
      titleIsCustom = !!(instagramComposedTitle || fullInstagramCaption);
    }
    const resolvedDescription =
      fullInstagramCaption ||
      (platform === SUPPORTED_PLATFORMS.INSTAGRAM
        ? 'Instagram Post (No caption)'
        : '');
    return {
      activeHoverUrl,
      title,
      description: resolvedDescription,
      content: resolvedDescription,
      caption: instagramCaption,
      image,
      imageIsCustom,
      titleIsCustom,
    };
  } catch (e) {
    return null;
  }
}

// ── Category detection (mirrors server-side detectCategoryAndType) ────────────

function _getCategoryBaseDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.replace(/^www\./, '').split('.');
    // Return only the second-to-last part (main domain name without TLD)
    // e.g. 'youtube.com' → 'youtube', 'google.com' → 'google'
    return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || '';
  } catch (e) {
    return '';
  }
}

export function detectItemCategory(savedUrl, pageUrl, htmlContext) {
  try {
    const fullUrlString = String(savedUrl || '').trim();
    const u = new URL(savedUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // ── Helper: Dominant media check ─────────────────────────────────────────
    // Returns 'Video' | 'Image' | '' based on htmlContext.
    // '' means no single media element dominates the CoreItem area.
    function getDominantMediaType() {
      if (!htmlContext) return '';
      try {
        const coreWidth  = Number(htmlContext?.boundingBox?.width)  || 0;
        const coreHeight = Number(htmlContext?.boundingBox?.height) || 0;
        if (coreWidth <= 0 || coreHeight <= 0) return '';
        const mediaItems = [
          ...(Array.isArray(htmlContext.images) ? htmlContext.images : []),
          ...(Array.isArray(htmlContext.videos) ? htmlContext.videos : []),
        ];
        for (const media of mediaItems) {
          const mw = Number(media?.width)  || 0;
          const mh = Number(media?.height) || 0;
          if (mw <= 0 || mh <= 0) continue;
          const widthRatio  = mw / coreWidth;
          const heightRatio = mh / coreHeight;
          if (
            (widthRatio >= 0.75 && heightRatio >= 0.4) ||
            (heightRatio >= 0.75 && widthRatio >= 0.4)
          ) {
            // Determine if the dominant element is a video
            const isDominantVideo = Array.isArray(htmlContext.videos) &&
              htmlContext.videos.some((v) => {
                const vw = Number(v?.width)  || 0;
                const vh = Number(v?.height) || 0;
                const wr = vw / coreWidth;
                const hr = vh / coreHeight;
                return (wr >= 0.75 && hr >= 0.4) || (hr >= 0.75 && wr >= 0.4);
              });
            return isDominantVideo ? 'Video' : 'Image';
          }
        }
      } catch (_) {}
      return '';
    }

    // ── Helper: savedUrl base domain ─────────────────────────────────────────
    function getSavedDomain() {
      return _getCategoryBaseDomain(savedUrl);
    }

    function getPageDomain() {
      return pageUrl ? _getCategoryBaseDomain(pageUrl) : '';
    }

    // ── Step 1: SNS ───────────────────────────────────────────────────────────
    // Detect SNS platform first (before any media check).
    let snsPlatform = '';
    if (host.includes('instagram.com')) {
      snsPlatform = 'Instagram';
    } else if (host.includes('x.com') || host.includes('twitter.com')) {
      snsPlatform = 'X';
    } else if (host.includes('reddit.com') && (path.includes('/r/') || path.includes('/user/'))) {
      snsPlatform = 'Reddit';
    }

    if (snsPlatform) {
      return {
        category: 'SNS',
        platform: snsPlatform,
      };
    }

    // ── Step 2: Dominant media check (non-SNS) ────────────────────────────────
    // BOTH dominant image AND dominant video classify as Image category.
    // KickClip's clip output for a dominant <video> is a still image artifact
    // (canvas frame data URL via videoElementToBlobAndDataUrl, or poster URL
    // fallback via PHASE_VIDEO_POSTER_FALLBACK on tainted canvas). The stored
    // payload's img_url / img_thumbnail_b64 are PNG data URLs, so categorizing
    // as 'Image' reflects what KickClip actually saves. getDominantMediaType()
    // still distinguishes 'Image' vs 'Video' internally — the flattening to
    // a single 'Image' category is a caller-side decision so future logic can
    // re-differentiate if needed.
    const dominantType = getDominantMediaType();
    if (dominantType === 'Image' || dominantType === 'Video') {
      return { category: 'Image', platform: getPageDomain() };
    }

    // ── Step 3: Same-origin URL-based ─────────────────────────────────────────
    // Only image file extensions classify as Image. Video extensions and video-host URLs
    // fall through to the null-category default.
    const savedDomain = getSavedDomain();
    const pageDomain  = pageUrl ? _getCategoryBaseDomain(pageUrl) : '';
    const sameOrigin  = !!savedDomain && !!pageDomain && savedDomain === pageDomain;

    if (sameOrigin) {
      if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(path)) {
        return { category: 'Image', platform: getPageDomain() };
      }
    }

    // ── Step 4: Weighted scoring ──────────────────────────────────────────────
    // Only scores toward IMAGE classification. Video signals are ignored.
    // A page reaches Image only when there is a clear, single image focus.
    {
      let score = 0;
      const mediaRatio = Number(htmlContext?.mediaRatio) || 0;
      if (mediaRatio > 0.7) score += 70;
      else if (mediaRatio > 0.5) score += 40;
      const imageCount = Number(htmlContext?.imageCount) || 0;
      const videoCount = Number(htmlContext?.videoCount) || 0;
      if (imageCount + videoCount === 1) score += 30;
      if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(path)) score += 20;
      if (imageCount + videoCount > 2) score -= 30;
      // Only Image category emerges from scoring. Presence of video does not help — scoring
      // is biased toward still-image pages. Classification reaches Image only if
      // videoCount === 0 AND score >= 100.
      if (score >= 100 && videoCount === 0) {
        return { category: 'Image', platform: getPageDomain() };
      }
    }

    // ── Step 5: Default — no recognized category ─────────────────────────────
    // KickClip now classifies only SNS and Image. Pages that match neither
    // return a null category, and downstream flows treat that as "no clip
    // target" (silent no-op gate is added in D3).
    return { category: null, platform: getSavedDomain() };
  } catch (e) {
    return { category: null, platform: '' };
  }
}
