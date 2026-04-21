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
} from './firebase-bundle.js';

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

// ── Shortcut key state ────────────────────────────────────────────────────────
let _currentShortcut = ''; // raw Chrome shortcut string, e.g. 'Ctrl+Shift+S'

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
const spShortcutBtn   = document.getElementById('sp-shortcut-btn');
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

/**
 * Formats a raw Chrome shortcut string for display.
 * On Mac: Ctrl→⌘, Shift→⇧, Alt→⌥, MacCtrl→⌃
 * On Windows/Linux: keeps 'Ctrl+Shift+S' style but uses '+'
 * Returns a compact display string like '⌘⇧S' or 'Ctrl+Shift+S'.
 */
function formatShortcutDisplay(raw) {
  if (!raw) return '⌘⇧S';
  const isMac = navigator.platform.toUpperCase().includes('MAC') ||
    navigator.userAgent.includes('Mac');
  if (isMac) {
    return raw
      .replace(/MacCtrl/gi, '⌃')
      .replace(/Ctrl/gi, '⌘')
      .replace(/Command/gi, '⌘')
      .replace(/Shift/gi, '⇧')
      .replace(/Alt/gi, '⌥')
      .replace(/\+/g, '');
  }
  return raw; // e.g. 'Ctrl+Shift+S'
}

function loadShortcut() {
  try {
    chrome.runtime.sendMessage({ action: 'get-shortcut' }, (response) => {
      if (chrome.runtime.lastError) return;
      const raw = response?.shortcut || 'Ctrl+Shift+S';
      _currentShortcut = raw;
      if (spShortcutBtn) {
        spShortcutBtn.textContent = formatShortcutDisplay(raw);
        spShortcutBtn.dataset.shortcut = raw;
      }
    });
  } catch {}
}

function mountShortcutRecorder() {
  if (!spShortcutBtn) return;
  if (spShortcutBtn.dataset.recorderMounted) return;
  spShortcutBtn.dataset.recorderMounted = 'true';

  spShortcutBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    try {
      chrome.runtime.sendMessage({ action: 'start-shortcut-polling' });
    } catch {}
  });
}

// ── Category section order ────────────────────────────────────────────────
const CATEGORY_ORDER = ['Img', 'SNS', 'Mail', 'Pages'];

let _activeTab = 'Img';

function setupTabHandlers() {
  document.querySelectorAll('.sp-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === _activeTab) return;
      _activeTab = tab;
      document.querySelectorAll('.sp-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const wrap = document.getElementById('sp-itemlist-wrap');
      if (wrap) {
        const tabIndex = ['Img', 'SNS', 'Mail', 'Pages'].indexOf(tab);
        wrap.style.transform = tabIndex > 0 ? `translateX(-${tabIndex * 25}%)` : 'translateX(0%)';
      }
    });
  });
}

/**
 * Normalizes both legacy and new-schema item category/confirmedType.
 * Returns an object { category, confirmedType } in the new schema.
 */
function normalizeItemCategoryAndType(item) {
  const rawCategory = (item?.category || '').trim();
  const rawType = (item?.confirmed_type || item?.confirmedType || '').trim();

  // Legacy 'Contents' → Image (if Image confirmed_type) or Page (anything else, including Video)
  if (rawCategory === 'Contents') {
    if (rawType === 'Image') return { category: 'Image', confirmedType: '' };
    return { category: 'Page', confirmedType: '' };
  }

  // SNS: normalize confirmedType to 'contents' or 'post'
  if (rawCategory === 'SNS') {
    if (rawType === 'Image' || rawType === 'Video' || rawType === 'contents') {
      return { category: 'SNS', confirmedType: 'contents' };
    }
    // 'Post', 'Page', 'post', empty, or anything else → 'post'
    return { category: 'SNS', confirmedType: 'post' };
  }

  // Image / Mail / Page / anything else — return as-is; confirmedType should be empty for these
  return { category: rawCategory, confirmedType: rawType };
}

/**
 * Returns the target list box key ('Img' | 'SNS' | 'Mail' | 'Pages') for a given item.
 * Uses the NEW schema category via normalization so legacy Firestore docs are routed correctly.
 */
function resolveItemListKey(item) {
  const { category } = normalizeItemCategoryAndType(item);
  if (category === 'Image') return 'Img';
  if (category === 'SNS')   return 'SNS';
  if (category === 'Mail')  return 'Mail';
  // Page and anything else → Pages (default)
  return 'Pages';
}

/**
 * Returns a JS Date from a Firestore item's createdAt field.
 * Handles Firestore Timestamp objects ({ seconds, nanoseconds })
 * and raw millisecond numbers. Returns null if unavailable.
 */
function getItemDate(item) {
  try {
    const ca = item?.createdAt;
    if (!ca) return null;
    if (typeof ca.toDate === 'function') return ca.toDate();
    if (typeof ca.seconds === 'number') return new Date(ca.seconds * 1000);
    if (typeof ca === 'number') return new Date(ca);
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
 * @param {HTMLElement} listEl - the .sp-category-list element
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

/**
 * Returns the .sp-category-list element for the given category string, or null if unknown.
 */
function getCategoryList(category) {
  const cat = (category || '').trim();
  const known = ['Img', 'SNS', 'Mail', 'Pages'];
  if (!known.includes(cat)) return null;
  return document.querySelector(`.sp-category-list[data-category-list="${cat}"]`);
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
  setupTabHandlers();

  // Update avatar
  if (user.photoURL) {
    spUserAvatar.src          = user.photoURL;
    spUserAvatar.style.display = 'block';
  } else {
    spUserAvatar.style.display = 'none';
  }

  startListeners(user.uid);

  loadShortcut();
  mountShortcutRecorder();
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
  const screenshotPadding = typeof item.screenshot_padding === 'number' && item.screenshot_padding > 0
    ? item.screenshot_padding : 0;
  const confirmedType = (item.confirmed_type || item.confirmedType || '').trim();
  const pageDescription = String(item.page_description || '');
  const imgUrlMethod = String(item.img_url_method || '');
  const directoryId  = item.directoryId && item.directoryId !== 'undefined' ? item.directoryId : '';

  // Horizontal layout is used for Page-category items (new schema: 'Page';
  // also legacy 'Contents'+'Video' which normalizes to 'Page').
  const { category: normalizedCategoryForLayout } = normalizeItemCategoryAndType(item);
  const usePortraitExtractedLayout = normalizedCategoryForLayout === 'Page';

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
      ? `${KC_SERVER_URL}/api/v1/logo/${faviconDomain}`
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
         class="data-card"
         data-url="${escapedUrl}"
         data-title="${escapedTitle}"
         data-type="${type}"
         data-img-url="${escapedImgUrl}"
         data-item-id="${itemId}"
         data-doc-id="${item.id || ''}"
         data-directory-id="${directoryId}">
      <!-- Main: portrait-extracted = image above main, header+info inside main -->
      ${usePortraitExtractedLayout && imgUrl ? `
      <div class="data-card-imgcontainer data-card-imgcontainer--row">
        <img src="${getProxiedImageUrl(imgUrl)}" alt="${escapedTitle}" class="data-card-image--${imgUrlMethod || 'screenshot'}">
      </div>
      <div class="data-card-main">
        <div class="data-card-header">
          <div class="data-card-context">
            ${(() => {
              const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
              const url = (item.url || '').trim().replace(/^https?:\/\//, '');
              return url ? `<span class="data-card-url">${esc(url)}</span>` : '';
            })()}
          </div>
          ${deleteBtn}
        </div>
        <div class="data-card-info">
          <div class="data-card-extracted-title">${displayTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <div class="data-card-extracted-description">${pageDescription.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
      </div>` : `
      <div class="data-card-header">
        <div class="data-card-context">
          ${(() => {
            const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const normalizedForContent = normalizeItemCategoryAndType(item);
            // A "content card" shows platform name instead of URL in the header.
            // This applies to: new-schema Image category, SNS+contents (media-rich SNS posts),
            // and legacy Contents+Image/Video items (which map to Image/Page respectively).
            const isContentCard =
              normalizedForContent.category === 'Image' ||
              (normalizedForContent.category === 'SNS' && normalizedForContent.confirmedType === 'contents');
            if (isContentCard) {
              const plat = (item.platform || '').trim();
              if (!plat) return '';
              return `<span class="data-card-content-type">${esc(plat)}</span>`;
            } else {
              const url = (item.url || '').trim().replace(/^https?:\/\//, '');
              if (!url) return '';
              return `<span class="data-card-url">${esc(url)}</span>`;
            }
          })()}
        </div>
        ${deleteBtn}
      </div>
      <div class="data-card-main">
        ${imgUrl ? `
        <div class="data-card-imgcontainer"${(() => {
    const styles = [];
    if (screenshotPadding > 0) styles.push(`padding-left:${screenshotPadding}px;padding-right:${screenshotPadding}px;padding-top:${screenshotPadding}px`);
    return styles.length > 0 ? ` style="${styles.join(';')}"` : '';
  })()}>
          <img src="${getProxiedImageUrl(imgUrl)}" alt="${escapedTitle}" class="data-card-image">
        </div>` : ''}
      </div>`}
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
  // Use normalized category AND confirmedType so that SNS items split between
  // grid-style (contents, has dominant media) and full-width (post, text-only).
  const {
    category: normalizedContainerCategory,
    confirmedType: normalizedContainerConfirmedType,
  } = normalizeItemCategoryAndType(item);

  // Image category → grid (image_card).
  // SNS + contents → grid (image_card), same as Image.
  // SNS + post → full-width (pages_card), same as Page.
  // Mail → full-width mail_card.
  // Page / anything else → pages_card (default).
  if (normalizedContainerCategory === 'Image') {
    container.classList.add('image_card');
  } else if (normalizedContainerCategory === 'SNS') {
    if (normalizedContainerConfirmedType === 'contents') {
      container.classList.add('image_card');
    } else {
      container.classList.add('pages_card');
    }
  } else if (normalizedContainerCategory === 'Mail') {
    container.classList.add('mail_card');
  } else {
    container.classList.add('pages_card');
  }

  // Page-category items use the horizontal portrait layout.
  // SNS items (both contents and post) do NOT use portrait layout.
  if (normalizedContainerCategory === 'Page') {
    container.classList.add('portrait_extracted_card');
  }

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
function addOptimisticCard({ tempId, url, title, imgUrl, isScreenshot: isScreenshotFlag, screenshotPadding, screenshotBgColor, category, platform, confirmedType, sender, pageDescription, imgUrlMethod, createdAt }) {
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
    page_description: pageDescription || '',
    img_url_method:   imgUrlMethod || '',
    createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
  };

  // Create the card element
  const { container, wrapper, card } = createCardElement(tempItem, true);
  card.dataset.tempId = tempId;
  container.dataset.optimisticCard = tempId;
  card.dataset.handlerAttached = 'false';

  // Add visual indicator that this card is pending
  wrapper.style.opacity = '0.7';

  // If the card belongs to a different tab than the currently active one,
  // switch to that tab first so the user sees the Optimistic Card appear.
  const targetTabKey = resolveItemListKey(tempItem);
  if (targetTabKey !== _activeTab) {
    _activeTab = targetTabKey;
    // Update tab button active states
    document.querySelectorAll('.sp-tab').forEach((btn) => {
      if (btn.dataset.tab === targetTabKey) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    // Slide the wrap to the target tab
    const tabIndex = CATEGORY_ORDER.indexOf(targetTabKey);
    const wrap = document.getElementById('sp-itemlist-wrap');
    if (wrap) {
      wrap.style.transform = tabIndex > 0
        ? `translateX(-${tabIndex * 25}%)`
        : 'translateX(0%)';
    }
  }

  // Prepend to the top of the routed list box
  const targetList = getCategoryList(resolveItemListKey(tempItem));
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

  // Track in optimisticCards map
  optimisticCards.set(tempId, {
    url,
    title,
    imgUrl,
    cardContainer: container,
  });

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
            fetch(
              `${KC_SERVER_URL}/api/v1/items/${encodeURIComponent(docId)}?userId=${encodeURIComponent(currentUser.uid)}`,
              { method: 'DELETE' }
            ).catch((err) => console.error('[Delete]', err));
            cardContainer.remove();
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

    // Click → first click activates card; second click on active card opens URL
    newCard.addEventListener('click', (e) => {
      const timeSinceDragEnd = Date.now() - lastDragEndTime;
      if (isDragging || timeSinceDragEnd < 100) return;

      // Ignore clicks on the delete button area
      if (e.target.closest('.data-card-delete')) return;

      const clickedWrapper = newCard.closest('.card-wrapper');
      if (!clickedWrapper) return;

      // Block any action when delete is pending
      if (clickedWrapper.classList.contains('delete-pending')) return;

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

// Deactivate active card when clicking outside any card-wrapper
document.addEventListener('click', (e) => {
  if (!e.target.closest('.card-wrapper')) {
    deactivateAllCards();
  }
}, { capture: false });

// Deactivate active card when Chrome window loses focus
window.addEventListener('blur', () => {
  deactivateAllCards();
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
    const preloader = new Image();
    preloader.onload = () => {
      imgEl.src = proxiedUrl;
      cardEl.dataset.imgUrl = newImgUrl;
    };
    preloader.onerror = () => {
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
            const targetList = getCategoryList(resolveItemListKey(itemToRender ?? item));
            targetList?.appendChild(existingContainer);
          }
          return;
        }
      }
    }

    const { container, wrapper, card } = createCardElement(itemToRender, isNew);
    getCategoryList(resolveItemListKey(itemToRender ?? item))?.appendChild(container);
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

  // ── Timeline dividers ────────────────────────────────────────
  CATEGORY_ORDER.forEach((cat) => {
    const listEl = getCategoryList(cat);
    if (!listEl) return;
    const itemsForList = itemsWithoutDirectory.filter(
      (it) => resolveItemListKey(it) === cat
    );
    insertTimelineDividers(listEl, itemsForList);
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
    if (message.action === 'shortcut-updated') {
      const raw = typeof message.shortcut === 'string' && message.shortcut
        ? message.shortcut
        : 'Ctrl+Shift+S';
      _currentShortcut = raw;
      if (spShortcutBtn) {
        spShortcutBtn.textContent = formatShortcutDisplay(raw);
        spShortcutBtn.dataset.shortcut = raw;
      }
      return false;
    }

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
        pageDescription:     message.page_description || '',
        imgUrlMethod:      message.img_url_method   || '',
        createdAt:         typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
      });
    }
    return false;
  });
}
