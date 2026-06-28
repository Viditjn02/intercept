// ============================================================================
// INTERCEPT — GUIDE AGENT (Track 3: zero-to-one PLG / onboarding generator)
//
// Reads the run + GTM brief, best-effort scrapes the product URL for grounding,
// then asks OpenAI to design a short, activation-focused in-app product tour for
// the user's product. The structured steps are normalized by the OnboardJS-
// modeled flow brain (lib/onboarding) and turned into a paste-ready Shepherd.js
// embed (convex/onboarding/embed). Persistence is owned by THIS file: one row in
// `onboardingFlows` (the swarm convention).
//
// The agent NEVER throws past its own handler — a failed generation must not
// block the run. With no OPENAI_API_KEY (or unusable output) it degrades to a
// deterministic, context-grounded fallback tour, so the canvas is never empty.
//
// NOTE: intentionally NOT "use node" — it defines internalMutation + query
// alongside the action (Convex forbids those in a "use node" module). lib/openai
// and lib/safeFetch are fetch-based and run in the default action runtime.
// ============================================================================

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id, Doc } from "../_generated/dataModel";
import { chatJSON } from "../../lib/openai";
import { safeFetch } from "../../lib/safeFetch";
import {
  buildGuidePrompts,
  parseGuideSteps,
  fallbackFlowSteps,
  type GuideContext,
} from "../../lib/onboarding/prompt";
import { normalizeSteps, isFlowViable } from "../../lib/onboarding/flow";
import { buildEmbed } from "../onboarding/embed";
import type { OnboardingStep } from "../../lib/contract";

// The persisted tour-step shape (mirrors schema onboardingFlows.tourSteps).
interface TourStepRow {
  order: number;
  target: string;
  title: string;
  body: string;
  placement: string;
  cta?: string;
}

// ----------------------------------------------------------------------------
// READ: assemble the product context for this run from run + brief. Tolerant —
// a thin brief still yields a usable context (the action grounds further).
// ----------------------------------------------------------------------------
export const context = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (
    ctx,
    { runId },
  ): Promise<{
    productName: string;
    url: string;
    valueProp: string;
    icp: string;
  }> => {
    const run = await ctx.db.get(runId);
    const brief = await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();

    const domain = run?.routedDomain?.trim();
    const url = domain
      ? domain.startsWith("http")
        ? domain
        : `https://${domain}`
      : "";

    return {
      productName: run?.company ?? run?.input ?? "the product",
      url,
      valueProp: brief?.positioning ?? "",
      icp: brief?.icp ?? "",
    };
  },
});

// ----------------------------------------------------------------------------
// WRITE: upsert the single onboardingFlows row for a run.
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    productName: v.string(),
    framework: v.string(),
    tourSteps: v.array(
      v.object({
        order: v.number(),
        target: v.string(),
        title: v.string(),
        body: v.string(),
        placement: v.string(),
        cta: v.optional(v.string()),
      }),
    ),
    embedSnippet: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"onboardingFlows">> => {
    const existing = await ctx.db
      .query("onboardingFlows")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();

    const fields = {
      productName: args.productName,
      framework: args.framework,
      tourSteps: args.tourSteps,
      embedSnippet: args.embedSnippet,
      generatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("onboardingFlows", {
      runId: args.runId,
      ...fields,
    });
  },
});

// ----------------------------------------------------------------------------
// ACTION: generate the onboarding flow from the product, persist. Never blocks.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<void> => {
    const base: {
      productName: string;
      url: string;
      valueProp: string;
      icp: string;
    } = await ctx.runQuery(internal.agents.guide.context, { runId });

    // Ground the model in the real landing page when we can reach it. Strictly
    // best-effort — a failed/empty scrape just means a leaner prompt.
    const pageText = base.url ? await scrapePageText(base.url) : "";
    const guideCtx: GuideContext = { ...base, pageText };

    const steps = await generateSteps(guideCtx);
    const tourSteps: TourStepRow[] = steps.map((s) => ({
      order: s.order,
      target: s.target,
      title: s.title,
      body: s.body,
      placement: s.placement,
      ...(s.cta ? { cta: s.cta } : {}),
    }));

    const embedSnippet = buildEmbed(steps, "shepherd");

    try {
      await ctx.runMutation(internal.agents.guide.save, {
        runId,
        productName: base.productName,
        framework: "shepherd",
        tourSteps,
        embedSnippet,
      });
      await logEvent(
        ctx,
        runId,
        "onboarded",
        `Generated a ${steps.length}-step in-app onboarding tour for ${base.productName} with a paste-ready Shepherd.js embed.`,
      );
      await rememberFlow(ctx, base.productName, steps);
    } catch {
      // Unreachable in practice (generateSteps never throws), but the run must
      // finalize regardless of the onboarding lane.
    }
  },
});

// ----------------------------------------------------------------------------
// Generation core: OpenAI when available, deterministic fallback otherwise.
// Always returns a viable, normalized OnboardingStep[] — never throws.
// ----------------------------------------------------------------------------
async function generateSteps(guideCtx: GuideContext): Promise<OnboardingStep[]> {
  const fallback = fallbackFlowSteps(guideCtx);
  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    const { system, user, schemaHint } = buildGuidePrompts(guideCtx);
    const raw = await chatJSON<{ steps?: unknown }>({
      system,
      user,
      schemaHint,
      temperature: 0.5,
      maxTokens: 1400,
    });
    const parsed = normalizeSteps(parseGuideSteps(raw));
    return isFlowViable(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// ----------------------------------------------------------------------------
// Best-effort landing-page scrape → compact visible text for grounding. SSRF-
// guarded via safeFetch; capped; any failure degrades to "".
// ----------------------------------------------------------------------------
async function scrapePageText(url: string): Promise<string> {
  try {
    const res = await safeFetch(url, {
      timeoutMs: 6000,
      maxBytes: 600_000,
      headers: { accept: "text/html" },
    });
    if (!res.ok) return "";
    const html = await res.text();
    return htmlToText(html).slice(0, 4000);
  } catch {
    return "";
  }
}

/** Crude HTML → visible text: drop script/style, strip tags, collapse space. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ----------------------------------------------------------------------------
// Live-feed + compounding helpers. Best-effort; a failure here must never block
// the guide lane (the run still finalizes with the onboarding row).
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
      agent: "guide",
      kind,
      message,
    });
  } catch {
    // ignore — the feed is additive
  }
}

async function rememberFlow(
  ctx: ActionCtx,
  productName: string,
  steps: readonly OnboardingStep[],
): Promise<void> {
  if (steps.length === 0) return;
  const slug = `intercept-onboarding-${slugify(productName)}`;
  const markdown = [
    `# ${productName} — onboarding tour (INTERCEPT)`,
    "",
    "**Activation flow (in-app product tour):**",
    ...steps.map((s) => `${s.order}. **${s.title}** — ${s.body}`),
  ].join("\n");
  try {
    await ctx.runAction(internal.brain.remember, { slug, markdown });
  } catch {
    // brain unavailable in this runtime — degrade silently
  }
}

/** Lowercase, hyphenated, filesystem-safe slug for a brain page key. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "product"
  );
}

// ----------------------------------------------------------------------------
// PUBLIC QUERY: the run's generated onboarding flow (reactive — drives the
// OnboardingCanvas). Returns null until the guide has written its row.
// ----------------------------------------------------------------------------
export const flowForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"onboardingFlows"> | null> => {
    return await ctx.db
      .query("onboardingFlows")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
  },
});
