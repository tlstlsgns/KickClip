/**
 * Firebase Auth Helper Functions
 * 
 * Handles Firebase authentication operations in the main process.
 * These functions are called via IPC from the renderer process.
 */

import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut as firebaseSignOut,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  User,
  Auth,
} from 'firebase/auth';
import { auth } from '../../lib/firebase';

/**
 * Sign in with Google OAuth
 * In Electron, we use signInWithPopup which opens a popup window
 */
export async function signInWithGoogle(): Promise<{ success: boolean; user?: any; error?: string }> {
  try {
    const provider = new GoogleAuthProvider();
    // Request additional scopes if needed
    provider.addScope('email');
    provider.addScope('profile');
    
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    
    // Convert Firebase User to plain object for IPC
    const userData = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      emailVerified: user.emailVerified,
    };
    
    console.log('Firebase Auth: Signed in with Google:', userData.email);
    return { success: true, user: userData };
  } catch (error: any) {
    console.error('Firebase Auth: Error signing in with Google:', error);
    return { 
      success: false, 
      error: error.message || 'Failed to sign in with Google' 
    };
  }
}

/**
 * Sign out the current user
 */
export async function signOut(): Promise<{ success: boolean; error?: string }> {
  try {
    await firebaseSignOut(auth);
    console.log('Firebase Auth: Signed out successfully');
    return { success: true };
  } catch (error: any) {
    console.error('Firebase Auth: Error signing out:', error);
    return { 
      success: false, 
      error: error.message || 'Failed to sign out' 
    };
  }
}

/**
 * Get current user
 */
export async function getCurrentUser(): Promise<any | null> {
  try {
    const user = auth.currentUser;
    if (!user) {
      return null;
    }
    
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      emailVerified: user.emailVerified,
    };
  } catch (error) {
    console.error('Firebase Auth: Error getting current user:', error);
    return null;
  }
}

/**
 * Set up auth state listener
 * Calls the callback whenever auth state changes
 * Returns unsubscribe function
 */
export function onAuthStateChanged(
  callback: (user: any) => void
): () => void {
  return firebaseOnAuthStateChanged(auth, (user: User | null) => {
    if (user) {
      const userData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        emailVerified: user.emailVerified,
      };
      callback(userData);
    } else {
      callback(null);
    }
  });
}

