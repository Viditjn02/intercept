// ============================================================================
// INTERCEPT — TRACK 2 · DIGITAL TWIN SIMULATOR.
//
// An OpenAI "digital twin" of a specific prospect (built from their firmographics
// + warm signal) that ROLEPLAYS receiving a drafted cold email in a busy inbox,
// then returns a TwinSimulation: reply-likelihood, sentiment, the predicted buyer
// reply, concrete objections, actionable suggestions, and an overall score.
//
// Plus `rewriteEmail` — the twin's critique fed back into a grounded rewrite, so
// the writer / PitchLab can ship the variant the buyer is most likely to answer.
//
// SPONSOR-FIRST: OpenAI (lib/openai → chatJSON) is primary. Everything degrades
// to a deterministic heuristic when no OPENAI_API_KEY (or the call fails) so this
// module NEVER throws and the green build / fan-in can always render.
//
// DEPLOY-SAFETY: NOT "use node"; defines no Convex functions (utility module).
// ============================================================================

import type {
  TwinSimulation,
  EnrichedProspect,
  DraftedEmail,
  CampaignBrief,
} from "../../lib/contract";
import { chatJSON } from "../../lib/openai";

export interface SimulateEmailArgs {
  prospect: Partial<EnrichedProspect>;
  email: Pick<DraftedEmail, "subject" | "body">;
  brief?: Partial<CampaignBrief>;
}

/** A grounded rewrite of the draft, addressing the twin's critique. */
export interface RewriteResult {
  subject: string;
  body: string;
  model: string;
}

// ----------------------------------------------------------------------------
// PUBLIC: simulate the prospect's digital twin reading the email and score it.
// Never throws — degrades to a deterministic heuristic when the LLM is absent.
// ----------------------------------------------------------------------------
export async function simulateEmail(
  args: SimulateEmailArgs,
): Promise<TwinSimulation> {
  const { prospect, email, brief } = args;
  const subject = (email.subject ?? "").trim();
  const body = (email.body ?? "").trim();

  // Empty draft → nothing to judge. Cheap, deterministic, never an LLM call.
  if (!subject && !body) {
    return {
      replyLikelihood: 0,
      sentiment: "negative",
      predictedReply: "",
      objections: ["The draft is empty."],
      suggestions: ["Write a subject and body before simulating."],
      score: 0,
      model: "heuristic",
    };
  }

  try {
    const raw = await chatJSON<RawSim>({
      system:
        "You are the DIGITAL TWIN of one specific B2B buyer. Roleplay as this exact " +
        "person opening a COLD email in an overflowing inbox. Be skeptical and " +
        "realistic — most cold emails get ignored. Judge ONLY from the buyer's point " +
        "of view: is it clearly relevant to me, personalized to a REAL trigger (not a " +
        "mail-merge), concise, low-friction, and does it respect my time? Then: " +
        "(1) decide whether you'd reply and predict your reply IN YOUR OWN VOICE, " +
        "(2) list the concrete objections that would stop you replying, " +
        "(3) give specific edits that would make YOU more likely to reply. " +
        "Calibrate the score: a generic templated email scores under 35; a sharp, " +
        "signal-grounded, concise, buyer-first email scores 75 or higher. STRICT JSON.",
      user: JSON.stringify({
        you_the_buyer: personaCard(prospect),
        the_seller: brief
          ? {
              company: brief.company,
              whatTheyDo: brief.positioning ?? brief.description,
              valueProp: brief.valueProp,
            }
          : undefined,
        the_email: { subject, body },
        instructions:
          'Return {"replyLikelihood":0-100 integer,"sentiment":"positive"|"neutral"|"negative",' +
          '"predictedReply":string (1-3 sentences in the buyer\'s voice, or "" if you would ignore it),' +
          '"objections":string[] (max 4, blunt),"suggestions":string[] (max 4, specific edits),' +
          '"score":0-100 integer}',
      }),
      temperature: 0.5,
      maxTokens: 600,
    });
    return normalize(raw);
  } catch {
    // No key / parse failure / network — fall through to the heuristic.
    return heuristicSimulation(args);
  }
}

// ----------------------------------------------------------------------------
// PUBLIC: rewrite the draft to address the twin's critique. Never throws — on
// failure (no key) it returns the original draft unchanged so the caller is safe.
// ----------------------------------------------------------------------------
export async function rewriteEmail(
  args: SimulateEmailArgs,
  critique: TwinSimulation,
): Promise<RewriteResult> {
  const subject = (args.email.subject ?? "").trim();
  const body = (args.email.body ?? "").trim();
  const fallback: RewriteResult = { subject, body, model: "heuristic" };

  try {
    const raw = await chatJSON<{ subject?: string; body?: string }>({
      system:
        "You are a top B2B SDR copywriter. Rewrite this COLD first-touch email so the " +
        "SPECIFIC buyer below is more likely to reply, directly addressing their " +
        "objections and applying the suggested edits. Rules: keep it under 130 words; " +
        "lead with the buyer, not the seller; reference their real trigger naturally; " +
        "one clear soft CTA phrased as a question; plain text; at most one link; no " +
        "buzzwords, no exclamation points. Keep what already worked. STRICT JSON.",
      user: JSON.stringify({
        buyer: personaCard(args.prospect),
        seller: args.brief
          ? { company: args.brief.company, whatTheyDo: args.brief.positioning, valueProp: args.brief.valueProp }
          : undefined,
        current_email: { subject, body },
        buyer_objections: critique.objections,
        suggested_edits: critique.suggestions,
        instructions:
          'Return {"subject":string,"body":string}. The body must read like a real person wrote it.',
      }),
      temperature: 0.6,
      maxTokens: 500,
    });
    const newSubject = raw?.subject?.trim();
    const newBody = raw?.body?.trim();
    if (newSubject && newBody) {
      return {
        subject: newSubject.slice(0, 120),
        body: enforceGuardrails(newBody),
        model: "openai",
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// ============================================================================
// INTERNALS
// ============================================================================

interface RawSim {
  replyLikelihood?: number;
  sentiment?: string;
  predictedReply?: string;
  objections?: unknown;
  suggestions?: unknown;
  score?: number;
}

/** A compact, LLM-friendly description of the buyer being simulated. */
function personaCard(p: Partial<EnrichedProspect>): Record<string, unknown> {
  return {
    name: p.name ?? "(name unknown)",
    title: p.title ?? "a senior decision-maker",
    company: p.company ?? "their company",
    industry: p.industry,
    employeeCount: p.employeeCount,
    recentTrigger: p.signal?.summary,
    persona:
      "Time-poor, allergic to fluff and mail-merge personalization; replies only " +
      "when an email is clearly relevant, specific, and low-effort to answer.",
  };
}

/** Coerce a possibly-messy LLM JSON object into a clean TwinSimulation. */
function normalize(raw: RawSim): TwinSimulation {
  const score = clamp(raw.score);
  return {
    replyLikelihood: clamp(raw.replyLikelihood ?? score),
    sentiment: normalizeSentiment(raw.sentiment, score),
    predictedReply: typeof raw.predictedReply === "string" ? raw.predictedReply.trim() : "",
    objections: toStringList(raw.objections),
    suggestions: toStringList(raw.suggestions),
    score,
    model: "openai",
  };
}

function normalizeSentiment(s: unknown, score: number): string {
  const v = typeof s === "string" ? s.toLowerCase() : "";
  if (v === "positive" || v === "neutral" || v === "negative") return v;
  return score >= 65 ? "positive" : score >= 40 ? "neutral" : "negative";
}

function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .slice(0, 4);
}

function clamp(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

// ----------------------------------------------------------------------------
// DETERMINISTIC FALLBACK — a transparent inbox-realistic rubric so a draft is
// always scored, even with no OpenAI key. Mirrors the LLM's judgment criteria:
// personalization, signal grounding, concision, a clear ask, and spam hygiene.
// ----------------------------------------------------------------------------
const SPAM_RE = /\b(free|guarantee|act now|limited time|buy now|cheap|risk[- ]free|100%|amazing|incredible)\b/i;

function heuristicSimulation(args: SimulateEmailArgs): TwinSimulation {
  const { prospect, email } = args;
  const subject = (email.subject ?? "").trim();
  const body = (email.body ?? "").trim();
  const lowerBody = body.toLowerCase();
  const words = body.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const objections: string[] = [];
  const suggestions: string[] = [];
  let score = 50;

  // Personalization — name + company referenced.
  const first = (prospect.name ?? "").split(" ")[0]?.toLowerCase();
  if (first && first.length > 1 && lowerBody.includes(first)) score += 6;
  const company = (prospect.company ?? "").toLowerCase();
  if (company && lowerBody.includes(company)) score += 6;
  else {
    score -= 6;
    objections.push("This reads generic — it doesn't feel written for me or my company.");
    suggestions.push(`Name ${prospect.company ?? "the company"} and tie the opener to it.`);
  }

  // Signal grounding — the warm trigger the buyer actually recognizes.
  const signalWord = (prospect.signal?.summary ?? "").split(/\s+/).find((w) => w.length > 4)?.toLowerCase();
  if (prospect.signal) {
    if (signalWord && lowerBody.includes(signalWord)) score += 14;
    else {
      score -= 4;
      objections.push("There's a real trigger to reference but the email ignores it.");
      suggestions.push(`Open with my recent trigger: "${prospect.signal.summary}".`);
    }
  }

  // Concision — busy inbox rewards short.
  if (wordCount > 0 && wordCount <= 120) score += 10;
  else if (wordCount > 160) {
    score -= 14;
    objections.push("Too long — I won't read a wall of text from a stranger.");
    suggestions.push("Cut it to under 90 words; one idea, one ask.");
  }

  // A single, low-friction ask.
  if (/\?/.test(body)) score += 8;
  else {
    score -= 6;
    objections.push("There's no clear, easy ask — I don't know what you want from me.");
    suggestions.push("End with one soft question that's easy to answer.");
  }

  // Spam hygiene.
  if (SPAM_RE.test(body) || SPAM_RE.test(subject)) {
    score -= 15;
    objections.push("Salesy spam-trigger language makes me distrust it.");
    suggestions.push("Drop the hype words; sound like a human, not a flyer.");
  }
  const exclamations = (body.match(/!/g) ?? []).length;
  if (exclamations > 0) {
    score -= Math.min(8, exclamations * 4);
    suggestions.push("Lose the exclamation points — they read as try-hard.");
  }
  const links = (body.match(/https?:\/\/\S+/g) ?? []).length;
  if (links > 1) {
    score -= 8;
    objections.push("Multiple links in a cold email feel risky.");
    suggestions.push("Keep at most one link.");
  }

  // Subject quality.
  const subjWords = subject.split(/\s+/).filter(Boolean).length;
  if (subjWords === 0) {
    score -= 10;
    objections.push("No subject line — I'd never open it.");
    suggestions.push("Add a short, specific, lowercase-feeling subject (3-7 words).");
  } else if (subjWords > 11) {
    score -= 4;
    suggestions.push("Shorten the subject to under 8 words.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const sentiment = score >= 65 ? "positive" : score >= 40 ? "neutral" : "negative";
  const replyLikelihood = Math.max(0, Math.min(100, Math.round(score * 0.85)));

  const firstName = (prospect.name ?? "there").split(" ")[0];
  const predictedReply =
    score >= 65
      ? `Hi — this is relevant to what we're working on. Can you share a bit more on how it'd work for ${prospect.company ?? "us"}?`
      : score >= 40
        ? `Thanks ${firstName === "there" ? "" : ""}— might be worth a look, but I'd need to see it's actually relevant before I spend time.`
        : "";

  return {
    replyLikelihood,
    sentiment,
    predictedReply,
    objections: objections.slice(0, 4),
    suggestions: suggestions.slice(0, 4),
    score,
    model: "heuristic",
  };
}

/** Trim to a tight word cap and collapse multiple links down to the first. */
function enforceGuardrails(body: string): string {
  let out = body.replace(/\r/g, "").trim();
  const words = out.split(/\s+/);
  if (words.length > 130) out = words.slice(0, 130).join(" ") + "…";
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
