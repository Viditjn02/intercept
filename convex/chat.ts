"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { chatJSON, streamChatText } from "../lib/openai";
import { brainQuery } from "../lib/gbrain";
import {
  ROUTER_INTENTS,
  INTENTS,
  spawnsRun,
} from "../lib/contract";
import type {
  Intent,
  InputType,
  Capability,
  RouterDecision,
} from "../lib/contract";

// ============================================================================
// INTERCEPT — THE ROUTER BRAIN (one chat, one decision per turn).
//
// `generate` is the heart of the product: it takes the user's latest message,
// CLASSIFIES it into exactly one Intent (LLM via lib/openai with a deterministic
// keyword fallback so it NEVER stalls), then DOES the right thing:
//   • chat / brain  → answer INLINE, streamed token-by-token. No swarm run.
//   • everything else → stream a short conversational ack, then spawn a RUN on
//     the swarm orchestrator (api.runs.createRun) and link it to this message so
//     the canvas renders the live board beside the reply.
//
// DEPLOY-SAFETY: this module is "use node" (it shells gbrain for `brain` recall),
// so it defines NO queries/mutations — those live in convex/conversations.ts and
// convex/runs.ts. Streaming is Convex-native: we patch messages.content via the
// internal mutation; the UI reads the live feed off the reactive getMessages.
//
// ROUTER PLACEMENT (the documented choice): intent classification lives HERE, in
// chat.ts. The per-run convex/agents/router.ts stays the DOMAIN resolver (it
// turns the run's subject into a canonical domain for enrich/detective). Two
// distinct jobs, two distinct files.
// ============================================================================

// Throttle DB writes while streaming so we don't hammer Convex on every token.
const FLUSH_INTERVAL_MS = 110;

// ----------------------------------------------------------------------------
// Classification — message -> RouterDecision.
// ----------------------------------------------------------------------------

interface ClassifierOutput {
  intent?: string;
  subject?: string;
  inputType?: string;
  ack?: string;
  rationale?: string;
}

/** Build the classifier system prompt from the single source of truth. */
function classifierSystem(): string {
  const lines = ROUTER_INTENTS.map((spec) => {
    const ex = spec.examples.map((e) => `"${e}"`).join(", ");
    return `- ${spec.intent}: ${spec.description}\n    e.g. ${ex}`;
  });
  return [
    "You are the ROUTER for INTERCEPT, an AI-native go-to-market platform.",
    "Read the user's latest message (with the short conversation context) and",
    "decide the SINGLE best intent to act on. The intents and what each does:",
    "",
    lines.join("\n"),
    "",
    "Rules:",
    "- Pick exactly ONE intent from the list above.",
    "- `subject` = the company / domain / competitor the work should run against",
    "  (resolve it from context for follow-ups like 'now find their ads'). Empty",
    "  string if there is genuinely no subject (e.g. 'send it', greetings).",
    "- `inputType` ∈ url | name | competitor | community | text.",
    "- `ack` = ONE short, warm, specific sentence you'd say while starting the work",
    "  (no markdown). For chat/brain leave ack empty (you'll answer in full later).",
    "- Respond with STRICT JSON only.",
  ].join("\n");
}

/** Render the recent turns + the new message for the classifier. */
function classifierUser(userText: string, history: Doc<"messages">[]): string {
  const ctxLines = history
    .filter((m) => m.role !== "system" && m.content.trim().length > 0)
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 240)}`);
  return [
    ctxLines.length > 0 ? "Conversation so far:" : "",
    ctxLines.join("\n"),
    "",
    `New user message: """${userText}"""`,
    "",
    'Return JSON: { "intent": string, "subject": string, "inputType": string, "ack": string, "rationale": string }',
  ]
    .filter(Boolean)
    .join("\n");
}

function coerceIntent(candidate: string | undefined): Intent | null {
  if (!candidate) return null;
  const lowered = candidate.trim().toLowerCase();
  return (INTENTS as readonly string[]).includes(lowered)
    ? (lowered as Intent)
    : null;
}

const INPUT_TYPES: readonly InputType[] = [
  "url",
  "name",
  "competitor",
  "community",
  "text",
];

function coerceInputType(
  candidate: string | undefined,
  fallback: InputType,
): InputType {
  if (!candidate) return fallback;
  const lowered = candidate.trim().toLowerCase();
  return (INPUT_TYPES as readonly string[]).includes(lowered)
    ? (lowered as InputType)
    : fallback;
}

/** Pull a clean apex domain out of arbitrary text, if one is present. */
function extractDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
    );
    const host = url.hostname.replace(/^www\./, "");
    if (host.includes(".") && !host.includes(" ")) return host;
  } catch {
    // fall through to regex
  }
  const match = trimmed.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/|$|\s)/);
  if (match) return match[1].replace(/^www\./, "");
  return null;
}

/** Pull the first full URL (with path) out of arbitrary text, if present. The
 *  replicate flow drops a post/ad link; adsmith scrapes this exact URL. */
function extractUrl(input: string): string | null {
  const match = input.match(/https?:\/\/[^\s)]+/i);
  if (match) return match[0].replace(/[.,)]+$/, "");
  return null;
}

/** Best-effort subject: the model's, else a domain from the text, else the text. */
function cleanSubject(modelSubject: string | undefined, userText: string): string {
  const s = modelSubject?.trim();
  if (s && s.toLowerCase() !== "null" && s.toLowerCase() !== "none") return s;
  const domain = extractDomain(userText);
  if (domain) return domain;
  return userText.trim().slice(0, 160);
}

/** Derive an inputType when the model didn't give a usable one. */
function deriveInputType(
  intent: Intent,
  subject: string,
  userText: string,
): InputType {
  if (intent === "competitor") return "competitor";
  if (extractDomain(subject) || extractDomain(userText)) return "url";
  if (intent === "discovery") return "community";
  if (subject && subject.split(/\s+/).length <= 3) return "name";
  return "text";
}

/**
 * Deterministic fallback used when the LLM is unavailable. Scores each intent by
 * how many of its trigger keywords appear in the message; ties break by the
 * priority order below (action verbs win over generic nouns). Never throws,
 * always returns a decision, so the chat never stalls.
 */
const FALLBACK_PRIORITY: readonly Intent[] = [
  "outreach",
  "competitor",
  "outbound",
  "content",
  "brain",
  "discovery",
  "analyze",
  "chat",
];

/**
 * Whole-word keyword match. Critically NOT a naive substring test: `includes`
 * would match "send" inside "reSENDcom", misrouting "find customers for
 * resend.com" to outreach. Word boundaries around the (escaped) keyword fix that
 * while still matching multi-word phrases like "find customers" / "follow up".
 */
function keywordHit(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function heuristicDecision(userText: string): RouterDecision {
  const text = userText.toLowerCase();
  let best: { intent: Intent; score: number } | null = null;

  for (const spec of ROUTER_INTENTS) {
    let score = 0;
    for (const kw of spec.keywords) {
      if (keywordHit(text, kw)) score += 1;
    }
    if (score === 0) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score &&
        FALLBACK_PRIORITY.indexOf(spec.intent) <
          FALLBACK_PRIORITY.indexOf(best.intent))
    ) {
      best = { intent: spec.intent, score };
    }
  }

  let intent: Intent;
  if (best) {
    intent = best.intent;
  } else {
    // No keyword hit: a bare company/URL is an "analyze" sweep; otherwise chat.
    intent = extractDomain(userText) ? "analyze" : "chat";
  }

  const subject = cleanSubject(undefined, userText);
  return {
    intent,
    subject,
    inputType: deriveInputType(intent, subject, userText),
    rationale: "Routed by keyword heuristic (LLM unavailable).",
  };
}

/** Classify a user message into a RouterDecision (LLM first, heuristic fallback). */
async function classify(
  userText: string,
  history: Doc<"messages">[],
): Promise<RouterDecision> {
  if (!userText.trim()) return { intent: "chat", subject: "" };

  try {
    const out = await chatJSON<ClassifierOutput>({
      system: classifierSystem(),
      user: classifierUser(userText, history),
      temperature: 0,
      maxTokens: 300,
    });
    const intent = coerceIntent(out.intent);
    if (intent) {
      const subject = cleanSubject(out.subject, userText);
      return {
        intent,
        subject,
        inputType: coerceInputType(
          out.inputType,
          deriveInputType(intent, subject, userText),
        ),
        ack: out.ack?.trim() || undefined,
        rationale: out.rationale?.trim() || undefined,
      };
    }
  } catch {
    // fall through to the deterministic fallback
  }
  return heuristicDecision(userText);
}

// ----------------------------------------------------------------------------
// Inline answer prompts (chat / brain) + capability ack.
// ----------------------------------------------------------------------------

function transcript(history: Doc<"messages">[]): string {
  return history
    .filter((m) => m.role !== "system" && m.content.trim().length > 0)
    .slice(-8)
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
}

function chatPrompt(
  userText: string,
  history: Doc<"messages">[],
): { system: string; user: string } {
  return {
    system: [
      "You are INTERCEPT, an AI-native go-to-market copilot. You can: find the",
      "live forum/Reddit/HN threads where a company's buyers are asking (the moat),",
      "find target companies + decision-makers with verified emails, draft and send",
      "signal-grounded outreach, pull competitors' winning ads, and generate video",
      "ads + landing pages. Be warm, concise, and concrete. When the user seems",
      "ready to act, nudge them with a specific example like: \"try: find customers",
      "for resend.com\". Plain text, no headings.",
    ].join(" "),
    user: history.length > 1 ? `${transcript(history)}\n\nReply to the latest user message.` : userText,
  };
}

const CAPABILITY_LABEL: Record<Capability, string> = {
  analyze: "running the full sweep",
  discovery: "hunting the live buyer threads",
  outbound: "sourcing companies and decision-makers",
  outreach: "sending and scheduling the approved outreach",
  content: "generating a similar ad — image, copy, and variations",
  competitor: "scanning the competitor's live ads and scoring them",
  replicate: "replicating that ad and improving it",
  social: "scanning trends and spinning up viral posts",
  onboarding: "designing an in-app onboarding flow",
};

function ackPrompt(decision: RouterDecision): { system: string; user: string } {
  const what = CAPABILITY_LABEL[decision.intent as Capability];
  const subj = decision.subject ? ` for "${decision.subject}"` : "";
  return {
    system:
      "You are INTERCEPT. Write ONE short, warm, specific sentence acknowledging " +
      "you're starting the work right now. Present tense, no markdown, no preamble.",
    user: `You are ${what}${subj}. Acknowledge it in one sentence.`,
  };
}

function defaultAck(decision: RouterDecision): string {
  const what = CAPABILITY_LABEL[decision.intent as Capability] ?? "getting to work";
  const subj = decision.subject ? ` for ${decision.subject}` : "";
  return `On it — ${what}${subj}. Watch the canvas.`;
}

// ----------------------------------------------------------------------------
// Streaming helpers — grow the assistant message, throttled.
// ----------------------------------------------------------------------------

/** A throttled flusher bound to one assistant message. */
function makeFlusher(ctx: ActionCtx, messageId: Id<"messages">) {
  let lastFlush = 0;
  return async (full: string, force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastFlush < FLUSH_INTERVAL_MS) return;
    lastFlush = now;
    await ctx.runMutation(internal.conversations.appendToMessage, {
      messageId,
      content: full,
    });
  };
}

/** Stream an inline LLM answer into the message; fall back gracefully. */
async function streamInline(
  prompt: { system: string; user: string },
  flush: (full: string, force?: boolean) => Promise<void>,
  fallback: string,
): Promise<string> {
  try {
    const text = await streamChatText(
      { system: prompt.system, user: prompt.user, temperature: 0.6, maxTokens: 600 },
      async (_delta, full) => {
        await flush(full);
      },
    );
    const finalText = text.trim() || fallback;
    await flush(finalText, true);
    return finalText;
  } catch {
    await flush(fallback, true);
    return fallback;
  }
}

// ----------------------------------------------------------------------------
// THE ROUTER ACTION.
// ----------------------------------------------------------------------------

export const generate = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("messages"),
    assistantMessageId: v.id("messages"),
  },
  handler: async (
    ctx,
    { conversationId, userMessageId, assistantMessageId },
  ): Promise<void> => {
    const history: Doc<"messages">[] = await ctx.runQuery(
      internal.conversations.getRecentMessages,
      { conversationId, limit: 12 },
    );
    const userMsg =
      history.find((m) => m._id === userMessageId) ??
      (await ctx.runQuery(internal.conversations.getMessageInternal, {
        messageId: userMessageId,
      }));
    const userText = (userMsg?.content ?? "").trim();

    const decision = await classify(userText, history);
    const flush = makeFlusher(ctx, assistantMessageId);

    let finalText = "";
    let runId: Id<"runs"> | undefined;

    if (decision.intent === "chat") {
      finalText = await streamInline(
        chatPrompt(userText, history),
        flush,
        "I'm INTERCEPT — point me at a company and I'll find where its buyers are talking, who to sell to, and what to say. Try: \"find customers for resend.com\".",
      );
    } else if (decision.intent === "brain") {
      finalText = await answerBrain(decision, userText, flush);
    } else if (spawnsRun(decision.intent)) {
      // Capability: stream a conversational ack, then kick the swarm.
      const ackFallback = defaultAck(decision);
      const ack = await streamInline(ackPrompt(decision), flush, ackFallback);

      // REPLICATE: thread the dropped post/ad URL through to adsmith so it can
      // scrape the source creative and produce an improved replica.
      const sourceUrl =
        decision.intent === "replicate"
          ? extractUrl(userText) ?? extractUrl(decision.subject ?? "") ?? undefined
          : undefined;

      try {
        runId = await ctx.runMutation(api.runs.createRun, {
          intent: decision.intent,
          input: decision.subject || userText,
          inputType: decision.inputType ?? "text",
          conversationId,
          messageId: assistantMessageId,
          trigger: "chat",
          sourceUrl,
        });
        finalText = `${ack}\n\n_The swarm is live on the canvas → watch it work._`;
      } catch {
        finalText = `${ack}\n\n_(I couldn't start that run just now — try again in a moment.)_`;
      }
      await flush(finalText, true);
    } else {
      // Should be unreachable (INTENTS is exhaustive), but never stall.
      finalText = await streamInline(
        chatPrompt(userText, history),
        flush,
        "Tell me a company and what you want — discovery, outbound, ads, or content.",
      );
    }

    await ctx.runMutation(internal.conversations.finalizeStream, {
      messageId: assistantMessageId,
      content: finalText,
      intent: decision.intent,
      runId,
    });
    await ctx.runMutation(internal.conversations.setConversationIntent, {
      conversationId,
      intent: decision.intent,
    });
  },
});

/**
 * `brain` intent: recall from the compounding gbrain (real CLI shell-out), then
 * synthesize a grounded inline answer. Degrades gracefully when the brain is
 * empty or unavailable — never stalls the chat.
 */
async function answerBrain(
  decision: RouterDecision,
  userText: string,
  flush: (full: string, force?: boolean) => Promise<void>,
): Promise<string> {
  const topic = decision.subject || userText;
  const recall = await brainQuery(topic);

  const system =
    "You are INTERCEPT's compounding memory. Answer the user's recall question " +
    "using ONLY the prior findings provided. Be concrete and cite what we found. " +
    "If there are no prior findings, say so plainly and suggest running a fresh " +
    "discovery or outbound pass. Plain text, no headings.";
  const findings =
    recall.available && recall.answer.trim()
      ? recall.answer.trim()
      : "(no prior findings recorded yet)";
  const user = [
    `Recall question: """${userText}"""`,
    "",
    "Prior findings from past runs:",
    findings,
  ].join("\n");

  return await streamInline(
    { system, user },
    flush,
    recall.available && recall.answer.trim()
      ? recall.answer.trim()
      : "I don't have prior findings on that yet. Want me to run a fresh pass? Try: \"find where buyers are talking about " +
          (decision.subject || "your market") +
          '".',
  );
}
