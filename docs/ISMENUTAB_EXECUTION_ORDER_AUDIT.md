# Audit Report: `__isMenuTab` Execution Order

**Date:** February 14, 2025  
**Scope:** hoverDetector.js – Sequential dependency and Post-Expansion validation

---

## 1. Call-Site Mapping (Before Refactor)

| Location | Phase | Timing | Container | Issue |
|----------|-------|--------|-----------|-------|
| **Line ~2095** | Phase B (Sync) | **Pre-Expansion** | `phaseBContainer` | ❌ Early – before `findItemRootContainer` |
| **Line ~2213** | Phase B-Main Stage 2 (Sync) | Post-Expansion | `finalItemEl` | ✅ Correct |
| **Line ~2499** | Sync-Final | Post-Expansion | `finalItemEl` | ✅ Correct |
| **Line ~2714** | Phase B (Async) | **Pre-Expansion** | `phaseBContainerAsync` | ❌ Early – before Main/Retry |
| **Line ~3071** | Async-Final | Post-Expansion | `finalItem` | ✅ Correct |

### Gateway Phase

The **Gateway** runs before `findItemRootContainer`. It checks:
- Cursor is pointer
- Anchor intent (DISCOVERY vs non-DISCOVERY)

**No `__isMenuTab`** is invoked during the Gateway phase itself. The problem was in **Phase B**, where `__isMenuTab` was applied to `phaseBContainer` **before** Main/Retry expansion.

---

## 2. Sequential Dependency Violation

### What Was Wrong

- **Phase B** returns a **structural candidate** (repeating siblings container) from `__blinkFindPhaseBContainer`.
- This is **not** the final expanded item. The final item is determined by:
  - Main-Process: `findItemRootContainer` → `itemRootContainer`
  - Retry-Process (if needed): second `findItemRootContainer` with full compare
  - Phase B Override: if Main candidate contains Phase B, use Phase B as `finalItemEl`

- Applying `__isMenuTab` to `phaseBContainer` **before** this expansion:
  - Rejected valid content cards whose dominant link looked like a nav link
  - Caused `<null>` finalItem in same-domain (e.g. SmartStore) scenarios
  - Treated the structural candidate as if it were the final item

### Correct Order

1. **Find structural candidate** (Phase A, Phase B, or Gate anchor)
2. **Run Main/Retry** → `findItemRootContainer` → expansion
3. **Identify finalItem** (Phase B override or Main/Retry result)
4. **Then** run `__isMenuTab(finalItem, resolvedUrl)`

---

## 3. Logic Flow Restructuring (Implemented)

### Removed: Early Phase B `__isMenuTab`

- **Sync:** Removed `__isMenuTab(phaseBContainer, ...)` before Main/Retry.
- **Async:** Removed `__isMenuTab(phaseBContainerAsync, ...)` before Main/Retry.

### Kept: Post-Expansion `__isMenuTab`

- **Phase B-Main Stage 2:** `__isMenuTab(finalItemEl, phaseBFinalResolved)` – after `finalItemEl` is set.
- **Phase B-Rescue:** `__isMenuTab(phaseBContainer, rescueResolved)` – when Phase B is used as finalItem without Main/Retry (deferred to async if resolution pending).
- **Sync-Final:** `__isMenuTab(finalItemEl, syncFinalResolvedUrl)` – after Main/Retry.
- **Async-Final:** `__isMenuTab(finalItem, asyncFinalResolvedUrl)` – after expansion.

### New Flow

```
Gateway (intent check)
    ↓
Phase A? → return (no __isMenuTab)
    ↓
Phase B? → keep phaseBContainer (no early __isMenuTab)
    ↓
Main/Retry: findItemRootContainer
    ↓
finalItemEl = mainIsParentOfPhaseB ? phaseBContainer : mainCandidate
    ↓
[Step 1] FinalItem Identified: <DIV.card>
[Step 2] Applying isMenuTab check to Identified FinalItem...
    ↓
__isMenuTab(finalItemEl, resolvedUrl)
    ↓
[Result] Pass / Fail (menu-tab)
```

---

## 4. Debug Log Sequence (Implemented)

Each `__isMenuTab` call site now logs:

```
[Step 1] FinalItem Identified: <DIV.card>
[Step 2] Applying isMenuTab check to Identified FinalItem...
[Result] Pass
```

or

```
[Result] Fail (menu-tab)
```

---

## 5. How This Fixes the `<null>` finalItem Issue

### SmartStore / Same-Domain Scenario

- **Before:** Phase B found a card container. Its dominant URL was same-domain (e.g. category nav). Early `__isMenuTab` rejected it and set `phaseBContainer = null`. Main/Retry then ran without Phase B. In some cases, Main failed or produced a different structure, leading to `<null>` or wrong finalItem.
- **After:** Phase B container is kept. Main/Retry runs and may choose Phase B as `finalItemEl` when `mainCandidate.contains(phaseBContainer)`. `__isMenuTab` runs only on this final item. If the card’s primary link is a nav link, it is rejected at the right stage; if not, the card is accepted.

### Summary

- `__isMenuTab` is no longer used as a gatekeeper on structural candidates.
- It runs only after the final item is chosen.
- This avoids discarding valid content cards and reduces `<null>` finalItem cases.
