// ============================================================================
// INTERCEPT — KNOWLEDGE ENGINE (Convex side of the compounding wiki loop).
// ----------------------------------------------------------------------------
// The native-Convex port of applyagent's Wiki Knowledge Loop. THREE actions +
// the queries/mutations they ride on, all in the DEFAULT runtime (NOT "use
// node"): they use chatJSON/embed (fetch SDK) + ctx.vectorSearch + typed
// ctx.runQuery/ctx.runMutation — exactly what enrich/detective already do.
//
//   • ingestFromRun  — after a run finalizes, read its REAL outputs, extract
//                      durable facts, embed, and UPSERT the entity page(s).
//                      Scheduled (fire-and-forget) by run.finalize. NEVER throws.
//   • queryContext   — the agent-facing recall: embed the question, vector-search
//                      neighbouring pages (+ an exact-page fast path + the OPTIONAL
//                      gbrain layer), and return a byte-bounded context blob.
//   • lintPages      — the daily cron: condense over-threshold pages so the wiki
//                      stays bounded (the Karpathy-trap bound). NEVER throws.
//
// Everything is ADDITIVE + GRACEFUL: a missing OpenAI key, an empty page, or an
// unreachable gbrain just means "no learned context this run". No entry point
// can touch run status or block a brief render. The pure logic + prompts live in
// lib/knowledge.ts; this module is the Convex wiring.
// ============================================================================

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  condensePage,
  dedupeBlocks,
  boundBytes,
  embedTextForPage,
  extractFacts,
  normalizeFact,
  renderPageBlock,
  renderPageContent,
  resolveIngestTargets,
  safeEmbed,
  LINT_BYTE_THRESHOLD,
  LINT_FACT_THRESHOLD,
  LINT_PAGE_BATCH,
  MAX_CONTEXT_BYTES,
  MAX_FACTS_PER_PAGE,
  QUERY_VECTOR_LIMIT,
} from "../lib/knowledge";
import type {
  EntityType,
  IngestBundle,
  NewFact,
  StoredFact,
} from "../lib/knowledge";

// Convex validators (mirrors lib/knowledge types + schema knowledge_pages).
const entityTypeValidator = v.union(
  v.literal("company"),
  v.literal("competitor"),
  v.literal("icp"),
  v.literal("campaign"),
);

const newFactValidator = v.object({
  text: v.string(),
  kind: v.string(),
  confidence: v.optional(v.number()),
  source: v.optional(v.string()),
  url: v.optional(v.string()),
});

const storedFactValidator = v.object({
  text: v.string(),
  kind: v.string(),
  confidence: v.optional(v.number()),
  source: v.optional(v.string()),
  url: v.optional(v.string()),
  runId: v.optional(v.string()), // accepted as string; cast to Id<"runs"> on write
  learnedAt: v.number(),
});

// ============================================================================
// QUERIES — the read side (default runtime, no I/O).
// ============================================================================

/**
 * Compact a run's REAL outputs into the bundle the ingest action distills into
 * facts. Returns null when the run is missing. Bounded reads — every table is
 * pulled by its `by_run` index (emails by `by_status` since it has none).
 */
export const runOutputsForIngest = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<IngestBundle | null> => {
    const run = await ctx.db.get(runId);
    if (!run) return null;

    const briefDoc = await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();

    const threads = await ctx.db
      .query("threads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const prospects = await ctx.db
      .query("prospects")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const adCreatives = await ctx.db
      .query("adCreatives")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const onboardingFlows = await ctx.db
      .query("onboardingFlows")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const trends = await ctx.db
      .query("trends")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    // emails has no by_run index — pull the replied ones and filter to this run.
    const repliedEmails = await ctx.db
      .query("emails")
      .withIndex("by_status", (q) => q.eq("status", "replied"))
      .take(200);

    return {
      run: {
        id: String(run._id),
        intent: run.intent,
        input: run.input,
        company: run.company,
        routedDomain: run.routedDomain,
        campaignId: run.campaignId ? String(run.campaignId) : undefined,
      },
      brief: briefDoc
        ? { icp: briefDoc.icp, positioning: briefDoc.positioning }
        : null,
      threads: threads.map((t) => ({
        url: t.url,
        title: t.title,
        snippet: t.snippet,
        intentScore: t.intentScore,
        intentLabel: t.intentLabel,
        platform: t.platform,
      })),
      prospects: prospects.map((p) => ({
        company: p.company,
        title: p.title,
        employeeCount: p.employeeCount,
        signalSummary: p.signal?.summary,
        signalUrl: p.signal?.url,
        stage: p.stage,
        fitScore: p.fitScore,
      })),
      emails: repliedEmails
        .filter((e) => e.runId === runId)
        .map((e) => ({ subject: e.subject, status: e.status })),
      ads: ads.map((a) => ({
        advertiser: a.advertiser,
        text: a.text,
        headline: a.headline,
        winningAngle: a.winningAngle,
        daysRunning: a.daysRunning,
        perfScore: a.perfScore,
        scalingSignal: a.scalingSignal,
        url: a.url,
      })),
      posts: posts.map((p) => ({
        platform: p.platform,
        hook: p.hook,
        angle: p.angle,
        viralityScore: p.viralityScore,
      })),
      adCreatives: adCreatives.map((c) => ({
        strategy: c.strategy,
        headline: c.headline,
      })),
      onboardingFlows: onboardingFlows.map((f) => ({
        productName: f.productName,
        framework: f.framework,
        stepCount: f.tourSteps.length,
      })),
      trends: trends.map((t) => ({
        topic: t.topic,
        angle: t.angle,
        score: t.score,
        url: t.url,
      })),
    };
  },
});

/** Exact-page lookup (the canonical fast path). */
export const getPageByEntity = internalQuery({
  args: { entityType: v.string(), entityKey: v.string() },
  handler: async (
    ctx,
    { entityType, entityKey },
  ): Promise<Doc<"knowledge_pages"> | null> => {
    return await ctx.db
      .query("knowledge_pages")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", entityType as EntityType).eq("entityKey", entityKey),
      )
      .first();
  },
});

/** Hydrate the pages behind a set of vector-search hits. */
export const getPagesByIds = internalQuery({
  args: { ids: v.array(v.id("knowledge_pages")) },
  handler: async (ctx, { ids }): Promise<Doc<"knowledge_pages">[]> => {
    const pages = await Promise.all(ids.map((id) => ctx.db.get(id)));
    return pages.filter((p): p is Doc<"knowledge_pages"> => p !== null);
  },
});

/** Over-threshold pages the lint pass should condense (cheap + bounded). */
export const pagesNeedingLint = internalQuery({
  args: { factThreshold: v.number(), byteThreshold: v.number() },
  handler: async (
    ctx,
    { factThreshold, byteThreshold },
  ): Promise<Doc<"knowledge_pages">[]> => {
    const all = await ctx.db.query("knowledge_pages").take(500);
    const enc = new TextEncoder();
    return all
      .filter(
        (p) =>
          p.factCount >= factThreshold ||
          enc.encode(p.content).length >= byteThreshold,
      )
      .slice(0, LINT_PAGE_BATCH);
  },
});

/**
 * Public listing for the UI (BrainCanvas) — most-recently-updated pages, optional
 * entityType filter. Read-only; safe to subscribe to from the client.
 */
export const listPages = query({
  args: {
    entityType: v.optional(entityTypeValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { entityType, limit }): Promise<Doc<"knowledge_pages">[]> => {
    const take = Math.min(limit ?? 60, 200);
    if (entityType) {
      return await ctx.db
        .query("knowledge_pages")
        .withIndex("by_type_updated", (q) => q.eq("entityType", entityType))
        .order("desc")
        .take(take);
    }
    return await ctx.db.query("knowledge_pages").order("desc").take(take);
  },
});

/**
 * Public brain-wide stats for the UI header (BrainCanvas) — the visible "it grows
 * every run" numbers. Read-only, bounded scan; safe to subscribe to. Returns
 * zeros for an empty brain (never throws).
 */
export const brainStats = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    pages: number;
    facts: number;
    runs: number;
    byType: Partial<Record<EntityType, number>>;
    lastUpdatedAt: number;
  }> => {
    const all = await ctx.db.query("knowledge_pages").take(500);
    let facts = 0;
    let runs = 0;
    let lastUpdatedAt = 0;
    const byType: Partial<Record<EntityType, number>> = {};
    for (const p of all) {
      facts += p.factCount;
      runs += p.runCount;
      if (p.updatedAt > lastUpdatedAt) lastUpdatedAt = p.updatedAt;
      byType[p.entityType] = (byType[p.entityType] ?? 0) + 1;
    }
    return { pages: all.length, facts, runs, byType, lastUpdatedAt };
  },
});

// ============================================================================
// MUTATIONS — the write side (default runtime; pure lib helpers only, no I/O).
// ============================================================================

/**
 * Upsert one entity page: append + dedupe facts (newest-wins cap), recompute the
 * compiled body from the merged facts, record run provenance, and store the
 * embedding when the action computed one. Creating a thin first-run page is
 * valid (every absent-able field defaults). Idempotent on re-ingest (dedupe).
 */
export const upsertPage = internalMutation({
  args: {
    entityType: entityTypeValidator,
    entityKey: v.string(),
    title: v.string(),
    newFacts: v.array(newFactValidator),
    runId: v.id("runs"),
    intent: v.string(),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (
    ctx,
    { entityType, entityKey, title, newFacts, runId, intent, embedding },
  ): Promise<Id<"knowledge_pages">> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("knowledge_pages")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", entityType).eq("entityKey", entityKey),
      )
      .first();

    type Fact = Doc<"knowledge_pages">["facts"][number];
    const priorFacts: Fact[] = existing?.facts ?? [];
    const seen = new Set(priorFacts.map((f) => normalizeFact(f.text)));
    const added: Fact[] = [];
    for (const f of newFacts) {
      const key = normalizeFact(f.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      added.push({
        text: f.text,
        kind: f.kind,
        confidence: f.confidence,
        source: f.source,
        url: f.url,
        runId,
        learnedAt: now,
      });
    }

    const mergedFacts: Fact[] = [...priorFacts, ...added]
      .sort((a, b) => b.learnedAt - a.learnedAt)
      .slice(0, MAX_FACTS_PER_PAGE);

    const content = renderPageContent(
      title,
      mergedFacts.map((f) => ({ text: f.text, kind: f.kind, url: f.url })),
    );

    const source = { runId, intent, at: now };

    if (existing) {
      await ctx.db.patch(existing._id, {
        title,
        content,
        facts: mergedFacts,
        sources: [...existing.sources, source].slice(-100),
        factCount: mergedFacts.length,
        runCount: existing.runCount + 1,
        ...(embedding ? { embedding } : {}),
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("knowledge_pages", {
      entityType,
      entityKey,
      title,
      content,
      facts: mergedFacts,
      sources: [source],
      embedding,
      factCount: mergedFacts.length,
      runCount: 1,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Replace a page's body + facts + embedding after a lint condense pass. */
export const replacePageBody = internalMutation({
  args: {
    pageId: v.id("knowledge_pages"),
    content: v.string(),
    facts: v.array(storedFactValidator),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, { pageId, content, facts, embedding }): Promise<void> => {
    const now = Date.now();
    type Fact = Doc<"knowledge_pages">["facts"][number];
    const mapped: Fact[] = facts.map((f) => ({
      text: f.text,
      kind: f.kind,
      confidence: f.confidence,
      source: f.source,
      url: f.url,
      runId: f.runId ? (f.runId as Id<"runs">) : undefined,
      learnedAt: f.learnedAt,
    }));
    await ctx.db.patch(pageId, {
      content: boundBytes(content, 5_120),
      facts: mapped,
      factCount: mapped.length,
      ...(embedding ? { embedding } : {}),
      lintedAt: now,
      updatedAt: now,
    });
  },
});

// ============================================================================
// ACTIONS — the three loop entry points (default runtime; LLM + vectorSearch).
// Each is wrapped to return a safe empty result instead of throwing.
// ============================================================================

/**
 * INGEST — distill a finalized run's REAL outputs into durable facts and upsert
 * the entity page(s). Scheduled (fire-and-forget) by run.finalize. Best-effort:
 * a missing key, empty run, or any failure returns { pages: 0, facts: 0 } and
 * never touches run status.
 */
export const ingestFromRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ pages: number; facts: number }> => {
    try {
      const bundle: IngestBundle | null = await ctx.runQuery(
        internal.knowledge.runOutputsForIngest,
        { runId },
      );
      if (!bundle) return { pages: 0, facts: 0 };

      const extracted: NewFact[] = await extractFacts(bundle);
      const targets = resolveIngestTargets(bundle, extracted);

      let pages = 0;
      let facts = 0;
      for (const t of targets) {
        if (t.newFacts.length === 0) continue;
        const embedding = await safeEmbed(embedTextForPage(t.title, t.newFacts));
        await ctx.runMutation(internal.knowledge.upsertPage, {
          entityType: t.entityType,
          entityKey: t.entityKey,
          title: t.title,
          newFacts: t.newFacts,
          runId,
          intent: bundle.run.intent,
          embedding,
        });
        pages += 1;
        facts += t.newFacts.length;
      }
      return { pages, facts };
    } catch {
      return { pages: 0, facts: 0 };
    }
  },
});

/**
 * QUERY — the agent-facing recall (applyagent's read_context analogue). Merges:
 *   (a) the exact entity page (fast path, when entityType+entityKey given),
 *   (b) semantic neighbours via OpenAI embed + ctx.vectorSearch (entityType
 *       filter when given),
 *   (c) the OPTIONAL gbrain layer (internal.brain.recall — absent in the cloud
 *       runtime, present on the local backend).
 * Returns a byte-bounded context blob. NEVER throws — agents proceed contextless
 * on any failure (missing key, empty wiki, gbrain absent).
 *
 * SIGNATURE (the helper agents adopt):
 *   const k = await ctx.runAction(internal.knowledge.queryContext, {
 *     query: string,            // REQUIRED — the semantic question (icp/positioning/topic)
 *     entityType?: "company" | "competitor" | "icp" | "campaign", // narrows the vector filter
 *     entityKey?: string,       // exact-page fast path (e.g. keyFor(run))
 *     maxBytes?: number,        // default MAX_CONTEXT_BYTES (8192)
 *   });
 *   // → { available: boolean; context: string; pageCount: number }
 *   if (k.available) prompt += `\n\nWHAT WE'VE LEARNED (prior runs):\n${k.context}`;
 */
export const queryContext = internalAction({
  args: {
    query: v.string(),
    entityType: v.optional(v.string()),
    entityKey: v.optional(v.string()),
    maxBytes: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { query: question, entityType, entityKey, maxBytes },
  ): Promise<{ available: boolean; context: string; pageCount: number }> => {
    try {
      const parts: string[] = [];
      const seenPages = new Set<string>();
      let pageCount = 0;

      const pushPage = (page: Doc<"knowledge_pages">): void => {
        const id = String(page._id);
        if (seenPages.has(id)) return;
        seenPages.add(id);
        parts.push(renderPageBlock(page as unknown as Parameters<typeof renderPageBlock>[0]));
        pageCount += 1;
      };

      // (a) Exact page fast path.
      if (entityType && entityKey) {
        const page = await ctx.runQuery(internal.knowledge.getPageByEntity, {
          entityType,
          entityKey,
        });
        if (page) pushPage(page);
      }

      // (b) Semantic neighbours.
      const vector = await safeEmbed(question);
      if (vector) {
        const hits = await ctx.vectorSearch("knowledge_pages", "by_embedding", {
          vector,
          limit: QUERY_VECTOR_LIMIT,
          ...(entityType
            ? { filter: (q) => q.eq("entityType", entityType as EntityType) }
            : {}),
        });
        if (hits.length > 0) {
          const pages = await ctx.runQuery(internal.knowledge.getPagesByIds, {
            ids: hits.map((h) => h._id),
          });
          for (const p of pages) pushPage(p);
        }
      }

      // (c) Optional gbrain layer — never required.
      try {
        const recall = await ctx.runAction(internal.brain.recall, {
          question,
        });
        if (recall.available && recall.answer.trim()) {
          parts.push(`### gbrain\n${recall.answer.trim()}`);
        }
      } catch {
        // gbrain absent in this runtime — skip.
      }

      const merged = boundBytes(dedupeBlocks(parts), maxBytes ?? MAX_CONTEXT_BYTES);
      return { available: merged.length > 0, context: merged, pageCount };
    } catch {
      return { available: false, context: "", pageCount: 0 };
    }
  },
});

/**
 * LINT — the daily cron. Condense over-threshold pages (merge near-dupes, drop
 * contradictions, bound facts[]/content), recompute the embedding, stamp
 * lintedAt. The Karpathy-trap bound. Best-effort per page; never throws.
 */
export const lintPages = internalAction({
  args: {},
  handler: async (ctx): Promise<{ linted: number }> => {
    try {
      const pages = await ctx.runQuery(internal.knowledge.pagesNeedingLint, {
        factThreshold: LINT_FACT_THRESHOLD,
        byteThreshold: LINT_BYTE_THRESHOLD,
      });
      let linted = 0;
      for (const page of pages) {
        try {
          const condensed = await condensePage(
            page as unknown as Parameters<typeof condensePage>[0],
          );
          const embedding = await safeEmbed(
            embedTextForPage(condensed.title, condensed.facts),
          );
          const facts: StoredFact[] = condensed.facts.map((f) => ({
            text: f.text,
            kind: f.kind,
            confidence: f.confidence,
            source: f.source,
            url: f.url,
            runId: f.runId,
            learnedAt: f.learnedAt,
          }));
          await ctx.runMutation(internal.knowledge.replacePageBody, {
            pageId: page._id,
            content: condensed.content,
            facts,
            embedding,
          });
          linted += 1;
        } catch {
          // skip this page, keep going.
        }
      }
      return { linted };
    } catch {
      return { linted: 0 };
    }
  },
});
