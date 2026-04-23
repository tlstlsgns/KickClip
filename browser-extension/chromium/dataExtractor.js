/**
 * Data extraction and metadata logic for core items.
 * Handles URL resolution, title/image extraction, and Type A core item resolution.
 */

import { getOriginalUrl, resolveCached, cleanTrackingParams, isNavigationUrl, getUrlIntent } from './urlResolver.js';

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

function extractLinkedInCommentaryFromCoreItem(coreItem) {
  try {
    if (!coreItem || coreItem.nodeType !== 1) {
      return { status: 'not_found', extracted_text: '', text_length: 0 };
    }

    const feedRoot =
      (coreItem.matches?.('div[data-view-name="feed-full-update"]') ? coreItem : null) ||
      coreItem.closest?.('div[data-view-name="feed-full-update"]') ||
      coreItem.querySelector?.('div[data-view-name="feed-full-update"]') ||
      coreItem;

    const commentaryContainer =
      feedRoot.querySelector?.('p[data-view-name="feed-commentary"], div[data-view-name="feed-commentary"]') || null;
    if (!commentaryContainer) {
      return { status: 'not_found', extracted_text: '', text_length: 0 };
    }

    const targetTextBox =
      commentaryContainer.querySelector?.('span[data-testid="expandable-text-box"]') ||
      commentaryContainer.querySelector?.('[data-testid="expandable-text-box"]') ||
      commentaryContainer;
    if (!targetTextBox) {
      return { status: 'not_found', extracted_text: '', text_length: 0 };
    }

    const clone = targetTextBox.cloneNode(true);
    if (!clone || clone.nodeType !== 1) {
      return { status: 'not_found', extracted_text: '', text_length: 0 };
    }

    // Remove UI controls around expansion/translation before text extraction.
    const controlSelectors = [
      'button',
      '[role="button"]',
      'a[role="button"]',
      '[data-control-name*="expand"]',
      '[data-control-name*="translation"]',
      '[aria-label*="See more"]',
      '[aria-label*="See translation"]',
      '[aria-label*="더 보기"]',
      '[aria-label*="번역"]',
    ];
    for (const sel of controlSelectors) {
      const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
      for (const n of nodes) {
        try {
          n.remove();
        } catch (e) {}
      }
    }

    // Remove pure UI text nodes that can survive structural filtering.
    const uiOnlyLineRe = /^(see more|see translation|show more|show translation|더 보기|번역 보기|번역 보기:|번역)$/i;
    const raw = String(clone.innerText || clone.textContent || '');
    const lines = raw
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !!line && !uiOnlyLineRe.test(line));
    const extracted = lines.join('\n').trim();
    if (!extracted) {
      return { status: 'not_found', extracted_text: '', text_length: 0 };
    }
    return {
      status: 'success',
      extracted_text: extracted,
      text_length: extracted.length,
    };
  } catch (e) {
    return { status: 'not_found', extracted_text: '', text_length: 0 };
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

export function extractImageFromCoreItem(coreItem) {
  try {
    if (!coreItem || !coreItem.querySelectorAll) return null;
    const platform = getCurrentPlatform();
    if (platform === SUPPORTED_PLATFORMS.THREADS) {
      const toImgMeta = (img) => {
        try {
          if (!img || String(img.tagName || '').toUpperCase() !== 'IMG') return null;
          const src = String(img.getAttribute?.('src') || img.currentSrc || img.src || '').trim();
          if (!src) return null;
          const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
          const w = Math.round(Math.max(0, Number(r?.width || 0)));
          const h = Math.round(Math.max(0, Number(r?.height || 0)));
          if (w <= 0 || h <= 0) return null;
          return { url: src, width: w, height: h };
        } catch (e) {
          return null;
        }
      };
      const areaOf = (img) => {
        try {
          const r = img?.getBoundingClientRect ? img.getBoundingClientRect() : null;
          return r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
        } catch (e) {
          return 0;
        }
      };

      // Explicitly exclude avatar/profile region: profile link usually "/@user" without "/post/".
      const excludedImgSet = new Set();
      const profileAnchors = Array.from(coreItem.querySelectorAll('a[href^="/@"]') || [])
        .filter((a) => !/\/post\//i.test(String(a.getAttribute?.('href') || a.href || '')));
      for (const a of profileAnchors) {
        const imgs = Array.from(a.querySelectorAll?.('img') || []);
        for (const img of imgs) excludedImgSet.add(img);
      }
      const isExcluded = (img) => {
        try {
          if (!img || img.nodeType !== 1) return true;
          if (excludedImgSet.has(img)) return true;
          const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
          const area = r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
          if (area > 0 && area < 40 * 40) return true;
          return false;
        } catch (e) {
          return true;
        }
      };

      const pickLargestFromSelectors = (selectors) => {
        let bestImg = null;
        let bestArea = 0;
        for (const sel of selectors) {
          const nodes = Array.from(coreItem.querySelectorAll?.(sel) || []);
          for (const img of nodes) {
            if (String(img?.tagName || '').toUpperCase() !== 'IMG') continue;
            if (isExcluded(img)) continue;
            const a = areaOf(img);
            if (a > bestArea) {
              bestArea = a;
              bestImg = img;
            }
          }
        }
        return bestImg;
      };

      // Priority 1: media/content area (images/videos rendered in body).
      const mediaImg = pickLargestFromSelectors([
        'div[aria-label*="photo" i] img',
        'div[aria-label*="video" i] img',
        'div[role="button"] img',
        'div[class*="x1e56ztr"] img',
        'div[class*="x1xdureb"] img',
        'div[class*="xkbb5z"] img',
        'a[href*="/post/"] img',
      ]);
      if (mediaImg) return { image: toImgMeta(mediaImg), usedCustomLogic: true };

      // Priority 2: link preview area.
      const previewImg = pickLargestFromSelectors([
        'a[target="_blank"] img',
        'div[role="link"] img',
      ]);
      if (previewImg) return { image: toImgMeta(previewImg), usedCustomLogic: true };

      // Text-only post: do not fall back to first image (prevents avatar capture).
      return { image: null, usedCustomLogic: true };
    }
    if (platform === SUPPORTED_PLATFORMS.LINKEDIN) {
      const extractLinkedInPrimaryContentImage = (itemRoot) => {
        try {
          const feedRoot =
            (itemRoot.matches?.('div[data-view-name="feed-full-update"]') ? itemRoot : null) ||
            itemRoot.closest?.('div[data-view-name="feed-full-update"]') ||
            itemRoot.querySelector?.('div[data-view-name="feed-full-update"]');
          if (!feedRoot) {
            return {
              status: 'not_found',
              item_type: null,
              image_url: '',
              alt_text: '',
              url: '',
            };
          }

          const noiseSelectors = [
            'div[data-view-name="feed-header-actor-image"]',
            'div[data-view-name="feed-actor-image"]',
            'div[data-view-name="feed-reaction-count"]',
          ];
          const isNoiseImage = (img) => {
            try {
              if (!img || img.nodeType !== 1) return true;
              return noiseSelectors.some((sel) => !!img.closest?.(sel));
            } catch (e) {
              return true;
            }
          };
          const resolveBestImgUrl = (img) => {
            try {
              if (!img || img.nodeType !== 1) return '';
              const src = String(img.getAttribute?.('src') || img.currentSrc || img.src || '').trim();
              const srcset = String(img.getAttribute?.('srcset') || '').trim();
              const dataSrc = String(img.getAttribute?.('data-delayed-url') || img.getAttribute?.('data-src') || '').trim();
              const dataLoaded = String(img.getAttribute?.('data-loaded') || '').trim().toLowerCase();
              const isLinkedInMedia = (u) => String(u || '').includes('media.licdn.com/dms/image/');

              // High-res strategy:
              // - data-loaded=true: prefer src
              // - otherwise: prefer data-delayed-url/data-src, then src/srcset fallback
              if (dataLoaded === 'true') {
                if (isLinkedInMedia(src)) return src;
                if (isLinkedInMedia(dataSrc)) return dataSrc;
                if (srcset) {
                  const first = srcset.split(',').map((p) => p.trim().split(/\s+/)[0]).find(Boolean) || '';
                  if (isLinkedInMedia(first)) return first;
                }
                return '';
              }

              if (isLinkedInMedia(dataSrc)) return dataSrc;
              if (isLinkedInMedia(src)) return src;
              if (srcset) {
                const first = srcset.split(',').map((p) => p.trim().split(/\s+/)[0]).find(Boolean) || '';
                if (isLinkedInMedia(first)) return first;
              }
              return '';
            } catch (e) {
              return '';
            }
          };
          const getArea = (el) => {
            try {
              const r = el?.getBoundingClientRect ? el.getBoundingClientRect() : null;
              return r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
            } catch (e) {
              return 0;
            }
          };
          const pickFromSelectors = (selectors, itemType, imageSelector = 'img', preferredUrlPattern = null) => {
            let best = null;
            let bestScore = -1;
            for (const sel of selectors) {
              const containers = Array.from(feedRoot.querySelectorAll?.(sel) || []);
              for (const container of containers) {
                const imgs = Array.from(container.querySelectorAll?.(imageSelector) || []);
                for (const img of imgs) {
                  if (String(img.tagName || '').toUpperCase() !== 'IMG') continue; // strict IMG only
                  if (isNoiseImage(img)) continue;
                  const url = resolveBestImgUrl(img);
                  if (!url) continue;
                  const area = getArea(img);
                  const priorityBoost = preferredUrlPattern && preferredUrlPattern.test(url) ? 1_000_000_000 : 0;
                  const score = priorityBoost + area;
                  if (score > bestScore) {
                    bestScore = score;
                    best = {
                      status: 'success',
                      item_type: itemType,
                      image_url: url,
                      alt_text: String(img.getAttribute?.('alt') || '').trim(),
                      url,
                    };
                  }
                }
              }
            }
            return best;
          };

          const priorityA = pickFromSelectors(['div[data-view-name="feed-update-image"]'], 'image');
          if (priorityA) return priorityA;

          const priorityB = pickFromSelectors(
            [
              'div.video-js',
              'div.vjs-poster',
              'div[aria-label="Video Player"]',
              'div[data-view-name*="video"]',
              'div[class*="video-player"]',
            ],
            'video_thumbnail',
            'img.vjs-poster, img',
            /videocover-(?:low|high)/i
          );
          if (priorityB) return priorityB;

          const priorityC = pickFromSelectors(['div[data-view-name="feed-article-image"]'], 'article');
          if (priorityC) return priorityC;

          return {
            status: 'not_found',
            item_type: null,
            image_url: '',
            alt_text: '',
            url: '',
          };
        } catch (e) {
          return {
            status: 'not_found',
            item_type: null,
            image_url: '',
            alt_text: '',
            url: '',
          };
        }
      };

      const linkedInResult = extractLinkedInPrimaryContentImage(coreItem);
      if (linkedInResult?.status === 'success' && linkedInResult?.image_url) {
        return { image: linkedInResult, usedCustomLogic: true };
      }
      return { image: linkedInResult, usedCustomLogic: true };
    }

    const rootFontSize = getRootFontSizePx();
    const viewportBasedSize = Math.max(0, Number(window?.innerWidth || 0) * 0.03);
    const minContentSize = Math.max(rootFontSize * 2, 32, viewportBasedSize);
    const getBackgroundImageUrl = (el) => {
      try {
        const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        const bg = String(cs?.backgroundImage || '').trim();
        if (!bg || bg === 'none') return '';
        const m = bg.match(/url\((['"]?)(.*?)\1\)/i);
        return String(m?.[2] || '').trim();
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
        return passSize && passRatio;
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
      const src = String(img.getAttribute('src') || img.src || '').trim();
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
    const minContentSize = Math.max(rootFontSize * 2, 48, viewportBasedSize);
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

export async function isValidTypeAAnchor(anchor) {
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

export async function resolveTypeACoreItem(itemMapElement, hoveredTarget = null, itemMapElements = null) {
  try {
    if (!itemMapElement || itemMapElement.nodeType !== 1) return itemMapElement;
    const anchor =
      hoveredTarget?.matches?.('a[href]') ? hoveredTarget : hoveredTarget?.closest?.('a[href]');
    const contained = anchor && itemMapElement.contains?.(anchor);
    const validSignal = anchor && contained && (await isValidTypeAAnchor(anchor));
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
  LINKEDIN: 'LINKEDIN',
  FACEBOOK: 'FACEBOOK',
  X_TWITTER: 'X_TWITTER',
  REDDIT: 'REDDIT',
  THREADS: 'THREADS',
  TIKTOK: 'TIKTOK',
  UNKNOWN: 'UNKNOWN',
};

const PLATFORMS_WITH_CUSTOM_IMAGE_LOGIC = new Set([
  SUPPORTED_PLATFORMS.THREADS,
  SUPPORTED_PLATFORMS.LINKEDIN,
  SUPPORTED_PLATFORMS.REDDIT,
]);

const PLATFORMS_WITH_CUSTOM_TITLE_LOGIC = new Set([
  SUPPORTED_PLATFORMS.LINKEDIN,
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
      'linkedin.com': SUPPORTED_PLATFORMS.LINKEDIN,
      'facebook.com': SUPPORTED_PLATFORMS.FACEBOOK,
      'x.com': SUPPORTED_PLATFORMS.X_TWITTER,
      'twitter.com': SUPPORTED_PLATFORMS.X_TWITTER,
      'reddit.com': SUPPORTED_PLATFORMS.REDDIT,
      'threads.com': SUPPORTED_PLATFORMS.THREADS,
      'threads.net': SUPPORTED_PLATFORMS.THREADS,
      'tiktok.com': SUPPORTED_PLATFORMS.TIKTOK,
    };
    if (DOMAIN_PLATFORM_MAP[host]) return DOMAIN_PLATFORM_MAP[host];

    // Fallback for subdomains (e.g., business.facebook.com, help.instagram.com).
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
    if (p === 'LINKEDIN' && shortcode && !/^\d{19}$/.test(shortcode)) {
      return { shortcode: '', activeHoverUrl, imageUrl, title, username };
    }
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

function extractLinkedInShortcode(element) {
  try {
    if (!element || element.nodeType !== 1) return null;
    const toLinkedInPayload = (id) => {
      const shortcode = String(id || '').trim();
      if (!/^\d{19}$/.test(shortcode)) return null;
      return {
        shortcode,
        activeHoverUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${shortcode}`,
        platform: 'linkedin',
      };
    };
    const extractPreferredNumericId = (text) => {
      const s = String(text || '');
      if (!s) return null;
      const withContext =
        s.match(/(?:updateUrn|ugcPost)[^0-9]{0,60}(\d{19})/i) ||
        s.match(/urn(?:%253A|%3A|:|\.|\\u003a)?li(?:%253A|%3A|:|\.|\\u003a)?(?:activity|ugcPost)(?:%253A|%3A|:|\.|\\u003a)(\d{19})/i);
      if (withContext && withContext[1]) return String(withContext[1]);
      const any19 = s.match(/\b(\d{19})\b/);
      return any19 && any19[1] ? String(any19[1]) : null;
    };

    const decodeByteArray = (arr) => {
      try {
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const bytes = arr
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
        if (bytes.length === 0) return null;
        if (typeof TextDecoder !== 'undefined') {
          return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
        }
        return String.fromCharCode(...bytes);
      } catch (e) {
        return null;
      }
    };

    const findBreadcrumbDataArray = (obj) => {
      try {
        if (!obj || typeof obj !== 'object') return null;
        const direct = obj?.breadcrumb?.content?.data;
        if (Array.isArray(direct)) return direct;
        const stack = [obj];
        let hops = 0;
        while (stack.length > 0 && hops < 80) {
          hops += 1;
          const cur = stack.pop();
          if (!cur || typeof cur !== 'object') continue;
          const nested = cur?.breadcrumb?.content?.data;
          if (Array.isArray(nested)) return nested;
          for (const key of Object.keys(cur)) {
            const v = cur[key];
            if (v && typeof v === 'object') stack.push(v);
          }
        }
        return null;
      } catch (e) {
        return null;
      }
    };

    const normalizeTrackingScope = (raw) =>
      String(raw || '')
        .trim()
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/%2522/gi, '"')
        .replace(/%22/gi, '"')
        .replace(/\\u003a/gi, ':')
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/');

    const tryExtractFromTrackingScope = (rawValue) => {
      const normalized = normalizeTrackingScope(rawValue);
      if (!normalized) return null;

      // Source-of-truth validation: wrapper payload should carry breadcrumb/buffer-like content.
      const hasSignal = /breadcrumb|buffer/i.test(normalized);
      if (!hasSignal) return null;

      // Regex-first fallback path (handles encoded/double-encoded delimiters).
      const regexId =
        normalized.match(/(?:activity|ugcPost)(?:%253A|%3A|:|\\u003a)(\d{19})/i) ||
        normalized.match(/urn(?:%253A|%3A|:|\\u003a)?li(?:%253A|%3A|:|\\u003a)?(?:activity|ugcPost)(?:%253A|%3A|:|\\u003a)(\d{19})/i) ||
        normalized.match(/\b(\d{19})\b/);
      if (regexId && regexId[1]) return String(regexId[1]);

      try {
        const parsed = JSON.parse(normalized);
        const bytes = findBreadcrumbDataArray(parsed);
        const decoded = decodeByteArray(bytes);
        const decodedId = extractPreferredNumericId(decoded);
        if (decodedId) return decodedId;
        const payloadId = extractPreferredNumericId(JSON.stringify(parsed));
        if (payloadId) return payloadId;
      } catch (e) {
        // keep null and let ancestor traversal continue
      }
      return null;
    };

    const hasAnyDataViewAttribute = (node) => {
      try {
        if (!node || node.nodeType !== 1 || !node.attributes) return false;
        return Array.from(node.attributes).some((attr) => String(attr?.name || '').toLowerCase().startsWith('data-view-'));
      } catch (e) {
        return false;
      }
    };

    const isFeedBoundary = (node) => {
      try {
        if (!node || node.nodeType !== 1) return false;
        const viewName = String(node.getAttribute?.('data-view-name') || '').toLowerCase().trim();
        const role = String(node.getAttribute?.('role') || '').toLowerCase().trim();
        const cls = String(node.className || '').toLowerCase();
        const id = String(node.id || '').toLowerCase();
        if (viewName.includes('feed')) return true;
        if (role === 'feed') return true;
        if (/(^|[-_])feed([-_]|$)/.test(cls) || /(^|[-_])feed([-_]|$)/.test(id)) return true;
        return false;
      } catch (e) {
        return false;
      }
    };

    // 1) Preferred lookup: nearest div with data-view-tracking-scope.
    const nearestScopeDiv = element.closest?.('div[data-view-tracking-scope]');
    if (nearestScopeDiv) {
      const nearestRaw = nearestScopeDiv.getAttribute?.('data-view-tracking-scope');
      const nearestId = tryExtractFromTrackingScope(nearestRaw);
      const payload = toLinkedInPayload(nearestId);
      if (payload) return payload;
    }

    // 2) Class-agnostic ancestor traversal:
    //    inspect any ancestor with data-view-tracking-scope OR any data-view-* attribute.
    let cur = element.parentElement;
    let hops = 0;
    while (cur && cur !== document.body && hops < 80) {
      hops += 1;
      const hasScopeAttr = cur.hasAttribute?.('data-view-tracking-scope');
      const hasDataView = hasAnyDataViewAttribute(cur);
      if (hasScopeAttr || hasDataView) {
        const raw = String(cur.getAttribute?.('data-view-tracking-scope') || '').trim();
        if (raw) {
          const extracted = tryExtractFromTrackingScope(raw);
          const payload = toLinkedInPayload(extracted);
          if (payload) return payload;
        }
      }
      if (isFeedBoundary(cur)) break;
      cur = cur.parentElement;
    }

    return null;
  } catch (e) {
    return null;
  }
}

function extractFacebookShortcode(element) {
  try {
    if (!element || element.nodeType !== 1) return null;
    const platform = getCurrentPlatform();
    if (platform !== SUPPORTED_PLATFORMS.FACEBOOK) return null;

    const anchors = [];
    if (element.matches?.('a[role="link"][href]')) anchors.push(element);
    anchors.push(...Array.from(element.querySelectorAll?.('a[role="link"][href]') || []));
    if (anchors.length === 0) return null;
    const toAbsoluteHref = (rawHref) => {
      const raw = String(rawHref || '').trim();
      if (!raw) return '';
      try {
        return new URL(raw, window.location.href).href;
      } catch (e) {
        return raw;
      }
    };
    const isRepresentativeImageUrl = (url) => {
      const u = String(url || '').trim().toLowerCase();
      if (!u) return false;
      return /fbcdn\.net|scontent\./.test(u);
    };
    const imageArea = (img) => {
      try {
        const r = img?.getBoundingClientRect ? img.getBoundingClientRect() : null;
        return r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
      } catch (e) {
        return 0;
      }
    };
    const resolveImageUrl = (img) => {
      const src = String(img?.getAttribute?.('src') || img?.currentSrc || img?.src || '').trim();
      if (isRepresentativeImageUrl(src)) return src;
      const dataSrc = String(img?.getAttribute?.('data-src') || img?.getAttribute?.('data-delayed-url') || '').trim();
      if (isRepresentativeImageUrl(dataSrc)) return dataSrc;
      return '';
    };
    const extractRepresentativeImageUrl = () => {
      const allImgs = Array.from(element.querySelectorAll?.('img[src], img[data-src], img[data-delayed-url]') || []);
      if (allImgs.length === 0) return '';

      const isNoise = (img) => {
        try {
          if (!img || img.nodeType !== 1) return true;
          const tag = String(img.tagName || '').toUpperCase();
          if (tag !== 'IMG') return true;
          const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
          const area = r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
          if (area > 0 && area < 32 * 32) return true;
          return false;
        } catch (e) {
          return true;
        }
      };

      const videoContainers = Array.from(
        element.querySelectorAll?.('div[aria-label*="video" i], div[data-testid*="video" i], div[class*="video"], div[class*="poster"]') || []
      );
      let bestVideo = '';
      let bestVideoArea = 0;
      for (const c of videoContainers) {
        const imgs = Array.from(c.querySelectorAll?.('img[src], img[data-src], img[data-delayed-url]') || []);
        for (const img of imgs) {
          if (isNoise(img)) continue;
          const u = resolveImageUrl(img);
          if (!u) continue;
          const area = imageArea(img);
          if (area > bestVideoArea) {
            bestVideoArea = area;
            bestVideo = u;
          }
        }
      }
      if (bestVideo) return bestVideo;

      let best = '';
      let bestArea = 0;
      for (const img of allImgs) {
        if (isNoise(img)) continue;
        const u = resolveImageUrl(img);
        if (!u) continue;
        const area = imageArea(img);
        if (area > bestArea) {
          bestArea = area;
          best = u;
        }
      }
      return best;
    };
    const extractFacebookMessageTitle = () => {
      try {
        const sourceEl =
          element.querySelector?.('div[data-ad-comet-preview="message"], div[data-ad-preview="message"]') ||
          element.querySelector?.('blockquote') ||
          null;
        if (!sourceEl) return '';

        const clone = sourceEl.cloneNode(true);
        if (!clone || clone.nodeType !== 1) return '';
        const uiSelectors = [
          'button',
          '[role="button"]',
          'a[role="button"]',
          '[aria-label*="See more" i]',
          '[aria-label*="더 보기"]',
          '[aria-label*="See translation" i]',
          '[aria-label*="번역"]',
        ];
        for (const sel of uiSelectors) {
          const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
          for (const n of nodes) {
            try {
              n.remove();
            } catch (e) {}
          }
        }

        const extractTextWithSmartSpacing = (root) => {
          try {
            if (!root) return '';
            const BLOCK_TAGS = new Set([
              'DIV', 'P', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI', 'UL', 'OL',
              'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
            ]);
            const tokens = [];
            const pushBreak = () => {
              if (tokens.length === 0) return;
              if (tokens[tokens.length - 1] !== '\n') tokens.push('\n');
            };
            const visit = (node) => {
              if (!node) return;
              if (node.nodeType === 3) {
                const t = String(node.textContent || '').replace(/\s+/g, ' ').trim();
                if (t) tokens.push(t);
                return;
              }
              if (node.nodeType !== 1) return;
              const tag = String(node.tagName || '').toUpperCase();
              if (tag === 'BR') {
                pushBreak();
                return;
              }
              const isBlock = BLOCK_TAGS.has(tag);
              if (isBlock) pushBreak();
              const children = Array.from(node.childNodes || []);
              for (const child of children) visit(child);
              if (isBlock) pushBreak();
            };
            visit(root);
            let out = '';
            for (const token of tokens) {
              if (token === '\n') {
                if (!out) continue;
                if (!out.endsWith('\n')) out = `${out.trimEnd()}\n`;
                continue;
              }
              if (out && !out.endsWith('\n') && !out.endsWith(' ')) out += ' ';
              out += token;
            }
            return out;
          } catch (e) {
            return String(root?.innerText || root?.textContent || '');
          }
        };

        const raw = extractTextWithSmartSpacing(clone);
        if (!raw) return '';
        const cleaned = String(raw)
          .replace(/[ \t]+/g, ' ')
          .replace(/\s*\n\s*/g, ' ')
          .replace(/ {2,}/g, ' ')
          .trim();
        if (!cleaned) return '';
        // Keep full content available in metadata, but keep title reasonably concise.
        return cleaned.length > 180 ? `${cleaned.slice(0, 180).trimEnd()}...` : cleaned;
      } catch (e) {
        return '';
      }
    };
    const extractFacebookUsername = () => {
      try {
        const isTimestampText = (text) => {
          const t = String(text || '').trim().toLowerCase();
          if (!t) return true;
          if (/^\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/.test(t)) return true;
          if (/^\d{1,2}\s*월\s*\d{1,2}\s*일$/.test(t)) return true;
          if (/^(?:오전|오후)\s*\d{1,2}:\d{2}$/.test(t)) return true;
          if (/^\d+\s*(?:분|시간|일|주|개월|달|년)$/.test(t)) return true;
          if (/^\d{1,2}:\d{2}$/.test(t)) return true;
          return false;
        };
        const candidates = [];
        const selectors = [
          'h2 a[role="link"]',
          'h3 a[role="link"]',
          'h2 span',
          'h3 span',
          'strong a[role="link"]',
          'strong',
          'a[role="link"]',
          'span[style*="font-weight: 600"]',
          'span[style*="font-weight:600"]',
        ];
        for (const sel of selectors) {
          candidates.push(...Array.from(element.querySelectorAll?.(sel) || []));
        }
        for (const node of candidates) {
          const txt = normalizeText(node?.innerText || node?.textContent || '');
          if (!txt) continue;
          if (isTimestampText(txt)) continue;
          if (/^(follow|message|more|see more|see translation)$/i.test(txt)) continue;
          if (txt.length > 80) continue;
          return txt;
        }
        return '';
      } catch (e) {
        return '';
      }
    };
    const isTimestampAnchor = (anchor) => {
      try {
        const aria = String(anchor?.getAttribute?.('aria-label') || '').trim();
        const txt = normalizeText(anchor?.textContent || '');
        const bag = `${aria} ${txt}`.toLowerCase();
        if (!bag) return false;
        if (/\b\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)\b/i.test(bag)) return true;
        if (/\b\d{1,2}\s*월\s*\d{1,2}\s*일\b/.test(bag)) return true;
        if (/\b(?:오전|오후)\s*\d{1,2}:\d{2}\b/.test(bag)) return true;
        if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(bag)) return true;
        if (/\b\d+\s*(?:분|시간|일|주|개월|달|년)\b/.test(bag)) return true;
        return false;
      } catch (e) {
        return false;
      }
    };
    const isDateTimeAriaLabel = (anchor) => {
      try {
        const aria = String(anchor?.getAttribute?.('aria-label') || '').trim();
        if (!aria) return false;
        if (/\b\d{1,2}\s*월\s*\d{1,2}\s*일\b/.test(aria)) return true;
        if (/\b(?:오전|오후)\s*\d{1,2}:\d{2}\b/.test(aria)) return true;
        if (/\b\d{1,2}:\d{2}\b/.test(aria) && /\b\d{1,2}[./-]\d{1,2}\b/.test(aria)) return true;
        if (/\b\d+\s*(?:min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/i.test(aria)) return true;
        return false;
      } catch (e) {
        return false;
      }
    };
    const orderedAnchors = [
      ...anchors.filter((a) => isDateTimeAriaLabel(a) || isTimestampAnchor(a)),
      ...anchors.filter((a) => !(isDateTimeAriaLabel(a) || isTimestampAnchor(a))),
    ];
    for (const a of orderedAnchors) {
      const rawHref = String(a.getAttribute?.('href') || a.href || '').trim();
      if (!rawHref) continue;
      const activeHoverUrl = toAbsoluteHref(rawHref);
      if (!activeHoverUrl) continue;
      const imageUrl = extractRepresentativeImageUrl();
      const title = extractFacebookMessageTitle();
      const username = extractFacebookUsername();
      return { activeHoverUrl, imageUrl, title, username, platform: 'facebook' };
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
function extractThreadsShortcode(element) {
  try {
    if (!element || element.nodeType !== 1) return null;
    const platform = getCurrentPlatform();
    if (platform !== SUPPORTED_PLATFORMS.THREADS) return null;

    const THREADS_CANONICAL_ORIGIN = 'https://www.threads.net';
    const POST_PATH_RE = /\/@([^/?#]+)\/post\/([^/?#]+)/i;
    const toPath = (rawHref) => {
      try {
        const raw = String(rawHref || '').trim();
        if (!raw) return '';
        if (/^https?:\/\//i.test(raw)) {
          const u = new URL(raw);
          return `${u.pathname || ''}${u.search || ''}${u.hash || ''}`;
        }
        return raw.startsWith('/') ? raw : `/${raw.replace(/^\.?\//, '')}`;
      } catch (e) {
        return '';
      }
    };
    const parsePostRefFromHref = (rawHref) => {
      try {
        const path = toPath(rawHref);
        const m = String(path || '').match(POST_PATH_RE);
        if (!m) return null;
        return { username: String(m[1] || '').trim(), shortcode: String(m[2] || '').trim() };
      } catch (e) {
        return null;
      }
    };
    const buildThreadsPostUrl = (rawHref) => {
      const ref = parsePostRefFromHref(rawHref);
      if (!ref?.username || !ref?.shortcode) return '';
      return `${THREADS_CANONICAL_ORIGIN}/@${ref.username}/post/${ref.shortcode}`;
    };
    const extractShortcodeFromFinalUrl = (url) => {
      try {
        const m = String(url || '').match(POST_PATH_RE);
        return m && m[2] ? String(m[2]).trim() : '';
      } catch (e) {
        return '';
      }
    };

    // 1) Primary strategy: time -> parent anchor.
    let activeHoverUrl = '';
    const timeEl = element.querySelector?.('time') || null;
    if (timeEl) {
      const p = timeEl.parentElement;
      if (p && String(p.tagName || '').toUpperCase() === 'A') {
        const raw = String(p.getAttribute?.('href') || p.href || '').trim();
        activeHoverUrl = buildThreadsPostUrl(raw);
      }
    }
    // 2) Fallback strategy: any anchor with /@user/post/shortcode.
    if (!activeHoverUrl) {
      const anchors = Array.from(element.querySelectorAll?.('a[href]') || []);
      for (const a of anchors) {
        const raw = String(a.getAttribute?.('href') || a.href || '').trim();
        const built = buildThreadsPostUrl(raw);
        if (!built) continue;
        activeHoverUrl = built;
        break;
      }
    }
    if (!activeHoverUrl) return null;

    // Shortcode must come from final activeHoverUrl string.
    const shortcode = extractShortcodeFromFinalUrl(activeHoverUrl);
    if (!shortcode) return null;

    const extractTextWithSmartSpacing = (root) => {
      try {
        if (!root) return '';
        const BLOCK_TAGS = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
        const tokens = [];
        const pushBreak = () => {
          if (tokens.length === 0) return;
          if (tokens[tokens.length - 1] !== '\n') tokens.push('\n');
        };
        const visit = (node) => {
          if (!node) return;
          if (node.nodeType === 3) {
            const t = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) tokens.push(t);
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = String(node.tagName || '').toUpperCase();
          if (tag === 'BR') {
            pushBreak();
            return;
          }
          const isBlock = BLOCK_TAGS.has(tag);
          if (isBlock) pushBreak();
          for (const child of Array.from(node.childNodes || [])) visit(child);
          if (isBlock) pushBreak();
        };
        visit(root);
        let out = '';
        for (const token of tokens) {
          if (token === '\n') {
            if (!out) continue;
            if (!out.endsWith('\n')) out = `${out.trimEnd()}\n`;
            continue;
          }
          if (out && !out.endsWith('\n') && !out.endsWith(' ')) out += ' ';
          out += token;
        }
        return out;
      } catch (e) {
        return String(root?.innerText || root?.textContent || '');
      }
    };
    const cleanUiNoise = (sourceEl) => {
      try {
        if (!sourceEl || sourceEl.nodeType !== 1) return '';
        const clone = sourceEl.cloneNode(true);
        const uiSelectors = [
          'button',
          '[role="button"]',
          'a[role="button"]',
          '[aria-label*="Translate" i]',
          '[aria-label*="번역"]',
          '[aria-label*="See more" i]',
          '[aria-label*="더 보기"]',
        ];
        for (const sel of uiSelectors) {
          const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
          for (const n of nodes) {
            try {
              n.remove();
            } catch (e) {}
          }
        }
        return String(extractTextWithSmartSpacing(clone) || '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\s*\n\s*/g, ' ')
          .replace(/ {2,}/g, ' ')
          .trim();
      } catch (e) {
        return '';
      }
    };

    // Username: parse from href that starts with /@
    let username = '';
    let usernameAnchor = null;
    const profileAnchors = Array.from(element.querySelectorAll?.('a[href^="/@"]') || []);
    for (const a of profileAnchors) {
      const hrefVal = String(a.getAttribute?.('href') || '').trim();
      const m = hrefVal.match(/^\/@([^/?#]+)/i);
      if (!m || !m[1]) continue;
      if (/\/post\//i.test(hrefVal)) continue;
      username = String(m[1]).trim();
      usernameAnchor = a;
      break;
    }
    if (!username) {
      const u = String(activeHoverUrl || '').match(POST_PATH_RE);
      if (u && u[1]) username = String(u[1]).trim();
    }

    // Content: longest span[dir=auto] (including nested span candidates), excluding username link subtree.
    let bestNode = null;
    let bestLen = 0;
    const dirSpanNodes = Array.from(element.querySelectorAll?.('span[dir="auto"]') || []);
    for (const node of dirSpanNodes) {
      if (!node || node.nodeType !== 1) continue;
      if (usernameAnchor && usernameAnchor.contains?.(node)) continue;
      const t = cleanUiNoise(node);
      if (!t) continue;
      const len = t.length;
      if (len > bestLen) {
        bestLen = len;
        bestNode = node;
      }
    }
    let content = '';
    if (bestNode) {
      const blockRoot = bestNode.parentElement || bestNode;
      content = cleanUiNoise(blockRoot) || cleanUiNoise(bestNode);
    }
    if (!content && bestNode) content = cleanUiNoise(bestNode);
    content = String(content || '').trim();
    if (content.length > 180) content = `${content.slice(0, 180).trimEnd()}...`;

    const title =
      username && content
        ? `${username}'s post\n${content}`
        : content || (username ? `${username}'s post` : 'Threads post');

    return {
      shortcode,
      activeHoverUrl,
      username,
      title,
      platform: 'THREADS',
    };
  } catch (e) {
    return null;
  }
}
function extractTikTokShortcode(_element) { return null; }

const PLATFORM_CONFIG = {
  [SUPPORTED_PLATFORMS.INSTAGRAM]: extractInstagramShortcode,
  [SUPPORTED_PLATFORMS.LINKEDIN]: extractLinkedInShortcode,
  [SUPPORTED_PLATFORMS.FACEBOOK]: extractFacebookShortcode,
  [SUPPORTED_PLATFORMS.X_TWITTER]: extractXTwitterShortcode,
  [SUPPORTED_PLATFORMS.REDDIT]: extractRedditShortcode,
  [SUPPORTED_PLATFORMS.THREADS]: extractThreadsShortcode,
  [SUPPORTED_PLATFORMS.TIKTOK]: extractTikTokShortcode,
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

export function extractMetadataForCoreItem(coreItem, closestAtag = null, hoveredTarget = null, cacheOverrides = null) {
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

    if (!activeHoverUrl) return null;

    let image;
    let imageIsCustom = false;
    if (cacheOverrides?.cachedImage?.usedCustomLogic && cacheOverrides.cachedImage.value != null) {
      image = cacheOverrides.cachedImage.value;
      imageIsCustom = true;
    } else {
      const imageResult = extractImageFromCoreItem(coreItem);
      image = imageResult?.image ?? imageResult;
      imageIsCustom = imageResult?.usedCustomLogic ?? false;
    }

    const platform = getCurrentPlatform();
    const linkedInCommentary =
      platform === SUPPORTED_PLATFORMS.LINKEDIN
        ? extractLinkedInCommentaryFromCoreItem(coreItem)
        : { status: 'not_found', extracted_text: '', text_length: 0 };
    const instagramCaption =
      platform === SUPPORTED_PLATFORMS.INSTAGRAM
        ? extractInstagramCaptionFromCoreItem(coreItem)
        : { status: 'not_found', extracted_text: '', text_length: 0 };
    const fullCommentaryText =
      linkedInCommentary?.status === 'success' ? String(linkedInCommentary.extracted_text || '').trim() : '';
    const fullInstagramCaption =
      instagramCaption?.status === 'success' ? String(instagramCaption.extracted_text || '').trim() : '';
    const instagramUsername = String(instagramCaption?.username || '').trim();
    const truncatedCommentaryTitle = fullCommentaryText
      ? (fullCommentaryText.length > 100
          ? `${fullCommentaryText.slice(0, 100).trimEnd()}...`
          : fullCommentaryText)
      : '';
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
        truncatedCommentaryTitle ||
        String(genericTitle || '').trim() ||
        (platform === SUPPORTED_PLATFORMS.LINKEDIN
          ? 'No text content'
          : platform === SUPPORTED_PLATFORMS.INSTAGRAM
            ? 'Instagram Post (No caption)'
            : null);
      titleIsCustom = !!(instagramComposedTitle || fullInstagramCaption || truncatedCommentaryTitle);
    }
    const resolvedDescription =
      fullInstagramCaption ||
      fullCommentaryText ||
      (platform === SUPPORTED_PLATFORMS.LINKEDIN
        ? 'No text content'
        : platform === SUPPORTED_PLATFORMS.INSTAGRAM
          ? 'Instagram Post (No caption)'
          : '');
    return {
      activeHoverUrl,
      title,
      description: resolvedDescription,
      content: resolvedDescription,
      commentary: linkedInCommentary,
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

const _CATEGORY_MAIL_TYPE_MAP = {
  'google.com': 'Gmail',
  'naver.com': 'Naver',
};

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

    // Returns true if pageUrl is a search engine domain but NOT a search results page.
    // In this case dominant media check should be suppressed — items on search engine
    // home/non-search pages (e.g. google.com main, naver.com main) are not real Contents.
    function isSearchEngineNonSearchPage() {
      if (!pageUrl) return false;
      try {
        const ph = new URL(pageUrl).hostname.toLowerCase();
        const pp = new URL(pageUrl).pathname.toLowerCase();
        const ps = new URL(pageUrl).search.toLowerCase();

        // Google: search results → /search?q=...
        if (ph.includes('google.com')) {
          return !(pp.startsWith('/search') && ps.includes('q='));
        }
        // Naver: search results → search.naver.com/...
        if (ph === 'search.naver.com') return false; // IS a search page
        if (ph.includes('naver.com')) return true;   // naver.com but not search subdomain

        // Bing: search results → /search?q=...
        if (ph.includes('bing.com')) {
          return !(pp.startsWith('/search') && ps.includes('q='));
        }
        // DuckDuckGo: search results → duckduckgo.com/?q=...
        if (ph.includes('duckduckgo.com')) {
          return !(ps.includes('q='));
        }
        // Yahoo Search: search results → search.yahoo.com/search?...
        if (ph.includes('yahoo.com')) {
          return !(ph.startsWith('search.') && pp.startsWith('/search'));
        }
        // Daum: search results → search.daum.net/search?...
        if (ph.includes('daum.net')) {
          return !(ph.startsWith('search.') && pp.startsWith('/search'));
        }
        // Baidu: search results → baidu.com/s?...
        if (ph.includes('baidu.com')) {
          return !(pp === '/s' || pp.startsWith('/s?') || ps.includes('wd='));
        }
        // Yandex: search results → yandex.com/search/...
        if (ph.includes('yandex.com') || ph.includes('yandex.ru')) {
          return !(pp.startsWith('/search'));
        }
      } catch (_) {}
      return false;
    }

    // ── Step 1: SNS ───────────────────────────────────────────────────────────
    // Detect SNS platform first (before any media check).
    // Then classify as `contents` (dominant media present) or `post` (no dominant media).
    let snsPlatform = '';
    if (host.includes('instagram.com')) {
      snsPlatform = 'Instagram';
    } else if (host.includes('x.com') || host.includes('twitter.com')) {
      snsPlatform = 'X';
    } else if (host.includes('threads.net')) {
      snsPlatform = 'Threads';
    } else if (
      host.includes('linkedin.com') &&
      (path.startsWith('/posts/') || path.includes('/feed/update/') || path.startsWith('/in/'))
    ) {
      snsPlatform = 'LinkedIn';
    } else if (host.includes('facebook.com') && !!htmlContext) {
      snsPlatform = 'Facebook';
    } else if (host.includes('tiktok.com')) {
      snsPlatform = 'TikTok';
    } else if (host.includes('reddit.com') && (path.includes('/r/') || path.includes('/user/'))) {
      snsPlatform = 'Reddit';
    }

    if (snsPlatform) {
      // Dominant media check: 'Image' | 'Video' | '' — both Image and Video count as "contents".
      const dominantType = getDominantMediaType();
      const hasDominantMedia = dominantType === 'Image' || dominantType === 'Video';
      return {
        category: 'SNS',
        platform: snsPlatform,
        confirmedType: hasDominantMedia ? 'contents' : 'post',
      };
    }

    // ── Step 2: Mail ──────────────────────────────────────────────────────────
    // Only classify as Mail when the savedUrl points to an actual email thread.
    // Folder/label pages (inbox list) are classified as Page instead.
    const savedHostParts = host.split('.');
    if (savedHostParts[0] === 'mail') {
      let mailRegDomain = '';
      try {
        const mh = new URL(savedUrl).hostname.toLowerCase();
        const mp = mh.replace(/^www\./, '').split('.');
        mailRegDomain = mp.slice(-2).join('.');
      } catch (_) {}

      // Gmail: real email thread → hash contains two segments: #{label}/{id}
      // e.g. #inbox/18f3a... → Mail   |   #inbox → Page
      if (mailRegDomain === 'google.com') {
        try {
          const gmailHash = new URL(savedUrl).hash || '';
          // Strip leading '#', split by '/'
          const gmailParts = gmailHash.replace(/^#/, '').split('/').filter(Boolean);
          if (gmailParts.length < 2) {
            // Only a label segment (e.g. #inbox, #sent) — folder page, not a thread
            return { category: 'Page', platform: 'google', confirmedType: '' };
          }
        } catch (_) {}
        return { category: 'Mail', platform: 'Gmail', confirmedType: '' };
      }

      // Naver Mail: real email → /v2/read/{folderId}/{mailId}
      // Folder page → /v2/folders/{folderId}
      if (mailRegDomain === 'naver.com') {
        try {
          const naverPath = new URL(savedUrl).pathname.toLowerCase();
          if (naverPath.startsWith('/v2/folders/')) {
            // Folder list page, not a specific email
            return { category: 'Page', platform: 'naver', confirmedType: '' };
          }
          // /v2/read/{folderId}/{mailId} → real email thread
        } catch (_) {}
        return { category: 'Mail', platform: 'Naver', confirmedType: '' };
      }

      const mailPlatform = _CATEGORY_MAIL_TYPE_MAP[mailRegDomain] || 'Other';
      return { category: 'Mail', platform: mailPlatform, confirmedType: '' };
    }

    // ── Step 2.5: Unconditional Video hosts → Page ────────────────────────────
    // YouTube videos/shorts, Vimeo, Twitch URLs are always Page category. This
    // check runs BEFORE the dominant media check (Step 3) because these pages
    // often contain a dominant <video> element or large thumbnail image, which
    // would otherwise cause Step 3 to classify them as Image.
    //
    // Note: Video is no longer a distinct category in the new taxonomy — these
    // URLs classify as plain Page (with img_url handling done separately for
    // YouTube thumbnails by coreEntry.js).
    if (
      !!extractYouTubeShortcodeFromUrl(fullUrlString) ||
      host.includes('vimeo.com') ||
      host.includes('twitch.tv')
    ) {
      return { category: 'Page', platform: getSavedDomain(), confirmedType: '' };
    }

    // ── Step 3: Dominant media check (non-SNS) ────────────────────────────────
    // Only DOMINANT IMAGE classifies as Image category.
    // Dominant Video falls through to default (Page) — Video is no longer a distinct category.
    // Skip check when pageUrl is a search engine non-search page (items are ads, not real content).
    const dominantType = isSearchEngineNonSearchPage() ? '' : getDominantMediaType();
    if (dominantType === 'Image') {
      return { category: 'Image', platform: getPageDomain(), confirmedType: '' };
    }

    // ── Step 4: Same-origin URL-based ─────────────────────────────────────────
    // Only image file extensions classify as Image. Video extensions and video-host URLs
    // fall through to default (Page).
    const savedDomain = getSavedDomain();
    const pageDomain  = pageUrl ? _getCategoryBaseDomain(pageUrl) : '';
    const sameOrigin  = !!savedDomain && !!pageDomain && savedDomain === pageDomain;

    if (sameOrigin) {
      if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(path)) {
        return { category: 'Image', platform: getPageDomain(), confirmedType: '' };
      }
    }

    // ── Step 5: Weighted scoring ──────────────────────────────────────────────
    // Only scores toward IMAGE classification. Video signals are ignored.
    // A page reaches Image only when there is a clear, single image focus.
    if (!isSearchEngineNonSearchPage()) {
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
        return { category: 'Image', platform: getPageDomain(), confirmedType: '' };
      }
    }

    // ── Step 6: Default ───────────────────────────────────────────────────────
    return { category: 'Page', platform: getSavedDomain(), confirmedType: '' };
  } catch (e) {
    return { category: 'Page', platform: '', confirmedType: '' };
  }
}
