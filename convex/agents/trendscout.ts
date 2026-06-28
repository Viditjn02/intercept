// ============================================================================
// INTERCEPT — TREND SCOUT AGENT  ·  TRACK 1 (algorithm hacking / virality)
// ----------------------------------------------------------------------------
// The first beat of the social lane. Given a run, it reads the brief
// (company / icp / positioning), derives a handful of market topics, and scans
// what is trending RIGHT NOW for that market — Exa when a key is present, else a
// FREE Hacker News + Reddit fallback (lib/discovery.discoverThreads). Each trend
// is scored 0-100 for momentum and turned into a content ANGLE the composer can
// post on, then persisted to the frozen `trends` table.
//
// Self-contained (adscout convention): owns its read query, write mutation, and
// a PUBLIC `trendsForRun` query the canvas reads. NEVER throws past its handler
// and NEVER touches agentStatus — a missing key or empty scan degrades to a
// clean no-op so the swarm and the fan-in never block.
//
// RUNTIME: intentionally NOT "use node" — it co-locates a query + mutation with
// the action (Convex forbids those in a "use node" module). lib/discovery and
// lib/openai are fetch-based and run in the default Convex runtime.
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal, api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { discoverThreads } from "../../lib/discovery";
import type { ExaThread } from "../../lib/exa";
import { chatJSON } from "../../lib/openai";
import { MAX_TREND_QUERIES } from "../../lib/contract";
import type { TrendHit } from "../../lib/contract";

const MAX_TRENDS = 6; // how many scored trends to keep on the board
const RESULTS_PER_TOPIC = 4;

// ----------------------------------------------------------------------------
// READ: the run row.
// ----------------------------------------------------------------------------
export const getRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"runs"> | null> => {
    return await ctx.db.get(runId);
  },
});

// ----------------------------------------------------------------------------
// WRITE: replace this run's trend rows with the freshly scored set. Idempotent.
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    trends: v.array(
      v.object({
        topic: v.string(),
        angle: v.string(),
        source: v.string(),
        url: v.optional(v.string()),
        score: v.number(),
        why: v.string(),
      }),
    ),
  },
  handler: async (ctx, { runId, trends }): Promise<number> => {
    const existing = await ctx.db
      .query("trends")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    const now = Date.now();
    for (const t of trends) {
      await ctx.db.insert("trends", { runId, ...t, foundAt: now });
    }
    return trends.length;
  },
});

// ----------------------------------------------------------------------------
// PUBLIC READ: trends for a run, momentum-first. The canvas (ContentCalendar)
// renders these as trend chips.
// ----------------------------------------------------------------------------
export const trendsForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"trends">[]> => {
    const rows = await ctx.db
      .query("trends")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return rows.sort((a, b) => b.score - a.score);
  },
});

// ----------------------------------------------------------------------------
// ACTION: derive topics → scan trends → score → persist. Never blocks.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ trends: number }> => {
    const runDoc = await ctx.runQuery(internal.agents.trendscout.getRun, { runId });
    if (!runDoc) return { trends: 0 };
    if (runDoc.replay) return { trends: 0 }; // replay: trends pre-seeded

    const brief = await ctx.runQuery(api.brief.getBrief, { runId });
    const company = (runDoc.company ?? runDoc.input ?? "").trim();
    const icp = brief?.icp?.trim() ?? "";
    const positioning = brief?.positioning?.trim() ?? "";

    // 1. derive market topics to scan (LLM, with deterministic fallback).
    const topics = await deriveTopics(company, icp, positioning);

    // 2. scan each topic for live conversation (Exa → free HN/Reddit fallback).
    const settled = await Promise.allSettled(
      topics.map(async (topic) => {
        const hits = await discoverThreads({
          query: topic,
          numResults: RESULTS_PER_TOPIC,
        });
        return { topic, hits };
      }),
    );

    const scanned = settled
      .filter(
        (s): s is PromiseFulfilledResult<{ topic: string; hits: ExaThread[] }> =>
          s.status === "fulfilled",
      )
      .map((s) => s.value)
      .filter((x) => x.hits.length > 0);

    if (scanned.length === 0) {
      await ctx.runMutation(internal.agents.trendscout.save, { runId, trends: [] });
      await logEvent(
        ctx,
        runId,
        "found",
        `No live trend signal surfaced for ${company || "this market"} right now.`,
      );
      return { trends: 0 };
    }

    // 3. turn each scanned topic into a scored, angled TrendHit.
    const raw: TrendHit[] = scanned.map(({ topic, hits }) =>
      toTrendHit(topic, hits, company),
    );

    // 4. sharpen the content angles with one LLM pass (fallback keeps raw angles).
    const trends = (await sharpenAngles(raw, { company, icp, positioning }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TRENDS);

    await ctx.runMutation(internal.agents.trendscout.save, {
      runId,
      trends: trends.map((t) => ({
        topic: t.topic,
        angle: t.angle,
        source: t.source,
        url: t.url,
        score: t.score,
        why: t.why,
      })),
    });
    await logEvent(
      ctx,
      runId,
      "found",
      `Scanned the market and surfaced ${trends.length} trending angle${
        trends.length === 1 ? "" : "s"
      } for ${company || "this market"}.`,
    );
    return { trends: trends.length };
  },
});

// ----------------------------------------------------------------------------
// Topic derivation — LLM with a deterministic fallback so the scan never stalls.
// ----------------------------------------------------------------------------
async function deriveTopics(
  company: string,
  icp: string,
  positioning: string,
): Promise<string[]> {
  const fallback = fallbackTopics(company, icp, positioning);
  if (!company && !icp && !positioning) return fallback;

  try {
    const result = await chatJSON<{ topics?: string[] }>({
      system:
        "You are a social-media trend scout. Given a company's market, output the search topics whose LIVE discussion would make the best viral content hooks for that company. Return concrete, currently-relevant topics — not the company name itself.",
      user: `Company: ${company || "(unknown)"}\nICP: ${icp || "(unknown)"}\nPositioning: ${
        positioning || "(unknown)"
      }\n\nReturn ${MAX_TREND_QUERIES} short trending search topics for this market.`,
      schemaHint: '{ "topics": ["...", "..."] }',
      temperature: 0.5,
      maxTokens: 300,
    });
    const topics = (result.topics ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, MAX_TREND_QUERIES);
    return topics.length >= 2 ? topics : fallback;
  } catch {
    return fallback;
  }
}

function fallbackTopics(company: string, icp: string, positioning: string): string[] {
  const seed = positioning || icp || company || "startups";
  const base = [
    seed,
    `${seed} best practices`,
    `${seed} alternatives`,
    `${icp || "founders"} pain points`,
    `${company || seed} use cases`,
  ];
  return Array.from(new Set(base.map((s) => s.trim()).filter(Boolean))).slice(
    0,
    MAX_TREND_QUERIES,
  );
}

// ----------------------------------------------------------------------------
// Turn a scanned topic + its evidence threads into a scored TrendHit.
// Momentum (0-100) is deterministic: recency + volume of evidence + buyer-intent
// language in the snippets. No LLM needed, so it can never stall.
// ----------------------------------------------------------------------------
const INTENT_WORDS = [
  "best",
  "vs",
  "alternative",
  "how to",
  "recommend",
  "anyone",
  "looking for",
  "switch",
  "frustrated",
  "problem",
  "why is",
];

function toTrendHit(topic: string, hits: ExaThread[], company: string): TrendHit {
  const top = hits[0];
  const source = sourceOf(top.url);

  let score = 35;
  score += Math.min(20, hits.length * 6); // more live threads = more momentum
  const text = hits
    .map((h) => `${h.title} ${h.snippet}`)
    .join(" ")
    .toLowerCase();
  score += Math.min(25, INTENT_WORDS.reduce((n, w) => (text.includes(w) ? n + 5 : n), 0));
  score += recencyBoost(hits); // fresher threads score higher
  score = Math.max(0, Math.min(100, Math.round(score)));

  const angle = company
    ? `Position ${company} against the live conversation about ${topic}.`
    : `Ride the live conversation about ${topic}.`;
  const why = (top.title || top.snippet || `Active discussion about ${topic}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  return { topic, angle, source, url: top.url, score, why };
}

function recencyBoost(hits: ExaThread[]): number {
  const now = Date.now();
  let freshest = 0;
  for (const h of hits) {
    if (!h.publishedDate) continue;
    const t = Date.parse(h.publishedDate);
    if (Number.isNaN(t)) continue;
    const ageDays = (now - t) / 86_400_000;
    const boost = ageDays <= 7 ? 20 : ageDays <= 30 ? 12 : ageDays <= 90 ? 6 : 0;
    freshest = Math.max(freshest, boost);
  }
  return freshest;
}

function sourceOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("ycombinator.com")) return "hackernews";
    if (host.endsWith("reddit.com")) return "reddit";
    return "exa";
  } catch {
    return "exa";
  }
}

// ----------------------------------------------------------------------------
// Sharpen content angles with one LLM pass over the scored trends. Best-effort:
// any failure leaves the deterministic angles intact.
// ----------------------------------------------------------------------------
async function sharpenAngles(
  trends: TrendHit[],
  ctx: { company: string; icp: string; positioning: string },
): Promise<TrendHit[]> {
  if (trends.length === 0) return trends;
  try {
    const result = await chatJSON<{ angles?: Array<{ topic: string; angle: string }> }>({
      system:
        "You are a viral content strategist. For each trending topic, write ONE sharp, specific content angle the company can post to ride that trend. Keep each angle under 18 words.",
      user: `Company: ${ctx.company || "(unknown)"}\nICP: ${ctx.icp || "(unknown)"}\nPositioning: ${
        ctx.positioning || "(unknown)"
      }\n\nTopics:\n${trends.map((t, i) => `${i + 1}. ${t.topic}`).join("\n")}`,
      schemaHint: '{ "angles": [{ "topic": "...", "angle": "..." }] }',
      temperature: 0.6,
      maxTokens: 500,
    });
    const byTopic = new Map<string, string>();
    for (const a of result.angles ?? []) {
      if (a.topic && a.angle) byTopic.set(a.topic.trim().toLowerCase(), a.angle.trim());
    }
    return trends.map((t) => {
      const better = byTopic.get(t.topic.trim().toLowerCase());
      return better ? { ...t, angle: better } : t;
    });
  } catch {
    return trends;
  }
}

// ----------------------------------------------------------------------------
// Live-feed helper. Best-effort — never blocks the trendscout lane.
// ----------------------------------------------------------------------------
async function logEvent(
  ctx: ActionCtx,
  runId: Id<"runs">,
  kind: string,
  message: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.events.log, {
      runId,
      agent: "trendscout",
      kind,
      message,
    });
  } catch {
    // ignore — the feed is additive
  }
}
