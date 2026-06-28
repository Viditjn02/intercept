// ============================================================================
// INTERCEPT — ENRICH AGENT
// Turns a raw company target into a crisp GTM brief. It scrapes the company's
// web presence (via lib/orangeslice.enrichCompany), then asks the LLM to infer
// the Ideal Customer Profile (ICP) and the company's positioning. The result is
// persisted as the run's `brief` via internal.brief.assembleBrief.
//
// This is what gives the Detective agent its search intent: detective reads the
// brief's ICP/positioning to know WHICH communities and questions to hunt for.
//
// The orchestrator (convex/run.ts) owns agentStatus — this file never touches it.
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { EnrichResult } from "../../lib/contract";
import { chatJSON } from "../../lib/openai";
import { enrichCompany } from "../../lib/orangeslice";

// Loose shape of what the scraper returns. We read every field defensively so a
// thin scrape still produces a usable brief.
interface ScrapeResult {
  company?: string;
  name?: string;
  url?: string;
  title?: string;
  description?: string;
  text?: string;
  content?: string;
}

// What we ask the LLM to produce.
interface BriefModelOutput {
  icp?: string;
  positioning?: string;
  company?: string;
}

// ----------------------------------------------------------------------------
// Internal query: read the run row (co-located, no cross-module dependency).
// ----------------------------------------------------------------------------
export const getRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"runs"> | null> => {
    return await ctx.db.get(runId);
  },
});

// ----------------------------------------------------------------------------
// Pure helpers.
// ----------------------------------------------------------------------------

/** Derive a company display name from the scrape + raw input. */
function resolveCompanyName(scrape: ScrapeResult, input: string): string {
  const candidate =
    scrape.company?.trim() ||
    scrape.name?.trim() ||
    scrape.title?.trim();
  if (candidate) return candidate.slice(0, 120);
  return input.trim().slice(0, 120) || "Unknown";
}

/** Compact the scraped body so we don't blow the LLM context budget. */
function buildContext(scrape: ScrapeResult): string {
  const parts = [
    scrape.title && `Title: ${scrape.title}`,
    scrape.description && `Description: ${scrape.description}`,
    scrape.url && `URL: ${scrape.url}`,
    (scrape.text || scrape.content) &&
      `Page content:\n${(scrape.text || scrape.content || "").slice(0, 6000)}`,
  ].filter(Boolean);
  return parts.join("\n\n");
}

// ----------------------------------------------------------------------------
// The agent action.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<EnrichResult> => {
    const runDoc = await ctx.runQuery(internal.agents.enrich.getRun, { runId });
    if (!runDoc) {
      throw new Error(`enrich: run ${runId} not found`);
    }

    // Replay mode: the brief is pre-seeded from a fixture, so we no-op and
    // simply echo back what's already on the run. No external calls.
    if (runDoc.replay) {
      return {
        company: runDoc.company ?? runDoc.input,
        icp: "",
        positioning: "",
      };
    }

    const input = runDoc.input;
    // Prefer the canonical domain the router resolved (e.g. "superhuman.com")
    // over the raw input ("Superhuman"), so the HTML fallback scrapes a real
    // homepage instead of "https://Superhuman".
    const scrapeTarget = runDoc.routedDomain?.trim() || input;

    // 1) Scrape the company's web presence. Failure is non-fatal — we degrade to
    //    an input-only context so the brief is always produced.
    let scrape: ScrapeResult = {};
    try {
      scrape = ((await enrichCompany(scrapeTarget)) as ScrapeResult) ?? {};
    } catch {
      scrape = {};
    }

    const company = resolveCompanyName(scrape, input);
    const context = buildContext(scrape);

    // 2) Infer ICP + positioning. Best-effort: on model failure we still write a
    //    minimal brief so downstream agents have something to work with.
    let model: BriefModelOutput = {};
    try {
      model = await chatJSON<BriefModelOutput>({
        system:
          "You are a go-to-market analyst. Given everything known about a " +
          "company, infer its Ideal Customer Profile and its market " +
          "positioning. Be concrete and specific — name roles, company sizes, " +
          "pains, and the exact category. Respond with STRICT JSON only.",
        user: [
          `Company: ${company}`,
          context
            ? `What we know about it:\n${context}`
            : `We could not scrape its site. Raw input: """${input}"""`,
          "",
          "Return a JSON object with EXACTLY these keys:",
          '- "icp": 1-3 sentences describing the ideal customer (who buys, ' +
            "their role, company size, and the pain they feel)",
          '- "positioning": 1-2 sentences on how this company positions itself ' +
            "(the category it plays in and its core promise/differentiator)",
          '- "company": the cleaned company name',
        ].join("\n"),
        temperature: 0.2,
      });
    } catch {
      model = {};
    }

    const result: EnrichResult = {
      company: model.company?.trim() || company,
      icp:
        model.icp?.trim() ||
        `Teams and buyers who would purchase ${company}.`,
      positioning:
        model.positioning?.trim() ||
        `${company} — positioning could not be inferred from available data.`,
    };

    // 3) Persist the brief. brief.ts owns this mutation; it sets brief.icp /
    //    brief.positioning and stamps the run's company.
    await ctx.runMutation(internal.brief.assembleBrief, {
      runId,
      icp: result.icp,
      positioning: result.positioning,
      company: result.company,
    });

    return result;
  },
});
