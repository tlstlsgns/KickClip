importScripts(chrome.runtime.getURL('config.js'));

// Track last ping time to detect if we should ping on focus
let lastPingTime = 0;

let _savedUrlsCache = [];
let _cachedUserId = null; // cached login state for synchronous access in onCommand

// Enable side panel toggle on toolbar icon click.
// Chrome 116+ automatically opens/closes the side panel on action click.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Failed to set side panel behavior:', error));

// Restore persisted saved-URLs cache so the first get-saved-urls call
// after a Service Worker restart returns real data instead of [].
// Migrate old blinkSavedUrls → kickclipSavedUrls if needed
chrome.storage.local.get(['kickclipSavedUrls', 'blinkSavedUrls'], (result) => {
  if (Array.isArray(result?.kickclipSavedUrls)) {
    _savedUrlsCache = result.kickclipSavedUrls;
  } else if (Array.isArray(result?.blinkSavedUrls)) {
    // Migrate from old key
    _savedUrlsCache = result.blinkSavedUrls;
    chrome.storage.local.set({ kickclipSavedUrls: _savedUrlsCache }).catch(() => {});
    chrome.storage.local.remove('blinkSavedUrls').catch(() => {});
  }
});

chrome.storage.local.get('kickclipUserId', (result) => {
  _cachedUserId = result?.kickclipUserId || null;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('kickclipUserId' in changes) {
    _cachedUserId = changes.kickclipUserId?.newValue || null;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  port.onDisconnect.addListener(() => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs?.[0]?.id) return;
        const tabUrl = tabs[0].url || '';
        if (
          tabUrl.startsWith('chrome://') ||
          tabUrl.startsWith('chrome-extension://') ||
          tabUrl.startsWith('edge://') ||
          tabUrl.startsWith('arc://')
        ) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'sidepanel-closed' }, () => {
          if (chrome.runtime.lastError) {}
        });
      });
    } catch (e) {}
  });
});

/**
 * Reads the cached Firebase userId from chrome.storage.local.
 * Set by sidepanel.js on sign-in.
 * Returns null if not available.
 */
async function getCachedUserId() {
  try {
    const result = await chrome.storage.local.get('kickclipUserId');
    return result?.kickclipUserId || null;
  } catch {
    return null;
  }
}

/**
 * Resolve redirect URL to final destination
 * Follows redirects and returns the final URL
 * 
 * @param {string} url - The URL to resolve
 * @returns {Promise<string>} - The resolved URL (or original if resolution fails)
 */
async function resolveRedirect(url) {
  const startTime = Date.now();
  
  try {
    // Create AbortController for timeout (increased to 5 seconds for complex redirect chains)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000); // 5 second timeout

    // Try GET method first (more reliable for redirect chains than HEAD)
    // Some servers don't properly handle HEAD requests for redirects
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow', // Follow redirects automatically
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    clearTimeout(timeoutId);

    // response.url contains the final URL after all redirects
    const finalUrl = response.url;

    // Return the final URL (or original if same)
    return finalUrl || url;
  } catch (error) {
    const elapsedTime = Date.now() - startTime;
    
    // Handle timeout, network errors, etc.
    if (error.name === 'AbortError') {
      return url; // Return original URL on timeout
    } else if (error.message && error.message.includes('CORS')) {
      return url; // Return original URL on CORS error
    } else if (error.message && error.message.includes('Failed to fetch')) {
      return url; // Return original URL on network error
    } else {
      return url; // Return original URL on error
    }
  }
}

const sendConnectionPing = async () => {};

// Send ping when extension starts/loads or service worker wakes up
// This happens when Chrome becomes active after being inactive
sendConnectionPing();

// Send ping periodically to maintain connection state (every 20 seconds)
setInterval(() => {
  sendConnectionPing();
}, 20000);

// Send ping when Chrome window gains focus (Chrome becomes active)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    // Chrome window gained focus - check if enough time has passed since last ping
    const timeSinceLastPing = Date.now() - lastPingTime;
    // If more than 5 seconds have passed, send a ping to refresh connection state
    if (timeSinceLastPing > 5000) {
      sendConnectionPing();
    }
  }
});

// Send ping when a tab becomes active (user switches to Chrome tab)
chrome.tabs.onActivated.addListener((activeInfo) => {
  const timeSinceLastPing = Date.now() - lastPingTime;
  // If more than 5 seconds have passed, send a ping to refresh connection state
  if (timeSinceLastPing > 5000) {
    sendConnectionPing();
  }
});

// === REMOVED: chrome.commands shortcut path ===
// The clip shortcut is now handled entirely by the content-script
// keydown listener (coreEntry.js PHASE_KEYDOWN_SHORTCUT). The legacy
// chrome.commands.onCommand listener — together with getCurrentShortcut,
// runShortcutPoll/stopShortcutPolling, and the 'get-shortcut' /
// 'start-shortcut-polling' message handlers — was removed in
// Sub-phase 4b of the custom-shortcut feature.
// === END REMOVED ===

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'open-sidepanel') {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs?.[0]?.id && tabs?.[0]?.windowId) {
          chrome.sidePanel.open({
            tabId: tabs[0].id,
            windowId: tabs[0].windowId,
          }).catch(() => {});
        }
      });
    } catch (e) {}
    return false;
  }

  if (request.action === 'sidepanel-opened' || request.action === 'sidepanel-closed') {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs?.[0]?.id) return;
        const tabUrl = tabs[0].url || '';
        if (
          tabUrl.startsWith('chrome://') ||
          tabUrl.startsWith('chrome-extension://') ||
          tabUrl.startsWith('edge://') ||
          tabUrl.startsWith('arc://')
        ) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: request.action }, () => {
          if (chrome.runtime.lastError) {}
        });
      });
    } catch (e) {}
    return false;
  }

  if (request.action === 'set-saved-urls') {
    _savedUrlsCache = Array.isArray(request.urls) ? request.urls : [];
    chrome.storage.local.set({ kickclipSavedUrls: _savedUrlsCache }).catch(() => {});
    sendResponse({ success: true });
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]?.id) return;
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url || '';
        if (
          tabUrl.startsWith('chrome://') ||
          tabUrl.startsWith('chrome-extension://') ||
          tabUrl.startsWith('edge://') ||
          tabUrl.startsWith('arc://')
        ) return;
        chrome.tabs.sendMessage(tabId, { action: 'saved-urls-updated' }, () => {
          if (chrome.runtime.lastError) { /* tab may not have content script */ }
        });
      });
    } catch (e) {}
    return true;
  }

  // === PHASE_AUTO_UPLOAD_ON_CLIP ===
  // Relay 'clip-saved' broadcast from coreEntry.js to the active tab
  // (where the sidepanel lives, if open). Mirrors the saved-urls-updated
  // relay pattern. Used by sidepanel.js to auto-upload when Auto is ON.
  if (request.action === 'clip-saved') {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]?.id) return;
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url || '';
        if (
          tabUrl.startsWith('chrome://') ||
          tabUrl.startsWith('chrome-extension://') ||
          tabUrl.startsWith('edge://') ||
          tabUrl.startsWith('arc://')
        ) return;
        chrome.tabs.sendMessage(tabId, { action: 'clip-saved', item: request.item }, () => {
          if (chrome.runtime.lastError) { /* tab may not have content script */ }
        });
      });
    } catch (e) {}
    return false;
  }
  // === END PHASE_AUTO_UPLOAD_ON_CLIP ===

  if (request.action === 'get-saved-urls') {
    sendResponse({ urls: _savedUrlsCache });
    return true;
  }

  if (request.action === 'get-server-status') {
    sendResponse({ ok: true });
    return false;
  }

  // Handle userId request from content script
  if (request.action === 'get-cached-user-id') {
    getCachedUserId().then((userId) => {
      if (userId) {
        console.log('[BG] get-cached-user-id: found', userId.substring(0, 8) + '...');
      } else {
        console.warn('[BG] get-cached-user-id: no userId in storage');
      }
      sendResponse({ userId: userId || null });
    });
    return true; // async response
  }

  // Generic Google OAuth token handler — replaces prior single-purpose
  // get-gmail-token. Consumers pass the required scopes explicitly so each
  // caller follows least-privilege.
  if (request.action === 'get-google-oauth-token') {
    const options = { interactive: request.interactive !== false };
    if (Array.isArray(request.scopes) && request.scopes.length > 0) {
      options.scopes = request.scopes;
    }
    try {
      chrome.identity.getAuthToken(options, (token) => {
        if (chrome.runtime.lastError) {
          console.log('[KICKCLIP-LOG] get-google-oauth-token error:',
            chrome.runtime.lastError.message);
          sendResponse({
            token: null,
            error: chrome.runtime.lastError.message || 'getAuthToken failed',
          });
          return;
        }
        if (!token) {
          sendResponse({ token: null, error: 'No token returned' });
          return;
        }
        sendResponse({ token });
      });
      return true; // async response
    } catch (e) {
      console.log('[KICKCLIP-LOG] get-google-oauth-token exception:', e);
      sendResponse({ token: null, error: e?.message || String(e) });
      return true;
    }
  }

  // Phase U3.3: ensure kickclip_files subfolder exists in selected parent
  // on Google Drive. Searches for app-owned 'kickclip_files' within parent;
  // reuses if found (drive.file scope lets app see only folders it created),
  // creates new otherwise.
  //
  // Request: { action: 'drive-ensure-folder', parentFolderId, parentFolderName? }
  // Response: { ok: true, folderId, folderName, parentFolderId, parentFolderName }
  //           | { ok: false, reason: 'no-token' | 'api-error', message, status? }
  if (request.action === 'drive-ensure-folder') {
    (async () => {
      try {
        const parentFolderId = request.parentFolderId;
        if (!parentFolderId) {
          sendResponse({ ok: false, reason: 'api-error', message: 'parentFolderId required' });
          return;
        }
        const tokenResp = await new Promise((resolve) => {
          chrome.identity.getAuthToken(
            {
              interactive: true,
              scopes: [
                'openid',
                'email',
                'profile',
                'https://www.googleapis.com/auth/drive.file',
              ],
            },
            (token) => {
              if (chrome.runtime.lastError || !token) {
                resolve({ token: null, error: chrome.runtime.lastError?.message });
              } else {
                resolve({ token });
              }
            }
          );
        });
        if (!tokenResp.token) {
          sendResponse({ ok: false, reason: 'no-token', message: tokenResp.error || 'No token' });
          return;
        }

        const query = [
          "name='kickclip_files'",
          `'${parentFolderId}' in parents`,
          "mimeType='application/vnd.google-apps.folder'",
          'trashed=false',
        ].join(' and ');
        const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`;
        const searchResp = await fetch(searchUrl, {
          headers: { Authorization: `Bearer ${tokenResp.token}` },
        });
        if (!searchResp.ok) {
          const errText = await searchResp.text();
          console.log('[KICKCLIP-LOG] drive-ensure-folder search error:', searchResp.status, errText);
          sendResponse({
            ok: false,
            reason: 'api-error',
            status: searchResp.status,
            message: `Drive search failed: ${searchResp.status}`,
          });
          return;
        }
        const searchData = await searchResp.json();

        if (Array.isArray(searchData.files) && searchData.files.length > 0) {
          const found = searchData.files[0];
          console.log('[KICKCLIP-LOG] drive-ensure-folder reused:', found.id);
          sendResponse({
            ok: true,
            folderId: found.id,
            folderName: found.name,
            parentFolderId,
            parentFolderName: request.parentFolderName || '',
            reused: true,
          });
          return;
        }

        const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenResp.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'kickclip_files',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentFolderId],
          }),
        });
        if (!createResp.ok) {
          const errText = await createResp.text();
          console.log('[KICKCLIP-LOG] drive-ensure-folder create error:', createResp.status, errText);
          sendResponse({
            ok: false,
            reason: 'api-error',
            status: createResp.status,
            message: `Drive create failed: ${createResp.status}`,
          });
          return;
        }
        const created = await createResp.json();
        console.log('[KICKCLIP-LOG] drive-ensure-folder created:', created.id);
        sendResponse({
          ok: true,
          folderId: created.id,
          folderName: created.name,
          parentFolderId,
          parentFolderName: request.parentFolderName || '',
          reused: false,
        });
      } catch (e) {
        console.log('[KICKCLIP-LOG] drive-ensure-folder exception:', e);
        sendResponse({ ok: false, reason: 'api-error', message: e?.message || String(e) });
      }
    })();
    return true; // async response
  }

  // Phase U3.3: upload a DataCard item to Drive's kickclip_files folder
  // as a markdown (or image for Image category) file via multipart upload.
  //
  // Request: { action: 'drive-upload-file', item, folderId, desiredName, mimeType, contentBase64 }
  // Response: { ok: true, fileId, fileName, webViewLink? }
  //           | { ok: false, reason: 'no-token' | 'folder-missing' | 'api-error', message, status? }
  if (request.action === 'drive-upload-file') {
    (async () => {
      try {
        const { folderId, desiredName, mimeType, contentBase64 } = request;
        if (!folderId || !desiredName || !mimeType || !contentBase64) {
          sendResponse({ ok: false, reason: 'api-error', message: 'missing required fields' });
          return;
        }

        const tokenResp = await new Promise((resolve) => {
          chrome.identity.getAuthToken(
            {
              interactive: true,
              scopes: [
                'openid',
                'email',
                'profile',
                'https://www.googleapis.com/auth/drive.file',
              ],
            },
            (token) => {
              if (chrome.runtime.lastError || !token) {
                resolve({ token: null, error: chrome.runtime.lastError?.message });
              } else {
                resolve({ token });
              }
            }
          );
        });
        if (!tokenResp.token) {
          sendResponse({ ok: false, reason: 'no-token', message: tokenResp.error || 'No token' });
          return;
        }

        const binaryString = atob(contentBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const boundary = `kickclip_boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const metadata = {
          name: desiredName,
          parents: [folderId],
          mimeType,
        };
        const metadataPart =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          JSON.stringify(metadata) +
          `\r\n`;
        const dataPartHeader =
          `--${boundary}\r\n` +
          `Content-Type: ${mimeType}\r\n\r\n`;
        const closing = `\r\n--${boundary}--`;

        const encoder = new TextEncoder();
        const metadataBytes = encoder.encode(metadataPart);
        const dataHeaderBytes = encoder.encode(dataPartHeader);
        const closingBytes = encoder.encode(closing);
        const body = new Uint8Array(
          metadataBytes.length + dataHeaderBytes.length + bytes.length + closingBytes.length
        );
        let offset = 0;
        body.set(metadataBytes, offset); offset += metadataBytes.length;
        body.set(dataHeaderBytes, offset); offset += dataHeaderBytes.length;
        body.set(bytes, offset); offset += bytes.length;
        body.set(closingBytes, offset);

        const uploadResp = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenResp.token}`,
              'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body,
          }
        );
        if (!uploadResp.ok) {
          const errText = await uploadResp.text();
          console.log('[KICKCLIP-LOG] drive-upload-file error:', uploadResp.status, errText);
          const reason = (uploadResp.status === 404 || uploadResp.status === 403)
            ? 'folder-missing'
            : 'api-error';
          sendResponse({
            ok: false,
            reason,
            status: uploadResp.status,
            message: `Drive upload failed: ${uploadResp.status}`,
          });
          return;
        }
        const uploaded = await uploadResp.json();
        console.log('[KICKCLIP-LOG] drive-upload-file success:', uploaded.id);
        sendResponse({
          ok: true,
          fileId: uploaded.id,
          fileName: uploaded.name,
          webViewLink: uploaded.webViewLink || null,
        });
      } catch (e) {
        console.log('[KICKCLIP-LOG] drive-upload-file exception:', e);
        sendResponse({ ok: false, reason: 'api-error', message: e?.message || String(e) });
      }
    })();
    return true; // async response
  }

  // Handle redirect resolution request
  if (request.action === 'resolve-redirect') {
    const url = request.url;
    
    if (!url || typeof url !== 'string') {
      sendResponse({ success: false, error: 'Invalid URL' });
      return true;
    }

    // Resolve redirect asynchronously
    resolveRedirect(url)
      .then((resolvedUrl) => {
        sendResponse({
          success: true,
          resolvedUrl: resolvedUrl
        });
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error.message || 'Failed to resolve redirect',
          resolvedUrl: url // Return original URL on error
        });
      });

    // Return true to indicate we will send a response asynchronously
    return true;
  }

  // Fetch image via background script to bypass CORS restrictions.
  // Content-script fetch fails for cross-origin images without CORS headers.
  // Background fetch uses extension's <all_urls> permission to succeed.
  // Blob must be converted to base64 data URL for cross-context transfer.
  if (request.action === 'fetch-image') {
    (async () => {
      try {
        const res = await fetch(request.url);
        if (!res.ok) {
          sendResponse({ success: false, error: `HTTP ${res.status}` });
          return;
        }
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({
            success: true,
            dataUrl: reader.result,
            type: blob.type,
          });
        };
        reader.onerror = () => {
          sendResponse({ success: false, error: 'FileReader failed' });
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        sendResponse({ success: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // === PHASE_TAB_SCREENSHOT_HANDLER ===
  // Capture the visible viewport of the active tab for video clip
  // fallback (when canvas drawImage is tainted and poster URL is absent).
  // Content script crops to video rect on its side.
  if (request.action === 'capture-visible-tab') {
    try {
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ dataUrl: null, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl: dataUrl || null });
        }
      });
    } catch (e) {
      sendResponse({ dataUrl: null, error: String(e?.message || e) });
    }
    return true;  // async response
  }
  // === END PHASE_TAB_SCREENSHOT_HANDLER ===
  
  if (request.action === 'sidepanel-focused' || request.action === 'sidepanel-blurred') {
    // Forward to the active tab's content script so it can track
    // whether the Side Panel has focus (to avoid false not-focused detection).
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]?.id) return;
      const tabId = tabs[0].id;
      const tabUrl = tabs[0].url || '';
      if (
        tabUrl.startsWith('chrome://') ||
        tabUrl.startsWith('chrome-extension://') ||
        tabUrl.startsWith('edge://') ||
        tabUrl.startsWith('arc://')
      ) return;
      chrome.tabs.sendMessage(tabId, { action: request.action }, () => {
        if (chrome.runtime.lastError) { /* tab may not have content script */ }
      });
    });
    return false;
  }
  
  // Return false for other messages (not handled here)
  return false;
});