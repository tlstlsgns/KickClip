# Data Flow Audit: Original URL Extraction ↔ Universal URL Resolver

**Date:** February 14, 2025  
**Scope:** Integration between smart extraction and resolution pipeline

---

## 1. Source of Input for `resolve()` / `resolveForDecision()`

### Where the URL Comes From

| Call Site | URL Source | Uses getOriginalUrl? |
|-----------|------------|----------------------|
| `__blinkResolveRescueDominantUrl` | `getOriginalUrl(a) \|\| a.getAttribute('href')` | ✅ Yes (primary) |
| `__blinkBuildPreResolvedMap` | `getOriginalUrl(a) \|\| a.getAttribute('href')` | ✅ Yes |
| `findNearbyDiscoverySource` | `getHrefFromAnchor(a)` → `getOriginalUrl(a) \|\| raw` | ✅ Yes |
| `findNearestDiscoveryAnchorInScope` | `getHrefFromAnchor(a)` | ✅ Yes |
| `collectDiscoveryIdsIn` | `getHrefFromAnchor(a)` | ✅ Yes |
| `countDiscoveryHostsIn` | `getOriginalUrl(a) \|\| a.getAttribute('href')` | ✅ Yes |
| `main.js` tooltip/save | `extractUrlFromNavigableElement(e.target, itemRootContainer)` | ✅ Yes (via extractUrl) |

**Conclusion:** The resolution pipeline receives URLs that are **primarily** from `getOriginalUrl()` (or `extractUrlFromNavigableElement` which uses it). Raw `anchor.getAttribute('href')` is only used as fallback when `getOriginalUrl` returns null.

---

## 2. Integration Audit: activeHoverUrl and dominantUrl

### Assignment Flow

- **dominantUrl** comes from:
  - `pickDominantDiscoveryUrl()` → `collectDiscoveryIdsIn()` → `getHrefFromAnchor(a)` → **getOriginalUrl**
  - `__blinkResolveRescueDominantUrl()` → **getOriginalUrl(a) || href**
  - `res1.dominantUrl` / `retryRes.dominantUrl` from `findItemRootContainer` (same chain)

- **activeHoverUrl** comes from:
  - `finalDominant` or `mainDominant` (from above)
  - `extractUrlFromNavigableElement(e.target, itemRootContainer)` in main.js for tooltip/save

### Comprehensive Attribute Data

- **getOriginalUrl** now checks:
  1. Custom attributes: `cru`, `data-url`, `data-u`, `data-href`, `origin-url`
  2. **onclick** (new): extracts `u=`, `url=`, `dest=` from onclick strings (e.g. `goOtherCR(..., 'u=https://hanssem.com')`)
  3. **parseRedirectParams** for any URL with `?url=`, `?u=`, `?dest=`, etc. (not only when path matches)
  4. Raw href as fallback

- **extractUrlFromNavigableElement** (used when target is not an anchor):
  - `getOriginalUrl` for anchors
  - `data-url`, `data-href`, `data-link` on element
  - **onclick** patterns: `window.location`, `window.open`, `location.href`
  - Parent onclick for images
  - `findBestUrlInContainer` when element is IMG

- **findNearbyDiscoverySource** (new step 0): When target is not inside an anchor (e.g. div with onclick), uses `extractUrlFromNavigableElement(targetEl)` as primary candidate.

---

## 3. Heuristic Pre-processing vs. Network Fetch

### Before This Audit

- **getOriginalUrl** only called `parseRedirectParams` when path matched `REDIRECT_PATH_PATTERNS` (`/url?`, `/redirect?`, etc.)
- **resolve()** did not attempt static extraction before network fetch
- URLs like `https://ader.naver.com/xyz?url=https://hanssem.com` would trigger a network hop even though the destination was in the string

### After Refactor

1. **getOriginalUrl** now tries `parseRedirectParams` for **any** URL that has redirect params (`?url=`, `?u=`, `?dest=`, etc.), regardless of path.

2. **resolve()** now runs `tryStaticExtract()` **before** sending to background:
   - If `parseRedirectParams` returns a destination, it is used immediately
   - No network hop
   - Result is cached for future `resolveCached` hits

3. **tryStaticExtract** is exported for reuse and runs the same `parseRedirectParams` logic.

---

## 4. Consistency in Logs

### getUrlStateLabel() Labels

| Label | Meaning |
|-------|---------|
| `[Raw Href]` | The actual `href` attribute value, no extraction applied |
| `[Extracted URL]` | URL from attribute/parameter analysis (pass `source: 'extracted'`) |
| `[Resolving...]` | Network request in flight |
| `[Network Resolved: domain.com]` | Final URL after background fetch (or from cache) |

### Optional `source` Parameter

```javascript
getUrlStateLabel(url, resolvedUrl, { source: 'raw' });      // → [Raw Href]
getUrlStateLabel(url, resolvedUrl, { source: 'extracted' }); // → [Extracted URL]
getUrlStateLabel(url, resolvedUrl, { source: 'network' });   // → [Network Resolved]
```

When `source` is omitted, the label is inferred from cache/pending state.

---

## 5. Summary of Changes

| Change | File | Description |
|--------|------|-------------|
| Broaden parseRedirectParams | urlResolver.js | getOriginalUrl tries extraction for any URL with `?url=`, `?u=`, etc. |
| onclick extraction | urlResolver.js | getOriginalUrl parses onclick for `u=`, `url=`, `dest=` patterns |
| tryStaticExtract | urlResolver.js | New export; parseRedirectParams before network |
| resolve() static pre-check | urlResolver.js | tryStaticExtract before urlResolver.resolveRedirect; cache result |
| getUrlStateLabel | urlResolver.js | Added `[Raw Href]`, `[Extracted URL]`, `[Network Resolved]` |
| findNearbyDiscoverySource | containerExtractor.js | Step 0: extractUrlFromNavigableElement when target not in anchor |
| extractUrlFromNavigableElement import | containerExtractor.js | For non-anchor targets (div with onclick, etc.) |

---

## 6. Data Flow Diagram

```
User hovers on element
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ findNearbyDiscoverySource / findItemRootContainer              │
│   - Target in anchor? → getHrefFromAnchor → getOriginalUrl     │
│   - Target not in anchor? → extractUrlFromNavigableElement     │
│     (onclick, data-url, findBestUrlInContainer)                │
└───────────────────────────────────────────────────────────────┘
        │
        │ href = getOriginalUrl result (attrs, onclick, ?url=) or raw
        ▼
┌───────────────────────────────────────────────────────────────┐
│ resolve(href) / resolveForDecision(href)                       │
│   1. resolveCached(href) → return if hit                       │
│   2. tryStaticExtract(href) → return if ?url=/?u= found         │
│   3. urlResolver.resolveRedirect(href) → background fetch     │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
resolvedUrl → __isMenuTab, getUrlIntent, activeHoverUrl, etc.
```
