// ============================================================================
// INTERCEPT — HACKATHON RADAR  ·  "us vs. the field"
// ----------------------------------------------------------------------------
// Turn INTERCEPT's own GTM-intelligence engine on the YC AI Growth Hackathon
// submissions. ONE public action — `runRadar({ tagUrl? })` — does the full pass:
//
//   1) SCRAPE   → lib/vibeapps.fetchHackathonProjects(tagUrl): the field of
//                 submitted projects (name, tagline, demo, GitHub repo).
//   2) DISSECT  → for the top ~25 by signal WITH a repo, read it via lib/github
//                 (getRepo/getReadme/getManifest/getContributors) and analyze it
//                 with lib/openai.chatJSON → whatItDoes / stack / maturity /
//                 standoutFeatures / threatLevel. Empty repos are LABELED.
//   3) PERSIST  → upsert one `radarProjects` row per project (latest run wins).
//   4) SYNTHESIZE → one more chatJSON comparing the WHOLE field to the
//                 INTERCEPT_MANIFEST → a RadarReport (ourStrengths, ourGaps,
//                 ranked, featuresToBorrow with source repo links, summary).
//   5) CACHE    → upsert the single latest `radarReports` row.
//
// Read it back with `getReport` (latest RadarReport | null) and `listProjects`
// (analyzed projects, newest-first).
//
// HONEST: confidence + provenance travel with every project; empty repos are
// labeled (never hallucinated); public data only (repos + demos), NO private
// OSINT. GRACEFUL: no Supadata key, no GitHub network, no OpenAI key, or an
// empty page all degrade to a thinner report — this action NEVER throws.
//
// RUNTIME: NOT "use node" (it owns the persistence mutations/queries). All libs
// here are fetch-based and run in Convex's DEFAULT action runtime (like scout).
// ============================================================================

import { v } from "convex/values";
import {
  action,
  internalMutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { chatJSON } from "../lib/openai";
import {
  getRepo,
  getReadme,
  getManifest,
  getContributors,
  githubTokenPresent,
  type GithubRepo,
} from "../lib/github";
import { fetchHackathonProjects } from "../lib/vibeapps";
import { supadataEnabled } from "../lib/supadata";
import {
  INTERCEPT_MANIFEST,
  DEFAULT_TAG_URL,
  RADAR_MAX_ANALYZE,
  RADAR_README_MAX_CHARS,
  type RadarProject,
  type RadarReport,
  type RadarRankedEntry,
  type RadarFeatureToBorrow,
  type RadarMaturity,
  parseRepoUrl,
  preAnalysisSignal,
  normalizeMaturity,
  normalizeEffort,
  clamp100,
  clamp01,
  toStringArray,
  cleanText,
  truncate,
} from "../lib/radar";

// ============================================================================
// runRadar — the public manual trigger.
// ============================================================================

export interface RunRadarSummary {
  ok: boolean;
  tagUrl: string;
  fieldSize: number;
  analyzed: number; // repos actually read + analyzed
  capped: number; // repo-bearing projects we did NOT analyze (over the cap)
  emptyReposLabeled: number;
  reportGenerated: boolean;
  note: string;
}

export const runRadar = action({
  args: { tagUrl: v.optional(v.string()) },
  handler: async (ctx, { tagUrl }): Promise<RunRadarSummary> => {
    const url = cleanText(tagUrl) || DEFAULT_TAG_URL;
    const runKey = `radar_${Date.now()}`;

    // 1) SCRAPE the field (graceful: [] on any failure).
    let field: RadarProject[] = [];
    try {
      field = await fetchHackathonProjects(url);
    } catch {
      field = [];
    }

    if (field.length === 0) {
      // Still cache an honest empty report so getReport never 404s the UI.
      const empty = emptyReport(url);
      await ctx.runMutation(internal.hackathonRadar.saveProjects, {
        runKey,
        projects: [],
      });
      await ctx.runMutation(internal.hackathonRadar.saveReport, {
        report: empty,
        tagUrl: url,
        analyzedCount: 0,
        cappedCount: 0,
        provenance: provenanceNow(0, 0),
      });
      return {
        ok: false,
        tagUrl: url,
        fieldSize: 0,
        analyzed: 0,
        capped: 0,
        emptyReposLabeled: 0,
        reportGenerated: true,
        note:
          "No projects scraped from the tag page. Likely a missing Supadata key " +
          "(the page is JS-rendered) or an empty/changed page. Cached an empty report.",
      };
    }

    // 2) Pick which projects to DEEP-ANALYZE: those with a repo, top-by-signal,
    //    capped. Log (return) what was capped so the trigger is honest.
    const withRepo = field
      .filter((p) => !!p.githubUrl)
      .sort((a, b) => preAnalysisSignal(b) - preAnalysisSignal(a));
    const toAnalyze = withRepo.slice(0, RADAR_MAX_ANALYZE);
    const cappedCount = Math.max(0, withRepo.length - toAnalyze.length);
    const analyzeUrls = new Set(toAnalyze.map((p) => p.githubUrl));

    // 3) DISSECT each chosen repo (parallel, fully isolated per project).
    const analyzedByUrl = new Map<string, RadarProject>();
    const settled = await Promise.allSettled(
      toAnalyze.map((p) => analyzeProjectRepo(p)),
    );
    settled.forEach((s, i) => {
      const original = toAnalyze[i];
      const result =
        s.status === "fulfilled" ? s.value : lightLabel(original, "Repo analysis failed.");
      if (original.githubUrl) analyzedByUrl.set(original.githubUrl, result);
    });

    // Merge: analyzed projects replace their scrape-only versions; the rest stay
    // as honest "card only" rows (or "repo not analyzed — over cap" labels).
    const merged: RadarProject[] = field.map((p) => {
      if (p.githubUrl && analyzedByUrl.has(p.githubUrl)) {
        return analyzedByUrl.get(p.githubUrl)!;
      }
      if (p.githubUrl && !analyzeUrls.has(p.githubUrl)) {
        return lightLabel(
          p,
          "Repo not analyzed this run (below the analysis cap).",
        );
      }
      return p; // scrape-only card (no repo)
    });

    // Rank the whole field by composite strength for stable ordering.
    const ranked = [...merged].sort((a, b) => fieldScore(b) - fieldScore(a));

    const analyzedCount = ranked.filter(
      (p) => p.analyzedFromRepo && !p.repoEmpty,
    ).length;
    const emptyReposLabeled = ranked.filter((p) => p.repoEmpty).length;

    // 4) PERSIST projects (latest run wins — saveProjects clears the prior run).
    await ctx.runMutation(internal.hackathonRadar.saveProjects, {
      runKey,
      projects: ranked,
    });

    // 5) SYNTHESIZE the report (graceful heuristic fallback when OpenAI is off).
    const report = await synthesizeReport(ranked, url);
    await ctx.runMutation(internal.hackathonRadar.saveReport, {
      report,
      tagUrl: url,
      analyzedCount,
      cappedCount,
      provenance: provenanceNow(analyzedCount, emptyReposLabeled),
    });

    return {
      ok: true,
      tagUrl: url,
      fieldSize: ranked.length,
      analyzed: analyzedCount,
      capped: cappedCount,
      emptyReposLabeled,
      reportGenerated: true,
      note: `Analyzed ${analyzedCount} repo(s) of ${ranked.length} projects` +
        (cappedCount > 0 ? `; capped ${cappedCount} repo(s) over the ${RADAR_MAX_ANALYZE} limit.` : "."),
    };
  },
});

// ============================================================================
// getReport — the latest cached RadarReport, or null.
// ============================================================================

export const getReport = query({
  args: {},
  handler: async (ctx): Promise<RadarReport | null> => {
    const row = await ctx.db
      .query("radarReports")
      .withIndex("by_key", (q) => q.eq("key", "latest"))
      .unique()
      .catch(() => null);
    if (!row) return null;
    return {
      generatedAt: row.generatedAt,
      fieldSize: row.fieldSize,
      ranked: row.ranked,
      ourStrengths: row.ourStrengths,
      ourGaps: row.ourGaps,
      featuresToBorrow: row.featuresToBorrow.map((f) => ({
        feature: f.feature,
        sourceProject: f.sourceProject,
        sourceRepoUrl: f.sourceRepoUrl,
        why: f.why,
        effort: normalizeEffort(f.effort),
      })),
      summary: row.summary,
    };
  },
});

// ============================================================================
// listProjects — the analyzed field, newest-first.
// ============================================================================

export const listProjects = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<Doc<"radarProjects">[]> => {
    const cap = Math.max(1, Math.min(limit ?? 200, 500));
    return await ctx.db
      .query("radarProjects")
      .withIndex("by_generated")
      .order("desc")
      .take(cap);
  },
});

// ============================================================================
// Per-repo dissect → a populated RadarProject (LLM, heuristic fallback).
// ============================================================================

async function analyzeProjectRepo(project: RadarProject): Promise<RadarProject> {
  const parsed = project.githubUrl ? parseRepoUrl(project.githubUrl) : null;
  if (!parsed) return lightLabel(project, "No parseable repo URL.");
  const fullName = `${parsed.owner}/${parsed.repo}`;

  // Refresh repo meta; fall back gracefully when GitHub is unreachable.
  const repo = await getRepo(fullName);
  if (!repo) {
    return {
      ...project,
      owner: parsed.owner,
      repo: parsed.repo,
      githubUrl: parsed.url,
      analyzedFromRepo: false,
      confidence: 0.25,
      note: "Repo link present but GitHub metadata was unreachable (rate-limit/404).",
    };
  }

  const [team, readme, manifest] = await Promise.all([
    getContributors(fullName, 6),
    getReadme(fullName),
    getManifest(fullName),
  ]);

  const readmeText = (readme ?? "").trim();
  const hasContent = readmeText.length > 40 || repo.sizeKb > 12;

  // Empty / placeholder repo — HONEST label, no fabricated analysis.
  if (!hasContent) {
    const placeholder = !!(repo.description && repo.description.trim());
    return {
      ...project,
      owner: parsed.owner,
      repo: parsed.repo,
      githubUrl: repo.htmlUrl,
      whatItDoes: placeholder
        ? `Repo created with a description but no public code yet: "${truncate(repo.description!, 140)}"`
        : "Repo created, no public code or README yet (placeholder push).",
      stack: repo.language ? [repo.language] : [],
      maturity: placeholder ? "placeholder" : "empty",
      standoutFeatures: [],
      threatLevel: clamp100(8),
      analyzedFromRepo: true,
      repoStars: repo.stars,
      repoEmpty: true,
      confidence: 0.2,
      note: "Empty/placeholder repo — analysis withheld (labeled, not guessed).",
    };
  }

  const heuristic = heuristicAnalysis(project, repo, readmeText);
  const llm = await llmAnalyze(project, repo, readmeText, manifest);
  const chosen = llm ?? heuristic;

  return {
    ...project,
    owner: parsed.owner,
    repo: parsed.repo,
    githubUrl: repo.htmlUrl,
    author:
      project.author ?? (team[0]?.login ? `@${team[0].login}` : undefined),
    whatItDoes: chosen.whatItDoes,
    stack: chosen.stack,
    maturity: chosen.maturity,
    standoutFeatures: chosen.standoutFeatures,
    threatLevel: chosen.threatLevel,
    analyzedFromRepo: true,
    repoStars: repo.stars,
    repoEmpty: false,
    confidence: chosen.confidence,
    note: llm
      ? "Analyzed from repo README + metadata."
      : "Heuristic analysis (OpenAI key absent or call failed).",
  };
}

interface RepoAnalysis {
  whatItDoes: string;
  stack: string[];
  maturity: RadarMaturity;
  standoutFeatures: string[];
  threatLevel: number;
  confidence: number;
}

async function llmAnalyze(
  project: RadarProject,
  repo: GithubRepo,
  readme: string,
  manifest: { path: string; content: string } | null,
): Promise<RepoAnalysis | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const result = await chatJSON<{
      whatItDoes?: string;
      stack?: string[];
      maturity?: string;
      standoutFeatures?: string[];
      threatLevel?: number;
      confidence?: number;
    }>({
      system:
        "You are INTERCEPT's competitive analyst. INTERCEPT is a GTM (go-to-market) " +
        "Command Center: AI swarm for community discovery, outbound prospecting + " +
        "drafting, ad/content generation, competitor-ad replication, and a shareable " +
        "intelligence dossier. Given ONE hackathon project's repo (metadata + README, " +
        "maybe a manifest), produce an HONEST teardown. Judge ONLY from the provided " +
        "text — never invent features. If the README is thin, say so and lower " +
        "confidence. threatLevel (0-100) = how DIRECTLY this project overlaps " +
        "INTERCEPT's GTM-intelligence space (100 = a head-on rival, 0 = unrelated). " +
        "Return STRICT JSON.",
      user: JSON.stringify({
        submittedAs: { name: project.name, tagline: project.tagline ?? null },
        repo: {
          fullName: repo.fullName,
          description: repo.description,
          language: repo.language,
          topics: repo.topics,
          stars: repo.stars,
          createdAt: repo.createdAt,
          pushedAt: repo.pushedAt,
          sizeKb: repo.sizeKb,
        },
        manifest: manifest
          ? { path: manifest.path, content: truncate(manifest.content, 1200) }
          : null,
        readme: truncate(readme, RADAR_README_MAX_CHARS),
        instructions:
          'Return {"whatItDoes": string (2-3 sentences: the problem + their ' +
          'approach), "stack": string[] (concrete tech/frameworks/APIs you can SEE ' +
          'referenced), "maturity": one of "empty"|"placeholder"|"prototype"|"mvp"|' +
          '"production", "standoutFeatures": string[] (1-4 distinctive features worth ' +
          'noting / possibly borrowing), "threatLevel": number 0-100 (overlap with ' +
          'INTERCEPT GTM space), "confidence": number 0..1 (given README depth)}.',
      }),
      temperature: 0.3,
      maxTokens: 800,
    });

    return {
      whatItDoes:
        cleanText(result.whatItDoes) ||
        cleanText(repo.description) ||
        `A ${repo.language ?? "software"} project.`,
      stack: toStringArray(result.stack, 8),
      maturity: normalizeMaturity(result.maturity) ?? inferMaturity(repo, readme),
      standoutFeatures: toStringArray(result.standoutFeatures, 4),
      threatLevel: clamp100(result.threatLevel, heuristicThreat(project, repo, readme)),
      confidence: clamp01(result.confidence, 0.55),
    };
  } catch {
    return null;
  }
}

function heuristicAnalysis(
  project: RadarProject,
  repo: GithubRepo,
  readme: string,
): RepoAnalysis {
  const firstLine = readme
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0 && !l.startsWith("![") && !l.startsWith("<"));
  const whatItDoes =
    cleanText(project.tagline) ||
    cleanText(repo.description) ||
    (firstLine ? truncate(firstLine, 200) : `A ${repo.language ?? "software"} project.`);
  return {
    whatItDoes,
    stack: inferStack(repo, readme),
    maturity: inferMaturity(repo, readme),
    standoutFeatures: [],
    threatLevel: heuristicThreat(project, repo, readme),
    confidence: Math.min(0.6, 0.3 + Math.min(readme.length, 3000) / 8000),
  };
}

// ============================================================================
// SYNTHESIZE — compare the whole field to INTERCEPT_MANIFEST → RadarReport.
// ============================================================================

async function synthesizeReport(
  field: RadarProject[],
  tagUrl: string,
): Promise<RadarReport> {
  const now = Date.now();
  if (field.length === 0) return emptyReport(tagUrl);

  // Compact, token-bounded view of the field for the synthesis prompt.
  const compact = field.slice(0, 40).map((p) => ({
    name: p.name,
    tagline: p.tagline ?? null,
    whatItDoes: p.whatItDoes ?? null,
    stack: p.stack ?? [],
    maturity: p.maturity,
    threatLevel: p.threatLevel,
    repo: p.githubUrl ?? null,
    demo: p.demoUrl ?? null,
    analyzedFromRepo: !!p.analyzedFromRepo,
  }));

  const llm = await llmSynthesize(compact, field, now, tagUrl);
  return llm ?? heuristicReport(field, now, tagUrl);
}

async function llmSynthesize(
  compact: unknown,
  field: RadarProject[],
  now: number,
  tagUrl: string,
): Promise<RadarReport | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const raw = await chatJSON<{
      ranked?: Array<{ name?: string; score?: number; oneLiner?: string }>;
      ourStrengths?: string[];
      ourGaps?: string[];
      featuresToBorrow?: Array<{
        feature?: string;
        sourceProject?: string;
        sourceRepoUrl?: string;
        why?: string;
        effort?: string;
      }>;
      summary?: string;
    }>({
      system:
        "You are INTERCEPT's head of competitive strategy. You are given (a) a prose " +
        "manifest of what INTERCEPT is, and (b) the FIELD of hackathon projects it is " +
        "competing against. Produce an HONEST 'us-vs-the-field' report. Be specific and " +
        "grounded ONLY in the provided data — never invent a project, feature, or repo " +
        "link. ourStrengths = where INTERCEPT clearly leads the field. ourGaps = where " +
        "the field has something INTERCEPT lacks or does worse. featuresToBorrow = the " +
        "highest-leverage features worth adopting, each tied to the project it came from " +
        "and that project's repo URL (use the repo URL from the field data verbatim; if a " +
        "project has no repo, do not cite it as a borrow source). Return STRICT JSON.",
      user: JSON.stringify({
        INTERCEPT_MANIFEST,
        field: compact,
        instructions:
          'Return {"ranked": [{"name": string (must be a project name from the field), ' +
          '"score": number 0-100 (strength on the field), "oneLiner": string}], ' +
          '"ourStrengths": string[] (3-6), "ourGaps": string[] (3-6), ' +
          '"featuresToBorrow": [{"feature": string, "sourceProject": string (a field ' +
          'project name), "sourceRepoUrl": string (that project\'s repo URL from the ' +
          'field), "why": string (why it helps INTERCEPT specifically), "effort": ' +
          '"low"|"medium"|"high"}] (3-8, ranked best-first), "summary": string ' +
          "(3-5 sentences, the executive read)}.",
      }),
      temperature: 0.4,
      maxTokens: 1600,
    });

    const ranked = coerceRanked(raw.ranked, field);
    const featuresToBorrow = coerceFeatures(raw.featuresToBorrow, field);
    const ourStrengths = toStringArray(raw.ourStrengths, 8);
    const ourGaps = toStringArray(raw.ourGaps, 8);
    const summary = cleanText(raw.summary);

    // If the model gave us essentially nothing usable, fall back to heuristics.
    if (ranked.length === 0 && ourStrengths.length === 0 && !summary) return null;

    return {
      generatedAt: now,
      fieldSize: field.length,
      ranked: ranked.length > 0 ? ranked : heuristicRanked(field),
      ourStrengths:
        ourStrengths.length > 0 ? ourStrengths : DEFAULT_STRENGTHS,
      ourGaps: ourGaps.length > 0 ? ourGaps : DEFAULT_GAPS,
      featuresToBorrow:
        featuresToBorrow.length > 0
          ? featuresToBorrow
          : heuristicFeatures(field),
      summary:
        summary ||
        `INTERCEPT vs. a field of ${field.length} hackathon projects (see ranked + gaps).`,
    };
  } catch {
    return null;
  }
}

/** Validate LLM ranked entries against the real field; clamp + cap. */
function coerceRanked(
  raw: RadarReport["ranked"] | unknown,
  field: RadarProject[],
): RadarRankedEntry[] {
  if (!Array.isArray(raw)) return [];
  const names = new Map(field.map((p) => [p.name.toLowerCase(), p.name]));
  const out: RadarRankedEntry[] = [];
  const seen = new Set<string>();
  for (const r of raw as Array<{ name?: unknown; score?: unknown; oneLiner?: unknown }>) {
    const name = names.get(cleanText(r.name).toLowerCase());
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      score: clamp100(r.score, 50),
      oneLiner: truncate(r.oneLiner, 160) || name,
    });
    if (out.length >= 25) break;
  }
  return out;
}

/** Validate borrow features — each MUST resolve to a real source link. */
function coerceFeatures(
  raw: unknown,
  field: RadarProject[],
): RadarFeatureToBorrow[] {
  if (!Array.isArray(raw)) return [];
  const byName = new Map(field.map((p) => [p.name.toLowerCase(), p]));
  const out: RadarFeatureToBorrow[] = [];
  for (const f of raw as Array<Record<string, unknown>>) {
    const feature = truncate(f.feature, 160);
    if (!feature) continue;
    const sourceProject = cleanText(f.sourceProject);
    const proj = byName.get(sourceProject.toLowerCase());
    // Prefer an LLM-provided repo URL if it's a real GitHub repo; else the
    // matched project's own repo; else its demo. Drop if no source link at all.
    const llmRepo = parseRepoUrl(cleanText(f.sourceRepoUrl))?.url;
    const sourceRepoUrl =
      llmRepo ?? proj?.githubUrl ?? proj?.demoUrl ?? "";
    if (!sourceRepoUrl) continue;
    out.push({
      feature,
      sourceProject: proj?.name ?? sourceProject ?? "the field",
      sourceRepoUrl,
      why: truncate(f.why, 200) || "Adjacent capability worth evaluating.",
      effort: normalizeEffort(f.effort),
    });
    if (out.length >= 12) break;
  }
  return out;
}

// ============================================================================
// HEURISTIC fallbacks (so a report always renders without OpenAI).
// ============================================================================

const DEFAULT_STRENGTHS: string[] = [
  "End-to-end GTM swarm: discovery → outbound → content → competitor intel in one flow, not a single point tool.",
  "Real sponsor integrations wired (Orange Slice, AgentMail, Supadata, Exa, Veo/WaveSpeed/fal, Brew) rather than mocked.",
  "Compounding knowledge Brain + shareable Intelligence Dossier give durable, verifiable outputs.",
  "24/7 autonomous mode keeps active campaigns watching and re-running on their own.",
];

const DEFAULT_GAPS: string[] = [
  "Heuristic report (OpenAI key absent): gaps not yet synthesized from the field — connect OPENAI_API_KEY for the full us-vs-them read.",
];

function heuristicReport(
  field: RadarProject[],
  now: number,
  tagUrl: string,
): RadarReport {
  return {
    generatedAt: now,
    fieldSize: field.length,
    ranked: heuristicRanked(field),
    ourStrengths: DEFAULT_STRENGTHS,
    ourGaps: DEFAULT_GAPS,
    featuresToBorrow: heuristicFeatures(field),
    summary:
      `Heuristic scan of ${field.length} projects from ${tagUrl} (OpenAI key absent — ` +
      "rankings/borrow-list are signal-based, not LLM-synthesized). Connect OpenAI for the full report.",
  };
}

function heuristicRanked(field: RadarProject[]): RadarRankedEntry[] {
  return [...field]
    .sort((a, b) => fieldScore(b) - fieldScore(a))
    .slice(0, 15)
    .map((p) => ({
      name: p.name,
      score: clamp100(fieldScore(p)),
      oneLiner:
        truncate(p.whatItDoes ?? p.tagline, 160) ||
        `${p.maturity} project${p.repoStars ? ` · ${p.repoStars}★` : ""}.`,
    }));
}

function heuristicFeatures(field: RadarProject[]): RadarFeatureToBorrow[] {
  const out: RadarFeatureToBorrow[] = [];
  for (const p of [...field].sort((a, b) => fieldScore(b) - fieldScore(a))) {
    const link = p.githubUrl ?? p.demoUrl;
    if (!link) continue;
    const feature = (p.standoutFeatures ?? [])[0] ?? cleanText(p.tagline);
    if (!feature) continue;
    out.push({
      feature: truncate(feature, 160),
      sourceProject: p.name,
      sourceRepoUrl: link,
      why: "Adjacent to INTERCEPT's GTM space — evaluate for the roadmap.",
      effort: "medium",
    });
    if (out.length >= 8) break;
  }
  return out;
}

function emptyReport(tagUrl: string): RadarReport {
  return {
    generatedAt: Date.now(),
    fieldSize: 0,
    ranked: [],
    ourStrengths: DEFAULT_STRENGTHS,
    ourGaps: [
      "No field scraped yet — run again with a Supadata key set (the tag page is JS-rendered).",
    ],
    featuresToBorrow: [],
    summary:
      `No projects were scraped from ${tagUrl}. The page is JS-rendered, so a Supadata ` +
      "key is needed (or the page/tag changed). This is an honest empty report, not an error.",
  };
}

// ============================================================================
// Scoring / inference helpers (pure, total).
// ============================================================================

const MATURITY_WEIGHT: Record<RadarMaturity, number> = {
  unknown: 5,
  empty: 2,
  placeholder: 8,
  prototype: 25,
  mvp: 55,
  production: 80,
};

/** Composite 0-100 "strength on the field" used for ranking + ordering. */
function fieldScore(p: RadarProject): number {
  const maturity = MATURITY_WEIGHT[p.maturity] ?? 5;
  const stars = Math.min(20, (p.repoStars ?? 0) / 2);
  const threat = p.threatLevel * 0.3;
  const live = p.demoUrl ? 8 : 0;
  const analyzed = p.analyzedFromRepo && !p.repoEmpty ? 6 : 0;
  const confidence = (p.confidence ?? 0.4) * 10;
  return clamp100(maturity * 0.5 + stars + threat + live + analyzed + confidence);
}

const GTM_KEYWORDS =
  /\b(gtm|go-to-market|outbound|outreach|prospect|lead\s*gen|leads?|sales|marketing|cold\s*email|crm|campaign|ad(s|vert)|seo|growth|funnel|content\s*generation|competitor|enrich)\b/i;

function heuristicThreat(
  project: RadarProject,
  repo: GithubRepo,
  readme: string,
): number {
  const hay = `${project.name} ${project.tagline ?? ""} ${repo.description ?? ""} ${repo.topics.join(" ")} ${readme.slice(0, 1500)}`;
  const hits = (hay.match(GTM_KEYWORDS) ?? []).length;
  return clamp100(Math.min(85, hits * 18 + (repo.stars > 10 ? 10 : 0)));
}

function inferStack(repo: GithubRepo, readme: string): string[] {
  const hay = `${readme}\n${repo.topics.join(" ")}`.toLowerCase();
  const out = new Set<string>();
  if (repo.language) out.add(repo.language);
  const probes: [RegExp, string][] = [
    [/\bnext\.?js\b/, "Next.js"],
    [/\breact\b/, "React"],
    [/\bconvex\b/, "Convex"],
    [/\bsupabase\b/, "Supabase"],
    [/\bpostgres\b/, "Postgres"],
    [/\bopenai\b|gpt-4|gpt-3/, "OpenAI"],
    [/\banthropic\b|claude/, "Anthropic"],
    [/\bgemini\b/, "Gemini"],
    [/\blangchain\b/, "LangChain"],
    [/\bfastapi\b/, "FastAPI"],
    [/\bflask\b/, "Flask"],
    [/\bdjango\b/, "Django"],
    [/\bexpress\b/, "Express"],
    [/\btailwind\b/, "Tailwind"],
    [/\bvercel\b/, "Vercel"],
    [/\btypescript\b/, "TypeScript"],
  ];
  for (const [re, label] of probes) if (re.test(hay)) out.add(label);
  return Array.from(out).slice(0, 8);
}

function inferMaturity(repo: GithubRepo, readme: string): RadarMaturity {
  if (repo.sizeKb < 12 && readme.length < 200) return "empty";
  if (readme.length < 200) return "placeholder";
  if (repo.stars >= 50 || readme.length > 3000) return "production";
  if (repo.sizeKb > 400 || readme.length > 1200) return "mvp";
  return "prototype";
}

/** A scrape-only or unanalyzed project, carrying an honest provenance note. */
function lightLabel(project: RadarProject, note: string): RadarProject {
  const parsed = project.githubUrl ? parseRepoUrl(project.githubUrl) : null;
  return {
    ...project,
    owner: project.owner ?? parsed?.owner,
    repo: project.repo ?? parsed?.repo,
    githubUrl: parsed?.url ?? project.githubUrl,
    maturity: project.maturity ?? "unknown",
    threatLevel: project.threatLevel ?? 0,
    analyzedFromRepo: false,
    note,
  };
}

function provenanceNow(reposAnalyzed: number, emptyReposLabeled: number) {
  return {
    githubTokenPresent: githubTokenPresent(),
    openaiPresent: !!process.env.OPENAI_API_KEY,
    supadataPresent: supadataEnabled(),
    reposAnalyzed,
    emptyReposLabeled,
  };
}

// ============================================================================
// Persistence (defined HERE so the action + reads share one module).
// ============================================================================

const radarProjectValidator = v.object({
  name: v.string(),
  tagline: v.optional(v.string()),
  demoUrl: v.optional(v.string()),
  githubUrl: v.optional(v.string()),
  owner: v.optional(v.string()),
  repo: v.optional(v.string()),
  author: v.optional(v.string()),
  whatItDoes: v.optional(v.string()),
  stack: v.optional(v.array(v.string())),
  maturity: v.string(),
  standoutFeatures: v.optional(v.array(v.string())),
  threatLevel: v.number(),
  analyzedFromRepo: v.optional(v.boolean()),
  repoStars: v.optional(v.number()),
  repoEmpty: v.optional(v.boolean()),
  confidence: v.optional(v.number()),
  note: v.optional(v.string()),
});

export const saveProjects = internalMutation({
  args: {
    runKey: v.string(),
    projects: v.array(radarProjectValidator),
  },
  handler: async (ctx, { runKey, projects }): Promise<number> => {
    // Latest run wins: clear all prior rows (hackathon scale is small/bounded).
    const prior = await ctx.db.query("radarProjects").take(1000);
    for (const row of prior) await ctx.db.delete(row._id);

    const now = Date.now();
    for (const p of projects) {
      await ctx.db.insert("radarProjects", {
        runKey,
        name: p.name,
        tagline: p.tagline,
        demoUrl: p.demoUrl,
        githubUrl: p.githubUrl,
        owner: p.owner,
        repo: p.repo,
        author: p.author,
        whatItDoes: p.whatItDoes,
        stack: p.stack,
        maturity: p.maturity,
        standoutFeatures: p.standoutFeatures,
        threatLevel: p.threatLevel,
        analyzedFromRepo: p.analyzedFromRepo,
        repoStars: p.repoStars,
        repoEmpty: p.repoEmpty,
        confidence: p.confidence,
        note: p.note,
        generatedAt: now,
      });
    }
    return projects.length;
  },
});

const rankedValidator = v.array(
  v.object({ name: v.string(), score: v.number(), oneLiner: v.string() }),
);
const featuresValidator = v.array(
  v.object({
    feature: v.string(),
    sourceProject: v.string(),
    sourceRepoUrl: v.string(),
    why: v.string(),
    effort: v.string(),
  }),
);

export const saveReport = internalMutation({
  args: {
    report: v.object({
      generatedAt: v.number(),
      fieldSize: v.number(),
      ranked: rankedValidator,
      ourStrengths: v.array(v.string()),
      ourGaps: v.array(v.string()),
      featuresToBorrow: featuresValidator,
      summary: v.string(),
    }),
    tagUrl: v.string(),
    analyzedCount: v.number(),
    cappedCount: v.number(),
    provenance: v.object({
      githubTokenPresent: v.boolean(),
      openaiPresent: v.boolean(),
      supadataPresent: v.boolean(),
      reposAnalyzed: v.number(),
      emptyReposLabeled: v.number(),
    }),
  },
  handler: async (
    ctx,
    { report, tagUrl, analyzedCount, cappedCount, provenance },
  ): Promise<void> => {
    const existing = await ctx.db
      .query("radarReports")
      .withIndex("by_key", (q) => q.eq("key", "latest"))
      .unique()
      .catch(() => null);

    const doc = {
      key: "latest",
      generatedAt: report.generatedAt,
      fieldSize: report.fieldSize,
      ranked: report.ranked,
      ourStrengths: report.ourStrengths,
      ourGaps: report.ourGaps,
      featuresToBorrow: report.featuresToBorrow,
      summary: report.summary,
      tagUrl,
      analyzedCount,
      cappedCount,
      provenance,
    };

    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("radarReports", doc);
  },
});
