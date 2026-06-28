// ============================================================================
// INTERCEPT — COMPOSER AGENT  ·  TRACK 1 (algorithm hacking / virality)
// ----------------------------------------------------------------------------
// The second beat of the social lane. Reads the trends the scout surfaced + the
// brief, then drafts MULTI-VARIANT viral posts per platform (OpenAI), scores
// every variant with the deterministic virality model (convex/virality/scoring),
// and persists them ranked into the frozen `posts` table. The harsh-reviewer
// rubric decides which variant wins each platform — surfaced on the live feed.
//
// Self-contained (adscout convention): owns its read query, write mutation, and
// a PUBLIC `postsForRun` query the canvas reads. NEVER throws past its handler.
// On a missing OpenAI key it falls back to deterministic templated variants so
// the lane still ships scored posts (degrade gracefully, never block fan-in).
//
// RUNTIME: NOT "use node" — co-locates query + mutation with the action.
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { chatJSON } from "../../lib/openai";
import {
  POST_VARIANTS_PER_PLATFORM,
  SOCIAL_PLATFORMS,
} from "../../lib/contract";
import { scoreVariants, pickBest, buildFeedback } from "../virality/scoring";
import type { ScorablePost } from "../virality/scoring";

// Keep the platform set tight so the board stays scannable + the run stays fast.
const PLATFORMS = SOCIAL_PLATFORMS.slice(0, 3); // linkedin, x, tiktok

interface DraftVariant {
  platform: string;
  variant: number;
  hook: string;
  body: string;
  hashtags: string[];
  angle: string;
  trendRef?: string;
}

// ----------------------------------------------------------------------------
// READ: the run + the trends the scout persisted (the composer's raw material).
// ----------------------------------------------------------------------------
export const context = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    const brief = await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();
    const trends = await ctx.db
      .query("trends")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return {
      company: run?.company ?? run?.input ?? "the company",
      icp: brief?.icp ?? "",
      positioning: brief?.positioning ?? "",
      trends: trends
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map((t) => ({ topic: t.topic, angle: t.angle })),
    };
  },
});

// ----------------------------------------------------------------------------
// WRITE: replace this run's post rows with the freshly scored set. Idempotent.
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    posts: v.array(
      v.object({
        platform: v.string(),
        variant: v.number(),
        hook: v.string(),
        body: v.string(),
        hashtags: v.array(v.string()),
        angle: v.string(),
        trendRef: v.optional(v.string()),
        viralityScore: v.number(),
        viralityBreakdown: v.object({
          hook: v.number(),
          emotion: v.number(),
          clarity: v.number(),
          timeliness: v.number(),
          cta: v.number(),
        }),
      }),
    ),
  },
  handler: async (ctx, { runId, posts }): Promise<number> => {
    const existing = await ctx.db
      .query("posts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    const now = Date.now();
    for (const p of posts) {
      await ctx.db.insert("posts", { runId, ...p, createdAt: now });
    }
    return posts.length;
  },
});

// ----------------------------------------------------------------------------
// PUBLIC READ: posts for a run, highest virality first. The canvas groups these
// by platform into variant cards with a virality gauge.
// ----------------------------------------------------------------------------
export const postsForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"posts">[]> => {
    const rows = await ctx.db
      .query("posts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return rows.sort((a, b) => b.viralityScore - a.viralityScore);
  },
});

// ----------------------------------------------------------------------------
// ACTION: draft variants per platform → score → persist. Never blocks.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ posts: number }> => {
    const run = await ctx.runQuery(internal.runs.getRunInternal, { runId });
    if (!run) return { posts: 0 };
    if (run.replay) return { posts: 0 };

    const data = await ctx.runQuery(internal.agents.composer.context, { runId });
    const trendRef = data.trends[0]?.topic;

    // Draft per platform in parallel (each call degrades to templates on failure).
    const settled = await Promise.allSettled(
      PLATFORMS.map((platform) => draftVariants(platform, data, trendRef)),
    );
    const drafts: DraftVariant[] = settled.flatMap((s) =>
      s.status === "fulfilled" ? s.value : [],
    );

    if (drafts.length === 0) {
      await ctx.runMutation(internal.agents.composer.save, { runId, posts: [] });
      return { posts: 0 };
    }

    // Score EVERY variant with the harsh-reviewer virality model.
    const scored = scoreVariants<ScorablePost & DraftVariant>(
      drafts.map((d) => ({ ...d })),
    );

    await ctx.runMutation(internal.agents.composer.save, {
      runId,
      posts: scored.map(({ post, virality }) => ({
        platform: post.platform,
        variant: post.variant,
        hook: post.hook,
        body: post.body,
        hashtags: post.hashtags,
        angle: post.angle,
        trendRef: post.trendRef,
        viralityScore: virality.score,
        viralityBreakdown: virality.breakdown,
      })),
    });

    // Surface the winning variant per platform + the harsh-reviewer note.
    for (const platform of PLATFORMS) {
      const forPlatform = scored.filter((s) => s.post.platform === platform);
      const best = pickBest(forPlatform);
      if (!best) continue;
      const feedback = buildFeedback(best.post, best.virality)[0];
      await logEvent(
        ctx,
        runId,
        "drafted",
        `${platform}: best of ${forPlatform.length} variants scored ${best.virality.score}/100 — ${feedback}`,
      );
    }

    return { posts: scored.length };
  },
});

// ----------------------------------------------------------------------------
// Variant drafting — OpenAI with a deterministic templated fallback.
// ----------------------------------------------------------------------------
interface ComposeContext {
  company: string;
  icp: string;
  positioning: string;
  trends: { topic: string; angle: string }[];
}

async function draftVariants(
  platform: string,
  data: ComposeContext,
  trendRef: string | undefined,
): Promise<DraftVariant[]> {
  const angle = data.trends[0]?.angle ?? `why ${data.company} matters`;
  try {
    const result = await chatJSON<{
      variants?: Array<{ hook?: string; body?: string; hashtags?: string[] }>;
    }>({
      system: `You are a world-class ${platform} ghostwriter who reliably writes viral posts. Write scroll-stopping hooks, take a clear stance, keep it skimmable, peg it to what's trending now, and ALWAYS end on a single clear call to action.`,
      user: `Company: ${data.company}\nICP: ${data.icp || "(unknown)"}\nPositioning: ${
        data.positioning || "(unknown)"
      }\nTrending angle: ${angle}\n\nWrite ${POST_VARIANTS_PER_PLATFORM} DISTINCT ${platform} post variants. Each: a punchy ≤8-word hook, a short skimmable body, and 2-4 relevant hashtags.`,
      schemaHint:
        '{ "variants": [{ "hook": "...", "body": "...", "hashtags": ["...", "..."] }] }',
      temperature: 0.8,
      maxTokens: 900,
    });
    const variants = (result.variants ?? [])
      .map((vr, i) => normalizeVariant(platform, i, vr, angle, trendRef))
      .filter((vr): vr is DraftVariant => vr !== null)
      .slice(0, POST_VARIANTS_PER_PLATFORM);
    return variants.length > 0
      ? variants
      : fallbackVariants(platform, data, angle, trendRef);
  } catch {
    return fallbackVariants(platform, data, angle, trendRef);
  }
}

function normalizeVariant(
  platform: string,
  index: number,
  vr: { hook?: string; body?: string; hashtags?: string[] },
  angle: string,
  trendRef: string | undefined,
): DraftVariant | null {
  const hook = (vr.hook ?? "").replace(/\s+/g, " ").trim();
  const body = (vr.body ?? "").trim();
  if (!hook && !body) return null;
  const hashtags = (vr.hashtags ?? [])
    .map((h) => h.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 4)
    .map((h) => `#${h}`);
  return {
    platform,
    variant: index + 1,
    hook: hook || body.split(/[.!?\n]/)[0].trim().slice(0, 80),
    body: body || hook,
    hashtags,
    angle,
    trendRef,
  };
}

// Deterministic fallback so the composer always ships scored variants.
function fallbackVariants(
  platform: string,
  data: ComposeContext,
  angle: string,
  trendRef: string | undefined,
): DraftVariant[] {
  const c = data.company;
  const topic = data.trends[0]?.topic ?? "this space";
  const templates: Array<{ hook: string; body: string; tags: string[] }> = [
    {
      hook: `Most teams get ${topic} wrong.`,
      body: `Most teams get ${topic} wrong — and it quietly costs them.\n\n${c} flips it: ${
        data.positioning || "a faster, simpler path"
      }.\n\nWhat's your take — agree?`,
      tags: ["#startups", "#growth"],
    },
    {
      hook: `${topic} is changing fast.`,
      body: `${topic} is changing fast, and ${
        data.icp || "most teams"
      } feel it.\n\nHere's the shift ${c} is betting on.\n\nFollow for the breakdown.`,
      tags: ["#building", "#tech"],
    },
    {
      hook: `Nobody talks about this ${topic} mistake.`,
      body: `Nobody talks about this ${topic} mistake — until it's expensive.\n\n${c} exists so you never hit it.\n\nComment "${c}" and I'll share how.`,
      tags: ["#founders", "#lessons"],
    },
  ];
  return templates.slice(0, POST_VARIANTS_PER_PLATFORM).map((t, i) => ({
    platform,
    variant: i + 1,
    hook: t.hook,
    body: t.body,
    hashtags: t.tags,
    angle,
    trendRef,
  }));
}

// ----------------------------------------------------------------------------
// Live-feed helper. Best-effort — never blocks the composer lane.
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
      agent: "composer",
      kind,
      message,
    });
  } catch {
    // ignore — the feed is additive
  }
}
