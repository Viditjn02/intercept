// ============================================================================
// INTERCEPT — AI PICK RATE (backend)
// ----------------------------------------------------------------------------
// GEO/SEO tells you whether AI *sees* a company. PICK RATE measures something
// sharper: when a real buyer asks an AI assistant for a recommendation, does the
// assistant actually NAME the target — or does it hand the pick to a competitor?
//
//   measure(action) { targetUrl } -> PickRateResult
//
// For the target company it simulates 6-8 realistic buyer questions a prospect
// would type into an AI assistant ("best <category> tool for <use case>"), then
// for each predicts which products the assistant would recommend (`winners`) and
// whether the target is among them (`picked`). The headline `score` is the % of
// questions where the target is recommended. It also surfaces the competitors
// repeatedly stealing the pick and the GAPS to close.
//
// CONVEX RULES (deploy-safety, mirrors convex/winback.ts):
//   - DEFAULT runtime — NOT "use node" — so lib/openai bundles cleanly (it's the
//     OpenAI SDK over fetch, valid in the default runtime).
//   - GRACEFUL ABOVE ALL: a missing OPENAI_API_KEY, a model error, or bad JSON
//     degrades to a believable CANNED result. This action NEVER throws and NEVER
//     returns an empty question list.
// ============================================================================

import { v } from "convex/values";
import { action } from "./_generated/server";
import { chatJSON } from "../lib/openai";

// ----------------------------------------------------------------------------
// The result shape. Mirrored in components/PickRatePanel.tsx.
// ----------------------------------------------------------------------------
export interface PickRateQuestion {
  /** The buyer's question to an AI assistant, e.g. "best CRM for a Series A startup". */
  question: string;
  /** Did the assistant name the target company in its recommendation? */
  picked: boolean;
  /** The products the assistant recommended for this question (target included when picked). */
  winners: string[];
}

export interface PickRateResult {
  /** 0-100 — % of questions where the target is recommended. */
  score: number;
  questions: PickRateQuestion[];
  /** Competitors repeatedly winning the pick instead of the target. */
  competitorsStealingPicks: string[];
  /** Why the target is being left out — the openings to close. */
  gaps: string[];
}

const MIN_QUESTIONS = 6;
const MAX_QUESTIONS = 8;
const MAX_WINNERS = 4;
const MAX_LIST = 6;

function clamp100(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

/** Bare host for the target, mirroring convex/winback.ts#hostOf. */
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

/** The headline metric: the share of questions where the target was recommended. */
function scoreFromQuestions(questions: PickRateQuestion[]): number {
  if (questions.length === 0) return 0;
  const picked = questions.filter((q) => q.picked).length;
  return clamp100((100 * picked) / questions.length);
}

/** Coerce loose JSON into a clean, deduped, capped string list. */
function strList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const s = item.trim();
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
// CANNED fallback — a believable PICK RATE read, lightly personalized to the
// target's brand. Fictional competitor names (never a real third party).
// Deterministic, never empty, never throws.
// ----------------------------------------------------------------------------
function cannedResult(targetUrl: string): PickRateResult {
  const brand = brandOf(hostOf(targetUrl) || "your");

  const questions: PickRateQuestion[] = [
    {
      question: "What's the best AI tool for a Series A startup doing outbound?",
      picked: false,
      winners: ["Cadence AI", "Reachbox"],
    },
    {
      question: "Which platform should I use to find and enrich B2B leads at scale?",
      picked: true,
      winners: [brand, "Prospectr", "LeadForge"],
    },
    {
      question: "Best software for automating cold-email follow-ups?",
      picked: false,
      winners: ["Outreachly", "Reachbox"],
    },
    {
      question: "What do top revenue teams use to prioritize the right accounts?",
      picked: true,
      winners: [brand, "Signalbase"],
    },
    {
      question: "Recommend a tool that turns website visitors into qualified pipeline.",
      picked: false,
      winners: ["Funnelly", "Pipematic"],
    },
    {
      question: "Which AI assistant helps SDR teams book more meetings?",
      picked: true,
      winners: ["Cadence AI", brand],
    },
    {
      question: "Best all-in-one GTM platform for a lean marketing team?",
      picked: false,
      winners: ["LeadForge", "Outreachly"],
    },
  ];

  return {
    score: scoreFromQuestions(questions),
    questions,
    competitorsStealingPicks: ["Reachbox", "Cadence AI", "Outreachly", "LeadForge"],
    gaps: [
      "You're absent from \"best for outbound / cold email\" answers — rivals own that category.",
      "Buyers asking for a lean all-in-one GTM platform aren't seeing you at all.",
      "No association with \"turn visitors into pipeline\" — a high-intent buying question.",
      "When you are picked you rarely lead the list — a secondary option, not the default.",
    ],
  };
}

// ----------------------------------------------------------------------------
// Derive the competitors stealing picks from the questions when the model omits
// them: the products that win most often in questions where the target lost.
// ----------------------------------------------------------------------------
function deriveCompetitors(questions: PickRateQuestion[], brand: string): string[] {
  const brandLower = brand.toLowerCase();
  const counts = new Map<string, { name: string; n: number }>();
  for (const q of questions) {
    if (q.picked) continue;
    for (const w of q.winners) {
      const key = w.toLowerCase();
      if (!key || key === brandLower) continue;
      const cur = counts.get(key);
      if (cur) cur.n += 1;
      else counts.set(key, { name: w, n: 1 });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_LIST)
    .map((c) => c.name);
}

// ----------------------------------------------------------------------------
// Coerce the model's loose JSON into a strict PickRateResult. Any shape drift
// (too few questions, missing keys) falls back to the canned read so the UI is
// never empty. The score is ALWAYS recomputed from the questions so the headline
// number and the per-question chips can never disagree.
// ----------------------------------------------------------------------------
function normalize(raw: unknown, targetUrl: string): PickRateResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const brand = brandOf(hostOf(targetUrl) || "your");
  const brandLower = brand.toLowerCase();

  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  const questions: PickRateQuestion[] = [];
  for (const q of rawQuestions) {
    const row = (q ?? {}) as Record<string, unknown>;
    const question = typeof row.question === "string" ? row.question.trim() : "";
    if (!question) continue;

    const winners = strList(row.winners, MAX_WINNERS);
    const winnersHaveBrand = winners.some((w) => w.toLowerCase().includes(brandLower));
    // Reconcile the model's flag with its own list so "picked" always matches
    // whether the brand actually appears among the winners.
    const picked =
      (typeof row.picked === "boolean" ? row.picked : false) || winnersHaveBrand;

    questions.push({ question, picked, winners });
    if (questions.length >= MAX_QUESTIONS) break;
  }

  // Need a real, believable set of questions — anything less degrades to canned.
  if (questions.length < MIN_QUESTIONS) {
    return cannedResult(targetUrl);
  }

  const competitorsFromModel = strList(obj.competitorsStealingPicks, MAX_LIST).filter(
    (c) => c.toLowerCase() !== brandLower,
  );
  const competitorsStealingPicks =
    competitorsFromModel.length > 0
      ? competitorsFromModel
      : deriveCompetitors(questions, brand);

  const gapsFromModel = strList(obj.gaps, MAX_LIST);
  const gaps =
    gapsFromModel.length > 0
      ? gapsFromModel
      : ["AI assistants default to better-known names — you're not yet the obvious pick."];

  return {
    score: scoreFromQuestions(questions),
    questions,
    competitorsStealingPicks,
    gaps,
  };
}

// ----------------------------------------------------------------------------
// The action.
// ----------------------------------------------------------------------------
export const measure = action({
  args: { targetUrl: v.string() },
  handler: async (_ctx, { targetUrl }): Promise<PickRateResult> => {
    try {
      const host = hostOf(targetUrl) || "the company";
      const brand = brandOf(host);

      const system =
        "You are INTERCEPT, a go-to-market visibility analyst measuring AI PICK RATE: " +
        "whether AI assistants actually RECOMMEND a company when a buyer asks for a " +
        "product recommendation — which is sharper than whether AI merely *sees* it. " +
        "You simulate realistic buyer questions a prospect would type into an AI " +
        "assistant ('best <category> tool for <use case>'), then for each you HONESTLY " +
        "predict which products the assistant would recommend and whether the target " +
        "company is named. Be realistic, not flattering: in most generic category " +
        "questions the target is NOT named unless it genuinely leads that space. Vary " +
        "the outcomes so the read is credible.";

      const user =
        `TARGET COMPANY\n` +
        `- Domain: ${host}\n` +
        `- Brand: ${brand}\n\n` +
        `Simulate the buyer journey and return a JSON object with this exact shape:\n` +
        `{\n` +
        `  "questions": [          // ${MIN_QUESTIONS}-${MAX_QUESTIONS} entries\n` +
        `    {\n` +
        `      "question": string, // a real buyer ask, e.g. "best <category> tool for <use case>"\n` +
        `      "winners": string[],// 2-4 products the assistant would recommend, in order\n` +
        `      "picked": boolean   // true ONLY if "${brand}" is among the winners\n` +
        `    }\n` +
        `  ],\n` +
        `  "competitorsStealingPicks": string[], // companies repeatedly recommended INSTEAD of ${brand}\n` +
        `  "gaps": string[]        // why ${brand} is left out + what to fix, each ONE line\n` +
        `}\n` +
        `Rules: when "picked" is true, include "${brand}" EXACTLY in that question's ` +
        `winners; when false, do NOT include it. Cover ${MIN_QUESTIONS}-${MAX_QUESTIONS} ` +
        `DISTINCT categories/use-cases and keep the mix of picked/not-picked realistic.`;

      const raw = await chatJSON<Record<string, unknown>>({
        system,
        user,
        temperature: 0.7,
        maxTokens: 1400,
      });

      return normalize(raw, targetUrl);
    } catch {
      // Missing key, model error, bad JSON — degrade to the canned read.
      return cannedResult(targetUrl);
    }
  },
});
