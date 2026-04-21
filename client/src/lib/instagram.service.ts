/**
 * Instagram Authentication Service
 * 
 * Handles Instagram authentication using cookie-based sessions with OAuth verification.
 * - Cookie extraction from login session for webview authentication
 * - Instagram Basic Display API OAuth for account verification
 * - Cookie encryption/decryption for secure storage
 */

import { BrowserWindow, session } from 'electron';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import * as http from 'http';
import { URL } from 'url';
import { auth } from './firebase.js';
import type { InstagramSessionData } from './firestore.js';

// Facebook App configuration (Instagram uses Facebook OAuth)
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '854337097429320';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || 'b6cacdb98de2bf45bcf20f3d1ee57f9f';

// Instagram Basic Display API configuration
const INSTAGRAM_REDIRECT_URI = `http://localhost:3005/instagram-callback`;
const INSTAGRAM_OAUTH_PORT = 3005;

// Instagram cookie domain
const INSTAGRAM_DOMAIN = '.instagram.com';

// Encryption key (should be stored securely, using a simple derivation for now)
// In production, consider using Electron's safeStorage API for key management
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
let encryptionKey: Buffer | null = null;

/**
 * Get or generate encryption key
 * Uses a simple key derivation (in production, use safeStorage)
 */
function getEncryptionKey(): Buffer {
  if (!encryptionKey) {
    // Derive key from app name + a fixed salt (in production, use safeStorage)
    const appName = appInstance?.getName() || 'AppTest';
    const keyMaterial = `${appName}-instagram-cookies-v1`;
    encryptionKey = createHash('sha256').update(keyMaterial).digest();
  }
  return encryptionKey;
}

/**
 * Encrypt cookie value for storage
 */
export function encryptCookie(value: string): string {
  try {
    const key = getEncryptionKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Return: iv:authTag:encrypted (all hex encoded)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Error encrypting cookie:', error);
    throw error;
  }
}

/**
 * Decrypt cookie value from storage
 */
export function decryptCookie(encryptedValue: string): string {
  try {
    const key = getEncryptionKey();
    const parts = encryptedValue.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted cookie format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Error decrypting cookie:', error);
    throw error;
  }
}

/**
 * Extract Instagram cookies from a BrowserWindow session
 */
export async function extractInstagramCookies(loginWindow: BrowserWindow): Promise<Electron.Cookie[]> {
  try {
    const ses = loginWindow.webContents.session;
    const cookies = await ses.cookies.get({ domain: INSTAGRAM_DOMAIN });
    
    // Extract ALL Instagram cookies (don't filter - Instagram may need all cookies for authentication)
    // Only filter by domain to ensure we get Instagram cookies
    const relevantCookies = cookies.filter(cookie => {
      // Accept all cookies from Instagram domain (more reliable than filtering by name)
      return cookie.domain && (
        cookie.domain.includes('instagram.com') ||
        cookie.domain.includes('.instagram.com')
      );
    });
    
    console.log(`Extracted ${relevantCookies.length} Instagram cookies`);
    return relevantCookies;
  } catch (error) {
    console.error('Error extracting Instagram cookies:', error);
    throw error;
  }
}

// InstagramSessionData interface is imported from firestore.ts

/**
 * OAuth callback server for Instagram Basic Display API
 */
let instagramOAuthServer: http.Server | null = null;
let pendingOAuthResolver: ((value: { success: boolean; code?: string; error?: string }) => void) | null = null;

/**
 * Start OAuth callback server for Instagram Basic Display API
 */
function startInstagramOAuthServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Close existing server if running
    if (instagramOAuthServer) {
      instagramOAuthServer.close();
      instagramOAuthServer = null;
    }
    
    const timeout = setTimeout(() => {
      if (instagramOAuthServer) {
        instagramOAuthServer.close();
        instagramOAuthServer = null;
      }
      reject(new Error('Instagram OAuth timeout - no response received'));
    }, 5 * 60 * 1000); // 5 minute timeout
    
    instagramOAuthServer = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      
      const url = new URL(req.url, `http://localhost:${INSTAGRAM_OAUTH_PORT}`);
      
      if (url.pathname === '/instagram-callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const errorReason = url.searchParams.get('error_reason');
        
        clearTimeout(timeout);
        
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Instagram Authentication Error</title></head>
              <body style="font-family: system-ui; text-align: center; padding: 40px;">
                <h1>❌ Instagram Authentication Error</h1>
                <p>Error: ${error}</p>
                ${errorReason ? `<p>Reason: ${errorReason}</p>` : ''}
                <p>You can close this window.</p>
                <script>setTimeout(() => window.close(), 3000);</script>
              </body>
            </html>
          `);
          reject(new Error(`Instagram OAuth error: ${error}${errorReason ? ` (${errorReason})` : ''}`));
          if (instagramOAuthServer) {
            instagramOAuthServer.close();
            instagramOAuthServer = null;
          }
          return;
        }
        
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Instagram Authentication successful</title></head>
              <body style="font-family: system-ui; text-align: center; padding: 40px;">
                <h1>✅ Instagram Authentication successful!</h1>
                <p>You can close this window and return to the app.</p>
                <script>setTimeout(() => window.close(), 2000);</script>
              </body>
            </html>
          `);
          resolve(code);
          if (instagramOAuthServer) {
            instagramOAuthServer.close();
            instagramOAuthServer = null;
          }
        } else {
          res.writeHead(400);
          res.end('No authorization code received');
          reject(new Error('No authorization code received'));
          if (instagramOAuthServer) {
            instagramOAuthServer.close();
            instagramOAuthServer = null;
          }
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    
    instagramOAuthServer.listen(INSTAGRAM_OAUTH_PORT, 'localhost', () => {
      console.log(`Instagram OAuth callback server listening on http://localhost:${INSTAGRAM_OAUTH_PORT}`);
    });
    
    instagramOAuthServer.on('error', (err: any) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${INSTAGRAM_OAUTH_PORT} is already in use. Please close the application using this port.`));
      } else {
        reject(err);
      }
      if (instagramOAuthServer) {
        instagramOAuthServer.close();
        instagramOAuthServer = null;
      }
    });
  });
}

/**
 * Stop Instagram OAuth callback server
 */
function stopInstagramOAuthServer(): void {
  if (instagramOAuthServer) {
    instagramOAuthServer.close();
    instagramOAuthServer = null;
    console.log('Instagram OAuth callback server stopped');
  }
}

/**
 * Exchange Instagram OAuth authorization code for access token
 * Instagram Basic Display API token exchange
 */
export async function exchangeInstagramOAuthCode(code: string): Promise<{ access_token: string; user_id: string; expires_in?: number }> {
  try {
    // Exchange code for access token
    // Note: Instagram Basic Display API uses a different endpoint structure
    // We need to exchange via Facebook's token endpoint
    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: FACEBOOK_APP_ID,
        client_secret: FACEBOOK_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: INSTAGRAM_REDIRECT_URI,
        code: code,
      }),
    });
    
    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Instagram token exchange error:', errorData);
      throw new Error(`Instagram token exchange failed: ${tokenResponse.status}`);
    }
    
    const tokenData = await tokenResponse.json();
    
    // Instagram Basic Display API returns: { access_token, user_id }
    return {
      access_token: tokenData.access_token,
      user_id: tokenData.user_id,
      expires_in: tokenData.expires_in, // Usually 3600 (1 hour) for short-lived tokens
    };
  } catch (error: any) {
    console.error('Error exchanging Instagram OAuth code:', error);
    throw error;
  }
}

/**
 * Get Instagram user info using access token
 */
export async function getInstagramUserInfo(accessToken: string): Promise<{ id: string; username: string }> {
  try {
    const response = await fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${accessToken}`);
    
    if (!response.ok) {
      const errorData = await response.text();
      console.error('Instagram user info error:', errorData);
      throw new Error(`Failed to get Instagram user info: ${response.status}`);
    }
    
    const userData = await response.json();
    return {
      id: userData.id,
      username: userData.username,
    };
  } catch (error: any) {
    console.error('Error getting Instagram user info:', error);
    throw error;
  }
}

/**
 * Connect Instagram account - Opens login window and extracts cookies
 * Also optionally performs OAuth verification
 */
export async function connectInstagram(
  userId: string,
  shellModule: typeof import('electron').shell
): Promise<{ success: boolean; username?: string; sessionData?: Omit<InstagramSessionData, 'userId'>; error?: string }> {
  return new Promise(async (resolve) => {
    try {
      console.log('Starting Instagram connection...');
      
      // Create a temporary login window
      const loginWindow = new BrowserWindow({
        width: 500,
        height: 700,
        show: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: `instagram-login-${Date.now()}`, // Unique session partition
        },
      });
      
      // Load Instagram login page
      const instagramLoginUrl = 'https://www.instagram.com/accounts/login/';
      await loginWindow.loadURL(instagramLoginUrl);
      
      console.log('Instagram login window opened');
      
      // Wait for successful login
      // Monitor navigation to detect when user has logged in
      loginWindow.webContents.on('did-navigate', async (event, url) => {
        // Check if user is on Instagram homepage (logged in)
        if (url.includes('instagram.com') && !url.includes('/accounts/login')) {
          console.log('Detected Instagram login success');
          
          try {
            // Wait a bit for cookies to be set
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Extract cookies
            const cookies = await extractInstagramCookies(loginWindow);
            
            if (cookies.length === 0) {
              loginWindow.close();
              resolve({
                success: false,
                error: 'No Instagram cookies found. Please ensure you logged in successfully.',
              });
              return;
            }
            
            // Try to get username from page DOM
            let username = 'instagram_user'; // Default fallback
            try {
              // Wait a bit more for page to fully load
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Try to extract username from various places in the DOM
              const usernameScript = `
                (function() {
                  // Try to get username from profile link in header
                  const profileLink = document.querySelector('a[href*="/accounts/edit/"]') || 
                                     document.querySelector('a[href*="/"]') ||
                                     document.querySelector('header a[href^="/"]');
                  if (profileLink && profileLink.href) {
                    const match = profileLink.href.match(/instagram\\.com\\/([^/\\?]+)/);
                    if (match && match[1] && match[1] !== 'accounts' && match[1] !== 'explore') {
                      return match[1];
                    }
                  }
                  
                  // Try to get from meta tags
                  const metaDescription = document.querySelector('meta[property="og:description"]');
                  if (metaDescription && metaDescription.content) {
                    const match = metaDescription.content.match(/@([a-zA-Z0-9._]+)/);
                    if (match && match[1]) {
                      return match[1];
                    }
                  }
                  
                  // Try to get from any link with username pattern
                  const links = document.querySelectorAll('a[href*="/"]');
                  for (const link of links) {
                    if (link.href) {
                      const match = link.href.match(/instagram\\.com\\/([a-zA-Z0-9._]+)/);
                      if (match && match[1] && match[1] !== 'accounts' && match[1] !== 'explore' && match[1] !== 'direct') {
                        return match[1];
                      }
                    }
                  }
                  
                  return null;
                })();
              `;
              
              const extractedUsername = await loginWindow.webContents.executeJavaScript(usernameScript);
              if (extractedUsername && typeof extractedUsername === 'string' && extractedUsername.length > 0) {
                username = extractedUsername;
                console.log('Extracted Instagram username from page:', username);
              } else {
                console.log('Could not extract username from page, using default');
              }
            } catch (e) {
              console.log('Could not extract username from page:', e);
              // Fall back to default
            }
            
            // Encrypt cookies for storage (filter out undefined values for Firestore)
            const encryptedCookies = cookies.map(cookie => {
              const cookieData: any = {
                name: cookie.name,
                value: encryptCookie(cookie.value),
                domain: cookie.domain || INSTAGRAM_DOMAIN,
                path: cookie.path || '/',
                secure: cookie.secure || true,
                httpOnly: cookie.httpOnly || false,
              };
              
              // Only include optional fields if they have values
              if (cookie.sameSite !== undefined) {
                cookieData.sameSite = cookie.sameSite;
              }
              if (cookie.expirationDate !== undefined) {
                cookieData.expirationDate = cookie.expirationDate;
              }
              
              return cookieData;
            });
            
            // Calculate expiration (use cookie expiration or default to 7 days)
            const expirationDate = cookies
              .map(c => c.expirationDate)
              .filter(Boolean)
              .sort((a, b) => (b || 0) - (a || 0))[0];
            
            const sessionData: InstagramSessionData = {
              userId,
              instagramUsername: username,
              cookies: encryptedCookies,
              connectedAt: Date.now(),
              expiresAt: expirationDate,
            };
            
            // Close login window
            loginWindow.close();
            
            // Return success with session data (caller will handle Firestore storage)
            resolve({
              success: true,
              username: username,
              sessionData: {
                instagramUsername: username,
                cookies: encryptedCookies,
                connectedAt: Date.now(),
                expiresAt: expirationDate,
              },
            });
          } catch (error: any) {
            console.error('Error during cookie extraction:', error);
            loginWindow.close();
            resolve({
              success: false,
              error: error.message || 'Failed to extract Instagram cookies',
            });
          }
        }
      });
      
      // Handle window closed before login
      loginWindow.on('closed', () => {
        if (!loginWindow.isDestroyed()) {
          // Check if we already resolved (success case)
          // This is a fallback for if user closes window manually
        }
      });
      
      // Optional: Set a timeout for login (5 minutes)
      setTimeout(() => {
        if (!loginWindow.isDestroyed()) {
          loginWindow.close();
          resolve({
            success: false,
            error: 'Login timeout - please try again',
          });
        }
      }, 5 * 60 * 1000);
      
    } catch (error: any) {
      console.error('Instagram connection error:', error);
      resolve({
        success: false,
        error: error.message || 'Failed to connect Instagram account',
      });
    }
  });
}

/**
 * Inject Instagram cookies into a webview session
 */
export async function injectInstagramCookies(
  webviewSession: Electron.Session,
  cookies: InstagramSessionData['cookies']
): Promise<void> {
  try {
    for (const cookie of cookies) {
      try {
        // Decrypt cookie value
        const decryptedValue = decryptCookie(cookie.value);
        
        // Build a valid URL for cookie setting
        // Instagram cookies have domains like '.instagram.com' (with leading dot)
        // We need to use a valid URL like 'https://www.instagram.com' for the url parameter
        let cookieUrl = 'https://www.instagram.com';
        if (cookie.domain && cookie.domain.includes('instagram.com')) {
          // Remove leading dot if present for URL construction
          const domainWithoutDot = cookie.domain.startsWith('.') 
            ? cookie.domain.substring(1) 
            : cookie.domain;
          cookieUrl = `https://${domainWithoutDot}`;
        }
        
        // For Electron's cookies.set(), remove leading dot from domain
        // Electron handles subdomain matching internally, and the leading dot can cause issues
        const domainForElectron = cookie.domain && cookie.domain.startsWith('.')
          ? cookie.domain.substring(1)
          : cookie.domain;
        
        await webviewSession.cookies.set({
          url: cookieUrl, // Valid URL format required (e.g., https://www.instagram.com)
          name: cookie.name,
          value: decryptedValue,
          domain: domainForElectron, // Domain without leading dot for Electron API
          path: cookie.path || '/',
          secure: cookie.secure !== false, // Default to true for Instagram
          httpOnly: cookie.httpOnly !== false, // Default to true for security cookies
          sameSite: cookie.sameSite || 'lax', // Default to 'lax' if not specified
          expirationDate: cookie.expirationDate,
        });
      } catch (cookieError) {
        console.error(`Error injecting cookie ${cookie.name}:`, cookieError);
        // Continue with other cookies
      }
    }
    console.log(`Injected ${cookies.length} Instagram cookies into session`);
  } catch (error) {
    console.error('Error injecting Instagram cookies:', error);
    throw error;
  }
}

/**
 * Check if URL is an Instagram URL
 */
export function isInstagramUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('instagram.com');
  } catch {
    return false;
  }
}

// Export for use in main process
export { stopInstagramOAuthServer };

// App instance for key derivation (set from main process)
let appInstance: Electron.App | null = null;
export function setApp(instance: Electron.App) {
  appInstance = instance;
}

