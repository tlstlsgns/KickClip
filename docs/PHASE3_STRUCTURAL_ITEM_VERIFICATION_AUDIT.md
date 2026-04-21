# Technical Deep-Dive: Phase3-Structural-Item Verification Failure

## 1. Definition & Mapping

### Where is "Phase3-structural-item" defined?

The string **`Phase3-Structural-Item`** (displayed as `Phase3-structural-item` when lowercased) is **not** a verification status constant. It is the **`source`** field in the debug tooltip, set when the Phase 3 Structural Rescue path runs.

| Location | Role |
|----------|------|
| **main.js:1786** | `debugInfo.source: 'Phase3-Structural-Item'` — identifies the tooltip as coming from the Phase 3 structural-item path |
| **main.js:472–486** | `__blinkMapFinalItemVerification()` — maps `finalItemPath` + `finalItemVerification` + `reason` to the displayed label |

### Mapping to verification status

When **`finalItemVerification === 'Failed'`**, the mapping returns:

```javascript
return `Fail: ${reason || finalItemPath || 'unknown'}`;
```

When the tooltip is built for the Phase 3 structural path, `reason` is derived from `debugInfo.source` (which is `'Phase3-Structural-Item'`). So the displayed label becomes:

- **`Fail: Phase3-Structural-Item`** (or `Phase3-structural-item` depending on display)

So **"Phase3-structural-item"** in the tooltip means:

- The **Phase 3 Structural Rescue** path ran (a container was found).
- **`finalItemVerification === 'Failed'`** — the structural verification failed.

---

## 2. Trigger Conditions

### What causes `finalItemVerification: 'Failed'`?

The failure comes from the **Host Purity Check** in `hoverDetector.js`:

```javascript
// hoverDetector.js ~2620–2625 (Main/Retry path)
// hoverDetector.js ~2359–2361 (Phase B path)
const hostCount = countDiscoveryHostsIn(finalItemEl, 36);
verifyOk = hostCount <= 1;
// ...
const finalItemVerification = verifyOk ? 'Succeeded' : 'Failed';
```

**Condition:** `hostCount > 1` → `verifyOk = false` → `finalItemVerification = 'Failed'`.

### Host Purity Check (Host Count)

| File | Function | Logic |
|------|----------|-------|
| **hoverDetector.js:2485–2510** | `countDiscoveryHostsIn(container, cap)` | Counts distinct hostnames among visible `a[href]` anchors whose intent is `DISCOVERY` |
| **hoverDetector.js:2623** | Main/Retry path | `hostCount = countDiscoveryHostsIn(finalCandidate.item, 36)` |
| **hoverDetector.js:2360** | Phase B path | `hostCount = countDiscoveryHostsIn(finalItemEl, 36)` |

**Failure:** The container has anchors from **2 or more different hosts** with DISCOVERY intent.

### Does it involve other checks?

The Phase3-structural-item failure is driven by the Host Purity Check. Other checks can also set `finalItemVerification: 'Failed'` but with different labels:

| Reason | finalItemPath | When |
|--------|---------------|------|
| **Host Purity** (`hostCount > 1`) | Main-Process, Retry-Process, Phase-B-Override | Container has 2+ discovery hosts |
| **Container Oversize** | Main-Process (Container Oversize) | `__blinkIsViewportSizedContainer(finalItem)` |
| **Menu-Tab** | `... (Menu-Tab Rejected)` | `__isMenuTab()` returns true |
| **Intent** | Phase-B-Main (Rejected), etc. | `getUrlIntent().group !== 'DISCOVERY'` |

When the tooltip shows **"Phase3-structural-item"**, it is because:

1. The Phase 3 structural path ran (container exists).
2. `source` is set to `'Phase3-Structural-Item'`.
3. `finalItemVerification` is `'Failed'` (usually from `hostCount > 1`).
4. The mapping uses `reason = source` → `Fail: Phase3-Structural-Item`.

---

## 3. Code Logic Trace

### Functions involved

| Function | File | Role |
|----------|------|------|
| `countDiscoveryHostsIn(container, cap)` | hoverDetector.js:2485–2510 | Counts distinct DISCOVERY hosts in container |
| `resolveHoverAndItemRootSync()` | hoverDetector.js | Returns `finalItemVerification`, `finalItemPath`, `itemRootContainer` |
| `__blinkMapFinalItemVerification()` | main.js:472–486 | Maps to display label |
| `__blinkBuildStructuredDebug()` | main.js:547–576 | Builds `debugInfo` including `finalItemVerificationLabel` |

### Conditional block for Host Purity failure

**Main/Retry path (hoverDetector.js:2619–2635):**

```javascript
// Phase 4 verification: final must be single-domain (DISCOVERY only).
let verifyOk = false;
if (finalCandidate && finalCandidate.item) {
  const hostCount = countDiscoveryHostsIn(finalCandidate.item, 36);
  verifyOk = hostCount <= 1;
}
// ...
const finalItemVerification = verifyOk ? 'Succeeded' : 'Failed';
```

**Phase B path (hoverDetector.js:2359–2368):**

```javascript
const hostCount = countDiscoveryHostsIn(finalItemEl, 36);
const verifyOk = hostCount <= 1;
// ...
const phaseBVerification = phaseBFinalPending ? 'Pending' : (verifyOk ? 'Succeeded' : 'Failed');
```

### `countDiscoveryHostsIn` logic

```javascript
// hoverDetector.js:2485–2510
const countDiscoveryHostsIn = (container, cap = 36) => {
  const hosts = new Set();
  const anchors = container.querySelectorAll('a[href]');
  for (const a of anchors) {
    if (!__blinkIsVisibleForDecision(a)) continue;
    const href = getOriginalUrl(a) || (a.getAttribute('href') || a.href || '').trim();
    if (!href) continue;
    const intent = getUrlIntent(href, window.location.href);
    if (!intent || intent.group !== 'DISCOVERY') continue;  // Only DISCOVERY links
    const u = new URL(href, window.location.href);
    if (u.hostname) hosts.add(u.hostname.toLowerCase());
    if (hosts.size >= 2) break;  // Early exit
  }
  return hosts.size;
};
```

---

## 4. Phase B vs. Main-Process Context

### Does the failure differ for Phase B vs. Main?

The same Host Purity Check is used in both paths:

| Path | Container source | Host check |
|------|------------------|------------|
| **Main-Process** | `findItemRootContainer` (Main or Retry) | `countDiscoveryHostsIn(finalCandidate.item, 36)` |
| **Phase-B-Override** | Phase B container (when Main is parent of Phase B) | `countDiscoveryHostsIn(finalItemEl, 36)` |
| **Phase-B-Rescue** | Phase B container (Gate failed) | No host check; uses `__blinkResolveRescueDominantUrl` |

### Phase B Rescue vs. Phase B Main

- **Phase-B-Rescue (2-b):** Gate failed; Phase B is used as final item. No `countDiscoveryHostsIn` check; only intent and menu-tab checks.
- **Phase-B-Override (2-a):** Gate passed; Main found a container; Phase B is chosen when Main is parent of Phase B. Host Purity Check is applied to the Phase B container.

### Why Phase B can pass rescue but still show Phase3-structural-item failure

1. **Phase-B-Rescue** does not run the Host Purity Check, so it can pass even with multiple hosts.
2. **Phase-B-Override** does run the Host Purity Check on the Phase B container.
3. The tooltip with `source: 'Phase3-Structural-Item'` is shown from **main.js** when `itemRootContainer` exists, regardless of whether it came from Phase B or Main.
4. If `finalItemVerification` is `'Failed'` (e.g. `hostCount > 1`), the tooltip shows `Fail: Phase3-Structural-Item`.

So a Phase B item can pass its own rescue validation (intent + menu-tab) but still fail when the Phase B container is used in the Phase-B-Override path and has `hostCount > 1`.

---

## 5. Plain-English Summary

**"Phase3-structural-item" verification failure** means:

> A container was found and the Phase 3 Structural Rescue path ran, but the **Host Purity Check** failed: the container has links to **2 or more different hosts** that are classified as DISCOVERY. The system treats this as a layout or mixed-content wrapper, not a single content item, so it rejects the container.

---

## 6. DOM/URL Attributes That Trigger This Failure

| Attribute / Condition | Effect |
|----------------------|--------|
| **2+ distinct hostnames** among visible `a[href]` with DISCOVERY intent | `hostCount > 1` → Failed |
| **Mixed domains** (e.g. `example.com` + `other.com`) in the same container | Failed |
| **Subdomains** (e.g. `www.example.com` + `api.example.com`) | May count as 2 hosts (hostname-based) |
| **Sitelinks / related links** to different domains inside one result block | Failed |
| **Ad + organic mix** in one container | Failed if both are DISCOVERY |
| **Single host** | `hostCount <= 1` → Passed |

### Example scenarios

1. **Google Search result with sitelinks:** Main result links to `example.com`; sitelinks link to `example.com/page1`, `example.com/page2`, `other.com`. If both hosts have DISCOVERY intent → Failed.
2. **Card with “Related” section:** One card with links to `site-a.com` and `site-b.com` → Failed.
3. **Single-domain result:** All links go to `example.com` → Passed.
