# Audit: Gateway Logic for Deferred Intent Judgment in Phase B Context

## Overview

The Gateway logic lives in `hoverDetector.js` (there is no separate `gateway.js`). The "deferred judgment" for Phase B is implemented via `isInsideValidatedContainer`, which relaxes URL intent classification when finding a nearby discovery anchor inside a Phase B repeating container.

---

## 1. Deferred Judgment Logic

### Does a check identify Phase B before finalizing ACCEPTED/REJECTED?

**Yes, but indirectly.** The flow is:

1. **Phase B is found first** via `__blinkFindPhaseBContainer(el, point)` (hoverDetector.js ~2254).
2. **Gate is evaluated** via `entryGate(el)` (hoverDetector.js ~2160).
3. **When Phase B exists and gate passed:** `findItemRootContainer` is called with `isInsideValidatedContainer: inPhaseB` (hoverDetector.js ~2288–2289).

The "deferred" behavior is: when the target is inside a Phase B container, `isInsideValidatedContainer: true` is passed into the nearby-anchor search. That changes how `getUrlIntent` classifies same-domain internal URLs.

### Is there logic that says "if structural repetition, allow through even if intent is ambiguous"?

**Partially.** The relaxation is:

- **Where:** `getUrlIntent` in urlResolver.js (lines 1278–1283).
- **Condition:** `(isInsideValidatedContainer || isSearchResultPage) && isTargetValidLandingPage && hasNoRedirectParams`
- **Effect:** Same-domain internal links are promoted to `CONTENT_ITEM` (reason: `internal-promoted`), so they become DISCOVERY.

So when inside Phase B (or on a search result page), internal links that would otherwise be INTERNAL_VIEW or GATEWAY can be treated as DISCOVERY. This is the only place where structural context relaxes intent.

---

## 2. Integration Between Gateway and Phase B

### How does the Gateway access Phase B data?

Phase B is computed in the same `resolveHoverAndItemRootSync` flow:

```
resolveHoverAndItemRootSync(el, urlPatterns, point)
  → entryGate(el)                    // Gate (no URL intent)
  → __blinkFindPhaseBContainer(el, point)  // Phase B from structuralMapManager
  → if phaseBContainer:
      inPhaseB = phaseBContainer.contains(gateTarget)
      findItemRootContainer(gateTarget, ..., { isInsideValidatedContainer: inPhaseB })
```

Phase B comes from `structuralMapManager.getPhaseBContainer(el, 14)` (hoverDetector.js ~244).

### Does the Gateway skip `getUrlIntent().group === 'DISCOVERY'` when inside Phase B?

**No.** The Gateway (entryGate) never checks URL intent. It only checks:

- In-form
- Presence of `a[href]` within 5 parents
- Toggle-like UI
- Ancestor interactive signals (role, aria-label)
- Subtree semantic scan

So there is no "skip" of the intent check at the gate. The relaxation happens later, when finding the nearby anchor.

### "Pending Structural Validation"?

**No.** There is no "Pending Structural Validation" state. The only "Pending" is `phaseBFinalPending` / `rescuePending`, which means the URL needs redirect resolution before the menu-tab check. Intent is still required to be DISCOVERY.

---

## 3. "No-Nearby-Discovery-Anchor" vs. Phase B

### Rescue when Main fails (no nearby anchor)

**Location:** hoverDetector.js ~2299–2311

When `findItemRootContainer` returns no result (e.g. `no-nearby-discovery-anchor`):

```javascript
if (!res1 || !res1.itemRootContainer || !res1.nearbyUrl) {
  const phaseBRescuePath = 'Phase-B-Rescue (Main-Fail)';
  const dominantUrl = __blinkResolveRescueDominantUrl(phaseBContainer, phaseBRescuePath);
  const intent = dominantUrl ? getUrlIntent(dominantUrl, window.location.href) : null;
  const ok = !!(dominantUrl && (isFacebook ? true : (intent && intent.group === 'DISCOVERY')));
  if (ok) {
    return { passed: true, reason: 'phase-b-rescue-main-fail', ... };
  }
  return { passed: false, ..., finalItemPath: 'Phase-B (Main-Fail, No DISCOVERY)' };
}
```

So:

- **Rescue exists:** Phase B is used when Main fails.
- **Intent is still required:** `intent.group === 'DISCOVERY'` (except Facebook).
- **URL source changes:** Uses `__blinkResolveRescueDominantUrl(phaseBContainer)` instead of the nearby anchor.

Phase B Rescue does **not** bypass the intent check. It uses the dominant URL from the Phase B container and still requires DISCOVERY.

---

## 4. Code Evidence: Where Intent Is Bypassed or Influenced by Phase B

### A. Relaxed intent when finding nearby anchor (only bypass-like behavior)

| File | Line | Code | Effect |
|------|------|------|--------|
| hoverDetector.js | 2288–2289 | `inPhaseB = phaseBContainer.contains(gateTarget)` | Detects if target is in Phase B |
| hoverDetector.js | 2289 | `findItemRootContainer(..., { isInsideValidatedContainer: inPhaseB })` | Passes flag into container extraction |
| containerExtractor.js | 2034–2035 | `intentOpts = isInsideValidatedContainer ? { isInsideValidatedContainer: true } : undefined` | Builds intent options |
| containerExtractor.js | 2035 | `findNearbyDiscoverySource(targetEl, preResolved, intentOpts)` | Passes options to nearby search |
| containerExtractor.js | 228, 644, 656, 669 | `isDiscoveryHref(href, preResolved, intentOptions)` | Uses options when classifying anchors |
| containerExtractor.js | 418–426 | `isDiscoveryHref` → `getUrlIntent(id, ..., intentOptions)` | Forwards options to intent |
| urlResolver.js | 1278–1283 | `(isInsideValidatedContainer \|\| isSearchResultPage) && isTargetValidLandingPage && hasNoRedirectParams` | Promotes internal URLs to DISCOVERY |

### B. Phase B Rescue (no intent bypass)

| File | Line | Code | Effect |
|------|------|------|--------|
| hoverDetector.js | 2306–2307 | `intent = getUrlIntent(dominantUrl, ...)`; `ok = !!(dominantUrl && (intent && intent.group === 'DISCOVERY'))` | Still requires DISCOVERY |
| hoverDetector.js | 2405–2406 | Same pattern for 2-b (Gate failed) | Same requirement |

---

## 5. Flow: Ambiguous Intent Allowed Through When Inside Phase B

```
1. User hovers element inside Phase B container (e.g. Google search result)
2. entryGate(el) → passed (anchor within 5 parents)
3. __blinkFindPhaseBContainer(el, point) → phaseBContainer
4. inPhaseB = phaseBContainer.contains(gateTarget) → true
5. findItemRootContainer(gateTarget, ..., { isInsideValidatedContainer: true })
6. findNearbyDiscoverySource(targetEl, preResolved, { isInsideValidatedContainer: true })
7. For each candidate anchor:
   - isDiscoveryHref(href, preResolved, { isInsideValidatedContainer: true })
   - getUrlIntent(id, window.location.href, { isInsideValidatedContainer: true })
   - getUrlIntentInternal: same-domain internal link + isInsideValidatedContainer + valid landing page
     → return CONTENT_ITEM (internal-promoted) → group = DISCOVERY
8. Anchor passes isDiscoveryHref → nearby found
9. Main/Retry continues with that nearby anchor
```

Without `isInsideValidatedContainer`, the same internal link (e.g. `google.com/?hl=ko` on a Google search page) might be classified as INTERNAL_VIEW or GATEWAY and fail `isDiscoveryHref`, leading to `no-nearby-discovery-anchor`.

---

## 6. Summary

| Question | Answer |
|----------|--------|
| **Deferred judgment exists?** | Yes, via `isInsideValidatedContainer` in `getUrlIntent` |
| **Where is it applied?** | When finding the nearby anchor in `findNearbyDiscoverySource` → `isDiscoveryHref` → `getUrlIntent` |
| **What does it do?** | Promotes same-domain internal links to DISCOVERY when inside Phase B or on a search result page |
| **Does it bypass intent entirely?** | No. It only relaxes classification for internal links that meet `isTargetValidLandingPage` and `hasNoRedirectParams` |
| **Phase B Rescue bypass intent?** | No. Phase B Rescue still requires `intent.group === 'DISCOVERY'` for the dominant URL |
| **"Pending Structural Validation"?** | No such state. "Pending" is only for redirect resolution |
