// Dashboard - Firestore, DnD, directories (user is always authenticated)
console.log('=== main.js (Dashboard) SCRIPT LOADED ===');

// Track displayed items to avoid duplicates
let displayedItemIds = new Set();
let activeCardUrl = null;

// ========== GLOBAL DRAG STATE ==========
// Global drag state to prevent conflicts between DnD and click handlers
let isDragging = false;
let lastDragEndTime = 0;
// Flag to prevent Firestore listener from triggering loadData during active sync
let isSyncing = false;
// Track if there's a valid drop indicator (prevents snap-to-end on invalid drops)
let hasValidDropIndicator = false;
// Hover-to-expand timer for collapsed directories
let directoryHoverTimer = null;
let hoveredDirectoryItem = null;

// Format URL for display (domain only)
function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return url.length > 50 ? url.substring(0, 50) + '...' : url;
  }
}

// Format relative time for recent items
function formatRelativeTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  
  if (diffMins < 1) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }
  return null; // Not recent enough for relative time
}

// Format date for timeline header (WhatsApp-style)
function formatTimelineDate(timestamp) {
  // Check if it's recent enough for relative time (within last hour)
  const relativeTime = formatRelativeTime(timestamp);
  if (relativeTime) {
    return relativeTime;
  }
  
  // Otherwise, show day-based grouping
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  
  if (itemDate.getTime() === today.getTime()) {
    return 'Today';
  } else if (itemDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  } else {
    // Format as "Month Day, Year" or localized date
    return date.toLocaleDateString('en-US', { 
      month: 'long', 
      day: 'numeric', 
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined 
    });
  }
}

// Get grouping key for timeline
// For recent items (< 1 hour), group by minute bucket
// For older items, group by day
function getTimelineKey(timestamp) {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  
  // For items within the last hour, create minute-based buckets
  // Group items saved at similar times together (within same minute or small window)
  if (diffMins < 60) {
    // Use minute as the bucket - items within the same minute window will be grouped
    // This allows headers like "Just now", "3 minutes ago", "15 minutes ago"
    return `recent-${diffMins}m`;
  }
  
  // For older items (1+ hours), group by day
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Get date key for grouping (YYYY-MM-DD format) - for comparison
function getDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Group items by timeline key (recent items by time, older by date)
function groupByTimeline(data) {
  const grouped = {};
  data.forEach(item => {
    const timelineKey = getTimelineKey(item.timestamp);
    if (!grouped[timelineKey]) {
      grouped[timelineKey] = {
        date: item.timestamp, // Use first item's timestamp for the header
        items: []
      };
    }
    grouped[timelineKey].items.push(item);
  });
  return grouped;
}

// Get favicon URL for a domain (using Google's favicon service)
function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace('www.', '');
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  } catch {
    return 'https://www.google.com/s2/favicons?domain=example.com&sz=64';
  }
}

// Get source domain for display (from domain field or URL)
function getSourceDomain(item) {
  if (item.domain) {
    // If domain is a domain-like string, use it directly
    if (item.domain.includes('.')) {
      return item.domain.replace('www.', '');
    }
    // If domain doesn't have a dot, it might be a domain without protocol
    // Try to construct a URL from it
    try {
      const testUrl = item.domain.startsWith('http') ? item.domain : `https://${item.domain}`;
      const urlObj = new URL(testUrl);
      return urlObj.hostname.replace('www.', '');
    } catch {
      // If URL parsing fails, return domain as-is
      return item.domain.replace('www.', '');
    }
  }
  return formatUrl(item.url);
}

// Get type icon SVG for different types
function getTypeIconSVG(type) {
  const iconSize = '10px';
  const iconColor = 'rgba(0, 0, 0, 0.2)';
  
  const icons = {
    webpage: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 3C1 2.44772 1.44772 2 2 2H14C14.5523 2 15 2.44772 15 3V13C15 13.5523 14.5523 14 14 14H2C1.44772 14 1 13.5523 1 13V3Z" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M1 5H15" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="3.5" cy="3.5" r="0.5" fill="${iconColor}"/>
      <circle cx="5.5" cy="3.5" r="0.5" fill="${iconColor}"/>
      <circle cx="7.5" cy="3.5" r="0.5" fill="${iconColor}"/>
    </svg>`,
    translation: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2V14M2 8H14" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M3 5L8 2L13 5M3 11L8 14L13 11" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    calculation: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="2" width="10" height="12" rx="1" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 5H10M6 8H10M6 11H10" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
    search: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="4" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M11 11L14 14" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    converter: `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 4L6 8L2 12M14 4L10 8L14 12" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8 2V14" stroke="${iconColor}" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`
  };
  
  return icons[type] || icons.webpage; // Default to webpage icon
}

// Create item ID from URL and timestamp
function getItemId(item) {
  return `${item.url}_${item.timestamp}`;
}

// Create timeline date header
function createTimelineHeader(timestamp) {
  const dateLabel = formatTimelineDate(timestamp);
  return `
    <div class="timeline-header flex items-center gap-[var(--space-200)] px-[var(--space-200)] py-[var(--space-200)]">
      <div class="flex-1 h-px bg-[var(--border-default)]"></div>
      <span class="text-title-small text-[var(--text-secondary)] whitespace-nowrap">${dateLabel}</span>
      <div class="flex-1 h-px bg-[var(--border-default)]"></div>
    </div>
  `;
}

// Create a card-wrapper element with a data-card inside
// This ensures consistent structure for all items
function createCardElement(item, isNew = false) {
  const itemId = getItemId(item);
  const cardHtml = createDataCard(item, isNew);
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = cardHtml.trim();
  const card = tempDiv.firstChild;
  
  // Ensure all data attributes are set on the card element
  if (!card.dataset.itemId) {
    card.dataset.itemId = itemId;
  }
  if (!card.dataset.url) {
    card.dataset.url = item.url;
  }
  if (!card.dataset.title) {
    card.dataset.title = item.title || 'Untitled';
  }
  if (!card.dataset.type) {
    card.dataset.type = item.type || 'webpage';
  }
  if (item.directoryId && item.directoryId !== 'undefined') {
    card.dataset.directoryId = item.directoryId;
  }
  
  // Always wrap card in card-wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'card-wrapper';
  wrapper.style.cssText = `
    overflow: hidden;
    transition: height 0.3s cubic-bezier(0.2, 0, 0, 1), opacity 0.3s ease;
  `;
  
  wrapper.appendChild(card);
  
  // Wrap card-wrapper in card-container for animation
  const container = document.createElement('div');
  container.className = 'card-container';
  
  if (isNew) {
    // Phase 1: initial state — container collapsed, card scaled to 0, invisible
    container.style.height = '0px';
    container.style.overflow = 'hidden';
    wrapper.style.transform = 'scale(0)';
    wrapper.style.transformOrigin = 'top center';
    wrapper.style.opacity = '0';
  }
  
  container.appendChild(wrapper);
  return { container, wrapper, card };
}

// Create DataCard matching Figma design
function createDataCard(item, isNew = false) {
  const itemId = getItemId(item);
  const cardId = `item-${itemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const escapedUrl = item.url.replace(/"/g, '&quot;');
  const animationClass = isNew ? 'animate-in' : '';
  const type = item.type || 'webpage';
  
  // Determine display title
  const displayTitle = item.title || 'Untitled';
  const escapedTitle = displayTitle.replace(/"/g, '&quot;');
  
  // Escape data for data attributes
  
  // Get source domain for display
  const sourceDomain = getSourceDomain(item);
  const escapedSourceDomain = sourceDomain.replace(/"/g, '&quot;');
  
  // Render different card structure for image vs non-image types
  if (type === 'image' && item.img_url) {
    // Image type: use new Figma design
    const imageSrc = item.img_url;
    const typeIcon = getTypeIconSVG(type);
    const escapedType = type.replace(/"/g, '&quot;');
    // Get source domain for display
    const sourceDomain = getSourceDomain(item);
    const escapedSourceDomain = sourceDomain.replace(/"/g, '&quot;');
    
    const directoryId = item.directoryId && item.directoryId !== 'undefined' ? item.directoryId : '';
    return `
      <div id="${cardId}" 
           class="data-card data-card-image bg-white border border-[var(--border-default)] flex flex-col gap-[var(--space-150)] items-start overflow-hidden px-[var(--space-200)] py-[var(--space-150)] rounded-[4px] ${animationClass}"
           data-url="${escapedUrl}"
           data-title="${escapedTitle}"
           data-type="${type}"
           data-img-url="${(item.img_url || '').replace(/"/g, '&quot;')}"
           data-directory-id="${directoryId}"
           draggable="true">
        <!-- Header: Icon and Type -->
        <div class="data-card-header flex gap-[var(--space-50)] items-center shrink-0 w-full">
          <div class="data-card-icon flex items-center" style="aspect-ratio: 1 / 1; height: 10px;">
            ${typeIcon}
          </div>
          <div class="text-[10px] font-medium leading-[1.3] text-[var(--text-secondary)] tracking-[0.1px]" style="font-family: 'Roboto', sans-serif; font-variation-settings: 'wdth' 100;">
            ${escapedType}
          </div>
        </div>
        <!-- Main: Image and Preview -->
        <div class="data-card-main flex flex-col gap-[var(--space-150)] items-start shrink-0 w-full">
          <!-- Image -->
          <div class="data-card-image-container shrink-0 w-full">
            <img src="${imageSrc}" 
                 alt="${escapedTitle}" 
                 class="data-card-image-img"
                 onerror="this.style.display='none';">
          </div>
          <!-- Preview: Infos and Hint -->
          <div class="data-card-preview flex flex-col gap-[4px] items-start justify-center shrink-0 w-full">
            <!-- Infos: Title and Source -->
            <div class="data-card-infos flex flex-col items-start shrink-0 w-full tracking-[0.1px]">
              <p class="data-card-title-truncate text-title-small-bold text-black leading-[20px] relative shrink-0" style="font-size: 14px; font-family: 'Roboto', sans-serif; font-weight: 600; font-variation-settings: 'wdth' 100;">
                ${escapedTitle}
              </p>
              <p class="text-[10px] font-medium leading-[1.3] text-[var(--text-secondary)] relative shrink-0" style="font-family: 'Roboto', sans-serif; font-variation-settings: 'wdth' 100; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">
                ${escapedSourceDomain}
              </p>
            </div>
            <!-- Click hint -->
            <p class="text-[10px] font-normal leading-[1.2] text-[var(--text-secondary)] relative shrink-0 tracking-[0.1px]" style="font-family: 'Roboto', 'Noto Sans Symbols', sans-serif; font-variation-settings: 'wdth' 100; white-space: nowrap;">
              → click to see this data
            </p>
          </div>
        </div>
      </div>
    `;
  } else {
    // Non-image types: use new Figma design
    // Determine logo URL: use domain if it's a valid domain, otherwise use URL
    let logoUrl;
    if (item.domain && item.domain.includes('.')) {
      logoUrl = getFaviconUrl(`https://${item.domain}`);
    } else {
      logoUrl = getFaviconUrl(item.url);
    }
    const typeIcon = getTypeIconSVG(type);
    const escapedType = type.replace(/"/g, '&quot;');
    
    const directoryId = item.directoryId && item.directoryId !== 'undefined' ? item.directoryId : '';
    return `
      <div id="${cardId}" 
           class="data-card data-card-other bg-white border border-[var(--border-default)] flex flex-col gap-[var(--space-150)] items-start overflow-hidden px-[var(--space-200)] py-[var(--space-150)] rounded-[4px] ${animationClass}"
           data-url="${escapedUrl}"
           data-title="${escapedTitle}"
           data-type="${type}"
           data-img-url="${(item.img_url || '').replace(/"/g, '&quot;')}">
        <!-- Header: Icon and Type -->
        <div class="data-card-header flex gap-[var(--space-50)] items-center shrink-0 w-full">
          <div class="data-card-icon flex items-center" style="aspect-ratio: 1 / 1; height: 10px;">
            ${typeIcon}
          </div>
          <div class="text-[10px] font-medium leading-[1.3] text-[var(--text-secondary)] tracking-[0.1px]" style="font-family: 'Roboto', sans-serif; font-variation-settings: 'wdth' 100;">
            ${escapedType}
          </div>
        </div>
        <!-- Main: Preview and Hint -->
        <div class="data-card-main flex flex-col gap-[var(--space-150)] items-start shrink-0 w-full">
          <!-- Preview: Logo and Infos -->
          <div class="data-card-preview flex gap-[var(--space-100)] items-start shrink-0 w-full" style="height: 33px;">
            <!-- Logo -->
            <div class="data-card-logo">
              <img src="${logoUrl}" 
                   alt="${escapedSourceDomain} logo" 
                   class="data-card-logo-image"
                   onerror="this.style.display='none';">
            </div>
            <!-- Infos: Title and Source -->
            <div class="data-card-infos flex flex-col items-start shrink-0 tracking-[0.1px]">
              <p class="data-card-title-truncate text-title-small-bold text-black leading-[20px] relative shrink-0" style="font-size: 14px; font-family: 'Roboto', sans-serif; font-weight: 600; font-variation-settings: 'wdth' 100;">
                ${escapedTitle}
              </p>
              <p class="text-[10px] font-medium leading-[1.3] text-[var(--text-secondary)] relative shrink-0" style="font-family: 'Roboto', sans-serif; font-variation-settings: 'wdth' 100; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">
                ${escapedSourceDomain}
              </p>
            </div>
          </div>
          <!-- Click hint -->
          <p class="text-[10px] font-normal leading-[1.2] text-[var(--text-secondary)] relative shrink-0 tracking-[0.1px]" style="font-family: 'Roboto', 'Noto Sans Symbols', sans-serif; font-variation-settings: 'wdth' 100; white-space: nowrap;">
            → click to see this data
          </p>
        </div>
      </div>
    `;
  }
}

// ========== REMOVED: Legacy API-based loadData (dead code) ==========
// This function has been removed to prevent duplicate event listeners.
// All click and drag handlers are now consolidated in the unified attachCardClickHandlers() function below.

// Browser Tab Functions
function openBrowserTab(url, title, type, imgUrl, toolType = '', toolInput = '', toolOutput = '') {
  const browserTab = document.getElementById('browser-tab');
  const browserTabTitle = document.getElementById('browser-tab-title');
  const browserTabNavBtn = document.getElementById('browser-tab-nav-btn');
  const browserTabNavIconNext = document.getElementById('browser-tab-nav-icon-next');
  const browserTabNavIconPrevious = document.getElementById('browser-tab-nav-icon-previous');
  const browserTabDetail = document.getElementById('browser-tab-detail');
  const browserTabImageSection = document.getElementById('browser-tab-image-section');
  const browserTabBrowserSection = document.getElementById('browser-tab-browser-section');
  const browserTabWebview = document.getElementById('browser-tab-webview');
  const browserTabImageSrc = document.getElementById('browser-tab-image-src');
  const browserTabFallback = document.getElementById('browser-tab-fallback');
  const browserTabFallbackLink = document.getElementById('browser-tab-fallback-link');
  
  if (!browserTab || !browserTabTitle) return;

  // Update browser tab title - include tool info if present
  if (toolType && toolInput) {
    let titleText = title || url;
    if (toolOutput) {
      titleText = `${toolType}: ${toolInput} = ${toolOutput}`;
    } else {
      titleText = `${toolType}: ${toolInput}`;
    }
    browserTabTitle.textContent = titleText;
  } else {
    browserTabTitle.textContent = title || url;
  }
  
  if (browserTabFallbackLink) {
    browserTabFallbackLink.href = url;
  }

  // Hide fallback initially
  if (browserTabFallback) {
    browserTabFallback.classList.add('hidden');
  }

  // Handle image type vs non-image type
  if (type === 'image' && imgUrl) {
    // Image type: show Image Section first, with navigation button
    browserTabImageSrc.src = imgUrl;
    browserTabImageSrc.alt = title || 'Image';
    
    // Show Image Section, hide Browser Section
    browserTabImageSection.classList.remove('hidden');
    browserTabBrowserSection.classList.add('hidden');
    browserTabBrowserSection.style.transform = 'translateX(100%)';
    
    // Show navigation button (next) and set up handler
    if (browserTabNavBtn) {
      browserTabNavBtn.classList.remove('hidden');
      browserTabNavIconNext.classList.remove('hidden');
      browserTabNavIconPrevious.classList.add('hidden');
      browserTabNavBtn.title = 'Next';
      browserTabNavBtn.dataset.view = 'image'; // Track current view: 'image' or 'browser'
      
      // Create handler function
      const handleNavClick = () => {
        const currentView = browserTabNavBtn.dataset.view;
        const nextIcon = document.getElementById('browser-tab-nav-icon-next');
        const prevIcon = document.getElementById('browser-tab-nav-icon-previous');
        
        if (currentView === 'image') {
          // Transition to browser section
          browserTabBrowserSection.classList.remove('hidden');
          requestAnimationFrame(() => {
            browserTabBrowserSection.style.transform = 'translateX(0)';
          });
          
          // Update button to previous
          if (nextIcon) nextIcon.classList.add('hidden');
          if (prevIcon) prevIcon.classList.remove('hidden');
          browserTabNavBtn.title = 'Previous';
          browserTabNavBtn.dataset.view = 'browser';
          
          // Load webview with URL (not img_url)
          if (browserTabWebview) {
            browserTabWebview.removeEventListener('did-fail-load', handleWebviewFail);
            browserTabWebview.removeEventListener('did-finish-load', handleWebviewFinish);
            browserTabWebview.addEventListener('did-fail-load', handleWebviewFail);
            browserTabWebview.addEventListener('did-finish-load', handleWebviewFinish);
            
            // Set zoom factor to zoom out (0.7 = 70% zoom, making content appear smaller)
            if (browserTabWebview.setZoomFactor) {
              browserTabWebview.setZoomFactor(0.7);
            }
            
            browserTabWebview.src = url;
          }
        } else {
          // Transition back to image section
          browserTabBrowserSection.style.transform = 'translateX(100%)';
          setTimeout(() => {
            browserTabBrowserSection.classList.add('hidden');
          }, 300);
          
          // Update button to next
          if (nextIcon) nextIcon.classList.remove('hidden');
          if (prevIcon) prevIcon.classList.add('hidden');
          browserTabNavBtn.title = 'Next';
          browserTabNavBtn.dataset.view = 'image';
        }
      };
      
      // Remove any existing handler and attach new one
      browserTabNavBtn.replaceWith(browserTabNavBtn.cloneNode(true));
      const newNavBtn = document.getElementById('browser-tab-nav-btn');
      if (newNavBtn) {
        newNavBtn.classList.remove('hidden');
        newNavBtn.dataset.view = 'image';
        newNavBtn.title = 'Next';
        const newNextIcon = document.getElementById('browser-tab-nav-icon-next');
        const newPrevIcon = document.getElementById('browser-tab-nav-icon-previous');
        if (newNextIcon) newNextIcon.classList.remove('hidden');
        if (newPrevIcon) newPrevIcon.classList.add('hidden');
        newNavBtn.addEventListener('click', handleNavClick);
      }
    }
    
  } else {
    // Non-image type: only show Browser Section
    browserTabImageSection.classList.add('hidden');
    browserTabBrowserSection.classList.remove('hidden');
    browserTabBrowserSection.style.transform = 'translateX(0)';
    
    // Hide navigation button
    if (browserTabNavBtn) {
      browserTabNavBtn.classList.add('hidden');
    }
    
    // Set up webview error handler
    if (browserTabWebview) {
      browserTabWebview.removeEventListener('did-fail-load', handleWebviewFail);
      browserTabWebview.removeEventListener('did-finish-load', handleWebviewFinish);
      
      browserTabWebview.addEventListener('did-fail-load', handleWebviewFail);
      browserTabWebview.addEventListener('did-finish-load', handleWebviewFinish);
      
      // Set zoom factor to zoom out (0.7 = 70% zoom, making content appear smaller)
      if (browserTabWebview.setZoomFactor) {
        browserTabWebview.setZoomFactor(0.7);
      }
      
      // Load the page in webview
      browserTabWebview.src = url;
    }
  }

  // Browser tab is now always visible and full width, so no need to show/hide or set width
}

function handleWebviewFail(event) {
  const browserTabFallback = document.getElementById('browser-tab-fallback');
  const browserTabWebview = document.getElementById('browser-tab-webview');
  if (!browserTabFallback || !browserTabWebview) return;

  if (
    event.errorCode === -3 ||
    (typeof event.errorDescription === 'string' &&
      event.errorDescription.includes('ERR_BLOCKED_BY_RESPONSE'))
  ) {
    browserTabFallback.classList.remove('hidden');
  }
}

function handleWebviewFinish() {
  const browserTabFallback = document.getElementById('browser-tab-fallback');
  const browserTabWebview = document.getElementById('browser-tab-webview');
  if (!browserTabFallback) return;
  browserTabFallback.classList.add('hidden');
  
  // Ensure zoom factor is set after page loads
  if (browserTabWebview && browserTabWebview.setZoomFactor) {
    browserTabWebview.setZoomFactor(0.7);
  }
}

function closeBrowserTab() {
  const browserTab = document.getElementById('browser-tab');
  const browserTabTitle = document.getElementById('browser-tab-title');
  const browserTabWebview = document.getElementById('browser-tab-webview');
  const browserTabImageSection = document.getElementById('browser-tab-image-section');
  const browserTabBrowserSection = document.getElementById('browser-tab-browser-section');
  const browserTabFallback = document.getElementById('browser-tab-fallback');

  if (!browserTab || !browserTabWebview || !browserTabFallback) return;

  // Reset browser tab title
  if (browserTabTitle) {
    browserTabTitle.textContent = 'Select an item from the dock to view';
  }

  // Stop loading webview
  browserTabWebview.src = 'about:blank';

  // Hide image section
  if (browserTabImageSection) {
    browserTabImageSection.classList.add('hidden');
  }

  // Hide browser section
  if (browserTabBrowserSection) {
    browserTabBrowserSection.classList.add('hidden');
  }

  // Hide fallback
  browserTabFallback.classList.add('hidden');

  activeCardUrl = null;
}

// Close browser tab on ESC key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeBrowserTab();
  }
});

// Refresh button (force full refresh) - disabled (data loading is now handled by dock window)
// const refreshBtn = document.getElementById('refresh-btn');
// if (refreshBtn) {
//   refreshBtn.addEventListener('click', () => loadData(true));
// }

// Close browser tab button
const browserTabCloseBtn = document.getElementById('browser-tab-close');
if (browserTabCloseBtn) {
  browserTabCloseBtn.addEventListener('click', () => {
    closeBrowserTab();
  });
}

// Keyboard shortcuts
// Keyboard shortcut for refresh - disabled (data loading is now handled by dock window)
// document.addEventListener('keydown', (e) => {
//   // R key to refresh (force full refresh)
//   if (e.key === 'r' || e.key === 'R') {
//     if (e.metaKey || e.ctrlKey) {
//       e.preventDefault();
//       loadData(true);
//     }
//   }
// });

// Polling for new data - disabled (data loading is now handled by dock window)
// let pollingInterval = null;
// 
// function startPolling() {
//   if (pollingInterval) return;
//   pollingInterval = setInterval(() => {
//     if (!document.hidden) {
//       loadData(false); // Incremental update
//     }
//   }, 2000); // Poll every 2 seconds
// }
// 
// function stopPolling() {
//   if (pollingInterval) {
//     clearInterval(pollingInterval);
//     pollingInterval = null;
//   }
// }
// 
// // Start polling when page is visible
// if (!document.hidden) {
//   startPolling();
// }
// 
// document.addEventListener('visibilitychange', () => {
//   if (document.hidden) {
//     stopPolling();
//   } else {
//     startPolling();
//   }
// });

// Listen for IPC messages from main process
// Note: With contextIsolation: true, we use window.electronAPI instead of direct ipcRenderer
// The main process sends 'refresh-data' and 'pending-save' messages via webContents.send()
// These are handled by the Firestore listener and loadData() function

// REMOVED: Direct ipcRenderer access (not available with contextIsolation: true)
// IPC messages are handled via:
// 1. Firestore listener (automatic updates)
// 2. loadData() function (called on refresh-data)
// 3. window.electronAPI (for auth, firestore operations)

// Legacy handler for open-browser-tab (if still needed)
// Note: With contextIsolation: true, direct ipcRenderer access is not available
// This handler may not work - consider using window.electronAPI or removing if not needed
try {
if (window.require) {
  const { ipcRenderer } = window.require('electron');
  ipcRenderer.on('open-browser-tab', (event, itemData) => {
      if (typeof openBrowserTab === 'function') {
    openBrowserTab(
      itemData.url,
      itemData.title,
      itemData.type || 'webpage',
      itemData.imgUrl || '',
      itemData.toolType || '',
      itemData.toolInput || '',
      itemData.toolOutput || ''
    );
      }
  });
  }
} catch (error) {
  console.warn('IPC listener setup failed (expected with contextIsolation):', error);
}

// Initial load - disabled (data loading is now handled by dock window)
// loadData(true);

// Drag and drop functionality for drop zone
// ========== LEGACY DnD FUNCTIONS (COMMENTED OUT - REPLACED BY UNIFIED SYSTEM) ==========
// The following functions are replaced by the unified DnD system:
// - setupDropZone() -> External drops handled in unified system
// - setupTrashZone() -> setupUnifiedDeleteZone()
// - setupDirectoryDropZone() -> Handled by setupContainerDropHandlers()
// - setupCardDropHandlers() -> Handled by event delegation in setupContainerDropHandlers()
// - setupDirectoryItemsContainerDropHandlers() -> setupUnifiedDropHandlers()

function setupDropZone() {
  console.log('Drop zone: Setting up drop zone...');
  const dropZone = document.getElementById('drop-zone');
  if (!dropZone) {
    // STOP THE LOOP: Log once and return - do not retry
    console.warn('Drop zone: Element with id "drop-zone" not found! This is expected if you are on dock.html (which uses "trash-zone" instead).');
    return;
  }
  console.log('Drop zone: Element found, attaching event listeners');
  console.log('Drop zone: Element details:', {
    id: dropZone.id,
    className: dropZone.className,
    style: window.getComputedStyle(dropZone).pointerEvents
  });
  
  // Test click to verify element is interactive
  dropZone.addEventListener('click', () => {
    console.log('Drop zone: Click event fired - element is interactive');
  });
  
  // Prevent default drag behaviors
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (eventName === 'dragenter' || eventName === 'dragover') {
        console.log(`Drop zone: ${eventName} event fired`);
      }
    });
  });

  // Add drag-over class for visual feedback
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => {
      dropZone.classList.add('border-[#007bff]', 'bg-[rgba(0,123,255,0.1)]');
      dropZone.classList.remove('border-[rgba(0,123,255,0.5)]');
    });
  });

  // Remove drag-over class
  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => {
      dropZone.classList.remove('border-[#007bff]', 'bg-[rgba(0,123,255,0.1)]');
      dropZone.classList.add('border-[rgba(0,123,255,0.5)]');
    });
  });

  // Handle drop
  dropZone.addEventListener('drop', async (e) => {
    console.log('=== DROP ZONE: Drop event triggered ===');
    const files = Array.from(e.dataTransfer.files);
    const items = Array.from(e.dataTransfer.items);
    const urls = [];
    const images = [];
    const texts = [];

    console.log('Drop zone: Files count:', files.length);
    files.forEach((file, idx) => {
      console.log(`  File[${idx}]: name="${file.name}", type="${file.type}", size=${file.size}`);
    });
    
    console.log('Drop zone: Items count:', items.length);
    items.forEach((item, idx) => {
      console.log(`  Item[${idx}]: kind="${item.kind}", type="${item.type}"`);
    });
    
    // Log all dataTransfer types
    console.log('Drop zone: Available dataTransfer types:', e.dataTransfer.types);
    
    // Try to get data from different types
    for (const type of e.dataTransfer.types) {
      try {
        const data = e.dataTransfer.getData(type);
        console.log(`Drop zone: dataTransfer.getData("${type}") =`, data.substring(0, 200));
      } catch (err) {
        console.log(`Drop zone: Could not get data for type "${type}":`, err.message);
      }
    }

    // Process data transfer items (for URLs, images, and text)
    for (const item of items) {
      console.log('Drop zone: Processing item type:', item.type, 'kind:', item.kind);
      
      // Handle file items (including images)
      if (item.kind === 'file') {
        if (item.type.startsWith('image/')) {
          // Handle image file items
          const file = item.getAsFile();
          if (file) {
            try {
              console.log('Drop zone: Reading image file:', file.name, file.type);
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
              });
              if (dataUrl) {
                console.log('Drop zone: Image read successfully, length:', dataUrl.length);
                images.push(dataUrl);
              }
            } catch (err) {
              console.error('Drop zone: Error reading image item:', err);
            }
          }
        }
      } else if (item.kind === 'string') {
        // Handle string items (URLs, text, image URLs)
        if (item.type === 'text/uri-list' || item.type === 'text/html' || item.type === 'text/plain') {
          try {
            const str = await new Promise((resolve) => {
              item.getAsString((s) => resolve(s));
            });
            console.log('Drop zone: Got string from item:', str.substring(0, 100));
            
            const trimmedStr = str.trim();
            
            // Check if it's a data:image URL (base64 encoded image)
            if (trimmedStr.startsWith('data:image/')) {
              console.log('Drop zone: Detected data:image URL, length:', trimmedStr.length);
              images.push(trimmedStr);
              continue; // Skip adding to URLs or texts
            }
            
            // For text/uri-list items that are HTTP URLs, try to fetch to see if it's an image
            // This handles cases where images are dragged from browsers
            if (item.type === 'text/uri-list' && (trimmedStr.startsWith('http://') || trimmedStr.startsWith('https://'))) {
              console.log('Drop zone: text/uri-list item detected, checking if it\'s an image:', trimmedStr);
              try {
                const response = await fetch(trimmedStr, { method: 'HEAD', mode: 'cors' }).catch(() => 
                  // If HEAD fails, try GET
                  fetch(trimmedStr, { mode: 'cors' })
                );
                
                if (response && response.ok) {
                  const contentType = response.headers.get('content-type');
                  console.log('Drop zone: Response content-type:', contentType);
                  
                  if (contentType && contentType.startsWith('image/')) {
                    // It's an image - fetch full content and convert to data URL
                    console.log('Drop zone: Confirmed as image, fetching full content...');
                    const fullResponse = await fetch(trimmedStr, { mode: 'cors' });
                    if (fullResponse.ok) {
                      const blob = await fullResponse.blob();
                      const dataUrl = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = (e) => resolve(e.target.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                      });
                      if (dataUrl) {
                        console.log('Drop zone: Image converted to data URL, length:', dataUrl.length);
                        images.push(dataUrl);
                        continue; // Skip adding to URLs
                      }
                    }
                  }
                }
              } catch (fetchErr) {
                console.log('Drop zone: Failed to check/fetch (possibly CORS), will check URL pattern:', fetchErr.message);
                // If fetch fails, check URL pattern as fallback
              }
            }
            
            // Check if it's an image URL by extension or common image URL patterns
            const isImageUrl = (trimmedStr.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?|$|#)/i) ||
                              trimmedStr.match(/\/image[s]?\/|img\/|photo[s]?\/|picture[s]?\/|media\/image/i)) &&
                              (trimmedStr.startsWith('http://') || trimmedStr.startsWith('https://'));
            
            if (isImageUrl) {
              // It's likely an image URL - try to fetch and convert to data URL
              console.log('Drop zone: Detected image URL by pattern:', trimmedStr);
              try {
                const response = await fetch(trimmedStr, { mode: 'cors' });
                if (response.ok) {
                  const blob = await response.blob();
                  if (blob.type.startsWith('image/')) {
                    console.log('Drop zone: Confirmed image, converting to data URL, blob type:', blob.type);
                    const dataUrl = await new Promise((resolve, reject) => {
                      const reader = new FileReader();
                      reader.onload = (e) => resolve(e.target.result);
                      reader.onerror = reject;
                      reader.readAsDataURL(blob);
                    });
                    if (dataUrl) {
                      console.log('Drop zone: Image URL converted to data URL, length:', dataUrl.length);
                      images.push(dataUrl);
                      continue; // Skip adding to URLs
                    }
                  }
                } else {
                  console.log('Drop zone: Image fetch failed with status:', response.status);
                }
              } catch (fetchErr) {
                console.log('Drop zone: Failed to fetch image (possibly CORS), saving URL as image:', fetchErr.message);
                // If we can't fetch due to CORS, save the URL as-is and mark it as an image
                console.log('Drop zone: Saving image URL directly:', trimmedStr);
                images.push(trimmedStr); // Save the URL string, we'll handle it in save function
                continue;
              }
            }
            
            // Add as URL or text (not an image)
            if (trimmedStr.startsWith('http://') || trimmedStr.startsWith('https://')) {
              urls.push(trimmedStr);
            } else if (trimmedStr) {
              texts.push(trimmedStr);
            }
          } catch (err) {
            console.error('Drop zone: Error reading item:', err);
          }
        }
      }
    }

    // Process files (fallback for file drags)
    for (const file of files) {
      console.log('Drop zone: Processing file:', file.name, file.type);
      if (file.type.startsWith('image/')) {
        try {
          console.log('Drop zone: Reading image file:', file.name);
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          if (dataUrl) {
            console.log('Drop zone: Image file read successfully, length:', dataUrl.length);
            images.push(dataUrl);
          }
        } catch (err) {
          console.error('Drop zone: Error reading image file:', err);
        }
      } else if (file.type === 'text/uri-list' || file.type === 'text/plain' || 
                 file.name.endsWith('.url') || file.name.endsWith('.webloc')) {
        try {
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
          });
          if (content) {
            const lines = content.split(/\r?\n/);
            lines.forEach(line => {
              const trimmed = line.trim();
              if (trimmed.match(/^https?:\/\//)) {
                urls.push(trimmed);
              } else if (trimmed) {
                texts.push(trimmed);
              }
            });
          }
        } catch (err) {
          console.error('Error reading text file:', err);
        }
      }
    }

    // Check HTML data
    const html = e.dataTransfer.getData('text/html');
    if (html) {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const links = doc.querySelectorAll('a[href]');
        links.forEach((link) => {
          const href = link.getAttribute('href');
          if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
            urls.push(href);
          }
        });
      } catch (err) {
        console.error('Error parsing HTML:', err);
      }
    }

    // Check plain text
    const plainText = e.dataTransfer.getData('text/plain');
    if (plainText) {
      const trimmedPlainText = plainText.trim();
      // Check if it's a data:image URL
      if (trimmedPlainText.startsWith('data:image/')) {
        console.log('Drop zone: Found data:image in text/plain, length:', trimmedPlainText.length);
        images.push(trimmedPlainText);
      } else if (trimmedPlainText.startsWith('http://') || trimmedPlainText.startsWith('https://')) {
        urls.push(trimmedPlainText);
      }
    }

    console.log('=== DROP ZONE: Collected data ===');
    console.log('  URLs:', urls.length, urls);
    console.log('  Images:', images.length, images.map(img => typeof img === 'string' ? (img.length > 100 ? img.substring(0, 100) + '...' : img) : '[File object]'));
    console.log('  Texts:', texts.length, texts);
    console.log('================================');

    // Save all data
    const allPromises = [];

    // Save URLs
    for (const url of urls) {
      if (url.trim()) {
        allPromises.push(saveUrlToServer(url.trim(), url.trim(), undefined));
      }
    }

    // Save texts that look like URLs (but skip data:image URLs as they should be in images array)
    for (const text of texts) {
      const trimmedText = text.trim();
      // Check if it's a data:image URL that wasn't caught earlier
      if (trimmedText.startsWith('data:image/')) {
        console.log('Drop zone: Found data:image in texts array, moving to images');
        images.push(trimmedText);
        continue;
      }
      if (trimmedText.match(/^https?:\/\//)) {
        allPromises.push(saveUrlToServer(trimmedText, trimmedText, undefined));
      }
    }

    // Save images
    for (const imageData of images) {
      const title = `Image ${new Date().toLocaleString()}`;
      
      // Check if imageData is a data URL (starts with data:) or a regular URL
      if (imageData.startsWith('data:')) {
        // It's a data URL - use empty URL and save the data URL as img_url
        console.log('Drop zone: Saving image data URL, length:', imageData.length);
        allPromises.push(saveUrlToServer('', title, imageData));
      } else if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
        // It's an image URL - save it with empty URL and the image URL as img_url
        console.log('Drop zone: Saving image URL:', imageData);
        allPromises.push(saveUrlToServer('', title, imageData));
      } else {
        // Fallback - treat as data URL
        console.log('Drop zone: Saving image (fallback):', imageData.substring(0, 50));
        allPromises.push(saveUrlToServer('', title, imageData));
      }
    }

    // Wait for all saves to complete, then refresh
    try {
      const results = await Promise.all(allPromises);
      console.log('Drop zone: All saves completed, results:', results);
      loadData(false); // Refresh data after saving
    } catch (err) {
      console.error('Drop zone: Error saving dropped items:', err);
    }
  });

  // Helper function to save to server
  async function saveUrlToServer(url, title, imgUrl) {
    try {
      const payload = {
        url: url || '',
        title: title || '',
        timestamp: Date.now(),
        saved_by: 'global',
        ...(imgUrl && { img_url: imgUrl })
      };

      console.log('Drop zone: Sending to server:', JSON.stringify(payload, null, 2));

      const response = await fetch('http://localhost:3000/api/v1/save-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const result = await response.json();
        console.log('✅ Saved via drop zone successfully:', result);
        return true;
      } else {
        const errorText = await response.text();
        console.error('❌ Failed to save via drop zone:', response.status, response.statusText, errorText);
        return false;
      }
    } catch (error) {
      console.error('❌ Error saving via drop zone:', error);
      return false;
    }
  }
}

// ========== DOCK CONTAINER FUNCTIONALITY ==========
// Dashboard assumes user is always authenticated (main process routes here only when logged in)
let currentUser = null;

// Global drag state tracking (simplified)
let globalDragState = {
  isActive: false,
  originalCard: null,
  mouseupFallback: null
};

// Global variable for currently dragged itemId (persists across windows)
window.currentDraggedItemId = null;
window.currentDraggedItemUrl = null;

// Update profile header from user data (dashboard always has user)
function updateProfileFromUser(user) {
  const profileName = document.getElementById('profile-name');
  const profileEmail = document.getElementById('profile-email');
  const profileImage = document.getElementById('profile-image');
  if (profileName) profileName.textContent = user.displayName || 'UserName';
  if (profileEmail) profileEmail.textContent = user.email || 'user@example.com';
  if (profileImage && user.photoURL) {
    profileImage.style.backgroundImage = `url(${user.photoURL})`;
  }
}

function disableAlwaysOnTopForDrag() {
  try {
    if (window.electronAPI && window.electronAPI.window && window.electronAPI.window.disableAlwaysOnTop) {
      setTimeout(() => window.electronAPI.window.disableAlwaysOnTop(), 30);
    }
  } catch (e) {}
}

function enableAlwaysOnTopAfterDrag() {
  try {
    if (window.electronAPI && window.electronAPI.window && window.electronAPI.window.enableAlwaysOnTop) {
      setTimeout(() => window.electronAPI.window.enableAlwaysOnTop(), 60);
    }
  } catch (e) {}
}

// Update Instagram UI (optional - social-insta may not exist on dashboard)
async function updateInstagramUI(userId) {
  if (!window.electronAPI || !window.electronAPI.instagram) return;
  const socialInsta = document.getElementById('social-insta');
  if (!socialInsta) return;
  
  try {
    const status = await window.electronAPI.instagram.getConnectionStatus(userId);
    const instagramIconUrl = 'https://static.cdninstagram.com/rsrc.php/v3/yt/r/30PrGfR3xhB.png';
    socialInsta.innerHTML = `<img src="${instagramIconUrl}" alt="Instagram" />`;
    
    if (status.connected && !status.expired) {
      socialInsta.title = `Instagram connected: @${status.username || 'instagram_user'}`;
    } else if (status.connected && status.expired) {
      socialInsta.title = 'Instagram session expired - Click to reconnect';
    } else {
      socialInsta.title = 'Click to connect Instagram';
    }
  } catch (error) {
    console.error('Error checking Instagram status:', error);
    const instagramIconUrl = 'https://static.cdninstagram.com/rsrc.php/v3/yt/r/30PrGfR3xhB.png';
    socialInsta.innerHTML = `<img src="${instagramIconUrl}" alt="Instagram" />`;
  }
}

// ========== CONTENT DRAWER ==========
const DRAWER_WIDTH = 500;
const SIDEBAR_WIDTH = 175;
let drawerOpen = false;

const DRAWER_ICON_RIGHT = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>
`;
const DRAWER_ICON_LEFT = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>
`;

const PIN_ICON_PINNED = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 5v6l-1 1v1h1l1-1v-1l1-1V5a1 1 0 0 0-2 0z"/>
  </svg>
`;
const PIN_ICON_UNPINNED = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(-45deg);">
    <path d="M9 5v6l-1 1v1h1l1-1v-1l1-1V5a1 1 0 0 0-2 0z"/>
  </svg>
`;

async function resizeWindow(width) {
  try {
    if (window.electronAPI && window.electronAPI.window && window.electronAPI.window.resize) {
      await window.electronAPI.window.resize(width);
    }
  } catch (e) {
    console.error('Failed to resize window in main process:', e);
  }
}

function setDrawerState(open) {
  const contentArea = document.getElementById('content-area');
  const toggle = document.getElementById('drawer-toggle');
  const appContainer = document.getElementById('app-container');
  if (!contentArea || !toggle) return;
  drawerOpen = open;
  if (open) {
    if (appContainer) appContainer.classList.add('is-open');
    resizeWindow(SIDEBAR_WIDTH + DRAWER_WIDTH);
    contentArea.classList.add('is-open');
    toggle.innerHTML = DRAWER_ICON_LEFT;
    return;
  }
  if (appContainer) appContainer.classList.remove('is-open');
  contentArea.classList.remove('is-open');
  toggle.innerHTML = DRAWER_ICON_RIGHT;
  const onEnd = (e) => {
    if (e.propertyName !== 'width') return;
    contentArea.removeEventListener('transitionend', onEnd);
    resizeWindow(SIDEBAR_WIDTH);
  };
  contentArea.addEventListener('transitionend', onEnd);
  setTimeout(() => {
    contentArea.removeEventListener('transitionend', onEnd);
    resizeWindow(SIDEBAR_WIDTH);
  }, 400);
}

function setupDrawerToggle() {
  const toggle = document.getElementById('drawer-toggle');
  if (!toggle) return;
  toggle.innerHTML = DRAWER_ICON_RIGHT;
  toggle.addEventListener('click', () => {
    setDrawerState(!drawerOpen);
  });
}

function setupDockPin() {
  // dock-pin button removed — auto-hide is now driven by app focus (see setupFocusState).
  // We only keep the mouseenter/mouseleave hover-to-show/hide logic here.
  const api = window.electronAPI?.dock;
  if (!api) return;

  let hideDelayTimer = null;
  const HIDE_DELAY_MS = 300;

  const dockContainer = document.getElementById('app-container');
  const dockEl = dockContainer || document.body;

  dockEl.addEventListener('mouseenter', async () => {
    const pinned = await api.getPinned();
    if (!pinned) {
      if (hideDelayTimer) {
        clearTimeout(hideDelayTimer);
        hideDelayTimer = null;
      }
      await api.show();
    }
  });

  dockEl.addEventListener('mouseleave', async () => {
    const pinned = await api.getPinned();
    if (!pinned) {
      hideDelayTimer = setTimeout(async () => {
        hideDelayTimer = null;
        await api.hide();
      }, HIDE_DELAY_MS);
    }
  });
}

function updateDockFunctionHeight() {
  const dockFunction = document.getElementById('dock-function');
  if (!dockFunction) return;
  // Always collapsed regardless of focus state
  dockFunction.style.opacity = '0';
  const currentHeight = dockFunction.offsetHeight || 0;
  dockFunction.style.height = `${currentHeight}px`;
  requestAnimationFrame(() => {
    dockFunction.style.height = '0.1px';
  });
}

function setupFocusState() {
  const dockTop = document.getElementById('dock-top');
  if (!dockTop) return;
  const resetDirectoriesOnBlur = () => {
    document.querySelectorAll('.directory-item').forEach((directoryItem) => {
      directoryItem.dataset.expanded = 'false';
      directoryItem.classList.remove('drag-over');
      const chevron = directoryItem.querySelector('.directory-chevron');
      if (chevron) chevron.style.transform = 'rotate(0deg)';
      const itemsContainer = directoryItem.querySelector('.directory-items-container');
      if (itemsContainer) itemsContainer.style.display = 'none';
    });
  };
  const applyFocus = (focused) => {
    if (focused) {
      dockTop.classList.add('app-focused');
    } else {
      dockTop.classList.remove('app-focused');
      resetDirectoriesOnBlur();
    }
    updateDockFunctionHeight();
    // Auto-hide is driven by focus: main process handles the actual window movement
    // via the focus/blur events in main.ts. No IPC call needed here.
  };
  if (window.electronAPI && window.electronAPI.window && window.electronAPI.window.onAppFocusChanged) {
    window.electronAPI.window.onAppFocusChanged((focused) => applyFocus(!!focused));
  }
  applyFocus(document.hasFocus());
}

// Helper: Format date for dock cards
function formatDate(timestamp) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

// Helper: Get favicon URL (sz: favicon size, default 64)
function getFaviconUrl(url, sz = 64) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.replace(/^www\./, '');
    const parts = hostname.split('.');
    const commonSubdomains = ['search', 'm', 'mobile', 'api', 'app', 'www', 'mail', 'drive', 'docs', 'maps', 'blog', 'shop', 'store', 'news', 'sports', 'finance', 'weather'];
    
    if (parts.length > 2 && commonSubdomains.includes(parts[0].toLowerCase())) {
      hostname = parts.slice(1).join('.');
    } else if (parts.length > 2) {
      const tldPatterns = ['co.uk', 'com.au', 'co.nz', 'co.za', 'com.br'];
      const lastTwo = parts.slice(-2).join('.');
      const lastThree = parts.slice(-3).join('.');
      hostname = tldPatterns.some(pattern => lastThree.endsWith('.' + pattern)) ? lastThree : lastTwo;
    }
    
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=${sz}`;
  } catch {
    return `https://www.google.com/s2/favicons?domain=example.com&sz=${sz}`;
  }
}

// Helper: Get source domain
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

// Helper: Get item ID
function getItemId(item) {
  return `${item.url}_${item.timestamp}`;
}

// Helper: Format URL for display (strip https://www. or https://)
function formatUrlForDisplay(url) {
  if (!url || typeof url !== 'string') return '';
  return url.replace(/^https?:\/\/(www\.)?/i, '').trim();
}

// Create DataCard component
function createDataCard(item) {
  const itemId = item.id || getItemId(item);
  const cardId = `item-${itemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const escapedUrl = item.url.replace(/"/g, '&quot;');
  const type = item.type || 'webpage';
  const displayTitle = item.title || 'Untitled';
  const escapedTitle = displayTitle.replace(/"/g, '&quot;');
  const sourceDomain = getSourceDomain(item);
  const escapedSourceDomain = sourceDomain.replace(/"/g, '&quot;');
  const imgUrl = (item.img_url || '').trim();
  const escapedImgUrl = imgUrl.replace(/"/g, '&quot;').replace(/&/g, '&amp;');

  const directoryId = item.directoryId && item.directoryId !== 'undefined' ? item.directoryId : '';
  const displayUrl = formatUrlForDisplay(item.url);
  const escapedDisplayUrl = displayUrl.replace(/"/g, '&quot;').replace(/&/g, '&amp;');

  const cardHtml = `
    <div id="${cardId}" 
         class="data-card"
         data-url="${escapedUrl}"
         data-title="${escapedTitle}"
         data-type="${type}"
         data-img-url="${escapedImgUrl}"
         data-item-id="${itemId}"
         data-doc-id="${item.id || ''}"
         data-directory-id="${directoryId}">
      <div class="data-card-header">
        <div class="data-card-domain-section">
          ${displayUrl ? `<span class="data-card-url">${escapedDisplayUrl}</span>` : ''}
        </div>
        <div class="data-card-delete" title="Delete">
          <div class="data-card-delete-btn">
            <svg viewBox="0 0 24 24" class="delete-icon-x">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            <svg viewBox="0 0 24 24" class="delete-icon-check" style="display:none;">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
        </div>
      </div>
      <div class="data-card-main">
        ${imgUrl ? `
        <div class="data-card-imgcontainer">
          <img src="${escapedImgUrl}" alt="${escapedTitle}" class="data-card-image">
        </div>` : ''}
        <div class="data-card-context">
          <p class="data-card-title">${escapedTitle}</p>
        </div>
      </div>
    </div>
  `;
  
  return cardHtml;
}

function attachDeleteHandlers() {
  document.querySelectorAll('.data-card-delete').forEach((deleteEl) => {
    if (deleteEl.dataset.deleteHandlerAttached === 'true') return;
    deleteEl.dataset.deleteHandlerAttached = 'true';

    const card = deleteEl.closest('.data-card');
    const header = deleteEl.closest('.data-card-header');
    const domainSection = header?.querySelector('.data-card-domain-section');
    const iconX = deleteEl.querySelector('.delete-icon-x');
    const iconCheck = deleteEl.querySelector('.delete-icon-check');
    if (!card || !header || !domainSection || !iconX || !iconCheck) return;

    let pendingMode = false;
    let originalDomainHtml = domainSection.innerHTML;

    const enterPendingMode = () => {
      pendingMode = true;
      originalDomainHtml = domainSection.innerHTML;
      header.classList.add('delete-pending');
      domainSection.innerHTML = 'Really delete this data?';
      iconX.style.display = 'none';
      iconCheck.style.display = '';
    };

    const exitPendingMode = () => {
      pendingMode = false;
      header.classList.remove('delete-pending');
      domainSection.innerHTML = originalDomainHtml;
      iconX.style.display = '';
      iconCheck.style.display = 'none';
    };

    // Click handler on delete button
    deleteEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!pendingMode) {
        enterPendingMode();
        return;
      }
      // Second click — execute delete
      exitPendingMode();
      const itemId = card.dataset.itemId;
      const container = card.closest('.card-container');
      const wrapper = card.closest('.card-wrapper');
      if (!itemId || !container || !wrapper) return;

      // Block loadData() re-renders for the duration of the delete animation
      // so Firestore's watchDatasByUser callback cannot wipe the DOM mid-animation.
      isSyncing = true;

      // Delete animation (reverse of entrance):
      // Phase 1: lock container height to fixed px so it won't auto-collapse
      // when wrapper shrinks, then scale wrapper to 0 + fade out.
      // Phase 2: after 400ms (350ms wrapper anim + 50ms gap), collapse
      // container height to 0, then remove from DOM.
      // Lock container height but keep overflow visible during Phase 1
      // so the scale animation is not clipped by the container boundary.
      container.style.height = `${container.offsetHeight}px`;
      container.style.overflow = 'visible';

      // bottom center origin so the card shrinks upward (bottom → top)
      wrapper.style.transition = 'none';
      wrapper.style.transformOrigin = 'bottom center';
      wrapper.style.transform = 'scale(1)';
      wrapper.style.opacity = '1';
      void wrapper.offsetHeight;
      wrapper.style.transition = [
        'transform 350ms cubic-bezier(0.36, 0, 0.66, -0.56)',
        'opacity 200ms ease-in',
      ].join(', ');
      requestAnimationFrame(() => {
        wrapper.style.transform = 'scale(0)';
        wrapper.style.opacity = '0';
      });

      // Phase 2: switch container to hidden then collapse height to 0
      setTimeout(() => {
        container.style.overflow = 'hidden';
        container.style.transition = 'height 300ms ease-in';
        requestAnimationFrame(() => {
          container.style.height = '0px';
        });
        // Remove from DOM after height animation completes
        setTimeout(() => {
          container.remove();
          isSyncing = false;
        }, 310);
      }, 400); // 350ms wrapper animation + 50ms gap

      // Delete from Firestore (fire-and-forget — animation is not blocked by this)
      try {
        if (currentUser && window.electronAPI?.firestore?.deleteData) {
          await window.electronAPI.firestore.deleteData(itemId, currentUser.uid);
        }
      } catch (err) {
        console.error('[Delete] Failed to delete item:', itemId, err);
        // Ensure isSyncing is released even on Firestore error
        isSyncing = false;
      }
    });

    // Click outside header → exit pending mode
    document.addEventListener('click', (e) => {
      if (!pendingMode) return;
      if (!header.contains(e.target)) {
        exitPendingMode();
      }
    });

    // App loses focus → exit pending mode
    if (window.electronAPI?.window?.onAppFocusChanged) {
      window.electronAPI.window.onAppFocusChanged((focused) => {
        if (!focused && pendingMode) exitPendingMode();
      });
    }
  });
}

// Attach click handlers and drag handlers to all cards
function attachCardClickHandlers() {
  console.log('[DnD] attachCardClickHandlers: Starting to attach handlers to cards');
  const allCards = document.querySelectorAll('.data-card');
  console.log('[DnD] Found', allCards.length, 'cards to process');
  
  allCards.forEach((card, index) => {
    if (card.dataset.handlerAttached === 'true') {
      console.log('[DnD] Card', index, 'already has handlers, skipping');
      return;
    }
    
    console.log('[DnD] Processing card', index, 'ID:', card.id);
    
    // ========== TASK 1: Make wrapper draggable, not just the card ==========
    const wrapper = card.closest('.card-wrapper');
    if (!wrapper) {
      console.warn('[DnD] Card has no wrapper, skipping');
      return;
    }
    
    // Remove draggable from card
    card.removeAttribute('draggable');
    
    // Set draggable on wrapper
    if (wrapper.getAttribute('draggable') !== 'true') {
      wrapper.setAttribute('draggable', 'true');
      console.log('[DnD] ✅ Set draggable="true" on wrapper for card:', card.id);
    }
    
    const newCard = card.cloneNode(true);
    card.parentNode.replaceChild(newCard, card);
    
    // ========== UNIFIED DRAGSTART HANDLER (Wrapper-Centric) ==========
    wrapper.addEventListener('dragstart', (e) => {
      disableAlwaysOnTopForDrag();
      const draggedWrapper = e.currentTarget;
      const card = draggedWrapper.querySelector('.data-card');
      if (!card) {
        console.error('[DnD] No card found in wrapper');
        e.preventDefault();
        return;
      }
      
      const itemId = card.dataset.docId || card.dataset.itemId || '';
      const url = card.dataset.url || '';
      const sourceDirectoryId = card.dataset.directoryId || null;
      
      // CRITICAL: Set global drag state FIRST
      isDragging = true;
      
      // ========== TASK 1: Fade but Keep Source during Drag ==========
      // Keep source visible but faded (opacity: 0.3) - do NOT collapse
      // ========== TASK 3: Fix Ghost Image Hover Interference ==========
      requestAnimationFrame(() => {
        draggedWrapper.style.opacity = '0.3';
        draggedWrapper.style.transition = 'opacity 0.25s cubic-bezier(0.2, 0, 0, 1)';
        draggedWrapper.classList.add('is-dragging-source');
        draggedWrapper.dataset.draggingSource = 'true';
        draggedWrapper.style.pointerEvents = 'none'; // Prevent hover interference
        card.classList.add('dragging');
      });
      
      // Store drag data
      document.body.dataset.activeDragId = itemId;
      document.body.dataset.activeDragUrl = url;
      document.body.dataset.activeSourceDirectoryId = sourceDirectoryId || '';
      document.body.dataset.activeDragWrapperId = itemId; // Store wrapper reference
      window.currentDraggedItemId = itemId;
      window.currentDraggedItemUrl = url;
      window.currentDraggedWrapper = draggedWrapper; // Store wrapper element
      
      // Set dataTransfer
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', itemId);
      e.dataTransfer.setData('text/uri-list', url);
      if (itemId) {
        e.dataTransfer.setData('application/x-datacard-id', itemId);
      }
      if (sourceDirectoryId) {
        e.dataTransfer.setData('application/x-source-directory-id', sourceDirectoryId);
      }
      
      // ========== TASK 4: Create ghost image from card (preserve HTML) ==========
      try {
        const ghostContainer = document.createElement('div');
        ghostContainer.style.cssText = 'position: absolute; top: -1000px; left: -1000px; width: 120px; height: auto; opacity: 0.5; overflow: hidden; z-index: -1; pointer-events: none;';
        
        // Clone the card (not the wrapper) for ghost image
        const ghost = card.cloneNode(true);
        ghost.style.cssText = 'width: 100%; height: auto; margin: 0; opacity: 1; position: relative; pointer-events: none;';
        
        ghostContainer.appendChild(ghost);
        document.body.appendChild(ghostContainer);
        
        // Force reflow before setting drag image
        void ghostContainer.offsetWidth;
        
        // Set drag image
        e.dataTransfer.setDragImage(ghostContainer, 60, 30);
        
        // Cleanup after drag starts
        setTimeout(() => {
          if (ghostContainer.parentNode) {
            ghostContainer.remove();
          }
        }, 0);
      } catch (error) {
        console.warn('[DnD] Could not create custom ghost image, using default:', error);
      }
      
      console.log('[DnD] Drag started (wrapper-centric):', { itemId, url, sourceDirectoryId });
    });
    
    // ========== UNIFIED DRAGEND HANDLER (Wrapper-Centric) ==========
    wrapper.addEventListener('dragend', (e) => {
      enableAlwaysOnTopAfterDrag();
      // CRITICAL: Update global drag state and timestamp FIRST
      isDragging = false;
      lastDragEndTime = Date.now();
      
      const card = wrapper.querySelector('.data-card');
      if (card) {
        card.classList.remove('dragging');
      }
      
      // ========== FIX: Always remove is-dragging-source class ==========
      // Ensure the wrapper is always cleaned up, regardless of drop success
      wrapper.classList.remove('is-dragging-source');
      wrapper.style.pointerEvents = ''; // Restore pointer events
      
      // Cleanup directory hover timer
      if (directoryHoverTimer) {
        clearTimeout(directoryHoverTimer);
        directoryHoverTimer = null;
        hoveredDirectoryItem = null;
      }
      
      // Cleanup directory drag-over states
      document.querySelectorAll('.directory-item.drag-over').forEach(item => {
        item.classList.remove('drag-over');
      });
      
      // Cleanup global state (for items)
      delete document.body.dataset.activeDragId;
      delete document.body.dataset.activeDragUrl;
      delete document.body.dataset.activeSourceDirectoryId;
      delete document.body.dataset.activeDragWrapperId;
      window.currentDraggedItemId = null;
      window.currentDraggedItemUrl = null;
      window.currentDraggedWrapper = null;
      
      // Cleanup global state (for directories)
      delete document.body.dataset.activeDragDirectoryId;
      
      // ========== TASK 3: Cleanup on DragEnd (Cancelation) ==========
      if (wrapper.dataset.draggingSource === 'true') {
        // Drag was canceled - restore wrapper to full opacity
        wrapper.style.opacity = '1';
        wrapper.style.transition = '';
        wrapper.dataset.draggingSource = '';
      }
      
      // Remove guide wrapper and reset flag
      removeGuideWrapper();
      hasValidDropIndicator = false;
      
      // Fail-safe cleanup: restore any modified styles
      if (window._restoreDraggedCardStyles) {
        window._restoreDraggedCardStyles();
      }
      
      console.log('[DnD] Drag ended (wrapper-centric)');
    });
    
    // ========== UNIFIED CLICK HANDLER ==========
    newCard.addEventListener('click', async (e) => {
      // CRITICAL: Enhanced click guard with time buffer
      // Prevents clicks that fire immediately after dragend (known browser behavior)
      const timeSinceDragEnd = Date.now() - lastDragEndTime;
      if (isDragging || timeSinceDragEnd < 100) {
        console.log('[DnD] Click blocked:', { isDragging, timeSinceDragEnd });
        return;
      }
      
      const url = newCard.dataset.url;
      if (!url) return;
      
      // Update active card state
      document.querySelectorAll('.data-card').forEach(c => c.classList.remove('active'));
      newCard.classList.add('active');
      activeCardUrl = url;
      
      // Open URL externally
      if (checkElectronAPI() && window.electronAPI.shell) {
        try {
          await window.electronAPI.shell.openExternal(url);
        } catch (error) {
          window.open(url, '_blank');
        }
      } else {
        window.open(url, '_blank');
      }
    });
    
    newCard.dataset.handlerAttached = 'true';
    
    // Drop handlers are now handled by event delegation on containers
    // setupCardDropHandlers(newCard); // Replaced by unified DnD system
    
    console.log('[DnD] ✅ Attached handlers to card:', newCard.id);
  });
  
  console.log('[DnD] attachCardClickHandlers: Completed. Total cards processed:', allCards.length);
  attachDeleteHandlers();
}

// ========== UNIFIED DnD SYSTEM ==========

// ========== WRAPPER-EXPANSION SYSTEM ==========
// Global guide wrapper element (shown during dragover)
let guideWrapper = null;

// Track last guide wrapper position to prevent unnecessary re-insertions
let lastGuideWrapperIndex = null;
let lastGuideWrapperContainer = null;

// Fixed wrapper height (80px card + 8px gap)
const WRAPPER_HEIGHT = 88; // 80px card + 8px gap
const WRAPPER_DIRECTORY_HEIGHT = 58; // Directory height + gap
const GUIDE_LINE_HEIGHT = 2; // Slim line for guide during dragover (refined design)

// Create or get guide wrapper element (shown during dragover)
function getGuideWrapper() {
  if (!guideWrapper) {
    guideWrapper = document.createElement('div');
    guideWrapper.className = 'card-wrapper';
    guideWrapper.style.cssText = `
      overflow: hidden;
      box-sizing: border-box;
      background: var(--border-active);
      border: none;
      border-radius: 2px;
      pointer-events: none;
      transition: height 0.2s cubic-bezier(0.2, 0, 0, 1), opacity 0.2s ease;
      min-height: 0;
      margin: 3px 0;
      box-shadow: 0 0 4px rgba(var(--blink-accent-rgb, 188, 19, 254), 0.3);
    `;
    guideWrapper.dataset.guideWrapper = 'true';
  }
  return guideWrapper;
}

// Remove guide wrapper from DOM
function removeGuideWrapper() {
  if (guideWrapper && guideWrapper.parentElement) {
    guideWrapper.style.opacity = '0';
    guideWrapper.style.height = '0';
    // Wait for transition to complete before removing
    setTimeout(() => {
      if (guideWrapper && guideWrapper.parentElement) {
        guideWrapper.parentElement.removeChild(guideWrapper);
      }
      guideWrapper.style.opacity = '';
      guideWrapper.style.height = '';
    }, 300); // Match transition duration
  }
  lastGuideWrapperIndex = null;
  lastGuideWrapperContainer = null;
  hasValidDropIndicator = false;
}

// Show guide wrapper at a specific index (during dragover)
function showGuideWrapper(container, index) {
  const wrapper = getGuideWrapper();
  
  // Check if already in correct position
  if (lastGuideWrapperIndex === index && 
      lastGuideWrapperContainer === container &&
      wrapper.parentElement === container) {
    // Already in correct position, just ensure it's visible
    if (wrapper.style.height === '0' || wrapper.style.opacity === '0') {
      requestAnimationFrame(() => {
        wrapper.style.height = `${GUIDE_LINE_HEIGHT}px`; // ========== TASK 2: Line-style guide
        wrapper.style.opacity = '1'; // Full opacity for thin line
      });
    }
    hasValidDropIndicator = true;
    return;
  }
  
  // Remove from current position if exists
  if (wrapper.parentElement) {
    wrapper.parentElement.removeChild(wrapper);
  }
  
  // Find insertion point based on index
  const allWrappers = Array.from(container.children).filter(child => {
    if (child.classList.contains('card-container')) {
      const card = child.querySelector('.data-card');
      return card && !card.classList.contains('dragging');
    }
    if (child.classList.contains('card-wrapper') && !child.dataset.guideWrapper) {
      const card = child.querySelector('.data-card');
      return card && !card.classList.contains('dragging');
    }
    if (child.classList.contains('directory-item') && !child.classList.contains('dragging')) {
      return true;
    }
    return false;
  });
  
  // Insert at correct position
  if (index === 0) {
    // Insert at beginning (after timeline header if exists)
    const firstHeader = container.querySelector('.timeline-header');
    if (firstHeader) {
      container.insertBefore(wrapper, firstHeader.nextSibling);
    } else {
      container.insertBefore(wrapper, container.firstChild);
    }
  } else if (index >= allWrappers.length) {
    // Insert at end
    container.appendChild(wrapper);
  } else {
    // Insert before wrapper at index
    const targetWrapper = allWrappers[index];
    container.insertBefore(wrapper, targetWrapper);
  }
  
  // Update tracking
  lastGuideWrapperIndex = index;
  lastGuideWrapperContainer = container;
  
  // Set initial state
  wrapper.style.width = '100%';
  wrapper.style.height = '0';
  wrapper.style.display = 'block';
  wrapper.style.opacity = '0';
  wrapper.style.margin = '3px 0'; // Consistent spacing (refined design)
  wrapper.style.flexShrink = '0';
  
  // ========== TASK 2: Animate to line-style guide state ==========
  requestAnimationFrame(() => {
    wrapper.style.height = `${GUIDE_LINE_HEIGHT}px`; // Slim line (2px)
    wrapper.style.opacity = '1'; // Full opacity for visibility
  });
  
  hasValidDropIndicator = true;
}

// Alias for backward compatibility (but prefer removeGuideWrapper)
function removeDropIndicator() {
  removeGuideWrapper();
}

// Calculate drop position based on mouse Y position with dead zone for stability
// Uses top 40% = above, bottom 40% = below, middle 20% = dead zone (prevents flickering)
function calculateDropPosition(e, element) {
  const rect = element.getBoundingClientRect();
  const elementHeight = rect.height;
  const mouseY = e.clientY;
  const relativeY = mouseY - rect.top;
  
  // Dead zone: middle 20% of element (40% to 60%)
  const deadZoneTop = elementHeight * 0.4;
  const deadZoneBottom = elementHeight * 0.6;
  
  // If in dead zone, maintain previous position or default to current position
  if (relativeY >= deadZoneTop && relativeY <= deadZoneBottom) {
    // Check if we have a previous position stored
    const previousIndicator = document.querySelector('.drop-indicator[style*="display: block"]');
    if (previousIndicator) {
      // Try to infer from current indicator position
      const indicatorTop = parseFloat(previousIndicator.style.top) || 0;
      const elementTop = relativeY;
      // If indicator is above element center, likely 'above', else 'below'
      return indicatorTop < elementHeight / 2 ? 'above' : 'below';
    }
    // Default: if mouse is in upper half of dead zone, use 'above', else 'below'
    return relativeY < elementHeight / 2 ? 'above' : 'below';
  }
  
  // Top 40% = above, bottom 40% = below
  return relativeY < deadZoneTop ? 'above' : 'below';
}

// Get the currently dragged card element
function getDraggedCard() {
  // Try to get from stored wrapper first (wrapper-centric)
  if (window.currentDraggedWrapper) {
    return window.currentDraggedWrapper.querySelector('.data-card');
  }
  // Fallback to query selector
  return document.querySelector('.data-card.dragging');
}

// Get the currently dragged wrapper element
function getDraggedWrapper() {
  return window.currentDraggedWrapper || document.querySelector('.card-wrapper[data-dragging-source="true"]');
}

// Check if a drop position is meaningful (not redundant)
// Updated for Single Bound approach where position is always 'above' (except last item 'below')
function isValidDropTarget(draggedCard, targetCard, position, container) {
  // If no dragged card, allow drop
  if (!draggedCard) return true;
  
  // If target is the dragged card itself, invalid
  if (targetCard === draggedCard) {
    return false;
  }
  
  // Get all cards in container (including dragged card for index calculation)
  const allCards = Array.from(container.children).filter(child => 
    child.classList.contains('data-card')
  );
  
  // Find indices
  const draggedIndex = allCards.indexOf(draggedCard);
  const targetIndex = allCards.indexOf(targetCard);
  
  // If dragged card not in this container, allow drop (cross-container move)
  if (draggedIndex === -1) return true;
  
  // If target not found, allow drop
  if (targetIndex === -1) return true;
  
  // Calculate what the new index would be after removing dragged card
  // With Single Bound, position is almost always 'above', except for last item 'below'
  let newIndex;
  if (position === 'above') {
    // Drop above target: newIndex = targetIndex
    // But if dragged is before target, we need to account for removal
    newIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  } else {
    // Position is 'below' (only for last item)
    // Drop below target: newIndex = targetIndex + 1
    // But if dragged is before target, we need to account for removal
    newIndex = draggedIndex < targetIndex ? targetIndex : targetIndex + 1;
  }
  
  // If new index equals current index, it's redundant
  if (newIndex === draggedIndex) {
    return false;
  }
  
  // With Single Bound, we only need to check 'above' position redundancy
  // (since 'below' only happens for last item, which is handled by newIndex check above)
  // Check if dropping "above" target that's immediately below dragged item
  // Example: Dragged at index 2, target at index 3, drop "above" target
  // After removing dragged, target becomes index 2, dropping "above" means newIndex = 2
  // This equals original draggedIndex (2), so it's redundant
  if (position === 'above' && targetIndex === draggedIndex + 1) {
    return false;
  }
  
  return true;
}

// Get dragged item ID from multiple sources
function getDraggedItemId(e) {
  return document.body.dataset.activeDragId || 
         e.dataTransfer.getData('application/x-datacard-id') ||
         e.dataTransfer.getData('text/plain') ||
         window.currentDraggedItemId ||
         null;
}

// Get source directory ID
function getSourceDirectoryId(e) {
  return document.body.dataset.activeSourceDirectoryId ||
         e.dataTransfer.getData('application/x-source-directory-id') ||
         null;
}

// ========== ENTRY ANIMATION ==========

// Animate item entry: wrapper grows from height 0 to natural size
function animateItemEntry(wrapper) {
  if (!wrapper || !wrapper.parentElement) return;
  
  // Get the card inside wrapper
  const card = wrapper.querySelector('.data-card');
  if (!card) return;
  
  // Measure natural height
  const cardHeight = card.offsetHeight;
  const gap = 8; // Match container gap
  const naturalHeight = cardHeight + gap;
  
  // Set initial state
  wrapper.style.height = '0';
  wrapper.style.opacity = '0';
  card.style.opacity = '0';
  
  // Force reflow
  void wrapper.offsetHeight;
  
  // Animate to natural size
  requestAnimationFrame(() => {
    wrapper.style.height = `${naturalHeight}px`;
    wrapper.style.opacity = '1';
    card.style.opacity = '1';
  });
}

// ========== CLOSEST TARGET DETECTION ==========

// Find the closest drop target (gap between items) based on mouse Y position
// Returns: { targetElement, position, index } or null if container is empty
function findClosestDropTarget(e, container) {
  const mouseY = e.clientY;
  const containerRect = container.getBoundingClientRect();
  
  // Get all valid wrappers/cards (excluding dragged card and placeholder)
  // Now ALL items should be in card-wrapper, but we handle both cases for safety
  const allWrappers = Array.from(container.children).filter(child => {
    if (child.classList.contains('dnd-placeholder') || 
        child.classList.contains('timeline-header') ||
        child.classList.contains('drop-indicator')) {
      return false;
    }
    if (child.classList.contains('card-container')) {
      const card = child.querySelector('.data-card');
      return card && !card.classList.contains('dragging');
    }
    if (child.classList.contains('card-wrapper')) {
      const card = child.querySelector('.data-card');
      return card && !card.classList.contains('dragging');
    }
    if (child.classList.contains('directory-item')) {
      return !child.classList.contains('dragging');
    }
    if (child.classList.contains('data-card')) {
      return !child.classList.contains('dragging');
    }
    return false;
  });
  
  const allCards = allWrappers.map(wrapper => {
    if (wrapper.classList.contains('card-container') || wrapper.classList.contains('card-wrapper')) {
      return wrapper.querySelector('.data-card') || wrapper;
    }
    return wrapper;
  }).filter(card => card);
  
  // If container is empty, return first position
  if (allCards.length === 0) {
    return {
      targetElement: null,
      position: 'above',
      index: 0,
      isEmpty: true
    };
  }
  
  // Check if mouse is below the last item (with tolerance)
  const lastCard = allCards[allCards.length - 1];
  const lastCardRect = lastCard.getBoundingClientRect();
  const containerBottom = containerRect.bottom;
  const tolerance = 30; // High tolerance for bottom edge
  
  // If mouse is near or below the last item, drop at the end
  // Use wrapper for index calculation
  if (mouseY >= (lastCardRect.bottom - tolerance) && mouseY <= (containerBottom + tolerance)) {
    // Find the wrapper containing this card
    const targetWrapper = lastCard.closest('.card-wrapper') || lastCard;
    return {
      targetElement: lastCard,
      targetWrapper: targetWrapper,
      position: 'below',
      index: allWrappers.length,
      isEmpty: false
    };
  }
  
  // Check if mouse is above the first item (with tolerance)
  const firstCard = allCards[0];
  const firstCardRect = firstCard.getBoundingClientRect();
  const containerTop = containerRect.top;
  
  // If mouse is near or above the first item, drop at the beginning
  if (mouseY <= (firstCardRect.top + tolerance) && mouseY >= (containerTop - tolerance)) {
    const targetWrapper = firstCard.closest('.card-wrapper') || firstCard;
    return {
      targetElement: firstCard,
      targetWrapper: targetWrapper,
      position: 'above',
      index: 0,
      isEmpty: false
    };
  }
  
  // Find the closest gap between items
  let closestGap = null;
  let minDistance = Infinity;
  
  for (let i = 0; i < allCards.length - 1; i++) {
    const currentCard = allCards[i];
    const nextCard = allCards[i + 1];
    
    const currentRect = currentCard.getBoundingClientRect();
    const nextRect = nextCard.getBoundingClientRect();
    
    // Gap is between currentCard.bottom and nextCard.top
    const gapTop = currentRect.bottom;
    const gapBottom = nextRect.top;
    const gapCenter = (gapTop + gapBottom) / 2;
    
    // Calculate distance from mouse to gap center
    const distance = Math.abs(mouseY - gapCenter);
    
    if (distance < minDistance) {
      minDistance = distance;
      // Determine which side of the gap the mouse is on
      // Use Single Bound: always show indicator at top of next card
      const targetWrapper = nextCard.closest('.card-wrapper') || nextCard;
      closestGap = {
        targetElement: nextCard,
        targetWrapper: targetWrapper,
        position: 'above',
        index: i + 1,
        isEmpty: false
      };
    }
  }
  
  // Also check distance to each card's center (for when mouse is over a card)
  for (let i = 0; i < allCards.length; i++) {
    const card = allCards[i];
    const cardRect = card.getBoundingClientRect();
    const cardCenter = cardRect.top + (cardRect.height / 2);
    const distance = Math.abs(mouseY - cardCenter);
    
    if (distance < minDistance) {
      minDistance = distance;
      // Determine position based on mouse Y relative to card center
      if (mouseY < cardCenter) {
        // Mouse in top half - drop above this card
        const targetWrapper = card.closest('.card-wrapper') || card;
        closestGap = {
          targetElement: card,
          targetWrapper: targetWrapper,
          position: 'above',
          index: i,
          isEmpty: false
        };
      } else {
        // Mouse in bottom half - drop below this card (or above next if exists)
        if (i < allCards.length - 1) {
          const nextCard = allCards[i + 1];
          const targetWrapper = nextCard.closest('.card-wrapper') || nextCard;
          closestGap = {
            targetElement: nextCard,
            targetWrapper: targetWrapper,
            position: 'above',
            index: i + 1,
            isEmpty: false
          };
        } else {
          // Last card - drop below
          const targetWrapper = card.closest('.card-wrapper') || card;
          closestGap = {
            targetElement: card,
            targetWrapper: targetWrapper,
            position: 'below',
            index: allWrappers.length,
            isEmpty: false
          };
        }
      }
    }
  }
  
  if (closestGap) {
    return closestGap;
  }
  
  // Fallback: first card
  const fallbackCard = allCards[0];
  const fallbackWrapper = fallbackCard.closest('.card-wrapper') || fallbackCard;
  return {
    targetElement: fallbackCard,
    targetWrapper: fallbackWrapper,
    position: 'above',
    index: 0,
    isEmpty: false
  };
}

// ========== UNIFIED DROP HANDLERS (Event Delegation) ==========

// Setup unified drop handlers on containers
function setupUnifiedDropHandlers() {
  // Main list container
  const mainList = document.getElementById('dock-itemlist');
  if (mainList && !mainList.dataset.unifiedDnDAttached) {
    mainList.dataset.unifiedDnDAttached = 'true';
    setupContainerDropHandlers(mainList, null); // null = main list
  }
  
  // Directory containers
  document.querySelectorAll('.directory-items-container').forEach(container => {
    if (!container.dataset.unifiedDnDAttached) {
      container.dataset.unifiedDnDAttached = 'true';
      const directoryItem = container.closest('.directory-item');
      const directoryId = directoryItem ? directoryItem.dataset.directoryId : null;
      setupContainerDropHandlers(container, directoryId);
    }
  });
  
  // Setup directory header drop handlers (for collapsed directories - items only)
  setupDirectoryHeaderDropHandlers();
  
  // Setup directory list drop handlers (for directory reordering)
  setupDirectoryListDropHandlers();
}

// Setup drop handlers for a container (event delegation)
function setupContainerDropHandlers(container, targetDirectoryId) {
  // dragover - handle indicator display using Closest Target logic
  container.addEventListener('dragover', (e) => {
    // Ignore directory drags - directories can only be dropped in #directory-list
    const draggedDirectoryId = document.body.dataset.activeDragDirectoryId ||
                               e.dataTransfer.getData('application/x-directory-id');
    if (draggedDirectoryId) {
      // This is a directory drag, ignore it (let directory list handler process it)
      return;
    }
    
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const draggedCard = getDraggedCard();
    
    // Use Closest Target detection instead of relying on e.target
    const closestTarget = findClosestDropTarget(e, container);
    
    if (!closestTarget) {
      removeGuideWrapper();
      return;
    }
    
    // Handle empty container case
    if (closestTarget.isEmpty) {
      // Container is empty - show guide wrapper at index 0
      showGuideWrapper(container, 0);
      hasValidDropIndicator = true;
      return;
    }
    
    // Validate drop target
    if (isValidDropTarget(draggedCard, closestTarget.targetElement, closestTarget.position, container)) {
      // Show guide wrapper at the calculated index
      showGuideWrapper(container, closestTarget.index);
      hasValidDropIndicator = true;
    } else {
      // Redundant position - remove guide wrapper
      removeGuideWrapper();
    }
  });
  
  // dragleave - remove placeholder and clear hover timer
  // CRITICAL: Only trigger cleanup when truly leaving the entire container
  container.addEventListener('dragleave', (e) => {
    // Enhanced check: Only process if truly leaving the container
    // relatedTarget can be null, the container itself, or a child element
    const relatedTarget = e.relatedTarget;
    
    // If relatedTarget is null, we're leaving the window - definitely remove
    if (!relatedTarget) {
      removeGuideWrapper();
      hasValidDropIndicator = false;
      
      // Clear directory hover timer
      if (directoryHoverTimer) {
        clearTimeout(directoryHoverTimer);
        directoryHoverTimer = null;
        hoveredDirectoryItem = null;
      }
      
      console.log('[DnD] dragleave - removed guide wrapper (left window)');
      return;
    }
    
    // If relatedTarget is not a child of the container, we're leaving the container
    if (!container.contains(relatedTarget)) {
      // Additional check: Make sure we're not just moving to the guide wrapper itself
      if (relatedTarget !== guideWrapper && !relatedTarget.dataset.guideWrapper) {
        removeGuideWrapper();
        hasValidDropIndicator = false;
        
        // Clear directory hover timer
        if (directoryHoverTimer) {
          clearTimeout(directoryHoverTimer);
          directoryHoverTimer = null;
          hoveredDirectoryItem = null;
        }
        
        console.log('[DnD] dragleave - removed guide wrapper (left container)');
      }
    }
    // If relatedTarget is still within the container, do nothing (prevents flicker)
  });
  
  // drop - handle drop with optimistic UI and Firestore sync
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    
    // ========== STEP 1: Identify Drop Target FIRST ==========
    const draggedItemId = getDraggedItemId(e);
    const sourceDirectoryId = getSourceDirectoryId(e);
    
    if (!draggedItemId) {
      console.error('[DnD] No dragged item ID found');
      return;
    }
    
    // ========== TASK 2: Get the dragged wrapper (wrapper-centric) ==========
    let draggedWrapper = getDraggedWrapper();
    if (!draggedWrapper) {
      console.error('[DnD] Dragged wrapper element not found');
      return;
    }
    
    // Get the card from the wrapper (preserve HTML)
    const draggedCard = draggedWrapper.querySelector('.data-card');
    if (!draggedCard) {
      console.error('[DnD] No card found in dragged wrapper');
      return;
    }
    
    // Check if dropping on a directory header (valid target even without indicator)
    const targetDirectoryHeader = e.target.closest('.directory-item-header');
    const isDirectoryDrop = !!targetDirectoryHeader;
    
    // Check if dropping on a card
    const targetCard = e.target.closest('.data-card');
    
    // Capture indicator state BEFORE removing it
    const isValidIndicatorDrop = hasValidDropIndicator;
    
    // ========== STEP 2: Final Validity Check ==========
    // Drop is valid if: (1) There's a valid indicator, OR (2) It's a directory header drop
    if (!isDirectoryDrop && !isValidIndicatorDrop) {
      console.log('[DnD] ❌ Drop canceled: Neither an indicator nor a directory header.');
      
      // Cleanup visual states only
      draggedCard.classList.remove('dragging');
      
      // Cleanup directory drag-over states
      document.querySelectorAll('.directory-item.drag-over').forEach(item => {
        item.classList.remove('drag-over');
      });
      
      // Remove guide wrapper (cleanup)
      removeGuideWrapper();
      
      // DO NOT set isSyncing flag - this was an invalid drop
      // DO NOT call Firestore - this was an invalid drop
      // DO NOT update DOM - this was an invalid drop
      return;
    }
    
    // ========== STEP 3: Calculate Drop Index using Closest Target Logic ==========
    // Use the same closest target detection as dragover for consistency
    const closestTarget = findClosestDropTarget(e, container);
    let newIndex;
    let position = null;
    
    if (!closestTarget) {
      console.log('[DnD] ❌ Could not find closest drop target, canceling');
      draggedCard.classList.remove('dragging');
      removeGuideWrapper();
      return;
    }
    
    // Use the closest target's calculated index and position
    newIndex = closestTarget.index;
    position = closestTarget.position;
    
    // Validate newIndex is a number
    if (typeof newIndex !== 'number' || isNaN(newIndex)) {
      console.error('[DnD] ❌ Invalid newIndex calculated:', newIndex);
      draggedCard.classList.remove('dragging');
      removeGuideWrapper();
      return;
    }
    
    // ========== STEP 4: Determine Target Directory (before animations) ==========
    const normalizedTargetDirectoryId = targetDirectoryId === null || targetDirectoryId === 'undefined' || targetDirectoryId === undefined 
      ? null 
      : targetDirectoryId;
    const normalizedSourceDirectoryId = sourceDirectoryId === null || sourceDirectoryId === 'undefined' || sourceDirectoryId === undefined 
      ? null 
      : sourceDirectoryId;
    
    // Log drop information
    console.log('[DnD] Drop:', {
      draggedItemId,
      sourceDirectoryId: normalizedSourceDirectoryId,
      targetDirectoryId: normalizedTargetDirectoryId || 'main-list',
      position: position || 'empty',
      newIndex,
      isDirectoryDrop,
      isValidIndicatorDrop
    });
    
    // Check if user is signed in
    if (!currentUser) {
      console.error('[DnD] No user signed in, cannot save to Firestore');
      draggedCard.classList.remove('dragging');
      removeGuideWrapper();
      return;
    }
    
    // ========== STEP 5: Remove Guide Wrapper (drop confirmed) ==========
    removeGuideWrapper();
    
    // ========== TASK 2: Get the dragged wrapper (Optimistic UI) ==========
    // Use the wrapper we already found above, or get it from the card
    if (!draggedWrapper) {
      draggedWrapper = window.currentDraggedWrapper || draggedCard.closest('.card-wrapper');
    }
    if (!draggedWrapper) {
      console.error('[DnD] No dragged wrapper found');
      draggedCard.classList.remove('dragging');
      return;
    }
    
    // Get the card from the wrapper (preserve HTML)
    const cardInWrapper = draggedWrapper.querySelector('.data-card');
    if (!cardInWrapper) {
      console.error('[DnD] No card found in dragged wrapper');
      draggedCard.classList.remove('dragging');
      return;
    }
    
    // ========== TASK 2: Optimistic UI - Instant DOM Reordering ==========
    // List item to move: card-container (wraps card-wrapper) or card-wrapper (guide/legacy)
    const listItemToMove = draggedWrapper.closest('.card-container') || draggedWrapper;
    // Find all list items in the target container (excluding guide wrapper and dragged item)
    const allWrappers = Array.from(container.children).filter(child => {
      if (child === listItemToMove) return false; // Exclude dragged item
      if (child.dataset.guideWrapper) return false; // Exclude guide wrapper
      if (child.classList.contains('card-container')) {
        const card = child.querySelector('.data-card');
        return card && !card.classList.contains('dragging');
      }
      if (child.classList.contains('card-wrapper')) {
        const card = child.querySelector('.data-card');
        return card && !card.classList.contains('dragging');
      }
      if (child.classList.contains('directory-item') && !child.classList.contains('dragging')) {
        return true;
      }
      return false;
    });
    
    // Determine insertion point
    let insertBeforeElement = null;
    if (newIndex === 0) {
      const firstHeader = container.querySelector('.timeline-header');
      if (firstHeader) {
        insertBeforeElement = firstHeader.nextSibling;
      } else {
        insertBeforeElement = container.firstChild;
      }
    } else if (newIndex >= allWrappers.length) {
      insertBeforeElement = null; // Append to end
    } else {
      insertBeforeElement = allWrappers[newIndex];
    }
    
    // ========== TASK 2: Physically move the list item DOM element ==========
    const sourceContainer = listItemToMove.parentElement;
    if (sourceContainer && sourceContainer !== container) {
      listItemToMove.remove();
    }
    if (insertBeforeElement && insertBeforeElement.parentElement === container) {
      container.insertBefore(listItemToMove, insertBeforeElement);
    } else {
      container.appendChild(listItemToMove);
    }
    
    // ========== TASK 3: Restore wrapper to visible state and set content-driven height ==========
    // Remove dragging source flag and class
    draggedWrapper.dataset.draggingSource = '';
    draggedWrapper.classList.remove('is-dragging-source');
    draggedWrapper.style.pointerEvents = ''; // Restore pointer events
    
    // Restore wrapper visibility and animate expansion
    draggedWrapper.style.height = `${GUIDE_LINE_HEIGHT}px`; // Start at line height
    draggedWrapper.style.margin = '';
    draggedWrapper.style.opacity = '1';
    draggedWrapper.style.overflow = 'hidden';
    draggedWrapper.style.transition = 'height 0.3s cubic-bezier(0.2, 0, 0, 1), background-color 0.2s ease';
    
    // ========== TASK 5: Subtle purple flash on drop ==========
    draggedWrapper.style.backgroundColor = 'rgba(var(--blink-accent-rgb, 188, 19, 254), 0.10)';
    
    // Remove dragging class from card
    cardInWrapper.classList.remove('dragging');
    
    // ========== TASK 3: Animate wrapper expansion to natural height ==========
    requestAnimationFrame(() => {
      void draggedWrapper.offsetHeight; // Force layout
      
      requestAnimationFrame(() => {
        // Animate to natural height
        draggedWrapper.style.height = `${WRAPPER_HEIGHT}px`;
        
        // ========== TASK 3: Set to auto height after animation ==========
        const handleTransitionEnd = (e) => {
          if (e.target === draggedWrapper && e.propertyName === 'height') {
            draggedWrapper.style.height = 'auto';
            draggedWrapper.style.minHeight = '';
            draggedWrapper.removeEventListener('transitionend', handleTransitionEnd);
          }
        };
        draggedWrapper.addEventListener('transitionend', handleTransitionEnd);
        
        // Fallback: Set to auto after 300ms
        setTimeout(() => {
          if (draggedWrapper.style.height !== 'auto') {
            draggedWrapper.style.height = 'auto';
            draggedWrapper.style.minHeight = '';
          }
        }, 300);
        
        // ========== TASK 5: Fade out purple flash ==========
        setTimeout(() => {
          draggedWrapper.style.backgroundColor = '';
        }, 200);
      });
    });
    
    // ========== TASK 3: MutationObserver to ensure content-driven height ==========
    // Watch for any attempts to set fixed height and convert to auto
    const heightObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          const height = draggedWrapper.style.height;
          // If height is set to a fixed pixel value after 300ms, convert to auto
          if (height && height !== 'auto' && !height.includes('calc') && !height.includes('%')) {
            const heightNum = parseFloat(height);
            if (!isNaN(heightNum) && heightNum > 0) {
              // Only convert if it's been more than 300ms since drop
              setTimeout(() => {
                if (draggedWrapper.style.height === height) {
                  draggedWrapper.style.height = 'auto';
                  draggedWrapper.style.minHeight = '';
                }
              }, 50);
            }
          }
        }
      });
    });
    
    heightObserver.observe(draggedWrapper, {
      attributes: true,
      attributeFilter: ['style']
    });
    
    // Stop observing after 1 second (animation should be done)
    setTimeout(() => {
      heightObserver.disconnect();
    }, 1000);
    
    // ========== TASK 2: Firestore Sync (Background, Optimistic UI) ==========
    // Set syncing flag BEFORE Firestore call
    isSyncing = true;
    
    // Start Firestore update in background (UI is already updated optimistically)
    const firestorePromise = window.electronAPI.firestore.moveItemToPosition(
      currentUser.uid,
      draggedItemId,
      normalizedTargetDirectoryId,
      newIndex,
      normalizedSourceDirectoryId
    );
    
    // Handle Firestore result (rollback on error)
    firestorePromise.then((result) => {
      if (!result.success) {
        console.error('[DnD] ❌ Firestore update failed:', result.error);
        isSyncing = false;
        
        // ========== TASK 2: Rollback Optimistic UI on error ==========
        if (sourceContainer && sourceContainer !== container) {
          listItemToMove.remove();
          sourceContainer.appendChild(listItemToMove);
        } else {
          // Was moved within same container - need to calculate original index
          // For now, just reload data to restore correct state
          loadData(true);
        }
        
        // Restore wrapper visibility
        draggedWrapper.style.height = '';
        draggedWrapper.style.margin = '';
        draggedWrapper.style.opacity = '';
        draggedWrapper.style.overflow = '';
        draggedWrapper.style.transition = '';
        draggedWrapper.style.backgroundColor = '';
        draggedWrapper.dataset.draggingSource = '';
        
        alert(`Failed to move item: ${result.error || 'Unknown error'}`);
        return;
      }
      
      console.log('[DnD] ✅ Firestore update successful (optimistic UI confirmed)');
      
      // Reset syncing flag after a short delay
      setTimeout(() => {
        isSyncing = false;
        console.log('[DnD] Sync flag reset - listener will process next event');
      }, 100);
      
      // UI is already in correct position, no need to reload
      // Firestore listener will update any data changes if needed
      
    }).catch((firestoreError) => {
      console.error('[DnD] ❌ Firestore update error:', firestoreError);
      isSyncing = false;
      
      // ========== TASK 2: Rollback Optimistic UI on error ==========
      if (sourceContainer && sourceContainer !== container) {
        listItemToMove.remove();
        sourceContainer.appendChild(listItemToMove);
      } else {
        loadData(true);
      }
      
      draggedWrapper.style.height = '';
      draggedWrapper.style.margin = '';
      draggedWrapper.style.opacity = '';
      draggedWrapper.style.overflow = '';
      draggedWrapper.style.transition = '';
      draggedWrapper.style.backgroundColor = '';
      draggedWrapper.dataset.draggingSource = '';
      
      alert(`Failed to move item: ${firestoreError.message || 'Unknown error'}`);
    });
  });
}

// Setup directory header drop handlers (for collapsed directories)
function setupDirectoryHeaderDropHandlers() {
  // Clear any existing handlers by re-querying
  document.querySelectorAll('.directory-item').forEach(directoryItem => {
    const header = directoryItem.querySelector('.directory-item-header');
    if (!header || header.dataset.dropHandlerAttached === 'true') return;
    
    header.dataset.dropHandlerAttached = 'true';
    const directoryId = directoryItem.dataset.directoryId;
    
    // Hover-to-expand timer
    let hoverTimer = null;
    
    // dragover - handle hover-to-expand and visual feedback (pointer-based detection)
    header.addEventListener('dragover', (e) => {
      // Ignore directory drags - directories can only be dropped in #directory-list
      const draggedDirectoryId = document.body.dataset.activeDragDirectoryId ||
                                 e.dataTransfer.getData('application/x-directory-id');
      if (draggedDirectoryId) {
        // This is a directory drag, ignore it (let directory list handler process it)
        return;
      }
      
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      
      // ========== POINTER-BASED DETECTION ==========
      // Use mouse pointer coordinates instead of event target (which can be triggered by ghost image)
      const pointerElement = document.elementFromPoint(e.clientX, e.clientY);
      
      // Verify that the mouse pointer is actually over the directory header or its children
      const isPointerOverHeader = pointerElement && (
        pointerElement === header ||
        header.contains(pointerElement) ||
        pointerElement.closest('.directory-item-header') === header
      );
      
      // Only proceed if pointer is actually over the header
      if (!isPointerOverHeader) {
        // Pointer is not over header - clear any existing timer and visual state
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
          hoveredDirectoryItem = null;
        }
        directoryItem.classList.remove('drag-over');
        return;
      }
      
      // Visual feedback (only if pointer is over header)
      directoryItem.classList.add('drag-over');
      
      // Hover-to-expand: If directory is collapsed, start timer
      const isExpanded = directoryItem.dataset.expanded === 'true';
      if (!isExpanded) {
        if (!hoverTimer) {
          hoverTimer = setTimeout(() => {
            console.log(`[DnD] Auto-expanding directory ${directoryId} after 600ms hover`);
            toggleDirectoryExpansion(directoryItem);
            hoverTimer = null;
            hoveredDirectoryItem = null;
          }, 600);
          hoveredDirectoryItem = directoryItem;
        }
      }
    });
    
    // dragenter - ensure timer starts
    header.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    
    // dragleave - clear hover timer if leaving directory (pointer-based detection)
    header.addEventListener('dragleave', (e) => {
      // Use pointer coordinates to verify we're actually leaving
      const pointerElement = e.relatedTarget ? 
        document.elementFromPoint(e.clientX, e.clientY) : null;
      
      // Only clear if we're actually leaving the directory item (not just moving to a child)
      const isStillOverHeader = pointerElement && (
        pointerElement === header ||
        header.contains(pointerElement) ||
        pointerElement.closest('.directory-item-header') === header
      );
      
      if (!isStillOverHeader && !directoryItem.contains(e.relatedTarget)) {
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
          hoveredDirectoryItem = null;
        }
        directoryItem.classList.remove('drag-over');
      }
    });
    
    // drop - handle drop on collapsed directory header (items only, not directories)
    header.addEventListener('drop', async (e) => {
      // Ignore directory drags - directories can only be dropped in #directory-list
      const draggedDirectoryId = document.body.dataset.activeDragDirectoryId ||
                                 e.dataTransfer.getData('application/x-directory-id');
      if (draggedDirectoryId) {
        // This is a directory drag, ignore it (let directory list handler process it)
        return;
      }
      
      e.preventDefault();
      e.stopPropagation();
      
      // Clear hover timer
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
        hoveredDirectoryItem = null;
      }
      
      directoryItem.classList.remove('drag-over');
      
      const draggedItemId = getDraggedItemId(e);
      const sourceDirectoryId = getSourceDirectoryId(e);
      
      if (!draggedItemId) {
        console.error('[DnD] No dragged item ID found');
        return;
      }
      
      // Get the dragged card element
      const draggedCard = getDraggedCard();
      if (!draggedCard) {
        console.error('[DnD] Dragged card element not found');
        return;
      }
      
      // Check if user is signed in
      if (!currentUser) {
        console.error('[DnD] No user signed in, cannot save to Firestore');
        return;
      }
      
      // Normalize directory IDs
      const normalizedTargetDirectoryId = directoryId;
      const normalizedSourceDirectoryId = sourceDirectoryId === null || sourceDirectoryId === 'undefined' || sourceDirectoryId === undefined 
        ? null 
        : sourceDirectoryId;
      
      console.log('[DnD] Drop on collapsed directory header:', {
        draggedItemId,
        sourceDirectoryId: normalizedSourceDirectoryId,
        targetDirectoryId: normalizedTargetDirectoryId,
        newIndex: 0 // Always first position when dropping on collapsed directory
      });
      
      // Get the items container
      const itemsContainer = directoryItem.querySelector('.directory-items-container');
      if (!itemsContainer) {
        console.error('[DnD] Directory items container not found');
        return;
      }
      
      // ========== CAPTURE SOURCE POSITION (for Vacuum animation) ==========
      const draggedCardRect = draggedCard.getBoundingClientRect();
      const sourceX = draggedCardRect.left;
      const sourceY = draggedCardRect.top;
      const sourceWidth = draggedCardRect.width;
      const sourceHeight = draggedCardRect.height;
      
      // ========== EXPAND DIRECTORY FIRST ==========
      if (directoryItem.dataset.expanded !== 'true') {
        toggleDirectoryExpansion(directoryItem);
        // Wait a frame for expansion to render
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      
      // ========== TASK 2: Optimistic UI for Directory Drop ==========
      // Get the dragged wrapper (wrapper-centric)
      const draggedWrapper = window.currentDraggedWrapper || draggedCard.closest('.card-wrapper');
      if (!draggedWrapper) {
        console.error('[DnD] No dragged wrapper found for directory drop');
        draggedCard.classList.remove('dragging');
        return;
      }
      
      const listItemToMove = draggedWrapper.closest('.card-container') || draggedWrapper;
      const allWrappers = Array.from(itemsContainer.children).filter(child => {
        if (child === listItemToMove) return false;
        if (child.dataset.guideWrapper) return false;
        if (child.classList.contains('card-container')) {
          const card = child.querySelector('.data-card');
          return card && !card.classList.contains('dragging');
        }
        if (child.classList.contains('card-wrapper')) {
          const card = child.querySelector('.data-card');
          return card && !card.classList.contains('dragging');
        }
        return false;
      });
      
      const newIndex = 0;
      let insertBeforeElement = null;
      if (allWrappers.length === 0) {
        insertBeforeElement = null;
      } else {
        insertBeforeElement = allWrappers[0];
      }
      
      const sourceContainer = listItemToMove.parentElement;
      if (sourceContainer && sourceContainer !== itemsContainer) {
        listItemToMove.remove();
      }
      if (insertBeforeElement && insertBeforeElement.parentElement === itemsContainer) {
        itemsContainer.insertBefore(listItemToMove, insertBeforeElement);
      } else {
        itemsContainer.appendChild(listItemToMove);
      }
      
      // ========== TASK 3: Restore wrapper to visible state ==========
      draggedWrapper.dataset.draggingSource = '';
      draggedWrapper.classList.remove('is-dragging-source');
      
      // Restore wrapper visibility and animate expansion
      draggedWrapper.style.height = `${GUIDE_LINE_HEIGHT}px`; // Start at line height
      draggedWrapper.style.margin = '';
      draggedWrapper.style.opacity = '1';
      draggedWrapper.style.overflow = 'hidden';
      draggedWrapper.style.transition = 'height 0.3s cubic-bezier(0.2, 0, 0, 1), opacity 0.3s cubic-bezier(0.2, 0, 0, 1), background-color 0.2s ease';
      
      // Subtle purple flash on drop
      draggedWrapper.style.backgroundColor = 'rgba(var(--blink-accent-rgb, 188, 19, 254), 0.10)';
      
      // Remove dragging class from card
      const cardInWrapper = draggedWrapper.querySelector('.data-card');
      if (cardInWrapper) {
        cardInWrapper.classList.remove('dragging');
      }
      
      // Animate wrapper expansion to natural height
      requestAnimationFrame(() => {
        void draggedWrapper.offsetHeight; // Force layout
        
        requestAnimationFrame(() => {
          // Animate to natural height
          draggedWrapper.style.height = `${WRAPPER_HEIGHT}px`;
          
          // Set to auto height after animation
          const handleTransitionEnd = (e) => {
            if (e.target === draggedWrapper && e.propertyName === 'height') {
              draggedWrapper.style.height = 'auto';
              draggedWrapper.style.minHeight = '';
              draggedWrapper.removeEventListener('transitionend', handleTransitionEnd);
            }
          };
          draggedWrapper.addEventListener('transitionend', handleTransitionEnd);
          
          // Fallback: Set to auto after 300ms
          setTimeout(() => {
            if (draggedWrapper.style.height !== 'auto') {
              draggedWrapper.style.height = 'auto';
              draggedWrapper.style.minHeight = '';
            }
          }, 300);
          
          // Fade out purple flash
          setTimeout(() => {
            draggedWrapper.style.backgroundColor = '';
          }, 200);
        });
      });
      
      // ========== TASK 2: Firestore Sync (Background, Optimistic UI) ==========
      isSyncing = true;
      
      // Start Firestore update in background (UI is already updated optimistically)
      const firestorePromise = window.electronAPI.firestore.moveItemToPosition(
        currentUser.uid,
        draggedItemId,
        normalizedTargetDirectoryId,
        0, // Always index 0 for collapsed directory drops
        normalizedSourceDirectoryId
      );
      
      // Handle Firestore result (rollback on error)
      firestorePromise.then((result) => {
        if (!result.success) {
          console.error('[DnD] ❌ Firestore update failed:', result.error);
          isSyncing = false;
          
          // Rollback Optimistic UI on error
          if (sourceContainer && sourceContainer !== itemsContainer) {
            listItemToMove.remove();
            sourceContainer.appendChild(listItemToMove);
          } else {
            loadData(true);
          }
          
          draggedWrapper.style.height = '';
          draggedWrapper.style.margin = '';
          draggedWrapper.style.opacity = '';
          draggedWrapper.style.overflow = '';
          draggedWrapper.style.transition = '';
          draggedWrapper.style.backgroundColor = '';
          draggedWrapper.dataset.draggingSource = '';
          
          alert(`Failed to move item: ${result.error || 'Unknown error'}`);
          return;
        }
        
        console.log('[DnD] ✅ Firestore update successful (optimistic UI confirmed)');
        
        setTimeout(() => {
          isSyncing = false;
          console.log('[DnD] Sync flag reset - listener will process next event');
        }, 100);
        
        // UI is already in correct position, no need to reload
        
      }).catch((firestoreError) => {
        console.error('[DnD] ❌ Firestore update error:', firestoreError);
        isSyncing = false;
        
        if (sourceContainer && sourceContainer !== itemsContainer) {
          listItemToMove.remove();
          sourceContainer.appendChild(listItemToMove);
        } else {
          loadData(true);
        }
        
        draggedWrapper.style.height = '';
        draggedWrapper.style.margin = '';
        draggedWrapper.style.opacity = '';
        draggedWrapper.style.overflow = '';
        draggedWrapper.style.transition = '';
        draggedWrapper.style.backgroundColor = '';
        draggedWrapper.dataset.draggingSource = '';
        
        alert(`Failed to move item: ${firestoreError.message || 'Unknown error'}`);
      });
    });
  });
}

// Setup directory list drop handlers (for directory reordering)
function setupDirectoryListDropHandlers() {
  const directoryList = document.getElementById('directory-list');
  if (!directoryList || directoryList.dataset.directoryDnDAttached === 'true') return;
  
  directoryList.dataset.directoryDnDAttached = 'true';
  
  // dragover - handle indicator display for directories
  directoryList.addEventListener('dragover', (e) => {
    // Only handle directory drags (not item drags)
    const draggedDirectoryId = document.body.dataset.activeDragDirectoryId ||
                               e.dataTransfer.getData('application/x-directory-id');
    
    if (!draggedDirectoryId) {
      // Not a directory drag, let other handlers process it
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    
    const draggedDirectoryItem = document.querySelector(`[data-directory-id="${draggedDirectoryId}"]`);
    
    // Use Closest Target detection for directories
    const closestTarget = findClosestDropTarget(e, directoryList);
    
    if (!closestTarget) {
      removeGuideWrapper();
      return;
    }
    
    // Handle empty container case
    if (closestTarget.isEmpty) {
      // Directory list is empty - show guide wrapper at index 0
      showGuideWrapper(directoryList, 0);
      hasValidDropIndicator = true;
      return;
    }
    
    // Validate drop target
    if (isValidDropTarget(draggedDirectoryItem, closestTarget.targetElement, closestTarget.position, directoryList)) {
      // Show guide wrapper at the calculated index
      showGuideWrapper(directoryList, closestTarget.index);
      hasValidDropIndicator = true;
    } else {
      // Redundant position - remove guide wrapper
      removeGuideWrapper();
    }
  });
  
  // dragleave - remove indicator
  // dragleave - remove placeholder
  // CRITICAL: Only trigger cleanup when truly leaving the entire container
  directoryList.addEventListener('dragleave', (e) => {
    // Only handle directory drags
    const draggedDirectoryId = document.body.dataset.activeDragDirectoryId;
    if (!draggedDirectoryId) return;
    
    const relatedTarget = e.relatedTarget;
    
    // If relatedTarget is null, we're leaving the window - definitely remove
    if (!relatedTarget) {
      removeGuideWrapper();
      hasValidDropIndicator = false;
      console.log('[DnD] dragleave (directory) - removed guide wrapper (left window)');
      return;
    }
    
    // If relatedTarget is not a child of the directory list, we're leaving
    if (!directoryList.contains(relatedTarget)) {
      // Additional check: Make sure we're not just moving to the guide wrapper itself
      if (relatedTarget !== guideWrapper && !relatedTarget.dataset.guideWrapper) {
        removeGuideWrapper();
        hasValidDropIndicator = false;
        console.log('[DnD] dragleave (directory) - removed guide wrapper (left container)');
      }
    }
    // If relatedTarget is still within the directory list, do nothing (prevents flicker)
  });
  
  // drop - handle directory reordering
  directoryList.addEventListener('drop', async (e) => {
    // Only handle directory drags
    const draggedDirectoryId = document.body.dataset.activeDragDirectoryId ||
                               e.dataTransfer.getData('application/x-directory-id');
    
    if (!draggedDirectoryId) {
      // Not a directory drag, let other handlers process it
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    // ========== STEP 1: Identify Drop Target ==========
    const targetDirectoryItem = e.target.closest('.directory-item');
    const draggedDirectoryItem = document.querySelector(`[data-directory-id="${draggedDirectoryId}"]`);
    
    if (!draggedDirectoryItem) {
      console.error('[DnD] Dragged directory item not found');
      return;
    }
    
    // Capture indicator state BEFORE removing
    const isValidIndicatorDrop = hasValidDropIndicator;
    
    // ========== STEP 2: Final Validity Check ==========
    if (!targetDirectoryItem && !isValidIndicatorDrop) {
      console.log('[DnD] ❌ Directory drop canceled: No valid target');
      
      // Cleanup visual states
      draggedDirectoryItem.classList.remove('dragging');
      removeGuideWrapper();
      return;
    }
    
    // ========== STEP 3: Calculate Drop Index using Closest Target Logic ==========
    // Use the same closest target detection as dragover for consistency
    const closestTarget = findClosestDropTarget(e, directoryList);
    let newIndex;
    
    if (!closestTarget) {
      console.log('[DnD] ❌ Could not find closest drop target for directory, canceling');
      draggedDirectoryItem.classList.remove('dragging');
      removeGuideWrapper();
      return;
    }
    
    // Use the closest target's calculated index
    newIndex = closestTarget.index;
    
    // Validate newIndex
    if (typeof newIndex !== 'number' || isNaN(newIndex)) {
      console.error('[DnD] ❌ Invalid newIndex calculated:', newIndex);
      draggedDirectoryItem.classList.remove('dragging');
      removeGuideWrapper();
      return;
    }
    
    // ========== STEP 4: Remove Guide Wrapper (drop confirmed) ==========
    removeGuideWrapper();
    
    // ========== TASK 5: Optimistic UI for Directories ==========
    // Find all directory items (excluding dragged one)
    const allDirectoryItems = Array.from(directoryList.children).filter(child => 
      child.classList.contains('directory-item') && child !== draggedDirectoryItem
    );
    
    // Determine insertion point
    let insertBeforeElement = null;
    if (newIndex === 0) {
      insertBeforeElement = directoryList.firstChild;
    } else if (newIndex >= allDirectoryItems.length) {
      insertBeforeElement = null; // Append to end
    } else {
      insertBeforeElement = allDirectoryItems[newIndex];
    }
    
    // ========== TASK 2: Physically move the directory DOM element ==========
    const sourceContainer = draggedDirectoryItem.parentElement;
    
    // ========== TASK 2: Instant "Space Closure" on Drop ==========
    // Remove from current position (if moving within same container, DOM will handle it)
    // Old position closes naturally since DOM element moved
    if (sourceContainer && sourceContainer !== directoryList) {
      draggedDirectoryItem.remove();
    }
    
    // Insert directory at new position (instant UI update)
    if (insertBeforeElement && insertBeforeElement.parentElement === directoryList) {
      directoryList.insertBefore(draggedDirectoryItem, insertBeforeElement);
    } else {
      directoryList.appendChild(draggedDirectoryItem);
    }
    
    // ========== TASK 5: Restore directory visibility ==========
    draggedDirectoryItem.style.opacity = '1';
    draggedDirectoryItem.style.transition = '';
    draggedDirectoryItem.classList.remove('dragging');
    draggedDirectoryItem.classList.remove('is-dragging-source');
    draggedDirectoryItem.dataset.draggingSource = '';
    
    // ========== TASK 2: Firestore Sync (Background, Optimistic UI) ==========
    if (!currentUser) {
      console.error('[DnD] No user signed in, cannot save to Firestore');
      return;
    }
    
    console.log('[DnD] Directory drop (optimistic):', {
      draggedDirectoryId,
      newIndex
    });
    
    // Set syncing flag
    isSyncing = true;
    
    // Start Firestore update in background (UI is already updated optimistically)
    const firestorePromise = window.electronAPI.firestore.moveDirectoryToPosition(
      currentUser.uid,
      draggedDirectoryId,
      newIndex
    );
    
    // Handle Firestore result (rollback on error)
    firestorePromise.then((result) => {
      if (!result.success) {
        console.error('[DnD] ❌ Firestore update failed:', result.error);
        isSyncing = false;
        
        // ========== TASK 2: Rollback Optimistic UI on error ==========
        if (sourceContainer && sourceContainer !== directoryList) {
          draggedDirectoryItem.remove();
          sourceContainer.appendChild(draggedDirectoryItem);
        } else {
          loadDirectories(currentUser.uid);
        }
        
        alert(`Failed to move directory: ${result.error || 'Unknown error'}`);
        return;
      }
      
      console.log('[DnD] ✅ Firestore update successful (optimistic UI confirmed)');
      
      setTimeout(() => {
        isSyncing = false;
        console.log('[DnD] Sync flag reset - listener will process next event');
      }, 100);
      
      // UI is already in correct position, no need to reload
      
    }).catch((firestoreError) => {
      console.error('[DnD] ❌ Firestore update error:', firestoreError);
      isSyncing = false;
      
      // ========== TASK 2: Rollback Optimistic UI on error ==========
      if (sourceContainer && sourceContainer !== directoryList) {
        draggedDirectoryItem.remove();
        sourceContainer.appendChild(draggedDirectoryItem);
      } else {
        loadDirectories(currentUser.uid);
      }
      
      alert(`Failed to move directory: ${firestoreError.message || 'Unknown error'}`);
    });
  });
}

// Cleanup drag state
async function cleanupDragState() {
  if (!globalDragState.isActive) return;
  if (globalDragState.originalCard) {
    globalDragState.originalCard.classList.remove('dragging');
    globalDragState.originalCard.style.pointerEvents = '';
  }
  if (globalDragState.mouseupFallback) {
    window.removeEventListener('mouseup', globalDragState.mouseupFallback, { capture: true });
  }
  window.currentDraggedItemId = null;
  window.currentDraggedItemUrl = null;
  globalDragState = { isActive: false, originalCard: null, mouseupFallback: null };
}

// Delete item
async function deleteItem(itemId) {
  console.log('[DeleteItem] Called with itemId:', itemId);
  
  if (!checkElectronAPI() || !currentUser) {
    console.error('[DeleteItem] Cannot delete: API not available or user not signed in');
    console.error('[DeleteItem] checkElectronAPI():', checkElectronAPI());
    console.error('[DeleteItem] currentUser:', currentUser ? 'exists' : 'null');
    return false;
  }
  
  // Additional sanitization (should already be sanitized, but double-check)
  let sanitizedId = itemId;
  if (itemId.includes('://') || itemId.startsWith('http')) {
    console.warn('[DeleteItem] WARNING: itemId appears to be a URL, attempting to find card...');
    const card = document.querySelector(`[data-item-id="${itemId}"]`);
    if (card && card.dataset.docId) {
      sanitizedId = card.dataset.docId;
      console.log('[DeleteItem] Found docId from card:', sanitizedId);
    } else {
      console.error('[DeleteItem] ERROR: No data-doc-id found on card.');
      return false;
    }
  }
  
  // Final sanitization: remove invalid characters
  const finalId = sanitizedId.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  if (finalId !== sanitizedId) {
    console.warn('[DeleteItem] ID was sanitized:', sanitizedId, '->', finalId);
  }
  
  console.log('[DeleteItem] Attempting to delete with finalId:', finalId);
  console.log('[DeleteItem] User UID:', currentUser.uid);
  
  try {
    const result = await window.electronAPI.firestore.deleteData(finalId, currentUser.uid);
    console.log('[DeleteItem] Firestore deleteData result:', result);
    
    if (result && result.success) {
      console.log('[DeleteItem] ✅ Item deleted successfully:', finalId);
      return true;
    } else {
      console.error('[DeleteItem] ❌ Delete item error:', result?.error || 'Unknown error');
      return false;
    }
  } catch (error) {
    console.error('[DeleteItem] ❌ Delete item exception:', error);
    console.error('[DeleteItem] Error details:', {
      itemId: itemId,
      sanitizedId: sanitizedId,
      finalId: finalId,
      errorMessage: error.message,
      errorStack: error.stack
    });
    return false;
  }
}

// Delete zone removed

/*
// Setup event listeners on a specific delete zone element
function setupTrashZoneElement(deleteZone) {
  console.log('[DeleteZone] Setting up event listeners...');
  
  deleteZone.dataset.handlersAttached = 'true';
  deleteZone.style.pointerEvents = 'auto';
  
  // CRITICAL: Use CAPTURE PHASE to ensure DeleteZone intercepts events FIRST
  // This prevents other listeners from interfering
  
  // CRITICAL: dragover handler - Simplistic mandatory drop acceptance
  deleteZone.addEventListener('dragover', (e) => {
    // CRITICAL: Mandatory drop acceptance - simple and reliable
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    
    // Add visual feedback
    deleteZone.classList.add('drag-over');
    
    console.log('[DeleteZone] dragover - Mandatory drop acceptance (move effect)');
    
    return false; // Additional guarantee for older browsers
  }, { capture: true }); // CAPTURE PHASE: Intercept before others
  
  deleteZone.addEventListener('dragenter', (e) => {
    // CRITICAL: Simple dragenter - always prevent default and stop propagation
    e.preventDefault();
    e.stopPropagation();
    
    // Add visual feedback
    deleteZone.classList.add('drag-over');
    
    console.log('[DeleteZone] dragenter - Added drag-over class');
    
    return false; // Additional guarantee
  }, { capture: true }); // CAPTURE PHASE
  
  // CRITICAL: Simplistic dragleave - no delays, no complex bounds checking
  deleteZone.addEventListener('dragleave', (e) => {
    // CRITICAL: Always prevent default and stop propagation
    e.preventDefault();
    e.stopPropagation();
    
    // Simple: Only remove drag-over if we're actually leaving the DeleteZone
    // pointer-events: none on children ensures dragleave only fires when truly leaving
    // Check if the relatedTarget (where we're going) is outside DeleteZone
    if (!deleteZone.contains(e.relatedTarget)) {
      deleteZone.classList.remove('drag-over');
      console.log('[DeleteZone] dragleave - Removed drag-over class (truly leaving)');
    } else {
      console.log('[DeleteZone] dragleave - Ignored (moving to child element)');
    }
    
    return false; // Additional guarantee
  }, { capture: true }); // CAPTURE PHASE
  
  // CRITICAL: Use CAPTURE PHASE to ensure DeleteZone intercepts drop FIRST
  deleteZone.addEventListener('drop', async (e) => {
    // CRITICAL: ALWAYS call preventDefault() FIRST, without any conditions
    e.preventDefault();
    e.stopPropagation(); // CRITICAL: Prevent other listeners from processing
    
    console.log('[DeleteZone] ========== DROP EVENT FIRED ==========');
    console.log('[DeleteZone] preventDefault() and stopPropagation() called (unconditional)');
    
    // Remove visual feedback
    deleteZone.classList.remove('drag-over');
    
    try {
      console.log('[DeleteZone] Step 2: Extracting ID from multiple sources');
      
      // Extract ID from multiple sources for robustness (priority order)
      // 1. SUPER-GLOBAL: document.body.dataset (most reliable)
      const rawIdFromBody = document.body.dataset.activeDragId;
      // 2. dataTransfer with docId
      const rawIdFromDataTransferId = e.dataTransfer.getData('application/x-datacard-id');
      // 3. window global variable
      const rawIdFromWindow = window.currentDraggedItemId;
      // 4. dataTransfer with URL (fallback)
      const rawIdFromDataTransfer = e.dataTransfer.getData('text/plain');
      const rawIdFromUrl = window.currentDraggedItemUrl || document.body.dataset.activeDragUrl;
      
      console.log('[DeleteZone]   Source 1 - document.body.dataset.activeDragId:', rawIdFromBody);
      console.log('[DeleteZone]   Source 2 - dataTransfer (application/x-datacard-id):', rawIdFromDataTransferId);
      console.log('[DeleteZone]   Source 3 - window.currentDraggedItemId:', rawIdFromWindow);
      console.log('[DeleteZone]   Source 4 - dataTransfer (text/plain):', rawIdFromDataTransfer);
      console.log('[DeleteZone]   Source 5 - window.currentDraggedItemUrl:', window.currentDraggedItemUrl);
      console.log('[DeleteZone]   Source 6 - document.body.dataset.activeDragUrl:', document.body.dataset.activeDragUrl);
      console.log('[DeleteZone]   Combined URL:', rawIdFromUrl);
      
      console.log('[DeleteZone] Step 3: Checking dataTransfer types');
      console.log('[DeleteZone]   - dataTransfer.types:', Array.from(e.dataTransfer.types));
      console.log('[DeleteZone]   - dataTransfer.dropEffect:', e.dataTransfer.dropEffect);
      console.log('[DeleteZone]   - dataTransfer.effectAllowed:', e.dataTransfer.effectAllowed);
      
      // Try to find the card element to get the actual docId
      let card = null;
      let docIdForDeletion = null;
      
      // PRIORITY 1: document.body.dataset (super-global, most reliable)
      if (rawIdFromBody) {
        docIdForDeletion = rawIdFromBody;
        console.log('[DeleteZone] Using docId from document.body.dataset.activeDragId:', docIdForDeletion);
        // Try to find card for visual feedback
        card = document.querySelector(`[data-doc-id="${rawIdFromBody}"]`);
      }
      
      // PRIORITY 2: dataTransfer with docId
      if (!docIdForDeletion && rawIdFromDataTransferId) {
        docIdForDeletion = rawIdFromDataTransferId;
        console.log('[DeleteZone] Using docId from dataTransfer (application/x-datacard-id):', docIdForDeletion);
        // Try to find card for visual feedback
        if (!card) {
          card = document.querySelector(`[data-doc-id="${rawIdFromDataTransferId}"]`);
        }
      }
      
      // PRIORITY 3: window global variable
      if (!docIdForDeletion && rawIdFromWindow) {
        card = document.querySelector(`[data-doc-id="${rawIdFromWindow}"]`) || 
               document.querySelector(`[data-item-id="${rawIdFromWindow}"]`);
        if (card && card.dataset.docId) {
          docIdForDeletion = card.dataset.docId;
          console.log('[DeleteZone] Found card by window.currentDraggedItemId, docId:', docIdForDeletion);
        } else if (rawIdFromWindow && !rawIdFromWindow.includes('://') && !rawIdFromWindow.startsWith('http')) {
          // Use rawIdFromWindow directly if it looks like a valid docId
          docIdForDeletion = rawIdFromWindow;
          console.log('[DeleteZone] Using rawIdFromWindow as docId (looks valid):', docIdForDeletion);
        }
      }
      
      // If not found, try to find by URL
      if (!card && rawIdFromUrl) {
        card = document.querySelector(`[data-url="${rawIdFromUrl}"]`);
        if (card && card.dataset.docId) {
          docIdForDeletion = card.dataset.docId;
          console.log('[DeleteZone] Found card by URL, docId:', docIdForDeletion);
        }
      }
      
      // If still not found, try dataTransfer URL
      if (!card && rawIdFromDataTransfer) {
        card = document.querySelector(`[data-url="${rawIdFromDataTransfer}"]`);
        if (card && card.dataset.docId) {
          docIdForDeletion = card.dataset.docId;
          console.log('[DeleteZone] Found card by dataTransfer URL, docId:', docIdForDeletion);
        }
      }
      
      // Fallback: use rawIdFromWindow if it looks like a valid docId
      if (!docIdForDeletion && rawIdFromWindow) {
        docIdForDeletion = rawIdFromWindow;
        console.log('[DeleteZone] Using rawIdFromWindow as fallback:', docIdForDeletion);
      }
      
      if (!docIdForDeletion) {
        console.error('[DeleteZone] ERROR: Could not determine docId for deletion');
        console.error('[DeleteZone] Available data:', {
          windowId: rawIdFromWindow,
          dataTransfer: rawIdFromDataTransfer,
          url: rawIdFromUrl,
          cardFound: !!card
        });
        return;
      }
      
      console.log('[DeleteZone] Original docIdForDeletion:', docIdForDeletion);
      
      // Robust ID sanitization
      let safeId = docIdForDeletion;
      
      // If it looks like a URL or path, extract the last segment
      if (safeId.includes('/')) {
        safeId = safeId.split('/').pop() || safeId;
        console.log('[DeleteZone] Extracted last segment from path:', safeId);
      }
      
      // Remove all invalid characters (keep only alphanumeric, hyphens, underscores)
      safeId = safeId.replace(/[^a-zA-Z0-9_-]/g, '');
      console.log('[DeleteZone] Sanitized ID:', safeId);
      
      // Final validation
      if (!safeId || safeId.length === 0) {
        console.error('[DeleteZone] ERROR: Sanitized ID is empty');
        return;
      }
      
      if (safeId.includes('://') || safeId.startsWith('http')) {
        console.error('[DeleteZone] ERROR: Sanitized ID still appears to be a URL:', safeId);
        return;
      }
      
      console.log('[Delete] Attempting to delete doc:', safeId);
      
      // Call deleteItem with the sanitized ID
      console.log('[DeleteZone]   - Calling deleteItem() with safeId:', safeId);
      const deleteStartTime = Date.now();
      const success = await deleteItem(safeId);
      const deleteEndTime = Date.now();
      const deleteDuration = deleteEndTime - deleteStartTime;
      
      console.log('[DeleteZone] Step 9: deleteItem() result');
      console.log('[DeleteZone]   - Success:', success);
      console.log('[DeleteZone]   - Duration:', deleteDuration, 'ms');
      
      if (success) {
        console.log('[Delete] ✅ Successfully deleted item from Firestore:', safeId);
        
        // Visual confirmation: fade out the card
        console.log('[DeleteZone] Step 10: Visual feedback');
        if (card) {
          console.log('[DeleteZone]   - Card found, starting fade-out animation');
          card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
          card.style.opacity = '0';
          card.style.transform = 'scale(0.8)';
          await new Promise(resolve => setTimeout(resolve, 300));
          console.log('[DeleteZone]   - Card fade-out animation completed');
        } else {
          console.warn('[DeleteZone]   - ⚠️ Card element not found for visual feedback');
          console.warn('[DeleteZone]   - safeId used:', safeId);
        }
      } else {
        console.error('[Delete] ❌ Failed to delete item from Firestore:', safeId);
        console.error('[DeleteZone]   - Check deleteItem() logs above for details');
      }
      
      console.log('[DeleteZone] ========== DROP EVENT COMPLETE ==========');
      console.log('═══════════════════════════════════════════════════════════');
    } catch (error) {
      console.error('[DeleteZone] ERROR in drop handler:', error);
      console.error('[DeleteZone] Error stack:', error.stack);
      deleteZone.classList.remove('drag-over');
    } finally {
      // Clean up document.body dataset after drop
      delete document.body.dataset.activeDragId;
      delete document.body.dataset.activeDragUrl;
    }
  }, { capture: true }); // CAPTURE PHASE: Intercept before others
}

*/
// Setup clear all button
function setupClearButton() {
  const clearBtn = document.getElementById('clear-all-btn');
  if (!clearBtn) {
    console.error('[Clear] Clear button element not found!');
    return;
  }
  
  clearBtn.addEventListener('click', async () => {
    if (!checkElectronAPI() || !currentUser) {
      console.error('[Clear] Cannot clear: no user');
      return;
    }
    
    // Get current item count for confirmation message
    const dockItemlist = document.getElementById('dock-itemlist');
    const itemCount = dockItemlist ? dockItemlist.querySelectorAll('.data-card').length : 0;
    
    if (itemCount === 0) {
      console.log('[Clear] No items to clear');
      return;
    }
    
    // Confirmation dialog
    const confirmed = confirm(`Are you sure you want to delete all ${itemCount} item${itemCount !== 1 ? 's' : ''}? This action cannot be undone.`);
    
    if (!confirmed) {
      console.log('[Clear] Clear operation cancelled by user');
      return;
    }
    
    try {
      console.log('[Clear] Starting clear all operation...');
      const result = await window.electronAPI.firestore.deleteAllData(currentUser.uid);
      
      if (result.success) {
        console.log(`[Clear] ✅ Successfully deleted ${result.deletedCount || 0} items`);
        // Items will be removed via real-time Firestore listener
      } else {
        console.error('[Clear] ❌ Failed to clear all items:', result.error);
        alert('Failed to clear all items: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('[Clear] Error clearing all items:', err);
      alert('Error clearing all items: ' + err.message);
    }
  });
}

// Firestore listener management
let firestoreUnsubscribe = null;

function startFirestoreListener(userId) {
  if (!checkElectronAPI()) return;
  stopFirestoreListener();
  firestoreUnsubscribe = window.electronAPI.firestore.watchDatasByUser(userId, (items) => {
    console.log('Firestore data changed, received items:', items.length);
    // Skip loadData if we're currently syncing to prevent UI snap-back
    if (isSyncing) {
      console.log('[DnD] Skipping loadData() - sync in progress');
      return;
    }
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

  // True only on the very first render pass (no items displayed yet)
  const isInitialRender = displayedItemIds.size === 0;
  // Snapshot of already-displayed IDs before the set is cleared,
  // so we can distinguish truly new items from re-rendered ones.
  const previouslyDisplayed = new Set(displayedItemIds);
  
  // ========== TASK 1: Preserve Expanding Wrappers ==========
  // Find all wrappers that are currently animating during Firestore sync
  const preservedWrappers = new Map();
  try {
    const expandingWrappers = document.querySelectorAll('[data-expanding-wrapper="true"]');
    expandingWrappers.forEach(wrapper => {
      if (wrapper.dataset.preserveAnimation === 'true' && wrapper.dataset.itemId) {
        const itemId = wrapper.dataset.itemId;
        preservedWrappers.set(itemId, {
          element: wrapper,
          height: wrapper.style.height,
          opacity: wrapper.style.opacity,
          backgroundColor: wrapper.style.backgroundColor
        });
        console.log('[DnD] Preserving wrapper for item:', itemId);
      }
    });
  } catch (preserveError) {
    console.warn('[DnD] Error preserving wrappers, will re-render all:', preserveError);
    // If preservation fails, clear all expanding wrappers and continue normally
    document.querySelectorAll('[data-expanding-wrapper="true"]').forEach(wrapper => {
      if (wrapper.parentElement) {
        wrapper.parentElement.removeChild(wrapper);
      }
    });
  }
  
  try {
    const items = await window.electronAPI.firestore.getDatasByUser(currentUser.uid);
    console.log('Loaded items from Firestore:', items.length);
    
    if (items.length === 0) {
      // Clear using DOM manipulation (preserve structure)
      while (dockItemlist.firstChild) {
        dockItemlist.removeChild(dockItemlist.firstChild);
      }
      // Clear all directory items containers
      document.querySelectorAll('.directory-items-container').forEach(container => {
        while (container.firstChild) {
          container.removeChild(container.firstChild);
        }
      });
    } else {
      const sortedData = [...items].sort((a, b) => b.timestamp - a.timestamp);
      
      if (forceRefresh || displayedItemIds.size === 0) {
        displayedItemIds.clear();
        // Clear using DOM manipulation (preserve structure)
        // BUT: Don't remove preserved wrappers - they're already in the right place
        Array.from(dockItemlist.children).forEach(child => {
          const preservedWrapper = child.classList.contains('card-container')
            ? child.querySelector('.card-wrapper[data-expanding-wrapper="true"]')
            : child;
          if (preservedWrapper?.dataset?.preserveAnimation === 'true') return;
          if (!child.dataset?.expandingWrapper || !child.dataset?.preserveAnimation) {
            dockItemlist.removeChild(child);
          }
        });
        
        // Group items by directoryId
        const itemsByDirectory = new Map();
        const itemsWithoutDirectory = [];
        
        sortedData.forEach(item => {
          const directoryId = item.directoryId;
          // Items with directoryId === "undefined" or undefined go to main list
          if (!directoryId || directoryId === 'undefined') {
            itemsWithoutDirectory.push(item);
          } else {
            if (!itemsByDirectory.has(directoryId)) {
              itemsByDirectory.set(directoryId, []);
            }
            itemsByDirectory.get(directoryId).push(item);
          }
        });
        
        // Render items in their respective directory containers
        itemsByDirectory.forEach((directoryItems, directoryId) => {
          const directoryItem = document.querySelector(`[data-directory-id="${directoryId}"]`);
          if (directoryItem) {
            const itemsContainer = directoryItem.querySelector('.directory-items-container');
            if (itemsContainer) {
              // Clear container using DOM manipulation (preserve structure)
              // BUT: Don't remove preserved wrappers
              Array.from(itemsContainer.children).forEach(child => {
                const preservedWrapper = child.classList.contains('card-container')
                  ? child.querySelector('.card-wrapper[data-expanding-wrapper="true"]')
                  : child;
                if (preservedWrapper?.dataset?.preserveAnimation === 'true') return;
                if (!child.dataset?.expandingWrapper || !child.dataset?.preserveAnimation) {
                  itemsContainer.removeChild(child);
                }
              });
              
              // Render items using createCardElement (DOM objects)
              directoryItems.forEach(item => {
                const itemId = getItemId(item);
                
                // ========== TASK 2: Check for Preserved Wrapper ==========
                try {
                  const preserved = preservedWrappers.get(itemId);
                  if (preserved) {
                    // Update the preserved wrapper's content instead of creating new
                    const existingWrapper = preserved.element;
                    const existingCard = existingWrapper.querySelector('.data-card');
                    
                    if (existingCard && itemsContainer.contains(existingWrapper)) {
                      // Update card data attributes with fresh data
                      existingCard.dataset.itemId = itemId;
                      existingCard.dataset.url = item.url;
                      existingCard.dataset.title = item.title || 'Untitled';
                      existingCard.dataset.type = item.type || 'webpage';
                      if (item.directoryId && item.directoryId !== 'undefined') {
                        existingCard.dataset.directoryId = item.directoryId;
                      }
                      
                      // ========== TASK 4: Fix Transition Conflicts ==========
                      // Ensure height is set to auto if it's still a fixed value
                      // This prevents animateItemEntry from fighting with drop animation
                      if (existingWrapper.style.height && existingWrapper.style.height !== 'auto') {
                        // Wait for any ongoing transitions to complete
                        existingWrapper.style.transition = 'height 0.3s cubic-bezier(0.2, 0, 0, 1)';
                        
                        // Set to auto after a brief delay to let current animation finish
                        setTimeout(() => {
                          existingWrapper.style.height = 'auto';
                          existingWrapper.style.minHeight = '';
                          existingWrapper.style.transition = '';
                        }, 100);
                      } else {
                        // Already auto or no height set, just ensure min-height is removed
                        existingWrapper.style.height = 'auto';
                        existingWrapper.style.minHeight = '';
                      }
                      
                      // Remove preserve flags
                      setTimeout(() => {
                        existingWrapper.dataset.expandingWrapper = '';
                        existingWrapper.dataset.preserveAnimation = '';
                        existingWrapper.dataset.itemId = '';
                        existingWrapper.style.backgroundColor = ''; // Remove any remaining background
                      }, 300);
                      
                      displayedItemIds.add(itemId);
                      existingCard.dataset.handlerAttached = 'false';
                      return; // Skip creating new wrapper
                    }
                  }
                } catch (preserveError) {
                  console.warn('[DnD] Error updating preserved wrapper for item:', itemId, preserveError);
                  // Fall through to create new wrapper
                }
                
                // Create new wrapper normally
                const isNew = !isInitialRender && !previouslyDisplayed.has(itemId);
                const { container, wrapper, card } = createCardElement(item, isNew);
                itemsContainer.appendChild(container);
                displayedItemIds.add(itemId);
                card.dataset.handlerAttached = 'false';
                // Trigger 3-phase entrance animation for new cards
                if (isNew) {
                  // Phase 1 initial state: opacity also starts at 0
                  wrapper.style.opacity = '0';

                  // Phase 2: expand container height [ease-out, 300ms]
                  const naturalHeight = wrapper.offsetHeight;
                  container.style.transition = 'height 300ms ease-out';
                  requestAnimationFrame(() => {
                    container.style.height = `${naturalHeight}px`;
                  });

                  // Phase 3: scale + fade-in with spring overshoot easing
                  // Starts at 50ms (slightly overlapping with height expansion)
                  setTimeout(() => {
                    wrapper.style.transition = [
                      'transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                      'opacity 150ms ease-out',
                    ].join(', ');
                    wrapper.style.transform = 'scale(1)';
                    wrapper.style.opacity = '1';
                  }, 50);

                  // Cleanup: lock container to fixed pixel height instead of
                  // clearing to auto, so it won't react to wrapper size changes
                  // during a subsequent delete animation.
                  setTimeout(() => {
                    container.style.height = `${container.offsetHeight}px`;
                    container.style.overflow = '';
                    container.style.transition = '';
                    wrapper.style.transition = '';
                    wrapper.style.transform = '';
                    wrapper.style.transformOrigin = '';
                    wrapper.style.opacity = '';
                  }, 500);
                }
                if (isNew && window.electronAPI?.dock?.notifyDataSaved) {
                  window.electronAPI.dock.notifyDataSaved();
                }
              });
            }
          } else {
            // Directory not found, add items to main list as fallback
            console.warn(`[Directory] Directory ${directoryId} not found, adding items to main list`);
            itemsWithoutDirectory.push(...directoryItems);
          }
        });
        
        // Render items without directory in main list using DOM objects
        itemsWithoutDirectory.forEach(item => {
          const itemId = getItemId(item);
          
          // ========== TASK 2: Check for Preserved Wrapper ==========
          try {
            const preserved = preservedWrappers.get(itemId);
            if (preserved) {
              // Update the preserved wrapper's content instead of creating new
              const existingWrapper = preserved.element;
              const existingCard = existingWrapper.querySelector('.data-card');
              
              if (existingCard && dockItemlist.contains(existingWrapper)) {
                // Update card data attributes with fresh data
                existingCard.dataset.itemId = itemId;
                existingCard.dataset.url = item.url;
                existingCard.dataset.title = item.title || 'Untitled';
                existingCard.dataset.type = item.type || 'webpage';
                
                // ========== TASK 4: Fix Transition Conflicts ==========
                // Ensure height is set to auto if it's still a fixed value
                if (existingWrapper.style.height && existingWrapper.style.height !== 'auto') {
                  const currentHeight = existingWrapper.style.height;
                  existingWrapper.style.transition = 'height 0.3s cubic-bezier(0.2, 0, 0, 1)';
                  
                  setTimeout(() => {
                    existingWrapper.style.height = 'auto';
                    existingWrapper.style.minHeight = '';
                    existingWrapper.style.transition = '';
                  }, 100);
                } else {
                  existingWrapper.style.height = 'auto';
                  existingWrapper.style.minHeight = '';
                }
                
                // Remove preserve flags
                setTimeout(() => {
                  existingWrapper.dataset.expandingWrapper = '';
                  existingWrapper.dataset.preserveAnimation = '';
                  existingWrapper.dataset.itemId = '';
                  existingWrapper.style.backgroundColor = ''; // Remove any remaining background
                }, 300);
                
                displayedItemIds.add(itemId);
                existingCard.dataset.handlerAttached = 'false';
                return; // Skip creating new wrapper
              }
            }
          } catch (preserveError) {
            console.warn('[DnD] Error updating preserved wrapper for item:', itemId, preserveError);
            // Fall through to create new wrapper
          }
          
          // Create new wrapper normally
          const isNew = !isInitialRender && !previouslyDisplayed.has(itemId);
          const { container, wrapper, card } = createCardElement(item, isNew);
          dockItemlist.appendChild(container);
          displayedItemIds.add(itemId);
          card.dataset.handlerAttached = 'false';
          // Trigger 3-phase entrance animation for new cards
          if (isNew) {
            // Phase 1 initial state: opacity also starts at 0
            wrapper.style.opacity = '0';

            // Phase 2: expand container height [ease-out, 300ms]
            const naturalHeight = wrapper.offsetHeight;
            container.style.transition = 'height 300ms ease-out';
            requestAnimationFrame(() => {
              container.style.height = `${naturalHeight}px`;
            });

            // Phase 3: scale + fade-in with spring overshoot easing
            // Starts at 50ms (slightly overlapping with height expansion)
            setTimeout(() => {
              wrapper.style.transition = [
                'transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                'opacity 150ms ease-out',
              ].join(', ');
              wrapper.style.transform = 'scale(1)';
              wrapper.style.opacity = '1';
            }, 50);

            // Cleanup: lock container to fixed pixel height instead of
            // clearing to auto, so it won't react to wrapper size changes
            // during a subsequent delete animation.
            setTimeout(() => {
              container.style.height = `${container.offsetHeight}px`;
              container.style.overflow = '';
              container.style.transition = '';
              wrapper.style.transition = '';
              wrapper.style.transform = '';
              wrapper.style.transformOrigin = '';
              wrapper.style.opacity = '';
            }, 500);
          }
          if (isNew && window.electronAPI?.dock?.notifyDataSaved) {
            window.electronAPI.dock.notifyDataSaved();
          }
        });
        
        // Attach handlers for ALL cards (main list + directory containers)
        attachCardClickHandlers(); // This handles all cards and sets up drop handlers
        
        // Setup drop handlers for directory containers and main list
        setupUnifiedDropHandlers(); // Use unified system
      }
    }
  } catch (err) {
    // ========== TASK 4: Error Handling ==========
    console.error('Failed to load data:', err);
    
    // If error occurs, clear preserved wrappers and re-render everything
    try {
      preservedWrappers.forEach((preserved, itemId) => {
        if (preserved.element && preserved.element.parentElement) {
          preserved.element.parentElement.removeChild(preserved.element);
        }
      });
    } catch (cleanupError) {
      console.warn('[DnD] Error cleaning up preserved wrappers:', cleanupError);
    }
    
    // Force a full refresh to prevent broken UI
    if (forceRefresh) {
      const dockItemlist = document.getElementById('dock-itemlist');
      if (dockItemlist) {
        while (dockItemlist.firstChild) {
          dockItemlist.removeChild(dockItemlist.firstChild);
        }
      }
      document.querySelectorAll('.directory-items-container').forEach(container => {
        while (container.firstChild) {
          container.removeChild(container.firstChild);
        }
      });
    }
  }
}

// Initialize dock functionality (dashboard: user is always authenticated)
function initializeDock() {
  console.log('Dock: Initializing (Dashboard)...');
  
  if (!checkElectronAPI() || !window.electronAPI.auth) {
    console.error('electronAPI.auth not available');
    return;
  }

  // Get current user once - main process only loads dashboard when logged in
  window.electronAPI.auth.getCurrentUser().then((user) => {
    if (!user) {
      console.warn('Dashboard loaded but no user - main process should have routed to login');
      return;
    }
    currentUser = user;
    updateProfileFromUser(user);
    updateInstagramUI(user.uid);
    startFirestoreListener(user.uid);
    loadData(true);
    loadDirectories(user.uid);
    updateDockFunctionHeight();
  });

  // Sign-Out button: main process will reload to login on auth:stateChanged
  const signoutBtn = document.getElementById('signout-btn');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      if (!checkElectronAPI()) return;
      try {
        await window.electronAPI.auth.signOut();
        // Main process listens for auth:stateChanged and will reload to login.html
      } catch (err) {
        console.error('Sign out error:', err);
      }
    });
  }

  setupDirectories();
  setupClearButton();
}

// Directory Management Functions
let directoryUnsubscribe = null;
let directoryCounter = 1;

// Setup directory functionality
function setupDirectories() {
  const createBtn = document.getElementById('create-directory-btn');
  if (createBtn) {
    createBtn.addEventListener('click', handleCreateDirectory);
  }
}

// Load and render directories
async function loadDirectories(userId) {
  if (!checkElectronAPI() || !userId) return;
  
  const directoryList = document.getElementById('directory-list');
  if (!directoryList) {
    console.error('[Directory] directory-list element not found');
    return;
  }
  
  try {
    // Set up real-time listener
    if (directoryUnsubscribe) {
      directoryUnsubscribe();
    }
    
    directoryUnsubscribe = window.electronAPI.firestore.watchDirectoriesByUser(userId, (directories) => {
      console.log('Firestore directories changed, received directories:', directories.length);
      // Skip renderDirectories if we're currently syncing to prevent UI snap-back
      if (isSyncing) {
        console.log('[DnD] Skipping renderDirectories() - sync in progress');
        return;
      }
      renderDirectories(directories);
    });
    
    // Initial load
    const directories = await window.electronAPI.firestore.getDirectoriesByUser(userId);
    renderDirectories(directories);
  } catch (err) {
    console.error('[Directory] Failed to load directories:', err);
  }
}

// Render directories list
function renderDirectories(directories) {
  const directoryList = document.getElementById('directory-list');
  if (!directoryList) return;
  
  // Store existing expansion states before clearing
  const expansionStates = new Map();
  Array.from(directoryList.querySelectorAll('.directory-item')).forEach(item => {
    const dirId = item.dataset.directoryId;
    if (dirId) {
      expansionStates.set(dirId, item.dataset.expanded === 'true');
    }
  });
  
  directoryList.innerHTML = '';
  
  directories.forEach(directory => {
    const directoryItem = createDirectoryItem(directory);
    
    // Restore expansion state
    if (expansionStates.has(directory.id)) {
      if (expansionStates.get(directory.id)) {
        toggleDirectoryExpansion(directoryItem);
      }
    }
    
    directoryList.appendChild(directoryItem);
  });
  
  // Update counter for default naming
  directoryCounter = directories.length + 1;
  
  // Setup drop handlers for directory containers
  // setupDirectoryItemsContainerDropHandlers(); // Replaced by unified DnD system
  setupUnifiedDropHandlers(); // Use unified system
  
  // Re-render items grouped by directory (only if we have items loaded)
  // This will be called separately when items change, not here to avoid loops
}

// Create directory item DOM element
function createDirectoryItem(directory) {
  const item = document.createElement('div');
  item.className = 'directory-item';
  item.dataset.directoryId = directory.id;
  item.dataset.expanded = 'false'; // Default: collapsed
  
  // Header container
  const header = document.createElement('div');
  header.className = 'directory-item-header';
  
  // Chevron icon (indicates expansion state)
  const chevron = document.createElement('div');
  chevron.className = 'directory-chevron';
  chevron.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="12" height="12">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
    </svg>
  `;
  
  // Name display/input
  const nameDisplay = document.createElement('div');
  nameDisplay.className = 'directory-name-display';
  nameDisplay.textContent = directory.name || `Directory ${directoryCounter++}`;
  nameDisplay.dataset.editing = 'false';
  
  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'directory-delete-btn';
  deleteBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  `;
  
  // Items container (hidden by default)
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'directory-items-container';
  itemsContainer.dataset.directoryId = directory.id;
  
  // Assemble header
  header.appendChild(chevron);
  header.appendChild(nameDisplay);
  header.appendChild(deleteBtn);
  
  // Assemble directory item
  item.appendChild(header);
  item.appendChild(itemsContainer);
  
  // Make header draggable for directory reordering
  header.setAttribute('draggable', 'true');
  header.dataset.directoryId = directory.id;
  
  // Toggle expansion on header click (but not on name display or delete button)
  header.addEventListener('click', (e) => {
    // Don't toggle if clicking on name (for rename) or delete button
    if (e.target === nameDisplay || e.target.closest('.directory-name-display') || 
        e.target === deleteBtn || e.target.closest('.directory-delete-btn')) {
      return;
    }
    toggleDirectoryExpansion(item);
  });
  
  // Event listeners for name and delete
  nameDisplay.addEventListener('click', (e) => {
    e.stopPropagation();
    handleRenameDirectory(directory.id, nameDisplay);
  });
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteDirectory(directory.id, directory.name);
  });
  
  // ========== DIRECTORY DRAG HANDLERS ==========
  // dragstart - initiate directory drag
  header.addEventListener('dragstart', (e) => {
    disableAlwaysOnTopForDrag();
    const directoryId = header.dataset.directoryId;
    
    // CRITICAL: Set global drag state FIRST
    isDragging = true;
    
    // CRITICAL: Use requestAnimationFrame to defer DOM changes
    requestAnimationFrame(() => {
      // Visual feedback - add class after browser has started drag
      item.classList.add('dragging');
    });
    
    // Store drag data
    document.body.dataset.activeDragDirectoryId = directoryId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', directoryId);
    e.dataTransfer.setData('application/x-directory-id', directoryId);
    
    // Create ghost image for directory
    try {
      const ghostContainer = document.createElement('div');
      ghostContainer.style.cssText = 'position: absolute; top: -1000px; left: -1000px; width: 200px; height: auto; opacity: 0.5; overflow: hidden; z-index: -1; pointer-events: none;';
      
      // Clone the entire directory item for ghost image
      const ghost = item.cloneNode(true);
      ghost.style.cssText = 'width: 100%; height: auto; margin: 0; opacity: 1; position: relative; pointer-events: none;';
      
      ghostContainer.appendChild(ghost);
      document.body.appendChild(ghostContainer);
      
      // Force reflow before setting drag image
      void ghostContainer.offsetWidth;
      
      // Set drag image
      e.dataTransfer.setDragImage(ghostContainer, 100, 25);
      
      // Cleanup after drag starts
      setTimeout(() => {
        if (ghostContainer.parentNode) {
          ghostContainer.remove();
        }
      }, 0);
    } catch (error) {
      console.warn('[DnD] Could not create custom ghost image for directory, using default:', error);
    }
    
    console.log('[DnD] Directory drag started:', { directoryId });
  });
  
  // dragend - cleanup directory drag
  header.addEventListener('dragend', (e) => {
    enableAlwaysOnTopAfterDrag();
    // CRITICAL: Update global drag state FIRST
    isDragging = false;
    lastDragEndTime = Date.now();
    
    // ========== FIX: Always remove is-dragging-source class ==========
    // Ensure the directory item is always cleaned up, regardless of drop success
    item.classList.remove('is-dragging-source');
    item.style.pointerEvents = ''; // Restore pointer events
    
    // ========== TASK 3: Cleanup on DragEnd (Cancelation) for Directories ==========
    if (item.dataset.draggingSource === 'true') {
      // Drag was canceled - restore directory to full opacity
      item.style.opacity = '1';
      item.style.transition = '';
      item.dataset.draggingSource = '';
    }
    
    // Cleanup visual states
    item.classList.remove('dragging');
    
    // Cleanup global state
    delete document.body.dataset.activeDragDirectoryId;
    
    // Remove guide wrapper and reset flag
    removeGuideWrapper();
    hasValidDropIndicator = false;
    
    // Fail-safe cleanup: restore any modified styles
    if (window._restoreDraggedCardStyles) {
      window._restoreDraggedCardStyles();
    }
    
    console.log('[DnD] Directory drag ended');
  });
  
  // Drag-and-drop handlers for items (not directories)
  // setupDirectoryDropZone(item, directory.id); // Replaced by unified DnD system
  // Directory drop handled by unified container handlers
  
  return item;
}

// Toggle directory expansion state
function toggleDirectoryExpansion(directoryItem) {
  const isExpanded = directoryItem.dataset.expanded === 'true';
  directoryItem.dataset.expanded = isExpanded ? 'false' : 'true';
  
  const chevron = directoryItem.querySelector('.directory-chevron');
  if (chevron) {
    chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
  }
  
  const itemsContainer = directoryItem.querySelector('.directory-items-container');
  if (itemsContainer) {
    itemsContainer.style.display = isExpanded ? 'none' : 'flex';
  }
  
  console.log(`[Directory] ${isExpanded ? 'Collapsed' : 'Expanded'} directory:`, directoryItem.dataset.directoryId);
}

// Setup directory as drop zone
function setupDirectoryDropZone(element, directoryId) {
  let expandTimeout = null;
  let isDraggingOver = false;
  
  // dragover - allow drop
  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    element.classList.add('drag-over');
  }, { capture: true });
  
  // dragenter - auto-expand on hover
  element.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.add('drag-over');
    
    // Auto-expand if collapsed and dragging over for 500ms
    if (element.dataset.expanded === 'false' && !isDraggingOver) {
      isDraggingOver = true;
      expandTimeout = setTimeout(() => {
        if (element.dataset.expanded === 'false') {
          toggleDirectoryExpansion(element);
          console.log('[Directory] Auto-expanded on drag hover:', directoryId);
        }
      }, 500);
    }
  }, { capture: true });
  
  // dragleave
  element.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Clear auto-expand timeout if leaving
    if (expandTimeout) {
      clearTimeout(expandTimeout);
      expandTimeout = null;
    }
    isDraggingOver = false;
    
    // Only remove class if we're truly leaving the element
    if (!element.contains(e.relatedTarget)) {
      element.classList.remove('drag-over');
    }
  }, { capture: true });
  
  // drop
  element.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.remove('drag-over');
    
    // Clear auto-expand timeout
    if (expandTimeout) {
      clearTimeout(expandTimeout);
      expandTimeout = null;
    }
    isDraggingOver = false;
    
    // Ensure directory is expanded when dropping
    if (element.dataset.expanded === 'false') {
      toggleDirectoryExpansion(element);
    }
    
    // Get item ID from global state or dataTransfer
    const itemId = document.body.dataset.activeDragId || 
                   e.dataTransfer.getData('application/x-datacard-id') ||
                   window.currentDraggedItemId;
    
    if (!itemId || !currentUser) {
      console.error('[Directory] No item ID or user found for drop');
      return;
    }
    
    // Sanitize ID
    const cleanItemId = itemId.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '');
    const directoryName = element.querySelector('.directory-name-display')?.textContent || 'directory';
    
    console.log(`[Directory] Moving item ${cleanItemId} to ${directoryName}`);
    
    try {
      const result = await window.electronAPI.firestore.updateItemDirectory(
        cleanItemId,
        currentUser.uid,
        directoryId
      );
      
      if (result.success) {
        console.log(`[Directory] Successfully moved item to ${directoryName}`);
      } else {
        console.error('[Directory] Failed to move item:', result.error);
      }
    } catch (err) {
      console.error('[Directory] Error moving item:', err);
    }
  }, { capture: true });
}

// Handle create directory
async function handleCreateDirectory() {
  if (!checkElectronAPI() || !currentUser) {
    console.error('[Directory] Cannot create directory: no user');
    return;
  }
  
  const defaultName = `Directory ${directoryCounter++}`;
  const currentUserId = currentUser.uid;
  
  // Debug logging
  console.log('[Directory Debug] Attempting to create directory');
  console.log('[Directory Debug] Current user UID:', currentUserId);
  console.log('[Directory Debug] Directory name:', defaultName);
  console.log('[Directory Debug] Target path: users/' + currentUserId + '/directories');
  console.log('[Directory Debug] Payload:', {
    name: defaultName,
    createdAt: Date.now(),
    userId: currentUserId
  });
  
  try {
    const result = await window.electronAPI.firestore.createDirectory(currentUserId, defaultName);
    
    if (result.success) {
      // Directory will be added via real-time listener
      // After a short delay, trigger rename mode for the new directory
      setTimeout(() => {
        const directoryList = document.getElementById('directory-list');
        if (directoryList) {
          const newItem = directoryList.querySelector(`[data-directory-id="${result.directoryId}"]`);
          if (newItem) {
            const nameDisplay = newItem.querySelector('.directory-name-display');
            if (nameDisplay) {
              handleRenameDirectory(result.directoryId, nameDisplay);
            }
          }
        }
      }, 100);
    } else {
      console.error('[Directory] Failed to create directory:', result.error);
      alert('Failed to create directory: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[Directory] Error creating directory:', err);
    alert('Error creating directory: ' + err.message);
  }
}

// Handle rename directory
function handleRenameDirectory(directoryId, nameDisplay) {
  if (nameDisplay.dataset.editing === 'true') return;
  
  const currentName = nameDisplay.textContent;
  
  // Create input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'directory-name-input';
  input.value = currentName;
  input.dataset.directoryId = directoryId;
  
  // Replace display with input
  nameDisplay.dataset.editing = 'true';
  nameDisplay.style.display = 'none';
  nameDisplay.parentNode.insertBefore(input, nameDisplay);
  input.focus();
  input.select();
  
  // Save on Enter or blur
  const saveName = async () => {
    const newName = input.value.trim() || `Directory ${directoryCounter++}`;
    
    if (newName === currentName) {
      // No change, just restore display
      input.remove();
      nameDisplay.style.display = '';
      nameDisplay.dataset.editing = 'false';
      return;
    }
    
    if (!checkElectronAPI() || !currentUser) {
      input.remove();
      nameDisplay.style.display = '';
      nameDisplay.dataset.editing = 'false';
      return;
    }
    
    try {
      const result = await window.electronAPI.firestore.updateDirectory(
        directoryId,
        currentUser.uid,
        newName
      );
      
      if (result.success) {
        // Name will be updated via real-time listener
        input.remove();
        nameDisplay.style.display = '';
        nameDisplay.dataset.editing = 'false';
      } else {
        console.error('[Directory] Failed to update directory:', result.error);
        alert('Failed to rename directory: ' + (result.error || 'Unknown error'));
        input.remove();
        nameDisplay.style.display = '';
        nameDisplay.dataset.editing = 'false';
      }
    } catch (err) {
      console.error('[Directory] Error updating directory:', err);
      alert('Error renaming directory: ' + err.message);
      input.remove();
      nameDisplay.style.display = '';
      nameDisplay.dataset.editing = 'false';
    }
  };
  
  input.addEventListener('blur', saveName);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveName();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.remove();
      nameDisplay.style.display = '';
      nameDisplay.dataset.editing = 'false';
    }
  });
}

// Handle delete directory
async function handleDeleteDirectory(directoryId, directoryName) {
  if (!checkElectronAPI() || !currentUser) {
    console.error('[Directory] Cannot delete directory: no user');
    return;
  }
  
  if (!confirm(`Delete directory "${directoryName}"? Items in this directory will be moved back to the main list.`)) {
    return;
  }
  
  try {
    const result = await window.electronAPI.firestore.deleteDirectory(directoryId, currentUser.uid);
    
    if (result.success) {
      console.log(`[Directory] Successfully deleted directory: ${directoryName}`);
      // Directory will be removed via real-time listener
    } else {
      console.error('[Directory] Failed to delete directory:', result.error);
      alert('Failed to delete directory: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[Directory] Error deleting directory:', err);
    alert('Error deleting directory: ' + err.message);
  }
}

// Setup drop zone when DOM is ready
console.log('main.js: Setting up, document.readyState:', document.readyState);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('main.js: DOMContentLoaded fired');
    // setupDropZone(); // Replaced by unified DnD system
    initializeDock();
    setupDrawerToggle();
    setupDockPin();
    setupFocusState();
    setupUnifiedDropHandlers(); // Initialize unified DnD
    // Delete zone removed
  });
} else {
  console.log('main.js: DOM already ready');
  // setupDropZone(); // Replaced by unified DnD system
  initializeDock();
  setupDrawerToggle();
  setupDockPin();
  setupFocusState();
  setupUnifiedDropHandlers(); // Initialize unified DnD
  // Delete zone removed
}
