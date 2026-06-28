// ============================================================================
// INTERCEPT — REPLY AGENT (the in-thread draft, behind the human-approval gate)
//
// For each high-intent thread the Detective surfaced, this agent drafts ONE
// genuinely-helpful, authentic, in-thread reply written in the community's
// native voice — not a sales pitch — and persists it as a `drafts` row with
// status "awaiting_approval".
//
// HUMAN-IN-THE-LOOP, ALWAYS:
//   - Nothing is ever auto-posted. A person reviews every draft and explicitly
//     approves it (drafts.status -> approved -> posted) before it reaches a
//     community. This agent only ever writes "awaiting_approval".
//   - When/if posting is wired up, it goes ONLY through official, ToS-compliant
//     platform APIs (e.g. Reddit's authenticated API) with proper disclosure —
//     never scraping, never impersonation, never automated mass-posting.
//
// SWARM CONVENTIONS:
//   - This module owns its own data: it defines `threadsForRun` (read), `save`
//     (write) and `run` (the orchestrated action) in this one file.
//   - It NEVER touches `agentStatus` — the orchestrator (convex/run.ts) owns the
//     live board and wraps this `run` action with status + the fan-in deadline.
//   - External LLM access goes through lib/openai (keys read from process.env).
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { chatJSON } from "../../lib/openai";

// Draft a reply for at most the top N threads, ranked by intent. Keeping this
// small keeps us well inside the fan-in deadline and focuses human review on the
// highest-signal conversations.
const TOP_REPLY_THREADS = 5;

// Below this intent score a thread is just "browsing" — not worth an in-thread
// reply that could read as spammy. We still let the orchestrator decide overall;
// this is a local quality gate.
const MIN_INTENT_TO_DRAFT = 35;

const OPENAI_MODEL = "gpt-4o-mini";

// Shape we ask the model to return. Validated + clamped before persisting.
interface DraftedReply {
  body: string;
  confidence: number; // 0-1
}

interface ReplyThread {
  threadId: Id<"threads">;
  platform: string;
  url: string;
  title: string;
  snippet: string;
  intentScore: number;
  intentLabel: string;
  author?: string;
  communityName?: string;
}

interface ReplyContext {
  brief: { icp: string; positioning: string } | null;
  company?: string;
  threads: ReplyThread[];
}

// ---------------------------------------------------------------------------
// READ: top in-intent threads for the run, plus the brief/positioning that
// tells the model WHAT the company actually helps with. Self-contained so this
// agent doesn't hard-depend on the Detective module's codegen being present.
// ---------------------------------------------------------------------------
export const threadsForRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<ReplyContext> => {
    const allThreads = await ctx.db
      .query("threads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    // Highest intent first; take the top slice worth a hand-crafted reply.
    const ranked = [...allThreads].sort((a, b) => b.intentScore - a.intentScore);

    const top = ranked
      .filter((t) => t.intentScore >= MIN_INTENT_TO_DRAFT)
      .slice(0, TOP_REPLY_THREADS);

    const threads: ReplyThread[] = await Promise.all(
      top.map(async (t) => {
        let communityName: string | undefined;
        if (t.communityId) {
          const community = await ctx.db.get(t.communityId);
          communityName = community?.name;
        }
        return {
          threadId: t._id,
          platform: t.platform,
          url: t.url,
          title: t.title,
          snippet: t.snippet,
          intentScore: t.intentScore,
          intentLabel: t.intentLabel,
          author: t.author,
          communityName,
        };
      }),
    );

    const brief = await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();

    const run = await ctx.db.get(runId);

    return {
      brief: brief ? { icp: brief.icp, positioning: brief.positioning } : null,
      company: run?.company ?? undefined,
      threads,
    };
  },
});

// ---------------------------------------------------------------------------
// WRITE: persist a single draft behind the approval gate. Idempotent — re-runs
// (and deterministic replay) won't create duplicate drafts for a thread.
// ---------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    threadId: v.id("threads"),
    body: v.string(),
    confidence: v.number(),
  },
  handler: async (ctx, { runId, threadId, body, confidence }) => {
    const existing = await ctx.db
      .query("drafts")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .first();

    const clamped = Math.max(0, Math.min(1, confidence));

    if (existing) {
      // Don't clobber a draft a human has already acted on.
      if (existing.status === "awaiting_approval") {
        await ctx.db.patch(existing._id, { body, confidence: clamped });
      }
      return existing._id;
    }

    return await ctx.db.insert("drafts", {
      runId,
      threadId,
      body,
      confidence: clamped,
      status: "awaiting_approval", // ALWAYS — human reviews before anything posts.
    });
  },
});

// ---------------------------------------------------------------------------
// RUN: the orchestrated swarm action. Reads context, drafts in parallel, saves.
// Resilient by design — a single thread's failure never blocks the others, and
// the agent always produces reviewable drafts so the human gate has something
// to act on.
// ---------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const { brief, company, threads } = await ctx.runQuery(
      internal.agents.reply.threadsForRun,
      { runId },
    );

    if (threads.length === 0) {
      return { drafted: 0 };
    }

    const results = await Promise.allSettled(
      threads.map(async (thread) => {
        const drafted = await draftReply({ thread, brief, company });
        await ctx.runMutation(internal.agents.reply.save, {
          runId,
          threadId: thread.threadId,
          body: drafted.body,
          confidence: drafted.confidence,
        });
      }),
    );

    const drafted = results.filter((r) => r.status === "fulfilled").length;
    return { drafted };
  },
});

// ---------------------------------------------------------------------------
// LLM drafting. Asks gpt-4o-mini for an authentic, helpful, in-thread reply in
// the community's voice + a self-assessed confidence. Falls back to a safe,
// low-confidence draft if the model call fails so the human still gets something
// to review (never silently drop a high-intent thread).
// ---------------------------------------------------------------------------
async function draftReply(params: {
  thread: ReplyThread;
  brief: { icp: string; positioning: string } | null;
  company?: string;
}): Promise<DraftedReply> {
  const { thread, brief, company } = params;

  const companyLine = company ? `Company / product: ${company}` : "Company: (unnamed)";
  const positioningLine = brief
    ? `What it genuinely helps with: ${brief.positioning}\nIdeal customer: ${brief.icp}`
    : "What it helps with: (use only the thread context; do not invent specifics)";

  const venue = thread.communityName
    ? `${thread.communityName} on ${thread.platform}`
    : thread.platform;

  const system = [
    "You are a seasoned community member writing a reply inside an online discussion thread.",
    "Your reply must be GENUINELY HELPFUL first and authentic to the community's voice — NOT a sales pitch.",
    "Hard rules:",
    "- Lead with real, specific help that directly answers the person's question.",
    "- Match the tone/format of the venue (e.g. casual + lowercase-ish for Reddit, technical + concise for Hacker News, helpful for forums).",
    "- Mention the product at most once, only if it's truly relevant, and framed as a genuine suggestion ('one option is…'), with light disclosure if you'd have a connection to it.",
    "- No marketing language, no hype, no emojis, no headers, no markdown bullet-dump, no signature, no links unless natural.",
    "- Keep it short: 2-4 short sentences or one tight paragraph. Sound like a person, not a brand.",
    "- If the product genuinely does NOT fit the thread, still give honest help and set a LOW confidence.",
    'Respond with STRICT JSON only: {"body": string, "confidence": number}. confidence is 0-1: how well the product fits the asker\'s need AND how authentic/non-spammy the reply is.',
  ].join("\n");

  const user = [
    companyLine,
    positioningLine,
    "",
    `Venue: ${venue}`,
    `Buyer intent: ${thread.intentLabel} (score ${thread.intentScore}/100)`,
    `Thread title: ${thread.title}`,
    `Thread snippet: ${thread.snippet}`,
    "",
    "Draft the single best in-thread reply this community member could leave. Return JSON only.",
  ].join("\n");

  try {
    const result = await chatJSON<DraftedReply>({
      system,
      user,
      model: OPENAI_MODEL,
      temperature: 0.7,
      maxTokens: 320,
    });

    const body = typeof result?.body === "string" ? result.body.trim() : "";
    const confidence =
      typeof result?.confidence === "number" && Number.isFinite(result.confidence)
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.4;

    if (!body) {
      return fallbackDraft(thread);
    }

    return { body, confidence };
  } catch {
    // Never block the swarm on a single LLM hiccup — hand the human a draft.
    return fallbackDraft(thread);
  }
}

// Deterministic, honest fallback. Clearly a starting point for the human editor,
// with low confidence so it sorts below model-written drafts in review.
function fallbackDraft(thread: ReplyThread): DraftedReply {
  const body = [
    `Saw your thread — "${thread.title.trim()}". A few folks here have run into the same thing.`,
    "Happy to share what's worked for us and point you in the right direction. What's your current setup and the main constraint you're hitting?",
  ].join(" ");

  return { body, confidence: 0.3 };
}
