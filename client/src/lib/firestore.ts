/**
 * Firestore Utility Layer
 * 
 * Provides typed helpers for Firestore operations.
 * These functions are designed to be used in the Electron main process
 * and exposed to renderer via IPC for security.
 */

import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  QueryConstraint,
  CollectionReference,
  DocumentReference,
  DocumentData,
  Timestamp,
  Unsubscribe,
  QueryDocumentSnapshot,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase.js';
import { BRAND, logFirebase, errorFirebase } from './brandConfig.js';

/**
 * Data structure for saved URLs/items
 */
export interface SavedItemData extends DocumentData {
  id?: string; // Document ID (optional, added when fetching)
  url: string;
  title: string;
  createdAt: number;
  domain?: string;
  type?: string;
  img_url?: string;
  thumbnail?: string; // Thumbnail URL (for instagram_post and other types)
  saved_by?: string;
  /**
   * App attribution (brand/version), separated from `saved_by` (which is used as a source marker: extension/global).
   */
  saved_by_app?: string;
  app_version?: string;
  save_source?: string;
  userId: string; // User ID who owns this item
  directoryId?: string; // Directory ID (default: "undefined" for items not in a directory)
  order?: number; // Order index for sorting within a directory or main list
}

/**
 * Directory data structure
 */
export interface DirectoryData extends DocumentData {
  id?: string; // Document ID (optional, added when fetching)
  name: string;
  createdAt: number;
  userId: string; // User ID who owns this directory
  order?: number; // Order index for sorting within the directory list
}

/**
 * Get a document reference
 */
function getDocRef(collectionPath: string, documentId: string): DocumentReference {
  return doc(db, collectionPath, documentId);
}

/**
 * Get a collection reference
 */
function getCollectionRef(collectionPath: string): CollectionReference {
  return collection(db, collectionPath);
}

/**
 * Save new data to Firestore
 * 
 * @param userId - The user ID who owns this data
 * @param data - The data to save (userId will be added automatically)
 * @returns The document ID of the created document
 */
export async function saveData(
  userId: string,
  data: Omit<SavedItemData, 'userId' | 'id'>
): Promise<string> {
  try {
    // Create a document reference with auto-generated ID
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const newDocRef = doc(itemsRef);
    
    // Prepare data with userId and createdAt
    const itemData: SavedItemData = {
      ...data,
      userId,
      createdAt: data.createdAt || Date.now(),
      // Production-ready attribution (does not break existing saved_by logic).
      saved_by_app: (data as any).saved_by_app || BRAND.NAME,
      app_version: (data as any).app_version || BRAND.VERSION,
      save_source: (data as any).save_source || (data as any).saved_by || 'unknown',
    } as SavedItemData;
    
    // Set the document
    await setDoc(newDocRef, itemData);
    
    logFirebase('Firestore: Data added successfully with ID:', newDocRef.id);
    return newDocRef.id;
  } catch (error) {
    errorFirebase('Firestore: Error adding data:', error);
    throw error;
  }
}

/**
 * Update existing data in Firestore
 * 
 * @param dataId - The document ID to update
 * @param userId - The user ID who owns this data
 * @param data - Partial data to update
 */
export async function updateData(
  dataId: string,
  userId: string,
  data: Partial<Omit<SavedItemData, 'userId' | 'id'>>
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/items`, dataId);
    
    // Check if document exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Document with ID ${dataId} does not exist for user ${userId}`);
    }
    
    // Update the document
    await updateDoc(docRef, data);
    console.log('Firestore: Data updated successfully:', dataId);
  } catch (error) {
    console.error('Firestore: Error updating data:', error);
    throw error;
  }
}

/**
 * Delete data from Firestore
 * 
 * @param dataId - The document ID to delete
 * @param userId - The user ID who owns this data
 */
export async function deleteData(
  dataId: string,
  userId: string
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/items`, dataId);
    
    // Check if document exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Document with ID ${dataId} does not exist for user ${userId}`);
    }
    
    // Delete the document
    await deleteDoc(docRef);
    console.log('Firestore: Data deleted successfully:', dataId);
  } catch (error) {
    console.error('Firestore: Error deleting data:', error);
    throw error;
  }
}

/**
 * Delete all data items for a specific user
 * 
 * @param userId - The user ID who owns the data
 * @returns Number of items deleted
 */
export async function deleteAllData(userId: string): Promise<number> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const querySnapshot = await getDocs(itemsRef);
    
    const deletePromises: Promise<void>[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      deletePromises.push(deleteDoc(doc.ref));
    });
    
    await Promise.all(deletePromises);
    const deletedCount = deletePromises.length;
    console.log(`Firestore: Deleted ${deletedCount} items for user:`, userId);
    return deletedCount;
  } catch (error) {
    console.error('Firestore: Error deleting all data:', error);
    throw error;
  }
}

/**
 * Watch all data items for a specific user
 * Returns a real-time listener that calls the callback whenever data changes
 * 
 * @param userId - The user ID to watch data for
 * @param callback - Function called with array of items whenever data changes
 * @returns Unsubscribe function to stop listening
 */
export function watchDatasByUser(
  userId: string,
  callback: (items: SavedItemData[]) => void
): Unsubscribe {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    
    // Create a query ordered by createdAt (newest first)
    const q = query(itemsRef, orderBy('createdAt', 'desc'));
    
    // Set up real-time listener
    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const items: SavedItemData[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
          const data = doc.data() as SavedItemData;
          // Include document ID in the data
          items.push({
            ...data,
            id: doc.id,
          });
        });
        callback(items);
      },
      (error) => {
        console.error('Firestore: Error in watchDatasByUser:', error);
        // Call callback with empty array on error to prevent UI from breaking
        callback([]);
      }
    );
    
    console.log('Firestore: Started watching data for user:', userId);
    return unsubscribe;
  } catch (error) {
    console.error('Firestore: Error setting up watchDatasByUser:', error);
    // Return a no-op unsubscribe function if setup fails
    return () => {};
  }
}

/**
 * Gets the minimum order value among all items for a user.
 * Used to prepend a new item at the top without shifting existing items.
 * Returns 0 if no items exist.
 */
export async function getMinItemOrder(userId: string): Promise<number> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const q = query(itemsRef, orderBy('order', 'asc'), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return 0;
    const minOrder = snap.docs[0].data().order ?? 0;
    return typeof minOrder === 'number' ? minOrder : 0;
  } catch {
    return 0;
  }
}

/**
 * Get all data items for a specific user (one-time fetch)
 * 
 * @param userId - The user ID to fetch data for
 * @param limitCount - Optional limit on number of items to fetch
 * @returns Array of items
 */
export async function getDatasByUser(
  userId: string,
  limitCount?: number
): Promise<SavedItemData[]> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    
    // Build query constraints
    const constraints: QueryConstraint[] = [orderBy('createdAt', 'desc')];
    if (limitCount && limitCount > 0) {
      constraints.push(limit(limitCount));
    }
    
    const q = query(itemsRef, ...constraints);
    const querySnapshot = await getDocs(q);
    
    const items: SavedItemData[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      const data = doc.data() as SavedItemData;
      items.push({
        ...data,
        id: doc.id,
      });
    });
    
    console.log(`Firestore: Fetched ${items.length} items for user:`, userId);
    return items;
  } catch (error) {
    console.error('Firestore: Error getting data for user:', error);
    throw error;
  }
}

/**
 * Instagram Session Data structure
 */
export interface InstagramSessionData extends DocumentData {
  userId: string;
  instagramUsername: string;
  cookies: Array<{
    name: string;
    value: string; // Encrypted
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: 'strict' | 'lax' | 'no_restriction' | 'unspecified';
    expirationDate?: number;
  }>;
  oauthAccessToken?: string; // Optional, for verification
  oauthTokenExpiresAt?: number;
  connectedAt: number;
  expiresAt?: number; // Estimated cookie expiration
}

/**
 * Save Instagram session data to Firestore
 * 
 * @param userId - The user ID who owns this Instagram session
 * @param sessionData - The Instagram session data to save
 * @returns The document ID of the saved session
 */
export async function saveInstagramSession(
  userId: string,
  sessionData: Omit<InstagramSessionData, 'userId'>
): Promise<string> {
  try {
    // Use a fixed document ID to ensure only one session per user
    const sessionRef = doc(getCollectionRef(`users/${userId}/instagramSession`), 'session');
    
    // Build data object, excluding undefined values (Firestore doesn't allow undefined)
    const data: InstagramSessionData = {
      userId,
      instagramUsername: sessionData.instagramUsername,
      cookies: sessionData.cookies,
      connectedAt: sessionData.connectedAt,
    };
    
    // Only include optional fields if they have values
    if (sessionData.expiresAt !== undefined) {
      data.expiresAt = sessionData.expiresAt;
    }
    if (sessionData.oauthAccessToken !== undefined) {
      data.oauthAccessToken = sessionData.oauthAccessToken;
    }
    if (sessionData.oauthTokenExpiresAt !== undefined) {
      data.oauthTokenExpiresAt = sessionData.oauthTokenExpiresAt;
    }
    
    await setDoc(sessionRef, data, { merge: false }); // Use setDoc without merge to replace entirely
    console.log('Firestore: Instagram session saved successfully for user:', userId, 'username:', sessionData.instagramUsername);
    return 'session';
  } catch (error) {
    console.error('Firestore: Error saving Instagram session:', error);
    throw error;
  }
}

/**
 * Get Instagram session data for a user
 * 
 * @param userId - The user ID
 * @returns Instagram session data or null if not found
 */
export async function getInstagramSession(userId: string): Promise<InstagramSessionData | null> {
  try {
    // Use fixed document ID to get the session
    const sessionRef = doc(getCollectionRef(`users/${userId}/instagramSession`), 'session');
    const docSnap = await getDoc(sessionRef);
    
    if (!docSnap.exists()) {
      return null;
    }
    
    const data = docSnap.data() as InstagramSessionData;
    return {
      ...data,
      id: docSnap.id,
    };
  } catch (error) {
    console.error('Firestore: Error getting Instagram session:', error);
    throw error;
  }
}

/**
 * Delete Instagram session data for a user
 * 
 * @param userId - The user ID
 */
export async function deleteInstagramSession(userId: string): Promise<void> {
  try {
    // Use fixed document ID to delete the session
    const sessionRef = doc(getCollectionRef(`users/${userId}/instagramSession`), 'session');
    await deleteDoc(sessionRef);
    
    console.log('Firestore: Instagram session deleted successfully for user:', userId);
  } catch (error) {
    console.error('Firestore: Error deleting Instagram session:', error);
    throw error;
  }
}

/**
 * Directory data structure
 */
export interface DirectoryData extends DocumentData {
  id?: string; // Document ID (optional, added when fetching)
  name: string;
  createdAt: number;
  userId: string; // User ID who owns this directory
  order?: number; // Order index for sorting within the directory list
}

/**
 * Create a new directory
 * 
 * @param userId - The user ID who owns this directory
 * @param name - The directory name
 * @returns The document ID of the created directory
 */
export async function createDirectory(
  userId: string,
  name: string
): Promise<string> {
  try {
    const collectionPath = `users/${userId}/directories`;
    console.log('[Directory Debug] Firestore: Creating directory at path:', collectionPath);
    console.log('[Directory Debug] Firestore: User ID being used:', userId);
    
    const directoriesRef = getCollectionRef(collectionPath);
    const newDocRef = doc(directoriesRef);
    
    const directoryData: DirectoryData = {
      name: name.trim(),
      createdAt: Date.now(),
      userId,
    };
    
    console.log('[Directory Debug] Firestore: Directory data payload:', directoryData);
    console.log('[Directory Debug] Firestore: Full document path will be:', `users/${userId}/directories/${newDocRef.id}`);
    
    await setDoc(newDocRef, directoryData);
    console.log('[Directory] Created:', name, 'with ID:', newDocRef.id);
    console.log('Firestore: Directory created successfully with ID:', newDocRef.id);
    return newDocRef.id;
  } catch (error: any) {
    console.error('Firestore: Error creating directory:', error);
    console.error('Firestore: Error code:', error.code);
    console.error('Firestore: Error message:', error.message);
    if (error.code === 'permission-denied' || error.code === 7) {
      console.error('[Directory Debug] PERMISSION_DENIED - Check Firestore Security Rules for: users/{userId}/directories');
      console.error('[Directory Debug] Ensure the authenticated user UID matches the userId in the path');
    }
    throw error;
  }
}

/**
 * Get all directories for a user
 * 
 * @param userId - The user ID
 * @returns Array of directories
 */
export async function getDirectoriesByUser(userId: string): Promise<DirectoryData[]> {
  try {
    const directoriesRef = getCollectionRef(`users/${userId}/directories`);
    const q = query(directoriesRef, orderBy('createdAt', 'asc'));
    const querySnapshot = await getDocs(q);
    
    const directories: DirectoryData[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      const data = doc.data() as DirectoryData;
      directories.push({
        ...data,
        id: doc.id,
      });
    });
    
    console.log(`Firestore: Fetched ${directories.length} directories for user:`, userId);
    return directories;
  } catch (error) {
    console.error('Firestore: Error getting directories for user:', error);
    throw error;
  }
}

/**
 * Watch directories for a user (real-time listener)
 * 
 * @param userId - The user ID
 * @param callback - Function called with array of directories whenever data changes
 * @returns Unsubscribe function to stop listening
 */
export function watchDirectoriesByUser(
  userId: string,
  callback: (directories: DirectoryData[]) => void
): Unsubscribe {
  try {
    const directoriesRef = getCollectionRef(`users/${userId}/directories`);
    const q = query(directoriesRef, orderBy('createdAt', 'asc'));
    
    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const directories: DirectoryData[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
          const data = doc.data() as DirectoryData;
          directories.push({
            ...data,
            id: doc.id,
          });
        });
        callback(directories);
      },
      (error) => {
        console.error('Firestore: Error in watchDirectoriesByUser:', error);
        callback([]);
      }
    );
    
    console.log('Firestore: Started watching directories for user:', userId);
    return unsubscribe;
  } catch (error) {
    console.error('Firestore: Error setting up watchDirectoriesByUser:', error);
    return () => {};
  }
}

/**
 * Update directory name
 * 
 * @param directoryId - The directory document ID
 * @param userId - The user ID who owns this directory
 * @param name - The new directory name
 */
export async function updateDirectory(
  directoryId: string,
  userId: string,
  name: string
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/directories`, directoryId);
    
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Directory with ID ${directoryId} does not exist for user ${userId}`);
    }
    
    await updateDoc(docRef, { name: name.trim() });
    console.log('Firestore: Directory updated successfully:', directoryId);
  } catch (error) {
    console.error('Firestore: Error updating directory:', error);
    throw error;
  }
}

/**
 * Delete a directory and update all associated items to have directoryId = "undefined"
 * 
 * @param directoryId - The directory document ID to delete
 * @param userId - The user ID who owns this directory
 */
export async function deleteDirectory(
  directoryId: string,
  userId: string
): Promise<void> {
  try {
    // First, update all items in this directory to have directoryId = "undefined"
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    const q = query(itemsRef, where('directoryId', '==', directoryId));
    const querySnapshot = await getDocs(q);
    
    const updatePromises: Promise<void>[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
      const itemRef = doc.ref;
      updatePromises.push(updateDoc(itemRef, { directoryId: 'undefined' }));
    });
    
    await Promise.all(updatePromises);
    console.log(`Firestore: Updated ${updatePromises.length} items to remove directory reference`);
    
    // Then delete the directory document
    const directoryRef = getDocRef(`users/${userId}/directories`, directoryId);
    await deleteDoc(directoryRef);
    
    console.log('Firestore: Directory deleted successfully:', directoryId);
  } catch (error) {
    console.error('Firestore: Error deleting directory:', error);
    throw error;
  }
}

/**
 * Update an item's directoryId
 * 
 * @param itemId - The item document ID
 * @param userId - The user ID who owns this item
 * @param directoryId - The directory ID (or "undefined" to remove from directory)
 */
export async function updateItemDirectory(
  itemId: string,
  userId: string,
  directoryId: string
): Promise<void> {
  try {
    const docRef = getDocRef(`users/${userId}/items`, itemId);
    
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Item with ID ${itemId} does not exist for user ${userId}`);
    }
    
    await updateDoc(docRef, { directoryId });
    console.log(`Firestore: Item ${itemId} moved to directory ${directoryId}`);
  } catch (error) {
    console.error('Firestore: Error updating item directory:', error);
    throw error;
  }
}

/**
 * Move an item to a new position within a directory or main list
 * Uses batched writes to ensure atomicity when reordering multiple items
 * 
 * @param userId - The user ID who owns the items
 * @param itemId - The item document ID to move
 * @param targetDirectoryId - The target directory ID (or null for main list)
 * @param newIndex - The new index position (0-based)
 * @param sourceDirectoryId - The source directory ID (or null for main list)
 * @returns Promise that resolves when the move is complete
 */
export async function moveItemToPosition(
  userId: string,
  itemId: string,
  targetDirectoryId: string | null,
  newIndex: number,
  sourceDirectoryId: string | null
): Promise<void> {
  try {
    const itemsRef = getCollectionRef(`users/${userId}/items`);
    
    // Determine the directory filter (null = main list, "undefined" = main list in Firestore)
    const targetDirFilter = targetDirectoryId === null ? 'undefined' : targetDirectoryId;
    const sourceDirFilter = sourceDirectoryId === null ? 'undefined' : sourceDirectoryId;
    
    // Get all items in the target directory/list
    // Try to query with order field first, fallback to createdAt if order doesn't exist
    let targetItems: QueryDocumentSnapshot[];
    let usingOrderField = true;
    try {
      // First, try with order field
      const targetQuery = query(
        itemsRef,
        where('directoryId', '==', targetDirFilter),
        orderBy('order', 'asc')
      );
      const targetSnapshot = await getDocs(targetQuery);
      targetItems = targetSnapshot.docs;
    } catch (error: any) {
      // If orderBy fails (no index or field doesn't exist), fallback to createdAt
      if (error.code === 'failed-precondition' || error.code === 'invalid-argument') {
        usingOrderField = false;
        const fallbackQuery = query(
          itemsRef,
          where('directoryId', '==', targetDirFilter),
          orderBy('createdAt', 'desc')
        );
        const fallbackSnapshot = await getDocs(fallbackQuery);
        targetItems = fallbackSnapshot.docs;
      } else {
        throw error;
      }
    }
    
    // Get the dragged item
    const draggedItemRef = getDocRef(`users/${userId}/items`, itemId);
    const draggedItemDoc = await getDoc(draggedItemRef);
    
    if (!draggedItemDoc.exists()) {
      throw new Error(`Item with ID ${itemId} does not exist for user ${userId}`);
    }
    
    const draggedItemData = draggedItemDoc.data();
    
    // Log old orders for debugging
    const oldOrders = targetItems.map(doc => {
      const data = doc.data();
      return { id: doc.id, order: data.order ?? 'missing', createdAt: data.createdAt };
    });
    console.log(`[DnD] Moving item ${itemId} to index ${newIndex}`);
    console.log(`[DnD] Old orders:`, oldOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Build a new array with the dragged item inserted at the correct position
    const isSameContainer = sourceDirFilter === targetDirFilter;
    let finalItems: Array<{ id: string; ref: DocumentReference; data: any }> = [];
    
    if (isSameContainer) {
      // Moving within the same container
      // Create array without the dragged item
      const itemsWithoutDragged = targetItems
        .filter(doc => doc.id !== itemId)
        .map(doc => ({
          id: doc.id,
          ref: doc.ref,
          data: doc.data()
        }));
      
      // Insert dragged item at newIndex
      finalItems = [
        ...itemsWithoutDragged.slice(0, newIndex),
        {
          id: itemId,
          ref: draggedItemRef,
          data: draggedItemData
        },
        ...itemsWithoutDragged.slice(newIndex)
      ];
    } else {
      // Moving between containers
      // Target items don't include the dragged item
      const targetItemsArray = targetItems.map(doc => ({
        id: doc.id,
        ref: doc.ref,
        data: doc.data()
      }));
      
      // Insert dragged item at newIndex
      finalItems = [
        ...targetItemsArray.slice(0, newIndex),
        {
          id: itemId,
          ref: draggedItemRef,
          data: draggedItemData
        },
        ...targetItemsArray.slice(newIndex)
      ];
    }
    
    // Re-assign incremental order values (0, 1, 2, 3...) to the entire array
    // This guarantees no duplicate or skipped order values
    const newOrders = finalItems.map((item, index) => ({
      id: item.id,
      ref: item.ref,
      order: index
    }));
    
    // Log new orders for debugging
    console.log(`[DnD] New orders:`, newOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Create batch for atomic updates
    const batch = writeBatch(db);
    
    // Update directoryId if moving between containers
    if (sourceDirFilter !== targetDirFilter) {
      batch.update(draggedItemRef, { directoryId: targetDirFilter });
    }
    
    // Update all items with their new order values
    newOrders.forEach(({ ref, order }) => {
      batch.update(ref, { order });
    });
    
    // Commit the batch
    await batch.commit();
    
    console.log(`[DnD] ✅ Successfully moved item ${itemId} to position ${newIndex} in ${targetDirFilter === 'undefined' ? 'main list' : `directory ${targetDirFilter}`}`);
  } catch (error) {
    console.error('[DnD] ❌ Error moving item to position:', error);
    throw error;
  }
}

/**
 * Move a directory to a new position within the directory list
 * Uses batched writes to ensure atomicity when reordering multiple directories
 * 
 * @param userId - The user ID who owns the directories
 * @param directoryId - The directory document ID to move
 * @param newIndex - The new index position (0-based)
 * @returns Promise that resolves when the move is complete
 */
export async function moveDirectoryToPosition(
  userId: string,
  directoryId: string,
  newIndex: number
): Promise<void> {
  try {
    const directoriesRef = getCollectionRef(`users/${userId}/directories`);
    
    // Get all directories ordered by order field (or createdAt if order doesn't exist)
    let directories: QueryDocumentSnapshot[];
    try {
      const directoriesQuery = query(
        directoriesRef,
        orderBy('order', 'asc')
      );
      const directoriesSnapshot = await getDocs(directoriesQuery);
      directories = directoriesSnapshot.docs;
    } catch (error: any) {
      // If orderBy fails (no index or field doesn't exist), fallback to createdAt
      if (error.code === 'failed-precondition' || error.code === 'invalid-argument') {
        const fallbackQuery = query(
          directoriesRef,
          orderBy('createdAt', 'asc')
        );
        const fallbackSnapshot = await getDocs(fallbackQuery);
        directories = fallbackSnapshot.docs;
      } else {
        throw error;
      }
    }
    
    // Get the dragged directory
    const draggedDirectoryRef = getDocRef(`users/${userId}/directories`, directoryId);
    const draggedDirectoryDoc = await getDoc(draggedDirectoryRef);
    
    if (!draggedDirectoryDoc.exists()) {
      throw new Error(`Directory with ID ${directoryId} does not exist for user ${userId}`);
    }
    
    const draggedDirectoryData = draggedDirectoryDoc.data();
    
    // Log old orders for debugging
    const oldOrders = directories.map(doc => {
      const data = doc.data();
      return { id: doc.id, order: data.order ?? 'missing', createdAt: data.createdAt };
    });
    console.log(`[DnD] Moving directory ${directoryId} to index ${newIndex}`);
    console.log(`[DnD] Old orders:`, oldOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Build a new array with the dragged directory inserted at the correct position
    // Create array without the dragged directory
    const directoriesWithoutDragged = directories
      .filter(doc => doc.id !== directoryId)
      .map(doc => ({
        id: doc.id,
        ref: doc.ref,
        data: doc.data()
      }));
    
    // Insert dragged directory at newIndex
    const finalDirectories = [
      ...directoriesWithoutDragged.slice(0, newIndex),
      {
        id: directoryId,
        ref: draggedDirectoryRef,
        data: draggedDirectoryData
      },
      ...directoriesWithoutDragged.slice(newIndex)
    ];
    
    // Re-assign incremental order values (0, 1, 2, 3...) to the entire array
    // This guarantees no duplicate or skipped order values
    const newOrders = finalDirectories.map((dir, index) => ({
      id: dir.id,
      ref: dir.ref,
      order: index
    }));
    
    // Log new orders for debugging
    console.log(`[DnD] New orders:`, newOrders.map(o => `${o.id}:${o.order}`).join(', '));
    
    // Create batch for atomic updates
    const batch = writeBatch(db);
    
    // Update all directories with their new order values
    newOrders.forEach(({ ref, order }) => {
      batch.update(ref, { order });
    });
    
    // Commit the batch
    await batch.commit();
    
    console.log(`[DnD] ✅ Successfully moved directory ${directoryId} to position ${newIndex}`);
  } catch (error) {
    console.error('[DnD] ❌ Error moving directory to position:', error);
    throw error;
  }
}

