"use client";

/**
 * Mascot — INTERCEPT's reactive delight mascot. A faithful port of ACME's
 * "Acey" sprite (AceySprite.tsx), RECOLORED to INTERCEPT's Figma editorial
 * palette and REPURPOSED: here the mascot is pure delight that reacts to the
 * live swarm (see useMascotReactions.ts). Acme's guide/book/FAQ chat flow is
 * intentionally DROPPED — this is never a chat input, only a friendly face.
 *
 * Pure CSS + inline SVG. No npm deps, no external image assets, no framer-motion.
 * One source of truth (`state`) drives a finite set of CSS keyframe animations,
 * mirroring the Codex-pet "row = state" model.
 *
 * Brand palette (INTERCEPT — navy ink + magenta accent + white):
 *   body navy    #1f1d3d  (block-navy / ink-navy — the body fill)
 *   deep navy    #15142a  (pupils / deepest shade — also the night canvas)
 *   indigo       #3a3566  (belly highlight, antenna stalk, waving hand)
 *   indigo line  #4a4576  (thin inner outline so the body reads on a card)
 *   magenta      #ff3d8b  (accent-magenta — rim edge, cheeks, antenna tip,
 *                          thinking dots, one celebrate sparkle)
 *   white                 (face, eyes, mouth, gloss, eye sparkle, brows, hand)
 *
 * Reading on BOTH themes (the key recolor constraint):
 *   - LIGHT (white canvas #ffffff): the navy body reads with high contrast; the
 *     magenta rim frames it crisply so it never melts into a white card/button.
 *   - NIGHT (deep-navy canvas #15142a): the navy body matches INTERCEPT's own
 *     raised-tile contrast (#1f1d3d lifts off #15142a exactly as surface-soft
 *     does), and the magenta rim GLOWS to keep the silhouette legible on dark.
 *   The magenta edge is the one device that guarantees legibility on both grounds.
 *
 * Accessibility:
 *   - The sprite is purely decorative → aria-hidden + role="img".
 *   - prefers-reduced-motion: all keyframe motion is disabled and the mascot
 *     renders frozen on a calm, neutral idle pose.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * The mascot's mood/animation states.
 *   Core (looping): idle · thinking · talking
 *   One-shots (auto-return to idle via the caller's ONE_SHOT timer):
 *     wave · happy · peek · nod · celebrate · concerned
 *
 * In INTERCEPT these map onto the live swarm (useMascotReactions):
 *   thinking  — at least one run is running (the swarm is working).
 *   celebrate — a win: a run completed, an email got a reply, a hot lead /
 *               high-intent thread appeared, a post scored high, an ad generated.
 *   concerned — a run failed (soft worry, never alarmed).
 *   peek/nod  — small ambient beats on minor signals (found / sent).
 *   idle      — at rest, eyes tracking the cursor via `gaze`.
 */
export type MascotState =
  | "idle"
  | "wave"
  | "thinking"
  | "talking"
  | "happy"
  | "peek"
  | "nod"
  | "celebrate"
  | "concerned";

/** Small clamped eye/lean offset (px, in the 100×100 viewBox) so the mascot can
 *  look toward the cursor. Supplied by useMascotGaze; absent → static look-around. */
export interface MascotGaze {
  x: number;
  y: number;
}

interface MascotProps {
  /** Animation state — the mascot's "mood". */
  state?: MascotState;
  /** Rendered square size in pixels. */
  size?: number;
  /** Optional extra class names on the root. */
  className?: string;
  /**
   * Optional live gaze offset (cursor tracking). When provided AND non-zero,
   * the pupils/face translate toward it and the body leans slightly — this
   * overrides the idle look-around keyframe so the two never fight. Falls back
   * to the keyframe when null/zero (e.g. no cursor, reduced motion).
   */
  gaze?: MascotGaze | null;
  /**
   * Optional 0–1 "smarter" signal (the compounding brain's size). Brightens the
   * antenna tip + adds a soft magenta halo so Acey visibly glows as it learns.
   * 0/undefined → no extra glow (the default reactive look). Decorative only.
   */
  glow?: number;
}

// Brand tokens kept local so the sprite is self-contained / portable.
// (Acme hex → INTERCEPT hex mapping documented in WIRING.md.)
const NAVY = "#1f1d3d"; // body fill — INTERCEPT block-navy / ink-navy
const NAVY_DEEP = "#15142a"; // pupils / deepest shade (also the night canvas)
const INDIGO = "#3a3566"; // belly highlight · antenna stalk · waving hand
const INDIGO_LINE = "#4a4576"; // thin inner body outline (definition on a card)
const MAGENTA = "#ff3d8b"; // accent — rim · cheeks · antenna tip · dots · spark
const WHITE = "#ffffff"; // face · eyes · mouth · gloss · sparkle · brows · hand

export function Mascot({ state = "idle", size = 40, className, gaze = null, glow = 0 }: MascotProps) {
  // Clamp the "smarter" glow once; drives the antenna halo opacity + tip radius.
  const g = Math.max(0, Math.min(1, glow));
  // A live gaze (cursor nearby) takes over from the idle look-around keyframe.
  // Tiny threshold avoids flicker between keyframe and live tracking at rest.
  const tracking = !!gaze && (Math.abs(gaze.x) > 0.05 || Math.abs(gaze.y) > 0.05);
  const gx = gaze ? gaze.x : 0;
  const gy = gaze ? gaze.y : 0;
  // Body leans a fraction of the gaze (follow-through); face/pupils track fuller.
  const leanX = gx * 0.45;

  // Randomized blink + idle-glance phase, chosen ONCE per mount so two mascot
  // instances never blink in lockstep and the idle loop never visibly repeats on
  // the same cadence. Random `animation-delay` is the cheap, compositor-only way
  // to vary cadence without JS per-frame work. useMemo (not useState) → no
  // re-render; SSR-stable enough (decorative only).
  const phase = useMemo(
    () => ({
      blink: -(Math.random() * 6).toFixed(2),
      glance: -(Math.random() * 8).toFixed(2),
      attract: -(Math.random() * 9).toFixed(2),
    }),
    [],
  );

  return (
    <span
      data-mascot-state={state}
      data-mascot-tracking={tracking ? "1" : undefined}
      className={["mascot-sprite", className].filter(Boolean).join(" ")}
      style={{
        width: size,
        height: size,
        // Consumed by the idle blink/glance/attract keyframes for varied cadence.
        ["--mascot-blink-delay" as string]: `${phase.blink}s`,
        ["--mascot-glance-delay" as string]: `${phase.glance}s`,
        ["--mascot-attract-delay" as string]: `${phase.attract}s`,
      }}
      role="img"
      aria-hidden="true"
    >
      <StyleTag />
      <svg
        className="mascot-svg"
        viewBox="0 0 100 100"
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* soft drop shadow under the pet (squashes on the happy hop) */}
        <ellipse className="mascot-shadow" cx="50" cy="91" rx="22" ry="5" fill="rgba(15,20,40,0.18)" />

        {/* the whole body bobs/breathes as a unit; a tiny live lean toward the
            cursor rides on top of the keyframe via a wrapper translate */}
        <g
          className="mascot-lean"
          style={tracking ? { transform: `translateX(${leanX}px)` } : undefined}
        >
          <g className="mascot-body">
            {/* magenta rim — the dual-theme legibility device: it frames the navy
                body crisply on the white canvas and GLOWS so the silhouette stays
                legible on the deep-navy night canvas. Also the brand's signature
                navy×magenta pairing as a clean "sticker" edge. */}
            <path
              className="mascot-rim"
              d="M50 13
                 C73 13 85 30 85 52
                 C85 75 70 87 50 87
                 C30 87 15 75 15 52
                 C15 30 27 13 50 13 Z"
              fill="none"
              stroke={MAGENTA}
              strokeWidth="5"
              strokeLinejoin="round"
            />

            {/* rounded blob body */}
            <path
              d="M50 14
                 C72 14 84 30 84 52
                 C84 74 70 86 50 86
                 C30 86 16 74 16 52
                 C16 30 28 14 50 14 Z"
              fill={NAVY}
              stroke={INDIGO_LINE}
              strokeWidth="2"
              strokeLinejoin="round"
            />
            {/* indigo belly highlight for depth */}
            <ellipse cx="50" cy="61" rx="26" ry="22" fill={INDIGO} opacity="0.55" />
            {/* glossy top highlight — gives a lively, rounded sheen */}
            <ellipse className="mascot-gloss" cx="42" cy="30" rx="16" ry="9" fill={WHITE} opacity="0.16" />

            {/* little antenna with a glowing magenta tip (pulses while thinking).
                A soft halo behind the tip brightens with the brain's size (`glow`)
                so Acey visibly "gets smarter" — decorative, opacity-only. */}
            <line x1="50" y1="14" x2="50" y2="5" stroke={INDIGO} strokeWidth="3" strokeLinecap="round" />
            {g > 0.02 && (
              <circle
                className="mascot-antenna-halo"
                cx="50"
                cy="4"
                r={6 + g * 4}
                fill={MAGENTA}
                opacity={0.12 + g * 0.33}
              />
            )}
            <circle className="mascot-antenna" cx="50" cy="4" r={3.6 + g * 0.9} fill={MAGENTA} />

            {/* friendly cheeks (on-brand magenta) */}
            <circle cx="31" cy="59" r="4.5" fill={MAGENTA} opacity="0.5" />
            <circle cx="69" cy="59" r="4.5" fill={MAGENTA} opacity="0.5" />

            {/* face — looks around in idle, up while thinking, toward the cursor
                when a live gaze is supplied */}
            <g
              className="mascot-face"
              style={tracking ? { transform: `translate(${gx * 0.5}px, ${gy * 0.5}px)` } : undefined}
            >
              {/* eye whites */}
              <ellipse className="mascot-eye" cx="38" cy="46" rx="8" ry="9" fill={WHITE} />
              <ellipse className="mascot-eye" cx="62" cy="46" rx="8" ry="9" fill={WHITE} />
              {/* pupils — track the cursor a bit further than the face */}
              <g
                className="mascot-pupils"
                style={tracking ? { transform: `translate(${gx}px, ${gy}px)` } : undefined}
              >
                <circle className="mascot-pupil" cx="39" cy="47" r="3.6" fill={NAVY_DEEP} />
                <circle className="mascot-pupil" cx="63" cy="47" r="3.6" fill={NAVY_DEEP} />
                {/* eye sparkle */}
                <circle cx="40.7" cy="45" r="1.2" fill={WHITE} />
                <circle cx="64.7" cy="45" r="1.2" fill={WHITE} />
              </g>
            </g>

            {/* mouth — animates open/closed when talking, smiles when happy */}
            <path
              className="mascot-mouth"
              d="M42 64 Q50 70 58 64"
              fill="none"
              stroke={WHITE}
              strokeWidth="2.6"
              strokeLinecap="round"
            />

            {/* waving hand/arm — only visible & animated in the wave state */}
            <g className="mascot-arm" style={{ transformOrigin: "82px 60px" }}>
              <circle cx="86" cy="46" r="6" fill={WHITE} />
              <line x1="82" y1="58" x2="86" y2="48" stroke={INDIGO} strokeWidth="4" strokeLinecap="round" />
            </g>

            {/* thinking dots floating near the antenna */}
            <g className="mascot-think-dots">
              <circle cx="74" cy="22" r="2.2" fill={MAGENTA} />
              <circle cx="80" cy="16" r="2.8" fill={MAGENTA} />
              <circle cx="87" cy="9" r="3.4" fill={MAGENTA} />
            </g>

            {/* concerned brows — small angled strokes above the eyes; only shown in
                the `concerned` one-shot (soft worry, never alarmed). */}
            <g className="mascot-brows">
              <line x1="31" y1="36" x2="44" y2="39" stroke={WHITE} strokeWidth="2.4" strokeLinecap="round" />
              <line x1="69" y1="36" x2="56" y2="39" stroke={WHITE} strokeWidth="2.4" strokeLinecap="round" />
            </g>

            {/* celebrate sparkles — tiny stars that pop on a win beat. */}
            <g className="mascot-sparkles">
              <path className="mascot-spark" d="M22 24 l1.6 3.4 3.4 1.6 -3.4 1.6 -1.6 3.4 -1.6 -3.4 -3.4 -1.6 3.4 -1.6 Z" fill={WHITE} />
              <path className="mascot-spark" d="M82 30 l1.3 2.8 2.8 1.3 -2.8 1.3 -1.3 2.8 -1.3 -2.8 -2.8 -1.3 2.8 -1.3 Z" fill={WHITE} />
              <path className="mascot-spark" d="M70 14 l1 2.2 2.2 1 -2.2 1 -1 2.2 -1 -2.2 -2.2 -1 2.2 -1 Z" fill={MAGENTA} />
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}

/**
 * Scoped keyframes + per-state rules. Injected inline so the sprite ships as one
 * self-contained file (no Tailwind / global CSS dependency). Selectors are
 * namespaced under `.mascot-sprite[data-mascot-state="…"]`.
 */
function StyleTag() {
  return (
    <style>{`
.mascot-sprite { display: inline-block; line-height: 0; }
.mascot-svg { overflow: visible; display: block; }

/* smarter-glow halo behind the antenna tip — soft blur so it reads as a glow,
   not a flat disc. Pulses with the antenna while idle/thinking. */
.mascot-antenna-halo { filter: blur(1.6px); transform-box: fill-box; transform-origin: center; }
.mascot-sprite[data-mascot-state="idle"] .mascot-antenna-halo { animation: mascot-antenna-pulse 4s ease-in-out infinite; }
.mascot-sprite[data-mascot-state="thinking"] .mascot-antenna-halo { animation: mascot-antenna-pulse 1.1s ease-in-out infinite; }

/* hidden-by-default sub-parts */
.mascot-arm { opacity: 0; }
.mascot-think-dots { opacity: 0; }
.mascot-brows { opacity: 0; }
.mascot-sparkles { opacity: 0; }

/* live cursor-gaze: ease the inline transforms so eyes glide, and stop the
   idle look-around/look-up keyframes from fighting the live tracking. */
.mascot-lean, .mascot-face, .mascot-pupils { transition: transform 160ms ease-out; }
.mascot-sprite[data-mascot-tracking="1"] .mascot-pupils { animation: none !important; }
.mascot-sprite[data-mascot-tracking="1"][data-mascot-state="idle"] .mascot-face,
.mascot-sprite[data-mascot-tracking="1"][data-mascot-state="thinking"] .mascot-face { animation: none !important; }

/* ---------- keyframes ---------- */
@keyframes mascot-breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50%      { transform: translateY(-2px) scale(1.02); }
}
@keyframes mascot-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  95%, 97%      { transform: scaleY(0.08); }
}
/* idle eyes glance around periodically to attract attention */
@keyframes mascot-look-around {
  0%, 58%, 100% { transform: translateX(0); }
  64%, 72%      { transform: translateX(2.4px); }
  80%, 88%      { transform: translateX(-2.4px); }
}
/* idle "attract" — a gentle periodic tilt+lean so the pet feels alive and
   occasionally nods to draw the eye, without ever leaving idle. */
@keyframes mascot-attract {
  0%, 78%, 100% { transform: translateY(0) rotate(0deg); }
  84%           { transform: translateY(-3px) rotate(-5deg); }
  90%           { transform: translateY(0) rotate(4deg); }
  95%           { transform: translateY(-1px) rotate(-2deg); }
}
@keyframes mascot-look-up {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2.5px); }
}
@keyframes mascot-antenna-pulse {
  0%, 100% { transform: scale(1); opacity: 0.9; }
  50%      { transform: scale(1.5); opacity: 1; }
}
@keyframes mascot-think-float {
  0%   { opacity: 0; transform: translateY(4px) scale(0.6); }
  40%  { opacity: 1; }
  100% { opacity: 0; transform: translateY(-6px) scale(1); }
}
@keyframes mascot-talk {
  0%, 100% { transform: translateY(0) scaleY(1); }
  50%      { transform: translateY(0.5px) scaleY(1.08); }
}
@keyframes mascot-mouth-talk {
  0%, 100% { d: path("M42 64 Q50 70 58 64"); }
  50%      { d: path("M42 64 Q50 76 58 64"); }
}
@keyframes mascot-hop {
  0%, 100% { transform: translateY(0); }
  30%      { transform: translateY(-9px); }
  55%      { transform: translateY(0); }
  70%      { transform: translateY(-3px); }
}
@keyframes mascot-hop-shadow {
  0%, 100% { transform: scaleX(1); opacity: 0.18; }
  30%      { transform: scaleX(0.7); opacity: 0.1; }
}
/* wave: anticipation (small dip back) before the raise, then follow-through. */
@keyframes mascot-wave-hand {
  0%, 100% { transform: rotate(0deg); }
  10%      { transform: rotate(8deg); }   /* anticipation: wind up */
  35%      { transform: rotate(-24deg); }
  60%      { transform: rotate(20deg); }
  80%      { transform: rotate(-10deg); } /* follow-through overshoot */
}
@keyframes mascot-wave-body {
  0%, 100% { transform: rotate(0deg); }
  50%      { transform: rotate(-4deg); }
}
/* peek: a quick glance + small lean (minor signal). transform-only. */
@keyframes mascot-peek {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  35%      { transform: translate(-3px, -2px) rotate(-6deg); }
  70%      { transform: translate(-2px, 0) rotate(-3deg); }
}
/* nod: quick affirmative dip (step complete / sent). */
@keyframes mascot-nod {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  30%      { transform: translateY(2px) rotate(3deg); }
  60%      { transform: translateY(-1px) rotate(-1deg); }
}
/* celebrate: a bigger hop with a small secondary bounce on land. */
@keyframes mascot-celebrate {
  0%      { transform: translateY(0) scale(1); }
  25%     { transform: translateY(-12px) scale(1.04); }
  45%     { transform: translateY(0) scaleY(0.92); }   /* squash on land */
  60%     { transform: translateY(-5px) scale(1.01); }
  80%     { transform: translateY(0) scaleY(0.98); }
  100%    { transform: translateY(0) scale(1); }
}
@keyframes mascot-spark-pop {
  0%   { opacity: 0; transform: scale(0.2) rotate(0deg); }
  40%  { opacity: 1; transform: scale(1.1) rotate(25deg); }
  100% { opacity: 0; transform: scale(0.6) rotate(60deg); }
}
/* concerned: a soft, slow side-tilt — worried, not alarmed. */
@keyframes mascot-concerned {
  0%, 100% { transform: rotate(0deg); }
  30%      { transform: rotate(-4deg); }
  70%      { transform: rotate(3deg); }
}

/* ---------- idle (richer: breathe + blink + periodic look-around + attract) ----------
   Random per-mount animation-delay (CSS custom props set on the root) de-syncs the
   blink/glance/attract loops so the idle never visibly metronomes or repeats. The
   delays default to 0 when the props are absent (e.g. SSR), so this degrades safely. */
.mascot-sprite[data-mascot-state="idle"] .mascot-body  { animation: mascot-breathe 3.4s ease-in-out infinite, mascot-attract 9s ease-in-out infinite; animation-delay: 0s, var(--mascot-attract-delay, 0s); transform-origin: 50px 80px; }
.mascot-sprite[data-mascot-state="idle"] .mascot-eye   { animation: mascot-blink 5.5s ease-in-out infinite; animation-delay: var(--mascot-blink-delay, 0s); transform-origin: center; transform-box: fill-box; }
.mascot-sprite[data-mascot-state="idle"] .mascot-pupils { animation: mascot-look-around 8s ease-in-out infinite; animation-delay: var(--mascot-glance-delay, 0s); }
.mascot-sprite[data-mascot-state="idle"] .mascot-antenna { animation: mascot-antenna-pulse 4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }

/* ---------- thinking ---------- */
.mascot-sprite[data-mascot-state="thinking"] .mascot-body { animation: mascot-breathe 2.4s ease-in-out infinite; transform-origin: 50px 80px; }
.mascot-sprite[data-mascot-state="thinking"] .mascot-face { animation: mascot-look-up 2.4s ease-in-out infinite; }
.mascot-sprite[data-mascot-state="thinking"] .mascot-antenna { animation: mascot-antenna-pulse 1.1s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
.mascot-sprite[data-mascot-state="thinking"] .mascot-think-dots { opacity: 1; }
.mascot-sprite[data-mascot-state="thinking"] .mascot-think-dots circle { animation: mascot-think-float 1.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.mascot-sprite[data-mascot-state="thinking"] .mascot-think-dots circle:nth-child(2) { animation-delay: 0.25s; }
.mascot-sprite[data-mascot-state="thinking"] .mascot-think-dots circle:nth-child(3) { animation-delay: 0.5s; }

/* ---------- talking ---------- */
.mascot-sprite[data-mascot-state="talking"] .mascot-body  { animation: mascot-talk 0.45s ease-in-out infinite; transform-origin: 50px 80px; }
.mascot-sprite[data-mascot-state="talking"] .mascot-mouth { animation: mascot-mouth-talk 0.4s ease-in-out infinite; }

/* ---------- happy ---------- */
.mascot-sprite[data-mascot-state="happy"] .mascot-body   { animation: mascot-hop 0.9s ease-in-out infinite; transform-origin: 50px 80px; }
.mascot-sprite[data-mascot-state="happy"] .mascot-shadow { animation: mascot-hop-shadow 0.9s ease-in-out infinite; transform-origin: 50px 90px; }
.mascot-sprite[data-mascot-state="happy"] .mascot-mouth  { d: path("M40 63 Q50 74 60 63"); }

/* ---------- wave ---------- */
.mascot-sprite[data-mascot-state="wave"] .mascot-body { animation: mascot-wave-body 1s ease-in-out infinite; transform-origin: 50px 80px; }
.mascot-sprite[data-mascot-state="wave"] .mascot-arm  { opacity: 1; animation: mascot-wave-hand 0.6s ease-in-out infinite; }

/* ---------- peek (one-shot) ---------- */
.mascot-sprite[data-mascot-state="peek"] .mascot-body { animation: mascot-peek 0.5s ease-in-out; transform-origin: 50px 80px; }

/* ---------- nod (one-shot) ---------- */
.mascot-sprite[data-mascot-state="nod"] .mascot-body  { animation: mascot-nod 0.45s ease-in-out; transform-origin: 50px 80px; }
.mascot-sprite[data-mascot-state="nod"] .mascot-mouth { d: path("M40 63 Q50 72 60 63"); }

/* ---------- celebrate (one-shot success beat) ---------- */
.mascot-sprite[data-mascot-state="celebrate"] .mascot-body     { animation: mascot-celebrate 0.9s ease-in-out; transform-origin: 50px 88px; }
.mascot-sprite[data-mascot-state="celebrate"] .mascot-shadow   { animation: mascot-hop-shadow 0.9s ease-in-out; transform-origin: 50px 90px; }
.mascot-sprite[data-mascot-state="celebrate"] .mascot-mouth    { d: path("M40 63 Q50 75 60 63"); }
.mascot-sprite[data-mascot-state="celebrate"] .mascot-sparkles { opacity: 1; }
.mascot-sprite[data-mascot-state="celebrate"] .mascot-spark    { animation: mascot-spark-pop 0.9s ease-out; transform-box: fill-box; transform-origin: center; }
.mascot-sprite[data-mascot-state="celebrate"] .mascot-spark:nth-child(2) { animation-delay: 0.15s; }
.mascot-sprite[data-mascot-state="celebrate"] .mascot-spark:nth-child(3) { animation-delay: 0.3s; }

/* ---------- concerned (one-shot, soft worry) ---------- */
.mascot-sprite[data-mascot-state="concerned"] .mascot-body  { animation: mascot-concerned 1s ease-in-out; transform-origin: 50px 80px; }
.mascot-sprite[data-mascot-state="concerned"] .mascot-brows { opacity: 1; }
.mascot-sprite[data-mascot-state="concerned"] .mascot-mouth { d: path("M42 67 Q50 62 58 67"); }

/* ---------- reduced motion: freeze on a calm idle pose ---------- */
@media (prefers-reduced-motion: reduce) {
  .mascot-sprite * { animation: none !important; }
  .mascot-lean, .mascot-face, .mascot-pupils { transition: none !important; }
  .mascot-sprite .mascot-arm,
  .mascot-sprite .mascot-think-dots,
  .mascot-sprite .mascot-brows,
  .mascot-sprite .mascot-sparkles { opacity: 0 !important; }
}
    `}</style>
  );
}

// ---------------------------------------------------------------------------
// useMascotGaze — a tiny, self-contained cursor-gaze hook (NO framer-motion).
// Ports the *eyes-track-the-cursor* essence of Acme's useAceyMotion without the
// heavy spring locomotion. The whole mascot stays parked in its corner; only the
// pupils/face glance toward the pointer. Returns a clamped { x, y } offset (in
// the 100×100 viewBox units the sprite expects), or null at rest / under
// reduced motion. Pass the result straight into <Mascot gaze={...} />.
// ---------------------------------------------------------------------------

/** Max pupil/face gaze offset (viewBox px) — small + clamped so it never looks
 *  cross-eyed. Mirrors useAceyMotion.GAZE_MAX. */
const GAZE_MAX = 3.2;
/** Beyond this distance (px) the cursor is "far"; gaze reaches its cap. */
const GAZE_REACH_PX = 240;
/** Quantize updates to this step (viewBox px) so we don't re-render per pixel. */
const GAZE_STEP = 0.4;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useMascotGaze<T extends HTMLElement>(
  ref: RefObject<T | null>,
): MascotGaze | null {
  const [gaze, setGaze] = useState<MascotGaze | null>(null);
  const last = useRef<{ x: number; y: number }>({ x: 999, y: 999 });
  const queued = useRef(false);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    const compute = (clientX: number, clientY: number) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const reach = Math.min(dist / GAZE_REACH_PX, 1); // farther = look further, capped
      const gx = clamp((dx / dist) * GAZE_MAX * reach, -GAZE_MAX, GAZE_MAX);
      const gy = clamp((dy / dist) * GAZE_MAX * reach, -GAZE_MAX, GAZE_MAX);
      // Quantize so the eyes don't trigger a React render every pixel.
      const rx = Math.round(gx / GAZE_STEP) * GAZE_STEP;
      const ry = Math.round(gy / GAZE_STEP) * GAZE_STEP;
      if (rx === last.current.x && ry === last.current.y) return;
      last.current = { x: rx, y: ry };
      setGaze(rx === 0 && ry === 0 ? null : { x: rx, y: ry });
    };

    let lastEvent: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      lastEvent = { x: e.clientX, y: e.clientY };
      if (queued.current) return;
      queued.current = true;
      requestAnimationFrame(() => {
        queued.current = false;
        if (lastEvent) compute(lastEvent.x, lastEvent.y);
      });
    };
    const onLeave = () => setGaze(null);

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerout", onLeave, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onLeave);
    };
  }, [ref]);

  return gaze;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export default Mascot;
