# `richCount` Implementation Audit

Technical breakdown of the `richCount` calculation and its role in `isMeaningfulItemMap` validation.

---

## 1. Definition of "Rich" Element

### Formula

```javascript
const richCount = elements.filter((el) =>
  hasImageAndText(el) || hasMultipleTextBlocks(el) || getTextLen(el) > 20
).length;
```

An element is counted as "rich" if **any** of these three conditions is true:

| Condition | Implementation | Threshold |
|-----------|----------------|-----------|
| **A. `getTextLen(el) > 20`** | `normalizeText(el.textContent).length > 20` | **> 20 characters** (strictly greater) |
| **B. `hasMultipleTextBlocks(el)`** | See below | **≥ 2 blocks** with ≥ 6 chars each |
| **C. `hasImageAndText(el)`** | See below | Image + (heading OR text > 20) |

---

### A. `getTextLen(el) > 20`

```javascript
function getTextLen(el) {
  const t = normalizeText(el?.textContent || '');
  return t.length;
}
function normalizeText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}
```

- **Source:** `el.textContent` (all descendant text, concatenated)
- **Normalization:** Trim, collapse runs of whitespace to a single space
- **Threshold:** `> 20` characters (21+)
- **Effect:** Any element with more than 20 characters of text is rich

---

### B. `hasMultipleTextBlocks(el)`

```javascript
function hasMultipleTextBlocks(el) {
  const blocks = Array.from(el.querySelectorAll('p,li,span,div,small,strong,b,time,[data-price],[data-date],[data-category]'))
    .filter((n) => getTextLen(n) >= 6);
  return blocks.length >= 2;
}
```

**Block tags:** `p`, `li`, `span`, `div`, `small`, `strong`, `b`, `time`, `[data-price]`, `[data-date]`, `[data-category]`

**Block criteria:**
- Must match one of the selectors above
- Must have `getTextLen(n) >= 6` (≥ 6 characters after normalization)

**Rich condition:** At least **2** such blocks

**Example:** An article with 2+ `<li>` or `<p>` elements of 6+ chars each is rich.

---

### C. `hasImageAndText(el)`

```javascript
function hasImageAndText(el) {
  const hasImg = countMeaningfulVisuals(el) > 0;
  const hasHeading = !!el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],.title,[data-title]');
  const textLen = getTextLen(el);
  return hasImg && (hasHeading || textLen > 20);
}
```

**Requirements (all must hold):**
1. **Image:** `countMeaningfulVisuals(el) > 0` (at least one meaningful visual)
2. **Text:** Either:
   - `hasHeading` (h1–h6, `[role="heading"]`, `.title`, `[data-title]`), or
   - `textLen > 20`

**`countMeaningfulVisuals`** counts:
- `img`, `video`, `canvas` with `area > 1`
- `picture`
- `svg` with `width ≥ 64` and `height ≥ 64`
- `[style*="background-image"]` with `area > 5000`

---

## 2. Scoring and Weighting

### Binary Increment

- `richCount` is a **count** of elements that satisfy at least one rich condition.
- Each element contributes **0 or 1**; no weighting or depth scoring.
- Order of evaluation: `hasImageAndText` → `hasMultipleTextBlocks` → `getTextLen > 20` (short-circuit OR).

### Tag Handling

| Role | Tags |
|------|------|
| **Block tags (hasMultipleTextBlocks)** | `p`, `li`, `span`, `div`, `small`, `strong`, `b`, `time`, `[data-price]`, `[data-date]`, `[data-category]` |
| **Heading tags (hasImageAndText)** | `h1`–`h6`, `[role="heading"]`, `.title`, `[data-title]` |
| **Visual tags (countMeaningfulVisuals)** | `img`, `video`, `picture`, `canvas`, `svg`, `[style*="background-image"]`, `[role="img"]` |

No tags are explicitly ignored for richness; any element can be rich via `getTextLen(el) > 20`.

---

## 3. The 40% Threshold Rule

### Logic

```javascript
if (richCount >= Math.ceil(elements.length * 0.4)) return true;
```

**Interpretation:** At least 40% of elements must be rich (rounded up).

### Single-Element Case

| `elements.length` | `ceil(length * 0.4)` | Required `richCount` |
|-------------------|----------------------|----------------------|
| 1 | 1 | ≥ 1 |
| 2 | 1 | ≥ 1 |
| 3 | 2 | ≥ 2 |
| 5 | 2 | ≥ 2 |
| 10 | 4 | ≥ 4 |

For `elements.length === 1`:
- `ceil(1 * 0.4) = 1`
- If the single element is rich, `richCount = 1` → **pass**
- No minimum element count is enforced before this rule.

### Guards Before the 40% Rule

Checks that run **before** the richCount rule (lines 899–950):

1. `elements.length === 0` → return false
2. Type B early exit (2 elements, both with share evidence)
3. Nav/sidebar rejection
4. Action-bias rejection
5. Menu/tab rejection
6. Tiny footprint + nav rejection

There is **no** guard that requires `elements.length > 1` before applying the 40% rule.

---

## 4. Interaction with Anchor Signals

### Control Flow

```
1. [Nav/action/menu/tiny checks - may return false]
2. richCount = ...
3. if (richCount >= ceil(elements.length * 0.4)) return true;   ← EARLY EXIT
4. if (evidenceType === ANCHOR) {
     hasValidTypeASignal = ...
     if (!hasValidTypeASignal || avgAnchors < 1) return false;
     ...
   }
```

### Early Exit Behavior

When `richCount >= ceil(elements.length * 0.4)`:
- Function returns `true` immediately
- `hasValidTypeASignal` is **not** evaluated
- `avgAnchors` is **not** evaluated
- Anchor-related logic is skipped

### When Anchor Checks Run

Anchor checks run only if the richCount rule does **not** pass. So:
- Single-element container with `richCount = 1` → early exit, no anchor checks
- Multi-element container with `richCount < 40%` → anchor checks applied

---

## 5. Why Editorial Blocks Pass as Rich

| Factor | Effect |
|--------|--------|
| **`getTextLen(el) > 20`** | Article bodies easily exceed 20 chars |
| **`hasMultipleTextBlocks(el)`** | Many `p`, `li`, `span`, `div` with ≥ 6 chars |
| **Single-element container** | `ceil(1 * 0.4) = 1` → one rich element is enough |
| **Early exit** | `avgAnchors` and `hasValidTypeASignal` never run |

---

## Summary Table

| Question | Answer |
|----------|--------|
| Min chars for `getTextLen` rich? | **> 20** (21+) |
| Blocks for `hasMultipleTextBlocks`? | **≥ 2** blocks, each with **≥ 6** chars |
| `hasImageAndText` requirements? | Image + (heading OR text > 20) |
| `richCount` weighting? | Binary: 0 or 1 per element |
| Single-element pass? | Yes, if that element is rich |
| Minimum element guard? | No |
| Anchor checks when richCount passes? | No — early exit bypasses them |
