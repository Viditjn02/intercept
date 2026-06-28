// ============================================================================
// INTERCEPT — REEL MAKER AGENT  ·  TRACK 1 (algorithm hacking / virality)
// ----------------------------------------------------------------------------
// The short-video beat of the social lane. Reads the brief + the top trend the
// scout surfaced, builds a MoneyPrinterTurbo-style segmented vertical script
// (convex/virality/reelScript: hook → 3 beats → CTA), and renders a 9:16 reel
// via lib/veo.generateAd (PRIMARY Veo → FALLBACK open-source fal LTX-Video).
//
// The reel REUSES the `creatives` table with kind "social_video" (kind is a free
// string) so it never collides with the content lane's "video" row. Runs in
// PARALLEL with the composer, so it reads only the brief + trends (already
// produced by enrich + trendscout, the prior phases).
//
// Self-contained: owns its read query, write mutation, and a PUBLIC `reelForRun`
// query the canvas reads. NEVER throws past its handler — a render failure marks
// the row "failed" so the panel shows a clear state, and the fan-in still ships.
//
// RUNTIME: NOT "use node" — co-locates query + mutation with the action.
// lib/veo runs its HTTP work via fetch in the default Convex runtime.
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { generateAd } from "../../lib/veo";
import { renderVideo } from "../../lib/videoWorker";
import { buildReelScript } from "../virality/reelScript";

const REEL_KIND = "social_video";
const REEL_MODEL = "veo-3.1-fast";
const REEL_ASPECT = "9:16";
const REEL_DURATION_SECONDS = 8;

// ----------------------------------------------------------------------------
// READ: brief + top trend for this run (the reel's raw material).
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
    const top = trends.sort((a, b) => b.score - a.score)[0];
    return {
      replay: run?.replay === true,
      company: run?.company ?? run?.input ?? "the company",
      positioning: brief?.positioning ?? "",
      topic: top?.topic ?? "",
      angle: top?.angle ?? "",
    };
  },
});

// ----------------------------------------------------------------------------
// WRITE: upsert the single "social_video" creative row for this run.
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
  handler: async (ctx, args): Promise<Id<"creatives">> => {
    const existing = (
      await ctx.db
        .query("creatives")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect()
    ).find((c) => c.kind === REEL_KIND);

    const fields = {
      kind: REEL_KIND,
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
// PUBLIC READ: the reel creative for a run (or null). The canvas renders it as
// a vertical <video>.
// ----------------------------------------------------------------------------
export const reelForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"creatives"> | null> => {
    const rows = await ctx.db
      .query("creatives")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return rows.find((c) => c.kind === REEL_KIND) ?? null;
  },
});

// ----------------------------------------------------------------------------
// ACTION: build the reel script, render, persist. Never blocks the run.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<void> => {
    const data = await ctx.runQuery(internal.agents.reelmaker.context, { runId });
    if (data.replay) return; // replay: reel pre-seeded

    const script = buildReelScript({
      company: data.company,
      topic: data.topic || `what's trending for ${data.company}`,
      angle: data.angle || `why ${data.company} matters now`,
      positioning: data.positioning,
    });

    await ctx.runMutation(internal.agents.reelmaker.save, {
      runId,
      status: "rendering",
      prompt: script.prompt,
      model: REEL_MODEL,
    });
    await logEvent(ctx, runId, "rendered", `Rendering a vertical reel for ${data.company}…`);

    // FREE MoneyPrinter path FIRST (Pexels stock + Edge-TTS + ffmpeg via the
    // local worker). $0 — no Veo/fal billing. If the worker is unreachable it
    // no-ops fast and we fall through to the Veo chain below.
    const free = await tryFreeWorker(ctx, runId, {
      topic: data.topic || `what's trending for ${data.company}`,
      scenes: [script.hook, ...script.beats, script.cta],
    });
    if (free) {
      await ctx.runMutation(internal.agents.reelmaker.save, {
        runId,
        status: "done",
        prompt: script.prompt,
        model: free.model,
        url: free.url,
        storageId: free.storageId,
      });
      await logEvent(ctx, runId, "rendered", `Reel ready (free ${free.model}).`);
      return;
    }

    try {
      const result = await generateAd({
        prompt: script.prompt,
        aspectRatio: REEL_ASPECT,
        durationSeconds: REEL_DURATION_SECONDS,
      });

      if (!result.url) {
        // lib/veo returns { url: undefined } (no throw) on missing key / timeout.
        await ctx.runMutation(internal.agents.reelmaker.save, {
          runId,
          status: "failed",
          prompt: script.prompt,
          model: result.model ?? REEL_MODEL,
        });
        await logEvent(
          ctx,
          runId,
          "rendered",
          "Reel render unavailable on this key — the posts + calendar are unaffected.",
        );
        return;
      }

      // Persist the asset to Convex File Storage (best-effort; URL is the fallback).
      let storageId: Id<"_storage"> | undefined;
      try {
        const stored = await ctx.runAction(internal.storage.storeFromUrl, {
          url: result.url,
        });
        storageId = stored.storageId;
      } catch {
        storageId = undefined;
      }

      await ctx.runMutation(internal.agents.reelmaker.save, {
        runId,
        status: "done",
        prompt: script.prompt,
        model: result.model ?? REEL_MODEL,
        url: result.url,
        storageId,
      });
      await logEvent(ctx, runId, "rendered", `Reel ready (${result.model ?? REEL_MODEL}).`);
    } catch {
      await ctx.runMutation(internal.agents.reelmaker.save, {
        runId,
        status: "failed",
        prompt: script.prompt,
        model: REEL_MODEL,
      });
      await logEvent(ctx, runId, "rendered", "Reel render failed.");
    }
  },
});

// ----------------------------------------------------------------------------
// FREE video worker bridge (MoneyPrinter path). Renders via the local worker,
// stores the returned MP4 bytes into Convex storage, and returns the asset.
// Returns null (never throws) when the worker is down / degrades — the caller
// then falls back to the Veo chain. The free path costs $0.
// ----------------------------------------------------------------------------
async function tryFreeWorker(
  ctx: ActionCtx,
  runId: Id<"runs">,
  input: { topic: string; scenes: string[] },
): Promise<{ url?: string; storageId?: Id<"_storage">; model: string } | null> {
  try {
    const result = await renderVideo({
      topic: input.topic,
      scenes: input.scenes,
      aspectRatio: REEL_ASPECT,
      durationSeconds: REEL_DURATION_SECONDS,
    });
    if (!result.ok || !result.videoBase64) return null;

    const stored = await ctx.runAction(internal.storage.storeFromBase64, {
      base64: result.videoBase64,
      contentType: result.contentType ?? "video/mp4",
    });
    return {
      url: stored.url ?? result.url,
      storageId: stored.storageId,
      model: result.model,
    };
  } catch {
    return null; // any failure → fall back to Veo
  }
}

// ----------------------------------------------------------------------------
// Live-feed helper. Best-effort — never blocks the reelmaker lane.
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
      agent: "reelmaker",
      kind,
      message,
    });
  } catch {
    // ignore — the feed is additive
  }
}
