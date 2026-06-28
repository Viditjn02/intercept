"use client";

/**
 * blipSuggestions — the small, context-aware "Acey-style" hint library plus a
 * best-effort surface detector. Blip surfaces ONE of these short, friendly
 * next-step nudges the instant you interact with (or briefly pause on) the
 * page. Three buckets, keyed by what's on screen:
 *
 *   • "dashboard" — the landing / command center (pick a play, paste a URL).
 *   • "board"     — inside a track board / focused run (expand a company, ⌘K…).
 *   • "idle"      — generic rotating product tips when the surface is unknown
 *                   or Blip is just keeping you company at rest.
 *
 * DETECTION is best-effort + graceful: an explicit `hint` (the sidebar knows
 * its own surface) wins; otherwise we read a `data-intercept-surface` marker
 * off the DOM; otherwise we fall back to "idle". SSR-safe (guards `document`),
 * never throws.
 *
 * RANDOMNESS is owned by the caller, which only ever calls `pickSuggestion`
 * client-side and post-mount (inside an event / timer handler) — so there is no
 * hydration concern here (no Math.random during render).
 */

import type { BlipState } from "./Blip";

export type BlipContext = "dashboard" | "board" | "idle";

export interface BlipSuggestion {
  /** The short, friendly one-liner shown in the bubble. */
  text: string;
  /** Optional talking pose (default "talking"); decorative only. */
  mood?: BlipState;
}

// Landing / command center: orient the user toward a first play.
const DASHBOARD: readonly BlipSuggestion[] = [
  { text: "Pick a play — or paste a company URL ↘" },
  { text: "Tap a track and I'll run it for you" },
  { text: "New here? Start with Reading Minds 🧠" },
  { text: "Flip on 24/7 and I'll hunt overnight 🌙" },
  { text: "Paste a link in Ad Factory and I'll break it down" },
];

// Inside a board / focused run: nudge the next interaction on the canvas.
const BOARD: readonly BlipSuggestion[] = [
  { text: "Click a company to expand its flow" },
  { text: "⌘K opens the command bar" },
  { text: "Hover a node to see what I found 👀" },
  { text: "Want outreach drafted next? Just say the word" },
  { text: "Open the brain to see what I've learned 🧠" },
];

// At rest / surface unknown: rotating product tips that teach the surface area.
const IDLE: readonly BlipSuggestion[] = [
  { text: "Flip on 24/7 and I'll work overnight 🌙" },
  { text: "Drop a link in Ad Factory and I'll break it down" },
  { text: "Try Algorithm Hacking to go viral 🚀" },
  { text: "Paste any company URL and watch me go" },
  { text: "⌘K is your shortcut to everything" },
];

const POOLS: Record<BlipContext, readonly BlipSuggestion[]> = {
  dashboard: DASHBOARD,
  board: BOARD,
  idle: IDLE,
};

/**
 * Best-effort resolve the on-screen bucket. `hint` (when the caller knows its
 * surface) wins; else read the DOM marker `data-intercept-surface`; else idle.
 */
export function detectBlipContext(hint?: BlipContext | null): BlipContext {
  if (hint === "dashboard" || hint === "board" || hint === "idle") return hint;
  if (typeof document === "undefined") return "idle";
  try {
    const marker = document.querySelector("[data-intercept-surface]");
    const surface = marker?.getAttribute("data-intercept-surface");
    if (surface === "dashboard") return "dashboard";
    if (surface === "workspace") return "board";
  } catch {
    /* DOM not ready / blocked — fall through to idle */
  }
  return "idle";
}

/**
 * Pick a suggestion for a context, avoiding an immediate repeat of `last` so the
 * bubble visibly rotates. Returns null only if the pool is somehow empty.
 */
export function pickSuggestion(
  context: BlipContext,
  last?: string | null,
): BlipSuggestion | null {
  const pool = POOLS[context] ?? IDLE;
  if (pool.length === 0) return null;
  const choices =
    pool.length > 1 && last ? pool.filter((s) => s.text !== last) : pool;
  const list = choices.length > 0 ? choices : pool;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx] ?? list[0];
}
