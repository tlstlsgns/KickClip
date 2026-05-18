/**
 * Item cluster and item map detection logic.
 * Handles detectItemMaps, getItemMapFingerprint, findClusterContainerFromTarget, getItemMapEvidenceType,
 * ensureClusterCacheFromState, getElementSignature, and related helpers.
 */

import { state } from './stateLite.js';
import {
  resolveAnchorUrl,
  isValidImageAnchor,
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
const EVIDENCE_TYPE_INTERACTION = 'B';
const EVIDENCE_TYPE_IMAGE_ANCHOR = 'D';
// === TYPED_REDESIGN_PHASE20_TYPEE ===
const EVIDENCE_TYPE_E = 'E';
// === END TYPED_REDESIGN_PHASE20_TYPEE ===
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
// Phase 27a: image-keyed lookup for Type B / Type D / Type E
// candidates. Type B and Type D candidates populate this from
// their `seedImages` field; Type E candidates populate it from
// `element` (which is always an <img>).
let imageToItem = new Map();
// === PHASE_CLUSTER_CACHE_REF ===
// Reference-equality cache key for ensureClusterCacheFromState. When
// state.itemMap is replaced (the only mutation pattern in the codebase —
// see itemDetector.js:2744 and coreEntry.js:905), this reference changes
// and the rebuild fires. While state.itemMap holds the same array
// reference, repeated ensureClusterCacheFromState() calls (one per
// mousemove dispatch) short-circuit. Cleared on rebuild failure so the
// next call retries.
let _lastClusterCacheRef = null;
// === END PHASE_CLUSTER_CACHE_REF ===

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

/** Mirrors extractMetadataForCoreItem getEffectiveImageRect for img nodes. */
function getEffectiveImageRectForImageGate(img) {
  const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
  if (r && (r.width < 10 || r.height < 10) && img.parentElement) {
    const pr = img.parentElement.getBoundingClientRect
      ? img.parentElement.getBoundingClientRect()
      : null;
    if (pr && pr.width >= 10 && pr.height >= 10) return pr;
  }
  if (r && r.width >= 10 && r.height >= 10) return r;

  // Phase 19j.3: lazy-load rect fallback — when layout and parent rects are
  // too small to measure (0×0 placeholder), synthesize width/height from
  // naturalWidth/naturalHeight so downstream size + viewport-center gates see
  // a real footprint. Anchor at the img layout top-left, else parent top-left,
  // else (0,0), so viewport-center semantics stay tied to where the placeholder
  // sits on screen (on-screen placeholder → on-screen synthetic center).
  // Reference: dataExtractor.js isImgVisuallySignificantForAnchor (~2141–2144)
  // uses Math.max(layout, natural) for the same lazy-load class of problem;
  // here we emit a plain rect object so callers receive a uniform rect shape
  // regardless of whether the layout was 0×0 (lazy-load) or already painted.
  const nw = Number(img.naturalWidth || 0);
  const nh = Number(img.naturalHeight || 0);
  if (nw >= 10 && nh >= 10) {
    const pr = img.parentElement?.getBoundingClientRect?.() || null;
    const layoutLeft = Number(r?.left);
    const layoutTop = Number(r?.top);
    const parentLeft = Number(pr?.left);
    const parentTop = Number(pr?.top);
    const left = Number.isFinite(layoutLeft)
      ? layoutLeft
      : (Number.isFinite(parentLeft) ? parentLeft : 0);
    const top = Number.isFinite(layoutTop)
      ? layoutTop
      : (Number.isFinite(parentTop) ? parentTop : 0);
    const width = nw;
    const height = nh;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
  return r;
}

/**
 * Phase 27d: Approximate rect equality for hover-companion
 * matching. Used to identify DOM elements that occupy the same
 * visual area as a given <img>. The tolerance is small (4px)
 * because observed real-world cases (Behance, etc.) wrap the
 * <img> with elements that paint the same box exactly. A larger
 * tolerance risks pulling in nearby-but-not-overlapping
 * elements.
 */
function rectsApproxEqual(a, b, tolerance = 4) {
  if (!a || !b) return false;
  const aw = Number(a.width) || 0;
  const ah = Number(a.height) || 0;
  const bw = Number(b.width) || 0;
  const bh = Number(b.height) || 0;
  if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) return false;
  return Math.abs(a.left - b.left) < tolerance &&
         Math.abs(a.top - b.top) < tolerance &&
         Math.abs(aw - bw) < tolerance &&
         Math.abs(ah - bh) < tolerance;
}

/**
 * Phase 27d/27e: Identifies DOM elements that visually occupy
 * the same area as a given <img>, used as hover-target
 * companions so that intercepting sibling/wrapper elements
 * still resolve to the correct candidate.
 *
 * Two operating modes:
 *
 * SCOPE-WIDE MODE (Phase 27e) — used by Type B / Type D:
 *   The caller passes `scopeElement` (the card or post
 *   container, i.e., candidate.element). Every descendant of
 *   scopeElement whose effective rect matches the <img>'s
 *   effective rect is added as a companion. The scope element
 *   itself is NEVER added (would re-open whole-card activation
 *   and defeat Phase 27).
 *
 *   This handles cases where the intercepting element sits
 *   deeper than the <img>'s direct neighborhood, e.g.,
 *   Behance's <a> link buried under a Cover-overlay sibling of
 *   <picture>'s parent.
 *
 * SIBLING/ANCESTOR MODE (Phase 27d) — used by Type E:
 *   When `scopeElement` is null/undefined, the walk is local:
 *   <img>'s near ancestors with same rect (depth <= 3), direct
 *   siblings of <img>, and direct siblings of <img>'s immediate
 *   parent. Type E has no card-scope concept, so the narrow
 *   walk is the right behavior there.
 *
 * Rect source for both modes: `getEffectiveImageRectForImageGate(img)`.
 * This matches the rect used by the dominance admission gate so
 * companion matching stays consistent.
 */
function findHoverCompanions(img, scopeElement = null) {
  const companions = new Set();
  try {
    if (!img || img.nodeType !== 1) return companions;
    const imgRect = getEffectiveImageRectForImageGate(img);
    if (!imgRect || imgRect.width <= 0 || imgRect.height <= 0) {
      return companions;
    }

    // === PHASE27E_SCOPE_WIDE ===
    // Scope-wide mode (Type B / Type D): search the entire
    // candidate.element subtree for descendants with matching
    // rect. Excludes <img> and scopeElement itself.
    if (scopeElement && scopeElement.nodeType === 1) {
      try {
        const descendants = scopeElement.querySelectorAll?.('*') || [];
        for (const el of descendants) {
          if (el === img) continue;
          if (el === scopeElement) continue;
          try {
            const r = el.getBoundingClientRect?.();
            if (rectsApproxEqual(r, imgRect)) {
              companions.add(el);
            }
          } catch (e) {}
        }
      } catch (e) {}
      return companions;
    }
    // === END PHASE27E_SCOPE_WIDE ===

    // Sibling/ancestor mode (Type E or scope-less callers):
    // Phase 27d's original walk preserved verbatim.

    // 1. Ancestor walk (up to 3 levels).
    let ancestor = img.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && depth < 3) {
      try {
        const ar = ancestor.getBoundingClientRect?.();
        if (rectsApproxEqual(ar, imgRect)) {
          companions.add(ancestor);
        } else {
          // First mismatch ends the upward walk — further ancestors
          // will only be larger.
          break;
        }
      } catch (e) {
        break;
      }
      ancestor = ancestor.parentElement;
      depth += 1;
    }

    // 2. Direct siblings of <img>.
    const directParent = img.parentElement;
    if (directParent) {
      for (const sib of Array.from(directParent.children || [])) {
        if (sib === img) continue;
        try {
          const sr = sib.getBoundingClientRect?.();
          if (rectsApproxEqual(sr, imgRect)) companions.add(sib);
        } catch (e) {}
      }
    }

    // 3. Direct siblings of <img>'s immediate parent.
    const grandparent = directParent?.parentElement;
    if (grandparent) {
      for (const sib of Array.from(grandparent.children || [])) {
        if (sib === directParent) continue;
        try {
          const sr = sib.getBoundingClientRect?.();
          if (rectsApproxEqual(sr, imgRect)) companions.add(sib);
        } catch (e) {}
      }
    }
  } catch (e) {
    // defensive
  }
  return companions;
}

/**
 * Returns true if the image's bounding rect is "dominant" within
 * the coreItem's bounding rect, applying the same ratio rule used
 * by dataExtractor.js's getDominantMediaType for category: Image
 * decisions:
 *   (widthRatio  >= 0.75 && heightRatio >= 0.4) ||
 *   (heightRatio >= 0.75 && widthRatio  >= 0.4)
 *
 * Intuition: the image must occupy at least 75% of one axis AND
 * at least 40% of the other axis. Cards with small thumbnail
 * icons fail this check.
 *
 * Used by Phase 20 Type D detection (detectTypeDItemMaps) for the
 * dominance check on candidate cards.
 */
function isImageDominantInCoreItem(imageRect, coreRect) {
  try {
    const coreWidth = Number(coreRect?.width) || 0;
    const coreHeight = Number(coreRect?.height) || 0;
    if (coreWidth <= 0 || coreHeight <= 0) return false;
    const mw = Number(imageRect?.width) || 0;
    const mh = Number(imageRect?.height) || 0;
    if (mw <= 0 || mh <= 0) return false;
    const widthRatio = mw / coreWidth;
    const heightRatio = mh / coreHeight;
    // Phase 25: Area-ratio guard. The existing OR-shaped axis
    // dominance permits cards where the image fully fills the short
    // axis but only partially the long axis (e.g., a small
    // thumbnail next to a meta text region in a horizontally-laid
    // card). For those cards the image is visually NOT the
    // dominant content. Require the image to also cover at least
    // half the card's area.
    const areaRatio = (mw * mh) / (coreWidth * coreHeight);
    return (
      ((widthRatio >= 0.75 && heightRatio >= 0.4) ||
       (heightRatio >= 0.75 && widthRatio >= 0.4)) &&
      areaRatio >= 0.5
    );
  } catch (e) {
    return false;
  }
}

function isInsideNavLikeAncestor(el) {
  try {
    let cur = el?.parentElement || null;
    while (cur && cur !== document.body) {
      const tag = String(cur.tagName || '').toUpperCase();
      if (TYPED_NAV_TAGS.has(tag)) {
        // === PHASE_SECTIONAL_HEADER_ALLOW ===
        // HTML5 distinguishes site-level <header> (page banner, usually a
        // direct child of <body>) from sectional <header> (article title,
        // byline, lead image — a child of <article> or <main>). The
        // sectional case is semantically content, not navigation, and
        // its lead images should be eligible for clipping.
        //
        // Treat <header> inside <article>/<main> as non-nav and keep
        // walking. <header> elsewhere (and <footer>/<nav> anywhere)
        // continues to count as nav.
        if (tag === 'HEADER' && cur.closest('article, main')) {
          cur = cur.parentElement;
          continue;
        }
        // === END PHASE_SECTIONAL_HEADER_ALLOW ===
        return true;
      }
      const role = String(cur.getAttribute?.('role') || '').toLowerCase().trim();
      if (TYPED_NAV_ROLES.has(role)) return true;
      cur = cur.parentElement;
    }
  } catch (e) {
    return false;
  }
  return false;
}

/**
 * Phase 23: Visibility check used by Type D detection (image pool,
 * sibling matching, per-card validation).
 *
 * Returns true if the element is visually hidden either by its own
 * styles/attributes OR by any ancestor up to depth 10.
 */
function isVisuallyHidden(el) {
  if (!el || el.nodeType !== 1) return true;

  // Self checks.
  try {
    if (el.getAttribute?.('aria-hidden') === 'true') return true;

    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (cs) {
      if (cs.display === 'none') return true;
      if (cs.visibility === 'hidden') return true;
      const opacity = parseFloat(cs.opacity);
      if (isFinite(opacity) && opacity < 0.01) return true;
    }

    const r = el.getBoundingClientRect?.();
    if (r && (r.width <= 0 || r.height <= 0)) {
      // === PHASE_LAZY_LOAD_ZERO_RECT_FALLBACK ===
      // Lazy-load-aware fallback: when an <img> element has its own
      // zero-rect because the underlying image bytes have not yet been
      // decoded (naturalWidth=0, complete=false), but its parent holds
      // the layout space via a placeholder sibling (e.g. Behance's
      // <a><img><div.ImageElement-placeholder-Cz6></a> pattern), the
      // image is structurally present and visually positioned — it is
      // not "hidden", just not yet painted. Treat it as visible so the
      // significant-image pipeline does not reject it at Gate G.
      //
      // This mirrors getEffectiveImageRectForImageGate's parent-fallback
      // (Phase 19j.3) which already returns the parent rect for the
      // same lazy-load class of state. Without this mirror, Gate C and
      // Gate G return contradictory verdicts on identical inputs.
      //
      // Restrictions:
      //  - Only relaxes for <img> elements. Other tags keep the strict
      //    zero-rect rule.
      //  - Parent must exist and have a non-zero rect.
      //  - All other hidden indicators (aria-hidden, display:none,
      //    visibility:hidden, opacity<0.01) above this block still
      //    apply; this block only relaxes the self:zero-rect indicator.
      //  - Ancestor visibility checks below this block continue to run.
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'IMG' && el.parentElement) {
        const pr = el.parentElement.getBoundingClientRect?.();
        if (pr && pr.width > 0 && pr.height > 0) {
          // Parent has layout — fall through to ancestor checks.
        } else {
          return true;
        }
      } else {
        return true;
      }
      // === END PHASE_LAZY_LOAD_ZERO_RECT_FALLBACK ===
    }
  } catch (e) {
    // If any self check throws, fall through to ancestor checks.
  }

  // Ancestor checks (depth-limited).
  try {
    let ancestor = el.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && depth < 10) {
      // === PHASE_ARIA_HIDDEN_ANCHOR_BYPASS ===
      // YouTube (and similar a11y patterns) wraps a thumbnail <img> in an
      // <a href aria-hidden="true"> when a separate, screen-reader-facing
      // <a href> to the same target carries the title text. The thumbnail
      // anchor is hidden from the accessibility tree but visually on
      // screen for sighted users. Treating it as "visually hidden" causes
      // the thumbnail to be dropped at filterSignificantImages Gate G,
      // and the parent card to lose both Type D (no dominant image found
      // inside the card) and Type E (no rejectedImages entry for the
      // thumbnail). Both outline classes go missing from one wrong
      // verdict here.
      //
      // The bypass is intentionally narrow:
      //   - el must be an <img>. Non-image elements keep strict rules.
      //   - ancestor must be an <a>. <div aria-hidden> / <section
      //     aria-hidden> stay rejected — those typically mark genuinely
      //     off-screen carousel panels or collapsed accordions, not
      //     visually-present duplicate-link wrappers.
      //   - the <a> must have a non-empty href. <a aria-hidden> without
      //     href is unusual and not the YouTube pattern; play it safe.
      //   - display:none / visibility:hidden on the same anchor still
      //     reject below. We only bypass the aria-hidden signal.
      //   - ancestors ABOVE the bypassed anchor continue to be checked
      //     by the rest of the loop, so a genuinely-hidden parent
      //     section still wins.
      //
      // Companion to PHASE_LAZY_LOAD_ZERO_RECT_FALLBACK above: both
      // distinguish visual visibility (KickClip's concern) from
      // accessibility-tree visibility (aria-hidden's semantic).
      //
      // Nested wrapper handling: YouTube mix-playlist cards add a decorative
      // <yt-collection-thumbnail-view-model aria-hidden="true"> between the
      // <img> and the duplicate-link <a href aria-hidden="true"> that the
      // direct bypass above handles. Without look-ahead, the ancestor walk
      // hits the wrapper first and rejects before reaching the anchor. For
      // <img> targets, when an aria-hidden non-<a> ancestor is encountered,
      // we look further up (within the same depth-10 budget) for an
      // enclosing <a href aria-hidden="true">. If found, the wrapper's
      // aria-hidden is treated as part of the same a11y-hidden region as
      // the anchor — bypassed for the aria-hidden indicator only.
      // display:none / visibility:hidden on the wrapper itself still
      // rejects on the lines immediately below this block.
      if (ancestor.getAttribute?.('aria-hidden') === 'true') {
        const elTag = String(el.tagName || '').toUpperCase();
        const ancestorTag = String(ancestor.tagName || '').toUpperCase();
        const ancestorHref = ancestor.getAttribute?.('href');
        const isDirectBypassShape =
          elTag === 'IMG' &&
          ancestorTag === 'A' &&
          typeof ancestorHref === 'string' &&
          ancestorHref.length > 0;
        if (isDirectBypassShape) {
          // Variant A pattern: the aria-hidden ancestor is itself the
          // duplicate-link anchor. Fall through to display/visibility checks
          // on this same ancestor, then to the next ancestor up the chain.
        } else if (elTag === 'IMG') {
          // Variant B pattern: aria-hidden on a non-anchor wrapper. Look
          // upward from the current ancestor's parent for an enclosing
          // <a href aria-hidden="true"> within the remaining depth budget.
          // A "hard hide" encountered during the look-ahead (display:none,
          // visibility:hidden) means the subtree really is hidden — stop
          // and reject.
          let foundEnclosingAnchor = false;
          let lookAheadNode = ancestor.parentElement;
          let lookAheadDepth = depth + 1;
          while (
            lookAheadNode &&
            lookAheadNode !== document.body &&
            lookAheadDepth < 10
          ) {
            // Hard-hide short-circuits: if a wrapper above the current
            // aria-hidden node is genuinely hidden via computed style,
            // the entire subtree (including el) is genuinely hidden.
            const laCs = window.getComputedStyle
              ? window.getComputedStyle(lookAheadNode)
              : null;
            if (laCs) {
              if (laCs.display === 'none') break;
              if (laCs.visibility === 'hidden') break;
            }
            const laTag = String(lookAheadNode.tagName || '').toUpperCase();
            const laAriaHidden =
              lookAheadNode.getAttribute?.('aria-hidden') === 'true';
            const laHref = lookAheadNode.getAttribute?.('href');
            if (
              laTag === 'A' &&
              laAriaHidden &&
              typeof laHref === 'string' &&
              laHref.length > 0
            ) {
              foundEnclosingAnchor = true;
              break;
            }
            lookAheadNode = lookAheadNode.parentElement;
            lookAheadDepth += 1;
          }
          if (!foundEnclosingAnchor) return true;
          // Fall through: bypass the aria-hidden indicator on this node,
          // continue to display/visibility checks on the same node, then
          // the next ancestor up.
        } else {
          // Non-<img> target: aria-hidden ancestor is a genuine hide signal.
          return true;
        }
      }
      // === END PHASE_ARIA_HIDDEN_ANCHOR_BYPASS ===
      const acs = window.getComputedStyle ? window.getComputedStyle(ancestor) : null;
      if (acs) {
        if (acs.display === 'none') return true;
        if (acs.visibility === 'hidden') return true;
      }
      ancestor = ancestor.parentElement;
      depth += 1;
    }
  } catch (e) {
    // Defensive: ancestor walk should never throw, but stay quiet.
  }

  return false;
}

/**
 * Phase 26: Detect whether an element is part of a map widget.
 *
 * Map widgets render their visual content as <img> tiles or
 * pre-baked static-map images. These tiles are visualization
 * assets, not user-actionable image content, so they should be
 * excluded from the significant-image pool that feeds Type D /
 * Type E detection.
 *
 * Two complementary checks (Phase 26 supports Google Maps embeds
 * and Naver Maps embeds only; other providers are deferred until
 * a concrete page surfaces them):
 *
 * 1. If the element is an <img>, check its src against a list of
 *    known map-tile host patterns.
 * 2. Walk ancestors (up to depth 12, stopping at body) for
 *    structural map signals:
 *      - role="region" with aria-label matching map / 지도 /
 *        地图 / 地圖
 *      - aria-roledescription matching map / 지도
 *      - data-test-id exactly mtc, met, or moc (Google Maps'
 *        internal tile/event/overlay containers)
 *
 * Class-name pattern matching is intentionally NOT included in
 * Phase 26; we only add patterns once a concrete page surfaces
 * them.
 */
function isMapTileUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /(?:map\.pstatic\.net|ssl\.pstatic\.net\/static\/maps|maps\.gstatic\.com|maps\.googleapis\.com|mt[0-3]?\.googleapis\.com)/i.test(url);
}

function isInsideMapContainer(el) {
  if (!el || el.nodeType !== 1) return false;

  // 1. <img> src domain check (catches Naver-style tile servers;
  //    no ARIA needed).
  try {
    if (el.tagName === 'IMG') {
      const src = el.getAttribute?.('src') || '';
      if (isMapTileUrl(src)) return true;
    }
  } catch (e) {
    // fall through to ancestor checks
  }

  // 2. Ancestor signals walk (depth-limited).
  try {
    let ancestor = el.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && depth < 12) {
      // 2a. role="region" + aria-label map signal.
      const role = ancestor.getAttribute?.('role') || '';
      if (role === 'region') {
        const ariaLabel = ancestor.getAttribute?.('aria-label') || '';
        if (/\b(map|지도|地图|地圖)\b/i.test(ariaLabel)) return true;
      }

      // 2b. aria-roledescription map signal.
      const ariaDesc = ancestor.getAttribute?.('aria-roledescription') || '';
      if (/\b(map|지도)\b/i.test(ariaDesc)) return true;

      // 2c. data-test-id map-internal markers (Google Maps).
      const testId = ancestor.getAttribute?.('data-test-id') || '';
      if (testId === 'mtc' || testId === 'met' || testId === 'moc') return true;

      ancestor = ancestor.parentElement;
      depth += 1;
    }
  } catch (e) {
    // Defensive: ancestor walk should never throw, but stay quiet.
  }

  return false;
}

/**
 * Phase 27a: Returns the set of dominant <img> elements inside a
 * container element. An <img> is dominant when its effective rect
 * satisfies `isImageDominantInCoreItem(imgRect, containerRect)`.
 * Returns an empty Set if the container has no dominant image.
 *
 * Used by:
 *   - Type B detection, to attach `seedImages` and to filter out
 *     Type B candidates that have no dominant image (Phase 27
 *     strict integration policy)
 *   - Type D detection, indirectly (the per-card loop still
 *     iterates inline, but Phase 27a expands its iteration to
 *     collect every dominant img rather than just the first)
 */
function findDominantImagesInElement(container) {
  const out = new Set();
  try {
    if (!container || container.nodeType !== 1) return out;
    const rect = container.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return out;
    const innerImgs = container.querySelectorAll?.('img[src]') || [];
    for (const innerImg of innerImgs) {
      const innerRect = getEffectiveImageRectForImageGate(innerImg);
      if (!innerRect) continue;
      if (isImageDominantInCoreItem(innerRect, rect)) {
        out.add(innerImg);
      }
    }
  } catch (e) {
    // defensive
  }
  return out;
}

/**
 * Phase 21: shared significant-image pool for Type D and Type E.
 * Threshold is viewport-independent: Math.max(80, cappedRootFontSize * 2),
 * preserving the existing root-font cap at 16.
 *
 * Returns Array<{ img, rect }>.
 */
function filterSignificantImages(root = document) {
  const significantImages = [];
  if (!root || !root.querySelectorAll) return significantImages;

  const rootFontSizeRaw = (() => {
    try {
      const rootEl = document.documentElement;
      const cs = rootEl && window.getComputedStyle ? window.getComputedStyle(rootEl) : null;
      const px = parseFloat(String(cs?.fontSize || '16'));
      return isFinite(px) && px > 0 ? px : 16;
    } catch (e) {
      return 16;
    }
  })();
  const cappedRootFontSize = Math.min(rootFontSizeRaw, 16);
  const minContentSize = Math.max(80, cappedRootFontSize * 2);

  const allImgs = Array.from(root.querySelectorAll('img[src]') || []);
  for (const img of allImgs) {
    if (img.getAttribute?.('aria-hidden') === 'true') {
      const probeRect = img.getBoundingClientRect?.();
      const visuallyLarge = probeRect && probeRect.width >= 100 && probeRect.height >= 100;
      if (!visuallyLarge) continue;
    }

    const naturalW = Number(img.naturalWidth || 0);
    if (naturalW > 0 && naturalW < 20) continue;

    const rect = getEffectiveImageRectForImageGate(img);
    if (!rect) continue;
    const w = Math.max(0, Number(rect.width || 0));
    const h = Math.max(0, Number(rect.height || 0));
    if (w < minContentSize || h < minContentSize) continue;

    const ratio = h > 0 ? w / h : Number.POSITIVE_INFINITY;
    if (ratio < 0.2 || ratio > 5.0) continue;

    if (isInsideNavLikeAncestor(img)) continue;

    // === PHASE23_VISIBILITY_FILTER ===
    // Even if the image's own size/ratio/nav-guard pass, exclude it if
    // it (or any ancestor up to depth 10) is visually hidden. This
    // catches images inside carousel slides translated off-screen,
    // collapsed accordions, etc.
    //
    // The earlier aria-hidden bypass for visually large images is
    // preserved above. Images that survived that bypass (large +
    // aria-hidden self) reach this check; isVisuallyHidden will still
    // catch them via ANCESTOR aria-hidden, which is the intended
    // ItemMap behavior.
    if (isVisuallyHidden(img)) continue;
    // === END PHASE23_VISIBILITY_FILTER ===

    // === PHASE26_MAP_FILTER ===
    // Exclude images that belong to a map widget (e.g., Google Maps
    // embed, Naver Maps embed). Map tiles are visualization assets,
    // not user-actionable image content. Phase 26 supports Google
    // and Naver only; other providers are added when a concrete page
    // surfaces them.
    if (isInsideMapContainer(img)) continue;
    // === END PHASE26_MAP_FILTER ===

    significantImages.push({ img, rect });
  }

  return significantImages;
}

async function getEvidenceType(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    // Only run Type B detection on platforms where share-button based
    // post detection is intentionally supported.
    if (TYPE_B_PLATFORMS.has(getCurrentPlatform()) && hasShareButtonEvidence(el)) {
      return EVIDENCE_TYPE_INTERACTION;
    }
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
    const anchorResults = await Promise.all(anchors.map((a) => isValidImageAnchor(a)));
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

async function isMeaningfulItemMap(elements, evidenceType) {
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

  if (
    isTinyFootprint(elements) &&
    avgVisual < 0.5 &&
    (hardNavTinyCount > 0 || navConfidenceScore > 0 || actionBiasCount > 0)
  ) return false;

  const richCount = elements.filter((el) => hasImageAndText(el) || hasMultipleTextBlocks(el) || getTextLen(el) > 20).length;
  if (richCount >= Math.ceil(elements.length * 0.4)) return true;

  if (evidenceType === EVIDENCE_TYPE_INTERACTION) {
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
      // === PHASE27A_TYPE_B_STRICT (facebook fallback) ===
      const seedImages = findDominantImagesInElement(unit);
      if (!seedImages.size) continue;
      // === END PHASE27A_TYPE_B_STRICT ===
      // === PHASE27E_HOVER_COMPANIONS (Type B facebook fallback) ===
      const hoverCompanions = new Set();
      try {
        for (const seedImg of seedImages) {
          // Phase 27e: pass `unit` (the FeedUnit container) as scope.
          for (const comp of findHoverCompanions(seedImg, unit)) {
            hoverCompanions.add(comp);
          }
        }
      } catch (e) {}
      // === END PHASE27E_HOVER_COMPANIONS ===
      out.push({
        key: signature,
        signature,
        itemMapSignature: signature,
        identitySignature: identitySig,
        structureSignature: structureSig,
        evidenceType: EVIDENCE_TYPE_INTERACTION,
        element: unit,
        seedImages,
        // === PHASE27D_HOVER_COMPANIONS_FIELD ===
        hoverCompanions,
        // === END PHASE27D_HOVER_COMPANIONS_FIELD ===
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

// === TYPED_REDESIGN_PHASE20 START ===
// Phase 20 — Type D ItemMap redesign: image-first detection.
//
// Algorithm:
//   1. Filter <img src> elements by size/ratio (no viewport check, no dominance yet)
//   2. From each filtered image, walk up the DOM (max 10 steps) tracking the
//      tag+key-attrs path signature. At each step, check if grandparent's
//      siblings have matching path-down-to-image. First match = card wrapper.
//   3. For each candidate card, verify dominance (existing rule) and anchor presence.
//   4. Group ≥ 2 valid cards become a Type D ItemMap entry batch.
//
// Returns: Array of candidate objects, same shape as candidates pushed in detectItemMaps.

const TYPED_PATH_MAX_DEPTH = 25;
const TYPED_MIN_GROUP_SIZE = 2;
const TYPED_NAV_TAGS = new Set(['HEADER', 'FOOTER', 'NAV']);
const TYPED_NAV_ROLES = new Set(['banner', 'contentinfo', 'navigation']);

/**
 * Build a path-node signature: tag + a small set of stable structural attributes.
 * Excludes className entirely (avoids dynamic class drift).
 */
function signatureOfNode(el) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [String(el.tagName || '').toLowerCase()];
  const gridItem = el.getAttribute?.('data-grid-item');
  if (gridItem != null) parts.push(`data-grid-item=${gridItem}`);
  // === PHASE20_HOTFIX_REMOVE_TEST_ID ===
  // data-test-id removed from path signature: it is a React testing identifier
  // (implementation detail) that splits visually identical cards (e.g.,
  // Pinterest's pincard-image-with-link vs pincard-storyPin-without-link).
  // === END PHASE20_HOTFIX_REMOVE_TEST_ID ===
  const role = el.getAttribute?.('role');
  if (role != null) parts.push(`role=${role}`);
  const tag = String(el.tagName || '').toUpperCase();
  // === PHASE_MEANINGFUL_URL_SIGNATURE ===
  // An <a>'s 'href' contributes to the path signature only when it resolves
  // to a meaningful navigation URL — the same criterion KickClip uses to
  // pick activeHoverUrl. Anchors whose href is non-navigation (empty,
  // fragment-only, javascript:, Google-style internal redirects like
  // /imgres? or /url?, etc.) leave the signature unchanged.
  //
  // Reason: on Google Images results pages, the image-wrapping <a> starts
  // with no href. On hover, Google's JS adds href="/imgres?..." (Google's
  // internal redirect, never the card's real navigation target — the
  // meaningful URL is on a separate <a class="EZAeBe"> in the card's
  // metadata block). The injected href persists across mouseleave, so on
  // the next detection cycle the hovered card's wrapper <a> signature
  // becomes 'a|href' while sibling cards' wrappers remain 'a|'. Strict
  // path matching fails, the hovered card is dropped from Type D, and it
  // gets reclassified as Type E. As subsequent cards get hovered they
  // accumulate the same injected href until the majority flips and the
  // group recoheres — observed as the "scroll/hover restores Type D"
  // behavior in the wild.
  //
  // resolveAnchorUrl is the existing KickClip predicate that returns
  // non-null only for anchors that qualify as a Type D / Type B / Type A
  // candidate's activeHoverUrl source. Gating the signature contribution
  // on it means: only anchors that *could* be the card's clip target
  // affect path matching. Hover-driven non-navigation hrefs are invisible
  // to detection — matching the maintainer's principle that "a change to
  // an <a> that is NOT the activeHoverUrl source should not affect Type D
  // detection."
  //
  // Note: <a> remains 'a|' (no 'href' suffix) for anchors with no href
  // AND for anchors with non-meaningful href. Path matching across a
  // grid where all cards have stable real navigation hrefs continues to
  // see 'a|href' on every sibling — unchanged behavior on Pinterest,
  // Instagram, ArchDaily, etc.
  // === END PHASE_MEANINGFUL_URL_SIGNATURE ===
  if (tag === 'A' && resolveAnchorUrl(el)) parts.push('href');
  if (tag === 'IMG' && el.hasAttribute?.('src')) parts.push('src');
  return parts.join('|');
}

/**
 * Check if `sibParent` contains a path of nodes whose signatures match `pathSig`
 * exactly, where pathSig[0] is the expected signature of sibParent itself and
 * pathSig[N-1] is the expected signature at the leaf (img).
 *
 * Recursive depth-first traversal: matches signature at current depth, then
 * recurses into children for the next depth. Returns true on first matching path.
 */
function hasMatchingPathDownToImage(sibParent, pathSig) {
  if (!sibParent || !Array.isArray(pathSig) || pathSig.length === 0) return false;
  const traverse = (el, idx) => {
    if (!el || el.nodeType !== 1) return false;
    if (signatureOfNode(el) !== pathSig[idx]) return false;
    if (idx === pathSig.length - 1) return true;
    const kids = el.children ? Array.from(el.children) : [];
    for (const child of kids) {
      if (traverse(child, idx + 1)) return true;
    }
    return false;
  };
  return traverse(sibParent, 0);
}

/**
 * Phase 20 — Type D detection. Image-first, bottom-up card discovery.
 * Returns candidate objects compatible with detectItemMaps's candidates schema.
 */
async function detectTypeDItemMaps(root = document) {
  const candidates = [];
  const rejectedImages = [];
  const processedImages = new WeakSet();
  const significantImages = filterSignificantImages(root);
  const significantImageSet = new Set(significantImages.map(({ img }) => img));
  const acceptedImageRefs = new Set();

  if (!root || !root.querySelectorAll) return { candidates, rejectedImages };

  // ─── Step 1: Shared significant-image pool ───
  // Phase 21 unifies D and E over the same image filter. This function
  // consumes the shared pool and decides which images pass D's card
  // conditions; images not accepted by any successful D card become Type E.

  // ─── Step 2: Bottom-up walk per image ───
  for (const { img } of significantImages) {
    if (processedImages.has(img)) continue;

    // Build pathSig starting at img, prepending parent each step
    let pathSig = [signatureOfNode(img)];
    let cur = img;
    let cardWrapper = null;
    let matchingSiblings = null;

    // === PHASE20_HOTFIX_GRID_ITEM_ATTR — explicit grid-item attribute helper ===
    // Returns the (name, value) pair of an explicit grid-item attribute on `el`,
    // or null if none. Recognized attributes (in priority order):
    //   - data-grid-item (Pinterest, custom grids)
    //   - role="listitem" (semantic list items)
    //   - role="article" (semantic article cards)
    const getExplicitGridItemAttr = (el) => {
      if (!el || el.nodeType !== 1 || !el.getAttribute) return null;
      const gridItem = el.getAttribute('data-grid-item');
      if (gridItem != null) return { name: 'data-grid-item', value: gridItem };
      const role = el.getAttribute('role');
      if (role === 'listitem' || role === 'article') return { name: 'role', value: role };
      return null;
    };
    // === END PHASE20_HOTFIX_GRID_ITEM_ATTR ===

    for (let step = 0; step < TYPED_PATH_MAX_DEPTH; step++) {
      const parent = cur.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;

      // Nav guard
      const parentTagU = String(parent.tagName || '').toUpperCase();
      if (TYPED_NAV_TAGS.has(parentTagU)) break;
      const parentRole = String(parent.getAttribute?.('role') || '').toLowerCase().trim();
      if (TYPED_NAV_ROLES.has(parentRole)) break;

      pathSig = [signatureOfNode(parent), ...pathSig];

      const grandparent = parent.parentElement;
      if (!grandparent) {
        cur = parent;
        continue;
      }

      const sibParents = Array.from(grandparent.children)
        .filter((s) => s !== parent && s.nodeType === 1 && !isVisuallyHidden(s));
      if (sibParents.length === 0) {
        cur = parent;
        continue;
      }

      // === PHASE20_HOTFIX_GRID_ITEM_ATTR — fast path for explicit grid-item attribute ===
      // If parent has an explicit grid-item attribute (data-grid-item, role=listitem,
      // role=article), siblings are matched by attribute name+value alone — bypassing
      // path matching. This handles inner-structure variants (e.g., Pinterest's
      // sponsored cards adding extra wrappers between anchor and pinWrapper) that
      // would otherwise fail strict path-length comparison.
      const explicitAttr = getExplicitGridItemAttr(parent);
      if (explicitAttr) {
        const attrMatching = sibParents.filter((sib) => {
          const sibAttr = getExplicitGridItemAttr(sib);
          return sibAttr && sibAttr.name === explicitAttr.name && sibAttr.value === explicitAttr.value;
        });
        if (attrMatching.length >= TYPED_MIN_GROUP_SIZE - 1) {
          cardWrapper = parent;
          matchingSiblings = attrMatching;
          break;
        }
      }
      // === END PHASE20_HOTFIX_GRID_ITEM_ATTR ===

      // Path matching fallback (sites without explicit grid-item attributes)
      const matching = sibParents.filter((sib) => hasMatchingPathDownToImage(sib, pathSig));
      if (matching.length >= TYPED_MIN_GROUP_SIZE - 1) {
        cardWrapper = parent;
        matchingSiblings = matching;
        break;
      }

      cur = parent;
    }

    if (!cardWrapper) continue;

    const candidateCards = [cardWrapper, ...(matchingSiblings || [])];

    // Phase 22: processedImages marking moved to AFTER card conditions
    // pass (search for "Phase 22 marking" below). This prevents a failed
    // wrong-level wrapper (e.g., multi-card column container) from
    // poisoning subsequent iterations and blocking correct tile-level
    // detection.

    // ─── Step 3: Per-card dominance + anchor verification ───
    const validCards = [];
    for (const card of candidateCards) {
      // Phase 23: Skip cards that are visually hidden (themselves or by
      // ancestor). The sibParents filter normally catches these earlier,
      // but cardWrapper itself is added to candidateCards directly and
      // skips that filter, so re-check here.
      if (isVisuallyHidden(card)) continue;
      const cardRect = card.getBoundingClientRect?.();
      if (!cardRect || cardRect.width <= 0 || cardRect.height <= 0) continue;

      // === PHASE20_HOTFIX_SIZE_GUARD ===
      // Reject cards that are too large to plausibly be grid cards.
      const viewportWidth = Math.max(1, Number(window?.innerWidth || 0));
      const viewportHeight = Math.max(1, Number(window?.innerHeight || 0));
      const widthRatio = cardRect.width / viewportWidth;
      const areaRatio = (cardRect.width * cardRect.height) / (viewportWidth * viewportHeight);
      // Phase 24: Tightened upper bound. Legitimate image card grids
      // observed in the wild occupy at most ~0.31 widthRatio (Instagram
      // explore is the largest sampled). Banner-like content such as
      // GitHub README <p>-wrapped images sits at 0.5+ widthRatio. The
      // 0.4 threshold leaves safe margin above real grids while
      // rejecting banner content. areaRatio is tightened in parallel as
      // a secondary signal.
      if (widthRatio > 0.4 || areaRatio > 0.25) continue;
      // === END PHASE20_HOTFIX_SIZE_GUARD ===

      // === PHASE27A_TYPE_D_DOMINANT_IMAGES ===
      // Collect every <img> inside this card that passes
      // isImageDominantInCoreItem. The `break` from the prior
      // implementation is removed: Phase 27 hover dispatch uses
      // every dominant image as an activation key, so we must
      // record all of them.
      let cardDominantImgs;
      try {
        cardDominantImgs = findDominantImagesInElement(card);
      } catch (e) {
        cardDominantImgs = new Set();
      }
      if (!cardDominantImgs.size) continue;
      // === END PHASE27A_TYPE_D_DOMINANT_IMAGES ===

      // === PHASE20_HOTFIX_ANCHOR_SELF ===
      // anchor: accept either (a) card element itself is <a href>, or
      // (b) card contains a descendant <a href>. The original `querySelector`
      // call excludes the element itself, so card-as-anchor sites (e.g., Temu's
      // <a class="goodsContainer-...">) failed even when the card is clearly
      // a navigable link. This broader check matches the user-facing intent:
      // "the card has a way to navigate."
      const cardIsAnchor = card.tagName === 'A' && card.hasAttribute?.('href');
      const hasDescendantAnchor = !!card.querySelector?.('a[href]');
      if (!cardIsAnchor && !hasDescendantAnchor) continue;
      // === END PHASE20_HOTFIX_ANCHOR_SELF ===

      validCards.push({ card, dominantImgs: cardDominantImgs });
    }

    if (validCards.length < TYPED_MIN_GROUP_SIZE) continue;

    // === PHASE20_HOTFIX_OUTLIER ===
    // Median-based outlier removal:
    // Compute median width and median height across validCards. Remove cards
    // whose width OR height falls outside [median/1.5, median*1.5]. This prunes
    // outliers like Pinterest's pin-closeup main image (501×763 alongside
    // right-rail cards' 242×~370) from the group before layout consistency.
    //
    // The remaining cards must still meet MIN_GROUP_SIZE; otherwise the group
    // is discarded. Uniform grids (Naver/Google image search, Pinterest organic
    // grid) have no outliers and pass through unchanged.
    const computeMedian = (values) => {
      const sorted = values.slice().sort((a, b) => a - b);
      const n = sorted.length;
      if (n === 0) return 0;
      if (n % 2 === 1) return sorted[(n - 1) / 2];
      return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    };
    const cardRects = validCards.map((x) => x.card.getBoundingClientRect());
    const widths = cardRects.map((r) => r.width);
    const heights = cardRects.map((r) => r.height);
    const widthMedian = computeMedian(widths);
    const heightMedian = computeMedian(heights);
    const OUTLIER_MULTIPLIER = 1.5;
    const widthLow = widthMedian / OUTLIER_MULTIPLIER;
    const widthHigh = widthMedian * OUTLIER_MULTIPLIER;
    const heightLow = heightMedian / OUTLIER_MULTIPLIER;
    const heightHigh = heightMedian * OUTLIER_MULTIPLIER;
    const filteredCards = [];
    for (let i = 0; i < validCards.length; i++) {
      const r = cardRects[i];
      const widthInRange = r.width >= widthLow && r.width <= widthHigh;
      const heightInRange = r.height >= heightLow && r.height <= heightHigh;
      // === PHASE20_HOTFIX_OUTLIER_RELAX ===
      // Keep card if AT LEAST ONE axis is within the median band. Reject only
      // when BOTH axes are outside the band (a true two-axis outlier like
      // Pinterest's closeup main image). This relaxation matches the user's
      // earlier decision that "width OR height consistent counts as consistent"
      // — applied to per-card outlier removal, not just group-level layout.
      if (widthInRange || heightInRange) filteredCards.push(validCards[i]);
      // === END PHASE20_HOTFIX_OUTLIER_RELAX ===
    }
    if (filteredCards.length < TYPED_MIN_GROUP_SIZE) continue;
    // === END PHASE20_HOTFIX_OUTLIER ===

    // === PHASE20_HOTFIX_LAYOUT_CONSISTENCY ===
    // Require that the surviving cards form a visually consistent group:
    // either widths are similar (widthSpread ≤ 0.30) or heights are similar
    // (heightSpread ≤ 0.30). Pinterest's pin-closeup main image (large) plus
    // related-pins grid (small) violates both axes — group is rejected.
    // Pinterest's organic right-rail (uniform width across cards, varying
    // heights for masonry) passes via widthSpread; Naver's image search
    // (uniform width and height) passes both axes.
    if (!validateVisualLayout(filteredCards.map((x) => x.card))) continue;
    // === END PHASE20_HOTFIX_LAYOUT_CONSISTENCY ===

    // ─── Build candidate entries (compatible with detectItemMaps schema) ───
    const grandparent = cardWrapper.parentElement;
    const identitySignature = grandparent ? signatureOfNode(grandparent) : '';
    const structureSignature = pathSig.join('::');
    const itemMapSignature = `${identitySignature}::F:${structureSignature}::E:D`;

    for (const { card } of filteredCards) {
      try {
        if (significantImageSet.has(card)) acceptedImageRefs.add(card);
        const innerImgs = card.querySelectorAll?.('img[src]') || [];
        for (const innerImg of innerImgs) {
          // Phase 22 marking: now that card conditions have passed, mark
          // these images to prevent reprocessing in subsequent loop iters.
          processedImages.add(innerImg);
          if (significantImageSet.has(innerImg)) acceptedImageRefs.add(innerImg);
        }
      } catch (e) {
        // ignore
      }
    }

    for (const { card, dominantImgs } of filteredCards) {
      // === PHASE27E_HOVER_COMPANIONS (Type D) ===
      const hoverCompanions = new Set();
      try {
        for (const seedImg of dominantImgs) {
          // Phase 27e: pass card as scope so the descendant
          // search covers the whole grid-item subtree.
          for (const comp of findHoverCompanions(seedImg, card)) {
            hoverCompanions.add(comp);
          }
        }
      } catch (e) {
        // defensive
      }
      // === END PHASE27E_HOVER_COMPANIONS ===
      candidates.push({
        key: itemMapSignature,
        signature: itemMapSignature,
        itemMapSignature,
        identitySignature,
        structureSignature,
        evidenceType: EVIDENCE_TYPE_IMAGE_ANCHOR,
        element: card,
        // === PHASE27A_SEED_IMAGES ===
        seedImages: dominantImgs,
        // === END PHASE27A_SEED_IMAGES ===
        // === PHASE27D_HOVER_COMPANIONS_FIELD ===
        hoverCompanions,
        // === END PHASE27D_HOVER_COMPANIONS_FIELD ===
        similarityType: 'typeD-image-first',
        classPattern: '',
        attrKey: '',
        attrValue: '',
      });
    }
  }

  rejectedImages.push(
    ...significantImages.filter(({ img }) => !acceptedImageRefs.has(img))
  );

  return { candidates, rejectedImages };
}
// === TYPED_REDESIGN_PHASE20 END ===

// === TYPED_REDESIGN_PHASE20_TYPEE ===
/**
 * Type E (fallback image) candidates derived from the shared significant-image
 * pool. Any significant image that fails Type D's card conditions becomes a
 * Type E candidate. Candidate element is the <img> itself.
 */
async function detectTypeEItemMaps(rejectedImages = []) {
  const candidates = [];
  const rejected = Array.isArray(rejectedImages) ? rejectedImages : [];

  for (const { img } of rejected) {
    if (!img || String(img?.tagName || '').toUpperCase() !== 'IMG') continue;
    // === PHASE27D_HOVER_COMPANIONS (Type E) ===
    let hoverCompanions = new Set();
    try {
      hoverCompanions = findHoverCompanions(img);
    } catch (e) {
      hoverCompanions = new Set();
    }
    // === END PHASE27D_HOVER_COMPANIONS ===
    candidates.push({
      key: `typeE::${candidates.length}`,
      signature: `typeE::${candidates.length}`,
      itemMapSignature: `typeE::${candidates.length}`,
      identitySignature: signatureOfNode(img),
      structureSignature: 'typeE',
      evidenceType: EVIDENCE_TYPE_E,
      element: img,
      // === PHASE27D_HOVER_COMPANIONS_FIELD ===
      hoverCompanions,
      // === END PHASE27D_HOVER_COMPANIONS_FIELD ===
      similarityType: 'typeE-fallback-image',
      classPattern: '',
      attrKey: '',
      attrValue: '',
    });
  }

  return candidates;
}
// === END TYPED_REDESIGN_PHASE20_TYPEE ===

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

    // === TYPED_REDESIGN_PHASE20 INTEGRATION START ===
    // Run new image-first Type D detection before the existing loop.
    // Existing main loop will skip elements already classified by the new system,
    // so old D path doesn't compete or duplicate.
    const { candidates: typeDCandidates, rejectedImages } = await detectTypeDItemMaps(root);
    candidates.push(...typeDCandidates);
    const typeDElementSet = new Set();
    for (const c of typeDCandidates) {
      if (c?.element) typeDElementSet.add(c.element);
    }
    // === TYPED_REDESIGN_PHASE20 INTEGRATION END ===

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
        // === TYPED_REDESIGN_PHASE20 SKIP START ===
        // Skip elements already classified as Type D by the new image-first system.
        if (typeDElementSet.has(start) || typeDElementSet.has(startRaw)) {
          i += 1;
          continue;
        }
        // === TYPED_REDESIGN_PHASE20 SKIP END ===
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
          const identityMatch = isSimilarIdentity(identitySig, nextIdentity, 0.8);
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
          // === PHASE27A_TYPE_B_STRICT ===
          // Phase 27 B-β-1: Type B activation is now image-keyed.
          // A Type B candidate must contain at least one dominant
          // <img>. Candidates with no dominant image (e.g.,
          // text-only posts) are excluded so they cannot be
          // activated via image-hover.
          let seedImages = new Set();
          if (evidenceType === EVIDENCE_TYPE_INTERACTION) {
            seedImages = findDominantImagesInElement(el);
            if (!seedImages.size) continue;
          }
          // === END PHASE27A_TYPE_B_STRICT ===
          // === PHASE27E_HOVER_COMPANIONS (Type B primary) ===
          const hoverCompanions = new Set();
          try {
            for (const seedImg of seedImages) {
              // Phase 27e: pass `el` (the post container) as scope.
              for (const comp of findHoverCompanions(seedImg, el)) {
                hoverCompanions.add(comp);
              }
            }
          } catch (e) {}
          // === END PHASE27E_HOVER_COMPANIONS ===
          candidates.push({
            key: itemMapSignature,
            signature: itemMapSignature,
            itemMapSignature,
            identitySignature: identitySig,
            structureSignature: structureSig,
            evidenceType,
            element: el,
            // === PHASE27A_SEED_IMAGES ===
            seedImages,
            // === END PHASE27A_SEED_IMAGES ===
            // === PHASE27D_HOVER_COMPANIONS_FIELD ===
            hoverCompanions,
            // === END PHASE27D_HOVER_COMPANIONS_FIELD ===
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
            // === PHASE27A_TYPE_B_STRICT (sibling recovery) ===
            const seedImages = findDominantImagesInElement(cand);
            if (!seedImages.size) continue;
            // === END PHASE27A_TYPE_B_STRICT ===
            // === PHASE27E_HOVER_COMPANIONS (Type B sibling recovery) ===
            const hoverCompanions = new Set();
            try {
              for (const seedImg of seedImages) {
                // Phase 27e: pass `cand` (the recovered container) as scope.
                for (const comp of findHoverCompanions(seedImg, cand)) {
                  hoverCompanions.add(comp);
                }
              }
            } catch (e) {}
            // === END PHASE27E_HOVER_COMPANIONS ===
            out.push({
              key: `${seed.key || seed.signature || ''}::BXR`,
              signature: `${seed.signature || seed.key || ''}::BXR`,
              itemMapSignature: `${seed.itemMapSignature || seed.signature || seed.key || ''}::BXR`,
              identitySignature: candidateIdentity,
              structureSignature: getInternalStructure(cand, 3) || seed.structureSignature || '',
              evidenceType: EVIDENCE_TYPE_INTERACTION,
              element: cand,
              seedImages,
              // === PHASE27D_HOVER_COMPANIONS_FIELD ===
              hoverCompanions,
              // === END PHASE27D_HOVER_COMPANIONS_FIELD ===
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

    const finalFiltered = merged.filter((item) => {
      if (!item?.element) return false;
      if (isLayoutHeaderFooterElement(item.element)) return false;
      return true;
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

    const allItems = [...finalFiltered];

    // === TYPED_REDESIGN_PHASE20_TYPEE — Type E fallback image merge ===
    // Type E now consumes the same significant-image pool as Type D and
    // receives only the images that failed D's card conditions. D/E dedup is
    // therefore deterministic and no longer needs containment checks.
    //
    // Preserve the prior Type B overlap guard: if a Type B element contains
    // this Type E image (or vice versa), skip the Type E candidate.
    const typeEItems = await detectTypeEItemMaps(rejectedImages);
    const seenBAncestors = new Set(
      allItems
        .filter((x) => x?.evidenceType === EVIDENCE_TYPE_INTERACTION && x?.element)
        .map((x) => x.element)
    );
    for (const item of typeEItems) {
      const el = item?.element;
      if (!el || seenBAncestors.has(el)) continue;
      let conflicts = false;
      for (const seenEl of seenBAncestors) {
        if (seenEl === el) { conflicts = true; break; }
        if (typeof seenEl.contains === 'function' && seenEl.contains(el)) { conflicts = true; break; }
        if (typeof el.contains === 'function' && el.contains(seenEl)) { conflicts = true; break; }
      }
      if (conflicts) continue;
      allItems.push(item);
    }
    // === END TYPED_REDESIGN_PHASE20_TYPEE ===

    if (root === document) {
      clusterLookup = new Set(allItems.map((x) => x.element));
      // === PHASE27A_IMAGE_TO_ITEM ===
      imageToItem = buildImageToItem(allItems);
      // === END PHASE27A_IMAGE_TO_ITEM ===
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

/**
 * Phase 27a: builds the <img> → candidate lookup map.
 *
 * Type B and Type D candidates contribute one entry per element
 * in their `seedImages` Set. Type E candidates contribute one
 * entry keyed by their `element` (which is always an <img>).
 *
 * If the same <img> appears in multiple candidates (should not
 * happen given Phase 22 dedup of accepted card inner imgs, plus
 * the Type B/E overlap pruning at allItems assembly), the first
 * candidate seen wins. We don't expect this collision in
 * practice; the first-wins policy is purely defensive.
 */
function buildImageToItem(items) {
  const map = new Map();
  try {
    if (!Array.isArray(items)) return map;
    for (const item of items) {
      if (!item) continue;
      if (item.evidenceType === EVIDENCE_TYPE_E) {
        const img = item.element;
        if (img && String(img.tagName || '').toUpperCase() === 'IMG' && !map.has(img)) {
          map.set(img, item);
        }
        // === PHASE_TYPE_E_ANCHOR_REGISTER ===
        // For each Type E item, also register the <img>'s closest
        // <a href> ancestor as an imageToItem key. Mirrors the Type D
        // registration above so descendants of the link (overlay
        // <div>s, caption icons, etc.) resolve to the Type E item via
        // findItemByImage's closest-anchor fallback. No-op when the
        // <img> is not inside an anchor (single-image page with no
        // link), which is fine — the direct registration of
        // item.element above still covers the image itself.
        //
        // Size-equivalence gate: Type E represents a standalone image,
        // not a card. When the <a> wraps significantly more than the
        // image (caption, metadata row, social buttons), registering
        // it under the anchor key would cause descendants far from the
        // image to activate Type E — a false positive. Only register
        // the anchor when its bounding rect approximately equals the
        // image's rect (within rectsApproxEqual's 4px tolerance per
        // axis). A wider anchor fails the gate; the image's direct
        // registration above still keeps the image itself dispatchable.
        if (item.element && typeof item.element.closest === 'function') {
          try {
            const anchor = item.element.closest('a[href]');
            if (anchor && anchor !== item.element && !map.has(anchor)) {
              const imgRect = item.element.getBoundingClientRect?.();
              const anchorRect = anchor.getBoundingClientRect?.();
              if (rectsApproxEqual(imgRect, anchorRect)) {
                // Strict gate: anchor's box ≈ image's box.
                // Covers the typical thumbnail-link pattern where
                // <a> wraps only the <img>.
                map.set(anchor, item);
              } else if (imgRect && anchorRect) {
                // Relaxed gate (figure-only): the strict gate rejects
                // ArchDaily's pattern where <a> has width=100% height=100%
                // styles but the rendered <a> box ends up shorter than
                // the <img> (aspect-ratio / min-height on the image).
                // The HTML semantic signal that "this is an image unit"
                // is the <figure> ancestor — author-tagged self-contained
                // image+caption block. Relax the size gate iff:
                //   (a) <img> and the (already-resolved) enclosing <a>
                //       both sit inside the same <figure>; AND
                //   (b) <a>'s rect is approximately contained within
                //       <img>'s rect on all four edges (4px tolerance).
                // The anchor under consideration is always
                // img.closest('a[href]') — the <a> that wraps the image,
                // not some other <a> elsewhere in <figure> (e.g. inside
                // <figcaption>).
                const figure = item.element.closest('figure');
                const sharedFigure =
                  figure && typeof figure.contains === 'function' && figure.contains(anchor);
                if (sharedFigure) {
                  const w = Number(imgRect.width) || 0;
                  const h = Number(imgRect.height) || 0;
                  const aw = Number(anchorRect.width) || 0;
                  const ah = Number(anchorRect.height) || 0;
                  if (w > 0 && h > 0 && aw > 0 && ah > 0) {
                    const TOL = 4;
                    const containedInImg =
                      anchorRect.left >= imgRect.left - TOL &&
                      anchorRect.top >= imgRect.top - TOL &&
                      anchorRect.right <= imgRect.right + TOL &&
                      anchorRect.bottom <= imgRect.bottom + TOL;
                    if (containedInImg) {
                      map.set(anchor, item);
                    }
                  }
                }
              }
            }
          } catch (e) {
            // defensive: closest, contains, or getBoundingClientRect can
            // throw on disconnected / exotic nodes
          }
        }
        // === END PHASE_TYPE_E_ANCHOR_REGISTER ===
        // === PHASE27D_HOVER_COMPANIONS_REGISTER (Type E) ===
        if (item.hoverCompanions instanceof Set) {
          for (const comp of item.hoverCompanions) {
            if (comp && !map.has(comp)) map.set(comp, item);
          }
        }
        // === END PHASE27D_HOVER_COMPANIONS_REGISTER ===
      } else if (
        item.evidenceType === EVIDENCE_TYPE_IMAGE_ANCHOR ||
        item.evidenceType === EVIDENCE_TYPE_INTERACTION
      ) {
        const seeds = item.seedImages instanceof Set ? item.seedImages : null;
        if (seeds) {
          for (const img of seeds) {
            if (img && !map.has(img)) {
              map.set(img, item);
            }
          }
        }
        // === PHASE_TYPE_D_ANCHOR_REGISTER ===
        // For each Type D dominantImg, also register the image's closest
        // <a href> ancestor under that anchor as an imageToItem key.
        // This lets the mouseover dispatcher resolve the Type D item
        // when the pointer lands on the clickable anchor wrapping the
        // thumbnail, even if the actual hover target is an overlay
        // <div>, an icon, or any other descendant of the anchor —
        // findItemByImage's closest-anchor fallback then resolves descendants too.
        //
        // Not applied to Type B (EVIDENCE_TYPE_INTERACTION): Type B's
        // anchor semantics differ (whole-feed-unit interaction); Type B
        // continues to rely on seedImages + companion registration.
        if (item.evidenceType === EVIDENCE_TYPE_IMAGE_ANCHOR && seeds) {
          for (const img of seeds) {
            if (!img) continue;
            try {
              const anchor = img.closest?.('a[href]');
              if (anchor && !map.has(anchor)) {
                map.set(anchor, item);
              }
            } catch (e) {
              // defensive: closest can throw on disconnected nodes
            }
          }
        }
        // === END PHASE_TYPE_D_ANCHOR_REGISTER ===
        // === PHASE27D_HOVER_COMPANIONS_REGISTER (Type B / D) ===
        if (item.hoverCompanions instanceof Set) {
          for (const comp of item.hoverCompanions) {
            if (comp && !map.has(comp)) map.set(comp, item);
          }
        }
        // === END PHASE27D_HOVER_COMPANIONS_REGISTER ===
      }
    }
  } catch (e) {
    // defensive
  }
  return map;
}

export function ensureClusterCacheFromState() {
  // === PHASE_CLUSTER_CACHE_REF ===
  // Fast path: when state.itemMap has not been replaced since the last
  // rebuild, the existing clusterLookup and imageToItem are still valid.
  // Both maps are derived purely from state.itemMap's contents and the
  // codebase only mutates state.itemMap via full-array reassignment, so
  // reference equality is a sufficient cache key. See module-level
  // cache variable comment for the invariant.
  const currentMapRef = state.itemMap;
  if (currentMapRef && currentMapRef === _lastClusterCacheRef) {
    return;
  }
  // === END PHASE_CLUSTER_CACHE_REF ===
  try {
    const list = Array.isArray(state.itemMap) ? state.itemMap : [];
    clusterLookup = new Set(list.map((x) => x.element).filter(Boolean));
    // === PHASE27A_IMAGE_TO_ITEM ===
    imageToItem = buildImageToItem(list);
    // === END PHASE27A_IMAGE_TO_ITEM ===
    // === PHASE_CLUSTER_CACHE_REF ===
    // Successful rebuild: record the current state.itemMap reference so
    // subsequent calls can short-circuit until state.itemMap is replaced.
    // Stored *after* the rebuild so a throw inside the try block leaves
    // the cache key cleared via the catch path.
    _lastClusterCacheRef = state.itemMap;
    // === END PHASE_CLUSTER_CACHE_REF ===
  } catch (e) {
    clusterLookup = new Set();
    imageToItem = new Map();
    // === PHASE_CLUSTER_CACHE_REF ===
    // Reset on failure — next call must retry the rebuild rather than
    // falsely short-circuit against a stale cached reference.
    _lastClusterCacheRef = null;
    // === END PHASE_CLUSTER_CACHE_REF ===
  }
}

/**
 * Phase 27d: Returns the candidate associated with a given DOM
 * element. The element may be:
 *   - the candidate's seed `<img>` (Type B / Type D seed,
 *     Type E element)
 *   - a hover-companion of a seed `<img>` registered during
 *     detection (Phase 27d)
 * Function name is preserved from Phase 27a for backward
 * compatibility; the input is no longer restricted to <img>.
 */
export function findItemByImage(el) {
  try {
    if (!el || el.nodeType !== 1) return null;
    const direct = imageToItem.get(el);
    if (direct) return direct;
    // === PHASE_TYPE_D_ANCHOR_FALLBACK ===
    // Type D / Type E items register their dominantImg's or <img>'s closest <a href> ancestor
    // in imageToItem (see buildImageToItem Type D / Type E anchor keys). The
    // pointer often lands on a descendant of that <a> — overlay <div>s,
    // info panels, icons, avatar imgs — not the <a> itself and not on
    // the registered dominantImg. When the direct lookup misses, walk
    // up to the nearest <a href> ancestor and retry the lookup there.
    //
    // Skip when:
    //   - el is itself an <a> (the direct lookup above already handled
    //     it; closest would return el and produce a redundant lookup,
    //     though it would not loop)
    //   - no <a href> ancestor exists (el is outside any anchor)
    //   - the resolved <a> is not in imageToItem (it's not part of
    //     any item's registered anchor set)
    //
    // Cost: at most one closest('a[href]') walk per missed mouseover.
    // closest is a plain DOM walk, no getComputedStyle. Layout-safe.
    try {
      const ancestorAnchor = el.closest?.('a[href]');
      if (ancestorAnchor && ancestorAnchor !== el) {
        const viaAnchor = imageToItem.get(ancestorAnchor);
        if (viaAnchor) return viaAnchor;
      }
    } catch (e) {
      // defensive: closest can throw on disconnected nodes
    }
    // === END PHASE_TYPE_D_ANCHOR_FALLBACK ===
    return null;
  } catch (e) {
    return null;
  }
}

// === PHASE_OVERLAY_ON_IMAGE ===
// Three-case rule for choosing the overlay element on Type D activation:
//
//   Case 1: <img> fits within (or equals) the anchor on all four edges
//           → overlay = <img>. The visible image footprint is exactly
//             the img's layout box.
//
//   Case 2: <img> extends beyond the anchor in layout, AND a clip-producing
//           CSS property is present somewhere on the path img → anchor
//           (overflow ≠ visible, clip-path ≠ none, or contain with paint/
//           strict/content). The clip restricts the rendered image to
//           within the anchor's box → overlay = anchor.
//
//   Case 3: <img> extends beyond the anchor in layout AND no clip applies
//           along that path. The img is genuinely painted outside the
//           anchor's layout box → overlay = <img>.
//
// Edge comparison uses strict inequality (>= / <=, no tolerance) — the user
// explicitly requested no 4-px tolerance here, unlike rectsApproxEqual elsewhere.
//
// Fallbacks: if either rect is unavailable / zero-sized, or if dominantImg
// or anchor is missing, the function returns coreItem so the existing
// whole-card outline remains as a safe default.
export function determineTypeDOverlayElement(coreItem, dominantImg, anchor) {
  if (!dominantImg) return coreItem;
  const imgRect = dominantImg.getBoundingClientRect?.();
  if (!imgRect) return coreItem;
  if (imgRect.width <= 0 || imgRect.height <= 0) return coreItem;

  // Branch A: image-wrapping anchor is present (anchor is an ancestor of img).
  // Apply the existing Case 1/2/3 rule with anchor as the comparator.
  if (anchor && anchor.contains?.(dominantImg)) {
    return applyOverlayCaseRule(coreItem, dominantImg, anchor, imgRect);
  }

  // === PHASE_OVERLAY_BRANCH_CONTAINER ===
  // No image-wrapping anchor: the Type D anchor lives in a sibling subtree
  // of the image (e.g. <figure> with image and caption-credit anchor as
  // separate children). Find the dominantImg's ancestor whose immediate
  // parent has a sibling containing an <a href>. That ancestor — the last
  // common-image-side container before the image and anchor diverge —
  // substitutes for the anchor in the case rule. The same clip-aware
  // physics apply: img either fits inside this container (Case 1), or
  // overflows but is clipped (Case 2), or overflows visibly (Case 3).
  let cur = dominantImg.parentElement || null;
  while (cur && cur !== coreItem) {
    const parent = cur.parentElement;
    if (!parent) break;
    let matched = false;
    for (const sibling of parent.children) {
      if (sibling === cur) continue;
      const isAnchorSibling =
        sibling.tagName === 'A' && sibling.hasAttribute?.('href');
      if (isAnchorSibling) {
        matched = true;
        break;
      }
      try {
        if (sibling.querySelector?.('a[href]')) {
          matched = true;
          break;
        }
      } catch (e) {
        // defensive: querySelector can throw on disconnected nodes
      }
    }
    if (matched) {
      return applyOverlayCaseRule(coreItem, dominantImg, cur, imgRect);
    }
    cur = cur.parentElement;
  }
  return coreItem;
  // === END PHASE_OVERLAY_BRANCH_CONTAINER ===
}

// Shared Case 1/2/3 evaluation: `comparator` may be either the
// image-wrapping anchor (Branch A) or the branch container (Branch B).
// Case rules are identical in both cases — the physics of clipping
// don't care about anchor semantics.
function applyOverlayCaseRule(coreItem, dominantImg, comparator, imgRect) {
  const comparatorRect = comparator.getBoundingClientRect?.();
  if (!comparatorRect) return coreItem;
  if (comparatorRect.width <= 0 || comparatorRect.height <= 0) return coreItem;

  // Case 1: img fully within comparator (no tolerance).
  if (
    imgRect.left >= comparatorRect.left &&
    imgRect.top >= comparatorRect.top &&
    imgRect.right <= comparatorRect.right &&
    imgRect.bottom <= comparatorRect.bottom
  ) {
    return dominantImg;
  }

  // img > comparator in layout. Check whether the overflow is actually
  // clipped visually by any element on the img → comparator ancestor chain.
  if (isImgClippedAlongAnchorPath(dominantImg, comparator)) {
    // Case 2: clip restricts visible image area to within comparator.
    return comparator;
  }

  // Case 3: no clip; img genuinely paints outside comparator's box.
  return dominantImg;
}

// Walk from img upward through its ancestor chain. Returns true if any
// element on the path up to and including `anchor` carries a clip-producing
// CSS property. Stops at `anchor` (inclusive). If `anchor` is not reached
// (e.g. disconnected, or anchor is not an ancestor of img), the walk
// terminates at the root and returns whatever was found en route.
function isImgClippedAlongAnchorPath(img, anchor) {
  // Start at img.parentElement, not img itself. overflow on a replaced
  // element (<img>, <video>, etc.) controls its own raster content within
  // its box — it doesn't constrain the box's position relative to an
  // ancestor. Modern Chrome sets overflow: clip on <img> by default when
  // aspect-ratio is present, which would false-positive every Type D
  // image otherwise.
  let cur = img?.parentElement || null;
  while (cur) {
    if (hasClipStyle(cur)) return true;
    if (cur === anchor) break;
    cur = cur.parentElement;
  }
  return false;
}

// CSS-level clip detection. Returns true if the element introduces any
// clip-producing rule:
//   - overflow-x or overflow-y is not 'visible' (hidden, clip, scroll, auto)
//   - clip-path is not 'none'
//   - contain includes 'paint', 'strict', or 'content' (which imply paint
//     containment, which clips overflow).
// Other clip mechanisms (mask-image, etc.) are intentionally out of scope —
// add them here if real-world cases emerge that need them.
function hasClipStyle(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    const cs = window.getComputedStyle?.(el);
    if (!cs) return false;
    if (cs.overflowX && cs.overflowX !== 'visible') return true;
    if (cs.overflowY && cs.overflowY !== 'visible') return true;
    if (cs.clipPath && cs.clipPath !== 'none') return true;
    const contain = String(cs.contain || '');
    if (/\b(paint|strict|content)\b/.test(contain)) return true;
    return false;
  } catch (e) {
    return false;
  }
}
// === END PHASE_OVERLAY_ON_IMAGE ===

// Aliases
export const findItemsOnPage = detectItemMaps;
export const buildItemMap = detectItemMaps;
export const findOptimalCluster = findClusterContainerFromTarget;
export { EVIDENCE_TYPE_IMAGE_ANCHOR };

export function calculateSimilarity(sigA, sigB) {
  if (!sigA || !sigB) return 0;
  return sigA === sigB ? 1 : 0;
}
