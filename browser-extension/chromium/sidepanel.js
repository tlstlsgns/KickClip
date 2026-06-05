// ─────────────────────────────────────────────────────────────────────────────
// KickClip Side Panel — sidepanel.js
// Firebase browser SDK loaded via CDN (ESM)
// ─────────────────────────────────────────────────────────────────────────────

// Notify content script that Side Panel is now open
try {
  chrome.runtime.sendMessage({ action: 'sidepanel-opened' });
} catch (e) {}

// Open a persistent port so background.js can detect when
// the Side Panel closes (port disconnect fires reliably on unload)
try {
  chrome.runtime.connect({ name: 'sidepanel' });
} catch (e) {}

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
  doc,
} from './firebase-bundle.js';

import {
  preloadPrimaryHandle,
  getPrimaryHandleForGesture,
  openPickerWindow,
  refreshPrimaryHandleCache,
  writeItemToHandle,
  saveItemViaDownloads,
  buildDriveUploadPayload,
  // === PHASE_UPLOAD_AUTO_ROUTING ===
  saveItemToDownloads,
  // === END PHASE_UPLOAD_AUTO_ROUTING ===
  resolveItemClipboardPngBlob,
} from './upload.js';
import {
  getDestination,
  setDestination,
  clearDestination,
} from './uploadStorage.js';

// === PHASE_SHORTCUT_RECORDER ===
import {
  getShortcut,
  setShortcut,
  getDefaultShortcut,
  isShortcutForbidden,
  formatShortcut,
  onShortcutChange,
} from './shortcutStore.js';
// === END PHASE_SHORTCUT_RECORDER ===

// PHASE_UPLOAD_ALWAYS_AUTO: the Auto checkbox is removed — uploads
// always route directly to the configured destination
// (handleUploadToDestination). The legacy 'kc_upload_auto_enabled'
// storage key is abandoned in place. The upload popover remains only
// as the catch-path fallback in handleUploadButtonClick.

// === PHASE_UPLOAD_FORMAT ===
const KC_UPLOAD_FORMAT_KEY = 'kc_upload_format';
const KC_UPLOAD_FORMAT_PRESETS = ['original', 'jpg', 'jpeg', 'png', 'webp'];
const KC_UPLOAD_FORMAT_LABELS = {
  original: 'Original',
  jpg: 'JPG',
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WEBP',
};

let _kcUploadFormatMenuOpen = false;
let _kcUploadFormatOutsideClick = null;
let _kcUploadFormatEscKey = null;

function _normalizeUploadFormat(fmt) {
  const v = String(fmt || '').trim().toLowerCase();
  return KC_UPLOAD_FORMAT_PRESETS.includes(v) ? v : 'original';
}

function _renderUploadFormatUI(fmt) {
  const key = _normalizeUploadFormat(fmt);
  const btn = document.getElementById('kc-upload-format-btn');
  const menu = document.getElementById('kc-upload-format-menu');
  if (!btn || !menu) return;
  btn.textContent = `${KC_UPLOAD_FORMAT_LABELS[key] || 'Original'} ▾`;
  btn.dataset.format = key;
  btn.setAttribute('aria-expanded', _kcUploadFormatMenuOpen ? 'true' : 'false');
  menu.innerHTML = '';
  for (const preset of KC_UPLOAD_FORMAT_PRESETS) {
    const li = document.createElement('li');
    li.className = 'kc-upload-format-menu-item';
    if (preset === key) li.classList.add('kc-upload-format-menu-item-selected');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', preset === key ? 'true' : 'false');
    li.dataset.format = preset;
    li.textContent = preset === key
      ? `✓ ${KC_UPLOAD_FORMAT_LABELS[preset]}`
      : KC_UPLOAD_FORMAT_LABELS[preset];
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      _selectUploadFormat(preset);
    });
    menu.appendChild(li);
  }
}

function _detachUploadFormatMenuListeners() {
  if (_kcUploadFormatOutsideClick) {
    document.removeEventListener('click', _kcUploadFormatOutsideClick, true);
    _kcUploadFormatOutsideClick = null;
  }
  if (_kcUploadFormatEscKey) {
    document.removeEventListener('keydown', _kcUploadFormatEscKey);
    _kcUploadFormatEscKey = null;
  }
}

function _closeUploadFormatMenu() {
  if (!_kcUploadFormatMenuOpen) return;
  _kcUploadFormatMenuOpen = false;
  const menu = document.getElementById('kc-upload-format-menu');
  const btn = document.getElementById('kc-upload-format-btn');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  _detachUploadFormatMenuListeners();
}

function _openUploadFormatMenu() {
  const menu = document.getElementById('kc-upload-format-menu');
  const btn = document.getElementById('kc-upload-format-btn');
  if (!menu || !btn) return;
  _kcUploadFormatMenuOpen = true;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  _renderUploadFormatUI(btn.dataset.format || 'original');
  _kcUploadFormatOutsideClick = (e) => {
    const wrap = document.getElementById('kc-upload-format-wrap');
    if (wrap && !wrap.contains(e.target)) _closeUploadFormatMenu();
  };
  _kcUploadFormatEscKey = (e) => {
    if (e.key === 'Escape') _closeUploadFormatMenu();
  };
  setTimeout(() => {
    if (_kcUploadFormatMenuOpen && _kcUploadFormatOutsideClick) {
      document.addEventListener('click', _kcUploadFormatOutsideClick, true);
    }
  }, 0);
  document.addEventListener('keydown', _kcUploadFormatEscKey);
}

function _toggleUploadFormatMenu() {
  if (_kcUploadFormatMenuOpen) _closeUploadFormatMenu();
  else _openUploadFormatMenu();
}

async function _selectUploadFormat(value) {
  const next = _normalizeUploadFormat(value);
  try {
    await chrome.storage.local.set({ [KC_UPLOAD_FORMAT_KEY]: next });
  } catch (_) {}
  _renderUploadFormatUI(next);
  _closeUploadFormatMenu();
}

async function _loadUploadFormatSetting() {
  try {
    const r = await chrome.storage.local.get(KC_UPLOAD_FORMAT_KEY);
    const v = String(r?.[KC_UPLOAD_FORMAT_KEY] || '').trim().toLowerCase();
    _renderUploadFormatUI(KC_UPLOAD_FORMAT_PRESETS.includes(v) ? v : 'original');
  } catch (_) {
    _renderUploadFormatUI('original');
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KC_UPLOAD_FORMAT_KEY]) return;
  const v = String(changes[KC_UPLOAD_FORMAT_KEY].newValue || '').trim().toLowerCase();
  _renderUploadFormatUI(KC_UPLOAD_FORMAT_PRESETS.includes(v) ? v : 'original');
});
// === END PHASE_UPLOAD_FORMAT ===

// Picker popup window tracking for auto-close + re-click handling.
let _kcPickerWindowId = null;
let _kcPickerBusy = false;

chrome.windows.onFocusChanged.addListener((focusedWindowId) => {
  if (_kcPickerWindowId == null) return;
  if (_kcPickerBusy) return;
  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) return;
  if (focusedWindowId === _kcPickerWindowId) return;

  const idToClose = _kcPickerWindowId;
  _kcPickerWindowId = null;
  _kcPickerBusy = false;
  chrome.windows.remove(idToClose).catch(() => {});
});

chrome.windows.onRemoved.addListener((closedWindowId) => {
  if (closedWindowId === _kcPickerWindowId) {
    _kcPickerWindowId = null;
    _kcPickerBusy = false;
  }
});

/**
 * Updates the Dir container UI to reflect destination preference.
 */
async function _refreshDirContainer() {
  const btn = document.getElementById('kc-dir-folder-btn');
  const label = document.getElementById('kc-dir-folder-label');
  if (!btn || !label) return;

  try {
    const destination = await getDestination();

    btn.classList.remove(
      'kc-dir-unconfigured',
      'kc-dir-configured',
      'kc-dir-missing',
      'kc-dir-drive-configured'
    );

    // Branch order:
    //   destination = {type:'drive', ...}     → Drive label (existing)
    //   destination = {type:'downloads'}      → "Downloads" (new, explicit)
    //   destination = {type:'local'}          → IDB handle name (existing, but now
    //                                            requires the handle to still exist)
    //   destination = null + cached handle    → IDB handle name (backfill path,
    //                                            existing — kept for U2 compat)
    //   destination = null + no handle        → "Downloads (기본)" (new)
    //
    // Note: in this commit (U3) the actual upload of items with
    // destination={type:'downloads'} or null still goes through the
    // legacy local-handle code paths if a stale handle exists in the
    // module cache. U4 rewrites the upload routing to use
    // saveItemToDownloads for the 'downloads' / null cases.
    if (destination && destination.type === 'drive') {
      const parent = destination.driveParentFolderName || '';
      const child = destination.driveFolderName || 'SeaClip_files';
      const fullPath = parent ? `${parent}/${child}` : child;
      label.textContent = fullPath;
      btn.title = `Google Drive: ${fullPath}`;
      btn.classList.add('kc-dir-configured', 'kc-dir-drive-configured');
    } else if (destination && destination.type === 'downloads') {
      label.textContent = 'Downloads';
      btn.title = '다운로드 폴더에 저장합니다';
      btn.classList.add('kc-dir-configured');
    } else if (destination && destination.type === 'local') {
      const handle = getPrimaryHandleForGesture();
      if (handle) {
        label.textContent = handle.name;
        btn.title = `로컬 폴더: ${handle.name}`;
        btn.classList.add('kc-dir-configured');
      } else {
        // Handle was cleared (permission revoked, folder deleted, etc).
        // Fall back to unconfigured display so user can re-pick.
        label.textContent = '저장 위치 선택';
        btn.title = '저장 폴더를 선택하세요';
        btn.classList.add('kc-dir-unconfigured');
      }
    } else {
      // destination === null — unconfigured default.
      // Show "Downloads (기본)" as the implicit default.
      const handle = getPrimaryHandleForGesture();
      if (handle) {
        // Backfill compatibility: a cached handle exists but no
        // destination was ever set. The init code at module load sets
        // destination={type:'local'} in this case, but if the IIFE
        // hasn't run yet or failed, fall through here so the user sees
        // their existing folder rather than the implicit default.
        label.textContent = handle.name;
        btn.title = `로컬 폴더: ${handle.name}`;
        btn.classList.add('kc-dir-configured');
      } else {
        label.textContent = 'Downloads (기본)';
        btn.title = '저장 위치 미설정 — 다운로드 폴더에 저장합니다. 클릭하여 변경하세요.';
        btn.classList.add('kc-dir-unconfigured');
      }
    }
  } catch (_) {}
}

function _markDirFolderMissing(folderName) {
  const btn = document.getElementById('kc-dir-folder-btn');
  const label = document.getElementById('kc-dir-folder-label');
  if (!btn || !label) return;
  label.textContent = folderName ? `${folderName} (없음)` : '폴더 없음';
  btn.classList.remove('kc-dir-configured', 'kc-dir-unconfigured');
  btn.classList.add('kc-dir-missing');
  btn.title = '폴더를 찾을 수 없습니다. 클릭하여 다시 선택하세요.';
}

async function handleOpenFolderSettings() {
  // Re-click: close any existing picker window first
  if (_kcPickerWindowId != null) {
    try {
      await chrome.windows.remove(_kcPickerWindowId);
    } catch (_) {}
    _kcPickerWindowId = null;
    _kcPickerBusy = false;
  }

  try {
    const winId = await openPickerWindow();
    if (!winId) {
      showKcToast('폴더 설정 창을 열지 못했습니다.', 'error');
      return;
    }
    _kcPickerWindowId = winId;
    _kcPickerBusy = false;
  } catch (e) {
    showKcToast(`폴더 설정 창 오류: ${e?.message || String(e)}`, 'error');
  }
}

(async () => {
  try {
    await preloadPrimaryHandle();
  } catch (_) {}
  try {
    const existingDest = await getDestination();
    const cachedHandle = getPrimaryHandleForGesture();
    if (!existingDest && cachedHandle) {
      await setDestination({ type: 'local' });
    }
  } catch (_) {}
  await _refreshDirContainer();
  await _loadUploadFormatSetting();
})();

document.getElementById('kc-upload-format-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  _toggleUploadFormatMenu();
});

// ── Firebase config ───────────────────────────────────────────────────────────
const DEV_FIREBASE_CONFIG = {
  apiKey:            'AIzaSyA9X_FEi9cgvFmDdEmeEvJW0msXSIrP6p0',
  authDomain:        'saveurl-a8593.firebaseapp.com',
  projectId:         'saveurl-a8593',
  storageBucket:     'saveurl-a8593.firebasestorage.app',
  messagingSenderId: '658386350246',
  appId:             '1:658386350246:web:ee80b8dcae26d2e4298467',
  measurementId:     'G-3CWFLRKTVR',
};
const PROD_FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBclUz3i_1dOk20KxzPaQHs07TOSPjSBz0',
  authDomain:        'saveurl-prod.firebaseapp.com',
  projectId:         'saveurl-prod',
  storageBucket:     'saveurl-prod.firebasestorage.app',
  messagingSenderId: '108278020684',
  appId:             '1:108278020684:web:5171c68256f59c53ccd2e9',
  measurementId:     'G-6HW4SW65N0',
};
const FIREBASE_CONFIG = (typeof KC_IS_DEV !== 'undefined' && !KC_IS_DEV)
  ? PROD_FIREBASE_CONFIG
  : DEV_FIREBASE_CONFIG;

const firebaseApp = getApps().length === 0
  ? initializeApp(FIREBASE_CONFIG)
  : getApps()[0];

const auth = getAuth(firebaseApp);
const db   = getFirestore(firebaseApp);

/** @param {unknown} v */
function _kcFirestorePrimitiveField(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  return { stringValue: String(v) };
}

/**
 * One read of a document ref via onSnapshot (getDoc is not exported from firebase-bundle.js).
 * @param {*} docRef
 */
function _kcFirestoreSnapshotOnce(docRef) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const unsub = onSnapshot(
      docRef,
      (snap) => {
        if (settled) return;
        settled = true;
        try {
          unsub();
        } catch (_) {}
        resolve(snap);
      },
      (err) => {
        if (settled) return;
        settled = true;
        try {
          unsub();
        } catch (_) {}
        reject(err);
      }
    );
  });
}

/**
 * Commit a user profile write via Firestore REST (setDoc/updateDoc/serverTimestamp are not in firebase-bundle.js).
 */
async function _kcFirestoreCommitUserProfile(projectId, idToken, documentName, fields, transforms) {
  const fieldPaths = [...Object.keys(fields), ...transforms.map((t) => t.fieldPath)];
  const body = {
    writes: [
      {
        update: { name: documentName, fields },
        updateMask: { fieldPaths },
        updateTransforms: transforms,
      },
    ],
  };
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore commit ${res.status}: ${text}`);
  }
}

/**
 * Upsert the current user's profile document at users/{uid}.
 * Idempotent — safe to call on every sign-in / auth state change.
 * If the document doesn't exist, creates it with createdAt set to
 * the server timestamp. If it exists, only updates non-createdAt
 * fields (preserving original creation timestamp).
 *
 * @param {*} user
 */
async function upsertUserProfile(user) {
  if (!user?.uid) return;
  try {
    const userRef = doc(db, 'users', user.uid);
    const snap = await _kcFirestoreSnapshotOnce(userRef);
    const idToken = await user.getIdToken();
    const projectId = FIREBASE_CONFIG.projectId;
    const documentName = `projects/${projectId}/databases/(default)/documents/users/${user.uid}`;
    const provider =
      (user.providerData && user.providerData[0] && user.providerData[0].providerId) || 'google.com';
    const baseFields = {
      uid: _kcFirestorePrimitiveField(user.uid),
      email: _kcFirestorePrimitiveField(user.email ?? null),
      displayName: _kcFirestorePrimitiveField(user.displayName ?? null),
      photoURL: _kcFirestorePrimitiveField(user.photoURL ?? null),
      emailVerified: { booleanValue: !!user.emailVerified },
      provider: _kcFirestorePrimitiveField(provider),
    };
    const transforms = [{ fieldPath: 'lastLoginAt', setToServerValue: 'REQUEST_TIME' }];
    if (!snap.exists()) {
      transforms.push({ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' });
    }
    await _kcFirestoreCommitUserProfile(projectId, idToken, documentName, baseFields, transforms);
  } catch (e) {
    // Do not break sign-in flow on upsert failure
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser        = null;
let unsubscribeItems   = null;
let unsubscribeDirs    = null;
// Phase 12h: subsequent item snapshots after the first only update
// dataset/tracking, not DOM layout. Reset to true in stopListeners
// so a fresh sidepanel session does a full initial render.
let isFirstItemsSnapshot = true;
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

// Maps each rendered `.data-card` element to its backing Firestore item object
// (used by upload UI — WeakMap avoids retaining detached DOM).
const kcCardItemByEl = new WeakMap();

/** @type {HTMLDivElement | null} */
let kcUploadPopoverEl = null;
/** @type {(() => void) | null} */
let kcUploadOutsideDismiss = null;

// window-level drag state (mirrors main.js pattern)
window.currentDraggedWrapper  = null;
window.currentDraggedItemId   = null;
window.currentDraggedItemUrl  = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginScreen     = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const btnSignin       = document.getElementById('btn-signin');
const btnSignout      = document.getElementById('btn-signout');
const dirFolderBtn    = document.getElementById('kc-dir-folder-btn');
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

// === PHASE_SHORTCUT_RECORDER ===
// Inline shortcut recorder for #sp-shortcut-btn.
//
// State machine:
//   idle       → chip shows the current shortcut (e.g. "⌘C"). Click → recording.
//   recording  → chip shows "Press a key…". Listens for keydown. On valid
//                modifier+key combo → save + idle. On forbidden → flash error,
//                stay in recording. On Escape → cancel, return to idle without
//                save.
//
// Validation rules:
//   - At least one of metaKey / ctrlKey must be pressed (no bare keystrokes).
//   - Must not match any FORBIDDEN_SHORTCUTS entry.
//   - The "main key" is event.code; modifier-only keystrokes (e.g. just Cmd)
//     are ignored (waiting for the user to press the main key).

const sp_shortcutBtn_v2 = document.getElementById('sp-shortcut-btn');
const sp_shortcutReset = document.getElementById('sp-shortcut-reset-btn');
const sp_shortcutError = document.getElementById('sp-shortcut-error');

let _sp_recording = false;
let _sp_priorShortcut = null;
let _sp_keydownListener = null;
let _sp_errorTimer = null;

function sp_renderChip(shortcut) {
  if (!sp_shortcutBtn_v2) return;
  sp_shortcutBtn_v2.textContent = formatShortcut(shortcut);
  sp_shortcutBtn_v2.dataset.shortcut = JSON.stringify(shortcut);
}

function sp_setRecordingState(on) {
  if (!sp_shortcutBtn_v2) return;
  _sp_recording = on;
  if (on) {
    sp_shortcutBtn_v2.classList.add('recording');
    sp_shortcutBtn_v2.textContent = 'Press a key…';
  } else {
    sp_shortcutBtn_v2.classList.remove('recording');
  }
}

function sp_showError(msg) {
  if (!sp_shortcutBtn_v2 || !sp_shortcutError) return;
  sp_shortcutError.textContent = msg;
  sp_shortcutError.hidden = false;
  sp_shortcutBtn_v2.classList.add('error');
  clearTimeout(_sp_errorTimer);
  _sp_errorTimer = setTimeout(() => {
    sp_shortcutError.hidden = true;
    sp_shortcutBtn_v2.classList.remove('error');
  }, 1500);
}

function sp_isModifierOnly(event) {
  // event.code for modifier keys: 'MetaLeft', 'MetaRight', 'ControlLeft',
  // 'ShiftLeft', 'AltLeft', etc. We want to ignore these — wait for a
  // non-modifier main key.
  const code = String(event.code || '');
  return /^(Meta|Control|Shift|Alt)(Left|Right)?$/.test(code);
}

function sp_startRecording() {
  if (_sp_recording) return;
  // Capture current shortcut so we can restore on Escape.
  getShortcut().then((cur) => {
    _sp_priorShortcut = cur;
    sp_setRecordingState(true);

    _sp_keydownListener = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        sp_stopRecording(false);
        return;
      }
      if (sp_isModifierOnly(event)) {
        // Modifier alone — wait for main key.
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Build candidate shortcut from event.
      const candidate = {
        metaKey: !!event.metaKey,
        ctrlKey: !!event.ctrlKey,
        shiftKey: !!event.shiftKey,
        altKey: !!event.altKey,
        code: event.code,
        display: '', // filled below via formatShortcut
      };
      // Validate: at least one modifier required.
      if (!candidate.metaKey && !candidate.ctrlKey) {
        sp_showError('Modifier required (⌘ or Ctrl)');
        return;
      }
      // Validate: not forbidden.
      if (isShortcutForbidden(candidate)) {
        sp_showError('This shortcut is unavailable');
        return;
      }
      // Save.
      candidate.display = formatShortcut(candidate);
      setShortcut(candidate).then((ok) => {
        if (!ok) {
          sp_showError('Failed to save');
          return;
        }
        // Pass the saved shortcut so sp_stopRecording can render it
        // synchronously — avoids the race with onShortcutChange.
        sp_stopRecording(true, candidate);
      });
    };
    document.addEventListener('keydown', _sp_keydownListener, true);
  });
}

function sp_stopRecording(saved, savedShortcut) {
  if (!_sp_recording) return;
  if (_sp_keydownListener) {
    document.removeEventListener('keydown', _sp_keydownListener, true);
    _sp_keydownListener = null;
  }
  sp_setRecordingState(false);
  if (saved && savedShortcut) {
    // Render the freshly-saved shortcut directly. We can't rely on the
    // onShortcutChange callback because its ordering relative to
    // setShortcut().then() is not guaranteed — the callback may fire while
    // _sp_recording is still true (in which case its own guard skips the
    // render). Calling sp_renderChip here makes the success path
    // deterministic.
    sp_renderChip(savedShortcut);
  } else if (!saved && _sp_priorShortcut) {
    // Cancel path — restore prior display.
    sp_renderChip(_sp_priorShortcut);
  }
  _sp_priorShortcut = null;
}

function sp_resetShortcut() {
  setShortcut(getDefaultShortcut()).then(() => {
    // onShortcutChange will refresh display.
  });
}

// Wire click handlers.
if (sp_shortcutBtn_v2) {
  sp_shortcutBtn_v2.addEventListener('click', () => {
    if (_sp_recording) {
      sp_stopRecording(false);
    } else {
      sp_startRecording();
    }
  });
}
if (sp_shortcutReset) {
  sp_shortcutReset.addEventListener('click', () => {
    sp_resetShortcut();
  });
}

// Initial render + subscribe to changes.
(async () => {
  try {
    const cur = await getShortcut();
    sp_renderChip(cur);
  } catch (e) {
    // ignore — chip keeps HTML placeholder
  }
})();
onShortcutChange((newShortcut) => {
  if (!_sp_recording) {
    sp_renderChip(newShortcut);
  }
});
// Auto-cancel recording when the sidepanel's window loses focus. This
// handles shortcuts that don't deliver keydown to the page (Cmd+T,
// Cmd+W, Cmd+N, etc.) — Chrome's own action takes effect, the user
// moves to the new tab / window, and our recorder cancels cleanly
// instead of leaving the chip stuck on "Press a key…". On return, the
// user sees the prior shortcut and can retry with a different combo.
//
// We use window.blur instead of document.visibilitychange because
// Chrome's sidepanel does NOT fire visibilitychange when the user
// switches focus to a new tab — the sidepanel stays "visible" alongside
// the new tab. window.blur, however, fires reliably when the sidepanel
// window itself loses focus (verified empirically).
//
// Clicking on the host page DOES blur the sidepanel window (maintainer-
// verified empirically). blur is therefore also used to clear card
// activation and multi-selection (see deactivateAllCards blur listener).
window.addEventListener('blur', () => {
  if (_sp_recording) {
    sp_stopRecording(false);
  }
});
// === END PHASE_SHORTCUT_RECORDER ===

// === PHASE_CARD_MULTISELECT ===
let _kcSelectedCardIds = new Set();

function _kcGetCardSelectId(card) {
  if (!card) return '';
  return String(card.dataset.docId || card.dataset.itemId || '').trim();
}

function _kcApplyCardSelectionClasses() {
  const liveIds = new Set();
  document.querySelectorAll('.data-card').forEach((card) => {
    const id = _kcGetCardSelectId(card);
    if (!id) return;
    liveIds.add(id);
    card.classList.toggle('kc-card-selected', _kcSelectedCardIds.has(id));
  });
  for (const id of _kcSelectedCardIds) {
    if (!liveIds.has(id)) _kcSelectedCardIds.delete(id);
  }
}

function _kcClearCardSelection() {
  if (_kcSelectedCardIds.size === 0) return;
  _kcSelectedCardIds.clear();
  _kcApplyCardSelectionClasses();
}

function _kcHandleCardSelectionClick(card, isShift) {
  const id = _kcGetCardSelectId(card);
  if (!id) return;
  if (isShift) {
    if (_kcSelectedCardIds.has(id)) _kcSelectedCardIds.delete(id);
    else _kcSelectedCardIds.add(id);
  } else if (_kcSelectedCardIds.size === 1 && _kcSelectedCardIds.has(id)) {
    _kcSelectedCardIds.clear();
  } else {
    _kcSelectedCardIds.clear();
    _kcSelectedCardIds.add(id);
  }
  _kcApplyCardSelectionClasses();
}

async function executeDeleteSelected() {
  if (!currentUser || _kcSelectedCardIds.size === 0) return;
  const ids = Array.from(_kcSelectedCardIds);
  const list = getUnifiedDockList();
  const cardsToRemove = [];
  document.querySelectorAll('.data-card').forEach((card) => {
    const id = _kcGetCardSelectId(card);
    if (id && _kcSelectedCardIds.has(id)) {
      const container = card.closest('.card-container');
      if (container) cardsToRemove.push({ id, container });
    }
  });

  await Promise.allSettled(
    ids.map((docId) =>
      fetch(
        `${KC_SERVER_URL}/api/v1/items/${encodeURIComponent(docId)}?userId=${encodeURIComponent(currentUser.uid)}`,
        { method: 'DELETE' }
      )
    )
  );

  cardsToRemove.forEach(({ container }) => container.remove());
  _kcSelectedCardIds.clear();
  _kcApplyCardSelectionClasses();
  if (list) {
    ensureEmptyState(list);
    syncTimelineDividers(list);
  }
  updateClearButtonState();
  showKcToast(`${ids.length} clip${ids.length === 1 ? '' : 's'} deleted`, 'success');
}
// === END PHASE_CARD_MULTISELECT ===

// === PHASE_SIDEPANEL_UNIFIED_LIST ===
let _clearBarExitConfirmPending = null;

function dismissClearConfirmPendingIfActive() {
  if (_clearBarExitConfirmPending) {
    _clearBarExitConfirmPending();
  }
}

/** Dock clips: no directoryId (or sentinel 'undefined'). */
function isDockItem(item) {
  const dirId = item?.directoryId;
  return !dirId || dirId === 'undefined';
}

function getUnifiedDockList() {
  return document.getElementById('sp-unified-list');
}

// === PHASE_IMAGE_URL_PIPELINE ===
function shouldUsePlaceholder(item) {
  if (item?.img_thumbnail_b64) return false;
  const imgUrl = String(item?.img_url || '').trim();
  if (imgUrl) return false;
  return true;
}

function getCardThumbnailUrl(item) {
  const b64 = String(item?.img_thumbnail_b64 || '').trim();
  if (b64) return b64;
  if (shouldUsePlaceholder(item)) return null;
  const imgUrl = String(item?.img_url || '').trim();
  if (imgUrl) return imgUrl;
  return null;
}
// === END PHASE_IMAGE_URL_PIPELINE ===
// === END PHASE_SIDEPANEL_UNIFIED_LIST ===

/**
 * Returns a JS Date from a Firestore item's updatedAt field
 * (set on both create and update on the server side).
 * Handles Firestore Timestamp objects ({ seconds, nanoseconds })
 * and raw millisecond numbers. Returns null if unavailable.
 *
 * Used to group items into timeline buckets (Today / Yesterday / date).
 * Matches the items query order (orderBy('updatedAt', 'desc')) so
 * dedup-updated items move into the most recent bucket.
 */
function getItemDate(item) {
  try {
    const ua = item?.updatedAt;
    if (!ua) return null;
    if (typeof ua.toDate === 'function') return ua.toDate();
    if (typeof ua.seconds === 'number') return new Date(ua.seconds * 1000);
    if (typeof ua === 'number') return new Date(ua);
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Formats a Date into a timeline label:
 *   Today, Yesterday, or locale date string (e.g. "Apr 5, 2025").
 */
function formatTimelineLabel(date) {
  if (!date) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (d.getTime() === today.getTime()) return 'Today';
  if (d.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Creates a full-width timeline divider element for a given label.
 */
function createTimelineDivider(label) {
  const el = document.createElement('div');
  el.className = 'sp-timeline-divider';
  el.dataset.timelineLabel = label;
  el.innerHTML = `<span class="sp-timeline-label">${label}</span>`;
  return el;
}

/**
 * Inserts timeline dividers into a rendered category list.
 * Reads createdAt from each .card-container's associated item data via
 * a data attribute, then groups consecutive cards by date and inserts
 * a divider at the start of each new date group.
 * Skips optimistic cards (data-optimistic-card).
 * Call this after all cards have been appended to the list.
 *
 * @param {HTMLElement} listEl - the unified dock list element (#sp-unified-list)
 * @param {Array} items - the sorted array of Firestore items rendered into this list
 */
function insertTimelineDividers(listEl, items) {
  if (!listEl || !Array.isArray(items) || items.length === 0) return;

  // Remove any existing dividers first (re-render safety)
  listEl.querySelectorAll('.sp-timeline-divider').forEach((el) => el.remove());

  // Build a map of itemId → item for quick lookup
  const itemMap = new Map();
  for (const item of items) {
    const id = getItemId(item);
    if (id) itemMap.set(id, item);
  }

  // Walk card-containers in DOM order, insert divider when date changes
  let lastLabel = null;
  const children = Array.from(listEl.children);
  for (const child of children) {
    if (child.dataset?.optimisticCard) continue;
    if (child.classList.contains('sp-timeline-divider')) continue;
    const card = child.querySelector('.data-card');
    if (!card) continue;
    const itemId = card.dataset?.itemId;
    const item = itemId ? itemMap.get(itemId) : null;
    const date = item ? getItemDate(item) : null;
    const label = date ? formatTimelineLabel(date) : null;
    if (!label) continue;
    if (label !== lastLabel) {
      const divider = createTimelineDivider(label);
      listEl.insertBefore(divider, child);
      lastLabel = label;
    }
  }
}


function updateCategoryCounts() {}

// ── Auth: Google Sign-in via chrome.identity ──────────────────────────────────
async function signInWithGoogle() {
  showLoginError('');
  if (chrome?.storage?.local) {
    chrome.storage.local.remove('kickclipExplicitSignOut').catch(() => {});
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
            'https://www.googleapis.com/auth/drive.file',
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
    const userCredential = await signInWithCredential(auth, credential);
    await upsertUserProfile(userCredential.user);
  } catch (err) {
    showLoginError(err.message || 'Sign-in failed. Please try again.');
  }
}

async function signOut() {
  try {
    _isExplicitSignOut = true;
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ kickclipExplicitSignOut: true }).catch(() => {});
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
  attachClearButtonHandlers();

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
  }, () => {
    currentDirectories = [];
    renderDirectories();
  });

  // Watch items
  const itemsRef = collection(db, `users/${userId}/items`);
  // Order by updatedAt so dedup hits (re-clip of same url+img_url)
  // surface at the top of the list, reflecting last activity.
  const itemsQ   = query(itemsRef, orderBy('updatedAt', 'desc'));
  unsubscribeItems = onSnapshot(itemsQ, (snap) => {
    currentItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    syncSavedUrlsToSession(currentItems);

    if (isFirstItemsSnapshot) {
      // Initial render — full loadData (also handles previously-saved
      // items on sidepanel reopen).
      isFirstItemsSnapshot = false;
      if (!isSyncing) loadData();
      return;
    }

    // Subsequent snapshots: silently reconcile new docs against
    // OptimisticCards. No DOM layout work — that path causes <img>
    // reload flashes on base64 dataURLs. Cross-device additions/
    // modifications/removals will be picked up when the sidepanel is
    // reopened (multi-device concurrent use is currently out of scope).
    if (isSyncing) return;
    reconcileSnapshotSilently(snap);
  }, () => {});
}

function stopListeners() {
  if (unsubscribeItems)  { unsubscribeItems();  unsubscribeItems  = null; }
  if (unsubscribeDirs)   { unsubscribeDirs();   unsubscribeDirs   = null; }
  currentItems       = [];
  currentDirectories = [];
  displayedItemIds   = new Set();
  isFirstItemsSnapshot = true;
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
    await upsertUserProfile(user);
    // Always sync userId to storage, regardless of Side Panel open state
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ kickclipUserId: user.uid }).catch(() => {});
    }
    showDashboardScreen(user);
  } else {
    // Explicit sign-out — skip silent re-auth and go directly to login screen
    // Check both the in-memory flag (same session) and persisted storage (after panel reopen)
    const explicitSignOut = _isExplicitSignOut || await (async () => {
      try {
        const result = await chrome.storage.local.get('kickclipExplicitSignOut');
        return !!result?.kickclipExplicitSignOut;
      } catch { return false; }
    })();

    if (explicitSignOut) {
      _isExplicitSignOut = false;
      if (chrome?.storage?.local) {
        chrome.storage.local.remove('kickclipUserId').catch(() => {});
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
        chrome.storage.local.remove('kickclipUserId').catch(() => {});
      }
      showLoginScreen();
    }
  }
});

// Show dashboard immediately if user was previously logged in,
// to avoid login screen flash while Firebase restores the session.
(async () => {
  try {
    const result = await chrome.storage.local.get('kickclipUserId');
    if (result?.kickclipUserId) {
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
const IMAGE_PROXY_BASE = `${KC_SERVER_URL}/api/v1/image-proxy`;

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
  // Don't proxy chrome-extension:// URLs — they are browser-internal
  // resources (e.g. bundled favicon assets) that the local server
  // cannot fetch. Return the URL directly so <img> loads it inline.
  if (trimmed.startsWith('chrome-extension://')) return trimmed;
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

// === PHASE_SIDEPANEL_UNIFIED_LIST ===
// ── Card creation (unified image_card grid) ────────────────────────────────────
function createDataCard(item) {
  const itemId       = item.id || getItemId(item);
  const cardId       = `item-${itemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const escapedUrl   = (item.url || '').replace(/"/g, '&quot;');
  const displayTitle = item.title || 'Untitled';
  const escapedTitle = displayTitle.replace(/"/g, '&quot;');
  const imgUrl       = (item.img_url || '').trim();
  const escapedImgUrl = imgUrl.replace(/"/g, '&quot;');
  const directoryId  = item.directoryId && item.directoryId !== 'undefined' ? item.directoryId : '';

  // === PHASE_CARD_CLIPBOARD_COPY ===
  const clipBtn = `
    <div class="data-card-clip" title="Copy image to clipboard">
      <button type="button" class="data-card-clip-btn" aria-label="Copy image to clipboard">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
        </svg>
        <svg class="kc-upload-mark kc-upload-mark--check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        <svg class="kc-upload-mark kc-upload-mark--x" viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  // === END PHASE_CARD_CLIPBOARD_COPY ===

  // Upload button HTML (shared) — appears immediately left of delete in header
  const uploadBtn = `
    <div class="data-card-upload" title="Upload to folder">
      <button type="button" class="data-card-upload-btn" aria-label="Upload to folder">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <svg class="kc-upload-mark kc-upload-mark--check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        <svg class="kc-upload-mark kc-upload-mark--x" viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;

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

  const thumbUrl = getCardThumbnailUrl(item);
  const escContext = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const escInfo = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const plat = (item.platform || '').trim();
  const urlText = (item.url || '').trim().replace(/^https?:\/\//, '');
  const contextHtml = plat
    ? `<span class="data-card-content-type">${escContext(plat)}</span>`
    : (urlText ? `<span class="data-card-content-type">${escContext(urlText)}</span>` : '');
  const headerHtml = `
    <div class="data-card-header">
      <div class="data-card-context">${contextHtml}</div>
      ${clipBtn}
      ${uploadBtn}
      ${deleteBtn}
    </div>`;

  let mainContentHtml;
  if (thumbUrl) {
    mainContentHtml = `
      <div class="data-card-imgcontainer">
        <img src="${getProxiedImageUrl(thumbUrl)}" alt="${escapedTitle}" class="data-card-image">
      </div>`;
  } else {
    mainContentHtml = `
      <div class="data-card-imgcontainer">
        <div class="sp-card-placeholder">
          <span class="sp-card-placeholder-title">${escInfo(displayTitle)}</span>
        </div>
      </div>`;
  }

  return `
    <div id="${cardId}"
         class="data-card"
         data-url="${escapedUrl}"
         data-title="${escapedTitle}"
         data-img-url="${escapedImgUrl}"
         data-item-id="${itemId}"
         data-doc-id="${item.id || ''}"
         data-directory-id="${directoryId}">
      ${headerHtml}
      <div class="data-card-main">${mainContentHtml}</div>
    </div>`;
}
// === END PHASE_SIDEPANEL_UNIFIED_LIST ===

// === PHASE_IMAGE_URL_PIPELINE ===
function attachCardImageErrorFallback(card, item) {
  const img = card?.querySelector?.('.data-card-image');
  if (!img) return;
  const escInfo = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  img.addEventListener('error', () => {
    const container = img.closest?.('.data-card-imgcontainer');
    if (!container) return;
    const title = item?.title || item?.url || 'Untitled';
    container.innerHTML = `
      <div class="sp-card-placeholder">
        <span class="sp-card-placeholder-title">${escInfo(title)}</span>
      </div>`;
  }, { once: true });
}
// === END PHASE_IMAGE_URL_PIPELINE ===

function createCardElement(item, isNew = false) {
  const itemId  = getItemId(item);
  const cardHtml = createDataCard(item);
  const tempDiv  = document.createElement('div');
  tempDiv.innerHTML = cardHtml.trim();
  const card = tempDiv.firstChild;

  if (!card.dataset.itemId) card.dataset.itemId = itemId;
  if (!card.dataset.url)    card.dataset.url    = item.url;
  if (!card.dataset.title)  card.dataset.title  = item.title || 'Untitled';
  if (item.directoryId && item.directoryId !== 'undefined') {
    card.dataset.directoryId = item.directoryId;
  }
  card.dataset.imgUrl = item.img_url || '';

  kcCardItemByEl.set(card, item);
  attachCardImageErrorFallback(card, item);

  const wrapper = document.createElement('div');
  wrapper.className  = 'card-wrapper';
  wrapper.style.cssText = 'overflow:hidden;transition:height 0.3s cubic-bezier(0.2,0,0,1),opacity 0.3s ease;';
  wrapper.appendChild(card);

  const container = document.createElement('div');
  container.className = 'card-container image_card';

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

  // If the card has a thumbnail image, wait for load when needed before measuring height
  const screenshotImg = wrapper.querySelector('.data-card-imgcontainer .data-card-image');

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
function addOptimisticCard({ tempId, url, title, imgUrl, originSource = '', imgThumbnailB64 = '', category, platform, createdAt }) {
  if (!currentUser) return;

  // Deduplication: ignore if a temp card with same tempId already exists
  if (optimisticCards.has(tempId)) return;

  // === PHASE_ORIGIN_SOURCE_DEDUP ===
  // Dedup by url + origin_source (replaces Phase 18b's url + img_url).
  // Video clips put base64 data URLs in img_url which change between
  // captures of the same video — origin_source provides a stable identifier
  // (video.src for video, img URL for image). Server enforces the same
  // rule (see functions/src/index.ts PHASE_ORIGIN_SOURCE_DEDUP).
  //
  // When incoming origin_source is empty, dedup is skipped — every clip
  // creates a new card. Same pattern as the old img_url empty handling.
  //
  // Legacy items (no origin_source field) are excluded from dedup
  // (existing.origin_source is empty → skip). Re-clipping legacy items
  // creates a new card. Acceptable trade-off (no migration).
  const incomingUrl = url || '';
  const incomingOriginSource = String(originSource || '').trim();

  // Race guard: skip when an in-flight optimistic card already matches.
  // On match, update the optimistic card's displayed image to the new clip's
  // thumbnail/img_url (B1+C from origin_source dedup decisions). Server-side
  // persistence is left to the in-flight first save; the second clip skips
  // its own server call (current pattern, no extra cost).
  if (incomingOriginSource) {
    for (const [, entry] of optimisticCards.entries()) {
      if ((entry.url || '') !== incomingUrl) continue;
      const entryOriginSource = String(entry.originSource || '').trim();
      if (!entryOriginSource) continue;
      if (entryOriginSource !== incomingOriginSource) continue;
      // === PHASE_DEDUP_IMAGE_UPDATE ===
      try {
        const newDisplayImg = String(imgThumbnailB64 || imgUrl || '').trim();
        if (newDisplayImg && entry.cardContainer?.isConnected) {
          const card = entry.cardContainer.querySelector('.data-card');
          if (card) updateCardImage(card, newDisplayImg);
          // Keep entry.imgUrl in sync for future dedup pre-checks reading it.
          entry.imgUrl = String(imgUrl || '').trim();
        }
      } catch (_) { /* defensive — match still suppresses duplicate card */ }
      // === END PHASE_DEDUP_IMAGE_UPDATE ===
      return;
    }
  }

  // Match against current persisted items.
  const matchingItem = incomingOriginSource
    ? currentItems.find((it) => {
        const itemUrl = typeof it.url === 'string' ? it.url : '';
        if (itemUrl !== incomingUrl) return false;
        const itemOriginSource = typeof it.origin_source === 'string'
          ? it.origin_source.trim() : '';
        if (!itemOriginSource) return false;
        return itemOriginSource === incomingOriginSource;
      })
    : null;
  // === END PHASE_ORIGIN_SOURCE_DEDUP ===

  // === PHASE_SIDEPANEL_UNIFIED_LIST ===
  if (matchingItem) {
    // Found an existing DataCard. Reorder to top of unified dock list.
    const targetList = getUnifiedDockList();
    let matchedDataCard = null;
    if (targetList) {
      matchedDataCard = targetList.querySelector(
        `[data-doc-id="${matchingItem.id}"]`
      );
      // Phase 18b.1: data-doc-id lives on the inner data-card element,
      // but the actual list child is the wrapping .card-container
      // (which carries layout, animation, and image-container CSS).
      // Reorder the wrapper, not the inner card.
      const cardContainer = matchedDataCard?.closest('.card-container');
      if (cardContainer && cardContainer.parentElement === targetList) {
        const todayDivider = targetList.querySelector(
          '.sp-timeline-divider[data-timeline-label="Today"]'
        );
        if (todayDivider && todayDivider.nextSibling) {
          targetList.insertBefore(cardContainer, todayDivider.nextSibling);
        } else if (todayDivider) {
          targetList.appendChild(cardContainer);
        } else {
          targetList.prepend(cardContainer);
        }
        syncTimelineDividers(targetList);
      }
    }
    // === PHASE_DEDUP_IMAGE_UPDATE ===
    // Server's update(baseFields) will persist new img_url/img_thumbnail_b64
    // to Firestore. The snapshot listener uses reconcileSnapshotSilently
    // and does NOT update DOM (to avoid base64 reload flash). Explicit DOM
    // update here ensures the displayed image reflects the latest clip
    // immediately after the visual reorder.
    try {
      const newDisplayImg = String(imgThumbnailB64 || imgUrl || '').trim();
      if (newDisplayImg && matchedDataCard) {
        updateCardImage(matchedDataCard, newDisplayImg);
      }
    } catch (_) { /* defensive — reorder still happened */ }
    // === END PHASE_DEDUP_IMAGE_UPDATE ===
    // Server save-url is still called by coreEntry.js. Server
    // dedup handles the data side; this client path handles only
    // the visual reorder + image update.
    return;
  }

  // Build a temporary item object matching the real item structure
  const tempItem = {
    id:          tempId,
    url:         url || '',
    title:       title || 'Untitled',
    img_url:     imgUrl || '',
    ...(imgThumbnailB64 ? { img_thumbnail_b64: imgThumbnailB64 } : {}),
    domain:      (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
    directoryId: 'undefined',
    order:       -Infinity, // Always at the top
    _isOptimistic:   true,
    category:        category      || '',
    platform:        platform      || '',
    createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
  };

  // Create the card element
  const { container, wrapper, card } = createCardElement(tempItem, true);
  card.dataset.tempId = tempId;
  container.dataset.optimisticCard = tempId;
  card.dataset.handlerAttached = 'false';

  // Add visual indicator that this card is pending
  wrapper.style.opacity = '0.7';

  // Prepend to the top of the unified dock list
  const targetList = getUnifiedDockList();
  if (!targetList) return;
  const todayDivider = targetList.querySelector(
    '.sp-timeline-divider[data-timeline-label="Today"]'
  );
  if (todayDivider && todayDivider.nextSibling) {
    targetList.insertBefore(container, todayDivider.nextSibling);
  } else if (todayDivider) {
    targetList.appendChild(container);
  } else {
    targetList.prepend(container);
  }

  // Sync "No clips yet" now that this list has a card in the DOM.
  ensureEmptyState(targetList);
  syncTimelineDividers(targetList);

  // Track in optimisticCards map
  optimisticCards.set(tempId, {
    url,
    title,
    imgUrl,
    // === PHASE_ORIGIN_SOURCE ===
    // origin_source used for dedup (replaces img_url-based dedup).
    // See coreEntry.js PHASE_ORIGIN_SOURCE for rationale.
    originSource,
    // === END PHASE_ORIGIN_SOURCE ===
    cardContainer: container,
  });

  // Add to displayedItemIds so loadData() won't duplicate it
  displayedItemIds.add(tempId);

  // Run entrance animation
  animateEntrance(container, wrapper);

  // Attach handlers
  attachCardClickHandlers();
  updateClearButtonState();
}
// === END PHASE_SIDEPANEL_UNIFIED_LIST ===

function removeOptimisticCard(tempId) {
  const entry = optimisticCards.get(tempId);
  if (!entry) return;

  // Remove from DOM
  if (entry.cardContainer && entry.cardContainer.parentNode) {
    const parentList = entry.cardContainer.parentNode;
    entry.cardContainer.remove();
    ensureEmptyState(parentList);
    syncTimelineDividers(parentList);
  }

  // Clean up tracking
  optimisticCards.delete(tempId);
  displayedItemIds.delete(tempId);
  updateClearButtonState();
}

/**
 * Apply an image URL to a tracked optimistic card. Designed to be
 * called when Phase 12b's deferred `optimistic-card-image-ready`
 * message arrives — the screenshot-capture stage has finished and
 * the dataUrl is finally available to render.
 *
 * Handles three sub-cases idempotently:
 *   1. Card present, has <img> → swap `src`.
 *   2. Card present, no imgcontainer (created with imgUrl='') →
 *      create the imgcontainer + img at layout-correct position.
 *   3. Card absent from optimisticCards map (promoted to real card,
 *      or never created) → silently no-op. Server-side reconcile
 *      via saved-urls-updated will end up using the Firestore
 *      img_url instead, which is fine.
 */
function applyOptimisticCardImage(tempId, imgUrl) {
  if (!tempId || !imgUrl) return;

  const entry = optimisticCards.get(tempId);
  if (!entry) return; // case 3
  const container = entry.cardContainer;
  if (!container || !container.isConnected) return; // detached → no-op

  const card = container.querySelector('.data-card');
  if (!card) return;

  // Update tracked entry so future logic that reads it sees the imgUrl.
  entry.imgUrl = imgUrl;

  let img = card.querySelector('.data-card-image');
  if (img) {
    // case 1: simple src swap
    img.src = getProxiedImageUrl(imgUrl);
    img.alt = String(entry.title || '');
    card.dataset.imgUrl = imgUrl;
    return;
  }

  // case 2: build the imgcontainer at the layout-correct position
  const main = card.querySelector('.data-card-main');
  if (!main) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'data-card-imgcontainer';
  const newImg = document.createElement('img');
  newImg.className = 'data-card-image';
  newImg.alt = String(entry.title || '');
  newImg.src = getProxiedImageUrl(imgUrl);
  wrapper.appendChild(newImg);
  const placeholder = main.querySelector('.sp-card-placeholder');
  if (placeholder) placeholder.closest('.data-card-imgcontainer')?.remove();
  main.appendChild(wrapper);

  // Reflect on the card's dataset so loadData() comparisons work.
  card.dataset.imgUrl = imgUrl;
}

/**
 * Recompute the disabled state of the single clear button for the
 * unified dock list. Called whenever card state changes and after bulk clear.
 */
function updateClearButtonState() {
  const btn = document.querySelector('.sp-clear-btn');
  if (!btn) return;

  // === PHASE_SIDEPANEL_UNIFIED_LIST ===
  const list = getUnifiedDockList();
  if (!list) {
    btn.disabled = true;
    return;
  }

  const hasCards = list.querySelector('.card-container') !== null;
  const hasOptimistic = list.querySelector('.card-container[data-optimistic-card]') !== null;
  const isPending = btn.dataset.clearPending === 'true';

  btn.disabled = !hasCards || hasOptimistic || isPending;
}
// === END PHASE_SIDEPANEL_UNIFIED_LIST ===

/**
 * Ensure the per-category "No clips yet" placeholder is in sync
 * with the list's actual contents. Called wherever a category's
 * cards are mutated outside loadData()'s full re-render path —
 * notably addOptimisticCard, the per-card delete handler, and
 * executeClear.
 *
 * - If the list has at least one .card-container: remove .sp-empty
 *   if present.
 * - Otherwise: append a fresh .sp-empty if not already present.
 */
function ensureEmptyState(list) {
  if (!list) return;
  const hasCards = list.querySelector('.card-container') !== null;
  const existingEmpty = list.querySelector('.sp-empty');
  if (hasCards) {
    if (existingEmpty) existingEmpty.remove();
  } else if (!existingEmpty) {
    const empty = document.createElement('div');
    empty.className = 'sp-empty';
    empty.textContent = 'No clips yet';
    list.appendChild(empty);
  }
}

/**
 * Sync timeline dividers in a category list with its current
 * card contents:
 * - If the list has zero `.card-container`, remove every
 *   `.sp-timeline-divider`. Stranded labels otherwise persist
 *   after a clear or last-card delete.
 * - Otherwise, ensure a "Today" divider sits immediately above
 *   the first card. If the element already directly above the
 *   first card is a Today divider, do nothing. This is a
 *   mid-session helper for paths that don't go through loadData().
 *
 * loadData() continues to use `insertTimelineDividers` for the
 * full grouping pass (Yesterday, older dates, etc.). This helper
 * intentionally only manages the Today label and total cleanup,
 * matching the (alpha) trade-off documented in Phase 13.6.
 */
function syncTimelineDividers(list) {
  if (!list) return;
  const cards = list.querySelectorAll('.card-container');

  if (cards.length === 0) {
    list.querySelectorAll('.sp-timeline-divider').forEach((d) => d.remove());
    return;
  }

  const firstCard = cards[0];
  const prev = firstCard.previousElementSibling;
  const isPrevTodayDivider = prev?.classList?.contains('sp-timeline-divider')
    && prev?.dataset?.timelineLabel === 'Today';

  if (!isPrevTodayDivider) {
    const divider = createTimelineDivider('Today');
    list.insertBefore(divider, firstCard);
  }
}

// === PHASE_SIDEPANEL_UNIFIED_LIST ===
async function executeClear(list, btn, exitConfirmPending) {
  if (!currentUser) {
    exitConfirmPending();
    return;
  }

  // Mark pending so the disabled-state recomputation keeps the button
  // disabled during the in-flight requests.
  btn.dataset.clearPending = 'true';
  updateClearButtonState();

  const cardContainers = Array.from(list.querySelectorAll('.card-container'));
  const docIds = cardContainers
    .map((c) => {
      const card = c.querySelector('.data-card');
      return card?.dataset?.docId || card?.dataset?.itemId || '';
    })
    .filter((id) => !!id);

  // Fire all deletes in parallel. Failures are otherwise ignored —
  // sidepanel reopen will reload the actual Firestore state if anything
  // went wrong.
  await Promise.allSettled(
    docIds.map((docId) =>
      fetch(
        `${KC_SERVER_URL}/api/v1/items/${encodeURIComponent(docId)}?userId=${encodeURIComponent(currentUser.uid)}`,
        { method: 'DELETE' }
      )
    )
  );

  // Remove all card containers from this list's DOM.
  cardContainers.forEach((c) => c.remove());

  // Also clean up matching entries from the local optimisticCards
  // map (if any tempIds happened to be in this category — unlikely
  // because button is disabled while OptimisticCards exist, but be
  // defensive).
  for (const [tempId, entry] of optimisticCards.entries()) {
    if (entry.cardContainer && !entry.cardContainer.isConnected) {
      optimisticCards.delete(tempId);
      displayedItemIds.delete(tempId);
    }
  }

  ensureEmptyState(list);
  syncTimelineDividers(list);

  // Reset confirm-pending and pending flag.
  delete btn.dataset.clearPending;
  exitConfirmPending();
  updateClearButtonState();

  // Toast.
  showKcToast(`${docIds.length} clips cleared`, 'success');
  // === PHASE_CARD_MULTISELECT ===
  _kcClearCardSelection();
  // === END PHASE_CARD_MULTISELECT ===
}
// === END PHASE_SIDEPANEL_UNIFIED_LIST ===

function attachClearButtonHandlers() {
  const bar = document.querySelector('.sp-clear-bar');
  const btn = bar?.querySelector('.sp-clear-btn');
  if (!bar || !btn) return;

  // Avoid double-attachment.
  if (btn.dataset.handlerAttached === 'true') return;
  btn.dataset.handlerAttached = 'true';

  const trashIcon = btn.querySelector('.sp-clear-icon-trash');
  const checkIcon = btn.querySelector('.sp-clear-icon-check');
  const confirmText = bar.querySelector('.sp-clear-confirm-text');

  let dismissHandler = null;
  // === PHASE_CARD_MULTISELECT ===
  let confirmTimeout = null;
  let confirmEscHandler = null;
  // 'selected' = confirm pending for the current multi-selection;
  // 'all' = confirm pending for clear-all. Reset on exit.
  let confirmMode = null;
  // === END PHASE_CARD_MULTISELECT ===

  const exitConfirmPending = () => {
    bar.classList.remove('confirm-pending');
    if (trashIcon) trashIcon.style.display = '';
    if (checkIcon) checkIcon.style.display = 'none';
    if (confirmText) {
      confirmText.style.display = 'none';
      confirmText.textContent = '';
    }
    if (dismissHandler) {
      document.removeEventListener('click', dismissHandler, true);
      dismissHandler = null;
    }
    // === PHASE_CARD_MULTISELECT ===
    if (confirmTimeout) {
      clearTimeout(confirmTimeout);
      confirmTimeout = null;
    }
    if (confirmEscHandler) {
      document.removeEventListener('keydown', confirmEscHandler);
      confirmEscHandler = null;
    }
    confirmMode = null;
    // === END PHASE_CARD_MULTISELECT ===
  };

  _clearBarExitConfirmPending = exitConfirmPending;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;

    const list = getUnifiedDockList();
    if (!list) return;

    if (!bar.classList.contains('confirm-pending')) {
      // === PHASE_CARD_MULTISELECT ===
      const selectedCount = _kcSelectedCardIds.size;
      if (selectedCount === 0) {
        const cardCount = list.querySelectorAll('.card-container').length;
        if (cardCount === 0) return;
      }
      confirmMode = selectedCount >= 1 ? 'selected' : 'all';

      bar.classList.add('confirm-pending');
      if (trashIcon) trashIcon.style.display = 'none';
      if (checkIcon) checkIcon.style.display = '';
      if (confirmText) {
        confirmText.textContent =
          confirmMode === 'selected'
            ? `Really delete ${selectedCount} clip${selectedCount === 1 ? '' : 's'}?`
            : 'Really delete all clips?';
        confirmText.style.display = '';
      }

      dismissHandler = (dismissEvent) => {
        if (dismissEvent.target.closest('.sp-clear-bar')) return;
        exitConfirmPending();
      };
      confirmEscHandler = (keyEvent) => {
        if (keyEvent.key === 'Escape') exitConfirmPending();
      };
      document.addEventListener('keydown', confirmEscHandler);
      confirmTimeout = setTimeout(() => exitConfirmPending(), 5000);
      setTimeout(() => {
        if (dismissHandler) {
          document.addEventListener('click', dismissHandler, true);
        }
      }, 0);
      return;
      // === END PHASE_CARD_MULTISELECT ===
    }

    // === PHASE_CARD_MULTISELECT ===
    // Second click while pending for a multi-selection: delete only the
    // selected cards. confirmMode must be read BEFORE exitConfirmPending
    // (exit resets it to null).
    if (confirmMode === 'selected') {
      exitConfirmPending();
      executeDeleteSelected();
      return;
    }
    // === END PHASE_CARD_MULTISELECT ===
    // Second click: execute clear on the unified dock list.
    executeClear(list, btn, exitConfirmPending);
  });
}

// ── Button event listeners ────────────────────────────────────────────────────
btnSignin.addEventListener('click', signInWithGoogle);
btnSignout.addEventListener('click', signOut);
if (dirFolderBtn) {
  dirFolderBtn.addEventListener('click', () => { handleOpenFolderSettings(); });
}

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

// ── Firestore proxy calls (via Cloud Functions / KC_SERVER_URL) ───────────────
async function moveItemToPosition(userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId) {
  const res = await fetch(`${KC_SERVER_URL}/api/v1/firestore/move-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId }),
  });
  if (!res.ok) throw new Error(`move-item failed: ${res.status}`);
}

async function moveDirectoryToPosition(userId, directoryId, newIndex) {
  const res = await fetch(`${KC_SERVER_URL}/api/v1/firestore/move-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, directoryId, newIndex }),
  });
  if (!res.ok) throw new Error(`move-directory failed: ${res.status}`);
}

// ── Upload toast + local-save feedback (Phase U2) ─────────────────────────────

let kcToastEl = null;
let kcToastTimer = null;

function showKcToast(message, kind = 'success', duration = 2500) {
  if (!kcToastEl) {
    kcToastEl = document.createElement('div');
    kcToastEl.className = 'kc-toast';
    document.body.appendChild(kcToastEl);
  }
  kcToastEl.textContent = message;
  kcToastEl.classList.remove('kc-toast--visible', 'kc-toast--success', 'kc-toast--error');
  kcToastEl.classList.add(kind === 'error' ? 'kc-toast--error' : 'kc-toast--success');
  void kcToastEl.offsetWidth;
  kcToastEl.classList.add('kc-toast--visible');
  if (kcToastTimer) clearTimeout(kcToastTimer);
  kcToastTimer = setTimeout(() => {
    if (kcToastEl) kcToastEl.classList.remove('kc-toast--visible');
  }, duration);
}

// === PHASE_UPLOAD_TOAST_FILENAME ===
// One-line filename for upload toasts. Truncation is by VISUAL width
// (CJK/fullwidth = 2 units, others = 1) because the toast box is fixed
// width and Korean titles render ~2x wider per character than latin.
// Budget below is derived from .kc-toast's CSS width at its font-size.
const KC_TOAST_NAME_BUDGET = 26; // visual units incl. '…' + extension
function charWidthUnits(ch) {
  const c = ch.codePointAt(0);
  // CJK Unified, Hangul syllables/jamo, fullwidth forms, CJK punct, Kana
  return (
    (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  ) ? 2 : 1;
}
function truncateToWidth(s, budget) {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const w = charWidthUnits(ch);
    if (used + w > budget) return { text: out.trimEnd() + '…', truncated: true };
    out += ch;
    used += w;
  }
  return { text: out, truncated: false };
}
function formatToastFileName(name) {
  const raw = String(name || '').replace(/\s*\r?\n\s*/g, ' ').trim() || '(untitled)';
  const dot = raw.lastIndexOf('.');
  const hasExt = dot > 0 && dot >= raw.length - 6;
  const base = hasExt ? raw.slice(0, dot) : raw;
  const ext = hasExt ? raw.slice(dot) : '';
  const extUnits = Array.from(ext).reduce((a, ch) => a + charWidthUnits(ch), 0);
  const baseBudget = Math.max(4, KC_TOAST_NAME_BUDGET - extUnits - 1); // 1 for '…'
  const t = truncateToWidth(base, baseBudget);
  return t.text + ext;
}
// === END PHASE_UPLOAD_TOAST_FILENAME ===

function flashUploadMark(btnEl, success) {
  if (!btnEl) return;
  const cls = success ? 'kc-upload--success' : 'kc-upload--error';
  btnEl.classList.add(cls, 'kc-upload--feedback');
  setTimeout(() => {
    btnEl.classList.remove(cls, 'kc-upload--feedback');
  }, 1200);
}

// === PHASE_CARD_CLIPBOARD_COPY ===
function handleClipButtonClick(item, anchorBtn) {
  const imgUrl = String(item?.img_url || '').trim();
  const proxied = getProxiedImageUrl(imgUrl);
  const pngPromise = resolveItemClipboardPngBlob(
    item,
    proxied && proxied !== imgUrl ? proxied : ''
  ).then((png) => {
    if (!png) throw new Error('clipboard image resolve failed');
    return png;
  });
  navigator.clipboard
    .write([new ClipboardItem({ 'image/png': pngPromise })])
    .then(() => {
      flashUploadMark(anchorBtn, true);
      showKcToast('클립보드에 복사 완료', 'success');
    })
    .catch(() => {
      flashUploadMark(anchorBtn, false);
      showKcToast('이미지 복사에 실패했습니다', 'error');
    });
}
// === END PHASE_CARD_CLIPBOARD_COPY ===

function handleLocalUpload(item, anchorBtn) {
  saveItemViaDownloads(item)
    .then((result) => {
      if (result.ok) {
        flashUploadMark(anchorBtn, true);
        showKcToast(`${formatToastFileName(result.filename)}\n저장 완료`, 'success');
      } else if (result.reason === 'cancelled') {
        flashUploadMark(anchorBtn, false);
      } else {
        flashUploadMark(anchorBtn, false);
        showKcToast(`저장 실패: ${result.message || 'Unknown error'}`, 'error');
      }
    })
    .catch((e) => {
      flashUploadMark(anchorBtn, false);
      showKcToast(`저장 실패: ${e?.message || String(e)}`, 'error');
    });
}

function handleAutoPathUpload(item, anchorBtn, handle) {
    writeItemToHandle(handle, item)
    .then((result) => {
      if (result.ok) {
        flashUploadMark(anchorBtn, true);
        showKcToast(
          `${formatToastFileName(result.filename)}\nsaved to ${result.primaryFolderName}`,
          'success'
        );
      } else {
        flashUploadMark(anchorBtn, false);
        let msg;
        switch (result.reason) {
          case 'permission':
            msg = '폴더 접근 권한이 거부되었습니다. 저장 폴더를 다시 선택하세요.';
            _markDirFolderMissing(handle?.name);
            break;
          case 'folder-missing':
            msg = '폴더를 찾을 수 없습니다. 저장 폴더를 다시 선택하세요.';
            _markDirFolderMissing(handle?.name);
            break;
          default:
            msg = `저장 실패: ${result.message || 'Unknown error'}`;
        }
        showKcToast(msg, 'error');
      }
    })
    .catch((e) => {
      flashUploadMark(anchorBtn, false);
      showKcToast(`저장 실패: ${e?.message || String(e)}`, 'error');
    });
}

function openUploadPopover(item, anchorBtn) {
  openKcUploadPopover(anchorBtn, item);
}

/**
 * Upload an item directly to the configured Drive SeaClip_files folder.
 * Called when destination.type === 'drive' and Auto is ON.
 */
async function handleAutoDriveUpload(item, destination, anchorBtn) {
  try {
    showKcToast('Google Drive에 업로드 중...');

    const payload = await buildDriveUploadPayload(item);
    if (!payload.ok) {
      flashUploadMark(anchorBtn, false);
      showKcToast(`업로드 준비 실패: ${payload.message || 'Unknown'}`, 'error');
      return;
    }

    const uploadResp = await chrome.runtime.sendMessage({
      action: 'drive-upload-file',
      folderId: destination.driveFolderId,
      desiredName: payload.desiredName,
      mimeType: payload.mimeType,
      contentBase64: payload.contentBase64,
    });

    if (!uploadResp?.ok) {
      flashUploadMark(anchorBtn, false);
      if (uploadResp?.reason === 'folder-missing') {
        await clearDestination();
        await _refreshDirContainer();
        showKcToast('Drive 폴더를 찾을 수 없습니다. 다시 설정해주세요.', 'error');
        return;
      }
      showKcToast(`업로드 실패: ${uploadResp?.message || 'Unknown'}`, 'error');
      return;
    }

    flashUploadMark(anchorBtn, true);
    // PHASE_UPLOAD_TOAST_FILENAME: unify the Drive success toast with the
    // non-Drive folder-upload style — width-budgeted filename owns line 1
    // (formatToastFileName's budget assumes a dedicated line; the old
    // single-line ✓/quotes/suffix form exceeded the toast width and
    // wrapped mid-name), 'saved to {folder}' on line 2 like the local
    // directory-handle path. driveFolderName fallback mirrors the
    // destination display fallback elsewhere in this file.
    showKcToast(
      `${formatToastFileName(payload.desiredName)}\nsaved to ${destination.driveFolderName || 'SeaClip_files'}`,
      'success'
    );
  } catch (e) {
    flashUploadMark(anchorBtn, false);
    showKcToast(`업로드 실패: ${e?.message || String(e)}`, 'error');
  }
}

// === PHASE_UPLOAD_AUTO_ROUTING ===
// handleUploadButtonClick — card upload button entry point.
//
// Always-auto routing (PHASE_UPLOAD_ALWAYS_AUTO): route immediately via
// handleUploadToDestination. The upload popover (openKcUploadPopover) is
// reachable only via the catch-path fallback when routing throws.
async function handleUploadButtonClick(item, anchorBtn) {
  try {
    await handleUploadToDestination(item, anchorBtn);
  } catch (e) {
    openKcUploadPopover(anchorBtn, item);
  }
}

// handleUploadToDestination — destination-driven upload dispatcher.
//
// Called from two paths:
//   1. handleUploadButtonClick (always-auto primary path).
//   2. Card popover's "지정 디렉토리로 업로드" item (error fallback or manual).
//
// Destination mapping:
//   null                            → saveItemToDownloads (implicit default)
//   {type: 'downloads'}             → saveItemToDownloads (explicit)
//   {type: 'local'} + handle ok     → handleAutoPathUpload (existing IDB handle path)
//   {type: 'local'} + handle missing → _markDirFolderMissing + toast + open Dir popover
//   {type: 'drive', ...}             → handleAutoDriveUpload (existing Drive path)
//
// The Downloads paths (null + 'downloads') go through chrome.downloads
// with filename '<sanitized>.<ext>' in the Downloads root and saveAs: false. No OS
// dialog, no user gesture required.
async function handleUploadToDestination(item, anchorBtn) {
  try {
    const destination = await getDestination();

    // Downloads: null fallthrough and explicit type both route here.
    if (!destination || destination.type === 'downloads') {
      const result = await saveItemToDownloads(item);
      if (result && result.ok) {
        flashUploadMark(anchorBtn, true);
        showKcToast(`${formatToastFileName(result.filename)}\n저장 완료`, 'success');
      } else {
        flashUploadMark(anchorBtn, false);
        showKcToast(`저장 실패: ${result?.message || 'Unknown error'}`, 'error');
      }
      return;
    }

    if (destination.type === 'local') {
      const handle = getPrimaryHandleForGesture();
      if (!handle) {
        _markDirFolderMissing();
        showKcToast('선택한 폴더를 찾을 수 없습니다. 저장 위치를 다시 선택해주세요.', 'error');
        // Open the picker window so user can re-pick.
        await handleOpenFolderSettings();
        return;
      }
      handleAutoPathUpload(item, anchorBtn, handle);
      return;
    }

    if (destination.type === 'drive') {
      await handleAutoDriveUpload(item, destination, anchorBtn);
      return;
    }

    // Defensive fallback: unknown destination shape → treat as Downloads.
    const result = await saveItemToDownloads(item);
    if (result && result.ok) {
      flashUploadMark(anchorBtn, true);
      showKcToast(`${formatToastFileName(result.filename)}\n저장 완료`, 'success');
    } else {
      flashUploadMark(anchorBtn, false);
      showKcToast(`저장 실패: ${result?.message || 'Unknown error'}`, 'error');
    }
  } catch (e) {
    flashUploadMark(anchorBtn, false);
    showKcToast(`저장 실패: ${e?.message || String(e)}`, 'error');
  }
}
// === END PHASE_UPLOAD_AUTO_ROUTING ===

// ── Upload destination popover (Phase U1 — UI only, no file I/O) ──────────────

function onKcUploadEscapeKey(ev) {
  if (ev.key === 'Escape') closeKcUploadPopover();
}

function closeKcUploadPopover() {
  if (kcUploadOutsideDismiss) {
    document.removeEventListener('click', kcUploadOutsideDismiss, false);
    kcUploadOutsideDismiss = null;
  }
  document.removeEventListener('keydown', onKcUploadEscapeKey, false);
  if (kcUploadPopoverEl) {
    kcUploadPopoverEl.classList.remove('kc-upload-popover--open');
    kcUploadPopoverEl.style.display = 'none';
    delete kcUploadPopoverEl._kcItem;
    delete kcUploadPopoverEl._kcAnchorBtn;
  }
}

function ensureKcUploadPopover() {
  if (kcUploadPopoverEl) return kcUploadPopoverEl;
  const app = document.getElementById('app');
  if (!app) return null;
  const div = document.createElement('div');
  div.className = 'kc-upload-popover';
  div.setAttribute('role', 'menu');
  // === PHASE_UPLOAD_AUTO_ROUTING ===
  // Card popover items (decision 6):
  //   📁 내 컴퓨터 폴더         → handleLocalUpload (OS save dialog, saveAs: true)
  //   📁 지정 디렉토리로 업로드  → handleUploadToDestination (routes by destination)
  //
  // Drive option removed from card popover. Drive is set via directory
  // settings; once {type:'drive'} is the active
  // destination, the "지정 디렉토리로 업로드" item routes there.
  div.innerHTML = `
    <button type="button" class="kc-upload-popover-item" data-destination="local" role="menuitem">
      <span class="kc-upload-popover-icon" aria-hidden="true">📁</span>
      <span>내 컴퓨터 폴더</span>
    </button>
    <button type="button" class="kc-upload-popover-item" data-destination="destination" role="menuitem">
      <span class="kc-upload-popover-icon" aria-hidden="true">📁</span>
      <span>지정 디렉토리로 업로드</span>
    </button>
  `;
  div.querySelectorAll('.kc-upload-popover-item').forEach((itemBtn) => {
    itemBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const dest = itemBtn.getAttribute('data-destination') || '';
      const item = div._kcItem;
      const anchorBtn = div._kcAnchorBtn;
      closeKcUploadPopover();
      if (!item) return;
      if (dest === 'local') {
        handleLocalUpload(item, anchorBtn);
      } else if (dest === 'destination') {
        await handleUploadToDestination(item, anchorBtn);
      }
    });
  });
  // === END PHASE_UPLOAD_AUTO_ROUTING ===
  app.appendChild(div);
  kcUploadPopoverEl = div;
  return div;
}

function positionKcUploadPopover(anchorEl) {
  const pop = ensureKcUploadPopover();
  if (!pop || !anchorEl) return;

  pop.classList.remove('kc-upload-popover--open');
  pop.style.display = 'block';
  pop.style.visibility = 'hidden';
  pop.style.position = 'fixed';
  pop.style.left = '0px';
  pop.style.top = '0px';

  requestAnimationFrame(() => {
    const ar = anchorEl.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const pad = 6;
    let left = ar.left;
    let top = ar.bottom + 4;

    if (left + pr.width > window.innerWidth - pad) {
      left = ar.right - pr.width;
    }
    if (left < pad) left = pad;

    if (top + pr.height > window.innerHeight - pad) {
      top = ar.top - pr.height - 4;
    }
    if (top < pad) top = pad;

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = '';
    pop.style.display = '';
    pop.classList.add('kc-upload-popover--open');
  });
}

function openKcUploadPopover(anchorBtn, item) {
  const pop = ensureKcUploadPopover();
  if (!pop) return;

  const wasOpen = pop.classList.contains('kc-upload-popover--open');
  const prevAnchor = pop._kcAnchorBtn;
  if (wasOpen && prevAnchor === anchorBtn) {
    closeKcUploadPopover();
    return;
  }
  if (wasOpen && prevAnchor !== anchorBtn) {
    closeKcUploadPopover();
  }

  pop._kcItem = item;
  pop._kcAnchorBtn = anchorBtn;

  positionKcUploadPopover(anchorBtn);

  if (kcUploadOutsideDismiss) {
    document.removeEventListener('click', kcUploadOutsideDismiss, false);
  }
  const outside = (ev) => {
    if (ev.target.closest('.kc-upload-popover')) return;
    if (ev.target.closest('.data-card-upload')) return;
    if (ev.target.closest('.data-card-clip')) return;
    closeKcUploadPopover();
  };
  kcUploadOutsideDismiss = outside;
  setTimeout(() => {
    document.addEventListener('click', outside, false);
  }, 0);
  document.addEventListener('keydown', onKcUploadEscapeKey, false);
}

// === PHASE_CARD_CLIPBOARD_COPY ===
function attachClipHandlers(container) {
  container.querySelectorAll('.data-card-clip').forEach((wrap) => {
    const newWrap = wrap.cloneNode(true);
    wrap.parentNode.replaceChild(newWrap, wrap);
    const btn = newWrap.querySelector('.data-card-clip-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = newWrap.closest('.data-card');
      if (!card) return;
      if (card.querySelector('.data-card-header.delete-pending')) return;
      const item = kcCardItemByEl.get(card);
      if (!item) return;
      handleClipButtonClick(item, btn);
    });
  });
}
// === END PHASE_CARD_CLIPBOARD_COPY ===

function attachUploadHandlers(container) {
  container.querySelectorAll('.data-card-upload').forEach((wrap) => {
    const newWrap = wrap.cloneNode(true);
    wrap.parentNode.replaceChild(newWrap, wrap);
    const btn = newWrap.querySelector('.data-card-upload-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = newWrap.closest('.data-card');
      if (!card) return;
      if (card.querySelector('.data-card-header.delete-pending')) return;
      const item = kcCardItemByEl.get(card);
      if (!item) return;
      handleUploadButtonClick(item, btn);
    });
  });
}

// ── Delete handlers ───────────────────────────────────────────────────────────
function attachDeleteHandlers(container) {
  container.querySelectorAll('.data-card-delete').forEach((btn) => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      closeKcUploadPopover();
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
            confirmEl.innerHTML = '<span class="data-card-delete-pending">Really delete?</span>';
          } else {
            confirmEl.dataset.originalText = confirmEl.textContent;
            confirmEl.textContent = 'Really delete?';
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
            const parentList = cardContainer.parentNode;
            fetch(
              `${KC_SERVER_URL}/api/v1/items/${encodeURIComponent(docId)}?userId=${encodeURIComponent(currentUser.uid)}`,
              { method: 'DELETE' }
            ).catch(() => {});
            cardContainer.remove();
            ensureEmptyState(parentList);
            syncTimelineDividers(parentList);
            updateClearButtonState();
          }, 250);
        }
      }
    });
  });
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
/**
 * Removes the active class from all card-wrappers.
 */
function deactivateAllCards() {
  document.querySelectorAll('.card-wrapper.active').forEach((w) => {
    w.classList.remove('active');
  });
}

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
    const mappedItem = kcCardItemByEl.get(card);
    const newCard = card.cloneNode(true);
    card.parentNode.replaceChild(newCard, card);
    if (mappedItem) kcCardItemByEl.set(newCard, mappedItem);

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

    // Click → first click activates card; second click on active card opens URL
    newCard.addEventListener('click', (e) => {
      const timeSinceDragEnd = Date.now() - lastDragEndTime;
      if (isDragging || timeSinceDragEnd < 100) return;

      // Ignore clicks on the delete button area
      if (e.target.closest('.data-card-delete')) return;
      if (e.target.closest('.data-card-upload')) return;
      if (e.target.closest('.data-card-clip')) return;

      const clickedWrapper = newCard.closest('.card-wrapper');
      if (!clickedWrapper) return;

      // Block any action when delete is pending
      if (clickedWrapper.classList.contains('delete-pending')) return;

      // === PHASE_CARD_MULTISELECT ===
      if (e.shiftKey) {
        _kcHandleCardSelectionClick(newCard, true);
        return;
      }
      _kcHandleCardSelectionClick(newCard, false);
      // === END PHASE_CARD_MULTISELECT ===

      const url = newCard.dataset.url;
      if (!url) return;

      if (clickedWrapper.classList.contains('active')) {
        // Second click on already-active card → open URL
        window.open(url, '_blank');
      } else {
        // First click → activate this card, deactivate all others
        deactivateAllCards();
        clickedWrapper.classList.add('active');
      }
    });

    newCard.dataset.handlerAttached = 'true';
  });

  // === PHASE_CARD_MULTISELECT ===
  _kcApplyCardSelectionClasses();
  // === END PHASE_CARD_MULTISELECT ===

  attachDeleteHandlers(document);
  // === PHASE_CARD_CLIPBOARD_COPY ===
  attachClipHandlers(document);
  // === END PHASE_CARD_CLIPBOARD_COPY ===
  attachUploadHandlers(document);

  document.querySelectorAll('.data-card-imgcontainer').forEach((container) => {
    if (container.dataset.imgHandlerAttached === 'true') return;
    container.dataset.imgHandlerAttached = 'true';

    const img = container.querySelector('.data-card-image');
    if (!img) return;

    img.addEventListener('error', () => {
      container.classList.add('img-placeholder');
      img.style.display = 'none';
    });

    img.addEventListener('load', () => {
      container.classList.remove('img-placeholder');
      img.style.display = '';
    });
  });
}

// Deactivate active card when clicking outside any card-wrapper
document.addEventListener('click', (e) => {
  if (!e.target.closest('.card-wrapper')) {
    deactivateAllCards();
  }
  // === PHASE_CARD_MULTISELECT ===
  if (!e.target.closest('.data-card') && !e.target.closest('.sp-clear-bar')) {
    _kcClearCardSelection();
  }
  // === END PHASE_CARD_MULTISELECT ===
}, { capture: false });

// === PHASE_CARD_MULTISELECT ===
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  dismissClearConfirmPendingIfActive();
  _kcClearCardSelection();
});
// === END PHASE_CARD_MULTISELECT ===

// Deactivate active card when Chrome window loses focus
window.addEventListener('blur', () => {
  deactivateAllCards();
  // === PHASE_CARD_MULTISELECT ===
  // Empirically (maintainer-verified), clicking the host page DOES blur
  // the sidepanel window; clear multi-selection together with the active
  // state so no stale selection survives focus loss.
  _kcClearCardSelection();
  // === END PHASE_CARD_MULTISELECT ===
});

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
    } catch (_) {
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
      } catch (_) {
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
    } catch (_) {
    } finally {
      setTimeout(() => { isSyncing = false; }, 100);
    }
  });
}

// ── Unified drop setup ────────────────────────────────────────────────────────
// === PHASE_SIDEPANEL_UNIFIED_LIST ===
function setupUnifiedDropHandlers() {
  const list = getUnifiedDockList();
  if (list && list.dataset.unifiedDnDAttached !== 'true') {
    list.dataset.unifiedDnDAttached = 'true';
    setupContainerDropHandlers(list, null);
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
// === END PHASE_SIDEPANEL_UNIFIED_LIST ===

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

function updateCardImage(cardEl, newImgUrl) {
  try {
    const imgContainer = cardEl.querySelector('.data-card-imgcontainer');
    const imgEl = cardEl.querySelector('.data-card-image');
    if (!imgContainer || !imgEl) return;
    const trimmed = String(newImgUrl || '').trim();
    if (!trimmed) return;
    const proxiedUrl = getProxiedImageUrl(trimmed);
    const preloader = new Image();
    preloader.onload = () => {
      imgEl.src = proxiedUrl;
      cardEl.dataset.imgUrl = trimmed;
      delete imgEl.dataset.fallbackAttempted;
    };
    preloader.onerror = () => {
      imgEl.src = proxiedUrl;
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

  // === PHASE_SIDEPANEL_UNIFIED_LIST ===
  // Clear unified dock list (preserve animating and optimistic cards)
  const unifiedList = getUnifiedDockList();
  if (unifiedList) {
    Array.from(unifiedList.children).forEach((child) => {
      if (
        child.dataset?.preserveAnimation
        || child.dataset?.optimisticCard
      ) return;
      const dockCard = child.querySelector?.('.data-card');
      const cid = dockCard?.dataset?.itemId;
      if (cid && preserveItemIds.has(cid)) return;
      unifiedList.removeChild(child);
    });
  }

  itemsWithoutDirectory.forEach((item) => {
    const itemId = getItemId(item);

    // Check if this real item matches an optimistic card.
    // Priority 1: exact temp_id match (Firestore's temp_id field ↔ OptimisticCard's tempId).
    //   This is precise and handles the case of multiple simultaneous saves of the same URL.
    // Priority 2: URL-based fallback — only used when temp_id is missing (legacy Firestore
    //   docs saved before temp_id support, or if temp_id was somehow lost in transit).
    // If so, promote the existing DOM in-place (avoid remove/recreate flash).
    let matchedTempId = null;
    if (!isInitialRender) {
      const itemTempId = String(item.temp_id || '').trim();
      if (itemTempId && optimisticCards.has(itemTempId)) {
        matchedTempId = itemTempId;
      } else {
        for (const [tempId, entry] of optimisticCards.entries()) {
          if (entry.url === item.url) {
            matchedTempId = tempId;
            break;
          }
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

        // Update dataset.imgUrl so future loadData() comparisons treat the card
        // as unchanged. For the visible <img>: if the optimistic card hasn't
        // yet been painted (Phase 12b deferred-image case where
        // optimistic-card-image-ready has not arrived in time), adopt the
        // Firestore Storage URL as the visible src so the card stops looking
        // blank. If the visible <img> already exists, the deferred-image
        // handler already painted the correct base64 — leave it alone to
        // avoid a swap-then-server-fetch flicker.
        if (item.img_url) {
          existingCard.dataset.imgUrl = item.img_url;
          const existingImg = existingCard.querySelector('.data-card-image');
          if (!existingImg) {
            // No imgcontainer yet — Phase 12b case where addOptimisticCard
            // created the card without an image and the deferred-image
            // message hasn't arrived. Build the imgcontainer using the
            // server URL directly.
            const main = existingCard.querySelector('.data-card-main');
            if (main && !shouldUsePlaceholder(item)) {
              const wrapper = document.createElement('div');
              wrapper.className = 'data-card-imgcontainer';
              const newImg = document.createElement('img');
              newImg.className = 'data-card-image';
              newImg.alt = String(item.title || 'Untitled');
              newImg.src = getProxiedImageUrl(item.img_url);
              wrapper.appendChild(newImg);
              main.querySelector('.sp-card-placeholder')?.closest('.data-card-imgcontainer')?.remove();
              main.appendChild(wrapper);
            }
          }
          // else: visible img already present (current pre-12b flow OR
          // Phase 12b post-image-ready). Leave src alone — base64 already
          // looks correct, swap would cause a re-fetch flicker.
        }
        kcCardItemByEl.set(existingCard, item);

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
              nextImgUrl
            );
          } else {
            existingCard.closest('.card-container')?.remove();
            removedForRebuild = true;
          }
        }

        if (!removedForRebuild) {
          displayedItemIds.add(itemId);
          kcCardItemByEl.set(existingCard, itemToRender ?? item);
          const existingContainer = existingCard.closest('.card-container');
          if (existingContainer) {
            getUnifiedDockList()?.appendChild(existingContainer);
          }
          return;
        }
      }
    }

    const { container, wrapper, card } = createCardElement(itemToRender, isNew);
    getUnifiedDockList()?.appendChild(container);
    displayedItemIds.add(itemId);
    card.dataset.handlerAttached = 'false';
    if (isNew) animateEntrance(container, wrapper);
  });

  ensureEmptyState(getUnifiedDockList());

  updateClearButtonState();

  // ── Attach handlers ──────────────────────────────────────────────────────
  attachCardClickHandlers();
  setupUnifiedDropHandlers();

  updateCategoryCounts();

  // ── Timeline dividers (unified dock list) ─────────────────────
  const dockListEl = getUnifiedDockList();
  if (dockListEl) {
    insertTimelineDividers(dockListEl, itemsWithoutDirectory);
  }
  // === END PHASE_SIDEPANEL_UNIFIED_LIST ===

}

/**
 * Silently reconcile a Firestore snapshot's added docs against
 * existing OptimisticCards. Updates identifiers and tracking maps
 * so user actions (delete, move) work — but does NOT touch DOM
 * layout (no appendChild, no element removal, no <img> swap).
 *
 * Called for all item snapshots AFTER the first. The first snapshot
 * goes through the full loadData() path for initial render.
 *
 * Behavior by docChange.type:
 * - 'added': try to match an existing OptimisticCard. If matched,
 *   promote it silently (dataset + map cleanup). If unmatched, skip
 *   (cross-device addition — out of scope until sidepanel reopens).
 * - 'modified': skip. The OptimisticCard already shows what the user
 *   clipped; server-side modifications don't currently happen on
 *   visible fields. Cross-device modifications fall under the same
 *   sidepanel-reopen contract as 'added' unmatched.
 * - 'removed': skip. Cross-device deletions wait for sidepanel
 *   reopen.
 *
 * The visible <img> on a promoted OptimisticCard keeps its base64
 * dataURL src. dataset.imgUrl is updated to the server's https URL
 * so future state checks reference the canonical URL, but the
 * visible src is left alone — swapping would trigger the very
 * <img> reload flash this whole approach is designed to avoid.
 * On sidepanel reopen, the card is rendered fresh from Firestore
 * with the https URL.
 */
function reconcileSnapshotSilently(snap) {
  if (!currentUser) return;

  snap.docChanges().forEach((change) => {
    if (change.type !== 'added') return;

    const item = { ...change.doc.data(), id: change.doc.id };

    // Match against OptimisticCards: temp_id first, URL fallback.
    let matchedTempId = null;
    const itemTempId = String(item.temp_id || '').trim();
    if (itemTempId && optimisticCards.has(itemTempId)) {
      matchedTempId = itemTempId;
    } else {
      for (const [tempId, entry] of optimisticCards.entries()) {
        if (entry.url === item.url) {
          matchedTempId = tempId;
          break;
        }
      }
    }

    if (!matchedTempId) {
      // Unmatched — could be a cross-device addition we don't render
      // mid-session. Sidepanel reopen will pick it up via the first-
      // snapshot loadData path.
      return;
    }

    const optimisticEntry = optimisticCards.get(matchedTempId);
    const existingContainer = optimisticEntry?.cardContainer;
    const existingCard = existingContainer?.querySelector('.data-card');
    if (!existingCard) {
      // Tracked but DOM-detached — clean up the map entry and move
      // on. The sidepanel reopen will re-render from Firestore.
      optimisticCards.delete(matchedTempId);
      displayedItemIds.delete(matchedTempId);
      return;
    }

    // ── Identifier & dataset promotion (no DOM layout) ──
    const realItemId = getItemId(item);
    existingCard.id              = `item-${realItemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    existingCard.dataset.itemId  = realItemId;
    existingCard.dataset.docId   = item.id || '';
    existingCard.dataset.url     = item.url || '';
    existingCard.dataset.title   = item.title || 'Untitled';
    if (item.img_url) {
      existingCard.dataset.imgUrl = item.img_url;
    }

    kcCardItemByEl.set(existingCard, item);

    // Remove optimistic marker so this container is treated as a
    // real-rendered card by any future code path.
    delete existingContainer.dataset.optimisticCard;

    // Tracking maps
    optimisticCards.delete(matchedTempId);
    displayedItemIds.delete(matchedTempId);
    displayedItemIds.add(realItemId);
    updateClearButtonState();

    // NOTE: deliberately no appendChild, no updateCardImage. The
    // visible <img> keeps its base64 src; the dataset.imgUrl is the
    // canonical reference for any future logic that needs the
    // server URL.
  });
}

// Notify content script via background when Side Panel gains or loses focus.
// This allows the content script to distinguish "Side Panel focused"
// from "user switched to another app" when window.blur fires on the page.
window.addEventListener('focus', () => {
  try {
    chrome.runtime.sendMessage({ action: 'sidepanel-focused' });
  } catch (e) {}
});

window.addEventListener('blur', () => {
  try {
    chrome.runtime.sendMessage({ action: 'sidepanel-blurred' });
  } catch (e) {}
});

// ── Optimistic card message listener ─────────────────────────────────────────
if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'kc-picker-busy') {
      _kcPickerBusy = Boolean(message.busy);
      return;
    }

    if (message.action === 'kc-picker-handle-ready') {
      (async () => {
        try {
          await refreshPrimaryHandleCache();
          await setDestination({ type: 'local' });
          await _refreshDirContainer();
          showKcToast(`저장 폴더 설정 완료: ${message.folderName || ''}`, 'success');
        } catch (e) {
          showKcToast('폴더 설정을 저장하지 못했습니다.', 'error');
        }
      })();
      return;
    }

    if (message.action === 'kc-picker-drive-ready') {
      (async () => {
        try {
          await _refreshDirContainer();
          showKcToast('✓ Google Drive 폴더가 설정되었습니다.');
        } catch (_) {}
      })();
      return;
    }

    if (message.action === 'kc-picker-downloads-ready') {
      (async () => {
        try {
          await _refreshDirContainer();
          showKcToast('✓ Downloads 폴더로 설정되었습니다.');
        } catch (_) {}
      })();
      return;
    }

    if (message.action === 'optimistic-card') {
      addOptimisticCard({
        tempId:            message.tempId,
        url:               message.url,
        title:             message.title,
        imgUrl:            message.imgUrl || '',
        originSource:      message.originSource || '',
        imgThumbnailB64:   message.imgThumbnailB64 || '',
        category:          message.category      || '',
        platform:          message.platform      || '',
        createdAt:         typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
      });
      return false;
    }

    if (message.action === 'optimistic-card-image-ready') {
      applyOptimisticCardImage(message.tempId, message.imgUrl || '');
      return false;
    }

    return false;
  });
}
