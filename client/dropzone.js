// Dropzone script for the overlay window
const { ipcRenderer } = require('electron');

let dragCounter = 0; // Track drag enter/leave to handle nested elements

// Drag and drop functionality for drop zone
function setupDropZone() {
  console.log('Dropzone: Setting up drop zone...');
  const dropZone = document.getElementById('drop-zone');
  const body = document.body;
  
  if (!dropZone) {
    console.error('Dropzone: Element with id "drop-zone" not found!');
    return;
  }
  console.log('Dropzone: Element found, attaching event listeners');
  
  // Listen for drag events on the dropzone element itself (always visible, small area)
  const handleDragEnter = (e) => {
    console.log('Dropzone: dragenter detected', e.target);
    e.preventDefault();
    e.stopPropagation();
    
    if (dragCounter === 0) {
      // First drag enter - highlight dropzone
      console.log('Dropzone: Highlighting dropzone');
      dropZone.classList.add('show');
    }
    dragCounter++;
  };
  
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  
  // Listen on the dropzone element itself (always visible)
  dropZone.addEventListener('dragenter', handleDragEnter, false);
  dropZone.addEventListener('dragover', handleDragOver, false);

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      // All drags left - remove highlight
      dropZone.classList.remove('show', 'drag-over');
      dropZone.classList.remove('border-[#007bff]', 'bg-[rgba(0,123,255,0.1)]');
      dropZone.classList.add('border-[rgba(0,123,255,0.5)]');
    }
  }, false);

  // Drop on dropzone is handled below, no need for body drop handler
  
  // Prevent default drag behaviors on dropzone itself
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log(`Dropzone: ${eventName} event fired on dropzone`);
    });
  });

  // Add drag-over class for visual feedback when dragging over dropzone
  dropZone.addEventListener('dragenter', () => {
    dropZone.classList.add('drag-over', 'border-[#007bff]', 'bg-[rgba(0,123,255,0.1)]');
    dropZone.classList.remove('border-[rgba(0,123,255,0.5)]');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over', 'border-[#007bff]', 'bg-[rgba(0,123,255,0.1)]');
    dropZone.classList.add('border-[rgba(0,123,255,0.5)]');
  });

  // Handle drop on dropzone
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dropZone.classList.remove('show', 'drag-over', 'border-[#007bff]', 'bg-[rgba(0,123,255,0.1)]');
    dropZone.classList.add('border-[rgba(0,123,255,0.5)]');
    
    console.log('=== DROPZONE: Drop event triggered ===');
    const files = Array.from(e.dataTransfer.files);
    const items = Array.from(e.dataTransfer.items);
    const urls = [];
    const images = [];
    const texts = [];

    console.log('Dropzone: Files count:', files.length, 'Items count:', items.length);

    // Process data transfer items
    for (const item of items) {
      if (item.kind === 'file') {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            try {
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
              });
              if (dataUrl) {
                images.push(dataUrl);
              }
            } catch (err) {
              console.error('Dropzone: Error reading image item:', err);
            }
          }
        }
      } else if (item.kind === 'string') {
        const str = await new Promise((resolve) => {
          item.getAsString((s) => resolve(s));
        });
        const trimmedStr = str.trim();
        
        if (trimmedStr.startsWith('data:image/')) {
          images.push(trimmedStr);
          continue;
        }
        
        if (item.type === 'text/uri-list' && (trimmedStr.startsWith('http://') || trimmedStr.startsWith('https://'))) {
          try {
            const response = await fetch(trimmedStr, { method: 'HEAD', mode: 'cors' }).catch(() => 
              fetch(trimmedStr, { mode: 'cors' })
            );
            
            if (response && response.ok) {
              const contentType = response.headers.get('content-type');
              if (contentType && contentType.startsWith('image/')) {
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
                    images.push(dataUrl);
                    continue;
                  }
                }
              }
            }
          } catch (fetchErr) {
            // If fetch fails, check URL pattern
          }
        }
        
        const isImageUrl = (trimmedStr.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?|$|#)/i) ||
                          trimmedStr.match(/\/image[s]?\/|img\/|photo[s]?\/|picture[s]?\/|media\/image/i)) &&
                          (trimmedStr.startsWith('http://') || trimmedStr.startsWith('https://'));
        
        if (isImageUrl) {
          try {
            const response = await fetch(trimmedStr, { mode: 'cors' });
            if (response.ok) {
              const blob = await response.blob();
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
              if (dataUrl) {
                images.push(dataUrl);
                continue;
              }
            }
          } catch (fetchErr) {
            // If fetch fails, save URL directly
            images.push(trimmedStr);
            continue;
          }
        }
        
        if (trimmedStr.startsWith('http://') || trimmedStr.startsWith('https://')) {
          urls.push(trimmedStr);
        } else if (trimmedStr && !trimmedStr.startsWith('data:')) {
          texts.push(trimmedStr);
        }
      }
    }

    // Process files
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          if (dataUrl) {
            images.push(dataUrl);
          }
        } catch (err) {
          console.error('Dropzone: Error reading image file:', err);
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
        console.error('Dropzone: Error parsing HTML:', err);
      }
    }

    // Check plain text
    const plainText = e.dataTransfer.getData('text/plain');
    if (plainText) {
      const trimmedPlainText = plainText.trim();
      if (trimmedPlainText.startsWith('data:image/')) {
        images.push(trimmedPlainText);
      } else if (trimmedPlainText.startsWith('http://') || trimmedPlainText.startsWith('https://')) {
        urls.push(trimmedPlainText);
      }
    }

    console.log('Dropzone: Collected data - URLs:', urls.length, 'Images:', images.length, 'Texts:', texts.length);

    // Save all data
    const allPromises = [];

    // Save URLs
    for (const url of urls) {
      if (url.trim()) {
        allPromises.push(saveUrlToServer(url.trim(), url.trim(), undefined));
      }
    }

    // Save texts that look like URLs
    for (const text of texts) {
      const trimmedText = text.trim();
      if (trimmedText.startsWith('data:image/')) {
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
      allPromises.push(saveUrlToServer('', title, imageData));
    }

    // Wait for all saves to complete
    try {
      const results = await Promise.all(allPromises);
      console.log('Dropzone: All saves completed, results:', results);
      // Notify main window to refresh
      ipcRenderer.send('dropzone-save-complete');
    } catch (err) {
      console.error('Dropzone: Error saving dropped items:', err);
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

      const response = await fetch('http://localhost:3000/api/v1/save-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const result = await response.json();
        console.log('✅ Dropzone: Saved successfully:', result);
        return true;
      } else {
        const errorText = await response.text();
        console.error('❌ Dropzone: Failed to save:', response.status, response.statusText, errorText);
        return false;
      }
    } catch (error) {
      console.error('❌ Dropzone: Error saving:', error);
      return false;
    }
  }
}

// Setup drop zone when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupDropZone);
} else {
  setupDropZone();
}

