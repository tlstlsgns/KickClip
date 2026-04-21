/**
 * Blink - Brand + Firebase Config (Production-ready)
 *
 * Firebase Console checklist for production:
 * - Project settings: Project name + register the correct “App” (Web/Desktop) and copy config values
 * - Authentication: Authorized domains + OAuth redirect URIs (and desktop OAuth client if applicable)
 * - Authentication: Email templates (sender name/logo) and OAuth consent screen branding
 * - (Optional) Hosting: authDomain / hosting site + redirect domains
 */

export const BRAND = {
  NAME: 'Blink',
  VERSION: process.env.APP_VERSION || '1.0.0',
  KEY_COLOR: 'purple',
  KEY_COLOR_HEX: '#BC13FE',
  LOG_PREFIX: '[BLINK-LOG]',
} as const;

export const RUNTIME_ENV = (process.env.NODE_ENV === 'production' ? 'production' : 'development') as
  | 'development'
  | 'production';

function normalizeRedirectUri(u: string): string {
  // Ensure no trailing slash for strict equality with Google Cloud Console settings
  return (u || '').trim().replace(/\/+$/, '');
}

/**
 * Firebase configuration (env-first).
 *
 * Defaults are set to your current Firebase project to avoid `auth/invalid-api-key`
 * in dev when env vars are missing. For production, override via FIREBASE_* env vars.
 */
export const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyA9X_FEi9cgvFmDdEmeEvJW0msXSIrP6p0',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'saveurl-a8593.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'saveurl-a8593',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'saveurl-a8593.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '658386350246',
  appId: process.env.FIREBASE_APP_ID || '1:658386350246:web:ee80b8dcae26d2e4298467',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-3CWFLRKTVR',
} as const;

/**
 * OAuth/Redirect configuration (env-first) for future production readiness.
 */
const RESOLVED_OAUTH_PORT = Number(process.env.OAUTH_CALLBACK_PORT || 3004);
const DEFAULT_REDIRECT_URI = `http://localhost:${RESOLVED_OAUTH_PORT}`;
export const AUTH_CONFIG = {
  // Strictly prioritize env var; default to 3004 if missing.
  OAUTH_CALLBACK_PORT: RESOLVED_OAUTH_PORT,
  // Highest priority: explicit OAUTH_REDIRECT_URI, otherwise derive from resolved port.
  // Ensure no trailing slash to match Google Cloud Console settings.
  REDIRECT_URI: normalizeRedirectUri(process.env.OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI),
  AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN || FIREBASE_CONFIG.authDomain,
  ENV: RUNTIME_ENV,
} as const;

export function logFirebase(...args: any[]) {
  // eslint-disable-next-line no-console
  console.log(BRAND.LOG_PREFIX, ...args);
}

export function warnFirebase(...args: any[]) {
  // eslint-disable-next-line no-console
  console.warn(BRAND.LOG_PREFIX, ...args);
}

export function errorFirebase(...args: any[]) {
  // eslint-disable-next-line no-console
  console.error(BRAND.LOG_PREFIX, ...args);
}

