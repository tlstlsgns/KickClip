# Type A ItemMap Detection: Full Requirements Audit

This document provides a technical breakdown of all non-signal requirements that must be met for a container to be classified as a **Type A ItemMap**.

---

## 1. Repetition & List Detection

### Minimum Repeat Count

| Evidence Type | `minGroupSize` | Meaning |
|--------------|----------------|---------|
| **Type A** (Anchor) | **3** | At least 3 similar sibling elements required |
| **Type B** (Interaction) | **2** | At least 2 similar sibling elements required |

**Source:** `itemDetector.js` lines 1163–1165:
```javascript
const minGroupSize = evidenceType === EVIDENCE_TYPE_INTERACTION ? 2 : 3;
const list = Array.from(new Set(group.list || []));
if (list.length < minGroupSize) continue;
```

### Parent Container Requirement

- The parent must have **at least 3 direct children** to be considered for ItemMap detection.
- **Source:** Line 1073: `if (!parent || !parent.children || parent.children.length < 3) continue;`

### Run Formation Logic

A "run" of similar items is built by iterating siblings and extending the run while:
1. **Identity match:** `isSimilarIdentity(identitySig, nextIdentity, 0.8)` — class/attribute overlap ≥ 80%
2. **Evidence type match:** Same `getEvidenceType` (A or B)
3. **Structure match:** `getInternalStructure(cur, 3)` must exactly equal `structureSig` (for Type A)

---

## 2. Visual & Structural Consistency

### DOM Structure Comparison

- **Identity signature:** `getElementSignature(el)` — tag + normalized class tokens or `data-*` attributes.
- **Structure signature:** `getInternalStructure(el, 3)` — tag names of descendants up to depth 3, excluding volatile nodes (TIME, relative-date text, etc.).
- **Similarity threshold:** 80% class overlap (`isSimilarIdentity`). For nav-like items, 60% is allowed.

### Visual Layout Validation (`validateVisualLayout`)

**Requirement:** At least one of width or height must have **low variance** across items.

| Metric | Formula | Threshold |
|--------|---------|-----------|
| `getRelativeSpread(values)` | `(max - min) / mean` | ≤ 0.30 |
| `widthSpread` | Applied to `rects.map(r => r.width)` | ≤ 0.30 |
| `heightSpread` | Applied to `rects.map(r => r.height)` | ≤ 0.30 |

**Pass condition:** `widthSpread <= 0.30 || heightSpread <= 0.30`

Items in a list must have similar dimensions — either similar widths or similar heights.

### Structural Consistency Rules

- **Exact structure match** for Type A: `nextStructure === structureSig`
- **Volatile nodes ignored:** TIME, "Liked by author" badges, relative-date text
- **Structure-ignored tags:** `svg`, `path`, `rect`, `circle`, `button`, `script`, `style`

---

## 3. Density & Signal Metrics (`collectDeepContentStats`)

### Metrics Collected Per Element

| Metric | Definition |
|--------|------------|
| `textLen` | `getTextLen(el)` — trimmed text content length |
| `anchorCount` | Count of `<a href>` elements that pass `isValidTypeAAnchor` |
| `mediaCount` | Count of `img,video,picture,canvas` |
| `visualCount` | `countMeaningfulVisuals(el)` — img/video/canvas/picture/SVG/bg-image with size thresholds |
| `blockCount` | Count of `p,li,span,div,small,strong,b,time,[data-price],[data-date],[data-category]` with ≥6 chars text |

### Aggregated Averages

- `avgText` = mean of `textLen`
- `avgAnchors` = mean of `anchorCount`
- `avgMedia` = mean of `mediaCount`
- `avgVisual` = mean of `visualCount`

### Minimum Requirements (Type A)

| Metric | Minimum | Location |
|--------|---------|----------|
| `avgAnchors` | **≥ 1** | `isMeaningfulItemMap` line 958 |
| `hasValidTypeASignal` | At least one element with `hasValidAbsoluteAnchor(el)` | Line 957 |

**Note:** There is no explicit minimum for `avgText` or `avgVisual` in isolation; they participate in compound conditions (see Section 4).

---

## 4. Container Validation (`isMeaningfulItemMap`)

### Early Exit (Reject) Conditions

| Condition | Effect |
|-----------|--------|
| `elements.length === 0` or not array | Return `false` |
| `hardNavTinyCount >= ceil(n*0.4)` AND `avgVisual < 0.5` | Return `false` (nav-like tiny items) |
| `navConfidenceScore >= ceil(n*0.5)` AND `!hasStrongContentMajority` | Return `false` (navigation list) |
| `actionBiasCount >= ceil(n*0.6)` | Return `false` (icon-only menu items) |
| `highConfidenceMenuTab` AND `!hasStrongContentMajority` AND `avgVisual < 1` AND `avgText < 40` | Return `false` (menu/tab bar) |
| `isTinyFootprint` AND `avgVisual < 0.5` AND (nav/action signals) | Return `false` |
| **Type A:** `!hasValidTypeASignal` OR `avgAnchors < 1` | Return `false` |
| `avgText < 12` AND `richCount === 0` | Return `false` |

### Pass (Accept) Conditions

| Condition | Effect |
|-----------|--------|
| `richCount >= ceil(n*0.4)` | Return `true` (image+text or multiple blocks or long text) |
| **Type A:** `hasValidTypeASignal` AND `avgAnchors >= 1` AND `avgVisual >= 1` | Return `true` |
| `avgMedia >= 1` AND `avgText >= 8` | Return `true` |
| `avgText > 20` | Return `true` |

### Derived Counts

- **strongContentCount:** `textLen >= 40` AND `anchorCount >= 2`
- **mediaRichCount:** `mediaCount >= 1` AND `anchorCount >= 1`
- **hasStrongContentMajority:** ≥50% of elements are strong-content OR media-rich
- **richCount:** Elements with `hasImageAndText` OR `hasMultipleTextBlocks` OR `getTextLen(el) > 20`

---

## 5. Exclusion Rules

### Blacklisted / Interruption Tags

| Constant | Tags | Effect |
|----------|------|--------|
| `INTERRUPTION_TAGS` | `SPAN`, `HR`, `BR`, `SCRIPT` | Breaks run formation; sibling skipped |
| `STRUCTURE_IGNORED_TAGS` | `svg`, `path`, `rect`, `circle`, `button`, `script`, `style` | Excluded from structure signature |

### Navigation / Sidebar Discrimination

**Nav detection signals:**
- `hasNavSemantics`: `role` in `tab`, `menuitem`, `option`, `button`, `tablist`, `menubar`, `navigation` (self or parent)
- `hasNavKeywords`: id/class/test-id/aria-label matches `nav|menu|breadcrumb|pagination|footer-link|home-tab|vertical-nav|toolbar|tab`
- `hasNavTestIdSignals`: `data-test-id` matches `nav|menu|tab|icon` patterns; small controls (≤120×120) also check parent
- `hasHardNavTestIdBlacklist`: `data-test-id` contains `-tab`, `_tab`, `-icon`, `_icon`, `-button`, `_button`, or `logo`

**Rejection when nav-like:**
- `navConfidenceScore >= 50%` of elements AND `!hasStrongContentMajority` → reject
- `hardNavTinyCount >= 40%` AND `avgVisual < 0.5` → reject
- `highConfidenceMenuTab` (active state + linear layout + nav/action signals) AND weak content → reject

### Main Content vs Navigation

**Main content favored when:**
- `hasStrongContentMajority` (≥50% strong-content or media-rich)
- `richCount >= 40%` (image+text, multiple blocks, or long text)
- `avgVisual >= 1` (meaningful visuals per item)
- `avgMedia >= 1` AND `avgText >= 8`

**Navigation/sidebar rejected when:**
- Linear layout (`hasLinearAlignment`: centers spread ≤ 25% in X or Y)
- Single active item (`aria-selected` or `aria-current`)
- Nav semantics/keywords/test-ids on ≥40% of items
- Action bias (icon-only, small SVG, no img/video) on ≥60% of items

### Element Size Requirements

| Check | Threshold |
|-------|-----------|
| `isVisibleAndSized(el)` | `display !== 'none'`, `visibility !== 'hidden'`, `width >= 40`, `height >= 40` |
| `MIN_CANDIDATE_SIZE` | 40 px |
| `isTinyElement(el, 10000)` | Area < 10,000 px² |
| `isTinyFootprint(elements)` | Average area < 10,000 px² (100×100) |

---

## Summary: Type A ItemMap Checklist

For a container to become a **Type A ItemMap**, all of the following must hold:

1. **Repetition:** ≥3 similar sibling elements (same identity, structure, evidence type)
2. **Parent:** Parent has ≥3 direct children
3. **Visibility:** Each element passes `isVisibleAndSized` (≥40×40 px, not hidden)
4. **Visual layout:** `validateVisualLayout` — width or height spread ≤ 30%
5. **Signal:** At least one element has `hasValidAbsoluteAnchor` (contains valid Type A anchor)
6. **Density:** `avgAnchors >= 1` (average valid anchors per item)
7. **Not nav:** Fails nav/sidebar heuristics (nav score, action bias, menu-tab patterns)
8. **Content:** Passes one of: `richCount >= 40%`, `avgVisual >= 1`, `avgMedia >= 1` + `avgText >= 8`, or `avgText > 20`
