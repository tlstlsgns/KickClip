# KickClip Secrets Inventory

Last updated: 2026-04-23 (HEAD: fd98d78)

This document is the authoritative map of every secret-bearing file in the KickClip repository. Values are **never** stored here - only paths, purposes, backup status, and recovery procedures.

## Backup method

All secrets are stored as **Bitwarden Secure Notes** in the developer's personal vault (`tlstlsgns@gmail.com`). File-attachment-based backup is not used. Each Secure Note contains:

- **Notes field**: the full text content of the source file, pasted verbatim.
- **Custom Fields**: metadata for recovery and integrity verification (see per-item rows below).

Recovery always proceeds by opening the Bitwarden Secure Note, copying the Notes field, and writing it to the source path via `pbpaste > <source_path>`.

## Legend

| Symbol | Meaning |
|---|---|
| 🔐 | Backed up to Bitwarden as Secure Note, integrity verified |
| 🔐⚠️ | Backed up but integrity verification intentionally skipped (see notes) |
| ⏳ | Backup pending |
| 📄 | Tracked in git, no secret values (template/example) |
| 🌐 | Public-by-design (not a secret) |

## Repository visibility

- Remote: `git@github.com:tlstlsgns/KickClip.git`
- Visibility: **private** (verified via GitHub API 404 on unauthenticated probe, 2026-04-23)
- Git history status for real-secret files: **clean** - zero commits on any `.env`, `.pem`, or `service-account-*.json` file as of HEAD `fd98d78`.

## Inventory

### Firebase service accounts (Admin SDK)

| File | Firebase project | Backup | Bitwarden item | Integrity | Recovery |
|---|---|---|---|---|---|
| `server/service-account-dev.json` | `saveurl-a8593` | 🔐⚠️ | `KickClip - DEV Firebase Service Account` | Verification skipped (see note below) | See recovery playbook |
| `server/service-account-prod.json` | `saveurl-prod` | 🔐⚠️ | `KickClip - PROD Firebase Service Account` | Verification skipped (see note below) | See recovery playbook |

**Why verification skipped**: these keys are cheaply regenerable via Firebase Console -> Service accounts -> Generate new private key. If the Bitwarden memo turns out to be corrupted when needed, regeneration costs minutes, not data. Acceptable risk trade-off.

**Consumption (from Phase 3.1b grep):**
- `server/package.json:9` - `dev` script sets `GOOGLE_APPLICATION_CREDENTIALS=./service-account-dev.json` inline.
- `scripts/migrate-schema.js:68-69` - hardcodes `server/service-account-dev.json` and `server/service-account-prod.json` via `firebase-admin`.
- `functions/` - does not read these files (uses Cloud Functions runtime service account).

**Rotation impact**: low. Cloud Functions are unaffected.

### Chrome extension signing keys

| File | Extension ID | Backup | Bitwarden item | Integrity indicator |
|---|---|---|---|---|
| `browser-extension/keys/kickclip-dev.pem` | `knpcebcbpcjoiagccededjhamononapd` | 🔐 | `KickClip - DEV Extension Signing Key` | `public_key_sha256` in Bitwarden Custom Field |
| `browser-extension/keys/kickclip-prod.pem` | `kbdieogmfmbeeplefmcielmcenpajioi` | 🔐 | `KickClip - PROD Extension Signing Key` | `public_key_sha256` in Bitwarden Custom Field |

**Integrity verification approach (important)**: `.pem` files use **`public_key_sha256`** - the SHA256 hash of the DER-encoded public key - as the integrity indicator, NOT the file's byte-level SHA256. Reason: `.pem` text can differ byte-level (trailing newline, line-ending style) between source file and Bitwarden memo while the underlying RSA key is identical. Format-invariant verification is required.

**2026-04-23 verification result**: both DEV and PROD `.pem`s showed byte-level hash mismatch between local file and Bitwarden memo but produced identical extension IDs and both passed `openssl rsa -check`. Confirmed same RSA key, different formatting. Backup integrity confirmed via extension-ID identity.

**Verification procedure (rerun anytime)**:

```bash
# Replace <pem-path> and <expected-ext-id> per key
# Also: copy the corresponding Bitwarden memo's Notes field to clipboard first

calc_ext_id() {
  local pem_input="$1"
  openssl rsa -in "$pem_input" -pubout -outform DER 2>/dev/null \
    | openssl dgst -sha256 -binary \
    | head -c 16 \
    | xxd -p \
    | tr '0-9a-f' 'a-p'
}

# Local file extension ID
calc_ext_id <pem-path>

# Bitwarden memo extension ID
pbpaste > /tmp/kc-verify.pem && calc_ext_id /tmp/kc-verify.pem && rm -f /tmp/kc-verify.pem

# Both must equal <expected-ext-id>.
```

**Rotation impact**: catastrophic. Extension ID is deterministically derived from the `.pem` public key. Losing a `.pem` forces:

1. New extension ID.
2. All testers must reinstall.
3. New OAuth Client ID registration in Google Cloud Console -> `manifest.*.json -> oauth2.client_id` update.
4. Possible `host_permissions` updates.

### Environment files - active

| File | Purpose | Key count | Keys (names only) | Backup | Bitwarden item | Integrity |
|---|---|---|---|---|---|---|
| `server/.env` | Local Express backend - Gemini API access, Firebase Storage bucket | 2 | `GEMINI_API_KEY`, `FIREBASE_STORAGE_BUCKET` | 🔐 | `KickClip - server/.env (GEMINI_API_KEY + Storage Bucket)` | `sha256` in Bitwarden Custom Field |
| `client/.env` | Electron desktop app - Firebase client SDK + Google OAuth | 10 | `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`, `FIREBASE_MEASUREMENT_ID`, `OAUTH_CALLBACK_PORT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 🔐 | `KickClip - client/.env (Firebase + Google OAuth)` | `sha256` in Bitwarden Custom Field |

**Sensitivity:**
- `GEMINI_API_KEY` (`server/.env`): **real secret**. Leakage -> uncapped billing on developer's Google AI account. Rotate at <https://aistudio.google.com/app/apikey>.
- `GOOGLE_CLIENT_SECRET` (`client/.env`): **real secret**. Leakage -> OAuth impersonation. Rotate at Google Cloud Console -> APIs & Services -> Credentials -> the Electron OAuth client -> Reset secret.
- `FIREBASE_API_KEY` family (`client/.env`): 🌐 public-by-design per Firebase client-SDK model. Backed up for convenience, not secrecy.
- `OAUTH_CALLBACK_PORT`: non-secret configuration.

**Verification procedure (rerun anytime)**:

```bash
# Copy the Bitwarden memo's Notes field to clipboard, then:
diff <(shasum -a 256 <env-path> | awk '{print $1}') <(pbpaste | shasum -a 256 | awk '{print $1}') \
  && echo "MATCH" || echo "MISMATCH"
```

**2026-04-23 note on `client/.env`**: initial Bitwarden memo contained an outdated `GOOGLE_CLIENT_SECRET` value. Authoritative source determined by successful Electron Google OAuth login using the local file. Memo was re-populated with the current local file content; re-verification passed.

### Environment files - templates (tracked, no values)

| File | Purpose | Status |
|---|---|---|
| `client/.env.example` | Template for `client/.env` | 📄 All values verified as PLACEHOLDER (Phase 3.1, 2026-04-23) |
| `server/.env.example` | Template for `server/.env` | 📄 `GEMINI_API_KEY` / `FIREBASE_STORAGE_BUCKET` are PLACEHOLDER; `GOOGLE_APPLICATION_CREDENTIALS` is a non-secret filepath placeholder (`./service-account.json`) |

**Intentionally tracked** - `.env.example` is onboarding documentation. Do not `.gitignore`.

**Deferred cleanup (not handled in this backup phase):**
- `server/.env.example:1` contains legacy `# Blink Server Environment Variables` comment (Phase 4 rebrand miss).
- `server/.env.example:11` contains `GOOGLE_APPLICATION_CREDENTIALS` line - appears to be dead entry as actual consumption paths (`server/package.json:9`, `scripts/migrate-schema.js:68-69`) hardcode the service-account JSON path instead of reading this env var.
- `.gitignore:72-73` contains legacy `firebase-service-account.json` patterns superseded by `service-account*.json` at line 75.

All three are queued for a future legacy-cleanup phase.

### Firebase project config (tracked, non-secret)

| File | Purpose | Status |
|---|---|---|
| `.firebaserc` | Firebase project aliases (`default`/`dev`/`prod`) | 🌐 Project IDs only |
| `firebase.json` | Cloud Functions source + deploy hooks | 🌐 Deploy config only |

### Extension-bundled Firebase config (tracked, public-by-design)

Files embedding Firebase Web API keys (`AIzaSy...`) - public-by-design per Firebase client-SDK security model, protected by Firestore security rules:

- `browser-extension/chromium/brandConfig.js`
- `browser-extension/chromium/sidepanel.js`
- `client/src/lib/brandConfig.ts`
- All `docs/PROJECT_BRIEFING_*.md` (quote `brandConfig.js` verbatim)
- `README.md`

**Do not hide these.** Hiding breaks the client SDK. Threat model assumes world-readable.

## Recovery playbook

All recovery procedures below assume Bitwarden access. The basic pattern is:

1. Open the relevant Bitwarden Secure Note.
2. Select the entire Notes field (`Cmd+A`), copy (`Cmd+C`).
3. In terminal at repo root: `pbpaste > <source_path>`
4. Verify integrity per the item's indicator (see per-item "Verification procedure" above).
5. Restart any consuming process (local server, Electron app, etc.).

### Service account key compromised or lost

1. Firebase Console -> affected project -> Service accounts -> **delete** compromised key.
2. Generate new key -> save to `server/service-account-{dev,prod}.json`.
3. **Update Bitwarden Secure Note**: open memo -> select Notes field all -> delete -> paste new JSON content -> save.
4. Update `backup_date` Custom Field.
5. Restart local `server/` module or migration script if running.
6. No Cloud Functions changes needed.

### Extension `.pem` compromised or lost

1. Check Bitwarden first. Verify via the `public_key_sha256` Custom Field and the verification procedure above.
2. If truly lost (Bitwarden memo also corrupted): full extension-ID migration required:
   - Generate new `.pem` via Chrome repacking.
   - New extension ID registered as new OAuth Client ID in Google Cloud Console.
   - Update `manifest.dev.json` / `manifest.prod.json` `oauth2.client_id` and any `host_permissions`.
   - Rebuild, redistribute user package, notify all testers to reinstall.

### `GEMINI_API_KEY` leaked

1. <https://aistudio.google.com/app/apikey> -> delete leaked key.
2. Create new key -> write to `server/.env`.
3. Update Bitwarden memo Notes field -> recompute `sha256` Custom Field.
4. Check usage dashboard for anomalous calls during leak window.

### `GOOGLE_CLIENT_SECRET` leaked

1. Google Cloud Console -> APIs & Services -> Credentials -> Electron OAuth client -> **Reset secret**.
2. Update `client/.env` with new secret.
3. Update Bitwarden memo Notes field -> recompute `sha256` Custom Field.
4. Restart Electron clients.

### `.env` file deleted from working tree (not leak, just loss)

1. Open corresponding Bitwarden Secure Note.
2. `Cmd+A`, `Cmd+C` on Notes field.
3. In repo root terminal: `pbpaste > server/.env` (or `client/.env`).
4. Verify with the procedure from "Environment files - active" above.
5. Restart consuming process.

## Do-not-commit enforcement (verified 2026-04-23)

Verified via `git check-ignore` in Phase 2.1:

| File | `.gitignore` rule that covers it |
|---|---|
| `client/.env` | `client/.gitignore:2:.env` |
| `server/.env` | `.gitignore:66:.env` |
| `server/service-account-*.json` | `.gitignore:75:service-account*.json` |
| `browser-extension/keys/*.pem` | `browser-extension/.gitignore:9:keys/` |

All real-secret files confirmed ignored. Zero commits in history for any of them.

## Adding a new secret file in the future

1. Add a pattern to the appropriate `.gitignore` **before** creating the file.
2. Verify with `git check-ignore -v <path>`.
3. Create Bitwarden Secure Note with Notes = file content, add Custom Fields (at minimum: `source_path`, `backup_date`, `git_head_at_backup`, integrity indicator).
4. Add a row to this document.
5. Commit this document (never the secret file).
