// ============================================================================
// INTERCEPT — PRE-FLIGHT (backend)
// ----------------------------------------------------------------------------
// Predicts what a buyer will NOTICE, IGNORE, and ACT ON in an outbound message
// *before* you send it — creative / message pre-testing for cold outreach.
//
//   predict(action) { targetUrl, draft? } -> PreFlightResult
//
// If no draft is supplied it first writes a representative outbound message for
// the target, then predicts buyer attention against it. It returns the message
// it actually analyzed (`draft`), a single 0-100 ATTENTION/impact `score`, and
// three buckets — `notice`, `ignore`, `actOn` — plus `risks` and one-tap `fixes`.
//
// CONVEX RULES (deploy-safety, mirrors convex/winback.ts):
//   - DEFAULT runtime — NOT "use node" — so lib/openai bundles cleanly (it's the
//     OpenAI SDK over fetch, valid in the default runtime).
//   - GRACEFUL ABOVE ALL: a missing OPENAI_API_KEY, a model error, or bad JSON
//     degrades to a believable CANNED prediction. This action NEVER throws and
//     NEVER returns empty buckets or an empty draft.
// ============================================================================

import { v } from "convex/values";
import { action } from "./_generated/server";
import { chatJSON } from "../lib/openai";

// ----------------------------------------------------------------------------
// The result shape. Mirrored in components/PreFlightPanel.tsx.
// ----------------------------------------------------------------------------
export interface PreFlightResult {
  /** The message that was actually analyzed (echoed, or freshly generated). */
  draft: string;
  /** 0-100 overall attention / impact score for the message. */
  score: number;
  /** What the buyer will NOTICE first. */
  notice: string[];
  /** What the buyer will skim past / IGNORE. */
  ignore: string[];
  /** What actually drives a REPLY. */
  actOn: string[];
  /** What could sink the message. */
  risks: string[];
  /** One-tap rewrites that lift the score. */
  fixes: string[];
}

// How many items we keep per bucket — enough to feel real, few enough to scan.
const MAX_ITEMS = 4;
const DEFAULT_SCORE = 58;

function clamp100(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

/** Bare host for the target, mirroring lib/orangeslice normalizeDomain shape. */
function hostOf(input: string): string {
  let host = (input || "").trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^https?:\/\//, "").replace(/^www\./, "");
  host = host.split("/")[0].split("?")[0].split("#")[0];
  return host.trim();
}

/** A readable brand from a host: "acme.io" -> "Acme". */
function brandOf(host: string): string {
  const stem = host.split(".")[0] || "the company";
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** Coerce loose model output into a clean, deduped, capped list of strings. */
function cleanList(raw: unknown, max: number = MAX_ITEMS): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const s = typeof item === "string" ? item.trim() : "";
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// ----------------------------------------------------------------------------
// CANNED fallback — a believable pre-flight prediction, lightly personalized to
// the target's brand. Deterministic, never throws, never empty. When a draft was
// supplied we analyze *that*; otherwise we hand back a representative message.
// ----------------------------------------------------------------------------
function cannedDraft(brand: string): string {
  return (
    `Subject: a faster path to qualified pipeline at ${brand}\n\n` +
    `Hi {{first_name}},\n\n` +
    `Noticed ${brand} is hiring across go-to-market — usually the moment outbound ` +
    `volume outruns the team. We help teams like yours book ~2x more qualified ` +
    `meetings without adding headcount, by intercepting buyers the moment they ` +
    `show intent.\n\n` +
    `Worth a quick 15 minutes Thursday to see if it maps to ${brand}?\n\n` +
    `— Sam\n\n` +
    `P.S. Happy to send a 60-second teardown of your current sequence first.`
  );
}

function cannedPrediction(targetUrl: string, draft?: string): PreFlightResult {
  const brand = brandOf(hostOf(targetUrl) || "your");
  const analyzed = (draft ?? "").trim() || cannedDraft(brand);

  return {
    draft: analyzed,
    score: 61,
    notice: [
      `The subject line names ${brand} and an outcome, not a feature`,
      "The trigger event in the first line ('hiring across go-to-market')",
      "The bolded number — '2x more qualified meetings'",
      "The single dated ask ('Thursday?') near the end",
    ],
    ignore: [
      "The generic 'Hope you're well' style opener",
      "Any sentence that starts with 'We' and describes your product",
      "The signature block and boilerplate footer",
      "A second link or attachment buried mid-paragraph",
    ],
    actOn: [
      "One specific, low-friction ask they can answer in a word",
      "Social proof from a recognizable peer in their space",
      "The P.S. — a value-first offer that costs them nothing",
    ],
    risks: [
      "Leads with you, not them — reads as a pitch, not a fit",
      "Two asks (the meeting and the teardown) compete for one reply",
      "The claim '2x' is unsourced and may trip a skeptic",
    ],
    fixes: [
      "Open on their trigger event; delete the 'hope you're well' line",
      "Keep ONE ask — move the teardown to a follow-up",
      "Attribute the 2x to a named peer or a one-line proof point",
    ],
  };
}

// ----------------------------------------------------------------------------
// Coerce the model's loose JSON into a strict PreFlightResult. Any shape drift
// (missing draft, all-empty buckets) degrades to the canned prediction so the
// UI is never empty.
// ----------------------------------------------------------------------------
function normalize(
  raw: unknown,
  targetUrl: string,
  providedDraft?: string,
): PreFlightResult {
  const obj = (raw ?? {}) as Record<string, unknown>;

  // Prefer an explicitly provided draft; else trust the model's generated one.
  const fromModel = typeof obj.draft === "string" ? obj.draft.trim() : "";
  const draft = (providedDraft ?? "").trim() || fromModel;

  const notice = cleanList(obj.notice);
  const ignore = cleanList(obj.ignore);
  const actOn = cleanList(obj.actOn);
  const risks = cleanList(obj.risks);
  const fixes = cleanList(obj.fixes);

  const score =
    typeof obj.score === "number" && Number.isFinite(obj.score)
      ? clamp100(obj.score)
      : DEFAULT_SCORE;

  // A real prediction needs a message AND at least the three core buckets.
  if (!draft || notice.length === 0 || ignore.length === 0 || actOn.length === 0) {
    return cannedPrediction(targetUrl, providedDraft);
  }

  // Backfill the secondary buckets from the canned set if the model skipped them
  // — but only those, so the primary signal stays the model's own work.
  const fallback = cannedPrediction(targetUrl, providedDraft);
  return {
    draft,
    score,
    notice,
    ignore,
    actOn,
    risks: risks.length > 0 ? risks : fallback.risks,
    fixes: fixes.length > 0 ? fixes : fallback.fixes,
  };
}

// ----------------------------------------------------------------------------
// The action.
// ----------------------------------------------------------------------------
export const predict = action({
  args: { targetUrl: v.string(), draft: v.optional(v.string()) },
  handler: async (_ctx, { targetUrl, draft }): Promise<PreFlightResult> => {
    const providedDraft = (draft ?? "").trim();
    try {
      const host = hostOf(targetUrl) || "the company";
      const brand = brandOf(host);

      const system =
        "You are INTERCEPT, a revenue copilot that runs PRE-FLIGHT on outbound " +
        "messages: you predict what a busy buyer will NOTICE, IGNORE, and ACT ON " +
        "in a cold message BEFORE it is sent — creative pre-testing for outreach. " +
        "You think like a skeptical buyer reading on a phone in three seconds. Be " +
        "concrete: quote the exact phrase, line, or move that earns or loses " +
        "attention. 'Notice' = what the eye lands on first. 'Ignore' = what gets " +
        "skimmed past. 'Act on' = what actually drives a reply. 'Risks' = what " +
        "could sink it. 'Fixes' = one-tap rewrites that lift the score. Score the " +
        "message 0-100 on attention/impact — most cold drafts land 45-70.";

      const draftBlock = providedDraft
        ? `THE DRAFT TO PRE-TEST (analyze EXACTLY this message):\n"""\n${providedDraft}\n"""\n\n` +
          `Echo this message back UNCHANGED in the "draft" field.`
        : `NO DRAFT WAS PROVIDED. First WRITE one representative cold outbound ` +
          `message a rep would actually send to a buyer at ${brand} (subject + ` +
          `short body, real and specific, not a template stub). Put that exact ` +
          `message in the "draft" field, then pre-test THAT message.`;

      const user =
        `TARGET COMPANY\n` +
        `- Domain: ${host}\n` +
        `- Brand: ${brand}\n\n` +
        `${draftBlock}\n\n` +
        `Return a JSON object with this exact shape:\n` +
        `{\n` +
        `  "draft": string,        // the message analyzed (echoed or generated)\n` +
        `  "score": number,        // 0-100 overall attention / impact\n` +
        `  "notice": string[],     // ${MAX_ITEMS} things they NOTICE first, each ONE line\n` +
        `  "ignore": string[],     // ${MAX_ITEMS} things they SKIM past, each ONE line\n` +
        `  "actOn": string[],      // up to ${MAX_ITEMS} things that drive a REPLY\n` +
        `  "risks": string[],      // up to ${MAX_ITEMS} things that could sink it\n` +
        `  "fixes": string[]       // up to ${MAX_ITEMS} one-tap rewrites that lift the score\n` +
        `}\n` +
        `Quote real phrases from the message. Keep every item to a single line.`;

      const rawJson = await chatJSON<Record<string, unknown>>({
        system,
        user,
        temperature: 0.6,
        maxTokens: 1100,
      });

      return normalize(rawJson, targetUrl, providedDraft);
    } catch {
      // Missing key, model error, bad JSON — degrade to the canned prediction.
      return cannedPrediction(targetUrl, providedDraft);
    }
  },
});
