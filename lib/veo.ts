// ============================================================================
// INTERCEPT — MULTI-PROVIDER VIDEO AD CLIENT
// The Creative agent (convex/agents/creative.ts) calls generateAd to render the
// video ad. Called from a "use node" Convex action.
//
// PROVIDER CHAIN (same generateAd(input) signature + return shape for all):
//   1. PRIMARY  — Veo (Google, veo-3.1-fast-generate-001). Native audio, but
//      requires a Google AI Studio / Vertex project with PAID billing enabled.
//      On a free key this 403s.
//   2. FALLBACK — fal.ai hosting the OPEN-SOURCE LTX-Video model. LTX-Video is
//      open source (Lightricks); fal.ai only rents the GPU + exposes a REST
//      queue. It has NO native audio (silent clip), but it renders on a
//      cheap/free-tier key, so it keeps the swarm's brief alive when Veo can't.
//
// We try Veo first; on missing GOOGLE_API_KEY / Veo error / Veo timeout we fall
// back to LTX via fal.ai. If neither provider is configured/usable we return
// { url: undefined } — the feature NO-OPs silently and NEVER throws / blocks the
// swarm. Keys are read from process.env: GOOGLE_API_KEY (or GEMINI_API_KEY) and
// FAL_KEY.
//
//   Veo's returned file.uri is a Google Files API URL that needs the API key
//   appended (?key=...) to download the bytes — we return the key-appended URL
//   so it is directly fetchable/clickable.
// ============================================================================

import { GoogleGenAI } from "@google/genai";

const VEO_MODEL = "veo-3.1-fast-generate-001";
const LTX_MODEL = "ltx-video"; // open-source; fal.ai just hosts the GPU, no native audio

// ---- Veo polling budget -----------------------------------------------------
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 30; // ~5 min ceiling

// ---- fal.ai LTX queue polling budget ----------------------------------------
const FAL_LTX_ENDPOINT = "https://queue.fal.run/fal-ai/ltx-video";
const FAL_POLL_INTERVAL_MS = 3_000;
const FAL_MAX_POLL_ATTEMPTS = 60; // ~3 min ceiling

let cachedClient: GoogleGenAI | null = null;

/** Returns the Google API key, or undefined if it isn't configured. */
function getGoogleApiKey(): string | undefined {
  return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? undefined;
}

/** Returns the fal.ai key, or undefined if it isn't configured. */
function getFalKey(): string | undefined {
  return process.env.FAL_KEY ?? undefined;
}

function getClient(apiKey: string): GoogleGenAI {
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Object-form input shared with the Creative agent (convex/agents/creative.ts):
//   generateAd({ prompt, aspectRatio?, durationSeconds? })
export interface GenerateAdInput {
  /** The cinematic ad prompt. Required, non-empty. */
  prompt: string;
  /** Aspect ratio, e.g. "16:9" or "9:16". Defaults to "16:9". */
  aspectRatio?: string;
  /** Target duration in seconds (advisory — Veo fast has a fixed length). */
  durationSeconds?: number;
}

export interface GenerateAdResult {
  /** Directly fetchable video URL (Veo Files API uri with key appended, or LTX mp4). */
  url?: string;
  /** The model that produced the clip (echoed back for the board). */
  model?: string;
}

/**
 * Generate a short video ad from a text prompt.
 *
 * Tries Veo (Google) first, then falls back to the open-source LTX-Video model
 * hosted on fal.ai. Never throws on a missing key / provider error / timeout —
 * returns { url: undefined } so the orchestrator's fan-in can render a partial
 * brief instead of blocking.
 */
export async function generateAd(
  input: GenerateAdInput,
): Promise<GenerateAdResult> {
  const trimmed = input.prompt.trim();
  if (!trimmed) {
    // No prompt — nothing to render. Never block the swarm.
    return { url: undefined };
  }

  // 1) PRIMARY: Veo (Google). Skips silently if GOOGLE_API_KEY is missing.
  const veo = await runVeo(trimmed, input);
  if (veo.url) {
    return veo;
  }

  // 2) FALLBACK: open-source LTX-Video via fal.ai. Skips silently if FAL_KEY is
  //    missing. fal.ai only hosts the GPU — LTX is open source and has no audio.
  const ltx = await runLtxVideo(trimmed);
  if (ltx.url) {
    return ltx;
  }

  // Neither provider produced a clip — no-op. The fixture clip can stand in.
  return { url: undefined, model: veo.model ?? ltx.model };
}

// ----------------------------------------------------------------------------
// PRIMARY — Veo (Google)
// ----------------------------------------------------------------------------
async function runVeo(
  prompt: string,
  input: GenerateAdInput,
): Promise<GenerateAdResult> {
  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    // Missing GOOGLE_API_KEY — skip Veo, let the LTX fallback take over.
    return { url: undefined };
  }

  try {
    const ai = getClient(apiKey);

    let operation = await ai.models.generateVideos({
      model: VEO_MODEL,
      prompt,
      config: {
        numberOfVideos: 1,
        aspectRatio: input.aspectRatio ?? "16:9",
      },
    });

    let attempts = 0;
    while (!operation.done && attempts < MAX_POLL_ATTEMPTS) {
      await delay(POLL_INTERVAL_MS);
      operation = await ai.operations.getVideosOperation({ operation });
      attempts += 1;
    }

    if (!operation.done) {
      // Timed out — fall back to LTX.
      return { url: undefined, model: VEO_MODEL };
    }

    const video = operation.response?.generatedVideos?.[0]?.video;
    const uri = video?.uri;
    if (!uri) {
      return { url: undefined, model: VEO_MODEL };
    }

    // The Files API uri requires the API key to download the bytes.
    const separator = uri.includes("?") ? "&" : "?";
    return { url: `${uri}${separator}key=${apiKey}`, model: VEO_MODEL };
  } catch (err) {
    // 403 (no paid billing), network error, etc. — degrade to the LTX fallback.
    console.error("[veo] Veo render failed, falling back to LTX-Video:", err);
    return { url: undefined, model: VEO_MODEL };
  }
}

// ----------------------------------------------------------------------------
// FALLBACK — LTX-Video (open source) hosted on fal.ai
//
// LTX-Video is an open-source text-to-video model (Lightricks). fal.ai only
// rents the GPU and exposes a queue-based REST API — no SDK, no bundled source.
// Note: LTX has NO native audio, so the clip is silent.
//
// Flow per fal's queue API:
//   POST  https://queue.fal.run/fal-ai/ltx-video   { prompt }
//     -> { request_id, status_url, response_url }
//   GET   status_url   (poll until { status: "COMPLETED" })
//   GET   response_url -> { video: { url } }  (the resulting mp4)
// ----------------------------------------------------------------------------
interface FalQueueSubmit {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface FalQueueStatus {
  status?: string; // "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | ...
  response_url?: string;
}

async function runLtxVideo(prompt: string): Promise<GenerateAdResult> {
  const falKey = getFalKey();
  if (!falKey) {
    // Missing FAL_KEY — nothing left to try. No-op silently.
    return { url: undefined };
  }

  const authHeader = { Authorization: `Key ${falKey}` };

  try {
    // 1) Submit the job to fal's queue.
    const submitRes = await fetch(FAL_LTX_ENDPOINT, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!submitRes.ok) {
      console.error(
        `[ltx-video] fal submit failed: ${submitRes.status} ${submitRes.statusText}`,
      );
      return { url: undefined, model: LTX_MODEL };
    }

    const submit = (await submitRes.json()) as FalQueueSubmit;
    const statusUrl = submit.status_url;
    let responseUrl = submit.response_url;
    if (!statusUrl) {
      return { url: undefined, model: LTX_MODEL };
    }

    // 2) Poll the queue status until COMPLETED (or budget exhausted).
    let attempts = 0;
    let completed = false;
    while (attempts < FAL_MAX_POLL_ATTEMPTS) {
      await delay(FAL_POLL_INTERVAL_MS);
      attempts += 1;

      const statusRes = await fetch(statusUrl, { headers: authHeader });
      if (!statusRes.ok) {
        continue; // transient — keep polling within budget
      }

      const statusBody = (await statusRes.json()) as FalQueueStatus;
      if (statusBody.response_url) {
        responseUrl = statusBody.response_url;
      }
      if (statusBody.status === "COMPLETED") {
        completed = true;
        break;
      }
    }

    if (!completed || !responseUrl) {
      // Timed out — let the caller fall back to the fixture clip.
      return { url: undefined, model: LTX_MODEL };
    }

    // 3) Fetch the result payload and extract the mp4 URL.
    const resultRes = await fetch(responseUrl, { headers: authHeader });
    if (!resultRes.ok) {
      return { url: undefined, model: LTX_MODEL };
    }

    const result = (await resultRes.json()) as Record<string, unknown>;
    const url = extractLtxVideoUrl(result);
    return { url, model: LTX_MODEL };
  } catch (err) {
    console.error("[ltx-video] fal render failed:", err);
    return { url: undefined, model: LTX_MODEL };
  }
}

/**
 * Pull the resulting mp4 URL out of fal's LTX-Video result payload. fal returns
 * either { video: { url } } or { video: { file: { url } } } depending on schema
 * version, so we defensively probe the common shapes.
 */
function extractLtxVideoUrl(
  result: Record<string, unknown>,
): string | undefined {
  const video = result["video"] as
    | { url?: string; file?: { url?: string } }
    | undefined;
  if (typeof video?.url === "string") {
    return video.url;
  }
  if (typeof video?.file?.url === "string") {
    return video.file.url;
  }
  // Some schemas return a list under "videos".
  const videos = result["videos"] as Array<{ url?: string }> | undefined;
  if (Array.isArray(videos) && typeof videos[0]?.url === "string") {
    return videos[0].url;
  }
  return undefined;
}
