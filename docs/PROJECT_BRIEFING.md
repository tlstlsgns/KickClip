# Blink Project Briefing

> Comprehensive onboarding document for AI assistants. Use this to initialize context in a fresh conversation.

---

## 1. Project Overview

### What Blink Is

**Blink** is a multi-component URL and image saving application. Users save web pages, links, and images with a global keyboard shortcut (Cmd+Shift+S). Saved items are stored in Firebase Firestore and displayed in a sidebar/dock UI (Electron app) or Chrome extension side panel.

### Purpose

- **Save URLs and images** from any browser tab or hovered element
- **Organize saved items** in directories with drag-and-drop
- **AI-powered classification** (type + summary) via Gemini
- **Optimistic UI** for instant feedback before Firestore confirmation
- **Cross-platform**: Electron desktop app + Chromium/Firefox/Safari extensions

### Tech Stack

| Component | Technologies |
|-----------|--------------|
| **Desktop** | Electron v31.3.1, TypeScript v5.6.3 |
| **Server** | Node.js, Express v4.19.2, TypeScript, ES Modules |
| **Extensions** | Vanilla JavaScript, Chrome Extension APIs (Manifest V3) |
| **Backend** | Firebase v12.7.0 (Web SDK), Firebase Admin SDK v13.6.0 |
| **AI** | Google Gemini 2.5 Flash API |
| **Key Libraries** | cheerio, node-fetch, robots-parser, firebase-admin |

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         User Action: Cmd+Shift+S                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌──────────────────┐
│ Chrome Ext    │         │ Electron App   │         │ Node.js Server   │
│ (background)  │         │ (main process)  │         │ (port 3000)      │
│               │         │                 │         │                  │
│ - Shortcut    │────────▶│ - Pending-save │────────▶│ - save-url       │
│ - Content     │         │   (port 3001)  │         │ - ai-analyze     │
│   script      │         │ - Firestore    │         │ - image-proxy    │
│ - Side panel  │         │   (port 3002)  │         │ - firestore/*    │
└───────────────┘         └─────────────────┘         └──────────────────┘
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │ Firebase              │
                        │ - Auth (Google OAuth) │
                        │ - Firestore           │
                        └───────────────────────┘
```

---

## 2. Project Structure

```
AppTest/
├── browser-extension/
│   ├── chromium/           # Chrome, Arc, Edge
│   │   ├── manifest.json
│   │   ├── background.js
│   │   ├── coreEntry.js    # Content script entry, save logic, optimistic UI
│   │   ├── coreEngine.js   # Item detection, metadata extraction
│   │   ├── content-loader.js
│   │   ├── sidepanel.html
│   │   ├── sidepanel.js    # Side panel UI, Firestore listeners
│   │   ├── uiManager.js    # Purple highlight, tooltip, AI tooltip
│   │   ├── stateLite.js
│   │   ├── itemDetector.js
│   │   ├── dataExtractor.js
│   │   ├── urlResolver.js
│   │   ├── firebase-bundle.js
│   │   └── brandConfig.js
│   ├── firefox/
│   └── safari/
├── client/                 # Electron desktop app
│   ├── src/
│   │   ├── main.ts         # Main process, IPC, HTTP servers
│   │   ├── preload/preload.ts
│   │   ├── lib/
│   │   │   ├── firestore.ts
│   │   │   ├── firebase.ts
│   │   │   ├── auth.service.ts
│   │   │   └── instagram.service.ts
│   │   └── extensionInstaller.ts
│   ├── pages/
│   │   ├── auth/login.html
│   │   └── dashboard/main.html
│   ├── dock.html
│   ├── dropzone.html
│   └── ghost-window.html
├── server/
│   ├── src/
│   │   └── server.ts       # Express API, save-url, AI, image-proxy
│   ├── data/saved-urls.json
│   ├── .env.example
│   └── service-account.json
└── docs/
    └── PROJECT_BRIEFING.md
```

### Major File Roles

| File | Role |
|------|------|
| `server/src/server.ts` | Express server, save-url, AI analysis, image proxy, Firestore proxy |
| `browser-extension/chromium/background.js` | Service worker: shortcut, context menu, ping, Instagram fetch, message routing |
| `browser-extension/chromium/coreEntry.js` | Content script: hover detection, save logic, optimistic-card, htmlContext |
| `browser-extension/chromium/sidepanel.js` | Side panel: Firebase auth, Firestore listeners, cards, DnD, optimistic UI |
| `browser-extension/chromium/uiManager.js` | Purple highlight, metadata tooltip, AI tooltip DOM |
| `client/src/main.ts` | Electron main: window, IPC, pending-save server, Firestore save server |
| `client/src/lib/firestore.ts` | Firestore CRUD, watch, directories, Instagram session |

---

## 3. Component Breakdown

### Server (`server/src/server.ts`)

- **Port**: 3000
- **Framework**: Express

#### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/save-url` | Save URL/item to Firestore (via Electron or direct) |
| POST | `/api/v1/firestore/move-item` | Move item to directory/position |
| POST | `/api/v1/firestore/move-directory` | Reorder directories |
| POST | `/api/v1/ai-analyze-url` | Real-time AI analysis (tooltip) |
| GET | `/api/v1/image-proxy` | Proxy external images for CSP |
| GET | `/api/v1/saved-urls` | List recent saves (extension detection) |
| POST | `/api/v1/extension/ping` | Extension connection ping |
| GET | `/api/v1/extension/status` | Check if extension is connected |
| GET | `/api/v1/dock/width` | Dock width for extension |
| GET | `/api/v1/logo/:domain` | Favicon/logo URL for domain |

#### Key Functions

- `extractSource(url)` — Domain extraction
- `determineType(url)` — URL-based type inference
- `forwardToElectronApp(payload)` — Forward save to Electron Firestore server
- `fetchOpenGraphImage(url)` — Fetch og:image (non-blocking)
- `fetchPageTextContent(url)` — Multi User-Agent page text for AI
- `updateDocumentWithOgImage(docPath, pageUrl)` — Background OG image update
- `updateDocumentWithAiAnalysis(docPath, context)` — Background AI analysis (CoreItem vs page)

#### Environment Variables

- `GEMINI_API_KEY` — Gemini API key for AI analysis
- `GOOGLE_APPLICATION_CREDENTIALS` — Path to Firebase service account JSON (optional)

---

### Chrome Extension (`browser-extension/chromium/`)

#### manifest.json Summary

- **Manifest version**: 3
- **Permissions**: `activeTab`, `storage`, `scripting`, `tabs`, `contextMenus`, `windows`, `sidePanel`, `identity`
- **Host permissions**: `localhost:3000`, `localhost:3001`, `instagram.com`, `cdninstagram.com`, `fbcdn.net`
- **Content scripts**: `content-loader.js` on `<all_urls>`, `all_frames: true`, `document_start`
- **Background**: Service worker `background.js`
- **Side panel**: `sidepanel.html`
- **Commands**: `save-url` → Cmd+Shift+S
- **OAuth2**: Google (openid, email, profile)

#### Key Files

| File | Role |
|------|------|
| **background.js** | Shortcut handler, placeholder to Electron, sendMessage to content script, context menu, `get-cached-user-id`, `resolve-redirect`, `fetch-metadata`, `get-instagram-post-data`, `ai-analyze-url` proxy |
| **coreEntry.js** | `saveActiveCoreItem()`, `extractCoreItemHtmlContext()`, `optimistic-card` message, `mountSaveMessageListener`, platform-specific metadata (Instagram, LinkedIn, Threads, Facebook) |
| **sidepanel.js** | Firebase auth (Google via chrome.identity), Firestore listeners, `optimistic-card` handler, image proxy, DnD, delete |
| **sidepanel.html** | Login/dashboard screens, directory list, item list, card markup |
| **uiManager.js** | Purple overlay, metadata tooltip, AI tooltip, green candidate outlines |

---

### Electron App (`client/`)

- **Entry point**: `src/main.ts`
- **Main process**: Window management, IPC, HTTP servers (3001 pending-save, 3002 Firestore save), global shortcut, extension ping polling

#### Key IPC Handlers

- `auth:signInWithGoogle`, `auth:signOut`, `auth:getCurrentUser`
- `firestore:getDatasByUser`, `firestore:watchDatasByUser`, `firestore:deleteData`, `firestore:createDirectory`, `firestore:moveItemToPosition`, etc.
- `dock:getPinned`, `dock:setPinned`, `dock:show`, `dock:hide`
- `ghost:create`, `ghost:update-position`, `ghost:destroy`
- `instagram:connect`, `instagram:disconnect`, `instagram:getConnectionStatus`

#### Dashboard UI

- Left sidebar (175px), auto-hide when unfocused
- Login page → Dashboard (main.html)
- Real-time Firestore data via IPC

---

### Firebase / Firestore

- **Project ID**: `saveurl-a8593`
- **Auth**: Google OAuth (chrome.identity in extension, OAuth callback in Electron)

#### Firestore Schema

| Collection | Document | Fields |
|------------|----------|--------|
| `users/{userId}/items` | Auto ID | `url`, `title`, `createdAt`, `domain`, `type`, `img_url`, `directoryId`, `order`, `ai_type`, `ai_summary`, `saved_by` |
| `users/{userId}/directories` | Auto ID | `name`, `createdAt`, `order` |
| `users/{userId}/instagramSession` | `session` | `instagramUsername`, `cookies`, `connectedAt`, `expiresAt` |

---

## 4. Key Data Flows

### Save Flow: Cmd+Shift+S → CoreItem Save (with htmlContext)

1. User hovers over a link/card (CoreItem) and presses Cmd+Shift+S.
2. **background.js**: Sends placeholder to `http://localhost:3001/pending-save`, then `chrome.tabs.sendMessage(tabId, { action: 'save-url' })`.
3. **coreEntry.js**: Receives message, `saveActiveCoreItem()` runs.
4. CoreItem active: extracts `htmlContext` via `extractCoreItemHtmlContext(activeItem)`.
5. Sends `optimistic-card` to side panel (if `window.self === window.top`).
6. POST to `http://localhost:3000/api/v1/save-url` with `url`, `title`, `pageUrl`, `htmlContext`, `userId`.
7. Server forwards to Electron `http://localhost:3002/save-to-firestore` or saves directly.
8. Server runs `updateDocumentWithOgImage()` and `updateDocumentWithAiAnalysis()` in background (non-blocking).
9. AI path: `htmlContext` present → CoreItem prompt (type only, no summary).

### Save Flow: Cmd+Shift+S → Page Save (no CoreItem)

1. User presses Cmd+Shift+S with no CoreItem hovered.
2. **coreEntry.js**: `saveActiveCoreItem()` uses `extractPageOpenGraphMeta()` (og:title, og:image, document.title).
3. Payload includes `userLanguage: navigator.language`.
4. Sends `optimistic-card`, POST to save-url.
5. AI path: no `htmlContext` → page save prompt: `fetchPageTextContent()` with multi User-Agent, then type + summary. Summary language from `userLanguage`.

### Optimistic UI Flow (coreEntry → background → sidepanel)

1. **coreEntry.js**: Before `fetch('save-url')`, sends `chrome.runtime.sendMessage({ action: 'optimistic-card', tempId, url, title, imgUrl })`.
2. **background.js**: Forwards to side panel (Chrome routes to open side panel).
3. **sidepanel.js**: Listener adds temp card via `addOptimisticCard()`, prepends to list.
4. When Firestore snapshot arrives with matching URL, `loadData()` removes optimistic card and renders real card.

### AI Analysis Flow (server → Gemini → Firestore → Side Panel)

1. After save, server calls `updateDocumentWithAiAnalysis(docPath, context)` (fire-and-forget).
2. **CoreItem path**: Uses `htmlContext` → type-only prompt.
3. **Page path**: Uses `fetchPageTextContent()` → type + summary prompt, `userLanguage` for summary language.
4. Gemini response parsed, `ai_type` and `ai_summary` written to Firestore.
5. Side panel Firestore listener receives update, re-renders card with AI section.

### OG Image Fetch Flow (background, non-blocking)

1. After save, if `img_url` not in payload, server calls `updateDocumentWithOgImage(docPath, pageUrl)`.
2. `fetchOpenGraphImage()` fetches HTML, extracts `<meta property="og:image" content="...">`.
3. Updates Firestore `img_url` field.
4. Side panel listener updates card thumbnail.

---

## 5. AI System

- **Provider**: Google
- **Model**: Gemini 2.5 Flash
- **API**: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
- **Auth**: API key in query (`?key=${GEMINI_API_KEY}`)

### Two Analysis Paths

| Path | Trigger | Prompt | Output |
|------|---------|--------|--------|
| **CoreItem** | `htmlContext` present | Saved URL + page URL + HTML context (tagName, mediaRatio, images, innerText) | `ai_type` only |
| **Page save** | No htmlContext | Fetched page content (title, meta, body) or URL-only fallback | `ai_type` + `ai_summary` |

### Firestore Fields Written

- `ai_type` — e.g. Article, Video, Image, Product
- `ai_summary` — Only for page save path

### userLanguage Handling

- From `navigator.language` (e.g. `ko-KR`, `en-US`).
- Mapped to language name for summary: `ko` → Korean, `ja` → Japanese, etc.
- Prompt instructs: "Must be written in ${summaryLanguage}".

---

## 6. Recently Completed Work

1. **OG image fetch non-blocking** — `updateDocumentWithOgImage()` runs after save, never blocks response.
2. **Optimistic UI** — `optimistic-card` from coreEntry to side panel; iframe noise fix (skip optimistic in iframes: `window.self === window.top`).
3. **AI analysis system activation** — Background AI analysis after save.
4. **Per-path AI prompt branching** — CoreItem (type only) vs page save (type + summary).
5. **fetchPageTextContent with multi User-Agent** — Tries Chrome UA and Googlebot for better fetch success.
6. **maxOutputTokens removal** — Removed from save-flow AI (tooltip endpoint still has it).
7. **User language-aware summary** — `userLanguage` in payload, summary in user's language.

---

## 7. Known Issues & Limitations

- **Gemini rate limits** — Free tier has quotas; high save volume may hit limits.
- **JS-rendered pages** — Server-side fetch gets static HTML; SPA content may be missing.
- **Login-required pages** — Server cannot access authenticated content.
- **Extension injection** — Content script may not be injected on some pages; fallback uses `content-loader.js`.
- **Private Network Access** — Content scripts cannot call localhost directly for some operations; `ai-analyze-url` is proxied via background.

---

## 8. Current File State

### server/src/server.ts

<details>
<summary>Click to expand (1337 lines)</summary>

```typescript
import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import admin from 'firebase-admin';

// ─── Gemini AI ─────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
// ───────────────────────────────────────────────────────────────────────────

interface SaveUrlPayload {
  url: string;
  title: string;
  timestamp: number;
  domain: string;
  type: string;
  img_url?: string;
  saved_by?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, '../data/saved-urls.json');
const PORT = 3000;

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// [Full implementation: extractSource, determineType, forwardToElectronApp,
//  fetchOpenGraphImage, extractTextFromHtml, fetchPageTextContent,
//  updateDocumentWithOgImage, updateDocumentWithAiAnalysis, getFirestore,
//  /api/v1/firestore/move-item, /api/v1/firestore/move-directory,
//  /api/v1/ai-analyze-url, /api/v1/save-url, /api/v1/saved-urls,
//  /api/v1/extension/ping, /api/v1/image-proxy, /api/v1/extension/status,
//  /api/v1/dock/width, /api/v1/logo/:domain, app.listen(PORT)]
```

</details>

*Full file: 1337 lines. See repository for complete source.*

---

### browser-extension/chromium/background.js

<details>
<summary>Click to expand (617 lines)</summary>

```javascript
// Track last ping time to detect if we should ping on focus
let lastPingTime = 0;

async function getCachedUserId() {
  try {
    const result = await chrome.storage.local.get('blinkUserId');
    return result?.blinkUserId || null;
  } catch {
    return null;
  }
}

async function resolveRedirect(url) { /* ... */ }
async function fetchMetadata(url) { /* ... */ }

const sendConnectionPing = async () => { /* POST to localhost:3000/api/v1/extension/ping */ };
sendConnectionPing();
setInterval(() => sendConnectionPing(), 20000);

chrome.commands.onCommand.addListener((command) => {
  if (command === 'save-url') {
    // Placeholder to localhost:3001/pending-save
    // chrome.tabs.sendMessage(tabId, { action: 'save-url' })
  }
});

// Context menus: save-image, save-link, save-page
// saveDirectly(), getInstagramPostData(), extractCaptionFromJson(), extractCaptionFromHtml()
// chrome.runtime.onMessage: get-cached-user-id, resolve-redirect, fetch-metadata,
//   get-instagram-thumbnail, get-instagram-post-data, ai-analyze-url
```

</details>

*Full file: 617 lines. See repository for complete source.*

---

### browser-extension/chromium/coreEntry.js

<details>
<summary>Click to expand (634 lines)</summary>

```javascript
import { state } from './stateLite.js';
import { detectItemMaps, extractMetadataForCoreItem, ... } from './coreEngine.js';

window.__blinkMainLoaded = true;

// Platform metadata: withInstagramActiveHoverUrl, withLinkedInCanonicalActiveHoverUrl,
//   withThreadsActiveHoverUrl, withFacebookTimestampActiveHoverUrl
// requestInstagramPostDataForTypeB, applyInstagramFallbackMetadata
// updateCoreSelectionFromTarget, schedulePreScan, mountObservers
// extractPageOpenGraphMeta, extractCoreItemHtmlContext

async function saveActiveCoreItem(request = {}) {
  // No CoreItem: extractPageOpenGraphMeta, userLanguage, optimistic-card, POST save-url
  // CoreItem: extractCoreItemHtmlContext, optimistic-card, POST save-url with htmlContext
}

function mountSaveMessageListener() { /* chrome.runtime.onMessage save-url */ }
function mountWindowListeners() { /* load, scroll, resize, mouseover, mousemove */ }
function mountLifecycle() { /* schedulePreScan, mountObservers, mountSaveMessageListener */ }

window.__blinkApplyCoreItem = (coreItem) => { /* ... */ };
mountLifecycle();
```

</details>

*Full file: 634 lines. See repository for complete source.*

---

### browser-extension/chromium/sidepanel.js

<details>
<summary>Click to expand (1128 lines)</summary>

```javascript
import { initializeApp, getAuth, getFirestore, ... } from './firebase-bundle.js';

const FIREBASE_CONFIG = { projectId: 'saveurl-a8593', ... };
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// signInWithGoogle (chrome.identity.getAuthToken), signOut
// startListeners: users/{userId}/directories, users/{userId}/items
// createDataCard, createCardElement, animateEntrance
// addOptimisticCard, removeOptimisticCard
// attachCardClickHandlers, attachDeleteHandlers
// setupContainerDropHandlers, moveItemToPosition, moveDirectoryToPosition
// loadData, renderDirectories
// chrome.runtime.onMessage: optimistic-card
```

</details>

*Full file: 1128 lines. See repository for complete source.*

---

### browser-extension/chromium/sidepanel.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Blink</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600&display=swap" rel="stylesheet">

  <!-- Firebase SDK (browser ESM via CDN) -->
  <script type="module" src="sidepanel.js"></script>

  <style>
    /* ── Reset & Base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #fafafa;
      color: #111;
      font-size: 14px;
      overflow: hidden;
    }

    /* ── Design tokens ── */
    :root {
      --bg-primary: #f2f2f7;
      --bg-secondary: #F2F2F7;
      --bg-body: #F9FAFB;
      --border-default: #d9d9d9;
      --border-secondary: #757575;
      --blink-accent: #BC13FE;
      --blink-accent-rgb: 188, 19, 254;
      --border-active: var(--blink-accent);
      --text-primary: #000000;
      --text-secondary: rgba(0, 0, 0, 0.2);
      --labels-secondary: rgba(60, 60, 67, 0.6);
      --overlay-default: rgba(0, 0, 0, 0.2);
      --space-50: 2px;
      --space-100: 4px;
      --space-150: 6px;
      --space-200: 8px;
      --space-300: 12px;
      --space-400: 16px;
      --corner-extra-small: 4px;
      --corner-small: 6px;
      --corner-medium: 12px;
      --accent: #BC13FE;
      --accent-rgb: 188, 19, 254;
      --accent-10: rgba(188, 19, 254, 0.10);
      --accent-20: rgba(188, 19, 254, 0.20);
      --border: #d9d9d9;
    }

    /* ── App shell ── */
    #app {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Login screen ── */
    #login-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      height: 100%;
      padding: 32px 24px;
    }
    #login-screen .logo {
      width: 48px;
      height: 48px;
      background: var(--accent);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 22px;
      font-weight: 700;
    }
    #login-screen h1 { font-size: 20px; font-weight: 700; text-align: center; }
    #login-screen p { font-size: 13px; color: var(--text-secondary); text-align: center; line-height: 1.5; }
    #btn-signin {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 20px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      transition: box-shadow 0.15s;
    }
    #btn-signin:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.14); }
    #btn-signin svg { width: 18px; height: 18px; flex-shrink: 0; }
    #login-error { font-size: 12px; color: #ef4444; text-align: center; display: none; }

    /* ── Dashboard screen ── */
    #dashboard-screen {
      display: none;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    /* ── Header ── */
    #sp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: #fff;
      flex-shrink: 0;
    }
    #sp-header .sp-logo {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 15px;
      color: var(--accent);
    }
    #sp-header .sp-logo-icon {
      width: 22px;
      height: 22px;
      background: var(--accent);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
    }
    #sp-user-section { display: flex; align-items: center; gap: 8px; }
    #sp-user-avatar {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      object-fit: cover;
      display: none;
    }
    #btn-signout {
      font-size: 11px;
      color: var(--text-secondary);
      background: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 3px 8px;
      cursor: pointer;
    }
    #btn-signout:hover { color: #111; border-color: #aaa; }

    /* ── Directory list ── */
    #sp-directory-list {
      flex-shrink: 0;
      overflow-y: auto;
      max-height: 200px;
      border-bottom: 1px solid var(--border);
      background: #fff;
    }
    .directory-item { border-bottom: 1px solid var(--border); }
    .directory-item-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.1s;
    }
    .directory-item-header:hover { background: var(--accent-10); }
    .directory-item-header.drag-over { background: var(--accent-20); }
    .directory-toggle { font-size: 10px; color: var(--text-secondary); transition: transform 0.15s; flex-shrink: 0; }
    .directory-item.expanded .directory-toggle { transform: rotate(90deg); }
    .directory-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .directory-items-container {
      display: none;
      flex-direction: column;
      gap: 0;
      padding: 0 8px 8px 8px;
      background: #f9fafb;
    }
    .directory-item.expanded .directory-items-container { display: flex; }

    /* ── Main item list ── */
    #sp-itemlist-wrap {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    #dock-itemlist {
      display: flex;
      flex-direction: column;
      gap: 0;
      min-height: 40px;
    }

    /* ── Card styles ── */
    .card-container { width: 100%; flex-shrink: 0; box-sizing: border-box; }
    .card-wrapper {
      position: relative;
      background: white;
      border: 1px solid var(--border-default);
      border-radius: var(--corner-extra-small);
      margin: 0 0 8px 0;
      width: 100%;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.25, 0.1, 0.25, 1.0),
                  height 0.3s cubic-bezier(0.2, 0, 0, 1),
                  opacity 0.3s ease;
      flex-shrink: 0;
      box-sizing: border-box;
      user-select: none;
    }
    .card-wrapper:hover {
      border-color: var(--border-secondary);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .card-wrapper:hover .data-card-header {
      max-height: 28px;
      opacity: 1;
      padding: var(--space-100) var(--space-150);
    }
    .card-wrapper.delete-pending .data-card-header {
      max-height: 28px;
      opacity: 1;
      padding: var(--space-100) var(--space-150);
    }
    .card-wrapper.active {
      border-color: var(--border-active);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .card-wrapper.is-dragging-source .data-card { opacity: 0.3; }

    .data-card {
      background: transparent;
      border: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-100);
      width: 100%;
      flex-shrink: 0;
    }
    .data-card * { pointer-events: none !important; }

    .data-card-header {
      position: relative;
      display: flex;
      flex-direction: row;
      align-items: stretch;
      justify-content: space-between;
      width: 100%;
      box-sizing: border-box;
      padding: 0 var(--space-150);
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      transition: max-height 200ms cubic-bezier(0.4, 0, 0.2, 1),
                  opacity 150ms ease,
                  padding 200ms cubic-bezier(0.4, 0, 0.2, 1),
                  background 200ms ease,
                  border-radius 200ms ease;
    }
    .data-card-domain-section {
      display: flex;
      align-items: center;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .data-card-url-text {
      font-family: 'Roboto', sans-serif;
      font-weight: 500;
      font-size: 10px;
      line-height: 1.3;
      color: var(--overlay-default);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .data-card-main {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: flex-start;
      gap: var(--space-100);
      width: 100%;
      min-width: 0;
      padding: var(--space-100) var(--space-150);
      box-sizing: border-box;
    }

    .data-card-imgcontainer {
      width: 100%;
      height: 40px;
      min-height: 40px;
      border-radius: var(--corner-small);
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      background: var(--bg-primary);
    }
    .data-card-imgcontainer.is-favicon {
      border-radius: 50%;
      background-color: #f0f0f0;
      width: 20px;
      height: 20px;
      min-height: 20px;
    }
    .data-card-imgcontainer.img-placeholder {
      background: var(--bg-primary);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .data-card-imgcontainer.img-placeholder::after {
      content: '';
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: var(--border-default);
      display: block;
    }
    .data-card-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .data-card-context {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      width: 100%;
    }
    .data-card-title {
      font-family: 'Roboto', sans-serif;
      font-weight: 600;
      font-size: 12px;
      line-height: 1.3;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
      margin: 0 0 2px 0;
    }
    .data-card-ai {
      display: none;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      padding: var(--space-100) var(--space-150);
      border-top: 1px solid var(--border-default);
      box-sizing: border-box;
    }
    .data-card-ai.has-content { display: flex; }
    .data-card-ai-type {
      font-family: 'Roboto', sans-serif;
      font-size: 9px;
      font-weight: 700;
      line-height: 1.3;
      color: var(--blink-accent);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .data-card-ai-summary {
      font-family: 'Roboto', sans-serif;
      font-size: 10px;
      font-weight: 400;
      line-height: 1.4;
      color: var(--labels-secondary);
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .data-card-delete {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      opacity: 0.3;
      cursor: pointer;
      transition: opacity 150ms ease;
      pointer-events: auto !important;
    }
    .data-card-delete * { pointer-events: auto !important; }
    .data-card-delete:hover { opacity: 1; }
    .data-card-delete-btn {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #ef4444;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .data-card-delete-btn svg {
      width: 55%;
      height: 55%;
      stroke: #fff;
      stroke-width: 2.5;
      fill: none;
    }

    .data-card-header.delete-pending {
      background: #ef4444;
      border-radius: 4px;
    }
    .data-card-header.delete-pending .data-card-domain-section { color: #fff; }
    .data-card-header.delete-pending .data-card-url-text {
      color: #fff;
      font-size: 11px;
      font-weight: 500;
    }
    .data-card-header.delete-pending .data-card-delete { opacity: 1; }
    .data-card-header.delete-pending .data-card-delete-btn { background: #fff; }
    .data-card-header.delete-pending .data-card-delete-btn svg { stroke: #ef4444; }

    .dnd-guide-wrapper {
      width: 100%;
      height: 2px;
      background: var(--accent);
      border-radius: 2px;
      margin: 2px 0;
      pointer-events: none;
      flex-shrink: 0;
    }

    .sp-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 32px 16px;
      color: var(--text-secondary);
      font-size: 13px;
      text-align: center;
    }

    .sp-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
      color: var(--text-secondary);
      font-size: 13px;
    }

    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; border-radius: 4px; }
    ::-webkit-scrollbar-thumb { background: rgba(var(--blink-accent-rgb), 0.22); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(var(--blink-accent-rgb), 0.35); }
  </style>
</head>
<body>
  <div id="app">

    <!-- Login Screen -->
    <div id="login-screen">
      <div class="logo">B</div>
      <h1>Welcome to Blink</h1>
      <p>Sign in to view and manage<br>your saved items.</p>
      <button id="btn-signin">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Sign in with Google
      </button>
      <p id="login-error"></p>
    </div>

    <!-- Dashboard Screen -->
    <div id="dashboard-screen">
      <div id="sp-header">
        <div class="sp-logo">
          <div class="sp-logo-icon">B</div>
          Blink
        </div>
        <div id="sp-user-section">
          <img id="sp-user-avatar" src="" alt="avatar" />
          <button id="btn-signout">Sign out</button>
        </div>
      </div>
      <div id="sp-directory-list"></div>
      <div id="sp-itemlist-wrap">
        <div id="dock-itemlist"></div>
      </div>
    </div>
  </div>
</body>
</html>
```

---

### browser-extension/chromium/manifest.json

```json
{
  "manifest_version": 3,
  "name": "Blink",
  "version": "1.0.0",
  "description": "Blink: save URLs and images with Cmd+Shift+S",
  "permissions": [
    "activeTab",
    "storage",
    "scripting",
    "tabs",
    "contextMenus",
    "windows",
    "sidePanel",
    "identity"
  ],
  "host_permissions": [
    "http://localhost:3000/*",
    "http://localhost:3001/*",
    "https://www.instagram.com/*",
    "https://*.cdninstagram.com/*",
    "https://*.fbcdn.net/*"
  ],
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content-loader.js"],
      "all_frames": true,
      "run_at": "document_start"
    }
  ],
  "background": {
    "service_worker": "background.js"
  },
  "web_accessible_resources": [
    {
      "resources": [
        "brandConfig.js",
        "stateLite.js",
        "coreEngine.js",
        "itemDetector.js",
        "dataExtractor.js",
        "uiManager.js",
        "urlResolver.js",
        "coreEntry.js",
        "sidepanel.html",
        "sidepanel.js",
        "sidepanel.css",
        "firebase-bundle.js"
      ],
      "matches": ["<all_urls>"]
    }
  ],
  "commands": {
    "save-url": {
      "suggested_key": {
        "default": "Ctrl+Shift+S",
        "mac": "Command+Shift+S"
      },
      "description": "Save current URL or hovered image"
    }
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "oauth2": {
    "client_id": "658386350246-kinolt4jf9l7131r76rnbii0407ookcj.apps.googleusercontent.com",
    "scopes": ["openid", "email", "profile"]
  },
  "action": {
    "default_title": "Blink",
    "default_popup": ""
  }
}
```

---

### client/src/main.ts

*Full file: ~1814 lines. Key sections:*
- `createWindow()`, `createTray()`, `createDropzoneWindow()`
- `registerShortcut()`, `manageShortcutRegistration()`, `startExtensionPingPolling()`
- `startPendingSaveServer()` (port 3001), `startFirestoreSaveServer()` (port 3002)
- IPC handlers: auth, firestore, dock, ghost, instagram
- `handleFirestoreSave()`, `getActiveBrowser()`, `showEnableExtensionDialog()`

---

### client/src/lib/firestore.ts

*Full file: ~678 lines. Key exports:*
- `SavedItemData`, `DirectoryData`, `InstagramSessionData`
- `saveData()`, `updateData()`, `deleteData()`, `deleteAllData()`
- `watchDatasByUser()`, `getDatasByUser()`, `getMinItemOrder()`
- `createDirectory()`, `getDirectoriesByUser()`, `watchDirectoriesByUser()`
- `updateItemDirectory()`, `moveItemToPosition()`, `moveDirectoryToPosition()`
- `saveInstagramSession()`, `getInstagramSession()`, `deleteInstagramSession()`

---

### server/.env.example

```env
# Blink Server Environment Variables
# Copy this file to .env and fill in your values

# Gemini AI API key (required for AI analysis)
# Get from: https://makersuite.google.com/app/apikey
GEMINI_API_KEY=your_gemini_api_key_here

# Firebase Admin SDK (optional - server uses this for direct Firestore saves when Electron is offline)
# Path to your Firebase service account JSON file
# Get from: Firebase Console > Project Settings > Service Accounts > Generate new private key
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
```

---

*End of Project Briefing.*

**Note for AI assistants:** For full contents of `server/src/server.ts`, `browser-extension/chromium/background.js`, `coreEntry.js`, `sidepanel.js`, `client/src/main.ts`, and `client/src/lib/firestore.ts`, use the `Read` tool on the source files. This briefing provides structure and key excerpts; the listed files contain the complete implementations.
