# Blink - Usage Guide

## Overview

This application allows you to save URLs and images from your browser using keyboard shortcuts. It consists of:

- **Server**: Node.js/Express API that stores saved URLs
- **Electron Client**: Desktop app running in the background with a global shortcut
- **Browser Extension**: Handles saving when browsing (supports image hover detection)

---

## Step 1: Start the Server

1. Open a terminal
2. Navigate to the server directory:
   ```bash
   cd server
   ```
3. Start the server:
   ```bash
   npm run dev
   ```
4. You should see: `Server running on http://localhost:3000`

**Keep this terminal window open** - the server must be running for the app to work.

---

## Step 2: Start the Electron Client

1. Open a **new terminal window**
2. Navigate to the client directory:
   ```bash
   cd client
   ```
3. Build and start the Electron app:
   ```bash
   npm run dev
   ```
4. You should see the app icon appear in your system tray (menu bar)
5. The main window will be hidden - the app runs in the background

**Keep this terminal window open as well**.

---

## Step 3: Install the Browser Extension (First Time Only)

### For Chrome/Arc/Edge:

1. Open your browser (Chrome, Arc, or Edge)
2. Go to the extensions page:
   - **Chrome/Arc**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
3. Enable **"Developer mode"** (toggle in top-right corner)
4. Click **"Load unpacked"**
5. Navigate to and select the extension folder:
   ```
   browser-extension/chromium/
   ```
6. The "Blink" extension should now appear in your extensions list
7. Make sure the extension is **enabled** (toggle switch is ON)

### For Firefox:

1. Open Firefox
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **"Load Temporary Add-on..."**
4. Navigate to the extension folder:
   ```
   browser-extension/firefox/
   ```
5. Select `manifest.json`
6. The extension will be loaded temporarily (reload after browser restart)

---

## Step 4: Set Up Extension Shortcut (Chrome/Arc/Edge Only)

**Important**: Chrome/Chromium browsers require you to manually configure the extension shortcut.

1. Go to the shortcuts page:
   - **Chrome/Arc**: `chrome://extensions/shortcuts`
   - **Edge**: `edge://extensions/shortcuts`
2. Find **"Blink"** extension
3. Find the **"Save current URL or hovered image"** command
4. Click on it and set the shortcut to: **`⌘⇧S`** (Cmd+Shift+S on Mac) or **`Ctrl+Shift+S`** (Windows/Linux)
5. Make sure it shows the correct shortcut

---

## Step 5: Using the Application

### Option A: Save Current Page URL (via Electron - Global)

- **Shortcut**: `Cmd+S` (Mac) or `Ctrl+S` (Windows/Linux)
- **Works from**: Anywhere on your system (even when browser is not focused)
- **What it saves**: The URL and title of the active browser tab

**How to use:**
1. Open any webpage in your browser
2. Press `Cmd+S` (or `Ctrl+S`)
3. The URL will be saved automatically

### Option B: Save Current Page URL (via Extension)

- **Shortcut**: `Cmd+Shift+S` (Mac) or `Ctrl+Shift+S` (Windows/Linux)
- **Works from**: Only when browser is focused
- **What it saves**: The URL and title of the current page
- **Advantage**: Can detect and save hovered images

**How to use:**
1. Open any webpage in your browser
2. Make sure the browser window is active/focused
3. Press `Cmd+Shift+S` (or `Ctrl+Shift+S`)
4. The URL will be saved with `saved_by: 'extension'` flag

### Option C: Save Hovered Image (via Extension Only)

- **Shortcut**: `Cmd+Shift+S` (Mac) or `Ctrl+Shift+S` (Windows/Linux)
- **Works from**: Only when browser is focused
- **What it saves**: The image URL you're hovering over + the current page URL

**How to use:**
1. Open any webpage with images
2. **Hover your mouse over an image** (keep the mouse over it)
3. Press `Cmd+Shift+S` (or `Ctrl+Shift+S`) while hovering
4. Both the image URL and page URL will be saved with `saved_by: 'extension'` and `type: 'image'`

**Note**: Works on:
- `<img>` tags
- Elements with `background-image` CSS property
- Images in galleries, social media posts, etc.

---

## Step 6: View Saved URLs

Saved URLs are stored in:
```
server/data/saved-urls.json
```

Each entry contains:
- `url`: The saved URL
- `title`: Page title
- `timestamp`: When it was saved
- `source`: Domain name (e.g., "google", "instagram")
- `type`: Content type (e.g., "image", "video", "article", "reels", "social_post")
- `img_url`: Image URL (if an image was hovered)
- `saved_by`: Either `"extension"` or undefined (for Electron app saves)

---

## Troubleshooting

### Extension shortcut doesn't work:

1. **Check if extension is enabled:**
   - Go to `chrome://extensions/` (or `edge://extensions/`)
   - Make sure "Blink" toggle is ON

2. **Verify shortcut is set:**
   - Go to `chrome://extensions/shortcuts`
   - Make sure "Save current URL or hovered image" shows `⌘⇧S`

3. **Reload the extension:**
   - Click the reload icon on the extension in the extensions page

4. **Check browser console:**
   - Press `F12` to open Developer Tools
   - Go to "Console" tab
   - Press `Cmd+Shift+S`
   - You should see logs like "Extension: save-url action received"

### CORS errors:

- Make sure the server is running on `http://localhost:3000`
- Restart the server if you see CORS errors

### Electron shortcut doesn't work:

1. Make sure the Electron app is running (check system tray)
2. Check the Electron app terminal for errors
3. The shortcut `Cmd+S` might conflict with browser's "Save Page" - use `Cmd+Shift+S` with the extension instead

### Extension not detected:

- The Electron app checks for extension saves by looking for `saved_by: 'extension'` in recent saves
- If the extension hasn't saved anything yet, the dialog will keep appearing
- Save something using the extension (`Cmd+Shift+S` in browser) first

### Image hover not working:

- Make sure you're using the **extension shortcut** (`Cmd+Shift+S`), not the Electron shortcut
- Keep your mouse over the image when pressing the shortcut
- Works on `<img>` tags and elements with `background-image`
- Check browser console for extension logs

---

## Quick Reference

| Action | Shortcut | Works From | Handled By |
|--------|----------|------------|------------|
| Save page URL (global) | `Cmd+S` / `Ctrl+S` | Anywhere | Electron app |
| Save page URL (browser) | `Cmd+Shift+S` / `Ctrl+Shift+S` | Browser only | Extension |
| Save hovered image | `Cmd+Shift+S` / `Ctrl+Shift+S` | Browser only | Extension |

---

## Stopping the Application

1. **Stop the Electron client:**
   - Close the terminal running the client, or
   - Right-click the system tray icon and quit

2. **Stop the server:**
   - Press `Ctrl+C` in the server terminal, or
   - Close the terminal window

---

## Notes

- The server must be running for any saves to work
- The Electron app can save from any browser (Safari, Chrome, Firefox, Edge, Arc)
- The extension works best for image saving and provides more detailed metadata
- Saved URLs are automatically categorized by domain and URL structure
- Instagram Reels are automatically detected and saved with `type: "reels"`
- Pinterest pins are automatically detected and saved with `type: "social_post"`






