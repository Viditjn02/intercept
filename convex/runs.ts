import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
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
  v.literal("social"),
  v.literal("onboarding"),
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

/**
 * Kick off a capability run. Inserts the run (status "running") with its routed
 * intent + trigger, queues one agentStatus row per BOARD agent for that intent,
 * links the spawning chat message (so the canvas keys off it), and schedules the
 * orchestrator. The fan-in deadline is hard: the board renders from whatever
 * exists at `deadlineAt`.
 */
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
  },
  handler: async (
    ctx,
    {
      intent,
      input,
      inputType,
      conversationId,
      messageId,
      campaignId,
      trigger,
      replay,
      skipVideo,
    },
  ): Promise<Id<"runs">> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new Error("createRun: input must not be empty");
    }

    const now = Date.now();
    const runId: Id<"runs"> = await ctx.db.insert("runs", {
      conversationId,
      messageId,
      campaignId,
      input: trimmed,
      inputType,
      intent,
      trigger,
      status: "running",
      startedAt: now,
      deadlineAt: now + FANIN_DEADLINE_MS,
      replay: replay ?? false,
      skipVideo,
    });

    // One queued board row per BOARD agent in this capability's plan. Silent
    // agents (router, enrich, reply) run but get no tile.
    const boardAgents = boardAgentsForIntent(intent as Capability);
    for (const agent of boardAgents) {
      await ctx.db.insert("agentStatus", {
        runId,
        agent,
        status: "queued",
      });
    }

    // Link the spawning chat message so the canvas can render this run's board.
    if (messageId) {
      await ctx.db.patch(messageId, { runId, intent });
    }

    // Hand off to the orchestrator. It owns agentStatus + the fan-in deadline.
    await ctx.scheduler.runAfter(0, internal.run.orchestrate, { runId });

    return runId;
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
