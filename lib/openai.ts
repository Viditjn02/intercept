// ============================================================================
// HOLMES — OPENAI CLIENT
// Shared LLM helpers used by the swarm agents (router/enrich/reply) from
// "use node" Convex actions. chatJSON enforces JSON output; chatText is freeform.
// ============================================================================

import OpenAI from "openai";

const DEFAULT_MODEL = "gpt-4o-mini";

let cachedClient: OpenAI | null = null;

/**
 * Lazily construct the OpenAI client. Throws a clear error if the key is
 * missing so the failure surfaces at call time, not deep in the SDK.
 */
function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to your environment (Convex dashboard env vars) to enable LLM calls.",
    );
  }
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey });
  }
  return cachedClient;
}

export interface ChatOpts {
  /** Override the model. Defaults to gpt-4o-mini. */
  model?: string;
  /** Sampling temperature. Defaults to 0.4 for stable, on-brief output. */
  temperature?: number;
  /** Hard cap on response tokens. */
  maxTokens?: number;
}

/**
 * Call the model and parse a JSON object response. Uses response_format
 * json_object so the model is constrained to emit valid JSON.
 *
 * @param system  System prompt (role + constraints).
 * @param user    User prompt (the task / data).
 * @param schemaHint  Optional description of the desired JSON shape, appended
 *                    to the system prompt to steer the structure.
 */
export async function chatJSON<T = Record<string, unknown>>(
  system: string,
  user: string,
  schemaHint?: string,
  opts: ChatOpts = {},
): Promise<T> {
  const client = getClient();
  const systemPrompt = schemaHint
    ? `${system}\n\nRespond with a single JSON object matching this shape:\n${schemaHint}`
    : `${system}\n\nRespond with a single valid JSON object.`;

  const completion = await client.chat.completions.create({
    model: opts.model ?? DEFAULT_MODEL,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: user },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty response for chatJSON.");
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(
      `OpenAI chatJSON returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Call the model and return freeform text (e.g. a drafted in-thread reply).
 */
export async function chatText(
  system: string,
  user: string,
  opts: ChatOpts = {},
): Promise<string> {
  const client = getClient();

  const completion = await client.chat.completions.create({
    model: opts.model ?? DEFAULT_MODEL,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty response for chatText.");
  }
  return content.trim();
}
