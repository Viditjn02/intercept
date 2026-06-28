import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { FANIN_DEADLINE_MS, boardAgentsForIntent } from "../lib/contract";
import type { Capability } from "../lib/contract";

// ============================================================================
// INTERCEPT — runs core (intent-aware).
//
// A RUN is one capability execution (a swarm cycle). `createRun` is now driven by
// the routed `intent`: it stamps the intent on the run and queues ONE agentStatus
// row per BOARD agent in that capability's plan (CAPABILITY_PLANS), not a fixed
// roster. The orchestrator (convex/run.ts) reads the plan and drives the board;
// it owns the hard fan-in deadline so the canvas always settles.
//
// DEPLOY-SAFETY: queries/mutations module — NEVER "use node". The chat router
// (convex/chat.ts) calls the public createRun via ctx.runMutation.
// ============================================================================

// Mirror schema runs.inputType — validate at the boundary before persisting.
const inputTypeValidator = v.union(
  v.literal("url"),
  v.literal("name"),
  v.literal("competitor"),
  v.literal("community"),
  v.literal("text"),
);

// Mirror schema runs.intent (the capability set that spawns a run).
const intentValidator = v.union(
  v.literal("analyze"),
  v.literal("discovery"),
  v.literal("outbound"),
  v.literal("outreach"),
  v.literal("content"),
  v.literal("competitor"),
  v.literal("replicate"),
  v.literal("social"),
  v.literal("onboarding"),
  v.literal("scout"),
);

const triggerValidator = v.union(
  v.literal("manual"),
  v.literal("chat"),
  v.literal("cron"),
);

const runStatusValidator = v.union(
  v.literal("running"),
  v.literal("complete"),
  v.literal("partial"),
  v.literal("failed"),
);

const agentStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("done"),
  v.literal("skipped"),
  v.literal("failed"),
);

// ---------------------------------------------------------------------------
// DEDUPE — don't redo just-completed work. A chat/manual ask that exactly
// repeats a (intent, target) we COMPLETED in the last REUSE_TTL_MS reuses that
// run (the spawning message is re-pointed at it) instead of re-running. Scoped
// to interactive triggers only — the cron loop owns its own cadence and must be
// free to re-run; runs with provenance (sourceUrl/groundedOnAdId/replay) or a
// campaign, and the side-effectful `outreach` intent, are never deduped.
// ---------------------------------------------------------------------------
// 30 min by default. The LOCAL demo deployment sets RUN_REUSE_TTL_MS to a long
// window (env, local only) so a pre-warmed target like nolongerjobless.com fires
// straight from the cached completed run — instant, killer-demo reuse.
const REUSE_TTL_MS = Number(process.env.RUN_REUSE_TTL_MS) || 30 * 60_000;

/** Normalize a run target to a stable key (host/name) for dedupe + cache match. */
function normalizeTarget(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .trim();
}

/**
 * Find a recent COMPLETED run for the same (intent, target). Scans the newest
 * completed runs of this intent (indexed) and returns the first whose
 * normalized input matches and that finished within the TTL. Null on no match.
 */
async function findReusableRun(
  ctx: MutationCtx,
  intent: Capability,
  input: string,
): Promise<Id<"runs"> | null> {
  const target = normalizeTarget(input);
  if (!target) return null;
  const since = Date.now() - REUSE_TTL_MS;
  const recent = await ctx.db
    .query("runs")
    .withIndex("by_intent_status", (q) =>
      q.eq("intent", intent).eq("status", "complete"),
    )
    .order("desc")
    .take(20);
  for (const r of recent) {
    if (r.startedAt < since) continue;
    if (normalizeTarget(r.input) === target) return r._id;
  }
  return null;
}

/** Whether a spawn is eligible for dedupe-reuse (interactive, no provenance). */
function eligibleForReuse(args: SpawnRunArgs): boolean {
  return (
    (args.trigger === "chat" || args.trigger === "manual") &&
    args.intent !== "outreach" &&
    !args.replay &&
    !args.sourceUrl &&
    !args.groundedOnAdId &&
    !args.campaignId
  );
}

/**
 * Kick off a capability run. Inserts the run (status "running") with its routed
 * intent + trigger, queues one agentStatus row per BOARD agent for that intent,
 * links the spawning chat message (so the canvas keys off it), and schedules the
 * orchestrator. The fan-in deadline is hard: the board renders from whatever
 * exists at `deadlineAt`.
 */
interface SpawnRunArgs {
  intent: Capability;
  input: string;
  inputType: Doc<"runs">["inputType"];
  conversationId?: Id<"conversations">;
  messageId?: Id<"messages">;
  campaignId?: Id<"campaigns">;
  trigger: Doc<"runs">["trigger"];
  replay?: boolean;
  skipVideo?: boolean;
  // AD FACTORY provenance.
  sourceUrl?: string;
  groundedOnAdId?: Id<"ads">;
}

/**
 * Shared run-spawn core: insert the run, queue one board row per BOARD agent in
 * the capability's plan, link the spawning message, and schedule the
 * orchestrator. Used by `createRun` (chat/manual) and `generateSimilar` (the ad
 * gallery's "Generate similar" button).
 */
async function spawnRun(ctx: MutationCtx, args: SpawnRunArgs): Promise<Id<"runs">> {
  const trimmed = args.input.trim();
  if (trimmed.length === 0) {
    throw new Error("spawnRun: input must not be empty");
  }

  // DEDUPE: reuse a just-completed run for the same (intent, target) instead of
  // re-running it. Re-point the spawning message at the existing run so the
  // canvas focuses its (already-settled) board.
  if (eligibleForReuse(args)) {
    const reuseId = await findReusableRun(ctx, args.intent, trimmed);
    if (reuseId) {
      if (args.messageId) {
        await ctx.db.patch(args.messageId, { runId: reuseId, intent: args.intent });
      }
      return reuseId;
    }
  }

  const now = Date.now();
  const runId: Id<"runs"> = await ctx.db.insert("runs", {
    conversationId: args.conversationId,
    messageId: args.messageId,
    campaignId: args.campaignId,
    input: trimmed,
    inputType: args.inputType,
    intent: args.intent,
    trigger: args.trigger,
    status: "running",
    startedAt: now,
    deadlineAt: now + FANIN_DEADLINE_MS,
    replay: args.replay ?? false,
    skipVideo: args.skipVideo,
    sourceUrl: args.sourceUrl,
    groundedOnAdId: args.groundedOnAdId,
  });

  // One queued board row per BOARD agent in this capability's plan. Silent
  // agents (router, enrich, reply) run but get no tile.
  const boardAgents = boardAgentsForIntent(args.intent);
  for (const agent of boardAgents) {
    await ctx.db.insert("agentStatus", { runId, agent, status: "queued" });
  }

  // Link the spawning chat message so the canvas can render this run's board.
  if (args.messageId) {
    await ctx.db.patch(args.messageId, { runId, intent: args.intent });
  }

  // Hand off to the orchestrator. It owns agentStatus + the fan-in deadline.
  await ctx.scheduler.runAfter(0, internal.run.orchestrate, { runId });

  return runId;
}

export const createRun = mutation({
  args: {
    intent: intentValidator,
    input: v.string(),
    inputType: inputTypeValidator,
    // Chat provenance — link the run to the assistant message + conversation.
    conversationId: v.optional(v.id("conversations")),
    messageId: v.optional(v.id("messages")),
    // Outbound / 24/7 runs carry a campaign.
    campaignId: v.optional(v.id("campaigns")),
    trigger: triggerValidator,
    replay: v.optional(v.boolean()),
    // Background (cron) ticks skip the Veo render so they don't burn credits.
    skipVideo: v.optional(v.boolean()),
    // AD FACTORY: a dropped post/ad URL to replicate (flow c).
    sourceUrl: v.optional(v.string()),
    // AD FACTORY: the scanned ad a "Generate similar" run is grounded on (flow b).
    groundedOnAdId: v.optional(v.id("ads")),
  },
  handler: async (ctx, args): Promise<Id<"runs">> => {
    return await spawnRun(ctx, {
      intent: args.intent as Capability,
      input: args.input,
      inputType: args.inputType,
      conversationId: args.conversationId,
      messageId: args.messageId,
      campaignId: args.campaignId,
      trigger: args.trigger,
      replay: args.replay,
      skipVideo: args.skipVideo,
      sourceUrl: args.sourceUrl,
      groundedOnAdId: args.groundedOnAdId,
    });
  },
});

/**
 * The ad gallery's "Generate similar" action: take a scanned `ads` row and spawn
 * a fresh CREATE run grounded on it, reusing the source run's conversation so the
 * new board renders in the same chat. adsmith reads `groundedOnAdId` to mirror
 * the winning angle. Returns the new runId so the UI can focus it.
 */
export const generateSimilar = mutation({
  args: { adId: v.id("ads") },
  handler: async (ctx, { adId }): Promise<Id<"runs">> => {
    const ad = await ctx.db.get(adId);
    if (!ad) throw new Error("generateSimilar: ad not found");
    const sourceRun = await ctx.db.get(ad.runId);

    return await spawnRun(ctx, {
      intent: "content",
      input: ad.advertiser,
      inputType: "competitor",
      conversationId: sourceRun?.conversationId,
      trigger: "manual",
      groundedOnAdId: adId,
    });
  },
});

/** Read a single run (reactive — canvas header + status pill). */
export const getRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"runs"> | null> => {
    return await ctx.db.get(runId);
  },
});

/** All runs, newest first (recent-runs / demo history). */
export const listRuns = query({
  args: {},
  handler: async (ctx): Promise<Doc<"runs">[]> => {
    return await ctx.db.query("runs").order("desc").take(50);
  },
});

/**
 * Public read of the agentStatus rows for a run — drives the live swarm board
 * (components/SwarmBoard.tsx). Reactive: re-renders as the orchestrator flips
 * each agent's status.
 */
export const agentStatuses = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"agentStatus">[]> => {
    return await ctx.db
      .query("agentStatus")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
  },
});

// ---------------------------------------------------------------------------
// Internal helpers — only the orchestrator + per-run router call these.
// ---------------------------------------------------------------------------

/** Internal read of a run (the orchestrator action needs deadlineAt + intent). */
export const getRunInternal = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"runs"> | null> => {
    return await ctx.db.get(runId);
  },
});

/** Patch a single agent's board row, stamping start/finish times by status. */
export const setAgentStatus = internalMutation({
  args: {
    runId: v.id("runs"),
    agent: v.string(),
    status: agentStatusValidator,
    note: v.optional(v.string()),
  },
  handler: async (ctx, { runId, agent, status, note }): Promise<void> => {
    const row = await ctx.db
      .query("agentStatus")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .filter((q) => q.eq(q.field("agent"), agent))
      .unique();

    if (!row) return;

    const now = Date.now();
    const patch: {
      status: typeof status;
      note?: string;
      startedAt?: number;
      finishedAt?: number;
    } = { status };

    if (note !== undefined) patch.note = note;
    if (status === "running") patch.startedAt = now;
    if (status === "done" || status === "failed" || status === "skipped") {
      patch.finishedAt = now;
    }

    await ctx.db.patch(row._id, patch);
  },
});

/**
 * Persist the per-run router's resolved classification onto the run so the
 * downstream enrich agent scrapes the canonical domain instead of the raw input.
 * Best-effort: only stamps fields that aren't already set; no-op for empties.
 */
export const applyRouting = internalMutation({
  args: {
    runId: v.id("runs"),
    inputType: v.optional(inputTypeValidator),
    company: v.optional(v.string()),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, { runId, inputType, company, domain }): Promise<void> => {
    const run = await ctx.db.get(runId);
    if (!run) return;

    const patch: {
      inputType?: typeof run.inputType;
      company?: string;
      routedDomain?: string;
    } = {};

    if (inputType) patch.inputType = inputType;

    const trimmedCompany = company?.trim();
    if (trimmedCompany && !run.company) patch.company = trimmedCompany;

    const trimmedDomain = domain?.trim();
    if (trimmedDomain) patch.routedDomain = trimmedDomain;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(runId, patch);
    }
  },
});

/**
 * Roll-up counters for the board summary (sourcer/qualifier/sender call this).
 * Additive: each call increments, so parallel agents compose correctly.
 */
export const bumpCounters = internalMutation({
  args: {
    runId: v.id("runs"),
    sourcedCount: v.optional(v.number()),
    qualifiedCount: v.optional(v.number()),
    contactedCount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    const patch: {
      sourcedCount?: number;
      qualifiedCount?: number;
      contactedCount?: number;
    } = {};
    if (args.sourcedCount !== undefined) {
      patch.sourcedCount = (run.sourcedCount ?? 0) + args.sourcedCount;
    }
    if (args.qualifiedCount !== undefined) {
      patch.qualifiedCount = (run.qualifiedCount ?? 0) + args.qualifiedCount;
    }
    if (args.contactedCount !== undefined) {
      patch.contactedCount = (run.contactedCount ?? 0) + args.contactedCount;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(args.runId, patch);
  },
});

/** Flip the run's terminal status. */
export const completeRun = internalMutation({
  args: {
    runId: v.id("runs"),
    status: runStatusValidator,
  },
  handler: async (ctx, { runId, status }): Promise<void> => {
    await ctx.db.patch(runId, { status });
  },
});

// ---------------------------------------------------------------------------
// SHARED-PHASE CACHE — different tracks for the SAME target redo identical
// upstream phases (company enrich/firmographics). We cache each phase result
// keyed by `${step}:${target}` with a short TTL so a second track for the same
// company reuses it instead of re-scraping + re-inferring. Best-effort: a miss
// (or a stale entry) just recomputes. Consumed by the enrich agent. (Competitor
// ad discovery is already cached separately via `adScanCache`.)
// ---------------------------------------------------------------------------
const STEP_CACHE_TTL_MS = Number(process.env.STEP_CACHE_TTL_MS) || 30 * 60_000; // 30 min default; local demo extends via env to match the run-reuse window

/** Build the `${step}:${target}` cache key with a normalized target. */
function stepCacheKey(step: string, target: string): string {
  return `${step}:${normalizeTarget(target)}`;
}

/** Read a fresh shared-phase result for (step, target), or null on miss/stale. */
export const getStepCache = internalQuery({
  args: { step: v.string(), target: v.string() },
  handler: async (ctx, { step, target }): Promise<unknown | null> => {
    const key = stepCacheKey(step, target);
    if (key.endsWith(":")) return null; // empty target — never cache
    const row = await ctx.db
      .query("stepCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row) return null;
    if (Date.now() - row.fetchedAt > STEP_CACHE_TTL_MS) return null;
    return row.value;
  },
});

/** Upsert a shared-phase result for (step, target). No-op on an empty target. */
export const putStepCache = internalMutation({
  args: { step: v.string(), target: v.string(), value: v.any() },
  handler: async (ctx, { step, target, value }): Promise<void> => {
    const key = stepCacheKey(step, target);
    if (key.endsWith(":")) return; // empty target — nothing to key on
    const normalized = normalizeTarget(target);
    const now = Date.now();
    const existing = await ctx.db
      .query("stepCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { value, fetchedAt: now });
    } else {
      await ctx.db.insert("stepCache", {
        key,
        step,
        target: normalized,
        value,
        fetchedAt: now,
      });
    }
  },
});
