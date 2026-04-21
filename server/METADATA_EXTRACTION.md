# URL Metadata Extraction

This module extracts structured metadata from URLs following Slack's link metadata extraction logic.

## Extraction Flow

1. **Fetch URL**
   - Uses Slackbot User-Agent: `Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`
   - Follows HTTP redirects automatically
   - 5 second timeout
   - Respects Content-Type (only processes `text/html`)

2. **Extract Metadata (Priority Order)**
   
   **Priority 1: JSON-LD Structured Data (highest priority)**
   - Parses `<script type="application/ld+json">` tags
   - Extracts `name`, `headline`, or `title` → title
   - Extracts `description` or `articleBody` → description
   - Extracts `image` (string, object, or array) → image
   - Extracts `@type` → type
   
   **Priority 2: Open Graph Tags**
   - `og:title` → title
   - `og:description` → description
   - `og:image` → image
   - `og:url` → final URL
   
   **Priority 3: Twitter Card Tags (if OG missing)**
   - `twitter:title` → title
   - `twitter:description` → description
   - `twitter:image` → image
   
   **Priority 4: Platform-Specific Extraction**
   - **Google Search**: Extracts knowledge graph data from HTML structure
     - Title from knowledge graph headings
     - Description from knowledge graph description elements
   - Future: Other platforms (Wikipedia, etc.)
   
   **Priority 5: HTML Fallback (if all above missing)**
   - `<title>` → title
   - `<meta name="description">` → description

3. **Normalization**
   - Trims whitespace from all text fields
   - Decodes HTML entities (e.g., `&amp;` → `&`, `&#39;` → `'`)
   - Resolves relative image URLs to absolute URLs
   - Prefers HTTPS over HTTP for image URLs

4. **Type Determination**
   - Uses JSON-LD `@type` if available (e.g., `Article`, `Product`, `Person`)
   - Uses `og:type` if available
   - Falls back to URL pattern matching:
     - `search`: Google/Naver/Bing search results
     - `article`: Blog posts, news articles
     - `product`: E-commerce product pages
     - `profile`: User profiles
     - `document`: PDF, DOC, etc.
     - `image`: Image files
     - `video`: YouTube, Vimeo, video files
     - `collection`: Playlists, collections
     - `social_post`: Twitter/X, Facebook, Instagram posts
     - `webpage`: Default fallback

5. **Error Handling**
   - On timeout: returns empty result (null values)
   - On network error: returns empty result
   - On parse error: returns empty result
   - Missing fields: returned as `null` (never throws)

## Usage

```typescript
import { extractMetadata } from './metadataExtractor';

const result = await extractMetadata('https://www.google.com');

console.log(result);
// {
//   originUrl: "https://www.google.com",
//   type: "webpage",
//   url: "https://www.google.com/",
//   title: "Google",
//   description: "Search the world's information...",
//   image: null
// }
```

## Example Result for https://www.google.com

```json
{
  "originUrl": "https://www.google.com",
  "type": "webpage",
  "url": "https://www.google.com/",
  "title": "Google",
  "description": "Search the world's information, including webpages, images, videos and more. Google has many special features to help you find exactly what you're looking for.",
  "image": null
}
```

**Note**: The actual result may vary slightly based on Google's current HTML structure, but it will follow the extraction priority (Open Graph > Twitter Card > HTML fallback).

## Output Format

```typescript
{
  originUrl: string;      // Original URL that user saved
  type: string;           // Type: search, article, product, webpage, profile, document, collection, image, video, social_post
  url: string;            // Final resolved URL (after redirects)
  title: string | null;   // Extracted title
  description: string | null; // Extracted description
  image: string | null;   // Absolute image URL
}
```

## Implementation Details

- **No JavaScript Execution**: Pure HTML parsing using regex and JSON parsing
- **No Headless Browser**: Uses native `fetch()` API
- **Server-Side Only**: Designed for Node.js backend
- **Lightweight**: No external dependencies (uses native fetch, regex, and JSON parsing)
- **Fast**: Regex-based parsing is much faster than DOM parsing
- **JSON-LD Support**: Parses structured data from `<script type="application/ld+json">` tags
- **Platform-Specific Parsers**: Includes Google knowledge graph extraction (best-effort)

