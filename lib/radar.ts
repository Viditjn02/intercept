// ============================================================================
// INTERCEPT — HACKATHON RADAR · SHARED TYPES + MANIFEST
// ----------------------------------------------------------------------------
// "Us vs. the field." INTERCEPT turns its own GTM-intelligence engine on the YC
// AI Growth Hackathon submissions: scrape every project, dissect each repo, and
// synthesize a cached comparison report — where WE lead, where we lag, and a
// ranked list of features worth borrowing (each with its source repo link).
//
// This module is PURE TS (no Convex / no node imports) so it is safe to import
// from lib/vibeapps.ts, convex/hackathonRadar.ts, and any UI the lead builds.
// It owns: the data contract (RadarProject / RadarReport), the INTERCEPT_MANIFEST
// (the "us" side of the comparison), and small total/never-throw helpers shared
// by the scraper and the analyzer (repo-URL parsing, demo-link heuristics, caps).
//
// HONEST BY DESIGN: every field that may be unknown is optional or defaulted;
// provenance + confidence travel with each project; empty repos are LABELED, not
// hallucinated. Public data only — repos + demos, NO private OSINT.
// ============================================================================

// ---------------------------------------------------------------------------
// Config / caps (overridable via env where it helps a live demo stay bounded).
// ---------------------------------------------------------------------------

/** The default submissions source — the YC AI Growth Hackathon tag page. */
export const DEFAULT_TAG_URL = "https://vibeapps.dev/tag/ycgrowthhackathon";

/** Hard cap on how many projects we deep-analyze (repo read + LLM) per run. */
export const RADAR_MAX_ANALYZE = 25;

/** Max README chars handed to the LLM (keeps tokens + cost bounded). */
export const RADAR_README_MAX_CHARS = 4000;

/** Max vibeapps story pages we follow for per-app detail (bounds scrape cost). */
export const RADAR_MAX_STORY_FETCHES = 45;

// ---------------------------------------------------------------------------
// The data contract.
// ---------------------------------------------------------------------------

/**
 * How built-out a project looks. "unknown" is the honest pre-analysis default
 * (we scraped a card but have not read the repo yet). The rest mirror the
 * scout agent's ProjectMaturity ladder so the two surfaces read consistently.
 */
export type RadarMaturity =
  | "unknown"
  | "empty"
  | "placeholder"
  | "prototype"
  | "mvp"
  | "production";

export const RADAR_MATURITIES: readonly RadarMaturity[] = [
  "unknown",
  "empty",
  "placeholder",
  "prototype",
  "mvp",
  "production",
];

/** How much effort it'd take INTERCEPT to adopt a borrowed feature. */
export type BorrowEffort = "low" | "medium" | "high";

export const BORROW_EFFORTS: readonly BorrowEffort[] = ["low", "medium", "high"];

/**
 * One submitted competitor project on the field. Scrape fills name/links; the
 * repo+LLM pass fills whatItDoes/stack/maturity/standoutFeatures/threatLevel.
 */
export interface RadarProject {
  /** Display name / title of the submission. */
  name: string;
  /** One-line pitch as submitted. */
  tagline?: string;
  /** Live/demo URL (the running app), when present. */
  demoUrl?: string;
  /** GitHub repo URL (canonical https://github.com/<owner>/<repo>). */
  githubUrl?: string;
  /** Parsed repo owner (from githubUrl). */
  owner?: string;
  /** Parsed repo name (from githubUrl). */
  repo?: string;
  /** Submitting author / builder (public handle or name). */
  author?: string;
  /** 1-3 sentence read of what it does (LLM, grounded in repo/demo). */
  whatItDoes?: string;
  /** Concrete tech/frameworks/APIs we can SEE referenced. */
  stack?: string[];
  /** Maturity read (defaults "unknown" until the repo is analyzed). */
  maturity: RadarMaturity;
  /** Distinctive features worth noting / potentially borrowing. */
  standoutFeatures?: string[];
  /** 0-100: how directly this overlaps INTERCEPT's space (higher = closer rival). */
  threatLevel: number;
  // --- provenance / honesty (so the report can be trusted) -----------------
  /** True when this project's fields came from a real repo read (not just a card). */
  analyzedFromRepo?: boolean;
  /** Public GitHub stars at analysis time (provenance, never load-bearing). */
  repoStars?: number;
  /** True when the linked repo had no analyzable code/README (LABELED, not faked). */
  repoEmpty?: boolean;
  /** 0..1 confidence in this project's analysis given the source depth. */
  confidence?: number;
  /** Human-readable provenance / caveat (e.g. "card only — repo not read"). */
  note?: string;
}

/** One ranked competitor in the field (the leaderboard). */
export interface RadarRankedEntry {
  name: string;
  /** 0-100 composite "strength on the field" score. */
  score: number;
  oneLiner: string;
}

/** A feature worth borrowing, with its source repo link for verification. */
export interface RadarFeatureToBorrow {
  /** The feature, stated concretely. */
  feature: string;
  /** Which submitted project it came from. */
  sourceProject: string;
  /** Direct repo link so the claim is verifiable in one click. */
  sourceRepoUrl: string;
  /** Why it's worth borrowing for INTERCEPT specifically. */
  why: string;
  /** Rough adoption effort. */
  effort: BorrowEffort;
}

/** The cached "us-vs-the-field" report. */
export interface RadarReport {
  generatedAt: number;
  /** How many projects were on the field this run. */
  fieldSize: number;
  /** The field ranked by strength. */
  ranked: RadarRankedEntry[];
  /** Where INTERCEPT clearly leads the field. */
  ourStrengths: string[];
  /** Where INTERCEPT lags / is missing something the field has. */
  ourGaps: string[];
  /** Ranked features worth borrowing, each with a source repo link. */
  featuresToBorrow: RadarFeatureToBorrow[];
  /** A tight executive read of the whole comparison. */
  summary: string;
}

// ---------------------------------------------------------------------------
// INTERCEPT_MANIFEST — the "us" side. Concise prose the synthesis LLM compares
// the whole field against. Kept factual: only capabilities that are actually
// wired in this repo (sponsors are REAL integrations, not aspirational).
// ---------------------------------------------------------------------------

export const INTERCEPT_MANIFEST = `INTERCEPT is a GTM (go-to-market) Command Center built on Convex + Next.js — one AI-native chat where you paste anything (a company, a URL, a competitor, a community) and a swarm of agents executes a full go-to-market cycle, lighting up a live canvas as it works.

Eight capability tracks share one data model:
1. Community / Discovery — the moat: find the live communities and threads where a company's buyers are already asking the question it answers (Exa + HN + Reddit intent radar).
2. Outbound prospecting + drafting — source target companies and decision-makers, enrich them with real buying signals, and draft grounded outreach.
3. Content / Ad-Factory — generate ad creative end-to-end: image + copy + variations + video.
4. Competitor-ad replication — scan a competitor's live ads across platforms, score them, and reproduce a "generate similar" creative grounded on the real ad.
5. Social / algorithm — read social signals and what the platform algorithm rewards.
6. Onboarding / PLG — product-led onboarding flows that adapt to the user.
7. GitHub Scout — point at an event/org/topic and enumerate the REAL projects being built there from the published artifact (the repo), with honest per-repo teardowns.
8. Analyze — the default full-swarm sweep when you just drop a company with no specific ask.

Cross-cutting product surfaces:
- The shareable Intelligence Dossier — a single link that packages a run's findings for a teammate or prospect.
- A compounding knowledge Brain — every run writes back durable facts, so the system gets smarter over time (vector + keyword recall).
- Blip — a reactive mascot that narrates and reacts to what the swarm is doing.
- 24/7 autonomous mode — active campaigns keep watching and re-running on their own.

Sponsor integrations are wired for REAL (not mocked): Orange Slice (enrich + source B2B leads), Fiber, AgentMail (email send/receive), Supadata (transcripts + JS-rendered web scrape), Pexels (stock imagery), WaveSpeed / fal / Veo (AI video generation), Brew (designed branded email), Exa (neural web search), and OpenAI (the LLM brain across agents).

In one line: INTERCEPT is an end-to-end, swarm-driven GTM operating system — discovery → outbound → content → competitor intel → autonomous follow-through — with a compounding memory and shareable, verifiable outputs.`;

// ---------------------------------------------------------------------------
// Shared pure helpers (total / never-throw) used by scraper + analyzer.
// ---------------------------------------------------------------------------

/** GitHub path segments that are NOT user/org repos (so we never mis-parse them). */
const GITHUB_RESERVED_OWNERS: ReadonlySet<string> = new Set([
  "sponsors", "topics", "features", "about", "pricing", "marketplace", "orgs",
  "settings", "login", "join", "apps", "collections", "explore", "trending",
  "new", "notifications", "search", "site", "customer-stories", "readme",
  "contact", "security", "enterprise", "team", "watching", "stars",
]);

/** Repo second-segments that are really sub-routes of a profile, not repos. */
const GITHUB_NON_REPO_SECOND: ReadonlySet<string> = new Set([
  "followers", "following", "repositories", "projects", "packages", "stars",
  "sponsors",
]);

/** Parsed {owner, repo, url} or null. Strips query/hash/`.git`, lowercases host. */
export function parseRepoUrl(
  raw: string,
): { owner: string; repo: string; url: string } | null {
  if (!raw || typeof raw !== "string") return null;
  const m = raw.match(
    /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]+)/i,
  );
  if (!m) return null;
  const owner = m[1];
  let repo = m[2];
  // Trim a trailing ".git", a trailing dot, or any path/query/hash leftovers.
  repo = repo.replace(/\.git$/i, "").replace(/[.,);:'"]+$/, "");
  if (!owner || !repo) return null;
  if (GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (GITHUB_NON_REPO_SECOND.has(repo.toLowerCase())) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Hosts that are never the project's own "live demo" (social / source / vibeapps). */
const NON_DEMO_HOST_RE =
  /(github\.com|gitlab\.com|vibeapps\.dev|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be|facebook\.com|instagram\.com|t\.me|discord\.(gg|com)|medium\.com|notion\.so|loom\.com|figma\.com|devpost\.com)/i;

/** True when a URL plausibly points at the project's live/demo app. */
export function isLikelyDemoUrl(url: string): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return !NON_DEMO_HOST_RE.test(url);
}

/** Collapse whitespace + trim. Total. */
export function cleanText(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

/** Truncate to `max` chars with an ellipsis. Total. */
export function truncate(text: unknown, max: number): string {
  const t = cleanText(text);
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Clamp a number into [0, 100]; non-finite → fallback. */
export function clamp100(n: unknown, fallback = 0): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(0, Math.min(100, Math.round(x)));
}

/** Clamp a number into [0, 1]; non-finite → fallback. */
export function clamp01(n: unknown, fallback = 0.4): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(0, Math.min(1, x));
}

/** Coerce unknown → a clean string[] (trimmed, de-empty, capped). */
export function toStringArray(value: unknown, cap = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .slice(0, cap);
}

/** Normalize an arbitrary string to a RadarMaturity, else null. */
export function normalizeMaturity(value: unknown): RadarMaturity | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (RADAR_MATURITIES as string[]).includes(v) ? (v as RadarMaturity) : null;
}

/** Normalize an arbitrary string to a BorrowEffort (defaults "medium"). */
export function normalizeEffort(value: unknown): BorrowEffort {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if ((BORROW_EFFORTS as string[]).includes(v)) return v as BorrowEffort;
    if (v.startsWith("lo")) return "low";
    if (v.startsWith("hi")) return "high";
  }
  return "medium";
}

/**
 * Pre-analysis signal score for prioritizing which projects to deep-analyze
 * when the field exceeds RADAR_MAX_ANALYZE. Favors projects with a repo, then a
 * live demo, then a fuller card — all we know before reading the repo. Total.
 */
export function preAnalysisSignal(p: RadarProject): number {
  let s = 0;
  if (p.githubUrl) s += 100;
  if (p.demoUrl) s += 30;
  if (p.tagline && p.tagline.length > 12) s += 10;
  if (p.author) s += 5;
  if (p.name && p.name.length > 2) s += 5;
  return s;
}
