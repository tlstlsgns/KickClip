# Comparative Audit: URL Matching Modes in Main vs. Retry Process

## 1. Main-Process Logic

### Primary expansion loop

The expansion loop lives in **`findItemRootContainer`** (containerExtractor.js). Main-Process invokes it with `compareMode: 'domain'`:

```javascript
// hoverDetector.js:2515 (sync path)
let res1 = findItemRootContainer(gateTarget, urlPatterns, debug1, { compareMode: 'domain', preResolved: null });

// hoverDetector.js:2289 (Phase B path)
findItemRootContainer(gateTarget, urlPatterns, debug1, { compareMode: 'domain', preResolved: null, isInsideValidatedContainer: inPhaseB });
```

### Mode used in `scanDiscoveryBranchingIn` (ascend loop)

The ascend loop does **not** use `compareMode`. It uses `'host'`:

```javascript
// containerExtractor.js:2169–2172
// Use subdomain-sensitive ('host') for branching detection so we stop at the true LCA
// (e.g. .BYM4Nd) where gemini.google.com vs google.com first diverge.
const scan = scanDiscoveryBranchingIn(curr, preResolved, nearbyId, 'host');
```

So Main-Process uses `'host'` for the branching check, regardless of `compareMode: 'domain'`.

---

## 2. Retry-Process Logic

### Expansion invocation

Retry-Process invokes `findItemRootContainer` with `compareMode: 'full'`:

```javascript
// hoverDetector.js:2589 (sync path)
retryRes = findItemRootContainer(el, urlPatterns, debug2, { compareMode: 'full', preResolved: null, nearby: nearbyOverride });

// hoverDetector.js:2329 (Phase B path)
retryRes = findItemRootContainer(el, urlPatterns, debug2, { compareMode: 'full', preResolved: null, nearby: nearbyOverride });
```

### Mode used in `scanDiscoveryBranchingIn` (ascend loop)

The same ascend loop runs for Retry. It still uses `'host'`:

```javascript
// containerExtractor.js:2172 (same code path for both processes)
const scan = scanDiscoveryBranchingIn(curr, preResolved, nearbyId, 'host');
```

So Retry-Process also uses `'host'` for the branching check, regardless of `compareMode: 'full'`.

---

## 3. Comparison Table

| Process       | findItemRootContainer options | Ascend loop scanDiscoveryBranchingIn | Exhausted-upward scanFinal | Subdomain sensitive in ascend? |
|---------------|-------------------------------|--------------------------------------|----------------------------|--------------------------------|
| **Main-Process**  | `compareMode: 'domain'`       | `'host'` (hardcoded)                 | `compareMode` ('domain')   | Yes                            |
| **Retry-Process** | `compareMode: 'full'`         | `'host'` (hardcoded)                 | `compareMode` ('full')     | Yes                            |

### Where `compareMode` is used

| Location | Main | Retry | Effect |
|----------|------|-------|--------|
| **Ascend loop branching** (line 2172) | `'host'` | `'host'` | Same for both |
| **refineToDivergencePointIfMixed** (line 554) | `'host'` | `'host'` | Same for both (internal call) |
| **Exhausted-upward scanFinal** (line 2351) | `'domain'` | `'full'` | Different; only affects `anyDiscovery` validation |
| **Cache key** | `__blinkResultCache['domain']` | `__blinkResultCache['full']` | Separate caches |
| **Debug mismatchDetail** | `{ nearbyDomain, otherDomain }` | `{ nearbyId, otherId }` | Different format |

---

## 4. Impact on `hasDifferent`

### Does Retry use a more relaxed mode?

No. Both processes use `'host'` for the branching check that drives `hasDifferent`.

### Can Retry bypass a `hasDifferent: true` that stops Main?

No. The ascend loop is shared and always uses `'host'`. If Main stops at a container because `scan.hasDifferent` is true, Retry would stop at the same container for the same reason.

### Mode strictness (if they were used)

| Mode   | Strictness | Example: `example.com/a` vs `example.com/b` |
|--------|------------|---------------------------------------------|
| `host` | Medium     | Same (same host) → no `hasDifferent`        |
| `domain` | Relaxed | Same (same root domain) → no `hasDifferent` |
| `full` | Strict     | Different (different path) → `hasDifferent` |

If the ascend loop used `compareMode` instead of `'host'`:

- Main (`domain`): would treat `www.example.com` and `api.example.com` as same → fewer stops.
- Retry (`full`): would treat `example.com/page1` and `example.com/page2` as different → more stops.

In the current implementation, neither of these applies because the loop uses `'host'` for both.

---

## 5. Code Snippets

### Main-Process: mode definition

```javascript
// hoverDetector.js:2513–2515
// [Main Process] compareMode: 'domain'
const debug1 = { reason: null, detail: null, dominantUrl: null, nearbyUrl: null, nearbyHref: null };
let res1 = findItemRootContainer(gateTarget, urlPatterns, debug1, { compareMode: 'domain', preResolved: null });
```

### Retry-Process: mode definition

```javascript
// hoverDetector.js:2588–2589
const debug2 = { reason: null, detail: null, dominantUrl: null, nearbyUrl: null, nearbyHref: null };
retryRes = findItemRootContainer(el, urlPatterns, debug2, { compareMode: 'full', preResolved: null, nearby: nearbyOverride });
```

### Shared ascend loop: hardcoded `'host'`

```javascript
// containerExtractor.js:2169–2176
// Use subdomain-sensitive ('host') for branching detection so we stop at the true LCA
// (e.g. .BYM4Nd) where gemini.google.com vs google.com first diverge.
const scan = scanDiscoveryBranchingIn(curr, preResolved, nearbyId, 'host');
try {
  console.log(`[Trace-Ascend] Checking Container: ${traceElDesc(curr)} | Contains otherUrl? ${scan.hasDifferent}`);
} catch (e) {}
// ...
if (scan.hasDifferent) {
  // STOP: branching point
  const candidate = refineToDivergencePointIfMixed(curr, nearby.sourceEl, nearbyId, preResolved, compareMode, traceElDesc);
  // ...
}
```

### Exhausted-upward: uses `compareMode`

```javascript
// containerExtractor.js:2349–2352
// If no breaking point found, prefer the highest container that still only contains the nearby ID.
const scanFinal = scanDiscoveryBranchingIn(prev, preResolved, nearbyId, compareMode);
if (!scanFinal.anyDiscovery && !(prev && prev.contains && prev.contains(nearby.sourceEl))) {
  return null;
}
```

Here `scanFinal` is only used for `anyDiscovery` (presence of any DISCOVERY anchor), not for `hasDifferent`. The loop has already finished without a branching stop.

---

## 6. Summary

| Question | Answer |
|----------|--------|
| Different compareMode between Main and Retry? | Yes: Main uses `'domain'`, Retry uses `'full'` when calling `findItemRootContainer`. |
| Different mode in the ascend loop? | No: both use `'host'` (hardcoded). |
| Is Retry more relaxed? | No: Retry’s `compareMode` is stricter (`full`), but it is not used for the branching check. |
| Can Retry bypass `hasDifferent`? | No: both use the same `'host'` logic for branching. |
| What does `compareMode` affect? | Cache keys, exhausted-upward `scanFinal`, and debug output. |

**Conclusion:** Main and Retry use the same subdomain-sensitive `'host'` mode for the branching check. The different `compareMode` values (`'domain'` vs `'full'`) do not change when `hasDifferent` is set or how far the container expands.
