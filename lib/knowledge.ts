// ============================================================================
// INTERCEPT — KNOWLEDGE ENGINE (the compounding wiki loop), pure + graceful.
// ----------------------------------------------------------------------------
// A faithful port of applyagent's Wiki Knowledge Loop (Ingest → Query → Lint)
// onto INTERCEPT's native Convex data model, keyed by GTM ENTITY instead of by
// ATS portal. Every run's REAL outputs (intent threads, qualified prospects,
// replied emails, winning competitor angles, top viral hooks, onboarding flows,
// canonical positioning) become durable, dedup-able FACTS on the entity's page;
// the NEXT run on that entity pulls those facts into its prompt before acting;
// LINT condenses pages so the prompt never bloats (the Karpathy trap bound).
//
// This module is PURE + runtime-agnostic (no convex/_generated imports). Its
// only async helpers are LLM calls (extractFacts / condensePage) and embedding
// (safeEmbed) — ALL of which degrade to a deterministic, bounded result instead
// of throwing, so a missing OPENAI_API_KEY just means "no LLM polish this run".
// It NEVER throws and NEVER blocks a run, a brief render, or finalize.
//
// Consumed by convex/knowledge.ts (the actions/mutations/queries) and by any
// agent that wants prior context via internal.knowledge.queryContext.
// ============================================================================

import { chatJSON, embed } from "./openai";

// ----------------------------------------------------------------------------
// Tuning knobs — the single source of truth for the loop's bounds. Shared by
// ingest, query, lint, and the UI so pages stay bounded and prompts stay lean.
// ----------------------------------------------------------------------------

/** The GTM entity a knowledge page is keyed to. */
export type EntityType = "company" | "competitor" | "icp" | "campaign";

/** Hard cap on facts retained per page (newest-wins beyond this). */
export const MAX_FACTS_PER_PAGE = 40;
/** Hard cap on a page's compiled markdown body. */
export const MAX_PAGE_BYTES = 5_120;
/** Hard cap on the context blob injected into an agent prompt. */
export const MAX_CONTEXT_BYTES = 8_192;
/** Lint a page once it carries at least this many facts. */
export const LINT_FACT_THRESHOLD = 32;
/** Lint a page once its body grows past this many bytes. */
export const LINT_BYTE_THRESHOLD = 6_144;
/** Per-run ingest caps (only the strongest signals become facts). */
export const INGEST_TOP_THREADS = 6;
export const INGEST_TOP_ADS = 6;
export const INGEST_TOP_POSTS = 4;
export const INGEST_TOP_PROSPECTS = 6;
export const INGEST_TOP_TRENDS = 4;
/** Distinct competitors (advertisers) that earn their own page per run. */
export const INGEST_TOP_COMPETITORS = 4;
/** Facts folded into the page embedding text. */
export const EMBED_TOP_FACTS = 12;
/** Semantic neighbours pulled per queryContext call. */
export const QUERY_VECTOR_LIMIT = 4;
/** Facts rendered into an injected context block, per page. */
export const RENDER_TOP_FACTS = 8;
/** Pages a single lint pass will touch (cheap, bounded LLM spend). */
export const LINT_PAGE_BATCH = 25;

// ----------------------------------------------------------------------------
// Types — loose, structural shapes. The Convex query compacts Docs into these
// (no _generated coupling); Doc<"knowledge_pages"> structurally satisfies the
// page-like shapes below (a branded Id is assignable to `string`).
// ----------------------------------------------------------------------------

/** A newly-learned fact, pre-provenance (runId/learnedAt added at upsert). */
export interface NewFact {
  text: string;
  kind: string; // thread | prospect | reply | ad | post | copy | onboarding | positioning | trend | insight
  confidence?: number; // 0-1
  source?: string; // detective | sourcer | writer | adscout | composer | guide | enrich | trendscout | openai
  url?: string; // clickable provenance when present
}

/** A fact already persisted on a page (carries provenance). */
export interface StoredFact extends NewFact {
  runId?: string;
  learnedAt: number;
}

/** Anything page-shaped enough to render / condense (Doc satisfies this). */
export interface KnowledgePageLike {
  title: string;
  entityType: string;
  entityKey: string;
  content?: string;
  facts: StoredFact[];
  factCount: number;
  runCount: number;
  updatedAt: number;
}

// --- Compacted run outputs the ingest query hands to the pure resolvers. -----
export interface IngestRun {
  id: string;
  intent: string;
  input: string;
  company?: string;
  routedDomain?: string;
  campaignId?: string;
}
export interface IngestBrief {
  icp?: string;
  positioning?: string;
}
export interface IngestThread {
  url?: string;
  title?: string;
  snippet?: string;
  intentScore?: number;
  intentLabel?: string;
  platform?: string;
}
export interface IngestProspect {
  company?: string;
  title?: string;
  employeeCount?: string;
  signalSummary?: string;
  signalUrl?: string;
  stage?: string;
  fitScore?: number;
}
export interface IngestEmail {
  subject?: string;
  status?: string;
}
export interface IngestAd {
  advertiser?: string;
  text?: string;
  headline?: string;
  winningAngle?: string;
  daysRunning?: number;
  perfScore?: number;
  scalingSignal?: boolean;
  url?: string;
}
export interface IngestPost {
  platform?: string;
  hook?: string;
  angle?: string;
  viralityScore?: number;
}
export interface IngestAdCreative {
  strategy?: string;
  headline?: string;
}
export interface IngestOnboarding {
  productName?: string;
  framework?: string;
  stepCount?: number;
}
export interface IngestTrend {
  topic?: string;
  angle?: string;
  score?: number;
  url?: string;
}
export interface IngestBundle {
  run: IngestRun;
  brief: IngestBrief | null;
  threads: IngestThread[];
  prospects: IngestProspect[];
  emails: IngestEmail[];
  ads: IngestAd[];
  posts: IngestPost[];
  adCreatives: IngestAdCreative[];
  onboardingFlows: IngestOnboarding[];
  trends: IngestTrend[];
}

/** One page to upsert this run (facts only; embedding computed in the action). */
export interface IngestTarget {
  entityType: EntityType;
  entityKey: string;
  title: string;
  newFacts: NewFact[];
}

// ----------------------------------------------------------------------------
// Pure helpers — slug/key/normalize/bound/render. No I/O, never throw.
// ----------------------------------------------------------------------------

/** Normalize an entity identifier into a stable, dedup-able slug key. */
export function slug(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "") // drop any path
    .replace(/[^a-z0-9.\-]+/g, "-") // keep domain dots/hyphens
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
}

/** The canonical company key for a run (domain preferred, then name/input). */
export function keyFor(run: Pick<IngestRun, "routedDomain" | "company" | "input">): string {
  const candidate = run.routedDomain?.trim() || run.company?.trim() || run.input?.trim() || "";
  return slug(candidate) || "unknown";
}

/** Human display name for a run's company page. */
export function displayName(run: Pick<IngestRun, "company" | "routedDomain" | "input">): string {
  return (run.company?.trim() || run.routedDomain?.trim() || run.input?.trim() || "Unknown").slice(0, 120);
}

/** Collapse a fact to a comparison key so near-identical facts dedupe away. */
export function normalizeFact(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "") // urls are provenance, not identity
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Byte-bounded truncation (UTF-8 aware) — keeps pages/prompts under cap. */
export function boundBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (enc.encode(s.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Dedupe rendered blocks (by normalized text) and join with a rule. */
export function dedupeBlocks(parts: string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(t);
  }
  return kept.join("\n\n---\n\n");
}

/** Dedupe stored facts, newest-wins, preserving provenance. */
export function dedupeStoredFacts(facts: StoredFact[]): StoredFact[] {
  const byKey = new Map<string, StoredFact>();
  for (const f of [...facts].sort((a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0))) {
    const key = normalizeFact(f.text);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, f);
  }
  return [...byKey.values()].sort((a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0));
}

/** Keep the newest N facts. */
export function boundFacts(facts: StoredFact[], cap: number): StoredFact[] {
  return [...facts].sort((a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0)).slice(0, cap);
}

/** Build the compiled markdown body of a page from its facts. */
export function renderPageContent(
  title: string,
  facts: ReadonlyArray<{ text: string; kind?: string; url?: string }>,
): string {
  const lines = [`# ${title}`, ""];
  for (const f of facts) {
    const tag = f.kind ? `**[${f.kind}]** ` : "";
    const link = f.url ? ` ([source](${f.url}))` : "";
    lines.push(`- ${tag}${f.text}${link}`);
  }
  return boundBytes(lines.join("\n").trim(), MAX_PAGE_BYTES);
}

/** Render a page as a compact context block for injection into a prompt. */
export function renderPageBlock(page: KnowledgePageLike): string {
  const facts = boundFacts(page.facts ?? [], RENDER_TOP_FACTS);
  const lines = [
    `### ${page.title} (${page.runCount} run${page.runCount === 1 ? "" : "s"}, ${page.factCount} facts)`,
  ];
  for (const f of facts) {
    const link = f.url ? ` <${f.url}>` : "";
    lines.push(`- ${f.text}${link}`);
  }
  return lines.join("\n").trim();
}

// ----------------------------------------------------------------------------
// Deterministic fact extraction — the always-available floor. Pulls REUSABLE
// patterns straight from a run's real outputs, no LLM required.
// ----------------------------------------------------------------------------

function topThreads(threads: IngestThread[]): IngestThread[] {
  return [...threads]
    .sort((a, b) => (b.intentScore ?? 0) - (a.intentScore ?? 0))
    .slice(0, INGEST_TOP_THREADS);
}
function topAds(ads: IngestAd[]): IngestAd[] {
  return [...ads]
    .sort(
      (a, b) =>
        (b.perfScore ?? 0) - (a.perfScore ?? 0) ||
        (b.daysRunning ?? 0) - (a.daysRunning ?? 0),
    )
    .slice(0, INGEST_TOP_ADS);
}
function topPosts(posts: IngestPost[]): IngestPost[] {
  return [...posts]
    .sort((a, b) => (b.viralityScore ?? 0) - (a.viralityScore ?? 0))
    .slice(0, INGEST_TOP_POSTS);
}

/** Build the ad-derived fact for a single competitor ad. */
function adFact(ad: IngestAd): NewFact {
  const angle =
    ad.winningAngle?.trim() ||
    ad.headline?.trim() ||
    (ad.text ?? "").trim().slice(0, 160) ||
    "(creative)";
  const dur =
    ad.daysRunning != null
      ? ` — running ${ad.daysRunning}d${ad.scalingSignal ? ", scaling" : ""}`
      : "";
  return {
    text: `Winning angle: ${angle}${dur}`.slice(0, 400),
    kind: "ad",
    source: "adscout",
    url: ad.url,
    confidence: ad.perfScore != null ? clamp01(ad.perfScore / 100) : undefined,
  };
}

/** Non-competitor facts (everything that belongs on the company/icp page). */
export function deterministicCompanyFacts(bundle: IngestBundle): NewFact[] {
  const out: NewFact[] = [];

  if (bundle.brief?.positioning?.trim()) {
    out.push({
      text: `Positioning: ${bundle.brief.positioning.trim()}`.slice(0, 400),
      kind: "positioning",
      source: "enrich",
    });
  }

  for (const t of topThreads(bundle.threads)) {
    if (!t.title && !t.snippet) continue;
    const platform = t.platform ?? "a community";
    const label = t.intentLabel ? ` [${t.intentLabel}]` : "";
    out.push({
      text: `On ${platform}, buyers ask: "${(t.title ?? t.snippet ?? "").slice(0, 180)}"${label}`,
      kind: "thread",
      source: "detective",
      url: t.url,
      confidence: t.intentScore != null ? clamp01(t.intentScore / 100) : undefined,
    });
  }

  const qualified = bundle.prospects
    .filter((p) => p.signalSummary || p.stage === "qualified" || (p.fitScore ?? 0) >= 60)
    .slice(0, INGEST_TOP_PROSPECTS);
  for (const p of qualified) {
    const role = p.title?.trim() || "decision-maker";
    const size = p.employeeCount ? ` (${p.employeeCount})` : "";
    const trigger = p.signalSummary ? `; trigger: ${p.signalSummary}` : "";
    out.push({
      text: `ICP: ${role} at ${p.company ?? "target"}${size}${trigger}`.slice(0, 400),
      kind: "prospect",
      source: "sourcer",
      url: p.signalUrl,
    });
  }

  const replied = bundle.emails.find((e) => e.status === "replied" && e.subject);
  if (replied?.subject) {
    out.push({
      text: `Outbound subject that earned a reply: "${replied.subject.slice(0, 160)}"`,
      kind: "reply",
      source: "writer",
    });
  }

  for (const post of topPosts(bundle.posts)) {
    if (!post.hook) continue;
    out.push({
      text: `High-scoring ${post.platform ?? "social"} hook: "${post.hook.slice(0, 160)}" — angle ${post.angle ?? "n/a"}`.slice(0, 400),
      kind: "post",
      source: "composer",
      confidence: post.viralityScore != null ? clamp01(post.viralityScore / 100) : undefined,
    });
  }

  const strat = bundle.adCreatives.find((c) => c.strategy?.trim());
  if (strat?.strategy) {
    out.push({
      text: `Ad copy strategy that won: ${strat.strategy.trim().slice(0, 240)}`,
      kind: "copy",
      source: "adsmith",
    });
  }

  const flow = bundle.onboardingFlows[0];
  if (flow?.productName) {
    out.push({
      text: `Activation flow for ${flow.productName}: ${flow.framework ?? "guided"} tour, ${flow.stepCount ?? 0} steps`,
      kind: "onboarding",
      source: "guide",
    });
  }

  for (const tr of [...bundle.trends].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, INGEST_TOP_TRENDS)) {
    if (!tr.topic) continue;
    out.push({
      text: `Trend: ${tr.topic} — ${tr.angle ?? ""}`.slice(0, 400),
      kind: "trend",
      source: "trendscout",
      url: tr.url,
      confidence: tr.score != null ? clamp01(tr.score / 100) : undefined,
    });
  }

  return out;
}

// ----------------------------------------------------------------------------
// LLM fact extraction — refines the deterministic facts into crisper, reusable
// statements. ALWAYS falls back to the deterministic floor on any failure.
// ----------------------------------------------------------------------------

function summarizeBundle(bundle: IngestBundle, base: NewFact[]): string {
  const lines = [
    `Company: ${displayName(bundle.run)} (${bundle.run.intent} run)`,
    bundle.brief?.icp ? `ICP: ${bundle.brief.icp}` : "",
    bundle.brief?.positioning ? `Positioning: ${bundle.brief.positioning}` : "",
    "",
    "Concrete signals observed this run:",
    ...base.map((f) => `- [${f.kind}] ${f.text}`),
  ].filter(Boolean);
  return boundBytes(lines.join("\n"), 6_000);
}

interface ExtractModelOutput {
  facts?: Array<{ text?: string; kind?: string; confidence?: number }>;
}

/**
 * Extract durable, REUSABLE facts for the entity. Combines an LLM polish pass
 * (high-level patterns) with the deterministic, provenance-bearing floor.
 * Never throws — on any LLM/key failure it returns the deterministic facts.
 */
export async function extractFacts(bundle: IngestBundle): Promise<NewFact[]> {
  const base = deterministicCompanyFacts(bundle);
  // Competitor (ad) facts live on their own pages — keep them out of the LLM pass.
  if (base.length === 0) return base;

  try {
    const model = await chatJSON<ExtractModelOutput>({
      system:
        "You distill a GTM run's outputs into durable, REUSABLE facts for a " +
        "knowledge wiki. A good fact is a pattern the NEXT run can trust and act " +
        "on (a buyer pain, a positioning truth, a channel that worked, an ICP " +
        "trait). Drop anything one-off or run-specific. Be terse and concrete. " +
        "STRICT JSON only.",
      user: [
        summarizeBundle(bundle, base),
        "",
        "Return JSON: { \"facts\": [{ \"text\": string (<=200 chars, a reusable " +
          "statement), \"kind\": one of thread|prospect|reply|post|copy|" +
          "onboarding|positioning|trend|insight, \"confidence\": 0..1 }] }. " +
          "Return at most 10 facts.",
      ].join("\n"),
      temperature: 0.2,
      maxTokens: 700,
    });

    const refined: NewFact[] = (model.facts ?? [])
      .filter((f) => f.text && f.text.trim().length > 0)
      .slice(0, 10)
      .map((f) => ({
        text: f.text!.trim().slice(0, 400),
        kind: (f.kind ?? "insight").trim() || "insight",
        confidence: f.confidence != null ? clamp01(f.confidence) : undefined,
        source: "openai",
      }));

    // Deterministic facts carry the clickable provenance, so keep BOTH — the
    // upsert dedupes overlaps. LLM-refined patterns lead.
    return [...refined, ...base];
  } catch {
    return base;
  }
}

// ----------------------------------------------------------------------------
// Target resolution — map a run's facts onto the entity pages they belong to.
// Pure: company (always), competitor-per-advertiser, icp (if a brief), and
// campaign (if the run is campaign-bound). Never throws.
// ----------------------------------------------------------------------------

export function resolveIngestTargets(bundle: IngestBundle, facts: NewFact[]): IngestTarget[] {
  const targets: IngestTarget[] = [];
  const companyFacts = facts.filter((f) => f.kind !== "ad");

  // 1) Company page — always, the canonical market knowledge for this entity.
  const companyKey = keyFor(bundle.run);
  if (companyFacts.length > 0) {
    targets.push({
      entityType: "company",
      entityKey: companyKey,
      title: `${displayName(bundle.run)} — knowledge`,
      newFacts: companyFacts,
    });
  }

  // 2) Competitor pages — one per distinct advertiser surfaced by the scan.
  const byAdvertiser = new Map<string, { name: string; ads: IngestAd[] }>();
  for (const ad of topAds(bundle.ads)) {
    const name = ad.advertiser?.trim();
    if (!name) continue;
    const key = slug(name);
    if (!key) continue;
    const entry = byAdvertiser.get(key) ?? { name, ads: [] };
    entry.ads.push(ad);
    byAdvertiser.set(key, entry);
  }
  let competitorCount = 0;
  for (const [key, entry] of byAdvertiser) {
    if (competitorCount >= INGEST_TOP_COMPETITORS) break;
    competitorCount += 1;
    targets.push({
      entityType: "competitor",
      entityKey: key,
      title: `${entry.name} — competitor ads`,
      newFacts: entry.ads.slice(0, 4).map(adFact),
    });
  }

  // 3) ICP page — buyer-segment knowledge, keyed by a normalized brief.icp.
  const icp = bundle.brief?.icp?.trim();
  if (icp) {
    const icpKey = slug(icp.split(/[.;,]/)[0] ?? icp).slice(0, 60) || "icp";
    const icpFacts = companyFacts.filter((f) => f.kind === "prospect" || f.kind === "thread");
    if (icpFacts.length > 0) {
      targets.push({
        entityType: "icp",
        entityKey: icpKey,
        title: `ICP: ${icp.slice(0, 80)}`,
        newFacts: icpFacts,
      });
    }
  }

  // 4) Campaign page — a standing outbound campaign's compounding memory.
  if (bundle.run.campaignId && companyFacts.length > 0) {
    targets.push({
      entityType: "campaign",
      entityKey: bundle.run.campaignId,
      title: `Campaign — ${displayName(bundle.run)}`,
      newFacts: companyFacts,
    });
  }

  return targets;
}

// ----------------------------------------------------------------------------
// LINT — condense an over-threshold page. Deterministic dedupe/bound floor,
// with an optional LLM narrative pass. Never throws; always returns a bounded
// page (the Karpathy-trap bound holds even with no OpenAI key).
// ----------------------------------------------------------------------------

export interface CondensedPage {
  title: string;
  content: string;
  facts: StoredFact[];
}

export async function condensePage(page: KnowledgePageLike): Promise<CondensedPage> {
  // Deterministic floor: dedupe + newest-wins cap (provenance preserved).
  const facts = boundFacts(dedupeStoredFacts(page.facts ?? []), MAX_FACTS_PER_PAGE);
  let content = renderPageContent(page.title, facts);

  try {
    const model = await chatJSON<{ content?: string }>({
      system:
        "You are a wiki editor keeping a GTM knowledge page tight. Merge " +
        "near-duplicate points, resolve contradictions in favor of the most " +
        "recent, and write a single crisp markdown briefing. Keep it under 4KB. " +
        "STRICT JSON only.",
      user: [
        `Page: ${page.title}`,
        "",
        "Facts (newest first):",
        ...facts.map((f) => `- [${f.kind}] ${f.text}`),
        "",
        'Return JSON: { "content": string (markdown, <=4000 chars) }.',
      ].join("\n"),
      temperature: 0.2,
      maxTokens: 900,
    });
    if (model.content?.trim()) {
      content = boundBytes(model.content.trim(), MAX_PAGE_BYTES);
    }
  } catch {
    // keep the deterministic body
  }

  return { title: page.title, content: boundBytes(content, MAX_PAGE_BYTES), facts };
}

// ----------------------------------------------------------------------------
// Embedding helpers — graceful (undefined on any failure, never throw).
// ----------------------------------------------------------------------------

/** The text we embed for a page: its title + its strongest facts. */
export function embedTextForPage(title: string, facts: ReadonlyArray<{ text: string }>): string {
  return boundBytes(
    [title, ...facts.slice(0, EMBED_TOP_FACTS).map((f) => f.text)].join("\n"),
    8_000,
  );
}

/** Embed a string, returning undefined (not throwing) if OpenAI is unavailable. */
export async function safeEmbed(text: string): Promise<number[] | undefined> {
  try {
    return await embed(text);
  } catch {
    return undefined;
  }
}
