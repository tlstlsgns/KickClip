# False Positive Type A ItemMap in Editorial Content: Diagnostic Report

## Scenario

- **Container:** `<span id="topic_contents">` (or equivalent article body wrapper)
- **Structure:** Multiple `<ul>`, `<li>` blocks separated by `<h2>`, `<hr>`
- **Links:** Scattered reference links (e.g. X.com, TechCrunch) — only 2–3 among many list items
- **Symptom:** Entire article body highlighted as a single "Content Item List"

---

## 1. Detection Seed: Top-Down Path (Unlikely)

### Which 3+ Siblings Would Trigger Detection?

For top-down detection, the system requires:
- A parent with **≥3 direct children**
- A run of **≥3 consecutive siblings** with matching identity, structure, and evidence type
- Each sibling must have `getEvidenceType === EVIDENCE_TYPE_ANCHOR` (i.e. `hasValidAbsoluteAnchor`)

**Structure under `#topic_contents`:**
- Children might be: `ul`, `h2`, `hr`, `ul`, `p`, etc.
- `INTERRUPTION_TAGS` = `SPAN`, `HR`, `BR`, `SCRIPT` — `HR` is **skipped** (not broken), but `H2` is **not** skipped.

**Run formation:**
- `ul` vs `h2`: different tags → `isSimilarIdentity` fails → run breaks
- So a run cannot span across `ul` → `h2` → `ul`

**If parent is `<ul>` (children = `<li>`):**
- Run extends only while each consecutive `li` has `hasValidAbsoluteAnchor`
- First `li` without a valid anchor breaks the run
- With scattered links, runs would be short (1–3 items)
- `minGroupSize = 3` → need 3 consecutive `li` with links

**Conclusion:** Top-down detection is unlikely to produce a single large ItemMap for this structure. Runs would be short or broken by `h2`/different tags.

---

## 2. Expansion and Harvesting: Bridging Across Lists

### Wrapper Bypass and Sibling Matching

**Type A sibling recovery** only considers siblings under the **same parent** (or parent’s parent when the parent is a simple wrapper). It does **not** bridge across different `<ul>` blocks that are separated by `h2`/`hr` at the same level.

**Why bridging does not occur:**
- Siblings of a seed `ul` are `h2`, `hr`, another `ul`, etc.
- `hasPartialClassOverlap(ul, h2)` fails (different tags)
- Sibling recovery adds only same-tag elements with class overlap
- Different `ul` blocks are not merged into one run by sibling recovery

**Conclusion:** The false positive is **not** from top-down expansion bridging separate lists. Sibling recovery stays within one logical list.

---

## 3. Validation Thresholds: Why `isMeaningfulItemMap` Passes

### Early Exit via `richCount`

```javascript
const richCount = elements.filter((el) =>
  hasImageAndText(el) || hasMultipleTextBlocks(el) || getTextLen(el) > 20
).length;
if (richCount >= Math.ceil(elements.length * 0.4)) return true;  // ← EARLY PASS
```

When `elements = [topic_contents]` (single container from bottom-up):
- `elements.length = 1`
- `richCount >= ceil(1 × 0.4) = 1` → **immediate return true**
- The `avgAnchors >= 1` and `hasValidTypeASignal` checks are **never reached**

### How `richCount = 1` for Editorial Content

| Condition | `#topic_contents` (article body) |
|-----------|-----------------------------------|
| `getTextLen(el) > 20` | ✅ Long article text |
| `hasMultipleTextBlocks(el)` | ✅ Many `p`, `li`, `span`, `div` with ≥6 chars |
| `hasImageAndText(el)` | Possibly (image + heading/text) |

At least one of these is true, so `richCount = 1` and the early pass triggers.

### Why `avgAnchors` Is Never Checked

For a **single-element** call `isMeaningfulItemMap([container])`:
- `avgAnchors` = `anchorCount` of that element (e.g. 2–3 valid anchors)
- But the `avgAnchors < 1` check is only evaluated **after** the `richCount` early exit
- Because `richCount >= 40%` passes first, the anchor-density logic is skipped

**Conclusion:** Editorial content passes because of the `richCount >= 40%` early exit, which bypasses anchor-density checks for single large containers.

---

## 4. Bottom-Up Recovery: Primary Cause

### Flow

1. `runBottomUpAnchorRecovery` scans `root.querySelectorAll('a[href]')`
2. For each anchor: `isValidTypeAAnchor(anchor)` and `resolveAnchorUrl` (external, etc.)
3. From the anchor, climb up the DOM until:
   - `isLayoutBoundary(parent)` (BODY, MAIN, role=main, or ≥70% viewport), or
   - `isClaimed(parent)`, or
   - `existingEls.has(parent)`
4. The last non-boundary ancestor becomes the **candidate container**
5. `isMeaningfulItemMap([candidate])` is called
6. If it passes, the candidate is added as an ItemMap entry

### For X.com / TechCrunch Links

- Anchor path: `a` → `li` → `ul` → `div` → `span#topic_contents` → `div` → `main` (or similar)
- Climb stops at `main` (or other layout boundary)
- `candidate` = direct child of `main`, e.g. `div` wrapping `#topic_contents`, or `#topic_contents` itself
- That element encompasses the whole article body

### Why `isMeaningfulItemMap([candidate])` Passes

- `elements = [candidate]` (single element)
- `richCount` = 1 (long text and/or multiple blocks)
- `richCount >= ceil(1 × 0.4) = 1` → **return true**
- No check of anchor density or signal ratio

**Conclusion:** The false positive is driven by **bottom-up recovery**: a valid external link is found, the climb stops at a layout boundary, and the chosen container (article body) passes `isMeaningfulItemMap` via the `richCount` early exit.

---

## Root Cause Summary

| Factor | Role |
|--------|------|
| **Bottom-up recovery** | Finds scattered external links and climbs to a large ancestor |
| **Layout boundary** | Stops at `main`/article, so the candidate is the article wrapper |
| **`richCount` early exit** | For a single-element container, `richCount >= 40%` is trivially true |
| **No anchor-density check** | `avgAnchors >= 1` is never evaluated when `richCount` passes first |
| **Single-element case** | `ceil(1 × 0.4) = 1` makes the 40% threshold trivial for one element |

---

## Recommended Mitigations

1. **Single-element guard for `richCount`:**  
   Require `elements.length > 1` before using the `richCount >= 40%` early pass, so single large containers still go through anchor checks.

2. **Editorial-content heuristic:**  
   Reject containers that look like article bodies (e.g. many `p`, `h2`, `ul`, `li`, high text-to-anchor ratio) unless they also meet anchor-density rules.

3. **Minimum anchor ratio for single elements:**  
   For `elements.length === 1`, require `anchorCount >= 2` (or similar) before accepting, to avoid treating whole articles as ItemMaps based on a few reference links.

4. **Layout-boundary refinement:**  
   Consider `article` or `[role="article"]` as layout boundaries so climbing stops earlier and does not select the full article wrapper.
