/**
 * Firebase Storage Utility Layer
 * 
 * Provides helpers for uploading files to Firebase Storage.
 * Used for persisting Instagram thumbnails and other images.
 */

import { 
  ref, 
  uploadBytes, 
  getDownloadURL,
  StorageReference,
} from 'firebase/storage';
import { storage } from './firebase.js';
import { BRAND, logFirebase, errorFirebase } from './brandConfig.js';

/**
 * Upload Instagram thumbnail to Firebase Storage
 * 
 * @param userId - The user ID who owns this thumbnail
 * @param shortcode - Instagram post shortcode
 * @param thumbnailUrl - The Instagram CDN URL to download from
 * @returns The permanent download URL from Firebase Storage
 */
export async function uploadInstagramThumbnail(
  userId: string,
  shortcode: string,
  thumbnailUrl: string
): Promise<string> {
  try {
    logFirebase(`[Storage] Starting upload for Instagram thumbnail: ${shortcode}`);
    logFirebase(`[Storage] Source URL: ${thumbnailUrl}`);
    
    // Step 1: Download the image from Instagram CDN
    logFirebase(`[Storage] Downloading image from Instagram CDN...`);
    const response = await fetch(thumbnailUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
    }
    
    // Get the image as ArrayBuffer, then convert to Buffer for Node.js
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    logFirebase(`[Storage] Downloaded ${imageBuffer.length} bytes`);
    
    // Determine file extension from URL or Content-Type
    let fileExtension = 'jpg'; // Default to jpg
    const contentType = response.headers.get('content-type');
    if (contentType) {
      if (contentType.includes('jpeg') || contentType.includes('jpg')) {
        fileExtension = 'jpg';
      } else if (contentType.includes('png')) {
        fileExtension = 'png';
      } else if (contentType.includes('webp')) {
        fileExtension = 'webp';
      }
    } else {
      // Try to extract from URL
      const urlMatch = thumbnailUrl.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
      if (urlMatch) {
        fileExtension = urlMatch[1].toLowerCase();
        if (fileExtension === 'jpeg') fileExtension = 'jpg';
      }
    }
    
    // Step 2: Create Storage reference
    // Path structure: users/{userId}/instagram-thumbnails/{shortcode}.{ext}
    const storagePath = `users/${userId}/instagram-thumbnails/${shortcode}.${fileExtension}`;
    const storageRef: StorageReference = ref(storage, storagePath);
    
    logFirebase(`[Storage] Uploading to path: ${storagePath}`);
    
    // Step 3: Upload to Firebase Storage
    const metadata = {
      contentType: contentType || `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`,
      customMetadata: {
        source: 'instagram',
        app: BRAND.NAME,
        appVersion: BRAND.VERSION,
        shortcode: shortcode,
        uploadedAt: new Date().toISOString(),
      },
    };
    
    const uploadResult = await uploadBytes(storageRef, imageBuffer, metadata);
    logFirebase(`[Storage] Upload successful: ${uploadResult.metadata.fullPath}`);
    
    // Step 4: Get the permanent download URL
    const downloadURL = await getDownloadURL(storageRef);
    logFirebase(`[Storage] Download URL: ${downloadURL}`);
    
    return downloadURL;
  } catch (error: any) {
    errorFirebase(`[Storage] Error uploading Instagram thumbnail:`, error);
    throw error;
  }
}

/**
 * Check if a URL is an Instagram CDN URL that should be uploaded to Storage
 * 
 * @param url - The URL to check
 * @returns True if the URL is an Instagram CDN URL
 */
export function isInstagramCDNUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  // Check if it's an Instagram CDN URL
  return url.includes('cdninstagram.com') || 
         url.includes('fbcdn.net') ||
         url.includes('instagram.com') && (url.includes('/p/') || url.includes('/media/'));
}

