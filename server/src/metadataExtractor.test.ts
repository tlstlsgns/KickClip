/**
 * Example usage of metadata extractor
 * This file demonstrates how to use the extractMetadata function
 */

import { extractMetadata } from './metadataExtractor.js';

// Example: Extract metadata from Google.com
async function example() {
  console.log('Extracting metadata from https://www.google.com...\n');
  
  const result = await extractMetadata('https://www.google.com');
  
  console.log('Result:');
  console.log(JSON.stringify(result, null, 2));
}

// Run example if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  example().catch(console.error);
}

