// ============================================================================
// INTERCEPT — FREE VIDEO WORKER CLIENT  (MoneyPrinter path, $0)
// ----------------------------------------------------------------------------
// Thin, deploy-safe client for the local video worker (scripts/video-worker.mjs).
// The worker stitches Pexels stock footage + free Edge-TTS narration + ffmpeg
// captions into a finished MP4 — no fal, no Veo, no payment.
//
// Used by convex/agents/reelmaker.ts (social reel) and creative.ts (ad video)
// as the PRIMARY, free video path; both fall back to the existing Veo/fal chain
// when the worker is unreachable. This module:
//   • NEVER throws — every failure returns { ok:false } so the agent no-ops.
//   • Fast-fails when the worker is down (a 2.5s /health probe) so a missing
//     worker never blocks the run.
//   • Uses only `fetch` (no node:* imports) → safe in the default Convex runtime.
//
// VIDEO_WORKER_URL overrides the endpoint (default http://localhost:8787).
// ============================================================================

const DEFAULT_WORKER_URL = "http://localhost:8787";
const HEALTH_TIMEOUT_MS = 2500;
const RENDER_TIMEOUT_MS = Number(process.env.VIDEO_WORKER_TIMEOUT_MS) || 240_000;

export interface VideoWorkerScene {
  /** On-screen caption + narration line. */
  text: string;
  /** Pexels search query for this scene's stock footage (optional). */
  query?: string;
}

export interface RenderVideoInput {
  /** Full narration script (split into scenes if `scenes` is absent). */
  script?: string;
  /** Base subject — seeds Pexels queries when a scene has no explicit query. */
  topic?: string;
  /** Explicit scene list (preferred). Strings or {text, query}. */
  scenes?: Array<string | VideoWorkerScene>;
  aspectRatio?: "9:16" | "16:9" | "1:1";
  durationSeconds?: number;
  /** Edge-TTS voice id, e.g. "en-US-AndrewNeural". */
  voice?: string;
  /** Burn captions (default true; auto-skipped if ffmpeg lacks drawtext). */
  captions?: boolean;
}

export interface RenderVideoResult {
  ok: boolean;
  /** Worker-served URL (localhost) — for local inspection only. */
  url?: string;
  /** Local mp4 path on the worker host. */
  path?: string;
  /** mp4 bytes (base64) for storing into Convex file storage. */
  videoBase64?: string;
  contentType?: string;
  durationSeconds?: number;
  model: string;
  degraded: boolean;
  reason?: string;
  usedPexels?: boolean;
  usedTts?: boolean;
}

const UNREACHABLE: RenderVideoResult = {
  ok: false,
  degraded: true,
  reason: "worker_unreachable",
  model: "moneyprinter-pexels-edgetts",
};

function workerUrl(): string {
  return (process.env.VIDEO_WORKER_URL || DEFAULT_WORKER_URL).replace(/\/$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Is the worker up? Fast-fails so a missing worker never blocks a run. */
export async function isWorkerHealthy(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${workerUrl()}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS);
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean; ffmpeg?: boolean };
    return json.ok === true && json.ffmpeg === true;
  } catch {
    return false;
  }
}

/**
 * Render a video via the free worker. Returns { ok:false } (never throws) when
 * the worker is down, ffmpeg is missing, or the render degrades to nothing.
 */
export async function renderVideo(input: RenderVideoInput): Promise<RenderVideoResult> {
  // Probe first — a fast no-op when the worker isn't running locally.
  if (!(await isWorkerHealthy())) return UNREACHABLE;

  try {
    const res = await fetchWithTimeout(
      `${workerUrl()}/render`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      RENDER_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { ...UNREACHABLE, reason: `worker_http_${res.status}` };
    }
    const json = (await res.json()) as RenderVideoResult;
    return {
      ...json,
      ok: json.ok === true,
      degraded: json.degraded ?? false,
      model: json.model ?? "moneyprinter-pexels-edgetts",
    };
  } catch (e) {
    return { ...UNREACHABLE, reason: e instanceof Error ? `worker_error:${e.message}` : "worker_error" };
  }
}
