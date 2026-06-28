// ============================================================================
// INTERCEPT — OUTREACH (the AgentMail send beat)
// ----------------------------------------------------------------------------
// Sends a human-APPROVED in-thread reply as a real email / follow-up via
// AgentMail. This is the ONLY place a draft leaves the building, and it is
// gated twice:
//   1. The reply agent only ever writes drafts as "awaiting_approval".
//   2. A person approves it in ApprovalModal (drafts.status -> "approved").
//   3. ONLY THEN can sendApprovedDraft email it; on success the draft moves
//      "approved" -> "posted", which is the persisted "sent" log.
//
// HUMAN-APPROVED BEFORE SEND, ALWAYS. OFFICIAL APIs ONLY: the wire work is a
// plain fetch in lib/agentmail (Bearer ${AGENTMAIL_API_KEY}); no SDK/vendored
// source, no new deps. With no key it NO-OPs ({ sent:false }) and never throws,
// so it can never block the swarm or the approval flow.
//
// RUNTIME NOTE: this file is intentionally NOT a "use node" module — Convex
// forbids queries/mutations in "use node" files, and the public mutation + query
// must live HERE alongside the action (mirrors convex/agents/detective.ts). The
// AgentMail client in lib/* is fetch-based and runs in the default action runtime.
//
// The "sent" state is persisted on the existing `drafts` row (status "posted"),
// so no schema change is needed — the frozen schema already models
// approved -> posted as the terminal "it went out" state.
// ============================================================================

import { v } from "convex/values";
import { action, mutation, query, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sendMessage } from "../lib/agentmail";

interface DraftContext {
  draftId: Id<"drafts">;
  status: string;
  body: string;
  company?: string;
  thread: {
    title: string;
    url: string;
    snippet: string;
    platform: string;
    author?: string;
  } | null;
}

// ---------------------------------------------------------------------------
// READ: load the approved draft + its thread + the run's company, for framing
// the email. Internal — only the action calls it.
// ---------------------------------------------------------------------------
export const loadDraftContext = internalQuery({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }): Promise<DraftContext | null> => {
    const draft = await ctx.db.get(draftId);
    if (!draft) return null;

    const thread = await ctx.db.get(draft.threadId);
    const run = await ctx.db.get(draft.runId);

    return {
      draftId: draft._id,
      status: draft.status,
      body: draft.body,
      company: run?.company ?? undefined,
      thread: thread
        ? {
            title: thread.title,
            url: thread.url,
            snippet: thread.snippet,
            platform: thread.platform,
            author: thread.author ?? undefined,
          }
        : null,
    };
  },
});

// ---------------------------------------------------------------------------
// LOG (public mutation): record a successful send by moving the draft
// approved -> posted. Idempotent: a draft already "posted" stays posted. Refuses
// to mark anything that a human hasn't approved — the gate is enforced here too.
// ---------------------------------------------------------------------------
export const logSent = mutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) {
      throw new Error(`logSent: draft ${draftId} not found`);
    }
    if (draft.status === "posted") {
      return { draftId, status: "posted" as const, alreadyLogged: true };
    }
    if (draft.status !== "approved") {
      // Never log a send for an unapproved draft — protects the human gate.
      throw new Error(
        `logSent: refusing to mark ${draft.status} draft as posted (must be approved)`,
      );
    }
    await ctx.db.patch(draftId, { status: "posted" });
    return { draftId, status: "posted" as const, alreadyLogged: false };
  },
});

// ---------------------------------------------------------------------------
// Frame the approved reply as an in-thread follow-up email. Keeps the human's
// approved wording verbatim and adds light context (which live thread it answers).
// ---------------------------------------------------------------------------
function frameEmail(c: DraftContext): { subject: string; text: string } {
  const title = c.thread?.title?.trim() || "your question";
  const subject = `Re: ${title}`.slice(0, 180);

  const lines: string[] = [];
  if (c.thread?.author) {
    lines.push(`Hi ${c.thread.author},`, "");
  }
  lines.push(c.body.trim());
  if (c.thread?.url) {
    lines.push("", `In reply to the thread: ${c.thread.url}`);
  }
  if (c.company) {
    lines.push("", `— sent on behalf of ${c.company} (human-reviewed before send)`);
  }
  return { subject, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// ACTION (public): send the human-approved draft via AgentMail.
// Integrator mounts this on the approval flow (e.g. after Approve, or from the
// OutreachButton). Never throws — degrades to { sent:false, reason } so the UI
// and the run are never blocked.
// ---------------------------------------------------------------------------
export const sendApprovedDraft = action({
  args: { draftId: v.id("drafts") },
  handler: async (
    ctx,
    { draftId },
  ): Promise<{ sent: boolean; id?: string; alreadySent?: boolean; reason?: string }> => {
    try {
      const context = await ctx.runQuery(internal.outreach.loadDraftContext, {
        draftId,
      });
      if (!context) {
        return { sent: false, reason: "Draft not found." };
      }

      // Idempotent: already sent.
      if (context.status === "posted") {
        return { sent: true, alreadySent: true };
      }

      // HARD GATE: only a human-approved draft may be sent.
      if (context.status !== "approved") {
        return {
          sent: false,
          reason: "Draft must be human-approved before it can be sent.",
        };
      }

      const { subject, text } = frameEmail(context);
      const result = await sendMessage({ subject, text });

      if (!result.sent) {
        // No key / API error -> silent no-op for the caller, with a reason for the UI.
        return { sent: false, reason: result.reason ?? "AgentMail did not send the message." };
      }

      // Persist the send by advancing the draft to "posted".
      await ctx.runMutation(api.outreach.logSent, { draftId });
      return { sent: true, id: result.id };
    } catch (err: unknown) {
      // Belt-and-suspenders: never let outreach throw into the approval flow.
      return {
        sent: false,
        reason: err instanceof Error ? err.message : "Outreach failed unexpectedly.",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// QUERY (public): reactive outreach status for a draft. `sent` is derived from
// the persisted draft status ("posted" === emailed via AgentMail).
// ---------------------------------------------------------------------------
export const outreachStatus = query({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) return null;
    return {
      draftId: draft._id,
      status: draft.status,
      sent: draft.status === "posted",
      approved: draft.status === "approved" || draft.status === "posted",
    };
  },
});
