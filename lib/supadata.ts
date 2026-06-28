// lib/supadata.ts
//
// INTERCEPT — Supadata graceful client.
// One tiny, dependency-free client for Supadata (https://supadata.ai).
// Design goals (READY-TO-DROP, sponsor-first):
//   - NEVER throws. Every method returns a typed result with `ok`/`degraded`.
//     Callers can `if (!r.ok) fallback()` and the pipeline keeps running.
//   - Reads SUPADATA_API_KEY from env; sends it as header `x-api-key`.
//   - No key / no network => graceful degrade (ok:false, reason set), NOT a crash.
//   - FREE-TIER DISCIPLINE: youtubeTranscript is rate-limited + in-memory cached
//     and gated behind an explicit budget so we only spend it on the top 1-2 videos.
//   - Zero npm deps: uses global fetch (Node 18+/Convex/Next runtime all have it).
//
// Endpoints used (all GET):
//   GET https://api.supadata.ai/v1/web/scrape?url=...           -> clean markdown
//   GET https://api.supadata.ai/v1/youtube/transcript?url=...&text=true
//   GET https://api.supadata.ai/v1/web/scrape (reused) for social meta/engagement
//
// Everything here is pure TS with no INTERCEPT imports so it merges instantly.

const SUPADATA_BASE = "https://api.supadata.ai/v1";

// ---------------------------------------------------------------------------
// Result types — discriminated, so consumers branch on `ok` and degrade safely.
// ---------------------------------------------------------------------------

export type SupadataReason =
  | "ok"
  | "no_api_key"
  | "bad_input"
  | "rate_limited"
  | "budget_exhausted"
  | "http_error"
  | "network_error"
  | "timeout"
  | "empty";

export interface SupadataResult<T> {
  ok: boolean;
  /** True when we returned a usable-but-incomplete result, or a clean no-op. */
  degraded: boolean;
  reason: SupadataReason;
  status?: number; // HTTP status when relevant
  data: T | null;
  /** Where it came from — useful for telemetry/Convex logging. */
  source: "supadata" | "cache" | "none";
}

export interface WebScrape {
  url: string;
  markdown: string; // clean markdown body
  title?: string;
  description?: string;
  /** rough word count, handy for scoring/length budgeting. */
  words: number;
}

export interface YoutubeTranscript {
  url: string;
  videoId?: string;
  /** Plain text transcript (text=true). Empty string if none. */
  text: string;
  lang?: string;
  words: number;
}

export interface SocialMeta {
  url: string;
  title?: string;
  description?: string;
  /** Best-effort engagement signals; any may be undefined. */
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
  followers?: number;
  /** Raw markdown/meta we scraped, so the brain can re-score later. */
  markdown?: string;
}

// ---------------------------------------------------------------------------
// Config / knobs (all overridable via env, with safe defaults).
// ---------------------------------------------------------------------------

const cfg = {
  get key(): string | undefined {
    return process.env.SUPADATA_API_KEY?.trim() || undefined;
  },
  timeoutMs: numEnv("SUPADATA_TIMEOUT_MS", 15000),
  // Free-tier transcript budget: how many transcripts per process lifetime.
  transcriptBudget: numEnv("SUPADATA_TRANSCRIPT_BUDGET", 2),
  // Minimum gap between transcript calls (client-side rate limit).
  transcriptMinGapMs: numEnv("SUPADATA_TRANSCRIPT_MIN_GAP_MS", 4000),
  // Cache TTLs.
  scrapeTtlMs: numEnv("SUPADATA_SCRAPE_TTL_MS", 6 * 60 * 60 * 1000), // 6h
  transcriptTtlMs: numEnv("SUPADATA_TRANSCRIPT_TTL_MS", 24 * 60 * 60 * 1000), // 24h
};

function numEnv(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// ---------------------------------------------------------------------------
// Tiny in-memory cache + transcript budget tracker.
// (Process-local — survives within a worker / Convex action invocation chain.
//  For cross-invocation cache use the Convex table noted in WIRING.md.)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  at: number;
  value: SupadataResult<T>;
}
const _cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string, ttlMs: number): SupadataResult<T> | null {
  const e = _cache.get(key) as CacheEntry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) {
    _cache.delete(key);
    return null;
  }
  // Mark cache hits so telemetry can see them.
  return { ...e.value, source: "cache" };
}

function cacheSet<T>(key: string, value: SupadataResult<T>): void {
  if (!value.ok) return; // only cache successes
  _cache.set(key, { at: Date.now(), value });
}

let _transcriptsUsed = 0;
let _lastTranscriptAt = 0;

/** Read-only view of the free-tier transcript budget (for UI / logging). */
export function transcriptBudgetStatus(): {
  used: number;
  total: number;
  remaining: number;
} {
  return {
    used: _transcriptsUsed,
    total: cfg.transcriptBudget,
    remaining: Math.max(0, cfg.transcriptBudget - _transcriptsUsed),
  };
}

// ---------------------------------------------------------------------------
// Core fetch helper — never throws, applies timeout + auth header.
// ---------------------------------------------------------------------------

async function getJson<T = any>(
  path: string,
  query: Record<string, string | number | boolean | undefined>
): Promise<{ ok: boolean; status: number; reason: SupadataReason; json: T | null }> {
  const key = cfg.key;
  if (!key) return { ok: false, status: 0, reason: "no_api_key", json: null };

  const url = new URL(SUPADATA_BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": key, accept: "application/json" },
      signal: controller.signal,
    });
    const status = res.status;
    if (status === 429) return { ok: false, status, reason: "rate_limited", json: null };
    if (!res.ok) return { ok: false, status, reason: "http_error", json: null };
    // Supadata returns JSON; tolerate text bodies too.
    const ct = res.headers.get("content-type") || "";
    const json = (ct.includes("json")
      ? await res.json()
      : { text: await res.text() }) as T;
    return { ok: true, status, reason: "ok", json };
  } catch (err: any) {
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      reason: aborted ? "timeout" : "network_error",
      json: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function fail<T>(reason: SupadataReason, status = 0): SupadataResult<T> {
  return { ok: false, degraded: true, reason, status, data: null, source: "none" };
}

function wordCount(s: string): number {
  const t = (s || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True if a key is present — cheap gate so callers can skip work entirely. */
export function supadataEnabled(): boolean {
  return !!cfg.key;
}

/**
 * webScrape — clean markdown for any URL (competitor ad pages, landing pages,
 * blog posts, discovery sources). Cached by URL. Never throws.
 */
export async function webScrape(url: string): Promise<SupadataResult<WebScrape>> {
  if (!url || !/^https?:\/\//i.test(url)) return fail<WebScrape>("bad_input");

  const cacheKey = `scrape:${url}`;
  const cached = cacheGet<WebScrape>(cacheKey, cfg.scrapeTtlMs);
  if (cached) return cached;

  const r = await getJson<any>("/web/scrape", { url });
  if (!r.ok) return fail<WebScrape>(r.reason, r.status);

  const j = r.json || {};
  const markdown: string =
    j.content ?? j.markdown ?? j.text ?? (typeof j === "string" ? j : "") ?? "";
  if (!markdown.trim()) {
    return { ...fail<WebScrape>("empty", r.status), degraded: true };
  }

  const data: WebScrape = {
    url,
    markdown,
    title: j.title ?? j.name ?? undefined,
    description: j.description ?? j.excerpt ?? undefined,
    words: wordCount(markdown),
  };
  const out: SupadataResult<WebScrape> = {
    ok: true,
    degraded: false,
    reason: "ok",
    status: r.status,
    data,
    source: "supadata",
  };
  cacheSet(cacheKey, out);
  return out;
}

/**
 * youtubeTranscript — RATE-LIMITED, BUDGETED, CACHED.
 * Free-tier discipline: only call this on the TOP 1-2 winning videos.
 *   - Hard budget (SUPADATA_TRANSCRIPT_BUDGET, default 2) per process.
 *   - Client-side min-gap between calls.
 *   - 24h cache by URL.
 * Pass { force:true } only when you intentionally want to bypass the gap
 * (budget is still enforced).
 */
export async function youtubeTranscript(
  url: string,
  opts: { force?: boolean } = {}
): Promise<SupadataResult<YoutubeTranscript>> {
  if (!url) return fail<YoutubeTranscript>("bad_input");

  const cacheKey = `yt:${url}`;
  const cached = cacheGet<YoutubeTranscript>(cacheKey, cfg.transcriptTtlMs);
  if (cached) return cached; // cache hits are FREE — don't spend budget

  if (!supadataEnabled()) return fail<YoutubeTranscript>("no_api_key");

  // Budget gate.
  if (_transcriptsUsed >= cfg.transcriptBudget) {
    return fail<YoutubeTranscript>("budget_exhausted");
  }

  // Rate-limit gate (client side).
  const gap = Date.now() - _lastTranscriptAt;
  if (!opts.force && _lastTranscriptAt > 0 && gap < cfg.transcriptMinGapMs) {
    await new Promise((res) => setTimeout(res, cfg.transcriptMinGapMs - gap));
  }

  _lastTranscriptAt = Date.now();
  const r = await getJson<any>("/youtube/transcript", { url, text: true });

  // Only burn budget on a real success.
  if (!r.ok) return fail<YoutubeTranscript>(r.reason, r.status);
  _transcriptsUsed += 1;

  const j = r.json || {};
  const text: string =
    typeof j.content === "string"
      ? j.content
      : j.text ?? (Array.isArray(j.content) ? j.content.map((c: any) => c.text).join(" ") : "") ?? "";

  if (!text.trim()) {
    return { ...fail<YoutubeTranscript>("empty", r.status), degraded: true };
  }

  const data: YoutubeTranscript = {
    url,
    videoId: j.videoId ?? j.video_id ?? extractYtId(url),
    text,
    lang: j.lang ?? j.language ?? undefined,
    words: wordCount(text),
  };
  const out: SupadataResult<YoutubeTranscript> = {
    ok: true,
    degraded: false,
    reason: "ok",
    status: r.status,
    data,
    source: "supadata",
  };
  cacheSet(cacheKey, out);
  return out;
}

/**
 * socialMeta — best-effort engagement/meta for a social or landing URL.
 * Built on webScrape (no extra free-tier transcript cost). Parses common
 * engagement counters out of the clean markdown; any field may be undefined.
 */
export async function socialMeta(url: string): Promise<SupadataResult<SocialMeta>> {
  const scraped = await webScrape(url);
  if (!scraped.ok || !scraped.data) {
    return fail<SocialMeta>(scraped.reason, scraped.status);
  }
  const md = scraped.data.markdown;
  const data: SocialMeta = {
    url,
    title: scraped.data.title,
    description: scraped.data.description,
    likes: parseCount(md, /([\d.,kKmM]+)\s*(likes?|reactions?)/),
    comments: parseCount(md, /([\d.,kKmM]+)\s*(comments?|replies)/),
    shares: parseCount(md, /([\d.,kKmM]+)\s*(shares?|retweets?|reposts?)/),
    views: parseCount(md, /([\d.,kKmM]+)\s*(views?|plays?)/),
    followers: parseCount(md, /([\d.,kKmM]+)\s*(followers?|subscribers?)/),
    markdown: md,
  };
  return {
    ok: true,
    degraded: scraped.source === "cache" ? false : false,
    reason: "ok",
    status: scraped.status,
    data,
    source: scraped.source,
  };
}

// ---------------------------------------------------------------------------
// URL classification + universal transcript (link-drop "break it down" feature).
// ---------------------------------------------------------------------------

const YT_RE = /(?:youtube\.com|youtu\.be)/i;
// Video/short-form platforms Supadata's transcript endpoints can read.
const VIDEO_RE =
  /(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com\/(?:reel|reels|p|tv)|vimeo\.com|(?:x\.com|twitter\.com)\/[^/]+\/status)/i;

/** True when the URL looks like a transcribable video (YouTube/TikTok/IG/X/Vimeo). */
export function isVideoUrl(url: string): boolean {
  return !!url && VIDEO_RE.test(url);
}

/**
 * transcript — universal, budgeted, cached transcript for a dropped video link.
 * Routes YouTube through the existing youtubeTranscript (its budget/cache/rate-
 * limit discipline is reused); other platforms hit Supadata's universal
 * `/transcript` endpoint under the SAME free-tier budget. Never throws — returns
 * a degraded result on no key / budget / empty / error so callers can fall back.
 */
export async function transcript(
  url: string,
  opts: { force?: boolean } = {},
): Promise<SupadataResult<YoutubeTranscript>> {
  if (!url) return fail<YoutubeTranscript>("bad_input");

  // YouTube → reuse the budgeted/cached/rate-limited path verbatim.
  if (YT_RE.test(url)) return youtubeTranscript(url, opts);

  const cacheKey = `tx:${url}`;
  const cached = cacheGet<YoutubeTranscript>(cacheKey, cfg.transcriptTtlMs);
  if (cached) return cached; // cache hits are FREE — don't spend budget

  if (!supadataEnabled()) return fail<YoutubeTranscript>("no_api_key");

  // Budget gate (shared with youtubeTranscript — top 1-2 videos per process).
  if (_transcriptsUsed >= cfg.transcriptBudget) {
    return fail<YoutubeTranscript>("budget_exhausted");
  }

  // Client-side rate-limit gate.
  const gap = Date.now() - _lastTranscriptAt;
  if (!opts.force && _lastTranscriptAt > 0 && gap < cfg.transcriptMinGapMs) {
    await new Promise((res) => setTimeout(res, cfg.transcriptMinGapMs - gap));
  }

  _lastTranscriptAt = Date.now();
  const r = await getJson<any>("/transcript", { url, text: true });

  if (!r.ok) return fail<YoutubeTranscript>(r.reason, r.status);
  _transcriptsUsed += 1; // only burn budget on a real success

  const j = r.json || {};
  const text: string =
    typeof j.content === "string"
      ? j.content
      : j.text ?? (Array.isArray(j.content) ? j.content.map((c: any) => c.text).join(" ") : "") ?? "";

  if (!text.trim()) {
    return { ...fail<YoutubeTranscript>("empty", r.status), degraded: true };
  }

  const data: YoutubeTranscript = {
    url,
    videoId: j.videoId ?? j.video_id ?? undefined,
    text,
    lang: j.lang ?? j.language ?? undefined,
    words: wordCount(text),
  };
  const out: SupadataResult<YoutubeTranscript> = {
    ok: true,
    degraded: false,
    reason: "ok",
    status: r.status,
    data,
    source: "supadata",
  };
  cacheSet(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// small parsers
// ---------------------------------------------------------------------------

function extractYtId(url: string): string | undefined {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/\/shorts\/([\w-]{11})/);
  return m?.[1];
}

/** Parse "12.3k likes" / "1,204 comments" -> number; undefined if absent. */
function parseCount(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m) return undefined;
  const raw = m[1].toLowerCase().replace(/,/g, "");
  const mult = raw.endsWith("k") ? 1e3 : raw.endsWith("m") ? 1e6 : 1;
  const n = parseFloat(raw) * mult;
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

// ---------------------------------------------------------------------------
// Default export — convenient namespace import.
// ---------------------------------------------------------------------------

export const supadata = {
  enabled: supadataEnabled,
  webScrape,
  youtubeTranscript,
  transcript,
  isVideoUrl,
  socialMeta,
  transcriptBudgetStatus,
};

export default supadata;
