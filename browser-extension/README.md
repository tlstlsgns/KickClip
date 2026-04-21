# Blink Browser Extension

This browser extension allows you to save URLs and images using the `Cmd+Shift+S` (Mac) or `Ctrl+Shift+S` (Windows/Linux) keyboard shortcut.

## Features

- Save the current page URL
- Save images when hovering over them and pressing the shortcut
- Automatically categorizes saved content (source, type)
- Supports saving images from `<img>` tags and CSS `background-image`

## Installation

### Chrome / Arc / Edge (Chromium-based browsers)

1. Open Chrome/Arc/Edge and navigate to `chrome://extensions/` (or `edge://extensions/` for Edge)
2. Enable "Developer mode" (toggle in the top right)
3. Click "Load unpacked"
4. Select the `browser-extension/chromium` folder
5. The extension should now be installed

### Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Navigate to the `browser-extension/firefox` folder
4. Select the `manifest.json` file
5. The extension should now be installed

### Safari

Safari extensions require additional setup:

1. Open Safari and go to Safari → Settings → Extensions
2. Enable "Show features for web developers" in Advanced settings
3. Use Xcode to build a Safari App Extension from the manifest
4. Alternatively, you can use the Web Extensions API in Safari 14+

**Note:** Safari extension development requires macOS and Xcode. The manifest structure is similar to Chrome, but Safari requires special packaging.

## Usage

1. Make sure the server is running at `http://localhost:3000`
2. Navigate to any webpage
3. To save the current page: Press `Cmd+Shift+S` (Mac) or `Ctrl+Shift+S` (Windows/Linux)
4. To save an image: Hover your mouse over the image, then press `Cmd+Shift+S` (Mac) or `Ctrl+Shift+S` (Windows/Linux)
5. Check the server logs and `server/data/saved-urls.json` to see saved entries

## How It Works

- The extension tracks the element your mouse is hovering over
- When you press the shortcut, it checks if you're hovering over an image
- If an image is detected, it extracts the image URL (from `src` attribute or `background-image` CSS)
- The data is sent to your local server at `http://localhost:3000/api/v1/save-url`
- The server automatically categorizes the content and saves it with `type: "image"` when `img_url` is present

## Troubleshooting

- **Shortcut not working**: Check that the extension is enabled and reloaded
- **Images not saving**: Make sure you're hovering over the image when pressing the shortcut
- **Server connection error**: Ensure the server is running at `http://localhost:3000`
- **Permission errors**: Check that `http://localhost:3000/*` is in the host_permissions

