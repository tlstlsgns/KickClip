// Standalone script to detect shortcut and show enable popup
// This can be injected into pages via Electron app or used as a bookmarklet

(function() {
  'use strict';
  
  // Track hovered image
  let hoveredImage = null;
  
  document.addEventListener('mouseover', (e) => {
    const img = e.target.closest('img');
    if (img) {
      hoveredImage = img;
    } else {
      const element = e.target;
      const bgImage = window.getComputedStyle(element).backgroundImage;
      if (bgImage && bgImage !== 'none' && bgImage !== 'initial') {
        hoveredImage = element;
      } else {
        hoveredImage = null;
      }
    }
  }, true);
  
  // Check if extension is enabled
  function isExtensionEnabled() {
    try {
      return typeof chrome !== 'undefined' && 
             chrome.runtime && 
             chrome.runtime.id !== undefined;
    } catch (e) {
      return false;
    }
  }
  
  // Detect browser type
  function getBrowserInfo() {
    const ua = navigator.userAgent;
    if (ua.includes('Edg/')) return { name: 'Edge', url: 'edge://extensions/' };
    if (ua.includes('Arc/')) return { name: 'Arc', url: 'arc://extensions/' };
    if (ua.includes('Chrome/') && !ua.includes('Edg/')) return { name: 'Chrome', url: 'chrome://extensions/' };
    if (ua.includes('Firefox/')) return { name: 'Firefox', url: 'about:addons' };
    return { name: 'Browser', url: 'chrome://extensions/' };
  }
  
  // Show popup
  function showEnablePopup() {
    const existing = document.getElementById('url-saver-enable-popup');
    if (existing) return;
    
    const browser = getBrowserInfo();
    const hasHoveredImage = hoveredImage !== null;
    
    const popup = document.createElement('div');
    popup.id = 'url-saver-enable-popup';
    popup.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      padding: 24px;
      z-index: 2147483647;
      max-width: 400px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;
    
    popup.innerHTML = `
      <div style="font-size: 18px; font-weight: 600; margin-bottom: 12px; color: #333;">
        ${hasHoveredImage ? '🖼️' : '🔌'} Enable Blink Extension
      </div>
      <div style="color: #666; margin-bottom: 20px; line-height: 1.5; font-size: 14px;">
        ${hasHoveredImage 
          ? 'To save this image, please enable the Blink extension.' 
          : 'To save images by hovering, please enable the Blink extension.'}
      </div>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="url-saver-cancel" style="
          padding: 8px 16px;
          border: 1px solid #ddd;
          background: white;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        ">Cancel</button>
        <button id="url-saver-enable" style="
          padding: 8px 20px;
          border: none;
          background: #007bff;
          color: white;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        ">Enable Extension</button>
      </div>
    `;
    
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      z-index: 2147483646;
    `;
    overlay.id = 'url-saver-popup-overlay';
    
    document.body.appendChild(overlay);
    document.body.appendChild(popup);
    
    // Close handlers
    const close = () => { popup.remove(); overlay.remove(); };
    document.getElementById('url-saver-cancel').onclick = close;
    overlay.onclick = close;
    
    // Enable button - open extensions page
    document.getElementById('url-saver-enable').onclick = () => {
      window.open(browser.url, '_blank');
      close();
      // Show brief instructions
      setTimeout(() => {
        alert(`To enable the extension:\n\n1. Enable "Developer mode" (toggle in top right)\n2. Click "Load unpacked"\n3. Select the extension folder\n\nAfter enabling, refresh this page and try again.`);
      }, 300);
    };
  }
  
  // Listen for shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'S') {
      if (!isExtensionEnabled()) {
        e.preventDefault();
        e.stopPropagation();
        showEnablePopup();
      }
    }
  }, true);
})();






