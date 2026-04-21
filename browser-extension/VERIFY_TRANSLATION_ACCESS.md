# Verifying Google Translate Widget Access

## Overview

We need to verify if it's **technically possible** to extract both input and output values from the Google Translate widget through a browser extension.

## Why This Matters

Browser extensions can access DOM elements, BUT:
- If the widget uses **Shadow DOM**, we need special access methods
- If the widget is in an **iframe**, we need cross-origin access (often blocked)
- If content is **dynamically rendered**, it might not be available when script runs
- Google may use **custom elements** or other techniques that hide content

## Step 1: Run Diagnostic Script

1. Open a Google Translate page (search for "translation" on Google)
2. Enter some text in the translation widget (e.g., "안녕하세요" → should show "hello")
3. Open Chrome DevTools Console (F12)
4. Copy and paste the entire contents of `debug-translation.js` into the console
5. Press Enter

This will inspect the DOM structure and show:
- What elements exist
- If textareas are present
- If Shadow DOM is used
- If iframes are used
- What text content is accessible

## Step 2: Manual DOM Inspection

Alternatively, manually inspect:

1. Right-click on the **source text** (Korean text you entered) → "Inspect"
2. Note:
   - What element type it is (textarea, input, div, span?)
   - What classes/IDs it has
   - If it's inside Shadow DOM (check for `#shadow-root`)
   - If it's inside an iframe

3. Right-click on the **target text** (English translation) → "Inspect"
4. Note:
   - What element type it is
   - What classes/IDs it has
   - If it's inside Shadow DOM
   - If it's inside an iframe
   - How it differs from source element

## Step 3: Check Console Logs from Extension

When you save via extension (Cmd+Shift+S), check console for:
- "Found textareas in translation widget: X" - This tells us if textareas exist
- Any error messages

## What We're Looking For

✅ **GOOD SIGNS** (feasible):
- Textareas/inputs are found with `.value` or `.textContent`
- Elements are in normal DOM (not Shadow DOM)
- Elements are not in cross-origin iframes

❌ **BAD SIGNS** (difficult/impossible):
- Elements use Shadow DOM (requires `.shadowRoot` access)
- Elements are in cross-origin iframe (contentDocument blocked)
- Text is rendered as images/canvas (not accessible as text)
- Text is only in CSS (not in DOM)
- Dynamic rendering means elements don't exist when script runs

## Expected Results

Based on your console logs showing "Found textareas in translation widget: 0", it's likely:
1. Google Translate widget doesn't use `<textarea>` elements
2. It might use `<div>` or `<span>` with `contenteditable` or just display text
3. We need to find the correct selectors for these elements

## Next Steps Based on Results

- **If elements are accessible**: Update selectors to match actual DOM structure
- **If Shadow DOM is used**: Access via `.shadowRoot` (requires checking if it's open)
- **If iframe is used**: Check if we can access `iframe.contentDocument`
- **If impossible**: Consider alternative approaches (screenshot, OCR, or accepting limitations)

