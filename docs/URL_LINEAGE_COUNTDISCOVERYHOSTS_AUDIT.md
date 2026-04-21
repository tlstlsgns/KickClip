# Functional Audit: `lineageHref` and `countDiscoveryHostsResolved`

**Date:** February 14, 2025  
**Scope:** Exact roles, impact of raw `href` usage, and patch recommendations

---

## 1. `lineageHref` (Gate Anchor-Parent Logic)

### 1.1 Functional Definition

**`lineageHref`** is the `href` attribute of the nearest ancestor anchor (`lineageAnchor`) of the hovered element. It is computed when:

1. The hovered element is inside an `<a href>` (via `el.closest('a[href]')` or `findAnchorWithinDepth(el, 5)`)
2. The value is stored as `gateHref` in the gate result and passed through the pipeline

**Location:** `hoverDetector.js` lines 1992–2012, inside `__blinkRunEntryGate` (gate logic).

### 1.2 Purpose: Gatekeeping vs Contextual Labeling

| Role | Description |
|------|-------------|
| **Gatekeeping** | When `lineageAnchor` and `lineageHref` exist and `!isInvalidHref(lineageHref)`, the gate returns `{ passed: true, reason: 'anchor-parent', gateAnchor, gateHref }`. This **accepts** the element for processing without further checks (cursor style, semantic signals). |
| **Contextual Labeling** | `gateHref` is stored on the event (`e.__blinkGateHref`) and returned in the final result. It is used as a **fallback URL** when `__blinkResolvedHref` is not set. |

**Conclusion:** `lineageHref` is used for **both** gatekeeping (early pass) and contextual labeling (downstream fallback).

### 1.3 Downstream Usage

| Consumer | Usage |
|----------|-------|
| **main.js** `extractUrlFromNavigableElement` fallback | `(e.__blinkResolvedHref) \|\| (e.__blinkGateHref) \|\| extractUrlFromNavigableElement(...)` — used for tooltip/save URL when resolved href is not set |
| **findItemRootContainer** options | `gateHref` is passed but **not used** in the implementation |

### 1.4 Impact of Raw Tracking URL on Stage 1 Domain Identity

**Does `lineageHref` feed into the Stage 1 Domain Identity check in `__isMenuTab`?**

**No.** The Stage 1 (Condition A) check in `__isMenuTab` uses `resolvedUrl`, which comes from `resolveCached(activeHoverUrl)` or `resolveForDecision(activeHoverUrl)`. `activeHoverUrl` comes from `findItemRootContainer` (nearbyUrl, dominantUrl), not from `gateHref`.

**Flow when gate passes with anchor-parent:**

1. `gateTarget = gate.gateAnchor` (the lineage anchor)
2. `findItemRootContainer(gateTarget)` → `findNearbyDiscoverySource(gateTarget)` → `getHrefFromAnchor(gateAnchor)` → **extracted URL**
3. `activeHoverUrl` = result of that chain (uses `getOriginalUrl`)
4. `__isMenuTab(container, resolveCached(activeHoverUrl))` uses the resolved URL

So `lineageHref` does **not** cause false rejections in the Stage 1 domain check in `__isMenuTab`.

**But:** When the sync path returns quickly and the async resolution hasn’t run yet, or when the tooltip/save flow uses `gateHref` as a fallback, a raw tracking URL (e.g. `ader.naver.com`) would be:

- Shown in the tooltip
- Used for save

That is a **UX/accuracy** issue, not a Stage 1 rejection issue.

---

## 2. `countDiscoveryHostsResolved` (Async Stats/Logic)

### 2.1 Functional Definition

**`countDiscoveryHostsResolved`** is a closure inside the async resolve path that counts how many **unique hostnames** appear among discovery links in a container. It:

1. Iterates over `container.querySelectorAll('a[href]')`
2. For each anchor, uses `href = String(a.getAttribute('href') || a.href)` (raw)
3. Looks up `preResolvedMap.get(href)` for a resolved URL
4. Uses `idToUse = resolvedId || href` (resolved if available, else raw)
5. Counts unique hostnames from `idToUse` via `new URL(idToUse).hostname`
6. Returns `hosts.size` (0, 1, 2, …)

**Location:** `hoverDetector.js` lines 2920–2947 (async path only).

### 2.2 Contribution to Discovery Decision

| Usage | Logic |
|-------|--------|
| **finalOk** | `finalOk = !!(finalItem && countDiscoveryHostsResolved(finalItem, preResolvedMain, 36) <= 1)` |
| **finalItemVerification** | `finalItemVerification = finalOk ? 'Succeeded' : 'Failed'` |
| **highlighted** | `highlighted = finalOk ? finalItem : initialItem` |

**Purpose:** Domain diversity check. A single product card typically links to one destination (or same-domain). A menu/nav often links to many different hosts. If the container has **more than 1 host**, it is treated as “multi-host” and `finalItemVerification = 'Failed'`.

### 2.3 Domain Diversity vs Menu Verification

| Interpretation | Description |
|----------------|-------------|
| **Domain diversity** | Counts how many distinct hosts the container links to. |
| **Menu verification** | If `hosts.size > 1`, the container is treated as non–single-item (e.g. menu or mixed content). |

So it is both: it measures domain diversity and uses that to decide whether the container is “single-item” (≤1 host) or “multi-item” (>1 host).

### 2.4 PreResolved Map Key Mismatch

**`__blinkBuildPreResolvedMap`** builds the map with keys from **`getOriginalUrl(a) || raw`**:

```javascript
// hoverDetector.js:1740
const href = getOriginalUrl(a) || (a.getAttribute && ...) ? String(a.getAttribute('href') || a.href || '').trim() : '';
// ...
map.set(href, resolved);
```

**`countDiscoveryHostsResolved`** looks up with **raw** `href`:

```javascript
// hoverDetector.js:2930
const href = String(a.getAttribute('href') || a.href || '').trim();
const resolvedId = preResolvedMap.get(href) || null;
```

So when `getOriginalUrl` returns a different URL than the raw `href` (e.g. `?url=` extraction), the map keys differ. The lookup fails and `idToUse = href` (raw).

**Example (Naver SmartStore):**

- Anchor A: raw `https://ader.naver.com/...?url=https://hanssem.com/product`
- Anchor B: raw `https://cr.naver.com/...?url=https://hanssem.com/product`
- `getOriginalUrl` → `https://hanssem.com/product` for both
- PreResolved map keys: `https://hanssem.com/product` (and possibly raw variants if they were also collected)
- `countDiscoveryHostsResolved` uses raw hrefs → `preResolvedMap.get('https://ader.naver.com/...')` = `null`
- `idToUse` = raw for both → `hosts.add('ader.naver.com')`, `hosts.add('cr.naver.com')` → `hosts.size = 2`
- `finalOk = false`, `finalItemVerification = 'Failed'`

**Result:** A valid single-product card is wrongly rejected because multiple tracking hosts are counted instead of the single resolved destination.

### 2.5 Skewing the Dominant Host Calculation

- `countDiscoveryHostsResolved` does **not** compute the dominant host; it only checks whether the count is ≤1.
- `pickDominantDiscoveryUrl` (in `containerExtractor.js`) uses `getHrefFromAnchor` and thus `getOriginalUrl`; it is unaffected.
- The skew is in the **final-item verification** (`finalOk`), not in the dominant URL selection.

---

## 3. Impact Assessment

### 3.1 Expected Improvements if Patched

| Patch | Fix | Expected Improvement |
|-------|-----|----------------------|
| **lineageHref** → `getOriginalUrl(lineageAnchor) \|\| raw` | Use extracted URL for gateHref | Tooltip/save URLs show the destination instead of the tracking URL when `gateHref` is used as fallback. |
| **countDiscoveryHostsResolved** → `getOriginalUrl(a) \|\| raw` | Use extracted URL for lookup and host counting | PreResolved map keys align with lookup. Hosts are counted from resolved destinations. Fewer false rejections for multi-tracking single-product cards (Naver, Facebook Ads). |

### 3.2 Same-Domain Ad Scenarios (Naver/Facebook Ads)

**Naver SmartStore:**

- Card with `ader.naver.com`, `cr.naver.com` links all resolving to the same product.
- **Before:** `countDiscoveryHostsResolved` counts 2 hosts → `finalOk = false`, `finalItemVerification = 'Failed'`.
- **After:** Extracted URLs resolve to same host → 1 host → `finalOk = true`, `finalItemVerification = 'Succeeded'`.

**Facebook Ads:**

- Similar pattern with multiple tracking domains resolving to the same destination.
- Same improvement: single-host cards are treated as single-item correctly.

---

## 4. Recommendations

### 4.1 lineageHref

**Recommendation: Patch**

- **Reason:** `gateHref` is used as a fallback for tooltip/save. When it is a raw tracking URL, the user sees/saves the wrong URL.
- **Change:** Use `getOriginalUrl(lineageAnchor) || lineageAnchor.getAttribute('href') || lineageAnchor.href` for `lineageHref`.
- **Impact:** Low risk; improves extraction consistency and UX when the fallback is used.

### 4.2 countDiscoveryHostsResolved

**Recommendation: Patch**

- **Reason:** Raw host counting causes false rejections for multi-tracking single-product cards (Naver, Facebook Ads).
- **Change:** Use `getOriginalUrl(a) || String(a.getAttribute('href') || a.href || '').trim()` for `href`.
- **Impact:** PreResolved map keys align with lookup. Hosts are counted from resolved destinations. Fixes false rejections in same-domain ad scenarios.

### 4.3 Summary

| Point | Patch? | Rationale |
|-------|--------|-----------|
| **lineageHref** | Yes | Aligns gateHref with extraction pipeline; avoids wrong tooltip/save URLs. |
| **countDiscoveryHostsResolved** | Yes | Corrects host counting for multi-tracking single-product cards; avoids false rejections. |

---

## 5. Appendix: Code References

| Symbol | File | Lines |
|--------|------|-------|
| lineageHref | hoverDetector.js | 2000–2006 |
| gateHref | hoverDetector.js | 2012, 2063, 2081 |
| gateHref fallback | main.js | 1468–1470 |
| countDiscoveryHostsResolved | hoverDetector.js | 2920–2947, 3180 |
| __blinkBuildPreResolvedMap | hoverDetector.js | 1729–1763 |
