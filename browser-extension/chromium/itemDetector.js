/**
 * Item cluster and item map detection logic.
 * Handles detectItemMaps, getItemMapFingerprint, findClusterContainerFromTarget, getItemMapEvidenceType,
 * ensureClusterCacheFromState, getElementSignature, and related helpers.
 */

import { state } from './stateLite.js';
import {
  resolveAnchorUrl,
  isValidTypeAAnchor,
  extractMetadataForCoreItem,
  extractShortcode,
  getCurrentPlatform,
  normalizeShortcodeExtractionResult,
  hasCustomImageLogic,
  hasCustomTitleLogic,
  SUPPORTED_PLATFORMS,
} from './dataExtractor.js';

const MIN_CANDIDATE_SIZE = 40;
const INTERRUPTION_TAGS = new Set(['SPAN', 'HR', 'BR', 'SCRIPT']);
const STRUCTURE_IGNORED_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'button', 'script', 'style']);
const EVIDENCE_TYPE_ANCHOR = 'A';
const EVIDENCE_TYPE_INTERACTION = 'B';
const EVIDENCE_TYPE_C = 'C';
const TYPE_B_FULLSCREEN_COVERAGE_THRESHOLD = 0.9;
const SHARE_KEYWORDS = ['share', '공유하기', '공유', 'send-as-message', 'send-privately', '보내기'];
const TYPE_B_CROSS_TAG_EXCEPTIONS = new Set(['shreddit-ad-post']);
// Platforms on which Type B (share-button) ItemMap detection is active.
// On all other pages getCurrentPlatform() returns UNKNOWN and Type B
// is skipped to prevent false positives on non-SNS sites.
const TYPE_B_PLATFORMS = new Set([
  SUPPORTED_PLATFORMS.INSTAGRAM,
  SUPPORTED_PLATFORMS.FACEBOOK,
  SUPPORTED_PLATFORMS.REDDIT,
  SUPPORTED_PLATFORMS.THREADS,
  SUPPORTED_PLATFORMS.TIKTOK,
  SUPPORTED_PLATFORMS.X_TWITTER,
  SUPPORTED_PLATFORMS.LINKEDIN,
]);
const STABLE_SIG_ATTR_KEYS = new Set([
  'data-type',
  'data-pagelet',
  'data-testid',
  'data-template-id',
  'data-sds-comp',
  'data-ad-rendering-role',
]);

let clusterLookup = new Set();

function normalizeText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

/**
 * Returns true if the element's tag name, id, or className contains
 * the word "comment" (case-insensitive, whole-word boundary match).
 * Used to exclude comment cards and comment containers from ItemMap
 * detection across all platforms and evidence types.
 */
function hasCommentKeyword(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toLowerCase();
    const id  = String(el.id || '').toLowerCase();
    const cls = String(el.className || '').toLowerCase();
    const bag = `${tag} ${id} ${cls}`;
    return /\bcomment\b/.test(bag);
  } catch (e) {
    return false;
  }
}

function getNormalizedClass(el) {
  const cls = normalizeText(el?.className || '');
  if (!cls) return '';
  const DYNAMIC_STATE_TOKENS = new Set(['hover', 'ad-hover', 'active', 'on', 'focus', 'selected', 'highlight']);
  const isDynamicStateClassToken = (token) => {
    const t = String(token || '').trim().toLowerCase();
    if (!t) return true;
    if (DYNAMIC_STATE_TOKENS.has(t)) return true;
    if (/^(is|has)[-_]?(hover|active|focus|selected|on)$/.test(t)) return true;
    if (/^(is|has)[-_]?(highlight|highlighted)$/.test(t)) return true;
    if (/(^|[-_])(hover|ad-hover|active|focus|selected|on|highlight|highlighted)([-_]|$)/.test(t)) return true;
    return false;
  };
  const isLikelyObfuscatedToken = (token) => {
    const t = String(token || '').trim();
    if (!t) return true;
    if (/^x[a-z0-9]{5,}$/i.test(t)) return true;
    // Short mixed alnum classes are often ephemeral UI states/hashes.
    if (t.length <= 4 && /[a-z]/i.test(t) && /\d/.test(t) && !/[-_]/.test(t)) return true;
    const hasSep = /[-_]/.test(t);
    const hasUpper = /[A-Z]/.test(t);
    const hasLower = /[a-z]/.test(t);
    const hasDigit = /\d/.test(t);
    if (t.length > 15 && hasUpper && hasLower && hasDigit && !hasSep) return true;
    return false;
  };
  const tokens = cls
    .split(/\s+/)
    .map((t) => String(t || '').trim())
    .filter((t) => !isDynamicStateClassToken(t))
    .filter((t) => !isLikelyObfuscatedToken(t))
    .map((t) => t.toLowerCase().replace(/[-_]*\d+$/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return Array.from(new Set(tokens)).sort().join('.');
}

function getCustomAttributesSignature(el) {
  try {
    if (!el || !el.attributes) return '';
    const isDynamicStateAttrName = (name) => {
      const n = String(name || '').toLowerCase().trim();
      if (!n) return true;
      return /(?:^|[-_])(hover|active|focus|selected)(?:$|[-_])/.test(n);
    };
    const normalizeAttrValue = (name, value) => {
      const n = String(name || '').toLowerCase();
      let v = String(value || '').trim();
      if (!v) return '';
      v = v.replace(/\{n\}/gi, '');
      v = v.replace(/[_-]\d+$/g, '');
      v = v.replace(/[_-]\{[a-z]+\}$/gi, '');
      if (n === 'data-pagelet') {
        v = v.replace(/[_-]?\d+$/g, '');
        v = v.replace(/\{[^}]+\}/g, '');
      }
      v = v.replace(/[_-]{2,}/g, '_').replace(/[_-]$/g, '');
      return v.trim();
    };
    const tokens = [];
    for (const attr of Array.from(el.attributes)) {
      const name = String(attr?.name || '').trim().toLowerCase();
      if (!name) continue;
      if (name === 'style') continue;
      if (name === 'componentkey') continue;
      if (isDynamicStateAttrName(name)) continue;
      const isScannerAttr = name.startsWith('data-') || name.startsWith('v-') || name.includes('data-v-');
      if (!isScannerAttr) continue;
      const rawValue = String(attr?.value || '').trim();
      const value = normalizeAttrValue(name, rawValue);
      if (!value) continue;
      if (!STABLE_SIG_ATTR_KEYS.has(name) && name.startsWith('data-')) {
        const looksNoisy =
          value.length > 40 ||
          /\s/.test(value) ||
          /[{}()[\]&=/?]/.test(value);
        if (looksNoisy) continue;
      }
      tokens.push(`${name}=${value}`);
    }
    return tokens.sort().join('|');
  } catch (e) {
    return '';
  }
}

function promoteGhostWrapper(el) {
  try {
    if (!el || el.nodeType !== 1) return el;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const hasNoBox = !r || r.width <= 0 || r.height <= 0;
    const displayContents = cs?.display === 'contents' || String(el.getAttribute?.('data-display-contents') || '').toLowerCase() === 'true';
    const shouldPromote = hasNoBox || displayContents;
    if (!shouldPromote) return el;

    const children = Array.from(el.children || []).filter((c) => c && c.nodeType === 1);
    if (children.length === 0) return el;
    if (children.length === 1) return children[0];

    const preferred = children.find((c) =>
      c.matches?.('[role="listitem"],article,li,[data-view-name]')
    );
    if (preferred) return preferred;

    const withAnchor = children.find((c) => !!c.querySelector?.('a[href]'));
    if (withAnchor) return withAnchor;
    const withBox = children.find((c) => {
      const cr = c.getBoundingClientRect ? c.getBoundingClientRect() : null;
      return !!cr && cr.width > 0 && cr.height > 0;
    });
    return withBox || el;
  } catch (e) {
    return el;
  }
}

function getInternalStructure(el, maxDepth = 3) {
  try {
    if (!el || el.nodeType !== 1) return '';
    const capDepth = Math.max(1, Math.min(3, Number(maxDepth) || 3));
    const MAX_NODES = 140;
    let visited = 0;
    // Map<depth, Set<tagName>> — tracks which tags appear at each depth level
    const depthMap = new Map();
    const isVolatileStructureNode = (node) => {
      try {
        if (!node || node.nodeType !== 1) return true;
        const tag = String(node.tagName || '').toUpperCase();
        const aria = String(node.getAttribute?.('aria-label') || '').trim().toLowerCase();
        const txt = normalizeText(node.textContent || '').toLowerCase();
        // "Liked by author" style badges and variants should not alter Type B grouping.
        if (/원본\s*작성자.*좋아함|liked\s*by\s*author/.test(`${aria} ${txt}`)) return true;
        // Author/time utility labels are volatile, not core-card structure.
        if (txt === '· 작성자' || txt === '작성자') return true;
        if (tag === 'TIME') return true;
        if (/^\d+\s*(?:초|분|시간|일|주|개월|달|년)\s*전$/.test(txt)) return true;
        if (/^\d+\s*(?:s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months|y|year|years)\s*ago$/.test(txt)) return true;
        return false;
      } catch (e) {
        return false;
      }
    };
    const build = (node, depth) => {
      if (!node || node.nodeType !== 1) return;
      visited += 1;
      if (visited > MAX_NODES) return;
      const tag = String(node.tagName || '').toLowerCase();
      if (!tag) return;
      if (isVolatileStructureNode(node)) return;
      if (STRUCTURE_IGNORED_TAGS.has(tag)) {
        // Transparent tag: traverse children at the same depth (not counted in structure)
        const kids = node.children ? Array.from(node.children).filter((c) => c && c.nodeType === 1) : [];
        for (const k of kids) build(k, depth);
        return;
      }
      // Register this tag at its depth level
      if (!depthMap.has(depth)) depthMap.set(depth, new Set());
      depthMap.get(depth).add(tag);
      if (depth >= capDepth) return;
      const kids = node.children ? Array.from(node.children).filter((c) => c && c.nodeType === 1) : [];
      for (const k of kids) build(k, depth + 1);
    };
    build(el, 1);
    if (depthMap.size === 0) return '';
    // Build signature: "D1:tag1,tag2|D2:tag3,tag4|D3:tag5"
    // Depths are sorted numerically; tags within each depth are sorted alphabetically.
    return Array.from(depthMap.keys())
      .sort((a, b) => a - b)
      .map((d) => `D${d}:${Array.from(depthMap.get(d)).sort().join(',')}`)
      .join('|');
  } catch (e) {
    return '';
  }
}

export function getElementSignature(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    const tag = String(el.tagName || '').toUpperCase();
    if (!tag) return '';
    const normalizedClass = getNormalizedClass(el);
    if (normalizedClass) {
      return `${tag}::C:${normalizedClass}`;
    }
    const customAttributes = getCustomAttributesSignature(el);
    if (customAttributes) {
      return `${tag}::A:${customAttributes}`;
    }
    return `${tag}::T:__tag_only__`;
  } catch (e) {
    return '';
  }
}

function parseIdentitySignature(sig) {
  const raw = String(sig || '').trim();
  if (!raw) return { tag: '', mode: '', value: '' };
  const parts = raw.split('::');
  const tag = String(parts[0] || '').trim().toUpperCase();
  const modePart = String(parts[1] || '').trim();
  const value = String(parts.slice(2).join('::') || '').trim();
  const mode = modePart.endsWith(':') ? modePart.slice(0, -1) : modePart;
  return { tag, mode, value };
}

function classTokenSetFromIdentity(sig) {
  const parsed = parseIdentitySignature(sig);
  if (!parsed.tag) return null;
  // Handle both 'C' (mode only) and 'C:classvalue' (mode includes value after colon)
  let classValue = '';
  if (parsed.mode === 'C') {
    classValue = parsed.value;
  } else if (parsed.mode.startsWith('C:')) {
    classValue = parsed.mode.slice(2);
  } else {
    return null;
  }
  const tokens = String(classValue || '')
    .split('.')
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  return { tag: parsed.tag, set: new Set(tokens) };
}

function getSetOverlapRatio(a, b) {
  const setA = a instanceof Set ? a : new Set();
  const setB = b instanceof Set ? b : new Set();
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1;
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  return inter / union.size;
}

function getStructureOverlapRatio(sigA, sigB) {
  try {
    const setA = new Set(String(sigA || '').split('|').map((t) => t.trim()).filter(Boolean));
    const setB = new Set(String(sigB || '').split('|').map((t) => t.trim()).filter(Boolean));
    return getSetOverlapRatio(setA, setB);
  } catch (e) {
    return 0;
  }
}

// Tags that represent inherently repeated list structures.
// Elements sharing the same list-like tag receive a similarity bonus
// because the tag itself is a strong structural signal.
const LIST_LIKE_TAGS = new Set(['TR', 'LI']);
const LIST_LIKE_TAG_BONUS = 0.3;

function isSimilarIdentity(sig1, sig2, threshold = 0.8) {
  const p1 = parseIdentitySignature(sig1);
  const p2 = parseIdentitySignature(sig2);
  if (!p1.tag || !p2.tag || p1.tag !== p2.tag) return { matched: false, ratio: 0 };
  if (sig1 === sig2) return { matched: true, ratio: 1 };

  const c1 = classTokenSetFromIdentity(sig1);
  const c2 = classTokenSetFromIdentity(sig2);
  if (!c1 || !c2) return { matched: false, ratio: 0 };

  let ratio = getSetOverlapRatio(c1.set, c2.set);
  // Apply bonus for list-like tags — the tag itself signals repeated structure.
  if (LIST_LIKE_TAGS.has(p1.tag)) {
    ratio = Math.min(1, ratio + LIST_LIKE_TAG_BONUS);
  }
  return { matched: ratio >= threshold, ratio };
}

async function hasValidAbsoluteAnchor(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    if (el.matches?.('a[href]') && (await isValidTypeAAnchor(el))) return true;
    if (!el.querySelector) return false;
    const anchors = el.querySelectorAll('a[href]');
    for (const a of anchors) {
      if (await isValidTypeAAnchor(a)) return true;
    }

    // role="link" + URL-bearing data attributes (e.g. Trip.com, some React/Vue SPAs)
    const roleLinkCandidates = [
      el,
      ...Array.from(el.querySelectorAll?.('[role="link"]') || []),
    ];
    for (const candidate of roleLinkCandidates) {
      if (candidate.getAttribute?.('role') !== 'link') continue;
      const raw =
        String(candidate.getAttribute?.('data-href')     || '').trim() ||
        String(candidate.getAttribute?.('data-url')      || '').trim() ||
        String(candidate.getAttribute?.('data-link')     || '').trim() ||
        String(candidate.getAttribute?.('data-href-url') || '').trim();
      if (!raw) continue;
      try {
        const u = new URL(raw, window.location.href);
        if (/^https?:$/i.test(u.protocol)) return true;
      } catch { /* skip invalid URLs */ }
    }

    return false;
  } catch (e) {
    return false;
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

function queryAllInOpenShadow(root, selector) {
  try {
    if (!root || !selector) return [];
    const out = [];
    const seen = new Set();
    const visit = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === 1 && node.matches?.(selector)) {
        out.push(node);
      }
      const local = Array.from(node.querySelectorAll?.(selector) || []);
      for (const m of local) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
      const descendants = Array.from(node.querySelectorAll?.('*') || []);
      for (const d of descendants) {
        if (!d || d.nodeType !== 1) continue;
        const sr = d.shadowRoot;
        if (sr && sr.mode === 'open') visit(sr);
      }
      if (node.shadowRoot && node.shadowRoot.mode === 'open') visit(node.shadowRoot);
    };
    visit(root);
    return out;
  } catch (e) {
    return [];
  }
}

function findInShadow(root, selector) {
  try {
    return queryAllInOpenShadow(root, selector).length > 0;
  } catch (e) {
    return false;
  }
}

function getFlattenedDepthWithin(rootEl, nodeEl) {
  try {
    if (!rootEl || !nodeEl) return Number.POSITIVE_INFINITY;
    let depth = 0;
    let cur = nodeEl;
    while (cur && cur !== rootEl) {
      const parent = cur.parentElement || cur.parentNode;
      if (!parent) return Number.POSITIVE_INFINITY;
      if (String(parent.toString?.() || '') === '[object ShadowRoot]') {
        // Cross shadow boundary via host, counting as one step.
        cur = parent.host || null;
        depth += 1;
        continue;
      }
      cur = parent;
      depth += 1;
    }
    return cur === rootEl ? depth : Number.POSITIVE_INFINITY;
  } catch (e) {
    return Number.POSITIVE_INFINITY;
  }
}

function hasShareButtonEvidence(el) {
  try {
    if (!el || !el.querySelectorAll) return false;
    if (findInShadow(el, 'shreddit-post-share-button')) return true;
    if (findInShadow(el, '[data-ad-rendering-role="share_button"]')) return true;
    if (/send-as-message|send-privately|share/i.test(String(el.getAttribute?.('data-view-name') || ''))) return true;
    const candidates = queryAllInOpenShadow(
      el,
      'button,a[href],[role="button"],[role="link"],[data-ad-rendering-role="share_button"],shreddit-post-share-button'
    );
    for (const node of candidates) {
      if (!node || node.nodeType !== 1) continue;
      const tag = String(node.tagName || '').toLowerCase().trim();
      if (tag === 'shreddit-post-share-button') return true;
      const explicitShareAttr = String(node.getAttribute?.('data-ad-rendering-role') || '').toLowerCase().trim();
      if (explicitShareAttr === 'share_button') return true;
      const viewName = String(node.getAttribute?.('data-view-name') || '').toLowerCase().trim();
      if (/send-as-message|send-privately|share/.test(viewName)) return true;
      const aria = String(node.getAttribute?.('aria-label') || '').trim();
      const txt = normalizeText(node.textContent || '');
      const svgIds = queryAllInOpenShadow(node, 'svg[id]')
        .map((s) => String(s.getAttribute?.('id') || '').toLowerCase().trim())
        .filter(Boolean)
        .join(' ');
      const svgTitles = queryAllInOpenShadow(node, 'svg title')
        .map((t) => normalizeText(t.textContent || ''))
        .filter(Boolean)
        .join(' ');
      const bag = `${aria} ${txt} ${svgTitles} ${svgIds}`.toLowerCase();
      if (!bag) continue;
      if (SHARE_KEYWORDS.some((k) => bag.includes(String(k).toLowerCase()))) return true;
      if (/(\bshare\b|공유)/i.test(bag)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function getShareButtonRelativeDepth(el) {
  try {
    if (!el || el.nodeType !== 1 || !el.querySelectorAll) return Number.POSITIVE_INFINITY;
    const selectors = [
      'shreddit-post-share-button',
      '[data-ad-rendering-role="share_button"]',
      'button,[role="button"],[role="link"]',
    ];
    const nodes = [];
    for (const sel of selectors) {
      nodes.push(...queryAllInOpenShadow(el, sel));
    }
    const hasShareSemantics = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = String(node.tagName || '').toLowerCase().trim();
      if (tag === 'shreddit-post-share-button') return true;
      const explicitShareAttr = String(node.getAttribute?.('data-ad-rendering-role') || '').toLowerCase().trim();
      if (explicitShareAttr === 'share_button') return true;
      const viewName = String(node.getAttribute?.('data-view-name') || '').toLowerCase().trim();
      if (/send-as-message|send-privately|share/.test(viewName)) return true;
      const aria = String(node.getAttribute?.('aria-label') || '').trim();
      const txt = normalizeText(node.textContent || '');
      const bag = `${aria} ${txt}`.toLowerCase();
      return SHARE_KEYWORDS.some((k) => bag.includes(String(k).toLowerCase())) || /(\bshare\b|공유)/i.test(bag);
    };
    let best = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      if (!hasShareSemantics(node)) continue;
      const d = getFlattenedDepthWithin(el, node);
      if (!isFinite(d)) continue;
      if (d < best) best = d;
    }
    return best;
  } catch (e) {
    return Number.POSITIVE_INFINITY;
  }
}

async function getEvidenceType(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    // Only run Type B detection on platforms where share-button based
    // post detection is intentionally supported.
    if (TYPE_B_PLATFORMS.has(getCurrentPlatform()) && hasShareButtonEvidence(el)) {
      return EVIDENCE_TYPE_INTERACTION;
    }
    if (await hasValidAbsoluteAnchor(el)) return EVIDENCE_TYPE_ANCHOR;
    return '';
  } catch (e) {
    return '';
  }
}

function isVisibleAndSized(el) {
  try {
    if (!el || !el.getBoundingClientRect) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    const r = el.getBoundingClientRect();
    return !!r && r.width >= MIN_CANDIDATE_SIZE && r.height >= MIN_CANDIDATE_SIZE;
  } catch (e) {
    return false;
  }
}

function isNearFullscreenCandidate(el, threshold = TYPE_B_FULLSCREEN_COVERAGE_THRESHOLD) {
  try {
    if (!el || !el.getBoundingClientRect) return false;
    const viewportWidth = Math.max(0, Number(window?.innerWidth) || 0);
    const viewportHeight = Math.max(0, Number(window?.innerHeight) || 0);
    if (viewportWidth <= 0 || viewportHeight <= 0) return false;
    const rect = el.getBoundingClientRect();
    if (!rect) return false;
    const itemWidth = Math.max(0, rect.width);
    const itemHeight = Math.max(0, rect.height);
    const minWidth = viewportWidth * threshold;
    const minHeight = viewportHeight * threshold;
    return itemWidth >= minWidth && itemHeight >= minHeight;
  } catch (e) {
    return false;
  }
}

function getRelativeSpread(values) {
  if (!values || values.length === 0) return 1;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (!isFinite(mean) || mean <= 0) return 1;
  return (max - min) / mean;
}

function validateVisualLayout(elements) {
  if (!Array.isArray(elements) || elements.length < 2) return false;
  const rects = [];
  for (const el of elements) {
    if (!el || !el.getBoundingClientRect) continue;
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) continue;
    rects.push({ width: r.width, height: r.height });
  }
  if (rects.length < 2) return false;

  const widthSpread = getRelativeSpread(rects.map((r) => r.width));
  const heightSpread = getRelativeSpread(rects.map((r) => r.height));
  return widthSpread <= 0.30 || heightSpread <= 0.30;
}

function hasAriaActiveState(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const selfSelected = String(el.getAttribute?.('aria-selected') || '').toLowerCase().trim() === 'true';
    const selfCurrent = String(el.getAttribute?.('aria-current') || '').toLowerCase().trim();
    if (selfSelected) return true;
    if (selfCurrent && ['page', 'step', 'location', 'date', 'time', 'true'].includes(selfCurrent)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function hasLinearAlignment(elements) {
  try {
    if (!Array.isArray(elements) || elements.length < 2) return false;
    const centersX = [];
    const centersY = [];
    for (const el of elements) {
      if (!el?.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      centersX.push(r.left + r.width / 2);
      centersY.push(r.top + r.height / 2);
    }
    if (centersX.length < 2 || centersY.length < 2) return false;
    const spreadX = getRelativeSpread(centersX);
    const spreadY = getRelativeSpread(centersY);
    // Horizontal tab row => low Y spread, Vertical menu => low X spread.
    return spreadY <= 0.25 || spreadX <= 0.25;
  } catch (e) {
    return false;
  }
}

function hasNavSemantics(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const navRoles = new Set(['tab', 'menuitem', 'option', 'button', 'tablist', 'menubar', 'navigation', 'banner']);
    const roleSelf = String(el.getAttribute?.('role') || '').toLowerCase().trim();
    if (navRoles.has(roleSelf)) return true;
    const parent = el.parentElement;
    const roleParent = String(parent?.getAttribute?.('role') || '').toLowerCase().trim();
    return navRoles.has(roleParent);
  } catch (e) {
    return false;
  }
}

// Static translation map for multilingual aria-label values.
// Maps non-English account/login-related terms to their English equivalents
// so hasNavKeywords() can match them with a single English pattern.
const ARIA_LABEL_TRANSLATIONS = {
  // Korean
  '로그인': 'login',
  '계정': 'account',
  '회원': 'member',
  '내 정보': 'account',
  '마이페이지': 'mypage',
  // Japanese
  'ログイン': 'login',
  'アカウント': 'account',
  '会員': 'member',
  'マイページ': 'mypage',
  'ユーザー': 'user',
  // Simplified Chinese
  '登录': 'login',
  '账户': 'account',
  '会员': 'member',
  '我的': 'mypage',
  '用户': 'user',
  // Traditional Chinese
  '登入': 'login',
  '帳戶': 'account',
  '會員': 'member',
  '用戶': 'user',
};

function hasNavKeywords(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const selfTestId = String(el.getAttribute?.('data-test-id') || '');
    const rawAriaLabel = String(el.getAttribute?.('aria-label') || '');
    // Translate multilingual aria-label to English before keyword matching
    const translatedAriaLabel = ARIA_LABEL_TRANSLATIONS[rawAriaLabel.trim()] || rawAriaLabel;
    const bag = `${el.id || ''} ${el.className || ''} ${selfTestId} ${translatedAriaLabel}`.toLowerCase();
    return /(nav|menu|breadcrumb|pagination|footer-link|home-tab|vertical-nav|toolbar|tab\b|login|account|signin|sign-in|mypage|member\b|user\b|profile\b)/.test(bag);
  } catch (e) {
    return false;
  }
}

function hasNavTestIdSignals(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const isLikelySmallControl = (() => {
      const role = String(el.getAttribute?.('role') || '').toLowerCase().trim();
      if (role === 'button' || role === 'tab' || role === 'menuitem') return true;
      if (el.tagName === 'BUTTON') return true;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) return false;
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      return area > 0 && area <= 120 * 120;
    })();
    const ids = [String(el.getAttribute?.('data-test-id') || '').toLowerCase()];
    if (isLikelySmallControl) {
      ids.push(String(el.parentElement?.getAttribute?.('data-test-id') || '').toLowerCase());
    }
    for (const id of ids) {
      if (!id) continue;
      if (/(^|[-_])(nav|menu|tab|icon)([-_]|$)/.test(id)) return true;
      if (id.includes('home-tab') || id.includes('vertical-nav')) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function hasHardNavTestIdBlacklist(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const ids = [
      String(el.getAttribute?.('data-test-id') || '').toLowerCase(),
      String(el.parentElement?.getAttribute?.('data-test-id') || '').toLowerCase(),
    ];
    for (const id of ids) {
      if (!id) continue;
      if (id.includes('-tab') || id.includes('_tab')) return true;
      if (id.includes('-icon') || id.includes('_icon')) return true;
      if (id.includes('-button') || id.includes('_button')) return true;
      if (id.includes('logo')) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function countMeaningfulVisuals(el) {
  try {
    if (!el || !el.querySelectorAll) return 0;
    const mediaNodes = el.querySelectorAll('img,video,picture,canvas,svg,[style*="background-image"],[role="img"]');
    let count = 0;
    for (const n of mediaNodes) {
      if (!n || n.nodeType !== 1) continue;
      const tag = String(n.tagName || '').toUpperCase();
      const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      const area = r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
      if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') {
        if (!r || area > 1) count += 1;
        continue;
      }
      if (tag === 'PICTURE') {
        count += 1;
        continue;
      }
      if (tag === 'SVG') {
        if (r && r.width >= 64 && r.height >= 64) count += 1;
        continue;
      }
      if (n.getAttribute && String(n.getAttribute('style') || '').includes('background-image')) {
        if (area > 5000) count += 1;
      }
    }
    return count;
  } catch (e) {
    return 0;
  }
}

function isTinyElement(el, maxArea = 10000) {
  try {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (!r) return false;
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    return area > 0 && area < maxArea;
  } catch (e) {
    return false;
  }
}

function getTextLen(el) {
  try {
    const t = normalizeText(el?.textContent || '');
    return t.length;
  } catch (e) {
    return 0;
  }
}

function hasImageAndText(el) {
  try {
    if (!el || !el.querySelector) return false;
    const hasImg = countMeaningfulVisuals(el) > 0;
    const hasHeading = !!el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],.title,[data-title]');
    const textLen = getTextLen(el);
    return hasImg && (hasHeading || textLen > 20);
  } catch (e) {
    return false;
  }
}

function hasMultipleTextBlocks(el) {
  try {
    if (!el || !el.querySelectorAll) return false;
    const blocks = Array.from(el.querySelectorAll('p,li,span,div,small,strong,b,time,[data-price],[data-date],[data-category]'))
      .filter((n) => getTextLen(n) >= 6);
    return blocks.length >= 2;
  } catch (e) {
    return false;
  }
}

function isSingleActionBias(el) {
  try {
    if (!el || !el.querySelector) return false;
    const hasIcon = !!el.querySelector('svg,i,[class*="icon"]');
    const textLen = getTextLen(el);
    const hasImgOrVideo = !!el.querySelector('img,video');
    const hasOtherMedia = !!el.querySelector('canvas,picture,[style*="background-image"]');
    const svgs = Array.from(el.querySelectorAll('svg'));
    const hasSmallSvg = svgs.some((s) => {
      const r = s.getBoundingClientRect ? s.getBoundingClientRect() : null;
      return !!r && r.width > 0 && r.height > 0 && r.width < 64 && r.height < 64;
    });
    const hasLargeSvg = svgs.some((s) => {
      const r = s.getBoundingClientRect ? s.getBoundingClientRect() : null;
      return !!r && r.width >= 64 && r.height >= 64;
    });
    return hasIcon && textLen <= 20 && !hasImgOrVideo && !hasOtherMedia && hasSmallSvg && !hasLargeSvg;
  } catch (e) {
    return false;
  }
}

function isTinyFootprint(elements) {
  try {
    if (!Array.isArray(elements) || elements.length === 0) return false;
    const areas = [];
    for (const el of elements) {
      if (!el?.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (!r) continue;
      areas.push(Math.max(0, r.width) * Math.max(0, r.height));
    }
    if (areas.length === 0) return false;
    const avgArea = areas.reduce((s, a) => s + a, 0) / areas.length;
    return avgArea < 100 * 100;
  } catch (e) {
    return false;
  }
}

async function collectDeepContentStats(el) {
  try {
    if (!el || el.nodeType !== 1) {
      return { textLen: 0, anchorCount: 0, mediaCount: 0, visualCount: 0, blockCount: 0 };
    }
    const textLen = getTextLen(el);
    const anchors = el.querySelectorAll ? Array.from(el.querySelectorAll('a[href]') || []) : [];
    const anchorResults = await Promise.all(anchors.map((a) => isValidTypeAAnchor(a)));
    const anchorCount = anchorResults.filter(Boolean).length;
    const mediaCount = el.querySelectorAll ? el.querySelectorAll('img,video,picture,canvas').length : 0;
    const visualCount = countMeaningfulVisuals(el);
    const blockCount = el.querySelectorAll
      ? Array.from(el.querySelectorAll('p,li,span,div,small,strong,b,time,[data-price],[data-date],[data-category]'))
          .filter((n) => getTextLen(n) >= 6).length
      : 0;
    return { textLen, anchorCount, mediaCount, visualCount, blockCount };
  } catch (e) {
    return { textLen: 0, anchorCount: 0, mediaCount: 0, visualCount: 0, blockCount: 0 };
  }
}

async function isMeaningfulItemMap(elements, evidenceType = EVIDENCE_TYPE_ANCHOR) {
  if (!Array.isArray(elements) || elements.length === 0) return false;
  if (evidenceType === EVIDENCE_TYPE_INTERACTION && elements.length >= 2) {
    const shareCountEarly = elements.filter((el) => hasShareButtonEvidence(el)).length;
    // Explicit quorum override: allow exact-2 Type B groups when both have share evidence.
    if (elements.length === 2 && shareCountEarly === 2) return true;
  }
  const stats = await Promise.all(elements.map((el) => collectDeepContentStats(el)));
  const avgText = stats.reduce((s, x) => s + x.textLen, 0) / Math.max(1, stats.length);
  const avgAnchors = stats.reduce((s, x) => s + x.anchorCount, 0) / Math.max(1, stats.length);
  const avgMedia = stats.reduce((s, x) => s + x.mediaCount, 0) / Math.max(1, stats.length);
  const avgVisual = stats.reduce((s, x) => s + (x.visualCount || 0), 0) / Math.max(1, stats.length);
  const strongContentCount = stats.filter((x) => x.textLen >= 40 && x.anchorCount >= 2).length;
  const mediaRichCount = stats.filter((x) => x.mediaCount >= 1 && x.anchorCount >= 1).length;
  const hasStrongContentMajority =
    strongContentCount >= Math.ceil(elements.length * 0.5) ||
    mediaRichCount >= Math.ceil(elements.length * 0.5);

  const navCount = elements.filter((el) => hasNavSemantics(el) || hasNavKeywords(el) || hasNavTestIdSignals(el)).length;
  const activeStateCount = elements.filter((el) => hasAriaActiveState(el)).length;
  const hasSingleActiveItem = activeStateCount === 1;
  const hasLinearLayout = hasLinearAlignment(elements);
  const navConfidenceBoost = hasSingleActiveItem ? Math.ceil(elements.length * 0.5) : 0;
  const navConfidenceScore = navCount + navConfidenceBoost;
  const hardNavTinyCount = elements.filter((el) => hasHardNavTestIdBlacklist(el) && isTinyElement(el, 10000)).length;
  if (hardNavTinyCount >= Math.ceil(elements.length * 0.4) && avgVisual < 0.5) return false;
  if (navConfidenceScore >= Math.ceil(elements.length * 0.5) && !hasStrongContentMajority) return false;

  const actionBiasCount = elements.filter((el) => isSingleActionBias(el)).length;
  if (actionBiasCount >= Math.ceil(elements.length * 0.6)) return false;

  // Reject groups where most elements contain menu-style class names
  // on inner descendants — these are navigation menu boxes that look
  // like content but are purely navigational (e.g. p-menu__item,
  // dropdown-item, nav-item, menu-item).
  const MENU_CLASS_PATTERN = /\b(menu[-_]item|dropdown[-_]item|nav[-_]item|menu[-_]link|nav[-_]link|p-menu)\b/i;
  const innerMenuCount = elements.filter((el) => {
    try {
      const inner = el.querySelectorAll?.('[class]') || [];
      return Array.from(inner).some((n) => MENU_CLASS_PATTERN.test(String(n.className || '')));
    } catch (_) { return false; }
  }).length;
  if (innerMenuCount >= Math.ceil(elements.length * 0.6)) return false;

  const highConfidenceMenuTab =
    activeStateCount > 0 &&
    hasLinearLayout &&
    (
      navCount >= Math.ceil(elements.length * 0.4) ||
      actionBiasCount >= Math.ceil(elements.length * 0.5) ||
      hasSingleActiveItem
    );
  if (
    evidenceType === EVIDENCE_TYPE_ANCHOR &&
    highConfidenceMenuTab &&
    !hasStrongContentMajority &&
    avgVisual < 1 &&
    avgText < 40
  ) {
    return false;
  }

  if (
    isTinyFootprint(elements) &&
    avgVisual < 0.5 &&
    (hardNavTinyCount > 0 || navConfidenceScore > 0 || actionBiasCount > 0)
  ) return false;

  const richCount = elements.filter((el) => hasImageAndText(el) || hasMultipleTextBlocks(el) || getTextLen(el) > 20).length;
  if (richCount >= Math.ceil(elements.length * 0.4)) return true;

  if (evidenceType === EVIDENCE_TYPE_ANCHOR) {
    let hasValidTypeASignal = false;
    for (const el of elements) {
      if (await hasValidAbsoluteAnchor(el)) {
        hasValidTypeASignal = true;
        break;
      }
    }
    if (!hasValidTypeASignal || avgAnchors < 1) return false;
    if (avgVisual >= 1) return true;
  } else if (evidenceType === EVIDENCE_TYPE_INTERACTION) {
    const shareCount = elements.filter((el) => hasShareButtonEvidence(el)).length;
    if (shareCount < Math.ceil(elements.length * 0.5)) return false;
    if (elements.length >= 2 && shareCount >= 2) return true;
  }

  if (avgMedia >= 1 && avgText >= 8) return true;

  if (avgText < 12 && richCount === 0) return false;
  return avgText > 20;
}

function detectFacebookFallback(root, existingElements = new Set()) {
  try {
    const href = String(window?.location?.href || '').trim();
    if (!href) return [];
    const isFacebookHome = href === 'https://www.facebook.com/';
    if (!isFacebookHome) return [];
    if (!root || typeof root.querySelectorAll !== 'function') return [];

    const toAbsoluteHref = (rawHref) => {
      const raw = String(rawHref || '').trim();
      if (!raw) return '';
      try {
        return new URL(raw, window.location.href).href;
      } catch (e) {
        return raw;
      }
    };
    const sanitizeShortcode = (absoluteHref) => {
      const s = String(absoluteHref || '').trim();
      if (!s) return '';
      try {
        const u = new URL(s, window.location.href);
        const base = `${u.origin}${u.pathname}${u.search}`.trim();
        return base || u.href;
      } catch (e) {
        return s;
      }
    };

    const out = [];
    const units = Array.from(root.querySelectorAll('div[data-pagelet="FeedUnit_0"], div[data-pagelet="FeedUnit_1"]') || []);
    for (const unit of units) {
      if (!unit || unit.nodeType !== 1) continue;
      if (existingElements.has(unit)) continue;

      const linkNodes = Array.from(unit.querySelectorAll?.('a[role="link"][href]') || []);
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
      const orderedLinks = [
        ...linkNodes.filter((a) => isDateTimeAriaLabel(a)),
        ...linkNodes.filter((a) => !isDateTimeAriaLabel(a)),
      ];
      let activeHoverUrl = '';
      let shortcode = '';
      for (const a of orderedLinks) {
        const rawHref = String(a.getAttribute?.('href') || a.href || '').trim();
        if (!rawHref) continue;
        const abs = toAbsoluteHref(rawHref);
        const normalized = sanitizeShortcode(abs);
        if (abs && normalized) {
          activeHoverUrl = abs;
          shortcode = normalized;
          break;
        }
      }
      if (!activeHoverUrl) activeHoverUrl = 'https://www.facebook.com/';
      if (!shortcode) shortcode = 'https://www.facebook.com/';

      const hasMedia = !!unit.querySelector?.('video, img');
      const pagelet = String(unit.getAttribute?.('data-pagelet') || '').trim();
      const identitySig = getElementSignature(unit) || 'DIV::A:fb_feedunit_fallback';
      const structureSig = getInternalStructure(unit, 3) || 'fb_fallback_structure';
      const signature = `FB_FALLBACK::${pagelet || 'unknown'}::${identitySig}::${structureSig}`;
      out.push({
        key: signature,
        signature,
        itemMapSignature: signature,
        identitySignature: identitySig,
        structureSignature: structureSig,
        evidenceType: EVIDENCE_TYPE_INTERACTION,
        element: unit,
        similarityType: 'facebook-feedunit-fallback',
        classPattern: '',
        attrKey: 'data-pagelet',
        attrValue: pagelet,
        shortcode,
        activeHoverUrl,
        platform: 'facebook',
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * Type C ItemMap detection: Gmail and Naver Mail.
 * Gmail: each <tr> under table.F.cf.zt > tbody.
 * Naver Mail: each <li class="mail_item"> when URL matches /v2/folders/\d+/.
 */
export function detectTypeCItemMaps(root = document) {
  try {
    const href = String(window?.location?.href || '').trim();
    const out = [];

    if (href.startsWith('https://mail.google.com/mail/u/0/')) {
      const tables = Array.from(
        root.querySelectorAll?.('table.F.cf.zt') || []
      );
      for (const table of tables) {
        const tbodies = Array.from(table.querySelectorAll?.('tbody') || []);
        for (const tbody of tbodies) {
          const rows = Array.from(tbody.children || []).filter(
            (el) => el && el.nodeType === 1 &&
              String(el.tagName || '').toUpperCase() === 'TR'
          );
          for (const tr of rows) {
            if (!tr || tr.nodeType !== 1) continue;
            const sig = `GMAIL_INBOX_TR::${tr.id || tr.className || ''}`;
            out.push({
              key:              sig,
              signature:        sig,
              itemMapSignature: sig,
              identitySignature: sig,
              structureSignature: 'gmail-inbox-tr',
              evidenceType:     EVIDENCE_TYPE_C,
              element:          tr,
              similarityType:   'gmail-inbox-type-c',
              classPattern:     '',
              attrKey:          '',
              attrValue:        '',
            });
          }
        }
      }
    }

    // ── Naver Mail ───────────────────────────────────────────────────────────
    // Activates when URL starts with https://mail.naver.com/v2/folders/
    // followed by a numeric folder ID (e.g. /v2/folders/0, /v2/folders/1)
    const isNaverMail = /^https:\/\/mail\.naver\.com\/v2\/folders\/-?\d+/.test(href);
    if (isNaverMail) {
      const mailItems = Array.from(
        root.querySelectorAll?.('li.mail_item') || []
      );
      for (const li of mailItems) {
        if (!li || li.nodeType !== 1) continue;
        const sig = `NAVER_MAIL_LI::${li.className || ''}`;
        out.push({
          key:               sig,
          signature:         sig,
          itemMapSignature:  sig,
          identitySignature: sig,
          structureSignature: 'naver-mail-li',
          evidenceType:      EVIDENCE_TYPE_C,
          element:           li,
          similarityType:    'naver-mail-type-c',
          classPattern:      '',
          attrKey:           '',
          attrValue:         '',
        });
      }
    }

    return out;
  } catch (e) {
    return [];
  }
}

function getDepthFromBody(el) {
  let depth = 0;
  let cur = el;
  while (cur && cur !== document.body) {
    depth++;
    cur = cur.parentElement;
    if (depth > 10) break; // cap to avoid infinite loop
  }
  return depth;
}

function isLayoutHeaderFooterElement(el) {
  try {
    let depth = 0;
    let cur = el;
    while (cur && cur !== document.body) {
      depth++;
      cur = cur.parentElement;
    }
    if (depth > 4) return false;
    const tag  = String(el.tagName || '').toUpperCase();
    const role = String(el.getAttribute?.('role') || '').toLowerCase();
    const id   = String(el.id || '').toLowerCase();
    const cls  = String(el.className || '').toLowerCase();
    return (
      tag === 'HEADER' || tag === 'FOOTER' ||
      role === 'banner'      || role === 'contentinfo' ||
      /\bheader\b/.test(id)  || /\bfooter\b/.test(id)  ||
      /\bheader\b/.test(cls) || /\bfooter\b/.test(cls)
    );
  } catch (e) {
    return false;
  }
}

export async function detectItemMaps(root = document) {
  try {
    const candidates = [];
    const parents = Array.from(
      root && root.querySelectorAll
        ? root === document
          ? root.querySelectorAll('body *')
          : root.querySelectorAll('*')
        : []
    );
    // Yield to the browser every CHUNK_SIZE elements so rAF frames
    // can run between chunks, preventing animation jank on complex pages.
    const CHUNK_SIZE = 500;
    let chunkCount = 0;
    for (const parent of parents) {
      chunkCount++;
      if (chunkCount % CHUNK_SIZE === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!parent || !parent.children || parent.children.length < 2) continue;

      // Exclude <header> and <footer> semantic tags and any element inside them
      const parentTag = String(parent.tagName || '').toUpperCase();
      if (parentTag === 'FOOTER' || parentTag === 'HEADER') continue;
      if (parent.closest?.('footer, header')) continue;

      // Exclude shallow layout elements that act as header/footer
      // (e.g. <div id="header" role="banner"> at depth ≤ 4 from body)
      const depth = getDepthFromBody(parent);
      if (depth <= 4) {
        const role = String(parent.getAttribute?.('role') || '').toLowerCase();
        const id   = String(parent.id || '').toLowerCase();
        const cls  = String(parent.className || '').toLowerCase();
        const isLayoutHeaderFooter =
          role === 'banner'      || role === 'contentinfo' ||
          /\bheader\b/.test(id)  || /\bfooter\b/.test(id)  ||
          /\bheader\b/.test(cls) || /\bfooter\b/.test(cls);
        if (isLayoutHeaderFooter) continue;
      }

      // Exclude comment containers — children of elements whose tag, id,
      // or class contains "comment" must not form an ItemMap.
      if (hasCommentKeyword(parent)) continue;

      const children = Array.from(parent.children).filter(Boolean);
      const groups = new Map();
      let i = 0;
      while (i < children.length) {
        const startRaw = children[i];
        const startTag = String(startRaw?.tagName || '').toUpperCase();
        const start = promoteGhostWrapper(startRaw);
        if (!start || INTERRUPTION_TAGS.has(startTag)) {
          i += 1;
          continue;
        }
        if (hasCommentKeyword(start)) {
          i += 1;
          continue;
        }
        const identitySig = getElementSignature(start);
        if (!identitySig) {
          i += 1;
          continue;
        }
        const evidenceType = await getEvidenceType(start);
        if (!evidenceType) {
          i += 1;
          continue;
        }
        const structureSig = getInternalStructure(start, 3);
        if (!structureSig) {
          i += 1;
          continue;
        }
        const run = [start];
        let j = i + 1;
        while (j < children.length) {
          const curRaw = children[j];
          const curTag = String(curRaw?.tagName || '').toUpperCase();
          if (!curRaw) {
            j += 1;
            continue;
          }
          if (INTERRUPTION_TAGS.has(curTag)) {
            j += 1;
            continue;
          }
          const cur = promoteGhostWrapper(curRaw);
          const nextIdentity = getElementSignature(cur);
          if (!nextIdentity) break;
          let identityMatch = isSimilarIdentity(identitySig, nextIdentity, 0.8);
          if (!identityMatch.matched && evidenceType === EVIDENCE_TYPE_ANCHOR) {
            const startHasNavState =
              hasAriaActiveState(start) || hasNavSemantics(start) || hasNavKeywords(start) || hasNavTestIdSignals(start);
            const curHasNavState =
              hasAriaActiveState(cur) || hasNavSemantics(cur) || hasNavKeywords(cur) || hasNavTestIdSignals(cur);
            if (startHasNavState || curHasNavState) {
              // Allow active-tab class drift to remain in the same functional list.
              identityMatch = isSimilarIdentity(identitySig, nextIdentity, 0.6);
            }
          }
          if (!identityMatch.matched) break;
          const nextEvidence = await getEvidenceType(cur);
          if (!nextEvidence || nextEvidence !== evidenceType) break;
          const nextStructure = getInternalStructure(cur, 3);
          const exactStructureMatch = !!nextStructure && nextStructure === structureSig;
          let typeBFuzzyStructureMatch = false;
          if (!exactStructureMatch && evidenceType === EVIDENCE_TYPE_INTERACTION) {
            const shareSeed = hasShareButtonEvidence(start);
            const shareCur = hasShareButtonEvidence(cur);
            if (shareSeed && shareCur) {
              const overlap = getStructureOverlapRatio(structureSig, nextStructure);
              const depthA = getShareButtonRelativeDepth(start);
              const depthB = getShareButtonRelativeDepth(cur);
              const similarShareDepth = isFinite(depthA) && isFinite(depthB) && Math.abs(depthA - depthB) <= 2;
              typeBFuzzyStructureMatch = overlap >= 0.65 && similarShareDepth;
            }
          }
          if (exactStructureMatch || typeBFuzzyStructureMatch) {
            run.push(cur);
            j += 1;
            continue;
          }
          break;
        }
        const itemMapSignature = `${identitySig}::F:${structureSig}::E:${evidenceType}`;
        if (!groups.has(itemMapSignature)) {
          groups.set(itemMapSignature, { signature: itemMapSignature, identitySig, structureSig, evidenceType, list: [] });
        }
        groups.get(itemMapSignature).list.push(...run);
        i = Math.max(j, i + 1);
      }
      for (const [, group] of groups.entries()) {
        const itemMapSignature = group.signature;
        const identitySig = group.identitySig || '';
        const structureSig = group.structureSig || '';
        const evidenceType = group.evidenceType || '';
        const minGroupSize = 2;
        const list = Array.from(new Set(group.list || []));
        if (list.length < minGroupSize) continue;
        const passed = [];
        for (const el of list) {
          if (!isVisibleAndSized(el)) continue;
          if ((await getEvidenceType(el)) === evidenceType) passed.push(el);
        }
        if (passed.length < minGroupSize) continue;
        if (!validateVisualLayout(passed)) continue;
        if (!(await isMeaningfulItemMap(passed, evidenceType))) continue;
        for (const el of passed) {
          const parts = identitySig.split('::');
          candidates.push({
            key: itemMapSignature,
            signature: itemMapSignature,
            itemMapSignature,
            identitySignature: identitySig,
            structureSignature: structureSig,
            evidenceType,
            element: el,
            similarityType: 'composite',
            classPattern: parts[1] || '',
            attrKey: parts[0] || '',
            attrValue: parts[2] || '',
          });
        }
      }
    }
    const uniqByEl = new Map();
    const deduped = [];
    for (const item of candidates) {
      if (!item?.element) continue;
      if (uniqByEl.has(item.element)) continue;
      uniqByEl.set(item.element, item);
      deduped.push(item);
    }

    const recovered = [...deduped];
    const recoveredSet = new Set(recovered.map((x) => x.element).filter(Boolean));
    const visitedParentTag = new Set();
    const getMeaningfulClassSet = (el) => {
      try {
        if (!el || el.nodeType !== 1) return new Set();
        const noise = new Set(['style-scope']);
        const tokens = normalizeText(el.className || '')
          .split(/\s+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .filter((t) => !noise.has(t));
        return new Set(tokens);
      } catch (e) {
        return new Set();
      }
    };
    const hasPartialClassOverlap = (seedEl, candidateEl) => {
      try {
        if (!seedEl || !candidateEl || seedEl.nodeType !== 1 || candidateEl.nodeType !== 1) return false;
        const seedTag = String(seedEl.tagName || '').toUpperCase();
        const candTag = String(candidateEl.tagName || '').toUpperCase();
        if (!seedTag || !candTag || seedTag !== candTag) return false;
        const seedSet = getMeaningfulClassSet(seedEl);
        const candSet = getMeaningfulClassSet(candidateEl);
        if (seedSet.size === 0 || candSet.size === 0) return false;
        for (const t of seedSet) {
          if (candSet.has(t)) return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    };
    const isSimpleWrapperNode = (node) => {
      try {
        if (!node || node.nodeType !== 1) return false;
        const tag = String(node.tagName || '').toUpperCase();
        if (tag !== 'DIV' && tag !== 'SPAN') return false;
        if (String(node.id || '').trim()) return false;

        const clsTokens = normalizeText(node.className || '')
          .split(/\s+/)
          .map((t) => t.trim())
          .filter(Boolean);
        const frameworkNoise = new Set(['style-scope']);
        if (clsTokens.length > 0 && !clsTokens.every((t) => frameworkNoise.has(t))) return false;

        const attrs = Array.from(node.attributes || []);
        for (const attr of attrs) {
          const name = String(attr?.name || '').toLowerCase().trim();
          if (!name) continue;
          if (name === 'class' || name === 'style') continue;
          if (name.startsWith('data-') || name.startsWith('aria-')) continue;
          return false;
        }
        return true;
      } catch (e) {
        return false;
      }
    };
    const iframeHasValidTypeASignal = async (iframeEl) => {
      try {
        if (!iframeEl || iframeEl.nodeType !== 1 || String(iframeEl.tagName || '').toUpperCase() !== 'IFRAME') return false;

        // 1) Same-origin iframe DOM anchors (strict Type A signal validation).
        try {
          const doc = iframeEl.contentDocument || iframeEl.contentWindow?.document || null;
          if (doc && typeof doc.querySelectorAll === 'function') {
            const anchors = Array.from(doc.querySelectorAll('a[href]') || []);
            for (const a of anchors) {
              if (await isValidTypeAAnchor(a)) return true;
            }
          }
        } catch (e) {
          // Cross-origin/inaccessible iframe; fallback to src check below.
        }

        // 2) Fallback to iframe src as a verifiable DISCOVERY target (probe is synthetic; use resolveAnchorUrl).
        const rawSrc = String(iframeEl.getAttribute?.('src') || iframeEl.src || '').trim();
        if (!rawSrc) return false;
        const probe = document.createElement('a');
        probe.setAttribute('href', rawSrc);
        return !!resolveAnchorUrl(probe);
      } catch (e) {
        return false;
      }
    };
    // Relaxed anchor check for 2nd-pass sibling recovery:
    // only requires at least one href with an absolute URL (http/https).
    const hasRelaxedAbsoluteAnchor = (el) => {
      try {
        if (!el || !el.querySelectorAll) return false;
        const anchors = Array.from(el.querySelectorAll('a[href]') || []);
        for (const a of anchors) {
          const href = String(a.getAttribute?.('href') || '').trim();
          if (/^https?:\/\//i.test(href)) return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    };
    const typeASeeds = deduped.filter((x) => x?.evidenceType === EVIDENCE_TYPE_ANCHOR && x?.element);
    for (const seed of typeASeeds) {
      const seedEl = seed.element;
      const parent = seedEl?.parentElement;
      if (!parent || !parent.children) continue;
      const seedTag = String(seedEl.tagName || '').toUpperCase();
      if (!seedTag) continue;
      const expansionRoots = [{ node: parent, viaSimpleWrapperBypass: false, wrapper: null }];
      if (isSimpleWrapperNode(parent) && parent.parentElement) {
        expansionRoots.push({ node: parent.parentElement, viaSimpleWrapperBypass: true, wrapper: parent });
      }

      for (const rootInfo of expansionRoots) {
        const root = rootInfo.node;
        if (!root || !root.children) continue;
        const marker = `${seedTag}::${Array.from(root.children || []).length}::${rootInfo.viaSimpleWrapperBypass ? 'wrapper-bypass' : 'direct'}`;
        const visitKey = `${marker}::${root.dataset?.viewName || root.id || root.className || ''}`;
        if (visitedParentTag.has(visitKey)) continue;
        visitedParentTag.add(visitKey);

        const siblings = Array.from(root.children).filter(Boolean);
        for (const siblingRaw of siblings) {
          if (rootInfo.viaSimpleWrapperBypass && siblingRaw === rootInfo.wrapper) continue;
          const sibling = promoteGhostWrapper(siblingRaw);
          if (!sibling || sibling.nodeType !== 1) continue;
          if (recoveredSet.has(sibling)) continue;
          if (!isVisibleAndSized(sibling)) continue;

          if (!hasPartialClassOverlap(seedEl, sibling)) continue;
          const siblingIdentity = getElementSignature(sibling);

          const siblingTag = String(sibling.tagName || '').toUpperCase();
          const isIframeSibling = siblingTag === 'IFRAME';
          const nestedIframes = !isIframeSibling ? Array.from(sibling.querySelectorAll?.('iframe') || []) : [];
          if (nestedIframes.length > 0) {
            let hasValidNestedIframeSignal = false;
            for (const frame of nestedIframes) {
              if (await iframeHasValidTypeASignal(frame)) {
                hasValidNestedIframeSignal = true;
                break;
              }
            }
            if (!hasValidNestedIframeSignal) {
              continue;
            }
          } else if (isIframeSibling) {
            const validIframeSignal = await iframeHasValidTypeASignal(sibling);
            if (!validIframeSignal) continue;
          } else {
            if (!hasRelaxedAbsoluteAnchor(sibling)) continue;
          }

          // Apply nav guard rails — same signals used in isMeaningfulItemMap()
          // to exclude nav/banner/account UI regions that slipped through.
          if (hasNavSemantics(sibling) || hasNavKeywords(sibling)) continue;

          if (rootInfo.viaSimpleWrapperBypass) {
            const cls = String(sibling.className || '').trim();
          }
          recovered.push({
            key: `${seed.key || seed.signature || ''}::R`,
            signature: `${seed.signature || seed.key || ''}::R`,
            itemMapSignature: `${seed.itemMapSignature || seed.signature || seed.key || ''}::R`,
            identitySignature: siblingIdentity || seed.identitySignature || '',
            structureSignature: getInternalStructure(sibling, 3) || seed.structureSignature || '',
            evidenceType: EVIDENCE_TYPE_ANCHOR,
            element: sibling,
            similarityType: rootInfo.viaSimpleWrapperBypass ? 'comprehensive-sibling-recovery-wrapper-bypass' : 'comprehensive-sibling-recovery',
            classPattern: seed.classPattern || '',
            attrKey: seed.attrKey || '',
            attrValue: seed.attrValue || '',
          });
          recoveredSet.add(sibling);
        }
      }
    }

    const depthOf = (el) => {
      let d = 0;
      let cur = el;
      while (cur && cur !== document.body) {
        d += 1;
        cur = cur.parentElement;
      }
      return d;
    };

    const bItems = recovered
      .filter((x) => x?.evidenceType === EVIDENCE_TYPE_INTERACTION && x?.element)
      .sort((a, b) => depthOf(a.element) - depthOf(b.element));
    const primaryBItems = [];
    for (const b of bItems) {
      const el = b.element;
      if (!el) continue;
      if (isNearFullscreenCandidate(el)) {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const itemWidth = Math.round(Math.max(0, Number(r?.width) || 0));
        const itemHeight = Math.round(Math.max(0, Number(r?.height) || 0));
        const viewportWidth = Math.round(Math.max(0, Number(window?.innerWidth) || 0));
        const viewportHeight = Math.round(Math.max(0, Number(window?.innerHeight) || 0));
        continue;
      }
      const containedByExistingB = primaryBItems.some((p) => p.element && p.element.contains(el));
      if (containedByExistingB) continue;
      primaryBItems.push(b);
    }

    const filtered = recovered.filter((item) => {
      const el = item?.element;
      if (!el) return false;
      if (isLayoutHeaderFooterElement(el)) return false;
      if (item.evidenceType === EVIDENCE_TYPE_INTERACTION) {
        return primaryBItems.some((p) => p.element === el);
      }
      if (item.evidenceType === EVIDENCE_TYPE_ANCHOR) {
        const insideAnyPrimaryB = primaryBItems.some((p) => p.element && p.element.contains(el));
        if (insideAnyPrimaryB) return false;
      }
      return true;
    });

    // Comprehensive sibling matching for Type B:
    // After initial Type B mapping, force-include exact same tag/class matches
    // found in a wider scope (closest main container -> document fallback),
    // when share evidence + share-depth consistency are satisfied.
    const expandTypeBByExactSiblingMatching = (baseItems = []) => {
      try {
        const out = Array.isArray(baseItems) ? [...baseItems] : [];
        const seen = new Set(out.map((x) => x?.element).filter(Boolean));
        const typeBSeeds = out.filter((x) => x?.evidenceType === EVIDENCE_TYPE_INTERACTION && x?.element);
        let addedCount = 0;
        const PROXIMITY_ROOT_SELECTOR =
          'shreddit-feed,main,[role="main"],div[data-testid*="feed" i],div[data-view-name*="feed" i],div[slot="posts"]';
        const getScopeRoot = (seedEl) =>
          seedEl?.closest?.(PROXIMITY_ROOT_SELECTOR) ||
          seedEl?.closest?.('section,article,div') ||
          document;
        const isReasonablyProximate = (seedEl, candEl, scopeRoot) => {
          try {
            if (!seedEl || !candEl) return false;
            // Strong proximity: both under the same shreddit-feed.
            const seedFeed = seedEl.closest?.('shreddit-feed') || null;
            const candFeed = candEl.closest?.('shreddit-feed') || null;
            if (seedFeed || candFeed) return !!seedFeed && seedFeed === candFeed && seedFeed.contains(candEl);

            // Fallback proximity: both share the same nearest feed-like root.
            const seedRoot = seedEl.closest?.(PROXIMITY_ROOT_SELECTOR) || scopeRoot || document;
            const candRoot = candEl.closest?.(PROXIMITY_ROOT_SELECTOR) || scopeRoot || document;
            return !!seedRoot && seedRoot === candRoot;
          } catch (e) {
            return false;
          }
        };
        for (const seed of typeBSeeds) {
          const seedEl = seed.element;
          if (!seedEl) continue;
          const seedTag = String(seedEl.tagName || '').toUpperCase();
          const seedClass = normalizeText(seedEl.className || '');
          if (!seedTag || !seedClass) continue;
          const seedShareDepth = getShareButtonRelativeDepth(seedEl);
          if (!isFinite(seedShareDepth)) continue;

          const scopeRoot = getScopeRoot(seedEl);
          const queryTag = seedTag.toLowerCase();
          const candidates = [
            ...Array.from(scopeRoot.querySelectorAll?.(queryTag) || []),
            ...Array.from(TYPE_B_CROSS_TAG_EXCEPTIONS).flatMap((tag) => Array.from(scopeRoot.querySelectorAll?.(tag) || [])),
          ];
          for (const candRaw of candidates) {
            const cand = promoteGhostWrapper(candRaw);
            if (!cand || cand.nodeType !== 1) continue;
            if (seen.has(cand)) continue;
            const candTag = String(cand.tagName || '').toUpperCase();
            const candClass = normalizeText(cand.className || '');
            const standardExactMatch = candTag === seedTag && candClass === seedClass;
            const customTagException = TYPE_B_CROSS_TAG_EXCEPTIONS.has(candTag.toLowerCase());
            if (!standardExactMatch && !customTagException) continue;
            if (!isReasonablyProximate(seedEl, cand, scopeRoot)) continue;
            if (!isVisibleAndSized(cand)) continue;
            if (isNearFullscreenCandidate(cand)) continue;
            if (!hasShareButtonEvidence(cand)) continue;
            const candShareDepth = getShareButtonRelativeDepth(cand);
            if (!isFinite(candShareDepth)) continue;
            if (Math.abs(candShareDepth - seedShareDepth) > 2) continue;

            const candidateIdentity = getElementSignature(cand) || seed.identitySignature || '';
            out.push({
              key: `${seed.key || seed.signature || ''}::BXR`,
              signature: `${seed.signature || seed.key || ''}::BXR`,
              itemMapSignature: `${seed.itemMapSignature || seed.signature || seed.key || ''}::BXR`,
              identitySignature: candidateIdentity,
              structureSignature: getInternalStructure(cand, 3) || seed.structureSignature || '',
              evidenceType: EVIDENCE_TYPE_INTERACTION,
              element: cand,
              similarityType: customTagException
                ? 'comprehensive-sibling-recovery-custom-tag'
                : 'comprehensive-sibling-recovery-type-b',
              classPattern: seed.classPattern || '',
              attrKey: seed.attrKey || '',
              attrValue: seed.attrValue || '',
            });
            seen.add(cand);
            addedCount += 1;
          }
        }
        return out;
      } catch (e) {
        return baseItems;
      }
    };
    const expandedFiltered = expandTypeBByExactSiblingMatching(filtered);

    // Bottom-up anchor recovery disabled: prevents editorial content (e.g. #topic_contents) from
    // being misclassified as ItemMaps when scattered reference links climb to large parent containers.
    // Facebook Home fallback: add FeedUnit_* containers when primary Type B evidence is not yet hydrated.
    const existingFilteredElements = new Set(
      expandedFiltered.map((x) => x?.element).filter(Boolean)
    );
    const fallbackItems = detectFacebookFallback(root, existingFilteredElements);
    let merged = [...expandedFiltered, ...fallbackItems];

    // De-duplicate by element after fallback merge.
    const dedupMergedByEl = new Map();
    for (const item of merged) {
      const el = item?.element;
      if (!el || dedupMergedByEl.has(el)) continue;
      dedupMergedByEl.set(el, item);
    }
    merged = Array.from(dedupMergedByEl.values());

    // Re-apply A-inside-B suppression after fallback merge.
    const allBContainers = merged
      .filter((x) => x?.evidenceType === EVIDENCE_TYPE_INTERACTION && x?.element)
      .map((x) => x.element);
    const finalFiltered = merged.filter((item) => {
      if (!item?.element) return false;
      if (isLayoutHeaderFooterElement(item.element)) return false;
      if (item.evidenceType !== EVIDENCE_TYPE_ANCHOR) return true;
      return !allBContainers.some((bEl) => bEl && bEl.contains?.(item.element));
    });

    // Keep nested parent ItemMaps alongside child ItemMaps.
    for (let i = 0; i < finalFiltered.length; i += 1) {
      const parent = finalFiltered[i]?.element;
      if (!parent) continue;
      let childCount = 0;
      for (let j = 0; j < finalFiltered.length; j += 1) {
        if (i === j) continue;
        const child = finalFiltered[j]?.element;
        if (!child || child === parent) continue;
        if (parent.contains(child)) childCount += 1;
      }
    }

    // ── Merge Type C (Gmail inbox) ───────────────────────────────────────────
    const typeCItems = detectTypeCItemMaps(root);
    const allItems = [...finalFiltered];
    const seenEls = new Set(allItems.map((x) => x.element));
    for (const item of typeCItems) {
      if (!item?.element || seenEls.has(item.element)) continue;
      allItems.push(item);
    }

    if (root === document) {
      clusterLookup = new Set(allItems.map((x) => x.element));
    }

    const platform = getCurrentPlatform();
    const shouldPreCache = hasCustomImageLogic(platform) || hasCustomTitleLogic(platform);
    for (const item of finalFiltered) {
      if (item?.evidenceType === EVIDENCE_TYPE_INTERACTION && item?.element && shouldPreCache) {
        try {
          const meta = extractMetadataForCoreItem(item.element, null, null);
          if (meta?.activeHoverUrl) {
            const shortcodeRaw = await extractShortcode(item.element);
            item.cachedMetadata = {
              ...meta,
              image: meta.imageIsCustom ? meta.image : null,
              title: meta.titleIsCustom ? meta.title : null,
              imageIsCustom: !!meta.imageIsCustom,
              titleIsCustom: !!meta.titleIsCustom,
            };
            item.cachedShortcodeNormalized =
              shortcodeRaw != null ? normalizeShortcodeExtractionResult(shortcodeRaw, platform) : null;
          }
        } catch (e) {
          /* Pre-cache failed; fall back to on-hover extraction */
        }
      }
    }

    // Only overwrite state.itemMap on a full document scan.
    // Scoped scans return candidates only — the caller (schedulePreScan) merges them.
    if (root === document) {
      state.itemMap = allItems;
    }
    return allItems;
  } catch (e) {
    // Keep existing cache valid; do not invalidate on error (atomic update semantics).
    return Array.isArray(state.itemMap) ? state.itemMap : [];
  }
}

export function findClusterContainerFromTarget(target) {
  try {
    let cur = target && target.nodeType === 1 ? target : null;
    while (cur && cur !== document.body) {
      if (clusterLookup.has(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function getItemMapEntryByElement(element) {
  try {
    const list = Array.isArray(state.itemMap) ? state.itemMap : [];
    return list.find((x) => x?.element === element) || null;
  } catch (e) {
    return null;
  }
}

export function getItemMapEvidenceType(element) {
  const entry = getItemMapEntryByElement(element);
  return entry?.evidenceType || '';
}

export function getItemMapFingerprint(items) {
  try {
    if (!Array.isArray(items) || items.length === 0) return '0';
    const keys = items
      .map((x) =>
        `${x.identitySignature || ''}::${x.structureSignature || ''}::${x.evidenceType || ''}@${x.element?.tagName || '?'}:${x.similarityType || ''}`
      )
      .sort();
    return `${items.length}:${keys.slice(0, 50).join('|')}`;
  } catch (e) {
    return '0';
  }
}

export function ensureClusterCacheFromState() {
  try {
    const list = Array.isArray(state.itemMap) ? state.itemMap : [];
    clusterLookup = new Set(list.map((x) => x.element).filter(Boolean));
  } catch (e) {
    clusterLookup = new Set();
  }
}

// Aliases
export const findItemsOnPage = detectItemMaps;
export const buildItemMap = detectItemMaps;
export const findOptimalCluster = findClusterContainerFromTarget;
export { EVIDENCE_TYPE_C };

export function calculateSimilarity(sigA, sigB) {
  if (!sigA || !sigB) return 0;
  return sigA === sigB ? 1 : 0;
}
