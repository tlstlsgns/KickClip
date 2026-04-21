# [Blink_Project] Initialization Overview

**Purpose:** This document provides Claude (mediator AI) with a comprehensive understanding of the Blink project so it can write effective prompts for Cursor when supporting development. Use this as the primary reference for project context.

---

## 1. Project Overview

**Blink** is a desktop application for saving URLs and images from the browser using keyboard shortcuts (`Cmd+Shift+S` / `Ctrl+Shift+S`). It consists of:

- **Electron Desktop Client** — Main app with Firebase auth, Firestore storage, and UI
- **Node.js Server** — REST API for metadata extraction and save operations
- **Browser Extension** — Captures URLs/images from web pages, detects hover targets, communicates with the Electron app
- **Firebase Backend** — Authentication (Google, Instagram OAuth) and Firestore database

**Core User Flow:** User hovers over content (e.g., Instagram post, Pinterest pin) → presses shortcut → extension detects the target → sends to server/Electron → saved to Firestore → appears in desktop app.

---

## 2. Project Scaffold

```
AppTest/
├── client/                 # Electron desktop app
│   ├── src/
│   │   ├── main.ts         # Main process (windows, IPC, system integration)
│   │   ├── preload/        # Preload scripts (contextBridge)
│   │   ├── lib/            # Firebase, auth, firestore, config
│   │   └── renderer/       # React components (auth, etc.)
│   ├── pages/              # Dashboard, auth HTML/JS
│   ├── viewer.html         # Main viewer UI
│   ├── ghost-window.html   # Transparent overlay for drag-drop
│   └── dist/               # Compiled output (tsc)
│
├── server/                 # Node.js Express API
│   ├── src/
│   │   └── server.ts       # REST API, metadata extraction
│   ├── data/               # saved-urls.json (local fallback)
│   └── dist/               # Compiled output
│
├── browser-extension/
│   ├── chromium/           # Chrome, Arc, Edge (primary, most feature-complete)
│   │   ├── manifest.json   # MV3 manifest
│   │   ├── background.js  # Service worker, shortcuts
│   │   ├── content-loader.js # Injected at document_start, loads coreEntry
│   │   ├── coreEntry.js    # Main entry: hover logic, save flow
│   │   ├── coreEngine.js   # Facade: re-exports itemDetector, dataExtractor, uiManager
│   │   ├── itemDetector.js # ItemMap detection, cluster logic
│   │   ├── dataExtractor.js# URL resolution, metadata, Type A/B extraction
│   │   ├── urlResolver.js   # URL normalization, intent, redirect handling
│   │   ├── uiManager.js    # Highlight overlays, tooltips
│   │   └── stateLite.js    # Shared state
│   ├── firefox/            # Firefox variant
│   └── safari/             # Safari variant
│
├── docs/                   # Technical audits, diagnostics
│   ├── TypeA-ItemMap-Detection-Audit.md
│   ├── Bottom-Up-Recovery-Audit.md
│   ├── richCount-Implementation-Audit.md
│   ├── Pinterest-Service-Worker-Navigation-Preload-Analysis.md
│   └── ... (many audit docs)
│
├── .cursorrules            # Architecture rules, sync/async parity constraints
├── firestore.rules         # Firestore security rules
└── README.md
```

---

## 3. How It's Built

### Client (Electron)

- **Stack:** Electron v31.3.1, TypeScript v5.6.3
- **Build:** `npm run build` (tsc) → `dist/`
- **Run:** `npm run dev` (build + electron)
- **Security:** `nodeIntegration: false`, `contextIsolation: true`, IPC via `contextBridge`

### Server

- **Stack:** Node.js, Express v4.19.2, TypeScript, ES Modules
- **Key libs:** cheerio, node-fetch, robots-parser, firebase-admin
- **Run:** `npm run dev` (ts-node) or `npm start` (node dist/server.js)
- **Port:** 3000 (main API), 3001 (pending save), 3002 (Firestore save)

### Browser Extension (Chromium)

- **Stack:** Vanilla JavaScript, Manifest V3
- **Injection:** `content-loader.js` at `document_start` → dynamic `import(coreEntry.js)`
- **No bundler:** ESM modules loaded from extension origin via `chrome.runtime.getURL`

---

## 4. Key Systems & Functions

### 4.1 ItemMap Detection (`itemDetector.js`)

**Purpose:** Find "content clusters" on a page (e.g., Instagram posts, Pinterest pins) so the user can hover and save a specific item.

- **`detectItemMaps(root)`** — Async. Scans `body *` for parents with 3+ similar children. Forms "runs" by identity/structure/evidence type. Returns list of ItemMap entries.
- **Evidence types:** `A` (anchor-based, e.g. link with image) vs `B` (interaction-based, e.g. share button)
- **`isValidTypeAAnchor(anchor)`** — Async. Validates anchor: `resolveAnchorUrl` must return URL; absolute href → pass; relative href → must contain visually significant `<img>` (48px min, aspect 0.2–5.0). Uses `img.decode()` and natural dimensions fallback.
- **`isMeaningfulItemMap(elements, evidenceType)`** — Async. Validates a group: nav/sidebar rejection, `richCount >= 40%` early pass, `avgAnchors >= 1` for Type A.
- **Sibling recovery:** Expands ItemMaps by adding missed siblings (same parent, `hasPartialClassOverlap`).
- **Bottom-up recovery:** Disabled (was causing editorial false positives).

### 4.2 Data Extraction (`dataExtractor.js`)

- **`resolveAnchorUrl(anchor)`** — Resolves href to absolute URL; returns null for functional/same-domain-only links.
- **`extractMetadataForCoreItem(element, hoveredTarget, ...)`** — Extracts title, image, URL for a detected item.
- **`resolveTypeACoreItem(itemMapElement, hoveredTarget)`** — Async. Finds the "core item" within an ItemMap (e.g., single post card vs full feed).
- **`findImagesDeep(root)`** — Recursively finds `<img>` including inside Shadow DOM.
- **`isImgVisuallySignificantForAnchor(img)`** — Async. Uses `img.decode()`, layout + natural dimensions, 48px min, aspect ratio 0.2–5.0.

### 4.3 URL Resolution (`urlResolver.js`)

- **`getOriginalUrl(element)`** — Extracts URL from data attributes, etc.
- **`resolveCached(url, options)`** — Resolves redirects, cleans tracking params.
- **`isNavigationUrl(url, element)`** — Excludes image assets, data URIs.
- **`getUrlIntent(url)`** — Classifies as DISCOVERY, etc.

### 4.4 Core Entry (`coreEntry.js`)

- **`updateCoreSelectionFromTarget(target, clientX, clientY)`** — Async. On hover: finds cluster container, validates anchor, resolves core item, extracts metadata, shows highlight/tooltip.
- **`schedulePreScan()`** — Debounced (80ms). Runs `detectItemMaps`, fingerprints, renders green candidate outlines.
- **Platform wrappers:** `withInstagramActiveHoverUrl`, `withLinkedInCanonicalActiveHoverUrl`, etc. — Normalize metadata per platform.

### 4.5 Save Flow

1. User presses `Cmd+Shift+S` → background script receives command.
2. Extension sends save request to `http://localhost:3000/api/v1/save-url` (or Firestore save server).
3. Payload: `url`, `title`, `img_url`, `domain`, `type`, etc.
4. Server: metadata extraction, categorization; Electron: Firestore write.
5. Renderer: real-time Firestore listener updates UI.

---

## 5. Important Conventions & Constraints

### From `.cursorrules`

- **Sync/Async parity:** When modifying hover detection, container extraction, or host-count logic, apply changes to BOTH Sync and Async paths. Use shared utilities to prevent drift.
- **Visibility:** Use `isVisibleForHostCheck` consistently in Sync and Async.
- **Consistency audit:** `window.__blinkInconsistencyCheck = true` logs when Async expands beyond Sync boundaries.

### Recent Design Decisions

- **Bottom-up recovery disabled** — Prevents editorial content (e.g. `#topic_contents`) from being misclassified as ItemMaps.
- **`richCount` early exit** — Single-element containers can pass `isMeaningfulItemMap` if `getTextLen > 20` or `hasMultipleTextBlocks`; this bypasses `avgAnchors` check (known cause of editorial false positives).
- **Type A validation** — Relative-path anchors require a visually significant `<img>` (48px min); absolute URLs pass without image check.

---

## 6. Documentation References

| Doc | Purpose |
|-----|---------|
| `TypeA-ItemMap-Detection-Audit.md` | Full requirements for Type A ItemMap |
| `Bottom-Up-Recovery-Audit.md` | Why bottom-up was disabled |
| `richCount-Implementation-Audit.md` | `richCount` calculation, 40% threshold |
| `Sibling-Expansion-Global-Pattern-Audit.md` | How ItemMaps expand (sibling recovery, Type B scope) |
| `Pinterest-Service-Worker-Navigation-Preload-Analysis.md` | SW preload failure, DOM stability, bypass options |
| `VERIFICATION_GATES_AUDIT.md` | Purity check, host counting (may reference older hoverDetector) |

---

## 7. Communication Flow

```
Browser Extension (content script)
    → coreEntry.js (hover, detectItemMaps, extractMetadata)
    → On save: HTTP POST to localhost:3000 or localhost:3002

Electron Main Process
    → Listens on 3001 (pending save), 3002 (Firestore save)
    → IPC to renderer for UI updates
    → Firebase SDK for Firestore/Auth

Server (Express)
    → Port 3000: /api/v1/save-url
    → Metadata extraction, categorization
```

---

## 8. For Claude: Prompt-Writing Guidelines

When writing prompts for Cursor:

1. **Specify the component** — e.g. "In `itemDetector.js`", "In `dataExtractor.js`".
2. **Reference existing patterns** — e.g. "Follow the same structure as `isValidTypeAAnchor`".
3. **Mention sync/async parity** — If the change touches hover/container logic, remind Cursor to update both Sync and Async paths.
4. **Point to audits** — e.g. "See `docs/TypeA-ItemMap-Detection-Audit.md` for requirements."
5. **State constraints** — e.g. "Do not add retry logic", "Maintain 48px minimum for image size".
