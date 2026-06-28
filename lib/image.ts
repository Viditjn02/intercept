// ============================================================================
// INTERCEPT — AD IMAGE GENERATION (OpenAI gpt-image-1)
// ----------------------------------------------------------------------------
// The AD FACTORY (adsmith) generates the ad's hero image here. The PRIMARY path
// is OpenAI **gpt-image-1** (sponsor): images.generate returns `b64_json`, which
// the adsmith agent persists to Convex File Storage and serves as a URL.
//
// fal (flux) stays an OPTIONAL premium path that degrades to gpt-image-1; fal
// balance is currently $0, so it is NEVER the hard dependency — any missing key /
// 402 / error silently falls through to gpt-image-1.
//
// GRACEFUL CONTRACT (must hold): never throws. On a missing key / quota / error
// it returns `{ degraded: true, reason }` with no image, and the adsmith card
// renders copy-only.
//
// RUNTIME: pure fetch/SDK client — safe in the default Convex action runtime and
// in "use node" actions alike. It returns the raw b64 (storage is the caller's
// job, mirroring lib/veo.ts → convex/storage.storeFromUrl).
// ============================================================================

import OpenAI from "openai";

/** Result of an ad-image generation attempt. Exactly one of `b64`/`url` is set
 *  on success; on degrade both are absent and `degraded` is true. */
export interface GenerateImageResult {
  /** base64-encoded PNG from gpt-image-1 (caller persists to Convex storage). */
  b64?: string;
  /** a ready external URL (only the optional fal premium path returns this). */
  url?: string;
  /** the model that produced (or would have produced) the image. */
  model: string;
  /** true when no image was produced — the card degrades to copy-only. */
  degraded: boolean;
  /** machine-readable degrade reason, e.g. "no_openai_key" | "quota" | "error". */
  reason?: string;
}

export interface GenerateImageOpts {
  /** gpt-image-1 size: "1024x1024" | "1024x1536" | "1536x1024". 1:1 default. */
  size?: string;
  /** Try the optional fal premium path first (degrades to gpt-image-1). */
  preferFal?: boolean;
}

const IMAGE_MODEL = "gpt-image-1";
const FAL_MODEL = "fal-ai/flux/dev";
const DEFAULT_SIZE = "1024x1024";
const MAX_PROMPT_CHARS = 4000;

// fal queue budget — kept tight so a $0/slow fal never holds up the run.
const FAL_ENDPOINT = "https://queue.fal.run/fal-ai/flux/dev";
const FAL_POLL_TIMEOUT_MS = 20_000;
const FAL_POLL_INTERVAL_MS = 1_500;

/** True when the OpenAI key is present (the primary image path is viable). */
export function hasImageKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Generate an ad hero image from a prompt. PRIMARY path is OpenAI gpt-image-1
 * (returns b64); the optional fal premium path runs first only when `preferFal`
 * is set and silently degrades to gpt-image-1 on any failure. NEVER throws — on a
 * missing key / quota / error it returns `{ degraded: true, reason }` so the
 * adsmith card ships copy-only.
 */
export async function generateImage(
  prompt: string,
  opts: GenerateImageOpts = {},
): Promise<GenerateImageResult> {
  const cleanPrompt = (prompt ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
  if (!cleanPrompt) {
    return { model: IMAGE_MODEL, degraded: true, reason: "empty_prompt" };
  }

  // OPTIONAL premium: fal flux. Only attempted on request + key present, and any
  // failure (incl. $0 balance / 402) falls through to the gpt-image-1 path.
  if (opts.preferFal && process.env.FAL_KEY) {
    const fal = await tryFal(cleanPrompt).catch(() => null);
    if (fal?.url) {
      return { url: fal.url, model: FAL_MODEL, degraded: false };
    }
  }

  if (!hasImageKey()) {
    return { model: IMAGE_MODEL, degraded: true, reason: "no_openai_key" };
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.images.generate({
      model: IMAGE_MODEL,
      prompt: cleanPrompt,
      size: (opts.size ?? DEFAULT_SIZE) as "1024x1024" | "1024x1536" | "1536x1024" | "auto",
    });
    const b64 = res.data?.[0]?.b64_json;
    if (b64) {
      return { b64, model: IMAGE_MODEL, degraded: false };
    }
    return { model: IMAGE_MODEL, degraded: true, reason: "no_image_returned" };
  } catch (error) {
    return { model: IMAGE_MODEL, degraded: true, reason: classifyReason(error) };
  }
}

/** Map an OpenAI/SDK error to a stable, machine-readable degrade reason. */
function classifyReason(error: unknown): string {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "quota";
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/(quota|billing|insufficient|exceeded|balance)/.test(message)) return "quota";
  if (/(content|safety|moderation|rejected)/.test(message)) return "content_policy";
  return "error";
}

// ----------------------------------------------------------------------------
// OPTIONAL fal flux premium path. fal only rents the GPU + exposes a REST queue;
// no SDK. Bounded poll, fully guarded — returns null on any missing-key / 402 /
// timeout / error so the caller degrades to gpt-image-1. Never throws.
// ----------------------------------------------------------------------------
async function tryFal(prompt: string): Promise<{ url: string } | null> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) return null;
  const auth = { Authorization: `Key ${falKey}` };

  try {
    const submit = await fetch(FAL_ENDPOINT, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, image_size: "portrait_4_3", num_images: 1 }),
    });
    if (!submit.ok) return null; // 402 ($0 balance) / 401 / 5xx — degrade
    const queued = (await submit.json()) as {
      status_url?: string;
      response_url?: string;
    };
    const statusUrl = queued.status_url;
    const responseUrl = queued.response_url;
    if (!statusUrl || !responseUrl) return null;

    const deadline = Date.now() + FAL_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(FAL_POLL_INTERVAL_MS);
      const statusRes = await fetch(statusUrl, { headers: auth });
      if (!statusRes.ok) return null;
      const status = (await statusRes.json()) as { status?: string };
      if (status.status === "COMPLETED") break;
      if (status.status === "FAILED" || status.status === "ERROR") return null;
    }

    const resultRes = await fetch(responseUrl, { headers: auth });
    if (!resultRes.ok) return null;
    const result = (await resultRes.json()) as {
      images?: Array<{ url?: string }>;
    };
    const url = result.images?.[0]?.url;
    return url ? { url } : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
