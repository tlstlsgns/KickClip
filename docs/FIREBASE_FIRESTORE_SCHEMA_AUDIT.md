# Firebase / Firestore Data Schema Audit

**Audit Date:** March 6, 2025  
**Scope:** Firestore collections, document structures, security rules, indexes, and usage patterns.  
**Constraint:** Documentation only — no code changes.

---

## 1. Overview

The application uses **Firebase** for:
- **Firestore** — primary database for user data (items, directories, Instagram sessions)
- **Firebase Auth** — Google OAuth, Instagram OAuth
- **Firebase Storage** — Instagram thumbnails (path-based, not schema-audited here)

**SDK Versions:**
- Client: Firebase Web SDK v12.7.0
- Server: Firebase Admin SDK v13.6.0 (used indirectly via Electron app forwarding; server does not write directly to Firestore)

---

## 2. Firestore Collections

All user data lives under `users/{userId}/` subcollections. There is no top-level `users` document; `userId` is the Firebase Auth UID.

| Collection Path | Purpose |
|-----------------|---------|
| `users/{userId}/items` | Saved URLs/links (webpages, images, Instagram posts) |
| `users/{userId}/directories` | User-created folders for organizing items |
| `users/{userId}/instagramSession` | Single Instagram session document per user |

---

## 3. Document Schemas

### 3.1 `users/{userId}/items/{itemId}`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Saved URL (can be empty for image-only saves) |
| `title` | string | Yes | Display title |
| `createdAt` | number | Yes | Unix timestamp (ms) |
| `userId` | string | Yes | Owner UID (redundant with path; used for consistency) |
| `domain` | string | No | Extracted domain (e.g., `instagram.com`) |
| `type` | string | No | Item type: `webpage`, `instagram_post`, `image`, `collection`, etc. |
| `img_url` | string | No | Primary image URL |
| `thumbnail` | string | No | Thumbnail URL (e.g., Firebase Storage URL for Instagram) |
| `saved_by` | string | No | Source marker: `extension`, `global` |
| `saved_by_app` | string | No | App attribution (brand name) |
| `app_version` | string | No | App version at save time |
| `save_source` | string | No | Normalized source (derived from `saved_by`) |
| `directoryId` | string | No | Directory ID or `"undefined"` for main list |
| `order` | number | No | Sort index within directory or main list (0-based) |

**Notes:**
- `directoryId: "undefined"` is a sentinel string for items not in any directory.
- `order` is used for drag-and-drop reordering; fallback sort is `createdAt desc` when `order` is missing or index unavailable.

---

### 3.2 `users/{userId}/directories/{dirId}`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Directory display name |
| `createdAt` | number | Yes | Unix timestamp (ms) |
| `userId` | string | Yes | Owner UID |
| `order` | number | No | Sort index in directory list (0-based) |

---

### 3.3 `users/{userId}/instagramSession/session`

Single document per user with fixed ID `session`. Replaced entirely on save (no merge).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | string | Yes | Owner UID |
| `instagramUsername` | string | Yes | Connected Instagram username |
| `cookies` | array | Yes | Array of cookie objects (see below) |
| `connectedAt` | number | Yes | Unix timestamp (ms) |
| `oauthAccessToken` | string | No | OAuth access token (verification) |
| `oauthTokenExpiresAt` | number | No | Token expiration timestamp |
| `expiresAt` | number | No | Estimated cookie expiration |

**Cookie object shape:**
- `name`, `value`, `domain`, `path`, `secure`, `httpOnly`
- `sameSite?`: `'strict' | 'lax' | 'no_restriction' | 'unspecified'`
- `expirationDate?`: number

---

## 4. Security Rules

**File:** `firestore.rules`

```javascript
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

**Summary:**
- All access requires `request.auth != null`.
- Users can only access their own data (`request.auth.uid == userId`).
- No field-level validation; any authenticated user can write any fields to their own documents.

---

## 5. Indexes

**Status:** No `firestore.indexes.json` file in the project.

**Queries used in code:**

| Collection | Query | Index Required |
|------------|-------|----------------|
| `items` | `orderBy('createdAt', 'desc')` | Single-field (auto-created) |
| `items` | `orderBy('createdAt', 'asc')` + `limit` | Single-field (auto-created) |
| `items` | `where('directoryId', '==', X)` + `orderBy('order', 'asc')` | **Composite** (directoryId + order) |
| `items` | `where('directoryId', '==', X)` + `orderBy('createdAt', 'desc')` | **Composite** (directoryId + createdAt) |
| `directories` | `orderBy('createdAt', 'asc')` | Single-field (auto-created) |
| `directories` | `orderBy('order', 'asc')` | Single-field (auto-created) |

**Note:** The code has fallbacks when composite indexes fail (e.g., `orderBy('order')` → fallback to `orderBy('createdAt')`). If indexes are missing, Firestore returns `failed-precondition` and the fallback is used.

---

## 6. Usage Patterns

### 6.1 Client (Electron Main Process)

**Location:** `client/src/lib/firestore.ts`

| Operation | Collection | Method |
|-----------|------------|--------|
| Save item | `items` | `saveData()` → `setDoc` |
| Update item | `items` | `updateData()` → `updateDoc` |
| Delete item | `items` | `deleteData()` → `deleteDoc` |
| Delete all items | `items` | `deleteAllData()` → `getDocs` + `deleteDoc` per doc |
| Watch items | `items` | `watchDatasByUser()` → `onSnapshot` + `orderBy('createdAt','desc')` |
| Get items | `items` | `getDatasByUser()` → `getDocs` + `orderBy('createdAt','desc')` |
| Create directory | `directories` | `createDirectory()` → `setDoc` |
| Get directories | `directories` | `getDirectoriesByUser()` → `getDocs` + `orderBy('createdAt','asc')` |
| Watch directories | `directories` | `watchDirectoriesByUser()` → `onSnapshot` |
| Update directory | `directories` | `updateDirectory()` → `updateDoc` |
| Delete directory | `directories` | `deleteDirectory()` → update items' `directoryId` to `'undefined'`, then `deleteDoc` |
| Update item directory | `items` | `updateItemDirectory()` → `updateDoc` |
| Move item (DnD) | `items` | `moveItemToPosition()` → `writeBatch` (directoryId + order updates) |
| Move directory (DnD) | `directories` | `moveDirectoryToPosition()` → `writeBatch` (order updates) |
| Save Instagram session | `instagramSession` | `saveInstagramSession()` → `setDoc` (merge: false) |
| Get Instagram session | `instagramSession` | `getInstagramSession()` → `getDoc` |
| Delete Instagram session | `instagramSession` | `deleteInstagramSession()` → `deleteDoc` |

### 6.2 Server (Node.js)

**Location:** `server/src/server.ts`

The server does **not** write to Firestore directly. It:
1. Receives save requests at `/api/v1/save-url`
2. Forwards to the Electron app at `http://localhost:3002/save-to-firestore`
3. Falls back to local JSON file if the Electron app is unavailable or user is not signed in

Firestore writes are performed only by the Electron main process (client).

### 6.3 Data Flow

```
Browser Extension → Server (port 3000) → Electron Main (port 3002) → Firestore
                         ↓
                  Local JSON fallback
```

---

## 7. Firebase Storage (Reference)

**Path pattern:** `users/{userId}/instagram-thumbnails/{shortcode}.{ext}`

- Used for Instagram post thumbnails
- No `storage.rules` file found in the project
- Metadata includes: `source`, `app`, `appVersion`, `shortcode`, `uploadedAt`

---

## 8. Observations and Recommendations

### 8.1 Schema Consistency
- `directoryId: "undefined"` as a string is unconventional; consider `null` or a dedicated sentinel if Firestore rules allow.
- `userId` is stored in both path and document; redundant but useful for validation and debugging.

### 8.2 Indexes
- Add `firestore.indexes.json` with composite indexes for:
  - `items`: `directoryId` (asc) + `order` (asc)
  - `items`: `directoryId` (asc) + `createdAt` (desc)
- This avoids fallback behavior and ensures consistent ordering.

### 8.3 Security
- Rules are correctly scoped to `userId`.
- No server-side Firestore access; all writes go through the authenticated client.

### 8.4 Type Values
- `type` values observed: `webpage`, `instagram_post`, `image`, `collection`, etc. No enum; values are free-form strings.

---

## 9. Summary

| Aspect | Status |
|--------|--------|
| Collections | 3 user-scoped subcollections |
| Document IDs | Auto-generated for items/directories; fixed `session` for Instagram |
| Security | User-scoped, auth-required |
| Indexes | None defined in repo; composite indexes may be needed |
| Server Firestore usage | None (forwarding to Electron only) |
| Storage | Separate path-based schema for thumbnails |
