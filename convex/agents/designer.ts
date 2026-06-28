// ============================================================================
// INTERCEPT — DESIGNER AGENT (AI Ad Factories: in-house design generation)
//
// Reads the GTM brief (icp + positioning) and the buyers' OWN language from the
// top moat threads, then calls lib/design.generateLanding to produce a
// brand-consistent, single-file campaign landing page + three ad-copy headline
// variants. Persistence is owned by THIS file (per the swarm convention): two
// rows in `designs` — kind "landing" (html) and kind "ad_copy" (copy).
//
// The agent NEVER throws past its own handler — a failed generation must not
// block the run. lib/design degrades to an on-brief static page when there's no
// OPENAI_API_KEY, so this always writes something real to the board.
//
// NOTE: intentionally NOT "use node" — it defines internalMutation + query
// alongside the action (Convex forbids mutations/queries in a "use node"
// module). lib/openai is fetch-based and runs in the default action runtime.
// ============================================================================

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id, Doc } from "../_generated/dataModel";
import { MAX_THREADS } from "../../lib/contract";
import { generateLanding } from "../../lib/design";

// ----------------------------------------------------------------------------
// READ: gather the brief + the buyers' own language for this run.
// Tolerant by design — if the brief/threads are missing we still generate.
// ----------------------------------------------------------------------------
interface DesignerContext {
  company: string;
  icp: string;
  positioning: string;
  buyerLanguage: string[];
}

export const context = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<DesignerContext> => {
    const run = await ctx.db.get(runId);
    const brief = await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    // Highest-intent threads first — their titles/snippets are the most
    // authentic "buyer language" we have to mirror in the copy.
    const intentRank: Record<string, number> = {
      ready_to_buy: 3,
      frustrated: 2,
      comparing: 1,
      browsing: 0,
    };
    const buyerLanguage = [...threads]
      .sort(
        (a, b) =>
          (intentRank[b.intentLabel] ?? 0) - (intentRank[a.intentLabel] ?? 0) ||
          b.intentScore - a.intentScore,
      )
      .slice(0, MAX_THREADS)
      .map((t) => t.title.trim())
      .filter(Boolean);

    return {
      company: run?.company ?? run?.input ?? "the company",
      icp: brief?.icp ?? "",
      positioning: brief?.positioning ?? "",
      buyerLanguage,
    };
  },
});

// ----------------------------------------------------------------------------
// WRITE: upsert one design row of a given kind ("landing" | "ad_copy").
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    kind: v.string(),
    title: v.string(),
    html: v.optional(v.string()),
    copy: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"designs">> => {
    const existing = (
      await ctx.db
        .query("designs")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect()
    ).find((d) => d.kind === args.kind);

    const fields = {
      kind: args.kind,
      title: args.title,
      html: args.html,
      copy: args.copy,
      generatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("designs", { runId: args.runId, ...fields });
  },
});

// ----------------------------------------------------------------------------
// ACTION: build the design from the brief + buyer language, persist. Never blocks.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<void> => {
    const data: DesignerContext = await ctx.runQuery(
      internal.agents.designer.context,
      { runId },
    );

    try {
      const result = await generateLanding({
        company: data.company,
        icp: data.icp,
        positioning: data.positioning,
        buyerLanguage: data.buyerLanguage,
      });

      // Landing page (html) and ad copy (copy) land as two separate rows so the
      // panel can render the iframe and the variants independently.
      await ctx.runMutation(internal.agents.designer.save, {
        runId,
        kind: "landing",
        title: result.title,
        html: result.html,
      });
      await ctx.runMutation(internal.agents.designer.save, {
        runId,
        kind: "ad_copy",
        title: `${data.company} — ad copy variants`,
        copy: result.copy,
      });
    } catch {
      // Should be unreachable (generateLanding never throws), but stay safe:
      // the run must finalize regardless of the design lane.
    }
  },
});

// ----------------------------------------------------------------------------
// PUBLIC QUERY: the run's generated designs (reactive — drives DesignPanel).
// ----------------------------------------------------------------------------
export const designsForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"designs">[]> => {
    return await ctx.db
      .query("designs")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
  },
});
