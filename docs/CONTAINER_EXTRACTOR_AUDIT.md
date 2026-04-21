# Technical Audit: Main-Process and Retry-Process Logic

## Overview

The `findItemRootContainer` function in `containerExtractor.js` is the core of ItemRoot detection. It is invoked by `hoverDetector.js` with different `compareMode` values to implement a two-phase strategy: **Main-Process** (broad, domain-level) and **Retry-Process** (strict, full-URL-level).

---

## 1. Main-Process (Bottom-Up Expansion)

### 1.1 Starting Point

The upward scan does **not** start from `HoveredEl` directly. It starts from the **nearest discovery anchor** (`nearby.sourceEl`):

```
prev = nearby.sourceEl          // The <a> tag (or element with extracted URL)
curr = prev.parentElement      // First container to check
```

**Preconditions:**
- `findNearbyDiscoverySource(targetEl, ...)` must return a valid `nearby` with:
  - `sourceEl`: visible DISCOVERY `<a[href]>` within ~150px of target
  - `id`: resolved/normalized URL (from `getDetailedIdSync`)
- If no nearby anchor is found → return `null` (reason: `no-nearby-discovery-anchor`)

**Nearby search order:**
1. Direct ancestor `<a href>` (if target is inside a link)
2. `extractUrlFromNavigableElement` (for non-anchor targets with data-url, onclick, etc.)
3. `findNearestDiscoveryAnchorInScope` (scan ancestor scopes up to 6 levels)

### 1.2 Exit Conditions (Priority Order)

The loop checks conditions in this order at each `curr`:

| Priority | Condition | Action |
|----------|-----------|--------|
| **0** | `curr` not visible | Skip, advance to parent |
| **1** | **Early Repetition** (on `prev`): `prev` has 3+ siblings with same structure signature, and `prev` contains `nearby.sourceEl` | Return `refineToDivergencePointIfMixed(prev)` |
| **2** | **URL Branching Point**: `scanDiscoveryBranchingIn(curr, ..., 'host')` returns `hasDifferent: true` | Return `refineToDivergencePointIfMixed(curr)` |
| **3** | **Structural Repetition**: `getStructuralRepetitionInfo(curr)` returns `strength: 'strong'` (or weak + list parent) | Return `refineToDivergencePointIfMixed(curr)` |
| **4** | None of above | Expand: `prev = curr`, `curr = curr.parentElement` |

**Exhausted path:** If loop exits without any return (depth ≥ 14 or `curr` null), return `refineToDivergencePointIfMixed(prev)`.

### 1.3 Single vs. Multiple Anchors

- **Single anchor:** `scanDiscoveryBranchingIn` returns `hasDifferent: false` (no other discovery URL in container). Loop continues expanding.
- **Multiple anchors, same host:** `hasDifferent: false` (host-level comparison). Loop continues.
- **Multiple anchors, different host:** `hasDifferent: true`. Loop stops at that container (branching point).

---

## 2. Retry-Process (Structural/Pattern Matching)

### 2.1 When Retry-Process Is Triggered

Retry-Process is **not** a separate code path. It is the **same** `findItemRootContainer` function called with `compareMode: 'full'` instead of `'domain'`.

**Trigger conditions (in `hoverDetector.js`):**
1. **Phase B + Gate passed:** Main-Process returns a result, but `initialValidated === false` (dominantUrl ≠ nearbyUrl when compared as full strings).
2. **No-Structural path:** Same validation check; if Main fails validation, Retry is attempted.
3. **Main oversize:** If Main returns a viewport-sized container, Retry is run to try a smaller unit.

**Key difference:** Retry receives `nearbyOverride` with the same `nearbyUrl` from Main, so it reuses the same anchor identity.

### 2.2 Spatial/Divergence vs. Structural Priority

**Spatial/Divergence logic is prioritized:**
- The ascend loop checks **URL branching** (Priority 2) **before** structural repetition (Priority 3).
- Branching uses `'host'` mode (subdomain-sensitive) to detect mixed domains.
- Structural repetition is a **guardrail** when no branching point is found.

### 2.3 Repeating Unit Definition

**Early Repetition (local-sibling-match):**
- Checks `prev` (the level being left).
- Siblings = `parent.children` minus separators.
- Same-signature count ≥ 3.
- Signature = `getStructureSignature(el, { maxChildTags: 12 })` (tag + child tag pattern).
- Element must be `isStructureComplex` (has content).

**Structural Repetition (guardrail):**
- Uses `findStructuralFinalItem(curr)` → `getStructuralRepetitionInfo(curr)`.
- **Phase A (SNS bypass):** Single-element match for Instagram `<article>`, Facebook feed unit, X, Reddit, Threads.
- **Phase B (general):** Sibling cohort with:
  - `getStructureSignature` + `immediateChildPattern` for pattern similarity
  - Jaccard on class tokens
  - Feature-map similarity (rescueFlattenedFeatureMap, rescueWeightedJaccard)
- **Strength:** `strong` if 2+ peers match with high confidence; `weak` if 1+ match.
- **List guardrail:** Inside `<ul>`/`<ol>`, weak + clusterSize ≥ 3 can stop expansion.

---

## 3. Main/Retry and Phase B Relationship

### 3.1 Phase B Container

`__blinkFindPhaseBContainer(el, point)` in `hoverDetector.js`:
- Uses `structuralMapManager.getPhaseBContainer(el, 14)` (pre-calculated repeating patterns).
- Falls back to `elementsFromPoint(x, y)` to probe the hit stack.
- Returns a container that is a **repeating structural unit** (e.g., `.MjjYud` in Google Search).

### 3.2 Merge/Prioritization Logic

**When Phase B exists and Gate passed (2-a):**
1. Run Main: `findItemRootContainer(gateTarget, ..., { compareMode: 'domain' })`.
2. If Main fails → **Phase B Rescue:** Use `phaseBContainer` as `finalItem`.
3. If Main succeeds:
   - Run Retry if `!initialValidated`.
   - **Override rule:** If `mainCandidate.contains(phaseBContainer)` → use `phaseBContainer` as `finalItem` (Phase B Override).
   - Otherwise use Main/Retry result.

**When Phase B exists and Gate failed (2-b):**
- Use Phase B as `finalItem` directly (Phase B Rescue).

### 3.3 Main Failure Fallback

| Scenario | Fallback |
|----------|----------|
| Main returns null | Phase B Rescue (if Phase B exists) |
| Main returns viewport-sized | Retry; if Retry also oversize → fail |
| Main returns but validation fails | Retry; if Retry succeeds → use Retry |
| No Phase B, Main fails | Click-path fallback (if available) or fail |

---

## 4. Refinement Logic Integration

### 4.1 When `refineToDivergencePointIfMixed` Is Called

Refinement is called **immediately before** returning a candidate in **every** exit path:

| Exit Path | Refinement Call |
|-----------|-----------------|
| Early Repetition (local-sibling-match) | `refineToDivergencePointIfMixed(prev, ...)` |
| URL Branching Point | `refineToDivergencePointIfMixed(curr, ...)` |
| Structural Repetition | `refineToDivergencePointIfMixed(curr, ...)` |
| Exhausted Upward | `refineToDivergencePointIfMixed(prev, ...)` |

### 4.2 Before vs. After Decision

Refinement happens **after** the process decides *which* container to return, but **before** that container is actually returned.

Flow: **Identify base container → Refine (if mixed domains) → Return refined or base**.

---

## 5. Decision Tree (Pseudo-Code)

```
findItemRootContainer(targetEl, urlPatterns, debugOut, options):
  compareMode = options.compareMode  // 'domain' (Main) or 'full' (Retry)
  nearby = findNearbyDiscoverySource(targetEl) or options.nearby
  if !nearby: return null

  prev = nearby.sourceEl
  curr = prev.parentElement
  depth = 0

  while curr && depth < 14:
    if !isVisibleForScan(curr): skip, advance
    scan = scanDiscoveryBranchingIn(curr, nearbyId, 'host')

    // Exit 1: Early repetition (on prev)
    if prev.contains(nearby) && prev has 3+ same-signature siblings:
      return finalize(refineToDivergencePointIfMixed(prev))

    // Exit 2: URL branching
    if scan.hasDifferent:
      candidate = refineToDivergencePointIfMixed(curr)
      return candidate ? finalize(candidate) : null

    // Exit 3: Structural repetition
    rep = getStructuralRepetitionInfo(curr)
    if rep.strength === 'strong' OR (listParent AND rep.strength === 'weak' AND rep.clusterSize >= 3):
      return finalize(refineToDivergencePointIfMixed(curr))

    prev = curr
    curr = curr.parentElement
    depth++

  // Exhausted
  return finalize(refineToDivergencePointIfMixed(prev))
```

---

## 6. Flow Diagram

```
                    ┌─────────────────────────────────────┐
                    │     findItemRootContainer           │
                    │  (compareMode: 'domain' | 'full')   │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
                    │  findNearbyDiscoverySource(target)   │
                    │  → nearby = { sourceEl, href, id }   │
                    └─────────────────┬───────────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │  nearby found?          │
                         └────────────┬────────────┘
                              No │         │ Yes
                                 ▼         │
                            return null    │
                                           ▼
                    ┌──────────────────────────────────────┐
                    │  ASCEND LOOP: prev=nearby.sourceEl,   │
                    │  curr=prev.parentElement              │
                    └─────────────────┬────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────────┐        ┌─────────────────┐
│ Early Repetition│        │ URL Branching       │        │ Structural Rep   │
│ (prev, 3+ sibs) │        │ (scan.hasDifferent) │        │ (rep.strength)  │
└────────┬────────┘        └──────────┬──────────┘        └────────┬────────┘
         │                            │                            │
         └────────────────────────────┼────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  refineToDivergencePointIfMixed(...)  │
                    │  (subdomain-sensitive host check)    │
                    └─────────────────┬───────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  finalize(candidate) → return        │
                    └─────────────────────────────────────┘
```

---

## 7. Key Implementation Details

| Concept | Implementation |
|---------|----------------|
| **Branching scan mode** | Always `'host'` (subdomain-sensitive) in ascend loop |
| **Cache key** | `compareMode::nearbyId` (separate caches for domain/full) |
| **Scan cache** | `__blinkBranchScanCache` (WeakMap, 160ms TTL) |
| **Result cache** | `__blinkResultCache[compareMode]` (WeakMap, 160ms TTL) |
| **Max depth** | 14 levels upward |
| **Proximity threshold** | 150px (configurable via `__blinkNearbyDiscoveryProximityPx`) |
