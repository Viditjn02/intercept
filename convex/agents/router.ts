// ============================================================================
// HOLMES — ROUTER AGENT
// The lightweight front door of the swarm. It reads the raw run input, asks the
// LLM to classify what kind of input it is (url | name | competitor | community
// | text), guesses the buyer intent of the run, and extracts the company's
// canonical domain so the rest of the swarm (enrich, detective) has a clean
// target to work from.
//
// Router is intentionally cheap: it persists nothing heavy. It RETURNS the
// classification so the orchestrator can log it / branch on it. The orchestrator
// (convex/run.ts) owns agentStatus — this file never touches it.
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { chatJSON } from "../../lib/openai";

type InputType = "url" | "name" | "competitor" | "community" | "text";
const INPUT_TYPES: readonly InputType[] = [
  "url",
  "name",
  "competitor",
  "community",
  "text",
];

// What the router hands back to the orchestrator.
export interface RouterClassification {
  inputType: InputType; // the (possibly corrected) shape of the input
  company: string; // best-guess human company name
  domain: string | null; // canonical apex domain, e.g. "acme.com"
  url: string | null; // canonical https URL to fetch, if derivable
  category: string; // short label, e.g. "B2B SaaS — observability"
  rationale: string; // one sentence on why it's classified this way
}

// Shape we ask the LLM to return. Kept narrow so parsing is predictable.
interface RouterModelOutput {
  inputType?: string;
  company?: string;
  domain?: string | null;
  category?: string;
  rationale?: string;
}

// ----------------------------------------------------------------------------
// Internal query: read the run row. Co-located so the router has zero
// cross-module dependencies for the one thing it needs to read.
// ----------------------------------------------------------------------------
export const getRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"runs"> | null> => {
    return await ctx.db.get(runId);
  },
});

// ----------------------------------------------------------------------------
// Pure helpers — no side effects, easy to reason about.
// ----------------------------------------------------------------------------

/** Pull a clean apex domain out of arbitrary input (URL, "Acme", "acme.com"). */
function extractDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Try as a URL first.
  try {
    const url = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
    );
    const host = url.hostname.replace(/^www\./, "");
    if (host.includes(".")) return host;
  } catch {
    // fall through to regex
  }

  // Bare domain-ish token, e.g. "acme.com" or "sub.acme.io"
  const match = trimmed.match(
    /([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/|$|\s)/,
  );
  if (match) return match[1].replace(/^www\./, "");

  return null;
}

/** Normalize a domain to a canonical https URL we can fetch. */
function domainToUrl(domain: string | null): string | null {
  if (!domain) return null;
  return `https://${domain}`;
}

/** Coerce a model-provided inputType into our allowed union, else fall back. */
function coerceInputType(
  candidate: string | undefined,
  fallback: InputType,
): InputType {
  if (!candidate) return fallback;
  const lowered = candidate.trim().toLowerCase();
  return (INPUT_TYPES as readonly string[]).includes(lowered)
    ? (lowered as InputType)
    : fallback;
}

/** Heuristic company name from input when the model gives us nothing useful. */
function fallbackCompanyName(input: string, domain: string | null): string {
  if (domain) {
    const root = domain.split(".")[0];
    return root.charAt(0).toUpperCase() + root.slice(1);
  }
  return input.trim().slice(0, 80) || "Unknown";
}

// ----------------------------------------------------------------------------
// The agent action.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<RouterClassification> => {
    const runDoc = await ctx.runQuery(internal.agents.router.getRun, { runId });
    if (!runDoc) {
      throw new Error(`router: run ${runId} not found`);
    }

    const input = runDoc.input;
    const domainGuess = extractDomain(input);

    // Best-effort LLM classification. If the model call fails we still return a
    // sane heuristic classification so the swarm never stalls on the router.
    let model: RouterModelOutput = {};
    try {
      model = await chatJSON<RouterModelOutput>({
        system:
          "You are the routing layer of a GTM intelligence swarm. Classify a " +
          "single piece of user input about a company and extract a canonical " +
          "web domain. Respond with STRICT JSON only.",
        user: [
          `Input: """${input}"""`,
          `Pre-detected input type: ${runDoc.inputType}`,
          "",
          "Return a JSON object with EXACTLY these keys:",
          '- "inputType": one of "url" | "name" | "competitor" | "community" | "text"',
          '- "company": the human-readable company name this input is about',
          '- "domain": the canonical apex domain (e.g. "acme.com") or null',
          '- "category": a short market category, e.g. "B2B SaaS — observability"',
          '- "rationale": one sentence on why you classified it this way',
        ].join("\n"),
        temperature: 0,
      });
    } catch {
      model = {};
    }

    const inputType = coerceInputType(model.inputType, runDoc.inputType);
    const domain =
      (model.domain && model.domain.trim()) || domainGuess || null;
    const company =
      (model.company && model.company.trim()) ||
      fallbackCompanyName(input, domain);

    return {
      inputType,
      company,
      domain,
      url: domainToUrl(domain),
      category: (model.category && model.category.trim()) || "Unknown category",
      rationale:
        (model.rationale && model.rationale.trim()) ||
        "Classified heuristically from the raw input.",
    };
  },
});
