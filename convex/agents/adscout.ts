// ============================================================================
// INTERCEPT — ADSCOUT AGENT  ·  AI Ad Factory (flow a: SCAN + SCORE)
// ----------------------------------------------------------------------------
// Token-free competitor ad intelligence. Given a run, it reads the target
// competitor and scans their LIVE ads across Meta + TikTok WITHOUT a Meta Graph
// API token (lib/adscan.scanAds — Orange Slice browser pool + Apify fallback +
// TikTok Creative Center, with the official Graph API demoted to an optional
// bonus lane). Each ad is then SCORED by OpenAI on five axes (hook, clarity,
// cta, quality, engagement) → a 0-100 perfScore + a one-line winning angle. The
// ranked winners land in the `ads` table for the gallery (components/AdGallery).
//
// Self-contained: this file owns its read query (getRun), its 6h scan cache
// (getCache/putCache over adScanCache), and its write mutation (save). It NEVER
// touches agentStatus (the orchestrator owns the board) and NEVER throws past
// its handler — a missing key, a blocked Ad Library, or a scoring failure each
// degrade cleanly so the swarm and the brief never block.
//
// RUNTIME: intentionally NOT a "use node" file. Convex forbids queries and
// mutations in "use node" modules and this agent co-locates both. lib/adscan +
// lib/openai are fetch-based clients that run in the default runtime (same as
// the detective agent's OpenAI scoring path).
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { scanAds, enrichTopAds } from "../../lib/adscan";
import { discoverCompetitors, type Competitor } from "../../lib/competitors";
import {
  MAX_SCAN_ADS,
  SCALING_MIN_DAYS,
  SCAN_CACHE_TTL_MS,
  type AdNetwork,
  type AdScores,
  type ScannedAd,
} from "../../lib/contract";
import { chatJSON } from "../../lib/openai";

// 5-axis → perfScore weights. Hook + CTA carry the most weight (they drive
// click + conversion); engagement is real-world social proof; quality/clarity
// round out craft. Weights sum to 1 so perfScore stays on a clean 0-100 scale.
const SCORE_WEIGHTS: Record<keyof AdScores, number> = {
  hook: 0.25,
  cta: 0.25,
  engagement: 0.2,
  clarity: 0.15,
  quality: 0.15,
};

// ----------------------------------------------------------------------------
// READ: the run row (co-located, no cross-module dependency).
// ----------------------------------------------------------------------------
export const getRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"runs"> | null> => {
    return await ctx.db.get(runId);
  },
});

// ----------------------------------------------------------------------------
// SCAN CACHE (6h TTL): the no-token path is expensive, so we cache the raw
// (pre-score) scan per advertiser|country|networks key. Scoring runs fresh each
// time off the cached raws so the gallery reflects the latest OpenAI judgement.
// ----------------------------------------------------------------------------
export const getCache = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<Doc<"adScanCache"> | null> => {
    return await ctx.db
      .query("adScanCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
  },
});

export const putCache = internalMutation({
  args: { key: v.string(), ads: v.array(v.any()), source: v.string() },
  handler: async (ctx, { key, ads, source }): Promise<void> => {
    const existing = await ctx.db
      .query("adScanCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    const patch = { key, ads, source, fetchedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("adScanCache", patch);
    }
  },
});

// ----------------------------------------------------------------------------
// WRITE: replace this run's ad rows with the freshly scanned, scored, ranked
// set. Idempotent — clears prior rows so re-runs don't duplicate the board.
// All scan/score fields are optional so a thin (unscored) scan still inserts.
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    ads: v.array(
      v.object({
        advertiser: v.string(),
        platform: v.string(),
        text: v.string(),
        status: v.string(),
        url: v.string(),
        imageUrl: v.optional(v.string()),
        runningSince: v.optional(v.string()),
        daysRunning: v.optional(v.number()),
        // scan extensions
        network: v.optional(v.string()),
        headline: v.optional(v.string()),
        cta: v.optional(v.string()),
        mediaType: v.optional(v.string()),
        thumbnailUrl: v.optional(v.string()),
        videoUrl: v.optional(v.string()),
        lastSeen: v.optional(v.string()),
        engagement: v.optional(
          v.object({
            likes: v.optional(v.number()),
            comments: v.optional(v.number()),
            shares: v.optional(v.number()),
          }),
        ),
        source: v.optional(v.string()),
        perfScore: v.optional(v.number()),
        scores: v.optional(
          v.object({
            hook: v.number(),
            clarity: v.number(),
            cta: v.number(),
            quality: v.number(),
            engagement: v.number(),
          }),
        ),
        scalingSignal: v.optional(v.boolean()),
        winningAngle: v.optional(v.string()),
        rank: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { runId, ads }): Promise<number> => {
    const existing = await ctx.db
      .query("ads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    for (const ad of ads) {
      await ctx.db.insert("ads", { runId, ...ad });
    }
    return ads.length;
  },
});

// ----------------------------------------------------------------------------
// ACTION: scan → score → rank → persist the competitor's live ads. Never blocks.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<void> => {
    const runDoc = await ctx.runQuery(internal.agents.adscout.getRun, { runId });
    if (!runDoc) return;

    // Replay mode: ads are pre-seeded from a fixture; do no external work.
    if (runDoc.replay) return;

    const target = (runDoc.company ?? runDoc.input ?? "").trim();
    if (!target) return;
    const domain = runDoc.routedDomain?.trim() || target;

    const country = "US";
    // Google ATC is the PRIMARY token-free network (works with ZERO keys), with
    // Meta + TikTok layered behind it.
    const networks: AdNetwork[] = ["google", "meta", "tiktok"];

    // STEP A — discover REAL, advertising competitors of the target. The target
    // itself (a pre-revenue startup) usually runs no ads; its rivals do. LLM
    // primary (needs only the OpenAI key already required for scoring), Ocean
    // grounding when keyed, deterministic seed fallback. Never empty, never throws.
    const competitors = await discoverCompetitors(domain, { limit: 5 }).catch(
      () => [] as Competitor[],
    );
    // Back-compat: if discovery somehow yields nothing, scan the target itself.
    const toScan: Competitor[] =
      competitors.length > 0 ? competitors : [{ name: target }];

    // STEP B — scan each rival across all 3 networks (cache-first, per rival).
    const perRival = await Promise.all(
      toScan.map((c) =>
        scanCached(ctx, c.name, country, networks).catch(() => [] as ScannedAd[]),
      ),
    );
    const scanned: ScannedAd[] = perRival.flat();

    const rivalNames = toScan.map((c) => c.name);
    const rivalLabel =
      rivalNames.length > 3
        ? `${rivalNames.slice(0, 3).join(", ")} +${rivalNames.length - 3} more`
        : rivalNames.join(", ");

    if (scanned.length === 0) {
      await logEvent(
        ctx,
        runId,
        "competitor",
        `Identified ${toScan.length} competitors of ${target} (${rivalLabel}) but no live ads surfaced across Google + Meta + TikTok (token-free) — the rest of the brief is unaffected.`,
      );
      return;
    }

    // STEP C/D — score each ad with OpenAI (degrades to longevity-only on no
    // key/failure), tagging the competitor each ad belongs to (via ad.advertiser).
    const scored = await scoreAds(target, scanned);

    // STEP E — rank winning-first, cap to the gallery size, stamp rank.
    const ranked = rankAds(scored)
      .slice(0, MAX_SCAN_ADS)
      .map((ad, i) => ({ ...ad, rank: i }));

    // Persist (map ScannedAd → the `ads` row shape).
    await ctx.runMutation(internal.agents.adscout.save, {
      runId,
      ads: ranked.map(toAdRow),
    });

    const top = ranked[0];
    const networksHit = Array.from(new Set(ranked.map((a) => a.network)))
      .map((n) => (n === "google" ? "Google" : n === "meta" ? "Meta" : "TikTok"))
      .join(" + ");
    const scoredCount = ranked.filter((a) => a.perfScore !== undefined).length;
    await logEvent(
      ctx,
      runId,
      "competitor",
      `Scanned ${ranked.length} live ads across ${networksHit || "Google + Meta + TikTok"} from ${
        toScan.length
      } competitors of ${target} (${rivalLabel}), token-free` +
        (scoredCount > 0 && top?.perfScore !== undefined
          ? `, scored by OpenAI (top: ${Math.round(top.perfScore)}/100${
              top.daysRunning !== undefined ? `, running ${top.daysRunning}d` : ""
            } — ${top.advertiser}).`
          : `, ranked by longevity.`),
    );

    // Compounding: persist the winning angles to the brain for future runs.
    await rememberAngles(ctx, target, ranked);
  },
});

// ----------------------------------------------------------------------------
// SCAN (cache-first) for a single advertiser. The no-token path is expensive, so
// we cache the raw (pre-score) scan per advertiser|country|networks key for 6h.
// Each lane in scanAds degrades to []; it never throws — so this never throws.
// ----------------------------------------------------------------------------
async function scanCached(
  ctx: ActionCtx,
  advertiser: string,
  country: string,
  networks: AdNetwork[],
): Promise<ScannedAd[]> {
  const name = advertiser.trim();
  if (!name) return [];
  const cacheKey = `${slugify(name)}|${country}|${[...networks].sort().join(",")}`;

  const cached = await ctx
    .runQuery(internal.agents.adscout.getCache, { key: cacheKey })
    .catch(() => null);
  if (cached && Date.now() - cached.fetchedAt < SCAN_CACHE_TTL_MS) {
    return (cached.ads as ScannedAd[]) ?? [];
  }

  let scanned: ScannedAd[] = [];
  try {
    scanned = await scanAds(name, { country, networks });
  } catch {
    scanned = [];
  }

  if (scanned.length > 0) {
    try {
      await ctx.runMutation(internal.agents.adscout.putCache, {
        key: cacheKey,
        ads: scanned,
        source: scanned[0]?.source ?? "scan",
      });
    } catch {
      // cache is additive — ignore
    }
  }
  return scanned;
}

// ----------------------------------------------------------------------------
// SCORING — one batched OpenAI call returns per-ad 5-axis scores + winning
// angle. perfScore is the weighted mean; scalingSignal is derived locally
// (active + ≥SCALING_MIN_DAYS running). On no key / failure, scores are left
// undefined and ranking falls back to longevity (the legacy behaviour).
// ----------------------------------------------------------------------------
const SCORE_SYSTEM_PROMPT = [
  "You are a senior direct-response performance marketer auditing a competitor's live ads.",
  "Score each ad on five axes, each an integer 0-100:",
  "- hook: how strongly the opening stops the scroll.",
  "- clarity: how clearly the offer + who-it's-for land.",
  "- cta: how compelling and specific the call-to-action is.",
  "- quality: production/copy craft and credibility.",
  "- engagement: likely real-world resonance (use any like/comment/share + run-duration signal).",
  "Also give winningAngle: the single persuasion angle that makes it work, <= 8 words.",
  "Long-running ads are usually winners (advertisers kill losers fast) — let that inform engagement.",
].join("\n");

async function scoreAds(advertiser: string, ads: ScannedAd[]): Promise<ScannedAd[]> {
  const withSignal = ads.map((ad) => ({
    ...ad,
    scalingSignal: ad.status === "active" && (ad.daysRunning ?? 0) >= SCALING_MIN_DAYS,
  }));

  // Supadata enrichment (additive, free-tier-disciplined, never throws): grounds
  // the winning-angle scoring in the competitor's ACTUAL landing copy + top video
  // transcript. Empty map without a key / on rate-limit → prompt is unchanged.
  let enrichment: Map<number, { landingCopy?: string; videoScript?: string }> =
    new Map();
  try {
    enrichment = await enrichTopAds(withSignal);
  } catch {
    enrichment = new Map();
  }
  const hasGrounding = enrichment.size > 0;

  let byIndex: Map<number, { scores: AdScores; winningAngle?: string }> | null = null;
  try {
    const result = await chatJSON<{
      scored?: Array<{
        i?: number;
        hook?: number;
        clarity?: number;
        cta?: number;
        quality?: number;
        engagement?: number;
        winningAngle?: string;
      }>;
    }>({
      system: SCORE_SYSTEM_PROMPT,
      user: JSON.stringify({
        advertiser,
        ads: withSignal.map((ad, i) => {
          const extra = enrichment.get(i);
          return {
            i,
            platform: ad.platform,
            network: ad.network,
            headline: ad.headline ?? "",
            text: ad.text.slice(0, 600),
            cta: ad.cta ?? "",
            daysRunning: ad.daysRunning,
            status: ad.status,
            engagement: ad.engagement,
            // NEW grounding context — only present for the top ad(s) Supadata
            // could enrich; omitted entirely otherwise so the prompt is unchanged.
            ...(extra?.landingCopy ? { landingCopy: extra.landingCopy } : {}),
            ...(extra?.videoScript ? { videoScript: extra.videoScript } : {}),
          };
        }),
        instructions:
          'Return STRICT JSON {"scored":[{"i":number,"hook":0-100,"clarity":0-100,"cta":0-100,"quality":0-100,"engagement":0-100,"winningAngle":string}]} — exactly one entry per input ad, same i.' +
          (hasGrounding
            ? " Some ads include landingCopy (the live landing page) and/or videoScript (the top video ad's transcript) — when present, ground winningAngle in those ACTUAL words, not guesses."
            : ""),
      }),
      temperature: 0.2,
      maxTokens: 1800,
    });

    byIndex = new Map();
    for (const s of result?.scored ?? []) {
      if (typeof s?.i !== "number") continue;
      byIndex.set(s.i, {
        scores: {
          hook: clampScore(s.hook),
          clarity: clampScore(s.clarity),
          cta: clampScore(s.cta),
          quality: clampScore(s.quality),
          engagement: clampScore(s.engagement),
        },
        winningAngle: cleanAngle(s.winningAngle),
      });
    }
  } catch {
    byIndex = null; // no OpenAI key / bad JSON → longevity-only ranking
  }

  return withSignal.map((ad, i) => {
    const hit = byIndex?.get(i);
    if (!hit) return ad;
    return {
      ...ad,
      scores: hit.scores,
      perfScore: perfScore(hit.scores),
      winningAngle: hit.winningAngle ?? ad.winningAngle,
    };
  });
}

function perfScore(scores: AdScores): number {
  let sum = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as Array<keyof AdScores>) {
    sum += scores[key] * SCORE_WEIGHTS[key];
  }
  return Math.round(sum);
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function cleanAngle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 80) : undefined;
}

// ----------------------------------------------------------------------------
// RANK: scaling winners → performance score → longevity → active-first.
// ----------------------------------------------------------------------------
function rankAds(ads: ScannedAd[]): ScannedAd[] {
  return [...ads].sort((a, b) => {
    const scaleA = a.scalingSignal ? 1 : 0;
    const scaleB = b.scalingSignal ? 1 : 0;
    if (scaleA !== scaleB) return scaleB - scaleA;

    const perfA = a.perfScore ?? -1;
    const perfB = b.perfScore ?? -1;
    if (perfA !== perfB) return perfB - perfA;

    if (a.status !== b.status) {
      if (a.status === "active") return -1;
      if (b.status === "active") return 1;
    }
    return (b.daysRunning ?? 0) - (a.daysRunning ?? 0);
  });
}

// ----------------------------------------------------------------------------
// Map an in-memory ScannedAd onto the `ads` table row shape.
// ----------------------------------------------------------------------------
type AdRowInput = {
  advertiser: string;
  platform: string;
  text: string;
  status: string;
  url: string;
  imageUrl?: string;
  runningSince?: string;
  daysRunning?: number;
  network?: string;
  headline?: string;
  cta?: string;
  mediaType?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  lastSeen?: string;
  engagement?: { likes?: number; comments?: number; shares?: number };
  source?: string;
  perfScore?: number;
  scores?: AdScores;
  scalingSignal?: boolean;
  winningAngle?: string;
  rank?: number;
};

function toAdRow(ad: ScannedAd & { rank?: number }): AdRowInput {
  return {
    advertiser: ad.advertiser,
    platform: ad.platform,
    text: ad.text,
    status: ad.status,
    url: ad.url,
    imageUrl: ad.imageUrl,
    runningSince: ad.firstSeen,
    daysRunning: ad.daysRunning,
    network: ad.network,
    headline: ad.headline,
    cta: ad.cta,
    mediaType: ad.mediaType,
    thumbnailUrl: ad.thumbnailUrl,
    videoUrl: ad.videoUrl,
    lastSeen: ad.lastSeen,
    engagement: ad.engagement,
    source: ad.source,
    perfScore: ad.perfScore,
    scores: ad.scores,
    scalingSignal: ad.scalingSignal,
    winningAngle: ad.winningAngle,
    rank: ad.rank,
  };
}

// ----------------------------------------------------------------------------
// Live-feed + compounding helpers. Best-effort — never block the adscout lane.
// ----------------------------------------------------------------------------
async function logEvent(
  ctx: ActionCtx,
  runId: Id<"runs">,
  kind: string,
  message: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.events.log, {
      runId,
      agent: "adscout",
      kind,
      message,
    });
  } catch {
    // ignore — the feed is additive
  }
}

async function rememberAngles(
  ctx: ActionCtx,
  advertiser: string,
  ads: ScannedAd[],
): Promise<void> {
  const winners = ads
    .filter((a) => a.status === "active" && (a.daysRunning ?? 0) >= 7 && a.text.trim())
    .slice(0, 5);
  if (winners.length === 0) return;

  const slug = `intercept-competitor-${slugify(advertiser)}`;
  const markdown = [
    `# ${advertiser} — winning ad angles (token-free Meta + TikTok scan, via INTERCEPT)`,
    "",
    "Ranked by performance score + run-duration (longer = a more proven angle):",
    "",
    ...winners.map((a) => {
      const score = a.perfScore !== undefined ? `${Math.round(a.perfScore)}/100` : "?";
      const angle = a.winningAngle ? ` [${a.winningAngle}]` : "";
      const days = a.daysRunning ?? "?";
      return `- (${score}, ${days}d, ${a.network})${angle} ${a.text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200)}`;
    }),
  ].join("\n");

  try {
    await ctx.runAction(internal.brain.remember, { slug, markdown });
  } catch {
    // brain unavailable in this runtime — degrade silently
  }
}

/** Lowercase, hyphenated, filesystem-safe slug for a cache/brain page key. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "competitor"
  );
}
