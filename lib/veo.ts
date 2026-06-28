// ============================================================================
// INTERCEPT — VEO (GOOGLE) VIDEO AD CLIENT
// The Creative agent (convex/agents/creative.ts) calls generateAd to render the
// Veo video ad. Called from a "use node" Convex action.
//
// IMPORTANT — BILLING / FALLBACK:
//   veo-3.1-fast-generate-001 requires a Google AI Studio / Vertex project with
//   PAID billing enabled. On a free key this call 403s. The demo path uses a
//   pre-rendered fixture clip (ReplayFixture.creativeUrl). For a live non-paid
//   fallback, swap in an LTX-Video render (e.g. Fal/Replicate LTX) behind the
//   same generateAd(prompt) signature so callers don't change.
//
//   The returned file.uri is a Google Files API URL that needs the API key
//   appended (?key=...) to actually download the bytes — we return the
//   key-appended URL so it is directly fetchable/clickable.
// ============================================================================

import { GoogleGenAI } from "@google/genai";

const VEO_MODEL = "veo-3.1-fast-generate-001";
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 30; // ~5 min ceiling

let cachedClient: GoogleGenAI | null = null;

function getApiKey(): string {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY is not set. Add it to your environment (Convex dashboard env vars) to enable Veo video generation.",
    );
  }
  return apiKey;
}

function getClient(): GoogleGenAI {
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey: getApiKey() });
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
  /** Directly fetchable video URL (Files API uri with key appended). */
  url?: string;
  /** The model that produced the clip (echoed back for the board). */
  model?: string;
}

/**
 * Generate a short video ad from a text prompt using Veo. Polls the
 * long-running operation until done, then returns the downloadable file URL.
 *
 * Never throws on "no video yet"/timeout — returns { url: undefined } so the
 * orchestrator's fan-in can render a partial brief instead of blocking.
 */
export async function generateAd(
  input: GenerateAdInput,
): Promise<GenerateAdResult> {
  const trimmed = input.prompt.trim();
  if (!trimmed) {
    throw new Error("generateAd requires a non-empty prompt.");
  }

  const ai = getClient();
  const apiKey = getApiKey();

  let operation = await ai.models.generateVideos({
    model: VEO_MODEL,
    prompt: trimmed,
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
    // Timed out — let the caller fall back to the fixture clip.
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
}
