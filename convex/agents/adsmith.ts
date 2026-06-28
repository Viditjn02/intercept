// ============================================================================
// INTERCEPT — ADSMITH AGENT  ·  AI Ad Factory (CREATE + REPLICATE)
// ----------------------------------------------------------------------------
// Replaces the old `designer` (landing pages) with REAL ad creative. Two modes:
//
//   • image_ad (default for content/analyze): ground on the scanned winner
//     (run.groundedOnAdId, else the #1 ranked `ads` row) and write a SIMILAR ad
//     — headline + primary copy + CTA + N variations — in the buyers' language,
//     with an AI hero image (OpenAI gpt-image-1, b64 → Convex storage URL).
//   • replica (run.intent === "replicate" OR run.sourceUrl set): scrape the
//     dropped post/ad (Orange Slice scrapeWebsite) and rewrite an IMPROVED replica.
//
// Copy/strategy via OpenAI (lib/openai.chatJSON). Image via lib/image.generateImage
// — on a missing key / $0 / error it degrades to a copy-only card (imageStatus
// "degraded"). The agent NEVER throws past its handler; the run always finalizes.
//
// RUNTIME: intentionally NOT "use node" — it co-locates internalMutation/Query +
// a public query alongside the action (Convex forbids those in a "use node"
// module). lib/openai + lib/image are fetch/SDK based and run in the default
// action runtime; image bytes are persisted via internal.storage.* like creative.ts.
//
// STATUS: shared-file SCAFFOLD. The `run` action is a graceful no-op stub today;
// the builder fills in the OpenAI copy/strategy + gpt-image-1 image + persistence,
// keeping the never-throws contract. The context/save/read contracts are final.
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
import type { Doc, Id } from "../_generated/dataModel";
import { AD_VARIATIONS, MAX_THREADS, type AdVariation } from "../../lib/contract";
import { chatJSON } from "../../lib/openai";
import { generateImage } from "../../lib/image";
import { capture } from "../../lib/posthog";
import { safeFetch } from "../../lib/safeFetch";

// ----------------------------------------------------------------------------
// Validator for one generated/persisted ad creative (mirrors the schema row).
// ----------------------------------------------------------------------------
const variationValidator = v.object({
  headline: v.string(),
  primaryText: v.string(),
  cta: v.string(),
  angle: v.string(),
});

// The mode the agent runs in, derived from the run's provenance.
type AdsmithMode = "image_ad" | "replica";

// ----------------------------------------------------------------------------
// READ: everything adsmith needs — the run, the brief, the top scanned winners
// (the angles to mirror), the moat threads (buyer language), and the watcher's
// reel-analysis note (style reference). Tolerant: any of these may be empty.
// ----------------------------------------------------------------------------
interface AdsmithContext {
  company: string;
  input: string;
  sourceUrl: string | null;
  groundedOnAdId: Id<"ads"> | null;
  mode: AdsmithMode;
  icp: string;
  positioning: string;
  groundingAd: {
    advertiser: string;
    headline: string | null;
    text: string;
    cta: string | null;
    winningAngle: string | null;
  } | null;
  buyerLanguage: string[];
  reelInsight: string | null;
}

export const context = internalQuery({
  args: {
    runId: v.id("runs"),
    sourceUrl: v.optional(v.string()),
    groundedOnAdId: v.optional(v.id("ads")),
  },
  handler: async (ctx, { runId, sourceUrl, groundedOnAdId }): Promise<AdsmithContext> => {
    const run = await ctx.db.get(runId);
    const brief = await ctx.db
      .query("brief")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();

    // The grounding winner: an explicit "Generate similar" target, else the top
    // scanned ad for this run (already ranked winning-first on insert).
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const targetId = groundedOnAdId ?? run?.groundedOnAdId ?? null;
    const groundingAdDoc =
      (targetId ? ads.find((a) => a._id === targetId) : undefined) ??
      ads.find((a) => (a.perfScore ?? 0) > 0) ??
      ads[0] ??
      null;

    const threads = await ctx.db
      .query("threads")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const intentRank: Record<string, number> = {
      ready_to_buy: 3,
      frustrated: 2,
      comparing: 1,
      browsing: 0,
    };
    const buyerLanguage = [...threads]
      .sort(
        (a, b) =>
          (intentRank[b.intentLabel] ?? 0) - (intentRank[a.intentLabel] ?? 0) ||
          b.intentScore - a.intentScore,
      )
      .slice(0, MAX_THREADS)
      .map((t) => t.title.trim())
      .filter(Boolean);

    const creatives = await ctx.db
      .query("creatives")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    const reelInsight = creatives.find((c) => c.kind === "reel-analysis");

    const resolvedSourceUrl = sourceUrl ?? run?.sourceUrl ?? null;
    const mode: AdsmithMode =
      run?.intent === "replicate" || resolvedSourceUrl ? "replica" : "image_ad";

    return {
      company: run?.company ?? run?.input ?? "the company",
      input: run?.input ?? "",
      sourceUrl: resolvedSourceUrl,
      groundedOnAdId: targetId,
      mode,
      icp: brief?.icp ?? "",
      positioning: brief?.positioning ?? "",
      groundingAd: groundingAdDoc
        ? {
            advertiser: groundingAdDoc.advertiser,
            headline: groundingAdDoc.headline ?? null,
            text: groundingAdDoc.text,
            cta: groundingAdDoc.cta ?? null,
            winningAngle: groundingAdDoc.winningAngle ?? null,
          }
        : null,
      buyerLanguage,
      reelInsight: reelInsight?.prompt ?? null,
    };
  },
});

// ----------------------------------------------------------------------------
// WRITE: upsert one adCreatives row for this run (idempotent on replay/re-run).
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    kind: v.string(), // "image_ad" | "replica"
    groundedOnAdId: v.optional(v.id("ads")),
    sourceUrl: v.optional(v.string()),
    headline: v.string(),
    primaryText: v.string(),
    cta: v.string(),
    variations: v.array(variationValidator),
    strategy: v.string(),
    imagePrompt: v.string(),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    imageStatus: v.string(), // "done" | "degraded" | "failed"
    degraded: v.boolean(),
    degradedReason: v.optional(v.string()),
    model: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"adCreatives">> => {
    const existing = await ctx.db
      .query("adCreatives")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .first();

    const { runId, ...rest } = args;
    const fields = { ...rest, generatedAt: Date.now() };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("adCreatives", { runId, ...fields });
  },
});

// ----------------------------------------------------------------------------
// ACTION: produce the similar/replica ad. SCAFFOLD — graceful no-op today.
// The builder fills in: OpenAI copy/strategy/variations (chatJSON) → image via
// lib/image.generateImage (gpt-image-1 b64 → internal.storage persist) → save().
// Must never throw past this handler.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: {
    runId: v.id("runs"),
    sourceUrl: v.optional(v.string()),
    groundedOnAdId: v.optional(v.id("ads")),
  },
  handler: async (ctx, { runId, sourceUrl, groundedOnAdId }): Promise<void> => {
    let data: AdsmithContext;
    try {
      data = await ctx.runQuery(internal.agents.adsmith.context, {
        runId,
        sourceUrl,
        groundedOnAdId,
      });
    } catch {
      return; // context read failed — finalize cleanly, never throw past handler
    }

    // REPLICATE: scrape the dropped post/URL (Orange Slice scrapeWebsite) so the
    // rewrite is grounded in the real creative. Best-effort — null on any failure.
    let sourceCreative: SourceCreative | null = null;
    if (data.mode === "replica" && data.sourceUrl) {
      sourceCreative = await scrapeSource(data.sourceUrl);
    }

    // No OpenAI key → we cannot write real copy. Degrade honestly (no fake copy):
    // log why and finalize. The run still completes; the panel shows "Generating".
    if (!process.env.OPENAI_API_KEY) {
      await logEvent(
        ctx,
        runId,
        "designed",
        `Ad Smith ready (${data.mode}) for ${data.company}, but copy generation is unavailable (OPENAI_API_KEY not set).`,
      );
      return;
    }

    // 1) COPY + STRATEGY + IMAGE PROMPT + VARIATIONS via OpenAI.
    let copy: AdCopy;
    try {
      copy = await writeAdCopy(data, sourceCreative);
    } catch {
      await logEvent(
        ctx,
        runId,
        "designed",
        `Ad Smith could not draft copy for ${data.company} (model unavailable) — no fake creative written.`,
      );
      return;
    }

    // 2) HERO IMAGE via gpt-image-1 (b64 → Convex storage URL). fal is an optional
    //    premium that degrades to gpt-image-1; any failure degrades to copy-only.
    let imageUrl: string | undefined;
    let imageStorageId: Id<"_storage"> | undefined;
    let imageStatus = "degraded";
    let degraded = true;
    let degradedReason: string | undefined;
    let imageModel = "gpt-image-1";

    const image = await generateImage(copy.imagePrompt, {
      size: "1024x1536", // portrait — frames the panel's 4:5 ad
      preferFal: true,
    });
    imageModel = image.model;
    if (image.b64) {
      const stored = await persistImage(ctx, image.b64);
      if (stored) {
        imageUrl = stored.url;
        imageStorageId = stored.storageId;
        imageStatus = "done";
        degraded = false;
      } else {
        degradedReason = "storage_failed";
      }
    } else if (image.url) {
      imageUrl = image.url;
      imageStatus = "done";
      degraded = false;
    } else {
      degradedReason = image.reason ?? "image_unavailable";
    }

    // 3) Persist one adCreatives row (idempotent on replay/re-run).
    await ctx.runMutation(internal.agents.adsmith.save, {
      runId,
      kind: data.mode,
      groundedOnAdId: data.groundedOnAdId ?? undefined,
      sourceUrl: data.sourceUrl ?? undefined,
      headline: copy.headline,
      primaryText: copy.primaryText,
      cta: copy.cta,
      variations: copy.variations,
      strategy: copy.strategy,
      imagePrompt: copy.imagePrompt,
      imageUrl,
      imageStorageId,
      imageStatus,
      degraded,
      degradedReason,
      model: `${data.mode === "replica" ? "openai+replica" : "openai"}/${imageModel}`,
    });

    await logEvent(
      ctx,
      runId,
      "designed",
      data.mode === "replica"
        ? `Replicated + improved the dropped creative for ${data.company}${
            degraded ? " (copy live, image paused)" : " (image + copy ready)"
          }.`
        : `Generated a similar ad for ${data.company}${
            degraded ? " (copy + variations ready, image paused)" : " (image + copy + variations ready)"
          }.`,
    );

    // Sponsor + compounding side-effects — best-effort, never block the lane.
    await rememberCreative(ctx, data, copy);
    await captureEvent(data, copy, degraded);
  },
});

// ----------------------------------------------------------------------------
// COPY GENERATION — OpenAI writes the strategy, hero copy, image prompt, and the
// N variations, grounded in the scanned winner + the buyers' own language (and,
// in replica mode, the scraped source creative). Normalized so the save
// validator always receives well-formed strings.
// ----------------------------------------------------------------------------
interface AdCopy {
  headline: string;
  primaryText: string;
  cta: string;
  strategy: string;
  imagePrompt: string;
  variations: AdVariation[];
}

async function writeAdCopy(
  data: AdsmithContext,
  source: SourceCreative | null,
): Promise<AdCopy> {
  const grounding = data.groundingAd
    ? [
        `Reference winning ad — advertiser "${data.groundingAd.advertiser}":`,
        data.groundingAd.headline ? `  headline: ${data.groundingAd.headline}` : "",
        `  body: ${data.groundingAd.text.replace(/\s+/g, " ").trim().slice(0, 600)}`,
        data.groundingAd.cta ? `  cta: ${data.groundingAd.cta}` : "",
        data.groundingAd.winningAngle
          ? `  winning angle (why it converts): ${data.groundingAd.winningAngle}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "No competitor reference ad was scanned — ground in the brief + buyer language.";

  const buyerVoice =
    data.buyerLanguage.length > 0
      ? data.buyerLanguage.map((line) => `- "${line}"`).join("\n")
      : "(no buyer-language threads captured for this run)";

  const sourceBlock =
    data.mode === "replica" && source
      ? [
          "SOURCE CREATIVE the user dropped to replicate + improve:",
          source.text.slice(0, 1500),
        ].join("\n")
      : data.mode === "replica"
        ? "The source post could not be scraped — improve from the brief + buyer language instead."
        : "";

  const system = [
    "You are a senior direct-response performance marketer writing a SINGLE high-converting social ad (Meta/Instagram feed).",
    data.mode === "replica"
      ? "MODE: REPLICATE — recreate the dropped source creative as a sharper, on-brand ad: same core offer, stronger hook, tighter CTA. Do NOT copy it verbatim; improve it."
      : "MODE: CREATE — write a NEW ad that mirrors the winning angle of the reference, but in this company's voice and the buyers' own words. Do NOT plagiarize the reference.",
    "Write in the buyers' real language. No emojis spam, no clickbait lies, no fabricated stats or claims.",
    "The image prompt must describe a single, clean, professional ad hero image (no text overlays, no logos, no watermarks, no gibberish letters).",
  ].join(" ");

  const user = [
    `Company / advertiser: ${data.company}`,
    data.input ? `Run input: ${data.input}` : "",
    data.icp ? `Ideal customer (ICP): ${data.icp}` : "",
    data.positioning ? `Positioning: ${data.positioning}` : "",
    data.reelInsight ? `Winning competitor reel style: ${data.reelInsight}` : "",
    "",
    grounding,
    "",
    "Buyers' own words (highest-intent first):",
    buyerVoice,
    sourceBlock ? `\n${sourceBlock}` : "",
    "",
    `Produce exactly ${AD_VARIATIONS} distinct variations, each a different angle (e.g. pain-led, outcome-led, social-proof, urgency).`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const schemaHint = `{
  "headline": "string — the primary ad headline (<= 12 words)",
  "primaryText": "string — the primary body copy (1-3 short sentences)",
  "cta": "string — a 1-4 word call to action, e.g. 'Get started'",
  "strategy": "string — 1-2 sentences on WHY this should beat the reference, grounded in the winning angle + buyer language",
  "imagePrompt": "string — a vivid description of the ad hero image (no text in image)",
  "variations": [
    { "headline": "string", "primaryText": "string", "cta": "string", "angle": "string — short label e.g. 'Pain-led'" }
  ]
}`;

  const raw = await chatJSON<Record<string, unknown>>({
    system,
    user,
    schemaHint,
    temperature: 0.7,
    maxTokens: 1200,
  });

  return normalizeCopy(raw, data);
}

/** Coerce the model's JSON into a fully-typed, validator-safe AdCopy. */
function normalizeCopy(raw: Record<string, unknown>, data: AdsmithContext): AdCopy {
  const str = (value: unknown, fallback: string): string => {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
  };

  const headline = str(raw.headline, `Meet ${data.company}`);
  const primaryText = str(
    raw.primaryText,
    `A better way for ${data.icp || "your team"} to get results.`,
  );
  const cta = str(raw.cta, "Learn more").slice(0, 40);
  const strategy = str(
    raw.strategy,
    "Mirrors the proven winning angle in the buyers' own language.",
  );
  const imagePrompt = str(
    raw.imagePrompt,
    `A clean, modern, premium product hero image for ${data.company}. Bright studio lighting, high contrast, no text, no logos.`,
  );

  const rawVariations = Array.isArray(raw.variations) ? raw.variations : [];
  const variations: AdVariation[] = rawVariations
    .map((entry, index): AdVariation => {
      const v = (entry ?? {}) as Record<string, unknown>;
      return {
        headline: str(v.headline, headline),
        primaryText: str(v.primaryText, primaryText),
        cta: str(v.cta, cta).slice(0, 40),
        angle: str(v.angle, `Variant ${index + 1}`),
      };
    })
    .slice(0, AD_VARIATIONS);

  // Guarantee exactly AD_VARIATIONS entries so the panel's tabs are stable.
  while (variations.length < AD_VARIATIONS) {
    const index = variations.length;
    variations.push({
      headline,
      primaryText,
      cta,
      angle: `Variant ${index + 1}`,
    });
  }

  return { headline, primaryText, cta, strategy, imagePrompt, variations };
}

// ----------------------------------------------------------------------------
// IMAGE PERSISTENCE — store the gpt-image-1 b64 PNG to Convex File Storage and
// return a served URL. Runs in the default action runtime (no Node built-ins):
// a dependency-free base64 decode → Blob → ctx.storage.store. Never throws.
// ----------------------------------------------------------------------------
async function persistImage(
  ctx: ActionCtx,
  b64: string,
): Promise<{ storageId: Id<"_storage">; url: string } | null> {
  try {
    const bytes = base64ToBytes(b64);
    if (bytes.length === 0) return null;
    const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
    const storageId = await ctx.storage.store(blob);
    const url = await ctx.storage.getUrl(storageId);
    if (!url) return null;
    return { storageId, url };
  } catch {
    return null;
  }
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET[i]] = i;
  return table;
})();

/** Dependency-free base64 → Uint8Array (no atob / Buffer — safe in any runtime). */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const byteLen = Math.max(0, Math.floor((len * 3) / 4) - pad);
  const bytes = new Uint8Array(byteLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const e0 = B64_LOOKUP[clean[i]] ?? 0;
    const e1 = B64_LOOKUP[clean[i + 1]] ?? 0;
    const e2 = B64_LOOKUP[clean[i + 2]] ?? 0;
    const e3 = B64_LOOKUP[clean[i + 3]] ?? 0;
    const n = (e0 << 18) | (e1 << 12) | (e2 << 6) | e3;
    if (p < byteLen) bytes[p++] = (n >> 16) & 0xff;
    if (p < byteLen) bytes[p++] = (n >> 8) & 0xff;
    if (p < byteLen) bytes[p++] = n & 0xff;
  }
  return bytes;
}

// ----------------------------------------------------------------------------
// REPLICATE source scrape — Orange Slice scrapeWebsite (firecrawl gateway). The
// dropped URL is fetched server-side via the trusted OS gateway (bearer auth +
// inline wait + bounded poll). Returns the source copy (markdown) + any hero
// image found. Never throws — null on missing key / non-2xx / timeout / error.
// ----------------------------------------------------------------------------
interface SourceCreative {
  text: string;
  imageUrl?: string;
}

const OS_BASE = (
  process.env.ORANGESLICE_BASE_URL ?? "https://enrichly-production.up.railway.app"
).replace(/\/+$/, "");
const OS_PLACEHOLDER = /^(your|placeholder|changeme|example|dummy|test[-_]?key|xxx)/i;
const OS_TIMEOUT_MS = 15_000;
const OS_INLINE_WAIT_MS = 8_000;
const OS_POLL_TIMEOUT_MS = 25_000;
const OS_POLL_INTERVAL_MS = 1_500;

function osKey(): string | undefined {
  const key = process.env.ORANGESLICE_API_KEY?.trim();
  if (!key || OS_PLACEHOLDER.test(key)) return undefined;
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeSource(url: string): Promise<SourceCreative | null> {
  const key = osKey();
  if (!key) return null;

  let body: Record<string, unknown> | null = null;
  try {
    const res = await safeFetch(`${OS_BASE}/execute/firecrawl`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ url, inlineWaitMs: OS_INLINE_WAIT_MS }),
      timeoutMs: OS_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const parsed: unknown = await res.json().catch(() => null);
    body = isRecord(parsed) ? parsed : null;
    if (body && body.pending === true) {
      body = await pollScrape(body);
    }
  } catch {
    return null;
  }
  if (!body) return null;

  const markdown =
    typeof body.markdown === "string"
      ? body.markdown
      : Array.isArray(body.data) && isRecord(body.data[0]) && typeof body.data[0].markdown === "string"
        ? (body.data[0].markdown as string)
        : "";
  const text = markdown.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { text };
}

async function pollScrape(
  pending: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const pollPath =
    typeof pending.pollUrl === "string" && pending.pollUrl.trim()
      ? pending.pollUrl
      : typeof pending.requestId === "string"
        ? `/function/result/${pending.requestId}`
        : undefined;
  if (!pollPath) return null;

  let pollUrl: string;
  try {
    pollUrl = new URL(pollPath, `${OS_BASE}/`).toString();
  } catch {
    return null;
  }

  const deadline = Date.now() + OS_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(OS_POLL_INTERVAL_MS);
    try {
      const res = await safeFetch(pollUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: OS_TIMEOUT_MS,
      });
      const parsed: unknown = await res.json().catch(() => null);
      const body = isRecord(parsed) ? parsed : null;
      if (res.status === 202 || (body && body.pending === true)) continue;
      if (!res.ok || !body) return null;
      if (typeof body.error === "string") return null;
      return body;
    } catch {
      return null;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Live-feed + compounding helpers. Best-effort — never block the adsmith lane.
// ----------------------------------------------------------------------------
async function logEvent(
  ctx: ActionCtx,
  runId: Id<"runs">,
  kind: string,
  message: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.events.log, { runId, agent: "adsmith", kind, message });
  } catch {
    // ignore — the feed is additive
  }
}

/** Compounding brain: persist the generated angle so future runs can reuse it. */
async function rememberCreative(
  ctx: ActionCtx,
  data: AdsmithContext,
  copy: AdCopy,
): Promise<void> {
  const slug = `intercept-adsmith-${slugify(data.company)}`;
  const markdown = [
    `# ${data.company} — generated ad creative (${data.mode}, via INTERCEPT Ad Factory)`,
    "",
    data.groundingAd?.winningAngle
      ? `Grounded on winning angle: ${data.groundingAd.winningAngle}`
      : data.sourceUrl
        ? `Replicated + improved from: ${data.sourceUrl}`
        : "Grounded on the brief + buyer language.",
    "",
    `- Headline: ${copy.headline}`,
    `- Primary: ${copy.primaryText}`,
    `- CTA: ${copy.cta}`,
    `- Why it should win: ${copy.strategy}`,
    "",
    "Variations:",
    ...copy.variations.map((vr) => `- (${vr.angle}) ${vr.headline} — ${vr.primaryText}`),
  ].join("\n");

  try {
    await ctx.runAction(internal.brain.remember, { slug, markdown });
  } catch {
    // brain unavailable in this runtime — degrade silently
  }
}

/** PostHog: fire ad_generated / ad_replicated. Best-effort, never throws. */
async function captureEvent(
  data: AdsmithContext,
  copy: AdCopy,
  degraded: boolean,
): Promise<void> {
  try {
    await capture(data.mode === "replica" ? "ad_replicated" : "ad_generated", {
      company: data.company,
      mode: data.mode,
      grounded: Boolean(data.groundingAd),
      variations: copy.variations.length,
      image_degraded: degraded,
    });
  } catch {
    // analytics must never block the lane
  }
}

/** Lowercase, hyphenated, filesystem-safe slug for a brain page key. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "company"
  );
}

// ----------------------------------------------------------------------------
// PUBLIC QUERY: the run's generated ads (reactive — drives AdFactoryPanel).
// ----------------------------------------------------------------------------
export const creativesForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"adCreatives">[]> => {
    return await ctx.db
      .query("adCreatives")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
  },
});
