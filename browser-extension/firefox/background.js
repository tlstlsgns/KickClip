// Create context menu items
function createContextMenus() {
  // Remove existing menus first to avoid duplicates
  browser.contextMenus.removeAll(() => {
    // Create context menu for images
    browser.contextMenus.create({
      id: 'save-image',
      title: 'Save image with Blink',
      contexts: ['image']
    });

    // Create context menu for links
    browser.contextMenus.create({
      id: 'save-link',
      title: 'Save link with Blink',
      contexts: ['link']
    });

    // Create context menu for page
    browser.contextMenus.create({
      id: 'save-page',
      title: 'Save page with Blink',
      contexts: ['page', 'selection']
    });
  });
}

// Create context menus on install
browser.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

// Also create context menus when background script loads (for existing installations)
createContextMenus();

// Handle context menu clicks
browser.contextMenus.onClicked.addListener((info, tab) => {
  console.log('Extension background: Context menu clicked:', info.menuItemId);
  
  // Check if this is a system page where we can't inject
  if (tab.url && (tab.url.startsWith('about:') || tab.url.startsWith('moz-extension://'))) {
    console.log('Extension background: Cannot save on system page:', tab.url);
    return;
  }

  if (info.menuItemId === 'save-image') {
    // Save image URL + current page URL
    browser.tabs.sendMessage(tab.id, { 
      action: 'save-url',
      img_url: info.srcUrl,
      from_context_menu: true
    }).catch((error) => {
      console.error('Extension background: Error sending message:', error);
      // Fallback: save directly with page URL as context
      const payload = {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        saved_by: 'extension',
        img_url: info.srcUrl
      };
      saveDirectly(tab, null, payload);
    });
  } else if (info.menuItemId === 'save-link') {
    // Save link URL
    const payload = {
      url: info.linkUrl,
      title: info.linkText || info.linkUrl,
      timestamp: Date.now(),
      saved_by: 'extension'
    };
    saveDirectly(tab, null, payload);
  } else if (info.menuItemId === 'save-page') {
    // Save current page (same as keyboard shortcut)
    browser.tabs.sendMessage(tab.id, { action: 'save-url' }).catch((error) => {
      console.error('Extension background: Error sending message:', error);
    });
  }
});

// Helper function to save directly to server (fallback when content script unavailable)
async function saveDirectly(tab, imageUrl, payload) {
  const finalPayload = payload || {
    url: tab.url,
    title: tab.title,
    timestamp: Date.now(),
    saved_by: 'extension',
    ...(imageUrl && { img_url: imageUrl })
  };
  
  try {
    const response = await fetch('http://localhost:3000/api/v1/save-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(finalPayload),
    });
    
    if (response.ok) {
      console.log('Extension background: Saved via context menu successfully');
    } else {
      console.error('Extension background: Failed to save via context menu:', response.status);
    }
  } catch (error) {
    console.error('Extension background: Error saving via context menu:', error);
  }
}

// Listen for keyboard shortcut command
browser.commands.onCommand.addListener((command) => {
  if (command === 'save-url') {
    // Send message to active tab's content script
    browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        browser.tabs.sendMessage(tabs[0].id, { action: 'save-url' }, (response) => {
          if (browser.runtime.lastError) {
            console.error('Error sending message:', browser.runtime.lastError);
          }
        });
      }
    });
  }
});

