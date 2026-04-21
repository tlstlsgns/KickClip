# Troubleshooting Extension Shortcut Issues

## Issue: Cmd+Shift+S doesn't work

### Step 1: Verify Extension Shortcut is Registered

1. **Chrome/Arc/Edge:**
   - Go to `chrome://extensions/shortcuts` (or `edge://extensions/shortcuts`)
  - Find "Blink" extension
   - Look for "Save current URL or hovered image" command
   - Verify it shows `⌘⇧S` (Cmd+Shift+S)
   - If it shows "Not set" or a different shortcut, click on it and set it to `⌘⇧S`

2. **Firefox:**
   - Go to `about:addons`
   - Click the gear icon → "Manage Extension Shortcuts"
  - Find "Blink" → "save-url"
   - Verify it's set to `⌘⇧S`

### Step 2: Check Extension Status

1. Open extensions page: `chrome://extensions/` (or `edge://extensions/`)
2. Make sure "Blink" extension is:
   - ✅ **Enabled** (toggle is ON)
   - ✅ **Reloaded** (click the reload icon after making any changes)

### Step 3: Check Browser Console

1. Open any webpage
2. Press `F12` to open Developer Tools
3. Go to "Console" tab
4. Press `Cmd+Shift+S`
5. You should see logs like:
   - `Extension background: Command received: save-url`
   - `Extension: save-url action received`
   - `Extension: Sending payload to server: ...`

If you don't see these logs, the shortcut isn't being triggered.

### Step 4: Check for Conflicts

Some websites or browser extensions might intercept `Cmd+Shift+S`. Try:
- Testing on a simple page like `about:blank` or `google.com`
- Disable other browser extensions temporarily
- Check if the browser itself has a shortcut for `Cmd+Shift+S` that might conflict

### Step 5: Verify Extension Files

Make sure all extension files are present:
- `manifest.json`
- `background.js`
- `content.js`

And that they're in the correct location (the extension folder should be loaded as "unpacked" in Chrome/Edge).

### Common Issues:

1. **Extension not loaded as unpacked:**
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the extension folder (e.g., `browser-extension/chromium/`)

2. **Shortcut conflict with browser:**
   - Some browsers reserve `Cmd+Shift+S` for other functions
   - Check the browser's keyboard shortcut settings

3. **Extension not enabled:**
   - Make sure the toggle switch is ON in the extensions page

4. **Content script not injected:**
   - Reload the webpage after installing/enabling the extension
   - Content scripts only run on pages loaded after the extension is enabled






