// ============================================================================
// INTERCEPT — WATCHER AGENT (competitor reel teardown)
//
// Optional / "if-ahead" agent. Given a competitor reel (video) URL, it calls
// lib/gemini.analyzeReel to extract the structured hook / pacing / cta, then
// stores that teardown as a self-contained note. The creative agent reads this
// note (by `kind === "reel-analysis"`) to match the winning energy of proven
// competitor ads when it builds the Veo prompt.
//
// Self-contained: this file owns its own persistence (`save`). It never touches
// agentStatus (the orchestrator owns the board) and never throws past its
// handler — a missing reel URL or a failed analysis must not block the run.
//
// We persist into the frozen `creatives` table with a distinct, non-"video"
// kind ("reel-analysis") so the video board (which renders kind === "video")
// is unaffected. The structured teardown lives in the `prompt` field as a
// human-readable note; `url` holds the analyzed reel.
//
// Expected contract from lib/gemini.ts (owned by the clients lane):
//   export interface ReelAnalysis {
//     hook: string;          // the first-2-seconds attention grab
//     pacing: string;        // edit rhythm / shot cadence
//     cta: string;           // closing call to action
//     visualStyle?: string;  // optional look-and-feel notes
//   }
//   export function analyzeReel(reelUrl: string): Promise<ReelAnalysis>
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { analyzeReel } from "../../lib/gemini";

const GEMINI_MODEL = "gemini-2.5-flash";

// ----------------------------------------------------------------------------
// WRITE: upsert the single `reel-analysis` note row for this run.
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    note: v.string(),
    reelUrl: v.string(),
    status: v.union(v.literal("done"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    const existing = (
      await ctx.db
        .query("creatives")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect()
    ).find((c) => c.kind === "reel-analysis");

    const fields = {
      kind: "reel-analysis" as const,
      status: args.status,
      model: GEMINI_MODEL,
      prompt: args.note,
      url: args.reelUrl,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("creatives", { runId: args.runId, ...fields });
  },
});

// ----------------------------------------------------------------------------
// ACTION: analyze the competitor reel and store the teardown. Never blocks.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: {
    runId: v.id("runs"),
    reelUrl: v.optional(v.string()),
  },
  handler: async (ctx, { runId, reelUrl }) => {
    // Nothing to analyze — the watcher is opportunistic, so just bow out.
    if (!reelUrl || reelUrl.trim().length === 0) return;
    const url = reelUrl.trim();

    try {
      const analysis = await analyzeReel(url);
      await ctx.runMutation(internal.agents.watcher.save, {
        runId,
        note: formatNote(analysis),
        reelUrl: url,
        status: "done",
      });
    } catch (error) {
      await ctx.runMutation(internal.agents.watcher.save, {
        runId,
        note: `Reel analysis failed: ${getErrorMessage(error)}`,
        reelUrl: url,
        status: "failed",
      });
    }
  },
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
interface ReelAnalysisShape {
  hook: string;
  pacing: string;
  cta: string;
  visualStyle?: string;
}

function formatNote(analysis: ReelAnalysisShape): string {
  const parts = [
    `Hook: ${analysis.hook}`,
    `Pacing: ${analysis.pacing}`,
    `CTA: ${analysis.cta}`,
  ];
  if (analysis.visualStyle && analysis.visualStyle.trim().length > 0) {
    parts.push(`Visual style: ${analysis.visualStyle.trim()}`);
  }
  return parts.join(" | ");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "unexpected error";
}
