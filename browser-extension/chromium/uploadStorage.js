// uploadStorage.js — persists a FileSystemDirectoryHandle in IndexedDB.
// Single-directory model (MVP): one "primary" handle used for all upload targets.
//
// Public API:
//   getPrimaryHandle()    -> Promise<FileSystemDirectoryHandle | null>
//   setPrimaryHandle(h)   -> Promise<void>
//   clearPrimaryHandle()  -> Promise<void>

const DB_NAME = 'kickclipUploadHandles';
const DB_VERSION = 1;
const STORE = 'directoryHandles';
const PRIMARY_KEY = 'primary';

/** @returns {Promise<IDBDatabase | null>} */
function openDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => {
      console.log('[KICKCLIP-LOG] uploadStorage openDB error:', req.error);
      resolve(null);
    };
    req.onblocked = () => {
      console.log('[KICKCLIP-LOG] uploadStorage openDB blocked');
    };
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

/** @param {IDBRequest} req */
function promisifyRequest(req) {
  return new Promise((resolve) => {
    req.onerror = () => {
      console.log('[KICKCLIP-LOG] uploadStorage request error:', req.error);
      resolve(undefined);
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export async function getPrimaryHandle() {
  const db = await openDB();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const handle = await promisifyRequest(store.get(PRIMARY_KEY));
    db.close();
    return handle && typeof handle === 'object' ? /** @type {FileSystemDirectoryHandle} */ (handle) : null;
  } catch (e) {
    console.log('[KICKCLIP-LOG] getPrimaryHandle error:', e);
    try {
      db.close();
    } catch (_) {}
    return null;
  }
}

export async function setPrimaryHandle(handle) {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    await promisifyRequest(store.put(handle, PRIMARY_KEY));
    db.close();
  } catch (e) {
    console.log('[KICKCLIP-LOG] setPrimaryHandle error:', e);
    try {
      db.close();
    } catch (_) {}
  }
}

export async function clearPrimaryHandle() {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    await promisifyRequest(store.delete(PRIMARY_KEY));
    db.close();
  } catch (e) {
    console.log('[KICKCLIP-LOG] clearPrimaryHandle error:', e);
    try {
      db.close();
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────
// Destination preference (Phase U3.3)
// chrome.storage.local key: 'kc_upload_destination'
//
// Shape:
//   null                    — unconfigured (Phase U2 fallback: check IDB handle)
//   { type: 'local' }       — use IndexedDB primary handle (existing flow)
//   {
//     type: 'drive',
//     driveFolderId: string,         // kickclip_files folder ID
//     driveFolderName: string,       // 'kickclip_files'
//     driveParentFolderId: string,   // picker-selected parent
//     driveParentFolderName: string  // parent name (for UI display)
//   }
//
// Local IDB handle is preserved when switching to Drive — lets user
// revert to previous local folder without re-picking.
// ─────────────────────────────────────────────────────────────

const DESTINATION_KEY = 'kc_upload_destination';

/**
 * Get current upload destination preference.
 * @returns {Promise<{type:'local'}|{type:'drive', driveFolderId:string, driveFolderName:string, driveParentFolderId:string, driveParentFolderName:string}|null>}
 */
export async function getDestination() {
  try {
    const result = await chrome.storage.local.get(DESTINATION_KEY);
    return result[DESTINATION_KEY] || null;
  } catch (e) {
    console.log('[KICKCLIP-LOG] getDestination error:', e);
    return null;
  }
}

/**
 * Set upload destination preference.
 * @param {{type:'local'}|{type:'drive', driveFolderId:string, driveFolderName:string, driveParentFolderId:string, driveParentFolderName:string}} dest
 * @returns {Promise<boolean>} true on success
 */
export async function setDestination(dest) {
  try {
    if (!dest || !dest.type || (dest.type !== 'local' && dest.type !== 'drive')) {
      throw new Error('Invalid destination shape');
    }
    if (dest.type === 'drive') {
      if (!dest.driveFolderId || !dest.driveParentFolderId) {
        throw new Error('Drive destination missing required IDs');
      }
    }
    await chrome.storage.local.set({ [DESTINATION_KEY]: dest });
    return true;
  } catch (e) {
    console.log('[KICKCLIP-LOG] setDestination error:', e);
    return false;
  }
}

/**
 * Clear destination preference. Does NOT clear IndexedDB handle.
 */
export async function clearDestination() {
  try {
    await chrome.storage.local.remove(DESTINATION_KEY);
    return true;
  } catch (e) {
    console.log('[KICKCLIP-LOG] clearDestination error:', e);
    return false;
  }
}
