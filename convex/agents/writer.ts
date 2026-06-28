// ============================================================================
// INTERCEPT — WRITER AGENT  (signal-grounded outbound copy)
// ----------------------------------------------------------------------------
// For each QUALIFIED prospect, drafts ONE first-touch email grounded in that
// prospect's real warm signal — not a generic template. Persists it to `emails`
// as status "draft" (the human-approval gate; the sender ships only approved).
// Tight deliverability guardrails: <= MAX_EMAIL_WORDS words, <= MAX_LINKS_PER_EMAIL
// link. NEVER throws — the orchestrator owns this agent's board tile.
// ============================================================================

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  MAX_EMAIL_WORDS,
  QUALIFY_THRESHOLD,
} from "../../lib/contract";
import { chatJSON } from "../../lib/openai";

interface DraftOut {
  subject: string;
  body: string;
}

export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ drafted: number }> => {
    const runDoc: Doc<"runs"> | null = await ctx.runQuery(
      internal.runs.getRunInternal,
      { runId },
    );
    if (!runDoc) throw new Error(`writer: run ${runId} not found`);

    const prospects: Doc<"prospects">[] = await ctx.runQuery(
      internal.prospects.forRunInternal,
      { runId },
    );
    const qualified = prospects.filter(
      (p) => p.stage === "qualified" || (p.fitScore ?? 0) >= QUALIFY_THRESHOLD,
    );
    if (qualified.length === 0) return { drafted: 0 };

    const context = await loadContext(ctx, runDoc);

    let drafted = 0;
    await Promise.allSettled(
      qualified.map(async (p) => {
        // One initial email per prospect — don't re-draft on a re-run.
        const existing: Doc<"emails">[] = await ctx.runQuery(
          internal.emails.forProspect,
          { prospectId: p._id },
        );
        if (existing.some((e) => e.step === 0)) return;

        const draft = await writeEmail(p, context);
        await ctx.runMutation(internal.emails.insert, {
          prospectId: p._id,
          campaignId: runDoc.campaignId,
          runId,
          step: 0,
          kind: "initial",
          subject: draft.subject,
          body: draft.body,
          signalRef: p.signal?.summary,
          to: p.email,
        });
        drafted += 1;
        await ctx.runMutation(internal.events.log, {
          runId,
          prospectId: p._id,
          agent: "writer",
          kind: "drafted",
          message: `Drafted outreach to ${p.name ?? p.company}: "${draft.subject}"`,
        });
      }),
    );

    // TRACK 2 · pre-send digital twin. Additive + graceful: the twin simulates
    // each fresh draft (reply-likelihood, objections, score) for PitchLab. It
    // never throws and degrades to a heuristic with no OPENAI_API_KEY, so it can
    // never block the swarm or the fan-in.
    if (drafted > 0) {
      await ctx.scheduler.runAfter(0, internal.agents.twin.run, { runId });
    }

    return { drafted };
  },
});

// ---------------------------------------------------------------------------
// LLM copy with a deterministic fallback so every qualified prospect gets a draft.
// ---------------------------------------------------------------------------
async function writeEmail(
  p: Doc<"prospects">,
  context: { company: string; positioning: string; valueProp: string },
): Promise<DraftOut> {
  const signalLine = p.signal
    ? `Real trigger to reference: ${p.signal.summary}${p.signal.url ? ` (${p.signal.url})` : ""}`
    : "No specific trigger found — open with their role/company context, do not invent facts.";

  try {
    const result = await chatJSON<DraftOut>({
      system:
        "You are a top B2B SDR writing a COLD first-touch email. Rules: " +
        `under ${MAX_EMAIL_WORDS} words; reference the prospect's real trigger naturally; ` +
        "lead with them, not us; one clear soft CTA (a question); no fluff, no buzzwords, " +
        "no exclamation points, at most one link, plain text. Sound human. STRICT JSON.",
      user: [
        `SELLER: ${context.company}`,
        `WHAT WE DO: ${context.positioning || context.valueProp}`,
        `VALUE PROP: ${context.valueProp}`,
        "",
        `PROSPECT: ${p.name ?? "(name unknown)"}, ${p.title ?? "decision-maker"} at ${p.company}`,
        p.industry ? `INDUSTRY: ${p.industry}` : "",
        signalLine,
        "",
        'Return {"subject": string, "body": string}. The body must read like a real person wrote it.',
      ]
        .filter(Boolean)
        .join("\n"),
      temperature: 0.6,
      maxTokens: 400,
    });
    const subject = result?.subject?.trim();
    const body = result?.body?.trim();
    if (subject && body) {
      return { subject: subject.slice(0, 120), body: enforceGuardrails(body) };
    }
  } catch {
    // fall through
  }
  return fallbackEmail(p, context);
}

/** Trim to the word cap and collapse multiple links down to the first. */
function enforceGuardrails(body: string): string {
  let out = body.replace(/\r/g, "").trim();
  const words = out.split(/\s+/);
  if (words.length > MAX_EMAIL_WORDS) {
    out = words.slice(0, MAX_EMAIL_WORDS).join(" ") + "…";
  }
  // Keep only the first URL.
  const urls = out.match(/https?:\/\/\S+/g) ?? [];
  if (urls.length > 1) {
    let seen = false;
    out = out.replace(/https?:\/\/\S+/g, (m) => {
      if (!seen) {
        seen = true;
        return m;
      }
      return "";
    });
  }
  return out.trim();
}

function fallbackEmail(
  p: Doc<"prospects">,
  context: { company: string; positioning: string; valueProp: string },
): DraftOut {
  const first = (p.name ?? "there").split(" ")[0];
  const hook = p.signal
    ? `Saw ${p.company} ${p.signal.summary.replace(/\.$/, "")}.`
    : `Came across ${p.company} and your work as ${p.title ?? "a leader there"}.`;
  const body = [
    `Hi ${first},`,
    "",
    `${hook} ${context.company} helps teams like yours — ${context.valueProp || context.positioning}.`,
    "",
    `Worth a quick look to see if it'd move the needle for ${p.company}?`,
  ].join("\n");
  return {
    subject: `Quick idea for ${p.company}`,
    body: enforceGuardrails(body),
  };
}

async function loadContext(
  ctx: ActionCtx,
  runDoc: Doc<"runs">,
): Promise<{ company: string; positioning: string; valueProp: string }> {
  if (runDoc.campaignId) {
    const campaign: Doc<"campaigns"> | null = await ctx.runQuery(
      internal.campaigns.getCampaignInternal,
      { campaignId: runDoc.campaignId },
    );
    if (campaign) {
      return {
        company: campaign.company,
        positioning: campaign.positioning ?? "",
        valueProp: campaign.valueProp ?? campaign.description ?? campaign.positioning ?? "",
      };
    }
  }
  const brief = await ctx.runQuery(api.brief.getBrief, { runId: runDoc._id });
  return {
    company: runDoc.company ?? runDoc.input ?? "our team",
    positioning: brief?.positioning ?? "",
    valueProp: brief?.positioning ?? "",
  };
}
