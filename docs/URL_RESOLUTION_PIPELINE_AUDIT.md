# Comprehensive Audit: Universal URL Resolution Pipeline

**Date:** February 14, 2025  
**Scope:** End-to-end URL resolution mechanism in the browser extension

---

## Executive Summary

The URL resolution pipeline uses **both static parsing and dynamic network resolution**. The background script performs a real network hop for **any domain** (no whitelist). However, several **hardcoded bottlenecks** limit domain-agnostic behavior: `isBlindRedirector` relies on a fixed host list, `getOriginalUrl` only applies static parsing when path patterns match, and the sync path can produce false `__isMenuTab` rejections when the cache is cold for blind redirectors.

---

## 1. Static vs. Dynamic Resolution

### How the System Determines Final Destination

| Layer | Mechanism | When Used |
|-------|-----------|-----------|
| **Static Parsing** | `parseRedirectParams()` extracts `u`, `url`, `dest`, `target`, `to`, `destination`, `link` from query params | During **URL extraction** in `getOriginalUrl()` when `REDIRECT_PATH_PATTERNS` match |
| **Dynamic Resolution** | `fetch(url, { redirect: 'follow' })` in background script | When `resolveCached()` misses and `urlResolver.resolveRedirect()` is called |

### Static Parsing Flow

- **Location:** `urlResolver.js` → `getOriginalUrl()` → `parseRedirectParams()`
- **Trigger:** Only when `href` matches `REDIRECT_PATH_PATTERNS`:
  - `/p/crd/rd`, `/url?`, `/redirect?`, `/link?`, `/out?`, `/go?`
- **Keys checked:** `u`, `url`, `dest`, `target`, `to`, `destination`, `link`
- **Result:** Returns decoded destination URL if found; otherwise falls through to raw `href`

```javascript
// urlResolver.js:169-176
const REDIRECT_PATH_PATTERNS = [
  /\/p\/crd\/rd/i, /\/url\?/i, /\/redirect\?/i, /\/link\?/i, /\/out\?/i, /\/go\?/i,
];
```

**Limitation:** If a tracking URL has a path like `/click` or `/ad` (no `/url?` etc.), static parsing is **never attempted**—even if `?url=` exists in the query string.

### Dynamic Resolution Flow

- **Location:** `urlResolver.js` → `resolve()` → `urlResolver.resolveRedirect()` → `background.js` → `resolveRedirect()`
- **Mechanism:** `fetch(url, { method: 'GET', redirect: 'follow' })`—follows 301/302/307
- **Scope:** **Any URL**—no domain whitelist in the background
- **Fallback:** On timeout (5s), CORS, or network error, returns original URL

```javascript
// background.js:25-32
const response = await fetch(url, {
  method: 'GET',
  signal: controller.signal,
  redirect: 'follow',
  headers: { 'User-Agent': '...' }
});
const finalUrl = response.url;  // Final URL after redirects
```

---

## 2. urlResolver ↔ background.js Relationship

### Message Flow

```
Content Script (urlResolver.js)
    │
    │  resolve(rawURL)
    │    → resolveCached() [sync, cache-only]
    │    → if miss: urlResolver.resolveRedirect(preClean)
    │
    ▼
URLResolver.resolveRedirect(url)
    │
    │  chrome.runtime.sendMessage({ action: 'resolve-redirect', url })
    │
    ▼
Background Script (background.js)
    │
    │  resolveRedirect(url) → fetch(url, { redirect: 'follow' })
    │  → response.url (final URL after redirects)
    │
    ▼
sendResponse({ success: true, resolvedUrl })
    │
    ▼
Content Script caches result, returns to caller
```

### Domain Coverage

- **Background `resolveRedirect()`:** Performs a real network hop for **every** URL passed to it.
- **No whitelist:** There is no domain check before calling `fetch`.
- **CORS:** Background has broader permissions; CORS does not block the request.

---

## 3. Cache Strategy & Timing

### How `resolveCached` Is Populated

| Source | Mechanism |
|--------|-----------|
| `urlResolver.resolveRedirect()` | After `_resolveRedirectFromBackground()` returns, result is stored in `urlResolver.cache` |
| Key | `urlResolver._normalizeUrl(preClean)` (fragment-free, cleaned URL) |
| TTL | 30 minutes (`CACHE_EXPIRY_MS`) |
| Cleanup | `clearExpiredCache()` every 10 minutes |

### Sync Path & Cold Cache

In the **sync path** (e.g., `resolveHoverAndItemRootSync`), network requests are not possible. The flow is:

```javascript
// hoverDetector.js:2482-2485
const syncFinalResolvedUrl = activeHoverUrl
  ? (resolveCached(activeHoverUrl, { baseUrl: window.location.href }) || activeHoverUrl)
  : null;
if (finalItemEl && syncFinalResolvedUrl && __isMenuTab(finalItemEl, syncFinalResolvedUrl)) {
  return { passed: false, reason: 'menu-tab', ... };
}
```

**Cold cache behavior:**

1. `resolveCached(activeHoverUrl)` returns `null`.
2. `syncFinalResolvedUrl = activeHoverUrl` (raw URL).
3. `__isMenuTab(container, rawUrl)` is called with the **unresolved** URL.

For blind redirectors (e.g., `https://ader.naver.com/...`), the raw URL’s base domain may match the current page (e.g., `naver.com`), so `__isMenuTab` can **incorrectly reject** a valid content link that would resolve to an external domain.

### Cache Warming

Cache warming exists for blind redirectors in `__blinkResolveRescueDominantUrl`:

```javascript
// hoverDetector.js:494-496
if (out && isBlindRedirector(href) && !resolveCached(href, { baseUrl: window.location.href })) {
  resolve(href, { baseUrl: window.location.href }).catch(() => {});
}
```

- **When:** During dominant URL resolution when a DISCOVERY intent URL is found.
- **Effect:** Fire-and-forget `resolve()` to warm the cache for the next hover.
- **Gap:** First hover on a blind redirector still sees a cold cache; warming only helps subsequent hovers.

---

## 4. Handling "Blind" Redirectors Globally

### `isBlindRedirector` Implementation

**Location:** `urlResolver.js:154-165`

```javascript
const BLIND_REDIRECTOR_HOSTS = [
  'ader.naver.com', 'ad.naver.com', 'nid.naver.com',
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'adservice.google.com', 't.co', 'bit.ly', 'tinyurl.com', 'ow.ly',
  'buff.ly', 'ad.doubleclick.net', 'clickserve.dartsearch.net',
];

const BLIND_REDIRECTOR_PREFIXES = ['tracking.', 'redirect.', 'adclick.', 'ad-track.'];
```

**Logic:**

- Hostname must be in `BLIND_REDIRECTOR_HOSTS` or start with a `BLIND_REDIRECTOR_PREFIXES` entry.
- No path-based heuristics.
- No query-param heuristics (e.g., presence of `?url=` without path match).
- No generic “redirect-likely” heuristics (e.g., short paths, high-entropy tokens).

### Gaps

1. **Hardcoded hosts:** New ad/tracking domains require code changes.
2. **No path heuristics:** Paths like `/r/`, `/l/`, `/go/` are not considered.
3. **No query heuristics:** URLs with `?url=` but non-matching paths are not treated as blind redirectors.
4. **No structural heuristics:** `containerExtractor.js` has `isRedirectorLikeUrl()` (param count, long query, entropy segments) but it is not used by `isBlindRedirector`.

---

## 5. Impact on `__isMenuTab`

### Design Intent

`__isMenuTab` is meant to reject elements that are menu/tab links (same base domain, high visual dominance). It expects a **resolved** URL so that redirect wrappers do not cause false rejections.

### Resolution Priority

```javascript
// hoverDetector.js:481-484
const resolved = (preResolved && preResolved.get && preResolved.get(href))
  || resolveCached(href, { baseUrl: window.location.href })
  || href;
```

Order: `preResolved` (async path) → `resolveCached` → raw `href`.

### Pending Resolution (Async Path)

In the **async path** (`resolveHoverAndItemRoot`), `__blinkBuildPreResolvedMap` pre-resolves URLs before Main-Process, so `preResolved` is populated and `__isMenuTab` receives resolved URLs when available.

### Cold Cache (Sync Path)

In the **sync path**, when `resolveCached` misses:

- `syncFinalResolvedUrl = activeHoverUrl` (raw).
- `__isMenuTab(finalItemEl, rawUrl)` runs with the raw URL.

**Risk:** For `https://ader.naver.com/...` on `blog.naver.com`:

- Raw URL base domain: `ader.naver.com` → base `naver.com`.
- Current page base: `naver.com`.
- `__isMenuTab` sees same base domain and can reject.
- Resolved URL might be `https://example.com/article` (external), which would pass.

**Mitigation today:** Cache warming on first discovery of a blind redirector helps the next hover, but the first hover remains vulnerable.

---

## 6. Sequence Diagram: Universal URL Resolver

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  HoverDetector  │     │   urlResolver.js  │     │  background.js  │
│  / containerEx  │     │                   │     │                 │
└────────┬────────┘     └─────────┬──────────┘     └────────┬────────┘
         │                       │                         │
         │ resolve(href)         │                         │
         │──────────────────────>│                         │
         │                       │                         │
         │                       │ resolveCached(href)     │
         │                       │ ──[HIT]──> return cached│
         │                       │                         │
         │                       │ ──[MISS]──>             │
         │                       │ resolveRedirect(href)   │
         │                       │─────────────────────────>│
         │                       │                         │ fetch(url, redirect:'follow')
         │                       │                         │
         │                       │<─────────────────────────│ response.url
         │                       │                         │
         │                       │ cache.set(key, result)  │
         │<──────────────────────│                         │
         │ resolvedUrl           │                         │
         │                       │                         │
         │ __isMenuTab(container, resolvedUrl)              │
         │                       │                         │
```

---

## 7. Hardcoded Bottlenecks

| Location | Bottleneck | Impact |
|----------|------------|--------|
| `urlResolver.js:128-144` | `BLIND_REDIRECTOR_HOSTS` | New ad/tracking domains need code changes |
| `urlResolver.js:145` | `BLIND_REDIRECTOR_PREFIXES` | Limited to 4 prefixes |
| `urlResolver.js:169-176` | `REDIRECT_PATH_PATTERNS` | Static parsing only for specific paths |
| `getOriginalUrl()` | `parseRedirectParams` only when path matches | `?url=` on non-matching paths is ignored |
| `isBlindRedirector()` | Host + prefix only | No path/query heuristics |

---

## 8. Recommendations for Domain-Agnostic Resolution

### 1. Broaden Static Parsing

- Run `parseRedirectParams()` for **any** URL with `?url=`, `?u=`, etc., not only when path matches `REDIRECT_PATH_PATTERNS`.
- Use static extraction as a fast path before network resolution.

### 2. Heuristic `isBlindRedirector`

- Add path-based checks: `/r/`, `/l/`, `/go/`, `/out`, `/redirect`, `/link`, etc.
- Add query-based checks: presence of `url`, `u`, `dest`, `target`, `to` with URL-like values.
- Reuse or integrate `isRedirectorLikeUrl()` from `containerExtractor.js` (param count, long query, entropy).
- Optionally use a small allowlist of “known content” patterns instead of only a blocklist.

### 3. Sync Path and Cold Cache

- **Option A:** For URLs that look like blind redirectors, defer `__isMenuTab` rejection until resolution is available (e.g., short async wait or retry).
- **Option B:** When `resolveCached` misses and `isBlindRedirector(href)` is true, treat as “unknown” and do not reject on menu-tab; only reject when resolved URL is same-domain.
- **Option C:** Proactively warm cache when a blind redirector is detected in the DOM (e.g., on page load or when container is first seen).

### 4. Centralize Redirect Detection

- Introduce a shared `isRedirectLikeUrl(url)` that combines:
  - Host blocklist
  - Host prefix blocklist
  - Path patterns
  - Query param patterns
  - Structural heuristics (param count, entropy)
- Use it in both `getOriginalUrl`, `isBlindRedirector`, and cache-warming logic.

### 5. Configurable Blocklist

- Move `BLIND_REDIRECTOR_HOSTS` and `BLIND_REDIRECTOR_PREFIXES` to a config (e.g., JSON or remote) so new domains can be added without code changes.

---

## Appendix: Key File References

| File | Relevant Symbols |
|------|------------------|
| `browser-extension/chromium/urlResolver.js` | `resolve`, `resolveCached`, `isBlindRedirector`, `parseRedirectParams`, `getOriginalUrl`, `URLResolver`, `REDIRECT_PATH_PATTERNS`, `BLIND_REDIRECTOR_HOSTS` |
| `browser-extension/chromium/background.js` | `resolveRedirect`, `resolve-redirect` message handler |
| `browser-extension/chromium/hoverDetector.js` | `__isMenuTab`, `__blinkResolveRescueDominantUrl`, `__blinkResolveHrefCached`, `__blinkBuildPreResolvedMap` |
| `browser-extension/chromium/containerExtractor.js` | `getDetailedIdSync`, `resolveCached`, `isRedirectorLikeUrl`, `mineDestinationUrlFrom` |
