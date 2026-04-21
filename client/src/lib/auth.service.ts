/**
 * Firebase Auth Service
 * 
 * Handles authentication in the main process.
 * Uses OAuth 2.0 Authorization Code flow with PKCE.
 * Uses http://localhost callback server to receive OAuth callback.
 * Aligns with current Google OAuth and OAuth 2.1 recommendations.
 */

import { 
  signInWithCredential,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  User,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  Unsubscribe,
} from 'firebase/auth';
import { auth } from './firebase.js';
import { BRAND, AUTH_CONFIG, logFirebase, errorFirebase } from './brandConfig.js';
import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import { URL } from 'url';

// Google OAuth configuration
// Use Desktop App Client ID from Google Cloud Console
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '708660683174-dk1maoouohahc4s15d953vq4mgtb4ovn.apps.googleusercontent.com';
// Client Secret for Desktop App (required for token exchange, even with PKCE)
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

// OAuth callback server configuration (env-first for production readiness)
const OAUTH_CALLBACK_PORT = AUTH_CONFIG.OAUTH_CALLBACK_PORT;
const REDIRECT_URI = AUTH_CONFIG.REDIRECT_URI;

// OAuth callback server
let oauthServer: http.Server | null = null;

// Store pending auth promise resolver and PKCE verifier
let pendingAuthResolver: ((value: { success: boolean; user?: any; error?: string }) => void) | null = null;
let pendingCodeVerifier: string | null = null;

/**
 * Generate PKCE code verifier and challenge
 * PKCE is required for OAuth 2.1 security recommendations
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // Generate random code verifier (43-128 characters, URL-safe)
  const codeVerifier = randomBytes(32).toString('base64url');
  
  // Generate code challenge (SHA256 hash of verifier, base64url encoded)
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  
  return { codeVerifier, codeChallenge };
}

/**
 * Start OAuth callback server to receive authorization code
 */
function startOAuthServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Close existing server if running
    if (oauthServer) {
      oauthServer.close();
      oauthServer = null;
    }
    
    const timeout = setTimeout(() => {
      if (oauthServer) {
        oauthServer.close();
        oauthServer = null;
      }
      reject(new Error('OAuth timeout - no response received'));
    }, 5 * 60 * 1000); // 5 minute timeout
    
    oauthServer = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      
      const url = new URL(req.url, `http://localhost:${OAUTH_CALLBACK_PORT}`);
      
      // Support both legacy `/callback` and root `/` depending on configured redirect URI.
      if (url.pathname === '/callback' || url.pathname === '/') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');
        
        clearTimeout(timeout);
        
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>${BRAND.NAME} - Authentication Error</title></head>
              <body style="font-family: system-ui; text-align: center; padding: 40px;">
                <h1>❌ Authentication Error</h1>
                <p>Error: ${error}</p>
                <p>You can close this window.</p>
                <script>setTimeout(() => window.close(), 3000);</script>
              </body>
            </html>
          `);
          reject(new Error(`OAuth error: ${error}`));
          if (oauthServer) {
            oauthServer.close();
            oauthServer = null;
          }
          return;
        }
        
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head>
                <title>${BRAND.NAME} - Authentication Successful</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              </head>
              <body style="
                margin: 0;
                min-height: 100vh;
                display: grid;
                place-items: center;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                background: linear-gradient(135deg, ${BRAND.KEY_COLOR_HEX}22, #ffffff 60%);
                color: #111827;
              ">
                <div style="
                  width: min(520px, calc(100vw - 32px));
                  background: rgba(255,255,255,0.9);
                  border: 1px solid ${BRAND.KEY_COLOR_HEX}33;
                  border-radius: 14px;
                  padding: 28px 22px;
                  box-shadow: 0 10px 30px rgba(0,0,0,0.12);
                  text-align: center;
                ">
                  <div style="
                    width: 54px; height: 54px;
                    margin: 0 auto 14px;
                    border-radius: 14px;
                    display: grid; place-items: center;
                    background: ${BRAND.KEY_COLOR_HEX};
                    color: white;
                    font-weight: 700;
                  ">✓</div>
                  <h1 style="margin: 0 0 10px; font-size: 20px;">
                    ${BRAND.NAME} Authentication Successful
                  </h1>
                  <p style="margin: 0 0 14px; color: #374151; line-height: 1.5;">
                    You can close this tab and return to the app.
                  </p>
                  <p style="margin: 0; font-size: 12px; color: #6b7280;">
                    This window will close automatically.
                  </p>
                </div>
                <script>setTimeout(() => window.close(), 2000);</script>
              </body>
            </html>
          `);
          resolve(code);
          if (oauthServer) {
            oauthServer.close();
            oauthServer = null;
          }
        } else {
          res.writeHead(400);
          res.end('No authorization code received');
          reject(new Error('No authorization code received'));
          if (oauthServer) {
            oauthServer.close();
            oauthServer = null;
          }
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    
    oauthServer.listen(OAUTH_CALLBACK_PORT, 'localhost', () => {
      logFirebase(`OAuth callback server listening on port ${OAUTH_CALLBACK_PORT}`);
    });
    
    oauthServer.on('error', (err: any) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        errorFirebase(`OAuth server failed to start: port ${OAUTH_CALLBACK_PORT} is already in use.`);
        reject(new Error(`Port ${OAUTH_CALLBACK_PORT} is already in use. Please close the application using this port.`));
      } else {
        errorFirebase('OAuth server failed to start:', err);
        reject(err);
      }
      if (oauthServer) {
        oauthServer.close();
        oauthServer = null;
      }
    });
  });
}

/**
 * Stop OAuth callback server
 */
function stopOAuthServer(): void {
  if (oauthServer) {
    oauthServer.close();
    oauthServer = null;
    logFirebase('OAuth callback server stopped');
  }
}

/**
 * Handle authorization code - exchange for id_token and sign in with Firebase
 * Uses PKCE code verifier for security (OAuth 2.1 recommendation)
 */
async function handleAuthorizationCode(
  code: string,
  codeVerifier: string,
  resolve: (value: { success: boolean; user?: any; error?: string }) => void
) {
  try {
    console.log('Exchanging authorization code for id_token...');
    
    // Exchange authorization code for tokens using PKCE
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code: code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier, // PKCE code verifier
      }),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', errorText);
      resolve({
        success: false,
        error: `Token exchange failed: ${errorText}`,
      });
      return;
    }
    
    const tokenData = await tokenResponse.json();
    
    // Get id_token from response
    const idToken = tokenData.id_token;
    
    if (!idToken) {
      console.error('No id_token in token response:', tokenData);
      resolve({
        success: false,
        error: 'No id_token received from Google',
      });
      return;
    }
    
    logFirebase('Obtained id_token, signing in with Firebase...');
    
    // Create Firebase credential from id_token
    // Firebase handles all validation internally
    const credential = GoogleAuthProvider.credential(idToken);
    
    // Sign in with Firebase
    const userCredential = await signInWithCredential(auth, credential);
    
    const user = userCredential.user;
    
    logFirebase('Successfully signed in with Firebase');
    resolve({
      success: true,
      user: {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      },
    });
  } catch (error: any) {
    errorFirebase('Error handling authorization code:', error);
    resolve({
      success: false,
      error: error.message || 'Failed to complete authentication',
    });
  }
}

/**
 * Sign in with Google using Authorization Code flow with PKCE
 * Opens Google OAuth consent page in external browser using shell.openExternal
 * Uses localhost callback server to receive OAuth callback
 */
export async function signInWithGoogle(shellModule: typeof import('electron').shell): Promise<{ success: boolean; user?: any; error?: string }> {
  return new Promise((resolve) => {
    try {
      console.log('Starting Google Sign-In with Authorization Code flow (PKCE)...');
      
      // Check if there's already a pending auth
      if (pendingAuthResolver) {
        resolve({
          success: false,
          error: 'Authentication already in progress',
        });
        return;
      }
      
      pendingAuthResolver = resolve;
      
      // Generate PKCE verifier and challenge
      const { codeVerifier, codeChallenge } = generatePKCE();
      pendingCodeVerifier = codeVerifier;
      
      // Start callback server
      const serverPromise = startOAuthServer();
      
      // Generate OAuth URL with Authorization Code flow + PKCE
      const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code', // Authorization Code flow
        scope: 'openid email profile',
        code_challenge: codeChallenge, // PKCE challenge
        code_challenge_method: 'S256', // SHA256
        state: state, // CSRF protection
        access_type: 'offline',
        prompt: 'consent',
      });
      
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      
      // Debug logging
      console.log('=== OAuth Authorization Request ===');
      console.log('Authorization URL:', authUrl);
      console.log('Redirect URI:', REDIRECT_URI);
      console.log('Client ID:', GOOGLE_CLIENT_ID);
      console.log('Code Challenge (first 20 chars):', codeChallenge.substring(0, 20));
      console.log('Code Challenge Method: S256');
      console.log('===================================');
      
      console.log('Opening Google OAuth consent page in external browser');
      
      // Open OAuth URL in external browser (system default browser)
      shellModule.openExternal(authUrl).catch((error: any) => {
        console.error('Failed to open external browser:', error);
        stopOAuthServer();
        pendingAuthResolver = null;
        pendingCodeVerifier = null;
        resolve({
          success: false,
          error: 'Failed to open browser for authentication',
        });
      });
      
      // Wait for callback with authorization code
      serverPromise
        .then((code) => {
          console.log('Received authorization code');
          if (pendingCodeVerifier && pendingAuthResolver) {
            handleAuthorizationCode(code, pendingCodeVerifier, pendingAuthResolver);
            pendingAuthResolver = null;
            pendingCodeVerifier = null;
          }
        })
        .catch((error: any) => {
          console.error('OAuth callback server error:', error);
          stopOAuthServer();
          if (pendingAuthResolver) {
            pendingAuthResolver({
              success: false,
              error: error.message || 'Failed to receive OAuth callback',
            });
            pendingAuthResolver = null;
            pendingCodeVerifier = null;
          }
        });
      
    } catch (error: any) {
      console.error('Google Sign-In error:', error);
      stopOAuthServer();
      pendingAuthResolver = null;
      pendingCodeVerifier = null;
      resolve({
        success: false,
        error: error.message || 'Failed to sign in with Google',
      });
    }
  });
}

/**
 * Sign out current user
 */
export async function signOut(): Promise<{ success: boolean; error?: string }> {
  try {
    await firebaseSignOut(auth);
    console.log('User signed out successfully');
    return { success: true };
  } catch (error: any) {
    console.error('Sign out error:', error);
    return {
      success: false,
      error: error.message || 'Failed to sign out',
    };
  }
}

/**
 * Get current user
 */
export function getCurrentUser(): User | null {
  return auth.currentUser;
}

/**
 * Get current user data (serializable format)
 */
export function getCurrentUserData(): { uid: string; email: string | null; displayName: string | null; photoURL: string | null } | null {
  const user = auth.currentUser;
  if (!user) return null;
  
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

/**
 * Listen to auth state changes
 */
export function onAuthStateChanged(
  callback: (user: User | null) => void
): Unsubscribe {
  return firebaseOnAuthStateChanged(auth, callback);
}

/**
 * Stop OAuth server (for cleanup)
 */
export function stopOAuthServerOnExit(): void {
  stopOAuthServer();
}
