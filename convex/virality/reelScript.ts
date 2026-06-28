// ============================================================================
// INTERCEPT — TRACK 1 · REEL SCRIPT (MoneyPrinterTurbo segment structure).
//
// Pure, no deps. Ports MoneyPrinterTurbo's pipeline IDEA (script → segmented
// scene beats → render prompt) into a deterministic builder. Turns a
// topic+angle into a segmented vertical-video script — hook → 3 beats → CTA —
// and assembles a single 9:16 generation prompt the reelmaker hands to
// lib/veo.generateAd (Veo → fal-LTX fallback).
//
// We do NOT run MoneyPrinter's Python or fetch stock footage; we keep its
// structure (a hook-led script broken into timed scene beats with auto social
// CTA) and feed it to our existing sponsor video chain. Deterministic so the
// reel step never stalls even with no LLM.
//
// DEPLOY-SAFETY: NOT "use node"; defines no Convex functions (utility module).
// ============================================================================

export interface ReelScriptInput {
  company: string;
  topic: string;
  angle: string;
  /** Optional one-line positioning to sharpen the payoff beat. */
  positioning?: string;
}

export interface ReelScript {
  hook: string;
  beats: string[]; // the 3 middle segments (problem → insight → product)
  cta: string;
  /** The assembled vertical-video generation prompt for lib/veo.generateAd. */
  prompt: string;
}

const REEL_SECONDS = 8; // matches the creative agent's short vertical format
const ASPECT = "9:16";

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Build a segmented vertical-video script + render prompt from a topic/angle.
 * Structure (MoneyPrinter-style): a scroll-stopping hook, three escalating
 * scene beats (tension → insight → product reveal), and a social CTA — all
 * woven into one cinematic 9:16 prompt with on-screen caption cues.
 */
export function buildReelScript(input: ReelScriptInput): ReelScript {
  const company = clean(input.company) || "the product";
  const topic = clean(input.topic) || "what everyone's talking about";
  const angle = clean(input.angle) || `why ${company} matters now`;
  const positioning = clean(input.positioning ?? "");

  // Hook — the first ~1.5s. Pegged to the live topic so it reads as timely.
  const hook = `Everyone's talking about ${topic} — almost nobody gets ${angle}.`;

  // 3 beats: tension → reframe → product payoff. Mirrors MoneyPrinter's
  // script→scene split (each beat is one ~2s scene the renderer can cut to).
  const beats = [
    `The old way of handling ${topic} is quietly costing you — show the frustration on screen.`,
    `Here's the reframe: ${angle}. Land it as a single bold caption.`,
    positioning
      ? `${company} makes it effortless: ${positioning}. Reveal the product in action.`
      : `${company} makes it effortless — reveal the product solving it in one clean shot.`,
  ];

  // CTA — the close. A single explicit ask drives comments/shares (the signal
  // the algorithm rewards). MoneyPrinter's auto social-metadata step, inlined.
  const cta = `Follow for more on ${topic} — and comment "${company}" if you want the breakdown.`;

  // Assemble the one-shot 9:16 generation prompt (scene-by-scene direction).
  const prompt = [
    `A ${REEL_SECONDS}-second vertical (${ASPECT}) social reel for ${company}, built to go viral on TikTok/Reels.`,
    `HOOK (0-1.5s): ${hook} Fast, punchy open with bold on-screen caption.`,
    `BEAT 1 (1.5-3.5s): ${beats[0]}`,
    `BEAT 2 (3.5-5.5s): ${beats[1]}`,
    `BEAT 3 (5.5-7s): ${beats[2]}`,
    `CTA (7-8s): end-card with "${company}" and the caption "${cta}".`,
    "Style: high-energy, high-contrast, modern creator aesthetic; quick cuts, kinetic captions, vertical framing.",
    "No watermarks, no gibberish text; captions must be legible and on-brand.",
  ].join(" ");

  return { hook, beats, cta, prompt };
}
