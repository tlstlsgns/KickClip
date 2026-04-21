/**
 * Blink Brand Config (Extension)
 * Single source of truth for branding in the browser extension codebase.
 */
export const BRAND = {
  NAME: 'Blink',
  VERSION: '1.0.0',
  KEY_COLOR: 'purple',
  KEY_COLOR_HEX: '#BC13FE',
  LOG_PREFIX: '[BLINK-LOG]',
};

const DEV_FIREBASE_CONFIG = {
  apiKey: "AIzaSyA9X_FEi9cgvFmDdEmeEvJW0msXSIrP6p0",
  authDomain: "saveurl-a8593.firebaseapp.com",
  projectId: "saveurl-a8593",
  storageBucket: "saveurl-a8593.firebasestorage.app",
  messagingSenderId: "658386350246",
  appId: "1:658386350246:web:ee80b8dcae26d2e4298467",
  measurementId: "G-3CWFLRKTVR"
};

const PROD_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBclUz3i_1dOk20KxzPaQHs07TOSPjSBz0",
  authDomain: "saveurl-prod.firebaseapp.com",
  projectId: "saveurl-prod",
  storageBucket: "saveurl-prod.firebasestorage.app",
  messagingSenderId: "108278020684",
  appId: "1:108278020684:web:5171c68256f59c53ccd2e9",
  measurementId: "G-6HW4SW65N0"
};

export const FIREBASE_CONFIG = KC_IS_DEV ? DEV_FIREBASE_CONFIG : PROD_FIREBASE_CONFIG;