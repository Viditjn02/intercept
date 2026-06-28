import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// ============================================================================
// INTERCEPT — the GTM brief (icp + positioning). Written by the enrich agent and
// repaired by the orchestrator's fan-in so the board always has a brief to
// render, even if enrich was slow or failed.
// ============================================================================

// Fallbacks so the brief row always exists at finalize time. Never block the
// board on a missing enrich result.
const FALLBACK_ICP =
  "Buyers actively asking the question this company answers — segment still resolving.";
const FALLBACK_POSITIONING =
  "Positioning is still assembling from live signal. Findings below are real and clickable.";

/**
 * Upsert the single brief row for a run. Shared core used by both the public
 * internalMutation (enrich calls it with real values) and the orchestrator's
 * finalize (calls it with no values to repair / guarantee existence).
 *
 * - With values: write/overwrite icp + positioning.
 * - Without values + brief exists: leave it untouched.
 * - Without values + brief missing: insert a safe fallback.
 *
 * `company` (when provided by enrich) is stamped onto the run row — the brief
 * table itself has no company column (see convex/schema.ts).
 */
export async function upsertBrief(
  ctx: MutationCtx,
  args: { runId: Id<"runs">; icp?: string; positioning?: string; company?: string },
): Promise<Id<"brief">> {
  const { runId } = args;
  const icp = args.icp?.trim() || undefined;
  const positioning = args.positioning?.trim() || undefined;
  const company = args.company?.trim() || undefined;

  // Stamp the resolved company name onto the run so the board header can show it.
  if (company) {
    const run = await ctx.db.get(runId);
    if (run && !run.company) {
      await ctx.db.patch(runId, { company });
    }
  }

  const existing = await ctx.db
    .query("brief")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();

  const now = Date.now();

  if (existing) {
    // Only rewrite when we actually have new content; otherwise repair is a
    // no-op so we don't clobber a good enrich result during finalize.
    if (icp !== undefined || positioning !== undefined) {
      await ctx.db.patch(existing._id, {
        icp: icp ?? existing.icp,
        positioning: positioning ?? existing.positioning,
        generatedAt: now,
      });
    }
    return existing._id;
  }

  return await ctx.db.insert("brief", {
    runId,
    icp: icp ?? FALLBACK_ICP,
    positioning: positioning ?? FALLBACK_POSITIONING,
    generatedAt: now,
  });
}

/**
 * Persist the brief. Enrich passes icp/positioning (+ company, which is stamped
 * onto the run); finalize passes neither.
 */
export const assembleBrief = internalMutation({
  args: {
    runId: v.id("runs"),
    icp: v.optional(v.string()),
    positioning: v.optional(v.string()),
    company: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await upsertBrief(ctx, args);
  },
});

/** Read the brief for a run (reactive, drives the brief card). */
export const getBrief = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    return await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
  },
});

/** Communities discovered for a run (reactive, drives the "where buyers gather" row). */
export const getCommunities = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    return await ctx.db
      .query("communities")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
  },
});

/** THE MOAT: real, intent-scored threads for a run, highest intent first. */
export const getThreads = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return threads.sort((a, b) => b.intentScore - a.intentScore);
  },
});

/** Drafted in-thread replies for a run (behind the human-approval gate). */
export const getDrafts = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    return await ctx.db
      .query("drafts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
  },
});

/** The single rendered video creative for a run (kind === "video"), if any. */
export const getCreative = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const creatives = await ctx.db
      .query("creatives")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const video = creatives.find((c) => c.kind === "video") ?? null;
    if (!video) return null;
    // Resolve a playable URL for the stored asset (reactive — getUrl works in
    // queries). CreativePanel prefers this Convex-served URL over the external one.
    const storageUrl = video.storageId
      ? await ctx.storage.getUrl(video.storageId)
      : null;
    return { ...video, storageUrl };
  },
});
