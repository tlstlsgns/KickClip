interface MetadataResult {
  originUrl: string;
  type: string;
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
}

interface ExtractOptions {
  timeout?: number;
  userAgent?: string;
}

/**
 * Extracts metadata from a URL following Slack's extraction logic
 * Priority: JSON-LD > Open Graph > Twitter Card > Platform-specific > HTML fallback
 */
export async function extractMetadata(
  originUrl: string,
  options: ExtractOptions = {}
): Promise<MetadataResult> {
  const timeout = options.timeout || 5000;
  const userAgent = options.userAgent || 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

  try {
    // Fetch the URL with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(originUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow', // Follow redirects
    });

    clearTimeout(timeoutId);

    // Get the final URL after redirects
    const finalUrl = response.url;

    // Check if response is OK
    if (!response.ok) {
      return createEmptyResult(originUrl, finalUrl);
    }

    // Get content type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return createEmptyResult(originUrl, finalUrl);
    }

    // Read HTML content
    const html = await response.text();

    // Detect platform for specific parsers
    const urlObj = new URL(finalUrl);
    const isGoogle = urlObj.hostname.includes('google.com');

    // Extract metadata with priority: JSON-LD > Open Graph > Twitter Card > Platform-specific > HTML fallback
    const jsonLdData = extractJSONLD(html);
    const platformData = isGoogle ? extractGoogleKnowledgeGraph(html, finalUrl) : null;

    const metadata = {
      title: jsonLdData?.title ||
             extractOpenGraphTag(html, 'title') ||
             extractTwitterCardTag(html, 'title') ||
             platformData?.title ||
             extractHTMLTitle(html),
      description: jsonLdData?.description ||
                   extractOpenGraphTag(html, 'description') ||
                   extractTwitterCardTag(html, 'description') ||
                   platformData?.description ||
                   extractHTMLMetaDescription(html),
      image: jsonLdData?.image ||
             extractOpenGraphTag(html, 'image') ||
             extractTwitterCardTag(html, 'image') ||
             platformData?.image ||
             null,
    };

    // Normalize values
    const normalized = {
      title: normalizeText(metadata.title),
      description: normalizeText(metadata.description),
      image: normalizeImageUrl(metadata.image, finalUrl),
    };

    // Determine type based on JSON-LD > Open Graph > URL patterns
    const ogType = extractOpenGraphTag(html, 'type');
    const jsonLdType = jsonLdData?.type || jsonLdData?.['@type'];
    const type = determineType(jsonLdType, ogType, finalUrl);

    return {
      originUrl,
      type,
      url: finalUrl,
      title: normalized.title,
      description: normalized.description,
      image: normalized.image,
    };

  } catch (error) {
    // On any error (timeout, network error, parse error, etc.), return empty result
    return createEmptyResult(originUrl, originUrl);
  }
}

/**
 * Extracts JSON-LD structured data from HTML
 */
function extractJSONLD(html: string): { title?: string; description?: string; image?: string; type?: string; '@type'?: string } | null {
  try {
    // Match all JSON-LD script tags
    const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([^<]*)<\/script>/gi;
    const matches = Array.from(html.matchAll(jsonLdPattern));

    if (matches.length === 0) {
      return null;
    }

    // Parse each JSON-LD block and extract relevant fields
    for (const match of matches) {
      try {
        const jsonStr = match[1];
        const data = JSON.parse(jsonStr);

        // Handle arrays (sometimes JSON-LD is an array)
        const items = Array.isArray(data) ? data : [data];

        for (const item of items) {
          // Extract title
          let title: string | undefined;
          if (item.name) title = item.name;
          else if (item.headline) title = item.headline;
          else if (item.title) title = item.title;

          // Extract description
          let description: string | undefined;
          if (item.description) description = item.description;
          else if (item.articleBody) description = item.articleBody;

          // Extract image
          let image: string | undefined;
          if (typeof item.image === 'string') {
            image = item.image;
          } else if (item.image?.url) {
            image = item.image.url;
          } else if (Array.isArray(item.image) && item.image[0]?.url) {
            image = item.image[0].url;
          }

          // If we found any data, return it
          if (title || description || image) {
            return {
              title,
              description,
              image,
              type: item['@type'],
              '@type': item['@type'],
            };
          }
        }
      } catch (parseError) {
        // Continue to next JSON-LD block if parsing fails
        continue;
      }
    }
  } catch (error) {
    // Return null if extraction fails
  }

  return null;
}

/**
 * Extracts Google Knowledge Graph data from search results
 */
function extractGoogleKnowledgeGraph(html: string, url: string): { title?: string; description?: string; image?: string } | null {
  try {
    const result: { title?: string; description?: string; image?: string } = {};

    // Extract from knowledge graph panel (data-attrid="rhs" or similar)
    // Google often renders knowledge graph in divs with specific data attributes
    
    // Pattern 1: Extract title from knowledge graph heading
    // Look for patterns like: <h2 class="...">Interior design</h2> or <span>Interior design</span>
    // within knowledge graph sections
    const titlePatterns = [
      /<h2[^>]*data-attrid="[^"]*"[^>]*>([^<]+)<\/h2>/i,
      /<span[^>]*class="[^"]*knowledge-panel[^"]*"[^>]*><[^>]*>([^<]+)<\/span>/i,
      /<div[^>]*data-attrid="[^"]*title[^"]*"[^>]*>([^<]+)<\/div>/i,
    ];

    for (const pattern of titlePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const extracted = decodeHTMLEntities(match[1].trim());
        if (extracted && extracted.length > 0 && extracted.length < 200) {
          result.title = extracted;
          break;
        }
      }
    }

    // Pattern 2: Extract description from knowledge graph description text
    // Look for description in div/span elements with specific classes or data attributes
    const descPatterns = [
      /<div[^>]*data-attrid="[^"]*description[^"]*"[^>]*>([^<]+)<\/div>/i,
      /<span[^>]*class="[^"]*[Dd]escription[^"]*"[^>]*>([^<]+)<\/span>/i,
      /<div[^>]*class="[^"]*kno-rdesc[^"]*"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/is,
    ];

    for (const pattern of descPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const extracted = decodeHTMLEntities(match[1].trim());
        if (extracted && extracted.length > 0 && extracted.length < 500) {
          result.description = extracted;
          break;
        }
      }
    }

    // Pattern 3: Extract from Google's structured data within script tags
    // Google sometimes embeds knowledge graph data in inline JavaScript
    const scriptDataPattern = /window\.__INITIAL_STATE__\s*=\s*({[^<]+});/i;
    const scriptMatch = html.match(scriptDataPattern);
    if (scriptMatch) {
      try {
        const data = JSON.parse(scriptMatch[1]);
        // Navigate through Google's data structure (this may vary)
        // This is a best-effort attempt to extract from their internal state
      } catch (e) {
        // Continue if parsing fails
      }
    }

    // Pattern 4: Extract from specific HTML structures Google uses for knowledge graph
    // Look for patterns in the HTML structure that Google uses
    // Example: <div class="kno-fv"> or similar structures
    
    // If we found at least one field, return the result
    if (result.title || result.description || result.image) {
      return result;
    }
  } catch (error) {
    // Return null if extraction fails
  }

  return null;
}

/**
 * Extracts Open Graph meta tag value using regex
 */
function extractOpenGraphTag(html: string, property: string): string | null {
  // Try property attribute first (standard Open Graph)
  // Match: <meta property="og:title" content="value" />
  const propertyPattern = new RegExp(
    `<meta[^>]*(?:property|name)=["']og:${property}["'][^>]*content=["']([^"']+)["']`,
    'i'
  );
  const propertyMatch = html.match(propertyPattern);
  if (propertyMatch && propertyMatch[1]) {
    return propertyMatch[1];
  }

  return null;
}

/**
 * Extracts Twitter Card meta tag value using regex
 */
function extractTwitterCardTag(html: string, property: string): string | null {
  // Twitter Card uses name attribute
  const nameMap: { [key: string]: string } = {
    'title': 'twitter:title',
    'description': 'twitter:description',
    'image': 'twitter:image',
  };

  const twitterName = nameMap[property];
  if (!twitterName) return null;

  // Match: <meta name="twitter:title" content="value" />
  const pattern = new RegExp(
    `<meta[^>]*(?:name|property)=["']${twitterName.replace(/:/g, '\\:')}["'][^>]*content=["']([^"']+)["']`,
    'i'
  );
  const match = html.match(pattern);
  if (match && match[1]) {
    return match[1];
  }

  return null;
}

/**
 * Extracts HTML <title> tag using regex
 */
function extractHTMLTitle(html: string): string | null {
  // Match: <title>content</title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1];
  }
  return null;
}

/**
 * Extracts HTML meta description using regex
 */
function extractHTMLMetaDescription(html: string): string | null {
  // Match: <meta name="description" content="value" />
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (descMatch && descMatch[1]) {
    return descMatch[1];
  }
  return null;
}

/**
 * Normalizes text: trims whitespace and decodes HTML entities
 */
function normalizeText(text: string | null): string | null {
  if (!text) return null;

  // Trim whitespace
  let normalized = text.trim();
  if (!normalized) return null;

  // Decode HTML entities
  normalized = decodeHTMLEntities(normalized);

  return normalized;
}

/**
 * Decodes HTML entities
 */
function decodeHTMLEntities(text: string): string {
  const entities: { [key: string]: string } = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };

  // Decode common entities
  let decoded = text;
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.replace(new RegExp(entity, 'g'), char);
  }

  // Decode numeric entities (&#123; or &#x1F;)
  decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
    return String.fromCharCode(parseInt(dec, 10));
  });

  decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });

  return decoded;
}

/**
 * Normalizes image URL: resolves relative URLs to absolute, prefers HTTPS
 */
function normalizeImageUrl(imageUrl: string | null, baseUrl: string): string | null {
  if (!imageUrl) return null;

  // Trim whitespace
  const trimmed = imageUrl.trim();
  if (!trimmed) return null;

  try {
    // Resolve relative URLs
    const absoluteUrl = new URL(trimmed, baseUrl).href;

    // Prefer HTTPS if possible (convert http:// to https://)
    if (absoluteUrl.startsWith('http://')) {
      return absoluteUrl.replace('http://', 'https://');
    }

    return absoluteUrl;
  } catch (error) {
    // Invalid URL, return null
    return null;
  }
}

/**
 * Determines the type based on JSON-LD type, Open Graph type or URL patterns
 */
function determineType(jsonLdType: string | null | undefined, ogType: string | null, url: string): string {
  // If JSON-LD type is available, map it
  if (jsonLdType) {
    const typeLower = jsonLdType.toLowerCase();
    if (typeLower.includes('article') || typeLower.includes('blogposting') || typeLower.includes('newsarticle')) return 'article';
    if (typeLower.includes('product')) return 'product';
    if (typeLower.includes('person') || typeLower.includes('profile')) return 'profile';
    if (typeLower.includes('video') || typeLower.includes('videobject')) return 'video';
    if (typeLower.includes('image') || typeLower.includes('imageobject')) return 'image';
  }

  // If Open Graph type is available, map it
  if (ogType) {
    const ogTypeLower = ogType.toLowerCase();
    if (ogTypeLower.includes('article')) return 'article';
    if (ogTypeLower.includes('product')) return 'product';
    if (ogTypeLower.includes('profile')) return 'profile';
    if (ogTypeLower.includes('video')) return 'video';
    if (ogTypeLower.includes('image')) return 'image';
  }

  // Fallback to URL pattern matching
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname.toLowerCase();

    // Search
    if (hostname.includes('google.com') && pathname.includes('/search')) return 'search';
    if (hostname.includes('naver.com') && urlObj.searchParams.has('query')) return 'search';
    if (hostname.includes('bing.com') && pathname.includes('/search')) return 'search';

    // Social post
    if ((hostname.includes('twitter.com') || hostname.includes('x.com')) && pathname.match(/\/[^/]+\/status\/\d+/)) return 'social_post';
    if (hostname.includes('facebook.com') && pathname.match(/\/[^/]+\/posts\/\d+/)) return 'social_post';
    if (hostname.includes('instagram.com') && (pathname.match(/\/p\//) || pathname.match(/\/reel\//))) return 'social_post';

    // Profile
    if (pathname.match(/\/@[\w-]+/)) return 'profile';
    if (pathname.match(/\/user[s]?\/[\w-]+/)) return 'profile';
    if (pathname.match(/\/profile[s]?\/[\w-]+/)) return 'profile';

    // Article/Blog
    if (pathname.match(/\/article[s]?\/[\w-]+/)) return 'article';
    if (pathname.match(/\/post[s]?\/[\w-]+/)) return 'article';
    if (pathname.match(/\/blog\/[\w-]+/)) return 'article';
    if (hostname.includes('medium.com') && pathname.match(/\/@[\w-]+\/[\w-]+/)) return 'article';

    // Product
    if (pathname.match(/\/product[s]?\/[\w-]+/)) return 'product';
    if (pathname.match(/\/item[s]?\/[\w-]+/)) return 'product';
    if (hostname.includes('amazon.') && pathname.match(/\/dp\/[\w-]+/)) return 'product';

    // Document
    if (pathname.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i)) return 'document';

    // Image
    if (pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i)) return 'image';
    if (pathname.includes('/image')) return 'image';

    // Video
    if (hostname.includes('youtube.com') && pathname.match(/\/watch/)) return 'video';
    if (hostname.includes('youtu.be/')) return 'video';
    if (hostname.includes('vimeo.com/')) return 'video';
    if (pathname.match(/\.(mp4|webm|ogg|mov|avi)$/i)) return 'video';

    // Collection
    if (pathname.includes('/playlist')) return 'collection';
    if (pathname.includes('/collection')) return 'collection';

  } catch (error) {
    // Invalid URL, fall through to default
  }

  // Default fallback
  return 'webpage';
}

/**
 * Creates an empty result structure
 */
function createEmptyResult(originUrl: string, finalUrl: string): MetadataResult {
  return {
    originUrl,
    type: 'webpage',
    url: finalUrl,
    title: null,
    description: null,
    image: null,
  };
}
