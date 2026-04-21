# Audit Report: Content Purity (Stage 2) in `__isMenuTab`

**Date:** February 14, 2025  
**Scope:** hoverDetector.js – Condition B2 (Content Purity) and Discovery Content signals

---

## 1. Analysis of Condition B2 (Content Purity)

### How "Pure Content" Was Defined (Before)

- **Pure** = anchor contains only: `SPAN`, `B`, `STRONG`, `I`, `EM`, `P`, `SVG`
- **Impure** = any `IMG`, or any tag not in the allowed set (e.g. `DIV`)
- Traversal: recursive `walk()` over `anchor` children (full depth)
- **Inversion:** `__hasContentPurity(anchor) === true` → menu-like → may reject. `false` → impure → pass (don't reject)

### Why SmartStore Cards Failed (False Rejection)

A rich product card can have structure like:

```html
<LI class="product-card">
  <A href="...">
    <DIV class="thumb"><IMG src="..."></DIV>
    <SPAN class="title">...</SPAN>
    <SPAN class="price">12,000원</SPAN>
    <SPAN class="rating">
      <SVG>★</SVG><SVG>★</SVG><SVG>★</SVG><SVG>★</SVG><SVG>☆</SVG>
    </SPAN>
    <SPAN class="badge">로켓배송</SPAN>
  </A>
</LI>
```

**Problem 1 – Anchor scope:** If the anchor wraps the whole card, it has `DIV` and `IMG` → impure → we should pass. So that case was already handled.

**Problem 2 – Alternate structure:** Some sites use:
- `A > SPAN > SPAN > SPAN` (no DIV wrapper)
- `A > SPAN.rating > SVG, SVG, SVG, SVG, SVG`
- `A > SPAN.price`, `A > SPAN.badge`

Here the anchor has only `SPAN` and `SVG` – no `IMG` or `DIV` at the anchor level. So `__hasContentPurity(anchor)` returned **true** (pure), and the card was wrongly rejected as a menu-tab.

**Problem 3 – IMG inside wrapper:** If the structure is `A > DIV > IMG`, we see `DIV` first → impure → pass. But if the DOM is `A > SPAN > IMG` (SPAN allowed), we recurse and hit `IMG` → impure → pass. So `IMG` anywhere under the anchor should have been caught. The failure case is when the **container** (finalItem) has the IMG, but the **anchor** used for purity is a different, smaller link (e.g. a secondary link) that only has SPAN+SVG.

**Problem 4 – Scope mismatch:** Purity was checked on the **anchor** only. The **container** (finalItem) can have rich content (img, price, ratings) while the primary anchor is a simple `[Icon]+[Label]` link. We were judging the wrong element.

---

## 2. Sub-element Traversal Depth

| Check | Scope | Depth | Notes |
|-------|-------|-------|-------|
| `__hasContentPurity` | anchor | Full (recursive) | Stopped at first disallowed tag |
| `__hasDiscoveryContentSignals` (new) | **container** | 12 levels | Traverses full container tree |

**Fix:** Discovery signals are now evaluated on the **container** (finalItem), not just the anchor, so deep nesting like `LI > DIV > DIV > SPAN` is fully inspected.

---

## 3. SVG and Icon Differentiation

### Before

- All `SVG` tags were treated the same.
- A menu item `[SVG icon] + [Label]` and a rating `[SVG][SVG][SVG][SVG][SVG]` were not distinguished.

### After

- **UI icons (nav):** typically 1–2 SVGs (arrow, hamburger, etc.)
- **Content icons (rating):** 3+ consecutive SVGs (stars)
- **Rule:** `maxSvgRun >= 3` → treat as discovery content → pass

---

## 4. Refined "Menu" vs "Content Card" Definition

| Menu item | Content card |
|-----------|--------------|
| `[Icon] + [Label]` | `[Image] + [Title] + [Price] + [Meta]` |
| 1–2 SVGs | 3+ SVGs (rating) or product image |
| Single text block | Multiple distinct text blocks (price, title, badge) |

### New Early Pass (Discovery Content Signals)

We **pass** (do not reject) if the **container** has any of:

1. **Product imagery:** `img` with width or height ≥ 48px
2. **Rating pattern:** 3+ consecutive SVGs (siblings)
3. **Content density:** 3+ distinct class names and 4+ text nodes
4. **Price/discount:** text matching `₩`, `$`, `원`, `할인`, `discount`, etc.
5. **Badge text:** `AD`, `광고`, `배송`, `로켓배송`, `할인`, `쿠폰`, `리뷰`, `평점`, etc.
6. **Mixed content:** 1+ img and (3+ text nodes or 2+ SVGs)

---

## 5. Logging Enhancement

### When Passing (Discovery Content)

```
[Purity Check] Discovery signal: Product imagery (img>=48px) → Pass
```
or
```
[Purity Check] Discovery signal: Rating-like SVGs (5 consecutive) → Pass
```

### When Failing Purity (Impure → Pass)

```
[Purity Check] Found Elements: img(1), svg(4), text_nodes(12)
[Purity Check] Reason for Fail: img (product imagery)
```

### When Rejecting (Menu-Tab)

```
[Purity Check] Found Elements: img(0), svg(2), text_nodes(3)
[Purity Check] Reason for Fail: Menu-like (no product imagery, anchor ratio 85% >= 70%)
[Blink] Element rejected as Menu-Tab (strict): ...
```

---

## 6. Execution Order (Stage 2)

1. **Condition A:** Same base domain (else pass)
2. **Discovery signals (new):** If container has content density → **Pass**
3. **Condition B2:** Content purity on anchor; if impure → **Pass**
4. **Condition B1:** Anchor occupancy ratio; if below threshold → **Pass**
5. **Reject** as menu-tab

---

## 7. Summary

- **Root cause:** Purity was evaluated on the anchor only; some cards use an anchor with only SPAN+SVG while the container holds the real content.
- **Fix:** Evaluate discovery signals on the **container** first. If present, pass immediately.
- **SVG handling:** 3+ consecutive SVGs are treated as rating/content, not nav.
- **Logging:** Purity check now logs element counts and pass/fail reasons.
