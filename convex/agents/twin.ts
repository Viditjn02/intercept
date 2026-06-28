// ============================================================================
// INTERCEPT — TWIN AGENT  (TRACK 2 · sales cyborgs / digital twin)
// ----------------------------------------------------------------------------
// Runs a prospect's DIGITAL TWIN (convex/sales/simulator) over each drafted
// outbound email BEFORE send: predicts the buyer's reply, surfaces objections,
// and scores reply-likelihood — then can rewrite the draft to address the
// critique. Persists each result to `simulations` (one row per email, latest
// wins) so the PitchLab canvas renders it reactively.
//
// Wired two ways, both ADDITIVE and graceful:
//   • internal `run`     — scheduled by the writer after it drafts (pre-send sim)
//   • public actions     — PitchLab's "simulate / improve" buttons
//
// The simulator NEVER throws (heuristic fallback with no OPENAI_API_KEY), and
// every handler here swallows its own failures — it can never block the swarm.
//
// DEPLOY-SAFETY: default runtime (OpenAI SDK is fetch-based, like the other
// agents) — NOT "use node". Same-module ctx.runMutation refs are explicitly
// typed; every handler has an explicit return type.
// ============================================================================

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  query,
} from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { CampaignBrief, EnrichedProspect } from "../../lib/contract";
import { simulateEmail, rewriteEmail } from "../sales/simulator";

// What PitchLab reads: the simulation joined to its email for one-tap context.
export interface SimulationView {
  _id: Id<"simulations">;
  emailId: Id<"emails">;
  prospectId: Id<"prospects">;
  subject: string;
  body: string;
  to?: string;
  emailStatus: string;
  prospectName?: string;
  prospectCompany?: string;
  replyLikelihood: number;
  sentiment: string;
  predictedReply: string;
  objections: string[];
  suggestions: string[];
  score: number;
  model: string;
  createdAt: number;
}

// ----------------------------------------------------------------------------
// INTERNAL: scheduled by the writer once it has drafted the run's outreach.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ simulated: number }> => {
    const simulated = await simulateAllDrafts(ctx, runId);
    return { simulated };
  },
});

// ----------------------------------------------------------------------------
// PUBLIC: PitchLab "Run pre-send simulation" — simulate every draft in the run.
// ----------------------------------------------------------------------------
export const simulateRun = action({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ simulated: number }> => {
    const simulated = await simulateAllDrafts(ctx, runId);
    return { simulated };
  },
});

// ----------------------------------------------------------------------------
// PUBLIC: PitchLab "Re-simulate" — re-run the twin on one email's current draft.
// ----------------------------------------------------------------------------
export const simulateOne = action({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }): Promise<{ ok: boolean; score: number }> => {
    const email: Doc<"emails"> | null = await ctx.runQuery(
      internal.emails.getInternal,
      { emailId },
    );
    if (!email || !email.runId) return { ok: false, score: 0 };

    const prospect: Doc<"prospects"> | null = await ctx.runQuery(
      internal.prospects.getInternal,
      { prospectId: email.prospectId },
    );
    const brief = await loadBrief(ctx, email.runId);
    const sim = await simulateEmail({
      prospect: toProspect(prospect),
      email: { subject: email.subject, body: email.body },
      brief,
    });
    await persist(ctx, email.runId, email._id, email.prospectId, sim);
    return { ok: true, score: sim.score };
  },
});

// ----------------------------------------------------------------------------
// PUBLIC: PitchLab "Improve draft" — critique → grounded rewrite → re-score.
// Rewrites the email body in place (only while it's still a draft) and persists
// the new simulation. Returns before/after scores for the UI to celebrate.
// ----------------------------------------------------------------------------
export const improve = action({
  args: { emailId: v.id("emails") },
  handler: async (
    ctx,
    { emailId },
  ): Promise<{ ok: boolean; before: number; after: number; reason?: string }> => {
    const email: Doc<"emails"> | null = await ctx.runQuery(
      internal.emails.getInternal,
      { emailId },
    );
    if (!email || !email.runId) {
      return { ok: false, before: 0, after: 0, reason: "Email not found." };
    }
    if (email.status !== "draft") {
      return { ok: false, before: 0, after: 0, reason: "Only drafts can be improved." };
    }

    const prospect: Doc<"prospects"> | null = await ctx.runQuery(
      internal.prospects.getInternal,
      { prospectId: email.prospectId },
    );
    const brief = await loadBrief(ctx, email.runId);
    const baseArgs = {
      prospect: toProspect(prospect),
      email: { subject: email.subject, body: email.body },
      brief,
    };

    const before = await simulateEmail(baseArgs);
    const rewrite = await rewriteEmail(baseArgs, before);

    // No-op rewrite (no key / unchanged) — re-persist the current sim, no edit.
    const changed = rewrite.subject !== email.subject || rewrite.body !== email.body;
    if (!changed) {
      await persist(ctx, email.runId, email._id, email.prospectId, before);
      return { ok: false, before: before.score, after: before.score, reason: "No rewrite available (LLM offline)." };
    }

    await ctx.runMutation(internal.agents.twin.patchEmailBody, {
      emailId: email._id,
      subject: rewrite.subject,
      body: rewrite.body,
    });
    const after = await simulateEmail({ ...baseArgs, email: { subject: rewrite.subject, body: rewrite.body } });
    await persist(ctx, email.runId, email._id, email.prospectId, after);

    await safeLog(ctx, {
      runId: email.runId,
      prospectId: email.prospectId,
      message: `Twin rewrote outreach to ${prospect?.name ?? prospect?.company ?? "prospect"} · reply-likelihood ${before.score} → ${after.score}`,
    });

    return { ok: true, before: before.score, after: after.score };
  },
});

// ----------------------------------------------------------------------------
// PUBLIC READ: simulations for a run, joined to their emails, best score first.
// ----------------------------------------------------------------------------
export const simulationsForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<SimulationView[]> => {
    const sims = await ctx.db
      .query("simulations")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    const views: SimulationView[] = [];
    for (const s of sims) {
      const email = await ctx.db.get(s.emailId);
      const prospect = await ctx.db.get(s.prospectId);
      views.push({
        _id: s._id,
        emailId: s.emailId,
        prospectId: s.prospectId,
        subject: email?.subject ?? "(draft removed)",
        body: email?.body ?? "",
        to: email?.to,
        emailStatus: email?.status ?? "draft",
        prospectName: prospect?.name,
        prospectCompany: prospect?.company,
        replyLikelihood: s.replyLikelihood,
        sentiment: s.sentiment,
        predictedReply: s.predictedReply,
        objections: s.objections,
        suggestions: s.suggestions,
        score: s.score,
        model: s.model,
        createdAt: s.createdAt,
      });
    }
    return views.sort((a, b) => b.score - a.score);
  },
});

// ----------------------------------------------------------------------------
// INTERNAL WRITES (actions persist through these — they own the `simulations`
// table and the in-place draft edit).
// ----------------------------------------------------------------------------
export const record = internalMutation({
  args: {
    runId: v.id("runs"),
    emailId: v.id("emails"),
    prospectId: v.id("prospects"),
    replyLikelihood: v.number(),
    sentiment: v.string(),
    predictedReply: v.string(),
    objections: v.array(v.string()),
    suggestions: v.array(v.string()),
    score: v.number(),
    model: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    // Latest wins: clear any prior simulation for this email.
    const prior = await ctx.db
      .query("simulations")
      .withIndex("by_email", (q) => q.eq("emailId", args.emailId))
      .collect();
    for (const p of prior) await ctx.db.delete(p._id);

    await ctx.db.insert("simulations", {
      runId: args.runId,
      emailId: args.emailId,
      prospectId: args.prospectId,
      replyLikelihood: args.replyLikelihood,
      sentiment: args.sentiment,
      predictedReply: args.predictedReply,
      objections: args.objections,
      suggestions: args.suggestions,
      score: args.score,
      model: args.model,
      createdAt: Date.now(),
    });
  },
});

export const patchEmailBody = internalMutation({
  args: { emailId: v.id("emails"), subject: v.string(), body: v.string() },
  handler: async (ctx, { emailId, subject, body }): Promise<void> => {
    const email = await ctx.db.get(emailId);
    if (!email || email.status !== "draft") return; // never touch a sent email
    await ctx.db.patch(emailId, { subject: subject.slice(0, 200), body });
  },
});

// ============================================================================
// SHARED HELPERS
// ============================================================================

/** Simulate every step-0 draft in the run that's still pending approval/send. */
async function simulateAllDrafts(ctx: ActionCtx, runId: Id<"runs">): Promise<number> {
  const emails: Doc<"emails">[] = await ctx.runQuery(
    internal.emails.forRunInternal,
    { runId },
  );
  const drafts = emails.filter(
    (e) => e.status === "draft" || e.status === "approved",
  );
  if (drafts.length === 0) return 0;

  const brief = await loadBrief(ctx, runId);
  let simulated = 0;
  await Promise.allSettled(
    drafts.map(async (e) => {
      const prospect: Doc<"prospects"> | null = await ctx.runQuery(
        internal.prospects.getInternal,
        { prospectId: e.prospectId },
      );
      const sim = await simulateEmail({
        prospect: toProspect(prospect),
        email: { subject: e.subject, body: e.body },
        brief,
      });
      await persist(ctx, runId, e._id, e.prospectId, sim);
      simulated += 1;
    }),
  );
  return simulated;
}

/** Persist a simulation through the internal mutation (explicitly typed ref). */
async function persist(
  ctx: ActionCtx,
  runId: Id<"runs">,
  emailId: Id<"emails">,
  prospectId: Id<"prospects">,
  sim: {
    replyLikelihood: number;
    sentiment: string;
    predictedReply: string;
    objections: string[];
    suggestions: string[];
    score: number;
    model?: string;
  },
): Promise<void> {
  await ctx.runMutation(internal.agents.twin.record, {
    runId,
    emailId,
    prospectId,
    replyLikelihood: sim.replyLikelihood,
    sentiment: sim.sentiment,
    predictedReply: sim.predictedReply,
    objections: sim.objections,
    suggestions: sim.suggestions,
    score: sim.score,
    model: sim.model ?? "twin",
  });
}

/** Map a prospect doc to the simulator's prospect shape (signal passes through). */
function toProspect(p: Doc<"prospects"> | null): Partial<EnrichedProspect> {
  if (!p) return {};
  return {
    company: p.company,
    domain: p.domain,
    name: p.name,
    title: p.title,
    industry: p.industry,
    employeeCount: p.employeeCount,
    email: p.email,
    emailVerified: p.emailVerified,
    signal: p.signal,
    source: p.source,
  };
}

/** Build the seller brief the twin scores against (campaign first, then brief). */
async function loadBrief(
  ctx: ActionCtx,
  runId: Id<"runs">,
): Promise<Partial<CampaignBrief>> {
  const runDoc: Doc<"runs"> | null = await ctx.runQuery(
    internal.runs.getRunInternal,
    { runId },
  );
  if (!runDoc) return {};

  if (runDoc.campaignId) {
    const campaign: Doc<"campaigns"> | null = await ctx.runQuery(
      internal.campaigns.getCampaignInternal,
      { campaignId: runDoc.campaignId },
    );
    if (campaign) {
      return {
        company: campaign.company,
        domain: campaign.domain,
        description: campaign.description,
        icp: campaign.icp,
        positioning: campaign.positioning,
        personas: campaign.personas,
        valueProp: campaign.valueProp,
      };
    }
  }

  const brief = await ctx.runQuery(api.brief.getBrief, { runId });
  return {
    company: runDoc.company ?? runDoc.input ?? undefined,
    icp: brief?.icp ?? undefined,
    positioning: brief?.positioning ?? undefined,
    valueProp: brief?.positioning ?? undefined,
  };
}

/** Append-only event log; a failed/absent event NEVER blocks the twin. */
async function safeLog(
  ctx: ActionCtx,
  entry: { runId: Id<"runs">; prospectId: Id<"prospects">; message: string },
): Promise<void> {
  try {
    await ctx.runMutation(internal.events.log, {
      runId: entry.runId,
      prospectId: entry.prospectId,
      agent: "twin",
      kind: "simulated",
      message: entry.message,
    });
  } catch {
    // additive: never throw on logging
  }
}
