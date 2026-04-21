# Technical Audit: `hasDifferent` Flag in Main/Retry Process

## 1. Definition of `hasDifferent`

### Where is it initialized and updated?

`hasDifferent` is **not** a loop variable. It is the **return property** of `scanDiscoveryBranchingIn()`, which is called once per ascend step.

| Location | Role |
|----------|------|
| **containerExtractor.js:1824–1888** | `scanDiscoveryBranchingIn(container, preResolved, nearbyId, compareMode)` — returns `{ hasDifferent, anyDiscovery, mismatchId, ... }` |
| **containerExtractor.js:2172** | Ascend loop: `const scan = scanDiscoveryBranchingIn(curr, preResolved, nearbyId, 'host');` |
| **containerExtractor.js:2229** | `if (scan.hasDifferent)` — branching-point check |

### Exact comparison line

The comparison happens at **containerExtractor.js:1874**:

```javascript
if (!equalsByMode(info.id, nearbyId, compareMode)) {
  // ...
  return { hasDifferent: true, ... };
}
```

- **`nearbyId`** — reference URL (from the nearby discovery anchor)
- **`info.id`** — identity of another DISCOVERY anchor found inside the current container (`curr`)
- **`equalsByMode(aId, bId, mode)`** — returns `true` when both IDs are considered equal under the given mode

---

## 2. Comparison Logic & Criteria

### `equalsByMode` implementation (containerExtractor.js:1732–1796)

```javascript
function equalsByMode(aId, bId, mode) {
  if (!aId || !bId) return false;

  const identityKey = (id, m) => {
    const s = String(id);
    if (m === 'full') return s;  // Strict: exact string match
    if (m === 'host') {
      if (isOpaqueTokenUrl(s)) return s;
      return normalizeHostname(getHostFromDetailedId(s));  // Subdomain-sensitive
    }
    if (m === 'domain') {
      if (isOpaqueTokenUrl(s)) return s;
      return rootDomain(getHostFromDetailedId(s));  // Root domain only
    }
  };

  return identityKey(aId, mode) === identityKey(bId, mode);
}
```

### Modes

| Mode | Comparison | Example |
|------|------------|---------|
| **`full`** | Exact normalized URL string | `https://example.com/page` ≠ `https://example.com/other` |
| **`host`** | Hostname (subdomain-sensitive) | `gemini.google.com` ≠ `google.com` |
| **`domain`** | Root domain | `www.example.com` = `api.example.com` |

### Mode used in Main-Process expansion

The ascend loop uses **`'host'`** for branching detection, not `compareMode` from options:

```javascript
// containerExtractor.js:2169–2172
// Use subdomain-sensitive ('host') for branching detection so we stop at the true LCA
// (e.g. .BYM4Nd) where gemini.google.com vs google.com first diverge.
const scan = scanDiscoveryBranchingIn(curr, preResolved, nearbyId, 'host');
```

So:

- **Main-Process** and **Retry-Process** both use **`'host'`** in the ascend loop.
- `compareMode` (`'domain'` or `'full'`) is used for cache keys, `refineToDivergencePointIfMixed`, and debug output, but not for the ascend-loop branching check.

### Does it use `resolveCached` / `isSameHost`?

- **`resolveCached`** is used when building `info.id` and `nearbyId` via `getDetailedIdSync` (which uses `resolveCached` when available).
- **`isSameHost`** is not used; comparison is via `equalsByMode` using `getHostFromDetailedId` and `normalizeHostname` (or `rootDomain` for domain mode).

---

## 3. URL Extraction Sources

### How `nearbyId` (reference URL) is finalized

1. **`findNearbyDiscoverySource(targetEl, preResolved, intentOptions)`** (containerExtractor.js:579–682)
   - Finds the nearest visible DISCOVERY anchor (direct ancestor, or via `findNearestDiscoveryAnchorInScope`).
   - Returns `{ sourceEl, href, id, intent }` where `id` comes from `isDiscoveryHref(href, preResolved, intentOptions).id`.

2. **`id`** is produced by **`getDetailedIdSync(rawHref, preResolved)`**:
   - `preResolved.get(raw)` if provided
   - else `resolveCached(raw)` if cached
   - else mined/cleaned raw URL

3. **`nearbyId = nearby.id`** (containerExtractor.js:2047) — used as the reference for the ascend loop.

### How `otherUrl` (info.id) is collected

Inside **`scanDiscoveryBranchingIn`** (containerExtractor.js:1846–1879):

```javascript
const anchors = container.querySelectorAll('a[href]');
for (const a of anchors) {
  if (!visible) continue;
  if (!href) continue;
  const info = isDiscoveryHref(href, preResolved);  // Uses getDetailedIdSync internally
  if (!info.ok) continue;  // Skip non-DISCOVERY
  any = true;
  if (!equalsByMode(info.id, nearbyId, compareMode)) {
    return { hasDifferent: true, mismatchId: info.id, ... };
  }
}
```

- **Aggregation:** Iterates over all `a[href]` in the container.
- **First mismatch wins:** As soon as a visible DISCOVERY anchor has `info.id` different from `nearbyId` (per `compareMode`), it returns `hasDifferent: true` with `mismatchId: info.id`.
- **Order:** DOM order; no special prioritization.

---

## 4. Termination Trigger

### Is `hasDifferent: true` the primary reason the loop stops?

Yes. When `scan.hasDifferent` is true, the loop stops and returns:

```javascript
// containerExtractor.js:2229–2278
if (scan.hasDifferent) {
  // ... telemetry ...
  const candidate = refineToDivergencePointIfMixed(curr, nearby.sourceEl, nearbyId, preResolved, compareMode, traceElDesc);
  if (candidate && candidate.contains(nearby.sourceEl)) {
    return finalize(candidate, 'branching-point', ...);  // Return refined candidate
  }
  if (debugOut) debugOut.reason = 'branching-point-no-candidate';
  return null;  // Failed: no valid divergence child
}
```

### Behavior when a mismatch is found

1. **Stop at `curr`** — `curr` is the LCA where a different DISCOVERY URL appears.
2. **Refine** — `refineToDivergencePointIfMixed` narrows to the direct child of `curr` that contains the nearby anchor (divergence point child).
3. **Return** — If that child exists and contains the nearby anchor, return it; otherwise return `null`.

The previous container (`prev`) is not returned; the system returns either the refined divergence child or `null`.

---

## 5. Code Snippet: `hasDifferent` Logic

```javascript
// containerExtractor.js:1824–1888
function scanDiscoveryBranchingIn(container, preResolved, nearbyId, compareMode) {
  if (!container || !nearbyId) return { hasDifferent: false, ... };

  const anchors = container.querySelectorAll('a[href]');
  let any = false;

  for (const a of anchors) {
    if (!isVisibleForScan(a)) continue;
    const href = getHrefFromAnchor(a);
    if (!href) continue;

    const info = isDiscoveryHref(href, preResolved);  // id = getDetailedIdSync + getUrlIntent
    if (!info.ok) continue;  // Not DISCOVERY
    any = true;

    // THE COMPARISON: different identity under compareMode => hasDifferent
    if (!equalsByMode(info.id, nearbyId, compareMode)) {
      return {
        hasDifferent: true,
        anyDiscovery: any,
        mismatchId: info.id,
        nearbyId,
        mode: compareMode,
        mismatchHref: href,
        mismatchWasResolved: !!resolveCached(href, { baseUrl: window.location.href }),
      };
    }
  }

  return { hasDifferent: false, anyDiscovery: any, ... };
}
```

---

## 6. Mismatch Threshold

### Does a different subdomain trigger `hasDifferent: true`?

Yes. The ascend loop uses **`'host'`** mode:

| Scenario | Mode | `hasDifferent` |
|----------|------|----------------|
| `google.com` vs `example.com` | host | `true` |
| `www.google.com` vs `google.com` | host | `true` (different hostnames) |
| `gemini.google.com` vs `google.com` | host | `true` |
| `example.com/page1` vs `example.com/page2` | host | `false` (same host) |
| `example.com` vs `example.com` | host | `false` |

### `normalizeHostname` (host mode)

- Lowercases hostname
- Strips leading `www.`
- Does not collapse subdomains (e.g. `gemini.google.com` stays distinct from `google.com`)

### Summary

- **`hasDifferent: true`** when the container has at least one visible DISCOVERY anchor whose identity differs from `nearbyId` under the given mode.
- **Ascend loop** uses `'host'` mode, so different subdomains (e.g. `gemini.google.com` vs `google.com`) trigger `hasDifferent: true`.
- **Main-Process** uses `compareMode: 'domain'` for cache/refinement, but the ascend loop always uses `'host'` for branching detection.
