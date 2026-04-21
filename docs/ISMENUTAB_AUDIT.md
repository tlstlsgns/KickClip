# Technical Audit: `__isMenuTab` Logic

## Overview

`__isMenuTab` (hoverDetector.js ~523) is a **strict reject-only** gate: it returns `true` (reject as menu-tab) **only when ALL** of the following conditions hold. Any early exit returns `false` (pass = not a menu-tab).

---

## 1. Negative Signals (What Makes It a "Menu")

The function does **not** use:
- CSS class names (`nav`, `menu`, `tab`, `header`)
- Element IDs
- Tag names (`<ul>`, `<li>`)
- Link-to-text ratio
- Number of links in the container

**Negative signals are implicit:** rejection happens only when the container passes all checks and reaches the final `return true`. The "menu-like" profile is:

1. **Same base domain** (Condition A)
2. **No discovery content signals** (Stage 2)
3. **Anchor is "pure"** – only SPAN/B/STRONG/I/EM/P/SVG, no IMG (Condition B2)
4. **Anchor occupies ≥70% of container** (or ≥50% with nav role) (Condition B1)

---

## 2. Positive Signals (What Saves It From Being a "Menu")

### Stage 2: `__hasDiscoveryContentSignals(container)`

If this returns `true`, the function immediately returns `false` (pass). The container is treated as discovery content, not a menu.

| Signal | Threshold | Description |
|--------|-----------|-------------|
| **Product imagery** | Any IMG with width or height ≥ 48px | `__CONTENT_IMG_MIN = 48` |
| **Rating-like SVGs** | 3+ consecutive SVG elements | `maxSvgRun >= 3` |
| **Content density** | `textClasses.size >= 3` AND `textNodes >= 4` | Distinct first-class tokens from child elements + non-empty text nodes |
| **Price pattern** | Text matches `__PRICE_PATTERN` | `[\d,.]+\s*[₩$€£¥%]`, `할인`, `discount`, `sale`, `가격`, `price` |
| **Badge pattern** | Text matches `__BADGE_PATTERN` | `AD`, `광고`, `배송`, `무료배송`, `할인`, `쿠폰`, `리뷰`, `평점`, `별점`, `\d+%`, `\d+점` |
| **Mixed content** | `imgCount >= 1` AND (`textNodes >= 3` OR `svgCount >= 2`) | At least one image plus text or SVGs |

**Text length:** No explicit minimum. Content density uses `textNodes >= 4` (count of non-empty text nodes) and `textClasses.size >= 3` (distinct first-class tokens from child elements).

---

## 3. Link Counting & Density

**No link counting.** The function does not:
- Count links in the container
- Reject "pure link" containers (links without metadata)
- Use link-to-text ratio

It operates on a **single anchor** – the first `<a href>` found via:
- `container` itself (if it is an `<a>`)
- `container.closest('a[href]')`
- `container.querySelector('a[href]')`

All checks (purity, occupancy) apply to that one anchor and its relationship to the container.

---

## 4. Special Handling

### Domain Exceptions

**No hardcoded domain allowlists.** The only domain logic is:

- **Condition A:** `targetBase !== currentBase` → pass (external link, not menu)
- `__getBaseDomain` uses `__blinkDomainClusterMap` for clustering (e.g. `googleusercontent.com` → `google.com`), but only for base-domain comparison, not for bypassing the menu check.

### Sitelink Table vs. Site Navigation

**No explicit sitelink vs. nav distinction.** Both are judged by the same rules:

1. **Same domain:** On Google Search, links to `google.com` or `gemini.google.com` are same-base-domain when the page is `google.com` → Condition A does not pass.
2. **Discovery signals:** Sitelinks often have descriptions (`.zz3gNc`), multiple text nodes, and multiple class tokens → `__hasDiscoveryContentSignals` often returns `true` → pass.
3. **Anchor purity:** Sitelink anchors often have `<h3>`, `<span>`, `<div>` (e.g. cite) → `__analyzeContentPurity` returns `pure: false` (disallowed tag) → pass.
4. **Occupancy:** Sitelink cells usually have description below the link → anchor area < 70% of cell → pass.

---

## 5. Boolean Logic Flow

```
__isMenuTab(container, resolvedUrl):
  if !container || !resolvedUrl → return false (pass)
  anchor = container or closest/query a[href]
  if !anchor → return false (pass)

  // Condition A: Domain
  if targetBase !== currentBase → return false (pass)  // External = not menu
  if !targetBase || !currentBase → return false (pass)

  // Stage 2: Discovery signals
  if __hasDiscoveryContentSignals(container) → return false (pass)

  // Condition B2: Anchor purity
  if !__analyzeContentPurity(anchor).pure → return false (pass)

  // Condition B1: Visual dominance
  ratio = anchorArea / containerArea
  threshold = hasNavRole ? 0.5 : 0.7
  if ratio <= threshold → return false (pass)

  // All conditions met → REJECT
  return true
```

---

## 6. Google Search: `.MjjYud` and `.eKjLze`

### `.eKjLze` (Main Result Block)

| Check | Expected Result |
|-------|-----------------|
| **Condition A** | On `google.com` search, link to `google.com` → same base domain → continues |
| **Discovery signals** | Many divs with different classes (V9tjod, LC20lb, MBeuO, etc.) → `textClasses.size >= 3`; snippet + title → `textNodes >= 4` → **Pass** (return false) |
| **Or: Mixed content** | Favicon (18×18) < 48px, so no `hasLargeImg`; but `imgCount >= 1` + `textNodes >= 3` is likely → **Pass** |
| **Or: Purity** | Title anchor often has `<h3>`, cite `<div>`, etc. → `disallowed tag` → **Pass** |
| **Or: Occupancy** | Snippet, cite, favicon reduce anchor share → ratio often < 70% → **Pass** |

**Conclusion:** `.eKjLze` is expected to pass (not rejected) via discovery signals, purity, or occupancy.

### `.MjjYud` (Full Result Including Sitelinks)

| Check | Expected Result |
|-------|-----------------|
| **Anchor** | First `a[href]` is typically the main result title link |
| **Discovery signals** | Container includes main block + sitelinks → many classes and text nodes → **Pass** |
| **Purity** | Same as above – title link has non-pure structure → **Pass** |

**Conclusion:** `.MjjYud` is also expected to pass.

### Sitelink Row (e.g. `.VttTV` or a table cell)

| Check | Expected Result |
|-------|-----------------|
| **Discovery signals** | Description (`.zz3gNc`), multiple classes → `textClasses >= 3`, `textNodes >= 4` → **Pass** |
| **Purity** | Sitelink anchor often has `<h3>`, `<span>`, `<div>` → **Pass** |
| **Occupancy** | Description below link → anchor < 70% of cell → **Pass** |

**Conclusion:** Sitelink rows are expected to pass.

---

## 7. When Would Google Search Be Flagged?

Rejection would require **all** of:

1. **Same base domain** – link to `google.com` while on `google.com`
2. **No discovery signals** – e.g. very minimal block with &lt; 3 distinct classes and &lt; 4 text nodes
3. **Pure anchor** – only SPAN/B/STRONG/I/EM/P/SVG, no IMG, no DIV/H3
4. **High occupancy** – anchor ≥ 70% of container (or ≥ 50% with nav role)

**Risky pattern:** A minimal same-domain link, e.g. a bare "구글" link with no description, no favicon, and the anchor filling most of the container. Typical Google result blocks (title + snippet + cite + favicon) do not match this.

---

## 8. Summary Table

| Aspect | Implementation |
|--------|----------------|
| **CSS classes/IDs** | Not used |
| **Link count** | Not used |
| **Link-to-text ratio** | Not used |
| **UL/LI structure** | Not used |
| **Domain allowlist** | None |
| **Sitelink vs. nav** | Same rules for both |
| **Discovery signals** | IMG ≥48px, 3+ SVGs, content density, price/badge patterns, mixed content |
| **Anchor purity** | SPAN/B/STRONG/I/EM/P/SVG only; IMG or other tags → impure |
| **Occupancy threshold** | 70% default; 50% with role=tab/menuitem/navigation |
