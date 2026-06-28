// ============================================================================
// INTERCEPT — TRACK 3 · ONBOARDING GUIDE PROMPT (OpenAI flow generation).
// ----------------------------------------------------------------------------
// Pure prompt construction + response parsing + a deterministic fallback so the
// guide agent ALWAYS produces a usable tour:
//   • buildGuidePrompts — system+user prompt grounding the model in the product
//   • parseGuideSteps   — tolerant parse of the JSON the model returns
//   • fallbackFlowSteps — deterministic, key-free activation tour from context
//
// DEPLOY-SAFETY: NOT "use node"; defines no Convex functions (utility module).
// ============================================================================

import type { OnboardingStep } from "../contract";
import { ONBOARDING_STEP_MIN, ONBOARDING_STEP_MAX } from "../contract";
import { normalizeSteps } from "./flow";

/** Everything the guide knows about the product it's onboarding users into. */
export interface GuideContext {
  productName: string;
  url: string; // the product URL the flow is generated "from"
  valueProp: string; // positioning / one-liner
  icp: string; // who the user is
  /** Best-effort visible text scraped from the landing page (may be empty). */
  pageText: string;
}

const SCHEMA_HINT = `{
  "steps": [
    {
      "order": 1,
      "target": "CSS selector hint for the UI element (e.g. \\".sidebar-new-btn\\", \\"#search\\", \\"nav a[href='/settings']\\")",
      "title": "short tooltip title (<= 6 words)",
      "body": "one or two sentences of guidance tied to the product's value",
      "placement": "top | bottom | left | right | center",
      "cta": "optional button label (e.g. \\"Create your first project\\")"
    }
  ]
}`;

/**
 * Build the system + user prompts for the onboarding-flow generator. The model
 * is asked for a short, activation-focused product tour grounded in the real
 * page text when available.
 */
export function buildGuidePrompts(ctx: GuideContext): {
  system: string;
  user: string;
  schemaHint: string;
} {
  const system = [
    "You are a world-class product-led-growth (PLG) onboarding designer.",
    "You design in-app product tours that drive a brand-new user to their first",
    '"aha" moment as fast as possible — concrete, click-by-click, never generic.',
    `Produce between ${ONBOARDING_STEP_MIN} and ${ONBOARDING_STEP_MAX} steps.`,
    "Each step points at a plausible real UI element via a CSS selector hint,",
    "has a punchy title and a benefit-led body, and progresses logically from",
    "first login → core action → activation. Mirror the product's own wording.",
  ].join(" ");

  const grounding = ctx.pageText.trim()
    ? `\n\nLanding-page copy (verbatim, use it to ground selectors + wording):\n"""${ctx.pageText.slice(0, 4000)}"""`
    : "";

  const user = [
    `Product: ${ctx.productName}`,
    ctx.url ? `URL: ${ctx.url}` : "",
    ctx.valueProp ? `Value proposition: ${ctx.valueProp}` : "",
    ctx.icp ? `Target user (ICP): ${ctx.icp}` : "",
    grounding,
    "",
    `Design the first-run onboarding tour for ${ctx.productName}. Walk the new`,
    "user from landing to their first real outcome. Return JSON only.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user, schemaHint: SCHEMA_HINT };
}

/** Loose shape of the model's JSON (every field read defensively). */
interface RawGuideResponse {
  steps?: unknown;
}

/**
 * Parse the model's JSON into a clean OnboardingStep[]. Tolerant of shape drift
 * (array at the root, `steps`, or `tour`); always returns a normalized set.
 */
export function parseGuideSteps(raw: unknown): OnboardingStep[] {
  const root = (raw ?? {}) as RawGuideResponse & { tour?: unknown };
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(root.steps)
      ? root.steps
      : Array.isArray(root.tour)
        ? root.tour
        : [];
  return normalizeSteps(list as Partial<OnboardingStep>[]);
}

/**
 * Deterministic, key-free activation tour built purely from context. Used when
 * there is no OPENAI_API_KEY or the model output is unusable — the guide must
 * never leave the canvas empty.
 */
export function fallbackFlowSteps(ctx: GuideContext): OnboardingStep[] {
  const product = ctx.productName || "the product";
  const value = ctx.valueProp.trim() || `everything ${product} can do`;
  const who = ctx.icp.trim();

  const raw: OnboardingStep[] = [
    {
      order: 1,
      target: "body",
      title: `Welcome to ${product}`,
      body: who
        ? `Built for ${who}. This quick tour gets you to your first win in under a minute.`
        : `This quick tour gets you to your first win in under a minute.`,
      placement: "center",
      cta: "Start the tour",
    },
    {
      order: 2,
      target: "nav, header",
      title: "Your command center",
      body: `Everything lives here. This is where you'll navigate ${product} day to day.`,
      placement: "bottom",
    },
    {
      order: 3,
      target: "[data-onboarding='primary-action'], .btn-primary, button[type='submit']",
      title: "Take the key action",
      body: `Kick off the core workflow — this is where ${product} delivers ${value}.`,
      placement: "right",
      cta: "Create your first one",
    },
    {
      order: 4,
      target: "main, [role='main']",
      title: "See your result",
      body: `Your output shows up right here. That's the "aha" — ${value}.`,
      placement: "left",
    },
    {
      order: 5,
      target: "[href*='settings'], [aria-label*='Settings']",
      title: "Make it yours",
      body: `Invite teammates and tune your settings so ${product} fits the way you work.`,
      placement: "top",
      cta: "Finish setup",
    },
  ];

  return normalizeSteps(raw);
}
