# Audit: Final Verification Systems for Item Candidates

## Overview

Before any selected container (Phase B or Main/Retry) is highlighted, it passes through multiple verification gates. This document catalogs every gatekeeper and its Pass/Fail criteria.

---

## 1. Purity Check (Host/Domain Counting)

### Function: `countDiscoveryHostsIn` / `countDiscoveryHostsResolved`

**Location:** `hoverDetector.js` (inline in Phase B path ~2239; No-Structural path ~2462; Async path uses `countDiscoveryHostsResolved` ~2929)

**Logic:**
- Scans `container.querySelectorAll('a[href]')` up to `cap` anchors (default 36)
- For each anchor: `__blinkIsVisibleForDecision(a)` must pass
- Uses `getOriginalUrl(a)` or raw href; resolves via `resolveCached` (or `preResolvedMap` for async)
- `getUrlIntent(resolved)` must be `group === 'DISCOVERY'`
- Extracts `u.hostname` and adds to a `Set` (lowercase)
- Returns `hosts.size` (unique discovery hosts)

**Threshold:** `hostCount <= 1`

| Result | Action |
|--------|--------|
| `hostCount <= 1` | Pass → `verifyOk = true`, `finalItemVerification = 'Succeeded'` |
| `hostCount > 1` | Fail → `verifyOk = false`, `finalItemVerification = 'Failed'` |

**Effect:** When verification fails, `highlightedContainer` falls back to `initialItem` (Main result) instead of the verified candidate. Highlight may still occur, but with lower confidence.

---

## 2. Content Density & Discovery Signals

### Function: `__hasDiscoveryContentSignals(container, options)`

**Location:** `hoverDetector.js` ~365

**Purpose:** Early pass in `__isMenuTab` – if container has rich discovery content, do NOT reject as menu-tab.

**Pass conditions (any one):**
- `hasLargeImg`: any IMG with width or height ≥ 40px (`__CONTENT_IMG_MIN`)
- `maxSvgRun >= 3`: 3+ consecutive SVG elements (rating-like)
- `textClasses.size >= 3 && textNodes >= 4`: content density (distinct class tokens + text nodes)
- `hasPriceLike`: text matches `__PRICE_PATTERN` (e.g. ₩, $, %)
- `hasBadgeLike`: text matches `__BADGE_PATTERN` (e.g. "할인", "NEW")
- `imgCount >= 1 && (textNodes >= 3 || svgCount >= 2)`: mixed content

**Fail:** None of the above → continues to stricter menu-tab checks.

---

### Function: `__analyzeContentPurity(anchor, options)`

**Location:** `hoverDetector.js` ~460

**Purpose:** Used by `__isMenuTab` – anchor must be "pure" (text-only, no product imagery) to be rejected as menu-tab.

**Allowed tags:** `SPAN`, `B`, `STRONG`, `I`, `EM`, `P`, `SVG`

**Fail conditions:**
- Contains `IMG` → `pure: false`, `reason: 'img (product imagery)'`
- Contains disallowed tag (e.g. `DIV`) → `pure: false`, `reason: 'disallowed tag: X'`

**Pass:** Anchor contains only allowed tags + text → `pure: true` (proceeds to visual dominance check).

---

## 3. Geometric & Viewport Checks

### Function: `__blinkIsViewportSizedContainer(el)`

**Location:** `main.js` ~498, `hoverDetector.js` ~596

**Logic:**
- `tag === 'html' || tag === 'body'` → `true`
- `rect.width >= w * 0.95 || rect.height >= h * 0.95` → `true` (95% of viewport)

**Effect:**
- **Main/Retry:** If `initialItem` is viewport-sized → triggers Retry; if both Main and Retry are oversize → `reason: 'container-oversize'`, `passed: false`
- **Highlight:** `main.js` ~1011, ~1482 – suppresses highlight when `__blinkIsViewportSizedContainer(highlightTarget)` is true
- **Async:** `main.js` ~991 – sets `e.__blinkFinalItem = null` if resolved item is viewport-sized

**No minimum size check** for "too small" – only maximum (viewport-sized) is enforced.

---

### Function: `__blinkIsVisibleForDecision(el)`

**Location:** `hoverDetector.js` ~1675

**Logic:**
- `el.closest('[aria-expanded="false"]')` → `false`
- `display === 'none'` or `visibility === 'hidden'` → `false`
- `getBoundingClientRect()`: `width <= 0` or `height <= 0` → `false`
- `offsetParent === null` and `position !== 'fixed'` → `false`

**Used by:** `countDiscoveryHostsIn`, `countDiscoveryHostsResolved`, anchor iteration in various paths. Anchors with zero dimensions are excluded from host counting.

---

## 4. Structural Sanity (Phase 3 / finalItemVerification)

### What Triggers `finalItemVerification: 'Failed'`

The label "Fail: Phase3-Structural-Item" (or similar) comes from `__blinkMapFinalItemVerification(main.js ~472)` when `finalItemVerification === 'Failed'`:

```
return `Fail: ${reason || finalItemPath || 'unknown'}`;
```

**Reasons that set `finalItemVerification = 'Failed'`:**

| Reason | Trigger | Path |
|--------|---------|------|
| `hostCount > 1` | Purity check fails | Phase B, No-Structural, Async |
| `verifyOk = false` | Same as above | All Main/Retry paths |
| `container-oversize` | Main and Retry both viewport-sized | Phase B, No-Structural |
| `final-not-discovery` | `getUrlIntent(activeHoverUrl).group !== 'DISCOVERY'` | Phase B, No-Structural, Async |
| `menu-tab` | `__isMenuTab(...)` returns true | Phase B, No-Structural, Async |
| `phase-b-no-discovery` | Phase B Rescue: no DISCOVERY URL in container | Phase B 2-b |
| `phase-a-no-discovery` | Phase A: no DISCOVERY URL | Phase A |
| `no-itemroot` | Main returns null | Phase B Rescue (Main-Fail) |

**"Too structural" or "too mixed":** The primary signal is `hostCount > 1`. A container with multiple discovery hosts (e.g. main result + sitelinks) fails the purity check. There is no separate "structural sanity" function; the host count IS the structural/mixed-domain gate.

---

## 5. Phase B Rescue Validation

### When Phase B Rescue Happens

- **2-a (Gate passed):** Main fails → Phase B Rescue (Main-Fail)
- **2-b (Gate failed):** Gate rejected → Phase B Rescue (Phase B as finalItem)

### Checks Applied to Phase B Rescue

| Check | Function | Pass/Fail |
|-------|----------|-----------|
| **DISCOVERY intent** | `getUrlIntent(dominantUrl).group === 'DISCOVERY'` | Fail → `passed: false`, `reason: 'phase-b-no-discovery'` |
| **Menu-Tab** | `__isMenuTab(phaseBContainer, rescueResolved, ...)` | Fail → `passed: false`, `reason: 'menu-tab'` |
| **URL resolution** | `resolveCached` or async resolve | Pending → `rescueVerification: 'Pending'` |

**No host-count check on Phase B Rescue** – it bypasses `countDiscoveryHostsIn` and returns `finalItemVerification: 'Succeeded'` when DISCOVERY + menu-tab pass. Phase B Rescue assumes the structural container is a valid repeating unit.

---

## 6. Menu-Tab Check (`__isMenuTab`)

**Location:** `hoverDetector.js` ~523

**Purpose:** Reject containers that look like nav tabs/menus (same-domain, text-only, high anchor occupancy).

**Reject (return `true`) only if ALL hold:**
- **A) Domain:** `targetBase === currentBase` (same base domain)
- **B) Content:** `__hasDiscoveryContentSignals` → false (no rich content)
- **B2) Purity:** `__analyzeContentPurity` → `pure: true` (anchor has only SPAN/B/STRONG/I/EM/P/SVG, no IMG)
- **B1) Visual dominance:** `__anchorOccupancyRatio(anchor, container) > threshold`
  - `threshold = 0.5` if role in `tab`, `tablist`, `menuitem`, `navigation`
  - `threshold = 0.7` otherwise

**Pass (return `false`):** Any of: external domain, discovery content signals, impure anchor (has IMG), or low anchor ratio.

---

## 7. Verification Functions Summary

| Function | Purpose | Pass | Fail |
|----------|---------|------|------|
| `countDiscoveryHostsIn` | Unique discovery hosts in container | `hostCount <= 1` | `hostCount > 1` |
| `countDiscoveryHostsResolved` | Same, with preResolved map | `hostCount <= 1` | `hostCount > 1` |
| `__hasDiscoveryContentSignals` | Rich content (img, price, badge, etc.) | Any signal found | No signals |
| `__analyzeContentPurity` | Anchor structure (no IMG, allowed tags only) | `pure: true` | `pure: false` |
| `__blinkIsViewportSizedContainer` | Container ≥ 95% viewport | N/A (reject) | Triggers oversize handling |
| `__blinkIsVisibleForDecision` | Element is visible, non-zero size | `true` | `false` |
| `__isMenuTab` | Container is nav/tab (same-domain, text-only, high ratio) | `false` (pass) | `true` (reject) |
| `getUrlIntent` | URL is DISCOVERY | `group === 'DISCOVERY'` | `group !== 'DISCOVERY'` |

---

## 8. Verification Flow by Path

### Phase B + Gate Passed (2-a)

1. Main → `findItemRootContainer` (compareMode: 'domain')
2. Retry if `!initialValidated`
3. Phase B Override if `mainCandidate.contains(phaseBContainer)`
4. `countDiscoveryHostsIn(finalItemEl)` → `verifyOk = hostCount <= 1`
5. `getUrlIntent(finalDominant)` → reject if not DISCOVERY
6. `__isMenuTab(finalItemEl, phaseBFinalResolved)` → reject if menu-tab
7. `finalItemVerification = verifyOk ? 'Succeeded' : 'Failed'`

### Phase B + Gate Failed (2-b)

1. `__blinkResolveRescueDominantUrl(phaseBContainer)`
2. `getUrlIntent(dominantUrl)` → reject if not DISCOVERY
3. `__isMenuTab(phaseBContainer, rescueResolved)` → reject if menu-tab
4. `finalItemVerification = 'Succeeded'` (no host count)

### No-Structural (Priority 3)

1. Main → `findItemRootContainer`
2. Retry if `!initialValidated`
3. `countDiscoveryHostsIn(finalCandidate.item)` → `verifyOk`
4. `highlightedContainer = verifyOk ? finalCandidate.item : initialItem`
5. `getUrlIntent(activeHoverUrl)` → reject if not DISCOVERY
6. `__isMenuTab(finalItemEl, syncFinalResolvedUrl)` → reject if menu-tab

### Async Path

1. Main + Retry (with preResolved)
2. Phase B Override if applicable
3. `countDiscoveryHostsResolved(finalItem, preResolvedMain)` → `finalOk = hostCount <= 1`
4. `getUrlIntent(activeHoverUrl)` → reject if not DISCOVERY
5. `__isMenuTab(finalItem, asyncFinalResolvedUrl)` → reject if menu-tab
