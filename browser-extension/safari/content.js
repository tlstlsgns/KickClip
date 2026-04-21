// Track currently hovered image element
let hoveredImage = null;

// Track currently hovered link element
let hoveredLink = null;

// Listen for mouse movement to track image hover and link hover
document.addEventListener('mouseover', (e) => {
  // Check if the element or its parent is a link (a tag with href)
  let link = e.target.closest('a[href]');
  
  // Special handling for Instagram: if hovering over article/post, find the post link
  if (window.location.hostname.includes('instagram.com')) {
    const article = e.target.closest('article');
    if (article) {
      // Look for Instagram post link within the article (links with /p/ pattern)
      // This includes both /p/... and /username/p/... formats
      const postLink = article.querySelector('a[href*="/p/"]');
      if (postLink) {
        link = postLink;
      }
    }
    
    // Also check if we're hovering directly over a post link (for profile page grids)
    // Profile pages have posts in a grid where the link itself might be hovered
    if (!link) {
      const hoveredPostLink = e.target.closest('a[href*="/p/"]');
      if (hoveredPostLink) {
        link = hoveredPostLink;
      }
    }
  }
  
  if (link && link.href) {
    // Only track links that point to other websites (not same-origin anchors/fragments)
    // For Instagram, always track post links (they might be relative URLs like /p/...)
    try {
      const linkUrl = new URL(link.href, window.location.href); // Use base URL for relative links
      const currentUrl = new URL(window.location.href);
      
      // For Instagram post links, always track them
      if (link.href.includes('/p/')) {
        hoveredLink = link;
      } else if (linkUrl.origin !== currentUrl.origin || linkUrl.pathname !== currentUrl.pathname || linkUrl.search !== currentUrl.search) {
        hoveredLink = link;
      } else {
        hoveredLink = null;
      }
    } catch (err) {
      // If URL parsing fails, don't track it
      hoveredLink = null;
    }
  } else {
    hoveredLink = null;
  }
  
  // Check if the element or its parent is an img tag
  const img = e.target.closest('img');
  if (img) {
    hoveredImage = img;
  } else {
    // Also check for elements with background-image
    const element = e.target;
    const bgImage = window.getComputedStyle(element).backgroundImage;
    if (bgImage && bgImage !== 'none') {
      hoveredImage = element;
    } else {
      hoveredImage = null;
    }
  }
}, true);

// Listen for mouse leave to clear hovered image and link
document.addEventListener('mouseout', (e) => {
  if (e.target === hoveredImage || hoveredImage?.contains(e.target)) {
    hoveredImage = null;
  }
  if (e.target === hoveredLink || hoveredLink?.contains(e.target)) {
    hoveredLink = null;
  }
}, true);

// Get image URL from element (img tag or background-image)
function getImageUrl(element) {
  if (!element) return null;
  
  if (element.tagName === 'IMG') {
    // Try different src attributes in order of preference
    const imgSrc = element.src || 
                   element.currentSrc || 
                   element.dataset.src || 
                   element.dataset.original || 
                   element.dataset.lazySrc ||
                   null;
    
    // Validate it's actually an image URL
    if (imgSrc && (imgSrc.startsWith('http') || imgSrc.startsWith('data:image'))) {
      try {
        return new URL(imgSrc, window.location.href).href;
      } catch (e) {
        return imgSrc;
      }
    }
  } else {
    // Extract from background-image CSS
    const bgImage = window.getComputedStyle(element).backgroundImage;
    if (bgImage && bgImage !== 'none' && bgImage !== 'initial') {
      // Extract URL from url("...") or url('...') - handle multiple backgrounds
      const matches = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/g);
      if (matches && matches.length > 0) {
        // Get the first background image URL
        const firstMatch = matches[0].match(/url\(['"]?([^'"]+)['"]?\)/);
        if (firstMatch && firstMatch[1]) {
          try {
            return new URL(firstMatch[1], window.location.href).href;
          } catch (e) {
            return firstMatch[1];
          }
        }
      }
    }
    
    // Also check for data attributes that might contain image URLs
    if (element.dataset.src || element.dataset.bg) {
      const dataSrc = element.dataset.src || element.dataset.bg;
      try {
        return new URL(dataSrc, window.location.href).href;
      } catch (e) {
        return dataSrc;
      }
    }
  }
  return null;
}

// Extract Instagram post thumbnail from rendered DOM image elements
function getInstagramThumbnail(url) {
  try {
    // Only process Instagram post URLs
    if (!url || !url.includes('instagram.com/p/')) {
      return null;
    }

    // Extract post ID from URL 
    // Handles formats like:
    // - "/p/DSAArEQj1Ac/" (standard format)
    // - "/username/p/DSrj5NiCRj-/" (profile page format)
    // - "instagram.com/p/DSAArEQj1Ac/"
    let postId = null;
    try {
      // Handle both absolute and relative URLs
      let urlToParse = url;
      if (!urlToParse.startsWith('http')) {
        // If relative URL, add base
        urlToParse = 'https://www.instagram.com' + (urlToParse.startsWith('/') ? urlToParse : '/' + urlToParse);
      }
      const urlObj = new URL(urlToParse);
      // Match /p/POST_ID pattern (works for both /p/... and /username/p/... formats)
      const pathMatch = urlObj.pathname.match(/\/p\/([^\/\?]+)/);
      if (pathMatch && pathMatch[1]) {
        postId = pathMatch[1];
      }
    } catch (e) {
      // If URL parsing fails, try simple regex (works for both formats)
      const match = url.match(/\/p\/([^\/\?]+)/);
      if (match && match[1]) {
        postId = match[1];
      }
    }

    if (!postId) {
      return null;
    }

    // Helper function to extract image URL from an img element
    const extractImageUrl = (img) => {
      if (!img) return null;
      
      let imageUrl = img.src || img.currentSrc;
      
      // Prefer srcset for higher quality images
      if (img.srcset && !imageUrl.includes('data:image')) {
        const srcset = img.srcset.split(',');
        if (srcset.length > 0) {
          // Get the highest resolution image (usually the last one in srcset)
          // Parse format: "url width" or "url w"
          for (let i = srcset.length - 1; i >= 0; i--) {
            const src = srcset[i].trim().split(/\s+/)[0];
            if (src && !src.includes('data:image')) {
              imageUrl = src;
              break;
            }
          }
        }
      }
      
      // Filter out generic Instagram CDN placeholder URLs and data URIs
      if (imageUrl && 
          !imageUrl.includes('rsrc.php') && 
          !imageUrl.includes('data:image') &&
          (imageUrl.includes('instagram.com') || imageUrl.includes('cdninstagram.com'))) {
        try {
          return new URL(imageUrl, window.location.href).href;
        } catch (urlError) {
          return null;
        }
      }
      return null;
    };

    // Helper function to check if an image is a profile picture (should be filtered out)
    const isProfilePicture = (img) => {
      if (!img) return false;
      const alt = (img.alt || '').toLowerCase();
      // Check alt text for profile picture indicators
      if (alt.includes('프로필') || alt.includes('profile') || alt.includes('프로필 사진') || alt.includes('profile picture')) {
        return true;
      }
      // Check if image is in header section (profile pictures are typically in headers)
      const header = img.closest('header');
      if (header) {
        // Profile pictures are usually small and in header
        return true;
      }
      return false;
    };

    // Helper function to check if a container has a video element (video posts)
    const hasVideo = (container) => {
      if (!container) return false;
      const video = container.querySelector('video');
      return video !== null;
    };

    // Helper function to extract thumbnail from an element's context
    const extractThumbnailFromContext = (element) => {
      if (!element) return null;

      const instagramImageSelectors = [
        '._aagu img',
        '._aagv img',
        'img[style*="object-fit"]',
        'img',
      ];

      // For video posts, try video poster first
      if (hasVideo(element)) {
        const video = element.querySelector('video[poster]');
        if (video && video.poster) {
          try {
            const absoluteUrl = new URL(video.poster, window.location.href).href;
            if (!absoluteUrl.includes('rsrc.php')) {
              return absoluteUrl;
            }
          } catch (urlError) {
            // Continue to other methods
          }
        }
      }

      // Look for images in Instagram-specific containers
      for (const selector of instagramImageSelectors) {
        const images = element.querySelectorAll(selector);
        for (const img of images) {
          if (isProfilePicture(img)) {
            continue;
          }
          const imageUrl = extractImageUrl(img);
          if (imageUrl) {
            return imageUrl;
          }
        }
      }

      return null;
    };

    // Helper function to check if an element's attribute value contains the Post ID
    const elementContainsPostId = (element, postId) => {
      if (!element || !postId) return false;

      // Check common attributes where Post ID might appear
      const attributesToCheck = [
        'href',
        'data-post-id',
        'data-id',
        'id',
        'class',
        'data-shortcode', // Instagram sometimes uses this
      ];

      for (const attr of attributesToCheck) {
        const value = element.getAttribute(attr);
        if (value) {
          // Check for exact Post ID match or Post ID in /p/POST_ID pattern
          if (value === postId || value.includes(`/p/${postId}`) || value.includes(postId)) {
            // For href, verify it's in the /p/ pattern
            if (attr === 'href') {
              const match = value.match(/\/p\/([^\/\?]+)/);
              if (match && match[1] === postId) {
                return true;
              }
            } else {
              return true;
            }
          }
        }
      }

      return false;
    };

    // Multi-attribute search strategy: Search for Post ID in various attributes
    const searchSelectors = [
      `a[href*="/p/${postId}"]`,           // Links with Post ID in href
      `[data-post-id*="${postId}"]`,       // Data attributes
      `[data-id*="${postId}"]`,
      `[data-shortcode*="${postId}"]`,     // Instagram shortcode
      `[id*="${postId}"]`,                 // ID attribute
      `[class*="${postId}"]`,              // Class attribute (less common but possible)
    ];

    // Try each search selector
    for (const selector of searchSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        
        for (const element of elements) {
          // Verify this element actually contains the Post ID
          if (!elementContainsPostId(element, postId)) {
            continue;
          }

          // Try to extract thumbnail from the element itself
          let thumbnail = extractThumbnailFromContext(element);
          if (thumbnail) {
            console.log(`Extension: Extracted Instagram thumbnail from element (${selector}):`, thumbnail);
            return thumbnail;
          }

          // Try to extract from parent container
          const parentContainer = element.closest('article') || 
                                  element.closest('div[class*="_aag"]') || 
                                  element.parentElement;
          
          if (parentContainer && parentContainer !== document.body) {
            thumbnail = extractThumbnailFromContext(parentContainer);
            if (thumbnail) {
              console.log(`Extension: Extracted Instagram thumbnail from parent container (${selector}):`, thumbnail);
              return thumbnail;
            }
          }
        }
      } catch (e) {
        // If selector is invalid, skip it
        console.log(`Extension: Invalid selector ${selector}, skipping`);
        continue;
      }
    }

    // For individual post pages: if we're on the post page itself, try finding the main container
    try {
      const currentUrl = window.location.href;
      if (currentUrl.includes(`/p/${postId}`)) {
        // Try og:image meta tag for video posts or as fallback
        const ogImageMeta = document.querySelector('meta[property="og:image"]');
        if (ogImageMeta) {
          const thumbnailUrl = ogImageMeta.getAttribute('content');
          if (thumbnailUrl && !thumbnailUrl.includes('rsrc.php') && !thumbnailUrl.includes('data:image')) {
            try {
              const absoluteUrl = new URL(thumbnailUrl, window.location.href).href;
              console.log('Extension: Extracted Instagram thumbnail from og:image (individual post page):', absoluteUrl);
              return absoluteUrl;
            } catch (urlError) {
              // Continue
            }
          }
        }

        // Try to find video poster if it's a video post
        const video = document.querySelector('video[poster]');
        if (video && video.poster) {
          try {
            const absoluteUrl = new URL(video.poster, window.location.href).href;
            if (!absoluteUrl.includes('rsrc.php')) {
              console.log('Extension: Extracted Instagram video thumbnail from video poster (individual post page):', absoluteUrl);
              return absoluteUrl;
            }
          } catch (urlError) {
            // Continue
          }
        }

        // Try to find the main post container on individual post pages
        const mainArticle = document.querySelector('article');
        if (mainArticle) {
          const thumbnail = extractThumbnailFromContext(mainArticle);
          if (thumbnail) {
            console.log('Extension: Extracted Instagram thumbnail from main article (individual post page):', thumbnail);
            return thumbnail;
          }
        }
      }
    } catch (e) {
      // Ignore errors
    }

    // Final fallback: og:image meta tag
    const ogImageMeta = document.querySelector('meta[property="og:image"]');
    if (ogImageMeta) {
      const thumbnailUrl = ogImageMeta.getAttribute('content');
      if (thumbnailUrl && !thumbnailUrl.includes('rsrc.php') && !thumbnailUrl.includes('data:image')) {
        try {
          const absoluteUrl = new URL(thumbnailUrl, window.location.href).href;
          console.log('Extension: Extracted Instagram thumbnail from og:image (final fallback):', absoluteUrl);
          return absoluteUrl;
        } catch (urlError) {
          // Ignore
        }
      }
    }

    return null;
  } catch (error) {
    console.log('Extension: Error extracting Instagram thumbnail:', error);
    return null;
  }
}

// Send data to server
async function saveToServer(data) {
  try {
    const response = await fetch('http://localhost:3000/api/v1/save-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (response.ok) {
      console.log('✅ URL saved successfully!', data);
    } else {
      console.error('❌ Failed to save URL:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('❌ Error saving URL:', error);
  }
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'save-url') {
    const imgUrl = hoveredImage ? getImageUrl(hoveredImage) : null;
    
    // SYNC: Determine URL to save: if hovering over a link, use the link's href; otherwise use current page URL
    let urlToSave = window.location.href;
    let titleToSave = document.title;
    
    if (hoveredLink && hoveredLink.href) {
      // Convert relative URL to absolute if needed (especially for Instagram)
      if (hoveredLink.href.startsWith('/')) {
        const baseUrl = window.location.origin;
        urlToSave = baseUrl + hoveredLink.href;
      } else {
        urlToSave = hoveredLink.href;
      }
      // Extract clean title from the link element
      titleToSave = hoveredLink.title || hoveredLink.textContent?.trim() || urlToSave;
    }
    
    // Extract Instagram thumbnail early (sync operation, for initial payload)
    let thumbnail = null;
    if (urlToSave && urlToSave.includes('instagram.com/p/')) {
      thumbnail = getInstagramThumbnail(urlToSave);
    }
    
    const payload = {
      url: urlToSave,
      title: titleToSave,
      timestamp: Date.now(),
      saved_by: 'extension', // Flag to indicate this save came from the extension
      ...(imgUrl && { img_url: imgUrl }),
      ...(thumbnail && { thumbnail }), // Include thumbnail for Instagram posts
    };

    saveToServer(payload);
    sendResponse({ success: true });
  }
  return true; // Keep message channel open for async response
});

