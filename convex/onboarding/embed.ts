// ============================================================================
// INTERCEPT — TRACK 3 · ONBOARDING EMBED BUILDER (Shepherd.js / OnboardJS, MIT).
// ----------------------------------------------------------------------------
// Pure, fetch-free. Deterministically emits a paste-ready tour from the
// structured steps the guide agent generated:
//   • buildEmbed       — Shepherd.js (default) or OnboardJS init code, served
//                        from the MIT CDNs, hardened with a finderx-style
//                        fallback so a step whose selector drifted still anchors.
//   • suggestSelectors — usertour/finderx-style heuristic: a step title → the
//                        most likely CSS selectors to attach the tooltip to.
//
// DEPLOY-SAFETY: NOT "use node"; defines no Convex functions (utility module).
// ============================================================================

import type { OnboardingStep } from "../../lib/contract";
import { normalizePlacement, slugifyId } from "../../lib/onboarding/flow";

export type OnboardingFramework = "shepherd" | "onboardjs";

const SHEPHERD_CSS =
  "https://cdn.jsdelivr.net/npm/shepherd.js@15/dist/css/shepherd.css";
const SHEPHERD_JS =
  "https://cdn.jsdelivr.net/npm/shepherd.js@15/dist/js/shepherd.mjs";
const ONBOARDJS_JS =
  "https://cdn.jsdelivr.net/npm/@onboardjs/core@latest/dist/index.es.js";

/** JSON.stringify a string for safe inlining inside generated JS source. */
function js(value: string): string {
  return JSON.stringify(value ?? "");
}

/**
 * Assemble a ready-to-paste tour embed snippet from structured steps.
 * Returns "" only when there are no steps (the canvas shows an empty state).
 */
export function buildEmbed(
  steps: OnboardingStep[],
  framework: OnboardingFramework = "shepherd",
): string {
  if (!steps || steps.length === 0) return "";
  return framework === "onboardjs"
    ? buildOnboardJSEmbed(steps)
    : buildShepherdEmbed(steps);
}

// ----------------------------------------------------------------------------
// Shepherd.js — the default tour UI. Self-contained ES-module snippet: pulls
// the MIT Shepherd build + CSS from the CDN, then walks the steps. Each step's
// `attachTo` falls back through suggestSelectors() so a single stale selector
// never breaks the tour (the finderx-style resilience).
// ----------------------------------------------------------------------------
function buildShepherdEmbed(steps: OnboardingStep[]): string {
  const stepSrc = steps
    .map((s) => {
      const fallbacks = suggestSelectors(s.title).filter((sel) => sel !== s.target);
      const candidates = [s.target, ...fallbacks];
      const buttons = [
        s.order > 1
          ? `{ text: 'Back', action() { return this.back(); }, secondary: true }`
          : "",
        `{ text: ${js(s.cta || (s.order === steps.length ? "Done" : "Next"))}, action() { return this.next(); } }`,
      ]
        .filter(Boolean)
        .join(", ");
      return `  tour.addStep({
    id: ${js(slugifyId(s.title, `step-${s.order}`))},
    title: ${js(s.title)},
    text: ${js(s.body)},
    attachTo: { element: pick([${candidates.map(js).join(", ")}]), on: ${js(normalizePlacement(s.placement))} },
    buttons: [${buttons}]
  });`;
    })
    .join("\n");

  return `<!-- INTERCEPT onboarding tour — Shepherd.js (MIT). Paste before </body>. -->
<link rel="stylesheet" href="${SHEPHERD_CSS}" />
<script type="module">
import Shepherd from '${SHEPHERD_JS}';

// Resilience: attach to the first selector that resolves on the page.
// (Port of usertour/finderx element re-finding — a drifted selector degrades.)
const pick = (selectors) =>
  selectors.find((sel) => { try { return document.querySelector(sel); } catch { return false; } })
  || selectors[selectors.length - 1];

const tour = new Shepherd.Tour({
  useModalOverlay: true,
  defaultStepOptions: { scrollTo: true, cancelIcon: { enabled: true }, classes: 'intercept-onboarding' }
});

${stepSrc}

tour.start();
</script>`;
}

// ----------------------------------------------------------------------------
// OnboardJS — the headless flow engine. Emits the step config (the same shape
// lib/onboarding.toOnboardJSSteps produces) wired into an OnboardingEngine.
// ----------------------------------------------------------------------------
function buildOnboardJSEmbed(steps: OnboardingStep[]): string {
  const ids = steps.map((s, i) => slugifyId(s.title, `step-${i + 1}`));
  const stepSrc = steps
    .map((s, i) => `  {
    id: ${js(ids[i])},
    type: 'INFORMATION',
    payload: {
      title: ${js(s.title)},
      body: ${js(s.body)},
      target: ${js(s.target)},
      placement: ${js(normalizePlacement(s.placement))}${s.cta ? `,\n      ctaLabel: ${js(s.cta)}` : ""}
    },
    previousStep: ${i > 0 ? js(ids[i - 1]) : "null"},
    nextStep: ${i < ids.length - 1 ? js(ids[i + 1]) : "null"}
  }`)
    .join(",\n");

  return `<!-- INTERCEPT onboarding flow — OnboardJS core (MIT, headless). -->
<script type="module">
import { OnboardingEngine } from '${ONBOARDJS_JS}';

const steps = [
${stepSrc}
];

const engine = new OnboardingEngine({ steps });
engine.addEventListener('stepActive', ({ state }) => {
  // Render state.currentStep.payload with your UI of choice (Shepherd, a
  // custom tooltip, a checklist…). OnboardJS owns the flow logic.
  console.log('onboarding step:', state.currentStep?.id, state.currentStep?.payload);
});
await engine.start();
</script>`;
}

// ----------------------------------------------------------------------------
// suggestSelectors — usertour/finderx-style heuristic. We don't have the live
// DOM at generation time, so instead of finderx's element→selector walk we run
// the inverse: a step title → the most likely selectors a real app would use
// for that element (data-onboarding hooks first, then id/class/aria/text).
// ----------------------------------------------------------------------------
const STOPWORDS = new Set<string>([
  "the", "a", "an", "your", "you", "to", "of", "and", "or", "for", "with",
  "first", "this", "that", "see", "make", "take", "get", "into", "in", "on",
  "is", "it", "here", "welcome", "key", "command", "center", "result",
]);

/** Derive 1-2 salient keyword stems from a step title. */
function keywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 2);
}

/**
 * Heuristically suggest likely CSS selectors for a step title, most-specific
 * first. Always returns at least one safe selector ("body") so callers can rely
 * on a non-empty list.
 */
export function suggestSelectors(stepTitle: string): string[] {
  const words = keywords(stepTitle);
  const out: string[] = [];
  for (const w of words) {
    out.push(`[data-onboarding="${w}"]`);
    out.push(`[data-tour="${w}"]`);
    out.push(`#${w}`);
    out.push(`.${w}`);
    out.push(`[aria-label*="${w}" i]`);
    out.push(`button[title*="${w}" i]`);
  }
  out.push("[data-onboarding]");
  out.push("main, [role='main']");
  out.push("body");
  // De-dupe, preserve order.
  return Array.from(new Set(out));
}
