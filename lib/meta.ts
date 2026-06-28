// ============================================================================
// INTERCEPT — META AD LIBRARY CLIENT  ·  AI Ad Factories
// ----------------------------------------------------------------------------
// Competitor-ad intelligence: which of a competitor's ads are LIVE in the Meta
// Ad Library and how long they have been running. Ad longevity is a strong
// proxy for "this creative is converting" — advertisers kill losers fast and
// let winners run for months. So the ads that have been live the longest are
// the angles INTERCEPT should mirror.
//
// Pure `fetch` REST client (no SDK, no new deps). Called from the adscout agent
// (convex/agents/adscout.ts) in Convex's default runtime.
//
// HONEST RESTRICTION NOTE
// -----------------------
// The Graph API `ads_archive` endpoint is the public Meta Ad Library API. In
// most regions it only returns ads about social issues, elections or politics;
// full commercial-ad search requires identity/region verification (and even
// then coverage varies). A vanilla developer token will frequently return an
// empty `data` array or an OAuth/permission error for a normal SaaS competitor.
// That is expected and is NOT a bug. Per the brief's graceful-degradation rule
// we treat ANY failure (missing token, permission error, restricted result,
// network error) as a silent no-op and return [] — the swarm never blocks.
// ============================================================================

const GRAPH_VERSION = "v21.0";
const AD_ARCHIVE_URL = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive`;

// Fields we request from the Ad Library. Kept tight so we map only what we use.
const AD_FIELDS = [
  "id",
  "page_name",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_creative_link_captions",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "ad_snapshot_url",
  "publisher_platforms",
].join(",");

const DEFAULT_LIMIT = 25; // pull a healthy set; the agent caps + ranks afterward
const REQUEST_TIMEOUT_MS = 12_000;

// The mapped ad shape — mirrors the frozen `ads` table in convex/schema.ts
// (minus runId, which the agent stamps on insert).
export interface AdRow {
  advertiser: string;
  platform: string; // facebook | instagram | audience_network
  text: string; // ad copy / primary text
  imageUrl?: string;
  runningSince?: string; // ISO date the ad started
  daysRunning?: number; // longevity = proxy for a winning ad
  status: string; // active | inactive
  url: string; // permalink into the Ad Library
}

// Loose shape of a raw Ad Library record. Every field is read defensively.
interface RawAd {
  id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_captions?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_snapshot_url?: string;
  publisher_platforms?: string[];
}

interface AdArchiveResponse {
  data?: RawAd[];
  error?: { message?: string };
}

// Map Meta's UPPERCASE platform tokens onto the table's lowercase vocabulary.
function normalizePlatform(platforms: string[] | undefined): string {
  const first = (platforms ?? [])[0]?.toUpperCase();
  switch (first) {
    case "INSTAGRAM":
      return "instagram";
    case "AUDIENCE_NETWORK":
      return "audience_network";
    case "MESSENGER":
      return "messenger";
    case "FACEBOOK":
    default:
      return "facebook";
  }
}

// Days between an ISO start date and either the stop date or now (if still live).
function computeDaysRunning(
  startTime: string | undefined,
  stopTime: string | undefined,
): number | undefined {
  if (!startTime) return undefined;
  const start = Date.parse(startTime);
  if (Number.isNaN(start)) return undefined;
  const end = stopTime ? Date.parse(stopTime) : Date.now();
  const span = (Number.isNaN(end) ? Date.now() : end) - start;
  if (span < 0) return 0;
  return Math.floor(span / 86_400_000); // ms per day
}

// An ad is "active" if it has no stop time, or its stop time is in the future.
function deriveStatus(stopTime: string | undefined): "active" | "inactive" {
  if (!stopTime) return "active";
  const stop = Date.parse(stopTime);
  if (Number.isNaN(stop)) return "active";
  return stop > Date.now() ? "active" : "inactive";
}

function firstNonEmpty(...candidates: Array<string[] | undefined>): string {
  for (const list of candidates) {
    const hit = (list ?? []).map((s) => s?.trim()).find(Boolean);
    if (hit) return hit;
  }
  return "";
}

function mapAd(raw: RawAd, advertiser: string): AdRow | null {
  // The permalink into the Ad Library is the one field we truly need — without
  // it the card has nothing to link to, so drop the record.
  const url = raw.ad_snapshot_url?.trim();
  if (!url) return null;

  const text = firstNonEmpty(
    raw.ad_creative_bodies,
    raw.ad_creative_link_titles,
    raw.ad_creative_link_captions,
  );

  return {
    advertiser: raw.page_name?.trim() || advertiser,
    platform: normalizePlatform(raw.publisher_platforms),
    text: text.slice(0, 600),
    // The Ad Library API does not expose a direct creative image URL; the
    // visual lives behind the snapshot permalink. Left undefined by design.
    imageUrl: undefined,
    runningSince: raw.ad_delivery_start_time || undefined,
    daysRunning: computeDaysRunning(
      raw.ad_delivery_start_time,
      raw.ad_delivery_stop_time,
    ),
    status: deriveStatus(raw.ad_delivery_stop_time),
    url,
  };
}

/**
 * Search the Meta Ad Library for a competitor's live ads.
 *
 * Graceful by contract: returns [] (never throws) when META_ACCESS_TOKEN is
 * missing, the advertiser is blank, or the API restricts / rejects the request.
 */
export async function searchAds(advertiser: string): Promise<AdRow[]> {
  const term = advertiser?.trim();
  if (!term) return [];

  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) return []; // no key -> silent no-op, swarm continues

  const params = new URLSearchParams({
    access_token: token,
    search_terms: term,
    ad_reached_countries: JSON.stringify(["US"]),
    ad_active_status: "ALL",
    fields: AD_FIELDS,
    limit: String(DEFAULT_LIMIT),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${AD_ARCHIVE_URL}?${params.toString()}`, {
      method: "GET",
      signal: controller.signal,
    });

    // Permission/restriction errors come back as non-2xx — degrade silently.
    if (!res.ok) return [];

    const payload = (await res.json()) as AdArchiveResponse;
    if (payload.error || !Array.isArray(payload.data)) return [];

    return payload.data
      .map((raw) => mapAd(raw, term))
      .filter((row): row is AdRow => row !== null);
  } catch {
    // Network error, abort/timeout, or malformed JSON — no-op, never block.
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
