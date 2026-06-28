// ============================================================================
// HOLMES — DETECTIVE AGENT  ·  THE MOAT
// ----------------------------------------------------------------------------
// Finds the LIVE communities where a company's buyers are asking the exact
// question the company answers, returns each as a REAL, clickable, intent-scored
// thread. This is the most important file in the repo.
//
// run (internalAction):
//   1. read brief + run (company / icp / positioning)
//   2. derive 3-5 buyer-intent search queries (lib/openai)
//   3. search reddit + Hacker News for live threads (lib/exa.searchThreads)
//   4. score each thread's intent 0-100 + label (lib/openai chatJSON)  <-- the moat
//   5. cluster threads into communities
//   6. persist via internal.agents.detective.save (cap MAX_COMMUNITIES/MAX_THREADS)
//
// NOTE ON RUNTIME: this module is intentionally NOT a "use node" file. Convex
// disallows queries/mutations in "use node" files, and the contract requires the
// `save` mutation + `threadsForRun` query to live HERE. The OpenAI + Exa clients
// in lib/* are fetch-based and run in Convex's default runtime.
// ============================================================================

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  MAX_COMMUNITIES,
  MAX_THREADS,
  type IntentLabel,
} from "../../lib/contract";
import { chatJSON } from "../../lib/openai";
import { searchThreads } from "../../lib/exa";

// ----------------------------------------------------------------------------
// Tuning knobs
// ----------------------------------------------------------------------------
const QUERIES_MIN = 3;
const QUERIES_MAX = 5;
const RESULTS_PER_QUERY = 6;
const MAX_CANDIDATES_TO_SCORE = 24;
const INCLUDE_DOMAINS = ["reddit.com", "news.ycombinator.com"];
const VALID_LABELS: IntentLabel[] = [
  "browsing",
  "comparing",
  "frustrated",
  "ready_to_buy",
];

// ----------------------------------------------------------------------------
// Local types (we normalize whatever Exa returns into these immediately)
// ----------------------------------------------------------------------------
interface RawExaResult {
  url?: string;
  title?: string;
  snippet?: string;
  text?: string;
  highlights?: string[];
  author?: string;
  publishedDate?: string;
}

interface Candidate {
  url: string;
  title: string;
  snippet: string;
  platform: string; // reddit | hackernews | forum
  author?: string;
}

interface ScoredThread extends Candidate {
  intentScore: number; // 0-100, integer
  intentLabel: IntentLabel;
  communityName: string;
  communityUrl: string;
}

// ============================================================================
// run — the agent entrypoint (orchestrator invokes this via the swarmpool)
// ============================================================================
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.runQuery(internal.runs.getRun, { runId });
    if (!run) throw new Error(`detective: run ${runId} not found`);

    const brief = await ctx.runQuery(internal.brief.getBrief, { runId });
    const company = (run.company ?? run.input ?? "").trim();
    const icp = brief?.icp?.trim() ?? "";
    const positioning = brief?.positioning?.trim() ?? "";

    // 1. derive buyer-intent search queries (LLM, with deterministic fallback)
    const queries = await deriveQueries(company, icp, positioning);

    // 2. search reddit + HN in parallel; gather REAL threads
    const settled = await Promise.allSettled(
      queries.map((query) =>
        searchThreads({
          query,
          includeDomains: INCLUDE_DOMAINS,
          numResults: RESULTS_PER_QUERY,
        }),
      ),
    );

    const candidates = dedupeByUrl(
      settled
        .filter(
          (s): s is PromiseFulfilledResult<RawExaResult[]> =>
            s.status === "fulfilled" && Array.isArray(s.value),
        )
        .flatMap((s) => s.value)
        .map(normalizeExaResult)
        .filter((c): c is Candidate => c !== null),
    ).slice(0, MAX_CANDIDATES_TO_SCORE);

    if (candidates.length === 0) {
      // Nothing found — persist nothing, let the fan-in render partial.
      await ctx.runMutation(internal.agents.detective.save, {
        runId,
        communities: [],
        threads: [],
      });
      return { communities: 0, threads: 0 };
    }

    // 3. intent-score every candidate (LLM rubric, with heuristic fallback)
    const scored = await scoreIntent(candidates, { company, icp, positioning });

    // 4. keep the highest-intent threads, then cluster into communities
    const topThreads = [...scored]
      .sort((a, b) => b.intentScore - a.intentScore)
      .slice(0, MAX_THREADS);

    const communities = clusterCommunities(topThreads, {
      company,
      positioning,
    }).slice(0, MAX_COMMUNITIES);

    const keptCommunityNames = new Set(communities.map((c) => c.name));

    // 5. persist (mutation defined in THIS file)
    await ctx.runMutation(internal.agents.detective.save, {
      runId,
      communities,
      threads: topThreads.map((t) => ({
        communityName: keptCommunityNames.has(t.communityName)
          ? t.communityName
          : undefined,
        platform: t.platform,
        url: t.url,
        title: t.title,
        snippet: t.snippet,
        intentScore: t.intentScore,
        intentLabel: t.intentLabel,
        author: t.author,
      })),
    });

    return { communities: communities.length, threads: topThreads.length };
  },
});

// ============================================================================
// save — persists communities + threads. Defined HERE per the agent contract.
// ============================================================================
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    communities: v.array(
      v.object({
        name: v.string(),
        platform: v.string(),
        url: v.string(),
        why: v.string(),
      }),
    ),
    threads: v.array(
      v.object({
        communityName: v.optional(v.string()),
        platform: v.string(),
        url: v.string(),
        title: v.string(),
        snippet: v.string(),
        intentScore: v.number(),
        intentLabel: v.string(),
        author: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { runId, communities, threads }) => {
    // Insert communities first, building a name -> id map for thread linkage.
    const idByName = new Map<string, Id<"communities">>();
    for (const c of communities) {
      const id = await ctx.db.insert("communities", {
        runId,
        name: c.name,
        platform: c.platform,
        url: c.url,
        why: c.why,
      });
      idByName.set(c.name, id);
    }

    for (const t of threads) {
      const communityId =
        t.communityName !== undefined
          ? idByName.get(t.communityName)
          : undefined;
      await ctx.db.insert("threads", {
        runId,
        communityId,
        platform: t.platform,
        url: t.url,
        title: t.title,
        snippet: t.snippet,
        intentScore: t.intentScore,
        intentLabel: t.intentLabel,
        author: t.author,
      });
    }

    return { communities: communities.length, threads: threads.length };
  },
});

// ============================================================================
// threadsForRun — lets the reply agent read this run's threads (highest intent first)
// ============================================================================
export const threadsForRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return threads.sort((a, b) => b.intentScore - a.intentScore);
  },
});

// ============================================================================
// Query derivation
// ============================================================================
async function deriveQueries(
  company: string,
  icp: string,
  positioning: string,
): Promise<string[]> {
  const fallback = fallbackQueries(company, positioning);
  if (!company && !positioning) return fallback;

  try {
    const result = await chatJSON<{ queries?: string[] }>({
      system:
        "You are a B2B demand researcher. Given a company, you produce search queries " +
        "that surface LIVE forum/Reddit/Hacker News threads where prospective buyers are " +
        "actively asking for, comparing, or complaining about tools in this space — i.e. " +
        "people with real purchase intent, NOT marketing pages. Phrase queries the way a " +
        "frustrated buyer would type them. Favor: 'alternatives to <competitor>', " +
        "'looking for a tool that <does the job>', '<pain point> recommendations', " +
        "'best <category> for <ICP>', 'is <incumbent> worth it'. Return STRICT JSON.",
      user: JSON.stringify({
        company,
        idealCustomerProfile: icp,
        positioning,
        instructions: `Return {"queries": string[]} with ${QUERIES_MIN}-${QUERIES_MAX} distinct, high-intent search queries. No quotes inside queries, no boolean operators.`,
      }),
      temperature: 0.4,
      maxTokens: 400,
    });

    const queries = (result?.queries ?? [])
      .map((q) => (typeof q === "string" ? q.trim() : ""))
      .filter((q) => q.length > 0);

    const unique = Array.from(new Set(queries)).slice(0, QUERIES_MAX);
    return unique.length >= QUERIES_MIN ? unique : fallback;
  } catch {
    return fallback;
  }
}

function fallbackQueries(company: string, positioning: string): string[] {
  const subject = company || positioning || "this tool";
  const problem = shortPhrase(positioning) || subject;
  return [
    `alternatives to ${subject}`,
    `looking for a tool like ${subject}`,
    `${problem} recommendations`,
    `best tool for ${problem}`,
    `is ${subject} worth it`,
  ].slice(0, QUERIES_MAX);
}

// ============================================================================
// Intent scoring — THE MOAT. LLM rubric with a deterministic heuristic fallback.
// ============================================================================
async function scoreIntent(
  candidates: Candidate[],
  ctx: { company: string; icp: string; positioning: string },
): Promise<ScoredThread[]> {
  let llmScores: Map<string, { score: number; label: IntentLabel }> | null =
    null;

  try {
    const result = await chatJSON<{
      scores?: Array<{
        url?: string;
        intentScore?: number;
        intentLabel?: string;
      }>;
    }>({
      system: INTENT_SYSTEM_PROMPT,
      user: JSON.stringify({
        company: ctx.company,
        idealCustomerProfile: ctx.icp,
        positioning: ctx.positioning,
        threads: candidates.map((c, i) => ({
          i,
          url: c.url,
          title: c.title,
          snippet: c.snippet.slice(0, 600),
          platform: c.platform,
        })),
        instructions:
          'Return STRICT JSON {"scores": [{"url": string, "intentScore": 0-100 integer, "intentLabel": "browsing"|"comparing"|"frustrated"|"ready_to_buy"}]} — one entry per input thread, same url.',
      }),
      temperature: 0.2,
      maxTokens: 1500,
    });

    llmScores = new Map();
    for (const s of result?.scores ?? []) {
      if (!s?.url) continue;
      llmScores.set(s.url, {
        score: clampScore(s.intentScore),
        label: normalizeLabel(s.intentLabel, clampScore(s.intentScore)),
      });
    }
  } catch {
    llmScores = null;
  }

  return candidates.map((c) => {
    const fromLlm = llmScores?.get(c.url);
    const { score, label } = fromLlm ?? heuristicScore(c);
    const community = communityOf(c);
    return {
      ...c,
      intentScore: score,
      intentLabel: label,
      communityName: community.name,
      communityUrl: community.url,
    };
  });
}

const INTENT_SYSTEM_PROMPT =
  "You are HOLMES's intent analyst. For each forum thread, judge how close the AUTHOR is " +
  "to buying a product like the given company's — based ONLY on the thread title/snippet. " +
  "Score 0-100 and assign exactly one label using this rubric:\n" +
  "- ready_to_buy (80-100): explicitly seeking a recommendation/vendor NOW, asking 'what should I use', " +
  "ready to switch, mentions budget/trial/migrating, evaluating specific options to pick one.\n" +
  "- frustrated (60-85): venting real pain with a current/incumbent tool — 'X is too expensive/broken/slow', " +
  "churning, hitting limits. High intent because they are primed to switch.\n" +
  "- comparing (45-75): weighing options — 'X vs Y', 'alternatives to X', pros/cons, deciding between tools.\n" +
  "- browsing (5-45): general curiosity, learning, 'how does this work', no near-term purchase signal.\n" +
  "Boost the score when the thread describes the EXACT problem the company solves and the author matches the ICP. " +
  "Penalize off-topic threads, news, announcements, and self-promotion. Be calibrated and decisive.";

// Deterministic fallback so the moat survives an OpenAI hiccup.
function heuristicScore(c: Candidate): {
  score: number;
  label: IntentLabel;
} {
  const text = `${c.title} ${c.snippet}`.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => text.includes(n));

  if (
    has(
      "what should i use",
      "what do you use",
      "any recommendations",
      "recommend a",
      "looking for a tool",
      "looking for a service",
      "best tool",
      "ready to switch",
      "about to buy",
      "trying to decide between",
      "which one should i",
    )
  ) {
    return { score: 88, label: "ready_to_buy" };
  }
  if (
    has(
      "too expensive",
      "hate ",
      "frustrated",
      "is broken",
      "keeps breaking",
      "fed up",
      "sick of",
      "terrible",
      "awful",
      "nightmare",
      "problems with",
      "issues with",
      "leaving ",
      "cancel my",
    )
  ) {
    return { score: 74, label: "frustrated" };
  }
  if (
    has(
      " vs ",
      " vs.",
      "versus",
      "alternative",
      "alternatives",
      "compared to",
      "compare",
      "better than",
      "or should i",
      "pros and cons",
    )
  ) {
    return { score: 60, label: "comparing" };
  }
  return { score: 28, label: "browsing" };
}

// ============================================================================
// Community clustering
// ============================================================================
function clusterCommunities(
  threads: ScoredThread[],
  ctx: { company: string; positioning: string },
): Array<{ name: string; platform: string; url: string; why: string }> {
  const groups = new Map<string, ScoredThread[]>();
  for (const t of threads) {
    const arr = groups.get(t.communityName) ?? [];
    arr.push(t);
    groups.set(t.communityName, arr);
  }

  const communities = Array.from(groups.entries()).map(([name, ts]) => {
    const best = ts.reduce((a, b) => (b.intentScore > a.intentScore ? b : a));
    return {
      name,
      platform: ts[0].platform,
      url: ts[0].communityUrl,
      why: buildWhy(name, ts, ctx),
      _best: best.intentScore,
    };
  });

  return communities
    .sort((a, b) => b._best - a._best)
    .map(({ _best, ...c }) => c);
}

function buildWhy(
  name: string,
  threads: ScoredThread[],
  ctx: { company: string; positioning: string },
): string {
  const hot = threads.reduce((a, b) =>
    b.intentScore > a.intentScore ? b : a,
  );
  const counts = threads.reduce<Record<IntentLabel, number>>(
    (acc, t) => {
      acc[t.intentLabel] = (acc[t.intentLabel] ?? 0) + 1;
      return acc;
    },
    { browsing: 0, comparing: 0, frustrated: 0, ready_to_buy: 0 },
  );
  const dominant = (Object.entries(counts) as [IntentLabel, number][])
    .sort((a, b) => b[1] - a[1])[0][0]
    .replace("_", " ");
  const problem = shortPhrase(ctx.positioning) || ctx.company || "this space";
  const n = threads.length;
  return `${name}: ${n} live thread${n === 1 ? "" : "s"} where buyers are ${dominant} around ${problem}. Hottest signal (${hot.intentScore}/100): "${truncate(hot.title, 90)}".`;
}

function communityOf(c: Candidate): { name: string; url: string } {
  if (c.platform === "reddit") {
    const sub = subredditOf(c.url);
    if (sub) {
      return { name: `r/${sub}`, url: `https://www.reddit.com/r/${sub}/` };
    }
    return { name: "Reddit", url: "https://www.reddit.com/" };
  }
  if (c.platform === "hackernews") {
    return { name: "Hacker News", url: "https://news.ycombinator.com/" };
  }
  const host = hostnameOf(c.url);
  return { name: host || "Forum", url: host ? `https://${host}/` : c.url };
}

// ============================================================================
// Normalization helpers
// ============================================================================
function normalizeExaResult(r: RawExaResult): Candidate | null {
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (!isValidHttpUrl(url)) return null;

  const title = (r.title ?? "").trim() || deriveTitleFromUrl(url);
  const snippet = truncate(
    (r.snippet ?? r.text ?? r.highlights?.[0] ?? "").replace(/\s+/g, " ").trim(),
    400,
  );

  return {
    url,
    title,
    snippet,
    platform: platformOf(url),
    author: r.author?.trim() || undefined,
  };
}

function platformOf(url: string): string {
  const host = hostnameOf(url);
  if (host.endsWith("reddit.com")) return "reddit";
  if (host.endsWith("ycombinator.com")) return "hackernews";
  return "forum";
}

function subredditOf(url: string): string | null {
  const m = url.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function deriveTitleFromUrl(url: string): string {
  const slug = url
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "")
    .split("/")
    .pop();
  if (!slug) return "Discussion thread";
  return (
    slug
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase())
      .trim() || "Discussion thread"
  );
}

function dedupeByUrl(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    const key = c.url.split("#")[0].replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function clampScore(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function normalizeLabel(label: unknown, score: number): IntentLabel {
  if (typeof label === "string") {
    const norm = label.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if ((VALID_LABELS as string[]).includes(norm)) return norm as IntentLabel;
  }
  // Derive a sane label from the score when the model omits/garbles it.
  if (score >= 80) return "ready_to_buy";
  if (score >= 60) return "frustrated";
  if (score >= 45) return "comparing";
  return "browsing";
}

function shortPhrase(text: string): string {
  if (!text) return "";
  return truncate(text.split(/[.!?\n]/)[0].trim(), 60);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
