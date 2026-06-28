// ============================================================================
// INTERCEPT — CREATIVE AGENT (Veo video ad)
//
// Kicked EARLY by the orchestrator so the ~73s Veo render lands before the
// fan-in deadline. It reads whatever the swarm has produced so far (brief,
// company, and the buyers' own language from `threads` — the moat) and turns
// that into a short, cinematic ad prompt, then calls lib/veo.generateAd.
//
// Persistence is owned by THIS file (per the swarm convention): a single
// `video` row in `creatives`, flipped rendering -> done(+url) | failed. The
// agent NEVER throws past its own handler — a failed render must never block
// the run (the brief renders regardless of the creative).
//
// NOTE: this file is intentionally NOT "use node". It defines internalMutation
// + internalQuery alongside the action (Convex forbids mutations/queries in a
// "use node" module). lib/veo.generateAd performs its HTTP work via fetch, so
// it runs fine in the default Convex action runtime.
//
// Expected contract from lib/veo.ts (owned by the clients lane):
//   export interface GenerateAdInput { prompt: string; aspectRatio?: string; durationSeconds?: number }
//   export interface GenerateAdResult { url: string; model?: string }
//   export function generateAd(input: GenerateAdInput): Promise<GenerateAdResult>
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_THREADS } from "../../lib/contract";
import { generateAd } from "../../lib/veo";

const VEO_MODEL = "veo-3.1-fast";
const AD_ASPECT_RATIO = "9:16"; // vertical — built for the feeds the buyers live in
const AD_DURATION_SECONDS = 8;

// ----------------------------------------------------------------------------
// READ: gather everything the swarm has produced so far for this run.
// Tolerant by design — creative is kicked early, so brief/threads may be empty.
// ----------------------------------------------------------------------------
export const context = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    const brief = await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .take(MAX_THREADS);
    // Optional competitor-reel insight produced by the watcher agent.
    const creatives = await ctx.db
      .query("creatives")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const reelInsight = creatives.find((c) => c.kind === "reel-analysis");

    return {
      company: run?.company ?? run?.input ?? "the company",
      input: run?.input ?? "",
      icp: brief?.icp ?? "",
      positioning: brief?.positioning ?? "",
      threads: threads.map((t) => ({
        title: t.title,
        snippet: t.snippet,
        intentLabel: t.intentLabel,
      })),
      reelInsight: reelInsight?.prompt ?? null,
    };
  },
});

// ----------------------------------------------------------------------------
// WRITE: upsert the single `video` creative row for this run.
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.literal("pending"),
      v.literal("rendering"),
      v.literal("done"),
      v.literal("failed"),
    ),
    prompt: v.string(),
    model: v.string(),
    url: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const existing = (
      await ctx.db
        .query("creatives")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect()
    ).find((c) => c.kind === "video");

    const fields = {
      kind: "video" as const,
      status: args.status,
      prompt: args.prompt,
      model: args.model,
      url: args.url,
      storageId: args.storageId,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("creatives", { runId: args.runId, ...fields });
  },
});

// ----------------------------------------------------------------------------
// ACTION: build the prompt, render the ad, persist. Never blocks the run.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const data = await ctx.runQuery(internal.agents.creative.context, { runId });
    const prompt = buildAdPrompt(data);

    // Mark rendering immediately so the live board reflects the early kick.
    await ctx.runMutation(internal.agents.creative.save, {
      runId,
      status: "rendering",
      prompt,
      model: VEO_MODEL,
    });

    try {
      const result = await generateAd({
        prompt,
        aspectRatio: AD_ASPECT_RATIO,
        durationSeconds: AD_DURATION_SECONDS,
      });

      // lib/veo returns { url: undefined } (no throw) on poll-timeout / no video.
      // Mark failed so the panel shows a clear state instead of an endless spinner.
      if (!result.url) {
        await ctx.runMutation(internal.agents.creative.save, {
          runId,
          status: "failed",
          prompt,
          model: result.model ?? VEO_MODEL,
        });
        return;
      }

      // Persist the asset to Convex File Storage (SSRF-guarded, "use node").
      // Storage failure never blocks the run — the external Veo URL is the fallback.
      let storageId: Id<"_storage"> | undefined;
      try {
        const stored = await ctx.runAction(internal.storage.storeFromUrl, {
          url: result.url,
        });
        storageId = stored.storageId;
      } catch {
        storageId = undefined;
      }

      await ctx.runMutation(internal.agents.creative.save, {
        runId,
        status: "done",
        prompt,
        model: result.model ?? VEO_MODEL,
        url: result.url,
        storageId,
      });
    } catch (error) {
      // Render failed — record it and return cleanly. The fan-in still ships
      // the brief; the creative is simply marked failed on the board.
      await ctx.runMutation(internal.agents.creative.save, {
        runId,
        status: "failed",
        prompt,
        model: VEO_MODEL,
      });
    }
  },
});

// ----------------------------------------------------------------------------
// Prompt construction — turn brief + buyers' own language into a Veo ad.
// ----------------------------------------------------------------------------
interface AdContext {
  company: string;
  input: string;
  icp: string;
  positioning: string;
  threads: { title: string; snippet: string; intentLabel: string }[];
  reelInsight: string | null;
}

function buildAdPrompt(data: AdContext): string {
  const { company, icp, positioning, threads, reelInsight } = data;

  // Surface the highest-intent buyer language first — it's the most authentic
  // hook material we have.
  const intentRank: Record<string, number> = {
    ready_to_buy: 3,
    frustrated: 2,
    comparing: 1,
    browsing: 0,
  };
  const buyerVoice = [...threads]
    .sort((a, b) => (intentRank[b.intentLabel] ?? 0) - (intentRank[a.intentLabel] ?? 0))
    .slice(0, 3)
    .map((t) => t.title.trim())
    .filter(Boolean);

  const painLine =
    buyerVoice.length > 0
      ? `Open on the real frustration buyers voice in their own words: ${buyerVoice
          .map((v) => `"${v}"`)
          .join("; ")}.`
      : `Open on the everyday frustration that ${icp || "the target buyer"} feels before discovering a fix.`;

  const positioningLine =
    positioning.trim().length > 0
      ? `Resolve the tension by revealing ${company} as the answer: ${positioning.trim()}.`
      : `Resolve the tension by revealing ${company} as the clear, modern answer.`;

  const audienceLine = icp.trim().length > 0 ? `The hero is ${icp.trim()}.` : "";

  const styleLine = reelInsight
    ? `Match the winning energy of high-performing competitor reels — ${reelInsight.trim()}`
    : "Punchy, high-contrast, modern tech-brand energy with confident motion and crisp typography.";

  return [
    `A ${AD_DURATION_SECONDS}-second vertical (${AD_ASPECT_RATIO}) cinematic product ad for ${company}.`,
    painLine,
    audienceLine,
    positioningLine,
    `Cinematography: ${styleLine}`,
    "Bright, premium lighting; smooth camera push-ins; a single clear emotional beat from problem to relief.",
    `End on a bold, legible end-card with the name "${company}" and a confident call to action.`,
    "No watermarks, no gibberish text, no logos other than the end-card name.",
  ]
    .filter((line) => line && line.trim().length > 0)
    .join(" ");
}
