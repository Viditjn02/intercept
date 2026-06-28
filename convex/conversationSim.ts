// ============================================================================
// INTERCEPT — CONVERSATION SIMULATOR (backend)
// ----------------------------------------------------------------------------
// Plays out a *hypothetical* outbound thread for one prospect so the operator
// can preview how a cold conversation might land BEFORE a single email ships.
//
//   simulate(action) { prospectId } -> SimResult   (inline — no schema change)
//
// It loads the prospect (internal query, reusing prospects.getInternal), then
// asks the model for: a hyper-personalized OPENER grounded in the prospect's
// role / company / signal; a realistic 5–7 message back-and-forth where OUR side
// ADAPTS to each reply; a per-message `intent` (0–100); and a final `score`
// (0–100) + one-line `verdict` ("Book a call" / "Nurture" / "Pass").
//
// CONVEX RULES (deploy-safety): DEFAULT runtime — NOT "use node" — so lib/openai
// bundles cleanly (it's the OpenAI SDK over fetch, valid in the default runtime,
// exactly like convex/chat.ts). GRACEFUL by contract: a missing OPENAI_API_KEY
// or a missing prospect degrades to a believable CANNED simulation built from
// whatever firmographics we hold. This action NEVER throws.
// ============================================================================

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { chatJSON } from "../lib/openai";

// ----------------------------------------------------------------------------
// The inline result shape. Mirrored in components/ConversationSimulator.tsx.
// `messages` already INCLUDES the opener as messages[0] (from "us"), so the UI
// can play a single ordered list. `degraded` === the canned fallback ran.
// ----------------------------------------------------------------------------
type Speaker = "us" | "them";

interface SimMessage {
  from: Speaker;
  text: string;
  /** Read on the prospect's buying intent at this point, 0–100. */
  intent: number;
}

type Verdict = "Book a call" | "Nurture" | "Pass";

interface SimResult {
  name: string;
  company: string;
  title?: string;
  signal?: string;
  opener: string;
  messages: SimMessage[];
  score: number;
  verdict: Verdict;
  degraded: boolean;
}

const VERDICTS: readonly Verdict[] = ["Book a call", "Nurture", "Pass"];

function clampIntent(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function verdictFromScore(score: number): Verdict {
  if (score >= 70) return "Book a call";
  if (score >= 40) return "Nurture";
  return "Pass";
}

/** A first name to address the prospect by, falling back to a warm generic. */
function firstName(name: string | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "there";
  return n.split(/\s+/)[0];
}

// ----------------------------------------------------------------------------
// CANNED fallback — a believable thread assembled from the prospect's own
// firmographics when the model is unavailable. Deterministic, never throws.
// ----------------------------------------------------------------------------
function cannedSimulation(p: Doc<"prospects"> | null): SimResult {
  const company = p?.company?.trim() || "the company";
  const name = p?.name?.trim() || "the decision-maker";
  const title = p?.title?.trim() || undefined;
  const signal = p?.signal?.summary?.trim() || undefined;
  const who = firstName(p?.name);

  const role = title ? `As ${title.toLowerCase()}, ` : "";
  const hook = signal
    ? `saw the news — ${signal.replace(/\.$/, "")}`
    : `noticed ${company} is scaling its go-to-market`;

  const opener =
    `Hi ${who} — ${hook}. ${role}you're probably feeling the outbound crunch right now. ` +
    `We help teams like ${company} turn buying signals into booked meetings without adding headcount. Worth a look?`;

  const messages: SimMessage[] = [
    { from: "us", text: opener, intent: 18 },
    {
      from: "them",
      text: `Appreciate the note. We do this in-house today — what makes you different?`,
      intent: 34,
    },
    {
      from: "us",
      text:
        `Fair question. The difference is timing: we only reach out the moment a ` +
        `real signal fires (funding, a key hire, a product launch), so every touch is ` +
        `relevant. Most teams see reply rates jump 2–3x versus a static list.`,
      intent: 52,
    },
    {
      from: "them",
      text: `That's actually the part we struggle with — our list goes stale fast.`,
      intent: 68,
    },
    {
      from: "us",
      text:
        `Exactly the gap we close. I can show you a live run against ${company}'s ICP ` +
        `in 15 minutes — you'll see the signals and the drafted replies side by side.`,
      intent: 79,
    },
    {
      from: "them",
      text: `Okay, you've got my attention. Send a couple of times for next week.`,
      intent: 88,
    },
  ];

  const score = 84;
  return {
    name,
    company,
    title,
    signal,
    opener,
    messages,
    score,
    verdict: verdictFromScore(score),
    degraded: true,
  };
}

// ----------------------------------------------------------------------------
// Coerce the model's loose JSON into a strict, playable SimResult. Any shape
// drift falls back to the canned thread so the UI always has something to play.
// ----------------------------------------------------------------------------
function normalize(raw: unknown, p: Doc<"prospects"> | null): SimResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];

  const messages: SimMessage[] = [];
  for (const m of rawMessages) {
    const row = (m ?? {}) as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) continue;
    const from: Speaker = row.from === "them" ? "them" : "us";
    messages.push({ from, text, intent: clampIntent(row.intent) });
  }

  // Guarantee the thread opens on OUR side and reads as a real back-and-forth.
  if (messages.length < 3 || messages[0].from !== "us") {
    return cannedSimulation(p);
  }

  const opener =
    typeof obj.opener === "string" && obj.opener.trim()
      ? obj.opener.trim()
      : messages[0].text;

  const score = clampIntent(obj.score);
  const verdict: Verdict = VERDICTS.includes(obj.verdict as Verdict)
    ? (obj.verdict as Verdict)
    : verdictFromScore(score);

  return {
    name: p?.name?.trim() || "the decision-maker",
    company: p?.company?.trim() || "the company",
    title: p?.title?.trim() || undefined,
    signal: p?.signal?.summary?.trim() || undefined,
    opener,
    messages,
    score,
    verdict,
    degraded: false,
  };
}

// ----------------------------------------------------------------------------
// The action.
// ----------------------------------------------------------------------------
export const simulate = action({
  args: { prospectId: v.id("prospects") },
  handler: async (ctx, { prospectId }): Promise<SimResult> => {
    // Load the prospect (best-effort — a missing one still yields a canned demo).
    let prospect: Doc<"prospects"> | null = null;
    try {
      prospect = await ctx.runQuery(internal.prospects.getInternal, { prospectId });
    } catch {
      prospect = null;
    }

    try {
      const company = prospect?.company?.trim() || "the company";
      const name = prospect?.name?.trim() || "the decision-maker";
      const title = prospect?.title?.trim() || "a decision-maker";
      const fit =
        typeof prospect?.fitScore === "number" ? `${Math.round(prospect.fitScore)}/100` : "unknown";
      const signal = prospect?.signal
        ? `${prospect.signal.type}: ${prospect.signal.summary}`
        : "no fresh signal on file";
      const industry = prospect?.industry?.trim() || "their industry";

      const system =
        "You are INTERCEPT, an outbound revenue copilot. You simulate a realistic, " +
        "high-quality cold outbound conversation so an operator can preview how it would land. " +
        "Our product turns real-time buying signals into booked meetings without adding headcount. " +
        "Write like a sharp, human SDR: specific, concise, never spammy, no fake familiarity. " +
        "OUR side must ADAPT to each of their replies. Ground the opener in the prospect's exact " +
        "role, company, and signal. Intent should generally climb as rapport builds, but may dip " +
        "on an objection. Keep each message 1–3 sentences.";

      const user =
        `PROSPECT\n` +
        `- Name: ${name}\n` +
        `- Title: ${title}\n` +
        `- Company: ${company}\n` +
        `- Industry: ${industry}\n` +
        `- Fit score: ${fit}\n` +
        `- Buying signal: ${signal}\n\n` +
        `Produce a JSON object with this exact shape:\n` +
        `{\n` +
        `  "opener": string,            // the hyper-personalized first line from us\n` +
        `  "messages": [                // 6 to 8 entries, ALTERNATING, messages[0].from MUST be "us" and equal the opener\n` +
        `    { "from": "us" | "them", "text": string, "intent": number /* 0-100 */ }\n` +
        `  ],\n` +
        `  "score": number,            // 0-100 overall likelihood this prospect converts\n` +
        `  "verdict": "Book a call" | "Nurture" | "Pass"\n` +
        `}\n` +
        `The first message is the opener (from us). End on a natural beat (a yes, a soft yes, or a clear pass).`;

      const raw = await chatJSON<Record<string, unknown>>({
        system,
        user,
        temperature: 0.7,
        maxTokens: 900,
      });

      return normalize(raw, prospect);
    } catch {
      // Missing key, model error, bad JSON — degrade to the canned thread.
      return cannedSimulation(prospect);
    }
  },
});
