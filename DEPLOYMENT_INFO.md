# KickClip Deployment & Recovery Info

**Last updated:** 2026-04-21 (evening — new taxonomy migration)
**Current stable commit:** `6df7b9f` (feat: migrate to new 4-category taxonomy)
**Maintainer:** tlstlsgns
**Contact:** [email protected]

---

## 🏗 Environments Overview

KickClip operates in two parallel environments. Every environment has its own Firebase project, OAuth client, and Chrome extension identity.

| Env | Purpose | Who loads it | Source |
|---|---|---|---|
| **DEV** | Local development & testing | Developer only | `browser-extension/chromium/` (unpacked) |
| **PROD** | Customer distribution | Customers | `browser-extension/dist/kickclip-prod.zip` |

---

## 🔥 Firebase Projects

### DEV — `saveurl-a8593`

| Field | Value |
|---|---|
| **Firebase Console** | https://console.firebase.google.com/project/saveurl-a8593 |
| **GCP Project Number** | `658386350246` |
| **Cloud Functions URL** | `https://api-gstf2hxbiq-du.a.run.app` |
| **Default GCP resource location** | `asia-northeast3` *(Seoul)* |
| **Cloud Functions region** | `asia-northeast3` *(verified 2026-04-21 via deploy log)* |
| **Storage bucket** | `saveurl-a8593.firebasestorage.app` |
| **Authentication** | Enabled (Google provider) |
| **Firestore** | Initialized |
| **Storage** | Initialized |

### PROD — `saveurl-prod`

| Field | Value |
|---|---|
| **Firebase Console** | https://console.firebase.google.com/project/saveurl-prod |
| **GCP Project Number** | `108278020684` |
| **Cloud Functions URL** | `https://api-hn4mxotviq-du.a.run.app` |
| **Default GCP resource location** | `asia-northeast3` *(Seoul)* |
| **Cloud Functions region** | `asia-northeast3` *(deployed 2026-04-21)* |
| **Storage bucket** | `saveurl-prod.firebasestorage.app` |
| **Storage region** | `US-EAST1` *(set during Storage initialization — cannot be changed)* |
| **Authentication** | Enabled (Google provider) |
| **Firestore** | Initialized |
| **Storage** | Initialized |

---

## 🔑 OAuth Clients (GCP)

### DEV OAuth Client

| Field | Value |
|---|---|
| **GCP Console** | https://console.cloud.google.com/auth/clients?project=saveurl-a8593 |
| **Client ID** | `658386350246-kinolt4jf9l7131r76rnbii0407ookcj.apps.googleusercontent.com` |
| **Application ID** *(Chrome Extension ID)* | `knpcebcbpcjoiagccededjhamononapd` |
| **Consent Screen** | External, Testing status |
| **Scopes** | `openid`, `email`, `profile`, `gmail.readonly` |
| **Test users** | [email protected] |

### PROD OAuth Client

| Field | Value |
|---|---|
| **GCP Console** | https://console.cloud.google.com/auth/clients?project=saveurl-prod |
| **Client ID** | `108278020684-gc4o3rfjldhb5bvjo8fgm3shnbdj8j8c.apps.googleusercontent.com` |
| **Application ID** *(Chrome Extension ID)* | `kbdieogmfmbeeplefmcielmcenpajioi` |
| **Consent Screen** | External, Testing status |
| **Scopes** | `openid`, `email`, `profile`, `gmail.readonly` |
| **Test users** | [email protected] *(100-user limit applies until public release)* |

> ⚠️ **Changing Extension ID?** If the `.pem` key is regenerated or the manifest `key` field changes, the Chrome Extension ID will change. In that case, the corresponding OAuth Client's Application ID must be updated — otherwise sign-in will fail with `auth/invalid-credential` ("access_token audience is not for this project"). GCP propagation takes 5–30 minutes after saving.

---

## 🔐 Chrome Extension Keys (RSA 2048-bit)

Chrome Extension IDs are **deterministically derived** from the `key` field in `manifest.json`. The `key` is the public half of an RSA key pair. The **private half (`.pem` files) must never be lost or leaked.**

### Local file locations
- DEV: `browser-extension/keys/kickclip-dev.pem`
- PROD: `browser-extension/keys/kickclip-prod.pem`

Both are **git-ignored** (never commit).

### 🔒 Backup locations

**Primary backup — Bitwarden:**
- Account email: [email protected]
- Vault items:
  - `KickClip - DEV Extension Signing Key` (Secure Note)
  - `KickClip - PROD Extension Signing Key` (Secure Note)

> ⚠️ **Loss of `.pem` = permanent Extension ID mismatch.** Customer-installed PROD extensions can no longer receive updates (Extension IDs don't match), and their local data may be orphaned. **This is the single most irrecoverable disaster scenario.**

### Extension IDs

| Env | Extension ID |
|---|---|
| DEV | `knpcebcbpcjoiagccededjhamononapd` |
| PROD | `kbdieogmfmbeeplefmcielmcenpajioi` |

### Public keys (from manifests)

Full values in `browser-extension/chromium/manifest.dev.json` and `manifest.prod.json` (committed to git). First 40 chars for identification:

- DEV `key`: `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCg...`
- PROD `key`: `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCg...`

*(The "BEGIN PUBLIC KEY" prefix is identical across all RSA 2048-bit keys — differentiation is in the body.)*

---

## 🚀 Build & Deploy

### DEV workflow

```bash
cd browser-extension
npm install   # triggers postinstall → build:dev automatically
# OR manually:
npm run build:dev
```

Then in Chrome:
1. `chrome://extensions`
2. Enable "Developer mode" (top-right)
3. "Load unpacked" → select `browser-extension/chromium/`

DEV artifacts (`chromium/manifest.json`, `chromium/config.js`) are generated on-the-fly. They are git-ignored.

### PROD workflow

```bash
cd browser-extension
npm run build:prod
# Output: browser-extension/dist/kickclip-prod.zip
```

Distribute the zip to customers. **Always verify zip contents by extracting locally first.** Look for:
- `manifest.json` should contain PROD `client_id` (`108278020684-...`)
- `config.js` should contain `KC_IS_DEV = false`

### Customer installation

Instructions for end customers:

1. Extract the KickClip zip
2. Open Chrome, go to `chrome://extensions`
3. Enable "Developer mode" (top-right toggle)
4. Click "Load unpacked" → select the extracted folder
5. Extension icon appears in toolbar → click → sign in with Google

### Shortcut keys

Default shortcut `Cmd+Shift+S` (macOS) / `Ctrl+Shift+S` (Windows) is **suggested in manifest**, but Chrome may not auto-assign it if another extension already claims that combination. Customers can manually assign at `chrome://extensions/shortcuts`.

---

## 🔒 Other Sensitive Files (git-ignored)

These files exist in the working tree but are excluded from git. Each needs its own backup strategy.

| File | Content | Current backup status |
|---|---|---|
| `browser-extension/keys/*.pem` | Extension signing keys | ✅ Bitwarden |
| `server/.env` | Gemini API key, other server-side secrets | ⚠️ **NOT BACKED UP** (TODO) |
| `server/service-account-dev.json` | Firebase Admin credential (DEV project `saveurl-a8593`) | ✅ Bitwarden *(backed up 2026-04-21)* |
| `server/service-account-prod.json` | Firebase Admin credential (PROD project `saveurl-prod`) — **newly generated 2026-04-21** | ✅ Bitwarden *(backed up 2026-04-21)* |
| `client/.env` | Electron app environment variables | ⚠️ **NOT BACKED UP** (TODO) |
| `functions/.env` | Cloud Functions environment *(does not exist as of 2026-04-21)* | N/A |

> 📌 **TODO (remaining):** Extend Bitwarden backup to cover `server/.env` and `client/.env`. See Phase B / recovery backlog.
>
> 📌 **DONE 2026-04-21:** Bitwarden backup for DEV (`service-account-dev.json`, renamed from `service-account.json`) and PROD (`service-account-prod.json`, new key generated). `.gitignore` pattern updated from `service-account.json` to `service-account*.json` to cover both.

---

## 🛡 Security Rules

Current Firestore and Storage security rules (applied to both DEV and PROD).

### Firestore Rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/items/{itemId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/directories/{dirId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/instagramSession/{sessionId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### Storage Rules
Copied from DEV to PROD verbatim. See Firebase Console for current content.

---

## 🆘 Disaster Recovery Playbook

### Scenario A: Developer PC lost / new machine

1. **Install toolchain:**
   - Git: `xcode-select --install` (macOS) or package manager
   - Node.js: https://nodejs.org (LTS version)
   - Chrome
2. **Clone repo:**
   ```bash
   git clone https://github.com/tlstlsgns/KickClip.git ~/Projects/KickClip
   cd ~/Projects/KickClip
   ```
3. **Restore `.pem` files from Bitwarden:**
   - Install Bitwarden → log in (use master password)
   - Open `KickClip - DEV Extension Signing Key` → copy Notes content
   - Create file:
     ```bash
     mkdir -p ~/Projects/KickClip/browser-extension/keys
     ```
   - Paste DEV key content into `~/Projects/KickClip/browser-extension/keys/kickclip-dev.pem`
   - Repeat for PROD key
   - Secure permissions:
     ```bash
     chmod 600 ~/Projects/KickClip/browser-extension/keys/*.pem
     ```
4. **Install dependencies + DEV build:**
   ```bash
   cd ~/Projects/KickClip/browser-extension
   npm install
   # postinstall hook automatically runs build:dev
   ```
5. **Load DEV in Chrome:**
   - `chrome://extensions` → "Load unpacked" → select `browser-extension/chromium/`
   - Extension ID should be `knpcebcbpcjoiagccededjhamononapd` (matches DEV OAuth Client)
6. **Sign in test:** If it fails, verify GCP OAuth Client's Application ID matches the loaded Extension ID.
7. **Restore other env files:**
   - `server/service-account-dev.json` — restore from Bitwarden (item: `KickClip - DEV Firebase Service Account Key`). `chmod 600`.
   - `server/service-account-prod.json` — restore from Bitwarden (item: `KickClip - PROD Firebase Service Account Key`). `chmod 600`.
   - `server/.env` — ⚠️ not yet backed up; retrieve from Gemini API key source (Google AI Studio) if needed.
   - `client/.env` — ⚠️ not yet backed up; reference `client/.env.example` if exists.
8. **If running migration scripts:**
```bash
   cd ~/Projects/KickClip
   node scripts/migrate-schema.js --project=dev --dry-run
```
   Dry-run should show `To update: 0 items` on a schema-current database.

### Scenario B: `.pem` file accidentally deleted locally

- Retrieve from Bitwarden → paste back to original file path.
- Since the key content is unchanged, Extension ID remains the same. No GCP/Firebase changes needed.

### Scenario C: GitHub account locked / deleted

- Local clone on developer machine is the source of truth.
- Create new remote (GitHub/GitLab/Bitbucket) → push:
  ```bash
  git remote set-url origin <new-url>
  git push -u origin main
  ```

### Scenario D: Bitwarden account inaccessible

- Master password forgotten → Bitwarden cannot help (zero-knowledge).
- Fallback: if `.pem` files still exist locally, regenerate backup immediately via different method.
- If `.pem` files also lost → **Extension ID recovery impossible.** Options:
  1. Generate new `.pem` → new Extension ID → update GCP OAuth Client → redistribute zip to customers (they must reinstall)
  2. Accept ID change for DEV only; keep PROD ID intact by restoring from any secondary backup if available.

> 📌 **Strong recommendation:** After Bitwarden setup, maintain at least one **physical** copy of master password (paper in safe) to prevent Scenario D.

---

## 📚 Related Documents

- `browser-extension/BUILD.md` — detailed build instructions (may need Phase B update)
- `docs/PROJECT_BRIEFING_0420.md` — latest full architecture audit
- `README.md` — general project overview
- `FIRESTORE_RULES_SETUP.md` — Firestore security rule setup history

---

## 🗓 Change Log
- **2026-04-22** — Clipboard copy feature + OptimisticCard performance optimization + tempId end-to-end matching.
  - **Sub-task 4 — Clipboard copy on save:**
    - **Sub-task 4.1**: Added `clipboardWrite` permission to both `manifest.dev.json` and `manifest.prod.json`.
    - **Sub-task 4.2**: Added 4 helpers in `coreEntry.js` — `getDominantImageElement`, `imgElementToBlob`, `showCopyToast`, and category-dispatch logic — invoked from both save paths (page save and CoreItem save) behind `window.self === window.top` guard.
    - **Sub-task 4.3.1**: Fixed `ClipboardItem` to accept only `image/png` (Chrome rejects JPEG/WebP/others); all non-PNG MIME types now fall through to canvas re-encoding.
    - **Sub-task 4.3.2**: Added `<all_urls>` to `host_permissions` in both manifests — enables background-script cross-origin image fetch.
    - **Sub-task 4.3.3**: Added `fetch-image` message handler in `background.js` — fetches image URL via extension privileges (bypasses page CORS), returns base64 data URL via `FileReader`.
    - **Sub-task 4.3.4**: Added Attempt 1.5 (background-script fetch) to `imgElementToBlob`, plus new `dataUrlToPngBlob` helper that re-encodes any image type to PNG via canvas. Order is now: direct fetch (PNG only) → background fetch → canvas-from-rendered-img as last resort.
    - **Sub-task 4.4**: Moved Toast to top-center with brand purple background `rgba(188, 19, 254, 0.92)` (from `brandConfig.js` `KEY_COLOR_HEX: '#BC13FE'`).
    - **Sub-task 4.5**: Replaced fire-and-forget clipboard copy with promise-based `performClipboardCopy` + `buildToastMessage` — unified Toast reflects both copy and save result. Save success is determined by `saveShutterStatus === 'success'` (existing shutter logic reused, no extra server round-trip). Toast CSS gained `white-space: pre-line` and `text-align: center` for multi-line messages. `handleClipboardCopy` fully removed.
    - Toast message matrix: `Image copied & saved` / `{subject} copied\n(save failed)` / `{subject} saved\n(copy failed)` / `Failed`, with subject per category: `Image` / `confirmedType` (SNS, e.g. "contents"/"post") / `Mail URL` / `Page URL`.
    - Image category's binary copy success does NOT fall back to URL — failure path returns `{ success: false }` so Toast accurately reflects state.
  - **Sub-task 5 — OptimisticCard performance + precise matching:**
    - **Sub-task 5.1 — Screenshot 2-stage split:** `capturePageScreenshotBase64()` kept as-is; added two new functions — `capturePageScreenshotRaw()` (Stage 1: UI hide + `waitForRepaint` + `chrome.tabs.captureVisibleTab`, returns raw dataUrl) and `processPageScreenshot(rawDataUrl)` (Stage 2: bg-color sampling + scrollbar crop). Save path A refactored so OptimisticCard dispatches immediately after Stage 1 with raw dataUrl as `imgUrl`, while Stage 2 runs in parallel with userId/fetch-metadata/etc. and is awaited just before payload construction. Save path B (CoreItem) unchanged (uses `extractImageFromCoreItem`).
    - **Sub-task 5.2 — tempId end-to-end propagation:** `tempId` generation hoisted in both save paths to precede both optimistic-card dispatch AND payload construction. Payload now includes `...(tempId ? { temp_id: tempId } : {})`. Server (`functions/src/index.ts`) validates `clientTempIdRaw = typeof req.body.temp_id === "string" ? req.body.temp_id.trim() : ""` and conditionally writes `firestoreEntry.temp_id`. Cloud Functions redeployed to both DEV (`saveurl-a8593`) and PROD (`saveurl-prod`) in `asia-northeast3`. Backward compatible — absent `temp_id` behaves exactly as before.
    - **Sub-task 5.3 — Precise tempId-based matching:** `sidepanel.js` item-to-optimistic-card matching now uses Priority 1 (exact `item.temp_id` match via `optimisticCards.has(tempId)`) with Priority 2 (URL-based iteration) as fallback for legacy Firestore docs without `temp_id`. DOM in-place promotion logic unchanged — the change is isolated to a single ~15-line matching block.
    - Resolves ambiguity when the same URL is saved multiple times in quick succession.
    - Existing in-place DOM promotion behavior preserved — OptimisticCard element continues to exist and is updated (dataset fields) rather than replaced, avoiding flash/flicker.
- **2026-04-21 (evening)** — Taxonomy overhaul + YouTube thumbnail feature + data migration.
  - **Sub-task 1 — Unified Video card layout** with Page card layout (horizontal "portrait extracted" style).
  - **Sub-task 2 — YouTube thumbnail extraction:**
    - `extractYouTubeShortcodeFromUrl()` strictly parses YouTube video/shorts URLs.
    - `getYouTubeThumbnailUrl()` builds `img.youtube.com/vi/{id}/hqdefault.jpg` URL.
    - `hqdefault.jpg` chosen over `maxresdefault.jpg` because the latter returns a valid 120×90 gray placeholder on 404 (undetectable via `img.onerror`).
    - `coreEntry.js` injects thumbnail as `img_url` with `img_url_method: 'youtube-thumbnail'`; screenshot capture skipped for YouTube saves.
    - Server allowlist (`functions/src/index.ts`) extended to accept `'youtube-thumbnail'` method value.
    - Cloud Functions redeployed to both DEV and PROD (`asia-northeast3`).
    - `host_permissions` on both manifests extended with 5 YouTube domains.
  - **Sub-task 3 — New 4-category taxonomy:**
    - Categories: `{SNS, Contents, Mail, Page}` → `{SNS, Image, Mail, Page}`.
    - `Contents` split: images → `Image`; videos/other → `Page` (Video category removed entirely).
    - SNS `confirmed_type`: `{Image, Video, Post, Page}` → `{contents, post}` (lowercase).
    - Image/Mail/Page `confirmed_type`: always `""`.
    - `detectItemCategory` rewritten to produce new taxonomy. Step 2.5 "Unconditional Video hosts" restored after 3.1 regression — YouTube/Vimeo/Twitch URLs return `Page` before dominant-media check.
    - `sidepanel.js` gained `normalizeItemCategoryAndType()` for render-time back-compat with legacy Firestore docs.
    - Sidepanel tab UI: `Img / Video / Mail / Pages` → `Img / SNS / Mail / Pages`.
    - SNS cards split by `confirmed_type`: `contents` → grid (`image_card`), `post` → full-width (`pages_card`).
    - `.data-card` height: `80px` → `130px` for `image_card` container (taller thumbnail in grid layout).
  - **Sub-task 3.4 — Firestore data migration:**
    - Script: `scripts/migrate-schema.js` — uses `listDocuments()` to include virtual parent user documents.
    - DEV (`saveurl-a8593`): 97 items scanned, all successfully on new schema post-migration.
    - PROD (`saveurl-prod`): 42 items scanned, 23 migrated from legacy schema, 19 already new.
    - Legacy fields untouched except `category` and `confirmed_type` — `img_url`, `img_url_method`, `createdAt`, etc. preserved.
  - **Infrastructure:**
    - `firebase-admin` installed as root-level devDependency (for migration scripts).
    - Root `package.json` formalized as `kickclip-scripts` (private, for maintenance scripts only).
    - `server/service-account.json` renamed to `server/service-account-dev.json` for disambiguation.
    - New PROD service account key generated → `server/service-account-prod.json`.
    - `.gitignore` pattern updated `service-account.json` → `service-account*.json` to cover both files.
    - `server/package.json` `dev` script updated to reference new DEV key filename.
    - Bitwarden backups added for both DEV and PROD service account keys.
  - **PROD release:**
    - New `dist/kickclip-prod.zip` rebuilt (324.98 KB, 23 files).
    - Verified: PROD public key + PROD OAuth client_id + YouTube host_permissions all present.
    - **Existing customers must reinstall** — old zip does not understand new schema.
  - Commit: `6df7b9f`

- **2026-04-21 (morning)** — Initial version. Captures state after Phase A (DEV/PROD build separation) completion.
  - Git repository initialized and pushed to GitHub private repo `tlstlsgns/KickClip`.
  - `.pem` keys backed up to Bitwarden.
  - Commit: `f8089a0`

---

## 📌 Known Issues / Tech Debt

1. `directoryId: "undefined"` string bug in some Firestore items (Phase B candidate).
2. `sidepanel.css` declared in `web_accessible_resources` but file doesn't exist (Phase B cleanup candidate).
3. Build artifacts lack version/commit-hash in filename (Phase B work).
4. Placeholder detection in `build-prod.js` is warning-only, not hard-fail (Phase B work).
5. Server-side `.env` and service account files not yet backed up (high priority TODO).
6. Chrome Web Store official listing not yet pursued (requires Google Gmail scope verification).
