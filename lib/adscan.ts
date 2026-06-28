// ============================================================================
// INTERCEPT — NO-TOKEN AD SCAN  ·  AI Ad Factory (flow a: SCAN)
// ----------------------------------------------------------------------------
// Token-free competitor ad intelligence. Given an advertiser (brand/domain),
// `scanAds` pulls their LIVE ads across Meta + TikTok WITHOUT a Meta Graph API
// token — the exact gate QuickAds can't get past. Sources are layered and each
// degrades into the next:
//
//   1. TikTok Creative Center — direct server fetch of the public top-ads API.
//   2. Meta Ad Library — Orange Slice `browserExecute` (residential Chromium
//      pool) renders facebook.com/ads/library and harvests the async search_ads
//      responses, sidestepping the 403/CAPTCHA wall a server IP hits.
//   3. Apify fallback (Orange Slice `runApifyActor`) — Meta + TikTok scrapers,
//      only fired when the primary lanes come back thin.
//   4. Optional extra: the official Meta Graph API (lib/meta.searchAds) — ONLY
//      when META_ACCESS_TOKEN is set (regulated-ad coverage as a bonus lane).
//
// CONTRACT: this module NEVER throws. Every source is wrapped so a missing key,
// timeout, blocked response, or bad payload collapses to [] and the next lane
// runs. An empty scan is an honest "no ads surfaced", never an error. Runs in
// the Convex default runtime (safeFetch + the gateway wrappers, no node-only
// deps) so the adscout agent can import it directly.
// ============================================================================

import { safeFetch } from "./safeFetch";
import {
  hasOrangeSliceKey,
  osBrowserExecute,
  osRunApifyActor,
  type OsBrowserResult,
} from "./orangeslice";
import { searchAds } from "./meta";
import { MAX_SCAN_ADS, type AdMediaType, type AdNetwork, type ScannedAd } from "./contract";

export interface ScanOpts {
  /** ISO country code biasing both libraries. Defaults to "US". */
  country?: string;
  /** Which networks to scan. Defaults to both. */
  networks?: AdNetwork[];
  /** Hard cap on returned ads. Defaults to MAX_SCAN_ADS. */
  limit?: number;
}

const FETCH_TIMEOUT_MS = 12_000;
const BROWSER_TIMEOUT_SEC = 75;
// Below this many ads from the fast lanes we spend Orange Slice credits on the
// Apify fallback scrapers; above it the primary lanes already gave enough signal.
const FALLBACK_THRESHOLD = 4;

// ----------------------------------------------------------------------------
// PUBLIC: scanAds — layered, graceful, never throws.
// ----------------------------------------------------------------------------
export async function scanAds(
  advertiser: string,
  opts: ScanOpts = {},
): Promise<ScannedAd[]> {
  const name = advertiser.trim();
  if (!name) return [];

  const country = (opts.country ?? "US").toUpperCase();
  const networks = opts.networks ?? ["meta", "tiktok"];
  const limit = Math.max(1, opts.limit ?? MAX_SCAN_ADS);

  const collected: ScannedAd[] = [];

  // --- Lane 1 + 2: fast/primary (TikTok direct + Meta browser pool) in parallel.
  const primary = await Promise.all([
    networks.includes("tiktok") ? scanTikTokRadar(name, country, limit) : empty(),
    networks.includes("meta") ? scanMetaBrowser(name, country, limit) : empty(),
  ]);
  for (const lane of primary) collected.push(...lane);

  // --- Lane 3: Apify fallback — only when primary was thin AND we have a key.
  if (collected.length < FALLBACK_THRESHOLD && hasOrangeSliceKey()) {
    const fallback = await Promise.all([
      networks.includes("meta") ? scanMetaApify(name, country, limit) : empty(),
      networks.includes("tiktok") ? scanTikTokApify(name, country, limit) : empty(),
    ]);
    for (const lane of fallback) collected.push(...lane);
  }

  // --- Lane 4: optional official Meta Graph API (only if token configured).
  if (networks.includes("meta") && process.env.META_ACCESS_TOKEN?.trim()) {
    collected.push(...(await scanMetaToken(name)));
  }

  return dedupeAndCap(collected, limit);
}

function empty(): Promise<ScannedAd[]> {
  return Promise.resolve([]);
}

// ----------------------------------------------------------------------------
// LANE 1 — TikTok Creative Center top-ads (public API, direct server fetch).
// ----------------------------------------------------------------------------
async function scanTikTokRadar(
  advertiser: string,
  country: string,
  limit: number,
): Promise<ScannedAd[]> {
  const qs = new URLSearchParams({
    period: "30",
    page: "1",
    limit: String(Math.min(50, limit * 2)),
    country_code: country,
    industry_id: "0",
    objective_key: "ALL",
    sort_by: "popular",
    keyword: advertiser,
  });
  const url = `https://ads.tiktok.com/creative_radar_api/v1/top_ads/pc?${qs.toString()}`;

  let body: unknown;
  try {
    const res = await safeFetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return [];
    body = await res.json();
  } catch {
    return [];
  }

  const materials = pluck(body, ["data", "materials"]) ?? pluck(body, ["materials"]);
  if (!Array.isArray(materials)) return [];

  const ads: ScannedAd[] = [];
  for (const raw of materials) {
    if (!isRecord(raw)) continue;
    const id = str(raw["id"]) ?? str(raw["ad_id"]);
    const videoInfo = isRecord(raw["video_info"]) ? raw["video_info"] : undefined;
    const text = str(raw["ad_title"]) ?? str(raw["title"]) ?? "";
    if (!id && !text) continue;
    ads.push({
      network: "tiktok",
      platform: "tiktok",
      advertiser: str(raw["brand_name"]) ?? advertiser,
      text,
      cta: str(raw["cta"]),
      mediaType: "video",
      videoUrl: str(videoInfo?.["video_url"]),
      thumbnailUrl: str(videoInfo?.["cover"]) ?? str(raw["cover"]),
      imageUrl: str(videoInfo?.["cover"]) ?? str(raw["cover"]),
      status: "active", // Creative Center surfaces currently-popular live ads
      engagement: {
        likes: num(raw["like"]),
        comments: num(raw["comment"]),
        shares: num(raw["share"]),
      },
      url: id
        ? `https://library.tiktok.com/ads/detail/?ad_id=${encodeURIComponent(id)}`
        : "https://library.tiktok.com/ads",
      source: "tiktok_radar",
    });
  }
  return ads;
}

// ----------------------------------------------------------------------------
// LANE 2 — Meta Ad Library via Orange Slice browser pool (NO token).
// Runs Playwright in the managed Chromium pool: navigate the public Ad Library,
// capture the async `search_ads` / graphql responses, normalize in-page to a
// clean array so this TS only maps a stable shape. Never throws.
// ----------------------------------------------------------------------------
async function scanMetaBrowser(
  advertiser: string,
  country: string,
  limit: number,
): Promise<ScannedAd[]> {
  if (!hasOrangeSliceKey()) return [];

  const code = metaBrowserCode(advertiser, country, limit);
  let res: OsBrowserResult;
  try {
    res = await osBrowserExecute(code, { timeoutSec: BROWSER_TIMEOUT_SEC });
  } catch {
    return [];
  }
  if (!res.success || !Array.isArray(res.result)) return [];

  return mapMetaRawAds(res.result, advertiser, "browser_meta");
}

/** The Playwright snippet executed inside the Orange Slice Chromium pool. */
function metaBrowserCode(advertiser: string, country: string, limit: number): string {
  // Built with JSON.stringify so the advertiser/country are safely escaped.
  return `
const ADV = ${JSON.stringify(advertiser)};
const COUNTRY = ${JSON.stringify(country)};
const CAP = ${JSON.stringify(Math.min(60, limit * 3))};
const captured = [];
page.on('response', async (res) => {
  try {
    const u = res.url();
    if (u.includes('/ads/library/async/search_ads') || u.includes('/api/graphql')) {
      captured.push(await res.text());
    }
  } catch (e) {}
});
const url = 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country='
  + encodeURIComponent(COUNTRY) + '&q=' + encodeURIComponent(ADV)
  + '&search_type=keyword_unordered&media_type=all';
try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
try { await page.waitForTimeout(4000); } catch (e) {}
try {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2500);
} catch (e) {}

const out = [];
const pushAd = (ad) => {
  try {
    const snap = (ad && ad.snapshot) || {};
    const card = (snap.cards && snap.cards[0]) || {};
    out.push({
      adArchiveID: ad.adArchiveID || ad.ad_archive_id || ad.adid,
      pageName: snap.page_name || ad.pageName || ad.page_name,
      body: (snap.body && (snap.body.text || snap.body.markup)) || card.body || '',
      title: snap.title || card.title || snap.link_description || '',
      cta: snap.cta_text || card.cta_text || '',
      linkUrl: snap.link_url || card.link_url || '',
      image: (snap.images && snap.images[0] && (snap.images[0].original_image_url || snap.images[0].resized_image_url))
        || card.original_image_url || card.resized_image_url || '',
      video: (snap.videos && snap.videos[0] && (snap.videos[0].video_hd_url || snap.videos[0].video_sd_url))
        || card.video_hd_url || card.video_sd_url || '',
      videoThumb: (snap.videos && snap.videos[0] && snap.videos[0].video_preview_image_url) || '',
      startDate: ad.startDate || ad.start_date,
      endDate: ad.endDate || ad.end_date,
      isActive: ad.isActive,
      platforms: ad.publisherPlatform || ad.publisher_platform || [],
    });
  } catch (e) {}
};
const walk = (node) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) walk(v); return; }
  if (node.snapshot && (node.adArchiveID || node.ad_archive_id || node.startDate || node.start_date)) {
    pushAd(node);
  }
  for (const k in node) {
    if (k === 'snapshot') continue;
    try { walk(node[k]); } catch (e) {}
  }
};
for (const raw of captured) {
  let txt = raw;
  const i = txt.indexOf('{');
  if (i > 0) txt = txt.slice(i); // strip for(;;); / while(1); guards
  let obj; try { obj = JSON.parse(txt); } catch (e) { continue; }
  const results = obj && obj.payload && obj.payload.results;
  if (Array.isArray(results)) {
    for (const grp of results) { if (Array.isArray(grp)) { for (const a of grp) pushAd(a); } else pushAd(grp); }
  } else {
    walk(obj);
  }
  if (out.length >= CAP) break;
}
return out.slice(0, CAP);
`.trim();
}

interface MetaRawAd {
  adArchiveID?: unknown;
  pageName?: unknown;
  body?: unknown;
  title?: unknown;
  cta?: unknown;
  linkUrl?: unknown;
  image?: unknown;
  video?: unknown;
  videoThumb?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  isActive?: unknown;
  platforms?: unknown;
}

function mapMetaRawAds(
  raws: unknown[],
  advertiser: string,
  source: string,
): ScannedAd[] {
  const ads: ScannedAd[] = [];
  for (const item of raws) {
    if (!isRecord(item)) continue;
    const r = item as MetaRawAd;
    const text = str(r.body) ?? "";
    const headline = str(r.title);
    if (!text && !headline) continue;

    const startSec = epochSeconds(r.startDate);
    const endSec = epochSeconds(r.endDate);
    const active = r.isActive === true || (r.isActive === undefined && !endSec);
    const firstSeen = startSec ? new Date(startSec * 1000).toISOString() : undefined;
    const lastSeen = endSec ? new Date(endSec * 1000).toISOString() : undefined;
    const daysRunning = computeDays(startSec, endSec);

    const video = str(r.video);
    const image = str(r.image);
    const mediaType: AdMediaType = video ? "video" : image ? "image" : "unknown";
    const archiveId = str(r.adArchiveID);

    ads.push({
      network: "meta",
      platform: normalizeMetaPlatform(r.platforms),
      advertiser: str(r.pageName) ?? advertiser,
      headline,
      text,
      cta: str(r.cta),
      mediaType,
      imageUrl: image ?? str(r.videoThumb),
      thumbnailUrl: str(r.videoThumb) ?? image,
      videoUrl: video,
      firstSeen,
      lastSeen,
      daysRunning,
      status: active ? "active" : "inactive",
      url: archiveId
        ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(archiveId)}`
        : "https://www.facebook.com/ads/library/",
      source,
    });
  }
  return ads;
}

function normalizeMetaPlatform(platforms: unknown): string {
  const arr = Array.isArray(platforms) ? platforms : [];
  const first = typeof arr[0] === "string" ? (arr[0] as string).toUpperCase() : "";
  if (first.includes("INSTAGRAM")) return "instagram";
  if (first.includes("AUDIENCE")) return "audience_network";
  if (first.includes("MESSENGER")) return "messenger";
  return "facebook";
}

// ----------------------------------------------------------------------------
// LANE 3 — Apify fallback scrapers (via Orange Slice gateway). Gated on key.
// ----------------------------------------------------------------------------
async function scanMetaApify(
  advertiser: string,
  country: string,
  limit: number,
): Promise<ScannedAd[]> {
  let items: Record<string, unknown>[];
  try {
    const res = await osRunApifyActor("harvestlab/facebook-ads-library-scraper", {
      searchTerms: [advertiser],
      country,
      activeStatus: "ALL",
      maxResults: limit,
    });
    items = res.items;
  } catch {
    return [];
  }
  // The actor's output broadly mirrors the Ad Library card; reuse the mapper by
  // projecting onto the same intermediate shape.
  const projected = items.map((it) => projectApifyMeta(it));
  return mapMetaRawAds(projected, advertiser, "apify_meta");
}

function projectApifyMeta(it: Record<string, unknown>): MetaRawAd {
  const snapshot = isRecord(it["snapshot"]) ? it["snapshot"] : it;
  const images = Array.isArray(snapshot["images"]) ? snapshot["images"] : [];
  const videos = Array.isArray(snapshot["videos"]) ? snapshot["videos"] : [];
  const firstImage = isRecord(images[0]) ? images[0] : undefined;
  const firstVideo = isRecord(videos[0]) ? videos[0] : undefined;
  const bodyObj = isRecord(snapshot["body"]) ? snapshot["body"] : undefined;
  return {
    adArchiveID: it["adArchiveID"] ?? it["ad_archive_id"] ?? it["id"],
    pageName: snapshot["page_name"] ?? it["pageName"] ?? it["page_name"],
    body: str(bodyObj?.["text"]) ?? it["text"] ?? it["adText"] ?? "",
    title: snapshot["title"] ?? it["title"] ?? it["headline"],
    cta: snapshot["cta_text"] ?? it["ctaText"] ?? it["cta"],
    linkUrl: snapshot["link_url"] ?? it["linkUrl"],
    image:
      firstImage?.["original_image_url"] ??
      firstImage?.["resized_image_url"] ??
      it["imageUrl"],
    video: firstVideo?.["video_hd_url"] ?? firstVideo?.["video_sd_url"] ?? it["videoUrl"],
    videoThumb: firstVideo?.["video_preview_image_url"],
    startDate: it["startDate"] ?? it["start_date"] ?? it["adDeliveryStartTime"],
    endDate: it["endDate"] ?? it["end_date"] ?? it["adDeliveryStopTime"],
    isActive: it["isActive"] ?? it["active"],
    platforms: it["publisherPlatform"] ?? it["publisher_platform"] ?? it["platforms"],
  };
}

async function scanTikTokApify(
  advertiser: string,
  country: string,
  limit: number,
): Promise<ScannedAd[]> {
  let items: Record<string, unknown>[];
  try {
    const res = await osRunApifyActor(
      "parseforge/tiktok-creative-center-top-ads-scraper",
      { keyword: advertiser, countryCode: country, period: 30, sortBy: "popular", maxItems: limit },
    );
    items = res.items;
  } catch {
    return [];
  }

  const ads: ScannedAd[] = [];
  for (const it of items) {
    if (!isRecord(it)) continue;
    const text = str(it["ad_title"]) ?? str(it["title"]) ?? str(it["adTitle"]) ?? "";
    const id = str(it["id"]) ?? str(it["ad_id"]) ?? str(it["adId"]);
    if (!text && !id) continue;
    const videoInfo = isRecord(it["video_info"]) ? it["video_info"] : undefined;
    ads.push({
      network: "tiktok",
      platform: "tiktok",
      advertiser: str(it["brand_name"]) ?? str(it["brandName"]) ?? advertiser,
      text,
      mediaType: "video",
      videoUrl: str(videoInfo?.["video_url"]) ?? str(it["videoUrl"]),
      thumbnailUrl: str(videoInfo?.["cover"]) ?? str(it["cover"]),
      imageUrl: str(videoInfo?.["cover"]) ?? str(it["cover"]),
      status: "active",
      engagement: {
        likes: num(it["like"]) ?? num(it["likes"]),
        comments: num(it["comment"]) ?? num(it["comments"]),
        shares: num(it["share"]) ?? num(it["shares"]),
      },
      url: id
        ? `https://library.tiktok.com/ads/detail/?ad_id=${encodeURIComponent(id)}`
        : "https://library.tiktok.com/ads",
      source: "apify_tiktok",
    });
  }
  return ads;
}

// ----------------------------------------------------------------------------
// LANE 4 — official Meta Graph API (optional bonus, only with a token).
// ----------------------------------------------------------------------------
async function scanMetaToken(advertiser: string): Promise<ScannedAd[]> {
  let rows: Awaited<ReturnType<typeof searchAds>>;
  try {
    rows = await searchAds(advertiser);
  } catch {
    return [];
  }
  return rows.map((r) => ({
    network: "meta" as AdNetwork,
    platform: r.platform,
    advertiser: r.advertiser,
    text: r.text,
    mediaType: (r.imageUrl ? "image" : "unknown") as AdMediaType,
    imageUrl: r.imageUrl,
    thumbnailUrl: r.imageUrl,
    firstSeen: r.runningSince,
    daysRunning: r.daysRunning,
    status: r.status,
    url: r.url,
    source: "meta_api",
  }));
}

// ----------------------------------------------------------------------------
// Dedupe (by url, else advertiser+text) and cap. Keeps the first occurrence,
// which preserves the source priority order the lanes ran in.
// ----------------------------------------------------------------------------
function dedupeAndCap(ads: ScannedAd[], limit: number): ScannedAd[] {
  const seen = new Set<string>();
  const out: ScannedAd[] = [];
  for (const ad of ads) {
    const key =
      ad.url && !ad.url.endsWith("/ads/library/") && !ad.url.endsWith("/ads")
        ? ad.url
        : `${ad.advertiser}|${ad.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ad);
    if (out.length >= limit) break;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Small defensive parsing helpers (no throws).
// ----------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Walk a path of object keys, returning the leaf or undefined. */
function pluck(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Coerce a Meta date (unix seconds, ms, or ISO string) into unix seconds. */
function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

function computeDays(
  startSec: number | undefined,
  endSec: number | undefined,
): number | undefined {
  if (!startSec) return undefined;
  const end = endSec ?? Math.floor(Date.now() / 1000);
  const days = Math.floor((end - startSec) / 86_400);
  return days < 0 ? 0 : days;
}
