import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// ============================================================================
// INTERCEPT — ADS (competitor ad intelligence, read side)
//
// Populated by the adscout agent from the Meta Ad Library. The board reads this
// reactively via components/CompetitorAds.tsx. Rows arrive ranked by longevity
// (longest-running = a proven winning angle) but we sort here too so the read
// is self-consistent regardless of insert order.
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
      if (a.status !== b.status) {
        if (a.status === "active") return -1;
        if (b.status === "active") return 1;
      }
      return (b.daysRunning ?? 0) - (a.daysRunning ?? 0);
    });
  },
});
