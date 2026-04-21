// Dock window JavaScript - Rebuilt from Figma designs
console.log('Dock script loaded');

// Track current user
let currentUser = null;
let authLoading = true;

// Track displayed items to avoid duplicates
let displayedItemIds = new Set();
let activeCardUrl = null;

// Global drag state tracking (simplified)
let globalDragState = {
  isActive: false,
  originalCard: null,
  mouseupFallback: null
};

// Global variable for currently dragged itemId (persists across windows)
window.currentDraggedItemId = null;
window.currentDraggedItemUrl = null;

// Check if electronAPI is available
function checkElectronAPI() {
  if (!window.electronAPI) {
    console.error('electronAPI not available');
    return false;
  }
  return true;
}

// Update auth UI based on user state
function updateAuthUI(user) {
  const signinBtn = document.getElementById('signin-btn');
  const headerProfile = document.getElementById('header-profile');
  const headerSocial = document.getElementById('header-social');
  const profileName = document.getElementById('profile-name');
  const profileEmail = document.getElementById('profile-email');
  const profileImage = document.getElementById('profile-image');
  const dockPlaceholder = document.getElementById('dock-placeholder');
  const dockFunction = document.getElementById('dock-function');
  const dockItemlist = document.getElementById('dock-itemlist');

  if (!signinBtn || !headerProfile || !headerSocial) {
    console.error('Auth UI elements not found');
    return;
  }

  if (authLoading) {
    // Show loading state on signin button
    signinBtn.classList.add('loading');
    signinBtn.textContent = 'loading';
    signinBtn.disabled = true;
    return;
  }

  // Hide loading state
  signinBtn.classList.remove('loading');
  signinBtn.disabled = false;

  if (user) {
    // User is signed in - show User state UI
    console.log('Updating UI: User signed in', user.email);
    signinBtn.style.display = 'none';
    headerProfile.classList.add('active');
    headerSocial.classList.add('active');
    
    if (profileName) {
      profileName.textContent = user.displayName || 'UserName';
    }
    if (profileEmail) {
      profileEmail.textContent = user.email || 'user@example.com';
    }
    if (profileImage && user.photoURL) {
      profileImage.style.backgroundImage = `url(${user.photoURL})`;
    }
    
    // Show function and itemlist sections
    if (dockPlaceholder) {
      dockPlaceholder.classList.add('hidden');
    }
    if (dockFunction) {
      dockFunction.classList.add('active');
    }
    if (dockItemlist) {
      dockItemlist.classList.add('active');
    }
    
    // Update Instagram UI
    updateInstagramUI(user.uid);
  } else {
    // User is signed out - show Default state UI
    console.log('Updating UI: User signed out');
    signinBtn.style.display = 'flex';
    signinBtn.textContent = 'Sign-In';
    headerProfile.classList.remove('active');
    headerSocial.classList.remove('active');
    
    // Show placeholder, hide function and itemlist
    if (dockPlaceholder) {
      dockPlaceholder.classList.remove('hidden');
    }
    if (dockFunction) {
      dockFunction.classList.remove('active');
    }
    if (dockItemlist) {
      dockItemlist.classList.remove('active');
      dockItemlist.innerHTML = '';
    }
  }
}

// Set up event listeners for auth buttons
function setupAuthEventListeners() {
  // Sign in button
  const signinBtn = document.getElementById('signin-btn');
  if (signinBtn) {
    signinBtn.addEventListener('click', async () => {
      if (!checkElectronAPI()) return;
      
      // Disable button during sign-in
      signinBtn.disabled = true;
      signinBtn.classList.add('loading');
      signinBtn.textContent = 'loading';
      
      try {
        const result = await window.electronAPI.auth.signInWithGoogle();
        
        if (!result.success) {
          console.error('Sign in error:', result.error);
          signinBtn.disabled = false;
          signinBtn.classList.remove('loading');
          signinBtn.textContent = 'Sign-In';
        }
        // If successful, the auth state change listener will update the UI
      } catch (error) {
        console.error('Sign in error:', error);
        signinBtn.disabled = false;
        signinBtn.classList.remove('loading');
        signinBtn.textContent = 'Sign-In';
      }
    });
  }
  

  // Instagram connect button (social-insta)
  const socialInsta = document.getElementById('social-insta');
  if (socialInsta) {
    socialInsta.addEventListener('click', async () => {
      if (!checkElectronAPI() || !currentUser) return;
      
      try {
        const result = await window.electronAPI.instagram.connect(currentUser.uid);
        
        if (result.success) {
          console.log('Instagram connected successfully');
          // Update Instagram UI
          await updateInstagramUI(currentUser.uid);
          // Show success message
          const username = result.username || 'your Instagram account';
          alert(`Instagram connected successfully!\n\nYour account ${username} is now connected.`);
        } else {
          console.error('Instagram connect error:', result.error);
          alert('Instagram connection failed: ' + (result.error || 'Unknown error'));
        }
      } catch (error) {
        console.error('Instagram connect error:', error);
        alert('Instagram connection failed: ' + error.message);
      }
    });
  }
}

// Update Instagram UI based on connection status
async function updateInstagramUI(userId) {
  if (!window.electronAPI || !window.electronAPI.instagram) return;
  
  const socialInsta = document.getElementById('social-insta');
  if (!socialInsta) return;
  
  try {
    const status = await window.electronAPI.instagram.getConnectionStatus(userId);
    
    // Load Instagram icon
    const instagramIconUrl = 'https://static.cdninstagram.com/rsrc.php/v3/yt/r/30PrGfR3xhB.png';
    socialInsta.innerHTML = `<img src="${instagramIconUrl}" alt="Instagram" />`;
    
    // Update tooltip based on connection status
    if (status.connected && !status.expired) {
      socialInsta.title = `Instagram connected: @${status.username || 'instagram_user'}`;
    } else if (status.connected && status.expired) {
      socialInsta.title = 'Instagram session expired - Click to reconnect';
    } else {
      socialInsta.title = 'Click to connect Instagram';
    }
  } catch (error) {
    console.error('Error checking Instagram status:', error);
    // Still show Instagram icon, just without status
    const instagramIconUrl = 'https://static.cdninstagram.com/rsrc.php/v3/yt/r/30PrGfR3xhB.png';
    socialInsta.innerHTML = `<img src="${instagramIconUrl}" alt="Instagram" />`;
    socialInsta.title = 'Click to connect Instagram';
  }
}

// Helper functions for data card rendering
function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return url.length > 50 ? url.substring(0, 50) + '...' : url;
  }
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname;
    
    // Remove www. prefix
    hostname = hostname.replace(/^www\./, '');
    
    // Extract root domain from subdomains
    const parts = hostname.split('.');
    
    // Common subdomain prefixes to remove
    const commonSubdomains = ['search', 'm', 'mobile', 'api', 'app', 'www', 'mail', 'drive', 'docs', 'maps', 'blog', 'shop', 'store', 'news', 'sports', 'finance', 'weather'];
    
    // If hostname has 3+ parts and first part is a common subdomain, remove it
    if (parts.length > 2 && commonSubdomains.includes(parts[0].toLowerCase())) {
      // Remove the subdomain prefix and join the rest
      hostname = parts.slice(1).join('.');
    } else if (parts.length > 2) {
      // For other cases with 3+ parts, use the last 2 parts (domain.tld)
      // Handle special cases like .co.uk, .com.au (use last 3 parts)
      const tldPatterns = ['co.uk', 'com.au', 'co.nz', 'co.za', 'com.br'];
      const lastTwo = parts.slice(-2).join('.');
      const lastThree = parts.slice(-3).join('.');
      
      if (tldPatterns.some(pattern => lastThree.endsWith('.' + pattern))) {
        hostname = lastThree;
      } else {
        hostname = lastTwo;
      }
    }
    
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`;
  } catch {
    // Fallback to default favicon if URL parsing fails
    return 'https://www.google.com/s2/favicons?domain=example.com&sz=64';
  }
}

function getSourceDomain(item) {
  if (item.domain) {
    if (item.domain.includes('.')) {
      return item.domain.replace('www.', '');
    }
    try {
      const testUrl = item.domain.startsWith('http') ? item.domain : `https://${item.domain}`;
      const urlObj = new URL(testUrl);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return item.domain.replace('www.', '');
    }
  }
  return formatUrl(item.url);
}

function getItemId(item) {
  return `${item.url}_${item.timestamp}`;
}

// Create DataCard component matching Figma design
function createDataCard(item) {
  // CRITICAL: Use Firestore document ID (item.id) for deletion, not the URL-based ID
  // item.id is the actual Firestore document ID (auto-generated, safe for paths)
  // getItemId(item) returns URL_timestamp which contains invalid characters for Firestore paths
  const itemId = item.id || getItemId(item); // Prefer Firestore doc ID, fallback to URL-based ID
  const cardId = `item-${itemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const escapedUrl = item.url.replace(/"/g, '&quot;');
  const type = item.type || 'webpage';
  
  // Determine display title
  const displayTitle = item.title || 'Untitled';
  const escapedTitle = displayTitle.replace(/"/g, '&quot;');
  
  // Get source domain for display
  const sourceDomain = getSourceDomain(item);
  const escapedSourceDomain = sourceDomain.replace(/"/g, '&quot;');
  
  // Get favicon URL - use item.url
  const faviconUrl = getFaviconUrl(item.url);
  
  // Format date
  const dateText = formatDate(item.timestamp);
  
  // Get image URL
  const imgUrl = item.img_url || '';
  const escapedImgUrl = imgUrl.replace(/"/g, '&quot;');
  
  const cardHtml = `
    <div id="${cardId}" 
         class="data-card"
         draggable="true"
         data-url="${escapedUrl}"
         data-title="${escapedTitle}"
         data-type="${type}"
         data-img-url="${escapedImgUrl}"
         data-item-id="${itemId}"
         data-doc-id="${item.id || ''}">
      <!-- Header: Domain and Date -->
      <div class="data-card-header">
        <div class="data-card-domain-section">
          <img src="${faviconUrl}" alt="${escapedSourceDomain}" class="data-card-favicon" onerror="this.style.display='none';">
          <div class="data-card-domain-text">${escapedSourceDomain}</div>
        </div>
        <div class="data-card-date-text">${dateText}</div>
      </div>
      
      <!-- Main: Image and Title -->
      <div class="data-card-main">
        ${imgUrl ? `
        <div class="data-card-imgcontainer">
          <img src="${escapedImgUrl}" alt="${escapedTitle}" class="data-card-image" onerror="this.style.display='none';">
        </div>
        ` : ''}
        <p class="data-card-title">${escapedTitle}</p>
      </div>
    </div>
  `;
  
  console.log('[DnD] Created DataCard:', {
    cardId,
    itemId,
    firestoreDocId: item.id || 'MISSING',
    url: escapedUrl.substring(0, 50) + (escapedUrl.length > 50 ? '...' : ''),
    draggable: 'true',
    hasItemId: !!itemId,
    hasFirestoreId: !!item.id
  });
  
  return cardHtml;
}

// Attach click handlers and drag handlers to all cards
function attachCardClickHandlers() {
  document.querySelectorAll('.data-card').forEach(card => {
    if (card.dataset.handlerAttached === 'true') {
      return;
    }
    
    // HARD-RESET LISTENERS: Clone and replace to ensure exactly ONE listener exists
    // This prevents duplicate listeners due to race conditions in loadData()
    const newCard = card.cloneNode(true);
    card.parentNode.replaceChild(newCard, card);
    
    // Track drag state to prevent click during drag
    let isDragging = false;
    
    // CLEAN MINIMAL dragstart handler - use currentTarget for reliable data extraction
    // currentTarget always refers to the element the listener is attached to (the card)
    newCard.addEventListener('dragstart', (e) => {
      // Use currentTarget instead of target - more reliable for delegated events
      const url = e.currentTarget.dataset.url || '';
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', url);
      e.dataTransfer.setData('text/uri-list', url);
    });
    
    // Drag end handler
    newCard.addEventListener('dragend', async (e) => {
      console.log('[DnD] ========== DRAG END ==========');
      console.log('[DnD] dropEffect:', e.dataTransfer.dropEffect);
      console.log('[DnD External] Final dropEffect (copy=external, move=internal):', e.dataTransfer.dropEffect);
      console.log('[DnD] window.currentDraggedItemId:', window.currentDraggedItemId);
      console.log('[DnD] isDragging:', isDragging);
      console.log('[DnD] globalDragState.isActive:', globalDragState.isActive);
      
      // DECOUPLE INTERNAL VS EXTERNAL LOGIC:
      // - If dropEffect is 'move', it was dropped in TrashZone (internal)
      // - If dropEffect is 'copy' or 'none', it was dropped externally or cancelled
      const wasInternalDrop = e.dataTransfer.dropEffect === 'move';
      const wasExternalDrop = e.dataTransfer.dropEffect === 'copy';
      console.log('[DnD] Drop type - Internal (TrashZone):', wasInternalDrop, 'External:', wasExternalDrop);
      
      try {
        // Cleanup drag state immediately (works for both internal and external drops)
        await cleanupDragState();
        console.log('[DnD] Cleanup completed');
        
        // Clean up TrashZone drag-over class (only relevant for internal drops)
        const trashZone = document.getElementById('trash-zone');
        if (trashZone) {
          trashZone.classList.remove('drag-over');
          console.log('[DnD] Removed drag-over from trash zone');
        }
        
        // DECOUPLE CLEANUP: Ensure global ID is cleared regardless of drop location
        // This prevents stale data from affecting future drag operations
        window.currentDraggedItemId = null;
        window.currentDraggedItemUrl = null;
        console.log('[DnD] Cleared global dragged item ID/URL (internal and external cleanup)');
        
        // Reset drag state after a short delay to prevent accidental clicks
        setTimeout(() => {
          isDragging = false;
          console.log('[DnD] Reset isDragging to false');
        }, 100);
        
        console.log('[DnD] ========== DRAG END COMPLETE ==========');
      } catch (error) {
        console.error('[DnD] ERROR in dragend handler:', error);
        // Ensure drag state is reset even on error
        isDragging = false;
        if (newCard) {
          newCard.classList.remove('is-dragging');
          newCard.classList.remove('dragging'); // Remove old class if present
          newCard.style.pointerEvents = '';
        }
        // Clean up TrashZone drag-over class
        const trashZone = document.getElementById('trash-zone');
        if (trashZone) {
          trashZone.classList.remove('drag-over');
        }
        // Attempt cleanup even on error
        try {
          await cleanupDragState();
        } catch (cleanupError) {
          console.error('[DnD] Error during cleanup:', cleanupError);
        }
      }
    });
    
    // Click handler (only if not dragging)
    newCard.addEventListener('click', async (e) => {
      // Prevent click if we just finished dragging
      if (isDragging) {
        return;
      }
      
      const url = newCard.dataset.url;
      const title = newCard.dataset.title;
      
      if (!url) return;
      
      // Update active card state
      document.querySelectorAll('.data-card').forEach(c => {
        c.classList.remove('active');
      });
      newCard.classList.add('active');
      activeCardUrl = url;
      
      // Open URL in user's default browser
      if (checkElectronAPI() && window.electronAPI.shell) {
        try {
          await window.electronAPI.shell.openExternal(url);
        } catch (error) {
          console.error('Failed to open URL in external browser:', error);
          // Fallback to window.open if electronAPI fails
          window.open(url, '_blank');
        }
      } else {
        // Fallback to window.open if electronAPI is not available
      window.open(url, '_blank');
      }
    });
    
    newCard.dataset.handlerAttached = 'true';
  });
}

// Cleanup drag state (simplified)
async function cleanupDragState() {
  if (!globalDragState.isActive) {
    return;
  }
  
  // Restore pointer events on original card and remove CSS classes
  if (globalDragState.originalCard) {
    globalDragState.originalCard.classList.remove('dragging');
    globalDragState.originalCard.style.pointerEvents = '';
  }
  
  // Remove mouseup fallback listener
  if (globalDragState.mouseupFallback) {
    window.removeEventListener('mouseup', globalDragState.mouseupFallback, { capture: true });
  }
  
  // Clear global dragged item variables
  window.currentDraggedItemId = null;
  window.currentDraggedItemUrl = null;
  
  // Reset global drag state
  globalDragState = {
    isActive: false,
    originalCard: null,
    mouseupFallback: null
  };
}

// Delete a single item by itemId (should be Firestore document ID)
async function deleteItem(itemId) {
  if (!checkElectronAPI() || !currentUser) {
    console.error('[DeleteItem] Cannot delete: API not available or user not signed in');
    return false;
  }
  
  // CRITICAL: Sanitize the itemId to ensure it's safe for Firestore paths
  // If itemId contains invalid characters (like //, :, etc.), it will cause "Invalid segment" error
  // Firestore document IDs must not contain: /, \, ?, #, [, ], *, ", ', `, |, <, >, {, }, or control characters
  let sanitizedId = itemId;
  
  // Check if itemId looks like a URL (contains :// or starts with http)
  if (itemId.includes('://') || itemId.startsWith('http')) {
    console.error('[DeleteItem] ERROR: itemId appears to be a URL, not a Firestore document ID:', itemId);
    console.error('[DeleteItem] This will cause "Invalid segment" error. Looking for data-doc-id attribute...');
    
    // Try to find the card and get the actual Firestore document ID
    const card = document.querySelector(`[data-item-id="${itemId}"]`);
    if (card && card.dataset.docId) {
      sanitizedId = card.dataset.docId;
      console.log('[DeleteItem] Found Firestore document ID from data-doc-id:', sanitizedId);
    } else {
      console.error('[DeleteItem] ERROR: No data-doc-id found on card. Cannot delete with URL-based ID.');
      return false;
    }
  }
  
  // Final sanitization: Remove any remaining invalid characters
  // Firestore document IDs should only contain alphanumeric, hyphens, and underscores
  const finalId = sanitizedId.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  if (finalId !== sanitizedId) {
    console.warn('[DeleteItem] Sanitized ID:', sanitizedId, '->', finalId);
  }
  
  console.log('[DeleteItem] Attempting to delete with ID:', finalId);
  console.log('[DeleteItem] Original itemId:', itemId);
  
  try {
    const result = await window.electronAPI.firestore.deleteData(finalId, currentUser.uid);
    if (result.success) {
      console.log('[DeleteItem] ✅ Item deleted successfully:', finalId);
      return true;
    } else {
      console.error('[DeleteItem] ❌ Delete item error:', result.error);
      return false;
    }
  } catch (error) {
    console.error('[DeleteItem] ❌ Delete item exception:', error);
    console.error('[DeleteItem] Error details:', {
      originalItemId: itemId,
      sanitizedId: sanitizedId,
      finalId: finalId,
      errorMessage: error.message
    });
    return false;
  }
}

// Setup trash zone drag and drop handlers - simplified, no retry loops
function setupTrashZone() {
  console.log('[DnD] ========== SETUP TRASH ZONE ==========');
  const trashZone = document.getElementById('trash-zone');
  if (!trashZone) {
    // STOP THE LOOP: Log once and return - do not retry
    console.error('[DnD] ERROR: Trash zone element with id "trash-zone" not found! Make sure the DOM is fully loaded.');
    return;
  }
  
  console.log('[DnD] Trash zone element found:', trashZone);
  console.log('[DnD] Trash zone ID:', trashZone.id);
  console.log('[DnD] Trash zone className:', trashZone.className);
  console.log('[DnD] Trash zone computed style display:', window.getComputedStyle(trashZone).display);
  console.log('[DnD] Trash zone computed style pointer-events:', window.getComputedStyle(trashZone).pointerEvents);
  console.log('[DnD] Trash zone computed style z-index:', window.getComputedStyle(trashZone).zIndex);
  
  // Prevent duplicate event listeners
  if (trashZone.dataset.handlersAttached === 'true') {
    console.warn('[DnD] Trash zone handlers already attached, skipping');
    return;
  }
  trashZone.dataset.handlersAttached = 'true';
  console.log('[DnD] Attaching event listeners to trash zone');
  
  // CRITICAL: Ensure trash zone is never blocked by pointer-events
  // Force pointer-events to auto to guarantee it can receive drop events
  trashZone.style.pointerEvents = 'auto';
  console.log('[DnD] Forced pointer-events: auto on trash zone');
  
  // dragover handler - preventDefault must be the very first line
  trashZone.addEventListener('dragover', (e) => {
    console.log('[DnD] [TrashZone] dragover event fired');
    console.log('[DnD] [TrashZone] Event target:', e.target);
    console.log('[DnD] [TrashZone] window.currentDraggedItemId:', window.currentDraggedItemId);
    console.log('[DnD] [TrashZone] dataTransfer.types:', Array.from(e.dataTransfer.types));
    
    e.preventDefault(); // MUST be first line - explicitly signal valid drop zone
    e.stopPropagation();
    
    // Check if this is a DataCard being dragged
    const hasDataCardData = window.currentDraggedItemId !== null ||
                           e.dataTransfer.types.includes('text/plain');
    
    console.log('[DnD] [TrashZone] hasDataCardData:', hasDataCardData);
    
    if (hasDataCardData) {
      // Explicitly set drop effect to 'move' for trash zone
      e.dataTransfer.dropEffect = 'move';
      trashZone.classList.add('drag-over');
      console.log('[DnD] [TrashZone] Set dropEffect to "move", added drag-over class');
    } else {
      e.dataTransfer.dropEffect = 'none';
      console.log('[DnD] [TrashZone] Set dropEffect to "none"');
    }
  });
  
  // REMOVED: Global document dragover handler
  // REASON: preventDefault() on document interferes with Notion's own hit-testing
  // Internal components like TrashZone already have their own dragover handlers
  // External apps do not need the renderer to call preventDefault()
  
  trashZone.addEventListener('dragenter', (e) => {
    console.log('[DnD] [TrashZone] dragenter event fired');
    console.log('[DnD] [TrashZone] Event target:', e.target);
    console.log('[DnD] [TrashZone] window.currentDraggedItemId:', window.currentDraggedItemId);
    console.log('[DnD] [TrashZone] dataTransfer.types:', Array.from(e.dataTransfer.types));
    
    e.preventDefault();
    e.stopPropagation();
    
    // Check if this is a DataCard being dragged
    const hasDataCardData = e.dataTransfer.types.includes('application/x-datacard-id') ||
                           e.dataTransfer.types.includes('application/x-datacard-url') ||
                           window.currentDraggedItemId !== null ||
                           window.currentDraggedItemUrl !== null;
    
    console.log('[DnD] [TrashZone] hasDataCardData:', hasDataCardData);
    
    if (hasDataCardData) {
      trashZone.classList.add('drag-over');
      console.log('[DnD] [TrashZone] Added drag-over class');
    }
  });
  
  trashZone.addEventListener('dragleave', (e) => {
    console.log('[DnD] [TrashZone] dragleave event fired');
    console.log('[DnD] [TrashZone] Event target:', e.target);
    console.log('[DnD] [TrashZone] clientX:', e.clientX, 'clientY:', e.clientY);
    
    e.preventDefault();
    e.stopPropagation();
    
    // Only remove drag-over if we're actually leaving the trash zone
    // (not just moving to a child element)
    const rect = trashZone.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    console.log('[DnD] [TrashZone] Trash zone rect:', rect);
    console.log('[DnD] [TrashZone] Cursor position:', { x, y });
    
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      trashZone.classList.remove('drag-over');
      console.log('[DnD] [TrashZone] Removed drag-over class (cursor left trash zone)');
    } else {
      console.log('[DnD] [TrashZone] Cursor still within trash zone, keeping drag-over');
    }
  });
  
  trashZone.addEventListener('drop', async (e) => {
    console.log('[DnD] ========== TRASH ZONE DROP ==========');
    console.log('[DnD] [TrashZone] drop event fired');
    console.log('[DnD] [TrashZone] Event target:', e.target);
    console.log('[DnD] [TrashZone] Event currentTarget:', e.currentTarget);
    console.log('[DnD] [TrashZone] dataTransfer.types:', Array.from(e.dataTransfer.types));
    console.log('[DnD] [TrashZone] dataTransfer.dropEffect:', e.dataTransfer.dropEffect);
    
    e.preventDefault();
    e.stopPropagation();
    
    // Always remove drag-over visual highlight immediately
    trashZone.classList.remove('drag-over');
    console.log('[DnD] [TrashZone] Removed drag-over class');
    
    try {
      // GUARANTEED DROP DATA: Use window.currentDraggedItemId directly (confirmed to be set correctly)
      // Do NOT check dataTransfer again - use global variable immediately
      const itemId = window.currentDraggedItemId;
      
      console.log('[DnD] [TrashZone] window.currentDraggedItemId:', itemId);
      
      // Final check log
      console.log('[DnD] [TrashZone] FINAL CHECK - Item ID:', itemId || 'NULL');
      
      if (!itemId) {
        // Not a DataCard drop, ignore
        console.warn('[DnD] [TrashZone] ERROR: window.currentDraggedItemId is null, ignoring drop');
        return;
      }
      
      console.log('[DnD] [TrashZone] Using itemId:', itemId);
      
      // FIX DELETION ERROR: Use data-doc-id directly to find the card
      // window.currentDraggedItemId is already set to docId in dragstart, but verify it's valid
      let docIdForDeletion = itemId;
      
      // Find the card element using data-doc-id (more reliable than data-item-id)
      const card = document.querySelector(`[data-doc-id="${itemId}"]`) || 
                   document.querySelector(`[data-item-id="${itemId}"]`);
      console.log('[DnD] [TrashZone] Card element found:', card ? 'YES' : 'NO');
      if (card) {
        console.log('[DnD] [TrashZone] Card element ID:', card.id);
        console.log('[DnD] [TrashZone] Card data-item-id:', card.dataset.itemId);
        console.log('[DnD] [TrashZone] Card data-doc-id:', card.dataset.docId);
        
        // CRITICAL: Use Firestore document ID (data-doc-id) for deletion, not URL-based itemId
        // This prevents "Invalid segment" errors
        if (card.dataset.docId) {
          docIdForDeletion = card.dataset.docId;
          console.log('[DnD] [TrashZone] Using Firestore document ID from data-doc-id:', docIdForDeletion);
        } else {
          console.warn('[DnD] [TrashZone] WARNING: No data-doc-id found, using itemId (may cause errors if it contains invalid characters):', itemId);
        }
      } else {
        // If card not found, itemId should already be the docId (set in dragstart)
        console.log('[DnD] [TrashZone] Card not found, using itemId directly (should be docId):', itemId);
      }
      
      // RESOLVE DELETION 'INVALID SEGMENT': Strictly sanitize ID before deletion
      // Extract last segment and remove all invalid characters
      let safeId = docIdForDeletion;
      
      // If it looks like a URL or path, extract the last segment
      if (docIdForDeletion.includes('/')) {
        safeId = docIdForDeletion.split('/').pop() || docIdForDeletion;
        console.log('[DnD] [TrashZone] Extracted last segment from path:', safeId);
      }
      
      // Remove all invalid characters (keep only alphanumeric, hyphens, underscores)
      safeId = safeId.replace(/[^a-zA-Z0-9_-]/g, '');
      
      // Final validation: ensure it's not empty and not a URL
      if (!safeId || safeId.includes('://') || safeId.startsWith('http')) {
        console.error('[DnD] [TrashZone] ERROR: Sanitized ID is invalid or appears to be a URL:', safeId);
        console.error('[DnD] [TrashZone] Original docIdForDeletion:', docIdForDeletion);
        console.error('[DnD] [TrashZone] Cannot delete with invalid ID. Aborting deletion.');
        return;
      }
      
      console.log('[DnD] [TrashZone] Original ID:', docIdForDeletion);
      console.log('[DnD] [TrashZone] Sanitized safe ID:', safeId);
      
      // Delete the item FIRST (before animation) to ensure we have the correct ID
      console.log('[DnD] [TrashZone] Calling deleteItem with sanitized safeId:', safeId);
      const success = await deleteItem(safeId);
      
      if (success) {
        console.log('[DnD] [TrashZone] ✅ Item deleted successfully:', docIdForDeletion);
        
        // Only animate fade-out AFTER successful deletion
        if (card) {
          card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
          card.style.opacity = '0';
          card.style.transform = 'scale(0.8)';
          console.log('[DnD] [TrashZone] Started fade-out animation after successful deletion');
          
          // Wait for animation to complete
          await new Promise(resolve => setTimeout(resolve, 300));
          console.log('[DnD] [TrashZone] Animation completed');
        }
        // The Firestore listener will automatically update the UI
      } else {
        console.error('[DnD] [TrashZone] ❌ Failed to delete item:', docIdForDeletion);
        // Do NOT animate if deletion failed - card should remain visible
        console.log('[DnD] [TrashZone] Card remains visible due to deletion failure');
      }
      
      console.log('[DnD] ========== TRASH ZONE DROP COMPLETE ==========');
    } catch (error) {
      console.error('[DnD] [TrashZone] ERROR in drop handler:', error);
      console.error('[DnD] [TrashZone] Error stack:', error.stack);
      // Ensure drag-over is removed even on error
      trashZone.classList.remove('drag-over');
    }
  });
  
  console.log('[DnD] ========== SETUP TRASH ZONE COMPLETE ==========');
}

// Firestore listener management
let firestoreUnsubscribe = null;

function startFirestoreListener(userId) {
  if (!checkElectronAPI()) return;
  
  // Stop existing listener if any
  stopFirestoreListener();
  
  // Start new listener
  firestoreUnsubscribe = window.electronAPI.firestore.watchDatasByUser(userId, (items) => {
    console.log('Firestore data changed, received items:', items.length);
    loadData(true);
  });
  
  console.log('Firestore listener started for user:', userId);
}

function stopFirestoreListener() {
  if (firestoreUnsubscribe) {
    firestoreUnsubscribe();
    firestoreUnsubscribe = null;
    console.log('Firestore listener stopped');
  }
}

// Load data from Firestore
async function loadData(forceRefresh = false) {
  if (!currentUser) {
    console.log('No user signed in, skipping data load');
    return;
  }
  
  const dockItemlist = document.getElementById('dock-itemlist');
  
  if (!dockItemlist) return;
  
  try {
    // Get data from Firestore
    const items = await window.electronAPI.firestore.getDatasByUser(currentUser.uid);
    
    console.log('Loaded items from Firestore:', items.length);
    
    if (items.length === 0) {
      // No items - clear list
      dockItemlist.innerHTML = '';
    } else {
      // Has items - render them
      // Sort by timestamp (newest first)
      const sortedData = [...items].sort((a, b) => b.timestamp - a.timestamp);
      
      if (forceRefresh || displayedItemIds.size === 0) {
        // Full refresh - clear and rebuild
        displayedItemIds.clear();
        dockItemlist.innerHTML = '';
        
        // Render all items
        sortedData.forEach(item => {
          const itemId = getItemId(item);
          const cardHtml = createDataCard(item);
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = cardHtml.trim();
          const card = tempDiv.firstChild;
          dockItemlist.appendChild(card);
          displayedItemIds.add(itemId);
          card.dataset.handlerAttached = 'false';
        });
        
        // Attach click handlers
        attachCardClickHandlers();
      }
    }
  } catch (err) {
    console.error('Failed to load data:', err);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

function initialize() {
  console.log('Dock: Initializing...');
  
  // Set up auth state change listener
  if (checkElectronAPI() && window.electronAPI.auth.onAuthStateChanged) {
    window.electronAPI.auth.onAuthStateChanged((user) => {
      console.log('Auth state changed:', user ? user.email : 'signed out');
      currentUser = user;
      authLoading = false;
      updateAuthUI(user);
      
      // Start Firestore listener and load data after getting initial auth state (only if signed in)
      if (user) {
        startFirestoreListener(user.uid);
        loadData(true);
      } else {
        // Clear itemlist when not signed in
        const dockItemlist = document.getElementById('dock-itemlist');
        if (dockItemlist) {
          dockItemlist.innerHTML = '';
        }
      }
    });
  }

  // Get initial auth state
  if (checkElectronAPI()) {
    window.electronAPI.auth.getCurrentUser().then((user) => {
      currentUser = user;
      authLoading = false;
      updateAuthUI(user);
      // Start Firestore listener and load data after getting initial auth state (only if signed in)
      if (user) {
        startFirestoreListener(user.uid);
        loadData(true);
      } else {
        // Clear itemlist when not signed in
        const dockItemlist = document.getElementById('dock-itemlist');
        if (dockItemlist) {
          dockItemlist.innerHTML = '';
        }
      }
    });
  }

  // Set up event listeners
  setupAuthEventListeners();
  
  // Set up trash zone drag and drop (only after DOM is ready)
  setupTrashZone();
}

// Ensure setupTrashZone only runs once after DOM is fully loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // setupTrashZone is already called in initialize(), but ensure it's called if initialize hasn't run yet
    if (!document.getElementById('trash-zone')) {
      console.warn('Trash zone not found during DOMContentLoaded');
    }
  });
}