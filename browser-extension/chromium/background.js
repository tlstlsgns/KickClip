importScripts(chrome.runtime.getURL('config.js'));

// Track last ping time to detect if we should ping on focus
let lastPingTime = 0;
let _shortcutPollTimer = null;
let _shortcutPollBaseline = null;

let _savedUrlsCache = [];
let _cachedUserId = null; // cached login state for synchronous access in onCommand

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
 * Reads the current shortcut for the 'save-url' command from Chrome's
 * commands API. Returns a string like 'Ctrl+Shift+S' or 'MacCtrl+Shift+S',
 * or null if unavailable.
 */
async function getCurrentShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'save-url');
    return cmd?.shortcut || null;
  } catch {
    return null;
  }
}

function stopShortcutPolling() {
  if (_shortcutPollTimer !== null) {
    clearTimeout(_shortcutPollTimer);
    _shortcutPollTimer = null;
  }
  _shortcutPollBaseline = null;
}

async function runShortcutPoll(deadline) {
  if (Date.now() >= deadline) {
    stopShortcutPolling();
    return;
  }
  try {
    const current = await getCurrentShortcut();
    if (current && current !== _shortcutPollBaseline) {
      // Shortcut changed — update baseline and notify Side Panel
      // Keep polling so further changes are also detected
      _shortcutPollBaseline = current;
      chrome.storage.local.set({ kickclipShortcut: current }).catch(() => {});
      chrome.runtime.sendMessage({ action: 'shortcut-updated', shortcut: current })
        .catch(() => {});
    }
  } catch {}
  // Schedule next tick
  _shortcutPollTimer = setTimeout(() => runShortcutPoll(deadline), 800);
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

/**
 * Fetch metadata (title and description) from a URL
 * Uses fetch API to avoid CORS issues (background worker has broader permissions)
 * 
 * @param {string} url - The URL to fetch metadata from
 * @returns {Promise<{title: string|null, description: string|null}>}
 */
async function fetchMetadata(url) {
  try {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 second timeout

    // Fetch the HTML
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Get HTML text
    const html = await response.text();

    // Parse title
    let title = null;
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim();
      // Decode HTML entities
      title = title.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&nbsp;/g, ' ');
    }

    // Parse description from meta tags
    let description = null;
    
    // Try og:description first
    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (ogDescMatch && ogDescMatch[1]) {
      description = ogDescMatch[1].trim();
    } else {
      // Fallback to standard description meta tag
      const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
      if (descMatch && descMatch[1]) {
        description = descMatch[1].trim();
      }
    }

    // Decode HTML entities in description
    if (description) {
      description = description.replace(/&amp;/g, '&')
                               .replace(/&lt;/g, '<')
                               .replace(/&gt;/g, '>')
                               .replace(/&quot;/g, '"')
                               .replace(/&#39;/g, "'")
                               .replace(/&nbsp;/g, ' ');
    }

    return { title, description };
  } catch (error) {
    // Handle timeout, network errors, etc.
    if (error.name === 'AbortError') {
      return { title: null, description: null };
    } else {
      return { title: null, description: null };
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

// Listen for keyboard shortcut command
chrome.commands.onCommand.addListener((command) => {
  if (command === 'save-url') {
    // Use cached login state for synchronous access — required to preserve
    // user gesture context for chrome.sidePanel.open()
    if (!_cachedUserId) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs?.[0]?.id && tabs?.[0]?.windowId) {
          chrome.sidePanel.open({
            tabId: tabs[0].id,
            windowId: tabs[0].windowId,
          }).catch(() => {});
        }
      });
      return;
    }
    // IMMEDIATELY send placeholder to Electron app (before any async operations)
    // This ensures instant UI feedback
    const timestamp = Date.now();
    const placeholderPayload = {
      url: 'about:blank',
      title: 'Loading...',
      timestamp: timestamp,
      saved_by: 'extension',
    };
    
    // Send placeholder IMMEDIATELY (fire and forget, don't await)
    fetch('http://localhost:3001/pending-save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(placeholderPayload),
    }).catch(() => {
      // Silently fail if Electron app is not running
    });
    
    // Now send message to active tab's content script to process the save
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0 && tabs[0]) {
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url || 'unknown';
        
        // Check if this is a system page where we can't inject
        if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('arc://')) {
          return;
        }
        
        // Try to send message to content script (should be already injected via manifest)
        chrome.tabs.sendMessage(tabId, { action: 'save-url' }, (response) => {
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            
            const isConnectionError = errorMsg.includes('Could not establish connection') || 
                                     errorMsg.includes('Receiving end does not exist') || 
                                     errorMsg.includes('message port closed');
            
            if (isConnectionError) {
              chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => !!window.__kcMainLoaded
              }).then((results) => {
                const mainLoaded = results && results[0] && results[0].result === true;
                if (mainLoaded) {
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: 'save-url' }, () => {});
                  }, 200);
                } else {
                  chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content-loader.js']
                  }).then(() => {
                    setTimeout(() => {
                      chrome.tabs.sendMessage(tabId, { action: 'save-url' }, () => {});
                    }, 300);
                  }).catch(() => {});
                }
              }).catch(() => {
                chrome.scripting.executeScript({
                  target: { tabId: tabId },
                  files: ['content-loader.js']
                }).then(() => {
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: 'save-url' }, () => {});
                  }, 300);
                }).catch(() => {});
              });
            }
          }
        });
      }
    });
  }
});

// Create context menu items
function createContextMenus() {
  // Remove existing menus first to avoid duplicates
  chrome.contextMenus.removeAll(() => {
    // Create context menu for images
    chrome.contextMenus.create({
      id: 'save-image',
      title: 'Save image with KickClip',
      contexts: ['image']
    });

    // Create context menu for links
    chrome.contextMenus.create({
      id: 'save-link',
      title: 'Save link with KickClip',
      contexts: ['link']
    });

    // Create context menu for page
    chrome.contextMenus.create({
      id: 'save-page',
      title: 'Save page with KickClip',
      contexts: ['page', 'selection']
    });
  });
}

// Create context menus on install
chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

// Also create context menus when service worker starts (for existing installations)
createContextMenus();

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Check if this is a system page where we can't inject
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('arc://'))) {
    return;
  }

  if (info.menuItemId === 'save-image') {
    saveImageFromContextMenu(tab, info.srcUrl);
  } else if (info.menuItemId === 'save-link') {
    saveLinkFromContextMenu(tab, info.linkUrl, info.linkText || '');
  } else if (info.menuItemId === 'save-page') {
    savePageFromContextMenu(tab);
  }
});

// Helper function to save image from context menu
function saveImageFromContextMenu(tab, imageUrl) {
  // Get current page info and send to content script to check for tool data
  chrome.tabs.sendMessage(tab.id, { 
    action: 'save-url',
    img_url: imageUrl,
    from_context_menu: true
  }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script might not be injected, try to inject it
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-loader.js']
      }).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { 
            action: 'save-url',
            img_url: imageUrl,
            from_context_menu: true
          });
        }, 300);
      }).catch(() => {
        // Fallback: save directly without tool data
        saveDirectly(tab, imageUrl, null);
      });
    }
  });
}

// Helper function to save link from context menu
function saveLinkFromContextMenu(tab, linkUrl, linkText) {
  const payload = {
    url: linkUrl,
    title: linkText || linkUrl,
    timestamp: Date.now(),
    saved_by: 'extension'
  };
  
  saveDirectly(tab, null, payload);
}

// Helper function to save page from context menu (same as keyboard shortcut)
function savePageFromContextMenu(tab) {
  // Use the same logic as keyboard shortcut
  chrome.tabs.sendMessage(tab.id, { action: 'save-url' }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script might not be injected, try to inject it
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-loader.js']
      }).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'save-url' });
        }, 300);
      }).catch(() => {});
    }
  });
}

// Helper function to save directly to server (fallback when content script unavailable)
async function saveDirectly(tab, imageUrl, payload) {
  const userId = await getCachedUserId();

  const finalPayload = payload || {
    url: tab.url,
    title: tab.title,
    timestamp: Date.now(),
    saved_by: 'extension',
    ...(imageUrl && { img_url: imageUrl }),
  };

  // Inject userId if available and not already present
  if (userId && !finalPayload.userId) {
    finalPayload.userId = userId;
  }

  try {
    await fetch(`${KC_SERVER_URL}/api/v1/save-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });
  } catch (error) {
    // Silently fail
  }
}

// ========================================
// Instagram Post Data Extraction (Thumbnail + Caption)
// ========================================

/**
 * Extracts Instagram post caption from JSON API response
 * Tries multiple JSON paths to find the caption text
 * 
 * @param {Object} jsonData - Parsed JSON response from Instagram API
 * @returns {string|null} - Caption text or null if not found
 */
function extractCaptionFromJson(jsonData) {
  if (!jsonData || typeof jsonData !== 'object') {
    return null;
  }
  
  try {
    // Path 1: data.items[0].caption.text (newer API format)
    if (jsonData.data && Array.isArray(jsonData.data.items) && jsonData.data.items.length > 0) {
      const caption = jsonData.data.items[0].caption?.text;
      if (caption && typeof caption === 'string') {
        return caption.trim();
      }
    }
    
    // Path 2: graphql.shortcode_media.edge_media_to_caption.edges[0].node.text (GraphQL format)
    if (jsonData.graphql && jsonData.graphql.shortcode_media) {
      const edges = jsonData.graphql.shortcode_media.edge_media_to_caption?.edges;
      if (Array.isArray(edges) && edges.length > 0) {
        const caption = edges[0].node?.text;
        if (caption && typeof caption === 'string') {
          return caption.trim();
        }
      }
    }
    
    // Path 3: items[0].caption.text (alternative format)
    if (Array.isArray(jsonData.items) && jsonData.items.length > 0) {
      const caption = jsonData.items[0].caption?.text;
      if (caption && typeof caption === 'string') {
        return caption.trim();
      }
    }
    
    // Path 4: Recursive search for caption/text fields
    function searchForCaption(obj, depth = 0) {
      if (depth > 5 || !obj || typeof obj !== 'object') return null;
      
      // Check if this object has a caption or text field
      if (obj.caption && typeof obj.caption === 'string') {
        return obj.caption.trim();
      }
      if (obj.text && typeof obj.text === 'string' && obj.text.length > 10) {
        // Only return if it looks like a caption (not just a short label)
        return obj.text.trim();
      }
      
      // Recursively search in nested objects
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const value = obj[key];
          if (value && typeof value === 'object') {
            const result = searchForCaption(value, depth + 1);
            if (result) return result;
          }
        }
      }
      
      return null;
    }
    
    const caption = searchForCaption(jsonData);
    if (caption) {
      return caption;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extracts Instagram post caption from HTML page
 * Falls back to og:description meta tag if JSON API fails
 * 
 * @param {string} html - HTML content of the post page
 * @returns {string|null} - Caption text or null if not found
 */
function extractCaptionFromHtml(html) {
  if (!html || typeof html !== 'string') {
    return null;
  }
  
  try {
    // Try to extract from og:description meta tag
    const ogDescriptionMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (ogDescriptionMatch && ogDescriptionMatch[1]) {
      const caption = ogDescriptionMatch[1].trim();
      if (caption && caption.length > 0) {
        return caption;
      }
    }
    
    // Try alternative meta tag format
    const metaDescriptionMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (metaDescriptionMatch && metaDescriptionMatch[1]) {
      const caption = metaDescriptionMatch[1].trim();
      if (caption && caption.length > 0) {
        return caption;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Fetches Instagram post caption using shortcode
 * Tries JSON API first, then falls back to HTML parsing
 * 
 * @param {string} shortcode - Instagram post shortcode
 * @returns {Promise<string|null>} - Caption text or null if not found
 */
async function getInstagramPostCaption(shortcode) {
  if (!shortcode) {
    return null;
  }
  
  const apiUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=1`;
  
  try {
    
    // Try JSON API first
    const response = await fetch(apiUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
      }
    });
    
    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      
      // Check if response is JSON
      if (contentType.includes('application/json')) {
        try {
          const jsonData = await response.json();
          const caption = extractCaptionFromJson(jsonData);
          if (caption) {
            return caption;
          }
        } catch (jsonError) {
          // Continue to HTML fallback
        }
      }
      
      // Fallback: Try HTML parsing
      const html = await response.text();
      const caption = extractCaptionFromHtml(html);
      if (caption) {
        return caption;
      }
    } else {
      // Try HTML fallback even on error
      try {
        const htmlUrl = `https://www.instagram.com/p/${shortcode}/`;
        const htmlResponse = await fetch(htmlUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.instagram.com/',
          }
        });
        
        if (htmlResponse.ok) {
          const html = await htmlResponse.text();
          const caption = extractCaptionFromHtml(html);
          if (caption) {
            return caption;
          }
        }
      } catch (htmlError) {
        // HTML fallback failed
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Fetches the final CDN URL from Instagram media shortcut URL
 * Handles redirects to get the actual CDN URL (scontent.cdninstagram.com)
 * 
 * @param {string} shortcode - Instagram post shortcode
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function getInstagramThumbnailUrl(shortcode) {
  if (!shortcode) {
    return { success: false, error: 'Shortcode is required' };
  }
  
  const mediaUrl = `https://www.instagram.com/p/${shortcode}/media/?size=l`;
  
  try {
    
    // Fetch with redirect: 'follow' (default) to automatically follow redirects
    // The response.url will contain the final destination URL after all redirects
    const response = await fetch(mediaUrl, {
      method: 'GET',
      redirect: 'follow', // Follow redirects automatically (default behavior)
      // Add headers to mimic browser request
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
      }
    });
    
    // Check response status
    if (!response.ok) {
      // Handle 404 (post not found) or 403 (private post)
      if (response.status === 404) {
        return { success: false, error: 'Post not found (404)' };
      } else if (response.status === 403) {
        return { success: false, error: 'Access forbidden - post may be private (403)' };
      } else {
        return { success: false, error: `Unexpected status: ${response.status}` };
      }
    }
    
    // Get the final URL after all redirects
    // response.url contains the final destination URL
    const finalUrl = response.url;
    
    // Verify it's a CDN URL (scontent.cdninstagram.com or similar)
    if (finalUrl.includes('cdninstagram.com') || finalUrl.includes('fbcdn.net')) {
      return { success: true, url: finalUrl };
    } else {
      // If redirect didn't lead to CDN, return the final URL anyway
      return { success: true, url: finalUrl };
    }
  } catch (error) {
    return { 
      success: false, 
      error: error.message || 'Failed to fetch thumbnail URL' 
    };
  }
}

/**
 * Fetches both thumbnail URL and caption for an Instagram post
 * Combines thumbnail and caption extraction into a single function
 * 
 * @param {string} shortcode - Instagram post shortcode
 * @returns {Promise<{success: boolean, thumbnailUrl?: string, caption?: string, error?: string}>}
 */
async function getInstagramPostData(shortcode) {
  if (!shortcode) {
    return { success: false, error: 'Shortcode is required', postUrl: null };
  }
  const postUrl = `https://www.instagram.com/p/${encodeURIComponent(String(shortcode).trim())}/`;

  // Fetch both thumbnail and caption in parallel for better performance
  const [thumbnailResult, caption] = await Promise.all([
    getInstagramThumbnailUrl(shortcode),
    getInstagramPostCaption(shortcode)
  ]);
  
  if (thumbnailResult.success) {
    return {
      success: true,
      thumbnailUrl: thumbnailResult.url,
      caption: caption || null,
      postUrl,
    };
  } else {
    // Even if thumbnail fails, return caption if available
    return {
      success: false,
      error: thumbnailResult.error || 'Failed to fetch thumbnail',
      thumbnailUrl: null,
      caption: caption || null,
      postUrl,
    };
  }
}

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

  if (request.action === 'get-saved-urls') {
    sendResponse({ urls: _savedUrlsCache });
    return true;
  }

  if (request.action === 'get-server-status') {
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === 'capture-visible-tab') {
    chrome.tabs.captureVisibleTab(
      null,
      { format: 'jpeg', quality: 80 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, dataUrl });
        }
      }
    );
    return true;
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

  if (request.action === 'get-shortcut') {
    getCurrentShortcut().then((shortcut) => {
      sendResponse({ shortcut: shortcut || '' });
    });
    return true; // async
  }

  if (request.action === 'start-shortcut-polling') {
    stopShortcutPolling();
    getCurrentShortcut().then((baseline) => {
      _shortcutPollBaseline = baseline || '';
      const deadline = Date.now() + 60000; // 60 s max
      _shortcutPollTimer = setTimeout(() => runShortcutPoll(deadline), 800);
    }).catch(() => {});
    sendResponse({ success: true });
    return true;
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

  if (request.action === 'get-naver-cookies') {
    chrome.cookies.getAll({ domain: '.naver.com' }, (cookies) => {
      if (chrome.runtime.lastError || !cookies?.length) {
        sendResponse({ cookies: null });
      } else {
        sendResponse({
          cookies: cookies.map((c) => ({
            name:     c.name,
            value:    c.value,
            domain:   c.domain,
            path:     c.path,
            secure:   c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
          })),
        });
      }
    });
    return true; // keep channel open for async sendResponse
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

  // Handle metadata fetching request
  if (request.action === 'fetch-metadata') {
    const url = request.url;
    if (!url || typeof url !== 'string') {
      sendResponse({ success: false, error: 'Invalid URL' });
      return true;
    }

    // Fetch metadata asynchronously
    fetchMetadata(url)
      .then((metadata) => {
        sendResponse({
          success: true,
          title: metadata.title,
          description: metadata.description
        });
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error.message || 'Failed to fetch metadata'
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
  
  if (request.action === 'get-instagram-thumbnail') {
    // Handle async operation (legacy support)
    getInstagramThumbnailUrl(request.shortcode)
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        sendResponse({ 
          success: false, 
          error: error.message || 'Unknown error' 
        });
      });
    
    // Return true to indicate we will send a response asynchronously
    return true;
  }
  
  if (request.action === 'get-instagram-post-data') {
    // Handle async operation for combined thumbnail + caption
    getInstagramPostData(request.shortcode)
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        sendResponse({ 
          success: false, 
          error: error.message || 'Unknown error',
          thumbnailUrl: null,
          caption: null,
          postUrl: request?.shortcode
            ? `https://www.instagram.com/p/${encodeURIComponent(String(request.shortcode).trim())}/`
            : null,
        });
      });
    
    // Return true to indicate we will send a response asynchronously
    return true;
  }

  // Handle AI URL analysis request — proxies to localhost to bypass
  // Chrome's Private Network Access restriction from content scripts.
  if (request.action === 'ai-analyze-url') {
    const { url } = request;
    if (!url || typeof url !== 'string') {
      sendResponse({ success: false, error: 'Invalid payload' });
      return true;
    }
    fetch(`${KC_SERVER_URL}/api/v1/ai-analyze-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ success: false, error: `Server error ${res.status}` });
          return;
        }
        const data = await res.json();
        sendResponse({ success: true, data });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message || 'Failed to fetch' });
      });
    return true; // async response
  }

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