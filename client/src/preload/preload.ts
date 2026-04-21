/**
 * Preload Script for Dock Window
 * 
 * Exposes secure IPC APIs to the renderer process via contextBridge.
 * This ensures the renderer process cannot access Node.js APIs directly.
 */

import { contextBridge, ipcRenderer } from 'electron';

/**
 * Auth API exposed to renderer
 */
const authAPI = {
  /**
   * Sign in with Google (opens external browser)
   */
  signInWithGoogle: (): Promise<{ success: boolean; user?: { uid: string; email: string | null; displayName: string | null; photoURL: string | null }; error?: string }> =>
    ipcRenderer.invoke('auth:signInWithGoogle'),

  /**
   * Sign out current user
   */
  signOut: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('auth:signOut'),

  /**
   * Get current user
   */
  getCurrentUser: (): Promise<{ uid: string; email: string | null; displayName: string | null; photoURL: string | null } | null> =>
    ipcRenderer.invoke('auth:getCurrentUser'),

  /**
   * Listen to auth state changes
   * Returns a function to unsubscribe
   */
  onAuthStateChanged: (callback: (user: { uid: string; email: string | null; displayName: string | null; photoURL: string | null } | null) => void) => {
    const listener = (_event: any, user: { uid: string; email: string | null; displayName: string | null; photoURL: string | null } | null) => callback(user);
    ipcRenderer.on('auth:stateChanged', listener);
    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('auth:stateChanged', listener);
    };
  },
};

/**
 * Firestore API exposed to renderer
 */
const firestoreAPI = {
  /**
   * Get all data for a user
   */
  getDatasByUser: (userId: string, limit?: number): Promise<any[]> =>
    ipcRenderer.invoke('firestore:getDatasByUser', userId, limit),

  /**
   * Watch data changes for a user using real-time Firestore listeners
   * Returns a function to unsubscribe
   */
  watchDatasByUser: (userId: string, callback: (items: any[]) => void) => {
    // Set up real-time listener via IPC
    ipcRenderer.invoke('firestore:watchDatasByUser', userId);
    
    // Listen for data change events from main process
    const dataChangeListener = (_event: any, items: any[]) => {
      callback(items);
    };
    ipcRenderer.on('firestore:dataChanged', dataChangeListener);
    
    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('firestore:dataChanged', dataChangeListener);
      ipcRenderer.invoke('firestore:unwatchDatasByUser', userId);
    };
  },

  /**
   * Delete data for a user
   */
  deleteData: (dataId: string, userId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('firestore:deleteData', dataId, userId),

  /**
   * Delete all data for a user
   */
  deleteAllData: (userId: string): Promise<{ success: boolean; deletedCount?: number; error?: string }> =>
    ipcRenderer.invoke('firestore:deleteAllData', userId),

  /**
   * Create a new directory
   */
  createDirectory: (userId: string, name: string): Promise<{ success: boolean; directoryId?: string; error?: string }> =>
    ipcRenderer.invoke('firestore:createDirectory', userId, name),

  /**
   * Get all directories for a user
   */
  getDirectoriesByUser: (userId: string): Promise<any[]> =>
    ipcRenderer.invoke('firestore:getDirectoriesByUser', userId),

  /**
   * Watch directories for a user using real-time Firestore listeners
   * Returns a function to unsubscribe
   */
  watchDirectoriesByUser: (userId: string, callback: (directories: any[]) => void) => {
    // Set up real-time listener via IPC
    ipcRenderer.invoke('firestore:watchDirectoriesByUser', userId);
    
    // Listen for directory change events from main process
    const directoryChangeListener = (_event: any, directories: any[]) => {
      callback(directories);
    };
    ipcRenderer.on('firestore:directoriesChanged', directoryChangeListener);
    
    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('firestore:directoriesChanged', directoryChangeListener);
      ipcRenderer.invoke('firestore:unwatchDirectoriesByUser', userId);
    };
  },

  /**
   * Update directory name
   */
  updateDirectory: (directoryId: string, userId: string, name: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('firestore:updateDirectory', directoryId, userId, name),

  /**
   * Delete a directory
   */
  deleteDirectory: (directoryId: string, userId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('firestore:deleteDirectory', directoryId, userId),

  /**
   * Update an item's directoryId
   */
  updateItemDirectory: (itemId: string, userId: string, directoryId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('firestore:updateItemDirectory', itemId, userId, directoryId),

  /**
   * Move an item to a new position (with reordering)
   */
  moveItemToPosition: (userId: string, itemId: string, targetDirectoryId: string | null, newIndex: number, sourceDirectoryId: string | null): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('firestore:moveItemToPosition', userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId),

  /**
   * Move a directory to a new position (with reordering)
   */
  moveDirectoryToPosition: (userId: string, directoryId: string, newIndex: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('firestore:moveDirectoryToPosition', userId, directoryId, newIndex),
};

/**
 * Instagram API exposed to renderer
 */
const instagramAPI = {
  /**
   * Connect Instagram account (opens login window)
   */
  connect: (userId: string): Promise<{ success: boolean; username?: string; error?: string }> =>
    ipcRenderer.invoke('instagram:connect', userId),

  /**
   * Disconnect Instagram account
   */
  disconnect: (userId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('instagram:disconnect', userId),

  /**
   * Get Instagram connection status
   */
  getConnectionStatus: (userId: string): Promise<{ connected: boolean; username?: string; expired?: boolean; error?: string }> =>
    ipcRenderer.invoke('instagram:getConnectionStatus', userId),

  /**
   * Get Instagram session cookies (encrypted)
   */
  getSessionCookies: (userId: string): Promise<Array<{
    name: string;
    value: string; // Encrypted
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: 'strict' | 'lax' | 'no_restriction' | 'unspecified';
    expirationDate?: number;
  }> | null> =>
    ipcRenderer.invoke('instagram:getSessionCookies', userId),

  /**
   * Inject Instagram cookies into a session (for webview)
   */
  injectCookiesIntoSession: (userId: string, partition?: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('instagram:injectCookiesIntoSession', userId, partition),
};

/**
 * Dock API exposed to renderer
 */
const dockAPI = {
  /**
   * Notify main process that a new item was saved (triggers show→hide sequence)
   */
  notifyDataSaved: (): void => ipcRenderer.send('data:saved'),

  /**
   * Get dock window bounds
   */
  getBounds: (): { width: number; height: number; x: number; y: number } =>
    ipcRenderer.sendSync('dock:getBounds'),

  /**
   * Set dock window size
   */
  setSize: (size: { width: number; height: number }): void =>
    ipcRenderer.send('dock:setSize', size),

  /**
   * Get whether dock is pinned (true = fixed, false = auto-hide)
   */
  getPinned: (): Promise<boolean> => ipcRenderer.invoke('dock:getPinned'),

  /**
   * Set dock pin state (true = pin/fixed, false = unpin/auto-hide)
   */
  setPinned: (pinned: boolean): Promise<void> => ipcRenderer.invoke('dock:setPinned', pinned),

  /**
   * Show dock (when unpinned, called on mouseenter)
   */
  show: (): Promise<void> => ipcRenderer.invoke('dock:show'),

  /**
   * Hide dock (when unpinned, called after mouseleave delay)
   */
  hide: (): Promise<void> => ipcRenderer.invoke('dock:hide'),

  /**
   * Listen to pin state changes
   */
  onPinStateChanged: (callback: (pinned: boolean) => void) => {
    const listener = (_event: any, pinned: boolean) => callback(!!pinned);
    ipcRenderer.on('dock:pinStateChanged', listener);
    return () => ipcRenderer.removeListener('dock:pinStateChanged', listener);
  },
};

/**
 * Shell API exposed to renderer
 */
const shellAPI = {
  /**
   * Open URL in user's default browser
   */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url),
};

/**
 * Window API exposed to renderer
 * Always-On-Top functionality removed to prevent DnD interference
 */
const windowAPI = {
  /**
   * Set window ignore mouse events
   */
  setIgnoreMouseEvents: (ignore: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('window:setIgnoreMouseEvents', ignore),
  
  /**
   * Resize main window to a target width
   */
  resize: (width: number): Promise<{ success: boolean; width?: number; error?: string }> =>
    ipcRenderer.invoke('window:resize', width),

  disableAlwaysOnTop: (): void => ipcRenderer.send('disable-always-on-top'),
  enableAlwaysOnTop: (): void => ipcRenderer.send('enable-always-on-top'),
  onAppFocusChanged: (callback: (focused: boolean) => void) => {
    const listener = (_event: any, focused: boolean) => callback(!!focused);
    ipcRenderer.on('app:focus-changed', listener);
    return () => ipcRenderer.removeListener('app:focus-changed', listener);
  },
  
  // REMOVED: startDrag method
  // REASON: Removed from main process to prevent conflicts with standard browser DnD
  // Standard Browser DnD is more reliable for URL strings
};

/**
 * Ghost Window API for drag-and-drop visual feedback
 */
const ghostAPI = {
  /**
   * Create ghost window with card HTML content
   */
  create: (cardHtml: string, width: number, height: number, offsetX: number, offsetY: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('ghost:create', cardHtml, width, height, offsetX, offsetY),
  
  /**
   * Update ghost window position offset
   */
  updatePosition: (offsetX: number, offsetY: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('ghost:update-position', offsetX, offsetY),
  
  /**
   * Destroy ghost window
   */
  destroy: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('ghost:destroy'),
};

/**
 * Expose APIs to renderer via contextBridge
 */
contextBridge.exposeInMainWorld('electronAPI', {
  auth: authAPI,
  firestore: firestoreAPI,
  instagram: instagramAPI,
  dock: dockAPI,
  shell: shellAPI,
  window: windowAPI,
  ghost: ghostAPI,
});

/**
 * TypeScript type definitions for the exposed API
 */
export type ElectronAPI = {
  auth: typeof authAPI;
  firestore: typeof firestoreAPI;
  instagram: typeof instagramAPI;
  dock: typeof dockAPI;
  shell: typeof shellAPI;
  window: typeof windowAPI;
  ghost: typeof ghostAPI;
};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

