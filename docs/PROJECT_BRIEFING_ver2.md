# Blink — Project Briefing (ver 2)

**Purpose:** Onboard AI assistants and developers to the Blink codebase in a fresh session.  
**Last generated:** 2026-03-13 (reflects repo state at generation time).

---

## 1. Project Overview

### What Blink is
**Blink** is a productivity app for **saving URLs, pages, and hovered “CoreItems”** (e.g. feed cards, mail rows) from the browser, with optional **AI-generated type and summary** stored on each saved item. It combines:

- A **local Node server** (metadata, saves JSON log, AI, optional Firestore writes)
- An **Electron desktop app** (Firebase auth, Firestore CRUD, sidebar UI, global shortcut coordination)
- **Browser extensions** (Chromium primary; Firefox/Safari variants exist) that inject content scripts, detect ItemMaps, and POST saves to localhost

### Tech stack
| Area | Stack |
|------|--------|
| **Server** | Node.js, **Express**, TypeScript (ESM), **cheerio**, **node-fetch**, **robots-parser**, **firebase-admin** |
| **Electron** | **Electron ~31**, TypeScript → `dist/`, **Firebase Web SDK** (Auth, Firestore, Storage) |
| **Extension (Chromium)** | Vanilla JS, **Manifest V3**, service worker `background.js`, content scripts |
| **AI** | **Google Gemini** (`gemini-2.5-flash`) via REST, API key in `GEMINI_API_KEY` |

### Architecture (how pieces interact)
```
Browser (extension content script: coreEntry.js)
    → HTTP POST localhost:3000/api/v1/save-url  (+ optional Firestore fields / AI triggers)
    → Node server (server.ts): JSON file, metadata, may call Gemini + firebase-admin

Extension side panel
    → Google OAuth (chrome.identity) + Firebase Auth
    → Firestore reads/writes for user items (from extension context)

Electron main (main.ts)
    → IPC ↔ dashboard renderer; Firestore via firebase.ts / firestore.ts
    → localhost:3001 /pending-save — optimistic “placeholder” card from extension shortcut
    → localhost:3002 /save-to-firestore — direct save when appropriate

Extension background.js
    → Pings server (extension connected), proxies AI analyze, Instagram thumbnail/caption fetch
```

---

## 2. Project Structure (major paths, ~2–3 levels)

```
AppTest/
├── server/                    # Express API + AI + optional Admin Firestore
│   ├── src/server.ts          # Main server (see §3.1)
│   ├── data/saved-urls.json   # Local log of saves (when used)
│   └── .env.example           # GEMINI_API_KEY, GOOGLE_APPLICATION_CREDENTIALS
├── client/                    # Electron app
│   ├── src/main.ts            # Main process: window, IPC, HTTP listeners
│   ├── src/preload/preload.ts # contextBridge API
│   ├── src/lib/firebase.ts    # Firebase init
│   ├── src/lib/firestore.ts   # Firestore helpers (main process)
│   └── pages/dashboard/       # Sidebar UI (HTML/JS)
├── browser-extension/
│   └── chromium/              # Primary MV3 extension
│       ├── manifest.json
│       ├── background.js      # Service worker
│       ├── content-loader.js  # Injects core bundle
│       ├── coreEntry.js       # Hover, ItemMaps, save, AI tooltip
│       ├── coreEngine.js      # Re-exports detector / UI / dataExtractor
│       ├── itemDetector.js    # ItemMap Types A/B/C
│       ├── dataExtractor.js   # URLs, anchors, platform-specific extractors
│       ├── uiManager.js       # Highlights, green outlines, tooltip DOM
│       ├── sidepanel.js / sidepanel.html / sidepanel.css
│       └── firebase-bundle.js # Side panel Firebase
├── docs/                      # Audits + this briefing
├── firestore.rules            # User-scoped rules
└── README.md / USAGE_GUIDE.md
```

**Roles (short):** `itemDetector.js` finds repeatable “items” on pages; `coreEntry.js` ties hover → CoreItem → save payload; `background.js` does network Chrome can do without CORS; `server.ts` centralizes save pipeline and AI.

---

## 3. Component Breakdown

### 3.1 Server (`server/src/server.ts`)
- **Port:** `3000` (default `PORT = 3000`).
- **Framework:** Express + `express.json()`, CORS middleware for extension origins.

**API endpoints**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/save-url` | Accept save payload from extension/app; persist + metadata; may create Firestore doc + queue `updateDocumentWithAiAnalysis` |
| GET | `/api/v1/saved-urls` | Read recent entries from local JSON log (`?limit=`) |
| POST | `/api/v1/extension/ping` | Extension heartbeat; updates last-ping state |
| GET | `/api/v1/extension/status` | Returns whether extension is “connected” (recent ping) |
| GET | `/api/v1/dock/width` | Legacy/dock-related constant/width helper |
| POST | `/api/v1/firestore/move-item` | Admin: move item document (batch) |
| POST | `/api/v1/firestore/move-directory` | Admin: move directory |
| POST | `/api/v1/ai-analyze-url` | **Tooltip-only** Gemini type+summary for a single URL (no Firestore) |
| GET | `/api/v1/image-proxy` | Proxy fetch image bytes (CORS/helper) |
| GET | `/api/v1/logo/:domain` | Favicon/logo fetch helper |

**Key functions (non-exhaustive)**
- `detectCategoryAndType()` — Rule-based **category** (`SNS`, `Contents`, `Page`, `Mail`) + sometimes **confirmed** `ai_type` (e.g. Mail provider).
- `updateDocumentWithAiAnalysis()` — Two-step Gemini: (1) type, (2) summary; writes `ai_category`, `ai_type`, `ai_summary` on Firestore doc.
- `fetchPageTextContent()` — Server-side HTML fetch with **rotating User-Agent** strings for page-only analysis.
- `callGemini()` — POST to Generative Language API with API key query param.

**Environment variables**
- `GEMINI_API_KEY` — Required for AI paths.
- `GOOGLE_APPLICATION_CREDENTIALS` — Path to service account JSON for **firebase-admin** (Firestore updates from server).

### 3.2 Chrome extension (`browser-extension/chromium/`)

**manifest.json (summary)**
- **MV3**; `permissions`: activeTab, storage, scripting, tabs, contextMenus, windows, sidePanel, identity.
- **host_permissions**: localhost 3000/3001, Instagram CDN hosts.
- **content_scripts**: `content-loader.js` on `<all_urls>`, `all_frames: true`, `document_start`.
- **background**: service worker `background.js`.
- **commands**: `save-url` → Cmd+Shift+S (Mac).
- **side_panel**: `sidepanel.html`.
- **oauth2**: Google client id for side panel sign-in.

**Key files**
- **background.js** — Ping server; Cmd+Shift+S sends placeholder to `:3001/pending-save` then messages tab; redirect resolve; metadata fetch; Instagram thumbnail/caption; proxy `ai-analyze-url` to server.
- **coreEntry.js** — Loads engine; pointer/hover; **ItemMap** cluster pick; Type A/B/C CoreItem logic; `saveActiveCoreItem` / page save; `extractCoreItemHtmlContext`; optimistic flow + AI tooltip.
- **sidepanel.js / sidepanel.html** — Auth UI, Firestore listeners, **optimistic** merge of pending saves, DataCard rendering (incl. `ai_type`, `ai_summary`, `ai_category`).
- **uiManager.js** — Purple selection overlay, green/red/**blue** ItemMap outlines, metadata tooltip DOM, AI tooltip slots.

### 3.3 Electron (`client/`)
- **Entry:** `client/src/main.ts` after `dotenv.config()`.
- **Main process:** `BrowserWindow` (sidebar), tray, **globalShortcut** Cmd+Shift+S (coordinates with extension), **http.createServer** on **3001** (`/pending-save`) and **3002** (`/save-to-firestore`), Firestore save handler, Instagram thumbnail fallback fetch, ghost window drag helpers.
- **IPC (representative):** `auth:*`, `firestore:*`, `dock:*`, `shell:openExternal`, `window:*`, `instagram:*`, `ghost:*`, messages `pending-save`, `refresh-data`, `firestore:dataChanged`, etc.
- **Dashboard UI:** `pages/dashboard/main.html` + `main.js` — list of items, directories, drag-drop; listens for IPC.

### 3.4 Firebase / Firestore
- **Project ID:** Not fixed in repo — set via client `VITE_FIREBASE_*` / `FIREBASE_*` in `.env` (see `client/.env.example`). Use your own project in deployment.
- **Auth:** **Google OAuth** in Electron and extension side panel; **Instagram** session stored per user (see schema).
- **Schema (summary)** — See `docs/FIREBASE_FIRESTORE_SCHEMA_AUDIT.md`:
  - `users/{userId}/items/{itemId}` — `url`, `title`, `createdAt`, `userId`, `domain`, `type`, `img_url`, `thumbnail`, `saved_by`, `directoryId`, `order`, … plus **AI fields** `ai_type`, `ai_summary`, `ai_category` when written.
  - `users/{userId}/directories/{dirId}`
  - `users/{userId}/instagramSession/session`

---

## 4. Key Data Flows

### 4.1 Save: Cmd+Shift+S → **CoreItem** (with `htmlContext`)
1. User hovers an ItemMap element; `coreEntry.js` sets `state.activeCoreItem`, `state.activeHoverUrl`, metadata.
2. Shortcut or context menu → `saveActiveCoreItem()` builds payload: URL, title, `saved_by: 'extension'`, optional `img_url`, **`htmlContext`** from `extractCoreItemHtmlContext()`, `pageUrl`, **`userLanguage`** (navigator.language).
3. POST `http://localhost:3000/api/v1/save-url`.
4. Server writes local log / metadata; if Firestore doc created with `docPath`, calls **`updateDocumentWithAiAnalysis`** with `htmlContext` (CoreItem path = Page category prompts using context JSON).

### 4.2 Save: Cmd+Shift+S → **Page** (no CoreItem)
1. No active CoreItem → `extractPageOpenGraphMeta()` or tab URL/title.
2. Same POST without `htmlContext` (or empty).
3. Server uses **fetchPageTextContent** + URL-only fallbacks for AI; category/scoring uses URL + optional signals only.

### 4.3 Optimistic UI (coreEntry → background → sidepanel)
1. **background.js** immediately POSTs placeholder to **Electron** `localhost:3001/pending-save` with synthetic URL/title/timestamp.
2. **sidepanel.js** listens / merges **pending** rows so a card appears instantly.
3. When real save completes, Firestore snapshot or refresh replaces pending with real item.
4. **Iframe noise:** content scripts run in all frames; loader/main guard reduces double-injection / wrong-frame saves (see `content-loader.js` / `__blinkMainLoaded`).

### 4.4 AI analysis (server → Gemini → Firestore → side panel)
1. After save, server runs `updateDocumentWithAiAnalysis(docPath, { savedUrl, pageUrl, htmlContext, userLanguage })`.
2. Writes **`ai_category`** first (code rules).
3. Step 1: Gemini **type** prompt (branch: SNS / Page+context / Page+content / Contents / Mail uses code type).
4. Step 2: Gemini **summary** (language from `userLanguage`).
5. Updates Firestore: `ai_type`, `ai_summary` (and already set `ai_category`).
6. Side panel real-time listener updates DataCard.

### 4.5 OG image fetch (background, non-blocking)
- Thumbnail / OG enrichment may be requested via **background** `fetch` (e.g. Instagram CDN) so content scripts avoid CORS; failures are non-fatal and UI still shows save.

---

## 5. AI System

| Item | Detail |
|------|--------|
| **Provider / model** | Google **Gemini** `gemini-2.5-flash` via `generativelanguage.googleapis.com/v1beta/models/...:generateContent` |
| **Auth** | `GEMINI_API_KEY` as query parameter `?key=` |
| **Paths** | **CoreItem:** prompts include stringified `htmlContext` + Page type lists. **Page/no HTML:** `fetchPageTextContent` + page text in prompt. **SNS:** URL + `SNS_TYPE_LIST`. **URL-only:** infer from URL. |
| **Firestore fields** | `ai_category`, `ai_type`, `ai_summary` |
| **userLanguage** | From extension payload; mapped to summary language name (e.g. `ko` → Korean) in `SUMMARY_RULES`. |

**Note:** `/api/v1/ai-analyze-url` is a **separate** lightweight path for **tooltip preview** in the page (via background proxy), not the post-save Firestore pipeline.

---

## 6. Recently Completed Work (chronological themes)

1. **OG / image fetch** — Background/non-blocking patterns; Instagram media URL + caption helpers in `background.js`.
2. **Optimistic UI** — Placeholder pending save via port 3001; side panel merge; fixes for duplicate/iframe noise.
3. **AI analysis activation** — Server-side `updateDocumentWithAiAnalysis`, Firestore updates, extension passes `userLanguage` and context.
4. **Per-path prompt branching** — Categories SNS / Contents / Page / Mail; SNS types via list; Contents Image/Video; Page `PAGE_TYPE_LIST`.
5. **fetchPageTextContent** — Multiple **User-Agent** rotations for better fetch success.
6. **maxOutputTokens** — Removed / relaxed where applicable so Gemini responses are not truncated mid-JSON.
7. **User language-aware summaries** — `SUMMARY_RULES(summaryLanguage)` embedded in prompts.
8. **Additional (recent codebase themes)** — ItemMap **Type C** (Gmail/Naver mail), **detectCategoryAndType** weighted Contents scoring, **`htmlContext` image filters** (visual significance + effective rect for padding-top layouts), **Instagram Type B** shortcode-first resolution in `coreEntry.js`.

---

## 7. Known Issues & Limitations

- **Gemini:** Rate limits, quota, and occasional empty/malformed JSON; server logs warnings and skips partial updates.
- **Server fetch:** Many sites block bots, require login, or render via JS — `fetchPageTextContent` may return null → URL-only AI path.
- **Extension / Electron:** Localhost must be reachable; firewall kills save + AI.
- **Same-origin / security:** Mixed content, CSP, and MV3 service worker sleep can delay first message.
- **Instagram:** Private posts, CDN 403, API shape changes break thumbnail/caption helpers.
- **Firestore rules:** Must deploy rules matching `users/{userId}/...` paths; indexes may be needed for compound queries.

---

## 8. Current File State (full contents)

The following subsections contain **verbatim** file contents from the repository at the time this document was generated. For very large files, ensure your editor can handle large markdown blocks.

---

### Note on `manifest.json` path

The active Chromium manifest is at **`browser-extension/chromium/manifest.json`**. There is no `browser-extension/manifest.json` at repo root; Firefox/Safari use their own folders.


---

## 8.1 Full file: `server/.env.example`

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


### Full file: `server/src/server.ts`

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
  saved_by?: string; // 'extension' or undefined (for Electron app saves)
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, '../data/saved-urls.json');
const PORT = 3000;

const app = express();

// Enable CORS for browser extensions
// Extensions make requests from web page origins, so we need to allow cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json());

/**
 * Extracts the source (domain) from a URL.
 * Examples:
 * - https://www.google.com/search?q=test → "google"
 * - https://instagram.com/p/abc123 → "instagram"
 * - https://blog.naver.com/user/123 → "naver"
 */
const extractSource = (url: string): string => {
  try {
    // Handle empty URLs
    if (!url || url.trim().length === 0) {
      return 'local';
    }
    
    // Handle data: URLs (for dropped images)
    if (url.startsWith('data:')) {
      return 'local';
    }
    
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();
    
    // Remove www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    
    // Extract main domain (e.g., "blog.naver.com" → "naver", "m.youtube.com" → "youtube")
    const parts = hostname.split('.');
    
    // Handle common subdomains and extract the main domain
    const subdomainPrefixes = ['blog', 'm', 'mobile', 'www', 'mail', 'drive', 'docs', 'maps'];
    
    if (parts.length > 2 && subdomainPrefixes.includes(parts[0])) {
      // For subdomains like blog.naver.com, use the main domain
      return parts.slice(1, -1).join('.'); // Get middle parts (main domain)
    }
    
    // For standard domains like google.com, instagram.com
    // Return everything except the TLD
    if (parts.length >= 2) {
      return parts.slice(0, -1).join('.');
    }
    
    return hostname;
  } catch (error) {
    console.error('Failed to extract source from URL:', url, error);
    return 'unknown';
  }
};

/**
 * Determines the content type based on URL structure.
 * Analyzes path, query parameters, and domain patterns.
 */
const determineType = (url: string): string => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const searchParams = urlObj.searchParams;
    
    // Video content patterns
    if (
      pathname.includes('/watch') ||
      pathname.includes('/video') ||
      pathname.includes('/v/') ||
      pathname.includes('/embed/') ||
      searchParams.has('v') ||
      searchParams.has('video_id')
    ) {
      return 'video';
    }
    
    // Instagram Reels - check before general social_post patterns
    if (urlObj.hostname.includes('instagram.com') && pathname.startsWith('/reel/')) {
      return 'reels';
    }
    
    // Instagram Posts - check before general social_post patterns
    if (urlObj.hostname.includes('instagram.com') && pathname.startsWith('/p/')) {
      return 'instagram_post';
    }
    
    // Image patterns
    if (
      pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) ||
      pathname.includes('/image') ||
      pathname.includes('/photo') ||
      pathname.includes('/picture') ||
      pathname.includes('/img/')
    ) {
      return 'image';
    }
    
    // Social media post patterns (exclude Instagram /p/ since handled above)
    if (
      (urlObj.hostname.includes('pinterest.com') && pathname.startsWith('/pin/')) || // Pinterest pins
      (pathname.match(/\/p\/[^/]+/) && !urlObj.hostname.includes('instagram.com')) || // Other /p/ posts (not Instagram)
      pathname.match(/\/posts?\/[^/]+/) ||
      pathname.match(/\/status\/[^/]+/) || // Twitter/X status
      pathname.match(/\/tweet\/[^/]+/)
    ) {
      return 'social_post';
    }
    
    // Search results
    if (
      pathname.includes('/search') ||
      searchParams.has('q') ||
      searchParams.has('query') ||
      searchParams.has('search')
    ) {
      return 'search';
    }
    
    // Article/Blog post patterns
    if (
      pathname.match(/\/article[s]?\/[^/]+/) ||
      pathname.match(/\/post[s]?\/[^/]+/) ||
      pathname.match(/\/blog\/[^/]+/) ||
      pathname.match(/\/entry\/[^/]+/) ||
      pathname.match(/\/[0-9]{4}\/[0-9]{2}\/[^/]+/) // Date-based blog URLs
    ) {
      return 'article';
    }
    
    // Product/E-commerce patterns
    if (
      pathname.includes('/product') ||
      pathname.includes('/item') ||
      pathname.includes('/p/') && !pathname.includes('/p/') && urlObj.hostname.includes('shop') ||
      searchParams.has('product_id') ||
      searchParams.has('item_id')
    ) {
      return 'product';
    }
    
    // Profile/User page patterns
    if (
      pathname.match(/\/@[^/]+/) || // Twitter/Instagram handles
      pathname.match(/\/user[s]?\/[^/]+/) ||
      pathname.match(/\/profile[s]?\/[^/]+/) ||
      pathname.match(/\/people\/[^/]+/)
    ) {
      return 'profile';
    }
    
    // PDF/document patterns
    if (
      pathname.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i) ||
      pathname.includes('/document') ||
      pathname.includes('/file/')
    ) {
      return 'document';
    }
    
    // Playlist/Collection patterns
    if (
      pathname.includes('/playlist') ||
      pathname.includes('/collection') ||
      pathname.includes('/list/')
    ) {
      return 'collection';
    }
    
    // Default to 'webpage' for generic pages
    return 'webpage';
  } catch (error) {
    console.error('Failed to determine type from URL:', url, error);
    return 'webpage';
  }
};

const ensureDataFile = async () => {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      await fs.writeFile(DATA_FILE, '[]', 'utf-8');
    } else {
      throw err;
    }
  }
};

/**
 * Forwards save request to Electron app's Firestore save endpoint
 * Returns true if successful, false if Electron app is not available
 */
const forwardToElectronApp = async (payload: any): Promise<{ success: boolean; result?: any }> => {
  try {
    const response = await fetch('http://localhost:3002/save-to-firestore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      // Timeout after 2 seconds
      signal: AbortSignal.timeout(2000),
    });

    if (response.ok) {
      const result = await response.json();
      return { success: true, result };
    } else {
      const errorData = await response.json();
      console.log('Electron app returned error:', errorData);
      return { success: false };
    }
  } catch (error: any) {
    // Electron app is not available or connection failed
    if (error.name === 'AbortError' || error.code === 'ECONNREFUSED') {
      return { success: false };
    }
    console.error('Error forwarding to Electron app:', error);
    return { success: false };
  }
};

/**
 * Attempts to fetch the OpenGraph og:image from a given URL.
 * Returns the image URL string if found, or null if not available.
 */
async function fetchOpenGraphImage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept': 'text/html',
      },
      // 5 second timeout to avoid blocking the save flow
      signal: AbortSignal.timeout(5000),
    } as any);
    if (!response.ok) return null;
    const html = await response.text();
    // Match <meta property="og:image" content="...">
    // or    <meta content="..." property="og:image">
    const match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!match || !match[1]) return null;
    const imageUrl = match[1].trim();
    if (!imageUrl.startsWith('http')) return null;
    return imageUrl;
  } catch {
    return null;
  }
}

/**
 * Extracts OG/meta tags and body text from raw HTML.
 */
function extractTextFromHtml(html: string): string | null {
  const parts: string[] = [];

  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch?.[1]) parts.push(`Title: ${titleMatch[1].trim()}`);

  // og:title
  const ogTitleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{3,200})["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']{3,200})["'][^>]+property=["']og:title["']/i);
  if (ogTitleMatch?.[1]) parts.push(`OG Title: ${ogTitleMatch[1].trim()}`);

  // meta description
  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{3,500})["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']{3,500})["'][^>]+name=["']description["']/i);
  if (descMatch?.[1]) parts.push(`Description: ${descMatch[1].trim()}`);

  // og:description
  const ogDescMatch =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{3,500})["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']{3,500})["'][^>]+property=["']og:description["']/i);
  if (ogDescMatch?.[1]) parts.push(`OG Description: ${ogDescMatch[1].trim()}`);

  // twitter:description (additional fallback)
  const twitterDescMatch =
    html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{3,300})["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']{3,300})["'][^>]+name=["']twitter:description["']/i);
  if (twitterDescMatch?.[1] && !ogDescMatch?.[1]) {
    parts.push(`Twitter Description: ${twitterDescMatch[1].trim()}`);
  }

  // Body text (strip tags, collapse whitespace, first 600 chars)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    const bodyText = bodyMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 600);
    if (bodyText) parts.push(`Body: ${bodyText}`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Fetches and extracts meaningful text content from a page for AI summarization.
 * Tries multiple User-Agent strings to maximize access success rate.
 * Returns title + meta tags + body text, or null if all attempts fail.
 */
async function fetchPageTextContent(url: string): Promise<string | null> {
  const userAgents = [
    // Standard modern browser (most permissive)
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    // Googlebot (some sites serve cleaner HTML to bots)
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ];

  for (const userAgent of userAgents) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent':      userAgent,
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control':   'no-cache',
        },
        signal: AbortSignal.timeout(6000),
      } as any);

      if (!response.ok) continue;

      const html = await response.text();
      if (!html || html.trim().length < 100) continue;

      const result = extractTextFromHtml(html);

      // If we got meaningful meta content (title/description), return it
      if (result && result.length > 30) {
        return result;
      }
    } catch {
      // Try next User-Agent
      continue;
    }
  }

  return null;
}

/**
 * Fetches OpenGraph image in the background and updates the Firestore document.
 * Called after the initial save so it never blocks the save response.
 */
async function updateDocumentWithOgImage(
  docPath: string,
  pageUrl: string
): Promise<void> {
  try {
    const ogImage = await fetchOpenGraphImage(pageUrl);
    if (!ogImage) return;

    const db = getFirestore();
    await db.doc(docPath).update({ img_url: ogImage });
    console.log('🖼️  OG image updated for doc:', docPath.split('/').pop());
  } catch {
    // Silently ignore — image update is best-effort
  }
}

interface AiAnalysisContext {
  savedUrl:      string;
  pageUrl?:      string;
  htmlContext?:  Record<string, any>;
  isPageSave?:   boolean;
  userLanguage?: string;  // e.g. "ko", "en-US", "ja"
}

type ItemCategory = 'SNS' | 'Contents' | 'Page' | 'Mail';

const PAGE_TYPE_LIST = [
  'Company page',
  'Service page',
  'Product page',
  'Search',
  'Article',
  'News',
  'Other(___)',
];
const PAGE_TYPE_LIST_FORMATTED = PAGE_TYPE_LIST.map((t) => `- ${t}`).join('\n');

const CONTENTS_TYPE_LIST = ['Image', 'Video'];
const CONTENTS_TYPE_LIST_FORMATTED = CONTENTS_TYPE_LIST.map((t) => `- ${t}`).join('\n');

const SNS_TYPE_LIST = [
  'Profile',
  'Image post',
  'Reels post',
  'Writing post',
];
const SNS_TYPE_LIST_FORMATTED = SNS_TYPE_LIST.map((t) => `- ${t}`).join('\n');

const SNS_TYPE_ENFORCEMENT_RULE = `IMPORTANT: You MUST return one of the exact types listed above.
Never return a value outside this list.`;

const MAIL_TYPE_MAP: Record<string, string> = {
  'google.com': 'Gmail',
  'naver.com':  'Naver',
};

const PAGE_TYPE_ENFORCEMENT_RULE = `IMPORTANT: You MUST return one of the exact types listed above.
If none fits, you MUST use the format Other(X) where X is your own concise label.
Never return a value outside this format.`;

const CONTENTS_TYPE_ENFORCEMENT_RULE = `IMPORTANT: You MUST return either Image or Video.`;

function getBaseDomainForCategory(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.replace(/^www\./, '').split('.');
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

/**
 * Code-based category and type detection. No AI. Returns category and optionally
 * confirmedType when the category alone determines the exact type.
 */
function detectCategoryAndType(
  savedUrl: string,
  pageUrl: string | undefined,
  htmlContext: Record<string, any> | undefined
): { category: ItemCategory; confirmedType: string | null } {
  try {
    const u = new URL(savedUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // ── SNS (savedUrl-based, confirmedType always null — AI determines type) ─
    const isSnsUrl =
      (host.includes('instagram.com') && (path.startsWith('/p/') || path.startsWith('/reel/') || path.startsWith('/'))) ||
      (host.includes('x.com') || host.includes('twitter.com')) ||
      (host.includes('reddit.com') && (path.includes('/r/') || path.includes('/user/'))) ||
      (host.includes('threads.net')) ||
      (host.includes('linkedin.com') && (path.startsWith('/posts/') || path.includes('/feed/update/') || path.startsWith('/in/'))) ||
      (host.includes('facebook.com') && htmlContext) ||
      (host.includes('tiktok.com'));
    if (isSnsUrl) {
      return { category: 'SNS', confirmedType: null };
    }

    // ── Mail (subdomain === 'mail', confirmedType from base domain) ──────────
    const savedHostParts = host.split('.');
    // subdomain is 'mail' when host is e.g. mail.google.com, mail.naver.com
    const hasMailSubdomain = savedHostParts[0] === 'mail';
    if (hasMailSubdomain) {
      const baseDomain = getBaseDomainForCategory(savedUrl);
      const mailType = MAIL_TYPE_MAP[baseDomain] || 'Other';
      return { category: 'Mail', confirmedType: mailType };
    }

    // ── Immediate confirmation (URL-based only, when same origin) ───────────
    const savedDomain = getBaseDomainForCategory(savedUrl);
    const pageDomain  = pageUrl ? getBaseDomainForCategory(pageUrl) : '';
    const sameOrigin  = !!savedDomain && !!pageDomain && savedDomain === pageDomain;

    if (sameOrigin) {
      const imgExt = path.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i);
      if (imgExt) return { category: 'Contents', confirmedType: 'Image' };

      const videoExt = path.match(/\.(mp4|webm)$/i);
      if (videoExt) return { category: 'Contents', confirmedType: 'Video' };

      if (
        (host.includes('youtube.com') && path.includes('/watch')) ||
        host.includes('youtu.be') ||
        host.includes('vimeo.com') ||
        host.includes('twitch.tv')
      ) {
        return { category: 'Contents', confirmedType: 'Video' };
      }
    }

    // ── Weighted scoring (htmlContext + URL auxiliary signals) ────────────────
    let score = 0;

    // mediaRatio tiers — mutually exclusive (no stacking)
    const mediaRatio = Number(htmlContext?.mediaRatio) || 0;
    if (mediaRatio > 0.7) {
      score += 70;
    } else if (mediaRatio > 0.5) {
      score += 40;
    }

    // videoCount
    const videoCount = Number(htmlContext?.videoCount) || 0;
    if (videoCount > 0) score += 50;

    // imageCount + videoCount === 1
    const imageCount = Number(htmlContext?.imageCount) || 0;
    if (imageCount + videoCount === 1) score += 30;

    // URL auxiliary signals
    const urlExt = path.match(/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm)$/i);
    if (urlExt) score += 20;

    const isVideoHost =
      (host.includes('youtube.com') && path.includes('/watch')) ||
      host.includes('youtu.be') ||
      host.includes('vimeo.com') ||
      host.includes('twitch.tv');
    if (isVideoHost) score += 20;

    // Penalty: too many media elements → likely a card list, not a single piece of content
    if (imageCount + videoCount > 2) score -= 30;

    // Threshold
    if (score >= 100) {
      return { category: 'Contents', confirmedType: null };
    }

    // ── Page (default) ───────────────────────────────────────────────────────
    return { category: 'Page', confirmedType: null };
  } catch {
    return { category: 'Page', confirmedType: null };
  }
}

const TYPE_LIST = [
  'Company page',
  'Service page',
  'Search',
  'Article',
  'News',
  'Image',
  'Video',
  'SNS Post',
  'Product',
  'Other(___)',
];

const TYPE_LIST_FORMATTED = TYPE_LIST.map((t) => `- ${t}`).join('\n');

const TYPE_ENFORCEMENT_RULE = `IMPORTANT: You MUST return one of the exact types listed above.
If none fits, you MUST use the format Other(X) where X is your own concise label (e.g. Other(Recipe), Other(Forum)).
Never return a value outside this format.`;

const SUMMARY_RULES = (summaryLanguage: string) =>
  `   - Must be a complete sentence ending with a period
   - Must be between 40 and 100 characters
   - Must NOT start with "This page", "This URL", "This site", "This website", or "This is"
   - Must describe the actual subject matter (e.g. "Interior design ideas and room styling inspiration for modern homes.")
   - Must be written in ${summaryLanguage}`;

/**
 * Calls Gemini API with the given prompt and returns the raw text response.
 * Throws on non-ok response.
 */
async function callGemini(prompt: string): Promise<string> {
  const response = await fetch(
    `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    } as any
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText.substring(0, 100)}`);
  }

  const data = await response.json() as any;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * Parses type or summary from raw Gemini response using JSON parse + regex fallback.
 */
function parseJsonField(rawText: string, field: 'type' | 'summary'): string | null {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  let parsed: Record<string, string> | null = null;

  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;
      const val = parsed?.[field];
      if (val && typeof val === 'string') return val.trim();
    } catch {
      parsed = null;
    }
  }

  // Fallback: regex extraction
  if (field === 'type') {
    const typeMatch = rawText.match(/"type"\s*:\s*"([^"]+)"/);
    return typeMatch?.[1]?.trim() ?? null;
  }
  const summaryMatch =
    rawText.match(/"summary"\s*:\s*"([^"]+)"/) ||
    rawText.match(/"summary"\s*:\s*"([\s\S]+?)(?:"|$)/);
  const summaryRaw = summaryMatch?.[1] || '';
  const summary = summaryRaw.trimEnd().replace(/,?\s*$/, '');
  return summary || null;
}

/**
 * Analyzes a URL with Gemini AI in the background and updates the Firestore document.
 * Two-step flow: (1) extract type → write ai_type, (2) extract summary → write ai_summary.
 * URL-only fallback skips step 2.
 */
async function updateDocumentWithAiAnalysis(
  docPath: string,
  context: AiAnalysisContext
): Promise<void> {
  const { savedUrl, pageUrl, htmlContext, userLanguage } = context;
  const langCode = (userLanguage || 'en').split('-')[0].toLowerCase();
  const langMap: Record<string, string> = {
    ko: 'Korean', ja: 'Japanese', zh: 'Chinese', fr: 'French',
    de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    ru: 'Russian', ar: 'Arabic', hi: 'Hindi', nl: 'Dutch',
  };
  const summaryLanguage = langMap[langCode] || 'English';

  if (!GEMINI_API_KEY) {
    console.warn('[AI Analyze] GEMINI_API_KEY not set — skipping AI analysis');
    return;
  }

  const db = getFirestore();
  const docId = docPath.split('/').pop();

  try {
    // ── Code-based category detection (no AI) ────────────────────────────────
    const { category, confirmedType } = detectCategoryAndType(
      savedUrl,
      pageUrl,
      htmlContext
    );

    await db.doc(docPath).update({ ai_category: category });
    console.log('[AI Analyze] ✅ Category:', category);

    // Fetch page content once for Page save path (reused for type + summary)
    let pageContent: string | null = null;
    if (!htmlContext) {
      pageContent = await fetchPageTextContent(savedUrl);
    }

    // ── Step 1: extract type ─────────────────────────────────────────────────
    if (confirmedType) {
      await db.doc(docPath).update({ ai_type: confirmedType });
      console.log('[AI Analyze] ✅ Type (code-based):', confirmedType);
    } else {
      let typePrompt: string;

      if (category === 'SNS') {
        typePrompt = `You are determining what kind of SNS content a user saved.

Saved URL: ${savedUrl}

What type of SNS content is this? Choose the most accurate type from:

${SNS_TYPE_LIST_FORMATTED}

${SNS_TYPE_ENFORCEMENT_RULE}

Use these guidelines:
- Profile: the URL points to an SNS account or profile page (e.g. /username, /in/name, /u/name)
- Image post: a post that primarily contains one or more images
- Reels post: a post that primarily contains a video or reel
- Writing post: a post that is primarily text-based (no dominant image or video)

Return ONLY a raw JSON object with no markdown, no explanation:
{"type":"..."}`;
      } else if (category === 'Page') {
        if (htmlContext) {
          const contextStr = JSON.stringify({
            tagName:     htmlContext.tagName,
            href:        htmlContext.href,
            role:        htmlContext.role,
            ariaLabel:   htmlContext.ariaLabel,
            boundingBox: htmlContext.boundingBox,
            mediaRatio:  htmlContext.mediaRatio,
            imageCount:  htmlContext.imageCount,
            videoCount:  htmlContext.videoCount,
            images:      htmlContext.images,
            videos:      htmlContext.videos,
            innerText:   htmlContext.innerText,
          }, null, 0);

          typePrompt = `You are determining what a user saved from a web page.

Current page URL: ${pageUrl || ''}
Saved URL: ${savedUrl}
Saved item HTML context: ${contextStr}

The "Current page URL" is the page the user was browsing.
The "Saved URL" is the specific link they saved.
The "HTML context" describes the visual element they hovered over —
use tagName, mediaRatio, imageCount, videoCount, and innerText to infer
what kind of content was saved.

What did the user save? Choose the most accurate type from:

${PAGE_TYPE_LIST_FORMATTED}

${PAGE_TYPE_ENFORCEMENT_RULE}

Return ONLY a raw JSON object with no markdown, no explanation:
{"type":"..."}`;
        } else if (pageContent) {
          typePrompt = `You are determining what a user saved from a web page.

URL: ${savedUrl}

Page content:
${pageContent}

What did the user save? Choose the most accurate type from:

${PAGE_TYPE_LIST_FORMATTED}

${PAGE_TYPE_ENFORCEMENT_RULE}

Return ONLY a raw JSON object with no markdown, no explanation:
{"type":"..."}`;
        } else {
          typePrompt = `You are determining what a user saved from a web page.

URL: ${savedUrl}

No page content is available. Infer the type from the URL structure and domain.

What did the user save? Choose the most accurate type from:

${PAGE_TYPE_LIST_FORMATTED}

${PAGE_TYPE_ENFORCEMENT_RULE}

Return ONLY a raw JSON object with no markdown, no explanation:
{"type":"..."}`;
        }
      } else {
        // Contents category, confirmedType null — Image vs Video
        const contextStr = htmlContext
          ? JSON.stringify({
              tagName:     htmlContext.tagName,
              href:        htmlContext.href,
              mediaRatio:  htmlContext.mediaRatio,
              imageCount:  htmlContext.imageCount,
              videoCount:  htmlContext.videoCount,
              innerText:   htmlContext.innerText,
            }, null, 0)
          : '{}';

        typePrompt = `You are determining what a user saved. The saved item has media (images and/or videos).

Saved URL: ${savedUrl}
HTML context: ${contextStr}

Is it primarily an Image or Video? Choose from:

${CONTENTS_TYPE_LIST_FORMATTED}

${CONTENTS_TYPE_ENFORCEMENT_RULE}

Return ONLY a raw JSON object with no markdown, no explanation:
{"type":"..."}`;
      }

      const typeRawText = await callGemini(typePrompt);
      const aiType = parseJsonField(typeRawText, 'type');

      if (!aiType) {
        console.warn('[AI Analyze] ❌ Failed to parse type for:', savedUrl.substring(0, 60));
        console.warn('[AI Analyze] ❌ Raw response:', typeRawText.substring(0, 300));
        return;
      }

      await db.doc(docPath).update({ ai_type: aiType });
      console.log('[AI Analyze] ✅ Type:', aiType);
    }

    // URL-only fallback: no summary step
    if (!htmlContext && !pageContent) {
      return;
    }

    // ── Step 2: extract summary ─────────────────────────────────────────────
    let summaryPrompt: string;

    if (htmlContext) {
      const contextStr = JSON.stringify({
        tagName:     htmlContext.tagName,
        href:        htmlContext.href,
        role:        htmlContext.role,
        ariaLabel:   htmlContext.ariaLabel,
        boundingBox: htmlContext.boundingBox,
        mediaRatio:  htmlContext.mediaRatio,
        imageCount:  htmlContext.imageCount,
        videoCount:  htmlContext.videoCount,
        images:      htmlContext.images,
        videos:      htmlContext.videos,
        innerText:   htmlContext.innerText,
      }, null, 0);

      summaryPrompt = `You are summarizing the content a user saved from a web page.

Saved URL: ${savedUrl}
Current page URL: ${pageUrl || ''}
CoreItem HTML context: ${contextStr}

Write a summary that answers: "What is this content and what does it offer or cover?"

Rules:
${SUMMARY_RULES(summaryLanguage)}

Return ONLY a raw JSON object with no markdown fences, no explanation, no extra text:
{"summary":"..."}`;
    } else {
      summaryPrompt = `Summarize the following web page content.

URL: ${savedUrl}

Page content:
${pageContent}

Write a summary that answers: "What is this page and what does it offer or cover?"

Rules:
${SUMMARY_RULES(summaryLanguage)}

Return ONLY a raw JSON object. No markdown, no explanation, nothing else:
{"summary":"..."}`;
    }

    const summaryRawText = await callGemini(summaryPrompt);
    const aiSummary = parseJsonField(summaryRawText, 'summary');

    if (aiSummary) {
      await db.doc(docPath).update({ ai_summary: aiSummary });
      console.log('[AI Analyze]    Summary:', aiSummary);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[AI Analyze] ❌ Unexpected error for:', savedUrl.substring(0, 60), '|', msg);
  }
}

function getFirestore() {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  return admin.firestore();
}

// ── Firestore: Move item to position ─────────────────────────────────────
app.post('/api/v1/firestore/move-item', async (req: Request, res: Response) => {
  try {
    const { userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId } =
      req.body as {
        userId: string;
        itemId: string;
        targetDirectoryId: string | null;
        newIndex: number;
        sourceDirectoryId: string | null;
      };

    if (!userId || !itemId || newIndex == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Normalize directory IDs: null → "undefined" (matches existing convention)
    const targetDirFilter = targetDirectoryId == null ? 'undefined' : targetDirectoryId;
    const sourceDirFilter = sourceDirectoryId == null ? 'undefined' : sourceDirectoryId;

    const db = getFirestore();
    const itemsRef = db.collection(`users/${userId}/items`);

    // Fetch all items in target directory
    let targetSnap;
    try {
      targetSnap = await itemsRef
        .where('directoryId', '==', targetDirFilter)
        .orderBy('order', 'asc')
        .get();
    } catch {
      targetSnap = await itemsRef
        .where('directoryId', '==', targetDirFilter)
        .orderBy('createdAt', 'desc')
        .get();
    }

    // Fetch dragged item
    const draggedRef = itemsRef.doc(itemId);
    const draggedSnap = await draggedRef.get();
    if (!draggedSnap.exists) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const targetItems = targetSnap.docs
      .filter((d) => d.id !== itemId)
      .map((d) => ({ id: d.id, ref: d.ref }));

    // Insert dragged item at newIndex
    const clampedIndex = Math.max(0, Math.min(newIndex, targetItems.length));
    targetItems.splice(clampedIndex, 0, { id: itemId, ref: draggedRef });

    // Batch write
    const batch = db.batch();
    if (targetDirFilter !== sourceDirFilter) {
      batch.update(draggedRef, { directoryId: targetDirFilter });
    }
    targetItems.forEach(({ ref }, index) => {
      batch.update(ref, { order: index });
    });
    await batch.commit();

    return res.status(200).json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Firestore] move-item error:', msg);
    return res.status(500).json({ error: msg });
  }
});

// ── Firestore: Move directory to position ────────────────────────────────
app.post('/api/v1/firestore/move-directory', async (req: Request, res: Response) => {
  try {
    const { userId, directoryId, newIndex } = req.body as {
      userId: string;
      directoryId: string;
      newIndex: number;
    };

    if (!userId || !directoryId || newIndex == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = getFirestore();
    const dirsRef = db.collection(`users/${userId}/directories`);

    // Fetch all directories
    let dirsSnap;
    try {
      dirsSnap = await dirsRef.orderBy('order', 'asc').get();
    } catch {
      dirsSnap = await dirsRef.orderBy('createdAt', 'asc').get();
    }

    const dirs = dirsSnap.docs
      .filter((d) => d.id !== directoryId)
      .map((d) => ({ id: d.id, ref: d.ref }));

    const draggedRef = dirsRef.doc(directoryId);
    const draggedSnap = await draggedRef.get();
    if (!draggedSnap.exists) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const clampedIndex = Math.max(0, Math.min(newIndex, dirs.length));
    dirs.splice(clampedIndex, 0, { id: directoryId, ref: draggedRef });

    const batch = db.batch();
    dirs.forEach(({ ref }, index) => {
      batch.update(ref, { order: index });
    });
    await batch.commit();

    return res.status(200).json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Firestore] move-directory error:', msg);
    return res.status(500).json({ error: msg });
  }
});

app.post('/api/v1/ai-analyze-url', async (req: Request, res: Response) => {
  try {
    const { url } = req.body as { url: string };
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const prompt = `You are analyzing a URL to identify what kind of content it points to.

URL: ${url}

Rules for the summary field:
- Describe the content directly. Do NOT start with phrases like "This URL", "This page", "This website", "This link", or any reference to the URL itself.
- Write as if describing the content to someone who is about to read it.
- One or two sentences maximum.

Return ONLY a raw JSON object with no markdown fences, no explanation, no extra text:
{"type":"<one of: Article, Video, Product, Profile, Image, Repository, Music, Podcast, Document, News, Forum, Social Post, Dataset, Tool, Other>","summary":"<direct description of the content, no URL references>"}`;

    const geminiResponse = await fetch(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
        }),
      } as any
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error('[AI Analyze] Gemini API error:', errText);
      return res.status(502).json({ error: 'Gemini API error' });
    }

    const geminiData = await geminiResponse.json() as any;
    const rawText: string =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const jsonMatch = rawText.match(/\{[\s\S]*"type"[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[AI Analyze] No JSON found:', rawText.substring(0, 200));
      return res.status(502).json({ error: 'Failed to parse AI response' });
    }

    let parsed: { type: string; summary: string };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.error('[AI Analyze] Parse error:', jsonMatch[0].substring(0, 200));
      return res.status(502).json({ error: 'Failed to parse AI response' });
    }

    console.log('[AI Analyze] ✅', url.substring(0, 60));
    console.log('[AI Analyze] Type:', parsed.type, '| Summary:', parsed.summary?.substring(0, 80));

    return res.status(200).json(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[AI Analyze] Unexpected error:', msg);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/v1/save-url', async (req: Request, res: Response) => {
  const { url, title, timestamp, img_url, saved_by, type } = req.body as Omit<SaveUrlPayload, 'domain'> & { 
    img_url?: string;
    saved_by?: string;
    type?: string; // Type from extension (e.g., 'instagram_post')
  };

  const isValidString = (value: unknown) =>
    typeof value === 'string' && value.trim().length > 0;
  const isValidStringOrEmpty = (value: unknown) =>
    typeof value === 'string'; // Allow empty strings
  const isValidTimestamp = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value);

  // Allow empty URL if img_url is present (for dropped images)
  const urlValidation = img_url ? isValidStringOrEmpty(url) : isValidString(url);
  
  if (!urlValidation || !isValidString(title) || !isValidTimestamp(timestamp)) {
    console.log('Validation failed:', { url: url?.substring(0, 50), title, timestamp, img_url: img_url ? 'present' : 'missing' });
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Use img_url from payload directly — OG image fetch is done in background after save
  const resolvedImgUrl = img_url ? img_url.trim() : '';

  // Prepare payload for forwarding (will add domain later, but preserve type from extension)
  const rawPayload = {
    url: url ? url.trim() : '',
    title: title.trim(),
    timestamp,
    ...(type && { type: type.trim() }),
    ...(resolvedImgUrl && { img_url: resolvedImgUrl }),
    ...(req.body.thumbnail && { thumbnail: req.body.thumbnail.trim() }),
    ...(saved_by && { saved_by }),
  };

  // Try to forward to Electron app first (for Firestore save)
  const forwardResult = await forwardToElectronApp(rawPayload);
  
  if (forwardResult.success && forwardResult.result?.success) {
    const documentId = forwardResult.result.documentId;
    console.log('✅ Saved to Firestore via Electron app:', documentId);

    const forwardedUrl = rawPayload.url;
    const userId = (req.body as any).userId as string | undefined;

    if (forwardedUrl && documentId && userId) {
      const docPath = `users/${userId}/items/${documentId}`;
      // Background: OG image fetch
      if (!resolvedImgUrl) {
        updateDocumentWithOgImage(docPath, forwardedUrl);
      }
      // Background: AI analysis
      const aiPageUrl     = (req.body as any).pageUrl     as string | undefined;
      const aiHtmlContext = (req.body as any).htmlContext  as Record<string, any> | undefined;
      const aiUserLanguage = (req.body as any).userLanguage as string | undefined;
      updateDocumentWithAiAnalysis(docPath, {
        savedUrl:      forwardedUrl,
        pageUrl:       aiPageUrl,
        htmlContext:   aiHtmlContext,
        isPageSave:    !aiHtmlContext,
        userLanguage:  aiUserLanguage,
      });
    }

    return res.status(201).json({
      success: true,
      entry: { ...rawPayload, id: documentId },
      savedTo: 'firestore',
    });
  }

  // Fallback: try Firestore direct save if userId is present
  const userId = (req.body as any).userId as string | undefined;
  console.log('[save-url] userId in payload:', userId ? userId.substring(0, 8) + '...' : 'MISSING');

  if (userId && typeof userId === 'string' && userId.trim().length > 0) {
    try {
      const uid = userId.trim();
      const db  = getFirestore();
      const itemsRef = db.collection(`users/${uid}/items`);

      const domain = (url && url.trim().length > 0)
        ? extractSource(url)
        : (resolvedImgUrl ? 'local' : 'unknown');

      const itemType = rawPayload.type
        ? rawPayload.type
        : resolvedImgUrl
          ? 'image'
          : url && url.trim().length > 0
            ? determineType(url)
            : 'image';

      // Get current minimum order value (fetch only 1 document)
      let newOrder = 0;
      try {
        const minSnap = await itemsRef
          .orderBy('order', 'asc')
          .limit(1)
          .get();
        if (!minSnap.empty) {
          const minOrderVal = minSnap.docs[0].data().order;
          newOrder = typeof minOrderVal === 'number' ? minOrderVal - 1 : 0;
        }
      } catch {
        newOrder = 0;
      }

      const firestoreEntry: Record<string, any> = {
        url:         url ? url.trim() : '',
        title:       rawPayload.title,
        timestamp,
        domain,
        type:        itemType,
        directoryId: 'undefined',
        order:       newOrder,
        saved_by:    saved_by || 'browser-extension',
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      };
      if (resolvedImgUrl) firestoreEntry.img_url = resolvedImgUrl;

      const newDocRef = itemsRef.doc();
      await newDocRef.set(firestoreEntry);

      console.log('✅ Saved directly to Firestore (Electron offline):', newDocRef.id);

      const docPath = `users/${uid}/items/${newDocRef.id}`;
      // Background: OG image fetch
      if (!resolvedImgUrl && url && url.trim().length > 0) {
        updateDocumentWithOgImage(docPath, url.trim());
      }
      // Background: AI analysis
      if (url && url.trim().length > 0) {
        const aiPageUrl     = (req.body as any).pageUrl     as string | undefined;
        const aiHtmlContext = (req.body as any).htmlContext  as Record<string, any> | undefined;
        const aiUserLanguage = (req.body as any).userLanguage as string | undefined;
        updateDocumentWithAiAnalysis(docPath, {
          savedUrl:      url.trim(),
          pageUrl:       aiPageUrl,
          htmlContext:   aiHtmlContext,
          isPageSave:    !aiHtmlContext,
          userLanguage:  aiUserLanguage,
        });
      }

      return res.status(201).json({
        success: true,
        entry: { ...firestoreEntry, id: newDocRef.id },
        savedTo: 'firestore-direct',
      });
    } catch (firestoreErr) {
      const msg = firestoreErr instanceof Error ? firestoreErr.message : String(firestoreErr);
      console.error('[Firestore Direct] Save failed:', msg);
      // Fall through to local JSON
    }
  }

  // Final fallback: local JSON file
  try {
    await ensureDataFile();
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    let existing: SaveUrlPayload[] = [];
    try {
      const parsed = JSON.parse(raw);
      existing = Array.isArray(parsed) ? parsed : [];
    } catch (parseError) {
      console.error('Failed to parse existing saved-urls.json, starting fresh:', parseError);
      existing = [];
      await fs.writeFile(DATA_FILE, '[]', 'utf-8');
    }

    const domain = (url && url.trim().length > 0)
      ? extractSource(url)
      : (resolvedImgUrl ? 'local' : 'unknown');

    let localType: string;
    if (resolvedImgUrl) {
      localType = 'image';
    } else if (url && url.trim().length > 0) {
      localType = determineType(url);
    } else {
      localType = 'image';
    }

    const entry: SaveUrlPayload = {
      url: url ? url.trim() : '',
      title: title.trim(),
      timestamp,
      domain,
      type: localType,
      ...(resolvedImgUrl && { img_url: resolvedImgUrl }),
      ...(saved_by && { saved_by }),
    };

    const updated = [entry, ...existing];
    await fs.writeFile(DATA_FILE, JSON.stringify(updated, null, 2), 'utf-8');

    console.log('⚠️  Saved to local JSON (no userId, Electron offline):', {
      url: entry.url || '(empty)',
      type: entry.type,
      hasImgUrl: !!entry.img_url,
    });

    return res.status(201).json({ success: true, entry, savedTo: 'local' });
  } catch (err) {
    console.error('Failed to save URL:', err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'Internal server error', details: errorMessage });
  }
});

// GET endpoint to check recent saved URLs (to detect if extension is enabled)
app.get('/api/v1/saved-urls', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string);
    
    await ensureDataFile();
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    const existing: SaveUrlPayload[] = Array.isArray(JSON.parse(raw))
      ? (JSON.parse(raw) as SaveUrlPayload[])
      : [];
    
    // If limit is provided and valid, use it; otherwise return all entries
    if (limit && limit > 0) {
      const limited = existing.slice(0, limit);
      return res.status(200).json(limited);
    }
    
    // Return all entries if no limit specified or limit is 0
    return res.status(200).json(existing);
  } catch (err) {
    console.error('Failed to get saved URLs', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Store last ping timestamp (in-memory, resets on server restart)
let lastExtensionPing: number = 0;

// Extension connection ping endpoint
app.post('/api/v1/extension/ping', async (req: Request, res: Response) => {
  try {
    const { version, timestamp } = req.body;
    
    // Update last ping timestamp
    lastExtensionPing = Date.now();
    
    // Log the ping (optional: store in memory or file for tracking)
    console.log(`Extension ping received${version ? ` (version: ${version})` : ''}`);
    
    // Return success
    return res.status(200).json({ 
      success: true, 
      message: 'Ping received',
      serverTime: Date.now()
    });
  } catch (err) {
    console.error('Failed to handle extension ping:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Image proxy ───────────────────────────────────────────────────────────────
app.get('/api/v1/image-proxy', async (req: Request, res: Response) => {
  const imageUrl = req.query.url as string;

  if (!imageUrl || typeof imageUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Basic URL validation
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(imageUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        // Mimic browser request to satisfy CDN referer checks
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`,
      },
    } as any);

    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
    }

    // Forward content-type and cache headers
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream the image body directly to the response
    const buffer = await response.arrayBuffer();
    return res.send(Buffer.from(buffer));

  } catch (err: any) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Image fetch timeout' });
    }
    console.error('[Image Proxy] Error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch image' });
  }
});

// Endpoint for native app to check if extension is connected
app.get('/api/v1/extension/status', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    const timeSincePing = now - lastExtensionPing;
    const isConnected = timeSincePing < 30000; // 30 seconds timeout
    
    return res.status(200).json({
      connected: isConnected,
      lastPing: lastExtensionPing,
      timeSincePing: timeSincePing
    });
  } catch (err) {
    console.error('Failed to get extension status:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint for extension to get dock window width
// The dock width matches DOCK_WIDTH constant in client/src/main.ts (250px)
app.get('/api/v1/dock/width', async (req: Request, res: Response) => {
  try {
    return res.status(200).json({
      width: 250, // DOCK_WIDTH constant from Electron app
      unit: 'px'
    });
  } catch (err) {
    console.error('Failed to get dock width:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Logo cache (in-memory, simple implementation)
interface LogoCacheEntry {
  url: string;
  timestamp: number;
}
const logoCache = new Map<string, LogoCacheEntry>();
const LOGO_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [domain, entry] of logoCache.entries()) {
    if (now - entry.timestamp > LOGO_CACHE_DURATION) {
      logoCache.delete(domain);
    }
  }
}, 60 * 60 * 1000); // Clean up every hour

/**
 * Extracts root domain from a domain string (e.g., "store.hanssem.com" -> "hanssem.com")
 */
function getRootDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length > 2) {
    // For subdomains, return root domain (last two parts: domain.tld)
    return parts.slice(-2).join('.');
  }
  return domain;
}

/**
 * Fetches logo/favicon for a domain using multiple fallback methods
 * For subdomains, tries root domain first (brand logos are typically on root domain)
 */
async function fetchLogoUrl(domain: string): Promise<string | null> {
  // Check cache first for the exact domain
  const cached = logoCache.get(domain);
  if (cached && (Date.now() - cached.timestamp < LOGO_CACHE_DURATION)) {
    return cached.url;
  }

  // If domain is a subdomain, try root domain first
  const rootDomain = getRootDomain(domain);
  const shouldTryRootDomain = rootDomain !== domain;
  
  if (shouldTryRootDomain) {
    // Check cache for root domain
    const rootCached = logoCache.get(rootDomain);
    if (rootCached && (Date.now() - rootCached.timestamp < LOGO_CACHE_DURATION)) {
      // Cache the root domain result for the subdomain too
      logoCache.set(domain, rootCached);
      return rootCached.url;
    }
    
    // Try fetching logo for root domain first
    const rootLogoUrl = await fetchLogoUrlForDomain(rootDomain);
    if (rootLogoUrl) {
      // Cache for both root domain and subdomain
      const cacheEntry = { url: rootLogoUrl, timestamp: Date.now() };
      logoCache.set(rootDomain, cacheEntry);
      logoCache.set(domain, cacheEntry);
      return rootLogoUrl;
    }
  }

  // If root domain failed or domain is already root, try the original domain
  return await fetchLogoUrlForDomain(domain);
}

/**
 * Internal function that actually fetches logo for a specific domain
 */
async function fetchLogoUrlForDomain(domain: string): Promise<string | null> {
  // Try multiple methods in order
  const methods = [
    // Method 1: Direct favicon.ico
    async () => {
      try {
        const url = `https://${domain}/favicon.ico`;
        const response = await fetch(url, { 
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' }
        } as any);
        if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
          return url;
        }
      } catch (err) {
        // Ignore errors, try next method
      }
      return null;
    },
    
    // Method 2: Google's favicon service
    async () => {
      try {
        const url = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
        const response = await fetch(url, { method: 'HEAD' } as any);
        if (response.ok) {
          return url;
        }
      } catch (err) {
        // Ignore errors, try next method
      }
      return null;
    },
    
    // Method 3: DuckDuckGo's favicon service
    async () => {
      try {
        const url = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
        const response = await fetch(url, { method: 'HEAD' } as any);
        if (response.ok) {
          return url;
        }
      } catch (err) {
        // Ignore errors, try next method
      }
      return null;
    },
    
    // Method 4: Try common favicon paths
    async () => {
      const commonPaths = ['/favicon.png', '/apple-touch-icon.png', '/logo.png', '/logo.svg'];
      for (const path of commonPaths) {
        try {
          const url = `https://${domain}${path}`;
          const response = await fetch(url, { 
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0' }
          } as any);
          if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
            return url;
          }
        } catch (err) {
          // Continue to next path
        }
      }
      return null;
    },
  ];

  // Try each method sequentially
  for (const method of methods) {
    try {
      const url = await method();
      if (url) {
        // Cache the successful result
        logoCache.set(domain, { url, timestamp: Date.now() });
        return url;
      }
    } catch (err) {
      // Continue to next method
      continue;
    }
  }

  // All methods failed
  return null;
}

// Endpoint to get logo URL for a domain
app.get('/api/v1/logo/:domain', async (req: Request, res: Response) => {
  try {
    const domain = decodeURIComponent(req.params.domain);
    
    // Validate domain format
    if (!domain || !/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const logoUrl = await fetchLogoUrl(domain);
    
    if (logoUrl) {
      return res.status(200).json({ url: logoUrl });
    } else {
      // Return null to indicate no logo found (client can use default)
      return res.status(200).json({ url: null });
    }
  } catch (err) {
    console.error('Failed to fetch logo:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


```


### Full file: `browser-extension/chromium/background.js`

```javascript
// Track last ping time to detect if we should ping on focus
let lastPingTime = 0;

/**
 * Reads the cached Firebase userId from chrome.storage.local.
 * Set by sidepanel.js on sign-in.
 * Returns null if not available.
 */
async function getCachedUserId() {
  try {
    const result = await chrome.storage.local.get('blinkUserId');
    return result?.blinkUserId || null;
  } catch {
    return null;
  }
}

/**
 * Resolve redirect URL to final destination
 * Follows redirects and returns the final URL
 * 
 * @param {string} url - The URL to resolve
 * @returns {Promise<string>} - The resolved URL (or original if resolution fails)
 */
async function resolveRedirect(url) {
  const startTime = Date.now();
  
  try {
    // Create AbortController for timeout (increased to 5 seconds for complex redirect chains)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000); // 5 second timeout

    // Try GET method first (more reliable for redirect chains than HEAD)
    // Some servers don't properly handle HEAD requests for redirects
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow', // Follow redirects automatically
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    clearTimeout(timeoutId);

    // response.url contains the final URL after all redirects
    const finalUrl = response.url;

    // Return the final URL (or original if same)
    return finalUrl || url;
  } catch (error) {
    const elapsedTime = Date.now() - startTime;
    
    // Handle timeout, network errors, etc.
    if (error.name === 'AbortError') {
      return url; // Return original URL on timeout
    } else if (error.message && error.message.includes('CORS')) {
      return url; // Return original URL on CORS error
    } else if (error.message && error.message.includes('Failed to fetch')) {
      return url; // Return original URL on network error
    } else {
      return url; // Return original URL on error
    }
  }
}

/**
 * Fetch metadata (title and description) from a URL
 * Uses fetch API to avoid CORS issues (background worker has broader permissions)
 * 
 * @param {string} url - The URL to fetch metadata from
 * @returns {Promise<{title: string|null, description: string|null}>}
 */
async function fetchMetadata(url) {
  try {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 second timeout

    // Fetch the HTML
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Get HTML text
    const html = await response.text();

    // Parse title
    let title = null;
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim();
      // Decode HTML entities
      title = title.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&nbsp;/g, ' ');
    }

    // Parse description from meta tags
    let description = null;
    
    // Try og:description first
    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (ogDescMatch && ogDescMatch[1]) {
      description = ogDescMatch[1].trim();
    } else {
      // Fallback to standard description meta tag
      const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
      if (descMatch && descMatch[1]) {
        description = descMatch[1].trim();
      }
    }

    // Decode HTML entities in description
    if (description) {
      description = description.replace(/&amp;/g, '&')
                               .replace(/&lt;/g, '<')
                               .replace(/&gt;/g, '>')
                               .replace(/&quot;/g, '"')
                               .replace(/&#39;/g, "'")
                               .replace(/&nbsp;/g, ' ');
    }

    return { title, description };
  } catch (error) {
    // Handle timeout, network errors, etc.
    if (error.name === 'AbortError') {
      return { title: null, description: null };
    } else {
      return { title: null, description: null };
    }
  }
}

// Send connection ping to native app when extension starts
const sendConnectionPing = async () => {
  try {
    const response = await fetch('http://localhost:3000/api/v1/extension/ping', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: chrome.runtime.getManifest().version,
        timestamp: Date.now(),
        browser: 'chrome'
      }),
    });
    
    if (response.ok) {
      lastPingTime = Date.now();
    }
  } catch (error) {
    // Silently fail if server is not available (native app might not be running)
  }
};

// Send ping when extension starts/loads or service worker wakes up
// This happens when Chrome becomes active after being inactive
sendConnectionPing();

// Send ping periodically to maintain connection state (every 20 seconds)
setInterval(() => {
  sendConnectionPing();
}, 20000);

// Send ping when Chrome window gains focus (Chrome becomes active)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    // Chrome window gained focus - check if enough time has passed since last ping
    const timeSinceLastPing = Date.now() - lastPingTime;
    // If more than 5 seconds have passed, send a ping to refresh connection state
    if (timeSinceLastPing > 5000) {
      sendConnectionPing();
    }
  }
});

// Send ping when a tab becomes active (user switches to Chrome tab)
chrome.tabs.onActivated.addListener((activeInfo) => {
  const timeSinceLastPing = Date.now() - lastPingTime;
  // If more than 5 seconds have passed, send a ping to refresh connection state
  if (timeSinceLastPing > 5000) {
    sendConnectionPing();
  }
});

// Listen for keyboard shortcut command
chrome.commands.onCommand.addListener((command) => {
  if (command === 'save-url') {
    
    // IMMEDIATELY send placeholder to Electron app (before any async operations)
    // This ensures instant UI feedback
    const timestamp = Date.now();
    const placeholderPayload = {
      url: 'about:blank',
      title: 'Loading...',
      timestamp: timestamp,
      saved_by: 'extension',
    };
    
    // Send placeholder IMMEDIATELY (fire and forget, don't await)
    fetch('http://localhost:3001/pending-save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(placeholderPayload),
    }).catch(() => {
      // Silently fail if Electron app is not running
    });
    
    // Now send message to active tab's content script to process the save
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0 && tabs[0]) {
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url || 'unknown';
        
        // Check if this is a system page where we can't inject
        if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('arc://')) {
          return;
        }
        
        // Try to send message to content script (should be already injected via manifest)
        chrome.tabs.sendMessage(tabId, { action: 'save-url' }, (response) => {
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            
            // Content script might not be injected on this page (expected on some pages)
            // Only try programmatic injection if the error suggests the script isn't there
            const isConnectionError = errorMsg.includes('Could not establish connection') || 
                                     errorMsg.includes('Receiving end does not exist') || 
                                     errorMsg.includes('message port closed');
            
            if (isConnectionError) {
              // Probe: check if main.js is loaded (may still be loading via async import)
              chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => !!window.__blinkMainLoaded
              }).then((results) => {
                const mainLoaded = results && results[0] && results[0].result === true;
                if (mainLoaded) {
                  // main.js is present; retry sendMessage without injecting content.js
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: 'save-url' }, () => {});
                  }, 200);
                } else {
                  // main.js absent; inject loader fallback
                  chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content-loader.js']
                  }).then(() => {
                    setTimeout(() => {
                      chrome.tabs.sendMessage(tabId, { action: 'save-url' }, () => {});
                    }, 300);
                  }).catch(() => {
                    // Silently handle injection failures - expected on system pages
                  });
                }
              }).catch(() => {
                // Probe failed; fall back to loader injection
                chrome.scripting.executeScript({
                  target: { tabId: tabId },
                  files: ['content-loader.js']
                }).then(() => {
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: 'save-url' }, () => {});
                  }, 300);
                }).catch(() => {});
              });
            }
            // Silently ignore expected connection errors - they occur on pages where content scripts can't run
  }
});
      }
    });
  }
});

// Create context menu items
function createContextMenus() {
  // Remove existing menus first to avoid duplicates
  chrome.contextMenus.removeAll(() => {
    // Create context menu for images
    chrome.contextMenus.create({
      id: 'save-image',
      title: 'Save image with Blink',
      contexts: ['image']
    });

    // Create context menu for links
    chrome.contextMenus.create({
      id: 'save-link',
      title: 'Save link with Blink',
      contexts: ['link']
    });

    // Create context menu for page
    chrome.contextMenus.create({
      id: 'save-page',
      title: 'Save page with Blink',
      contexts: ['page', 'selection']
    });
  });
}

// Create context menus on install
chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

// Also create context menus when service worker starts (for existing installations)
createContextMenus();

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Check if this is a system page where we can't inject
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('arc://'))) {
    return;
  }

  if (info.menuItemId === 'save-image') {
    saveImageFromContextMenu(tab, info.srcUrl);
  } else if (info.menuItemId === 'save-link') {
    saveLinkFromContextMenu(tab, info.linkUrl, info.linkText || '');
  } else if (info.menuItemId === 'save-page') {
    savePageFromContextMenu(tab);
  }
});

// Helper function to save image from context menu
function saveImageFromContextMenu(tab, imageUrl) {
  // Get current page info and send to content script to check for tool data
  chrome.tabs.sendMessage(tab.id, { 
    action: 'save-url',
    img_url: imageUrl,
    from_context_menu: true
  }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script might not be injected, try to inject it
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-loader.js']
      }).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { 
            action: 'save-url',
            img_url: imageUrl,
            from_context_menu: true
          });
        }, 300);
      }).catch(() => {
        // Fallback: save directly without tool data
        saveDirectly(tab, imageUrl, null);
      });
    }
  });
}

// Helper function to save link from context menu
function saveLinkFromContextMenu(tab, linkUrl, linkText) {
  const payload = {
    url: linkUrl,
    title: linkText || linkUrl,
    timestamp: Date.now(),
    saved_by: 'extension'
  };
  
  saveDirectly(tab, null, payload);
}

// Helper function to save page from context menu (same as keyboard shortcut)
function savePageFromContextMenu(tab) {
  // Use the same logic as keyboard shortcut
  chrome.tabs.sendMessage(tab.id, { action: 'save-url' }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script might not be injected, try to inject it
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-loader.js']
      }).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'save-url' });
        }, 300);
      }).catch(() => {});
    }
  });
}

// Helper function to save directly to server (fallback when content script unavailable)
async function saveDirectly(tab, imageUrl, payload) {
  const userId = await getCachedUserId();

  const finalPayload = payload || {
    url: tab.url,
    title: tab.title,
    timestamp: Date.now(),
    saved_by: 'extension',
    ...(imageUrl && { img_url: imageUrl }),
  };

  // Inject userId if available and not already present
  if (userId && !finalPayload.userId) {
    finalPayload.userId = userId;
  }

  try {
    await fetch('http://localhost:3000/api/v1/save-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });
  } catch (error) {
    // Silently fail
  }
}

// ========================================
// Instagram Post Data Extraction (Thumbnail + Caption)
// ========================================

/**
 * Extracts Instagram post caption from JSON API response
 * Tries multiple JSON paths to find the caption text
 * 
 * @param {Object} jsonData - Parsed JSON response from Instagram API
 * @returns {string|null} - Caption text or null if not found
 */
function extractCaptionFromJson(jsonData) {
  if (!jsonData || typeof jsonData !== 'object') {
    return null;
  }
  
  try {
    // Path 1: data.items[0].caption.text (newer API format)
    if (jsonData.data && Array.isArray(jsonData.data.items) && jsonData.data.items.length > 0) {
      const caption = jsonData.data.items[0].caption?.text;
      if (caption && typeof caption === 'string') {
        return caption.trim();
      }
    }
    
    // Path 2: graphql.shortcode_media.edge_media_to_caption.edges[0].node.text (GraphQL format)
    if (jsonData.graphql && jsonData.graphql.shortcode_media) {
      const edges = jsonData.graphql.shortcode_media.edge_media_to_caption?.edges;
      if (Array.isArray(edges) && edges.length > 0) {
        const caption = edges[0].node?.text;
        if (caption && typeof caption === 'string') {
          return caption.trim();
        }
      }
    }
    
    // Path 3: items[0].caption.text (alternative format)
    if (Array.isArray(jsonData.items) && jsonData.items.length > 0) {
      const caption = jsonData.items[0].caption?.text;
      if (caption && typeof caption === 'string') {
        return caption.trim();
      }
    }
    
    // Path 4: Recursive search for caption/text fields
    function searchForCaption(obj, depth = 0) {
      if (depth > 5 || !obj || typeof obj !== 'object') return null;
      
      // Check if this object has a caption or text field
      if (obj.caption && typeof obj.caption === 'string') {
        return obj.caption.trim();
      }
      if (obj.text && typeof obj.text === 'string' && obj.text.length > 10) {
        // Only return if it looks like a caption (not just a short label)
        return obj.text.trim();
      }
      
      // Recursively search in nested objects
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const value = obj[key];
          if (value && typeof value === 'object') {
            const result = searchForCaption(value, depth + 1);
            if (result) return result;
          }
        }
      }
      
      return null;
    }
    
    const caption = searchForCaption(jsonData);
    if (caption) {
      return caption;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extracts Instagram post caption from HTML page
 * Falls back to og:description meta tag if JSON API fails
 * 
 * @param {string} html - HTML content of the post page
 * @returns {string|null} - Caption text or null if not found
 */
function extractCaptionFromHtml(html) {
  if (!html || typeof html !== 'string') {
    return null;
  }
  
  try {
    // Try to extract from og:description meta tag
    const ogDescriptionMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (ogDescriptionMatch && ogDescriptionMatch[1]) {
      const caption = ogDescriptionMatch[1].trim();
      if (caption && caption.length > 0) {
        return caption;
      }
    }
    
    // Try alternative meta tag format
    const metaDescriptionMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (metaDescriptionMatch && metaDescriptionMatch[1]) {
      const caption = metaDescriptionMatch[1].trim();
      if (caption && caption.length > 0) {
        return caption;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Fetches Instagram post caption using shortcode
 * Tries JSON API first, then falls back to HTML parsing
 * 
 * @param {string} shortcode - Instagram post shortcode
 * @returns {Promise<string|null>} - Caption text or null if not found
 */
async function getInstagramPostCaption(shortcode) {
  if (!shortcode) {
    return null;
  }
  
  const apiUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=1`;
  
  try {
    
    // Try JSON API first
    const response = await fetch(apiUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
      }
    });
    
    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      
      // Check if response is JSON
      if (contentType.includes('application/json')) {
        try {
          const jsonData = await response.json();
          const caption = extractCaptionFromJson(jsonData);
          if (caption) {
            return caption;
          }
        } catch (jsonError) {
          // Continue to HTML fallback
        }
      }
      
      // Fallback: Try HTML parsing
      const html = await response.text();
      const caption = extractCaptionFromHtml(html);
      if (caption) {
        return caption;
      }
    } else {
      // Try HTML fallback even on error
      try {
        const htmlUrl = `https://www.instagram.com/p/${shortcode}/`;
        const htmlResponse = await fetch(htmlUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.instagram.com/',
          }
        });
        
        if (htmlResponse.ok) {
          const html = await htmlResponse.text();
          const caption = extractCaptionFromHtml(html);
          if (caption) {
            return caption;
          }
        }
      } catch (htmlError) {
        // HTML fallback failed
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Fetches the final CDN URL from Instagram media shortcut URL
 * Handles redirects to get the actual CDN URL (scontent.cdninstagram.com)
 * 
 * @param {string} shortcode - Instagram post shortcode
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function getInstagramThumbnailUrl(shortcode) {
  if (!shortcode) {
    return { success: false, error: 'Shortcode is required' };
  }
  
  const mediaUrl = `https://www.instagram.com/p/${shortcode}/media/?size=l`;
  
  try {
    
    // Fetch with redirect: 'follow' (default) to automatically follow redirects
    // The response.url will contain the final destination URL after all redirects
    const response = await fetch(mediaUrl, {
      method: 'GET',
      redirect: 'follow', // Follow redirects automatically (default behavior)
      // Add headers to mimic browser request
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
      }
    });
    
    // Check response status
    if (!response.ok) {
      // Handle 404 (post not found) or 403 (private post)
      if (response.status === 404) {
        return { success: false, error: 'Post not found (404)' };
      } else if (response.status === 403) {
        return { success: false, error: 'Access forbidden - post may be private (403)' };
      } else {
        return { success: false, error: `Unexpected status: ${response.status}` };
      }
    }
    
    // Get the final URL after all redirects
    // response.url contains the final destination URL
    const finalUrl = response.url;
    
    // Verify it's a CDN URL (scontent.cdninstagram.com or similar)
    if (finalUrl.includes('cdninstagram.com') || finalUrl.includes('fbcdn.net')) {
      return { success: true, url: finalUrl };
    } else {
      // If redirect didn't lead to CDN, return the final URL anyway
      return { success: true, url: finalUrl };
    }
  } catch (error) {
    return { 
      success: false, 
      error: error.message || 'Failed to fetch thumbnail URL' 
    };
  }
}

/**
 * Fetches both thumbnail URL and caption for an Instagram post
 * Combines thumbnail and caption extraction into a single function
 * 
 * @param {string} shortcode - Instagram post shortcode
 * @returns {Promise<{success: boolean, thumbnailUrl?: string, caption?: string, error?: string}>}
 */
async function getInstagramPostData(shortcode) {
  if (!shortcode) {
    return { success: false, error: 'Shortcode is required', postUrl: null };
  }
  const postUrl = `https://www.instagram.com/p/${encodeURIComponent(String(shortcode).trim())}/`;

  // Fetch both thumbnail and caption in parallel for better performance
  const [thumbnailResult, caption] = await Promise.all([
    getInstagramThumbnailUrl(shortcode),
    getInstagramPostCaption(shortcode)
  ]);
  
  if (thumbnailResult.success) {
    return {
      success: true,
      thumbnailUrl: thumbnailResult.url,
      caption: caption || null,
      postUrl,
    };
  } else {
    // Even if thumbnail fails, return caption if available
    return {
      success: false,
      error: thumbnailResult.error || 'Failed to fetch thumbnail',
      thumbnailUrl: null,
      caption: caption || null,
      postUrl,
    };
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle userId request from content script
  if (request.action === 'get-cached-user-id') {
    getCachedUserId().then((userId) => {
      if (userId) {
        console.log('[BG] get-cached-user-id: found', userId.substring(0, 8) + '...');
      } else {
        console.warn('[BG] get-cached-user-id: no userId in storage');
      }
      sendResponse({ userId: userId || null });
    });
    return true; // async response
  }

  // Handle redirect resolution request
  if (request.action === 'resolve-redirect') {
    const url = request.url;
    
    if (!url || typeof url !== 'string') {
      sendResponse({ success: false, error: 'Invalid URL' });
      return true;
    }

    // Resolve redirect asynchronously
    resolveRedirect(url)
      .then((resolvedUrl) => {
        sendResponse({
          success: true,
          resolvedUrl: resolvedUrl
        });
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error.message || 'Failed to resolve redirect',
          resolvedUrl: url // Return original URL on error
        });
      });

    // Return true to indicate we will send a response asynchronously
    return true;
  }

  // Handle metadata fetching request
  if (request.action === 'fetch-metadata') {
    const url = request.url;
    if (!url || typeof url !== 'string') {
      sendResponse({ success: false, error: 'Invalid URL' });
      return true;
    }

    // Fetch metadata asynchronously
    fetchMetadata(url)
      .then((metadata) => {
        sendResponse({
          success: true,
          title: metadata.title,
          description: metadata.description
        });
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error.message || 'Failed to fetch metadata'
        });
      });

    // Return true to indicate we will send a response asynchronously
    return true;
  }
  
  if (request.action === 'get-instagram-thumbnail') {
    // Handle async operation (legacy support)
    getInstagramThumbnailUrl(request.shortcode)
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        sendResponse({ 
          success: false, 
          error: error.message || 'Unknown error' 
        });
      });
    
    // Return true to indicate we will send a response asynchronously
    return true;
  }
  
  if (request.action === 'get-instagram-post-data') {
    // Handle async operation for combined thumbnail + caption
    getInstagramPostData(request.shortcode)
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        sendResponse({ 
          success: false, 
          error: error.message || 'Unknown error',
          thumbnailUrl: null,
          caption: null,
          postUrl: request?.shortcode
            ? `https://www.instagram.com/p/${encodeURIComponent(String(request.shortcode).trim())}/`
            : null,
        });
      });
    
    // Return true to indicate we will send a response asynchronously
    return true;
  }

  // Handle AI URL analysis request — proxies to localhost to bypass
  // Chrome's Private Network Access restriction from content scripts.
  if (request.action === 'ai-analyze-url') {
    const { url } = request;
    if (!url || typeof url !== 'string') {
      sendResponse({ success: false, error: 'Invalid payload' });
      return true;
    }
    fetch('http://localhost:3000/api/v1/ai-analyze-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ success: false, error: `Server error ${res.status}` });
          return;
        }
        const data = await res.json();
        sendResponse({ success: true, data });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message || 'Failed to fetch' });
      });
    return true; // async response
  }
  
  // Return false for other messages (not handled here)
  return false;
});
```


### Full file: `browser-extension/chromium/coreEntry.js`

```javascript
import { state } from './stateLite.js';
import {
  detectItemMaps,
  EVIDENCE_TYPE_C,
  getItemMapFingerprint,
  findClusterContainerFromTarget,
  getItemMapEvidenceType,
  getItemMapEntryByElement,
  resolveTypeACoreItem,
  isValidTypeAAnchor,
  extractMetadataForCoreItem,
  extractShortcode,
  getCurrentPlatform,
  normalizeShortcodeExtractionResult,
  applyPurpleForCoreItem,
  clearCoreSelection,
  ensureClusterCacheFromState,
  showMetadataTooltip,
  setAiTooltipContent,
  clearAiTooltipContent,
  positionMetadataTooltip,
  renderItemMapCandidates,
  showFullPageHighlight,
} from './coreEngine.js';

window.__blinkMainLoaded = true;

let scanTimer = 0;
let lastFingerprint = '';
let pendingClearTimer = 0;
let lastPointerX = null;
let lastPointerY = null;
const CLEAR_GRACE_MS = 140;
const instagramFetchInFlightByElement = new WeakMap();

function withInstagramActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'INSTAGRAM') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const shortcode = String(meta?.shortcode || '').trim() || extracted.shortcode;
  if (!shortcode) return meta;
  const currentUrl = String(meta?.activeHoverUrl || '').trim();
  if (currentUrl) return meta;
  const assignedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
  return { ...meta, shortcode, activeHoverUrl: assignedUrl };
}

function withLinkedInCanonicalActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'LINKEDIN') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const shortcode = String(meta?.shortcode || '').trim() || extracted.shortcode;
  if (!/^\d{19}$/.test(shortcode)) return { ...meta, shortcode: null };
  const currentUrl = String(meta?.activeHoverUrl || '').trim();
  const assignedUrl =
    extracted.activeHoverUrl ||
    currentUrl ||
    `https://www.linkedin.com/feed/update/urn:li:activity:${shortcode}`;
  return { ...meta, shortcode, activeHoverUrl: assignedUrl };
}

function withThreadsActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'THREADS') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const activeHoverUrl = String(extracted.activeHoverUrl || meta?.activeHoverUrl || '').trim();
  if (!activeHoverUrl) return meta;
  const shortcode = String(meta?.shortcode || extracted.shortcode || activeHoverUrl).trim();
  const username = String(extracted.username || meta?.username || '').trim();
  const rawMessage = String(extracted.title || meta?.title || '').trim();
  const alreadyComposed = !!(username && rawMessage.startsWith(`${username}'s post\n`));
  const message = rawMessage.length > 180 ? `${rawMessage.slice(0, 180).trimEnd()}...` : rawMessage;
  let title = 'Threads post';
  if (alreadyComposed) {
    title = message;
  } else if (username && message) {
    title = `${username}'s post\n${message}`;
  } else if (message) {
    title = message;
  } else if (username) {
    title = `${username}'s post`;
  }
  return { ...meta, activeHoverUrl, shortcode, ...(username ? { username } : {}), title };
}

function withFacebookTimestampActiveHoverUrl(meta = {}, coreItem = null, cachedExtraction = null) {
  const platform = String(meta?.platform || '').toUpperCase();
  if (platform !== 'FACEBOOK') return meta;
  const extracted =
    cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
  const fallbackUrl = String(meta?.activeHoverUrl || '').trim();
  const activeHoverUrl = String(extracted.activeHoverUrl || '').trim() || fallbackUrl;
  if (!activeHoverUrl) return meta;
  const imageUrl = String(extracted.imageUrl || '').trim();
  const rawTitle = String(extracted.title || meta?.title || '').trim();
  const username = String(extracted.username || meta?.username || '').trim();
  const nextMeta = { ...meta, activeHoverUrl };
  if (imageUrl) {
    nextMeta.image = { ...(meta?.image || {}), url: imageUrl };
  }
  if (username) {
    nextMeta.username = username;
    nextMeta.title = rawTitle ? `${username}'s post\n${rawTitle}` : `${username}'s post`;
  } else if (rawTitle) {
    nextMeta.title = rawTitle;
  } else {
    nextMeta.title = "Facebook's post";
  }
  if ('shortcode' in nextMeta) delete nextMeta.shortcode;
  return nextMeta;
}

function applyInstagramFallbackMetadata(meta = {}) {
  const baseTitle = String(meta?.title || '').trim();
  const fallbackTitle = baseTitle || String(document?.title || '').trim() || String(meta?.activeHoverUrl || '').trim() || '(No title)';
  const imageUrl = String(meta?.image?.url || meta?.thumbnail || '').trim();
  return {
    ...meta,
    title: fallbackTitle,
    ...(imageUrl ? { thumbnail: imageUrl, image: { ...(meta?.image || {}), url: imageUrl } } : {}),
  };
}

function requestInstagramPostDataForTypeB(coreItem, meta, clientX = null, clientY = null) {
  if (!coreItem || coreItem.nodeType !== 1) return;
  if (!chrome?.runtime?.sendMessage) return;
  const platform = String(meta?.platform || '').toUpperCase();
  const shortcode = String(meta?.shortcode || '').trim();
  if (platform !== 'INSTAGRAM' || !shortcode) return;

  const alreadyRequestedFor = instagramFetchInFlightByElement.get(coreItem);
  if (alreadyRequestedFor === shortcode) return;
  instagramFetchInFlightByElement.set(coreItem, shortcode);

  chrome.runtime.sendMessage(
    { action: 'get-instagram-post-data', shortcode },
    (result) => {
      instagramFetchInFlightByElement.delete(coreItem);
      const activeMeta = state.lastExtractedMetadata || {};
      const stillSameCoreItem = state.activeCoreItem === coreItem;
      const stillSameTarget =
        stillSameCoreItem &&
        String(activeMeta?.platform || '').toUpperCase() === 'INSTAGRAM' &&
        String(activeMeta?.shortcode || '').trim() === shortcode;

      if (!stillSameTarget) return;

      if (chrome?.runtime?.lastError) {
        state.lastExtractedMetadata = applyInstagramFallbackMetadata(activeMeta);
        showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
        return;
      }

      const caption = String(result?.caption || '').trim();
      const thumbnailUrl = String(result?.thumbnailUrl || '').trim();
      const postUrl = String(result?.postUrl || '').trim();
      const hasUpdates = Boolean(caption || thumbnailUrl);
      if (!result?.success || !hasUpdates) {
        let fallbackMeta = applyInstagramFallbackMetadata(activeMeta);
        if (postUrl && !String(fallbackMeta?.activeHoverUrl || '').trim()) {
          fallbackMeta = { ...fallbackMeta, activeHoverUrl: postUrl };
        }
        state.lastExtractedMetadata = fallbackMeta;
        state.activeHoverUrl = String(state.lastExtractedMetadata?.activeHoverUrl || '').trim() || state.activeHoverUrl;
        showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
        return;
      }

      const mergedMeta = {
        ...activeMeta,
        ...(caption ? { title: caption } : {}),
        ...(thumbnailUrl
          ? {
              thumbnail: thumbnailUrl,
              image: { ...(activeMeta?.image || {}), url: thumbnailUrl },
            }
          : {}),
        ...(postUrl ? { activeHoverUrl: postUrl } : {}),
      };
      state.lastExtractedMetadata = mergedMeta;
      state.activeHoverUrl = String(mergedMeta?.activeHoverUrl || '').trim() || state.activeHoverUrl;
      showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
    }
  );
}

function cancelPendingClear() {
  if (!pendingClearTimer) return;
  window.clearTimeout(pendingClearTimer);
  pendingClearTimer = 0;
}

function scheduleCoreClear() {
  if (pendingClearTimer) return;
  pendingClearTimer = window.setTimeout(() => {
    pendingClearTimer = 0;
    _aiAnalyzeSession++;
    clearCoreSelection();
  }, CLEAR_GRACE_MS);
}

/**
 * Finds the first valid Type A anchor within a container (primary signal anchor).
 * Used as fallback when the hovered anchor fails validation.
 */
async function findPrimaryTypeAAnchor(container) {
  if (!container || container.nodeType !== 1) return null;
  const anchors = container.querySelectorAll?.('a[href]') || [];
  for (const a of anchors) {
    if (await isValidTypeAAnchor(a)) return a;
  }
  return null;
}

async function updateCoreSelectionFromTarget(target, clientX = null, clientY = null) {
  if (!target || target.nodeType !== 1) {
    scheduleCoreClear();
    return false;
  }
  ensureClusterCacheFromState();
  const coreItemContainer = findClusterContainerFromTarget(target);
  const active = state.activeCoreItem;
  if (!coreItemContainer) {
    scheduleCoreClear();
    return false;
  }
  const evidenceType = getItemMapEvidenceType(coreItemContainer);
  if (evidenceType === 'A') {
    const anchor = target?.matches?.('a') ? target : target?.closest?.('a');
    const hasAnchor = !!anchor;
    const contained = hasAnchor && !!coreItemContainer.contains?.(anchor);
    const hasPointerCursor =
      target && window.getComputedStyle ? window.getComputedStyle(target).cursor === 'pointer' : false;
    const shouldExit = (hasAnchor && !contained) || (!hasAnchor && !hasPointerCursor);
    if (shouldExit) {
      scheduleCoreClear();
      return false;
    }
  }

  // Type C: the hovered element itself is the CoreItem — no anchor traversal
  if (evidenceType === EVIDENCE_TYPE_C) {
    let mailUrl   = '';
    let mailTitle = '';

    const currentHref = String(window?.location?.href || '');

    if (currentHref.startsWith('https://mail.google.com/')) {
      // Gmail: build URL from data-legacy-thread-id
      const threadIdEl = coreItemContainer.querySelector?.('[data-legacy-thread-id]');
      const threadId   = threadIdEl?.getAttribute?.('data-legacy-thread-id') || '';
      mailUrl   = threadId
        ? `${window.location.origin}${window.location.pathname}#inbox/${threadId}`
        : '';
      mailTitle = threadId
        ? String(threadIdEl?.textContent || '').trim() || 'Gmail message'
        : 'Gmail message';

    } else if (currentHref.startsWith('https://mail.naver.com/')) {
      // Naver Mail: get href from .mail_title > a
      const anchor = coreItemContainer.querySelector?.('.mail_title a');
      const rawHref     = anchor?.getAttribute?.('href') || '';
      const cleanedHref = rawHref.replace('/popup/', '/');
      mailUrl = cleanedHref
        ? `${window.location.origin}${cleanedHref}`
        : '';
      // Title from .mail_title .text span
      const titleEl = coreItemContainer.querySelector?.('.mail_title .text');
      mailTitle = titleEl
        ? String(titleEl.textContent || '').trim() || 'Naver message'
        : 'Naver message';
    }

    cancelPendingClear();
    state.activeCoreItem        = coreItemContainer;
    state.activeHoverUrl        = mailUrl;
    state.lastExtractedMetadata = {
      activeHoverUrl: mailUrl,
      title:          mailTitle,
      platform:       'MAIL',
    };
    applyPurpleForCoreItem(coreItemContainer);
    showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
    return true;
  }

  const platformForB = evidenceType === 'B' ? getCurrentPlatform() : '';
  const typeBEntry = evidenceType === 'B' ? getItemMapEntryByElement(coreItemContainer) : null;
  const cachedExtraction = typeBEntry?.cachedShortcodeNormalized ?? null;

  // ── Instagram: dedicated shortcode extraction runs FIRST ─────────────────
  // Extract shortcode without any visual/size/visibility checks.
  // If found, build the canonical post URL immediately and use it as the
  // authoritative activeHoverUrl regardless of what generic logic would find.
  let instagramPreresolvedUrl = '';
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    const shortcodeResult =
      cachedExtraction ??
      normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    const shortcode = String(shortcodeResult?.shortcode || '').trim();
    if (shortcode) {
      instagramPreresolvedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const shortcodeForB =
    evidenceType === 'B' && platformForB === 'INSTAGRAM'
      ? (cachedExtraction?.shortcode || '').trim() ||
        normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB).shortcode
      : '';
  let coreItem = coreItemContainer;
  let closestAtag = null;
  if (evidenceType === 'A') {
    const anchor = target?.matches?.('a') ? target : target?.closest?.('a');
    const anchorValid = anchor && (await isValidTypeAAnchor(anchor));
    const effectiveTarget = anchorValid ? target : await findPrimaryTypeAAnchor(coreItemContainer);
    if (!effectiveTarget) {
      scheduleCoreClear();
      return false;
    }
    coreItem = await resolveTypeACoreItem(coreItemContainer, effectiveTarget);
    closestAtag = anchorValid ? anchor : effectiveTarget;
  }
  const cacheOverrides =
    evidenceType === 'B' && typeBEntry?.cachedMetadata
      ? {
          cachedImage:
            typeBEntry.cachedMetadata.imageIsCustom && typeBEntry.cachedMetadata.image != null
              ? { value: typeBEntry.cachedMetadata.image, usedCustomLogic: true }
              : null,
          cachedTitle:
            typeBEntry.cachedMetadata.titleIsCustom && typeBEntry.cachedMetadata.title != null
              ? { value: typeBEntry.cachedMetadata.title, usedCustomLogic: true }
              : null,
        }
      : null;
  let meta =
    evidenceType === 'B' && typeBEntry?.cachedMetadata
      ? extractMetadataForCoreItem(coreItem, closestAtag, target, cacheOverrides) || {}
      : extractMetadataForCoreItem(coreItem, closestAtag, target) || {};

  // ── Instagram: override activeHoverUrl with pre-resolved URL ─────────────
  // If dedicated shortcode extraction succeeded, always use that URL.
  // Generic logic result is used only as fallback when shortcode was not found.
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM' && instagramPreresolvedUrl) {
    meta = {
      ...meta,
      activeHoverUrl: instagramPreresolvedUrl,
      platform: platformForB,
      shortcode: shortcodeForB,
    };
  } else if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    // Shortcode extraction failed — fall back to generic withInstagramActiveHoverUrl
    meta = withInstagramActiveHoverUrl(
      { ...meta, platform: platformForB, ...(shortcodeForB ? { shortcode: shortcodeForB } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    const li = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    meta = withLinkedInCanonicalActiveHoverUrl(
      { ...meta, platform: platformForB, ...(li.shortcode ? { shortcode: li.shortcode } : {}), ...(li.activeHoverUrl ? { activeHoverUrl: li.activeHoverUrl } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'THREADS') {
    const th = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    meta = withThreadsActiveHoverUrl(
      { ...meta, platform: platformForB, ...(th.shortcode ? { shortcode: th.shortcode } : {}), ...(th.activeHoverUrl ? { activeHoverUrl: th.activeHoverUrl } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  } else if (evidenceType === 'B' && platformForB === 'FACEBOOK') {
    const fb = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItemContainer), platformForB);
    meta = withFacebookTimestampActiveHoverUrl(
      { ...meta, platform: platformForB, ...(fb.activeHoverUrl ? { activeHoverUrl: fb.activeHoverUrl } : {}), ...(fb.imageUrl ? { image: { ...(meta?.image || {}), url: fb.imageUrl } } : {}) },
      coreItemContainer,
      cachedExtraction
    );
  }
  if (!meta?.activeHoverUrl) {
    // Keep current state briefly to avoid flicker around tiny DOM gaps.
    if (active && active.contains?.(target)) {
      cancelPendingClear();
      if (isFinite(Number(clientX)) && isFinite(Number(clientY))) {
        positionMetadataTooltip(clientX, clientY);
      }
      applyPurpleForCoreItem(active);
      return true;
    }
    scheduleCoreClear();
    return false;
  }
  cancelPendingClear();
  let syncedMeta = meta;
  if (evidenceType === 'B') {
    const platform = getCurrentPlatform();
    syncedMeta = { ...syncedMeta, platform };
    if (platform !== 'FACEBOOK') {
      const shortcodeResult = cachedExtraction ?? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
      if (shortcodeResult?.shortcode) {
        syncedMeta = {
          ...syncedMeta,
          shortcode: shortcodeResult.shortcode,
          ...(shortcodeResult.activeHoverUrl ? { activeHoverUrl: shortcodeResult.activeHoverUrl } : {}),
        };
      }
    }
    // If instagramPreresolvedUrl was already set, skip withInstagramActiveHoverUrl
    // to prevent it from being overridden or blocked
    if (instagramPreresolvedUrl) {
      syncedMeta = {
        ...syncedMeta,
        activeHoverUrl: instagramPreresolvedUrl,
      };
    } else {
      syncedMeta = withInstagramActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
    }
    syncedMeta = withLinkedInCanonicalActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
    syncedMeta = withThreadsActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
    syncedMeta = withFacebookTimestampActiveHoverUrl(syncedMeta, coreItem, cachedExtraction);
  }
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  applyPurpleForCoreItem(coreItem);
  showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
  if (evidenceType === 'B') {
    requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  return true;
}

/**
 * Analyzes a URL via the AI server and updates the tooltip with Type + Summary.
 * Uses a session token to discard stale responses when the user has already
 * moved to a different CoreItem.
 */
let _aiAnalyzeSession = 0;
const _aiUrlCache = new Map(); // url → { type, summary }

async function analyzeUrlForTooltip(url) {
  if (!url) return;
  const session = ++_aiAnalyzeSession;

  // Cache hit — show result instantly without calling the API
  if (_aiUrlCache.has(url)) {
    const cached = _aiUrlCache.get(url);
    setAiTooltipContent({ type: cached.type, summary: cached.summary });
    return;
  }

  clearAiTooltipContent(); // show "Analyzing..." immediately
  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'ai-analyze-url', url },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.success) {
            reject(new Error(response?.error || 'Unknown error'));
            return;
          }
          resolve(response.data);
        }
      );
    });
    // Discard if user has moved to a different CoreItem
    if (session !== _aiAnalyzeSession) return;
    _aiUrlCache.set(url, { type: result.type, summary: result.summary });
    setAiTooltipContent({ type: result.type, summary: result.summary });
  } catch (e) {
    if (session !== _aiAnalyzeSession) return;
    setAiTooltipContent({ type: '', summary: 'Analysis unavailable.' });
  }
}

function schedulePreScan() {
  if (scanTimer) return;
  scanTimer = window.setTimeout(async () => {
    scanTimer = 0;

    // ── Rule-based detection (unchanged) ──────────────────────────────────
    const candidates = await detectItemMaps(document);
    const attrAwarePart = Array.isArray(candidates)
      ? candidates
          .map((c) => `${c.signature || c.key || ''}`)
          .sort()
          .slice(0, 80)
          .join('|')
      : '';
    const fp = `${getItemMapFingerprint(candidates)}::${attrAwarePart}`;
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    renderItemMapCandidates(candidates);
  }, 80);
}

function mountObservers() {
  function registerObserver(isRecovery = false) {
    const targetNode = window.document.documentElement || window.document.body;
    if (!targetNode) return;

    const obs = new MutationObserver(() => {
      schedulePreScan();
    });

    obs.observe(targetNode, { childList: true, subtree: true });

    // Detect document.open(): after document.open(), document.documentElement
    // is replaced. Poll every 200ms; if the live document's root differs from
    // our observed node, disconnect, re-register on the new document, and continue.
    const checkInterval = window.setInterval(() => {
      const liveRoot = window.document.documentElement;
      if (liveRoot !== targetNode) {
        obs.disconnect();
        window.clearInterval(checkInterval);
        schedulePreScan();
        window.__blinkWindowListenersMounted = false;
        mountWindowListeners();
        registerObserver(true);
      }
    }, 200);
  }
  registerObserver();
}

function extractPageOpenGraphMeta() {
  const url = String(window.location.href || '').trim();
  const title =
    String(document.querySelector('meta[property="og:title"]')?.content || '').trim() ||
    String(document.title || '').trim() ||
    url;
  const imgUrl =
    String(document.querySelector('meta[property="og:image"]')?.content || '').trim();
  return { url, title, imgUrl };
}

/**
 * Extracts a lightweight visual context object from a CoreItem element.
 * Used to help AI infer the content type based on what the element contains.
 */
function extractCoreItemHtmlContext(element) {
  if (!element) return null;
  try {
    const rect = element.getBoundingClientRect();
    const totalArea = rect.width * rect.height;

    const MIN_CONTENT_SIZE = Math.max(
      32,
      typeof window !== 'undefined' ? Math.max(0, (window.innerWidth || 0) * 0.03) : 0
    );
    const isVisuallySignificantImage = (w, h) => {
      if (w < MIN_CONTENT_SIZE || h < MIN_CONTENT_SIZE) return false;
      const ratio = h > 0 ? w / h : Infinity;
      return ratio >= 0.2 && ratio <= 5.0;
    };

    const getEffectiveImageRect = (img) => {
      const r = img.getBoundingClientRect();
      // If the img itself has no renderable size, try the parent element.
      // This handles the "padding-top aspect ratio trick" where the img is
      // absolutely positioned inside a padding-driven container.
      if ((r.width < 10 || r.height < 10) && img.parentElement) {
        const pr = img.parentElement.getBoundingClientRect();
        if (pr.width >= 10 && pr.height >= 10) return pr;
      }
      return r;
    };

    // Collect images with size info (visually significant only)
    const images = Array.from(element.querySelectorAll('img')).map((img) => {
      const r = getEffectiveImageRect(img);
      return {
        src:    (img.src || img.getAttribute('data-src') || '').substring(0, 200),
        width:  Math.round(r.width),
        height: Math.round(r.height),
        alt:    (img.alt || '').substring(0, 80),
      };
    }).filter(i => isVisuallySignificantImage(i.width, i.height));

    // Collect videos
    const videos = Array.from(element.querySelectorAll('video, [data-video], iframe[src*="youtube"], iframe[src*="vimeo"]')).map((v) => {
      const r = v.getBoundingClientRect();
      return {
        src:    (v.src || v.getAttribute('data-src') || v.getAttribute('src') || '').substring(0, 200),
        width:  Math.round(r.width),
        height: Math.round(r.height),
      };
    }).filter(v => v.width > 0 || v.src);

    // Dominant media area ratio (0–1)
    const mediaArea = [...images, ...videos].reduce((sum, m) => sum + (m.width * m.height), 0);
    const mediaRatio = totalArea > 0 ? Math.round((mediaArea / totalArea) * 100) / 100 : 0;

    // Inner text (trimmed, max 200 chars)
    const innerText = (element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ').trim().substring(0, 200);

    // Tag name and key attributes
    const tagName = element.tagName || '';
    const href    = (element.href || element.getAttribute('href') || '').substring(0, 200);
    const role    = element.getAttribute('role') || '';
    const ariaLabel = element.getAttribute('aria-label') || '';

    return {
      tagName,
      href,
      role,
      ariaLabel: ariaLabel.substring(0, 80),
      boundingBox: { width: Math.round(rect.width), height: Math.round(rect.height) },
      mediaRatio,
      imageCount:  images.length,
      videoCount:  videos.length,
      images:      images.slice(0, 3),  // max 3 images
      videos:      videos.slice(0, 2),  // max 2 videos
      innerText,
    };
  } catch {
    return null;
  }
}

async function saveActiveCoreItem(request = {}) {
  const activeItem = state.activeCoreItem;
  const activeUrl = String(state.activeHoverUrl || '').trim();

  // No CoreItem active → save current page via OpenGraph metadata
  if (!activeItem || !activeUrl) {
    const { url, title, imgUrl } = extractPageOpenGraphMeta();
    if (!url) return { success: false, reason: 'missing-url' };

    // Request userId from background.js (cached from sidepanel sign-in)
    let userId = null;
    try {
      // First attempt — service worker may be asleep
      const userIdResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
          if (chrome.runtime.lastError) {
            // Service worker was asleep or not ready — resolve with null to trigger retry
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });

      if (userIdResponse?.userId) {
        userId = userIdResponse.userId;
      } else {
        // Retry once after a short delay to allow service worker to wake up
        await new Promise((r) => setTimeout(r, 150));
        const retryResponse = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
            if (chrome.runtime.lastError) {
              resolve(null);
            } else {
              resolve(response);
            }
          });
        });
        userId = retryResponse?.userId || null;
      }
    } catch {
      userId = null;
    }

    const payload = {
      url,
      title: title || url,
      timestamp: Date.now(),
      saved_by: 'browser-extension',
      userLanguage: navigator.language || 'en',
      ...(imgUrl ? { img_url: imgUrl } : {}),
      ...(userId ? { userId } : {}),
    };

    // Optimistic UI: notify Side Panel to show a temporary card immediately
    // Skip if running inside an iframe — only the top-level frame should create optimistic cards
    if (window.self === window.top) {
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        chrome.runtime.sendMessage({
          action: 'optimistic-card',
          tempId,
          url,
          title: title || url,
          imgUrl: imgUrl || '',
        });
      } catch { /* Side Panel may not be open — silently ignore */ }
    }

    const response = await fetch('http://localhost:3000/api/v1/save-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`save failed: ${response.status}`);
    }

    // Brief success flash on the full-page highlight overlay
    try {
      const overlay = document.getElementById('blink-purple-highlight-overlay');
      if (overlay) {
        const prevBorder = overlay.style.border;
        const prevBg = overlay.style.background;
        overlay.style.border = '3px solid #22c55e';
        overlay.style.background = 'rgba(34, 197, 94, 0.16)';
        window.setTimeout(() => {
          overlay.style.border = prevBorder;
          overlay.style.background = prevBg;
        }, 500);
      }
    } catch (e) {}

    return { success: true, payload };
  }

  // CoreItem active → existing logic
  const meta = state.lastExtractedMetadata;
  const url = String(meta?.activeHoverUrl || activeUrl).trim();
  if (!url) return { success: false, reason: 'missing-url' };

  const title = String(meta?.title || document.title || url).trim();
  const imgUrl = String(request?.img_url || meta?.image?.url || '').trim();

  // Request userId from background.js (cached from sidepanel sign-in)
  let userId = null;
  try {
    // First attempt — service worker may be asleep
    const userIdResponse = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
        if (chrome.runtime.lastError) {
          // Service worker was asleep or not ready — resolve with null to trigger retry
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });

    if (userIdResponse?.userId) {
      userId = userIdResponse.userId;
    } else {
      // Retry once after a short delay to allow service worker to wake up
      await new Promise((r) => setTimeout(r, 150));
      const retryResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });
      userId = retryResponse?.userId || null;
    }
  } catch {
    userId = null;
  }

  // Extract HTML context from the active CoreItem for AI type inference
  const htmlContext = extractCoreItemHtmlContext(activeItem);

  const payload = {
    url,
    title: title || url,
    timestamp: Date.now(),
    saved_by: 'browser-extension',
    userLanguage: navigator.language || 'en',
    pageUrl: window.location.href,
    ...(htmlContext ? { htmlContext } : {}),
    ...(imgUrl ? { img_url: imgUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  // Optimistic UI: notify Side Panel to show a temporary card immediately
  // Skip if running inside an iframe — only the top-level frame should create optimistic cards
  if (window.self === window.top) {
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      chrome.runtime.sendMessage({
        action: 'optimistic-card',
        tempId,
        url,
        title: title || url,
        imgUrl: imgUrl || '',
      });
    } catch { /* Side Panel may not be open — silently ignore */ }
  }

  const response = await fetch('http://localhost:3000/api/v1/save-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`save failed: ${response.status}`);
  }

  // Brief success flash on the active highlight.
  try {
    const overlay = document.getElementById('blink-purple-highlight-overlay');
    if (overlay) {
      const prevBorder = overlay.style.border;
      const prevBg = overlay.style.background;
      overlay.style.border = '3px solid #22c55e';
      overlay.style.background = 'rgba(34, 197, 94, 0.16)';
      window.setTimeout(() => {
        overlay.style.border = prevBorder;
        overlay.style.background = prevBg;
      }, 500);
    } else if (activeItem?.style) {
      const prevOutline = activeItem.style.outline;
      activeItem.style.outline = '3px solid #22c55e';
      window.setTimeout(() => {
        activeItem.style.outline = prevOutline;
      }, 500);
    }
  } catch (e) {}

  return { success: true, payload };
}

function mountSaveMessageListener() {
  if (window.__blinkSaveMessageListenerMounted) return;
  if (!chrome?.runtime?.onMessage?.addListener) return;
  window.__blinkSaveMessageListenerMounted = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action !== 'save-url') return false;
    saveActiveCoreItem(request)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ success: false, error: String(error?.message || error) });
      });
    return true;
  });
}

function mountWindowListeners() {
  if (window.__blinkWindowListenersMounted) return;
  window.__blinkWindowListenersMounted = true;

  window.addEventListener('load', schedulePreScan, { passive: true });
  window.addEventListener('scroll', async () => {
    schedulePreScan();
    const active = state.activeCoreItem;
    if (!active) return;
    const x = Number(lastPointerX);
    const y = Number(lastPointerY);
    if (isFinite(x) && isFinite(y)) {
      const pointerEl = document.elementFromPoint(x, y);
      if (pointerEl && (await updateCoreSelectionFromTarget(pointerEl, x, y))) return;
    }
    // Keep highlight stable while scrolling, even before next hover event.
    applyPurpleForCoreItem(active);
    scheduleCoreClear();
  }, { passive: true, capture: true });
  window.addEventListener('resize', schedulePreScan, { passive: true });
  window.addEventListener('mouseover', async (e) => {
    lastPointerX = e?.clientX ?? lastPointerX;
    lastPointerY = e?.clientY ?? lastPointerY;
    const target = e?.target && e.target.nodeType === 1 ? e.target : null;
    await updateCoreSelectionFromTarget(target, e.clientX, e.clientY);
  }, { passive: true, capture: true });
  window.addEventListener('mousemove', (e) => {
    lastPointerX = e?.clientX ?? lastPointerX;
    lastPointerY = e?.clientY ?? lastPointerY;
    const active = state.activeCoreItem;
    if (!active) return;
    const target = e?.target && e.target.nodeType === 1 ? e.target : null;
    if (target && active.contains?.(target)) {
      cancelPendingClear();
    }
    positionMetadataTooltip(e.clientX, e.clientY);
  }, { passive: true, capture: true });
}

function mountLifecycle() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedulePreScan, { once: true });
  } else {
    schedulePreScan();
  }
  mountWindowListeners();
  mountObservers();
  mountSaveMessageListener();
  // Default state: no CoreItem active → highlight entire page
  showFullPageHighlight();
}

window.__blinkApplyCoreItem = (coreItem) => {
  const evidenceType = getItemMapEvidenceType(coreItem);
  const platformForB = evidenceType === 'B' ? getCurrentPlatform() : '';
  const shortcodeForB =
    evidenceType === 'B' && platformForB === 'INSTAGRAM'
      ? normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB).shortcode
      : '';
  let meta = extractMetadataForCoreItem(coreItem, null, coreItem) || {};
  if (evidenceType === 'B' && platformForB === 'INSTAGRAM') {
    meta = withInstagramActiveHoverUrl({ ...meta, platform: platformForB, ...(shortcodeForB ? { shortcode: shortcodeForB } : {}) }, coreItem);
  } else if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    const li = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withLinkedInCanonicalActiveHoverUrl(
      { ...meta, platform: platformForB, ...(li.shortcode ? { shortcode: li.shortcode } : {}), ...(li.activeHoverUrl ? { activeHoverUrl: li.activeHoverUrl } : {}) },
      coreItem
    );
  } else if (evidenceType === 'B' && platformForB === 'THREADS') {
    const th = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withThreadsActiveHoverUrl(
      { ...meta, platform: platformForB, ...(th.shortcode ? { shortcode: th.shortcode } : {}), ...(th.activeHoverUrl ? { activeHoverUrl: th.activeHoverUrl } : {}) },
      coreItem
    );
  } else if (evidenceType === 'B' && platformForB === 'FACEBOOK') {
    const fb = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platformForB);
    meta = withFacebookTimestampActiveHoverUrl(
      { ...meta, platform: platformForB, ...(fb.activeHoverUrl ? { activeHoverUrl: fb.activeHoverUrl } : {}), ...(fb.imageUrl ? { image: { ...(meta?.image || {}), url: fb.imageUrl } } : {}) },
      coreItem
    );
  }
  if (!meta?.activeHoverUrl) {
    _aiAnalyzeSession++;
    clearCoreSelection();
    return null;
  }
  let syncedMeta = meta;
  if (evidenceType === 'B') {
    const platform = getCurrentPlatform();
    syncedMeta = { ...syncedMeta, platform };
    if (platform !== 'FACEBOOK') {
      const shortcodeResult = normalizeShortcodeExtractionResult(extractShortcode(coreItem), platform);
      if (shortcodeResult.shortcode) {
        syncedMeta = {
          ...syncedMeta,
          shortcode: shortcodeResult.shortcode,
          ...(shortcodeResult.activeHoverUrl ? { activeHoverUrl: shortcodeResult.activeHoverUrl } : {}),
        };
      } else {
      }
    }
    syncedMeta = withInstagramActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withLinkedInCanonicalActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withThreadsActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withFacebookTimestampActiveHoverUrl(syncedMeta, coreItem);
  }
  cancelPendingClear();
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  applyPurpleForCoreItem(coreItem);
  const rect = coreItem.getBoundingClientRect ? coreItem.getBoundingClientRect() : null;
  const x = rect ? rect.right : null;
  const y = rect ? rect.top : null;
  showMetadataTooltip(state.lastExtractedMetadata, x, y);
  if (evidenceType === 'B') {
    requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, x, y);
  }
  return syncedMeta;
};

mountLifecycle();


```


### Full file: `browser-extension/chromium/sidepanel.js`

```javascript
// ─────────────────────────────────────────────────────────────────────────────
// Blink Side Panel — sidepanel.js
// Firebase browser SDK loaded via CDN (ESM)
// ─────────────────────────────────────────────────────────────────────────────

import {
  initializeApp,
  getApps,
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  getFirestore,
  collection,
  query,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
} from './firebase-bundle.js';

// ── Firebase config ───────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyA9X_FEi9cgvFmDdEmeEvJW0msXSIrP6p0',
  authDomain:        'saveurl-a8593.firebaseapp.com',
  projectId:         'saveurl-a8593',
  storageBucket:     'saveurl-a8593.firebasestorage.app',
  messagingSenderId: '658386350246',
  appId:             '1:658386350246:web:ee80b8dcae26d2e4298467',
  measurementId:     'G-3CWFLRKTVR',
};

const firebaseApp = getApps().length === 0
  ? initializeApp(FIREBASE_CONFIG)
  : getApps()[0];

const auth = getAuth(firebaseApp);
const db   = getFirestore(firebaseApp);

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser        = null;
let unsubscribeItems   = null;
let unsubscribeDirs    = null;
let isSyncing          = false;
let isDragging         = false;
let lastDragEndTime    = 0;
let displayedItemIds   = new Set();
let currentDirectories = [];
let currentItems       = [];

// Optimistic UI: tracks temp card IDs waiting for Firestore confirmation
// key: tempId, value: { url, title, imgUrl, cardContainer }
const optimisticCards = new Map();

// window-level drag state (mirrors main.js pattern)
window.currentDraggedWrapper  = null;
window.currentDraggedItemId   = null;
window.currentDraggedItemUrl  = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginScreen     = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const btnSignin       = document.getElementById('btn-signin');
const btnSignout      = document.getElementById('btn-signout');
const loginError      = document.getElementById('login-error');
const spUserAvatar    = document.getElementById('sp-user-avatar');
const spDirectoryList = document.getElementById('sp-directory-list');
const dockItemlist    = document.getElementById('dock-itemlist');

// ── Auth: Google Sign-in via chrome.identity ──────────────────────────────────
async function signInWithGoogle() {
  showLoginError('');
  try {
    // 1. Get OAuth token from Chrome Identity API
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(token);
        }
      });
    });

    // 2. Create Firebase credential from OAuth token
    const credential = GoogleAuthProvider.credential(null, token);

    // 3. Sign in to Firebase
    await signInWithCredential(auth, credential);
  } catch (err) {
    console.error('[Auth] Sign-in error:', err);
    showLoginError(err.message || 'Sign-in failed. Please try again.');
  }
}

async function signOut() {
  try {
    // Revoke Chrome identity token
    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, resolve);
    });
    if (token) {
      await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
    }
    await firebaseSignOut(auth);
  } catch (err) {
    console.error('[Auth] Sign-out error:', err);
  }
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.style.display = msg ? 'block' : 'none';
}

// ── Screen switching ──────────────────────────────────────────────────────────
function showLoginScreen() {
  loginScreen.style.display    = 'flex';
  dashboardScreen.style.display = 'none';
  stopListeners();
}

function showDashboardScreen(user) {
  loginScreen.style.display     = 'none';
  dashboardScreen.style.display = 'flex';

  // Update avatar
  if (user.photoURL) {
    spUserAvatar.src          = user.photoURL;
    spUserAvatar.style.display = 'block';
  } else {
    spUserAvatar.style.display = 'none';
  }

  startListeners(user.uid);
}

// ── Firestore listeners ───────────────────────────────────────────────────────
function startListeners(userId) {
  stopListeners();

  // Watch directories
  const dirsRef = collection(db, `users/${userId}/directories`);
  const dirsQ   = query(dirsRef, orderBy('createdAt', 'asc'));
  unsubscribeDirs = onSnapshot(dirsQ, (snap) => {
    currentDirectories = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    renderDirectories();
  }, (err) => {
    console.error('[Firestore] dirs error:', err);
    currentDirectories = [];
    renderDirectories();
  });

  // Watch items
  const itemsRef = collection(db, `users/${userId}/items`);
  const itemsQ   = query(itemsRef, orderBy('createdAt', 'desc'));
  unsubscribeItems = onSnapshot(itemsQ, (snap) => {
    currentItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    if (!isSyncing) loadData();
  }, (err) => {
    console.error('[Firestore] items error:', err);
  });
}

function stopListeners() {
  if (unsubscribeItems)  { unsubscribeItems();  unsubscribeItems  = null; }
  if (unsubscribeDirs)   { unsubscribeDirs();   unsubscribeDirs   = null; }
  currentItems       = [];
  currentDirectories = [];
  displayedItemIds   = new Set();
}

// ── Auth state ────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    // Always sync userId to storage, regardless of Side Panel open state
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ blinkUserId: user.uid }).catch(() => {});
    }
    showDashboardScreen(user);
  } else {
    // Clear userId on sign-out
    if (chrome?.storage?.local) {
      chrome.storage.local.remove('blinkUserId').catch(() => {});
    }
    showLoginScreen();
  }
});

// ── Utility helpers ───────────────────────────────────────────────────────────
function getItemId(item) {
  if (item.id) return item.id;
  try {
    const url = new URL(item.url);
    return url.hostname + url.pathname;
  } catch {
    return item.url || Math.random().toString(36).slice(2);
  }
}

function getSourceDomain(item) {
  if (item.domain) return item.domain;
  try {
    return new URL(item.url).hostname.replace(/^www\./, '');
  } catch {
    return item.url || '';
  }
}

function formatUrlForDisplay(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

function getFaviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return '';
  }
}

// ── Image proxy helper ────────────────────────────────────────────────────────
const IMAGE_PROXY_BASE = 'http://localhost:3000/api/v1/image-proxy';

/**
 * Returns a proxied image URL via the local server.
 * All external img_url values are routed through the proxy to avoid
 * CSP and CORP restrictions in the Chrome Extension context.
 * Falls back to the original URL if it's already a local/data URL.
 */
function getProxiedImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  // Don't proxy data: URLs or relative URLs
  if (trimmed.startsWith('data:') || trimmed.startsWith('/')) return trimmed;
  return `${IMAGE_PROXY_BASE}?url=${encodeURIComponent(trimmed)}`;
}

function getTypeIconSVG(type) {
  const iconSize = '10px';
  const iconColor = 'rgba(0, 0, 0, 0.2)';
  const icons = {
    webpage: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 3C1 2.44772 1.44772 2 2 2H14C14.5523 2 15 2.44772 15 3V13C15 13.5523 14.5523 14 14 14H2C1.44772 14 1 13.5523 1 13V3Z" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M1 5H15" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="3.5" cy="3.5" r="0.5" fill="${iconColor}"/>
      <circle cx="5.5" cy="3.5" r="0.5" fill="${iconColor}"/>
      <circle cx="7.5" cy="3.5" r="0.5" fill="${iconColor}"/>
    </svg>`,
    image: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="14" height="14" rx="2" stroke="${iconColor}" stroke-width="1.5"/>
      <circle cx="5.5" cy="5.5" r="1.5" stroke="${iconColor}" stroke-width="1.5"/>
      <path d="M1 11l4-4 3 3 2-2 5 5" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    translation: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2V14M2 8H14" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M3 5L8 2L13 5M3 11L8 14L13 11" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    calculation: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="2" width="10" height="12" rx="1" stroke="${iconColor}" stroke-width="1.5"/>
      <path d="M6 5H10M6 8H10M6 11H10" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
    search: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="4" stroke="${iconColor}" stroke-width="1.5"/>
      <path d="M11 11L14 14" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
    converter: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 4L6 8L2 12M14 4L10 8L14 12" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8 2V14" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
  };
  return icons[type] || icons.webpage;
}

// ── Card creation (main.html CSS-compatible structure) ────────────────────────
function createDataCard(item) {
  const itemId       = item.id || getItemId(item);
  const cardId       = `item-${itemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const escapedUrl   = (item.url || '').replace(/"/g, '&quot;');
  const type         = item.type || 'webpage';
  const displayTitle = item.title || 'Untitled';
  const escapedTitle = displayTitle.replace(/"/g, '&quot;');
  const sourceDomain = getSourceDomain(item);
  const escapedDomain = sourceDomain.replace(/"/g, '&quot;');
  const imgUrl       = (item.img_url || '').trim();
  const escapedImgUrl = imgUrl.replace(/"/g, '&quot;');
  const directoryId  = item.directoryId && item.directoryId !== 'undefined' ? item.directoryId : '';

  // Favicon URL
  let faviconUrl = '';
  if (item.domain && item.domain.includes('.')) {
    faviconUrl = getFaviconUrl(`https://${item.domain}`);
  } else if (item.url) {
    faviconUrl = getFaviconUrl(item.url);
  }

  // Delete button HTML (shared)
  const deleteBtn = `
    <div class="data-card-delete" title="Delete">
      <div class="data-card-delete-btn">
        <svg viewBox="0 0 24 24" class="delete-icon-x">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        <svg viewBox="0 0 24 24" class="delete-icon-check" style="display:none;">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
    </div>`;

  return `
    <div id="${cardId}"
         class="data-card"
         data-url="${escapedUrl}"
         data-title="${escapedTitle}"
         data-type="${type}"
         data-img-url="${escapedImgUrl}"
         data-item-id="${itemId}"
         data-doc-id="${item.id || ''}"
         data-directory-id="${directoryId}">
      <!-- Header: URL + delete -->
      <div class="data-card-header">
        <div class="data-card-domain-section">
          <span class="data-card-url-text">${escapedUrl}</span>
        </div>
        ${deleteBtn}
      </div>
      <!-- Main: thumbnail + title -->
      <div class="data-card-main">
        ${imgUrl ? `
        <div class="data-card-imgcontainer">
          <img src="${getProxiedImageUrl(imgUrl)}" alt="${escapedTitle}" class="data-card-image">
        </div>` : `
        <div class="data-card-imgcontainer is-favicon">
          <img src="${faviconUrl}" alt="${escapedDomain}" class="data-card-image">
        </div>`}
        <div class="data-card-context">
          <p class="data-card-title">${escapedTitle}</p>
        </div>
      </div>
      <!-- AI analysis section -->
      <div class="data-card-ai${item.ai_category || item.ai_type || item.ai_summary ? ' has-content' : ''}">
        ${item.ai_category ? `<span class="data-card-ai-category">${item.ai_category.replace(/"/g, '&quot;')}</span>` : ''}
        ${item.ai_type ? `<span class="data-card-ai-type">${item.ai_type.replace(/"/g, '&quot;')}</span>` : ''}
        ${item.ai_summary ? `<p class="data-card-ai-summary">${item.ai_summary.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : ''}
      </div>
    </div>`;
}

function createCardElement(item, isNew = false) {
  const itemId  = getItemId(item);
  const cardHtml = createDataCard(item);
  const tempDiv  = document.createElement('div');
  tempDiv.innerHTML = cardHtml.trim();
  const card = tempDiv.firstChild;

  if (!card.dataset.itemId) card.dataset.itemId = itemId;
  if (!card.dataset.url)    card.dataset.url    = item.url;
  if (!card.dataset.title)  card.dataset.title  = item.title || 'Untitled';
  if (!card.dataset.type)   card.dataset.type   = item.type  || 'webpage';
  if (item.directoryId && item.directoryId !== 'undefined') {
    card.dataset.directoryId = item.directoryId;
  }

  const wrapper = document.createElement('div');
  wrapper.className  = 'card-wrapper';
  wrapper.style.cssText = 'overflow:hidden;transition:height 0.3s cubic-bezier(0.2,0,0,1),opacity 0.3s ease;';
  wrapper.appendChild(card);

  const container = document.createElement('div');
  container.className = 'card-container';

  if (isNew) {
    container.style.height   = '0px';
    container.style.overflow = 'hidden';
    wrapper.style.transform       = 'scale(0)';
    wrapper.style.transformOrigin = 'top center';
    wrapper.style.opacity         = '0';
  }

  container.appendChild(wrapper);
  return { container, wrapper, card };
}

// ── Entrance animation (mirrors main.js) ──────────────────────────────────────
function animateEntrance(container, wrapper) {
  wrapper.style.opacity = '0';
  const naturalHeight   = wrapper.offsetHeight;
  container.style.transition = 'height 300ms ease-out';
  requestAnimationFrame(() => { container.style.height = `${naturalHeight}px`; });
  setTimeout(() => {
    wrapper.style.transition = [
      'transform 350ms cubic-bezier(0.34,1.56,0.64,1)',
      'opacity 150ms ease-out',
    ].join(', ');
    wrapper.style.transform = 'scale(1)';
    wrapper.style.opacity   = '1';
  }, 50);
  setTimeout(() => {
    container.style.height         = '';
    container.style.overflow       = '';
    container.style.transition     = '';
    wrapper.style.transition       = '';
    wrapper.style.transform        = '';
    wrapper.style.transformOrigin  = '';
    wrapper.style.opacity          = '';
  }, 500);
}

// ── Optimistic UI ─────────────────────────────────────────────────────────────
function addOptimisticCard({ tempId, url, title, imgUrl }) {
  if (!currentUser || !dockItemlist) return;

  // Deduplication: ignore if a temp card with same tempId already exists
  if (optimisticCards.has(tempId)) return;

  // Also ignore if a temp card with the same URL is already pending
  for (const [, entry] of optimisticCards.entries()) {
    if (entry.url === url) return;
  }

  // Build a temporary item object matching the real item structure
  const tempItem = {
    id:          tempId,
    url:         url || '',
    title:       title || 'Untitled',
    img_url:     imgUrl || '',
    type:        imgUrl ? 'image' : 'webpage',
    domain:      (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
    directoryId: 'undefined',
    order:       -Infinity, // Always at the top
    _isOptimistic: true,
  };

  // Create the card element
  const { container, wrapper, card } = createCardElement(tempItem, true);
  card.dataset.tempId = tempId;
  container.dataset.optimisticCard = tempId;
  card.dataset.handlerAttached = 'false';

  // Add visual indicator that this card is pending
  wrapper.style.opacity = '0.7';

  // Prepend to the top of the main list
  dockItemlist.insertBefore(container, dockItemlist.firstChild);

  // Track in optimisticCards map
  optimisticCards.set(tempId, { url, title, imgUrl, cardContainer: container });

  // Add to displayedItemIds so loadData() won't duplicate it
  displayedItemIds.add(tempId);

  // Run entrance animation
  animateEntrance(container, wrapper);

  // Attach handlers
  attachCardClickHandlers();
}

function removeOptimisticCard(tempId) {
  const entry = optimisticCards.get(tempId);
  if (!entry) return;

  // Remove from DOM
  if (entry.cardContainer && entry.cardContainer.parentNode) {
    entry.cardContainer.remove();
  }

  // Clean up tracking
  optimisticCards.delete(tempId);
  displayedItemIds.delete(tempId);
}

// ── Button event listeners ────────────────────────────────────────────────────
btnSignin.addEventListener('click', signInWithGoogle);
btnSignout.addEventListener('click', signOut);

// ─────────────────────────────────────────────────────────────────────────────
// Part B: loadData, renderDirectories, DnD, Delete
// ─────────────────────────────────────────────────────────────────────────────

// ── DnD helpers ───────────────────────────────────────────────────────────────
let hasValidDropIndicator = false;
let directoryHoverTimer   = null;
let hoveredDirectoryItem  = null;
const GUIDE_LINE_HEIGHT   = 2;

function removeGuideWrapper() {
  document.querySelectorAll('.dnd-guide-wrapper').forEach((el) => el.remove());
  hasValidDropIndicator = false;
}

function showGuideWrapper(container, index) {
  removeGuideWrapper();
  const guide = document.createElement('div');
  guide.className = 'dnd-guide-wrapper';
  const children = Array.from(container.children).filter(
    (c) => !c.classList.contains('dnd-guide-wrapper')
  );
  if (index >= children.length) {
    container.appendChild(guide);
  } else {
    container.insertBefore(guide, children[index]);
  }
  hasValidDropIndicator = true;
}

function findClosestDropTarget(e, container) {
  const children = Array.from(container.children).filter(
    (c) => c.classList.contains('card-container')
  );
  if (children.length === 0) return { targetElement: null, index: 0, isEmpty: true };

  let closestIndex = children.length;
  for (let i = 0; i < children.length; i++) {
    const r = children[i].getBoundingClientRect();
    const mid = r.top + r.height * 0.5;
    if (e.clientY < mid) { closestIndex = i; break; }
  }
  return {
    targetElement: children[closestIndex] || null,
    index: closestIndex,
    isEmpty: false,
  };
}

function getDraggedWrapper() {
  return window.currentDraggedWrapper
    || document.querySelector('[data-dragging-source="true"]');
}

function getDraggedItemId(e) {
  return (
    e.dataTransfer.getData('application/x-datacard-id') ||
    e.dataTransfer.getData('text/plain') ||
    ''
  );
}

function getSourceDirectoryId(e) {
  return e.dataTransfer.getData('application/x-source-directory-id') || null;
}

// ── Firestore proxy calls (via localhost server) ───────────────────────────────
async function moveItemToPosition(userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId) {
  const res = await fetch('http://localhost:3000/api/v1/firestore/move-item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId }),
  });
  if (!res.ok) throw new Error(`move-item failed: ${res.status}`);
}

async function moveDirectoryToPosition(userId, directoryId, newIndex) {
  const res = await fetch('http://localhost:3000/api/v1/firestore/move-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, directoryId, newIndex }),
  });
  if (!res.ok) throw new Error(`move-directory failed: ${res.status}`);
}

async function deleteItem(itemId, userId) {
  const docRef = doc(db, `users/${userId}/items/${itemId}`);
  await deleteDoc(docRef);
}

// ── Delete handlers ───────────────────────────────────────────────────────────
function attachDeleteHandlers(container) {
  container.querySelectorAll('.data-card-delete').forEach((btn) => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const header  = newBtn.closest('.data-card-header');
      const card    = newBtn.closest('.data-card');
      const wrapper = newBtn.closest('.card-wrapper');
      if (!header || !card || !wrapper) return;

      if (!header.classList.contains('delete-pending')) {
        // First click: enter delete-pending
        header.classList.add('delete-pending');
        wrapper.classList.add('delete-pending');

        // Swap icon X → checkmark
        const iconX     = newBtn.querySelector('.delete-icon-x');
        const iconCheck = newBtn.querySelector('.delete-icon-check');
        if (iconX)     iconX.style.display     = 'none';
        if (iconCheck) iconCheck.style.display = 'block';

        // Replace URL text with confirmation message
        const urlTextEl = header.querySelector('.data-card-url-text');
        if (urlTextEl) {
          urlTextEl.dataset.originalText = urlTextEl.textContent;
          urlTextEl.textContent = 'Really delete this data?';
        }

        // Cancel any existing dismiss listener for this wrapper
        if (wrapper._deletePendingDismiss) {
          document.removeEventListener('click', wrapper._deletePendingDismiss, false);
          wrapper._deletePendingDismiss = null;
        }

        // Register a document-level capture listener to dismiss on any click
        // outside the confirm button
        const dismissHandler = (dismissEvent) => {
          // If the click is on the confirm (checkmark) button — let it proceed, don't dismiss
          if (dismissEvent.target.closest('.data-card-delete')) return;

          // Cancel delete-pending state
          header.classList.remove('delete-pending');
          wrapper.classList.remove('delete-pending');
          if (iconX)     iconX.style.display     = 'block';
          if (iconCheck) iconCheck.style.display = 'none';
          if (urlTextEl && urlTextEl.dataset.originalText) {
            urlTextEl.textContent = urlTextEl.dataset.originalText;
          }

          // Clean up
          document.removeEventListener('click', dismissHandler, false);
          wrapper._deletePendingDismiss = null;
        };

        wrapper._deletePendingDismiss = dismissHandler;
        // Use capture phase so it fires before other handlers
        // Small delay so the current click event doesn't immediately trigger the dismiss
        setTimeout(() => {
          document.addEventListener('click', dismissHandler, false);
        }, 0);
      } else {
        // Second click: confirm delete
        // Clean up document dismiss listener
        if (wrapper._deletePendingDismiss) {
          document.removeEventListener('click', wrapper._deletePendingDismiss, false);
          wrapper._deletePendingDismiss = null;
        }
        // No need to restore text — card will be removed
        const docId = card.dataset.docId || card.dataset.itemId;
        if (docId && currentUser) {
          const itemRef = doc(db, 'users', currentUser.uid, 'items', docId);
          const cardContainer = wrapper.closest('.card-container') || wrapper;
          cardContainer.style.transition = 'height 0.25s ease, opacity 0.2s ease';
          cardContainer.style.opacity    = '0';
          cardContainer.style.height     = cardContainer.offsetHeight + 'px';
          requestAnimationFrame(() => { cardContainer.style.height = '0px'; });
          setTimeout(() => {
            deleteDoc(itemRef).catch((err) => console.error('[Delete]', err));
            cardContainer.remove();
          }, 250);
        }
      }
    });
  });
}

// ── Card click & drag handlers ────────────────────────────────────────────────
function attachCardClickHandlers() {
  document.querySelectorAll('.data-card').forEach((card) => {
    if (card.dataset.handlerAttached === 'true') return;

    const wrapper = card.closest('.card-wrapper');
    if (!wrapper) return;

    card.removeAttribute('draggable');
    if (wrapper.getAttribute('draggable') !== 'true') {
      wrapper.setAttribute('draggable', 'true');
    }

    // Replace card node to clear old listeners
    const newCard = card.cloneNode(true);
    card.parentNode.replaceChild(newCard, card);

    // Dragstart
    wrapper.addEventListener('dragstart', (e) => {
      const c       = wrapper.querySelector('.data-card');
      if (!c) { e.preventDefault(); return; }
      const itemId  = c.dataset.docId || c.dataset.itemId || '';
      const url     = c.dataset.url   || '';
      const srcDirId = c.dataset.directoryId || null;

      isDragging = true;
      requestAnimationFrame(() => {
        wrapper.style.opacity     = '0.3';
        wrapper.style.transition  = 'opacity 0.25s cubic-bezier(0.2,0,0,1)';
        wrapper.classList.add('is-dragging-source');
        wrapper.style.cursor      = 'grabbing';
        wrapper.dataset.draggingSource = 'true';
        wrapper.style.pointerEvents    = 'none';
        c.classList.add('dragging');
      });

      document.body.dataset.activeDragId           = itemId;
      document.body.dataset.activeDragUrl          = url;
      document.body.dataset.activeSourceDirectoryId = srcDirId || '';
      window.currentDraggedItemId  = itemId;
      window.currentDraggedItemUrl = url;
      window.currentDraggedWrapper = wrapper;

      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', itemId);
      e.dataTransfer.setData('text/uri-list', url);
      if (itemId)   e.dataTransfer.setData('application/x-datacard-id', itemId);
      if (srcDirId) e.dataTransfer.setData('application/x-source-directory-id', srcDirId);
    });

    // Dragend
    wrapper.addEventListener('dragend', () => {
      isDragging      = false;
      lastDragEndTime = Date.now();
      const c = wrapper.querySelector('.data-card');
      if (c) c.classList.remove('dragging');
      wrapper.classList.remove('is-dragging-source');
      wrapper.style.pointerEvents    = '';
      wrapper.style.cursor           = '';
      wrapper.dataset.draggingSource = '';
      window.currentDraggedWrapper   = null;
      window.currentDraggedItemId    = null;
      window.currentDraggedItemUrl   = null;
      delete document.body.dataset.activeDragId;
      delete document.body.dataset.activeDragUrl;
      delete document.body.dataset.activeSourceDirectoryId;
      removeGuideWrapper();
    });

    // Click → open URL
    newCard.addEventListener('click', async (e) => {
      const timeSinceDragEnd = Date.now() - lastDragEndTime;
      if (isDragging || timeSinceDragEnd < 100) return;
      // Block URL open when delete is pending
      // Use a different variable name to avoid conflict with outer scope 'wrapper'
      const clickedWrapper = newCard.closest('.card-wrapper');
      if (clickedWrapper && clickedWrapper.classList.contains('delete-pending')) return;
      const url = newCard.dataset.url;
      if (!url) return;
      document.querySelectorAll('.data-card').forEach((c) => c.classList.remove('active'));
      newCard.classList.add('active');
      window.open(url, '_blank');
    });

    newCard.dataset.handlerAttached = 'true';
  });

  attachDeleteHandlers(document);

  // Delegated image error handler (CSP blocks inline onerror)
  document.querySelectorAll('.data-card-imgcontainer').forEach((container) => {
    if (container.dataset.imgHandlerAttached === 'true') return;
    container.dataset.imgHandlerAttached = 'true';

    const img = container.querySelector('.data-card-image');
    if (!img) return;

    img.addEventListener('error', () => {
      // Show grey placeholder when proxy is unreachable or image fails
      container.classList.add('img-placeholder');
      img.style.display = 'none';
    });

    img.addEventListener('load', () => {
      // Remove placeholder once image loads successfully
      container.classList.remove('img-placeholder');
      img.style.display = '';
    });
  });
}

// ── Container drop handlers ───────────────────────────────────────────────────
function setupContainerDropHandlers(container, directoryId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const { index } = findClosestDropTarget(e, container);
    showGuideWrapper(container, index);
  });

  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) removeGuideWrapper();
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    removeGuideWrapper();
    if (!currentUser) return;

    const draggedItemId      = getDraggedItemId(e);
    const srcDirectoryId     = getSourceDirectoryId(e);
    const draggedWrapper     = getDraggedWrapper();
    const { index: newIndex } = findClosestDropTarget(e, container);

    if (!draggedItemId || !draggedWrapper) return;

    const normalizedTarget = directoryId   || null;
    const normalizedSource = srcDirectoryId || null;

    // Optimistic UI: move DOM node
    const draggedContainer = draggedWrapper.closest('.card-container') || draggedWrapper;
    const children = Array.from(container.children).filter(
      (c) => c.classList.contains('card-container')
    );

    isSyncing = true;

    if (newIndex >= children.length) {
      container.appendChild(draggedContainer);
    } else {
      container.insertBefore(draggedContainer, children[newIndex]);
    }

    // Animate drop landing
    draggedWrapper.style.opacity    = '1';
    draggedWrapper.style.transition = '';
    draggedWrapper.classList.remove('is-dragging-source');
    draggedWrapper.dataset.draggingSource = '';
    draggedWrapper.style.pointerEvents    = '';

    try {
      await moveItemToPosition(
        currentUser.uid,
        draggedItemId,
        normalizedTarget,
        newIndex,
        normalizedSource
      );
    } catch (err) {
      console.error('[DnD] move-item error:', err);
      loadData();
    } finally {
      setTimeout(() => { isSyncing = false; }, 100);
    }
  });
}

// ── Directory header drop handlers (collapsed directory) ──────────────────────
function setupDirectoryHeaderDropHandlers() {
  document.querySelectorAll('.directory-item-header').forEach((header) => {
    if (header.dataset.dropHandlerAttached === 'true') return;
    header.dataset.dropHandlerAttached = 'true';

    const dirItem   = header.closest('.directory-item');
    const dirId     = dirItem?.dataset.directoryId || null;

    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      header.classList.add('drag-over');
    });

    header.addEventListener('dragleave', () => {
      header.classList.remove('drag-over');
    });

    header.addEventListener('drop', async (e) => {
      e.preventDefault();
      header.classList.remove('drag-over');
      if (!currentUser) return;

      const draggedItemId  = getDraggedItemId(e);
      const srcDirectoryId = getSourceDirectoryId(e);
      if (!draggedItemId) return;

      isSyncing = true;
      try {
        await moveItemToPosition(
          currentUser.uid,
          draggedItemId,
          dirId,
          0,
          srcDirectoryId || null
        );
      } catch (err) {
        console.error('[DnD] directory header drop error:', err);
        loadData();
      } finally {
        setTimeout(() => { isSyncing = false; }, 100);
      }
    });
  });
}

// ── Directory list drop handlers (directory reordering) ───────────────────────
function setupDirectoryListDropHandlers() {
  const dirList = document.getElementById('sp-directory-list');
  if (!dirList || dirList.dataset.dirDndAttached === 'true') return;
  dirList.dataset.dirDndAttached = 'true';

  // Make directory headers draggable
  document.querySelectorAll('.directory-item-header').forEach((header) => {
    if (header.dataset.dirDraggableAttached === 'true') return;
    header.dataset.dirDraggableAttached = 'true';
    header.setAttribute('draggable', 'true');

    header.addEventListener('dragstart', (e) => {
      const dirItem = header.closest('.directory-item');
      const dirId   = dirItem?.dataset.directoryId || '';
      document.body.dataset.activeDragDirectoryId = dirId;
      e.dataTransfer.setData('application/x-directory-id', dirId);
      e.dataTransfer.effectAllowed = 'move';
    });

    header.addEventListener('dragend', () => {
      delete document.body.dataset.activeDragDirectoryId;
    });
  });

  dirList.addEventListener('dragover', (e) => {
    if (!document.body.dataset.activeDragDirectoryId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  dirList.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!currentUser) return;

    const draggedDirId = e.dataTransfer.getData('application/x-directory-id');
    if (!draggedDirId) return;

    // Find new index from Y position
    const dirItems = Array.from(
      dirList.querySelectorAll('.directory-item')
    ).filter((d) => d.dataset.directoryId !== draggedDirId);

    let newIndex = dirItems.length;
    for (let i = 0; i < dirItems.length; i++) {
      const r = dirItems[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height * 0.5) { newIndex = i; break; }
    }

    isSyncing = true;
    try {
      await moveDirectoryToPosition(currentUser.uid, draggedDirId, newIndex);
    } catch (err) {
      console.error('[DnD] move-directory error:', err);
    } finally {
      setTimeout(() => { isSyncing = false; }, 100);
    }
  });
}

// ── Unified drop setup ────────────────────────────────────────────────────────
function setupUnifiedDropHandlers() {
  // Main list
  if (dockItemlist && !dockItemlist.dataset.unifiedDnDAttached) {
    dockItemlist.dataset.unifiedDnDAttached = 'true';
    setupContainerDropHandlers(dockItemlist, null);
  }

  // Directory containers
  document.querySelectorAll('.directory-items-container').forEach((container) => {
    if (container.dataset.unifiedDnDAttached === 'true') return;
    container.dataset.unifiedDnDAttached = 'true';
    const dirItem = container.closest('.directory-item');
    const dirId   = dirItem?.dataset.directoryId || null;
    setupContainerDropHandlers(container, dirId);
  });

  setupDirectoryHeaderDropHandlers();
  setupDirectoryListDropHandlers();
}

// ── renderDirectories ─────────────────────────────────────────────────────────
function renderDirectories() {
  if (!spDirectoryList) return;

  // Preserve expanded state
  const expandedIds = new Set();
  spDirectoryList.querySelectorAll('.directory-item.expanded').forEach((el) => {
    expandedIds.add(el.dataset.directoryId);
  });

  spDirectoryList.innerHTML = '';

  if (!currentDirectories || currentDirectories.length === 0) {
    spDirectoryList.style.display = 'none';
    return;
  }

  spDirectoryList.style.display = 'block';

  currentDirectories.forEach((dir) => {
    const item = document.createElement('div');
    item.className         = 'directory-item';
    item.dataset.directoryId = dir.id;
    if (expandedIds.has(dir.id)) item.classList.add('expanded');

    const header = document.createElement('div');
    header.className = 'directory-item-header';
    header.innerHTML = `
      <span class="directory-toggle">▶</span>
      <span class="directory-name">${(dir.name || 'Untitled').replace(/</g, '&lt;')}</span>
    `;

    // Toggle expand on click (not drag)
    header.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      item.classList.toggle('expanded');
    });

    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'directory-items-container';

    item.appendChild(header);
    item.appendChild(itemsContainer);
    spDirectoryList.appendChild(item);
  });

  // Re-render items into directories after DOM update
  if (currentItems.length > 0) loadData();
}

// ── loadData ──────────────────────────────────────────────────────────────────
function loadData() {
  if (!currentUser) return;
  if (!dockItemlist) return;

  const isInitialRender   = displayedItemIds.size === 0;
  const previouslyDisplayed = new Set(displayedItemIds);

  // Group items
  const itemsWithoutDirectory = [];
  const itemsByDirectory      = new Map();

  currentItems.forEach((item) => {
    const dirId = item.directoryId;
    if (!dirId || dirId === 'undefined') {
      itemsWithoutDirectory.push(item);
    } else {
      if (!itemsByDirectory.has(dirId)) itemsByDirectory.set(dirId, []);
      itemsByDirectory.get(dirId).push(item);
    }
  });

  displayedItemIds.clear();

  // ── Render items into directories ────────────────────────────────────────
  itemsByDirectory.forEach((items, dirId) => {
    const dirEl       = document.querySelector(`.directory-item[data-directory-id="${dirId}"]`);
    const itemsContainer = dirEl?.querySelector('.directory-items-container');
    if (!itemsContainer) return;

    // Clear non-animating children
    Array.from(itemsContainer.children).forEach((child) => {
      if (!child.dataset?.preserveAnimation) itemsContainer.removeChild(child);
    });

    items.forEach((item) => {
      const itemId = getItemId(item);
      const isNew  = !isInitialRender && !previouslyDisplayed.has(itemId);
      const { container, wrapper, card } = createCardElement(item, isNew);
      itemsContainer.appendChild(container);
      displayedItemIds.add(itemId);
      card.dataset.handlerAttached = 'false';
      if (isNew) animateEntrance(container, wrapper);
    });
  });

  // ── Render items without directory ──────────────────────────────────────
  // Clear non-animating children (preserve optimistic cards for seamless replacement)
  Array.from(dockItemlist.children).forEach((child) => {
    if (child.dataset?.preserveAnimation || child.dataset?.optimisticCard) return;
    dockItemlist.removeChild(child);
  });

  itemsWithoutDirectory.forEach((item) => {
    const itemId = getItemId(item);

    // Check if this real item matches an optimistic card by URL
    // If so, remove the optimistic card and render the real one in its place
    let matchedTempId = null;
    if (!isInitialRender) {
      for (const [tempId, entry] of optimisticCards.entries()) {
        if (entry.url === item.url) {
          matchedTempId = tempId;
          break;
        }
      }
    }

    if (matchedTempId) {
      // Remove optimistic card silently (no animation — real card takes over)
      removeOptimisticCard(matchedTempId);
    }

    const isNew  = !isInitialRender && !previouslyDisplayed.has(itemId) && !matchedTempId;
    const { container, wrapper, card } = createCardElement(item, isNew);
    dockItemlist.appendChild(container);
    displayedItemIds.add(itemId);
    card.dataset.handlerAttached = 'false';
    if (isNew) animateEntrance(container, wrapper);
  });

  // ── Empty state ──────────────────────────────────────────────────────────
  if (currentItems.length === 0 && optimisticCards.size === 0) {
    const empty = document.createElement('div');
    empty.className   = 'sp-empty';
    empty.textContent = 'No saved items yet.\nUse Cmd+Shift+S to save.';
    dockItemlist.appendChild(empty);
  }

  // ── Attach handlers ──────────────────────────────────────────────────────
  attachCardClickHandlers();
  setupUnifiedDropHandlers();
}

// ── Optimistic card message listener ─────────────────────────────────────────
if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'optimistic-card') {
      addOptimisticCard({
        tempId: message.tempId,
        url:    message.url,
        title:  message.title,
        imgUrl: message.imgUrl || '',
      });
    }
    return false;
  });
}

```


### Full file: `browser-extension/chromium/sidepanel.html`

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
      /* Side Panel specific */
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
    #login-screen h1 {
      font-size: 20px;
      font-weight: 700;
      text-align: center;
    }
    #login-screen p {
      font-size: 13px;
      color: var(--text-secondary);
      text-align: center;
      line-height: 1.5;
    }
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
    #login-error {
      font-size: 12px;
      color: #ef4444;
      text-align: center;
      display: none;
    }

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
    #sp-user-section {
      display: flex;
      align-items: center;
      gap: 8px;
    }
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
    .directory-item {
      border-bottom: 1px solid var(--border);
    }
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
    .directory-toggle {
      font-size: 10px;
      color: var(--text-secondary);
      transition: transform 0.15s;
      flex-shrink: 0;
    }
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
    /* Keep header visible when delete is pending, regardless of hover state */
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

    /* data-card: outer shell, no padding — padding is on inner sections */
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

    /* Header: domain + delete button */
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
      /* Hidden by default — animates open on hover */
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

    /* Main content section */
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

    /* Image thumbnail — fixed height like Electron */
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
    /* Placeholder shown when image proxy is unavailable or image fails to load */
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

    /* Text content */
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
    /* AI analysis section */
    .data-card-ai {
      display: none;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      padding: var(--space-100) var(--space-150);
      border-top: 1px solid var(--border-default);
      box-sizing: border-box;
    }
    .data-card-ai.has-content {
      display: flex;
    }
    .data-card-ai-category {
      font-family: 'Roboto', sans-serif;
      font-size: 9px;
      font-weight: 500;
      line-height: 1.3;
      color: rgba(0, 0, 0, 0.35);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
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
    /* Delete button — top-right of header */
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

    /* Delete pending */
    .data-card-header.delete-pending {
      background: #ef4444;
      border-radius: 4px;
    }
    .data-card-header.delete-pending .data-card-domain-section {
      color: #fff;
    }
    .data-card-header.delete-pending .data-card-url-text {
      color: #fff;
      font-size: 11px;
      font-weight: 500;
    }
    .data-card-header.delete-pending .data-card-delete { opacity: 1; }
    .data-card-header.delete-pending .data-card-delete-btn { background: #fff; }
    .data-card-header.delete-pending .data-card-delete-btn svg { stroke: #ef4444; }

    /* ── DnD guide line ── */
    .dnd-guide-wrapper {
      width: 100%;
      height: 2px;
      background: var(--accent);
      border-radius: 2px;
      margin: 2px 0;
      pointer-events: none;
      flex-shrink: 0;
    }

    /* ── Empty state ── */
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

    /* ── Loading state ── */
    .sp-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
      color: var(--text-secondary);
      font-size: 13px;
    }

    /* ── Scrollbar ── */
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
        <!-- Google icon -->
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

      <!-- Header -->
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

      <!-- Directory list -->
      <div id="sp-directory-list"></div>

      <!-- Main item list -->
      <div id="sp-itemlist-wrap">
        <div id="dock-itemlist"></div>
      </div>

    </div>
  </div>
</body>
</html>

```


### Full file: `browser-extension/chromium/manifest.json`

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


### Full file: `client/src/main.ts`

```typescript
// Load environment variables before anything else
import * as dotenv from 'dotenv';
dotenv.config();

import * as electron from 'electron';
import type {
  BrowserWindow as ElectronBrowserWindow,
  Tray as ElectronTray,
  Event,
} from 'electron';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { installExtensions } from './extensionInstaller';
import http from 'http';
import * as authService from './lib/auth.service';
import * as firestoreService from './lib/firestore';
import * as instagramService from './lib/instagram.service';
import * as storageService from './lib/storage';
import { BRAND } from './lib/brandConfig.js';

const execAsync = promisify(exec);

const { app, BrowserWindow, globalShortcut, Tray, nativeImage, dialog, shell, ipcMain, screen, protocol, session } = electron;

let mainWindow: ElectronBrowserWindow | null = null;
let dropzoneWindow: ElectronBrowserWindow | null = null;
// REMOVED: dockWindow - dock is now integrated into main window
let tray: ElectronTray | null = null;
let ghostWindow: ElectronBrowserWindow | null = null;

// Track Firestore watchers (unsubscribe functions) per window
const firestoreWatchers = new Map<ElectronBrowserWindow, Map<string, () => void>>();
const firestoreDirectoryWatchers = new Map<ElectronBrowserWindow, Map<string, () => void>>();

// REMOVED: DOCK_WIDTH - dock is now part of main window

// Local HTTP server for receiving pending save notifications from extension
let pendingSaveServer: http.Server | null = null;
const PENDING_SAVE_PORT = 3001;

// Local HTTP server for Firestore save operations
let firestoreSaveServer: http.Server | null = null;
const FIRESTORE_SAVE_PORT = 3002;

// Track extension connection state (last ping timestamp)
let extensionLastPing: number = 0;
const EXTENSION_PING_TIMEOUT = 30000; // 30 seconds

// Track which browsers have shown the extension installation dialog (per focus session)
// When a browser gains focus, it's removed from this set so dialog can show again
const browsersDialogShown = new Set<string>();

// Track the previously active browser to detect focus changes
let previousActiveBrowser: BrowserInfo | null = null;

/**
 * Gets the highest always-on-top level for the dock window based on platform
 */
// Always-On-Top functionality removed to prevent DnD interference

// REMOVED: createDockWindow() - dock is now integrated into main window
// REMOVED: getDockBounds() - no longer needed
// REMOVED: adjustMainWindowBounds() - main window uses full screen

const getPrimaryWorkAreaHeight = (): number => {
  try {
    return screen.getPrimaryDisplay().workAreaSize.height;
  } catch (e) {
    return 900;
  }
};

const SIDEBAR_WIDTH_DEFAULT = 175;

// Dock auto-hide (pin) state: true = pinned (fixed), false = unpinned (auto-hide)
let dockPinned = false;
let isDashboard = false;
let dataSavedHideTimer: ReturnType<typeof setTimeout> | null = null;
let isAnimatingOut = false;
const DOCK_TRIGGER_WIDTH = 5;
const DOCK_ANIMATION_DURATION_MS = 200;
const DOCK_HIDE_DELAY_MS = 300;

function animateWindowPosition(
  win: ElectronBrowserWindow,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMs: number,
  onComplete?: () => void
) {
  if (!win || win.isDestroyed()) return;

  const w = win;
  const startBounds = w.getBounds();
  const safeNum = (v: number, fallback: number) =>
    (typeof v === 'number' && Number.isFinite(v) && !Number.isNaN(v)) ? v : fallback;

  const safeFromX = Math.round(safeNum(fromX, startBounds.x));
  const safeFromY = Math.round(safeNum(fromY, startBounds.y));
  const safeToX = Math.round(safeNum(toX, startBounds.x));
  const safeToY = Math.round(safeNum(toY, startBounds.y));
  const safeDuration = Math.max(1, safeNum(durationMs, DOCK_ANIMATION_DURATION_MS));

  const startTime = Date.now();

  const step = () => {
    if (!w || w.isDestroyed()) return;

    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / safeDuration);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const currentX = safeFromX + (safeToX - safeFromX) * eased;
    const currentY = safeFromY + (safeToY - safeFromY) * eased;

    const targetX = Math.round(Number.isFinite(currentX) ? currentX : safeFromX);
    const targetY = Math.round(Number.isFinite(currentY) ? currentY : safeFromY);

    try {
      if (!w.isDestroyed()) {
        w.setPosition(targetX, targetY);
      }
    } catch (e) {
      console.error('Failed to set window position:', e);
    }

    if (t < 1) {
      setTimeout(step, 16);
    } else {
      try {
        if (!w.isDestroyed()) {
          w.setPosition(safeToX, safeToY);
        }
      } catch (e) {
        console.error('Failed to set final window position:', e);
      }
      onComplete?.();
    }
  };
  step();
}

const createWindow = () => {
  const screenHeight = getPrimaryWorkAreaHeight();
  const sidebarWidth = SIDEBAR_WIDTH_DEFAULT;
  
  // Main window now behaves as a left sidebar
  mainWindow = new BrowserWindow({
    width: sidebarWidth,
    height: screenHeight,
    x: 0,
    y: 0,
    show: false, // avoid stealing focus on launch
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    focusable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false, // Disabled for security
      contextIsolation: true, // Enabled for security
      preload: path.join(__dirname, 'preload/preload.js'), // Load preload script
      webSecurity: false, // Allow fetch requests to localhost
      webviewTag: true, // Enable webview tag for better iframe compatibility
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.on('will-move', (event: Event) => {
    if (dockPinned) {
      event.preventDefault();
      mainWindow?.setPosition(0, 0);
    }
  });
  mainWindow.on('resize', () => {
    if (dockPinned) {
      mainWindow?.setPosition(0, 0);
    }
  });

  // Load login or dashboard based on auth state
  const loadPageForAuth = (user: { uid: string } | null) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (user) {
      isDashboard = true;
      mainWindow.loadFile(path.resolve(__dirname, '..', 'pages/dashboard/main.html'));
    } else {
      isDashboard = false;
      // Login page: always pinned, slide dock to x=0
      dockPinned = true;
      mainWindow.setPosition(0, 0);
      mainWindow.loadFile(path.resolve(__dirname, '..', 'pages/auth/login.html'));
    }
  };

  const user = authService.getCurrentUserData();
  loadPageForAuth(user);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.showInactive();
  });

  mainWindow.on('show', () => {
    if (!isDashboard) return;
    // On first show, if app is not focused, start hidden
    if (!mainWindow?.isFocused()) {
      // Close DevTools before auto-hiding
      if (mainWindow && !mainWindow!.isDestroyed()) {
        mainWindow!.webContents.closeDevTools();
      }
      const bounds = mainWindow!.getBounds();
      const targetX = -(bounds.width - DOCK_TRIGGER_WIDTH);
      mainWindow!.setPosition(targetX, bounds.y);
    }
  });

  mainWindow.on('close', (event: Event) => {
    // Hide instead of quit when attempting to close from UI
    event.preventDefault();
    mainWindow?.hide();
  });
};

/**
 * Shows and refreshes the main window
 */
const showAndRefreshWindow = () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    // Send message to refresh data
    mainWindow.webContents.send('refresh-data');
  }
};


interface BrowserInfo {
  name: string;
  bundleId: string;
  supportsExtension: boolean; // Whether we provide extensions for this browser
}

/**
 * Detects the currently active browser and returns its information
 * Returns null if no supported browser is active
 */
const getActiveBrowser = async (): Promise<BrowserInfo | null> => {
  if (process.platform !== 'darwin') {
    return null; // Only supported on macOS
  }

  try {
    const script = `
      tell application "System Events"
        try
          set frontAppBundle to bundle identifier of first application process whose frontmost is true
          return frontAppBundle
        on error
          return ""
        end try
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    const bundleId = stdout.trim();
    
    // Chrome bundle identifiers
    const chromeBundleIds = [
      'com.google.Chrome',
      'com.google.Chrome.beta',
      'com.google.Chrome.canary'
    ];
    
    if (chromeBundleIds.includes(bundleId)) {
      return {
        name: 'Chrome',
        bundleId,
        supportsExtension: true,
      };
    }
    
    // Edge bundle identifier
    if (bundleId === 'com.microsoft.edgemac') {
      return {
        name: 'Edge',
        bundleId,
        supportsExtension: true, // Edge supports Chromium extensions
      };
    }
    
    // Arc bundle identifier (approximate - may vary)
    // Note: Arc's bundle ID might be different, this is an approximation
    const getAppNameScript = `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`;
    const { stdout: appName } = await execAsync(getAppNameScript);
    const appNameLower = appName.trim().toLowerCase();
    
    if (appNameLower.includes('arc')) {
      return {
        name: 'Arc',
        bundleId,
        supportsExtension: true, // Arc supports Chromium extensions
      };
    }
    
    // Firefox bundle identifier
    if (bundleId === 'org.mozilla.firefox') {
      return {
        name: 'Firefox',
        bundleId,
        supportsExtension: true, // Firefox has its own extension format
      };
    }
    
    return null;
  } catch (error) {
    console.log('Failed to detect active browser:', error);
    return null;
  }
};

/**
 * Checks if Chrome is the currently active (frontmost) application on macOS
 * Returns true only if Chrome has keyboard focus (is the active app)
 */
const isChromeActive = async (): Promise<boolean> => {
  const browser = await getActiveBrowser();
  return browser?.name === 'Chrome' || false;
};

/**
 * Checks if the Chrome extension is connected (ping received within timeout window)
 */
const isExtensionConnected = (): boolean => {
  if (extensionLastPing === 0) {
    return false;
  }
  const now = Date.now();
  const timeSincePing = now - extensionLastPing;
  return timeSincePing < EXTENSION_PING_TIMEOUT;
};

/**
 * Updates the extension connection state (called when ping is received)
 */
const updateExtensionPing = (): void => {
  extensionLastPing = Date.now();
  console.log('Extension connection ping received');
};

/**
 * Checks if there was a very recent save from the extension (within last 2 seconds)
 */
const checkRecentExtensionSave = async (): Promise<boolean> => {
  try {
    const response = await fetch('http://localhost:3000/api/v1/saved-urls?limit=5');
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const now = Date.now();
        const recentExtensionSave = data.some((entry: any) => {
          const age = now - entry.timestamp;
          return entry.saved_by === 'extension' && age < 2000; // Within last 2 seconds
        });
        return recentExtensionSave;
      }
    }
  } catch (error) {
    console.log('Could not check recent extension save:', error);
  }
  return false;
};

/**
 * Checks if the browser extension is enabled by checking for saves with saved_by='extension'
 * When the extension is enabled and working, it marks saves with saved_by='extension'
 */
const isExtensionEnabled = async (): Promise<boolean> => {
  try {
    const response = await fetch('http://localhost:3000/api/v1/saved-urls?limit=50');
    if (response.ok) {
      const data = await response.json();
      
      if (Array.isArray(data) && data.length > 0) {
        // Check if any entry was saved by the extension
        const hasExtensionSaves = data.some((entry: any) => 
          entry.saved_by === 'extension'
        );
        return hasExtensionSaves;
      }
    }
  } catch (error) {
    console.log('Could not check extension status:', error);
  }
  return false;
};

/**
 * Shows a dialog asking user to enable the browser extension
 * @param browserInfo Information about the active browser
 */
const showEnableExtensionDialog = async (browserInfo: BrowserInfo): Promise<void> => {
  try {
    const browserName = browserInfo.name;
    let extensionsUrl = 'chrome://extensions/';
    let browserApp = browserName;
    
    // Set browser-specific URLs and app names
    if (browserName === 'Chrome') {
      extensionsUrl = 'chrome://extensions/';
      browserApp = 'Google Chrome';
    } else if (browserName === 'Arc') {
      extensionsUrl = 'arc://extensions/';
      browserApp = 'Arc';
    } else if (browserName === 'Edge') {
      extensionsUrl = 'edge://extensions/';
      browserApp = 'Microsoft Edge';
    } else if (browserName === 'Firefox') {
      extensionsUrl = 'about:addons';
      browserApp = 'Firefox';
    }
    
    // Get extension folder path (use chromium folder for Chrome-based browsers, firefox for Firefox)
    const extensionFolder = browserName === 'Firefox'
      ? path.resolve(__dirname, '../../browser-extension/firefox')
      : path.resolve(__dirname, '../../browser-extension/chromium');
    
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'Enable Blink Extension',
      message: `Enable Browser Extension in ${browserName}`,
      detail: `To save URLs and images using the shortcut, please enable the Blink extension in ${browserName}.\n\nSteps:\n1. Click "Open Extensions" below\n2. Enable "Developer mode" (toggle in top right)\n3. Click "Load unpacked"\n4. Select this folder:\n   ${extensionFolder}\n\nAfter enabling, press Cmd+Shift+S in ${browserName} to save URLs and images!`,
      buttons: ['Ignore', 'Open Extensions'],
      defaultId: 1,
      cancelId: 0,
    };
    
    const result = mainWindow 
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    
    // Handle "Open Extensions" button (response 1)
    if (result.response === 1) {
      // Open extensions page in the browser
      try {
        if (process.platform === 'darwin') {
          const openScript = `
            tell application "${browserApp}"
              activate
              open location "${extensionsUrl}"
            end tell
          `;
          await execAsync(`osascript -e '${openScript.replace(/'/g, "'\\''")}'`);
        } else {
          // For Windows/Linux, try opening via shell
          shell.openExternal(extensionsUrl);
        }
      } catch (openError) {
        console.error('Failed to open extensions page:', openError);
        // Fallback: Show message with manual instructions
        dialog.showErrorBox(
          'Could not open extensions page automatically',
          `Please manually open ${browserName} and go to:\n${extensionsUrl}`
        );
      }
    }
    // If "Ignore" button is clicked (response 0), dialog closes and user can continue using global shortcut
  } catch (error) {
    console.error('Failed to show enable dialog:', error);
  }
};

interface BrowserTabInfo {
  url: string;
  title: string;
}

/**
 * Injects extension detector script into the active browser tab
 * This allows showing enable popup even when extension isn't enabled
 */
const injectExtensionDetector = async (): Promise<void> => {
  if (process.platform !== 'darwin') {
    // Only works on macOS with AppleScript
    return;
  }
  
  try {
    const script = `
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
      end tell
      
      if frontApp contains "Chrome" or frontApp contains "Arc" or frontApp contains "Edge" then
        tell application frontApp
          activate
          tell application "System Events"
            -- Inject script via keyboard shortcut simulation
            -- This is a workaround - direct injection isn't possible
          end tell
        end tell
      end if
    `;
    
    // For now, we'll rely on the extension's own detection
    // The popup will show when shortcut is pressed in browser if extension isn't enabled
    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
  } catch (error) {
    // Silently fail - this is optional functionality
    console.log('Could not inject detector script:', error);
  }
};

/**
 * Captures the active browser tab URL and title using AppleScript on macOS.
 * Supports Safari, Chrome, Firefox, and Edge.
 */
const getActiveBrowserTab = async (): Promise<BrowserTabInfo | null> => {
  try {
    // First, detect which browser is frontmost
    const getFrontmostAppScript = `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`;
    const { stdout: frontmostApp } = await execAsync(getFrontmostAppScript);
    const appName = frontmostApp.trim().toLowerCase();

    let script = '';

    if (appName.includes('safari')) {
      script = `
        tell application "Safari"
          tell front window
            set currentTab to current tab
            set tabURL to URL of currentTab
            set tabTitle to name of currentTab
            return tabURL & "|||" & tabTitle
          end tell
        end tell
      `;
    } else if (appName.includes('arc')) {
      script = `
        tell application "Arc"
          tell active tab of front window
            set tabURL to URL
            set tabTitle to title
            return tabURL & "|||" & tabTitle
          end tell
        end tell
      `;
    } else if (appName.includes('chrome') || appName.includes('google chrome')) {
      script = `
        tell application "Google Chrome"
          tell active tab of front window
            set tabURL to URL
            set tabTitle to title
            return tabURL & "|||" & tabTitle
          end tell
        end tell
      `;
    } else if (appName.includes('firefox')) {
      script = `
        tell application "Firefox"
          activate
        end tell
        tell application "System Events"
          tell process "Firefox"
            keystroke "l" using command down
            delay 0.5
            keystroke "c" using command down
            delay 0.3
          end tell
        end tell
        delay 0.2
        set clipboardContent to the clipboard as string
        return clipboardContent & "|||" & "Firefox Tab"
      `;
      // Note: Firefox AppleScript support is limited. This is a workaround.
      // For better Firefox support, consider using browser extensions.
    } else if (appName.includes('edge') || appName.includes('microsoft edge')) {
      script = `
        tell application "Microsoft Edge"
          tell active tab of front window
            set tabURL to URL
            set tabTitle to title
            return tabURL & "|||" & tabTitle
          end tell
        end tell
      `;
    } else {
      console.warn(`Unsupported browser: ${appName}`);
      return null;
    }

    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    const result = stdout.trim();
    
    if (!result || result.includes('|||') === false) {
      return null;
    }

    const [url, title] = result.split('|||').map(s => s.trim());
    
    if (!url || !title) {
      return null;
    }

    return { url, title };
  } catch (error) {
    console.error('Failed to get active browser tab:', error);
    return null;
  }
};

/**
 * Creates a small dropzone window at the bottom-center of the desktop
 * This approach works cross-platform (macOS, Windows, iOS, Android) and doesn't block mouse interactions.
 * The dropzone is always visible but subtle, appearing when dragging items over it.
 */
const createDropzoneWindow = () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  
  // Dropzone dimensions - small, unobtrusive, always visible
  const dropzoneWidth = 300;
  const dropzoneHeight = 60;
  const bottomMargin = 20;
  
  // Calculate position at bottom-center of screen
  const x = Math.floor((screenWidth - dropzoneWidth) / 2);
  const y = screenHeight - dropzoneHeight - bottomMargin;
  
  // Create small window at bottom-center
  dropzoneWindow = new BrowserWindow({
    width: dropzoneWidth,
    height: dropzoneHeight,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: false, // Disabled to prevent DnD interference
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  
  dropzoneWindow.loadFile(path.resolve(__dirname, '../dropzone.html'));
  
  // Enable mouse events - only the small dropzone area blocks interactions, not the whole screen
  dropzoneWindow.setIgnoreMouseEvents(false);
  
  // Handle window close
  dropzoneWindow.on('closed', () => {
    dropzoneWindow = null;
  });
  
  // Listen for dropzone save completion to refresh main window
  ipcMain.on('dropzone-save-complete', () => {
    if (mainWindow) {
      mainWindow.webContents.send('refresh-data');
    }
  });
};

const createTray = () => {
  // Temporary tray icon (SVG) aligned with Blink purple until official logo exists.
  const accent = (BRAND && (BRAND as any).KEY_COLOR_HEX) ? (BRAND as any).KEY_COLOR_HEX : '#BC13FE';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${accent}" stop-opacity="1"/>
          <stop offset="1" stop-color="${accent}" stop-opacity="0.65"/>
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="13" height="13" rx="4" fill="url(#g)"/>
      <path d="M8 4.3c1.9 0 3.4 1.5 3.4 3.4S9.9 11.1 8 11.1 4.6 9.6 4.6 7.7 6.1 4.3 8 4.3Z"
            fill="white" fill-opacity="0.92"/>
      <circle cx="10.4" cy="6.2" r="0.9" fill="${accent}" fill-opacity="0.95"/>
    </svg>
  `.trim();
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const trayIcon = nativeImage.createFromDataURL(dataUrl);
  tray = new Tray(trayIcon);
  tray.setToolTip('Blink');
  tray.on('click', () => {
    // Toggle visibility for debugging or status checks
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });
};

/**
 * Resizes all visible windows to avoid the dock area
 * Uses AppleScript on macOS to resize windows
 */
const resizeAllWindowsToAvoidDock = async () => {
  if (process.platform !== 'darwin') {
    console.log('Window resizing only supported on macOS');
    return;
  }

  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    // Use bounds (full screen) instead of workAreaSize to get actual screen dimensions
    const { width: screenWidth, height: screenHeight } = primaryDisplay.bounds;
    
    // REMOVED: Dock window avoidance - dock is now integrated into main window
    // Dock container is 250px wide, but it's part of the main window, not a separate window
    // Other windows don't need to avoid it since it's not a separate window
    const dockWidth = 0; // No separate dock window to avoid
    const availableX = 0;
    const availableWidth = screenWidth;
    const availableHeight = screenHeight;

    // AppleScript to resize all visible windows
    const script = `
      tell application "System Events"
        set allProcesses to every process whose visible is true
        repeat with proc in allProcesses
          try
            set procName to name of proc
            -- Skip our own application (Electron or Blink)
            if procName is not "Electron" and procName is not "Blink" and procName does not contain "Electron" then
              set allWindows to every window of proc
              repeat with win in allWindows
                try
                  -- Get window properties
                  set winProperties to properties of win
                  set winPosition to position of win
                  set winSize to size of win
                  
                  set winX to item 1 of winPosition
                  set winY to item 2 of winPosition
                  set winWidth to item 1 of winSize
                  set winHeight to item 2 of winSize
                  
                  -- REMOVED: Dock window avoidance check
                  -- Dock is now integrated into main window, no separate dock to avoid
                  -- Only check if window extends beyond screen
                  if winX + winWidth > ${screenWidth} then
                    -- Window extends beyond screen, adjust width to fit
                    set newWidth to ${screenWidth} - winX
                    if newWidth > 100 then
                      set size of win to {newWidth, winHeight}
                    end if
                  end if
                on error errMsg
                  -- Skip windows that can't be resized (dialogs, etc.)
                end try
              end repeat
            end if
          on error errMsg
            -- Skip processes that can't be accessed
          end try
        end repeat
      end tell
    `;

    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    console.log('✅ Resized all windows to avoid dock area');
  } catch (error) {
    console.error('Failed to resize windows:', error);
    // Show user-friendly error if Accessibility permissions are missing
    if (error instanceof Error && (error.message.includes('not allowed assistive') || error.message.includes('execution error'))) {
      dialog.showErrorBox(
        'Accessibility Permission Required',
        'To resize windows, please enable Accessibility permissions:\n\n1. Go to System Preferences > Security & Privacy > Privacy > Accessibility\n2. Enable the checkbox for "Terminal" or "Electron" (whichever appears)\n3. Try the shortcut again (Cmd+Shift+R)'
      );
    }
  }
};

const registerShortcut = () => {
  // Always register the shortcut so we can immediately show placeholder
  // Extension will handle actual save when connected, but we need shortcut for instant UI feedback
  if (!shortcutRegistered) {
    const success = globalShortcut.register(SHORTCUT_ACCELERATOR, () => {
      console.log('Shortcut triggered! (Global Cmd+Shift+S)');
      
      // IMMEDIATELY show placeholder DataCard (don't wait for anything)
      const timestamp = Date.now();
      const placeholderPayload = {
        url: 'about:blank',
        title: 'Loading...',
        timestamp: timestamp,
        saved_by: 'extension',
      };
      
      // Send placeholder to main window IMMEDIATELY (synchronous, no await)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pending-save', placeholderPayload);
      }
      
      // Now continue with actual processing (async, doesn't block UI)
      (async () => {
        try {
          // Track browser focus changes (this ensures dialog state is reset when browser gains focus)
          await trackBrowserFocus();
          
          // Detect which browser is active
          const activeBrowser = await getActiveBrowser();
          
          if (activeBrowser && activeBrowser.supportsExtension) {
            // A supported browser is active - check extension connection
            const extensionConnected = isExtensionConnected();
            
            if (!extensionConnected) {
              // Browser is active but extension is NOT connected
              // Show dialog only if we haven't shown it for this browser focus session yet
              // (Dialog state is reset when browser gains focus via trackBrowserFocus)
              if (!browsersDialogShown.has(activeBrowser.bundleId)) {
                console.log(`${activeBrowser.name} is active but extension is not connected - showing setup dialog`);
                browsersDialogShown.add(activeBrowser.bundleId);
                await showEnableExtensionDialog(activeBrowser);
                return;
              } else {
                // Dialog already shown for this browser session - continue with global shortcut
                console.log(`Dialog already shown for ${activeBrowser.name} - using global shortcut`);
              }
            } else {
              // Extension is connected - it will handle the shortcut and send real data
              // The placeholder we just showed will be updated when extension sends data
              console.log(`${activeBrowser.name} active with extension - extension will handle and send real data`);
              return;
            }
          }
          
          // No supported browser with extension is active - handle the shortcut via native app
          console.log('No supported browser with extension is active - handling via native app');
          
          // Get the actual active browser tab info
          const tabInfo = await getActiveBrowserTab();
          
          if (!tabInfo) {
            console.error('❌ Could not capture active browser tab. Make sure a supported browser (Safari, Arc, Chrome, Firefox, Edge) is active.');
            return;
          }

          const payload = {
            url: tabInfo.url,
            title: tabInfo.title,
            timestamp: timestamp, // Use same timestamp as placeholder
            saved_by: 'global', // Flag to indicate this save came from Electron app's global shortcut
          };

          console.log('Captured tab info:', payload);
          console.log('Saving via Electron app...');
          
          // Send real data to main window to update the placeholder
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pending-save', payload);
          }
          
          const response = await fetch('http://localhost:3000/api/v1/save-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          
          if (response.ok) {
            console.log('✅ URL saved successfully! (Page URL saved via Electron app)');
            
            // Refresh main window to get confirmed data from server
            if (mainWindow) {
              mainWindow.webContents.send('refresh-data');
            }
          } else {
            console.error('❌ Server returned error:', response.status, response.statusText);
          }
        } catch (err) {
          console.error('Failed to send URL to server', err);
        }
      })();
    });
    
    if (success) {
      shortcutRegistered = true;
      console.log('Shortcut registered (always active for instant placeholder)');
    } else {
      console.error('Failed to register shortcut');
    }
  }
  
  // Register window resize shortcut (Cmd+Shift+R)
  const resizeSuccess = globalShortcut.register(RESIZE_WINDOWS_SHORTCUT, async () => {
    console.log('Window resize shortcut triggered (Cmd+Shift+R)');
    await resizeAllWindowsToAvoidDock();
  });
  
  if (resizeSuccess) {
    resizeWindowsShortcutRegistered = true;
    console.log('Window resize shortcut registered (Cmd+Shift+R)');
  } else {
    console.error('Failed to register window resize shortcut');
  }
};

// Track shortcut registration state
let shortcutRegistered = false;
const SHORTCUT_ACCELERATOR = 'CommandOrControl+Shift+S';
let resizeWindowsShortcutRegistered = false;
const RESIZE_WINDOWS_SHORTCUT = 'CommandOrControl+Shift+R';

// Manage shortcut registration - register/unregister based on extension connection state
// When extension is connected, unregister so extension can handle it
// When extension is NOT connected, register so Electron can handle it
const manageShortcutRegistration = async () => {
  const extensionConnected = isExtensionConnected();
  
  if (extensionConnected) {
    // Extension is connected - unregister Electron's shortcut so extension can handle it
    if (shortcutRegistered) {
      globalShortcut.unregister(SHORTCUT_ACCELERATOR);
      shortcutRegistered = false;
      console.log('Extension connected - unregistered Electron global shortcut (extension will handle it)');
    }
  } else {
    // Extension is NOT connected - register Electron's shortcut to handle it
    if (!shortcutRegistered) {
      const success = globalShortcut.register(SHORTCUT_ACCELERATOR, () => {
        console.log('Shortcut triggered! (Global Cmd+Shift+S - Electron handling)');
        
        // IMMEDIATELY show placeholder DataCard (don't wait for anything)
        const timestamp = Date.now();
        const placeholderPayload = {
          url: 'about:blank',
          title: 'Loading...',
          timestamp: timestamp,
          saved_by: 'extension',
        };
        
        // Send placeholder to main window IMMEDIATELY (synchronous, no await)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pending-save', placeholderPayload);
        }
        
        // Now continue with actual processing (async, doesn't block UI)
        (async () => {
          try {
            // Track browser focus changes (this ensures dialog state is reset when browser gains focus)
            await trackBrowserFocus();
            
            // Detect which browser is active
            const activeBrowser = await getActiveBrowser();
            
            if (activeBrowser && activeBrowser.supportsExtension) {
              // A supported browser is active - check extension connection
              const extensionConnected = isExtensionConnected();
              
              if (!extensionConnected) {
                // Browser is active but extension is NOT connected
                // Show dialog only if we haven't shown it for this browser focus session yet
                // (Dialog state is reset when browser gains focus via trackBrowserFocus)
                if (!browsersDialogShown.has(activeBrowser.bundleId)) {
                  console.log(`${activeBrowser.name} is active but extension is not connected - showing setup dialog`);
                  browsersDialogShown.add(activeBrowser.bundleId);
                  await showEnableExtensionDialog(activeBrowser);
                  return;
                } else {
                  // Dialog already shown for this browser session - continue with global shortcut
                  console.log(`Dialog already shown for ${activeBrowser.name} - using global shortcut`);
                }
              } else {
                // Extension connected after shortcut was pressed - extension will handle next time
                console.log(`${activeBrowser.name} active with extension - extension will handle next shortcut`);
                return;
              }
            }
            
            // No supported browser with extension is active - handle the shortcut via native app
            console.log('No supported browser with extension is active - handling via native app');
            
            // Get the actual active browser tab info
            const tabInfo = await getActiveBrowserTab();
            
            if (!tabInfo) {
              console.error('❌ Could not capture active browser tab. Make sure a supported browser (Safari, Arc, Chrome, Firefox, Edge) is active.');
              return;
            }

            const payload = {
              url: tabInfo.url,
              title: tabInfo.title,
              timestamp: timestamp, // Use same timestamp as placeholder
              saved_by: 'global', // Flag to indicate this save came from Electron app's global shortcut
            };

            console.log('Captured tab info:', payload);
            console.log('Saving via Electron app...');
            
            // Send real data to main window to update the placeholder
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('pending-save', payload);
            }
            
            const response = await fetch('http://localhost:3000/api/v1/save-url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            
            if (response.ok) {
              console.log('✅ URL saved successfully! (Page URL saved via Electron app)');
              
              // Refresh main window to get confirmed data from server
              if (mainWindow) {
                mainWindow.webContents.send('refresh-data');
              }
            } else {
              console.error('❌ Server returned error:', response.status, response.statusText);
            }
          } catch (err) {
            console.error('Failed to send URL to server', err);
          }
        })();
      });
      
      if (success) {
        shortcutRegistered = true;
        console.log('Extension NOT connected - registered Electron global shortcut');
      } else {
        console.error('Failed to register shortcut');
      }
    }
  }
};

/**
 * Tracks browser focus changes and resets dialog state when a browser gains or regains focus
 * This ensures the dialog shows the first time the shortcut is pressed after a browser becomes active
 */
const trackBrowserFocus = async () => {
  const currentBrowser = await getActiveBrowser();
  
  // Check if a supported browser is active
  if (currentBrowser && currentBrowser.supportsExtension) {
    // If this is a different browser than before (browser gained/regained focus)
    if (!previousActiveBrowser || previousActiveBrowser.bundleId !== currentBrowser.bundleId) {
      // Browser gained or regained focus - reset dialog state so it can show again on first shortcut press
      browsersDialogShown.delete(currentBrowser.bundleId);
      console.log(`${currentBrowser.name} gained/regained focus - dialog state reset for first shortcut press`);
    }
    // If browser is the same, don't reset (user is continuing to use the same browser)
  } else {
    // No supported browser is active - this is fine, just update the tracker
  }
  
  // Update previous browser tracker for next comparison
  previousActiveBrowser = currentBrowser;
};

// Set up extension ping polling and shortcut management
const startExtensionPingPolling = () => {
  setInterval(async () => {
    try {
      // Track browser focus changes
      await trackBrowserFocus();
      
      const response = await fetch('http://localhost:3000/api/v1/extension/status');
      if (response.ok) {
        const data = await response.json();
        if (data.connected) {
          extensionLastPing = data.lastPing;
        } else {
          extensionLastPing = 0;
        }
      }
      
      // Manage shortcut registration based on current state
      await manageShortcutRegistration();
    } catch (error) {
      // Silently handle errors (server might not be running)
      extensionLastPing = 0;
      // Still track browser focus and manage shortcut registration
      trackBrowserFocus();
      manageShortcutRegistration();
    }
  }, 2000); // Check every 2 seconds for more responsive shortcut management
};

// Single instance lock - prevent multiple instances from running
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
} else {
  // This is the first instance, continue normally
  app.on('second-instance', () => {
    // Another instance tried to launch, focus this one instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

// REMOVED: dockDefenseInterval - dock is now integrated into main window

app.whenReady().then(async () => {
  // Note: OAuth callback uses http://localhost callback server, no protocol handler needed

  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.cdninstagram.com/*',
        '*://*.fbcdn.net/*',
        '*://*.instagram.com/*',
        '*://*.facebook.com/*',
      ],
    },
    (details, callback) => {
      const headers = details.requestHeaders || {};
      try {
        const url = new URL(details.url);
        const host = url.hostname || '';
        if (host.includes('instagram.com') || host.includes('cdninstagram.com')) {
          headers['Referer'] = 'https://www.instagram.com/';
        } else if (host.includes('fbcdn.net')) {
          headers['Referer'] = 'https://www.facebook.com/';
        }
      } catch (e) {}
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'origin') {
          delete headers[key];
        }
      }
      headers['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
      callback({ requestHeaders: headers });
    }
  );

  try {
    await session.defaultSession.clearCache();
  } catch (e) {}
  
  // Start HTTP servers
  startPendingSaveServer();
  startFirestoreSaveServer();
  
  // Create main window only (dock is now integrated into main window)
  createWindow();
  // Dropzone is now in the browser extension (for browser) and in the app window header (for system-wide)
  // createDropzoneWindow(); // Removed - using extension dropzone and app window dropzone instead
  createTray();
  registerShortcut();

  mainWindow?.on('focus', () => {
    try {
      mainWindow?.webContents.send('app:focus-changed', true);
      if (!isDashboard) return;
      // Auto-hide OFF: slide dock to x=0 and pin it
      if (mainWindow && !mainWindow.isDestroyed()) {
        const bounds = mainWindow.getBounds();
        dockPinned = true;
        animateWindowPosition(mainWindow, bounds.x, bounds.y, 0, bounds.y, DOCK_ANIMATION_DURATION_MS, () => {
          mainWindow?.webContents.send('dock:pinStateChanged', true);
        });
      }
    } catch (e) {}
  });
  mainWindow?.on('blur', () => {
    try {
      mainWindow?.webContents.send('app:focus-changed', false);
      if (!isDashboard) return;
      // Close DevTools before auto-hiding to prevent the 5px trigger area
      // being occupied by the DevTools panel instead of the renderer content
      if (mainWindow && !mainWindow!.isDestroyed()) {
        mainWindow!.webContents.closeDevTools();
      }
      // Auto-hide ON: unpin and slide dock off-screen
      if (mainWindow && !mainWindow!.isDestroyed()) {
        const bounds = mainWindow!.getBounds();
        dockPinned = false;
        const targetX = -(bounds.width - DOCK_TRIGGER_WIDTH);
        animateWindowPosition(mainWindow!, bounds.x, bounds.y, targetX, bounds.y, DOCK_ANIMATION_DURATION_MS, () => {
          mainWindow?.webContents.send('dock:pinStateChanged', false);
        });
      }
    } catch (e) {}
  });
  
  // Listen for dropzone save completion to refresh main window
  ipcMain.on('dropzone-save-complete', () => {
    if (mainWindow) {
      mainWindow.webContents.send('refresh-data');
    }
  });
  
  // Listen for dock item click - forward to main window
  ipcMain.on('dock-item-clicked', (event, itemData) => {
    if (mainWindow) {
      mainWindow.webContents.send('open-browser-tab', itemData);
      // Show and focus main window if it's hidden
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });
  
  // Auth IPC handlers
  ipcMain.handle('auth:signInWithGoogle', async () => {
    try {
      return await authService.signInWithGoogle(shell);
    } catch (error: any) {
      console.error('Auth sign-in error:', error);
      return { success: false, error: error.message || 'Failed to sign in' };
    }
  });
  
  ipcMain.handle('auth:signOut', async () => {
    try {
      return await authService.signOut();
    } catch (error: any) {
      console.error('Auth sign-out error:', error);
      return { success: false, error: error.message || 'Failed to sign out' };
    }
  });
  
  ipcMain.handle('auth:getCurrentUser', async () => {
    try {
      return authService.getCurrentUserData();
    } catch (error: any) {
      console.error('Auth get current user error:', error);
      return null;
    }
  });
  
  // Firestore IPC handlers
  ipcMain.handle('firestore:getDatasByUser', async (_event, userId: string, limit?: number) => {
    try {
      const items = await firestoreService.getDatasByUser(userId, limit);
      // Transform Firestore data to match dock format (createdAt -> timestamp)
      return items.map(item => ({
        ...item,
        timestamp: item.createdAt || item.timestamp || Date.now(),
        id: item.id, // Ensure id is included
      }));
    } catch (error: any) {
      console.error('Firestore getDatasByUser error:', error);
      return [];
    }
  });

  // Real-time Firestore watching via IPC
  ipcMain.handle('firestore:watchDatasByUser', (event, userId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      console.error('Cannot find window for Firestore watch');
      return;
    }

    // Clean up existing watcher for this window/userId if any
    const windowWatchers = firestoreWatchers.get(window) || new Map();
    const existingUnsubscribe = windowWatchers.get(userId);
    if (existingUnsubscribe) {
      existingUnsubscribe();
      windowWatchers.delete(userId);
    }

    // Set up new real-time listener
    const unsubscribe = firestoreService.watchDatasByUser(userId, (items) => {
      // Transform Firestore data to match dock format (createdAt -> timestamp)
      const transformedItems = items.map(item => ({
        ...item,
        timestamp: item.createdAt || item.timestamp || Date.now(),
        id: item.id,
      }));
      
      // Send data update to renderer process
      event.sender.send('firestore:dataChanged', transformedItems);
    });

    // Store unsubscribe function
    if (!firestoreWatchers.has(window)) {
      firestoreWatchers.set(window, new Map());
    }
    firestoreWatchers.get(window)!.set(userId, unsubscribe);

    // Clean up when window is destroyed
    window.once('closed', () => {
      const watchers = firestoreWatchers.get(window);
      if (watchers) {
        watchers.forEach(unsub => unsub());
        firestoreWatchers.delete(window);
      }
    });
  });

  // Delete data from Firestore
  ipcMain.handle('firestore:deleteData', async (_event, dataId: string, userId: string) => {
    try {
      await firestoreService.deleteData(dataId, userId);
      return { success: true };
    } catch (error: any) {
      console.error('Firestore deleteData error:', error);
      return { success: false, error: error.message || 'Failed to delete data' };
    }
  });

  // Delete all data from Firestore for a user
  ipcMain.handle('firestore:deleteAllData', async (_event, userId: string) => {
    try {
      const deletedCount = await firestoreService.deleteAllData(userId);
      return { success: true, deletedCount };
    } catch (error: any) {
      console.error('Firestore deleteAllData error:', error);
      return { success: false, error: error.message || 'Failed to delete all data' };
    }
  });

  // Unsubscribe from Firestore watching
  ipcMain.handle('firestore:unwatchDatasByUser', (event, userId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;

    const windowWatchers = firestoreWatchers.get(window);
    if (windowWatchers) {
      const unsubscribe = windowWatchers.get(userId);
      if (unsubscribe) {
        unsubscribe();
        windowWatchers.delete(userId);
        console.log(`${BRAND.LOG_PREFIX} Firestore: Stopped watching data for user:`, userId);
      }
    }
  });
  
  // Directory IPC handlers
  ipcMain.handle('firestore:createDirectory', async (_event, userId: string, name: string) => {
    try {
      const directoryId = await firestoreService.createDirectory(userId, name);
      return { success: true, directoryId };
    } catch (error: any) {
      console.error('Firestore createDirectory error:', error);
      return { success: false, error: error.message || 'Failed to create directory' };
    }
  });

  ipcMain.handle('firestore:getDirectoriesByUser', async (_event, userId: string) => {
    try {
      const directories = await firestoreService.getDirectoriesByUser(userId);
      return directories;
    } catch (error: any) {
      console.error('Firestore getDirectoriesByUser error:', error);
      return [];
    }
  });

  // Real-time directory watching via IPC
  ipcMain.handle('firestore:watchDirectoriesByUser', (event, userId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      console.error('Cannot find window for Firestore directory watch');
      return;
    }

    // Clean up existing watcher for this window/userId if any
    const windowWatchers = firestoreDirectoryWatchers.get(window) || new Map();
    const existingUnsubscribe = windowWatchers.get(userId);
    if (existingUnsubscribe) {
      existingUnsubscribe();
      windowWatchers.delete(userId);
    }

    // Set up new real-time listener
    const unsubscribe = firestoreService.watchDirectoriesByUser(userId, (directories) => {
      // Send data update to renderer process
      event.sender.send('firestore:directoriesChanged', directories);
    });

    // Store unsubscribe function
    if (!firestoreDirectoryWatchers.has(window)) {
      firestoreDirectoryWatchers.set(window, new Map());
    }
    firestoreDirectoryWatchers.get(window)!.set(userId, unsubscribe);

    // Clean up when window is destroyed
    window.once('closed', () => {
      const watchers = firestoreDirectoryWatchers.get(window);
      if (watchers) {
        watchers.forEach(unsub => unsub());
        firestoreDirectoryWatchers.delete(window);
      }
    });
  });

  ipcMain.handle('firestore:updateDirectory', async (_event, directoryId: string, userId: string, name: string) => {
    try {
      await firestoreService.updateDirectory(directoryId, userId, name);
      return { success: true };
    } catch (error: any) {
      console.error('Firestore updateDirectory error:', error);
      return { success: false, error: error.message || 'Failed to update directory' };
    }
  });

  ipcMain.handle('firestore:deleteDirectory', async (_event, directoryId: string, userId: string) => {
    try {
      await firestoreService.deleteDirectory(directoryId, userId);
      return { success: true };
    } catch (error: any) {
      console.error('Firestore deleteDirectory error:', error);
      return { success: false, error: error.message || 'Failed to delete directory' };
    }
  });

  ipcMain.handle('firestore:updateItemDirectory', async (_event, itemId: string, userId: string, directoryId: string) => {
    try {
      await firestoreService.updateItemDirectory(itemId, userId, directoryId);
      return { success: true };
    } catch (error: any) {
      console.error('Firestore updateItemDirectory error:', error);
      return { success: false, error: error.message || 'Failed to update item directory' };
    }
  });

  // Move item to a new position (with reordering)
  ipcMain.handle('firestore:moveItemToPosition', async (_event, userId: string, itemId: string, targetDirectoryId: string | null, newIndex: number, sourceDirectoryId: string | null) => {
    try {
      await firestoreService.moveItemToPosition(userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId);
      return { success: true };
    } catch (error: any) {
      console.error('Firestore moveItemToPosition error:', error);
      return { success: false, error: error.message || 'Failed to move item to position' };
    }
  });

  // Move directory to a new position (with reordering)
  ipcMain.handle('firestore:moveDirectoryToPosition', async (_event, userId: string, directoryId: string, newIndex: number) => {
    try {
      await firestoreService.moveDirectoryToPosition(userId, directoryId, newIndex);
      return { success: true };
    } catch (error: any) {
      console.error('Firestore moveDirectoryToPosition error:', error);
      return { success: false, error: error.message || 'Failed to move directory to position' };
    }
  });

  // Unsubscribe from directory watching
  ipcMain.handle('firestore:unwatchDirectoriesByUser', (event, userId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;

    const windowWatchers = firestoreDirectoryWatchers.get(window);
    if (windowWatchers) {
      const unsubscribe = windowWatchers.get(userId);
      if (unsubscribe) {
        unsubscribe();
        windowWatchers.delete(userId);
        console.log(`${BRAND.LOG_PREFIX} Firestore: Stopped watching directories for user:`, userId);
      }
    }
  });
  
  // Dock pin (auto-hide) IPC handlers
  ipcMain.handle('dock:getPinned', () => dockPinned);
  ipcMain.handle('dock:setPinned', async (_event, pinned: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dockPinned = !!pinned;
    if (dockPinned) {
      mainWindow.setPosition(0, 0);
      mainWindow.webContents.send('dock:pinStateChanged', true);
    } else {
      const bounds = mainWindow.getBounds();
      const targetX = -(bounds.width - DOCK_TRIGGER_WIDTH);
      animateWindowPosition(mainWindow, bounds.x, bounds.y, targetX, bounds.y, DOCK_ANIMATION_DURATION_MS, () => {
        mainWindow?.webContents.send('dock:pinStateChanged', false);
      });
    }
  });
  ipcMain.handle('dock:show', async () => {
    if (!mainWindow || mainWindow.isDestroyed() || dockPinned) return;
    const bounds = mainWindow.getBounds();
    if (bounds.x >= 0) return; // already shown
    animateWindowPosition(mainWindow, bounds.x, bounds.y, 0, bounds.y, DOCK_ANIMATION_DURATION_MS);
  });
  ipcMain.handle('dock:hide', async () => {
    if (!mainWindow || mainWindow.isDestroyed() || dockPinned) return;
    const bounds = mainWindow.getBounds();
    const targetX = -(bounds.width - DOCK_TRIGGER_WIDTH);
    if (bounds.x <= targetX + 1) return; // already hidden
    animateWindowPosition(mainWindow, bounds.x, bounds.y, targetX, bounds.y, DOCK_ANIMATION_DURATION_MS);
  });

  // When a new item is saved, briefly show the dock so the user can see
  // the card entrance animation, then auto-hide again after 1 second.
  ipcMain.on('data:saved', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (dockPinned) return;

    // Cancel any pending hide timer from a previous save
    if (dataSavedHideTimer) {
      clearTimeout(dataSavedHideTimer);
      dataSavedHideTimer = null;
    }

    const scheduleHide = () => {
      dataSavedHideTimer = setTimeout(() => {
        dataSavedHideTimer = null;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (dockPinned) return; // User pinned the dock in the meantime
        const currentBounds = mainWindow.getBounds();
        const targetX = -(currentBounds.width - DOCK_TRIGGER_WIDTH);
        isAnimatingOut = true;
        animateWindowPosition(
          mainWindow,
          currentBounds.x,
          currentBounds.y,
          targetX,
          currentBounds.y,
          DOCK_ANIMATION_DURATION_MS,
          () => { isAnimatingOut = false; }
        );
      }, 1000); // 500ms card animation + 500ms pause
    };

    const bounds = mainWindow.getBounds();
    const isHidden = bounds.x < 0;

    if (isAnimatingOut) {
      // Dock is currently sliding out — cancel and slide back in from current position
      isAnimatingOut = false;
      animateWindowPosition(
        mainWindow,
        bounds.x,
        bounds.y,
        0,
        bounds.y,
        DOCK_ANIMATION_DURATION_MS,
        () => scheduleHide()
      );
    } else if (isHidden) {
      // Dock is fully hidden — slide it in, then schedule hide
      animateWindowPosition(
        mainWindow,
        bounds.x,
        bounds.y,
        0,
        bounds.y,
        DOCK_ANIMATION_DURATION_MS,
        () => scheduleHide()
      );
    } else {
      // Dock is already fully visible — just reset the hide timer
      scheduleHide();
    }
  });

  // Shell API IPC handlers
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
    } catch (error: any) {
      console.error('Failed to open external URL:', error);
      throw error;
    }
  });
  
  // Window management API for drag-and-drop compatibility
  // Always-On-Top IPC handlers removed to prevent DnD interference
  
  // REMOVED: window:startDrag IPC handler
  // REASON: Incomplete implementation causes conflicts with standard browser DnD
  // Standard Browser DnD is more reliable for URL strings than file-based startDrag API

  ipcMain.handle('window:setIgnoreMouseEvents', async (_event, ignore: boolean) => {
    try {
      const window = BrowserWindow.fromWebContents(_event.sender);
      if (window) {
        window.setIgnoreMouseEvents(ignore);
        return { success: true };
      }
      return { success: false, error: 'Window not found' };
    } catch (error: any) {
      console.error('Failed to set ignore mouse events:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.on('disable-always-on-top', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setAlwaysOnTop(false);
    } catch (e) {}
  });

  ipcMain.on('enable-always-on-top', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (e) {}
  });
  
  ipcMain.handle('window:resize', async (_event, width: number) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: 'Window not available' };
      }
      const screenHeight = getPrimaryWorkAreaHeight();
      const currentBounds = mainWindow.getBounds();
      const safeWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : currentBounds.width;
      mainWindow.setSize(safeWidth, screenHeight);
      mainWindow.setPosition(0, 0);
      return { success: true, width: safeWidth };
    } catch (error: any) {
      console.error('Failed to resize window:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Ghost Window Management for Drag-and-Drop
  let ghostTrackingInterval: NodeJS.Timeout | null = null;
  
  /**
   * Create and configure the ghost window for drag visual feedback
   */
  function createGhostWindow(): ElectronBrowserWindow | null {
    if (ghostWindow && !ghostWindow.isDestroyed()) {
      return ghostWindow;
    }
    
    const ghost = new BrowserWindow({
      width: 250,
      height: 150,
      transparent: true,
      frame: false,
      alwaysOnTop: false, // Disabled to prevent DnD interference
      hasShadow: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      show: false, // Don't show until content is ready
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    
    // Set window level to stay above all OS elements
    if (process.platform === 'darwin') {
      ghost.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      ghost.setAlwaysOnTop(true, 'screen-saver');
    } else if (process.platform === 'win32') {
      ghost.setAlwaysOnTop(true, 'screen-saver');
    } else {
      ghost.setAlwaysOnTop(true, 'floating');
    }
    
    // Ignore mouse events so it doesn't intercept drops
    // Use forward: true to allow dragover and drop events to pass through
    ghost.setIgnoreMouseEvents(true, { forward: true });
    
    // Load ghost window HTML
    const ghostPath = path.join(__dirname, '../ghost-window.html');
    ghost.loadFile(ghostPath);
    
    // Handle ready event
    ipcMain.once('ghost:ready', () => {
      if (ghost && !ghost.isDestroyed()) {
        ghost.show();
      }
    });
    
    ghostWindow = ghost;
    return ghost;
  }
  
  /**
   * Start tracking global cursor position and update ghost window
   * Uses high-frequency interval (8ms ≈ 120fps) for smooth tracking
   */
  function startGhostTracking() {
    if (ghostTrackingInterval) {
      return; // Already tracking
    }
    
    // Use 8ms interval for 120fps smooth tracking (better than 60fps)
    ghostTrackingInterval = setInterval(() => {
      if (!ghostWindow || ghostWindow.isDestroyed()) {
        stopGhostTracking();
        return;
      }
      
      try {
        // Get global cursor position
        const cursorPoint = screen.getCursorScreenPoint();
        
        // Get ghost window bounds
        const bounds = ghostWindow.getBounds();
        
        // Calculate new position (center ghost on cursor with offset)
        // Offset will be set by renderer, default to center
        const offsetX = (ghostWindow as any).offsetX || bounds.width / 2;
        const offsetY = (ghostWindow as any).offsetY || bounds.height / 2;
        
        const x = cursorPoint.x - offsetX;
        const y = cursorPoint.y - offsetY;
        
        // Update ghost window position
        ghostWindow.setPosition(Math.round(x), Math.round(y));
      } catch (error) {
        console.error('Error tracking ghost window:', error);
        stopGhostTracking();
      }
    }, 8); // ~120fps (1000ms / 120 ≈ 8ms) for ultra-smooth tracking
  }
  
  /**
   * Stop tracking and cleanup
   */
  function stopGhostTracking() {
    if (ghostTrackingInterval) {
      clearInterval(ghostTrackingInterval);
      ghostTrackingInterval = null;
    }
  }
  
  /**
   * Close and destroy ghost window
   */
  function destroyGhostWindow() {
    stopGhostTracking();
    
    if (ghostWindow && !ghostWindow.isDestroyed()) {
      // Fade out before closing
      ghostWindow.webContents.send('ghost:fade-out');
      
      setTimeout(() => {
        if (ghostWindow && !ghostWindow.isDestroyed()) {
          ghostWindow.close();
          ghostWindow = null;
        }
      }, 200); // Wait for fade animation
    } else {
      ghostWindow = null;
    }
  }
  
  // IPC Handlers for Ghost Window
  ipcMain.handle('ghost:create', async (_event, cardHtml: string, width: number, height: number, offsetX: number, offsetY: number) => {
    try {
      const ghost = createGhostWindow();
      if (!ghost) {
        return { success: false, error: 'Failed to create ghost window' };
      }
      
      // Store offset for tracking
      (ghost as any).offsetX = offsetX;
      (ghost as any).offsetY = offsetY;
      
      // Set window size
      ghost.setSize(width, height);
      
      // Wait for window to be ready
      await new Promise<void>((resolve) => {
        if (ghost.webContents.isLoading()) {
          ghost.webContents.once('did-finish-load', () => {
            resolve();
          });
        } else {
          resolve();
        }
      });
      
      // Send card HTML content
      ghost.webContents.send('ghost:set-content', cardHtml);
      
      // Start tracking cursor
      startGhostTracking();
      
      // Setup global mouseup failsafe
      setupGlobalMouseUpFailsafe();
      
      return { success: true };
    } catch (error: any) {
      console.error('Failed to create ghost window:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('ghost:update-position', async (_event, offsetX: number, offsetY: number) => {
    try {
      if (ghostWindow && !ghostWindow.isDestroyed()) {
        (ghostWindow as any).offsetX = offsetX;
        (ghostWindow as any).offsetY = offsetY;
        return { success: true };
      }
      return { success: false, error: 'Ghost window not found' };
    } catch (error: any) {
      console.error('Failed to update ghost position:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('ghost:destroy', async () => {
    try {
      destroyGhostWindow();
      return { success: true };
    } catch (error: any) {
      console.error('Failed to destroy ghost window:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Global mouseup failsafe - destroy ghost window if dragend fails
  // This handles cases where dragend doesn't fire (e.g., drag outside window)
  let globalMouseUpListener: (() => void) | null = null;
  
  function setupGlobalMouseUpFailsafe() {
    // Remove existing listener if any
    if (globalMouseUpListener) {
      app.removeListener('browser-window-focus', globalMouseUpListener as any);
    }
    
    // Create new listener
    globalMouseUpListener = () => {
      // Check if ghost window exists and should be cleaned up
      if (ghostWindow && !ghostWindow.isDestroyed()) {
        // Small delay to allow normal dragend to fire first
        setTimeout(() => {
          if (ghostWindow && !ghostWindow.isDestroyed()) {
            console.log('[Global MouseUp Failsafe] Destroying ghost window');
            destroyGhostWindow();
          }
        }, 100);
      }
    };
    
    // Listen to all browser windows for mouseup events
    // Note: Electron doesn't have a global mouseup event, so we use a workaround
    // by checking window focus changes and monitoring ghost window state
    app.on('browser-window-focus', globalMouseUpListener as any);
  }
  
  // Setup failsafe when ghost window is created
  // This will be called from the ghost:create handler
  
  // Cleanup on app quit
  app.on('before-quit', () => {
    destroyGhostWindow();
    if (globalMouseUpListener) {
      app.removeListener('browser-window-focus', globalMouseUpListener as any);
      globalMouseUpListener = null;
    }
  });
  
  // Initialize Instagram service with app instance
  instagramService.setApp(app);
  
  // Instagram IPC handlers
  ipcMain.handle('instagram:connect', async (_event, userId: string) => {
    try {
      const result = await instagramService.connectInstagram(userId, shell);
      
      if (result.success && result.sessionData) {
        // Save session data to Firestore
        await firestoreService.saveInstagramSession(userId, result.sessionData);
        console.log('Instagram connection successful for user:', userId, 'username:', result.username);
      }
      
      return result;
    } catch (error: any) {
      console.error('Instagram connect error:', error);
      return { success: false, error: error.message || 'Failed to connect Instagram' };
    }
  });
  
  ipcMain.handle('instagram:disconnect', async (_event, userId: string) => {
    try {
      await firestoreService.deleteInstagramSession(userId);
      return { success: true };
    } catch (error: any) {
      console.error('Instagram disconnect error:', error);
      return { success: false, error: error.message || 'Failed to disconnect Instagram' };
    }
  });
  
  ipcMain.handle('instagram:getConnectionStatus', async (_event, userId: string) => {
    try {
      const session = await firestoreService.getInstagramSession(userId);
      if (session) {
        // Check if session is expired
        // Note: session.expiresAt is in seconds (from Electron Cookie.expirationDate)
        // Date.now() returns milliseconds, so we need to convert expiresAt to milliseconds
        const now = Date.now();
        const isExpired = session.expiresAt ? now > (session.expiresAt * 1000) : false;
        
        return {
          connected: true,
          username: session.instagramUsername,
          expired: isExpired,
        };
      }
      return { connected: false };
    } catch (error: any) {
      console.error('Instagram get connection status error:', error);
      return { connected: false, error: error.message };
    }
  });
  
  ipcMain.handle('instagram:getSessionCookies', async (_event, userId: string) => {
    try {
      const session = await firestoreService.getInstagramSession(userId);
      if (!session) {
        return null;
      }
      
      // Return encrypted cookies (will be decrypted when injected)
      return session.cookies;
    } catch (error: any) {
      console.error('Instagram get session cookies error:', error);
      return null;
    }
  });
  
  // Inject Instagram cookies into a session (for webview)
  // Note: Webviews without a partition attribute use the default session
  ipcMain.handle('instagram:injectCookiesIntoSession', async (event, userId: string, partition?: string) => {
    try {
      const instagramSession = await firestoreService.getInstagramSession(userId);
      if (!instagramSession) {
        return { success: false, error: 'No Instagram session found' };
      }
      
      // Get the session (default session for webviews without partition, or partition-based)
      // Webviews without partition use session.defaultSession
      const targetSession = partition 
        ? session.fromPartition(partition)
        : session.defaultSession;
      
      // Inject cookies using Instagram service
      await instagramService.injectInstagramCookies(targetSession, instagramSession.cookies);
      
      console.log('Successfully injected Instagram cookies into session');
      return { success: true };
    } catch (error: any) {
      console.error('Instagram inject cookies error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Set up auth state change listener: reload main window to login or dashboard
  authService.onAuthStateChanged((user) => {
    const userData = user ? {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
    } : null;

    // Route-based architecture: switch pages on auth change
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (userData) {
        isDashboard = true;
        mainWindow.loadFile(path.resolve(__dirname, '..', 'pages/dashboard/main.html'));
      } else {
        isDashboard = false;
        dockPinned = true;
        mainWindow.setPosition(0, 0);
        mainWindow.loadFile(path.resolve(__dirname, '..', 'pages/auth/login.html'));
      }
    }
  });
  
  // Start extension ping polling
  startExtensionPingPolling();

  // Install browser extensions on first launch
  // Check if extensions have been installed before
  const extensionInstalled = app.getPath('userData');
  const installedFlagPath = path.join(extensionInstalled, 'extensions-installed.flag');
  
  try {
    await require('fs/promises').access(installedFlagPath);
    // Flag exists, extensions already installed
  } catch {
    // First launch - install extensions
    console.log('First launch detected. Installing browser extensions...');
    await installExtensions();
    
    // Create flag file to indicate extensions have been installed
    try {
      await require('fs/promises').writeFile(installedFlagPath, 'installed', 'utf-8');
    } catch (err) {
      console.error('Failed to create installation flag:', err);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    } else {
      // Show main window if it's hidden
      if (!mainWindow?.isVisible()) {
        mainWindow?.show();
        mainWindow?.focus();
      }
    }
  });
  
  // REMOVED: Handle screen size changes for dock window
  // REASON: Dock is now integrated into main window, no separate window to manage
});

/**
 * Extracts source from URL (same logic as server)
 */
function extractSource(url: string): string {
  try {
    if (!url || url.trim().length === 0) {
      return 'local';
    }
    
    if (url.startsWith('data:')) {
      return 'local';
    }
    
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();
    
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    
    const parts = hostname.split('.');
    const subdomainPrefixes = ['blog', 'm', 'mobile', 'www', 'mail', 'drive', 'docs', 'maps'];
    
    if (parts.length > 2 && subdomainPrefixes.includes(parts[0])) {
      return parts.slice(1, -1).join('.');
    }
    
    if (parts.length >= 2) {
      return parts.slice(0, -1).join('.');
    }
    
    return hostname;
  } catch (error) {
    console.error('Failed to extract source from URL:', url, error);
    return 'unknown';
  }
}

/**
 * Determines type from URL (simplified version of server logic)
 */
function determineType(url: string): string {
  try {
    if (!url || url.trim().length === 0) {
      return 'webpage';
    }
    
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const searchParams = urlObj.searchParams;
    
    // Video patterns
    if (
      pathname.includes('/watch') ||
      pathname.includes('/video') ||
      pathname.includes('/v/') ||
      searchParams.has('v')
    ) {
      return 'video';
    }
    
    // Instagram Reels
    if (urlObj.hostname.includes('instagram.com') && pathname.startsWith('/reel/')) {
      return 'reels';
    }
    
    // Instagram Posts
    if (urlObj.hostname.includes('instagram.com') && pathname.startsWith('/p/')) {
      return 'instagram_post';
    }
    
    // Image patterns
    if (pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i)) {
      return 'image';
    }
    
    // Search patterns
    if (pathname.includes('/search') || searchParams.has('q') || searchParams.has('query')) {
      return 'search';
    }
    
    return 'webpage';
  } catch (error) {
    return 'webpage';
  }
}

/**
 * Extracts thumbnail URL from Instagram post URL by fetching HTML and extracting og:image meta tag
 */
async function extractInstagramThumbnail(url: string): Promise<string | null> {
  try {
    // Only process Instagram post URLs
    if (!url || !url.includes('instagram.com/p/')) {
      return null;
    }

    // Fetch the URL with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      // Get the final URL after redirects
      const finalUrl = response.url;

      // Check content type
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return null;
      }

      // Read HTML content
      const html = await response.text();

      // Extract og:image meta tag
      // Match: <meta property="og:image" content="value" />
      const ogImagePattern = /<meta[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/i;
      const match = html.match(ogImagePattern);
      
      if (match && match[1]) {
        const thumbnailUrl = match[1].trim();
        
        // Resolve relative URLs to absolute
        try {
          const absoluteUrl = new URL(thumbnailUrl, finalUrl).href;
          console.log('✅ Extracted Instagram thumbnail:', absoluteUrl);
          return absoluteUrl;
        } catch (urlError) {
          // Invalid URL, return as-is or null
          return thumbnailUrl || null;
        }
      }

      return null;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        console.log('Instagram thumbnail extraction timeout');
      } else {
        console.log('Instagram thumbnail extraction error:', fetchError.message);
      }
      return null;
    }
  } catch (error: any) {
    console.log('Instagram thumbnail extraction failed:', error.message);
    return null;
  }
}

/**
 * Handles saving data to Firestore for signed-in users
 */
async function handleFirestoreSave(payload: any): Promise<{ success: boolean; error?: string; documentId?: string }> {
  try {
    // Get current user
    const user = authService.getCurrentUser();
    
    if (!user) {
      return {
        success: false,
        error: 'User not signed in',
      };
    }
    
    // Extract domain and type (same logic as server)
    const domain = (payload.url && payload.url.trim().length > 0) 
      ? extractSource(payload.url) 
      : (payload.img_url ? 'local' : 'unknown');
    
    // Use type from payload if provided (extension sends correct type), otherwise determine it
    let type: string;
    if (payload.type) {
      // Extension already determined the type (e.g., 'instagram_post')
      type = payload.type;
    } else if (payload.img_url) {
      type = 'image';
    } else if (payload.url && payload.url.trim().length > 0) {
      type = determineType(payload.url);
    } else {
      type = 'image';
    }
    
    // Extract thumbnail for Instagram posts (only if not already provided by extension)
    let thumbnail: string | null = payload.thumbnail || null;
    if (!thumbnail && type === 'instagram_post' && payload.url && payload.url.trim().length > 0) {
      // Fallback: try to extract if extension didn't provide it
      thumbnail = await extractInstagramThumbnail(payload.url);
    }
    
    // Get current minimum order and assign new item one below it
    let newOrder = 0;
    try {
      const minOrder = await firestoreService.getMinItemOrder(user.uid);
      newOrder = minOrder - 1;
    } catch {
      newOrder = 0;
    }
    
    // Transform payload: timestamp -> createdAt, and prepare data for Firestore
    const firestoreData = {
      url: payload.url || '',
      title: payload.title,
      createdAt: payload.timestamp || payload.createdAt || Date.now(),
      domain,
      type,
      directoryId: 'undefined', // Default: items not in a directory
      order: newOrder,
      ...(payload.img_url && { img_url: payload.img_url }),
      ...(thumbnail && { thumbnail }),
      // Preserve existing saved_by behavior (used as a source marker: extension/global),
      // but always add production-ready attribution from BRAND.
      ...(payload.saved_by && { saved_by: payload.saved_by }),
      saved_by_app: BRAND.NAME,
      app_version: BRAND.VERSION,
      save_source: payload.saved_by || 'unknown',
    };
    
    // Save to Firestore
    const documentId = await firestoreService.saveData(user.uid, firestoreData);
    
    console.log(`${BRAND.LOG_PREFIX} ✅ Firestore: Data saved successfully with ID:`, documentId);
    return {
      success: true,
      documentId,
    };
  } catch (error: any) {
    console.error(`${BRAND.LOG_PREFIX} ❌ Firestore: Error saving data:`, error);
    return {
      success: false,
      error: error.message || 'Failed to save to Firestore',
    };
  }
}

/**
 * Starts a local HTTP server for Firestore save operations
 */
const startFirestoreSaveServer = () => {
  if (firestoreSaveServer) {
    return; // Already started
  }
  
  firestoreSaveServer = http.createServer(async (req, res) => {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.method === 'POST' && req.url === '/save-to-firestore') {
      let body = '';
      
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          
          // Handle the save to Firestore
          const result = await handleFirestoreSave(payload);
          
          if (result.success) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, documentId: result.documentId }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: result.error }));
          }
        } catch (error: any) {
          console.error('Failed to process Firestore save:', error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  firestoreSaveServer.listen(FIRESTORE_SAVE_PORT, 'localhost', () => {
    console.log(`Firestore save server listening on http://localhost:${FIRESTORE_SAVE_PORT}`);
  });
  
  firestoreSaveServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`Port ${FIRESTORE_SAVE_PORT} is already in use, Firestore save server not started`);
    } else {
      console.error('Firestore save server error:', error);
    }
  });
};

/**
 * Starts a local HTTP server to receive pending save notifications from extension
 */
const startPendingSaveServer = () => {
  if (pendingSaveServer) {
    return; // Already started
  }
  
  pendingSaveServer = http.createServer((req, res) => {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.method === 'POST' && req.url === '/pending-save') {
      let body = '';
      
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      
      req.on('end', () => {
        try {
          const pendingData = JSON.parse(body);
          
          // Send pending data to main window
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pending-save', pendingData);
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          console.error('Failed to process pending save:', error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  pendingSaveServer.listen(PENDING_SAVE_PORT, 'localhost', () => {
    console.log(`Pending save server listening on http://localhost:${PENDING_SAVE_PORT}`);
  });
  
  pendingSaveServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`Port ${PENDING_SAVE_PORT} is already in use, pending save server not started`);
    } else {
      console.error('Pending save server error:', error);
    }
  });
};

app.on('will-quit', () => {
  // REMOVED: Clear dockDefenseInterval - dock is now integrated into main window
  if (shortcutRegistered) {
    globalShortcut.unregister(SHORTCUT_ACCELERATOR);
  }
  if (resizeWindowsShortcutRegistered) {
    globalShortcut.unregister(RESIZE_WINDOWS_SHORTCUT);
  }
  globalShortcut.unregisterAll();
  
  // Close pending save server
  if (pendingSaveServer) {
    pendingSaveServer.close();
    pendingSaveServer = null;
  }
  
  // Stop OAuth callback server
  authService.stopOAuthServerOnExit();
  
  // Close Firestore save server
  if (firestoreSaveServer) {
    firestoreSaveServer.close();
    firestoreSaveServer = null;
  }
  
  // REMOVED: Close dock window on quit
  // REASON: Dock is now integrated into main window
});
} // End of single instance lock check

/**
 * IMPLEMENTATION NOTE: This implementation uses AppleScript to capture the active
 * browser tab URL on macOS. Supported browsers:
 * - Safari: Full support via AppleScript
 * - Arc: Full support via AppleScript (Chromium-based)
 * - Chrome/Google Chrome: Full support via AppleScript
 * - Microsoft Edge: Full support via AppleScript
 * - Firefox: Limited support (workaround using clipboard - may not be reliable)
 * 
 * For Windows/Linux, this would need different implementations:
 * - Windows: UI Automation APIs, COM interfaces, or PowerShell scripts
 * - Linux: Window manager APIs or accessibility tools
 * 
 * Browser extensions are an alternative cross-platform approach but require
 * per-browser packaging and user installation.
 */


```


### Full file: `client/src/lib/firestore.ts`

```typescript
/**
 * Firestore Utility Layer
 * 
 * Provides typed helpers for Firestore operations.
 * These functions are designed to be used in the Electron main process
 * and exposed to renderer via IPC for security.
 */

import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  QueryConstraint,
  CollectionReference,
  DocumentReference,
  DocumentData,
  Timestamp,
  Unsubscribe,
  QueryDocumentSnapshot,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase.js';
import { BRAND, logFirebase, errorFirebase } from './brandConfig.js';

/**
 * Data structure for saved URLs/items
 */
export interface SavedItemData extends DocumentData {
  id?: string; // Document ID (optional, added when fetching)
  url: string;
  title: string;
  createdAt: number;
  domain?: string;
  type?: string;
  img_url?: string;
  thumbnail?: string; // Thumbnail URL (for instagram_post and other types)
  saved_by?: string;
  /**
   * App attribution (brand/version), separated from `saved_by` (which is used as a source marker: extension/global).
   */
  saved_by_app?: string;
  app_version?: string;
  save_source?: string;
  userId: string; // User ID who owns this item
  directoryId?: string; // Directory ID (default: "undefined" for items not in a directory)
  order?: number; // Order index for sorting within a directory or main list
}

/**
 * Directory data structure
 */
export interface DirectoryData extends DocumentData {
  id?: string; // Document ID (optional, added when fetching)
  name: string;
  createdAt: number;
  userId: string; // User ID who owns this directory
  order?: number; // Order index for sorting within the directory list
}

/**
 * Get a document reference
 */
function getDocRef(collectionPath: string, documentId: string): DocumentReference {
  return doc(db, collectionPath, documentId);
}

/**
 * Get a collection reference
 */
function getCollectionRef(collectionPath: string): CollectionReference {
  return collection(db, collectionPath);
}

/**
 * Save new data to Firestore
 * 
 * @param userId - The user ID who owns this data
 * @param data - The data to save (userId will be added automatically)
 * @returns The document ID of the created document
 */
export async function saveData(
  userId: string,
  data: Omit<SavedItemData, 'userId' | 'id'>
): Promise<string> {
  try {
    // Create a document reference with auto-generated ID
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const newDocRef = doc(itemsRef);
    
    // Prepare data with userId and createdAt
    const itemData: SavedItemData = {
      ...data,
      userId,
      createdAt: data.createdAt || Date.now(),
      // Production-ready attribution (does not break existing saved_by logic).
      saved_by_app: (data as any).saved_by_app || BRAND.NAME,
      app_version: (data as any).app_version || BRAND.VERSION,
      save_source: (data as any).save_source || (data as any).saved_by || 'unknown',
    } as SavedItemData;
    
    // Set the document
    await setDoc(newDocRef, itemData);
    
    logFirebase('Firestore: Data added successfully with ID:', newDocRef.id);
    return newDocRef.id;
  } catch (error) {
    errorFirebase('Firestore: Error adding data:', error);
    throw error;
  }
}

/**
 * Update existing data in Firestore
 * 
 * @param dataId - The document ID to update
 * @param userId - The user ID who owns this data
 * @param data - Partial data to update
 */
export async function updateData(
  dataId: string,
  userId: string,
  data: Partial<Omit<SavedItemData, 'userId' | 'id'>>
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/items`, dataId);
    
    // Check if document exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Document with ID ${dataId} does not exist for user ${userId}`);
    }
    
    // Update the document
    await updateDoc(docRef, data);
    console.log('Firestore: Data updated successfully:', dataId);
  } catch (error) {
    console.error('Firestore: Error updating data:', error);
    throw error;
  }
}

/**
 * Delete data from Firestore
 * 
 * @param dataId - The document ID to delete
 * @param userId - The user ID who owns this data
 */
export async function deleteData(
  dataId: string,
  userId: string
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/items`, dataId);
    
    // Check if document exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Document with ID ${dataId} does not exist for user ${userId}`);
    }
    
    // Delete the document
    await deleteDoc(docRef);
    console.log('Firestore: Data deleted successfully:', dataId);
  } catch (error) {
    console.error('Firestore: Error deleting data:', error);
    throw error;
  }
}

/**
 * Delete all data items for a specific user
 * 
 * @param userId - The user ID who owns the data
 * @returns Number of items deleted
 */
export async function deleteAllData(userId: string): Promise<number> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const querySnapshot = await getDocs(itemsRef);
    
    const deletePromises: Promise<void>[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      deletePromises.push(deleteDoc(doc.ref));
    });
    
    await Promise.all(deletePromises);
    const deletedCount = deletePromises.length;
    console.log(`Firestore: Deleted ${deletedCount} items for user:`, userId);
    return deletedCount;
  } catch (error) {
    console.error('Firestore: Error deleting all data:', error);
    throw error;
  }
}

/**
 * Watch all data items for a specific user
 * Returns a real-time listener that calls the callback whenever data changes
 * 
 * @param userId - The user ID to watch data for
 * @param callback - Function called with array of items whenever data changes
 * @returns Unsubscribe function to stop listening
 */
export function watchDatasByUser(
  userId: string,
  callback: (items: SavedItemData[]) => void
): Unsubscribe {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    
    // Create a query ordered by createdAt (newest first)
    const q = query(itemsRef, orderBy('createdAt', 'desc'));
    
    // Set up real-time listener
    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const items: SavedItemData[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
          const data = doc.data() as SavedItemData;
          // Include document ID in the data
          items.push({
            ...data,
            id: doc.id,
          });
        });
        callback(items);
      },
      (error) => {
        console.error('Firestore: Error in watchDatasByUser:', error);
        // Call callback with empty array on error to prevent UI from breaking
        callback([]);
      }
    );
    
    console.log('Firestore: Started watching data for user:', userId);
    return unsubscribe;
  } catch (error) {
    console.error('Firestore: Error setting up watchDatasByUser:', error);
    // Return a no-op unsubscribe function if setup fails
    return () => {};
  }
}

/**
 * Gets the minimum order value among all items for a user.
 * Used to prepend a new item at the top without shifting existing items.
 * Returns 0 if no items exist.
 */
export async function getMinItemOrder(userId: string): Promise<number> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const q = query(itemsRef, orderBy('order', 'asc'), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return 0;
    const minOrder = snap.docs[0].data().order ?? 0;
    return typeof minOrder === 'number' ? minOrder : 0;
  } catch {
    return 0;
  }
}

/**
 * Get all data items for a specific user (one-time fetch)
 * 
 * @param userId - The user ID to fetch data for
 * @param limitCount - Optional limit on number of items to fetch
 * @returns Array of items
 */
export async function getDatasByUser(
  userId: string,
  limitCount?: number
): Promise<SavedItemData[]> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    
    // Build query constraints
    const constraints: QueryConstraint[] = [orderBy('createdAt', 'desc')];
    if (limitCount && limitCount > 0) {
      constraints.push(limit(limitCount));
    }
    
    const q = query(itemsRef, ...constraints);
    const querySnapshot = await getDocs(q);
    
    const items: SavedItemData[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      const data = doc.data() as SavedItemData;
      items.push({
        ...data,
        id: doc.id,
      });
    });
    
    console.log(`Firestore: Fetched ${items.length} items for user:`, userId);
    return items;
  } catch (error) {
    console.error('Firestore: Error getting data for user:', error);
    throw error;
  }
}

/**
 * Instagram Session Data structure
 */
export interface InstagramSessionData extends DocumentData {
  userId: string;
  instagramUsername: string;
  cookies: Array<{
    name: string;
    value: string; // Encrypted
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: 'strict' | 'lax' | 'no_restriction' | 'unspecified';
    expirationDate?: number;
  }>;
  oauthAccessToken?: string; // Optional, for verification
  oauthTokenExpiresAt?: number;
  connectedAt: number;
  expiresAt?: number; // Estimated cookie expiration
}

/**
 * Save Instagram session data to Firestore
 * 
 * @param userId - The user ID who owns this Instagram session
 * @param sessionData - The Instagram session data to save
 * @returns The document ID of the saved session
 */
export async function saveInstagramSession(
  userId: string,
  sessionData: Omit<InstagramSessionData, 'userId'>
): Promise<string> {
  try {
    // Use a fixed document ID to ensure only one session per user
    const sessionRef = doc(getCollectionRef(`users/${userId}/instagramSession`), 'session');
    
    // Build data object, excluding undefined values (Firestore doesn't allow undefined)
    const data: InstagramSessionData = {
      userId,
      instagramUsername: sessionData.instagramUsername,
      cookies: sessionData.cookies,
      connectedAt: sessionData.connectedAt,
    };
    
    // Only include optional fields if they have values
    if (sessionData.expiresAt !== undefined) {
      data.expiresAt = sessionData.expiresAt;
    }
    if (sessionData.oauthAccessToken !== undefined) {
      data.oauthAccessToken = sessionData.oauthAccessToken;
    }
    if (sessionData.oauthTokenExpiresAt !== undefined) {
      data.oauthTokenExpiresAt = sessionData.oauthTokenExpiresAt;
    }
    
    await setDoc(sessionRef, data, { merge: false }); // Use setDoc without merge to replace entirely
    console.log('Firestore: Instagram session saved successfully for user:', userId, 'username:', sessionData.instagramUsername);
    return 'session';
  } catch (error) {
    console.error('Firestore: Error saving Instagram session:', error);
    throw error;
  }
}

/**
 * Get Instagram session data for a user
 * 
 * @param userId - The user ID
 * @returns Instagram session data or null if not found
 */
export async function getInstagramSession(userId: string): Promise<InstagramSessionData | null> {
  try {
    // Use fixed document ID to get the session
    const sessionRef = doc(getCollectionRef(`users/${userId}/instagramSession`), 'session');
    const docSnap = await getDoc(sessionRef);
    
    if (!docSnap.exists()) {
      return null;
    }
    
    const data = docSnap.data() as InstagramSessionData;
    return {
      ...data,
      id: docSnap.id,
    };
  } catch (error) {
    console.error('Firestore: Error getting Instagram session:', error);
    throw error;
  }
}

/**
 * Delete Instagram session data for a user
 * 
 * @param userId - The user ID
 */
export async function deleteInstagramSession(userId: string): Promise<void> {
  try {
    // Use fixed document ID to delete the session
    const sessionRef = doc(getCollectionRef(`users/${userId}/instagramSession`), 'session');
    await deleteDoc(sessionRef);
    
    console.log('Firestore: Instagram session deleted successfully for user:', userId);
  } catch (error) {
    console.error('Firestore: Error deleting Instagram session:', error);
    throw error;
  }
}

/**
 * Directory data structure
 */
export interface DirectoryData extends DocumentData {
  id?: string; // Document ID (optional, added when fetching)
  name: string;
  createdAt: number;
  userId: string; // User ID who owns this directory
  order?: number; // Order index for sorting within the directory list
}

/**
 * Create a new directory
 * 
 * @param userId - The user ID who owns this directory
 * @param name - The directory name
 * @returns The document ID of the created directory
 */
export async function createDirectory(
  userId: string,
  name: string
): Promise<string> {
  try {
    const collectionPath = `users/${userId}/directories`;
    console.log('[Directory Debug] Firestore: Creating directory at path:', collectionPath);
    console.log('[Directory Debug] Firestore: User ID being used:', userId);
    
    const directoriesRef = getCollectionRef(collectionPath);
    const newDocRef = doc(directoriesRef);
    
    const directoryData: DirectoryData = {
      name: name.trim(),
      createdAt: Date.now(),
      userId,
    };
    
    console.log('[Directory Debug] Firestore: Directory data payload:', directoryData);
    console.log('[Directory Debug] Firestore: Full document path will be:', `users/${userId}/directories/${newDocRef.id}`);
    
    await setDoc(newDocRef, directoryData);
    console.log('[Directory] Created:', name, 'with ID:', newDocRef.id);
    console.log('Firestore: Directory created successfully with ID:', newDocRef.id);
    return newDocRef.id;
  } catch (error: any) {
    console.error('Firestore: Error creating directory:', error);
    console.error('Firestore: Error code:', error.code);
    console.error('Firestore: Error message:', error.message);
    if (error.code === 'permission-denied' || error.code === 7) {
      console.error('[Directory Debug] PERMISSION_DENIED - Check Firestore Security Rules for: users/{userId}/directories');
      console.error('[Directory Debug] Ensure the authenticated user UID matches the userId in the path');
    }
    throw error;
  }
}

/**
 * Get all directories for a user
 * 
 * @param userId - The user ID
 * @returns Array of directories
 */
export async function getDirectoriesByUser(userId: string): Promise<DirectoryData[]> {
  try {
    const directoriesRef = getCollectionRef(`users/${userId}/directories`);
    const q = query(directoriesRef, orderBy('createdAt', 'asc'));
    const querySnapshot = await getDocs(q);
    
    const directories: DirectoryData[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      const data = doc.data() as DirectoryData;
      directories.push({
        ...data,
        id: doc.id,
      });
    });
    
    console.log(`Firestore: Fetched ${directories.length} directories for user:`, userId);
    return directories;
  } catch (error) {
    console.error('Firestore: Error getting directories for user:', error);
    throw error;
  }
}

/**
 * Watch directories for a user (real-time listener)
 * 
 * @param userId - The user ID
 * @param callback - Function called with array of directories whenever data changes
 * @returns Unsubscribe function to stop listening
 */
export function watchDirectoriesByUser(
  userId: string,
  callback: (directories: DirectoryData[]) => void
): Unsubscribe {
  try {
    const directoriesRef = getCollectionRef(`users/${userId}/directories`);
    const q = query(directoriesRef, orderBy('createdAt', 'asc'));
    
    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const directories: DirectoryData[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
          const data = doc.data() as DirectoryData;
          directories.push({
            ...data,
            id: doc.id,
          });
        });
        callback(directories);
      },
      (error) => {
        console.error('Firestore: Error in watchDirectoriesByUser:', error);
        callback([]);
      }
    );
    
    console.log('Firestore: Started watching directories for user:', userId);
    return unsubscribe;
  } catch (error) {
    console.error('Firestore: Error setting up watchDirectoriesByUser:', error);
    return () => {};
  }
}

/**
 * Update directory name
 * 
 * @param directoryId - The directory document ID
 * @param userId - The user ID who owns this directory
 * @param name - The new directory name
 */
export async function updateDirectory(
  directoryId: string,
  userId: string,
  name: string
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/directories`, directoryId);
    
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Directory with ID ${directoryId} does not exist for user ${userId}`);
    }
    
    await updateDoc(docRef, { name: name.trim() });
    console.log('Firestore: Directory updated successfully:', directoryId);
  } catch (error) {
    console.error('Firestore: Error updating directory:', error);
    throw error;
  }
}

/**
 * Delete a directory and update all associated items to have directoryId = "undefined"
 * 
 * @param directoryId - The directory document ID to delete
 * @param userId - The user ID who owns this directory
 */
export async function deleteDirectory(
  directoryId: string,
  userId: string
): Promise<void> {
  try {
    // First, update all items in this directory to have directoryId = "undefined"
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const q = query(itemsRef, where('directoryId', '==', directoryId));
    const querySnapshot = await getDocs(q);
    
    const updatePromises: Promise<void>[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      const itemRef = doc.ref;
      updatePromises.push(updateDoc(itemRef, { directoryId: 'undefined' }));
    });
    
    await Promise.all(updatePromises);
    console.log(`Firestore: Updated ${updatePromises.length} items to remove directory reference`);
    
    // Then delete the directory document
    const directoryRef = getDocRef(`users/${userId}/directories`, directoryId);
    await deleteDoc(directoryRef);
    
    console.log('Firestore: Directory deleted successfully:', directoryId);
  } catch (error) {
    console.error('Firestore: Error deleting directory:', error);
    throw error;
  }
}

/**
 * Update an item's directoryId
 * 
 * @param itemId - The item document ID
 * @param userId - The user ID who owns this item
 * @param directoryId - The directory ID (or "undefined" to remove from directory)
 */
export async function updateItemDirectory(
  itemId: string,
  userId: string,
  directoryId: string
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/items`, itemId);
    
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Item with ID ${itemId} does not exist for user ${userId}`);
    }
    
    await updateDoc(docRef, { directoryId });
    console.log(`Firestore: Item ${itemId} moved to directory ${directoryId}`);
  } catch (error) {
    console.error('Firestore: Error updating item directory:', error);
    throw error;
  }
}

/**
 * Move an item to a new position within a directory or main list
 * Uses batched writes to ensure atomicity when reordering multiple items
 * 
 * @param userId - The user ID who owns the items
 * @param itemId - The item document ID to move
 * @param targetDirectoryId - The target directory ID (or null for main list)
 * @param newIndex - The new index position (0-based)
 * @param sourceDirectoryId - The source directory ID (or null for main list)
 * @returns Promise that resolves when the move is complete
 */
export async function moveItemToPosition(
  userId: string,
  itemId: string,
  targetDirectoryId: string | null,
  newIndex: number,
  sourceDirectoryId: string | null
): Promise<void> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    
    // Determine the directory filter (null = main list, "undefined" = main list in Firestore)
    const targetDirFilter = targetDirectoryId === null ? 'undefined' : targetDirectoryId;
    const sourceDirFilter = sourceDirectoryId === null ? 'undefined' : sourceDirectoryId;
    
    // Get all items in the target directory/list
    // Try to query with order field first, fallback to createdAt if order doesn't exist
    let targetItems: QueryDocumentSnapshot[];
    let usingOrderField = true;
    try {
      // First, try with order field
      const targetQuery = query(
        itemsRef,
        where('directoryId', '==', targetDirFilter),
        orderBy('order', 'asc')
      );
      const targetSnapshot = await getDocs(targetQuery);
      targetItems = targetSnapshot.docs;
    } catch (error: any) {
      // If orderBy fails (no index or field doesn't exist), fallback to createdAt
      if (error.code === 'failed-precondition' || error.code === 'invalid-argument') {
        usingOrderField = false;
        const fallbackQuery = query(
          itemsRef,
          where('directoryId', '==', targetDirFilter),
          orderBy('createdAt', 'desc')
        );
        const fallbackSnapshot = await getDocs(fallbackQuery);
        targetItems = fallbackSnapshot.docs;
      } else {
        throw error;
      }
    }
    
    // Get the dragged item
    const draggedItemRef = getDocRef(`users/${userId}/items`, itemId);
    const draggedItemDoc = await getDoc(draggedItemRef);
    
    if (!draggedItemDoc.exists()) {
      throw new Error(`Item with ID ${itemId} does not exist for user ${userId}`);
    }
    
    const draggedItemData = draggedItemDoc.data();
    
    // Log old orders for debugging
    const oldOrders = targetItems.map(doc => {
      const data = doc.data();
      return { id: doc.id, order: data.order ?? 'missing', createdAt: data.createdAt };
    });
    console.log(`[DnD] Moving item ${itemId} to index ${newIndex}`);
    console.log(`[DnD] Old orders:`, oldOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Build a new array with the dragged item inserted at the correct position
    const isSameContainer = sourceDirFilter === targetDirFilter;
    let finalItems: Array<{ id: string; ref: DocumentReference; data: any }> = [];
    
    if (isSameContainer) {
      // Moving within the same container
      // Create array without the dragged item
      const itemsWithoutDragged = targetItems
        .filter(doc => doc.id !== itemId)
        .map(doc => ({
          id: doc.id,
          ref: doc.ref,
          data: doc.data()
        }));
      
      // Insert dragged item at newIndex
      finalItems = [
        ...itemsWithoutDragged.slice(0, newIndex),
        {
          id: itemId,
          ref: draggedItemRef,
          data: draggedItemData
        },
        ...itemsWithoutDragged.slice(newIndex)
      ];
    } else {
      // Moving between containers
      // Target items don't include the dragged item
      const targetItemsArray = targetItems.map(doc => ({
        id: doc.id,
        ref: doc.ref,
        data: doc.data()
      }));
      
      // Insert dragged item at newIndex
      finalItems = [
        ...targetItemsArray.slice(0, newIndex),
        {
          id: itemId,
          ref: draggedItemRef,
          data: draggedItemData
        },
        ...targetItemsArray.slice(newIndex)
      ];
    }
    
    // Re-assign incremental order values (0, 1, 2, 3...) to the entire array
    // This guarantees no duplicate or skipped order values
    const newOrders = finalItems.map((item, index) => ({
      id: item.id,
      ref: item.ref,
      order: index
    }));
    
    // Log new orders for debugging
    console.log(`[DnD] New orders:`, newOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Create batch for atomic updates
    const batch = writeBatch(db);
    
    // Update directoryId if moving between containers
    if (sourceDirFilter !== targetDirFilter) {
      batch.update(draggedItemRef, { directoryId: targetDirFilter });
    }
    
    // Update all items with their new order values
    newOrders.forEach(({ ref, order }) => {
      batch.update(ref, { order });
    });
    
    // Commit the batch
    await batch.commit();
    
    console.log(`[DnD] ✅ Successfully moved item ${itemId} to position ${newIndex} in ${targetDirFilter === 'undefined' ? 'main list' : `directory ${targetDirFilter}`}`);
  } catch (error) {
    console.error('[DnD] ❌ Error moving item to position:', error);
    throw error;
  }
}

/**
 * Move a directory to a new position within the directory list
 * Uses batched writes to ensure atomicity when reordering multiple directories
 * 
 * @param userId - The user ID who owns the directories
 * @param directoryId - The directory document ID to move
 * @param newIndex - The new index position (0-based)
 * @returns Promise that resolves when the move is complete
 */
export async function moveDirectoryToPosition(
  userId: string,
  directoryId: string,
  newIndex: number
): Promise<void> {
  try {
    const directoriesRef = getCollectionRef(`users/${userId}/directories`);
    
    // Get all directories ordered by order field (or createdAt if order doesn't exist)
    let directories: QueryDocumentSnapshot[];
    try {
      const directoriesQuery = query(
        directoriesRef,
        orderBy('order', 'asc')
      );
      const directoriesSnapshot = await getDocs(directoriesQuery);
      directories = directoriesSnapshot.docs;
    } catch (error: any) {
      // If orderBy fails (no index or field doesn't exist), fallback to createdAt
      if (error.code === 'failed-precondition' || error.code === 'invalid-argument') {
        const fallbackQuery = query(
          directoriesRef,
          orderBy('createdAt', 'asc')
        );
        const fallbackSnapshot = await getDocs(fallbackQuery);
        directories = fallbackSnapshot.docs;
      } else {
        throw error;
      }
    }
    
    // Get the dragged directory
    const draggedDirectoryRef = getDocRef(`users/${userId}/directories`, directoryId);
    const draggedDirectoryDoc = await getDoc(draggedDirectoryRef);
    
    if (!draggedDirectoryDoc.exists()) {
      throw new Error(`Directory with ID ${directoryId} does not exist for user ${userId}`);
    }
    
    const draggedDirectoryData = draggedDirectoryDoc.data();
    
    // Log old orders for debugging
    const oldOrders = directories.map(doc => {
      const data = doc.data();
      return { id: doc.id, order: data.order ?? 'missing', createdAt: data.createdAt };
    });
    console.log(`[DnD] Moving directory ${directoryId} to index ${newIndex}`);
    console.log(`[DnD] Old orders:`, oldOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Build a new array with the dragged directory inserted at the correct position
    // Create array without the dragged directory
    const directoriesWithoutDragged = directories
      .filter(doc => doc.id !== directoryId)
      .map(doc => ({
        id: doc.id,
        ref: doc.ref,
        data: doc.data()
      }));
    
    // Insert dragged directory at newIndex
    const finalDirectories = [
      ...directoriesWithoutDragged.slice(0, newIndex),
      {
        id: directoryId,
        ref: draggedDirectoryRef,
        data: draggedDirectoryData
      },
      ...directoriesWithoutDragged.slice(newIndex)
    ];
    
    // Re-assign incremental order values (0, 1, 2, 3...) to the entire array
    // This guarantees no duplicate or skipped order values
    const newOrders = finalDirectories.map((dir, index) => ({
      id: dir.id,
      ref: dir.ref,
      order: index
    }));
    
    // Log new orders for debugging
    console.log(`[DnD] New orders:`, newOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Create batch for atomic updates
    const batch = writeBatch(db);
    
    // Update all directories with their new order values
    newOrders.forEach(({ ref, order }) => {
      batch.update(ref, { order });
    });
    
    // Commit the batch
    await batch.commit();
    
    console.log(`[DnD] ✅ Successfully moved directory ${directoryId} to position ${newIndex}`);
  } catch (error) {
    console.error('[DnD] ❌ Error moving directory to position:', error);
    throw error;
  }
}


```
