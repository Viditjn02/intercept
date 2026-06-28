import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// ============================================================================
// INTERCEPT — ADS (competitor ad intelligence, read side)
//
// Populated by the adscout agent (token-free multi-platform scan). The board
// reads this reactively via components/AdGallery.tsx. Rows arrive ranked, but we
// sort here too (scalingSignal → perfScore → active → longevity) so the read is
// self-consistent regardless of insert order.
// ============================================================================

/** Read all of a run's competitor ads, ranked winning-first (reactive). */
export const listByRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"ads">[]> => {
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    return ads.sort((a, b) => {
      // Scaling winners (active + long-running) first.
      const scaleA = a.scalingSignal ? 1 : 0;
      const scaleB = b.scalingSignal ? 1 : 0;
      if (scaleA !== scaleB) return scaleB - scaleA;
      // Then by performance score (when scored).
      const perfA = a.perfScore ?? -1;
      const perfB = b.perfScore ?? -1;
      if (perfA !== perfB) return perfB - perfA;
      // Then active ahead of ended.
      if (a.status !== b.status) {
        if (a.status === "active") return -1;
        if (b.status === "active") return 1;
      }
      // Finally by longevity.
      return (b.daysRunning ?? 0) - (a.daysRunning ?? 0);
    });
  },
});
