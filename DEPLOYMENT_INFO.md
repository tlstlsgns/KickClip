# KickClip Deployment & Recovery Info

**Last updated:** 2026-04-21
**Current stable commit:** `f8089a0` (Initial commit — Phase A complete)
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
| **Default GCP resource location** | `us-central1` |
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
| **Default GCP resource location** | `us-central1` |
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
| `server/service-account.json` | Firebase Admin credential (DEV) | ⚠️ **NOT BACKED UP** (TODO) |
| `client/.env` | Electron app environment variables | ⚠️ **NOT BACKED UP** (TODO) |
| `functions/.env` | Cloud Functions environment *(does not exist as of 2026-04-21)* | N/A |

> 📌 **TODO:** Extend Bitwarden backup to cover `server/.env`, `server/service-account.json`, `client/.env`. See Phase B / recovery backlog.

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
7. **Restore other env files (TODO — once backed up):** `server/.env`, `server/service-account.json`, `client/.env`.

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

- **2026-04-21** — Initial version. Captures state after Phase A (DEV/PROD build separation) completion.
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
