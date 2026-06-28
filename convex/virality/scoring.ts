// ============================================================================
// INTERCEPT — TRACK 1 · VIRALITY SCORING (OSS PLUS).
//
// Pure, fetch-free, deterministic. A "harsh reviewer" virality model the
// composer uses to score every drafted post variant 0-100 and pick the best one
// to surface. There is no LLM call here on purpose: a deterministic rubric makes
// the score reproducible, debuggable, and impossible to stall — it runs even
// when OpenAI is down, so the composer's "best variant" decision never blocks.
//
// The rubric scores five dimensions (mirrors lib/contract ViralityScore):
//   • hook       — does the first line stop the scroll?
//   • emotion    — does it trigger a feeling / take a stance?
//   • clarity    — is it skimmable, concrete, jargon-free?
//   • timeliness — is it pegged to something happening NOW (a trend)?
//   • cta        — is there a single, clear ask that drives engagement?
//
// HARSH by design: each dimension STARTS LOW and must EARN points from concrete
// signals, so a generic corporate post scores ~30 and a sharp, trend-pegged,
// CTA-driven hook scores ~85+. This spread makes pickBest meaningful.
//
// DEPLOY-SAFETY: NOT "use node"; defines no Convex functions (utility module).
// ============================================================================

import type { ViralityScore } from "../../lib/contract";

/** The minimal post shape the model scores. */
export interface ScorablePost {
  hook: string;
  body: string;
  hashtags?: string[];
  angle?: string;
  platform?: string;
}

/** A post paired with its computed virality score. */
export interface ScoredPost<T extends ScorablePost = ScorablePost> {
  post: T;
  virality: ViralityScore;
}

// Per-dimension weights — sum to 1. The hook dominates because on every feed the
// first line decides whether anything else is ever read.
const WEIGHTS = {
  hook: 0.3,
  emotion: 0.2,
  clarity: 0.2,
  timeliness: 0.15,
  cta: 0.15,
} as const;

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

// ----------------------------------------------------------------------------
// Signal lexicons — the rubric's "what good looks like".
// ----------------------------------------------------------------------------

// Generic, scroll-past corporate openers. Their presence in the hook is a heavy
// penalty: these are the #1 reason a post dies in the feed.
const WEAK_OPENERS = [
  "in today's",
  "in today’s",
  "we are excited",
  "we're excited",
  "i am excited",
  "i'm excited",
  "i am thrilled",
  "i'm thrilled",
  "we are thrilled",
  "as a company",
  "in the world of",
  "in this article",
  "let me tell you",
  "without further ado",
  "it is important to",
];

// Power / emotion words that signal a stance, tension, or curiosity gap.
const EMOTION_WORDS = [
  "stop",
  "never",
  "nobody",
  "everyone",
  "secret",
  "mistake",
  "wrong",
  "fail",
  "failed",
  "broke",
  "broken",
  "hate",
  "love",
  "fear",
  "shocking",
  "surprising",
  "honestly",
  "truth",
  "lie",
  "myth",
  "hard truth",
  "unpopular",
  "controversial",
  "warning",
  "regret",
  "obsessed",
  "insane",
  "brutal",
  "painful",
];

// Words that peg a post to the present moment (timeliness).
const TIMELY_WORDS = [
  "now",
  "today",
  "just",
  "new",
  "latest",
  "trending",
  "this week",
  "this year",
  "2025",
  "2026",
  "breaking",
  "right now",
  "currently",
  "announced",
  "launch",
  "launched",
];

// Explicit calls-to-action that drive comments / shares / follows.
const CTA_WORDS = [
  "comment",
  "share",
  "follow",
  "repost",
  "save this",
  "save it",
  "link in bio",
  "dm me",
  "dm us",
  "drop a",
  "tag someone",
  "tag a",
  "try it",
  "try this",
  "join",
  "sign up",
  "what do you think",
  "agree?",
  "thoughts?",
  "let me know",
];

// Jargon that erodes clarity — vague filler that says nothing concrete.
const JARGON_WORDS = [
  "synergy",
  "leverage",
  "paradigm",
  "ecosystem",
  "holistic",
  "robust",
  "seamless",
  "best-in-class",
  "cutting-edge",
  "next-generation",
  "revolutionary",
  "disrupt",
  "empower",
  "unlock",
  "utilize",
  "thought leader",
];

const containsAny = (text: string, words: readonly string[]): number =>
  words.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0);

// ----------------------------------------------------------------------------
// Per-dimension scorers. Each starts LOW and earns points from real signals.
// ----------------------------------------------------------------------------

/** Hook (0-100): does line one stop the scroll? Starts at 25, earns up to 100. */
function scoreHook(hook: string): number {
  const h = hook.trim();
  if (!h) return 0;
  const lower = h.toLowerCase();
  const words = wordCount(h);
  let s = 25;

  // Brevity wins on the feed — a tight hook is read in full.
  if (words <= 8) s += 22;
  else if (words <= 14) s += 12;
  else if (words > 24) s -= 18;

  if (/^\s*\d|\b\d+%|\b\d+x\b|\$\d/.test(h)) s += 18; // leads with a number / stat
  if (h.includes("?")) s += 12; // a question opens a curiosity gap
  if (/\byou\b|\byour\b/.test(lower)) s += 10; // speaks to the reader directly
  if (/^(stop|how|why|the|nobody|most|everyone|i |we )/i.test(h)) s += 8; // strong frame
  if (containsAny(lower, EMOTION_WORDS) > 0) s += 8; // tension in the hook itself

  for (const opener of WEAK_OPENERS) {
    if (lower.startsWith(opener) || lower.includes(opener)) {
      s -= 30; // corporate opener = scroll-past
      break;
    }
  }
  return clamp(s);
}

/** Emotion (0-100): stance, tension, curiosity. Starts at 20. */
function scoreEmotion(post: ScorablePost): number {
  const text = `${post.hook} ${post.body}`.toLowerCase();
  let s = 20;
  s += Math.min(45, containsAny(text, EMOTION_WORDS) * 15);
  if (/!/.test(`${post.hook}${post.body}`)) s += 8; // an exclamation adds energy
  if (text.includes("?")) s += 8; // questions invite a reaction
  if (/\bvs\.?\b|\binstead of\b|\bnot\b.*\bbut\b/.test(text)) s += 10; // contrast/stance
  return clamp(s);
}

/** Clarity (0-100): skimmable, concrete, jargon-free. Starts at 35. */
function scoreClarity(post: ScorablePost): number {
  const body = post.body.trim();
  const words = wordCount(body);
  let s = 35;

  if (words >= 12 && words <= 60) s += 25; // the sweet spot for a feed post
  else if (words > 0 && words < 12) s += 8; // a little thin
  if (words > 120) s -= 25; // a wall of text — nobody finishes it

  if (/\n/.test(body)) s += 10; // line breaks → skimmable structure
  const jargon = containsAny(body.toLowerCase(), JARGON_WORDS);
  s -= jargon * 12; // every buzzword erodes trust + clarity

  // Punchy short sentences read fast.
  const sentences = body.split(/[.!?]+/).map((x) => x.trim()).filter(Boolean);
  if (sentences.length > 0) {
    const avg = sentences.reduce((n, x) => n + wordCount(x), 0) / sentences.length;
    if (avg <= 12) s += 10;
    else if (avg > 22) s -= 10;
  }
  return clamp(s);
}

/** Timeliness (0-100): pegged to a live trend / the present moment. Starts at 20. */
function scoreTimeliness(post: ScorablePost): number {
  const text = `${post.hook} ${post.body} ${post.angle ?? ""}`.toLowerCase();
  let s = 20;
  s += Math.min(50, containsAny(text, TIMELY_WORDS) * 16);
  if ((post.angle ?? "").trim().length > 0) s += 18; // an explicit trend angle
  return clamp(s);
}

/** CTA (0-100): one clear ask that drives engagement. Starts at 15. */
function scoreCta(post: ScorablePost): number {
  const text = `${post.body}`.toLowerCase();
  const tail = text.slice(-160); // CTAs live at the end
  let s = 15;
  if (containsAny(text, CTA_WORDS) > 0) s += 35;
  if (containsAny(tail, CTA_WORDS) > 0) s += 15; // bonus if it CLOSES on the ask
  if (post.body.trim().endsWith("?")) s += 18; // a closing question = free engagement
  const tags = post.hashtags?.length ?? 0;
  if (tags >= 1 && tags <= 4) s += 12; // a few targeted tags help reach
  else if (tags > 8) s -= 10; // hashtag soup looks spammy
  return clamp(s);
}

// ----------------------------------------------------------------------------
// PUBLIC API.
// ----------------------------------------------------------------------------

/**
 * Score a post's virality 0-100 with a per-dimension breakdown.
 * Pure + deterministic — the same post always yields the same score.
 */
export function scoreVirality(post: ScorablePost): ViralityScore {
  const breakdown = {
    hook: scoreHook(post.hook),
    emotion: scoreEmotion(post),
    clarity: scoreClarity(post),
    timeliness: scoreTimeliness(post),
    cta: scoreCta(post),
  };
  const score = clamp(
    breakdown.hook * WEIGHTS.hook +
      breakdown.emotion * WEIGHTS.emotion +
      breakdown.clarity * WEIGHTS.clarity +
      breakdown.timeliness * WEIGHTS.timeliness +
      breakdown.cta * WEIGHTS.cta,
  );
  return { score, breakdown };
}

/** Score a batch of variants. Returns each post paired with its score. */
export function scoreVariants<T extends ScorablePost>(posts: T[]): ScoredPost<T>[] {
  return posts.map((post) => ({ post, virality: scoreVirality(post) }));
}

/**
 * Pick the single highest-scoring variant. Ties break on the hook sub-score
 * (the dimension that matters most on the feed). Returns null for an empty set.
 */
export function pickBest<T extends ScorablePost>(
  scored: ScoredPost<T>[],
): ScoredPost<T> | null {
  if (scored.length === 0) return null;
  return [...scored].sort((a, b) => {
    if (b.virality.score !== a.virality.score) {
      return b.virality.score - a.virality.score;
    }
    return b.virality.breakdown.hook - a.virality.breakdown.hook;
  })[0];
}

/**
 * Harsh-reviewer feedback: concrete, actionable notes on every weak dimension,
 * worst-first. A strong post returns a single line of praise. Used for the live
 * feed + the canvas tooltip so the user sees WHY a variant won or lost.
 */
export function buildFeedback(post: ScorablePost, score?: ViralityScore): string[] {
  const v = score ?? scoreVirality(post);
  const notes: Array<{ dim: number; text: string }> = [];

  if (v.breakdown.hook < 60) {
    notes.push({
      dim: v.breakdown.hook,
      text: "Hook is weak — open with a number, a question, or a contrarian claim in ≤8 words.",
    });
  }
  if (v.breakdown.emotion < 55) {
    notes.push({
      dim: v.breakdown.emotion,
      text: "No emotional charge — take a stance or surface tension; neutral posts don't spread.",
    });
  }
  if (v.breakdown.clarity < 55) {
    notes.push({
      dim: v.breakdown.clarity,
      text: "Hard to skim — cut jargon, shorten sentences, add line breaks.",
    });
  }
  if (v.breakdown.timeliness < 50) {
    notes.push({
      dim: v.breakdown.timeliness,
      text: "Not pegged to now — tie it to a live trend so the algorithm sees relevance.",
    });
  }
  if (v.breakdown.cta < 50) {
    notes.push({
      dim: v.breakdown.cta,
      text: "Missing a clear ask — end on a question or an explicit call to comment/share.",
    });
  }

  if (notes.length === 0) {
    return [`Strong across the board (${v.score}/100) — ship it.`];
  }
  return notes.sort((a, b) => a.dim - b.dim).map((n) => n.text);
}
