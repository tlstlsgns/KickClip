# Audit Report: `getOriginalUrl` as Entry Point for Discovery URL Types

**Date:** February 14, 2025  
**Scope:** Verification that `getOriginalUrl` (Smart Extraction) is the mandatory entry point for `nearbyUrl`, `otherUrl`, `dominantUrl`, and `activeHoverUrl` before resolution or decision logic.

---

## 1. Flow Report: `getOriginalUrl` as Source of Truth

### Summary Table

| URL Variable | Primary Source | Uses getOriginalUrl? | Resolution Input |
|--------------|----------------|---------------------|------------------|
| **nearbyUrl** | findNearbyDiscoverySource → getHrefFromAnchor | ✅ Yes | Extracted href → resolveCached |
| **nearbyHref** | Same as nearbyUrl (raw for lookup) | ✅ Yes | Used for preResolved key |
| **dominantUrl** | pickDominantDiscoveryUrl → collectDiscoveryIdsIn → getHrefFromAnchor | ✅ Yes | Extracted href → resolve |
| **activeHoverUrl** | finalDominant / mainDominant / Phase A/B extraction | ⚠️ Mixed (see §2) | Extracted → resolveForDecision |
| **otherUrl** | Not a first-class variable; used in branching scan | Via getHrefFromAnchor | ✅ Yes |

### Core Extraction Chain (Correct)

```
Phase A/B Discovery
    │
    ├─ findNearbyDiscoverySource(targetEl)
    │     ├─ Step 0: extractUrlFromNavigableElement(targetEl)  [when target not in anchor]
    │     │     └─ getOriginalUrl(link) for anchors
    │     └─ Step 1: getHrefFromAnchor(directA)
    │           └─ getOriginalUrl(a) || raw
    │
    ├─ findItemRootContainer → finalize(nearbyId, nearbyHref)
    │     └─ nearbyId = isDiscoveryHref(href).id  [href from getHrefFromAnchor]
    │
    ├─ pickDominantDiscoveryUrl → collectDiscoveryIdsIn
    │     └─ getHrefFromAnchor(a) → getOriginalUrl(a)
    │
    └─ __blinkResolveRescueDominantUrl
          └─ getOriginalUrl(a) || a.getAttribute('href')
```

### Resolution Pipeline Triggering

| Step | Input | Output |
|------|-------|--------|
| **resolve()** | Extracted URL (from getOriginalUrl chain) | Resolved destination (cache or network) |
| **resolveForDecision()** | activeHoverUrl (extracted) | Resolved URL for __isMenuTab |
| **resolveCached()** | Extracted URL | Cached resolved or null |

**Confirmation:** The Universal URL Resolution (background fetch / cache) operates on the **output of getOriginalUrl**. Static extraction in `getOriginalUrl` (e.g. `parseRedirectParams`, onclick parsing) runs before any network resolution, so the system does not waste resources resolving a raw tracking URL that was already statically parsed.

---

## 2. Data Integrity: `activeHoverUrl` Lifecycle

### Assignment Paths

| Path | Source | getOriginalUrl? |
|------|--------|-----------------|
| Phase B Main / Sync-Final | finalDominant ← __blinkResolveRescueDominantUrl or Phase B Override | ✅ |
| Phase B Rescue | dominantUrl ← __blinkResolveRescueDominantUrl | ✅ |
| Phase A (Instagram) | extractActiveHoverUrlFromInstagramFinalItem → extractInstagramPostUrl | ⚠️ See §4 |
| Phase A (Facebook) | extractActiveHoverUrlFromFacebookFinalItem | ❌ **LEAK** |
| Sync-Final / Async-Final | finalCandidate.dominant \|\| nearbyUrl (from findItemRootContainer) | ✅ |
| Click-path fallback | __blinkResolveNearbyUrlClickPath → __blinkFindCandidateAnchorUrl | ✅ |

### `__isMenuTab` Input

- **Sync:** `syncFinalResolvedUrl = resolveCached(activeHoverUrl) || activeHoverUrl`
- **Async:** `asyncFinalResolvedUrl = resolveForDecision(activeHoverUrl) || resolveCached(activeHoverUrl) || activeHoverUrl`

**Confirmation:** `__isMenuTab` uses the **fully resolved** version of the extracted URL when resolution is available. When the cache is cold, it falls back to the extracted URL (not raw `anchor.href`).

---

## 3. Leaks: Raw `href` Bypassing getOriginalUrl

### High Impact (Feeds activeHoverUrl / nearbyUrl / dominantUrl)

| Location | Variable | Issue |
|----------|----------|-------|
| **extractActiveHoverUrlFromFacebookFinalItem** | activeHoverUrl (Phase A) | Uses `primary.getAttribute('href') \|\| primary.href` and `fallback.getAttribute('href') \|\| fallback.href` – no getOriginalUrl |
| **lineageHref** (gate anchor-parent) | gateHref | Uses `lineageAnchor.getAttribute('href') \|\| lineageAnchor.href` – gateHref can flow into downstream logic |

### Medium Impact (Domain counting / branching)

| Location | Variable | Issue |
|----------|----------|-------|
| **countDiscoveryHostsResolved** (async path) | Host counting | Uses `a.getAttribute('href') \|\| a.href` – can miscount hosts for tracking URLs |

### Lower Impact (SNS / iframe edge cases)

| Location | Variable | Issue |
|----------|----------|-------|
| **__blinkExtractInstagramUrlFromAnchors** | Instagram post URL | Uses `a.href` – Instagram post links are usually direct, low redirect risk |
| **__blinkExtractInstagramSponsoredUrl** | Sponsored ad URL | Uses `a.href` – Facebook ad redirect URLs |
| **extractDataFromIframe** | iframe anchor URL | Uses `a.getAttribute('href') \|\| a.href` for same-origin iframe anchors |

---

## 4. Resolution Chain Verification

### Correct Chaining

```
getOriginalUrl(anchor)  →  extracted URL
        ↓
resolve(extracted) / resolveCached(extracted) / resolveForDecision(extracted)
        ↓
resolved URL  →  __isMenuTab(container, resolvedUrl)
                 getUrlIntent(resolved, ...)
                 domain comparison
```

### urlResolver Input

- `resolve()` and `resolveForDecision()` receive the **extracted** URL from the getOriginalUrl chain.
- `tryStaticExtract()` inside `resolve()` runs on the same URL; if `getOriginalUrl` already unwrapped it, `tryStaticExtract` may find nothing additional but will not re-wrap it.

---

## 5. Recommendations

### Fix High-Impact Leaks

1. **extractActiveHoverUrlFromFacebookFinalItem**
   - Replace `primary.getAttribute('href') || primary.href` with `getOriginalUrl(primary) || primary.getAttribute('href') || primary.href`
   - Same for fallback anchor

2. **lineageHref** (gate anchor-parent)
   - Replace with `getOriginalUrl(lineageAnchor) || lineageAnchor.getAttribute('href') || lineageAnchor.href`

### Fix Medium-Impact Leaks

3. **countDiscoveryHostsResolved**
   - Use `getOriginalUrl(a) || a.getAttribute('href') || a.href` for consistency

### Optional (SNS / iframe)

4. **__blinkExtractInstagramUrlFromAnchors** – Add getOriginalUrl for consistency (Instagram links are often direct).
5. **__blinkExtractInstagramSponsoredUrl** – Add getOriginalUrl for ad redirect handling.
6. **extractDataFromIframe** – Use getOriginalUrl for iframe anchors when available (content script context).

---

## 6. Conclusion

| Criterion | Status |
|----------|--------|
| getOriginalUrl as entry point for nearbyUrl | ✅ Yes (via getHrefFromAnchor) |
| getOriginalUrl as entry point for dominantUrl | ✅ Yes (via getHrefFromAnchor, __blinkResolveRescueDominantUrl) |
| getOriginalUrl as entry point for activeHoverUrl | ⚠️ Mostly – Facebook Phase A leaks |
| Resolution pipeline uses extracted URL | ✅ Yes |
| __isMenuTab uses fully resolved URL | ✅ Yes (when cache/resolution available) |
| Raw href leaks | ⚠️ 6 identified (see §3) |

**Overall:** The main discovery paths (findNearbyDiscoverySource, findItemRootContainer, pickDominantDiscoveryUrl, __blinkResolveRescueDominantUrl, click-path) correctly use `getOriginalUrl` as the entry point. The resolution pipeline is chained to the output of extraction. The remaining leaks are in SNS-specific extractors (Facebook), gate lineage, async host counting, and iframe handling.
