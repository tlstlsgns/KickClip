# Sibling Expansion and Global Pattern Matching: Architectural Audit

This document describes how a detected ItemMap expands to include missed siblings and structurally similar elements across the page. **Note:** There is no `itemHarvester.js`; all logic lives in `itemDetector.js` within `detectItemMaps`.

---

## Overview: Post-Detection Phases

| Phase | Scope | Evidence Type | Purpose |
|-------|-------|---------------|---------|
| **1. Comprehensive Sibling Recovery** | Same parent (or parent's parent) | Type A, Type B | Swallow missed siblings into existing ItemMap |
| **2. Type B Global Expansion** | Scope root (main, feed, section) | Type B only | Find identical tag+class matches elsewhere in feed |
| **3. Bottom-Up Anchor Recovery** | Document-wide | Type A | Claim unclaimed valid anchors and find their containers |
| **4. Facebook Fallback** | Document-wide | Type A | Add FeedUnit_* when Type B not hydrated |
| **5. Merge & Deduplication** | — | — | Dedupe by element, suppress A-inside-B |

---

## 1. Comprehensive Sibling Matching (Local Expansion)

### When It Runs

After initial `detectItemMaps` produces `deduped` candidates, the system iterates over **Type A seeds** and expands each seed's ItemMap by including missed siblings within the same parent container.

### Expansion Roots

For each Type A seed:

1. **Direct parent:** `parent = seedEl.parentElement` → siblings = `parent.children`
2. **Wrapper bypass (optional):** If `parent` is a "simple wrapper" (DIV/SPAN, no id, only `style-scope`-like classes, no data-*/aria-* attrs), also expand from `parent.parentElement` → includes siblings of the wrapper

**Visit deduplication:** `visitedParentTag` prevents re-processing the same root: key = `seedTag::childCount::direct|wrapper-bypass` + root's `dataset.viewName` or `id` or `className`.

### Sibling Inclusion Criteria (Type A)

A sibling is **swallowed** if ALL of the following hold:

| Criterion | Check |
|-----------|-------|
| **Same parent** | Sibling is a direct child of `root` (parent or grandparent) |
| **Not already recovered** | `!recoveredSet.has(sibling)` |
| **Visible and sized** | `isVisibleAndSized(sibling)` (≥40×40 px, not hidden) |
| **Partial class overlap** | `hasPartialClassOverlap(seedEl, sibling)` |
| **Evidence type** | `getEvidenceType(sibling) === EVIDENCE_TYPE_ANCHOR` |
| **Type A signal** | For non-iframe: must pass `getEvidenceType` (implies `hasValidAbsoluteAnchor`). For iframe: `iframeHasValidTypeASignal(sibling)` |

### `hasPartialClassOverlap` (Relaxed vs. `isSimilarIdentity`)

**Relaxed:** Only **one shared class token** is required.

| `isSimilarIdentity` (initial detection) | `hasPartialClassOverlap` (sibling recovery) |
|----------------------------------------|-------------------------------------------|
| 80% class overlap (Jaccard-style) | At least 1 shared token |
| Same tag required | Same tag required |
| Used for run formation | Used for sibling expansion |

**Implementation:**
```javascript
// hasPartialClassOverlap: seedTag === candTag, and at least one class token in common
for (const t of seedSet) {
  if (candSet.has(t)) return true;
}
return false;
```

**Conclusion:** Sibling expansion uses a **relaxed** criterion (any class overlap) compared to initial detection (80% overlap).

---

## 2. Global Tag/Pattern Inclusion (Global Harvesting)

### Type A: No Global Harvesting

**Type A does NOT search outside the immediate parent.** Expansion is strictly local:
- Siblings within `parent.children`
- Optionally siblings within `parent.parentElement.children` when parent is a simple wrapper

There is no `querySelectorAll` over the document for Type A patterns.

### Type B: Scope-Based Global Expansion

**`expandTypeBByExactSiblingMatching`** searches within a **scope root**, not the whole document.

| Step | Logic |
|------|-------|
| **Scope root** | `getScopeRoot(seedEl)` = `seedEl.closest(PROXIMITY_ROOT_SELECTOR)` or `closest('section,article,div')` or `document` |
| **PROXIMITY_ROOT_SELECTOR** | `shreddit-feed`, `main`, `[role="main"]`, `div[data-testid*="feed"]`, `div[data-view-name*="feed"]`, `div[slot="posts"]` |
| **Query** | `scopeRoot.querySelectorAll(seedTag)` + `TYPE_B_CROSS_TAG_EXCEPTIONS` (e.g. `shreddit-ad-post`) |
| **Proximity** | `isReasonablyProximate(seedEl, cand, scopeRoot)` — both must share the same feed/main root |

**Seed pattern:** `seedTag` + `seedClass` (normalized). Candidate must have **exact** `candTag === seedTag` and `candClass === seedClass`.

**Additional Type B filters:**
- `hasShareButtonEvidence(cand)`
- Share depth within ±2 of seed
- `isVisibleAndSized(cand)`
- Not `isNearFullscreenCandidate(cand)`

**Conclusion:** Global harvesting exists **only for Type B**, and is scoped to feed/main-like containers. It does not search the entire DOM.

---

## 3. Validation of Expanded Items

### Type A Sibling Recovery

| Check | Applied? |
|-------|----------|
| `isValidTypeAAnchor` | **Indirect:** `getEvidenceType(sibling) === EVIDENCE_TYPE_ANCHOR` requires `hasValidAbsoluteAnchor(sibling)`, which uses `isValidTypeAAnchor` |
| Structural fingerprint | **No explicit hash.** Uses `hasPartialClassOverlap` (tag + ≥1 shared class) and `getEvidenceType` |
| `getInternalStructure` | Stored on recovered item but **not** used as a filter for inclusion |

**Iframe siblings:** Must pass `iframeHasValidTypeASignal` (same-origin anchors with `isValidTypeAAnchor`, or valid iframe `src`).

**Conclusion:** Type A siblings are accepted based on **structural similarity** (tag + class overlap) and **evidence type** (which implies a valid Type A anchor). There is no separate re-validation with `isValidTypeAAnchor` on the sibling itself for non-iframe elements; `getEvidenceType` does that internally.

### Type B Global Expansion

| Check | Applied? |
|-------|----------|
| Exact tag + class match | Yes |
| `hasShareButtonEvidence` | Yes |
| Share depth ±2 | Yes |
| `isVisibleAndSized` | Yes |
| Proximity (same scope root) | Yes |

**Conclusion:** Type B expansion relies on **exact structural match** (tag + class) and share-button evidence. No `isValidTypeAAnchor` (Type B uses interaction evidence, not anchors).

### Bottom-Up Recovery

| Check | Applied? |
|-------|----------|
| `isValidTypeAAnchor(anchor)` | **Yes** — each anchor is validated before climbing |
| `isMeaningfulItemMap([candidate])` | **Yes** — container must pass full ItemMap validation |
| Structural fingerprint | **No** — climbs from anchor to container, no pattern matching |

---

## 4. Merging Logic

### Merge Order

```
merged = [...expandedFiltered, ...bottomUpRecovered, ...fallbackItems]
```

1. **expandedFiltered** = deduped initial + Type A sibling recovery + Type B global expansion
2. **bottomUpRecovered** = unclaimed anchors → containers via `runBottomUpAnchorRecovery`
3. **fallbackItems** = `detectFacebookFallback` (Facebook FeedUnit_*)

### Deduplication

```javascript
const dedupMergedByEl = new Map();
for (const item of merged) {
  const el = item?.element;
  if (!el || dedupMergedByEl.has(el)) continue;
  dedupMergedByEl.set(el, item);
}
merged = Array.from(dedupMergedByEl.values());
```

**First-wins:** If the same element appears in multiple sources, the first occurrence is kept.

### Over-Harvesting Prevention

| Mechanism | Purpose |
|-----------|---------|
| **A-inside-B suppression** | Type A items inside a Type B container are removed. Type B is treated as the primary container. |
| **Proximity scope (Type B)** | `PROXIMITY_ROOT_SELECTOR` limits Type B expansion to feed/main, not footer or sidebar |
| **isLayoutBoundary (bottom-up)** | Stops climbing at BODY, MAIN, role=main, or elements ≥70% viewport — prevents claiming footer/sidebar as containers |
| **isClaimed** | Bottom-up skips anchors already inside existing ItemMap containers |
| **visitedParentTag (Type A)** | Prevents re-processing the same parent with the same seed |
| **primaryBItems filter** | Type B: excludes near-fullscreen items, excludes items contained by another Type B |

### Fragment Merging

**No explicit "merge fragmented ItemMaps" step.** Each seed produces its own recovered set; the final list is the union of all recovered items, deduplicated by element. Items from different seeds that point to the same element are collapsed to one entry.

### `getItemMapFingerprint`

Used for **change detection** (e.g. in `coreEntry.js`), not for merging:

```javascript
// Format: "count:identity::structure::evidenceType@tag:similarityType|..."
const keys = items.map(x =>
  `${x.identitySignature}::${x.structureSignature}::${x.evidenceType}@${x.element?.tagName}:${x.similarityType}`
).sort();
return `${items.length}:${keys.slice(0, 50).join('|')}`;
```

When the fingerprint is unchanged, the system skips re-rendering.

---

## Summary: Seed → Full Coverage Flow

```
1. detectItemMaps produces initial candidates (min 3 similar siblings, strict identity/structure)
2. Type A sibling recovery: for each seed, add siblings with hasPartialClassOverlap + getEvidenceType
   - Scope: same parent (or parent's parent if simple wrapper)
   - Criterion: relaxed (1 shared class)
3. Type B global expansion: querySelectorAll(seedTag) within scope root
   - Scope: main, feed, section, etc.
   - Criterion: exact tag+class + share evidence + depth ±2
4. Bottom-up: find unclaimed isValidTypeAAnchor, climb to container, validate with isMeaningfulItemMap
5. Facebook fallback: add FeedUnit_* if applicable
6. Merge: concatenate, dedupe by element, suppress A-inside-B
```

**Key distinction:** Type A expansion is **local** (siblings only). Type B expansion is **scope-based** (within feed/main). There is no document-wide "find all elements matching seed pattern" for Type A.
