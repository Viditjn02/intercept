import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ============================================================================
// INTERCEPT — DRAFTS (the human-approval gate)
//
// Drafts are created by the reply agent as "awaiting_approval". Nothing is ever
// auto-posted: a person reviews each draft in components/ApprovalModal.tsx and
// explicitly approves/rejects it. That UI calls api.drafts.setStatus.
// ============================================================================

/**
 * Move a draft to a human-decided status. The reply agent only ever writes
 * "awaiting_approval"; this mutation is the ONLY way a draft becomes
 * approved / rejected / posted — always behind an explicit human action.
 */
export const setStatus = mutation({
  args: {
    draftId: v.id("drafts"),
    status: v.union(
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("posted"),
    ),
  },
  handler: async (ctx, { draftId, status }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) {
      throw new Error(`setStatus: draft ${draftId} not found`);
    }
    // State-machine guard: a draft can only move awaiting_approval -> approved|rejected,
    // then approved -> posted. Blocks re-flipping terminal drafts or skipping the gate.
    //
    // SECURITY (no-auth demo): this mutation is PUBLIC and has no ownership check, so
    // it is an IDOR by design for the single-tenant hackathon build — there are no
    // users/tenants, and the approval gate is a UX control, not a security boundary.
    // Production MUST authenticate the caller and verify they own draft.runId here.
    const allowedTransitions: Record<string, ReadonlyArray<string>> = {
      awaiting_approval: ["approved", "rejected"],
      approved: ["posted"],
      rejected: [],
      posted: [],
    };
    if (!allowedTransitions[draft.status]?.includes(status)) {
      throw new Error(
        `setStatus: illegal transition ${draft.status} -> ${status}`,
      );
    }
    await ctx.db.patch(draftId, { status });
    return { draftId, status };
  },
});

/** Read all drafts for a run (reactive). Mirrors api.brief.getDrafts. */
export const listByRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    return await ctx.db
      .query("drafts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
  },
});
