# KickClip

> 웹 콘텐츠를 빠르게 저장하고 정리하는 Chrome 확장 프로그램  
> Chrome extension for quickly saving and organizing web content

KickClip lets users save URLs, images, and web content to their local
folder or Google Drive with a single keyboard shortcut or click.
Saved items are automatically categorized (Article, Image, Video,
Mail, Product, etc.) and synced via Firebase Firestore.

## Features

- **One-key shortcut save**: Press `Cmd+Shift+S` (Mac) / `Ctrl+Shift+S` (Windows/Linux)
  to save the current page or hovered image
- **Dual storage**: Save to a local folder (via File System Access API)
  or Google Drive (via Drive API, `drive.file` scope)
- **Automatic categorization**: Articles, Images, Videos, Mail,
  Products, and more — detected from page content
- **Rich metadata**: Title, description, thumbnails, timestamps
- **Side panel UI**: Browse saved items organized by category

## Architecture

- **Chrome Extension** (Manifest V3) — `browser-extension/chromium/`
- **Cloud Run server** (Node.js/Express) — `server/`
- **Firebase**
  - Firestore: user profiles, saved items metadata
  - Auth: Google OAuth sign-in
- **Google Drive API**: optional cloud storage destination

## Development Setup

### Prerequisites

- Node.js ≥ 18
- Chrome browser (latest stable)
- Google account (for Firebase + OAuth testing)

### Install

```bash
# Extension dependencies
cd browser-extension
npm install

# Server dependencies (optional — for local API development)
cd ../server
npm install
```

### Run (development)

**1. Build extension (dev variant)**:

```bash
cd browser-extension
npm run build:dev
```

This copies `manifest.dev.json` → `chromium/manifest.json` and
`config.dev.js` → `chromium/config.js`.

**2. Load extension in Chrome**:

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select `browser-extension/chromium/`

**3. (Optional) Run server locally**:

```bash
cd server
npm run dev
```

Server runs on `http://localhost:3000` by default. The dev build's
`config.dev.js` points to the deployed dev Cloud Run URL by default;
adjust `KC_SERVER_URL` in `config.dev.js` if you want to hit your
local server instead.

## Configuration

KickClip uses environment-specific manifest and config files:

### Extension manifests

- `browser-extension/chromium/manifest.dev.json` — dev OAuth client,
  includes `key` field for stable extension ID during development
- `browser-extension/chromium/manifest.prod.json` — prod OAuth client,
  no `key` field (Chrome Web Store assigns its own key)
- `browser-extension/chromium/manifest.json` — **generated** at build
  time, gitignored

### Extension config

- `browser-extension/chromium/config.dev.js` — `KC_IS_DEV = true`,
  dev Cloud Run URL
- `browser-extension/chromium/config.prod.js` — `KC_IS_DEV = false`,
  prod Cloud Run URL
- `browser-extension/chromium/config.js` — **generated** at build
  time, gitignored

Chrome extensions use PKCE flow via `chrome.identity.getAuthToken`,
so **no client secret** is stored or needed in the extension.

### Server configuration

The server uses Firebase Admin SDK. Place service account JSON files at:

- `server/service-account-dev.json` — Firebase service account for
  dev project (`saveurl-a8593`)
- `server/service-account-prod.json` — Firebase service account for
  prod project (`saveurl-prod`)

**Both files are gitignored**. Download them from Firebase Console →
Project Settings → Service Accounts for your own projects.

## Build

### Dev build

```bash
cd browser-extension
npm run build:dev
```

Writes dev manifest + config into `chromium/`. Load unpacked in
Chrome for testing.

### Prod build

```bash
cd browser-extension
npm run build:prod
```

Produces:

- `browser-extension/dist/prod/` — unpacked extension with prod
  manifest + config
- `browser-extension/dist/kickclip-prod.zip` — packaged for
  Chrome Web Store upload

## Project Structure

```
KickClip/
├── browser-extension/
│   ├── chromium/              # extension source
│   │   ├── background.js
│   │   ├── sidepanel.html / .js / .css
│   │   ├── picker.html / .js
│   │   ├── upload.js
│   │   ├── uploadStorage.js
│   │   ├── coreEntry.js
│   │   ├── firebase-bundle.js
│   │   ├── manifest.dev.json / manifest.prod.json
│   │   └── config.dev.js / config.prod.js
│   ├── scripts/               # build scripts
│   │   ├── build-dev.js
│   │   ├── build-prod.js
│   │   └── build-user-package.js
│   └── package.json
├── server/                    # Cloud Run API server
│   ├── src/
│   │   └── server.ts
│   ├── scripts/
│   │   └── backfill-user-profiles.js
│   └── package.json
├── docs/                      # documentation + privacy policy pages
│   ├── index.html
│   ├── privacy-policy.html
│   └── privacy-policy-en.html
├── firestore.rules            # Firestore security rules
└── firebase.json
```

## Privacy & Security

- **Privacy Policy**: [https://tlstlsgns.github.io/KickClip/privacy-policy.html](https://tlstlsgns.github.io/KickClip/privacy-policy.html)
- **OAuth scopes**: `openid`, `email`, `profile`, `drive.file` (least privilege)
- **Data storage**: Firebase Firestore (Asia Northeast / Seoul),
  user's local folder, or user's own Google Drive
- **Security rules**: Per-user access control via Firestore Security Rules
- **No client secrets in the extension** (PKCE flow via `chrome.identity`)

## Usage

### Getting Started

1. **Install the extension** from the Chrome Web Store (pending
   approval) or load the unpacked build for development (see
   [Development Setup](#development-setup) above).

2. **Sign in with Google** — click the KickClip icon to open the
   side panel, then sign in with your Google account.

3. **Choose a save destination** when prompted:
   - **Local folder**: select a folder on your computer (via File
     System Access API)
   - **Google Drive**: automatically creates a `kickclip_files`
     folder in your Drive root

### Saving Content

**Keyboard shortcut** (recommended):

- Press `Cmd+Shift+S` (Mac) or `Ctrl+Shift+S` (Windows/Linux) on any
  webpage to save it.
- If you're hovering over an image when you press the shortcut, the
  image will be saved instead of the page URL.

**Extension icon**:

- Click the KickClip icon in your Chrome toolbar to open the side
  panel and browse saved items.

### Managing Saved Items

Saved items are organized by auto-detected category in the side panel:

- **Article** — news articles, blog posts
- **Image** — saved images
- **Video** — YouTube, Instagram Reels, etc.
- **Mail** — email-style content
- **Product** — shopping pages
- **Other** — uncategorized content

Click any item card to view its metadata, open the original URL, or
navigate to the saved file.

### Auto Upload

When "Auto" is enabled in the side panel, pressing the save shortcut
automatically uploads to your configured destination without prompting.
Disable "Auto" if you want a destination picker (local folder or Google
Drive) each time.

### Switching Save Destinations

Click the folder icon in the Dir container at the top of the side
panel to change destinations. The picker popup lets you switch between
a local folder and Google Drive at any time.

### Troubleshooting

**Shortcut not working**:

1. Go to `chrome://extensions/shortcuts`
2. Find KickClip → "Save current URL or hovered image"
3. Assign `⌘⇧S` (Mac) or `Ctrl+Shift+S` (Windows/Linux)

**Sign-in issues**:

- Ensure third-party cookies are allowed for Google domains
- Sign out and back in via the side panel's account menu

**Save failures**:

- **Google Drive**: confirm your Google account granted Drive permission
  during sign-in
- **Local folder**: the selected folder must still exist and the
  extension must retain File System Access permission (re-grant via
  the folder picker if needed)

## Contributing

Contributions welcome. Please open an issue first to discuss substantial changes.

## License

TBD

---

**Website**: [https://tlstlsgns.github.io/KickClip/](https://tlstlsgns.github.io/KickClip/)  
**Contact**: tlstlsgns@gmail.com
