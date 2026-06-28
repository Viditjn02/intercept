// ============================================================================
// INTERCEPT — EXA CLIENT
// THE MOAT depends on this: real, clickable URLs to LIVE conversations where
// buyers are asking the exact question the company answers. Detective agent
// (convex/agents/detective.ts) calls searchThreads from a "use node" action.
// ============================================================================

import Exa from "exa-js";

// Communities where buyer intent surfaces as a public, linkable thread.
const DEFAULT_INCLUDE_DOMAINS = ["reddit.com", "news.ycombinator.com"] as const;
const DEFAULT_NUM_RESULTS = 8;

export interface ExaThread {
  url: string;
  title: string;
  snippet: string;
  author?: string;
  publishedDate?: string;
}

export interface SearchThreadsArgs {
  /** Buyer-intent search query. Required, non-empty. */
  query: string;
  /** How many threads to pull back. Defaults to 8 (MAX_THREADS). */
  numResults?: number;
  /** Override the communities to search. Defaults to Reddit + Hacker News. */
  includeDomains?: string[];
  /** Exa search mode. "keyword" is best for finding exact-question threads. */
  type?: "keyword" | "neural" | "auto";
}

let cachedClient: Exa | null = null;

/**
 * Lazily construct the Exa client. Throws a clear error if the key is missing
 * so the failure is obvious at call time rather than a cryptic SDK error.
 */
function getClient(): Exa {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "EXA_API_KEY is not set. Add it to your environment (Convex dashboard env vars) to enable thread discovery.",
    );
  }
  if (!cachedClient) {
    cachedClient = new Exa(apiKey);
  }
  return cachedClient;
}

/**
 * Build a short snippet from Exa's full-text content. Keeps the most relevant
 * leading chunk and trims to a tweet-ish length for the board.
 */
function toSnippet(text: string | undefined, fallback: string | undefined): string {
  const raw = (text ?? fallback ?? "").replace(/\s+/g, " ").trim();
  if (raw.length <= 280) return raw;
  return `${raw.slice(0, 277).trimEnd()}…`;
}

/**
 * Search live communities for threads matching a buyer-intent query.
 * Returns real, clickable URLs — the core of THE MOAT.
 *
 * Object-form signature shared with detective:
 *   searchThreads({ query, includeDomains?, numResults?, type? })
 */
export async function searchThreads(
  args: SearchThreadsArgs,
): Promise<ExaThread[]> {
  const trimmed = args.query.trim();
  if (!trimmed) {
    throw new Error("searchThreads requires a non-empty query.");
  }

  const exa = getClient();
  const numResults = args.numResults ?? DEFAULT_NUM_RESULTS;
  const includeDomains = args.includeDomains ?? [...DEFAULT_INCLUDE_DOMAINS];
  const type = args.type ?? "keyword";

  const response = await exa.searchAndContents(trimmed, {
    numResults,
    includeDomains,
    type,
    text: true,
  });

  return (response.results ?? [])
    .filter((r) => Boolean(r.url))
    .map((r) => ({
      url: r.url,
      title: (r.title ?? r.url).trim(),
      snippet: toSnippet((r as { text?: string }).text, r.title ?? undefined),
      author: (r as { author?: string }).author?.trim() || undefined,
      publishedDate: r.publishedDate ?? undefined,
    }));
}
