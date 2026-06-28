// ============================================================================
// HOLMES — GEMINI REEL ANALYSIS CLIENT
// Analyzes a reference reel/video to extract creative structure the Creative
// agent reuses when prompting Veo. Called from a "use node" Convex action.
// Uses gemini-2.5-flash with JSON response mode.
// ============================================================================

import { GoogleGenAI } from "@google/genai";

const GEMINI_MODEL = "gemini-2.5-flash";

let cachedClient: GoogleGenAI | null = null;

function getApiKey(): string {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY is not set. Add it to your environment (Convex dashboard env vars) to enable reel analysis.",
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

export interface ReelAnalysis {
  hook_type: string;
  pacing: string;
  cta_text: string;
  [key: string]: unknown;
}

const RESPONSE_SCHEMA_HINT = `{
  "hook_type": string,   // e.g. "question", "bold-claim", "pattern-interrupt"
  "pacing": string,      // e.g. "fast-cut", "slow-build", "steady"
  "cta_text": string     // the call-to-action text/idea
}`;

/**
 * Pull the video bytes for an http(s) URL and upload them via the Files API so
 * Gemini can read the content. For gs:// or already-hosted file URIs we pass
 * the URI through as fileData.
 */
async function buildVideoPart(
  ai: GoogleGenAI,
  fileUrl: string,
): Promise<{ fileData: { fileUri: string; mimeType: string } }> {
  if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch reel (${resp.status}) from ${fileUrl}`);
    }
    const mimeType = resp.headers.get("content-type") ?? "video/mp4";
    const blob = await resp.blob();
    const uploaded = await ai.files.upload({ file: blob, config: { mimeType } });
    const fileUri = uploaded.uri;
    if (!fileUri) {
      throw new Error("Files API upload did not return a uri.");
    }
    return { fileData: { fileUri, mimeType: uploaded.mimeType ?? mimeType } };
  }
  // Already a hosted/gs URI.
  return { fileData: { fileUri: fileUrl, mimeType: "video/mp4" } };
}

/**
 * Analyze a reference reel and return its creative structure as JSON.
 */
export async function analyzeReel(fileUrl: string): Promise<ReelAnalysis> {
  const trimmed = fileUrl.trim();
  if (!trimmed) {
    throw new Error("analyzeReel requires a non-empty fileUrl.");
  }

  const ai = getClient();
  const videoPart = await buildVideoPart(ai, trimmed);

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          videoPart,
          {
            text:
              "Analyze this short-form video ad. Identify its hook type, pacing, " +
              `and call-to-action. Respond as JSON matching:\n${RESPONSE_SCHEMA_HINT}`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned an empty response for analyzeReel.");
  }

  try {
    return JSON.parse(text) as ReelAnalysis;
  } catch (error) {
    throw new Error(
      `Gemini analyzeReel returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
