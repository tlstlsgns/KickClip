# Blink — Project Briefing (2026-04-09)

Onboarding document for AI assistants. Canonical paths are relative to the repository root unless noted.

---

## 1. Project Overview

### What Blink is
**Blink** is a productivity tool for **capturing URLs, page screenshots, and structured “CoreItem” regions** (e.g. social posts) from the browser, persisting them to **Firebase Firestore**, and surfacing them in a **Chrome extension side panel** and an **Electron** desktop shell. A local **Node/Express** server assists with saves, metadata, image proxying, optional AI analysis, and integration with the Electron app.

### Tech stack
| Area | Stack |
|------|--------|
| **Extension (Chromium)** | Manifest V3, vanilla JS modules (`coreEntry.js`, `itemDetector.js`, `uiManager.js`, …), Firebase JS SDK (side panel), `chrome.*` APIs |
| **Server** | Node.js, **Express 4**, TypeScript (ESM), **Firebase Admin**, **Puppeteer** (crawls / mail), **node-fetch**, **cheerio** (where used) |
| **Electron client** | Electron 31.x, TypeScript → `dist/`, **Firebase v9 modular** in main/renderer, IPC + preload |
| **Backend SaaS** | **Firebase** (Auth, Firestore, Storage) — project id **`saveurl-a8593`** (see extension `FIREBASE_CONFIG` / console) |
| **AI** | **Google Gemini** `gemini-2.5-flash` via Generative Language API; API key `GEMINI_API_KEY` |

### Architecture (high level)
```
Browser page ──content script──► coreEntry.js (+ itemDetector, uiManager, …)
       │                              │
       │                              ├──► localhost:3000 (Express) save-url, proxy, etc.
       │                              ├──► chrome.runtime (background.js): capture, side panel, optimistic msgs
       │                              └──► Firestore (extension side panel direct), or via Electron forward

Electron main ◄──IPC──► Renderer (dashboard) + preload bridge
       │
       ├──► HTTP :3002 firestore save / forward path (paired with server save-url)
       └──► Firestore Admin / client patterns per feature
```

---

## 2. Project Structure

High-level layout (2–3 levels; `node_modules` omitted).

```
AppTest/
├── browser-extension/
│   ├── chromium/              # Primary MV3 target
│   │   ├── manifest.json
│   │   ├── background.js      # Service worker
│   │   ├── content-loader.js  # Injects core stack
│   │   ├── coreEntry.js       # Page context: hover, Cmd+Shift+S, save pipeline
│   │   ├── coreEngine.js      # Re-exports / glue
│   │   ├── itemDetector.js    # ItemMap / CoreItem detection (Types A/B/C)
│   │   ├── uiManager.js       # Overlays, highlights, tooltips
│   │   ├── dataExtractor.js, urlResolver.js, stateLite.js, brandConfig.js
│   │   ├── sidepanel.html/js  # Dock UI + Firestore listeners
│   │   └── firebase-bundle.js # Bundled Firebase for side panel
│   ├── firefox/, safari/      # Other targets (variants)
│   └── …
├── client/                    # Electron desktop app
│   ├── src/
│   │   ├── main.ts            # Main process entry
│   │   ├── preload/
│   │   └── lib/               # firestore.ts, auth, instagram, storage, firebase.js
│   ├── pages/                 # login.html, dashboard, viewer
│   └── package.json
├── server/
│   ├── src/server.ts          # Express app (MAIN server source)
│   ├── package.json
│   └── .env.example
└── docs/                      # Briefings, internal docs
```

**Note:** There is **no** `browser-extension/manifest.json` at repo root; the Chromium manifest is **`browser-extension/chromium/manifest.json`**. Section 6 embeds that file under the name requested (`manifest.json`) with path clarified in the heading.

---

## 3. Component Breakdown

### 3.1 Server (`server/src/server.ts`)

| | |
|---|---|
| **Port** | **3000** (`PORT = 3000`) |
| **Framework** | Express |

**API endpoints**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/firestore/move-item` | Reorder / move item between directories (`userId`, `itemId`, indices, directory ids) |
| POST | `/api/v1/firestore/move-directory` | Reorder directories (`userId`, `directoryId`, `newIndex`) |
| POST | `/api/v1/save-url` | Main save: forwards to Electron Firestore save when possible; fallback direct Firestore + metadata; optional screenshot upload |
| DELETE | `/api/v1/items/:itemId` | Delete item (`userId` query/body as implemented) |
| GET | `/api/v1/saved-urls` | List / sync saved URLs (legacy/helper) |
| POST | `/api/v1/extension/ping` | Extension liveness |
| GET | `/api/v1/image-proxy` | Proxy remote images (CORS) |
| GET | `/api/v1/extension/status` | Extension connection status |
| GET | `/api/v1/dock/width` | Dock width hint |
| GET | `/api/v1/logo/:domain` | Favicon/logo for Mail cards etc. |
| POST | `/api/v1/analyze-page` | One-off page analysis via crawl + Gemini (simpler schema than full `analyzeAndUpdateDocument`) |

**Key functions (representative)**
- `forwardToElectronApp` — tries localhost Firestore forwarder for saves.
- `uploadScreenshotToStorage` — uploads base64 screenshot to GCS bucket; returns `{ publicUrl }`.
- `analyzeAndUpdateDocument` — Puppeteer/crawl + **Gemini function calling** → writes `ai_*` fields on item doc. **Currently disabled at call sites** after `save-url` (commented); implementation remains for re-enable.
- `crawlPageContent` / Gmail / Naver mail helpers — feed AI or Mail saves.

**Environment variables**
- `GEMINI_API_KEY` — Gemini
- `GOOGLE_APPLICATION_CREDENTIALS` — Firebase Admin JSON path
- `FIREBASE_STORAGE_BUCKET` — Storage bucket name

---

### 3.2 Chrome Extension (`browser-extension/chromium/`)

**Manifest (summary)**
- **Permissions:** `activeTab`, `storage`, `scripting`, `tabs`, `contextMenus`, `windows`, `sidePanel`, `identity`, `cookies`
- **Host permissions:** `localhost:3000`, `localhost:3001`, Instagram, Gmail, Google APIs, Naver mail domains, etc.
- **Content scripts:** `html2canvas.bundle.js`, `content-loader.js` on `<all_urls>`, `all_frames: true`, `document_start`
- **Background:** MV3 service worker `background.js`
- **Commands:** `save-url` → **Cmd+Shift+S** (mac) / Ctrl+Shift+S
- **Side panel:** `sidepanel.html`
- **OAuth2 client id** for Google (Gmail readonly + profile)

**Key files**
| File | Role |
|------|------|
| `background.js` | `capture-visible-tab`, context menus, message hub, optimistic routing, port bridges |
| `coreEntry.js` | In-page: ItemMap scanning, CoreItem selection, **`htmlContext`** / metadata extraction, Cmd+Shift+S handlers, `save-url` POST payload, optimistic `optimistic-card` messages |
| `sidepanel.js` | Firebase auth, Firestore listeners, **category-section** dock lists, DnD, card DOM, collapse state (`blink_category_collapsed`) |
| `sidepanel.html` | Shell + styles for side panel, `#sp-itemlist-wrap` category sections |
| `uiManager.js` | Highlight layers, full-page overlay, `showFullPageHighlight` / `hideFullPageHighlight`, metadata tooltip positioning |
| `itemDetector.js` | `detectItemMaps`, evidence types (anchor / interaction / Type C mail), `isMeaningfulItemMap`, share / nav guards |
| `content-loader.js` | Dynamically loads the web-accessible module graph into isolated world |

---

### 3.3 Electron App (`client/`)

| | |
|---|---|
| **Entry** | `client/src/main.ts` (compiled to `dist/main.js`) |
| **Main process** | Window management (sidebar scratch / dashboard), **HTTP servers** on **3001** (pending save) and **3002** (Firestore save forward), tray/shortcuts, **IPC** to renderer, extension installer hooks |

**IPC (representative `ipcMain.handle` / `on`)**
- Auth: `auth:signInWithGoogle`, `auth:signOut`, `auth:getCurrentUser`
- Firestore: `firestore:getDatasByUser`, `firestore:watchDatasByUser`, `firestore:deleteData`, directories CRUD, `firestore:moveItemToPosition`, `firestore/moveDirectoryToPosition`, unwatch helpers
- Dock: `dock:getPinned`, `dock:setPinned`, `dock:show`, `dock:hide`
- Shell: `shell:openExternal`
- Window: resize, ignore mouse events, always-on-top toggles
- Ghost preview: `ghost:create`, `ghost:update-position`, `ghost:destroy`
- Instagram: connect/disconnect/session cookies

**Dashboard UI** (renderer): under `client/pages/` — `dashboard/main.html` loads after auth; integrates with preload-exposed APIs.

---

### 3.4 Firebase / Firestore

| | |
|---|---|
| **Project ID** | `saveurl-a8593` (matches extension config in `sidepanel.js` / `coreEntry` patterns) |
| **Auth** | Google OAuth (extension: `chrome.identity` + Firebase credential; Electron: `auth.service`) |

**Schema (conceptual)**

- **`users/{userId}/items/{itemId}`**  
  Fields include at least: `url`, `title`, `createdAt`, `domain`, `type`, `img_url`, `directoryId`, `order`, `category`, `platform`, `confirmed_type`, `sender` (Mail), `screenshot_bg_color`, `screenshot_padding`, optional `ai_*` from Gemini (`ai_title`, `ai_key_points`, `ai_keywords`, `ai_content_type`, …), Gmail/Naver metadata when saved as Mail.

- **`users/{userId}/directories/{dirId}`**  
  `name`, `createdAt`, `userId`, `order`

- **Storage**  
  Screenshots under `screenshots/{userId}/{itemId}.jpg|png`

---

## 4. Key Data Flows

### 4.1 Save: Cmd+Shift+S → **CoreItem** save (with `htmlContext`)

1. User presses **Cmd+Shift+S** → `commands.onCommand` in `background.js` may message tab / trigger content path (or coreEntry keyboard path).
2. `coreEntry.js` resolves active **CoreItem** container (ItemMap evidence Type A/B/C), builds metadata (URL, title, platform, category, **`htmlContext`** snippet as implemented), optional screenshot base64 / padding / bg color.
3. `fetch('http://localhost:3000/api/v1/save-url', { method: 'POST', body: JSON.stringify(payload) })`.
4. Server **`save-url`**: forwards to **Electron** when success → Firestore doc created in user collection; async **screenshot upload** may patch `img_url` / `screenshot_bg_color`.
5. Extension **side panel** listener receives Firestore snapshot → merges with optimistic card if URL matched.
6. **AI path:** `analyzeAndUpdateDocument` would enqueue Gemini crawl + patch `ai_*` fields — **call sites currently commented** on save success.

### 4.2 Save: Cmd+Shift+S → **Page** save (no CoreItem)

1. When no CoreItem, flow uses **page** capture path: `capturePageScreenshotBase64()` (hide Blink overlays, `capture-visible-tab`, sample corners for bg).
2. Payload includes `category: Page` (or equivalent), screenshot fields; same **`save-url`** endpoint and Electron/Firestore mirroring.

### 4.3 Optimistic UI (`coreEntry` → background → sidepanel)

1. `coreEntry.js` calls `chrome.runtime.sendMessage({ action: 'optimistic-card', tempId, url, title, imgUrl, … })` (after recent changes: no `screenshotWide`; category drives card width via `pageCard` / Page rules in `sidepanel.js`).
2. `background.js` may relay to side panel if needed, or side panel listens directly (listener in `sidepanel.js`).
3. `addOptimisticCard()` inserts a temporary card into **`getCategoryList(category)`** container, animates, tracks `optimisticCards` map; on Firestore confirm, DOM promoted or replaced.

### 4.4 AI analysis (server → Gemini → Firestore → side panel)

**Designed path**
1. After save, server runs **`analyzeAndUpdateDocument(docPath, url, userLanguage, gmailToken?, naverCookies?)`** (fire-and-forget).
2. Crawls page (Puppeteer / fetches), builds rich **function-calling** schema (`analyze_page_content` with taxonomy fields).
3. Gemini returns structured args → server **`update`s** Firestore doc with `ai_*` fields.
4. Side panel **Firestore listener** updates cards / AI board (AI board may be partially disabled in UI).

**Current state (Apr 2026)**  
Post-save **`analyzeAndUpdateDocument` invocations are commented out** in `server.ts` for both Electron-forward and direct-save paths.  
**`/api/v1/analyze-page`** remains available for explicit analysis requests (lighter schema).

---

## 5. AI System

| | |
|---|---|
| **Provider** | Google Generative Language API |
| Full save pipeline model | **`gemini-2.5-flash`** (`generateContent`) |
| **Auth** | `GEMINI_API_KEY` as query param `?key=` |

**Paths**
1. **Embedded in `analyzeAndUpdateDocument` (save pipeline)**  
   Crawl → prompt includes URL, title, truncated text → tool `analyze_page_content` with fields like `title`, `key_points`, `keywords`, `content_type`, `content_resource`, `subject_type`, `content_category`, `content_topic`, etc.  
   Writes **Firestore** fields such as `ai_title`, `ai_key_points`, `ai_keywords`, `ai_content_type`, `ai_content_resource`, `ai_subject_type`, `ai_content_category`, `ai_content_topic`, etc. (see `server.ts` batch update near analysis success).

2. **`POST /api/v1/analyze-page`**  
   Lighter crawler + tool with **`title`, `key_points`, `keywords`, `content_type`** only; returns JSON to client (does not by itself persist to Firestore unless extended).

**`userLanguage`**  
Passed on save body as `userLanguage`; mapped to output language label (e.g. Korean → `Korean`) for Gemini instructions in both `analyze-page` and `analyzeAndUpdateDocument` style prompts.

---

## 6. Current File State

Full file contents as of generation time are appended below.

**Manifest note:** Onboarding text may reference `browser-extension/manifest.json`; in this repo the file is **`browser-extension/chromium/manifest.json`** (embedded below under that path).

### `server/src/server.ts`

```typescript
import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';

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
  screenshot_base64?: string;
  screenshot_bg_color?: string;
  category?: string;
  confirmed_type?: string;
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

app.use(express.json({ limit: '4mb' }));

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

type ItemCategory = 'SNS' | 'Mail' | 'Image' | 'Video' | 'Page';

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
): { category: ItemCategory; platform: string; confirmedType: string } {
  try {
    const u = new URL(savedUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // ── Helper: dominant media type ───────────────────────────────────────────
    function getDominantMediaType(): 'Video' | 'Image' | '' {
      if (!htmlContext) return '';
      try {
        const coreWidth  = Number(htmlContext?.boundingBox?.width)  || 0;
        const coreHeight = Number(htmlContext?.boundingBox?.height) || 0;
        if (coreWidth <= 0 || coreHeight <= 0) return '';
        const mediaItems = [
          ...(Array.isArray(htmlContext.images) ? htmlContext.images : []),
          ...(Array.isArray(htmlContext.videos) ? htmlContext.videos : []),
        ];
        for (const media of mediaItems) {
          const mw = Number(media?.width)  || 0;
          const mh = Number(media?.height) || 0;
          if (mw <= 0 || mh <= 0) continue;
          const widthRatio  = mw / coreWidth;
          const heightRatio = mh / coreHeight;
          if (
            (widthRatio >= 0.75 && heightRatio >= 0.4) ||
            (heightRatio >= 0.75 && widthRatio >= 0.4)
          ) {
            const isDominantVideo = Array.isArray(htmlContext.videos) &&
              htmlContext.videos.some((v: any) => {
                const vw = Number(v?.width)  || 0;
                const vh = Number(v?.height) || 0;
                const wr = vw / coreWidth;
                const hr = vh / coreHeight;
                return (wr >= 0.75 && hr >= 0.4) || (hr >= 0.75 && wr >= 0.4);
              });
            return isDominantVideo ? 'Video' : 'Image';
          }
        }
      } catch { /* ignore */ }
      return '';
    }

    function getPageDomain(): string {
      return pageUrl ? getBaseDomainForCategory(pageUrl) : '';
    }

    // ── Step 1: SNS ───────────────────────────────────────────────────────────
    let snsPlatform = '';
    if (host.includes('instagram.com')) {
      snsPlatform = 'Instagram';
    } else if (host.includes('x.com') || host.includes('twitter.com')) {
      snsPlatform = 'X';
    } else if (host.includes('threads.net')) {
      snsPlatform = 'Threads';
    } else if (
      host.includes('linkedin.com') &&
      (path.startsWith('/posts/') || path.includes('/feed/update/') || path.startsWith('/in/'))
    ) {
      snsPlatform = 'LinkedIn';
    } else if (host.includes('facebook.com') && !!htmlContext) {
      snsPlatform = 'Facebook';
    } else if (host.includes('tiktok.com')) {
      snsPlatform = 'TikTok';
    } else if (host.includes('reddit.com') && (path.includes('/r/') || path.includes('/user/'))) {
      snsPlatform = 'Reddit';
    }

    if (snsPlatform) {
      const dominantType = getDominantMediaType();
      return {
        category: 'SNS',
        platform: snsPlatform,
        confirmedType: dominantType || 'Post',
      };
    }

    // ── Step 2: Mail ──────────────────────────────────────────────────────────
    const savedHostParts = host.split('.');
    if (savedHostParts[0] === 'mail') {
      const baseDomain = getBaseDomainForCategory(savedUrl);
      const mailPlatform =
        baseDomain === 'google.com' ? 'Gmail' :
        baseDomain === 'naver.com'  ? 'Naver' :
        'Other';
      return { category: 'Mail', platform: mailPlatform, confirmedType: '' };
    }

    // ── Step 2.5: Unconditional Video hosts ───────────────────────────────────
    if (
      (host.includes('youtube.com') && path.includes('/watch')) ||
      host.includes('youtu.be') ||
      host.includes('vimeo.com') ||
      host.includes('twitch.tv')
    ) {
      return { category: 'Video', platform: getBaseDomainForCategory(savedUrl), confirmedType: '' };
    }

    // ── Step 3: Dominant media check (non-SNS) ────────────────────────────────
    const dominantType = getDominantMediaType();
    if (dominantType) {
      if (dominantType === 'Video') {
        return { category: 'Video', platform: getBaseDomainForCategory(savedUrl), confirmedType: '' };
      }
      return { category: 'Image', platform: getPageDomain(), confirmedType: '' };
    }

    // ── Step 4: Same-origin URL-based ─────────────────────────────────────────
    const savedDomain = getBaseDomainForCategory(savedUrl);
    const pageDomain  = pageUrl ? getBaseDomainForCategory(pageUrl) : '';
    const sameOrigin  = !!savedDomain && !!pageDomain && savedDomain === pageDomain;

    if (sameOrigin) {
      if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(path))
        return { category: 'Image', platform: getPageDomain(), confirmedType: '' };
      if (/\.(mp4|webm)$/i.test(path))
        return { category: 'Video', platform: savedDomain, confirmedType: '' };
      if (
        (host.includes('youtube.com') && path.includes('/watch')) ||
        host.includes('youtu.be') ||
        host.includes('vimeo.com') ||
        host.includes('twitch.tv')
      ) return { category: 'Video', platform: savedDomain, confirmedType: '' };
    }

    // ── Step 5: Weighted scoring ──────────────────────────────────────────────
    let score = 0;
    const mediaRatio = Number(htmlContext?.mediaRatio) || 0;
    if (mediaRatio > 0.7) score += 70;
    else if (mediaRatio > 0.5) score += 40;
    const videoCount = Number(htmlContext?.videoCount) || 0;
    if (videoCount > 0) score += 50;
    const imageCount = Number(htmlContext?.imageCount) || 0;
    if (imageCount + videoCount === 1) score += 30;
    if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm)$/i.test(path)) score += 20;
    if (
      (host.includes('youtube.com') && path.includes('/watch')) ||
      host.includes('youtu.be') ||
      host.includes('vimeo.com') ||
      host.includes('twitch.tv')
    ) score += 20;
    if (imageCount + videoCount > 2) score -= 30;
    if (score >= 100) {
      if (videoCount > 0) {
        return { category: 'Video', platform: getBaseDomainForCategory(savedUrl), confirmedType: '' };
      }
      return { category: 'Image', platform: getPageDomain(), confirmedType: '' };
    }

    // ── Step 6: Default ───────────────────────────────────────────────────────
    return { category: 'Page', platform: '', confirmedType: '' };
  } catch {
    return { category: 'Page', platform: '', confirmedType: '' };
  }
}

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
 * Crawls the given URL with Puppeteer and returns the page's text content.
 * Extracts title, meta description, and body text (JS-rendered).
 * Returns null if crawling fails.
 */
async function crawlPageContent(url: string): Promise<{ title: string; text: string } | null> {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(() => {
      // Remove noise elements
      ['script', 'style', 'nav', 'header', 'footer', 'iframe', 'noscript'].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => el.remove());
      });

      const title = document.title || '';
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';
      const bodyText = (document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 4000);

      return { title, text: `${metaDesc}\n\n${bodyText}`.trim() };
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Crawl] Failed for', url.substring(0, 60), '|', msg);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Fetches a Gmail thread's subject and body text using the Gmail API.
 * Requires a valid OAuth access token with gmail.readonly scope.
 * Returns { title, text } or null on failure.
 */
async function fetchGmailThreadContent(
  gmailUrl: string,
  accessToken: string
): Promise<{ title: string; text: string } | null> {
  try {
    // Extract thread ID from URL fragment: #inbox/THREAD_ID or #all/THREAD_ID etc.
    const fragmentMatch = gmailUrl.match(/#[^/]+\/([A-Za-z0-9]+)/);
    if (!fragmentMatch?.[1]) {
      console.warn('[Gmail] Could not extract thread ID from URL:', gmailUrl.substring(0, 80));
      return null;
    }
    const threadId = fragmentMatch[1];

    // Fetch thread metadata (includes messages list)
    const threadRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      } as any
    );

    if (!threadRes.ok) {
      const errText = await threadRes.text().catch(() => '');
      console.warn('[Gmail] API error:', threadRes.status, errText.substring(0, 100));
      return null;
    }

    const threadData = await threadRes.json() as any;
    const messages: any[] = threadData?.messages || [];
    if (messages.length === 0) return null;

    // Extract subject from first message headers
    const firstHeaders: any[] = messages[0]?.payload?.headers || [];
    const subject = firstHeaders.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '(No subject)';
    const from    = firstHeaders.find((h: any) => h.name?.toLowerCase() === 'from')?.value    || '';
    const date    = firstHeaders.find((h: any) => h.name?.toLowerCase() === 'date')?.value    || '';

    // Extract body text from all messages (plain text preferred)
    const extractBody = (payload: any): string => {
      if (!payload) return '';
      // Direct plain text part
      if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
      }
      // Recurse into parts
      if (Array.isArray(payload.parts)) {
        for (const part of payload.parts) {
          const text = extractBody(part);
          if (text) return text;
        }
      }
      return '';
    };

    const bodies = messages
      .map((msg: any) => extractBody(msg.payload))
      .filter(Boolean)
      .join('\n\n---\n\n')
      .substring(0, 4000);

    const text = [
      from   ? `From: ${from}`    : '',
      date   ? `Date: ${date}`    : '',
      bodies ? `\n${bodies}`      : '',
    ].filter(Boolean).join('\n');

    console.log('[Gmail] ✅ Thread content fetched');
    return { title: subject, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Gmail] fetchGmailThreadContent error:', msg);
    return null;
  }
}

/**
 * Crawls a Naver Mail page using injected login cookies from the browser.
 * Uses networkidle2 to wait for dynamic content to fully render.
 * Returns { title, text } or null on failure.
 */
async function crawlNaverMailContent(
  url: string,
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
  }>
): Promise<{ title: string; text: string } | null> {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Inject Naver login cookies
    for (const cookie of cookies) {
      try {
        await page.setCookie({
          name:     cookie.name,
          value:    cookie.value,
          domain:   cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`,
          path:     cookie.path || '/',
          secure:   cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: (cookie.sameSite as any) || 'Lax',
        });
      } catch { /* skip invalid cookie */ }
    }

    // Use networkidle2 to wait for dynamic mail content to render
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    const result = await page.evaluate(() => {
      ['script', 'style', 'nav', 'header', 'footer', 'iframe', 'noscript'].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => el.remove());
      });

      const title = document.title || '';
      const bodyText = (document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 4000);

      return { title, text: bodyText };
    });

    if (!result.text || result.text.trim().length < 30) {
      console.warn('[NaverMail] Page rendered but content too short — may not be logged in');
      return null;
    }

    console.log('[NaverMail] ✅ Mail content fetched');
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[NaverMail] Crawl failed:', msg);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Detects if a URL is a search engine results page.
 * Returns { engine, query } if matched, or null otherwise.
 */
function detectSearchUrl(url: string): { engine: string; query: string } | null {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, '');

    if (hostname === 'google.com' && u.pathname === '/search') {
      const q = u.searchParams.get('q');
      if (q) return { engine: 'Google', query: q };
    }
    if (hostname === 'search.naver.com' && u.pathname.startsWith('/search.naver')) {
      const q = u.searchParams.get('query');
      if (q) return { engine: 'Naver', query: q };
    }
    if (hostname === 'bing.com' && u.pathname === '/search') {
      const q = u.searchParams.get('q');
      if (q) return { engine: 'Bing', query: q };
    }
    if (hostname === 'youtube.com' && u.pathname === '/results') {
      const q = u.searchParams.get('search_query');
      if (q) return { engine: 'YouTube', query: q };
    }
    if (hostname === 'duckduckgo.com') {
      const q = u.searchParams.get('q');
      if (q) return { engine: 'DuckDuckGo', query: q };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Crawls the given URL, calls Gemini Function Calling to analyze the content,
 * and updates the Firestore document with ai_* fields.
 * Runs fire-and-forget — caller does not await.
 */
async function analyzeAndUpdateDocument(
  docPath: string,
  url: string,
  userLanguage?: string,
  gmailToken?: string,
  naverCookies?: Array<Record<string, any>>
): Promise<void> {
  if (!GEMINI_API_KEY) {
    console.warn('[AI] GEMINI_API_KEY not set — skipping analysis');
    return;
  }
  if (!url || !url.trim()) return;

  try {
    const isGmailUrl = url.trim().startsWith('https://mail.google.com/');
    if (isGmailUrl && !gmailToken) {
      console.warn('[AI] Gmail URL but no token received — skipping analysis');
      return;
    }

    // Naver Mail: use cookie-injected Puppeteer crawl
    const isNaverMailUrl = url.trim().startsWith('https://mail.naver.com/');
    if (isNaverMailUrl && !naverCookies?.length) {
      console.warn('[AI] Naver Mail URL but no cookies received — skipping analysis');
      return;
    }

    // Search engine results page — skip crawl, write directly to Firestore
    const searchInfo = detectSearchUrl(url.trim());
    if (searchInfo) {
      const db = getFirestore();
      await db.doc(docPath).update({
        ai_title:             `${searchInfo.engine} Search: ${searchInfo.query}`,
        ai_key_points:        [],
        ai_keywords:          [searchInfo.query],
        ai_content_type:      'Search',
        ai_content_resource:  searchInfo.engine,
        ai_subject_type:      '',
        ai_content_category:  [],
        ai_content_topic:     [],
      });
      console.log('[AI] ✅ Search URL processed:', searchInfo.engine, '|', searchInfo.query);
      return;
    }

    const crawled = isGmailUrl && gmailToken
      ? await fetchGmailThreadContent(url.trim(), gmailToken)
      : isNaverMailUrl && naverCookies?.length
        ? await crawlNaverMailContent(url.trim(), naverCookies as any)
        : await crawlPageContent(url.trim());
    if (!crawled) {
      console.warn('[AI] Crawl failed for:', url.substring(0, 60));
      return;
    }

    const langCode = ((userLanguage || 'en').split('-')[0]).toLowerCase();
    const langMap: Record<string, string> = {
      ko: 'Korean', ja: 'Japanese', zh: 'Chinese', fr: 'French',
      de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    };
    const outputLanguage = langMap[langCode] || 'English';

    const tools = [
      {
        functionDeclarations: [
          {
            name: 'analyze_page_content',
            description: 'Analyzes the text content of a web page and returns structured insights.',
            parameters: {
              type: 'OBJECT',
              properties: {
                title: {
                  type: 'STRING',
                  description: 'The main title or topic of the page content.',
                },
                key_points: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '3 to 5 key points or highlights from the content.',
                },
                keywords: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '4 to 6 keywords or topic tags that describe the content.',
                },
                content_type: {
                  type: 'STRING',
                  description: `What kind of content this is. Choose the best match:
- Article: written content meant to be read (blog posts, essays, guides, reviews, interviews, tutorials, opinions, comparisons, recommendations, case studies)
- SNS Post: a post published on a social media platform (Instagram, X, LinkedIn, Facebook, Threads, TikTok, Pinterest, Reddit, etc.)
- News: journalism or press content reporting on current events
- Video: video content on any platform (YouTube, Vimeo, TikTok, etc.)
- Image: a standalone image (photo, illustration, infographic, meme, design, screenshot)
- Website: an official web presence whose purpose is to introduce or describe an entity — company, organization, government, school, etc.
- Product: a physical/tangible item for purchase (electronics, fashion, food, furniture, books, etc.)
- Tool: a software or digital service that users directly interact with and use. ONLY use Tool if the page IS the actual service interface or its official landing page where you sign up / start using it. Do NOT use Tool for a page that merely describes a company that makes software.
- Platform: a digital ecosystem or marketplace that hosts other content or services (shopping platforms, video platforms, app stores, etc.)
- Community: an online gathering space for people with shared interests (forums, Discord servers, Naver Cafe, Reddit communities, etc.)
- Mail: an email message (newsletter, notification, promotion, personal, work, receipt)
- Repository: a code or model repository (GitHub, HuggingFace, etc.)
- Document: a file-based document (PDF, spreadsheet, presentation, etc.)
- Profile: a page on a third-party platform that presents a specific person or company as a listed entity. Examples: Instagram user profile, LinkedIn company page, GitHub user page, YCombinator company listing, Product Hunt page, Crunchbase entry. Key signal: the URL contains a username/slug within a platform that lists many such entities.
- Travel & Events: flight tickets, accommodation, event tickets, gift cards, and related booking pages
- Maps & Location: map pages and location/place information pages (Google Maps, Naver Map, Kakao Map, etc.)
- Search: a search engine results page (Google, Naver, Bing, YouTube, DuckDuckGo)
If none fits, generate a concise label of your own.`,
                },
                content_resource: {
                  type: 'STRING',
                  description: `The source platform or provider of this content. Rules per content_type:
- Article: the publication or website name (e.g. Naver, Medium, Brunch, TechCrunch)
- SNS Post: the social platform (e.g. Instagram, X, LinkedIn, Facebook, Threads, TikTok, Pinterest, Reddit)
- News: the news outlet name (e.g. NY Times, BBC, Yonhap, TechCrunch)
- Video: the video platform (e.g. YouTube, Vimeo, TikTok)
- Image: the platform where the image was found (e.g. Pinterest, Google Images, Unsplash)
- Website: leave empty
- Product: the shopping platform or store (e.g. Amazon, Coupang, eBay)
- Tool: leave empty — tools are self-hosted
- Platform: leave empty — platforms are self-hosted
- Community: the community platform (e.g. Reddit, Discord, Naver Cafe, DC Inside)
- Mail: the mail platform (e.g. Gmail, Naver Mail, Outlook)
- Repository: the repository platform (e.g. GitHub, HuggingFace, GitLab)
- Document: leave empty
- Profile: the platform hosting the profile (e.g. Instagram, LinkedIn, YCombinator)
- Travel & Events: the booking platform (e.g. Expedia, Airbnb, Interpark, Kyobo)
- Maps & Location: the map platform (e.g. Google, Naver, Kakao)
- Search: leave empty
If the source cannot be determined, leave empty.`,
                },
                subject_type: {
                  type: 'STRING',
                  description: `Only applicable for specific content_types. Leave empty for all others.
- Profile: whether the profile subject is a person or a company → Person | Company
- Community: the primary audience or member type of the community → Developer | Designer | Investor | Entrepreneur | Student | Parent | Gamer | Creator | Office Worker. If none fits, generate a concise label.
- Travel & Events: the type of booking or event → Flight | Accommodation | Ticket | Gift Card. If none fits, generate a concise label.
- All other content_types: leave empty.`,
                },
                content_category: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: `1 to 2 category tags describing the content domain. Rules per content_type:
- Article / SNS Post / News / Video / Website / Community / Profile:
  Choose 1–2 from: Film & Animation & Drama | Music & Art | Gaming | Current Affairs & Culture | Autos & Vehicles | Pets & Animals | Sports & Outdoors | Healthcare & Medical | Travel & Events | People & Living | Beauty & Style | Education & Lecture | News & Politics | Science & Tech | Nonprofits & Activism | Finance & Insurance | Real Estate | Transportation & Weather | Comedy & Meme & Gossip | Economy & Business. If none fits, generate a concise label.
- Product:
  Choose 1–2 from: Electronics | Fashion | Beauty | Food & Drink | Home & Living | Sports & Outdoors | Books | Toys & Hobbies | Autos & Vehicles. If none fits, generate a concise label.
- Tool:
  Choose 1–2 from: Productivity | Design | Communication | Development | Marketing & Sales | Finance | AI | Entertainment. If none fits, generate a concise label.
- Platform:
  Choose 1–2 from: Shopping | Video | Music | Image | News & Media | Development | Art & Design | Education & Lecture | Finance | Travel & Events | Food & Drink. If none fits, generate a concise label.
- Mail:
  Choose 1 from: Newsletter | Notification | Promotion | Personal | Work | Receipt. If none fits, generate a concise label.
- Repository:
  Choose 1–2 from: Model | Dataset | Library | Framework | App | Template. If none fits, generate a concise label.
- Document:
  Choose 1 from: PDF | Spreadsheet | Presentation | Word. If none fits, generate a concise label.
- Maps & Location:
  Generate a concise label for the type of place (e.g. Restaurant, Shopping Mall, Hospital, Park, Hotel).
- Travel & Events: use the same list as Article above, choosing the most relevant category.
- Image: leave empty — use content_topic instead.
- Search: leave empty.`,
                },
                content_topic: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: `1 to 2 keywords describing the specific subject or purpose of the content. Only applicable for specific content_types. Leave empty for all others.
- Article / SNS Post:
  Choose 1–2 from: Opinion & Review | Recommendation | Comparison | How-to & Tutorial | Analysis & Essay | Interview & Podcast | Inform. If none fits, generate a concise label.
- News:
  Choose 1–2 from: Recommendation | Comparison | How-to & Tutorial | Analysis & Essay | Interview & Podcast | Inform. If none fits, generate a concise label.
- Video:
  Choose 1–2 from: Opinion & Review | Recommendation | Comparison | How-to & Tutorial | Analysis & Essay | Interview & Podcast | Inform | Contents | Live Stream & Reaction | Promotion | Documentary & Vlog. If none fits, generate a concise label.
- Image:
  Generate 1–2 concise keywords describing what is depicted in the image (e.g. "Mountain Landscape", "UI Design", "Cat", "Portrait").
- All other content_types: leave empty (return empty array).
IMPORTANT: each item must be a short keyword or phrase (1–4 words), never a full sentence.`,
                },
              },
              required: ['title', 'key_points', 'keywords', 'content_type', 'content_resource', 'subject_type', 'content_category', 'content_topic'],
            },
          },
        ],
      },
    ];

    const prompt = `You are analyzing the content of a web page and labeling it with a structured taxonomy.
URL: ${url}
Page title: ${crawled.title}
Page content:
${crawled.text}

Call the analyze_page_content function with your analysis.
Write title, key_points in ${outputLanguage}.
Keywords should be concise single words or short phrases.
content_resource, subject_type must be left empty when the rules say so.
content_category and content_topic must each be arrays of 1–2 short keyword phrases (never full sentences); return empty arrays when the rules say so.`;

    const response = await fetch(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools,
          generationConfig: { temperature: 0.2 },
        }),
      } as any
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini error ${response.status}: ${errText.substring(0, 100)}`);
    }

    const data = await response.json() as any;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const functionCallPart = parts.find((p: any) => p.functionCall?.name === 'analyze_page_content');
    if (!functionCallPart) {
      console.warn('[AI] No function call in Gemini response for:', url.substring(0, 60));
      return;
    }

    let rawArgs = functionCallPart.functionCall.args as unknown;
    if (typeof rawArgs === 'string') {
      try { rawArgs = JSON.parse(rawArgs); } catch { return; }
    }
    const args = rawArgs as {
      title?: string;
      key_points?: string[];
      keywords?: string[];
      content_type?: string;
      content_resource?: string;
      subject_type?: string;
      content_category?: string[];
      content_topic?: string[];
    };

    const db = getFirestore();
    await db.doc(docPath).update({
      ai_title:             args.title              || crawled.title,
      ai_key_points:        Array.isArray(args.key_points)       ? args.key_points       : [],
      ai_keywords:          Array.isArray(args.keywords)         ? args.keywords         : [],
      ai_content_type:      args.content_type       || '',
      ai_content_resource:  args.content_resource   || '',
      ai_subject_type:      args.subject_type       || '',
      ai_content_category:  Array.isArray(args.content_category) ? args.content_category : [],
      ai_content_topic:     Array.isArray(args.content_topic)    ? args.content_topic    : [],
    });

    console.log('[AI] ✅ Analysis saved to Firestore:', docPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[AI] ❌ analyzeAndUpdateDocument failed for:', url.substring(0, 60), '|', msg);
  }
}

function getFirestore() {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  return admin.firestore();
}

function getStorage() {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || '';
  return bucketName
    ? admin.storage().bucket(bucketName)
    : admin.storage().bucket();
}

async function uploadScreenshotToStorage(
  base64DataUrl: string,
  userId: string,
  itemId: string
): Promise<{ publicUrl: string } | null> {
  try {
    const matches = base64DataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return null;
    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const filePath = `screenshots/${userId}/${itemId}.${ext}`;
    const bucket = getStorage();
    const file = bucket.file(filePath);

    await file.save(buffer, {
      metadata: { contentType: mimeType },
    });
    try {
      await file.makePublic();
    } catch {
      /* uniform bucket-level access or policy may disallow ACL */
    }

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    return { publicUrl };
  } catch (e) {
    return null;
  }
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

app.post('/api/v1/save-url', async (req: Request, res: Response) => {
  const {
    url,
    title,
    timestamp,
    img_url,
    saved_by,
    type,
    screenshot_base64,
    screenshot_bg_color,
    category,
    confirmed_type,
    page_save,
  } = req.body as Omit<SaveUrlPayload, 'domain'> & {
    img_url?: string;
    saved_by?: string;
    type?: string; // Type from extension (e.g., 'instagram_post')
    screenshot_base64?: string;
    screenshot_bg_color?: string;
    category?: string;
    confirmed_type?: string;
    page_save?: boolean;
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
  const clientCategoryRaw      = typeof category === 'string' ? category.trim() : '';
  const isPageCategory         = clientCategoryRaw === 'Page';
  const clientPlatformRaw      = typeof (req.body as any).platform === 'string'
    ? (req.body as any).platform.trim() : '';
  const clientConfirmedTypeRaw = typeof confirmed_type === 'string' ? confirmed_type.trim() : '';
  const clientSenderRaw        = typeof (req.body as any).sender === 'string'
    ? (req.body as any).sender.trim() : '';
  const clientScreenshotPaddingRaw = typeof (req.body as any).screenshot_padding === 'number'
    ? (req.body as any).screenshot_padding : 0;
  const gmailTokenRaw = typeof (req.body as any).gmail_token === 'string'
    ? (req.body as any).gmail_token.trim()
    : '';
  const naverCookiesRaw = Array.isArray((req.body as any).naver_cookies)
    ? ((req.body as any).naver_cookies as Array<Record<string, any>>)
    : undefined;

  const rawPayload = {
    url: url ? url.trim() : '',
    title: title.trim(),
    timestamp,
    ...(type && { type: type.trim() }),
    ...(resolvedImgUrl && { img_url: resolvedImgUrl }),
    ...(req.body.thumbnail && { thumbnail: req.body.thumbnail.trim() }),
    ...(saved_by && { saved_by }),
    ...(clientCategoryRaw      && { category:       clientCategoryRaw }),
    ...(clientPlatformRaw      && { platform:        clientPlatformRaw }),
    ...(clientConfirmedTypeRaw && { confirmed_type:  clientConfirmedTypeRaw }),
    ...(clientSenderRaw        && { sender:             clientSenderRaw }),
    ...(clientScreenshotPaddingRaw > 0 && { screenshot_padding: clientScreenshotPaddingRaw }),
  };

  // Try to forward to Electron app first (for Firestore save)
  const forwardResult = await forwardToElectronApp(rawPayload);
  
  if (forwardResult.success && forwardResult.result?.success) {
    const documentId = forwardResult.result.documentId;
    console.log('✅ Saved to Firestore via Electron app:', documentId);

    const forwardedUrl = rawPayload.url;
    const userId = (req.body as any).userId as string | undefined;

    let docPath: string | undefined;
    if (forwardedUrl && documentId && userId) {
      docPath = `users/${userId}/items/${documentId}`;

      const screenshotBase64Fwd = screenshot_base64;
      if (screenshotBase64Fwd && userId && documentId && (!resolvedImgUrl || isPageCategory)) {
        (async () => {
          try {
            const uploadResult = await uploadScreenshotToStorage(
              screenshotBase64Fwd,
              userId,
              documentId
            );
            if (uploadResult) {
              const db = getFirestore();
              const screenshotBgColor =
                typeof screenshot_bg_color === 'string' ? screenshot_bg_color.trim() : '';
              const { publicUrl } = uploadResult;
              await db.doc(docPath!).update({
                img_url: publicUrl,
                ...(screenshotBgColor ? { screenshot_bg_color: screenshotBgColor } : {}),
              });
            }
          } catch {}
        })();
      }
    }

    // Background: AI analysis (disabled — re-enable in future update)
    // if (forwardedUrl && docPath) {
    //   const aiUserLanguage = (req.body as any).userLanguage as string | undefined;
    //   (async () => { await analyzeAndUpdateDocument(docPath, forwardedUrl, aiUserLanguage, gmailTokenRaw || undefined, naverCookiesRaw); })();
    // }

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

      if (clientCategoryRaw)      firestoreEntry.category       = clientCategoryRaw;
      if (clientPlatformRaw)      firestoreEntry.platform       = clientPlatformRaw;
      if (clientConfirmedTypeRaw) firestoreEntry.confirmed_type = clientConfirmedTypeRaw;
      if (clientSenderRaw)                    firestoreEntry.sender             = clientSenderRaw;
      if (clientScreenshotPaddingRaw > 0)     firestoreEntry.screenshot_padding = clientScreenshotPaddingRaw;

      const newDocRef = itemsRef.doc();
      await newDocRef.set(firestoreEntry);

      console.log('✅ Saved directly to Firestore (Electron offline):', newDocRef.id);

      const screenshotBase64Direct = screenshot_base64;
      if (screenshotBase64Direct && uid && (!resolvedImgUrl || isPageCategory)) {
        const newItemId = newDocRef.id;
        const newDocPath = `users/${uid}/items/${newItemId}`;
        (async () => {
          try {
            const uploadResult = await uploadScreenshotToStorage(
              screenshotBase64Direct,
              uid,
              newItemId
            );
            if (uploadResult) {
              const db = getFirestore();
              const screenshotBgColor =
                typeof screenshot_bg_color === 'string' ? screenshot_bg_color.trim() : '';
              const { publicUrl } = uploadResult;
              await db.doc(newDocPath).update({
                img_url: publicUrl,
                ...(screenshotBgColor ? { screenshot_bg_color: screenshotBgColor } : {}),
              });
            }
          } catch {}
        })();
      }

      // Background: AI analysis (disabled — re-enable in future update)
      // const aiUserLanguage = (req.body as any).userLanguage as string | undefined;
      // (async () => { await analyzeAndUpdateDocument(`users/${uid}/items/${newDocRef.id}`, url.trim(), aiUserLanguage, gmailTokenRaw || undefined, naverCookiesRaw); })();

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

app.delete('/api/v1/items/:itemId', async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const userId = (req.query.userId || (req.body as { userId?: string } | undefined)?.userId) as
      | string
      | undefined;

    if (!itemId || typeof itemId !== 'string' || !itemId.trim()) {
      return res.status(400).json({ error: 'Missing itemId' });
    }
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const uid = userId.trim();
    const docId = itemId.trim();
    const db = getFirestore();
    const docPath = `users/${uid}/items/${docId}`;

    // Read the document first to check for a screenshot to delete
    let imgUrl = '';
    try {
      const snap = await db.doc(docPath).get();
      if (snap.exists) {
        imgUrl = String(snap.data()?.img_url || '').trim();
      }
    } catch {
      /* proceed even if read fails */
    }

    // Delete Firestore document
    await db.doc(docPath).delete();

    // Delete Storage file if img_url points to a screenshot
    if (imgUrl.includes('/screenshots/')) {
      try {
        const bucket = getStorage();
        const bucketPrefix = `https://storage.googleapis.com/${bucket.name}/`;
        if (imgUrl.startsWith(bucketPrefix)) {
          const filePath = imgUrl.slice(bucketPrefix.length);
          await bucket.file(filePath).delete();
        }
      } catch {
        /* silently ignore storage deletion errors */
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/v1/items/:itemId]', err);
    return res.status(500).json({ error: 'Delete failed' });
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

    // ?format=json → return JSON (legacy/internal use)
    if (req.query.format === 'json') {
      return res.status(200).json({ url: logoUrl || null });
    }

    // Default: proxy the image binary so <img src> can use this endpoint directly
    if (!logoUrl) {
      return res.status(404).json({ error: 'Logo not found' });
    }

    const imgRes = await fetch(logoUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    } as any);

    if (!imgRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch logo image' });
    }

    const contentType = imgRes.headers.get('content-type') || 'image/x-icon';
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.setHeader('Content-Length', buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Failed to fetch logo:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/v1/analyze-page', async (req: Request, res: Response) => {
  try {
    const { url, userLanguage } = req.body as { url: string; userLanguage?: string };
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'Invalid url' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'Gemini API key not configured' });
    }

    // ── Step 1: Crawl the page ──────────────────────────────────────────────
    const crawled = await crawlPageContent(url.trim());
    if (!crawled) {
      return res.status(502).json({ error: 'Failed to crawl page' });
    }

    // ── Step 2: Gemini Function Calling ─────────────────────────────────────
    const langCode = ((userLanguage || 'en').split('-')[0]).toLowerCase();
    const langMap: Record<string, string> = {
      ko: 'Korean', ja: 'Japanese', zh: 'Chinese', fr: 'French',
      de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    };
    const outputLanguage = langMap[langCode] || 'English';

    // Tool definition
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'analyze_page_content',
            description: 'Analyzes the text content of a web page and returns structured insights.',
            parameters: {
              type: 'OBJECT',
              properties: {
                title: {
                  type: 'STRING',
                  description: 'The main title or topic of the page content.',
                },
                key_points: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '3 to 5 key points or highlights from the content.',
                },
                keywords: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '4 to 6 keywords or topic tags that describe the content.',
                },
                content_type: {
                  type: 'STRING',
                  description: 'The type of content. One of: Article, News, Product, Video, Profile, Repository, Recipe, Forum, Document, Other.',
                },
              },
              required: ['title', 'key_points', 'keywords', 'content_type'],
            },
          },
        ],
      },
    ];

    const prompt = `You are analyzing the content of a web page.
URL: ${url}
Page title: ${crawled.title}
Page content:
${crawled.text}

Call the analyze_page_content function with your analysis.
Write all text fields (title, key_points) in ${outputLanguage}.
Keywords should be concise single words or short phrases.`;

    // First Gemini call — expect function call response
    const firstResponse = await fetch(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools,
          generationConfig: { temperature: 0.2 },
        }),
      } as any
    );

    if (!firstResponse.ok) {
      const errText = await firstResponse.text().catch(() => '');
      throw new Error(`Gemini error ${firstResponse.status}: ${errText.substring(0, 100)}`);
    }

    const firstData = await firstResponse.json() as any;
    const candidate = firstData?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Extract function call args
    const functionCallPart = parts.find((p: any) => p.functionCall?.name === 'analyze_page_content');
    if (!functionCallPart) {
      // Fallback: Gemini responded with text instead of function call
      const fallbackText = parts.find((p: any) => p.text)?.text || '';
      return res.status(200).json({ raw: fallbackText });
    }

    let rawArgs = functionCallPart.functionCall.args as unknown;
    if (typeof rawArgs === 'string') {
      try {
        rawArgs = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        return res.status(200).json({ raw: String(rawArgs) });
      }
    }
    const args = rawArgs as {
      title: string;
      key_points: string[];
      keywords: string[];
      content_type: string;
    };

    return res.status(200).json({
      title:              args.title              || crawled.title,
      key_points:         Array.isArray(args.key_points)         ? args.key_points         : [],
      keywords:           Array.isArray(args.keywords)           ? args.keywords           : [],
      content_type:       args.content_type       || 'Other',
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Analyze Page] Error:', msg);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

```

### `browser-extension/chromium/background.js`

```javascript
// Track last ping time to detect if we should ping on focus
let lastPingTime = 0;

let _savedUrlsCache = [];

// Restore persisted saved-URLs cache so the first get-saved-urls call
// after a Service Worker restart returns real data instead of [].
chrome.storage.local.get('blinkSavedUrls', (result) => {
  if (Array.isArray(result?.blinkSavedUrls)) {
    _savedUrlsCache = result.blinkSavedUrls;
  }
});

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
  if (request.action === 'set-saved-urls') {
    _savedUrlsCache = Array.isArray(request.urls) ? request.urls : [];
    chrome.storage.local.set({ blinkSavedUrls: _savedUrlsCache }).catch(() => {});
    sendResponse({ success: true });
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]?.id) return;
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url || '';
        if (
          tabUrl.startsWith('chrome://') ||
          tabUrl.startsWith('chrome-extension://') ||
          tabUrl.startsWith('edge://') ||
          tabUrl.startsWith('arc://')
        ) return;
        chrome.tabs.sendMessage(tabId, { action: 'saved-urls-updated' }, () => {
          if (chrome.runtime.lastError) { /* tab may not have content script */ }
        });
      });
    } catch (e) {}
    return true;
  }

  if (request.action === 'get-saved-urls') {
    sendResponse({ urls: _savedUrlsCache });
    return true;
  }

  if (request.action === 'capture-visible-tab') {
    chrome.tabs.captureVisibleTab(
      null,
      { format: 'jpeg', quality: 80 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, dataUrl });
        }
      }
    );
    return true;
  }

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

  if (request.action === 'get-gmail-token') {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        sendResponse({ token: null });
      } else {
        sendResponse({ token });
      }
    });
    return true; // keep channel open for async sendResponse
  }

  if (request.action === 'get-naver-cookies') {
    chrome.cookies.getAll({ domain: '.naver.com' }, (cookies) => {
      if (chrome.runtime.lastError || !cookies?.length) {
        sendResponse({ cookies: null });
      } else {
        sendResponse({
          cookies: cookies.map((c) => ({
            name:     c.name,
            value:    c.value,
            domain:   c.domain,
            path:     c.path,
            secure:   c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
          })),
        });
      }
    });
    return true; // keep channel open for async sendResponse
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

### `browser-extension/chromium/coreEntry.js`

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
  mountInstagramShortcodeObserver,
  getCurrentPlatform,
  normalizeShortcodeExtractionResult,
  applyCoreHighlight,
  clearCoreSelection,
  applyCoreHighlightState,
  applyFullPageHighlightState,
  ensureClusterCacheFromState,
  showMetadataTooltip,
  setAiTooltipContent,
  clearAiTooltipContent,
  positionMetadataTooltip,
  renderItemMapCandidates,
  showFullPageHighlight,
  hideFullPageHighlight,
  detectItemCategory,
  triggerShutterEffect,
} from './coreEngine.js';

let scanTimer = 0;
let lastFingerprint = '';
let _retryScanTimer = 0;    // setTimeout handle for pending retry scan
let _retryScanCount  = 0;   // number of retries attempted for current navigation
let _forceFullScanOnMutation = false; // true after navigation: next MutationObserver trigger uses full document scan
let pendingClearTimer = 0;
let lastPointerX = null;
let lastPointerY = null;
let _lastMouseoverTarget = null;
let _activeSourceIframe = null; // iframe element that sent the last highlight-core-item
let _lastIframeLocalRect = null; // last local rect received from that iframe
const CLEAR_GRACE_MS = 140;
const instagramFetchInFlightByElement = new WeakMap();

let _isCapturing = false; // true while captureVisibleTab is in progress

const IS_IFRAME = window.self !== window.top;
const BLINK_MSG_PREFIX = '__blink__';
const BLINK_SAVE_QUERY = '__blink_save_query__';
const BLINK_SAVE_HANDLED = '__blink_save_handled__';
const BLINK_SAVE_RELAY = '__blink_save_relay__';

/** Metadata tooltip id — hidden briefly during save (shutter uses overlay fills in uiManager). */
const METADATA_TOOLTIP_ID = 'blink-metadata-tooltip';
const SAVE_FEEDBACK_BLINK_MIN_MS = 80;

function postHighlightToTop(type, payload = {}) {
  try {
    window.top.postMessage({ [BLINK_MSG_PREFIX]: true, type, ...payload }, '*');
  } catch (e) {}
}

let _savedUrlSet = new Set(); // saved URLs

/**
 * Synchronously checks _savedUrlSet (kept fresh via get-saved-urls / saved-urls-updated).
 * Returns true if the URL is already saved, false otherwise.
 */
function checkIsSavedSync(url) {
  try {
    const u = normalizeUrlForSavedCheck(url);
    if (!u) return false;
    return _savedUrlSet.has(u);
  } catch (e) {
    return false;
  }
}

/**
 * Normalizes a URL string for consistent saved-URL matching.
 * Decodes percent-encoded characters so that encoded and decoded
 * forms of the same URL (e.g. %EA%B5%AC vs 구) are treated as equal.
 * Falls back to the original string if decoding fails (malformed encoding).
 */
function normalizeUrlForSavedCheck(url) {
  try {
    return decodeURIComponent(String(url || '').trim());
  } catch {
    return String(url || '').trim();
  }
}

function normalizeSavedUrlsResponse(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) =>
      typeof e === 'string'
        ? normalizeUrlForSavedCheck(e)
        : normalizeUrlForSavedCheck(e?.url || '')
    )
    .filter(Boolean);
}

function applyCoreHighlightFromUrl(coreItem, urlRaw, rectOverride = null, forceRestart = false) {
  const u = String(urlRaw || '').trim();
  const saved = u ? checkIsSavedSync(u) : false;
  applyCoreHighlight(coreItem, saved, rectOverride, forceRestart);
}

function applyFullPageHighlightFromUrl(urlRaw) {
  const u = String(urlRaw || '').trim();
  const saved = u ? checkIsSavedSync(u) : false;
  applyFullPageHighlightState(saved);
}

function initPageLevelMetadata() {
  try {
    const pageUrl = String(window?.location?.href || '').trim();
    if (!pageUrl) return;
    const { category } = detectItemCategory(pageUrl, pageUrl, null);
    state.lastExtractedMetadata = {
      ...(state.lastExtractedMetadata || {}),
      activeHoverUrl: '',
      category,
    };
    applyFullPageHighlightFromUrl(pageUrl);
  } catch (e) {}
}

function mountIframeHighlightListener() {
  if (window.__blinkIframeHighlightListenerMounted) return;
  window.__blinkIframeHighlightListenerMounted = true;
  window.addEventListener(
    'message',
    (e) => {
      try {
        const data = e.data;
        if (!data || !data[BLINK_MSG_PREFIX]) return;

        if (data.type === 'highlight-core-item') {
          let iframeOffsetTop = 0;
          let iframeOffsetLeft = 0;
          let sourceIframe = null;
          try {
            sourceIframe = Array.from(document.querySelectorAll('iframe')).find(
              (f) => f.contentWindow === e.source
            );
            if (sourceIframe) {
              const ifr = sourceIframe.getBoundingClientRect();
              iframeOffsetTop = ifr.top;
              iframeOffsetLeft = ifr.left;
            }
          } catch (_) {}

          const resolvedRect = {
            top: data.rect.top + iframeOffsetTop,
            left: data.rect.left + iframeOffsetLeft,
            width: data.rect.width,
            height: data.rect.height,
            right: data.rect.right + iframeOffsetLeft,
          };

          // Store iframe context for scroll position updates
          _activeSourceIframe = sourceIframe || null;
          _lastIframeLocalRect = data.rect ? { ...data.rect } : null;

          hideFullPageHighlight();
          if (data.meta) {
            applyCoreHighlightFromUrl(null, data.meta.activeHoverUrl, resolvedRect, true);
            showMetadataTooltip(data.meta, resolvedRect.right, resolvedRect.top);
          } else {
            applyCoreHighlightFromUrl(null, '', resolvedRect, true);
          }
        } else if (data.type === 'clear-core-item') {
          _activeSourceIframe = null;
          _lastIframeLocalRect = null;
          clearCoreSelection();
          initPageLevelMetadata();
        } else if (data.type === 'resync-saved-badge') {
          applyCoreHighlightState(checkIsSavedSync(String(data.url || '')));
        }
      } catch (err) {}
    },
    { passive: true }
  );
}

// Waits for the browser to complete two paint frames.
// Used to ensure DOM visibility changes are reflected on screen
// before captureVisibleTab fires.
function waitForRepaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Temporarily hides purple overlay + metadata tooltip (opacity 0, layout preserved).
 * @returns {Array<{ el: HTMLElement, prevOpacity: string, prevTransition: string }>}
 */
/** Hides only the metadata tooltip during save; purple/full-page “blink” is `triggerShutterEffect`. */
function hideBlinkSaveFeedbackUi() {
  const hidden = [];
  for (const id of [METADATA_TOOLTIP_ID]) {
    try {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') {
        hidden.push({ el, prevOpacity: el.style.opacity, prevTransition: el.style.transition });
        el.style.opacity = '0';
      }
    } catch (e) {}
  }
  return hidden;
}

function restoreBlinkSaveFeedbackUi(hiddenEls) {
  for (const { el, prevOpacity, prevTransition } of hiddenEls) {
    try {
      el.style.transition = prevTransition;
      el.style.opacity = prevOpacity;
    } catch (e) {}
  }
}

/** Ensures a minimum visible “blink” duration, then restores save-feedback UI and re-applies purple. */
async function finalizeSaveFeedbackBlink(hiddenEls, startedAt) {
  const elapsed = Date.now() - startedAt;
  const wait = Math.max(0, SAVE_FEEDBACK_BLINK_MIN_MS - elapsed);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  restoreBlinkSaveFeedbackUi(hiddenEls);
  try {
    const currentActive = state.activeCoreItem;
    if (currentActive && currentActive.nodeType === 1) {
      applyCoreHighlightFromUrl(
        currentActive,
        String(state.lastExtractedMetadata?.activeHoverUrl || state.activeHoverUrl || '')
      );
    }
  } catch (e) {}
}

/**
 * Requests a Gmail OAuth token from background.js via chrome.identity.
 * Returns the token string or null if unavailable.
 */
async function getGmailAuthToken() {
  try {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-gmail-token' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response?.token || null);
        }
      });
    });
  } catch {
    return null;
  }
}

/**
 * Collects Naver login cookies from the browser for server-side Puppeteer injection.
 * Returns an array of cookie objects or null if unavailable.
 */
async function getNaverCookies() {
  try {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-naver-cookies' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response?.cookies || null);
        }
      });
    });
  } catch {
    return null;
  }
}

/**
 * Finds the minimum content container within a CoreItem using top-down traversal.
 * Starting from the root element, descends as long as there is exactly one
 * "meaningful" child — a child that has a visible bounding box AND contains
 * text, images, or further meaningful children.
 * Stops and returns the current node when:
 *   - 2+ meaningful children exist (this node IS the minimum container), OR
 *   - 0 meaningful children exist (leaf/empty — falls back to parent)
 *
 * Only applies to CoreItem screenshots. Page screenshots use the full viewport.
 *
 * @param {Element} root - The CoreItem element to search within
 * @returns {{ container: Element, hasPadding: boolean, paddingValue: number }}
 */
function findMinContentContainer(root) {
  const DEFAULT_PADDING = 6;
  const fallback = { container: root, hasPadding: false, paddingValue: DEFAULT_PADDING };
  try {
    if (!root || root.nodeType !== 1) return fallback;

    function isMeaningfulElement(el) {
      try {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        // Has direct text content
        const hasText = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && String(n.textContent || '').trim().length > 0
        );
        if (hasText) return true;
        // Has an img descendant with a visible rect
        const imgs = Array.from(el.querySelectorAll('img'));
        if (imgs.some((img) => {
          const ir = img.getBoundingClientRect();
          return ir.width > 0 && ir.height > 0;
        })) return true;
        // Has meaningful child elements
        const children = Array.from(el.children || []);
        return children.some((c) => isMeaningfulElement(c));
      } catch (e) {
        return false;
      }
    }

    let current = root;
    for (let depth = 0; depth < 8; depth++) {
      const children = Array.from(current.children || []);
      const meaningful = children.filter(isMeaningfulElement);
      if (meaningful.length === 1) {
        // Exactly one meaningful child — descend into it
        current = meaningful[0];
      } else {
        // 0 or 2+ meaningful children — stop here
        break;
      }
    }

    // Detect computed padding on the found container
    const cs = window.getComputedStyle ? window.getComputedStyle(current) : null;
    const paddingTop    = cs ? parseFloat(cs.paddingTop)    || 0 : 0;
    const paddingRight  = cs ? parseFloat(cs.paddingRight)  || 0 : 0;
    const paddingBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
    const paddingLeft   = cs ? parseFloat(cs.paddingLeft)   || 0 : 0;
    const maxPadding    = Math.max(paddingTop, paddingRight, paddingBottom, paddingLeft);
    const hasPadding    = maxPadding >= 4;

    return {
      container:    current,
      hasPadding,
      // If container already has padding >= 4px, no extra padding needed on DataCard.
      // Otherwise apply DEFAULT_PADDING for visual consistency.
      paddingValue: hasPadding ? 0 : DEFAULT_PADDING,
    };
  } catch (e) {
    return fallback;
  }
}

async function captureScreenshotBase64(element) {
  try {
    if (!element || element.nodeType !== 1) return null;

    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;

    const BLINK_UI_IDS = [
      'blink-highlight-overlay',
      'blink-metadata-tooltip',
      'blink-green-candidate-layer',
      'blink-fullpage-highlight-overlay',
    ];
    const hiddenEls = [];
    for (const id of BLINK_UI_IDS) {
      try {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') {
          // Use opacity:0 instead of display:none so the element stays in
          // the layout (no visual jump) but is excluded from the screenshot.
          hiddenEls.push({ el, prevOpacity: el.style.opacity, prevTransition: el.style.transition });
          el.style.opacity = '0';
        }
      } catch (e) {}
    }

    _isCapturing = true;
    try {
      // One rAF is enough since opacity change (no layout reflow needed).
      await waitForRepaint();
      await new Promise((resolve) => setTimeout(resolve, 32));

      let dataUrl = null;
      let backgroundColor = '#ffffff';
      try {
        const result = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ action: 'capture-visible-tab' }, (response) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve(response);
            });
          } catch (e) {
            resolve(null);
          }
        });

        if (!result?.success || !result?.dataUrl) return null;

        const dpr = window.devicePixelRatio || 1;
        const img = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('img load failed'));
          image.src = result.dataUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(
          img,
          Math.round(rect.left * dpr),
          Math.round(rect.top * dpr),
          Math.round(rect.width * dpr),
          Math.round(rect.height * dpr),
          0,
          0,
          Math.round(rect.width * dpr),
          Math.round(rect.height * dpr)
        );
        dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        // Sample background color from the cropped canvas pixels.
        // Average the RGB values of 3 corners (top-left, top-right, bottom-left)
        // to get a representative background color, avoiding content-heavy center.
        try {
          const cw = canvas.width;
          const ch = canvas.height;
          const samples = [
            ctx.getImageData(0, 0, 1, 1).data, // top-left
            ctx.getImageData(cw - 1, 0, 1, 1).data, // top-right
            ctx.getImageData(0, ch - 1, 1, 1).data, // bottom-left
          ];
          const avgR = Math.round(samples.reduce((s, p) => s + p[0], 0) / samples.length);
          const avgG = Math.round(samples.reduce((s, p) => s + p[1], 0) / samples.length);
          const avgB = Math.round(samples.reduce((s, p) => s + p[2], 0) / samples.length);
          backgroundColor = `rgb(${avgR},${avgG},${avgB})`;
        } catch (_) {
          backgroundColor = '#ffffff';
        }
      } catch (e) {
        dataUrl = null;
      }

      if (!dataUrl) return null;
      return { dataUrl, backgroundColor };
    } finally {
      _isCapturing = false;
      for (const { el, prevOpacity, prevTransition } of hiddenEls) {
        try {
          el.style.transition = prevTransition;
          el.style.opacity    = prevOpacity;
        } catch (e) {}
      }
      // Re-apply highlight for the current active CoreItem in case
      // the user moved to a different CoreItem during capture.
      // This ensures the correct highlight is shown immediately after
      // the overlay is restored, with no flicker gap.
      try {
        const currentActive = state.activeCoreItem;
        if (currentActive && currentActive.nodeType === 1) {
          applyCoreHighlightFromUrl(
            currentActive,
            String(state.lastExtractedMetadata?.activeHoverUrl || state.activeHoverUrl || '')
          );
        }
      } catch (e) {}
    }
  } catch (e) {
    return null;
  }
}

async function capturePageScreenshotBase64() {
  const BLINK_UI_IDS = [
    'blink-highlight-overlay',
    'blink-metadata-tooltip',
    'blink-green-candidate-layer',
    'blink-fullpage-highlight-overlay',
  ];

  // Temporarily hide Blink UI elements
  const hiddenEls = [];
  let _fullPageHighlightHidden = false;
  for (const id of BLINK_UI_IDS) {
    try {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') {
        hiddenEls.push({ el, prevOpacity: el.style.opacity, prevTransition: el.style.transition });
        el.style.transition = '';
        el.style.opacity = '0';
        // Stop rAF border animation for FullPage overlay so the compositor
        // fully removes it before captureVisibleTab fires.
        if (id === 'blink-fullpage-highlight-overlay') {
          hideFullPageHighlight();
          _fullPageHighlightHidden = true;
        }
      }
    } catch (e) {}
  }

  _isCapturing = true;
  try {
    // Wait for the browser to repaint with hidden Blink UI before capturing.
    // Two rAFs ensure layout/paint; the extra 32ms settles compositor flush.
    await waitForRepaint();
    await new Promise((resolve) => setTimeout(resolve, 32));

    // Re-apply hide in case any intervening rAF or event handler
    // restored the overlay during the repaint wait.
    if (_fullPageHighlightHidden) {
      hideFullPageHighlight();
    }

    const result = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'capture-visible-tab' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve(null);
      }
    });

    if (!result?.success || !result?.dataUrl) return null;

    // Sample background color from 3 corners of the captured full-page image.
    // Uses pixel sampling instead of DOM computed style for accuracy.
    let backgroundColor = '#ffffff';
    try {
      const fullImg = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('img load failed'));
        image.src = result.dataUrl;
      });
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width  = fullImg.naturalWidth  || fullImg.width;
      sampleCanvas.height = fullImg.naturalHeight || fullImg.height;
      const sCtx = sampleCanvas.getContext('2d');
      if (sCtx) {
        sCtx.drawImage(fullImg, 0, 0);
        const cw = sampleCanvas.width;
        const ch = sampleCanvas.height;
        const samples = [
          sCtx.getImageData(0, 0, 1, 1).data,
          sCtx.getImageData(cw - 1, 0, 1, 1).data,
          sCtx.getImageData(0, ch - 1, 1, 1).data,
        ];
        const avgR = Math.round(samples.reduce((s, p) => s + p[0], 0) / samples.length);
        const avgG = Math.round(samples.reduce((s, p) => s + p[1], 0) / samples.length);
        const avgB = Math.round(samples.reduce((s, p) => s + p[2], 0) / samples.length);
        backgroundColor = `rgb(${avgR},${avgG},${avgB})`;
      }
    } catch (_) {
      backgroundColor = '#ffffff';
    }

    return { dataUrl: result.dataUrl, backgroundColor };
  } finally {
    _isCapturing = false;
    // Always restore Blink UI elements
    for (const { el, prevOpacity, prevTransition } of hiddenEls) {
      try {
        el.style.transition = prevTransition;
        el.style.opacity    = prevOpacity;
      } catch (e) {}
    }
    // Restart FullPage rAF animation if it was stopped for capture.
    if (_fullPageHighlightHidden) {
      showFullPageHighlight();
    }
    try {
      const currentActive = state.activeCoreItem;
      if (currentActive && currentActive.nodeType === 1) {
        applyCoreHighlightFromUrl(
          currentActive,
          String(state.lastExtractedMetadata?.activeHoverUrl || state.activeHoverUrl || '')
        );
      }
    } catch (e) {}
  }
}

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

/**
 * For Type A CoreItems whose activeHoverUrl is an Instagram post URL,
 * fetches the thumbnail via background.js and updates the tooltip image.
 */
function requestInstagramThumbnailForTypeA(coreItem, meta, clientX = null, clientY = null) {
  try {
    const activeHoverUrl = String(meta?.activeHoverUrl || '').trim();
    // Only process Instagram post URLs
    const instagramPostMatch = activeHoverUrl.match(
      /^https?:\/\/(?:www\.)?instagram\.com\/p\/([^/?#]+)\/?/i
    );
    if (!instagramPostMatch) return;
    // Skip if image already present
    if (meta?.image?.url) return;

    const shortcode = instagramPostMatch[1];
    if (!shortcode) return;

    // Deduplicate: skip if already in flight for this element + shortcode
    const alreadyRequestedFor = instagramFetchInFlightByElement.get(coreItem);
    if (alreadyRequestedFor === shortcode) return;
    instagramFetchInFlightByElement.set(coreItem, shortcode);

    chrome.runtime.sendMessage(
      { action: 'get-instagram-post-data', shortcode },
      (result) => {
        instagramFetchInFlightByElement.delete(coreItem);
        if (chrome.runtime.lastError || !result?.success) return;

        const thumbnailUrl = String(result?.thumbnailUrl || '').trim();
        if (!thumbnailUrl) return;

        // Verify the CoreItem is still the active one
        const activeMeta = state.lastExtractedMetadata;
        const stillActive =
          state.activeCoreItem === coreItem &&
          String(activeMeta?.activeHoverUrl || '').trim() === activeHoverUrl;
        if (!stillActive) return;

        // Update metadata with fetched thumbnail
        state.lastExtractedMetadata = {
          ...activeMeta,
          image: { ...(activeMeta?.image || {}), url: thumbnailUrl },
        };
        state.activeHoverUrl = String(activeMeta?.activeHoverUrl || '').trim() || state.activeHoverUrl;

        // Refresh tooltip with updated image
        if (!_isCapturing) {
          showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
        }
      }
    );
  } catch (e) {}
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
    if (IS_IFRAME) {
      postHighlightToTop('clear-core-item');
      state.activeCoreItem = null;
      state.activeHoverUrl = null;
      state.lastExtractedMetadata = null;
    } else {
      clearCoreSelection();
      initPageLevelMetadata();
    }
    _lastMouseoverTarget = null;
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
  const getRoleLinkHrefLocal = (el) =>
    String(el.getAttribute?.('data-href')     || '').trim() ||
    String(el.getAttribute?.('data-url')      || '').trim() ||
    String(el.getAttribute?.('data-link')     || '').trim() ||
    String(el.getAttribute?.('data-href-url') || '').trim();

  // Fallback: role="link" + URL-bearing data attributes
  if (container.getAttribute?.('role') === 'link' && getRoleLinkHrefLocal(container)) {
    return container;
  }
  const roleLinkEls = Array.from(
    container.querySelectorAll?.('[role="link"]') || []
  ).filter((el) => !!getRoleLinkHrefLocal(el));
  if (roleLinkEls.length > 0) return roleLinkEls[0];
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

    // Also accept role="link" + URL data attributes as valid anchor signal
    const roleLinkEl = target?.closest?.('[role="link"][data-href], [role="link"][data-url], [role="link"][data-link], [role="link"][data-href-url]');
    const hasRoleLink = !!roleLinkEl && !!coreItemContainer.contains?.(roleLinkEl);

    const hasPointerCursor =
      target && window.getComputedStyle ? window.getComputedStyle(target).cursor === 'pointer' : false;
    const shouldExit =
      (hasAnchor && !contained) ||
      (!hasAnchor && !hasRoleLink && !hasPointerCursor);
    if (shouldExit) {
      scheduleCoreClear();
      return false;
    }
  }

  // Type C: the hovered element itself is the CoreItem — no anchor traversal
  if (evidenceType === EVIDENCE_TYPE_C) {
    let mailUrl   = '';
    let mailTitle = '';
    let mailSender = '';

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
      // Extract sender — ordered fallback chain:
      // 1) span.yP[name] → name attribute (most reliable, Gmail standard)
      // 2) span.yP[email] → textContent
      // 3) any span[email] inside td.yX → name or textContent
      // 4) first span[email] anywhere in CoreItem → name or textContent
      try {
        const yPEl = coreItemContainer.querySelector?.('span.yP[name]')
          || coreItemContainer.querySelector?.('span.yP[email]');
        if (yPEl) {
          mailSender = yPEl.getAttribute?.('name')?.trim()
            || yPEl.textContent?.trim()
            || '';
        }
        if (!mailSender) {
          const tdSenderEl = coreItemContainer.querySelector?.('td.yX span[email]');
          mailSender = tdSenderEl?.getAttribute?.('name')?.trim()
            || tdSenderEl?.textContent?.trim()
            || '';
        }
        if (!mailSender) {
          const anyEmailEl = coreItemContainer.querySelector?.('span[email]');
          mailSender = anyEmailEl?.getAttribute?.('name')?.trim()
            || anyEmailEl?.textContent?.trim()
            || '';
        }
      } catch (_) {}

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
      // Extract sender from button.button_sender — text nodes only (exclude .blind span)
      try {
        const senderBtn = coreItemContainer.querySelector?.('button.button_sender');
        if (senderBtn) {
          mailSender = Array.from(senderBtn.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => String(n.textContent || '').trim())
            .filter(Boolean)
            .join('') || '';
        }
      } catch (_) {}
    }

    cancelPendingClear();
    state.activeCoreItem = coreItemContainer;
    state.activeHoverUrl = mailUrl;

    let mailCategory      = '';
    let mailPlatform      = '';
    let mailConfirmedType = '';
    if (mailUrl) {
      try {
        const mailCatResult = detectItemCategory(mailUrl, window.location.href, null);
        mailCategory      = mailCatResult?.category      || '';
        mailPlatform      = mailCatResult?.platform      || '';
        mailConfirmedType = mailCatResult?.confirmedType || '';
      } catch (_) {}
    }

    state.lastExtractedMetadata = {
      activeHoverUrl: mailUrl,
      title:          mailTitle,
      ...(mailCategory      ? { category:      mailCategory }      : {}),
      ...(mailPlatform      ? { platform:      mailPlatform }      : {}),
      ...(mailConfirmedType ? { confirmedType: mailConfirmedType } : {}),
      sender: mailSender,
    };
    if (IS_IFRAME) {
      const coreRect = coreItemContainer.getBoundingClientRect?.();
      if (coreRect && coreRect.width > 0 && coreRect.height > 0) {
        const localRect = {
          top: coreRect.top,
          left: coreRect.left,
          width: coreRect.width,
          height: coreRect.height,
          right: coreRect.right,
        };
        postHighlightToTop('highlight-core-item', {
          rect: localRect,
          meta: state.lastExtractedMetadata,
        });
      }
      return true;
    }
    hideFullPageHighlight();
    applyCoreHighlightFromUrl(coreItemContainer, mailUrl);
    if (!_isCapturing) {
      showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
    }
    return true;
  }

  const platformForB = evidenceType === 'B' ? getCurrentPlatform() : '';

  // LinkedIn Type B detection is disabled until dedicated URL/image extraction
  // logic is implemented. Fall through to scheduleCoreClear() to avoid
  // showing an incorrect CoreItem highlight or saving the wrong URL.
  if (evidenceType === 'B' && platformForB === 'LINKEDIN') {
    scheduleCoreClear();
    return false;
  }

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
    const itemMapElementsSet = new Set(
      (Array.isArray(state.itemMap) ? state.itemMap : [])
        .map((x) => x?.element)
        .filter(Boolean)
    );
    coreItem = await resolveTypeACoreItem(coreItemContainer, effectiveTarget, itemMapElementsSet);
    // Guard rail: if the resolved coreItem does not contain target, reject it.
    // This catches cases where resolveTypeACoreItem() returns a childWithClosest
    // that target is not actually inside.
    if (coreItem && coreItem !== coreItemContainer && !coreItem.contains?.(target)) {
      scheduleCoreClear();
      return false;
    }
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
      hideFullPageHighlight();
      applyCoreHighlightFromUrl(active, String(state.lastExtractedMetadata?.activeHoverUrl || state.activeHoverUrl || ''));
      if (!_isCapturing) {
        if (isFinite(Number(clientX)) && isFinite(Number(clientY))) {
          positionMetadataTooltip(clientX, clientY);
        }
      }
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
  // Detect category at hover time so it can be included in the save payload
  if (syncedMeta.activeHoverUrl) {
    try {
      const htmlCtx = extractCoreItemHtmlContext(coreItem);
      const { category, platform, confirmedType } = detectItemCategory(
        syncedMeta.activeHoverUrl,
        window.location.href,
        htmlCtx
      );
      syncedMeta = { ...syncedMeta, category };
      if (platform)      syncedMeta = { ...syncedMeta, platform };
      if (confirmedType) syncedMeta = { ...syncedMeta, confirmedType };
    } catch (e) {}
  }
  if (IS_IFRAME) {
    const coreRect = coreItem.getBoundingClientRect ? coreItem.getBoundingClientRect() : null;
    if (coreRect && coreRect.width > 0 && coreRect.height > 0) {
      const localRect = {
        top: coreRect.top,
        left: coreRect.left,
        width: coreRect.width,
        height: coreRect.height,
        right: coreRect.right,
      };
      postHighlightToTop('highlight-core-item', {
        rect: localRect,
        meta: syncedMeta,
      });
    }
    state.activeCoreItem = coreItem;
    state.activeHoverUrl = syncedMeta.activeHoverUrl;
    state.lastExtractedMetadata = syncedMeta;
    if (evidenceType === 'B') {
      requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, clientX, clientY);
    }
    return true;
  }
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  hideFullPageHighlight();
  applyCoreHighlightFromUrl(coreItem, syncedMeta.activeHoverUrl);
  if (!_isCapturing) {
    showMetadataTooltip(state.lastExtractedMetadata, clientX, clientY);
  }
  if (evidenceType === 'B') {
    requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, clientX, clientY);
  }
  if (evidenceType === 'A') {
    requestInstagramThumbnailForTypeA(coreItem, state.lastExtractedMetadata, clientX, clientY);
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

function schedulePreScan(scope = document, force = false) {
  if (scanTimer) return;
  // Use requestIdleCallback so detectItemMaps() only runs when the browser
  // is idle — this prevents it from blocking rAF-based overlay animations.
  // timeout: 2000 ensures it still runs within 2 seconds even if the browser
  // stays busy (e.g. on heavy pages like YouTube).
  const idleCallback = async () => {
    scanTimer = 0;
    // Clear navigation flag — this scan is now running, so the next
    // MutationObserver trigger should use scoped scan again.
    _forceFullScanOnMutation = false;
    const isFullScan = scope === document;
    const newCandidates = await detectItemMaps(scope);
    let candidates;
    if (isFullScan) {
      // Full scan: detectItemMaps() already updated state.itemMap — use as-is.
      candidates = newCandidates;
    } else {
      // Scoped scan: merge new candidates with existing items outside the scope.
      // detectItemMaps() did not overwrite state.itemMap when root !== document,
      // so we merge here and update state.itemMap manually.
      const existing = Array.isArray(state.itemMap) ? state.itemMap : [];
      const outsideScope = existing.filter(
        (item) => item?.element && !scope.contains(item.element)
      );
      candidates = [...outsideScope, ...newCandidates];
      state.itemMap = candidates;
    }
    const attrAwarePart = Array.isArray(candidates)
      ? candidates
          .map((c) => `${c.signature || c.key || ''}`)
          .sort()
          .slice(0, 80)
          .join('|')
      : '';
    const fp = `${getItemMapFingerprint(candidates)}::${attrAwarePart}`;
    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;
    renderItemMapCandidates(candidates);

    // Retry logic: when a forced full-document scan finds no candidates,
    // schedule another forced scan after 500ms (up to 3 retries).
    // This handles SPA frameworks (e.g. Vue keep-alive) that restore DOM
    // asynchronously after navigation — the first scan may run before
    // the framework has finished mounting the list.
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 500;
    if (force && isFullScan && candidates.length === 0 && _retryScanCount < MAX_RETRIES) {
      _retryScanCount += 1;
      if (_retryScanTimer) window.clearTimeout(_retryScanTimer);
      _retryScanTimer = window.setTimeout(() => {
        _retryScanTimer = 0;
        if (scanTimer) {
          if (typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(scanTimer);
          } else {
            window.clearTimeout(scanTimer);
          }
          scanTimer = 0;
        }
        schedulePreScan(document, true);
      }, RETRY_DELAY_MS);
    }
  };
  if (typeof window.requestIdleCallback === 'function') {
    scanTimer = window.requestIdleCallback(idleCallback, { timeout: 2000 });
  } else {
    // Fallback for browsers that do not support requestIdleCallback (e.g. Safari)
    scanTimer = window.setTimeout(idleCallback, 80);
  }
}

function mountObservers() {
  function registerObserver(isRecovery = false) {
    const targetNode = window.document.documentElement || window.document.body;
    if (!targetNode) return;

    const obs = new MutationObserver((mutations) => {
      // Only call schedulePreScan() when a meaningful content node is added.
      // Non-visual tags and text/comment nodes do not affect ItemMap detection.
      const NON_VISUAL_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT']);
      // On YouTube, all mutations inside #video-preview are thumbnail preview
      // rendering and are unrelated to ItemMap detection — skip them entirely.
      const isYouTube = /^https:\/\/www\.youtube\.com(\/|$)/.test(
        String(window.location.href || '')
      );
      for (const mutation of mutations) {
        if (isYouTube && mutation.target?.closest?.('#video-preview')) continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (NON_VISUAL_TAGS.has(String(node.tagName || '').toUpperCase())) continue;
          // Skip DOM changes inside #video-preview and ytd-miniplayer —
          // these are YouTube's thumbnail preview and miniplayer overlays
          // which are unrelated to ItemMap detection.
          // Other ytd-app subtree changes (e.g. PiP transition, related videos)
          // are allowed through so ItemMap re-scans correctly.
          if (node.closest?.('#video-preview') || node.closest?.('ytd-miniplayer')) continue;
          // After a SPA navigation, always run a full document scan with force=true
          // so that frameworks like Vue that re-render the full list are correctly detected.
          // Otherwise, use the added node's parentElement as scope for efficiency.
          if (_forceFullScanOnMutation) {
            _forceFullScanOnMutation = false;
            schedulePreScan(document, true);
          } else {
            // Mail pages (Naver Mail, Gmail) require full document scan for
            // Type C detection (li.mail_item, table.F.cf.zt).
            // All other pages use scoped scan (added node's parentElement)
            // to avoid scanning the entire DOM on every mutation —
            // which causes rAF jank on complex pages like YouTube and Claude.
            const href = String(window?.location?.href || '');
            const isMailPage =
              /^https:\/\/mail\.naver\.com\//.test(href) ||
              /^https:\/\/mail\.google\.com\//.test(href);
            if (isMailPage) {
              schedulePreScan(document);
            } else {
              const scope = (node.parentElement && node.parentElement !== document.documentElement)
                ? node.parentElement
                : document;
              schedulePreScan(scope);
            }
          }
          return;
        }
      }
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
  return { url, title };
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

    const getMinimalMediaContainerRect = (img, boundary) => {
      try {
        const isMeaningfulSibling = (el) => {
          try {
            if (!el || el.nodeType !== 1) return false;
            if (el === img) return false;
            const tag = String(el.tagName || '').toUpperCase();
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) return false;
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || (r.width <= 0 && r.height <= 0)) return false;
            const hasChildren = el.children && el.children.length > 0;
            const hasText = (el.textContent || '').trim().length > 0;
            if (!hasChildren && !hasText) return false;
            return true;
          } catch (e) {
            return false;
          }
        };

        let current = img;
        let bestRect = img.getBoundingClientRect ? img.getBoundingClientRect() : null;

        while (current && current !== boundary && current.parentElement && current.parentElement !== boundary) {
          const parent = current.parentElement;
          const siblings = Array.from(parent.children || []).filter((c) => c !== current);
          const hasMeaningfulSibling = siblings.some(isMeaningfulSibling);
          if (hasMeaningfulSibling) break;
          const pr = parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
          if (pr && (pr.width > 0 || pr.height > 0)) bestRect = pr;
          current = parent;
        }

        if (bestRect && (bestRect.width < 10 || bestRect.height < 10) && img.parentElement) {
          const pr = img.parentElement.getBoundingClientRect?.();
          if (pr && pr.width >= 10 && pr.height >= 10) return pr;
        }

        return bestRect;
      } catch (e) {
        return img.getBoundingClientRect ? img.getBoundingClientRect() : null;
      }
    };

    // Collect images with size info (visually significant only)
    const images = Array.from(element.querySelectorAll('img')).map((img) => {
      const r = getMinimalMediaContainerRect(img, element);
      const rectW = r?.width  || 0;
      const rectH = r?.height || 0;
      // Fallback: when getBoundingClientRect() returns an incomplete size
      // (e.g. height:auto not yet computed, or container clipping),
      // use naturalWidth/naturalHeight or data-thumb-* attributes.
      const fallbackW = img.naturalWidth  || Number(img.getAttribute('data-thumb-width'))  || 0;
      const fallbackH = img.naturalHeight || Number(img.getAttribute('data-thumb-height')) || 0;
      const w = rectW > 10 ? Math.round(rectW) : Math.round(fallbackW);
      const h = rectH > 10 ? Math.round(rectH) : Math.round(fallbackH);
      return {
        src:    (img.src || img.getAttribute('data-src') || '').substring(0, 200),
        width:  w,
        height: h,
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

async function getCachedUserIdForShutter() {
  try {
    const r = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    });
    if (r?.userId) return r.userId;
    await new Promise((res) => setTimeout(res, 150));
    const r2 = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-cached-user-id' }, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    });
    return r2?.userId || null;
  } catch {
    return null;
  }
}

async function isBlinkLocalServerReachable() {
  try {
    const res = await fetch('http://localhost:3000/api/v1/extension/status', {
      method: 'GET',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** `'success'` | `'error'` — passed to `triggerShutterEffect` for green/red shutter + status badge. */
async function resolveSaveShutterStatus() {
  const [uid, serverOk] = await Promise.all([
    getCachedUserIdForShutter(),
    isBlinkLocalServerReachable(),
  ]);
  return uid && serverOk ? 'success' : 'error';
}

async function saveActiveCoreItem(request = {}) {
  const saveFeedbackHidden = hideBlinkSaveFeedbackUi();
  const saveBlinkStartedAt = Date.now();
  try {
    const saveShutterStatus = await resolveSaveShutterStatus();
    const activeItem = state.activeCoreItem;
    const activeUrl = String(state.activeHoverUrl || '').trim();

    // No CoreItem active → save current page via OpenGraph metadata
    if (!activeItem || !activeUrl) {
      // Step 1: hide overlays immediately
      const PAGE_BLINK_UI_IDS = [
        'blink-highlight-overlay',
        'blink-metadata-tooltip',
        'blink-green-candidate-layer',
        'blink-fullpage-highlight-overlay',
      ];
      const pageShutterHiddenEls = [];
      for (const id of PAGE_BLINK_UI_IDS) {
        try {
          const el = document.getElementById(id);
          if (el && el.style.display !== 'none') {
            pageShutterHiddenEls.push({ el, prevOpacity: el.style.opacity });
            el.style.transition = '';
            el.style.opacity = '0';
          }
        } catch (e) {}
      }

      const { url, title } = extractPageOpenGraphMeta();
      if (!url) {
        // Restore overlays synchronously before early return
        for (const { el, prevOpacity } of pageShutterHiddenEls) {
          try {
            el.style.transition = '';
            el.style.opacity = prevOpacity !== '' ? prevOpacity : '1';
          } catch (e) {}
        }
        return { success: false, reason: 'missing-url' };
      }

      let pageScreenshotBase64 = null;
      let pageScreenshotBgColor = null;
      // capturePageScreenshotBase64 handles waitForRepaint + 32ms internally
      const pageScreenshotResult = await capturePageScreenshotBase64();
      if (pageScreenshotResult) {
        pageScreenshotBase64 = pageScreenshotResult.dataUrl;
        pageScreenshotBgColor = pageScreenshotResult.backgroundColor;
      }

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

      // Gmail: fetch auth token so server can read mail content
      let gmailToken = null;
      if (url.startsWith('https://mail.google.com/')) {
        gmailToken = await getGmailAuthToken();
      }

      // Naver Mail: collect login cookies for server-side Puppeteer injection
      let naverCookies = null;
      if (url.startsWith('https://mail.naver.com/')) {
        naverCookies = await getNaverCookies();
      }

      const pageCategory      = String(state.lastExtractedMetadata?.category      || '').trim();
      const pagePlatform      = String(state.lastExtractedMetadata?.platform      || '').trim();
      const pageConfirmedType = String(state.lastExtractedMetadata?.confirmedType || '').trim();
      const payload = {
        url,
        title: title || url,
        timestamp: Date.now(),
        saved_by: 'browser-extension',
        userLanguage: navigator.language || 'en',
        page_save: true,
        ...(pageScreenshotBase64 ? { screenshot_base64: pageScreenshotBase64 } : {}),
        ...(pageScreenshotBgColor ? { screenshot_bg_color: pageScreenshotBgColor } : {}),
        ...(pageCategory      ? { category:       pageCategory }      : {}),
        ...(pagePlatform      ? { platform:        pagePlatform }      : {}),
        ...(pageConfirmedType ? { confirmed_type:  pageConfirmedType } : {}),
        ...(userId ? { userId } : {}),
        ...(gmailToken ? { gmail_token: gmailToken } : {}),
        ...(naverCookies ? { naver_cookies: naverCookies } : {}),
      };

      // Optimistic UI: notify Side Panel to show a temporary card immediately
      // Skip if running inside an iframe — only the top-level frame should create optimistic cards
      if (window.self === window.top) {
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
          chrome.runtime.sendMessage({
            action:            'optimistic-card',
            tempId,
            url,
            title:             title || url,
            imgUrl:            pageScreenshotBase64 || '',
            isScreenshot:      !!pageScreenshotBase64,
            screenshotPadding: 0,
            screenshotBgColor: pageScreenshotBgColor || '',
            category:          pageCategory || '',
            platform:          pagePlatform || '',
            confirmedType:     pageConfirmedType || '',
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

      // Immediately update _savedUrlSet so checkIsSavedSync() returns true
      // before the saved-urls-updated chain completes.
      try {
        const savedUrl = normalizeUrlForSavedCheck(url);
        if (savedUrl) _savedUrlSet.add(savedUrl);
      } catch (e) {}

      triggerShutterEffect('page', saveShutterStatus);

      for (const { el, prevOpacity } of pageShutterHiddenEls) {
        try {
          el.style.opacity = prevOpacity !== '' ? prevOpacity : '1';
        } catch (e) {}
      }

      return { success: true, payload };
    }

    // CoreItem active → existing logic
    const meta = state.lastExtractedMetadata;
    const url = String(meta?.activeHoverUrl || activeUrl).trim();
    if (!url) return { success: false, reason: 'missing-url' };

    // Step 1: hide overlays immediately on shortcut press
    const BLINK_UI_IDS = [
      'blink-highlight-overlay',
      'blink-metadata-tooltip',
      'blink-green-candidate-layer',
      'blink-fullpage-highlight-overlay',
    ];
    const shutterHiddenEls = [];
    for (const id of BLINK_UI_IDS) {
      try {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') {
          shutterHiddenEls.push({ el, prevOpacity: el.style.opacity });
          el.style.transition = '';
          el.style.opacity = '0';
        }
      } catch (e) {}
    }

    const title = String(meta?.title || document.title || url).trim();
    const imgUrl = String(request?.img_url || meta?.image?.url || '').trim();

    const relayScreenshotBase64 = meta?._screenshotBase64 || null;
    const relayScreenshotBgColor = meta?._screenshotBgColor || null;

    let screenshotBase64 = null;
    let screenshotBgColor = null;
    let screenshotPadding = 0;
    const isMail = meta?.category === 'Mail';
    const isPage = meta?.category === 'Page';
    if (isMail) {
      // Mail items: skip screenshot entirely — no img_url, no screenshot
      await waitForRepaint();
      await new Promise((resolve) => setTimeout(resolve, 32));
    } else if (relayScreenshotBase64) {
      // Relay screenshot already captured — apply minimum wait for UX consistency
      screenshotBase64 = relayScreenshotBase64;
      screenshotBgColor = relayScreenshotBgColor;
      await waitForRepaint();
      await new Promise((resolve) => setTimeout(resolve, 32));
    } else if (activeItem && activeItem.nodeType === 1 && (!imgUrl || isPage)) {
      // Capture screenshot when:
      // - no imgUrl present (any category), OR
      // - category is 'Page' (always capture even if imgUrl exists)
      //
      // For CoreItem screenshots, find the minimum content container
      // to avoid capturing unnecessary padding/whitespace from the CoreItem root.
      // Page screenshots (capturePageScreenshotBase64) are NOT affected.
      const { container: captureTarget, paddingValue: screenshotPaddingValue } =
        findMinContentContainer(activeItem);
      const screenshotResult = await captureScreenshotBase64(captureTarget);
      if (screenshotResult) {
        screenshotBase64 = screenshotResult.dataUrl;
        screenshotBgColor = screenshotResult.backgroundColor;
        screenshotPadding = screenshotPaddingValue;
      }
    } else {
      // imgUrl already present and not a Page — no capture needed
      await waitForRepaint();
      await new Promise((resolve) => setTimeout(resolve, 32));
    }

    triggerShutterEffect('core', saveShutterStatus);

    for (const { el, prevOpacity } of shutterHiddenEls) {
      try {
        el.style.opacity = prevOpacity !== '' ? prevOpacity : '1';
      } catch (e) {}
    }

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

    // Gmail: fetch auth token so server can read mail content
    let gmailToken = null;
    if (url.startsWith('https://mail.google.com/')) {
      gmailToken = await getGmailAuthToken();
    }

    // Naver Mail: collect login cookies for server-side Puppeteer injection
    let naverCookies = null;
    if (url.startsWith('https://mail.naver.com/')) {
      naverCookies = await getNaverCookies();
    }

    // Extract HTML context from the active CoreItem for AI type inference
    const htmlContext = extractCoreItemHtmlContext(activeItem);

    const payload = {
      url,
      title: title || url,
      timestamp: Date.now(),
      saved_by: 'browser-extension',
      userLanguage: navigator.language || 'en',
      pageUrl: meta?._pageUrl || window.location.href,
      ...(htmlContext ? { htmlContext } : {}),
      ...(imgUrl ? { img_url: imgUrl } : {}),
      ...(screenshotBase64 ? { screenshot_base64: screenshotBase64 } : {}),
      ...(screenshotBgColor ? { screenshot_bg_color: screenshotBgColor } : {}),
      ...(screenshotBase64 && screenshotPadding > 0 ? { screenshot_padding: screenshotPadding } : {}),
      ...(userId ? { userId } : {}),
      ...(meta?.category      ? { category:       meta.category }      : {}),
      ...(meta?.platform      ? { platform:        meta.platform }      : {}),
      ...(meta?.confirmedType ? { confirmed_type:  meta.confirmedType } : {}),
      sender: meta?.sender ?? '',
      ...(gmailToken ? { gmail_token: gmailToken } : {}),
      ...(naverCookies ? { naver_cookies: naverCookies } : {}),
    };

    // Optimistic UI: notify Side Panel to show a temporary card immediately
    // Skip if running inside an iframe — only the top-level frame should create optimistic cards
    if (window.self === window.top) {
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        // For Page category, screenshot takes priority over OG image
        const isScreenshot = !!screenshotBase64 && (!imgUrl || isPage);
        chrome.runtime.sendMessage({
          action:             'optimistic-card',
          tempId,
          url,
          title:              title || url,
          imgUrl:             isPage && screenshotBase64 ? screenshotBase64 : (imgUrl || screenshotBase64 || ''),
          isScreenshot,
          screenshotPadding,
          screenshotBgColor:  screenshotBgColor || '',
          category:           String(meta?.category      || '').trim(),
          platform:           String(meta?.platform      || '').trim(),
          confirmedType:      String(meta?.confirmedType || '').trim(),
          sender:             String(meta?.sender        || '').trim(),
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

    // Immediately update _savedUrlSet so checkIsSavedSync() returns true
    // before the saved-urls-updated chain completes.
    try {
      const savedUrl = normalizeUrlForSavedCheck(url);
      if (savedUrl) _savedUrlSet.add(savedUrl);
    } catch (e) {}

    return { success: true, payload };
  } finally {
    await finalizeSaveFeedbackBlink(saveFeedbackHidden, saveBlinkStartedAt);
  }
}

function mountSaveMessageListener() {
  if (window.__blinkSaveMessageListenerMounted) return;
  if (!chrome?.runtime?.onMessage?.addListener) return;
  window.__blinkSaveMessageListenerMounted = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === 'saved-urls-updated') {
      chrome.runtime.sendMessage({ action: 'get-saved-urls' }, (response) => {
        if (chrome.runtime.lastError) return;
        const entries = response?.urls;
        if (Array.isArray(entries)) {
          const normalized = normalizeSavedUrlsResponse(entries);
          _savedUrlSet = new Set(normalized);
        }
        try {
          const activeUrl = String(state.activeHoverUrl || '').trim();
          const pageUrl = String(window.location.href || '').trim();
          if (IS_IFRAME) {
            postHighlightToTop('resync-saved-badge', { url: activeUrl || pageUrl });
          } else if (activeUrl) {
            applyCoreHighlightState(checkIsSavedSync(activeUrl));
          } else {
            applyFullPageHighlightFromUrl(pageUrl);
          }
        } catch (e) {}
      });
      return false;
    }
    if (request?.action !== 'save-url') return false;

    // Iframes must never handle save-url directly — only via BLINK_SAVE_QUERY postMessage.
    // Fetching localhost from a cross-origin iframe is blocked by CORS.
    if (IS_IFRAME) return false;

    (async () => {
      try {
        if (!state.activeCoreItem && !state.activeHoverUrl) {
          // Attempt to re-identify CoreItem at current pointer position.
          // This handles the case where clear grace timer fired between the
          // keyboard shortcut and the save-url message arriving.
          try {
            const x = Number(lastPointerX);
            const y = Number(lastPointerY);
            if (isFinite(x) && isFinite(y)) {
              const pointerEl = document.elementFromPoint(x, y);
              if (pointerEl) {
                await updateCoreSelectionFromTarget(pointerEl, x, y);
              }
            }
          } catch (e) {}
        }

        // If top frame has no active CoreItem, check if any iframe does
        if (!state.activeCoreItem && !state.activeHoverUrl) {
          let iframeHandled = false;
          let iframeRelayData = null;

          const handleIframeResponse = (e) => {
            try {
              if (!e.data || !e.data[BLINK_MSG_PREFIX] || e.data[BLINK_SAVE_HANDLED] !== true) return;
              iframeHandled = true;
              if (e.data[BLINK_SAVE_RELAY] === true) {
                iframeRelayData = e.data;
              }
            } catch (e) {}
          };
          window.addEventListener('message', handleIframeResponse, { passive: true });

          try {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            for (const iframe of iframes) {
              try {
                iframe.contentWindow?.postMessage(
                  { [BLINK_MSG_PREFIX]: true, [BLINK_SAVE_QUERY]: true },
                  '*'
                );
              } catch (e) {}
            }
          } catch (e) {}

          await new Promise((resolve) => setTimeout(resolve, 80));
          window.removeEventListener('message', handleIframeResponse);

          if (iframeHandled && iframeRelayData) {
            const prevActiveCoreItem = state.activeCoreItem;
            const prevActiveHoverUrl = state.activeHoverUrl;
            const prevLastExtractedMetadata = state.lastExtractedMetadata;
            try {
              const relayRequest = {
                img_url: iframeRelayData.imgUrl || '',
              };
              state.activeCoreItem = {};
              state.activeHoverUrl = iframeRelayData.url || '';
              state.lastExtractedMetadata = {
                activeHoverUrl: iframeRelayData.url || '',
                title: iframeRelayData.title || '',
                category: iframeRelayData.category || '',
                confirmedType: iframeRelayData.confirmedType || '',
                image: iframeRelayData.imgUrl ? { url: iframeRelayData.imgUrl } : null,
                _screenshotBase64: iframeRelayData.screenshotBase64 || null,
                _screenshotBgColor: iframeRelayData.screenshotBgColor || null,
                _pageUrl: iframeRelayData.pageUrl || '',
                _isIframeRelay: true,
              };

              const result = await saveActiveCoreItem(relayRequest);
              sendResponse(result);
            } catch (err) {
              sendResponse({ success: false, error: String(err?.message || err) });
            } finally {
              state.activeCoreItem = prevActiveCoreItem;
              state.activeHoverUrl = prevActiveHoverUrl;
              state.lastExtractedMetadata = prevLastExtractedMetadata;
            }
            return;
          }

          if (iframeHandled) {
            sendResponse({ success: true, handledByIframe: true });
            return;
          }
        }

        const result = await saveActiveCoreItem(request);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: String(error?.message || error) });
      }
    })();

    return true;
  });

  if (IS_IFRAME) {
    window.addEventListener(
      'message',
      async (e) => {
        try {
          if (!e.data || !e.data[BLINK_MSG_PREFIX] || e.data[BLINK_SAVE_QUERY] !== true) return;
          const activeItem = state.activeCoreItem;
          const activeUrl = String(state.activeHoverUrl || '').trim();
          if (!activeItem || !activeUrl) return;

          const saveFeedbackHidden = hideBlinkSaveFeedbackUi();
          const saveBlinkStartedAt = Date.now();
          try {
            const saveShutterStatus = await resolveSaveShutterStatus();
            triggerShutterEffect('core', saveShutterStatus);
            await waitForRepaint();

            const meta = state.lastExtractedMetadata || {};
            const imgUrl = String(meta?.image?.url || '').trim();

            let screenshotBase64 = null;
            let screenshotBgColor = null;
            if (!imgUrl && activeItem && activeItem.nodeType === 1) {
              const screenshotResult = await captureScreenshotBase64(activeItem);
              if (screenshotResult) {
                screenshotBase64 = screenshotResult.dataUrl;
                screenshotBgColor = screenshotResult.backgroundColor;
              }
            }

            window.top.postMessage(
              {
                [BLINK_MSG_PREFIX]: true,
                [BLINK_SAVE_HANDLED]: true,
                [BLINK_SAVE_RELAY]: true,
                url: activeUrl,
                title: String(meta?.title || '').trim(),
                imgUrl,
                screenshotBase64,
                screenshotBgColor,
                category: String(meta?.category || '').trim(),
                confirmedType: String(meta?.confirmedType || '').trim(),
                pageUrl: String(window.location.href || '').trim(),
              },
              '*'
            );
          } finally {
            await finalizeSaveFeedbackBlink(saveFeedbackHidden, saveBlinkStartedAt);
          }
        } catch (err) {}
      },
      { passive: true }
    );
  }
}

function mountWindowListeners() {
  if (window.__blinkWindowListenersMounted) return;
  window.__blinkWindowListenersMounted = true;

  window.addEventListener('load', schedulePreScan, { passive: true });
  window.addEventListener('scroll', async () => {
    const active = state.activeCoreItem;

    // Mirrors uiManager _coreOverlayActive (not exported); opacity is the source of truth here.
    const _coreOverlayActive =
      document.getElementById('blink-highlight-overlay')?.style?.opacity === '1';

    // iframe CoreHighlight scroll: recalculate resolved rect using current iframe offset
    if (!active && _coreOverlayActive && _activeSourceIframe && _lastIframeLocalRect) {
      try {
        const ifr = _activeSourceIframe.getBoundingClientRect();
        const updatedRect = {
          top: _lastIframeLocalRect.top + ifr.top,
          left: _lastIframeLocalRect.left + ifr.left,
          width: _lastIframeLocalRect.width,
          height: _lastIframeLocalRect.height,
          right: _lastIframeLocalRect.right + ifr.left,
        };
        applyCoreHighlightFromUrl(
          null,
          String(state.lastExtractedMetadata?.activeHoverUrl || state.activeHoverUrl || ''),
          updatedRect
        );
      } catch (e) {}
      return;
    }

    if (!active) return;
    // Compute current rect for the active CoreItem and pass it as rectOverride
    // so showPurpleHighlight() treats this as a scroll update (isScrollUpdate = true),
    // skipping updateBorderSvg() and animation restart.
    const scrollRect = active.getBoundingClientRect?.();
    const rectOverride = scrollRect && scrollRect.width > 0 && scrollRect.height > 0
      ? { top: scrollRect.top, left: scrollRect.left, width: scrollRect.width, height: scrollRect.height, right: scrollRect.right }
      : null;
    // Keep highlight stable while scrolling, even before next hover event.
    applyCoreHighlightFromUrl(
      active,
      String(state.lastExtractedMetadata?.activeHoverUrl || state.activeHoverUrl || ''),
      rectOverride
    );
    scheduleCoreClear();
  }, { passive: true, capture: true });
  window.addEventListener('resize', schedulePreScan, { passive: true });
  window.addEventListener('mouseover', async (e) => {
    lastPointerX = e?.clientX ?? lastPointerX;
    lastPointerY = e?.clientY ?? lastPointerY;
    const target = e?.target && e.target.nodeType === 1 ? e.target : null;
    if (target === _lastMouseoverTarget) return;
    _lastMouseoverTarget = target;
    // On YouTube, ignore mouseover events whose target is inside #video-preview —
    // the preview overlay renders on top of thumbnails and intercepts mouse events,
    // causing CoreHighlight to be incorrectly dismissed.
    if (
      target?.closest?.('#video-preview') &&
      /^https:\/\/www\.youtube\.com(\/|$)/.test(String(window.location.href || ''))
    ) return;
    // Skip if the target is inside the already-active CoreItem —
    // no highlight change is needed and scheduleCoreClear must not fire.
    const active = state.activeCoreItem;
    if (active && target && active.contains(target)) return;
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

  // ── SPA navigation detection ──────────────────────────────────────────────
  // Forces a full document re-scan when the URL changes without a page reload.
  // Resets lastFingerprint and cancels any pending scanTimer so the new page's
  // content is always scanned from scratch.
  function resetAndFullScan() {
    // Cancel any pending idle/timeout scan before scheduling a new one
    if (scanTimer) {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(scanTimer);
      } else {
        window.clearTimeout(scanTimer);
      }
      scanTimer = 0;
    }
    // Cancel any pending retry and reset counter for this new navigation
    if (_retryScanTimer) {
      window.clearTimeout(_retryScanTimer);
      _retryScanTimer = 0;
    }
    _retryScanCount = 0;
    lastFingerprint = '';
    _forceFullScanOnMutation = true;
    schedulePreScan(document, true);
  }

  // popstate: browser back/forward navigation
  window.addEventListener('popstate', resetAndFullScan, { passive: true });

  // hashchange: hash-only URL changes (e.g. Gmail folder switching #inbox → #sent)
  window.addEventListener('hashchange', resetAndFullScan, { passive: true });

  // yt-navigate-finish: YouTube's custom SPA navigation complete event.
  // Fires after YouTube has fully rendered the new page content — more accurate
  // than pushState which fires before rendering. Only active on youtube.com.
  window.addEventListener('yt-navigate-finish', () => {
    if (/^https:\/\/www\.youtube\.com(\/|$)/.test(String(window.location.href || ''))) {
      resetAndFullScan();
    }
  }, { passive: true });

  // pushState / replaceState: SPA routing (patch history methods)
  // Guard against double-patching if mountWindowListeners() is called again
  if (!window.__blinkHistoryPatched) {
    window.__blinkHistoryPatched = true;
    const _isYouTubeOrigin = () =>
      /^https:\/\/www\.youtube\.com(\/|$)/.test(String(window.location.href || ''));
    const _origPushState = history.pushState.bind(history);
    history.pushState = (...args) => {
      _origPushState(...args);
      // On YouTube, yt-navigate-finish handles the scan after rendering is complete.
      // Calling resetAndFullScan() here would scan before content is ready.
      if (!_isYouTubeOrigin()) resetAndFullScan();
    };
    const _origReplaceState = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      _origReplaceState(...args);
      if (!_isYouTubeOrigin()) resetAndFullScan();
    };
  }
}

function mountIframeSaveQueryListener() {
  if (window.__blinkIframeSaveQueryListenerMounted) return;
  window.__blinkIframeSaveQueryListenerMounted = true;
  window.addEventListener(
    'message',
    (e) => {
      try {
        if (!e.data || !e.data[BLINK_MSG_PREFIX] || e.data[BLINK_SAVE_HANDLED] !== true) return;
        // An iframe reported it handled the save — nothing to do in top frame
      } catch (e) {}
    },
    { passive: true }
  );
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
  mountInstagramShortcodeObserver();
  // Only show full-page highlight and init page metadata in the top frame.
  // iframe contexts still run CoreItem detection but must not render the
  // full-page overlay.
  if (window.self === window.top) {
    showFullPageHighlight();
    // Populate _savedUrlSet from background cache (restored from chrome.storage.local)
    // before running initPageLevelMetadata() so the first isSaved check is accurate.
    try {
      chrome.runtime.sendMessage({ action: 'get-saved-urls' }, (response) => {
        if (!chrome.runtime.lastError && Array.isArray(response?.urls)) {
          const normalized = normalizeSavedUrlsResponse(response.urls);
          _savedUrlSet = new Set(normalized);
        }
        initPageLevelMetadata();
      });
    } catch (e) {
      initPageLevelMetadata();
    }
    mountIframeHighlightListener();
    mountIframeSaveQueryListener();
  }
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
    if (IS_IFRAME) {
      postHighlightToTop('clear-core-item');
      state.activeCoreItem = null;
      state.activeHoverUrl = null;
      state.lastExtractedMetadata = null;
    } else {
      clearCoreSelection();
      initPageLevelMetadata();
    }
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
      }
    }
    syncedMeta = withInstagramActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withLinkedInCanonicalActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withThreadsActiveHoverUrl(syncedMeta, coreItem);
    syncedMeta = withFacebookTimestampActiveHoverUrl(syncedMeta, coreItem);
  }
  // Detect category at hover time so it can be included in the save payload
  if (syncedMeta.activeHoverUrl) {
    try {
      const htmlCtx = extractCoreItemHtmlContext(coreItem);
      const { category, platform, confirmedType } = detectItemCategory(
        syncedMeta.activeHoverUrl,
        window.location.href,
        htmlCtx
      );
      syncedMeta = { ...syncedMeta, category };
      if (platform)      syncedMeta = { ...syncedMeta, platform };
      if (confirmedType) syncedMeta = { ...syncedMeta, confirmedType };
    } catch (e) {}
  }
  cancelPendingClear();
  if (IS_IFRAME) {
    const coreRect = coreItem.getBoundingClientRect ? coreItem.getBoundingClientRect() : null;
    let tipX = null;
    let tipY = null;
    if (coreRect && coreRect.width > 0 && coreRect.height > 0) {
      const localRect = {
        top: coreRect.top,
        left: coreRect.left,
        width: coreRect.width,
        height: coreRect.height,
        right: coreRect.right,
      };
      tipX = localRect.right;
      tipY = localRect.top;
      postHighlightToTop('highlight-core-item', {
        rect: localRect,
        meta: syncedMeta,
      });
    }
    state.activeCoreItem = coreItem;
    state.activeHoverUrl = syncedMeta.activeHoverUrl;
    state.lastExtractedMetadata = syncedMeta;
    if (evidenceType === 'B') {
      requestInstagramPostDataForTypeB(coreItem, state.lastExtractedMetadata, tipX, tipY);
    }
    return syncedMeta;
  }
  state.activeCoreItem = coreItem;
  state.activeHoverUrl = syncedMeta.activeHoverUrl;
  state.lastExtractedMetadata = syncedMeta;
  applyCoreHighlightFromUrl(coreItem, syncedMeta.activeHoverUrl);
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
window.__blinkMainLoaded = true; // Set AFTER mountLifecycle so background.js retry only fires once listeners are ready
```

### `browser-extension/chromium/sidepanel.js`

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
let activeCardItemId   = null;
let _isExplicitSignOut      = false;

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
const spAiBoard        = document.getElementById('sp-ai-board');
const spAiBoardEmpty   = document.getElementById('sp-ai-board-empty');
const spAiBoardContent = document.getElementById('sp-ai-board-content');
const spAiBoardLoading = document.getElementById('sp-ai-board-loading');
const spAiBoardTitle   = document.getElementById('sp-ai-board-title');
const spAiBoardBody    = document.getElementById('sp-ai-board-body');
const spAiBoardClose   = document.getElementById('sp-ai-board-close');

// ── Category section order ────────────────────────────────────────────────
const CATEGORY_ORDER = ['SNS', 'Image', 'Video', 'Mail', 'Page'];

/**
 * Returns the .sp-category-list element for the given category string, or null if unknown.
 */
function getCategoryList(category) {
  const cat = (category || '').trim();
  const known = ['SNS', 'Image', 'Video', 'Mail', 'Page'];
  if (!known.includes(cat)) return null;
  return document.querySelector(`.sp-category-list[data-category-list="${cat}"]`);
}

/**
 * Loads collapse state from chrome.storage.local.
 * Returns a map of { category: boolean } where true = collapsed.
 */
async function loadCategoryCollapseState() {
  try {
    return await new Promise((resolve) => {
      chrome.storage.local.get('blink_category_collapsed', (result) => {
        resolve(result?.blink_category_collapsed || {});
      });
    });
  } catch (e) {
    return {};
  }
}

/**
 * Saves collapse state for a single category to chrome.storage.local.
 */
async function saveCategoryCollapseState(category, isCollapsed) {
  try {
    const current = await loadCategoryCollapseState();
    current[category] = isCollapsed;
    chrome.storage.local.set({ blink_category_collapsed: current });
  } catch (e) {}
}

/**
 * Updates the count badge in each category section header.
 */
function updateCategoryCounts() {
  CATEGORY_ORDER.forEach((cat) => {
    const list = document.querySelector(`.sp-category-list[data-category-list="${cat}"]`);
    const section = list?.closest('.sp-category-section');
    const countEl = section?.querySelector('.sp-category-count');
    if (!countEl || !list) return;
    const count = list.querySelectorAll('.card-container:not([data-optimistic-card])').length;
    countEl.textContent = count > 0 ? count : '';
  });
}

/**
 * Attaches collapse toggle listeners to all category section headers.
 * Guards against double-attaching with a data attribute.
 */
function setupCategoryCollapseHandlers() {
  document.querySelectorAll('.sp-category-header').forEach((header) => {
    if (header.dataset.collapseAttached === 'true') return;
    header.dataset.collapseAttached = 'true';
    header.addEventListener('click', () => {
      const section = header.closest('.sp-category-section');
      if (!section) return;
      section.classList.toggle('collapsed');
      const cat = section.dataset.category;
      const isCollapsed = section.classList.contains('collapsed');
      saveCategoryCollapseState(cat, isCollapsed);
    });
  });
}

/**
 * Applies initial collapsed/expanded state to each category section.
 * Priority:
 *   1. If stored state exists for a category → use it
 *   2. If no stored state → collapse if count === 0, expand if count > 0
 */
async function applyCategoryCollapseStates() {
  const stored = await loadCategoryCollapseState();
  CATEGORY_ORDER.forEach((cat) => {
    const list = document.querySelector(`.sp-category-list[data-category-list="${cat}"]`);
    const section = list?.closest('.sp-category-section');
    if (!section) return;
    const count = list.querySelectorAll('.card-container').length;
    let shouldCollapse;
    if (Object.prototype.hasOwnProperty.call(stored, cat)) {
      // Use stored preference
      shouldCollapse = stored[cat];
    } else {
      // Default: collapse if no items
      shouldCollapse = count === 0;
    }
    if (shouldCollapse) {
      section.classList.add('collapsed');
    } else {
      section.classList.remove('collapsed');
    }
  });
}

// ── Auth: Google Sign-in via chrome.identity ──────────────────────────────────
async function signInWithGoogle() {
  showLoginError('');
  if (chrome?.storage?.local) {
    chrome.storage.local.remove('blinkExplicitSignOut').catch(() => {});
  }
  try {
    // 1. Get OAuth token from Chrome Identity API
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken(
        {
          interactive: true,
          scopes: [
            'openid',
            'email',
            'profile',
            'https://www.googleapis.com/auth/gmail.readonly',
          ],
        },
        (token) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(token);
          }
        }
      );
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
    _isExplicitSignOut = true;
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ blinkExplicitSignOut: true }).catch(() => {});
    }
    // Stop Firestore listeners before signing out to prevent permission errors
    stopListeners();
    // Revoke Chrome identity token
    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, resolve);
    });
    if (token) {
      await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
    }
    await firebaseSignOut(auth);
  } catch (err) {
    _isExplicitSignOut = false;
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
    syncSavedUrlsToSession(currentItems);
    if (!isSyncing) loadData();
    // Re-render ai board if active card's data was updated
    // AI board disabled
    // if (activeCardItemId) showAiBoardForItem(activeCardItemId);
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
  syncSavedUrlsToSession([]);
}

function syncSavedUrlsToSession(items) {
  try {
    const seen = new Set();
    const urls = (items || []).reduce((acc, item) => {
      const url = String(item.url || '').trim();
      if (!url || seen.has(url)) return acc;
      seen.add(url);
      acc.push(url);
      return acc;
    }, []);
    chrome.runtime.sendMessage({ action: 'set-saved-urls', urls }).catch?.(() => {});
  } catch (e) {}
}

// ── Auth state ────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    // Always sync userId to storage, regardless of Side Panel open state
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ blinkUserId: user.uid }).catch(() => {});
    }
    showDashboardScreen(user);
  } else {
    // Explicit sign-out — skip silent re-auth and go directly to login screen
    // Check both the in-memory flag (same session) and persisted storage (after panel reopen)
    const explicitSignOut = _isExplicitSignOut || await (async () => {
      try {
        const result = await chrome.storage.local.get('blinkExplicitSignOut');
        return !!result?.blinkExplicitSignOut;
      } catch { return false; }
    })();

    if (explicitSignOut) {
      _isExplicitSignOut = false;
      if (chrome?.storage?.local) {
        chrome.storage.local.remove('blinkUserId').catch(() => {});
      }
      showLoginScreen();
      return;
    }
    // Firebase session expired — attempt silent re-auth via cached Chrome Identity token.
    // interactive: false never shows any UI and only succeeds when a cached token exists
    // from a previous explicit login, so this will not auto-login first-time users.
    try {
      const token = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: false }, (t) => {
          if (chrome.runtime.lastError || !t) {
            reject(new Error(chrome.runtime.lastError?.message || 'No cached token'));
          } else {
            resolve(t);
          }
        });
      });
      const credential = GoogleAuthProvider.credential(null, token);
      await signInWithCredential(auth, credential);
      // onAuthStateChanged will fire again with the restored user — no further action needed here
    } catch {
      // Silent re-auth failed (first-time user or explicit sign-out) — show login screen
      if (chrome?.storage?.local) {
        chrome.storage.local.remove('blinkUserId').catch(() => {});
      }
      showLoginScreen();
    }
  }
});

// Show dashboard immediately if user was previously logged in,
// to avoid login screen flash while Firebase restores the session.
(async () => {
  try {
    const result = await chrome.storage.local.get('blinkUserId');
    if (result?.blinkUserId) {
      loginScreen.style.display    = 'none';
      dashboardScreen.style.display = 'flex';
    }
  } catch (e) {}
})();

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

function formatUrlForDisplay(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
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
  const imgUrl       = (item.img_url || '').trim();
  const escapedImgUrl = imgUrl.replace(/"/g, '&quot;');
  const screenshotBgColor = (item.screenshot_bg_color || '').trim();
  const isScreenshot = imgUrl.includes('/screenshots/') || !!item._isScreenshot;
  const isPageCategory = (item.category || '').trim() === 'Page';
  const isScreenshotWide = isScreenshot && isPageCategory;
  const directoryId  = item.directoryId && item.directoryId !== 'undefined' ? item.directoryId : '';
  const screenshotPadding = typeof item.screenshot_padding === 'number' && item.screenshot_padding > 0
    ? item.screenshot_padding : 0;

  // ── Mail card: full-width layout with favicon + sender + title ───────────
  const isMail = (item.category || '').trim() === 'Mail';
  if (isMail) {
    const mailSender  = (item.sender  || '').trim();
    const mailPlatform = (item.platform || '').trim(); // 'Gmail' | 'Naver' | 'Other'
    // Derive favicon domain from platform name for logo endpoint
    const faviconDomain = mailPlatform === 'Gmail'  ? 'google.com'
                        : mailPlatform === 'Naver'  ? 'naver.com'
                        : '';
    const faviconUrl = faviconDomain
      ? `http://localhost:3000/api/v1/logo/${faviconDomain}`
      : '';
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `
      <div id="${cardId}"
           class="data-card data-card--mail"
           data-url="${escapedUrl}"
           data-title="${escapedTitle}"
           data-type="${type}"
           data-img-url=""
           data-item-id="${itemId}"
           data-doc-id="${item.id || ''}"
           data-directory-id="${directoryId}">
        <div class="data-card-header">
          <div class="data-card-context">
            <span class="data-card-content-type">Mail</span>
            ${mailPlatform ? `<span class="data-card-type-separator">›</span><span class="data-card-detail-type">${esc(mailPlatform)}</span>` : ''}
          </div>
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
          </div>
        </div>
        <div class="data-card-mail-body">
          ${faviconUrl
            ? `<img src="${esc(faviconUrl)}" class="data-card-mail-favicon" alt="${esc(mailPlatform)}" onerror="this.style.display='none'">`
            : `<div class="data-card-mail-favicon data-card-mail-favicon--placeholder"></div>`
          }
          <div class="data-card-mail-info">
            ${mailSender
              ? `<span class="data-card-mail-sender">${esc(mailSender)}</span>`
              : ''
            }
            <span class="data-card-mail-title">${esc(displayTitle)}</span>
          </div>
        </div>
      </div>`;
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
         class="data-card${isScreenshotWide ? ' data-card--screenshot-wide' : ''}"
         data-url="${escapedUrl}"
         data-title="${escapedTitle}"
         data-type="${type}"
         data-img-url="${escapedImgUrl}"
         data-item-id="${itemId}"
         data-doc-id="${item.id || ''}"
         data-directory-id="${directoryId}">
      <!-- Header: context + delete -->
      <div class="data-card-header">
        <div class="data-card-context">
          ${(() => {
            const cat      = (item.category      || '').trim();
            const plat     = (item.platform       || '').trim();
            const conf     = (item.confirmed_type || '').trim();
            if (!cat) return '';
            const esc = (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const parts = [cat, plat, conf].filter(Boolean);
            if (parts.length === 1) {
              return `<span class="data-card-content-type">${esc(parts[0])}</span>`;
            }
            return parts
              .map((p, i) =>
                i === 0
                  ? `<span class="data-card-content-type">${esc(p)}</span>`
                  : `<span class="data-card-type-separator">›</span><span class="data-card-detail-type">${esc(p)}</span>`
              )
              .join('');
          })()}
        </div>
        ${deleteBtn}
      </div>
      <!-- Main: thumbnail only -->
      <div class="data-card-main">
        ${imgUrl ? `
        <div class="data-card-imgcontainer${isScreenshot ? ' is-screenshot' : ''}${isScreenshotWide ? ' is-screenshot-wide' : ''}"${(() => {
          const styles = [];
          if (isScreenshot && screenshotBgColor) styles.push(`background-color:${screenshotBgColor.replace(/"/g, '&quot;')}`);
          if (screenshotPadding > 0) styles.push(`padding-left:${screenshotPadding}px;padding-top:${screenshotPadding}px`);
          return styles.length > 0 ? ` style="${styles.join(';')}"` : '';
        })()}>
          <img src="${getProxiedImageUrl(imgUrl)}" alt="${escapedTitle}" class="data-card-image">
        </div>` : ''}
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
  card.dataset.imgUrl = item.img_url || '';

  const wrapper = document.createElement('div');
  wrapper.className  = 'card-wrapper';
  wrapper.style.cssText = 'overflow:hidden;transition:height 0.3s cubic-bezier(0.2,0,0,1),opacity 0.3s ease;';
  wrapper.appendChild(card);

  const container = document.createElement('div');
  container.className = 'card-container';
  // Wide layout: Page category (full-page and CoreItem Page saves).
  const isPageCategory = (item.category || '').trim() === 'Page';
  const isMailCategory = (item.category || '').trim() === 'Mail';
  if (isPageCategory) container.classList.add('wide');
  if (isPageCategory) container.dataset.pageCard = 'true';
  if (isMailCategory) container.classList.add('wide');

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

  // Check if this card has a screenshot image (height: auto — size depends on image load)
  const screenshotImg = wrapper.querySelector('.data-card-imgcontainer.is-screenshot .data-card-image');

  const runAnimation = (naturalHeight) => {
    container.style.height     = '0px';
    container.style.overflow   = 'hidden';
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
  };

  const measureHeight = () => {
    // Preserve the container's rendered width during measurement
    const containerWidth = container.getBoundingClientRect().width ||
                           container.offsetWidth;

    container.style.visibility = 'hidden';
    container.style.position   = 'absolute';
    container.style.width      = `${containerWidth}px`;
    container.style.height     = '';
    container.style.overflow   = '';

    const naturalHeight = wrapper.offsetHeight;

    container.style.visibility = '';
    container.style.position   = '';
    container.style.width      = '';

    return naturalHeight;
  };

  if (screenshotImg && (!screenshotImg.complete || screenshotImg.naturalHeight === 0)) {
    // Image not yet loaded — wait for it before measuring
    // Keep container collapsed and invisible during wait
    container.style.height   = '0px';
    container.style.overflow = 'hidden';

    const onLoad = () => {
      screenshotImg.removeEventListener('load', onLoad);
      screenshotImg.removeEventListener('error', onLoad);
      const naturalHeight = measureHeight();
      runAnimation(naturalHeight > 0 ? naturalHeight : 200);
    };
    screenshotImg.addEventListener('load', onLoad);
    screenshotImg.addEventListener('error', onLoad); // fallback on error
  } else {
    // Fixed-height card or already-loaded image — measure immediately
    const naturalHeight = measureHeight();
    runAnimation(naturalHeight > 0 ? naturalHeight : 80);
  }
}

// ── Optimistic UI ─────────────────────────────────────────────────────────────
function addOptimisticCard({ tempId, url, title, imgUrl, isScreenshot: isScreenshotFlag, screenshotPadding, screenshotBgColor, category, platform, confirmedType, sender }) {
  if (!currentUser) return;

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
    _isOptimistic:   true,
    _isScreenshot:   !!isScreenshotFlag,
    category:        category      || '',
    platform:        platform      || '',
    confirmed_type:  confirmedType || '',
    sender:            sender           || '',
    screenshot_padding:   typeof screenshotPadding === 'number' && screenshotPadding > 0
      ? screenshotPadding : 0,
    screenshot_bg_color:  screenshotBgColor || '',
  };

  // Create the card element
  const { container, wrapper, card } = createCardElement(tempItem, true);
  card.dataset.tempId = tempId;
  container.dataset.optimisticCard = tempId;
  card.dataset.handlerAttached = 'false';

  // Add visual indicator that this card is pending
  wrapper.style.opacity = '0.7';

  // Prepend to the top of the main list
  const categoryList = getCategoryList(category);
  if (!categoryList) return;
  // Auto-expand section if currently collapsed
  const categorySection = categoryList.closest('.sp-category-section');
  if (categorySection?.classList.contains('collapsed')) {
    categorySection.classList.remove('collapsed');
    const cat = categorySection.dataset.category;
    saveCategoryCollapseState(cat, false);
  }
  categoryList.insertBefore(container, categoryList.firstChild);

  // Track in optimisticCards map
  optimisticCards.set(tempId, { url, title, imgUrl, cardContainer: container });

  // Add to displayedItemIds so loadData() won't duplicate it
  displayedItemIds.add(tempId);

  // Run entrance animation
  animateEntrance(container, wrapper);

  // Attach handlers
  attachCardClickHandlers();

  // Explicitly apply screenshot alignment for base64 images which are
  // already decoded and won't trigger a load event after handler registration
  if (isScreenshotFlag) {
    try {
      const imgContainer = container.querySelector('.data-card-imgcontainer.is-screenshot');
      const imgEl = imgContainer?.querySelector('.data-card-image');
      if (imgContainer && imgEl && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
        applyScreenshotImgAlignment(imgEl, imgContainer);
      }
    } catch (e) {}
  }
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

// AI board disabled
// spAiBoardClose.addEventListener('click', () => {
//   activeCardItemId = null;
//   document.querySelectorAll('.data-card').forEach((c) => c.classList.remove('active'));
//   showAiBoardEmpty();
// });

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
  let closestDist  = Infinity;

  for (let i = 0; i < children.length; i++) {
    const r   = children[i].getBoundingClientRect();
    const midX = r.left + r.width  * 0.5;
    const midY = r.top  + r.height * 0.5;
    const dx  = e.clientX - midX;
    const dy  = e.clientY - midY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Also check if the pointer is before this card's center
    // (prefer inserting before a card when dragging into its top-left quadrant)
    if (dist < closestDist) {
      closestDist  = dist;
      // Insert before this card if pointer is left of or above its center
      closestIndex = (e.clientX < midX || e.clientY < midY) ? i : i + 1;
    }
  }

  // Clamp to valid range
  closestIndex = Math.max(0, Math.min(closestIndex, children.length));

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

        // Replace URL (Mail) or context line (standard card) with confirmation message
        const confirmEl = header.querySelector('.data-card-url-text') || header.querySelector('.data-card-context');
        if (confirmEl) {
          if (confirmEl.classList.contains('data-card-context')) {
            confirmEl.dataset.originalHtml = confirmEl.innerHTML;
            confirmEl.innerHTML = '<span class="data-card-delete-pending">Really delete this data?</span>';
          } else {
            confirmEl.dataset.originalText = confirmEl.textContent;
            confirmEl.textContent = 'Really delete this data?';
          }
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
          if (confirmEl) {
            if (confirmEl.dataset.originalHtml !== undefined) {
              confirmEl.innerHTML = confirmEl.dataset.originalHtml;
              delete confirmEl.dataset.originalHtml;
            } else if (confirmEl.dataset.originalText !== undefined) {
              confirmEl.textContent = confirmEl.dataset.originalText;
              delete confirmEl.dataset.originalText;
            }
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
          const cardContainer = wrapper.closest('.card-container') || wrapper;
          cardContainer.style.transition = 'height 0.25s ease, width 0.25s ease, opacity 0.2s ease, margin 0.25s ease, padding 0.25s ease';
          cardContainer.style.overflow   = 'hidden';
          cardContainer.style.opacity    = '0';
          cardContainer.style.height     = cardContainer.offsetHeight + 'px';
          cardContainer.style.width      = cardContainer.offsetWidth  + 'px';
          requestAnimationFrame(() => {
            cardContainer.style.height  = '0px';
            cardContainer.style.width   = '0px';
            cardContainer.style.margin  = '0';
            cardContainer.style.padding = '0';
          });
          setTimeout(() => {
            fetch(
              `http://localhost:3000/api/v1/items/${encodeURIComponent(docId)}?userId=${encodeURIComponent(currentUser.uid)}`,
              { method: 'DELETE' }
            ).catch((err) => console.error('[Delete]', err));
            cardContainer.remove();
          }, 250);
        }
      }
    });
  });
}

function applyScreenshotImgAlignment(imgEl, imgContainer) {
  try {
    if (!imgContainer.classList.contains('is-screenshot')) return;
    if (!imgEl || imgEl.naturalWidth <= 0 || imgEl.naturalHeight <= 0) return;
    const container = imgContainer.closest('.card-container');
    const isPageCard = container?.dataset?.pageCard === 'true';
    if (isPageCard) {
      imgContainer.classList.add('is-screenshot-wide');
      container?.classList.add('wide');
    } else {
      imgContainer.classList.remove('is-screenshot-wide');
      container?.classList.remove('wide');
    }
    // Clear any previously set inline styles that may conflict with CSS classes
    imgEl.style.width          = '';
    imgEl.style.height         = '';
    imgEl.style.objectFit      = '';
    imgEl.style.objectPosition = '';
    imgContainer.style.justifyContent = '';
  } catch (e) {}
}

// ── AI Board state ────────────────────────────────────────────────────────────
function showAiBoardEmpty() {
  spAiBoardTitle.classList.remove('sp-ai-reveal', 'sp-ai-revealed');
  spAiBoardEmpty.style.display   = '';
  spAiBoardContent.style.display = 'none';
  spAiBoardLoading.style.display = 'none';
}

function showAiBoardLoading() {
  spAiBoardTitle.classList.remove('sp-ai-reveal', 'sp-ai-revealed');
  spAiBoardEmpty.style.display   = 'none';
  spAiBoardContent.style.display = 'none';
  spAiBoardLoading.style.display = '';
}

function showAiBoardContent(data) {
  spAiBoardEmpty.style.display   = 'none';
  spAiBoardLoading.style.display = 'none';
  spAiBoardBody.innerHTML        = '';
  spAiBoardTitle.textContent     = '';
  spAiBoardContent.style.display = '';

  // Each block: { html, delay (ms) }
  const blocks = [];

  if (data.title) {
    blocks.push({
      applyTitle: true,
      value: data.title,
      delay: 0,
    });
  }

  if (data.content_type) {
    const detailPart = data.detail_type
      ? ` <span class="sp-ai-type-separator">›</span> <span class="sp-ai-detail-type">${escapeHtml(data.detail_type)}</span>`
      : '';
    blocks.push({
      html:  `<div class="sp-ai-type sp-ai-reveal">${escapeHtml(data.content_type)}${detailPart}</div>`,
      delay: 80,
    });
  }

  if (data.summary) {
    blocks.push({
      html:  `<div class="sp-ai-summary sp-ai-reveal">${escapeHtml(data.summary)}</div>`,
      delay: 160,
    });
  }

  if (data.table_of_contents?.length) {
    let toc = `<div class="sp-ai-section-label sp-ai-reveal">목차</div>`;
    toc += `<ol class="sp-ai-toc sp-ai-reveal">`;
    data.table_of_contents.forEach((section) => {
      toc += `<li>${escapeHtml(section)}</li>`;
    });
    toc += `</ol>`;
    blocks.push({ html: toc, delay: 280 });
  }

  if (data.key_points?.length) {
    let kp = `<ul class="sp-ai-keypoints sp-ai-reveal">`;
    data.key_points.forEach((pt) => {
      kp += `<li>${escapeHtml(pt)}</li>`;
    });
    kp += `</ul>`;
    blocks.push({ html: kp, delay: 420 });
  }

  if (data.keywords?.length) {
    let kw = `<div class="sp-ai-keywords sp-ai-reveal">`;
    data.keywords.forEach((k) => {
      kw += `<span class="sp-ai-keyword">${escapeHtml(k)}</span>`;
    });
    kw += `</div>`;
    blocks.push({ html: kw, delay: 560 });
  }

  if (data.raw) {
    blocks.push({
      html:  `<div class="sp-ai-summary sp-ai-reveal">${escapeHtml(data.raw)}</div>`,
      delay: 80,
    });
  }

  blocks.forEach((block) => {
    setTimeout(() => {
      if (block.applyTitle) {
        spAiBoardTitle.textContent = block.value;
        spAiBoardTitle.classList.add('sp-ai-reveal');
        requestAnimationFrame(() => spAiBoardTitle.classList.add('sp-ai-revealed'));
        return;
      }
      const temp = document.createElement('div');
      temp.innerHTML = block.html;
      Array.from(temp.children).forEach((el) => {
        spAiBoardBody.appendChild(el);
        // Trigger animation on next frame so the initial opacity:0 is painted first
        requestAnimationFrame(() => el.classList.add('sp-ai-revealed'));
      });
    }, block.delay);
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showAiBoardForItem(itemId) {
  activeCardItemId = itemId;
  if (!itemId) { showAiBoardEmpty(); return; }

  const item = currentItems.find((it) => getItemId(it) === itemId);
  if (!item) { showAiBoardEmpty(); return; }

  const hasAiData = item.ai_title || item.ai_summary ||
                    item.ai_key_points?.length || item.ai_keywords?.length;

  if (hasAiData) {
    showAiBoardContent({
      title:             item.ai_title             || '',
      summary:           item.ai_summary           || '',
      key_points:        item.ai_key_points        || [],
      keywords:          item.ai_keywords          || [],
      content_type:      item.ai_content_type      || '',
      detail_type:       item.ai_subject_type      || '',
      table_of_contents: item.ai_table_of_contents || [],
    });
  } else {
    // AI analysis not yet available — show loading state
    showAiBoardLoading();
  }
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
      // AI board disabled
      // const itemId = newCard.dataset.itemId || newCard.dataset.docId || '';
      // showAiBoardForItem(itemId);
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

      applyScreenshotImgAlignment(img, container);
    });

    // Apply ratio alignment immediately if image is already loaded
    if (
      container.classList.contains('is-screenshot') &&
      img.complete &&
      img.naturalWidth > 0 &&
      img.naturalHeight > 0
    ) {
      applyScreenshotImgAlignment(img, container);
    }
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
  // Attach DnD to each category list independently (same-category reordering only)
  CATEGORY_ORDER.forEach((cat) => {
    const list = document.querySelector(`.sp-category-list[data-category-list="${cat}"]`);
    if (!list || list.dataset.unifiedDnDAttached === 'true') return;
    list.dataset.unifiedDnDAttached = 'true';
    setupContainerDropHandlers(list, null);
  });

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

  spDirectoryList.style.display = 'none';

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

function updateCardImage(cardEl, newImgUrl, screenshotBgColor) {
  try {
    const imgContainer = cardEl.querySelector('.data-card-imgcontainer');
    const imgEl = cardEl.querySelector('.data-card-image');
    if (!imgContainer || !imgEl) return;

    const proxiedUrl = getProxiedImageUrl(newImgUrl);
    const isScreenshot = newImgUrl.includes('/screenshots/') ||
                         newImgUrl.startsWith('data:image/');

    // Preload the new image before swapping to avoid flash
    const preloader = new Image();
    preloader.onload = () => {
      // Update container classes BEFORE swapping src so load/alignment logic
      // sees the correct class when the new image fires its load event
      if (isScreenshot) {
        imgContainer.classList.add('is-screenshot');
        if (screenshotBgColor) {
          imgContainer.style.backgroundColor = screenshotBgColor;
        }
      } else {
        imgContainer.classList.remove('is-screenshot');
        imgContainer.classList.remove('is-screenshot-wide');
        imgContainer.style.backgroundColor = '';
      }
      imgEl.src = proxiedUrl;
      cardEl.dataset.imgUrl = newImgUrl;
      // Apply alignment using preloader's known dimensions
      if (isScreenshot && preloader.naturalWidth > 0 && preloader.naturalHeight > 0) {
        const containerEl = imgContainer.closest('.card-container');
        const isPageCard = containerEl?.dataset?.pageCard === 'true';
        if (isPageCard) {
          imgContainer.classList.add('is-screenshot-wide');
          containerEl?.classList.add('wide');
        } else {
          imgContainer.classList.remove('is-screenshot-wide');
          containerEl?.classList.remove('wide');
        }
        imgEl.style.width          = '';
        imgEl.style.height         = '';
        imgEl.style.objectFit      = '';
        imgEl.style.objectPosition = '';
        imgContainer.style.justifyContent = '';
      }
    };
    preloader.onerror = () => {
      // On error, swap anyway to avoid staying on stale image
      imgEl.src = proxiedUrl;
      cardEl.dataset.imgUrl = newImgUrl;
    };
    preloader.src = proxiedUrl;
  } catch (e) {}
}

// ── loadData ──────────────────────────────────────────────────────────────────
function loadData() {
  if (!currentUser) return;

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
  function getOptimisticTempIdForItem(it) {
    if (isInitialRender) return null;
    for (const [tempId, entry] of optimisticCards.entries()) {
      if (entry.url === it.url) return tempId;
    }
    return null;
  }

  const preserveItemIds = new Set();
  for (const it of itemsWithoutDirectory) {
    const pid = getItemId(it);
    if (getOptimisticTempIdForItem(it)) continue;
    if (!isInitialRender && previouslyDisplayed.has(pid)) {
      preserveItemIds.add(pid);
    }
  }

  // Clear all category lists (preserve animating and optimistic cards)
  CATEGORY_ORDER.forEach((cat) => {
    const list = document.querySelector(`.sp-category-list[data-category-list="${cat}"]`);
    if (!list) return;
    Array.from(list.children).forEach((child) => {
      if (child.dataset?.preserveAnimation || child.dataset?.optimisticCard) return;
      const dockCard = child.querySelector?.('.data-card');
      const cid = dockCard?.dataset?.itemId;
      if (cid && preserveItemIds.has(cid)) return;
      list.removeChild(child);
    });
  });

  itemsWithoutDirectory.forEach((item) => {
    const itemId = getItemId(item);

    // Check if this real item matches an optimistic card by URL
    // If so, promote the existing DOM in-place (avoid remove/recreate flash)
    let matchedTempId = null;
    if (!isInitialRender) {
      for (const [tempId, entry] of optimisticCards.entries()) {
        if (entry.url === item.url) {
          matchedTempId = tempId;
          break;
        }
      }
    }

    let itemToRender = item;
    if (matchedTempId) {
      const optimisticEntry = optimisticCards.get(matchedTempId);
      const existingContainer = optimisticEntry?.cardContainer;
      const existingCard = existingContainer?.querySelector('.data-card');

      if (existingCard) {
        // Promote the existing Optimistic Card DOM in-place:
        // update identifiers so the card is treated as a real item from now on.
        const realItemId = getItemId(item);
        existingCard.id                  = `item-${realItemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
        existingCard.dataset.itemId      = realItemId;
        existingCard.dataset.docId       = item.id || '';
        existingCard.dataset.url         = item.url || '';
        existingCard.dataset.title       = item.title || 'Untitled';

        // If Firestore already has a Storage URL, update dataset.imgUrl so future
        // loadData() calls see it as unchanged (prevents re-triggering updateCardImage).
        // Do NOT swap the visible <img> src — the base64 already looks correct.
        if (item.img_url) {
          existingCard.dataset.imgUrl = item.img_url;
        }

        // Remove optimistic marker so the DOM clear loop won't skip this container
        // and future loadData() passes treat it as a normal rendered card.
        delete existingContainer.dataset.optimisticCard;

        // Clean up tracking maps
        optimisticCards.delete(matchedTempId);
        displayedItemIds.delete(matchedTempId);
        displayedItemIds.add(realItemId);

        // Skip the createCardElement / appendChild path entirely
        return;
      }

      // Fallback: existing DOM not found — proceed with original replacement logic
      const optimisticData = optimisticCards.get(matchedTempId);
      if (optimisticData) {
        itemToRender = {
          ...item,
          ...(optimisticData.imgUrl && !item.img_url ? { img_url: optimisticData.imgUrl } : {}),
        };
      }
      removeOptimisticCard(matchedTempId);
    }

    const isNew = !isInitialRender && !previouslyDisplayed.has(itemId) && !matchedTempId;
    const alreadyRendered = !isNew && !matchedTempId && previouslyDisplayed.has(itemId);

    if (alreadyRendered) {
      const cardId = `item-${itemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const existingCard = dashboardScreen.querySelector(`#${cardId}`);
      if (existingCard) {
        const prevImgUrl = (existingCard.dataset.imgUrl || '').trim();
        const nextImgUrl = (itemToRender.img_url || '').trim();
        const hasImgContainer = !!existingCard.querySelector('.data-card-imgcontainer');
        let removedForRebuild = false;

        if (nextImgUrl && nextImgUrl !== prevImgUrl) {
          if (hasImgContainer) {
            updateCardImage(
              existingCard,
              nextImgUrl,
              (itemToRender.screenshot_bg_color || '').trim()
            );
          } else {
            existingCard.closest('.card-container')?.remove();
            removedForRebuild = true;
          }
        }

        if (!removedForRebuild) {
          displayedItemIds.add(itemId);
          const existingContainer = existingCard.closest('.card-container');
          if (existingContainer) {
            const targetList = getCategoryList(itemToRender?.category || item?.category || '');
            targetList?.appendChild(existingContainer);
          }
          return;
        }
      }
    }

    const { container, wrapper, card } = createCardElement(itemToRender, isNew);
    getCategoryList(itemToRender?.category || item?.category || '')?.appendChild(container);
    displayedItemIds.add(itemId);
    card.dataset.handlerAttached = 'false';
    if (isNew) animateEntrance(container, wrapper);
  });

  // ── Empty state ──────────────────────────────────────────────────────────
  if (currentItems.length === 0 && optimisticCards.size === 0) {
    const empty = document.createElement('div');
    empty.className   = 'sp-empty';
    empty.textContent = 'No saved items yet.\nUse Cmd+Shift+S to save.';
    document.querySelector('.sp-category-list')?.appendChild(empty);
  }

  // ── Attach handlers ──────────────────────────────────────────────────────
  attachCardClickHandlers();
  setupUnifiedDropHandlers();

  updateCategoryCounts();
  setupCategoryCollapseHandlers();
  applyCategoryCollapseStates();

  // Re-apply screenshot alignment for any already-loaded images
  // (new DOM elements from createCardElement reset inline styles)
  try {
    document.querySelectorAll(
      '#sp-itemlist-wrap .data-card-imgcontainer.is-screenshot .data-card-image'
    ).forEach((imgEl) => {
      const imgContainer = imgEl.closest('.data-card-imgcontainer');
      if (!imgContainer) return;
      if (imgEl.complete && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
        applyScreenshotImgAlignment(imgEl, imgContainer);
      }
    });
  } catch (e) {}
}

// ── Optimistic card message listener ─────────────────────────────────────────
if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'optimistic-card') {
      addOptimisticCard({
        tempId:            message.tempId,
        url:               message.url,
        title:             message.title,
        imgUrl:            message.imgUrl || '',
        isScreenshot:      !!message.isScreenshot,
        screenshotPadding: typeof message.screenshotPadding === 'number'
          ? message.screenshotPadding : 0,
        screenshotBgColor: message.screenshotBgColor || '',
        category:          message.category      || '',
        platform:          message.platform      || '',
        confirmedType:     message.confirmedType || '',
        sender:            message.sender        || '',
      });
    }
    return false;
  });
}
```

### `browser-extension/chromium/sidepanel.html`

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
    /* ── AI board ── */
    #sp-ai-board {
      flex-shrink: 0;
      height: 200px;
      overflow-y: auto;
      border-bottom: 1px solid var(--border);
      background: #fff;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
    }
    #sp-ai-board-empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
      font-size: 11px;
    }
    #sp-ai-board-content {
      display: flex;
      flex-direction: column;
      width: 100%;
    }
    #sp-ai-board-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px 4px 12px;
      flex-shrink: 0;
    }
    #sp-ai-board-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }
    #sp-ai-board-close {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 11px;
      color: var(--text-secondary);
      padding: 0 0 0 8px;
      flex-shrink: 0;
      line-height: 1;
    }
    #sp-ai-board-close:hover {
      color: #111;
    }
    #sp-ai-board-body {
      padding: 0 12px 12px 12px;
      font-size: 11px;
      line-height: 1.6;
      color: var(--text-primary);
      word-break: break-word;
      white-space: pre-wrap;
    }
    .sp-ai-type {
      display: inline-block;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--blink-accent, #6c47ff);
      margin-bottom: 6px;
    }
    .sp-ai-type-separator {
      font-size: 9px;
      font-weight: 400;
      color: rgba(0, 0, 0, 0.3);
      margin: 0 2px;
    }
    .sp-ai-detail-type {
      font-size: 9px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--blink-accent, #6c47ff);
      opacity: 0.7;
    }
    .sp-ai-summary {
      font-size: 11px;
      line-height: 1.6;
      color: var(--text-primary, #111);
      margin-bottom: 8px;
    }
    .sp-ai-keypoints {
      margin: 0 0 8px 0;
      padding-left: 16px;
      font-size: 11px;
      line-height: 1.6;
      color: var(--text-primary, #111);
    }
    .sp-ai-keypoints li {
      margin-bottom: 2px;
    }
    .sp-ai-keywords {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 4px;
    }
    .sp-ai-keyword {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--accent-10, #f0ecff);
      color: var(--blink-accent, #6c47ff);
      font-weight: 500;
    }
    .sp-ai-section-label {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-secondary, #888);
      margin-bottom: 4px;
      margin-top: 8px;
    }
    .sp-ai-toc {
      margin: 0 0 8px 0;
      padding-left: 18px;
      font-size: 11px;
      line-height: 1.6;
      color: var(--text-primary, #111);
    }
    .sp-ai-toc li {
      margin-bottom: 2px;
    }
    .sp-ai-reveal {
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 220ms ease, transform 220ms ease;
    }
    .sp-ai-revealed {
      opacity: 1;
      transform: translateY(0);
    }
    #sp-ai-board-title.sp-ai-reveal {
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 200ms ease, transform 200ms ease;
    }
    #sp-ai-board-title.sp-ai-revealed {
      opacity: 1;
      transform: translateY(0);
    }
    #sp-ai-board-loading {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      color: var(--text-secondary);
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
      padding: 3px;
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    /* ── Category sections ── */
    .sp-category-section {
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid var(--border-default);
    }
    .sp-category-section:last-child {
      border-bottom: none;
    }
    .sp-category-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      background: transparent;
      transition: background 0.1s;
      flex-shrink: 0;
    }
    .sp-category-header:hover {
      background: var(--accent-10);
    }
    .sp-category-title {
      font-family: 'Roboto', sans-serif;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      flex: 1;
    }
    .sp-category-count {
      font-family: 'Roboto', sans-serif;
      font-size: 9px;
      font-weight: 500;
      color: var(--text-secondary);
      opacity: 0.6;
    }
    .sp-category-chevron {
      width: 12px;
      height: 12px;
      stroke: var(--text-secondary);
      stroke-width: 2;
      fill: none;
      transition: transform 0.2s ease;
      flex-shrink: 0;
    }
    .sp-category-section.collapsed .sp-category-chevron {
      transform: rotate(-90deg);
    }
    .sp-category-list {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      padding: 3px;
      min-height: 0;
      align-items: start;
      box-sizing: border-box;
      max-height: 360px;
      overflow-y: auto;
      transition: max-height 0.25s cubic-bezier(0.4, 0, 0.2, 1),
                  padding 0.25s ease,
                  opacity 0.2s ease;
      opacity: 1;
    }
    .sp-category-section.collapsed .sp-category-list {
      max-height: 0;
      padding-top: 0;
      padding-bottom: 0;
      overflow: hidden;
      opacity: 0;
    }

    /* ── Card styles ── */
    .card-container { width: calc(33.333% - 2px); flex-shrink: 0; box-sizing: border-box; min-width: 0; }
    .card-wrapper {
      position: relative;
      background: white;
      border: 1px solid var(--border-default);
      border-radius: var(--corner-extra-small);
      margin: 0;
      width: 100%;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.25, 0.1, 0.25, 1.0),
                  height 0.3s cubic-bezier(0.2, 0, 0, 1),
                  opacity 0.3s ease;
      box-sizing: border-box;
      user-select: none;
    }
    .card-wrapper:hover {
      border-color: var(--border-secondary);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
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
      padding: 2px var(--space-100);
      overflow: hidden;
      max-height: 28px;
      opacity: 1;
    }
    /* Main content section */
    .data-card-main {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: flex-start;
      width: 100%;
      min-width: 0;
      padding: 0;
      box-sizing: border-box;
    }

    /* Image thumbnail — fixed height like Electron */
    .data-card-imgcontainer {
      width: 100%;
      height: 80px;
      min-height: 80px;
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
    .data-card-imgcontainer.is-screenshot {
      height: 80px;
      min-height: 80px;
      align-items: flex-start;
      padding: 2px;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
    }
    .data-card-imgcontainer.is-screenshot::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 32px;
      background: linear-gradient(to bottom, transparent, white);
      pointer-events: none;
      z-index: 1;
    }
    .data-card-imgcontainer.is-screenshot .data-card-image {
      width: 100%;
      height: auto;
      object-fit: unset;
      object-position: unset;
      display: block;
    }
    /* Wide screenshot (ratio >= 2.5): width-based sizing, clipped to 80px height */
    .data-card-imgcontainer.is-screenshot-wide .data-card-image {
      width: 100%;
      height: auto;
      object-fit: unset;
      object-position: unset;
      display: block;
    }
    .data-card-imgcontainer.is-screenshot-wide {
      justify-content: flex-start;
      overflow: hidden;
    }

    /* Text content */
    .data-card-context {
      display: flex;
      flex-direction: row;
      align-items: center;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      padding: 0;
      box-sizing: border-box;
      gap: 3px;
    }
    .data-card-content-type {
      font-family: 'Roboto', sans-serif;
      font-size: 9px;
      font-weight: 700;
      color: var(--blink-accent, #6c47ff);
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 0;
    }
    .data-card-type-separator {
      font-size: 9px;
      color: rgba(0, 0, 0, 0.25);
      flex-shrink: 0;
    }
    .data-card-detail-type {
      font-family: 'Roboto', sans-serif;
      font-size: 9px;
      font-weight: 500;
      color: rgba(0, 0, 0, 0.4);
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .data-card-context-loading {
      width: 10px;
      height: 10px;
      border: 1.5px solid rgba(0, 0, 0, 0.12);
      border-top-color: var(--blink-accent, #6c47ff);
      border-radius: 50%;
      animation: data-card-spin 0.7s linear infinite;
      flex-shrink: 0;
      margin: auto;
    }
    /* ── Mail card ── */
    .card-container:has(.data-card--mail) {
      width: 100%;
    }
    .data-card--mail .data-card-mail-body {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--space-200);
      padding: var(--space-200) var(--space-200);
      min-height: 48px;
    }
    .data-card-mail-favicon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      object-fit: contain;
      flex-shrink: 0;
      background: var(--bg-primary);
    }
    .data-card-mail-favicon--placeholder {
      background: var(--bg-primary);
    }
    .data-card-mail-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }
    .data-card-mail-sender {
      font-family: 'Roboto', sans-serif;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .data-card-mail-title {
      font-family: 'Roboto', sans-serif;
      font-size: 10px;
      font-weight: 400;
      color: rgba(0, 0, 0, 0.55);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* ── Wide screenshot card: spans all 3 columns ── */
    .card-container.wide {
      width: 100%;
    }
    @keyframes data-card-spin {
      to { transform: rotate(360deg); }
    }
    .data-card-title {
      font-family: 'Roboto', sans-serif;
      font-weight: 600;
      font-size: 10px;
      line-height: 1.3;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
      margin: 0;
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
    }
    .data-card-header.delete-pending .data-card-delete { opacity: 1; }
    .data-card-header.delete-pending .data-card-delete-btn { background: #fff; }
    .data-card-header.delete-pending .data-card-delete-btn svg { stroke: #ef4444; }
    .data-card-header.delete-pending .data-card-delete-pending {
      color: #ffffff;
      font-family: 'Roboto', sans-serif;
      font-size: 9px;
      font-weight: 500;
    }

    /* ── DnD guide line ── */
    .dnd-guide-wrapper {
      width: 100%;
      min-height: 80px;
      background: rgba(var(--accent-rgb, 188, 19, 254), 0.08);
      border: 2px dashed var(--accent, #bc13fe);
      border-radius: var(--corner-extra-small);
      pointer-events: none;
      box-sizing: border-box;
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

      <!-- AI analysis board -->
      <div id="sp-ai-board" style="display:none;">
        <div id="sp-ai-board-empty">
          <span>Click a card to analyze</span>
        </div>
        <div id="sp-ai-board-content" style="display:none;">
          <div id="sp-ai-board-header">
            <span id="sp-ai-board-title"></span>
            <button id="sp-ai-board-close">✕</button>
          </div>
          <div id="sp-ai-board-body"></div>
        </div>
        <div id="sp-ai-board-loading" style="display:none;">
          <span>Analyzing…</span>
        </div>
      </div>

      <!-- Main item list: category sections -->
      <div id="sp-itemlist-wrap">
        <div class="sp-category-section" data-category="SNS">
          <div class="sp-category-header">
            <span class="sp-category-title">SNS</span>
            <span class="sp-category-count"></span>
            <svg class="sp-category-chevron" viewBox="0 0 12 12">
              <polyline points="2,4 6,8 10,4"/>
            </svg>
          </div>
          <div class="sp-category-list" data-category-list="SNS"></div>
        </div>
        <div class="sp-category-section" data-category="Image">
          <div class="sp-category-header">
            <span class="sp-category-title">Image</span>
            <span class="sp-category-count"></span>
            <svg class="sp-category-chevron" viewBox="0 0 12 12">
              <polyline points="2,4 6,8 10,4"/>
            </svg>
          </div>
          <div class="sp-category-list" data-category-list="Image"></div>
        </div>
        <div class="sp-category-section" data-category="Video">
          <div class="sp-category-header">
            <span class="sp-category-title">Video</span>
            <span class="sp-category-count"></span>
            <svg class="sp-category-chevron" viewBox="0 0 12 12">
              <polyline points="2,4 6,8 10,4"/>
            </svg>
          </div>
          <div class="sp-category-list" data-category-list="Video"></div>
        </div>
        <div class="sp-category-section" data-category="Mail">
          <div class="sp-category-header">
            <span class="sp-category-title">Mail</span>
            <span class="sp-category-count"></span>
            <svg class="sp-category-chevron" viewBox="0 0 12 12">
              <polyline points="2,4 6,8 10,4"/>
            </svg>
          </div>
          <div class="sp-category-list" data-category-list="Mail"></div>
        </div>
        <div class="sp-category-section" data-category="Page">
          <div class="sp-category-header">
            <span class="sp-category-title">Page</span>
            <span class="sp-category-count"></span>
            <svg class="sp-category-chevron" viewBox="0 0 12 12">
              <polyline points="2,4 6,8 10,4"/>
            </svg>
          </div>
          <div class="sp-category-list" data-category-list="Page"></div>
        </div>
      </div>

    </div>
  </div>
</body>
</html>
```

### `browser-extension/chromium/manifest.json`

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
    "identity",
    "cookies"
  ],
  "host_permissions": [
    "http://localhost:3000/*",
    "http://localhost:3001/*",
    "https://www.instagram.com/*",
    "https://*.cdninstagram.com/*",
    "https://*.fbcdn.net/*",
    "https://mail.googleapis.com/*",
    "https://www.googleapis.com/*",
    "https://mail.naver.com/*",
    "https://*.naver.com/*"
  ],
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["html2canvas.bundle.js", "content-loader.js"],
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
    "scopes": ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"]
  },
  "action": {
    "default_title": "Blink",
    "default_popup": ""
  }
}

```

### `client/src/main.ts`

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
      // Category / platform / type fields from extension detection
      ...(payload.category      && { category:       payload.category }),
      ...(payload.platform      && { platform:        payload.platform }),
      ...(payload.confirmed_type && { confirmed_type: payload.confirmed_type }),
      ...(payload.sender                                    && { sender:             payload.sender }),
      ...(typeof payload.screenshot_padding === 'number' &&
          payload.screenshot_padding > 0                    && { screenshot_padding: payload.screenshot_padding }),
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

### `client/src/lib/firestore.ts`

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

### `server/.env.example`

```bash
# Blink Server Environment Variables
# Copy this file to .env and fill in your values

# Gemini AI API key (required for AI analysis)
# Get from: https://makersuite.google.com/app/apikey
GEMINI_API_KEY=your_gemini_api_key_here

# Firebase Admin SDK (optional - server uses this for direct Firestore saves when Electron is offline)
# Path to your Firebase service account JSON file
# Get from: Firebase Console > Project Settings > Service Accounts > Generate new private key
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json

# Firebase Storage bucket for screenshot uploads (same as Firebase Console → Storage)
FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
```

