import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';

// ─── Gemini AI ─────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
// ───────────────────────────────────────────────────────────────────────────

interface SaveUrlPayload {
  url: string;
  title: string;
  timestamp: number;
  domain: string;
  type: string;
  img_url?: string;
  is_extracted_img?: boolean;
  overlay_ratio?: number;
  saved_by?: string; // 'extension' or undefined (for Electron app saves)
  screenshot_base64?: string;
  screenshot_bg_color?: string;
  category?: string;
  confirmed_type?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, '../data/saved-urls.json');
const PORT = 3000;

const app = express();

// Enable CORS for browser extensions
// Extensions make requests from web page origins, so we need to allow cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json({ limit: '4mb' }));

/**
 * Extracts the source (domain) from a URL.
 * Examples:
 * - https://www.google.com/search?q=test → "google"
 * - https://instagram.com/p/abc123 → "instagram"
 * - https://blog.naver.com/user/123 → "naver"
 */
const extractSource = (url: string): string => {
  try {
    // Handle empty URLs
    if (!url || url.trim().length === 0) {
      return 'local';
    }
    
    // Handle data: URLs (for dropped images)
    if (url.startsWith('data:')) {
      return 'local';
    }
    
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();
    
    // Remove www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    
    // Extract main domain (e.g., "blog.naver.com" → "naver", "m.youtube.com" → "youtube")
    const parts = hostname.split('.');
    
    // Handle common subdomains and extract the main domain
    const subdomainPrefixes = ['blog', 'm', 'mobile', 'www', 'mail', 'drive', 'docs', 'maps'];
    
    if (parts.length > 2 && subdomainPrefixes.includes(parts[0])) {
      // For subdomains like blog.naver.com, use the main domain
      return parts.slice(1, -1).join('.'); // Get middle parts (main domain)
    }
    
    // For standard domains like google.com, instagram.com
    // Return everything except the TLD
    if (parts.length >= 2) {
      return parts.slice(0, -1).join('.');
    }
    
    return hostname;
  } catch (error) {
    console.error('Failed to extract source from URL:', url, error);
    return 'unknown';
  }
};

/**
 * Determines the content type based on URL structure.
 * Analyzes path, query parameters, and domain patterns.
 */
const determineType = (url: string): string => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const searchParams = urlObj.searchParams;
    
    // Video content patterns
    if (
      pathname.includes('/watch') ||
      pathname.includes('/video') ||
      pathname.includes('/v/') ||
      pathname.includes('/embed/') ||
      searchParams.has('v') ||
      searchParams.has('video_id')
    ) {
      return 'video';
    }
    
    // Instagram Reels - check before general social_post patterns
    if (urlObj.hostname.includes('instagram.com') && pathname.startsWith('/reel/')) {
      return 'reels';
    }
    
    // Instagram Posts - check before general social_post patterns
    if (urlObj.hostname.includes('instagram.com') && pathname.startsWith('/p/')) {
      return 'instagram_post';
    }
    
    // Image patterns
    if (
      pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) ||
      pathname.includes('/image') ||
      pathname.includes('/photo') ||
      pathname.includes('/picture') ||
      pathname.includes('/img/')
    ) {
      return 'image';
    }
    
    // Social media post patterns (exclude Instagram /p/ since handled above)
    if (
      (urlObj.hostname.includes('pinterest.com') && pathname.startsWith('/pin/')) || // Pinterest pins
      (pathname.match(/\/p\/[^/]+/) && !urlObj.hostname.includes('instagram.com')) || // Other /p/ posts (not Instagram)
      pathname.match(/\/posts?\/[^/]+/) ||
      pathname.match(/\/status\/[^/]+/) || // Twitter/X status
      pathname.match(/\/tweet\/[^/]+/)
    ) {
      return 'social_post';
    }
    
    // Search results
    if (
      pathname.includes('/search') ||
      searchParams.has('q') ||
      searchParams.has('query') ||
      searchParams.has('search')
    ) {
      return 'search';
    }
    
    // Article/Blog post patterns
    if (
      pathname.match(/\/article[s]?\/[^/]+/) ||
      pathname.match(/\/post[s]?\/[^/]+/) ||
      pathname.match(/\/blog\/[^/]+/) ||
      pathname.match(/\/entry\/[^/]+/) ||
      pathname.match(/\/[0-9]{4}\/[0-9]{2}\/[^/]+/) // Date-based blog URLs
    ) {
      return 'article';
    }
    
    // Product/E-commerce patterns
    if (
      pathname.includes('/product') ||
      pathname.includes('/item') ||
      pathname.includes('/p/') && !pathname.includes('/p/') && urlObj.hostname.includes('shop') ||
      searchParams.has('product_id') ||
      searchParams.has('item_id')
    ) {
      return 'product';
    }
    
    // Profile/User page patterns
    if (
      pathname.match(/\/@[^/]+/) || // Twitter/Instagram handles
      pathname.match(/\/user[s]?\/[^/]+/) ||
      pathname.match(/\/profile[s]?\/[^/]+/) ||
      pathname.match(/\/people\/[^/]+/)
    ) {
      return 'profile';
    }
    
    // PDF/document patterns
    if (
      pathname.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i) ||
      pathname.includes('/document') ||
      pathname.includes('/file/')
    ) {
      return 'document';
    }
    
    // Playlist/Collection patterns
    if (
      pathname.includes('/playlist') ||
      pathname.includes('/collection') ||
      pathname.includes('/list/')
    ) {
      return 'collection';
    }
    
    // Default to 'webpage' for generic pages
    return 'webpage';
  } catch (error) {
    console.error('Failed to determine type from URL:', url, error);
    return 'webpage';
  }
};

const ensureDataFile = async () => {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      await fs.writeFile(DATA_FILE, '[]', 'utf-8');
    } else {
      throw err;
    }
  }
};

/**
 * Forwards save request to Electron app's Firestore save endpoint
 * Returns true if successful, false if Electron app is not available
 */
const forwardToElectronApp = async (payload: any): Promise<{ success: boolean; result?: any }> => {
  try {
    const response = await fetch('http://localhost:3002/save-to-firestore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      // Timeout after 2 seconds
      signal: AbortSignal.timeout(2000),
    });

    if (response.ok) {
      const result = await response.json();
      return { success: true, result };
    } else {
      const errorData = await response.json();
      console.log('Electron app returned error:', errorData);
      return { success: false };
    }
  } catch (error: any) {
    // Electron app is not available or connection failed
    if (error.name === 'AbortError' || error.code === 'ECONNREFUSED') {
      return { success: false };
    }
    console.error('Error forwarding to Electron app:', error);
    return { success: false };
  }
};

type ItemCategory = 'SNS' | 'Mail' | 'Contents' | 'Page';

function getBaseDomainForCategory(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.replace(/^www\./, '').split('.');
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

/**
 * Code-based category and type detection. No AI. Returns category and optionally
 * confirmedType when the category alone determines the exact type.
 */
function detectCategoryAndType(
  savedUrl: string,
  pageUrl: string | undefined,
  htmlContext: Record<string, any> | undefined
): { category: ItemCategory; platform: string; confirmedType: string } {
  try {
    const u = new URL(savedUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // ── Helper: dominant media type ───────────────────────────────────────────
    function getDominantMediaType(): 'Video' | 'Image' | '' {
      if (!htmlContext) return '';
      try {
        const coreWidth  = Number(htmlContext?.boundingBox?.width)  || 0;
        const coreHeight = Number(htmlContext?.boundingBox?.height) || 0;
        if (coreWidth <= 0 || coreHeight <= 0) return '';
        const mediaItems = [
          ...(Array.isArray(htmlContext.images) ? htmlContext.images : []),
          ...(Array.isArray(htmlContext.videos) ? htmlContext.videos : []),
        ];
        for (const media of mediaItems) {
          const mw = Number(media?.width)  || 0;
          const mh = Number(media?.height) || 0;
          if (mw <= 0 || mh <= 0) continue;
          const widthRatio  = mw / coreWidth;
          const heightRatio = mh / coreHeight;
          if (
            (widthRatio >= 0.75 && heightRatio >= 0.4) ||
            (heightRatio >= 0.75 && widthRatio >= 0.4)
          ) {
            const isDominantVideo = Array.isArray(htmlContext.videos) &&
              htmlContext.videos.some((v: any) => {
                const vw = Number(v?.width)  || 0;
                const vh = Number(v?.height) || 0;
                const wr = vw / coreWidth;
                const hr = vh / coreHeight;
                return (wr >= 0.75 && hr >= 0.4) || (hr >= 0.75 && wr >= 0.4);
              });
            return isDominantVideo ? 'Video' : 'Image';
          }
        }
      } catch { /* ignore */ }
      return '';
    }

    function getPageDomain(): string {
      return pageUrl ? getBaseDomainForCategory(pageUrl) : '';
    }

    // Returns true if pageUrl is a search engine domain but NOT a search results page.
    // In this case dominant media check should be suppressed — items on search engine
    // home/non-search pages (e.g. google.com main, naver.com main) are not real Contents.
    function isSearchEngineNonSearchPage(): boolean {
      if (!pageUrl) return false;
      try {
        const ph = new URL(pageUrl).hostname.toLowerCase();
        const pp = new URL(pageUrl).pathname.toLowerCase();
        const ps = new URL(pageUrl).search.toLowerCase();

        // Google: search results → /search?q=...
        if (ph.includes('google.com')) {
          return !(pp.startsWith('/search') && ps.includes('q='));
        }
        // Naver: search results → search.naver.com/...
        if (ph === 'search.naver.com') return false; // IS a search page
        if (ph.includes('naver.com')) return true; // naver.com but not search subdomain

        // Bing: search results → /search?q=...
        if (ph.includes('bing.com')) {
          return !(pp.startsWith('/search') && ps.includes('q='));
        }
        // DuckDuckGo: search results → duckduckgo.com/?q=...
        if (ph.includes('duckduckgo.com')) {
          return !ps.includes('q=');
        }
        // Yahoo Search: search results → search.yahoo.com/search?...
        if (ph.includes('yahoo.com')) {
          return !(ph.startsWith('search.') && pp.startsWith('/search'));
        }
        // Daum: search results → search.daum.net/search?...
        if (ph.includes('daum.net')) {
          return !(ph.startsWith('search.') && pp.startsWith('/search'));
        }
        // Baidu: search results → baidu.com/s?...
        if (ph.includes('baidu.com')) {
          return !(pp === '/s' || pp.startsWith('/s?') || ps.includes('wd='));
        }
        // Yandex: search results → yandex.com/search/...
        if (ph.includes('yandex.com') || ph.includes('yandex.ru')) {
          return !pp.startsWith('/search');
        }
      } catch {
        /* ignore */
      }
      return false;
    }

    // ── Step 1: SNS ───────────────────────────────────────────────────────────
    let snsPlatform = '';
    if (host.includes('instagram.com')) {
      snsPlatform = 'Instagram';
    } else if (host.includes('x.com') || host.includes('twitter.com')) {
      snsPlatform = 'X';
    } else if (host.includes('threads.net')) {
      snsPlatform = 'Threads';
    } else if (
      host.includes('linkedin.com') &&
      (path.startsWith('/posts/') || path.includes('/feed/update/') || path.startsWith('/in/'))
    ) {
      snsPlatform = 'LinkedIn';
    } else if (host.includes('facebook.com') && !!htmlContext) {
      snsPlatform = 'Facebook';
    } else if (host.includes('tiktok.com')) {
      snsPlatform = 'TikTok';
    } else if (host.includes('reddit.com') && (path.includes('/r/') || path.includes('/user/'))) {
      snsPlatform = 'Reddit';
    }

    if (snsPlatform) {
      const dominantType = getDominantMediaType();
      if (dominantType) {
        return { category: 'SNS', platform: snsPlatform, confirmedType: dominantType };
      }
      let snsConfirmedType = 'Page';
      if (snsPlatform === 'LinkedIn' || snsPlatform === 'Facebook') {
        snsConfirmedType = 'Post';
      } else if (snsPlatform === 'Instagram') {
        if (path.includes('/p/') || path.includes('/reel/')) snsConfirmedType = 'Post';
      } else if (snsPlatform === 'X') {
        if (path.includes('/status/')) snsConfirmedType = 'Post';
      } else if (snsPlatform === 'Threads') {
        if (path.includes('/post/')) snsConfirmedType = 'Post';
      } else if (snsPlatform === 'TikTok') {
        if (path.includes('/video/')) snsConfirmedType = 'Post';
      } else if (snsPlatform === 'Reddit') {
        if (path.includes('/comments/')) snsConfirmedType = 'Post';
      }
      return { category: 'SNS', platform: snsPlatform, confirmedType: snsConfirmedType };
    }

    // ── Step 2: Mail ──────────────────────────────────────────────────────────
    // Only classify as Mail when the savedUrl points to an actual email thread.
    // Folder/label pages (inbox list) are classified as Page instead.
    const savedHostParts = host.split('.');
    if (savedHostParts[0] === 'mail') {
      const baseDomain = getBaseDomainForCategory(savedUrl);

      // Gmail: real email thread → hash contains two segments: #{label}/{id}
      if (baseDomain === 'google.com') {
        try {
          const gmailHash = new URL(savedUrl).hash || '';
          const gmailParts = gmailHash.replace(/^#/, '').split('/').filter(Boolean);
          if (gmailParts.length < 2) {
            return { category: 'Page', platform: 'google', confirmedType: '' };
          }
        } catch { /* ignore */ }
        return { category: 'Mail', platform: 'Gmail', confirmedType: '' };
      }

      // Naver Mail: folder page → /v2/folders/{id} → Page
      if (baseDomain === 'naver.com') {
        try {
          const naverPath = new URL(savedUrl).pathname.toLowerCase();
          if (naverPath.startsWith('/v2/folders/')) {
            return { category: 'Page', platform: 'naver', confirmedType: '' };
          }
        } catch { /* ignore */ }
        return { category: 'Mail', platform: 'Naver', confirmedType: '' };
      }

      const mailPlatform = baseDomain === 'google.com' ? 'Gmail'
        : baseDomain === 'naver.com' ? 'Naver'
        : 'Other';
      return { category: 'Mail', platform: mailPlatform, confirmedType: '' };
    }

    // ── Step 2.5: Unconditional Video hosts ───────────────────────────────────
    if (
      (host.includes('youtube.com') && (path.includes('/watch') || path.includes('/shorts/'))) ||
      host.includes('youtu.be') ||
      host.includes('vimeo.com') ||
      host.includes('twitch.tv')
    ) {
      return { category: 'Contents', platform: getBaseDomainForCategory(savedUrl), confirmedType: 'Video' };
    }

    // ── Step 3: Dominant media check (non-SNS) ────────────────────────────────
    // Skip dominant media check when pageUrl is a search engine non-search page
    // (e.g. google.com homepage) — items there are ads/products, not real Contents.
    const dominantType = isSearchEngineNonSearchPage() ? '' : getDominantMediaType();
    if (dominantType) {
      if (dominantType === 'Video') {
        return { category: 'Contents', platform: getBaseDomainForCategory(savedUrl), confirmedType: 'Video' };
      }
      return { category: 'Contents', platform: getPageDomain(), confirmedType: 'Image' };
    }

    // ── Step 4: Same-origin URL-based ─────────────────────────────────────────
    const savedDomain = getBaseDomainForCategory(savedUrl);
    const pageDomain  = pageUrl ? getBaseDomainForCategory(pageUrl) : '';
    const sameOrigin  = !!savedDomain && !!pageDomain && savedDomain === pageDomain;

    if (sameOrigin) {
      if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(path))
        return { category: 'Contents', platform: getPageDomain(), confirmedType: 'Image' };
      if (/\.(mp4|webm)$/i.test(path))
        return { category: 'Contents', platform: savedDomain, confirmedType: 'Video' };
      if (
        (host.includes('youtube.com') && (path.includes('/watch') || path.includes('/shorts/'))) ||
        host.includes('youtu.be') ||
        host.includes('vimeo.com') ||
        host.includes('twitch.tv')
      ) return { category: 'Contents', platform: savedDomain, confirmedType: 'Video' };
    }

    // ── Step 5: Weighted scoring ──────────────────────────────────────────────
    // Skip scoring-based Contents classification on search engine non-search pages.
    if (!isSearchEngineNonSearchPage()) {
      let score = 0;
      const mediaRatio = Number(htmlContext?.mediaRatio) || 0;
      if (mediaRatio > 0.7) score += 70;
      else if (mediaRatio > 0.5) score += 40;
      const videoCount = Number(htmlContext?.videoCount) || 0;
      if (videoCount > 0) score += 50;
      const imageCount = Number(htmlContext?.imageCount) || 0;
      if (imageCount + videoCount === 1) score += 30;
      if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm)$/i.test(path)) score += 20;
      if (
        (host.includes('youtube.com') && (path.includes('/watch') || path.includes('/shorts/'))) ||
        host.includes('youtu.be') ||
        host.includes('vimeo.com') ||
        host.includes('twitch.tv')
      ) score += 20;
      if (imageCount + videoCount > 2) score -= 30;
      if (score >= 100) {
        if (videoCount > 0) {
          return { category: 'Contents', platform: getBaseDomainForCategory(savedUrl), confirmedType: 'Video' };
        }
        return { category: 'Contents', platform: getPageDomain(), confirmedType: 'Image' };
      }
    }

    // ── Step 6: Default ───────────────────────────────────────────────────────
    return { category: 'Page', platform: getBaseDomainForCategory(savedUrl), confirmedType: '' };
  } catch {
    return { category: 'Page', platform: '', confirmedType: '' };
  }
}

/**
 * Calls Gemini API with the given prompt and returns the raw text response.
 * Throws on non-ok response.
 */
async function callGemini(prompt: string): Promise<string> {
  const response = await fetch(
    `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    } as any
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText.substring(0, 100)}`);
  }

  const data = await response.json() as any;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * Crawls the given URL with Puppeteer and returns the page's text content.
 * Extracts title, meta description, and body text (JS-rendered).
 * Returns null if crawling fails.
 */
async function crawlPageContent(url: string): Promise<{ title: string; text: string } | null> {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(() => {
      // Remove noise elements
      ['script', 'style', 'nav', 'header', 'footer', 'iframe', 'noscript'].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => el.remove());
      });

      const title = document.title || '';
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';
      const bodyText = (document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 4000);

      return { title, text: `${metaDesc}\n\n${bodyText}`.trim() };
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Crawl] Failed for', url.substring(0, 60), '|', msg);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Fetches a Gmail thread's subject and body text using the Gmail API.
 * Requires a valid OAuth access token with gmail.readonly scope.
 * Returns { title, text } or null on failure.
 */
async function fetchGmailThreadContent(
  gmailUrl: string,
  accessToken: string
): Promise<{ title: string; text: string } | null> {
  try {
    // Extract thread ID from URL fragment: #inbox/THREAD_ID or #all/THREAD_ID etc.
    const fragmentMatch = gmailUrl.match(/#[^/]+\/([A-Za-z0-9]+)/);
    if (!fragmentMatch?.[1]) {
      console.warn('[Gmail] Could not extract thread ID from URL:', gmailUrl.substring(0, 80));
      return null;
    }
    const threadId = fragmentMatch[1];

    // Fetch thread metadata (includes messages list)
    const threadRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      } as any
    );

    if (!threadRes.ok) {
      const errText = await threadRes.text().catch(() => '');
      console.warn('[Gmail] API error:', threadRes.status, errText.substring(0, 100));
      return null;
    }

    const threadData = await threadRes.json() as any;
    const messages: any[] = threadData?.messages || [];
    if (messages.length === 0) return null;

    // Extract subject from first message headers
    const firstHeaders: any[] = messages[0]?.payload?.headers || [];
    const subject = firstHeaders.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '(No subject)';
    const from    = firstHeaders.find((h: any) => h.name?.toLowerCase() === 'from')?.value    || '';
    const date    = firstHeaders.find((h: any) => h.name?.toLowerCase() === 'date')?.value    || '';

    // Extract body text from all messages (plain text preferred)
    const extractBody = (payload: any): string => {
      if (!payload) return '';
      // Direct plain text part
      if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
      }
      // Recurse into parts
      if (Array.isArray(payload.parts)) {
        for (const part of payload.parts) {
          const text = extractBody(part);
          if (text) return text;
        }
      }
      return '';
    };

    const bodies = messages
      .map((msg: any) => extractBody(msg.payload))
      .filter(Boolean)
      .join('\n\n---\n\n')
      .substring(0, 4000);

    const text = [
      from   ? `From: ${from}`    : '',
      date   ? `Date: ${date}`    : '',
      bodies ? `\n${bodies}`      : '',
    ].filter(Boolean).join('\n');

    console.log('[Gmail] ✅ Thread content fetched');
    return { title: subject, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Gmail] fetchGmailThreadContent error:', msg);
    return null;
  }
}

/**
 * Crawls a Naver Mail page using injected login cookies from the browser.
 * Uses networkidle2 to wait for dynamic content to fully render.
 * Returns { title, text } or null on failure.
 */
async function crawlNaverMailContent(
  url: string,
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
  }>
): Promise<{ title: string; text: string } | null> {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Inject Naver login cookies
    for (const cookie of cookies) {
      try {
        await page.setCookie({
          name:     cookie.name,
          value:    cookie.value,
          domain:   cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`,
          path:     cookie.path || '/',
          secure:   cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: (cookie.sameSite as any) || 'Lax',
        });
      } catch { /* skip invalid cookie */ }
    }

    // Use networkidle2 to wait for dynamic mail content to render
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    const result = await page.evaluate(() => {
      ['script', 'style', 'nav', 'header', 'footer', 'iframe', 'noscript'].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => el.remove());
      });

      const title = document.title || '';
      const bodyText = (document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 4000);

      return { title, text: bodyText };
    });

    if (!result.text || result.text.trim().length < 30) {
      console.warn('[NaverMail] Page rendered but content too short — may not be logged in');
      return null;
    }

    console.log('[NaverMail] ✅ Mail content fetched');
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[NaverMail] Crawl failed:', msg);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Detects if a URL is a search engine results page.
 * Returns { engine, query } if matched, or null otherwise.
 */
function detectSearchUrl(url: string): { engine: string; query: string } | null {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, '');

    if (hostname === 'google.com' && u.pathname === '/search') {
      const q = u.searchParams.get('q');
      if (q) return { engine: 'Google', query: q };
    }
    if (hostname === 'search.naver.com' && u.pathname.startsWith('/search.naver')) {
      const q = u.searchParams.get('query');
      if (q) return { engine: 'Naver', query: q };
    }
    if (hostname === 'bing.com' && u.pathname === '/search') {
      const q = u.searchParams.get('q');
      if (q) return { engine: 'Bing', query: q };
    }
    if (hostname === 'youtube.com' && u.pathname === '/results') {
      const q = u.searchParams.get('search_query');
      if (q) return { engine: 'YouTube', query: q };
    }
    if (hostname === 'duckduckgo.com') {
      const q = u.searchParams.get('q');
      if (q) return { engine: 'DuckDuckGo', query: q };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Crawls the given URL, calls Gemini Function Calling to analyze the content,
 * and updates the Firestore document with ai_* fields.
 * Runs fire-and-forget — caller does not await.
 */
async function analyzeAndUpdateDocument(
  docPath: string,
  url: string,
  userLanguage?: string,
  gmailToken?: string,
  naverCookies?: Array<Record<string, any>>
): Promise<void> {
  if (!GEMINI_API_KEY) {
    console.warn('[AI] GEMINI_API_KEY not set — skipping analysis');
    return;
  }
  if (!url || !url.trim()) return;

  try {
    const isGmailUrl = url.trim().startsWith('https://mail.google.com/');
    if (isGmailUrl && !gmailToken) {
      console.warn('[AI] Gmail URL but no token received — skipping analysis');
      return;
    }

    // Naver Mail: use cookie-injected Puppeteer crawl
    const isNaverMailUrl = url.trim().startsWith('https://mail.naver.com/');
    if (isNaverMailUrl && !naverCookies?.length) {
      console.warn('[AI] Naver Mail URL but no cookies received — skipping analysis');
      return;
    }

    // Search engine results page — skip crawl, write directly to Firestore
    const searchInfo = detectSearchUrl(url.trim());
    if (searchInfo) {
      const db = getFirestore();
      await db.doc(docPath).update({
        ai_title:             `${searchInfo.engine} Search: ${searchInfo.query}`,
        ai_key_points:        [],
        ai_keywords:          [searchInfo.query],
        ai_content_type:      'Search',
        ai_content_resource:  searchInfo.engine,
        ai_subject_type:      '',
        ai_content_category:  [],
        ai_content_topic:     [],
      });
      console.log('[AI] ✅ Search URL processed:', searchInfo.engine, '|', searchInfo.query);
      return;
    }

    const crawled = isGmailUrl && gmailToken
      ? await fetchGmailThreadContent(url.trim(), gmailToken)
      : isNaverMailUrl && naverCookies?.length
        ? await crawlNaverMailContent(url.trim(), naverCookies as any)
        : await crawlPageContent(url.trim());
    if (!crawled) {
      console.warn('[AI] Crawl failed for:', url.substring(0, 60));
      return;
    }

    const langCode = ((userLanguage || 'en').split('-')[0]).toLowerCase();
    const langMap: Record<string, string> = {
      ko: 'Korean', ja: 'Japanese', zh: 'Chinese', fr: 'French',
      de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    };
    const outputLanguage = langMap[langCode] || 'English';

    const tools = [
      {
        functionDeclarations: [
          {
            name: 'analyze_page_content',
            description: 'Analyzes the text content of a web page and returns structured insights.',
            parameters: {
              type: 'OBJECT',
              properties: {
                title: {
                  type: 'STRING',
                  description: 'The main title or topic of the page content.',
                },
                key_points: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '3 to 5 key points or highlights from the content.',
                },
                keywords: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '4 to 6 keywords or topic tags that describe the content.',
                },
                content_type: {
                  type: 'STRING',
                  description: `What kind of content this is. Choose the best match:
- Article: written content meant to be read (blog posts, essays, guides, reviews, interviews, tutorials, opinions, comparisons, recommendations, case studies)
- SNS Post: a post published on a social media platform (Instagram, X, LinkedIn, Facebook, Threads, TikTok, Pinterest, Reddit, etc.)
- News: journalism or press content reporting on current events
- Video: video content on any platform (YouTube, Vimeo, TikTok, etc.)
- Image: a standalone image (photo, illustration, infographic, meme, design, screenshot)
- Website: an official web presence whose purpose is to introduce or describe an entity — company, organization, government, school, etc.
- Product: a physical/tangible item for purchase (electronics, fashion, food, furniture, books, etc.)
- Tool: a software or digital service that users directly interact with and use. ONLY use Tool if the page IS the actual service interface or its official landing page where you sign up / start using it. Do NOT use Tool for a page that merely describes a company that makes software.
- Platform: a digital ecosystem or marketplace that hosts other content or services (shopping platforms, video platforms, app stores, etc.)
- Community: an online gathering space for people with shared interests (forums, Discord servers, Naver Cafe, Reddit communities, etc.)
- Mail: an email message (newsletter, notification, promotion, personal, work, receipt)
- Repository: a code or model repository (GitHub, HuggingFace, etc.)
- Document: a file-based document (PDF, spreadsheet, presentation, etc.)
- Profile: a page on a third-party platform that presents a specific person or company as a listed entity. Examples: Instagram user profile, LinkedIn company page, GitHub user page, YCombinator company listing, Product Hunt page, Crunchbase entry. Key signal: the URL contains a username/slug within a platform that lists many such entities.
- Travel & Events: flight tickets, accommodation, event tickets, gift cards, and related booking pages
- Maps & Location: map pages and location/place information pages (Google Maps, Naver Map, Kakao Map, etc.)
- Search: a search engine results page (Google, Naver, Bing, YouTube, DuckDuckGo)
If none fits, generate a concise label of your own.`,
                },
                content_resource: {
                  type: 'STRING',
                  description: `The source platform or provider of this content. Rules per content_type:
- Article: the publication or website name (e.g. Naver, Medium, Brunch, TechCrunch)
- SNS Post: the social platform (e.g. Instagram, X, LinkedIn, Facebook, Threads, TikTok, Pinterest, Reddit)
- News: the news outlet name (e.g. NY Times, BBC, Yonhap, TechCrunch)
- Video: the video platform (e.g. YouTube, Vimeo, TikTok)
- Image: the platform where the image was found (e.g. Pinterest, Google Images, Unsplash)
- Website: leave empty
- Product: the shopping platform or store (e.g. Amazon, Coupang, eBay)
- Tool: leave empty — tools are self-hosted
- Platform: leave empty — platforms are self-hosted
- Community: the community platform (e.g. Reddit, Discord, Naver Cafe, DC Inside)
- Mail: the mail platform (e.g. Gmail, Naver Mail, Outlook)
- Repository: the repository platform (e.g. GitHub, HuggingFace, GitLab)
- Document: leave empty
- Profile: the platform hosting the profile (e.g. Instagram, LinkedIn, YCombinator)
- Travel & Events: the booking platform (e.g. Expedia, Airbnb, Interpark, Kyobo)
- Maps & Location: the map platform (e.g. Google, Naver, Kakao)
- Search: leave empty
If the source cannot be determined, leave empty.`,
                },
                subject_type: {
                  type: 'STRING',
                  description: `Only applicable for specific content_types. Leave empty for all others.
- Profile: whether the profile subject is a person or a company → Person | Company
- Community: the primary audience or member type of the community → Developer | Designer | Investor | Entrepreneur | Student | Parent | Gamer | Creator | Office Worker. If none fits, generate a concise label.
- Travel & Events: the type of booking or event → Flight | Accommodation | Ticket | Gift Card. If none fits, generate a concise label.
- All other content_types: leave empty.`,
                },
                content_category: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: `1 to 2 category tags describing the content domain. Rules per content_type:
- Article / SNS Post / News / Video / Website / Community / Profile:
  Choose 1–2 from: Film & Animation & Drama | Music & Art | Gaming | Current Affairs & Culture | Autos & Vehicles | Pets & Animals | Sports & Outdoors | Healthcare & Medical | Travel & Events | People & Living | Beauty & Style | Education & Lecture | News & Politics | Science & Tech | Nonprofits & Activism | Finance & Insurance | Real Estate | Transportation & Weather | Comedy & Meme & Gossip | Economy & Business. If none fits, generate a concise label.
- Product:
  Choose 1–2 from: Electronics | Fashion | Beauty | Food & Drink | Home & Living | Sports & Outdoors | Books | Toys & Hobbies | Autos & Vehicles. If none fits, generate a concise label.
- Tool:
  Choose 1–2 from: Productivity | Design | Communication | Development | Marketing & Sales | Finance | AI | Entertainment. If none fits, generate a concise label.
- Platform:
  Choose 1–2 from: Shopping | Video | Music | Image | News & Media | Development | Art & Design | Education & Lecture | Finance | Travel & Events | Food & Drink. If none fits, generate a concise label.
- Mail:
  Choose 1 from: Newsletter | Notification | Promotion | Personal | Work | Receipt. If none fits, generate a concise label.
- Repository:
  Choose 1–2 from: Model | Dataset | Library | Framework | App | Template. If none fits, generate a concise label.
- Document:
  Choose 1 from: PDF | Spreadsheet | Presentation | Word. If none fits, generate a concise label.
- Maps & Location:
  Generate a concise label for the type of place (e.g. Restaurant, Shopping Mall, Hospital, Park, Hotel).
- Travel & Events: use the same list as Article above, choosing the most relevant category.
- Image: leave empty — use content_topic instead.
- Search: leave empty.`,
                },
                content_topic: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: `1 to 2 keywords describing the specific subject or purpose of the content. Only applicable for specific content_types. Leave empty for all others.
- Article / SNS Post:
  Choose 1–2 from: Opinion & Review | Recommendation | Comparison | How-to & Tutorial | Analysis & Essay | Interview & Podcast | Inform. If none fits, generate a concise label.
- News:
  Choose 1–2 from: Recommendation | Comparison | How-to & Tutorial | Analysis & Essay | Interview & Podcast | Inform. If none fits, generate a concise label.
- Video:
  Choose 1–2 from: Opinion & Review | Recommendation | Comparison | How-to & Tutorial | Analysis & Essay | Interview & Podcast | Inform | Contents | Live Stream & Reaction | Promotion | Documentary & Vlog. If none fits, generate a concise label.
- Image:
  Generate 1–2 concise keywords describing what is depicted in the image (e.g. "Mountain Landscape", "UI Design", "Cat", "Portrait").
- All other content_types: leave empty (return empty array).
IMPORTANT: each item must be a short keyword or phrase (1–4 words), never a full sentence.`,
                },
              },
              required: ['title', 'key_points', 'keywords', 'content_type', 'content_resource', 'subject_type', 'content_category', 'content_topic'],
            },
          },
        ],
      },
    ];

    const prompt = `You are analyzing the content of a web page and labeling it with a structured taxonomy.
URL: ${url}
Page title: ${crawled.title}
Page content:
${crawled.text}

Call the analyze_page_content function with your analysis.
Write title, key_points in ${outputLanguage}.
Keywords should be concise single words or short phrases.
content_resource, subject_type must be left empty when the rules say so.
content_category and content_topic must each be arrays of 1–2 short keyword phrases (never full sentences); return empty arrays when the rules say so.`;

    const response = await fetch(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools,
          generationConfig: { temperature: 0.2 },
        }),
      } as any
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini error ${response.status}: ${errText.substring(0, 100)}`);
    }

    const data = await response.json() as any;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const functionCallPart = parts.find((p: any) => p.functionCall?.name === 'analyze_page_content');
    if (!functionCallPart) {
      console.warn('[AI] No function call in Gemini response for:', url.substring(0, 60));
      return;
    }

    let rawArgs = functionCallPart.functionCall.args as unknown;
    if (typeof rawArgs === 'string') {
      try { rawArgs = JSON.parse(rawArgs); } catch { return; }
    }
    const args = rawArgs as {
      title?: string;
      key_points?: string[];
      keywords?: string[];
      content_type?: string;
      content_resource?: string;
      subject_type?: string;
      content_category?: string[];
      content_topic?: string[];
    };

    const db = getFirestore();
    await db.doc(docPath).update({
      ai_title:             args.title              || crawled.title,
      ai_key_points:        Array.isArray(args.key_points)       ? args.key_points       : [],
      ai_keywords:          Array.isArray(args.keywords)         ? args.keywords         : [],
      ai_content_type:      args.content_type       || '',
      ai_content_resource:  args.content_resource   || '',
      ai_subject_type:      args.subject_type       || '',
      ai_content_category:  Array.isArray(args.content_category) ? args.content_category : [],
      ai_content_topic:     Array.isArray(args.content_topic)    ? args.content_topic    : [],
    });

    console.log('[AI] ✅ Analysis saved to Firestore:', docPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[AI] ❌ analyzeAndUpdateDocument failed for:', url.substring(0, 60), '|', msg);
  }
}

function getFirestore() {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  return admin.firestore();
}

function getStorage() {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || '';
  return bucketName
    ? admin.storage().bucket(bucketName)
    : admin.storage().bucket();
}

async function uploadScreenshotToStorage(
  base64DataUrl: string,
  userId: string,
  itemId: string
): Promise<{ publicUrl: string } | null> {
  try {
    const matches = base64DataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return null;
    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const filePath = `screenshots/${userId}/${itemId}.${ext}`;
    const bucket = getStorage();
    const file = bucket.file(filePath);

    await file.save(buffer, {
      metadata: { contentType: mimeType },
    });
    try {
      await file.makePublic();
    } catch {
      /* uniform bucket-level access or policy may disallow ACL */
    }

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    return { publicUrl };
  } catch (e) {
    return null;
  }
}

// ── Firestore: Move item to position ─────────────────────────────────────
app.post('/api/v1/firestore/move-item', async (req: Request, res: Response) => {
  try {
    const { userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId } =
      req.body as {
        userId: string;
        itemId: string;
        targetDirectoryId: string | null;
        newIndex: number;
        sourceDirectoryId: string | null;
      };

    if (!userId || !itemId || newIndex == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Normalize directory IDs: null → "undefined" (matches existing convention)
    const targetDirFilter = targetDirectoryId == null ? 'undefined' : targetDirectoryId;
    const sourceDirFilter = sourceDirectoryId == null ? 'undefined' : sourceDirectoryId;

    const db = getFirestore();
    const itemsRef = db.collection(`users/${userId}/items`);

    // Fetch all items in target directory
    let targetSnap;
    try {
      targetSnap = await itemsRef
        .where('directoryId', '==', targetDirFilter)
        .orderBy('order', 'asc')
        .get();
    } catch {
      targetSnap = await itemsRef
        .where('directoryId', '==', targetDirFilter)
        .orderBy('createdAt', 'desc')
        .get();
    }

    // Fetch dragged item
    const draggedRef = itemsRef.doc(itemId);
    const draggedSnap = await draggedRef.get();
    if (!draggedSnap.exists) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const targetItems = targetSnap.docs
      .filter((d) => d.id !== itemId)
      .map((d) => ({ id: d.id, ref: d.ref }));

    // Insert dragged item at newIndex
    const clampedIndex = Math.max(0, Math.min(newIndex, targetItems.length));
    targetItems.splice(clampedIndex, 0, { id: itemId, ref: draggedRef });

    // Batch write
    const batch = db.batch();
    if (targetDirFilter !== sourceDirFilter) {
      batch.update(draggedRef, { directoryId: targetDirFilter });
    }
    targetItems.forEach(({ ref }, index) => {
      batch.update(ref, { order: index });
    });
    await batch.commit();

    return res.status(200).json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Firestore] move-item error:', msg);
    return res.status(500).json({ error: msg });
  }
});

// ── Firestore: Move directory to position ────────────────────────────────
app.post('/api/v1/firestore/move-directory', async (req: Request, res: Response) => {
  try {
    const { userId, directoryId, newIndex } = req.body as {
      userId: string;
      directoryId: string;
      newIndex: number;
    };

    if (!userId || !directoryId || newIndex == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = getFirestore();
    const dirsRef = db.collection(`users/${userId}/directories`);

    // Fetch all directories
    let dirsSnap;
    try {
      dirsSnap = await dirsRef.orderBy('order', 'asc').get();
    } catch {
      dirsSnap = await dirsRef.orderBy('createdAt', 'asc').get();
    }

    const dirs = dirsSnap.docs
      .filter((d) => d.id !== directoryId)
      .map((d) => ({ id: d.id, ref: d.ref }));

    const draggedRef = dirsRef.doc(directoryId);
    const draggedSnap = await draggedRef.get();
    if (!draggedSnap.exists) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const clampedIndex = Math.max(0, Math.min(newIndex, dirs.length));
    dirs.splice(clampedIndex, 0, { id: directoryId, ref: draggedRef });

    const batch = db.batch();
    dirs.forEach(({ ref }, index) => {
      batch.update(ref, { order: index });
    });
    await batch.commit();

    return res.status(200).json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Firestore] move-directory error:', msg);
    return res.status(500).json({ error: msg });
  }
});

app.post('/api/v1/save-url', async (req: Request, res: Response) => {
  const {
    url,
    title,
    timestamp,
    img_url,
    saved_by,
    type,
    screenshot_base64,
    screenshot_bg_color,
    category,
    confirmed_type,
    page_save,
  } = req.body as Omit<SaveUrlPayload, 'domain'> & {
    img_url?: string;
    saved_by?: string;
    type?: string; // Type from extension (e.g., 'instagram_post')
    screenshot_base64?: string;
    screenshot_bg_color?: string;
    category?: string;
    confirmed_type?: string;
    page_save?: boolean;
  };

  const isValidString = (value: unknown) =>
    typeof value === 'string' && value.trim().length > 0;
  const isValidStringOrEmpty = (value: unknown) =>
    typeof value === 'string'; // Allow empty strings
  const isValidTimestamp = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value);

  // Allow empty URL if img_url is present (for dropped images)
  const urlValidation = img_url ? isValidStringOrEmpty(url) : isValidString(url);
  
  if (!urlValidation || !isValidString(title) || !isValidTimestamp(timestamp)) {
    console.log('Validation failed:', { url: url?.substring(0, 50), title, timestamp, img_url: img_url ? 'present' : 'missing' });
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Use img_url from payload directly — OG image fetch is done in background after save
  const resolvedImgUrl = img_url ? img_url.trim() : '';

  // Prepare payload for forwarding (will add domain later, but preserve type from extension)
  const clientCategoryRaw      = typeof category === 'string' ? category.trim() : '';
  const isPageCategory         = clientCategoryRaw === 'Page';
  const clientPlatformRaw      = typeof (req.body as any).platform === 'string'
    ? (req.body as any).platform.trim() : '';
  const clientConfirmedTypeRaw = typeof confirmed_type === 'string' ? confirmed_type.trim() : '';
  const isSnsPageCategory = clientCategoryRaw === 'SNS' &&
    clientConfirmedTypeRaw === 'Page';
  const clientSenderRaw        = typeof (req.body as any).sender === 'string'
    ? (req.body as any).sender.trim() : '';
  const clientPageDescriptionRaw =
    typeof (req.body as any).page_description === 'string'
      ? (req.body as any).page_description.trim()
      : '';
  const clientIsPortraitRaw =
    typeof (req.body as any).is_portrait === 'boolean'
      ? (req.body as any).is_portrait
      : false;
  const clientImgUrlMethodRaw =
    typeof (req.body as any).img_url_method === 'string' &&
    ['screenshot', 'extracted', 'favicon'].includes((req.body as any).img_url_method)
      ? (req.body as any).img_url_method as string
      : '';
  const clientScreenshotPaddingRaw = typeof (req.body as any).screenshot_padding === 'number'
    ? (req.body as any).screenshot_padding : 0;
  const clientIsExtractedImgRaw = typeof (req.body as any).is_extracted_img === 'boolean'
    ? (req.body as any).is_extracted_img : undefined;
  const clientOverlayRatioRaw = typeof (req.body as any).overlay_ratio === 'number'
    ? (req.body as any).overlay_ratio : undefined;
  const isPortraitExtracted =
    isPageCategory &&
    clientIsExtractedImgRaw === true &&
    typeof clientOverlayRatioRaw === 'number' &&
    Number.isFinite(clientOverlayRatioRaw) &&
    clientOverlayRatioRaw < 1.2;
  const gmailTokenRaw = typeof (req.body as any).gmail_token === 'string'
    ? (req.body as any).gmail_token.trim()
    : '';
  const naverCookiesRaw = Array.isArray((req.body as any).naver_cookies)
    ? ((req.body as any).naver_cookies as Array<Record<string, any>>)
    : undefined;

  const rawPayload = {
    url: url ? url.trim() : '',
    title: title.trim(),
    timestamp,
    ...(type && { type: type.trim() }),
    ...(resolvedImgUrl && { img_url: resolvedImgUrl }),
    ...(req.body.thumbnail && { thumbnail: req.body.thumbnail.trim() }),
    ...(saved_by && { saved_by }),
    ...(clientCategoryRaw      && { category:       clientCategoryRaw }),
    ...(clientPlatformRaw      && { platform:        clientPlatformRaw }),
    ...(clientConfirmedTypeRaw && { confirmed_type:  clientConfirmedTypeRaw }),
    ...(clientSenderRaw        && { sender:             clientSenderRaw }),
    ...(clientPageDescriptionRaw && { page_description: clientPageDescriptionRaw }),
    ...(clientScreenshotPaddingRaw > 0 && { screenshot_padding: clientScreenshotPaddingRaw }),
    ...(typeof clientIsExtractedImgRaw === 'boolean'
      ? { is_extracted_img: clientIsExtractedImgRaw }
      : {}),
    ...(clientOverlayRatioRaw !== undefined && Number.isFinite(clientOverlayRatioRaw)
      ? { overlay_ratio: clientOverlayRatioRaw }
      : {}),
    ...(clientIsPortraitRaw ? { is_portrait: true } : {}),
    ...(clientImgUrlMethodRaw && { img_url_method: clientImgUrlMethodRaw }),
  };

  // Try to forward to Electron app first (for Firestore save)
  const forwardResult = await forwardToElectronApp(rawPayload);
  
  if (forwardResult.success && forwardResult.result?.success) {
    const documentId = forwardResult.result.documentId;
    console.log('✅ Saved to Firestore via Electron app:', documentId);

    const forwardedUrl = rawPayload.url;
    const userId = (req.body as any).userId as string | undefined;

    let docPath: string | undefined;
    if (forwardedUrl && documentId && userId) {
      docPath = `users/${userId}/items/${documentId}`;

      const screenshotBase64Fwd = screenshot_base64;
      if (screenshotBase64Fwd && userId && documentId && !isPortraitExtracted && (!resolvedImgUrl || isPageCategory || isSnsPageCategory)) {
        (async () => {
          try {
            const uploadResult = await uploadScreenshotToStorage(
              screenshotBase64Fwd,
              userId,
              documentId
            );
            if (uploadResult) {
              const db = getFirestore();
              const screenshotBgColor =
                typeof screenshot_bg_color === 'string' ? screenshot_bg_color.trim() : '';
              const { publicUrl } = uploadResult;
              await db.doc(docPath!).update({
                img_url: publicUrl,
                ...(screenshotBgColor ? { screenshot_bg_color: screenshotBgColor } : {}),
              });
            }
          } catch {}
        })();
      }
    }

    // Background: AI analysis (disabled — re-enable in future update)
    // if (forwardedUrl && docPath) {
    //   const aiUserLanguage = (req.body as any).userLanguage as string | undefined;
    //   (async () => { await analyzeAndUpdateDocument(docPath, forwardedUrl, aiUserLanguage, gmailTokenRaw || undefined, naverCookiesRaw); })();
    // }

    return res.status(201).json({
      success: true,
      entry: { ...rawPayload, id: documentId },
      savedTo: 'firestore',
    });
  }

  // Fallback: try Firestore direct save if userId is present
  const userId = (req.body as any).userId as string | undefined;
  console.log('[save-url] userId in payload:', userId ? userId.substring(0, 8) + '...' : 'MISSING');

  if (userId && typeof userId === 'string' && userId.trim().length > 0) {
    try {
      const uid = userId.trim();
      const db  = getFirestore();
      const itemsRef = db.collection(`users/${uid}/items`);

      const domain = (url && url.trim().length > 0)
        ? extractSource(url)
        : (resolvedImgUrl ? 'local' : 'unknown');

      const itemType = rawPayload.type
        ? rawPayload.type
        : resolvedImgUrl
          ? 'image'
          : url && url.trim().length > 0
            ? determineType(url)
            : 'image';

      // Get current minimum order value (fetch only 1 document)
      let newOrder = 0;
      try {
        const minSnap = await itemsRef
          .orderBy('order', 'asc')
          .limit(1)
          .get();
        if (!minSnap.empty) {
          const minOrderVal = minSnap.docs[0].data().order;
          newOrder = typeof minOrderVal === 'number' ? minOrderVal - 1 : 0;
        }
      } catch {
        newOrder = 0;
      }

      const firestoreEntry: Record<string, any> = {
        url:         url ? url.trim() : '',
        title:       rawPayload.title,
        timestamp,
        domain,
        type:        itemType,
        directoryId: 'undefined',
        order:       newOrder,
        saved_by:    saved_by || 'browser-extension',
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      };
      if (resolvedImgUrl) firestoreEntry.img_url = resolvedImgUrl;

      if (clientCategoryRaw)      firestoreEntry.category       = clientCategoryRaw;
      if (clientPlatformRaw)      firestoreEntry.platform       = clientPlatformRaw;
      if (clientConfirmedTypeRaw) firestoreEntry.confirmed_type = clientConfirmedTypeRaw;
      if (clientSenderRaw)                    firestoreEntry.sender             = clientSenderRaw;
      if (clientPageDescriptionRaw) firestoreEntry.page_description = clientPageDescriptionRaw;
      if (clientScreenshotPaddingRaw > 0)     firestoreEntry.screenshot_padding = clientScreenshotPaddingRaw;
      if (typeof clientIsExtractedImgRaw === 'boolean') {
        firestoreEntry.is_extracted_img = clientIsExtractedImgRaw;
      }
      if (clientOverlayRatioRaw !== undefined && Number.isFinite(clientOverlayRatioRaw)) {
        firestoreEntry.overlay_ratio = clientOverlayRatioRaw;
      }
      if (clientIsPortraitRaw) firestoreEntry.is_portrait = true;
      if (clientImgUrlMethodRaw) firestoreEntry.img_url_method = clientImgUrlMethodRaw;

      const newDocRef = itemsRef.doc();
      await newDocRef.set(firestoreEntry);

      console.log('✅ Saved directly to Firestore (Electron offline):', newDocRef.id);

      const screenshotBase64Direct = screenshot_base64;
      if (screenshotBase64Direct && uid && !isPortraitExtracted && (!resolvedImgUrl || isPageCategory || isSnsPageCategory)) {
        const newItemId = newDocRef.id;
        const newDocPath = `users/${uid}/items/${newItemId}`;
        (async () => {
          try {
            const uploadResult = await uploadScreenshotToStorage(
              screenshotBase64Direct,
              uid,
              newItemId
            );
            if (uploadResult) {
              const db = getFirestore();
              const screenshotBgColor =
                typeof screenshot_bg_color === 'string' ? screenshot_bg_color.trim() : '';
              const { publicUrl } = uploadResult;
              await db.doc(newDocPath).update({
                img_url: publicUrl,
                ...(screenshotBgColor ? { screenshot_bg_color: screenshotBgColor } : {}),
              });
            }
          } catch {}
        })();
      }

      // Background: AI analysis (disabled — re-enable in future update)
      // const aiUserLanguage = (req.body as any).userLanguage as string | undefined;
      // (async () => { await analyzeAndUpdateDocument(`users/${uid}/items/${newDocRef.id}`, url.trim(), aiUserLanguage, gmailTokenRaw || undefined, naverCookiesRaw); })();

      return res.status(201).json({
        success: true,
        entry: { ...firestoreEntry, id: newDocRef.id },
        savedTo: 'firestore-direct',
      });
    } catch (firestoreErr) {
      const msg = firestoreErr instanceof Error ? firestoreErr.message : String(firestoreErr);
      console.error('[Firestore Direct] Save failed:', msg);
      // Fall through to local JSON
    }
  }

  // Final fallback: local JSON file
  try {
    await ensureDataFile();
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    let existing: SaveUrlPayload[] = [];
    try {
      const parsed = JSON.parse(raw);
      existing = Array.isArray(parsed) ? parsed : [];
    } catch (parseError) {
      console.error('Failed to parse existing saved-urls.json, starting fresh:', parseError);
      existing = [];
      await fs.writeFile(DATA_FILE, '[]', 'utf-8');
    }

    const domain = (url && url.trim().length > 0)
      ? extractSource(url)
      : (resolvedImgUrl ? 'local' : 'unknown');

    let localType: string;
    if (resolvedImgUrl) {
      localType = 'image';
    } else if (url && url.trim().length > 0) {
      localType = determineType(url);
    } else {
      localType = 'image';
    }

    const entry: SaveUrlPayload = {
      url: url ? url.trim() : '',
      title: title.trim(),
      timestamp,
      domain,
      type: localType,
      ...(resolvedImgUrl && { img_url: resolvedImgUrl }),
      ...(saved_by && { saved_by }),
    };

    const updated = [entry, ...existing];
    await fs.writeFile(DATA_FILE, JSON.stringify(updated, null, 2), 'utf-8');

    console.log('⚠️  Saved to local JSON (no userId, Electron offline):', {
      url: entry.url || '(empty)',
      type: entry.type,
      hasImgUrl: !!entry.img_url,
    });

    return res.status(201).json({ success: true, entry, savedTo: 'local' });
  } catch (err) {
    console.error('Failed to save URL:', err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'Internal server error', details: errorMessage });
  }
});

app.delete('/api/v1/items/:itemId', async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const userId = (req.query.userId || (req.body as { userId?: string } | undefined)?.userId) as
      | string
      | undefined;

    if (!itemId || typeof itemId !== 'string' || !itemId.trim()) {
      return res.status(400).json({ error: 'Missing itemId' });
    }
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const uid = userId.trim();
    const docId = itemId.trim();
    const db = getFirestore();
    const docPath = `users/${uid}/items/${docId}`;

    // Read the document first to check for a screenshot to delete
    let imgUrl = '';
    try {
      const snap = await db.doc(docPath).get();
      if (snap.exists) {
        imgUrl = String(snap.data()?.img_url || '').trim();
      }
    } catch {
      /* proceed even if read fails */
    }

    // Delete Firestore document
    await db.doc(docPath).delete();

    // Delete Storage file if img_url points to a screenshot
    if (imgUrl.includes('/screenshots/')) {
      try {
        const bucket = getStorage();
        const bucketPrefix = `https://storage.googleapis.com/${bucket.name}/`;
        if (imgUrl.startsWith(bucketPrefix)) {
          const filePath = imgUrl.slice(bucketPrefix.length);
          await bucket.file(filePath).delete();
        }
      } catch {
        /* silently ignore storage deletion errors */
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/v1/items/:itemId]', err);
    return res.status(500).json({ error: 'Delete failed' });
  }
});

// GET endpoint to check recent saved URLs (to detect if extension is enabled)
app.get('/api/v1/saved-urls', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string);
    
    await ensureDataFile();
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    const existing: SaveUrlPayload[] = Array.isArray(JSON.parse(raw))
      ? (JSON.parse(raw) as SaveUrlPayload[])
      : [];
    
    // If limit is provided and valid, use it; otherwise return all entries
    if (limit && limit > 0) {
      const limited = existing.slice(0, limit);
      return res.status(200).json(limited);
    }
    
    // Return all entries if no limit specified or limit is 0
    return res.status(200).json(existing);
  } catch (err) {
    console.error('Failed to get saved URLs', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Store last ping timestamp (in-memory, resets on server restart)
let lastExtensionPing: number = 0;

// Extension connection ping endpoint
app.post('/api/v1/extension/ping', async (req: Request, res: Response) => {
  try {
    const { version, timestamp } = req.body;
    
    // Update last ping timestamp
    lastExtensionPing = Date.now();
    
    // Log the ping (optional: store in memory or file for tracking)
    console.log(`Extension ping received${version ? ` (version: ${version})` : ''}`);
    
    // Return success
    return res.status(200).json({ 
      success: true, 
      message: 'Ping received',
      serverTime: Date.now()
    });
  } catch (err) {
    console.error('Failed to handle extension ping:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Image proxy ───────────────────────────────────────────────────────────────
app.get('/api/v1/image-proxy', async (req: Request, res: Response) => {
  const imageUrl = req.query.url as string;

  if (!imageUrl || typeof imageUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Basic URL validation
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(imageUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        // Mimic browser request to satisfy CDN referer checks
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`,
      },
    } as any);

    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
    }

    // Forward content-type and cache headers
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream the image body directly to the response
    const buffer = await response.arrayBuffer();
    return res.send(Buffer.from(buffer));

  } catch (err: any) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Image fetch timeout' });
    }
    console.error('[Image Proxy] Error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch image' });
  }
});

// Endpoint for native app to check if extension is connected
app.get('/api/v1/extension/status', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    const timeSincePing = now - lastExtensionPing;
    const isConnected = timeSincePing < 30000; // 30 seconds timeout
    
    return res.status(200).json({
      connected: isConnected,
      lastPing: lastExtensionPing,
      timeSincePing: timeSincePing
    });
  } catch (err) {
    console.error('Failed to get extension status:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint for extension to get dock window width
// The dock width matches DOCK_WIDTH constant in client/src/main.ts (250px)
app.get('/api/v1/dock/width', async (req: Request, res: Response) => {
  try {
    return res.status(200).json({
      width: 250, // DOCK_WIDTH constant from Electron app
      unit: 'px'
    });
  } catch (err) {
    console.error('Failed to get dock width:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Logo cache (in-memory, simple implementation)
interface LogoCacheEntry {
  url: string;
  timestamp: number;
}
const logoCache = new Map<string, LogoCacheEntry>();
const LOGO_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [domain, entry] of logoCache.entries()) {
    if (now - entry.timestamp > LOGO_CACHE_DURATION) {
      logoCache.delete(domain);
    }
  }
}, 60 * 60 * 1000); // Clean up every hour

/**
 * Extracts root domain from a domain string (e.g., "store.hanssem.com" -> "hanssem.com")
 */
function getRootDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length > 2) {
    // For subdomains, return root domain (last two parts: domain.tld)
    return parts.slice(-2).join('.');
  }
  return domain;
}

/**
 * Fetches logo/favicon for a domain using multiple fallback methods
 * For subdomains, tries root domain first (brand logos are typically on root domain)
 */
async function fetchLogoUrl(domain: string): Promise<string | null> {
  // Check cache first for the exact domain
  const cached = logoCache.get(domain);
  if (cached && (Date.now() - cached.timestamp < LOGO_CACHE_DURATION)) {
    return cached.url;
  }

  // If domain is a subdomain, try root domain first
  const rootDomain = getRootDomain(domain);
  const shouldTryRootDomain = rootDomain !== domain;
  
  if (shouldTryRootDomain) {
    // Check cache for root domain
    const rootCached = logoCache.get(rootDomain);
    if (rootCached && (Date.now() - rootCached.timestamp < LOGO_CACHE_DURATION)) {
      // Cache the root domain result for the subdomain too
      logoCache.set(domain, rootCached);
      return rootCached.url;
    }
    
    // Try fetching logo for root domain first
    const rootLogoUrl = await fetchLogoUrlForDomain(rootDomain);
    if (rootLogoUrl) {
      // Cache for both root domain and subdomain
      const cacheEntry = { url: rootLogoUrl, timestamp: Date.now() };
      logoCache.set(rootDomain, cacheEntry);
      logoCache.set(domain, cacheEntry);
      return rootLogoUrl;
    }
  }

  // If root domain failed or domain is already root, try the original domain
  return await fetchLogoUrlForDomain(domain);
}

/**
 * Internal function that actually fetches logo for a specific domain
 */
async function fetchLogoUrlForDomain(domain: string): Promise<string | null> {
  // Try multiple methods in order
  const methods = [
    // Method 1: apple-touch-icon.png — 180×180, high quality,
    // supported by most modern sites.
    async () => {
      try {
        const url = `https://${domain}/apple-touch-icon.png`;
        const response = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        } as any);
        if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
          return url;
        }
      } catch (err) {}
      return null;
    },

    // Method 2: apple-touch-icon-precomposed.png — same resolution,
    // older convention still used by many sites.
    async () => {
      try {
        const url = `https://${domain}/apple-touch-icon-precomposed.png`;
        const response = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        } as any);
        if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
          return url;
        }
      } catch (err) {}
      return null;
    },

    // Method 3: Google favicon service at 256px — reliable fallback
    // with good resolution. Increased from sz=64 to sz=256.
    async () => {
      try {
        const url = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
        const response = await fetch(url, { method: 'HEAD' } as any);
        if (response.ok) {
          return url;
        }
      } catch (err) {}
      return null;
    },

    // Method 4: Direct favicon.ico — low resolution last resort.
    async () => {
      try {
        const url = `https://${domain}/favicon.ico`;
        const response = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        } as any);
        if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
          return url;
        }
      } catch (err) {}
      return null;
    },
  ];

  // Try each method sequentially
  for (const method of methods) {
    try {
      const url = await method();
      if (url) {
        // Cache the successful result
        logoCache.set(domain, { url, timestamp: Date.now() });
        return url;
      }
    } catch (err) {
      // Continue to next method
      continue;
    }
  }

  // All methods failed
  return null;
}

// Endpoint to get logo URL for a domain
app.get('/api/v1/logo/:domain', async (req: Request, res: Response) => {
  try {
    const domain = decodeURIComponent(req.params.domain);

    // Validate domain format
    if (!domain || !/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const logoUrl = await fetchLogoUrl(domain);

    // ?format=json → return JSON (legacy/internal use)
    if (req.query.format === 'json') {
      return res.status(200).json({ url: logoUrl || null });
    }

    // Default: proxy the image binary so <img src> can use this endpoint directly
    if (!logoUrl) {
      return res.status(404).json({ error: 'Logo not found' });
    }

    const imgRes = await fetch(logoUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    } as any);

    if (!imgRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch logo image' });
    }

    const contentType = imgRes.headers.get('content-type') || 'image/x-icon';
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.setHeader('Content-Length', buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Failed to fetch logo:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/v1/analyze-page', async (req: Request, res: Response) => {
  try {
    const { url, userLanguage } = req.body as { url: string; userLanguage?: string };
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'Invalid url' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'Gemini API key not configured' });
    }

    // ── Step 1: Crawl the page ──────────────────────────────────────────────
    const crawled = await crawlPageContent(url.trim());
    if (!crawled) {
      return res.status(502).json({ error: 'Failed to crawl page' });
    }

    // ── Step 2: Gemini Function Calling ─────────────────────────────────────
    const langCode = ((userLanguage || 'en').split('-')[0]).toLowerCase();
    const langMap: Record<string, string> = {
      ko: 'Korean', ja: 'Japanese', zh: 'Chinese', fr: 'French',
      de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    };
    const outputLanguage = langMap[langCode] || 'English';

    // Tool definition
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'analyze_page_content',
            description: 'Analyzes the text content of a web page and returns structured insights.',
            parameters: {
              type: 'OBJECT',
              properties: {
                title: {
                  type: 'STRING',
                  description: 'The main title or topic of the page content.',
                },
                key_points: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '3 to 5 key points or highlights from the content.',
                },
                keywords: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                  description: '4 to 6 keywords or topic tags that describe the content.',
                },
                content_type: {
                  type: 'STRING',
                  description: 'The type of content. One of: Article, News, Product, Video, Profile, Repository, Recipe, Forum, Document, Other.',
                },
              },
              required: ['title', 'key_points', 'keywords', 'content_type'],
            },
          },
        ],
      },
    ];

    const prompt = `You are analyzing the content of a web page.
URL: ${url}
Page title: ${crawled.title}
Page content:
${crawled.text}

Call the analyze_page_content function with your analysis.
Write all text fields (title, key_points) in ${outputLanguage}.
Keywords should be concise single words or short phrases.`;

    // First Gemini call — expect function call response
    const firstResponse = await fetch(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools,
          generationConfig: { temperature: 0.2 },
        }),
      } as any
    );

    if (!firstResponse.ok) {
      const errText = await firstResponse.text().catch(() => '');
      throw new Error(`Gemini error ${firstResponse.status}: ${errText.substring(0, 100)}`);
    }

    const firstData = await firstResponse.json() as any;
    const candidate = firstData?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Extract function call args
    const functionCallPart = parts.find((p: any) => p.functionCall?.name === 'analyze_page_content');
    if (!functionCallPart) {
      // Fallback: Gemini responded with text instead of function call
      const fallbackText = parts.find((p: any) => p.text)?.text || '';
      return res.status(200).json({ raw: fallbackText });
    }

    let rawArgs = functionCallPart.functionCall.args as unknown;
    if (typeof rawArgs === 'string') {
      try {
        rawArgs = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        return res.status(200).json({ raw: String(rawArgs) });
      }
    }
    const args = rawArgs as {
      title: string;
      key_points: string[];
      keywords: string[];
      content_type: string;
    };

    return res.status(200).json({
      title:              args.title              || crawled.title,
      key_points:         Array.isArray(args.key_points)         ? args.key_points         : [],
      keywords:           Array.isArray(args.keywords)           ? args.keywords           : [],
      content_type:       args.content_type       || 'Other',
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Analyze Page] Error:', msg);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

