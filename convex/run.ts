import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { AGENT_REGISTRY, AGENTS, CAPABILITY_PLANS } from "../lib/contract";
import type { Capability } from "../lib/contract";
import { upsertBrief } from "./brief";

// ============================================================================
// INTERCEPT — THE ORCHESTRATOR (plan-driven).
//
// Owns the live swarm board (agentStatus) and the hard fan-in deadline. The
// P1 finding: the brief + board MUST render regardless of slow/failed agents.
// So we schedule `finalize` at runs.deadlineAt as a guaranteed cap, AND call
// it early once the swarm settles. Whichever fires first wins; finalize is
// idempotent (it no-ops once the run leaves "running").
//
// The execution plan is no longer hardcoded — it comes from the routed
// capability: CAPABILITY_PLANS[run.intent] is an ordered list of phases, each a
// set of agents run in parallel (Promise.allSettled, so a straggler never blocks
// the rest). Different intents drive different rosters (analyze = full swarm,
// discovery = just the moat, outbound = sourcer→qualifier→writer, etc.).
//
// Agents persist their OWN results. The orchestrator only drives status +
// the deadline. It never touches communities/threads/drafts/creatives.
// ============================================================================

// BOARD agents get running -> done/failed transitions + a tile; silent agents
// (router, enrich, reply) run but never touch agentStatus. Sourced from the
// single registry so it can never drift from the contract.
const BOARD_AGENTS: ReadonlySet<string> = new Set<string>(
  AGENTS.filter((id) => AGENT_REGISTRY[id].board),
);

/** The ordered phase plan for a run's capability. */
function phasesForIntent(intent: Capability): ReadonlyArray<ReadonlyArray<string>> {
  return CAPABILITY_PLANS[intent] as ReadonlyArray<ReadonlyArray<string>>;
}

// Optional competitor reel for the watcher to tear down. There is no per-run
// reel source today, so this is configured out-of-band. When absent, the
// orchestrator marks the watcher "skipped" (honest) rather than a no-op "done".
function competitorReelUrl(): string | undefined {
  const raw = process.env.INTERCEPT_COMPETITOR_REEL_URL?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

// Per-agent extra arguments threaded into the agent's `run` action.
function agentArgs(name: string, run: Doc<"runs">): Record<string, unknown> {
  if (name === "watcher") {
    const reelUrl = competitorReelUrl();
    return reelUrl ? { reelUrl } : {};
  }
  // adsmith reads the run's AD FACTORY provenance: the dropped URL to replicate
  // (flow c) and/or the scanned ad a "Generate similar" run is grounded on (flow b).
  if (name === "adsmith") {
    const args: Record<string, unknown> = {};
    if (run.sourceUrl) args.sourceUrl = run.sourceUrl;
    if (run.groundedOnAdId) args.groundedOnAdId = run.groundedOnAdId;
    return args;
  }
  return {};
}

/**
 * Resolve a swarm agent's `run` action reference by name. Agents live in
 * separate worktrees and are wired in at merge; the dynamic lookup keeps this
 * module compiling and lets us fail gracefully if one isn't registered.
 */
function agentRunRef(name: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agents = (internal as any).agents;
  return agents?.[name]?.run;
}

/**
 * Run one agent with full isolation. Board agents get running -> done/failed
 * status transitions; non-board agents (reply) just run. Nothing thrown here
 * ever escapes — a single agent's failure must not abort the swarm.
 */
async function runAgent(
  ctx: ActionCtx,
  run: Doc<"runs">,
  name: string,
): Promise<void> {
  const runId: Id<"runs"> = run._id;
  const isBoard = BOARD_AGENTS.has(name);
  const extraArgs = agentArgs(name, run);

  // Honor skipVideo: a 24/7 monitor tick spawns the run with skipVideo=true so
  // the background swarm never burns Veo credits. Mark the creative lane
  // honestly "skipped" rather than rendering (or pretending it's "done").
  if (name === "creative" && run.skipVideo === true) {
    if (isBoard) {
      await ctx.runMutation(internal.runs.setAgentStatus, {
        runId,
        agent: name,
        status: "skipped",
        note: "video skipped on 24/7 monitor tick",
      });
    }
    return;
  }

  // The watcher only does real work given a competitor reel. With none, marking
  // it "done" would misrepresent an idle agent, so we mark it honestly skipped.
  if (name === "watcher" && extraArgs.reelUrl === undefined) {
    if (isBoard) {
      await ctx.runMutation(internal.runs.setAgentStatus, {
        runId,
        agent: name,
        status: "skipped",
        note: "no competitor reel configured",
      });
    }
    return;
  }

  if (isBoard) {
    await ctx.runMutation(internal.runs.setAgentStatus, {
      runId,
      agent: name,
      status: "running",
    });
  }

  try {
    const ref = agentRunRef(name);
    if (!ref) {
      throw new Error(`agent "${name}" is not registered`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.runAction(ref as any, { runId, ...extraArgs });

    if (isBoard) {
      await ctx.runMutation(internal.runs.setAgentStatus, {
        runId,
        agent: name,
        status: "done",
      });
    }
  } catch (error: unknown) {
    const note = error instanceof Error ? error.message : String(error);
    if (isBoard) {
      await ctx.runMutation(internal.runs.setAgentStatus, {
        runId,
        agent: name,
        status: "failed",
        note: note.slice(0, 500),
      });
    }
  }
}

/**
 * Drive the full swarm for a run. Schedules the deadline finalize up front (the
 * guarantee), runs the phases, then finalizes early. Even if this action dies
 * mid-flight, the scheduled finalize still completes the run.
 */
export const orchestrate = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<void> => {
    const run: Doc<"runs"> | null = await ctx.runQuery(
      internal.runs.getRunInternal,
      { runId },
    );
    if (!run) return;

    // Guaranteed cap: render from whatever exists at the deadline, no matter
    // what happens below.
    await ctx.scheduler.runAt(run.deadlineAt, internal.run.finalize, { runId });

    try {
      // The plan is the routed capability's phase list. run.intent is always one
      // of the six capabilities (schema-enforced), so the lookup is total.
      const phases = phasesForIntent(run.intent);
      for (const phase of phases) {
        await Promise.allSettled(
          phase.map((name) => runAgent(ctx, run, name)),
        );
      }
    } finally {
      // Early finalize: the swarm has settled, so don't make the demo wait out
      // the deadline. Idempotent — the scheduled finalize will no-op.
      await ctx.runMutation(internal.run.finalize, { runId });
    }
  },
});

/**
 * Fan-in. Idempotent and deadline-safe. Marks any agent still in flight as
 * "skipped", repairs/guarantees the brief, and flips the run to its terminal
 * status: complete (all board agents done), partial (some done), or failed
 * (none done). Runs as a mutation so the whole assembly is atomic.
 */
export const finalize = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<void> => {
    const run = await ctx.db.get(runId);
    if (!run) return;

    // Already finalized (early finish or a prior deadline fire) — do nothing.
    if (run.status !== "running") return;

    const rows = await ctx.db
      .query("agentStatus")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    // Anything not yet terminal at fan-in time is a casualty of the deadline.
    const now = Date.now();
    for (const row of rows) {
      if (row.status === "queued" || row.status === "running") {
        await ctx.db.patch(row._id, {
          status: "skipped",
          finishedAt: now,
          note: row.note ?? "skipped at fan-in deadline",
        });
      }
    }

    // Guarantee a brief exists so the board renders no matter what.
    await upsertBrief(ctx, { runId });

    // A "deadline casualty" = an agent still queued/running at fan-in (just
    // marked skipped above). An agent ALREADY skipped before the deadline (e.g.
    // the watcher with no competitor reel) was skipped on purpose and must NOT
    // downgrade an otherwise-clean run to "partial".
    const deadlineCasualties = rows.filter(
      (r) => r.status === "queued" || r.status === "running",
    ).length;
    const doneCount = rows.filter((r) => r.status === "done").length;
    const failedCount = rows.filter((r) => r.status === "failed").length;

    const status: "complete" | "partial" | "failed" =
      doneCount === 0
        ? "failed"
        : failedCount === 0 && deadlineCasualties === 0
          ? "complete"
          : "partial";

    await ctx.db.patch(runId, { status });

    // Compounding knowledge loop: schedule the best-effort INGEST as a follow-up
    // (a mutation scheduling an action is the standard Convex hand-off). This
    // runs ONCE per run — finalize early-returns above once status != "running",
    // so a re-fire (deadline + early finish) can't double-schedule. ingestFromRun
    // is fully guarded (returns { pages:0, facts:0 } on any failure) and never
    // touches run status, so this can never block or alter the run's outcome.
    await ctx.scheduler.runAfter(0, internal.knowledge.ingestFromRun, { runId });
  },
});
