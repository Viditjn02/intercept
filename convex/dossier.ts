import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { keyFor } from "../lib/knowledge";

// ============================================================================
// INTERCEPT — DOSSIER (the shareable, public Intelligence Dossier).
// ----------------------------------------------------------------------------
// One PUBLIC (no-auth) read that aggregates a run's REAL outputs into a single,
// screenshot-worthy intelligence object. A shareable link is just the runId:
//   /dossier/<runId>  →  api.dossier.get({ runId })
//
// PURELY ADDITIVE + GRACEFUL. Reuses the exact logic of the existing public
// queries (brief.getBrief/getThreads, ads.listByRun, prospects.byRun,
// emails.byRun, adsmith.creativesForRun, knowledge.brainStats). Never throws;
// returns null only when the run itself does not exist. Convex queries here are
// already public/no-auth, so this needs no new auth surface.
// ============================================================================

// ---------------------------------------------------------------------------
// Public dossier shape (the page renders exactly this).
// ---------------------------------------------------------------------------
export interface DossierThread {
  title: string;
  snippet: string;
  url: string;
  platform: string;
  intentScore: number;
  intentLabel: string;
  author: string | null;
}

export interface DossierAd {
  headline: string | null;
  text: string;
  cta: string | null;
  network: string;
  daysRunning: number | null;
  perfScore: number | null;
  winningAngle: string | null;
  status: string;
  scalingSignal: boolean;
  imageUrl: string | null;
  url: string;
}

export interface DossierCompetitor {
  advertiser: string;
  adCount: number;
  topAd: DossierAd;
}

export interface DossierDecisionMaker {
  name: string;
  title: string | null;
  company: string;
  email: string | null;
  verified: boolean;
  fitScore: number | null;
  signal: string | null;
  linkedinUrl: string | null;
}

export interface DossierCreative {
  headline: string;
  primaryText: string;
  cta: string;
  strategy: string;
  imageUrl: string | null;
  variations: { headline: string; primaryText: string; cta: string; angle: string }[];
}

export interface DossierOutreach {
  subject: string;
  body: string;
  to: string | null;
}

export interface DossierFact {
  text: string;
  kind: string;
  url: string | null;
}

export interface RecommendedPlay {
  summary: string;
  steps: string[];
}

export interface Dossier {
  runId: string;
  company: string;
  input: string;
  intent: string;
  generatedAt: number;
  icp: string;
  positioning: string;
  stats: {
    threads: number;
    competitorAds: number;
    decisionMakers: number;
    verifiedEmails: number;
    brainPages: number;
    brainFacts: number;
    brainRuns: number;
  };
  topThreads: DossierThread[];
  competitors: DossierCompetitor[];
  decisionMakers: DossierDecisionMaker[];
  creative: DossierCreative | null;
  learnedFacts: DossierFact[];
  recommendedPlay: RecommendedPlay;
  draftedOutreach: DossierOutreach | null;
}

// ---------------------------------------------------------------------------
// Pure shaping helpers (no I/O — never throw).
// ---------------------------------------------------------------------------

/** Mirror ads.listByRun's winning-first ranking so the read is self-consistent. */
function rankAds(a: Doc<"ads">, b: Doc<"ads">): number {
  const scaleA = a.scalingSignal ? 1 : 0;
  const scaleB = b.scalingSignal ? 1 : 0;
  if (scaleA !== scaleB) return scaleB - scaleA;
  const perfA = a.perfScore ?? -1;
  const perfB = b.perfScore ?? -1;
  if (perfA !== perfB) return perfB - perfA;
  if (a.status !== b.status) {
    if (a.status === "active") return -1;
    if (b.status === "active") return 1;
  }
  return (b.daysRunning ?? 0) - (a.daysRunning ?? 0);
}

function toDossierAd(ad: Doc<"ads">): DossierAd {
  return {
    headline: ad.headline ?? null,
    text: ad.text ?? "",
    cta: ad.cta ?? null,
    network: (ad.network ?? ad.platform ?? "ad").toLowerCase(),
    daysRunning: ad.daysRunning ?? null,
    perfScore: ad.perfScore ?? null,
    winningAngle: ad.winningAngle ?? null,
    status: ad.status,
    scalingSignal: ad.scalingSignal === true,
    imageUrl: ad.thumbnailUrl ?? ad.imageUrl ?? null,
    url: ad.url,
  };
}

function truncate(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function platformLabel(platform: string): string {
  const map: Record<string, string> = {
    reddit: "Reddit",
    hackernews: "Hacker News",
    forum: "a forum",
    discord: "Discord",
    twitter: "X",
    x: "X",
    linkedin: "LinkedIn",
  };
  return map[platform.toLowerCase()] ?? platform;
}

/**
 * Synthesize the recommended play from the brief + the strongest competitor ad +
 * the highest-intent thread + the top decision-maker + the drafted creative. Pure
 * string assembly (no LLM) so the dossier always has a confident "what we'd do".
 */
function synthesizePlay(input: {
  company: string;
  positioning: string;
  topThread: DossierThread | undefined;
  topCompetitor: DossierCompetitor | undefined;
  topDecisionMaker: DossierDecisionMaker | undefined;
  creative: DossierCreative | null;
}): RecommendedPlay {
  const { company, positioning, topThread, topCompetitor, topDecisionMaker, creative } = input;
  const steps: string[] = [];

  if (topThread) {
    steps.push(
      `Show up where buyers already are. On ${platformLabel(topThread.platform)}, people are asking "${truncate(
        topThread.title,
        100,
      )}" — meet that intent in the thread, not in a cold inbox.`,
    );
  }

  if (topCompetitor) {
    const ad = topCompetitor.topAd;
    const days = ad.daysRunning;
    const angle = ad.winningAngle;
    steps.push(
      `Mirror what's proven to convert. ${topCompetitor.advertiser}${
        days ? ` has kept a creative live for ${days} days` : ` is actively running ads`
      }${angle ? ` on the angle "${truncate(angle, 100)}"` : ""} — adapt that angle in your own voice instead of guessing.`,
    );
  }

  if (positioning && positioning.trim()) {
    steps.push(`Lead with the wedge: ${truncate(positioning, 160)}`);
  }

  if (topDecisionMaker) {
    const dm = topDecisionMaker;
    steps.push(
      `Open with ${dm.name}${dm.title ? `, ${dm.title}` : ""}${
        dm.company ? ` at ${dm.company}` : ""
      }${dm.email ? ` (${dm.email}${dm.verified ? ", verified" : ""})` : ""}${
        dm.signal ? ` — grounded in a real trigger: ${truncate(dm.signal, 90)}` : ""
      }.`,
    );
  }

  if (creative) {
    steps.push(`Ship the creative we already drafted: "${truncate(creative.headline, 90)}" — ${truncate(creative.cta, 24)}.`);
  }

  const who = company.trim() || "this market";
  const summary =
    steps.length > 0
      ? `Here's the play for ${who}: intercept the buyers who are already asking, mirror the competitor angles that are demonstrably working, and open every conversation with a decision-maker who has a live reason to talk.`
      : `INTERCEPT is still assembling the live signal for ${who}. Everything below is real and grows with every run.`;

  return { summary, steps };
}

// ---------------------------------------------------------------------------
// The aggregation core — shared by get + getByConversation.
// ---------------------------------------------------------------------------
async function buildDossier(ctx: QueryCtx, run: Doc<"runs">): Promise<Dossier> {
  const runId = run._id;

  // brief (icp + positioning) — first(), never unique()-throws.
  const brief = await ctx.db
    .query("brief")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .first();

  // threads (the moat) — highest intent first.
  const threadDocs = await ctx.db
    .query("threads")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();
  const topThreads: DossierThread[] = [...threadDocs]
    .sort((a, b) => b.intentScore - a.intentScore)
    .slice(0, 6)
    .map((t) => ({
      title: t.title,
      snippet: t.snippet,
      url: t.url,
      platform: t.platform,
      intentScore: t.intentScore,
      intentLabel: t.intentLabel,
      author: t.author ?? null,
    }));

  // competitor ads → grouped by advertiser, each with its single top ad.
  const adDocs = await ctx.db
    .query("ads")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();
  const ranked = [...adDocs].sort(rankAds);
  const byAdvertiser = new Map<string, Doc<"ads">[]>();
  for (const ad of ranked) {
    const key = (ad.advertiser ?? "").trim() || "Unknown advertiser";
    const list = byAdvertiser.get(key) ?? [];
    list.push(ad);
    byAdvertiser.set(key, list);
  }
  const competitors: DossierCompetitor[] = [...byAdvertiser.entries()]
    .map(([advertiser, list]) => ({
      advertiser,
      adCount: list.length,
      topAd: toDossierAd(list[0]),
    }))
    .sort(
      (a, b) =>
        (b.topAd.perfScore ?? 0) - (a.topAd.perfScore ?? 0) ||
        (b.topAd.daysRunning ?? 0) - (a.topAd.daysRunning ?? 0),
    )
    .slice(0, 6);

  // decision-makers (prospects with a person), ordered by fit.
  const prospectDocs = await ctx.db
    .query("prospects")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();
  const decisionMakers: DossierDecisionMaker[] = [...prospectDocs]
    .filter((p) => (p.name ?? "").trim().length > 0)
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, 8)
    .map((p) => ({
      name: p.name as string,
      title: p.title ?? null,
      company: p.company,
      email: p.email ?? null,
      verified: p.emailVerified === true,
      fitScore: p.fitScore ?? null,
      signal: p.signal?.summary ?? null,
      linkedinUrl: p.linkedinUrl ?? null,
    }));

  // generated creative (image + copy) — the most recent one.
  const creativeDocs = await ctx.db
    .query("adCreatives")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();
  const creativeDoc =
    [...creativeDocs].sort((a, b) => b.generatedAt - a.generatedAt)[0] ?? null;
  const creative: DossierCreative | null = creativeDoc
    ? {
        headline: creativeDoc.headline,
        primaryText: creativeDoc.primaryText,
        cta: creativeDoc.cta,
        strategy: creativeDoc.strategy,
        imageUrl: creativeDoc.imageUrl ?? null,
        variations: creativeDoc.variations ?? [],
      }
    : null;

  // drafted outreach — the first-touch email for this run (prefer the initial).
  const emailDocs = (await ctx.db.query("emails").collect()).filter(
    (e) => e.runId === runId,
  );
  const chosenEmail =
    [...emailDocs].sort((a, b) => a.createdAt - b.createdAt).find((e) => e.kind === "initial") ??
    [...emailDocs].sort((a, b) => a.createdAt - b.createdAt)[0] ??
    null;
  const draftedOutreach: DossierOutreach | null = chosenEmail
    ? { subject: chosenEmail.subject, body: chosenEmail.body, to: chosenEmail.to ?? null }
    : null;
  const verifiedEmails = decisionMakers.filter((d) => d.verified && d.email).length;

  // compounding brain — this company's learned facts + the brain-wide totals.
  const companyKey = keyFor({
    routedDomain: run.routedDomain,
    company: run.company,
    input: run.input,
  });
  const companyPage = await ctx.db
    .query("knowledge_pages")
    .withIndex("by_entity", (q) => q.eq("entityType", "company").eq("entityKey", companyKey))
    .first();
  const learnedFacts: DossierFact[] = (companyPage?.facts ?? [])
    .slice()
    .sort((a, b) => b.learnedAt - a.learnedAt)
    .slice(0, 10)
    .map((f) => ({ text: f.text, kind: f.kind, url: f.url ?? null }));

  // brain-wide stats (bounded scan, mirrors knowledge.brainStats).
  const allPages = await ctx.db.query("knowledge_pages").take(500);
  let brainFacts = 0;
  let brainRuns = 0;
  for (const p of allPages) {
    brainFacts += p.factCount;
    brainRuns += p.runCount;
  }

  const company = (run.company ?? run.input ?? "this company").trim();
  const positioning = brief?.positioning ?? "";

  const recommendedPlay = synthesizePlay({
    company,
    positioning,
    topThread: topThreads[0],
    topCompetitor: competitors[0],
    topDecisionMaker: decisionMakers[0],
    creative,
  });

  return {
    runId: String(runId),
    company,
    input: run.input,
    intent: run.intent,
    generatedAt: brief?.generatedAt ?? run.startedAt,
    icp: brief?.icp ?? "",
    positioning,
    stats: {
      threads: threadDocs.length,
      competitorAds: adDocs.length,
      decisionMakers: decisionMakers.length,
      verifiedEmails,
      brainPages: allPages.length,
      brainFacts,
      brainRuns,
    },
    topThreads,
    competitors,
    decisionMakers,
    creative,
    learnedFacts,
    recommendedPlay,
    draftedOutreach,
  };
}

// ---------------------------------------------------------------------------
// PUBLIC QUERIES — the shareable read surface.
// ---------------------------------------------------------------------------

/**
 * THE shareable read: aggregate a run's real outputs into one dossier object.
 * Public + no-auth (a link is just the runId). Returns null only when the run
 * doesn't exist — never throws.
 */
export const get = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Dossier | null> => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    return await buildDossier(ctx, run);
  },
});

/**
 * Convenience: resolve a conversation's most relevant run (newest settled run,
 * else newest) and return its dossier. Null when the conversation has no runs.
 */
export const getByConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }): Promise<Dossier | null> => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    if (runs.length === 0) return null;
    const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
    const best =
      sorted.find((r) => r.status === "complete" || r.status === "partial") ?? sorted[0];
    return await buildDossier(ctx, best);
  },
});

// Re-export the id type alias so the page can import a single source of truth if
// desired (kept minimal; the page reads via the generated api types).
export type DossierRunId = Id<"runs">;
