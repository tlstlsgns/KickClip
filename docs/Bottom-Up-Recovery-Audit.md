# Bottom-Up Recovery and Anchor Climbing Logic: Technical Audit

Step-by-step map of `runBottomUpAnchorRecovery` and why it tends to select large article wrappers for scattered reference links.

---

## 1. Initial Trigger

### Anchor Criteria (All Must Pass)

| Check | Implementation | Purpose |
|-------|----------------|---------|
| **1. Valid element** | `anchor.nodeType === 1` | Must be a DOM element |
| **2. Not claimed** | `!isClaimed(anchor)` | Anchor not already inside a top-down or sibling-recovered ItemMap |
| **3. Type A signal** | `isValidTypeAAnchor(anchor)` | Absolute URL or relative with valid-sized img |
| **4. Resolvable URL** | `resolveAnchorUrl(anchor)` returns truthy | Must resolve to a valid URL |
| **5. HTTP(S) protocol** | `u.protocol` is `http:` or `https:` | Excludes `mailto:`, `javascript:`, etc. |
| **6. External domain** | `anchorBase !== currentBase` | Link must point to a different base domain than current page |
| **7. Cross-service** | `currentService !== anchorService` (or either < 3 chars) | Avoid same-service links (e.g. pinterest.com → pinimg.com) |

### `isClaimed` Logic

```javascript
const isClaimed = (el) => {
  for (const item of existingItems || []) {
    const container = item?.element;
    if (container && (container === el || container.contains(el))) return true;
  }
  return false;
};
```

An anchor is claimed if it is **inside** any container from `existingItems` (top-down + sibling recovery). Bottom-up runs **after** top-down, so it only processes anchors not yet covered.

### Trigger Summary

Bottom-up runs for anchors that:
- Pass `isValidTypeAAnchor`
- Resolve to an external HTTP(S) URL
- Are not inside any existing ItemMap container

---

## 2. Climbing Process (Parent Selection)

### Algorithm

```javascript
let candidate = anchor;
let current = anchor;
while (current && current !== document.body) {
  const parent = current.parentElement;
  if (!parent) break;
  // ... break conditions ...
  candidate = parent;   // Promote parent as new candidate
  current = parent;    // Continue climbing from parent
}
```

### Per-Step Logic

1. **Start:** `candidate = anchor`, `current = anchor`
2. **Loop:** `parent = current.parentElement`
3. **Break conditions** (see Section 3)
4. **Promote:** `candidate = parent`, `current = parent`
5. **Repeat** until a break condition or `document.body`

### Wrapper vs Container

There is **no** special handling for "wrapper" divs. The logic:

- Climbs one parent per step
- Stops only at layout boundaries, claimed elements, or other break conditions
- Does not skip elements by tag, class, or structure
- Does not prefer "semantic" containers (e.g. `article`, `section`)

So a chain like `a → li → ul → div → span#topic_contents → div → main` will climb through every level until it hits a layout boundary. The last non-boundary ancestor becomes the candidate.

---

## 3. Termination Criteria (Stop-Line)

### Break Conditions (In Order)

| Condition | Effect |
|-----------|--------|
| `!parent` | No parent → stop |
| `parent.matches('a[href]')` and `parentUrl !== url` | Parent is a different link → stop (avoid climbing into another anchor) |
| `existingEls.has(parent)` | Parent is an existing ItemMap element → stop |
| `isClaimed(parent)` | Parent is inside an existing ItemMap → stop |
| `isLayoutBoundary(parent)` | Parent is a layout boundary → stop |

### `isLayoutBoundary` Definition

```javascript
function isLayoutBoundary(el) {
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'BODY') return true;
  if (tag === 'MAIN') return true;
  if (el.getAttribute?.('role') === 'main') return true;
  const r = el.getBoundingClientRect?.();
  if (r && window?.innerWidth && window?.innerHeight) {
    const vw = Math.max(1, Number(window.innerWidth) || 0);
    const vh = Math.max(1, Number(window.innerHeight) || 0);
    if (r.width >= vw * 0.7 || r.height >= vh * 0.7) return true;
  }
  return false;
}
```

### Layout Boundary Conditions

| Type | Condition |
|------|-----------|
| **Tag** | `BODY`, `MAIN` |
| **Role** | `role="main"` |
| **Viewport size** | `width >= 70%` viewport **or** `height >= 70%` viewport |

### Not Treated as Boundaries

- `ARTICLE` — not checked
- `SECTION` — not checked
- `overflow`, `display`, `flex` — not checked
- Any other CSS — not checked

### Implication for Editorial Content

If the structure is `main > div > span#topic_contents > ...`:
- Climb stops at `main` (layout boundary)
- `candidate` = direct child of `main` (e.g. `div` or `span#topic_contents`)
- That element can cover the whole article

If `main` is absent and the article wrapper is &lt; 70% viewport:
- No layout boundary is hit
- Climb can continue to `body`
- `candidate` = direct child of `body` (possibly the whole page wrapper)

---

## 4. Candidate Validation for Single Elements

### Post-Climb Checks

| Check | Implementation |
|-------|----------------|
| **Seen** | `!seenContainers.has(candidate)` |
| **Visible** | `isVisibleAndSized(candidate)` — not hidden, ≥40×40 px |
| **Meaningful** | `isMeaningfulItemMap([candidate], EVIDENCE_TYPE_ANCHOR)` |

### No Size or Anchor-Density Checks

There is **no** check that:
- The container is "too large"
- The container is "too text-heavy"
- The anchor-to-container ratio is sufficient
- The container has a minimum number of anchors

### `isMeaningfulItemMap([candidate])` for Single Element

For `elements = [candidate]`:
- `richCount >= ceil(1 * 0.4) = 1` → one rich element passes
- `getTextLen(candidate) > 20` or `hasMultipleTextBlocks(candidate)` → typical for article bodies
- Early exit → `avgAnchors` and `hasValidTypeASignal` are never evaluated

So large editorial blocks pass solely via the richCount rule.

---

## 5. Merging and Deduplication

### Within `runBottomUpAnchorRecovery`

```javascript
const seenContainers = new Set();
// ...
if (seenContainers.has(candidate)) continue;
// ... after successful validation ...
seenContainers.add(candidate);
recovered.push({ ... });
```

- Multiple anchors can climb to the same container
- Each candidate is only added once (via `seenContainers`)
- First anchor that reaches a container adds it; later anchors for the same container are skipped

### After Merge with Top-Down

```javascript
let merged = [...expandedFiltered, ...bottomUpRecovered, ...fallbackItems];
const dedupMergedByEl = new Map();
for (const item of merged) {
  const el = item?.element;
  if (!el || dedupMergedByEl.has(el)) continue;
  dedupMergedByEl.set(el, item);
}
merged = Array.from(dedupMergedByEl.values());
```

- Deduplication is by element reference
- First occurrence wins (order: expandedFiltered, then bottomUpRecovered, then fallback)

If a container is already in `expandedFiltered`, it will not be added again from bottom-up. If it appears only from bottom-up, it is added once regardless of how many anchors climbed to it.

---

## Flow Summary

```
1. Get all anchors: root.querySelectorAll('a[href]')
2. For each anchor:
   a. Skip if claimed (inside existing ItemMap)
   b. Skip if !isValidTypeAAnchor
   c. Skip if !resolveAnchorUrl || !http(s) || same-domain || same-service
   d. Climb: candidate = anchor, current = anchor
   e. While current != body:
      - parent = current.parentElement
      - Break if: no parent; parent is different <a>; parent in existingEls; isClaimed(parent); isLayoutBoundary(parent)
      - candidate = parent, current = parent
   f. Skip if seenContainers.has(candidate)
   g. Skip if !isVisibleAndSized(candidate)
   h. Skip if !isMeaningfulItemMap([candidate])
   i. seenContainers.add(candidate), push to recovered
3. Return recovered
```

---

## Why Large Editorial Blocks Are Selected

| Factor | Effect |
|--------|--------|
| **No ARTICLE boundary** | Climb does not stop at `<article>` |
| **Layout boundary = main/body** | Stops at main or 70% viewport; candidate = direct child of main |
| **No anchor-density check** | `isMeaningfulItemMap` never checks `avgAnchors` when richCount passes |
| **richCount early exit** | Single-element container with long text passes |
| **No size cap** | No limit on how large the candidate can be |
| **No wrapper skipping** | No logic to prefer smaller, more specific containers |

---

## Recommended Mitigations

1. **Add ARTICLE as layout boundary:** Treat `ARTICLE` and `[role="article"]` as layout boundaries so climbing stops before the article wrapper.
2. **Anchor-density check for single elements:** For `elements.length === 1`, require `anchorCount >= 2` (or similar) before accepting.
3. **Disable richCount early exit for single elements:** Require `elements.length > 1` before using the richCount rule.
4. **Container size cap:** Reject candidates whose area exceeds a threshold (e.g. 50% viewport).
5. **Anchor-to-text ratio:** Reject candidates where `anchorCount / textLen` is below a minimum (e.g. 1 anchor per 500 chars).
