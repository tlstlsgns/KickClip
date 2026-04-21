/**
 * Firebase Initialization
 * 
 * Initializes Firebase once using Web v9 modular SDK.
 * Safe for Electron environment with getApps() check to prevent multiple initialization.
 */

import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { BRAND, FIREBASE_CONFIG, warnFirebase, logFirebase, errorFirebase } from './brandConfig.js';

/**
 * Firebase configuration from environment variables (env-first; no baked project IDs).
 * See `client/src/lib/config.ts` for the production checklist and placeholders.
 */
const firebaseConfig = FIREBASE_CONFIG;

// Validate that required config values are present
const requiredConfigKeys: (keyof typeof firebaseConfig)[] = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

const missingKeys = requiredConfigKeys.filter(
  (key) => !firebaseConfig[key] || firebaseConfig[key] === ''
);

if (missingKeys.length > 0) {
  warnFirebase(
    `Firebase: Missing configuration keys: ${missingKeys.join(', ')}. ` +
      'Set FIREBASE_* env vars to enable Firebase in this environment.'
  );
}

/**
 * Initialize Firebase app only if not already initialized
 * This prevents multiple initialization errors in Electron
 */
let app: FirebaseApp;
const existingApps = getApps();

if (existingApps.length === 0) {
  try {
    app = initializeApp(firebaseConfig);
    logFirebase(`Firebase initialized successfully (${BRAND.NAME})`);
  } catch (error) {
    errorFirebase('Firebase initialization error:', error);
    // Re-throw to prevent app from continuing with invalid Firebase state
    throw error;
  }
} else {
  // Use the existing app instance
  app = existingApps[0];
  logFirebase('Firebase already initialized, using existing app instance');
}

/**
 * Get Firebase Auth instance
 */
export const auth: Auth = getAuth(app);

/**
 * Get Firestore database instance
 */
export const db: Firestore = getFirestore(app);

/**
 * Get Firebase Storage instance
 */
export const storage: FirebaseStorage = getStorage(app);

/**
 * Export the Firebase app instance (useful for advanced use cases)
 */
export { app };


