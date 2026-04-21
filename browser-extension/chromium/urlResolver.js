/**
 * URL Resolver Module
 * Handles URL extraction, external/internal detection, and redirect resolution
 */

// NOTE: Do not import containerExtractor here. This module must remain acyclic so it can be
// safely reused by containerExtractor for URL normalization.

/**
 * Extract root domain from hostname (removes subdomains)
 * Examples:
 * - www.example.com → example.com
 * - search.example.com → example.com
 * - search.shopping.example.com → example.com
 * - api.example.co.uk → example.co.uk
 * 
 * @param {string} hostname - The hostname to extract root domain from
 * @returns {string} - The root domain
 */
export function getRootDomain(hostname) {
  if (!hostname) return '';
  
  const parts = hostname.toLowerCase().split('.');
  
  // Remove www. prefix if present
  if (parts.length > 0 && parts[0] === 'www') {
    parts.shift();
  }
  
  // Handle multi-part TLDs (e.g., .co.uk, .com.au, .org.uk)
  const multiPartTlds = ['co.uk', 'com.au', 'org.uk', 'net.uk', 'gov.uk'];
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (multiPartTlds.includes(lastTwo)) {
      // Return last 3 parts (e.g., example.co.uk)
      return parts.slice(-3).join('.');
    }
  }
  
  // Standard case: return last 2 parts (e.g., example.com)
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  
  return hostname; // Fallback: return as-is
}

/**
 * Normalize a hostname for strict (subdomain-sensitive) comparisons.
 * - Lowercases
 * - Removes a leading "www."
 *
 * Examples:
 * - www.example.com -> example.com
 * - sub1.example.com -> sub1.example.com
 *
 * @param {string} hostname
 * @returns {string}
 */
export function normalizeHostname(hostname) {
  try {
    const h = (hostname || '').toLowerCase();
    if (!h) return '';
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch (e) {
    return '';
  }
}

/**
 * Image/asset extensions to exclude from navigation target discovery.
 */
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|svg|webp|bmp|ico|tiff)(\?|$|#)/i;
const IMAGE_EXTENSION_FILENAME = /\.(jpg|jpeg|png|gif|svg|webp|bmp|ico|tiff)$/i;

/**
 * Media element tags - NEVER treat as navigation sources. Absolute exclusion.
 */
const MEDIA_SOURCE_TAGS = new Set(['IMG', 'SOURCE', 'TRACK', 'VIDEO', 'AUDIO']);

/**
 * Image CDN host patterns - URLs from these domains are treated as image assets.
 */
const IMAGE_CDN_HOSTS = /gstatic\.com|twimg\.com|fbcdn\.net|cdninstagram\.com|tbn\d*\.gstatic\.com|encrypted-tbn/i;

/**
 * Returns true only when the URL's last path segment looks like an image filename.
 * Segments containing ':' are treated as namespace:title patterns (e.g. wiki pages)
 * and are NOT considered image filenames even if they end with an image extension.
 */
function isImageFilenameUrl(parsedUrl) {
  try {
    const pathname = decodeURIComponent(parsedUrl.pathname || '');
    const lastSegment = pathname.split('/').pop().split('?')[0].split('#')[0];
    if (lastSegment.includes(':')) return false;
    return IMAGE_EXTENSION_FILENAME.test(lastSegment);
  } catch (e) {
    return false;
  }
}

/**
 * Returns true if the URL is a valid navigation target (leads to a new page).
 * Excludes image assets, data URIs, and URLs from media elements.
 *
 * @param {string} url - The URL to check
 * @param {Element} [element] - Optional: element from which the URL originated (e.g. img, source)
 * @returns {boolean}
 */
export function isNavigationUrl(url, element) {
  try {
    if (element && element.nodeType === 1) {
      const tag = String(element.tagName || '').toUpperCase();
      if (tag === 'IMG') return false;
      if (MEDIA_SOURCE_TAGS.has(tag)) return false;
    }

    if (!url || typeof url !== 'string') return false;
    const s = url.trim();
    if (!s) return false;

    if (s.startsWith('data:image/')) return false;
    if (/^data:image\//i.test(s)) return false;

    try {
      const u = new URL(s, window.location && window.location.href);
      const host = (u.hostname || '').toLowerCase();
      const path = (u.pathname || '') + (u.search || '');
      if (isImageFilenameUrl(u)) return false;
      if (IMAGE_CDN_HOSTS.test(host)) return false;
      if (/\/images\?|tbn:|encrypted-tbn/i.test(path)) return false;
      if (/\/images\?|tbn:|encrypted-tbn/i.test(u.href)) return false;
    } catch (e) {
      if (IMAGE_EXTENSIONS.test(s)) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Blind redirector hosts: require network fetch to resolve (no destination in query params).
 * Used to defer menu-tab rejection until async resolution completes.
 */
const BLIND_REDIRECTOR_HOSTS = [
  'ader.naver.com',
  'ad.naver.com',
  'nid.naver.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'adservice.google.com',
  't.co',
  'bit.ly',
  'tinyurl.com',
  'ow.ly',
  'buff.ly',
  'ad.doubleclick.net',
  'clickserve.dartsearch.net',
];

const BLIND_REDIRECTOR_PREFIXES = ['tracking.', 'redirect.', 'adclick.', 'ad-track.'];

/** Path patterns typical of redirectors (domain-agnostic). */
const BLIND_REDIRECTOR_PATH_PATTERNS = [
  /\/linkout\b/i,
  /\/click\b/i,
  /\/redirect\b/i,
  /\/out\b/i,
  /\/go\b/i,
  /\/l\/[^/]+$/i,       // /l/abc123
  /\/r\/[^/]+$/i,       // /r/abc123
  /\/url\?/i,
  /\/redirect\?/i,
  /\/link\?/i,
  /\/p\/crd\/rd/i,
];

/** Query param keys that often contain nested destination URLs. */
const REDIRECT_QUERY_KEYS = new Set(['url', 'u', 'dest', 'target', 'to', 'destination', 'link', 'redirect', 'continue', 'out', 'goto']);

/**
 * Path prefixes that indicate utility/redirection endpoints, not final landing pages.
 * URLs with these paths should NOT be promoted to DISCOVERY even inside Phase B.
 */
const UTILITY_PATH_PREFIXES = [
  /^\/imgres(?:\/|$|\?)/i,   // Google image viewer (e.g. /imgres?q=...&imgurl=...)
  /^\/url(?:\/|$|\?)/i,      // URL redirect endpoints
  /^\/redirect(?:\/|$|\?)/i,
  /^\/linkout(?:\/|$|\?)/i,
  /^\/out(?:\/|$|\?)/i,
  /^\/go(?:\/|$|\?)/i,
  /^\/link(?:\/|$|\?)/i,
  /^\/click(?:\/|$|\?)/i,
];

/**
 * Returns true if the URL looks like a clean final landing page suitable for DISCOVERY promotion.
 * Returns false for known utility/redirection paths (e.g. /imgres, /url) or URLs with
 * excessive technical parameters without a clear external destination.
 *
 * @param {string} targetPath - Normalized pathname (lowercase)
 * @param {URL} targetUrlObj - Full URL object for param checks
 * @returns {boolean}
 */
function isCleanLandingPage(targetPath, targetUrlObj) {
  try {
    const p = (targetPath || '/').toLowerCase();
    // Exclude utility/redirection path prefixes
    if (UTILITY_PATH_PREFIXES.some((re) => re.test(p))) return false;
    // Explicit filter for Google /imgres (image viewer) - even inside Phase B, do not promote
    if (p.startsWith('/imgres')) return false;
    // Rootish paths are fine
    const rootish = (path) => path === '/' || path === '' || path === '/webhp';
    if (rootish(p)) return true;
    // Simple path structure (1–4 segments) suggests a content destination
    const segs = p.split('/').filter(Boolean);
    if (segs.length >= 1 && segs.length <= 4) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Check if a query param value looks like an absolute URL (http/https).
 * @param {string} val
 * @returns {boolean}
 */
function looksLikeNestedUrl(val) {
  try {
    const s = String(val || '').trim();
    if (!s || s.length < 10) return false;
    const decoded = decodeURIComponent(s);
    return decoded.startsWith('http://') || decoded.startsWith('https://');
  } catch (e) {
    return false;
  }
}

/**
 * Structural heuristic: long encrypted-looking query on ad-network-like subdomains.
 * @param {URL} u
 * @returns {boolean}
 */
function hasRedirectorStructuralSignals(u) {
  try {
    const host = (u.hostname || '').toLowerCase();
    const path = (u.pathname || '') + (u.search || '');
    const paramCount = Array.from(u.searchParams.keys()).length;
    const queryLen = (u.search || '').length;

    // Long query (60+ chars) with 3+ params often indicates tracking wrapper
    if (paramCount >= 3 && queryLen >= 60) return true;

    // High-entropy path segment (20+ alphanumeric) suggests redirect token
    const segments = (u.pathname || '').split('/').filter(Boolean);
    const hasEntropySeg = segments.some((s) => s.length >= 20 && /^[A-Za-z0-9._~-]+$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s));
    if (hasEntropySeg && (u.pathname || '').length > 20) return true;

    // Known ad subdomain patterns (ad., ads., track., etc.) with multiple params
    const adSubdomain = /^(ad|ads|track|tracking|click|clk|redirect)\./i.test(host) || host.includes('.ad.');
    if (adSubdomain && paramCount >= 2) return true;

    return false;
  } catch (e) {
    return false;
  }
}

/**
 * True if URL is a blind redirector (requires network resolution).
 * Uses pattern-based detection beyond hardcoded hostnames:
 * - Query params containing nested URLs (?url=, ?dest=, ?u=)
 * - Path patterns typical of redirectors (/linkout, /click, /redirect)
 * - Structural signals (long encrypted query, ad subdomains)
 *
 * @param {string} url
 * @param {{ baseUrl?: string }} [options]
 * @returns {boolean}
 */
export function isBlindRedirector(url, options = {}) {
  try {
    if (!url || typeof url !== 'string') return false;
    const baseUrl = (options && options.baseUrl) || (typeof window !== 'undefined' && window.location ? window.location.href : '') || 'https://example.com';
    const u = new URL(url.trim(), baseUrl);
    const host = (u.hostname || '').toLowerCase();
    if (!host) return false;

    // 1. Known host blocklist
    if (BLIND_REDIRECTOR_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
    if (BLIND_REDIRECTOR_PREFIXES.some((p) => host.startsWith(p))) return true;

    // 2. Query params with nested URLs (redirect wrapper)
    for (const [k, v] of u.searchParams.entries()) {
      const key = (k || '').toLowerCase();
      if (REDIRECT_QUERY_KEYS.has(key) || key.includes('url') || key.includes('dest')) {
        if (looksLikeNestedUrl(v)) return true;
      }
    }

    // 3. Path patterns typical of redirectors
    const pathAndQuery = (u.pathname || '') + (u.search || '');
    if (BLIND_REDIRECTOR_PATH_PATTERNS.some((p) => p.test(pathAndQuery))) return true;

    // 4. Structural signals (long query, entropy, ad subdomains)
    if (hasRedirectorStructuralSignals(u)) return true;

    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Returns true if URL requires async resolution (blind redirector or not cached).
 * Used to flag URLs as pending_resolution in Phase A/B and Main/Retry.
 *
 * @param {string} url
 * @param {{ baseUrl?: string }} [options]
 * @returns {boolean}
 */
export function requiresResolution(url, options = {}) {
  if (!url || typeof url !== 'string') return false;
  const baseUrl = (options && options.baseUrl) || (typeof window !== 'undefined' && window.location ? window.location.href : '') || 'https://example.com';
  if (resolveCached(url, { baseUrl })) return false; // Already cached
  return isBlindRedirector(url, { baseUrl });
}

/**
 * Redirect/tracking path patterns that indicate href may be a wrapper.
 */
const REDIRECT_PATH_PATTERNS = [
  /\/p\/crd\/rd/i,
  /\/url\?/i,
  /\/redirect\?/i,
  /\/link\?/i,
  /\/out\?/i,
  /\/go\?/i,
];

/** HTML entity replacements for URL unwrapping. */
const HTML_ENTITY_MAP = {
  '&quot;': '"', '&#34;': '"', '&#x22;': '"',
  '&apos;': "'", '&#39;': "'", '&#x27;': "'",
  '&amp;': '&', '&#38;': '&', '&#x26;': '&',
  '&lt;': '<', '&gt;': '>',
};

/**
 * Unwrap and decode a string until a clean URL is obtained.
 * Handles HTML entities (&quot;, &#39;) and URI encoding.
 * @param {string} s
 * @param {number} maxRounds - Prevent infinite loops
 * @returns {string|null}
 */
function unwrapAndDecodeUrl(s, maxRounds = 4) {
  try {
    if (!s || typeof s !== 'string') return null;
    let out = String(s).trim();
    let prev = '';
    for (let r = 0; r < maxRounds && out !== prev; r++) {
      prev = out;
      for (const [ent, repl] of Object.entries(HTML_ENTITY_MAP)) {
        out = out.split(ent).join(repl);
      }
      try {
        const decoded = decodeURIComponent(out);
        if (decoded !== out) out = decoded;
      } catch (e) {
        try {
          const decoded = decodeURI(out);
          if (decoded !== out) out = decoded;
        } catch (e2) {}
      }
      // Trim surrounding quotes after unwrapping
      out = out.replace(/^["'`]\s*|\s*["'`]$/g, '').trim();
    }
    return out && (out.startsWith('http://') || out.startsWith('https://')) ? out : null;
  } catch (e) {
    return null;
  }
}

/**
 * Extract URL from onclick attribute. Handles urlencode("..."), goOtherCR(..., "u="+...), etc.
 * Non-greedy, supports ", ', `, &quot;, &#39;.
 * @param {string} onclick
 * @param {string} baseUrl
 * @returns {string|null}
 */
function parseOnclickForUrl(onclick, baseUrl) {
  try {
    if (!onclick || typeof onclick !== 'string') return null;
    const s = onclick.trim();
    if (!s) return null;

    // Pattern 1: urlencode("http://..."), urlencode('http://...'), encodeURIComponent("http://...")
    const urlEncodeRe = /(?:urlencode|encodeURIComponent|encodeURI)\s*\(\s*["'`]?([^"'`)]*?)["'`]?\s*\)/gi;
    let m;
    while ((m = urlEncodeRe.exec(s)) !== null) {
      const inner = m[1];
      if (inner && (inner.includes('http://') || inner.includes('https://') || /\.(com|kr|net|org|co\.kr)(\/|$|\?|#)/i.test(inner))) {
        const unwrapped = unwrapAndDecodeUrl(inner) || unwrapAndDecodeUrl(inner.replace(/\\/g, ''));
        if (unwrapped) return unwrapped;
        try {
          const u = new URL(inner, baseUrl);
          if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
        } catch (e) {}
      }
    }

    // Pattern 2: (u|url|dest)=... with nested quotes and urlencode
    const paramRe = /(?:^|[,(\s])(?:u|url|dest|target|to)\s*=\s*(?:(?:["'`]|&quot;|&#39;)([^"'`]*?)(?:["'`]|&quot;|&#39;)|([^"'`)\s,]+))/gi;
    while ((m = paramRe.exec(s)) !== null) {
      const inner = (m[1] || m[2] || '').trim();
      if (!inner) continue;
      const unwrapped = unwrapAndDecodeUrl(inner);
      if (unwrapped) return unwrapped;
      if (inner.startsWith('http://') || inner.startsWith('https://')) {
        try {
          const u = new URL(inner, baseUrl);
          if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
        } catch (e) {}
      }
    }

    // Pattern 3: Bare http:// or https:// URL in string (non-greedy)
    const bareUrlRe = /(https?:\/\/[^\s"'`)\],;]+?)(?=["'`)\]\s,;]|$)/gi;
    while ((m = bareUrlRe.exec(s)) !== null) {
      const raw = m[1];
      if (raw) {
        const unwrapped = unwrapAndDecodeUrl(raw);
        if (unwrapped) return unwrapped;
        try {
          const u = new URL(raw, baseUrl);
          if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
        } catch (e) {}
      }
    }

    // Pattern 4: .com/.kr-like host in quoted string (e.g. 'mokgong.alltheway.kr')
    const hostRe = /(?:["'`]|&quot;|&#39;)((?:https?:\/\/)?[a-z0-9][-a-z0-9]*(?:\.[a-z0-9][-a-z0-9]*)+(?:\/[^\s"'`]*)?)(?:["'`]|&quot;|&#39;)/gi;
    while ((m = hostRe.exec(s)) !== null) {
      const raw = m[1];
      if (raw && /\.(com|kr|net|org|co\.kr|go\.kr)(\/|$|\?|#)/i.test(raw)) {
        const withProto = raw.startsWith('http') ? raw : `https://${raw}`;
        try {
          const u = new URL(withProto, baseUrl);
          if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
        } catch (e) {}
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Parse tracking/redirect URL parameters to extract the original destination.
 * Handles various quoting styles (", ', &quot;) and URI encoding.
 */
function parseRedirectParams(href, baseUrl) {
  try {
    const base = baseUrl || (typeof window !== 'undefined' && window.location ? window.location.href : '') || 'https://example.com';
    const u = new URL(href, base);
    const params = u.searchParams;
    const keys = ['u', 'url', 'dest', 'target', 'to', 'destination', 'link'];
    for (const k of keys) {
      const v = params.get(k);
      if (v) {
        const unwrapped = unwrapAndDecodeUrl(v) || v;
        const decoded = decodeURIComponent(unwrapped);
        if (decoded && (decoded.startsWith('http://') || decoded.startsWith('https://'))) {
          return decoded;
        }
        try {
          const resolved = new URL(decoded || unwrapped, base);
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            return resolved.href;
          }
        } catch (e) {}
      }
    }
    if (u.search) {
      const q = u.search.slice(1);
      const m = q.match(/(?:^|&)(?:u|url|dest)=([^&]+)/i);
      if (m && m[1]) {
        try {
          const unwrapped = unwrapAndDecodeUrl(m[1]) || m[1];
          const decoded = decodeURIComponent(unwrapped);
          if (decoded.startsWith('http')) return decoded;
          const resolved = new URL(decoded, base);
          return resolved.href;
        } catch (e) {}
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Try to statically extract destination URL from redirect params (u=, url=, dest=, etc.).
 * Use BEFORE network fetch to avoid unnecessary hops when destination is in the string.
 * @param {string} href
 * @param {string} [baseUrl]
 * @returns {string|null} - Extracted URL or null
 */
export function tryStaticExtract(href, baseUrl) {
  try {
    if (!href || typeof href !== 'string') return null;
    const base = baseUrl || (typeof window !== 'undefined' && window.location ? window.location.href : '') || 'https://example.com';
    const extracted = parseRedirectParams(href.trim(), base);
    if (extracted && (extracted.startsWith('http://') || extracted.startsWith('https://'))) return extracted;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Resolve the original destination URL from an <a> element, bypassing tracking/redirect wrappers.
 * - Step 1: Check custom attributes (cru, data-url, data-u, data-href, origin-url)
 * - Step 2: If href is a redirect pattern, parse params (u=, url=, dest=) for the real URL
 * - Step 3: Fallback to standard href
 *
 * @param {HTMLAnchorElement|HTMLElement} element - The anchor or element with closest a[href]
 * @param {string} [baseUrl] - Base URL for resolving relative URLs
 * @returns {string|null} - Absolute URL (http/https) or null
 */
export function getOriginalUrl(element, baseUrl) {
  try {
    if (!element) return null;
    const tag = String(element.tagName || '').toUpperCase();
    if (MEDIA_SOURCE_TAGS.has(tag)) return null;

    const base = baseUrl || (window.location ? window.location.href : '');
    const link = element.tagName === 'A' ? element : (element.closest && element.closest('a[href]'));
    if (!link) return null;

    const attrs = ['cru', 'data-url', 'data-u', 'data-href', 'data-redir', 'origin-url'];
    for (const attr of attrs) {
      const v = link.getAttribute && link.getAttribute(attr);
      if (v) {
        const raw = String(v).trim();
        if (!raw || /^#\s*$/.test(raw)) continue;
        if (raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;
        try {
          const u = new URL(raw, base);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            return isNavigationUrl(u.href) ? u.href : null;
          }
        } catch (e) {}
      }
    }

    // Priority: onclick – robust extraction (urlencode("..."), goOtherCR(..., "u="+...), etc.)
    const onclick = link.getAttribute && link.getAttribute('onclick');
    if (onclick && typeof onclick === 'string') {
      const extracted = parseOnclickForUrl(onclick, base);
      if (extracted && isNavigationUrl(extracted)) return extracted;
    }

    const href = (link.getAttribute && link.getAttribute('href')) || link.href || '';
    const rawHref = String(href).trim();
    if (!rawHref) return null;

    try {
      const parsed = new URL(rawHref, base);
      const path = parsed.pathname || '';
      const pathMatchesRedirect = REDIRECT_PATH_PATTERNS.some((p) => p.test(path)) ||
        /\/p\/crd\/rd/.test(parsed.pathname + parsed.search);
      // Try static extraction: (1) when path matches redirect patterns, or (2) when ANY redirect param exists
      const hasRedirectParam = ['u', 'url', 'dest', 'target', 'to', 'destination', 'link'].some((k) => parsed.searchParams.has(k));
      if (pathMatchesRedirect || hasRedirectParam) {
        const extracted = parseRedirectParams(rawHref, base);
        if (extracted) return isNavigationUrl(extracted) ? extracted : null;
      }
    } catch (e) {}

    try {
      const u = new URL(rawHref, base);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return isNavigationUrl(u.href) ? u.href : null;
      }
    } catch (e) {}
    return null;
  } catch (e) {
    return null;
  }
}

// Visibility filter for URL extraction:
// Skip links that are present in the DOM but not currently visible (collapsed menus, hidden panels).
function isVisibleForUrlScan(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    // Generic collapsed toggle signal.
    if (el.closest && el.closest('[aria-expanded="false"]')) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (cs) {
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden') return false;
      const pos = cs.position || '';
      if (el.offsetParent === null && pos !== 'fixed') return false;
    }
    return true;
  } catch (e) {
    // Fail-open to avoid breaking extraction on style access errors.
    return true;
  }
}

/**
 * Check if a URL is external (different origin) using hierarchical domain analysis
 * 
 * @param {string} url - The URL to check
 * @returns {boolean} - True if external, false if internal
 */
export function isExternalUrl(url, context = null) {
  if (!url) return false;
  
  try {
    // Resolve relative URLs to absolute using current page as base
    const urlObj = new URL(url, window.location.href);
    const currentUrlObj = new URL(window.location.href);
    
    const urlHostname = normalizeHostname(urlObj.hostname || '');
    const currentHostname = normalizeHostname(currentUrlObj.hostname || '');

    // Best-effort element geometry (for optional UI heuristics like “brand logo” exceptions)
    let elementRect = null;
    try {
      if (context && context.element && context.element.getBoundingClientRect) {
        elementRect = context.element.getBoundingClientRect();
      } else if (context && context.elementRect) {
        elementRect = context.elementRect;
      }
    } catch (e) {
      elementRect = null;
    }

    // Normalize pathnames for similarity checks (ignore trailing slash)
    const normalizePathname = (pathname) => {
      if (!pathname) return '/';
      let p = pathname;
      if (p.length > 1 && p.endsWith('/')) {
        p = p.slice(0, -1);
      }
      return p || '/';
    };

    // Normalize query string for equality checks (sort params; ignore tracking-ish keys)
    const normalizeSearch = (searchParams) => {
      const ignoredPrefixes = ['utm_'];
      const ignoredExact = new Set(['fbclid', 'gclid']);
      const entries = [];
      for (const [k, v] of searchParams.entries()) {
        const key = k.toLowerCase();
        if (ignoredExact.has(key)) continue;
        if (ignoredPrefixes.some(p => key.startsWith(p))) continue;
        entries.push([key, v]);
      }
      entries.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
      return entries.map(([k, v]) => `${k}=${v}`).join('&');
    };
    
    // If hostnames are identical, this may still be a meaningful content navigation.
    // Do NOT reject solely based on same hostname.
    if (urlHostname === currentHostname) {
      // Reject pure fragment jumps or same-page navigations (ignoring hash)
      const baseCurrent = normalizeComparableUrl(currentUrlObj.href);
      const baseTarget = normalizeComparableUrl(urlObj.href);
      if (baseCurrent && baseTarget && baseCurrent === baseTarget) {
        return false;
      }

      const urlPath = normalizePathname(urlObj.pathname);
      const currentPath = normalizePathname(currentUrlObj.pathname);

      // Treat as “valid content navigation” if pathname diverges meaningfully.
      if (urlPath !== currentPath) {
        const segs = (p) => (p || '/').split('/').filter(Boolean);
        const a = segs(currentPath);
        const b = segs(urlPath);
        // From homepage/root to deeper content is usually meaningful.
        if (currentPath === '/' && urlPath !== '/') {
          return true;
        }
        // Different segment count or different first segment => meaningful step.
        if (a.length !== b.length || (a[0] && b[0] && a[0] !== b[0])) {
          return true;
        }
        // Otherwise fall through to ID-param check below.
      }

      // Treat as “valid content navigation” if URL contains ID-like parameters (generic).
      const hasContentIdParam = (u) => {
        try {
          const explicit = new Set(['id', 'v', 'articleno']);
          for (const [k, v] of u.searchParams.entries()) {
            const key = (k || '').toLowerCase();
            const val = (v || '').trim();
            if (!val || val.length < 2) continue;
            if (explicit.has(key)) return true;
            if (key.endsWith('id')) return true;
            if (key.includes('id') && key.length <= 20) return true;
          }
          return false;
        } catch (e) {
          return false;
        }
      };

      if (hasContentIdParam(urlObj)) {
        return true;
      }

      return false;
    }
    
    // Extract root domains (removes subdomains) for same-site heuristics only.
    const urlRootDomain = getRootDomain(urlHostname);
    const currentRootDomain = getRootDomain(currentHostname);
    
    // If root domains are different, it's external
    if (urlRootDomain !== currentRootDomain) {
      return true;
    }
    
    // Same root domain - apply same-site heuristics.

    // Guard A (Path Similarity): reject ONLY if it points to the exact same page.
    // (Same normalized pathname + same normalized query string; hash differences are ignored by URL parsing here.)
    const urlPath = normalizePathname(urlObj.pathname);
    const currentPath = normalizePathname(currentUrlObj.pathname);
    const urlQuery = normalizeSearch(urlObj.searchParams);
    const currentQuery = normalizeSearch(currentUrlObj.searchParams);
    if (urlPath === currentPath && urlQuery === currentQuery) {
      return false;
    }

    // Guard B (Subdomain → Root “home button”): treat sub.example.com → example.com as internal/noise when landing on root-ish paths
    // Brand Logo Exception: if the hovered element is large, treat it as “content candidate” instead of navigation noise.
    const urlIsRootHostname = urlHostname === urlRootDomain;
    const currentHasSubdomain = currentHostname !== currentRootDomain;
    if (currentHasSubdomain && urlIsRootHostname && urlPath === '/' && urlQuery === '') {
      const isLarge = !!(elementRect && (elementRect.width > 80 || elementRect.height > 30));
      if (isLarge) {
        return true;
      }
      return false;
    }

    // Subdomain-sensitive rule:
    // If hostnames differ (even under same root domain), treat as a distinct destination.
    // (This prevents grouping sub1.example.com and sub2.example.com as the same site in density/dominance logic.)
    if (urlHostname && currentHostname && urlHostname !== currentHostname) {
      return true;
    }

    // Query parameter sensitivity heuristic (same path): fewer params often indicates “back to simpler nav”
    if (urlPath === currentPath && urlQuery !== currentQuery) {
      const urlKeys = new Set(Array.from(urlObj.searchParams.keys()).map(k => k.toLowerCase()));
      const currentKeys = new Set(Array.from(currentUrlObj.searchParams.keys()).map(k => k.toLowerCase()));
      if (urlKeys.size < currentKeys.size) {
        return false;
      }
      // Otherwise, do not reject here; allow existing hierarchy rules to decide.
    }
    
    // Same hostname under same root domain: fall through to default allow at end.
    return true; // External
  } catch (e) {
    // If URL parsing fails, treat as internal (safer default)
    return false;
  }
}

/**
 * Normalize a URL for consistent comparison across modules.
 * - Resolves relative URLs against window.location.href
 * - Removes hash fragments
 * - Strips common tracking params (utm_*, gclid/fbclid, etc.)
 * - Normalizes trailing slash (except root)
 * - Sorts remaining query params for stable equality comparisons
 *
 * @param {string} url
 * @returns {string|null}
 */
export function normalizeComparableUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw || raw === '#' || raw.startsWith('#')) return null;
  const lowered = raw.toLowerCase();
  if (lowered.startsWith('javascript:') || lowered.startsWith('mailto:') || lowered.startsWith('tel:')) return null;

  try {
    const u = new URL(raw, window.location.href);
    u.hash = '';

    const ignoredPrefixes = ['utm_'];
    const ignoredExact = new Set(['fbclid', 'gclid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'spm', 'src', 'source']);

    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const key = (k || '').toLowerCase();
      if (ignoredExact.has(key)) continue;
      if (ignoredPrefixes.some(p => key.startsWith(p))) continue;
      kept.push([k, v]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    u.search = '';
    for (const [k, v] of kept) {
      u.searchParams.append(k, v);
    }

    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch (e) {
    return null;
  }
}

/**
 * Normalize a URL for comparison while PRESERVING hash fragments.
 *
 * Use this when fragment differences represent distinct destinations (e.g., link chips like `#s-1`, `#s-2`),
 * and we must treat those as separate items during dominance/distinctness decisions.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function normalizeComparableUrlKeepHash(url) {
  if (!url || typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw || raw === '#' || raw.startsWith('#')) return null;
  const lowered = raw.toLowerCase();
  if (lowered.startsWith('javascript:') || lowered.startsWith('mailto:') || lowered.startsWith('tel:')) return null;

  try {
    const u = new URL(raw, window.location.href);
    // NOTE: DO NOT clear u.hash here.

    const ignoredPrefixes = ['utm_'];
    const ignoredExact = new Set(['fbclid', 'gclid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'spm', 'src', 'source']);

    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const key = (k || '').toLowerCase();
      if (ignoredExact.has(key)) continue;
      if (ignoredPrefixes.some(p => key.startsWith(p))) continue;
      kept.push([k, v]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    u.search = '';
    for (const [k, v] of kept) {
      u.searchParams.append(k, v);
    }

    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch (e) {
    return null;
  }
}

/**
 * Clean tracking noise from a URL while preserving the "detailed identity":
 * - Keep: origin + full pathname + meaningful query params + FULL hash fragment
 * - Remove: known tracking params (utm_*, gclid, fbclid, etc.) and obvious click/timestamp noise
 *
 * This is intentionally conservative: it avoids dropping parameters that look like content IDs.
 *
 * @param {string} url
 * @param {{ baseUrl?: string }} [options]
 * @returns {string|null}
 */
export function cleanTrackingParams(url, options = {}) {
  try {
    if (!url || typeof url !== 'string') return null;
    const raw = url.trim();
    if (!raw) return null;
    const lowered = raw.toLowerCase();
    if (lowered === '#' || lowered.startsWith('javascript:') || lowered.startsWith('mailto:') || lowered.startsWith('tel:')) return null;

    const baseUrl = (options && options.baseUrl) ? String(options.baseUrl) : (window.location ? window.location.href : '');
    const u = new URL(raw, baseUrl);

    // NOTE: We DO NOT touch u.hash here. Hash differences must remain distinct.

    const ignoredPrefixes = ['utm_'];
    const ignoredExact = new Set([
      'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid',
      'yclid', 'igshid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok',
      'ref', 'src', 'source', 'spm'
    ]);

    // Keys that are commonly content-identifiers and must not be dropped even if they look random.
    const contentKeys = new Set([
      'id', 'v', 'vid', 'video', 'videoid', 'article', 'articleno',
      'docid', 'doc', 'aid', 'uid', 'gid', 'mid', 'pid', 'post', 'postid',
      'item', 'itemid', 'product', 'productid', 'sku',
      'q', 'query', 'keyword', 'imgid', 'imageid'
    ]);

    const isLikelyContentKey = (k) => {
      const key = (k || '').toLowerCase();
      if (!key) return false;
      if (contentKeys.has(key)) return true;
      if (key.endsWith('id')) return true;
      if (key.includes('id') && key.length <= 20) return true;
      return false;
    };

    const looksLikeEpoch = (v) => /^\d{10,13}$/.test(String(v || '').trim());
    const looksLikeRandomToken = (v) => {
      const s = String(v || '').trim();
      if (s.length < 10) return false;
      // Long alnum-ish tokens are often click IDs.
      if (/^[a-z0-9._-]{10,}$/i.test(s)) return true;
      return false;
    };

    const shouldDropKey = (k, v) => {
      const key = (k || '').toLowerCase();
      if (!key) return false;
      if (ignoredExact.has(key)) return true;
      if (ignoredPrefixes.some((p) => key.startsWith(p))) return true;

      if (isLikelyContentKey(key)) return false;

      // Obvious tracking-ish keys (segment-boundary-ish patterns)
      if (/(?:^|_)(?:clk|click|track|tracking|trk|campaign|cmp|source|medium|referrer|ref)(?:_|$)/i.test(key)) return true;

      // Timestamp/cache-bust style keys: drop only when the value looks like an epoch/random token.
      if (/^(?:ts|timestamp|time|cb|cachebust|cache_bust|rand|random|nonce|r|_t|t)$/.test(key)) {
        return looksLikeEpoch(v) || looksLikeRandomToken(v);
      }

      return false;
    };

    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (shouldDropKey(k, v)) continue;
      kept.push([k, v]);
    }
    kept.sort((a, b) => {
      const ak = String(a[0]);
      const bk = String(b[0]);
      if (ak === bk) return String(a[1]) < String(b[1]) ? -1 : String(a[1]) > String(b[1]) ? 1 : 0;
      return ak < bk ? -1 : 1;
    });
    u.search = '';
    for (const [k, v] of kept) {
      u.searchParams.append(k, v);
    }

    // Normalize trailing slash (except root)
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);

    return u.href;
  } catch (e) {
    return null;
  }
}

/**
 * Resolve a raw URL into a "detailed redirected URL" suitable for strict comparisons.
 * - Resolves relative URLs against the current page
 * - Follows redirects via the background resolver
 * - Preserves hash fragments (hash differences remain distinct)
 * - Removes tracking noise (cleanTrackingParams)
 *
 * @param {string} rawURL
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<string|null>}
 */
export async function resolve(rawURL, options = {}) {
  try {
    if (!rawURL || typeof rawURL !== 'string') return null;
    const raw = rawURL.trim();
    if (!raw) return null;
    const lowered = raw.toLowerCase();
    if (lowered === '#' || lowered.startsWith('javascript:') || lowered.startsWith('mailto:') || lowered.startsWith('tel:')) return null;

    const baseUrl = (options && options.baseUrl) ? String(options.baseUrl) : (window.location ? window.location.href : '');
    const abs = new URL(raw, baseUrl).href;
    const absObj = new URL(abs);
    const originalHash = absObj.hash || '';

    // Pre-clean before resolving (helps reduce cache fragmentation).
    const preClean = cleanTrackingParams(abs, { baseUrl }) || abs;

    // Fast path: if we already have a cached redirect resolution, return immediately.
    const cached = resolveCached(preClean, { baseUrl });
    if (cached) return cached;

    // Static extraction: if destination is in query params (?url=, ?u=, etc.), use it immediately.
    const staticExtracted = tryStaticExtract(preClean, baseUrl);
    const urlToCheck = staticExtracted ? (cleanTrackingParams(staticExtracted, { baseUrl }) || staticExtracted) : preClean;
    if (urlToCheck) {
      try {
        const currentHost = (typeof window !== 'undefined' && window.location) ? window.location.hostname || '' : '';
        const targetHost = new URL(urlToCheck, baseUrl).hostname || '';
        const currentRoot = getRootDomain(currentHost);
        const targetRoot = getRootDomain(targetHost);
        if (currentRoot && targetRoot && currentRoot !== targetRoot) {
          // External domain: skip network fetch – use extracted or input as resolved.
          urlResolver.cache.set(urlResolver._normalizeUrl(preClean), { resolvedUrl: urlToCheck, timestamp: Date.now() });
          return urlToCheck;
        }
      } catch (e) {}
    }
    if (staticExtracted) {
      const cleaned = cleanTrackingParams(staticExtracted, { baseUrl }) || staticExtracted;
      if (cleaned) {
        urlResolver.cache.set(urlResolver._normalizeUrl(preClean), { resolvedUrl: cleaned, timestamp: Date.now() });
        return cleaned;
      }
    }

    // Resolve redirects (urlResolver caches on a fragment-free key internally).
    const resolved = await urlResolver.resolveRedirect(preClean);
    let resolvedAbs = resolved || preClean;

    // Fallback guard: if network returned same host as input (failed jump / non-resolution), use static extraction.
    if (staticExtracted) {
      try {
        const inputHost = new URL(preClean, baseUrl).hostname || '';
        const outputHost = new URL(resolvedAbs, baseUrl).hostname || '';
        if (inputHost && outputHost && inputHost.toLowerCase() === outputHost.toLowerCase()) {
          const cleaned = cleanTrackingParams(staticExtracted, { baseUrl }) || staticExtracted;
          if (cleaned) resolvedAbs = cleaned;
        }
      } catch (e) {}
    }

    // Preserve original hash if redirect resolution dropped it.
    let resolvedObj = null;
    try {
      resolvedObj = new URL(resolvedAbs, baseUrl);
    } catch (e) {
      resolvedObj = new URL(preClean, baseUrl);
    }
    if ((!resolvedObj.hash || resolvedObj.hash === '') && originalHash) {
      resolvedObj.hash = originalHash;
    }

    return cleanTrackingParams(resolvedObj.href, { baseUrl }) || resolvedObj.href;
  } catch (e) {
    return null;
  }
}

/**
 * Synchronous cache-only variant of resolve().
 * Returns a resolved URL ONLY if the redirect result is already cached in-memory.
 *
 * @param {string} rawURL
 * @param {{ baseUrl?: string }} [options]
 * @returns {string|null}
 */
export function resolveCached(rawURL, options = {}) {
  try {
    if (!rawURL || typeof rawURL !== 'string') return null;
    const raw = rawURL.trim();
    if (!raw) return null;
    const lowered = raw.toLowerCase();
    if (lowered === '#' || lowered.startsWith('javascript:') || lowered.startsWith('mailto:') || lowered.startsWith('tel:')) return null;

    const baseUrl = (options && options.baseUrl) ? String(options.baseUrl) : (window.location ? window.location.href : '');
    const abs = new URL(raw, baseUrl).href;
    const absObj = new URL(abs);
    const originalHash = absObj.hash || '';

    const preClean = cleanTrackingParams(abs, { baseUrl }) || abs;
    const key = urlResolver._normalizeUrl(preClean);
    const cached = urlResolver.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp >= urlResolver.CACHE_EXPIRY_MS) return null;

    const resolvedAbs = cached.resolvedUrl || preClean;
    let resolvedObj = null;
    try {
      resolvedObj = new URL(resolvedAbs, baseUrl);
    } catch (e) {
      resolvedObj = new URL(preClean, baseUrl);
    }
    if ((!resolvedObj.hash || resolvedObj.hash === '') && originalHash) {
      resolvedObj.hash = originalHash;
    }

    return cleanTrackingParams(resolvedObj.href, { baseUrl }) || resolvedObj.href;
  } catch (e) {
    return null;
  }
}

/**
 * Get a human-readable URL state label for debug logs.
 * Distinguishes: [Raw Href], [Extracted URL], [Resolving...], [Network Resolved: domain.com]
 *
 * @param {string} rawUrl
 * @param {string|null} resolvedUrl - Resolved URL if available
 * @param {{ baseUrl?: string, source?: 'raw'|'extracted'|'network' }} [options]
 *   - source: when known, use explicit label (raw=href attr, extracted=attr/param analysis, network=fetch)
 * @returns {string}
 */
export function getUrlStateLabel(rawUrl, resolvedUrl, options = {}) {
  try {
    if (!rawUrl || typeof rawUrl !== 'string') return '[Raw Href]';
    const baseUrl = (options && options.baseUrl) || (typeof window !== 'undefined' && window.location ? window.location.href : '') || 'https://example.com';
    const source = options && options.source;

    if (source === 'raw') return '[Raw Href]';
    if (source === 'extracted') return '[Extracted URL]';

    const key = urlResolver._normalizeUrl(cleanTrackingParams(new URL(rawUrl.trim(), baseUrl).href, { baseUrl }) || rawUrl);
    if (urlResolver.pendingRequests && urlResolver.pendingRequests.has(key)) return '[Resolving...]';

    const effectiveResolved = resolvedUrl || resolveCached(rawUrl, { baseUrl });
    if (effectiveResolved && typeof effectiveResolved === 'string') {
      try {
        const u = new URL(effectiveResolved.trim(), baseUrl);
        const host = (u.hostname || '').toLowerCase();
        return host ? `[Network Resolved: ${host}]` : '[Network Resolved]';
      } catch (e) {
        return '[Network Resolved]';
      }
    }

    if (source === 'network') return '[Network Resolved]';
    return '[Raw Href]';
  } catch (e) {
    return '[Raw Href]';
  }
}

/**
 * Batch resolve URLs with optional priority. Resolves priorityUrl first, then others in parallel.
 * Warms cache for secondary URLs. Use for nearbyUrl, dominantUrl, activeHoverUrl before decisions.
 *
 * @param {string[]} urls - URLs to resolve
 * @param {{ baseUrl?: string, priorityUrl?: string }} [options]
 * @returns {Promise<Map<string,string>>} - rawUrl -> resolvedUrl
 */
export async function resolveBatch(urls, options = {}) {
  const baseUrl = (options && options.baseUrl) || (typeof window !== 'undefined' && window.location ? window.location.href : '') || 'https://example.com';
  const priorityUrl = options.priorityUrl || null;
  const result = new Map();

  const unique = [...new Set(urls.filter((u) => u && typeof u === 'string' && u.trim()))];
  if (unique.length === 0) return result;

  // Resolve priority URL first if present
  if (priorityUrl && unique.includes(priorityUrl)) {
    const resolved = await resolve(priorityUrl, { baseUrl });
    if (resolved) result.set(priorityUrl, resolved);
  }

  // Resolve remaining in parallel (cache warming)
  const rest = priorityUrl ? unique.filter((u) => u !== priorityUrl) : unique;
  const restResolved = await Promise.all(rest.map((u) => resolve(u, { baseUrl })));
  rest.forEach((u, i) => {
    const r = restResolved[i];
    if (r) result.set(u, r);
  });

  return result;
}

/**
 * Resolve a single URL, ensuring it is available before decision logic.
 * If resolution is pending (blind redirector, cold cache), waits for it.
 * Returns resolved URL or raw URL on timeout/error.
 *
 * @param {string} url
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<string|null>}
 */
export async function resolveForDecision(url, options = {}) {
  if (!url || typeof url !== 'string') return null;
  const baseUrl = (options && options.baseUrl) || (typeof window !== 'undefined' && window.location ? window.location.href : '') || 'https://example.com';
  const cached = resolveCached(url, { baseUrl });
  if (cached) return cached;
  if (!isBlindRedirector(url, { baseUrl })) return url; // Not a redirector, use as-is
  const resolved = await resolve(url, { baseUrl });
  return resolved || url;
}

/**
 * Intent classifier (Discovery vs Non-Discovery).
 *
 * New contract:
 * - DISCOVERY URLs are only: CONTENT_ITEM or CONTENT_INFO
 * - Everything else is NON_DISCOVERY (ACTION / INTERNAL_VIEW / GATEWAY)
 *
 * Backwards compatible: accepts (targetUrlStr, currentUrlStr?) during migration.
 *
 * @param {string} targetUrlStr
 * @param {string} [currentUrlStr]
 * @param {{ isInsideValidatedContainer?: boolean }} [options]
 * @returns {{ group: 'DISCOVERY'|'NON_DISCOVERY', category: 'CONTENT_ITEM'|'CONTENT_INFO'|'ACTION'|'INTERNAL_VIEW'|'GATEWAY', reason: string, details?: any }|null}
 */
export function getUrlIntent(targetUrlStr, currentUrlStr = null, options = null) {
  try {
    const base = (typeof currentUrlStr === 'string' && currentUrlStr.trim())
      ? currentUrlStr.trim()
      : (window.location ? window.location.href : '');

    const cleaned = cleanTrackingParams(targetUrlStr, { baseUrl: base }) || targetUrlStr;
    // Use resolved URL when cached (tracking URLs like ader.naver.com -> true destination).
    const urlToCheck = resolveCached(cleaned, { baseUrl: base }) || cleaned;
    const intent = getUrlIntentInternal(urlToCheck, base, options || null);
    if (!intent) return null;
    const group = (intent.category === 'CONTENT_ITEM' || intent.category === 'CONTENT_INFO') ? 'DISCOVERY' : 'NON_DISCOVERY';
    return { group, ...intent };
  } catch (e) {
    return null;
  }
}

// Internal implementation for intent (keeps existing semantics but under new wrapper).
function getUrlIntentInternal(targetUrlStr, currentUrlStr, options) {
  try {
    if (!targetUrlStr || typeof targetUrlStr !== 'string') return null;
    const rawTarget = targetUrlStr.trim();
    if (!rawTarget) return null;

    const currentBase = (typeof currentUrlStr === 'string' && currentUrlStr.trim())
      ? currentUrlStr.trim()
      : (window.location ? window.location.href : '');

    // Fragment-only navigations are treated as content destinations (viewer open / content panel).
    if (rawTarget.startsWith('#') && rawTarget !== '#') {
      return { category: 'CONTENT_ITEM', reason: 'hash-navigation', details: { href: rawTarget } };
    }

    const targetUrlObj = new URL(rawTarget, currentBase);
    const currentUrlObj = new URL(currentBase);

    const targetHost = normalizeHostname(targetUrlObj.hostname || '');
    const currentHost = normalizeHostname(currentUrlObj.hostname || '');

    const targetPath = (targetUrlObj.pathname || '/').toLowerCase();
    const currentPath = (currentUrlObj.pathname || '/').toLowerCase();

    // Authentication & Identity: classify login/accounts URLs as NON_DISCOVERY (Action) early.
    // Must run before external-host check so login.sooplive.co.kr, accounts.google.com are not treated as discovery.
    const authSubdomains = new Set(['login', 'accounts', 'signin', 'auth', 'sso', 'id', 'passport']);
    const authPathPatterns = [
      /\/login(?:\/|$)/i,
      /\/signin(?:\/|$)/i,
      /\/authorize(?:\/|$)/i,
      /\/authenticate(?:\/|$)/i,
      /\/account\/login(?:\/|$)/i,
      /\/accounts\/login(?:\/|$)/i,
    ];
    const knownAuthHostSuffixes = [
      'login.sooplive.co.kr', 'login.afreecatv.com',
      'accounts.google.com', 'accounts.nintendo.com',
      'id.naver.com', 'nid.naver.com', 'login.naver.com',
      'kauth.kakao.com', 'accounts.kakao.com',
      'login.facebook.com', 'accounts.facebook.com',
    ];
    const hostLower = (targetUrlObj.hostname || '').toLowerCase();
    const hostFirstLabel = hostLower.split('.')[0] || '';
    const isAuthSubdomain = authSubdomains.has(hostFirstLabel);
    const isAuthPath = authPathPatterns.some((re) => re.test(targetPath));
    const isKnownAuthHost = knownAuthHostSuffixes.some((s) => hostLower === s || hostLower.endsWith('.' + s));
    if (isAuthSubdomain || isAuthPath || isKnownAuthHost) {
      const reason = isAuthSubdomain ? 'auth-subdomain' : (isAuthPath ? 'auth-path' : 'auth-host');
      return { category: 'ACTION', subGroup: 'Action', reason, details: { path: targetUrlObj.pathname, host: targetUrlObj.hostname } };
    }

    const actionTokens = ['cart', 'checkout', 'share', 'login', 'logout', 'signin', 'signup', 'settings', 'account', 'accounts', 'session'];
    for (const token of actionTokens) {
      const re = new RegExp(`/(?:${token})(?:/|$)`, 'i');
      if (re.test(targetPath)) {
        return { category: 'ACTION', reason: 'action-path', details: { path: targetUrlObj.pathname } };
      }
    }

    // External exception: subdomain-sensitive host mismatch => default CONTENT_ITEM.
    if (targetHost && currentHost && targetHost !== currentHost) {
      return { category: 'CONTENT_ITEM', reason: 'external-host', details: { targetHost, currentHost } };
    }

    // Same-domain: promote internal links to DISCOVERY when inside validated container or on search result page.
    const opts = options && typeof options === 'object' ? options : {};
    const isInsideValidatedContainer = !!opts.isInsideValidatedContainer;
    const isSearchResultPage = (() => {
      try {
        const path = (currentUrlObj.pathname || '').toLowerCase();
        const hasSearchPath = path.includes('/search');
        const hasSearchParam = currentUrlObj.searchParams.has('q') || currentUrlObj.searchParams.has('query') || currentUrlObj.searchParams.has('hl');
        return hasSearchPath || hasSearchParam;
      } catch (e) {
        return false;
      }
    })();
    const hasNoRedirectParams = (() => {
      for (const k of ['continue', 'redirect', 'url', 'dest', 'destination']) {
        if (targetUrlObj.searchParams.has(k)) return false;
      }
      return true;
    })();
    const isClean = isCleanLandingPage(targetPath, targetUrlObj);
    if ((isInsideValidatedContainer || isSearchResultPage) && isClean && hasNoRedirectParams) {
      return { category: 'CONTENT_ITEM', reason: 'internal-promoted', details: { path: targetUrlObj.pathname, host: targetUrlObj.hostname } };
    }

    // Gateway detection: redirect-like params that point back to same root domain.
    const redirectKeys = ['continue', 'redirect', 'url', 'dest', 'destination'];
    const targetRoot = getRootDomain(targetHost);
    for (const k of redirectKeys) {
      const v = targetUrlObj.searchParams.get(k);
      if (!v) continue;
      let inner = null;
      try {
        inner = new URL(v, currentBase);
      } catch (e) {
        inner = null;
      }
      if (!inner) continue;
      const innerHost = normalizeHostname(inner.hostname || '');
      const innerRoot = getRootDomain(innerHost);
      if (innerRoot && targetRoot && innerRoot === targetRoot) {
        return { category: 'GATEWAY', reason: 'redirect-param', details: { param: k, inner: inner.href } };
      }
    }

    // Primary query keys and view-state keys.
    const primaryKeys = ['q', 'query', 'keyword'];
    const viewKeys = ['udm', 'tbm', 'view', 'tab'];

    const getPrimary = (u) => {
      for (const k of primaryKeys) {
        if (u.searchParams.has(k)) {
          const val = (u.searchParams.get(k) || '').trim();
          if (val) return { key: k, val };
        }
      }
      return null;
    };

    const currPrimary = getPrimary(currentUrlObj);
    const tgtPrimary = getPrimary(targetUrlObj);

    // Logo/Home reset.
    const isRootish = (p) => p === '/' || p === '' || p === '/webhp';
    if (currPrimary && isRootish(targetPath) && (!tgtPrimary || tgtPrimary.key !== currPrimary.key)) {
      return { category: 'ACTION', reason: 'home-reset', details: { dropped: currPrimary.key } };
    }

    // INTERNAL_VIEW: same query but view-state differs.
    if (currPrimary && tgtPrimary && currPrimary.val === tgtPrimary.val) {
      const diff = {};
      let hasDiff = false;
      for (const k of viewKeys) {
        const a = currentUrlObj.searchParams.get(k);
        const b = targetUrlObj.searchParams.get(k);
        if ((a || '') !== (b || '')) {
          diff[k] = { from: a || null, to: b || null };
          hasDiff = true;
        }
      }
      if (hasDiff) {
        return { category: 'INTERNAL_VIEW', reason: 'view-state-param', details: { primary: currPrimary.key, diff } };
      }
    }

    // INTERNAL_VIEW (vertical switches): same host + same query, but shallow path switches.
    const isLikelyVerticalPath = (p) => {
      try {
        const segs = (p || '/').split('/').filter(Boolean);
        if (segs.length !== 1) return false;
        const seg = segs[0].toLowerCase();
        if (!seg || seg.length < 2 || seg.length > 24) return false;
        if (!/^[a-z0-9-]+$/.test(seg)) return false;
        const excluded = new Set([
          'cart','checkout','share','login','logout','signin','signup','settings','account','accounts','session',
          'about','product','info','intl'
        ]);
        if (excluded.has(seg)) return false;
        return true;
      } catch (e) {
        return false;
      }
    };
    if (currPrimary && tgtPrimary && currPrimary.val === tgtPrimary.val && targetPath !== currentPath) {
      const currentIsVertical = isLikelyVerticalPath(currentPath) || isRootish(currentPath);
      const targetIsVertical = isLikelyVerticalPath(targetPath) || isRootish(targetPath);
      if (currentIsVertical && targetIsVertical) {
        return { category: 'INTERNAL_VIEW', reason: 'vertical-path-switch', details: { primary: currPrimary.key, from: currentUrlObj.pathname, to: targetUrlObj.pathname } };
      }
    }

    // CONTENT_INFO boost: informational paths without query params.
    const hasAnyQuery = Array.from(targetUrlObj.searchParams.keys()).length > 0;
    if (!hasAnyQuery) {
      const infoTokens = ['about', 'product', 'info', 'intl'];
      for (const token of infoTokens) {
        const re = new RegExp(`/(?:${token})(?:/|$)`, 'i');
        if (re.test(targetPath)) {
          return { category: 'CONTENT_INFO', reason: 'info-path', details: { token } };
        }
      }
    }

    return { category: 'CONTENT_ITEM', reason: 'default', details: { path: targetUrlObj.pathname, currentPath } };
  } catch (e) {
    return null;
  }
}

/**
 * Find the best URL from all links within a container using universal heuristics
 * @param {HTMLElement} container - The container element to search within
 * @returns {string|null} - The best URL found, or null
 */
export function findBestUrlInContainer(container) {
  if (!container || !container.querySelector) return null;
  
  // Find all links within the container
  const allLinks = container.querySelectorAll('a[href]');
  if (allLinks.length === 0) return null;
  
  // Common redirect/tracking URL patterns to avoid
  const redirectPatterns = [
    /^https?:\/\/bit\.ly\//,
    /^https?:\/\/t\.co\//,
    /^https?:\/\/goo\.gl\//,
    /^https?:\/\/tinyurl\.com\//,
    /^https?:\/\/[^\/]+\/url\?/i, // Generic "/url?" redirect endpoints
    /^https?:\/\/[^\/]+\/redirect\?/i, // Generic redirect endpoints
    /^https?:\/\/[^\/]+\/[a-zA-Z0-9]{10,}$/, // Short hash-like paths (likely redirects)
  ];
  
  // Heuristic scoring function
  const scoreLink = (link) => {
    let score = 0;
    const href = getOriginalUrl(link) || link.href;
    if (!href || !isNavigationUrl(href)) return -Infinity;

    // Negative scores for redirect/tracking URLs
    for (const pattern of redirectPatterns) {
      if (pattern.test(href)) {
        score -= 100;
        break;
      }
    }
    
    // Positive scores for content indicators
    // Longer, more specific paths are better (avoid short redirect IDs)
    const pathLength = new URL(href).pathname.length;
    if (pathLength > 20) score += 20;
    if (pathLength > 50) score += 10;
    
    // Prefer links with meaningful path segments (not just IDs)
    const pathSegments = new URL(href).pathname.split('/').filter(s => s.length > 0);
    if (pathSegments.length > 1) score += 15;
    if (pathSegments.some(s => s.length > 10 && /[a-z]/.test(s))) score += 10; // Has readable segments
    
    // Prefer links deeper in DOM (further from container root)
    let depth = 0;
    let current = link;
    while (current && current !== container && depth < 20) {
      depth++;
      current = current.parentElement;
    }
    score += depth; // Deeper links are usually the actual content links
    
    // Prefer links that don't look like tracking/analytics
    if (!href.includes('utm_') && !href.includes('ref=') && !href.includes('source=')) {
      score += 5;
    }
    
    return score;
  };
  
  // Score all links and find the best one
  let bestLink = null;
  let bestScore = -Infinity;
  
  for (const link of allLinks) {
    if (!isVisibleForUrlScan(link)) continue;
    try {
      const resolved = getOriginalUrl(link) || link.href;
      if (!resolved || !isNavigationUrl(resolved)) continue;
      const url = new URL(resolved, window.location.href);
      const score = scoreLink(link);
      if (score > bestScore) {
        bestScore = score;
        bestLink = url.href;
      }
    } catch (e) {
      // Skip invalid URLs
      continue;
    }
  }

  return bestLink;
}

/**
 * Extract URL from all data attributes within a container (universal approach)
 * @param {HTMLElement} container - The container element to search within
 * @returns {string|null} - The first valid URL found, or null
 */
export function findUrlInContainerDataAttributes(container) {
  if (!container) return null;
  if (!isVisibleForUrlScan(container)) return null;
  
  // Check container and its parents (up to 3 levels)
  let current = container;
  let depth = 0;
  const maxDepth = 3;
  
  while (current && depth < maxDepth) {
    // Get all data attributes
    const attributes = current.attributes;
    if (attributes) {
      for (let i = 0; i < attributes.length; i++) {
        const attr = attributes[i];
        if (attr.name.startsWith('data-')) {
          const value = attr.value;
          // Check if value looks like a URL
          if (value && (value.startsWith('http://') || value.startsWith('https://'))) {
            try {
              const url = new URL(value);
              if (isNavigationUrl(url.href)) return url.href;
            } catch (e) {
              // Not a valid URL, continue
            }
          }
        }
      }
    }
    current = current.parentElement;
    depth++;
  }
  
  return null;
}

/**
 * Extract URL from an element that can navigate (link or element with click handler)
 * Checks for href attribute, data attributes, or click handlers that navigate
 * Also handles images that navigate when clicked
 * 
 * @param {HTMLElement} element - The element to check
 * @param {HTMLElement} container - Optional container to search within first
 * @returns {string|null} - The URL if found, null otherwise
 */
const MEDIA_EXTRACT_BLOCK_TAGS = new Set(['IMG', 'SOURCE', 'VIDEO', 'AUDIO']);

export function extractUrlFromNavigableElement(element, container = null) {
  if (!element) return null;
  if (!isVisibleForUrlScan(element)) return null;

  const tag = String(element.tagName || '').toUpperCase();
    if (MEDIA_EXTRACT_BLOCK_TAGS.has(tag)) {
    if (container) {
      const containerLink = findBestUrlInContainer(container);
      if (containerLink) return containerLink;
      const containerDataUrl = findUrlInContainerDataAttributes(container);
      if (containerDataUrl) return containerDataUrl;
    }
    return null;
  }

  // PRIORITY 0: If container is provided, search within it first (universal approach)
  if (container) {
    // Try to find best link within container
    const containerLink = findBestUrlInContainer(container);
    if (containerLink) {
      return containerLink;
    }
    
    // Try to find URL in container's data attributes
    const containerDataUrl = findUrlInContainerDataAttributes(container);
    if (containerDataUrl) {
      return containerDataUrl;
    }
  }
  
  // Method 1: Check if it's an <a> tag with href
  if (element.tagName === 'A' && (element.href || element.getAttribute('href'))) {
    const original = getOriginalUrl(element);
    if (original) return original;
    try {
      const url = new URL(element.href, window.location.href);
      return isNavigationUrl(url.href) ? url.href : null;
    } catch (e) {
      return isNavigationUrl(element.href) ? element.href : null;
    }
  }

  // Method 2: Check for href in closest <a> tag
  const link = element.closest('a[href]');
  if (link && (link.href || link.getAttribute('href'))) {
    if (!isVisibleForUrlScan(link)) return null;
    const original = getOriginalUrl(link);
    if (original) return original;
    try {
      const url = new URL(link.href, window.location.href);
      return isNavigationUrl(url.href) ? url.href : null;
    } catch (e) {
      return isNavigationUrl(link.href) ? link.href : null;
    }
  }
  
  // Method 3: Check for data attributes that might contain URLs
  const dataUrl = element.getAttribute('data-url') || 
                  element.getAttribute('data-href') ||
                  element.getAttribute('data-link');
  if (dataUrl) {
    try {
      const url = new URL(dataUrl, window.location.href);
      return isNavigationUrl(url.href) ? url.href : null;
    } catch (e) {
      // If not a full URL, might be relative
      if (dataUrl.startsWith('/') || dataUrl.startsWith('./') || dataUrl.startsWith('../')) {
        try {
          const url = new URL(dataUrl, window.location.href);
          return isNavigationUrl(url.href) ? url.href : null;
        } catch (e2) {
          return null;
        }
      }
      return null;
    }
  }
  
  // Method 4: Check for click handlers that might navigate
  // Look for onclick attribute or event listeners
  const onclick = element.getAttribute('onclick');
  if (onclick) {
    // Try to extract URL from common patterns like window.location, window.open, etc.
    const urlPatterns = [
      /window\.location\s*=\s*['"]([^'"]+)['"]/,
      /window\.open\s*\(\s*['"]([^'"]+)['"]/,
      /location\.href\s*=\s*['"]([^'"]+)['"]/,
      /href\s*=\s*['"]([^'"]+)['"]/,
    ];
    
    for (const pattern of urlPatterns) {
      const match = onclick.match(pattern);
      if (match && match[1]) {
        try {
          const url = new URL(match[1], window.location.href);
          if (isNavigationUrl(url.href)) return url.href;
        } catch (e) {
          // Try as relative URL
          if (match[1].startsWith('/') || match[1].startsWith('./') || match[1].startsWith('../')) {
            try {
              const url = new URL(match[1], window.location.href);
              if (isNavigationUrl(url.href)) return url.href;
            } catch (e2) {
              // Ignore
            }
          }
        }
      }
    }
  }

  // Method 5: Check for role="link" with aria-label or data attributes
  if (element.getAttribute('role') === 'link') {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && (ariaLabel.startsWith('http://') || ariaLabel.startsWith('https://'))) {
      try {
        const url = new URL(ariaLabel);
        return isNavigationUrl(url.href) ? url.href : null;
      } catch (e) {
        // Ignore
      }
    }
  }
  
  // Method 6: Check if element is an image or inside a clickable container that navigates
  // Universal approach: check parent elements for click handlers that change URL
  const img = element.tagName === 'IMG' ? element : element.closest('img');
  if (img) {
    // Check parent elements for click handlers or data attributes
    let current = img.parentElement;
    let depth = 0;
    const maxDepth = 5; // Limit search depth
    
    while (current && depth < maxDepth) {
      if (!isVisibleForUrlScan(current)) {
        current = current.parentElement;
        depth++;
        continue;
      }
      // Check for onclick on parent
      const parentOnclick = current.getAttribute('onclick');
      if (parentOnclick) {
        // Try to extract URL from onclick - universal patterns
        const urlPatterns = [
          /window\.location\s*=\s*['"]([^'"]+)['"]/,
          /window\.open\s*\(\s*['"]([^'"]+)['"]/,
          /location\.href\s*=\s*['"]([^'"]+)['"]/,
          /location\.hash\s*=\s*['"]([^'"]+)['"]/,
          /#([^'"]+)/, // Hash fragment pattern
        ];
        
        for (const pattern of urlPatterns) {
          const match = parentOnclick.match(pattern);
          if (match && match[1]) {
            try {
              // If it's a hash fragment, append to current URL
              if (match[1].startsWith('#')) {
                const url = new URL(window.location.href);
                url.hash = match[1].substring(1);
                return url.href;
              } else if (match[0].includes('hash')) {
                // location.hash = "..."
                const url = new URL(window.location.href);
                url.hash = match[1];
                return url.href;
              } else {
                // Full URL (skip image URLs)
                const url = new URL(match[1], window.location.href);
                if (isNavigationUrl(url.href)) return url.href;
              }
            } catch (e) {
              // If it's a hash fragment, try appending to current URL
              if (match[1] && !match[1].startsWith('http')) {
                try {
                  const url = new URL(window.location.href);
                  url.hash = match[1];
                  return url.href;
                } catch (e2) {
                  // Ignore
                }
              }
            }
          }
        }
      }
      
      // Check for data attributes on parent (universal)
      const parentDataUrl = current.getAttribute('data-url') || 
                           current.getAttribute('data-href') ||
                           current.getAttribute('data-link') ||
                           current.getAttribute('data-img-id') ||
                           current.getAttribute('data-image-id') ||
                           current.getAttribute('data-ved') || // Google image search
                           current.getAttribute('data-id');
      if (parentDataUrl) {
        // If it looks like a hash fragment (starts with # or contains common hash patterns)
        if (parentDataUrl.startsWith('#') || 
            parentDataUrl.includes('imgId') || 
            parentDataUrl.includes('ved=') ||
            parentDataUrl.includes('id=')) {
          try {
            const url = new URL(window.location.href);
            url.hash = parentDataUrl.startsWith('#') ? parentDataUrl.substring(1) : parentDataUrl;
            return url.href;
          } catch (e) {
            // Ignore
          }
        } else {
          // Try as full URL (skip image URLs)
          try {
            const url = new URL(parentDataUrl, window.location.href);
            if (isNavigationUrl(url.href)) return url.href;
          } catch (e) {
            // Ignore
          }
        }
      }

      // Check if parent is a link (skip image hrefs)
      if (current.tagName === 'A' && current.href) {
        try {
          const url = new URL(current.href, window.location.href);
          if (isNavigationUrl(url.href)) return url.href;
        } catch (e) {
          if (isNavigationUrl(current.href)) return current.href;
        }
      }
      
      // Universal: Check for clickable elements that might navigate
      // If parent has onclick or is clickable, try to construct URL from current page + hash
      // This handles cases like image search pages where clicking adds hash
      if (current.onclick !== null || 
          current.getAttribute('role') === 'button' || 
          current.getAttribute('role') === 'link' ||
          current.classList.contains('clickable') ||
          current.classList.contains('image-link')) {
        
        // Try to extract identifier from data attributes to construct hash
        const identifier = current.getAttribute('data-id') ||
                          current.getAttribute('data-img-id') ||
                          current.getAttribute('data-image-id') ||
                          current.getAttribute('data-ved') ||
                          (img && img.getAttribute('data-image-viewer-img-id')) ||
                          (img && img.getAttribute('data-id'));
        
        if (identifier) {
          try {
            // Construct URL with hash fragment
            // Try common patterns: #id=..., #imgId=..., #ved=...
            const url = new URL(window.location.href);
            // Try different hash formats
            if (identifier.includes('imgId') || identifier.includes('image')) {
              url.hash = `imgId=${encodeURIComponent(identifier)}`;
            } else if (identifier.includes('ved')) {
              url.hash = `ved=${encodeURIComponent(identifier)}`;
            } else {
              // Generic: use id= or just the identifier
              url.hash = `id=${encodeURIComponent(identifier)}`;
            }
            return url.href;
          } catch (e) {
            // Ignore
          }
        }
      }
      
      current = current.parentElement;
      depth++;
    }
  }
  
  return null;
}

/**
 * URLResolver Module
 * Resolves redirect URLs to their final destination with caching and timeout
 */
export class URLResolver {
  constructor() {
    // Cache for resolved URLs to prevent redundant network requests
    this.cache = new Map();
    // Track pending requests to avoid duplicate fetches
    this.pendingRequests = new Map();
    // Timeout for URL resolution (6000ms - increased to allow background worker more time)
    // Note: Background worker has its own 5s timeout, this is just for the content script timeout
    this.TIMEOUT_MS = 6000;
    // Cache expiration time (30 minutes - redirects are more stable than metadata)
    this.CACHE_EXPIRY_MS = 30 * 60 * 1000;
  }

  /**
   * Resolve redirect URL to final destination
   * Uses background worker to avoid CORS issues
   * 
   * @param {string} url - The URL to resolve
   * @returns {Promise<string>} - The resolved URL (or original if resolution fails)
   */
  async resolveRedirect(url) {
    const startTime = Date.now();
    
    if (!url || typeof url !== 'string') {
      return url;
    }

    // Normalize URL for caching (remove fragments)
    const normalizedUrl = this._normalizeUrl(url);

    // Check cache first
    const cached = this.cache.get(normalizedUrl);
    if (cached) {
      // Check if cache is still valid
      if (Date.now() - cached.timestamp < this.CACHE_EXPIRY_MS) {
        return cached.resolvedUrl;
      } else {
        // Cache expired, remove it
        this.cache.delete(normalizedUrl);
      }
    }

    // Check if there's already a pending request for this URL
    if (this.pendingRequests.has(normalizedUrl)) {
      return this.pendingRequests.get(normalizedUrl);
    }


    // Create a new resolve promise
    const resolvePromise = this._resolveRedirectFromBackground(normalizedUrl)
      .then((resolvedUrl) => {
        const elapsedTime = Date.now() - startTime;
        
        // Cache the result
        this.cache.set(normalizedUrl, {
          resolvedUrl: resolvedUrl,
          timestamp: Date.now()
        });
        // Remove from pending requests
        this.pendingRequests.delete(normalizedUrl);
        return resolvedUrl;
      })
      .catch((error) => {
        const elapsedTime = Date.now() - startTime;
        // Remove from pending requests on error
        this.pendingRequests.delete(normalizedUrl);
        // Return original URL on error
        return normalizedUrl;
      });

    // Store pending request
    this.pendingRequests.set(normalizedUrl, resolvePromise);

    return resolvePromise;
  }

  /**
   * Resolve redirect via background worker
   * 
   * @param {string} url - The URL to resolve
   * @returns {Promise<string>} - The resolved URL
   */
  async _resolveRedirectFromBackground(url) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      // Set timeout (content script timeout, background has its own 5s timeout)
      const timeoutId = setTimeout(() => {
        const elapsedTime = Date.now() - startTime;
        resolve(url); // Return original URL on timeout
      }, this.TIMEOUT_MS);

      // Send message to background worker
      chrome.runtime.sendMessage(
        {
          action: 'resolve-redirect',
          url: url
        },
        (response) => {
          const elapsedTime = Date.now() - startTime;
          clearTimeout(timeoutId);
          
          if (chrome.runtime.lastError) {
            resolve(url); // Return original URL on error
            return;
          }

          if (response && response.success && response.resolvedUrl) {
            resolve(response.resolvedUrl);
          } else {
            // Resolution failed, return original URL
            resolve(url);
          }
        }
      );
    });
  }

  /**
   * Normalize URL for caching
   * Removes fragments and normalizes protocol
   * 
   * @param {string} url - The URL to normalize
   * @returns {string} - Normalized URL
   */
  _normalizeUrl(url) {
    try {
      const urlObj = new URL(url);
      // Remove fragment
      urlObj.hash = '';
      return urlObj.toString();
    } catch (e) {
      // If URL parsing fails, return as-is
      return url;
    }
  }

  /**
   * Clear expired cache entries
   */
  clearExpiredCache() {
    const now = Date.now();
    for (const [url, data] of this.cache.entries()) {
      if (now - data.timestamp >= this.CACHE_EXPIRY_MS) {
        this.cache.delete(url);
      }
    }
  }
}

// Initialize URLResolver instance
export const urlResolver = new URLResolver();

// Periodically clean up expired cache entries (every 10 minutes)
setInterval(() => {
  urlResolver.clearExpiredCache();
}, 10 * 60 * 1000);

/**
 * Extract and resolve URL from navigable element
 * Wrapper that extracts URL and resolves redirects
 * 
 * @param {HTMLElement} element - The element to check
 * @param {HTMLElement} container - Optional container to search within first
 * @returns {Promise<string|null>} - The resolved URL if found, null otherwise
 */
export async function extractAndResolveUrl(element, container = null) {
  
  // First extract the URL
  const url = extractUrlFromNavigableElement(element, container);
  
  if (!url) {
    return null;
  }

  // Resolve redirects
  try {
    const resolvedUrl = await urlResolver.resolveRedirect(url);
    return resolvedUrl;
  } catch (error) {
    return url; // Return original URL on error
  }
}
