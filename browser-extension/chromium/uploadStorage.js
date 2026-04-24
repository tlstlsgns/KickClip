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
