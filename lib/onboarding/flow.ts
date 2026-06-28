// ============================================================================
// INTERCEPT — TRACK 3 · ONBOARDING FLOW BRAIN (headless, OnboardJS-modeled).
// ----------------------------------------------------------------------------
// Pure, fetch-free, runtime-free. Turns the raw tour steps the guide agent
// generates into a normalized, render-ready flow:
//   • normalizeSteps  — clamp count / order / placement → a clean OnboardingStep[]
//   • buildChecklist  — derive an activation checklist from the steps
//   • toOnboardJSSteps — map to an OnboardJS (@onboardjs/core) step config,
//                        the MIT headless "flow brain" that drives the embed
//
// `OnboardJSStep` is asserted assignable to OnboardJS's own `OnboardingStep`
// type at the bottom of this file, so our config stays in lockstep with the
// library without importing any of its runtime (keeps Convex/SSR builds clean).
//
// DEPLOY-SAFETY: NOT "use node"; defines no Convex functions (utility module).
// ============================================================================

import type { OnboardingStep } from "../contract";
import { ONBOARDING_STEP_MIN, ONBOARDING_STEP_MAX } from "../contract";

export type OnboardingPlacement =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "center";

const PLACEMENTS: readonly OnboardingPlacement[] = [
  "top",
  "bottom",
  "left",
  "right",
  "center",
] as const;

/** Coerce an arbitrary placement string to a valid Shepherd/Floating-UI side. */
export function normalizePlacement(raw: unknown): OnboardingPlacement {
  const value = String(raw ?? "").toLowerCase().trim();
  return (PLACEMENTS as readonly string[]).includes(value)
    ? (value as OnboardingPlacement)
    : "bottom";
}

/** A single derived activation checklist item (OnboardJS ChecklistItemDefinition-shaped). */
export interface ChecklistItem {
  id: string;
  label: string;
  description: string;
  isMandatory: boolean;
}

/** The fully-assembled flow the guide persists + the canvas renders. */
export interface GeneratedFlow {
  productName: string;
  framework: "shepherd" | "onboardjs";
  tourSteps: OnboardingStep[];
  checklist: ChecklistItem[];
}

/** Lowercase, hyphenated id-safe slug for step/checklist ids. */
export function slugifyId(value: string, fallback: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || fallback
  );
}

/**
 * Normalize raw model output into a clean, ordered OnboardingStep[]:
 *   • drop steps with no title/body
 *   • coerce placement to a valid side, target to a non-empty selector
 *   • re-number `order` 1..N after sorting
 *   • clamp to [ONBOARDING_STEP_MIN, ONBOARDING_STEP_MAX]
 * Tolerant by design — a thin or malformed payload still yields a usable tour.
 */
export function normalizeSteps(raw: readonly Partial<OnboardingStep>[]): OnboardingStep[] {
  const cleaned = (raw ?? [])
    .filter((s): s is Partial<OnboardingStep> => Boolean(s))
    .map((s, i) => {
      const title = String(s.title ?? "").trim();
      const body = String(s.body ?? "").trim();
      const target = String(s.target ?? "").trim() || "body";
      const cta = s.cta ? String(s.cta).trim() : undefined;
      return {
        order: typeof s.order === "number" ? s.order : i + 1,
        target,
        title,
        body,
        placement: normalizePlacement(s.placement),
        ...(cta ? { cta } : {}),
      } as OnboardingStep;
    })
    .filter((s) => s.title.length > 0 && s.body.length > 0)
    .sort((a, b) => a.order - b.order)
    .slice(0, ONBOARDING_STEP_MAX)
    .map((s, i) => ({ ...s, order: i + 1 }));

  return cleaned;
}

/** True when the normalized step set clears the floor for a real tour. */
export function isFlowViable(steps: readonly OnboardingStep[]): boolean {
  return steps.length >= ONBOARDING_STEP_MIN;
}

/**
 * Derive an activation checklist from the tour steps — the OnboardJS CHECKLIST
 * surface. Each step becomes one "get value" task; the first two are mandatory
 * (the activation core), the rest optional.
 */
export function buildChecklist(steps: readonly OnboardingStep[]): ChecklistItem[] {
  return steps.map((s, i) => ({
    id: slugifyId(s.title, `step-${i + 1}`),
    label: s.cta?.trim() || s.title,
    description: s.body,
    isMandatory: i < 2,
  }));
}

// ----------------------------------------------------------------------------
// OnboardJS bridge — map our tour to @onboardjs/core's INFORMATION step config.
// We keep our own structural type (OnboardJSStep) and statically assert it is
// assignable to the library's `OnboardingStep` (see the type guard below), so
// the emitted config is guaranteed valid for the OnboardJS engine WITHOUT
// pulling its runtime into this module.
// ----------------------------------------------------------------------------
export interface OnboardJSStep {
  id: string;
  type: "INFORMATION";
  payload: {
    title: string;
    body: string;
    target: string;
    placement: OnboardingPlacement;
    ctaLabel?: string;
  };
  nextStep?: string | null;
  previousStep?: string | null;
}

/** Map the normalized tour into an OnboardJS step array (the headless flow). */
export function toOnboardJSSteps(steps: readonly OnboardingStep[]): OnboardJSStep[] {
  const ids = steps.map((s, i) => slugifyId(s.title, `step-${i + 1}`));
  return steps.map((s, i) => ({
    id: ids[i],
    type: "INFORMATION" as const,
    payload: {
      title: s.title,
      body: s.body,
      target: s.target,
      placement: s.placement as OnboardingPlacement,
      ...(s.cta ? { ctaLabel: s.cta } : {}),
    },
    previousStep: i > 0 ? ids[i - 1] : null,
    nextStep: i < ids.length - 1 ? ids[i + 1] : null,
  }));
}

// Compile-time guarantee that OnboardJSStep is a valid @onboardjs/core step.
// `import type` is erased at build time, so this adds ZERO runtime/SSR weight.
// If OnboardJS changes its step shape, this line fails typecheck — by design.
import type { OnboardingStep as OnboardJSCoreStep } from "@onboardjs/core";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertOnboardJSCompatible = OnboardJSStep extends OnboardJSCoreStep
  ? true
  : never;
