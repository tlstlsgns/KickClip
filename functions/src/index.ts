import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import * as admin from "firebase-admin";
import express, {NextFunction, Request, Response} from "express";
import fetch from "node-fetch";

// ─── Firebase Admin 초기화 ───────────────────────────────────────────────────
admin.initializeApp();

// ─── Secrets ─────────────────────────────────────────────────────────────────
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// ─── 전역 옵션 ────────────────────────────────────────────────────────────────
setGlobalOptions({maxInstances: 10});

// ─── Gemini ───────────────────────────────────────────────────────────────────
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ─── Express 앱 ───────────────────────────────────────────────────────────────
const app = express();

// CORS — 모든 origin 허용 (Chrome Extension 포함)
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

app.use(express.json({limit: "50mb"}));

// ─── 헬퍼: Firestore / Storage ────────────────────────────────────────────────
function getFirestore() {
  return admin.firestore();
}

function getStorage() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || "";
  return bucketName ?
    admin.storage().bucket(bucketName) :
    admin.storage().bucket();
}

// ─── 헬퍼: extractSource ──────────────────────────────────────────────────────
const extractSource = (url: string): string => {
  try {
    if (!url || url.trim().length === 0) return "local";
    if (url.startsWith("data:")) return "local";
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();
    if (hostname.startsWith("www.")) hostname = hostname.substring(4);
    const parts = hostname.split(".");
    const subdomainPrefixes = ["blog", "m", "mobile", "www", "mail", "drive", "docs", "maps"];
    if (parts.length > 2 && subdomainPrefixes.includes(parts[0])) {
      return parts.slice(1, -1).join(".");
    }
    if (parts.length >= 2) return parts.slice(0, -1).join(".");
    return hostname;
  } catch {
    return "unknown";
  }
};

// ─── 헬퍼: determineType ──────────────────────────────────────────────────────
const determineType = (url: string): string => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const searchParams = urlObj.searchParams;
    if (
      pathname.includes("/watch") || pathname.includes("/video") ||
      pathname.includes("/v/") || pathname.includes("/embed/") ||
      searchParams.has("v") || searchParams.has("video_id")
    ) return "video";
    if (urlObj.hostname.includes("instagram.com") && pathname.startsWith("/reel/")) return "reels";
    if (urlObj.hostname.includes("instagram.com") && pathname.startsWith("/p/")) return "instagram_post";
    if (
      pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) ||
      pathname.includes("/image") || pathname.includes("/photo") ||
      pathname.includes("/picture") || pathname.includes("/img/")
    ) return "image";
    if (
      (urlObj.hostname.includes("pinterest.com") && pathname.startsWith("/pin/")) ||
      (pathname.match(/\/p\/[^/]+/) && !urlObj.hostname.includes("instagram.com")) ||
      pathname.match(/\/posts?\/[^/]+/) ||
      pathname.match(/\/status\/[^/]+/) ||
      pathname.match(/\/tweet\/[^/]+/)
    ) return "social_post";
    if (
      pathname.includes("/search") || searchParams.has("q") ||
      searchParams.has("query") || searchParams.has("search")
    ) return "search";
    if (
      pathname.match(/\/article[s]?\/[^/]+/) || pathname.match(/\/post[s]?\/[^/]+/) ||
      pathname.match(/\/blog\/[^/]+/) || pathname.match(/\/entry\/[^/]+/) ||
      pathname.match(/\/[0-9]{4}\/[0-9]{2}\/[^/]+/)
    ) return "article";
    if (
      pathname.match(/\/@[^/]+/) || pathname.match(/\/user[s]?\/[^/]+/) ||
      pathname.match(/\/profile[s]?\/[^/]+/) || pathname.match(/\/people\/[^/]+/)
    ) return "profile";
    if (
      pathname.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i) ||
      pathname.includes("/document") || pathname.includes("/file/")
    ) return "document";
    if (
      pathname.includes("/playlist") || pathname.includes("/collection") ||
      pathname.includes("/list/")
    ) return "collection";
    return "webpage";
  } catch {
    return "webpage";
  }
};

// ─── 헬퍼: uploadScreenshotToStorage ─────────────────────────────────────────
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
    const buffer = Buffer.from(base64Data, "base64");
    const ext = mimeType.includes("png") ? "png" : "jpg";
    const filePath = `screenshots/${userId}/${itemId}.${ext}`;
    const bucket = getStorage();
    const file = bucket.file(filePath);
    await file.save(buffer, {metadata: {contentType: mimeType}});
    try {
      await file.makePublic();
    } catch {/* ignore ACL errors */}
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    return {publicUrl};
  } catch {
    return null;
  }
}

// ─── 헬퍼: Logo cache ─────────────────────────────────────────────────────────
interface LogoCacheEntry { url: string; timestamp: number; }
const logoCache = new Map<string, LogoCacheEntry>();
const LOGO_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;

function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : domain;
}

async function fetchLogoUrlForDomain(domain: string): Promise<string | null> {
  const methods: Array<() => Promise<string | null>> = [
    async () => {
      try {
        const url = `https://${domain}/apple-touch-icon.png`;
        const response = await fetch(url, {method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"}} as any);
        if (response.ok && response.headers.get("content-type")?.startsWith("image/")) return url;
      } catch {/* continue */}
      return null;
    },
    async () => {
      try {
        const url = `https://${domain}/apple-touch-icon-precomposed.png`;
        const response = await fetch(url, {method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"}} as any);
        if (response.ok && response.headers.get("content-type")?.startsWith("image/")) return url;
      } catch {/* continue */}
      return null;
    },
    async () => {
      try {
        const url = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
        const response = await fetch(url, {method: "HEAD"} as any);
        if (response.ok) return url;
      } catch {/* continue */}
      return null;
    },
    async () => {
      try {
        const url = `https://${domain}/favicon.ico`;
        const response = await fetch(url, {method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"}} as any);
        if (response.ok && response.headers.get("content-type")?.startsWith("image/")) return url;
      } catch {/* continue */}
      return null;
    },
  ];
  for (const method of methods) {
    try {
      const url = await method();
      if (url) {
        logoCache.set(domain, {url, timestamp: Date.now()});
        return url;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchLogoUrl(domain: string): Promise<string | null> {
  const cached = logoCache.get(domain);
  if (cached && Date.now() - cached.timestamp < LOGO_CACHE_DURATION) return cached.url;
  const rootDomain = getRootDomain(domain);
  if (rootDomain !== domain) {
    const rootCached = logoCache.get(rootDomain);
    if (rootCached && Date.now() - rootCached.timestamp < LOGO_CACHE_DURATION) {
      logoCache.set(domain, rootCached);
      return rootCached.url;
    }
    const rootLogoUrl = await fetchLogoUrlForDomain(rootDomain);
    if (rootLogoUrl) {
      const cacheEntry = {url: rootLogoUrl, timestamp: Date.now()};
      logoCache.set(rootDomain, cacheEntry);
      logoCache.set(domain, cacheEntry);
      return rootLogoUrl;
    }
  }
  return fetchLogoUrlForDomain(domain);
}

// ─── 헬퍼: fetchMetadata ──────────────────────────────────────────────────────
async function fetchMetadata(url: string): Promise<{ title: string | null; description: string | null }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
    } as any);
    clearTimeout(timeoutId);
    if (!response.ok) return {title: null, description: null};
    const html = await response.text();
    let title: string | null = null;
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) {
      title = titleMatch[1].trim()
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
    }
    let description: string | null = null;
    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (ogDescMatch?.[1]) {
      description = ogDescMatch[1].trim();
    } else {
      const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
      if (descMatch?.[1]) description = descMatch[1].trim();
    }
    if (description) {
      description = description
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
    }
    return {title, description};
  } catch {
    return {title: null, description: null};
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 엔드포인트
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/v1/save-url ────────────────────────────────────────────────────
app.post("/api/v1/save-url", async (req: Request, res: Response): Promise<void> => {
  const {
    url, title, timestamp, img_url, saved_by, type,
    screenshot_base64, screenshot_bg_color, category, confirmed_type,
  } = req.body;

  const isValidString = (v: unknown) => typeof v === "string" && (v as string).trim().length > 0;
  const isValidStringOrEmpty = (v: unknown) => typeof v === "string";
  const isValidTimestamp = (v: unknown) => typeof v === "number" && Number.isFinite(v);

  const urlValidation = img_url ? isValidStringOrEmpty(url) : isValidString(url);
  if (!urlValidation || !isValidString(title) || !isValidTimestamp(timestamp)) {
    res.status(400).json({error: "Invalid payload"});
    return;
  }

  const resolvedImgUrl = img_url ? String(img_url).trim() : "";
  const clientCategoryRaw = typeof category === "string" ? category.trim() : "";
  const isPageCategory = clientCategoryRaw === "Page";
  const clientPlatformRaw = typeof req.body.platform === "string" ? req.body.platform.trim() : "";
  const clientConfirmedTypeRaw = typeof confirmed_type === "string" ? confirmed_type.trim() : "";
  const isSnsPageCategory = clientCategoryRaw === "SNS" && clientConfirmedTypeRaw === "Page";
  const clientSenderRaw = typeof req.body.sender === "string" ? req.body.sender.trim() : "";
  const clientPageDescriptionRaw = typeof req.body.page_description === "string" ?
    req.body.page_description.trim() : "";
  const clientIsPortraitRaw = typeof req.body.is_portrait === "boolean" ? req.body.is_portrait : false;
  const clientImgUrlMethodRaw =
    typeof req.body.img_url_method === "string" &&
    ["screenshot", "extracted", "favicon", "youtube-thumbnail"].includes(req.body.img_url_method) ?
      (req.body.img_url_method as string) : "";
  const clientScreenshotPaddingRaw = typeof req.body.screenshot_padding === "number" ?
    req.body.screenshot_padding : 0;
  const clientIsExtractedImgRaw = typeof req.body.is_extracted_img === "boolean" ?
    req.body.is_extracted_img : undefined;
  const clientOverlayRatioRaw = typeof req.body.overlay_ratio === "number" ?
    req.body.overlay_ratio : undefined;
  const isPortraitExtracted =
    isPageCategory && clientIsExtractedImgRaw === true &&
    typeof clientOverlayRatioRaw === "number" &&
    Number.isFinite(clientOverlayRatioRaw) && clientOverlayRatioRaw < 1.2;

  const userId = typeof req.body.userId === "string" ? req.body.userId.trim() : "";
  if (!userId) {
    res.status(400).json({error: "userId is required"});
    return;
  }

  try {
    const db = getFirestore();
    const itemsRef = db.collection(`users/${userId}/items`);
    const domain = (url && String(url).trim().length > 0) ?
      extractSource(String(url)) : (resolvedImgUrl ? "local" : "unknown");
    const itemType = type ?
      String(type).trim() :
      resolvedImgUrl ? "image" :
        url && String(url).trim().length > 0 ? determineType(String(url)) :
          "image";

    let newOrder = 0;
    try {
      const minSnap = await itemsRef.orderBy("order", "asc").limit(1).get();
      if (!minSnap.empty) {
        const minOrderVal = minSnap.docs[0].data().order;
        newOrder = typeof minOrderVal === "number" ? minOrderVal - 1 : 0;
      }
    } catch {
      newOrder = 0;
    }

    const firestoreEntry: Record<string, any> = {
      url: url ? String(url).trim() : "",
      title: String(title).trim(),
      timestamp,
      domain,
      type: itemType,
      directoryId: "undefined",
      order: newOrder,
      saved_by: saved_by || "browser-extension",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (resolvedImgUrl) firestoreEntry.img_url = resolvedImgUrl;
    if (clientCategoryRaw) firestoreEntry.category = clientCategoryRaw;
    if (clientPlatformRaw) firestoreEntry.platform = clientPlatformRaw;
    if (clientConfirmedTypeRaw) firestoreEntry.confirmed_type = clientConfirmedTypeRaw;
    if (clientSenderRaw) firestoreEntry.sender = clientSenderRaw;
    if (clientPageDescriptionRaw) firestoreEntry.page_description = clientPageDescriptionRaw;
    if (clientScreenshotPaddingRaw > 0) firestoreEntry.screenshot_padding = clientScreenshotPaddingRaw;
    if (typeof clientIsExtractedImgRaw === "boolean") firestoreEntry.is_extracted_img = clientIsExtractedImgRaw;
    if (clientOverlayRatioRaw !== undefined && Number.isFinite(clientOverlayRatioRaw)) {
      firestoreEntry.overlay_ratio = clientOverlayRatioRaw;
    }
    if (clientIsPortraitRaw) firestoreEntry.is_portrait = true;
    if (clientImgUrlMethodRaw) firestoreEntry.img_url_method = clientImgUrlMethodRaw;

    const newDocRef = itemsRef.doc();
    await newDocRef.set(firestoreEntry);

    // 스크린샷 Storage 업로드 (백그라운드)
    if (
      screenshot_base64 && userId && !isPortraitExtracted &&
      (!resolvedImgUrl || isPageCategory || isSnsPageCategory)
    ) {
      const newItemId = newDocRef.id;
      const newDocPath = `users/${userId}/items/${newItemId}`;
      (async () => {
        try {
          const uploadResult = await uploadScreenshotToStorage(screenshot_base64, userId, newItemId);
          if (uploadResult) {
            const screenshotBgColor = typeof screenshot_bg_color === "string" ?
              screenshot_bg_color.trim() : "";
            await getFirestore().doc(newDocPath).update({
              img_url: uploadResult.publicUrl,
              ...(screenshotBgColor ? {screenshot_bg_color: screenshotBgColor} : {}),
            });
          }
        } catch {/* ignore */}
      })();
    }

    res.status(201).json({
      success: true,
      entry: {...firestoreEntry, id: newDocRef.id},
      savedTo: "firestore",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[save-url] Firestore save failed:", msg);
    res.status(500).json({error: "Failed to save"});
  }
});

// ── POST /api/v1/firestore/move-item ─────────────────────────────────────────
app.post("/api/v1/firestore/move-item", async (req: Request, res: Response): Promise<void> => {
  try {
    const {userId, itemId, targetDirectoryId, newIndex, sourceDirectoryId} = req.body;
    if (!userId || !itemId || newIndex == null) {
      res.status(400).json({error: "Missing required fields"});
      return;
    }
    const targetDirFilter = targetDirectoryId == null ? "undefined" : String(targetDirectoryId);
    const sourceDirFilter = sourceDirectoryId == null ? "undefined" : String(sourceDirectoryId);
    const db = getFirestore();
    const itemsRef = db.collection(`users/${userId}/items`);
    let targetSnap;
    try {
      targetSnap = await itemsRef
        .where("directoryId", "==", targetDirFilter).orderBy("order", "asc").get();
    } catch {
      targetSnap = await itemsRef
        .where("directoryId", "==", targetDirFilter).orderBy("createdAt", "desc").get();
    }
    const draggedRef = itemsRef.doc(String(itemId));
    const draggedSnap = await draggedRef.get();
    if (!draggedSnap.exists) {
      res.status(404).json({error: "Item not found"}); return;
    }
    const targetItems = targetSnap.docs
      .filter((d) => d.id !== String(itemId))
      .map((d) => ({id: d.id, ref: d.ref}));
    const clampedIndex = Math.max(0, Math.min(Number(newIndex), targetItems.length));
    targetItems.splice(clampedIndex, 0, {id: String(itemId), ref: draggedRef});
    const batch = db.batch();
    if (targetDirFilter !== sourceDirFilter) batch.update(draggedRef, {directoryId: targetDirFilter});
    targetItems.forEach(({ref}, index) => {
      batch.update(ref, {order: index});
    });
    await batch.commit();
    res.status(200).json({success: true});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({error: msg});
  }
});

// ── POST /api/v1/firestore/move-directory ────────────────────────────────────
app.post("/api/v1/firestore/move-directory", async (req: Request, res: Response): Promise<void> => {
  try {
    const {userId, directoryId, newIndex} = req.body;
    if (!userId || !directoryId || newIndex == null) {
      res.status(400).json({error: "Missing required fields"});
      return;
    }
    const db = getFirestore();
    const dirsRef = db.collection(`users/${userId}/directories`);
    let dirsSnap;
    try {
      dirsSnap = await dirsRef.orderBy("order", "asc").get();
    } catch {
      dirsSnap = await dirsRef.orderBy("createdAt", "asc").get();
    }
    const dirs = dirsSnap.docs
      .filter((d) => d.id !== String(directoryId))
      .map((d) => ({id: d.id, ref: d.ref}));
    const draggedRef = dirsRef.doc(String(directoryId));
    const draggedSnap = await draggedRef.get();
    if (!draggedSnap.exists) {
      res.status(404).json({error: "Directory not found"}); return;
    }
    const clampedIndex = Math.max(0, Math.min(Number(newIndex), dirs.length));
    dirs.splice(clampedIndex, 0, {id: String(directoryId), ref: draggedRef});
    const batch = db.batch();
    dirs.forEach(({ref}, index) => {
      batch.update(ref, {order: index});
    });
    await batch.commit();
    res.status(200).json({success: true});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({error: msg});
  }
});

// ── DELETE /api/v1/items/:itemId ─────────────────────────────────────────────
app.delete("/api/v1/items/:itemId", async (req: Request, res: Response): Promise<void> => {
  try {
    const itemId = String(req.params.itemId ?? "");
    const rawUserId = req.query.userId ?? req.body?.userId;
    const userId = Array.isArray(rawUserId) ?
      String(rawUserId[0] ?? "") :
      typeof rawUserId === "string" ? rawUserId : String(rawUserId ?? "");

    if (!itemId || !itemId.trim()) {
      res.status(400).json({error: "Missing itemId"}); return;
    }
    if (!userId || !userId.trim()) {
      res.status(400).json({error: "Missing userId"}); return;
    }

    const uid = userId.trim();
    const docId = itemId.trim();
    const db = getFirestore();
    const docPath = `users/${uid}/items/${docId}`;

    let imgUrl = "";
    try {
      const snap = await db.doc(docPath).get();
      if (snap.exists) imgUrl = String(snap.data()?.img_url || "").trim();
    } catch {/* proceed */}

    await db.doc(docPath).delete();

    if (imgUrl.includes("/screenshots/")) {
      try {
        const bucket = getStorage();
        const bucketPrefix = `https://storage.googleapis.com/${bucket.name}/`;
        if (imgUrl.startsWith(bucketPrefix)) {
          await bucket.file(imgUrl.slice(bucketPrefix.length)).delete();
        }
      } catch {/* ignore */}
    }

    res.status(200).json({success: true});
  } catch {
    res.status(500).json({error: "Delete failed"});
  }
});

// ── GET /api/v1/image-proxy ───────────────────────────────────────────────────
app.get("/api/v1/image-proxy", async (req: Request, res: Response): Promise<void> => {
  const rawUrl = req.query.url;
  const imageUrl = Array.isArray(rawUrl) ?
    String(rawUrl[0] ?? "") :
    typeof rawUrl === "string" ? rawUrl : "";

  if (!imageUrl) {
    res.status(400).json({error: "Missing url parameter"}); return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    res.status(400).json({error: "Invalid URL"}); return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    res.status(400).json({error: "Only http/https URLs are allowed"});
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(imageUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `${parsedUrl.protocol}//${parsedUrl.hostname}/`,
      },
    } as any);
    clearTimeout(timeoutId);

    if (!response.ok) {
      res.status(response.status).json({error: `Upstream error: ${response.status}`});
      return;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (err: any) {
    if (err.name === "AbortError") {
      res.status(504).json({error: "Image fetch timeout"}); return;
    }
    res.status(502).json({error: "Failed to fetch image"});
  }
});

// ── GET /api/v1/logo/:domain ──────────────────────────────────────────────────
app.get("/api/v1/logo/:domain", async (req: Request, res: Response): Promise<void> => {
  try {
    const domain = decodeURIComponent(String(req.params.domain ?? ""));
    if (
      !domain ||
      !/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(domain)
    ) {
      res.status(400).json({error: "Invalid domain format"});
      return;
    }

    const logoUrl = await fetchLogoUrl(domain);
    const rawFormat = req.query.format;
    const formatQuery = Array.isArray(rawFormat) ?
      String(rawFormat[0] ?? "") :
      typeof rawFormat === "string" ? rawFormat : "";

    if (formatQuery === "json") {
      res.status(200).json({url: logoUrl || null}); return;
    }
    if (!logoUrl) {
      res.status(404).json({error: "Logo not found"}); return;
    }

    const imgRes = await fetch(logoUrl, {
      headers: {"User-Agent": "Mozilla/5.0"},
      signal: AbortSignal.timeout(5000),
    } as any);

    if (!imgRes.ok) {
      res.status(502).json({error: "Failed to fetch logo image"}); return;
    }

    const contentType = imgRes.headers.get("content-type") || "image/x-icon";
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Length", buffer.length);
    res.status(200).send(buffer);
  } catch {
    res.status(500).json({error: "Internal server error"});
  }
});

// ── POST /api/v1/fetch-metadata ───────────────────────────────────────────────
app.post("/api/v1/fetch-metadata", async (req: Request, res: Response): Promise<void> => {
  const {url} = req.body;
  if (!url || typeof url !== "string") {
    res.status(400).json({success: false, error: "Invalid URL"});
    return;
  }
  try {
    const metadata = await fetchMetadata(url);
    res.status(200).json({success: true, ...metadata});
  } catch {
    res.status(500).json({success: false, error: "Failed to fetch metadata"});
  }
});

// ── POST /api/v1/analyze-page ─────────────────────────────────────────────────
app.post("/api/v1/analyze-page", async (req: Request, res: Response): Promise<void> => {
  try {
    const {url, userLanguage} = req.body as { url: string; userLanguage?: string };
    if (!url || typeof url !== "string" || !url.trim()) {
      res.status(400).json({error: "Invalid url"});
      return;
    }

    const GEMINI_KEY = geminiApiKey.value();
    if (!GEMINI_KEY) {
      res.status(503).json({error: "Gemini API key not configured"});
      return;
    }

    const crawled = await fetchMetadata(url.trim());
    if (!crawled.title && !crawled.description) {
      res.status(502).json({error: "Failed to fetch page"});
      return;
    }

    const langCode = ((userLanguage || "en").split("-")[0]).toLowerCase();
    const langMap: Record<string, string> = {
      ko: "Korean", ja: "Japanese", zh: "Chinese", fr: "French",
      de: "German", es: "Spanish", pt: "Portuguese", it: "Italian",
    };
    const outputLanguage = langMap[langCode] || "English";

    const prompt = `You are analyzing the content of a web page.
URL: ${url}
Page title: ${crawled.title || ""}
Page description: ${crawled.description || ""}

Call the analyze_page_content function with your analysis.
Write all text fields in ${outputLanguage}.`;

    const tools = [{
      functionDeclarations: [{
        name: "analyze_page_content",
        description: "Analyzes a web page and returns structured insights.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: {type: "STRING", description: "The main title or topic."},
            key_points: {type: "ARRAY", items: {type: "STRING"}, description: "3-5 key points."},
            keywords: {type: "ARRAY", items: {type: "STRING"}, description: "4-6 keywords."},
            content_type: {type: "STRING", description: "Type: Article, News, Product, Video, Profile, etc."},
          },
          required: ["title", "key_points", "keywords", "content_type"],
        },
      }],
    }];

    const geminiRes = await fetch(`${GEMINI_API_URL}?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        contents: [{role: "user", parts: [{text: prompt}]}],
        tools,
        generationConfig: {temperature: 0.2},
      }),
    } as any);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      throw new Error(`Gemini error ${geminiRes.status}: ${errText.substring(0, 100)}`);
    }

    const data = await geminiRes.json() as any;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const fnPart = parts.find((p: any) => p.functionCall?.name === "analyze_page_content");

    if (!fnPart) {
      const fallbackText = parts.find((p: any) => p.text)?.text || "";
      res.status(200).json({raw: fallbackText});
      return;
    }

    let rawArgs = fnPart.functionCall.args as unknown;
    if (typeof rawArgs === "string") {
      try {
        rawArgs = JSON.parse(rawArgs);
      } catch {
        res.status(200).json({raw: String(rawArgs)}); return;
      }
    }

    const args = rawArgs as {
      title: string; key_points: string[]; keywords: string[]; content_type: string;
    };
    res.status(200).json({
      title: args.title || crawled.title || "",
      key_points: Array.isArray(args.key_points) ? args.key_points : [],
      keywords: Array.isArray(args.keywords) ? args.keywords : [],
      content_type: args.content_type || "Other",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Analyze Page] Error:", msg);
    res.status(500).json({error: "Internal server error"});
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cloud Functions 진입점
// ═══════════════════════════════════════════════════════════════════════════════
export const api = onRequest(
  {
    memory: "512MiB",
    timeoutSeconds: 60,
    region: "asia-northeast3",
    secrets: [geminiApiKey],
  },
  app
);
