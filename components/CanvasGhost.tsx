"use client";

import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

// ============================================================================
// CanvasGhost — the canvas-level empty state, reimagined as a COMMAND CENTER:
// a scannable, clickable map of everything INTERCEPT does. Each track card
// pre-fills the composer with a ready-to-run prompt (one click → the swarm
// builds it), so a first-time user (or a judge) immediately sees the full GTM
// stack and can fire any capability. The Brain card opens the knowledge graph.
// Editorial/flat (content you read) — no glass here. Motion gated on reduced.
// ============================================================================

// Pre-fill the composer with a starter prompt via the window event ChatPanel
// listens for. Never throws; no prop drilling. (submit:false → user can tweak
// the target company before hitting enter.)
function compose(text: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("intercept:compose", { detail: { text, submit: false } }),
    );
  } catch {
    /* never break the canvas */
  }
}

interface Track {
  key: string;
  label: string;
  what: string;
  example: string;
  /** Pastel accent (full Tailwind class) for the card's left bar + dot. */
  accent: string;
  sponsors: string;
  icon: (props: { className?: string }) => ReactElement;
}

// The navigable capability map — the 6 hackathon tracks + the GitHub scout.
// `example` is what gets dropped into the composer on click.
const TRACKS: readonly Track[] = [
  {
    key: "discovery",
    label: "Reading Minds",
    what: "Find where your buyers are already complaining — free, across HN + Reddit.",
    example: "Find where buyers are complaining about resume tools — for nolongerjobless.com",
    accent: "bg-block-mint",
    sponsors: "Free · compounding brain",
    icon: DiscoveryIcon,
  },
  {
    key: "outbound",
    label: "Revenue on Autopilot",
    what: "Source decision-makers + verified emails, then draft + send 24/7 outreach.",
    example: "Find decision-makers and verified emails for nolongerjobless.com's ICP",
    accent: "bg-block-lilac",
    sponsors: "Orange Slice · Fiber · AgentMail",
    icon: PipelineIcon,
  },
  {
    key: "competitor",
    label: "Ad Intelligence",
    what: "Discover competitors and scan their live winning ads — Google, Meta, TikTok.",
    example: "Find competitors and scan their winning ads for nolongerjobless.com",
    accent: "bg-block-pink",
    sponsors: "Google ATC · token-free",
    icon: RadarIcon,
  },
  {
    key: "content",
    label: "Ad Factory",
    what: "Generate a scroll-stopping ad — image, copy, variations, and a free video.",
    example: "Make me a scroll-stopping ad for nolongerjobless.com",
    accent: "bg-block-cream",
    sponsors: "OpenAI gpt-image-1 · Pexels",
    icon: SparkIcon,
  },
  {
    key: "social",
    label: "Algorithm Hacking",
    what: "Engineer a viral content calendar, each post scored for reach.",
    example: "Plan a viral content calendar for nolongerjobless.com",
    accent: "bg-block-coral",
    sponsors: "OpenAI · Supadata",
    icon: PulseIcon,
  },
  {
    key: "onboarding",
    label: "Zero to One",
    what: "Design a PLG onboarding flow that actually activates new users.",
    example: "Design a PLG onboarding flow for nolongerjobless.com",
    accent: "bg-block-lime",
    sponsors: "OpenAI",
    icon: SeedIcon,
  },
  {
    key: "scout",
    label: "GitHub Scout",
    what: "Point at an event, org, or topic — dissect what everyone's building.",
    example: "Scout the projects built at the YC AI Growth Hackathon by Orange Slice",
    accent: "bg-block-mint",
    sponsors: "GitHub · OpenAI",
    icon: ScoutIcon,
  },
];

interface CanvasGhostProps {
  hasConversation: boolean;
  reducedMotion: boolean;
  /** Open the compounding-knowledge Brain board on the canvas. */
  onOpenBrain?: () => void;
}

export default function CanvasGhost({
  hasConversation,
  reducedMotion,
  onOpenBrain,
}: CanvasGhostProps) {
  return (
    <div className="col-scroll h-full min-h-0 overflow-y-auto px-6 py-7">
      <div className={cn("mx-auto w-full max-w-3xl", !reducedMotion && "animate-fade-up")}>
        <p className="eyebrow text-ink/60">The whole GTM stack · one chat</p>
        <h2 className="mt-2 text-headline text-ink">
          {hasConversation ? "Pick your next play" : "What INTERCEPT does"}
        </h2>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink/70">
          Click any play to load it into the chat — or just type. The swarm
          assembles the work right here, live.
        </p>

        {/* the capability map — each card pre-fills the composer */}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {TRACKS.map((t, i) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => compose(t.example)}
                style={!reducedMotion ? { animationDelay: `${i * 45}ms` } : undefined}
                className={cn(
                  "group relative overflow-hidden rounded-lg border border-hairline bg-surface-soft/50 p-4 text-left transition-all",
                  "hover:-translate-y-px hover:border-ink/20 hover:bg-surface-soft hover:shadow-soft",
                  !reducedMotion && "animate-fade-up",
                )}
              >
                {/* left accent bar */}
                <span
                  aria-hidden
                  className={cn("absolute inset-y-0 left-0 w-1", t.accent)}
                />
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-white/50",
                      t.accent,
                    )}
                  >
                    <Icon className="h-4 w-4 text-ink/80" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-fig-card leading-snug text-ink">
                      {t.label}
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink/65">
                      {t.what}
                    </p>
                    <p className="mt-2.5 truncate font-mono text-[10.5px] uppercase tracking-wide text-ink/40">
                      {t.sponsors}
                    </p>
                  </div>
                  {/* hover "load it" affordance */}
                  <span className="mt-0.5 shrink-0 text-ink/0 transition-colors group-hover:text-ink/40">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </div>
              </button>
            );
          })}

          {/* the Brain — opens the knowledge graph instead of pre-filling chat */}
          <button
            type="button"
            onClick={onOpenBrain}
            className={cn(
              "group relative overflow-hidden rounded-lg border border-hairline bg-block-navy/95 p-4 text-left text-canvas transition-all sm:col-span-2",
              "hover:-translate-y-px hover:shadow-soft",
              !reducedMotion && "animate-fade-up",
            )}
            style={!reducedMotion ? { animationDelay: `${TRACKS.length * 45}ms` } : undefined}
          >
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas/15">
                <BrainIcon className="h-4 w-4 text-canvas" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-fig-card leading-snug">The Brain</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-canvas/70">
                  The knowledge graph every run feeds — open the live map.
                </p>
              </div>
              <span className="shrink-0 text-canvas/50 transition-transform group-hover:translate-x-0.5">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
            </div>
          </button>
        </div>

        <p className="mt-5 text-[11px] text-ink/45">
          or press{" "}
          <kbd className="rounded border border-hairline bg-surface-soft px-1.5 py-0.5 font-mono text-[10px] text-ink/70">
            ⌘K
          </kbd>{" "}
          for everything
        </p>
      </div>
    </div>
  );
}

// ── glyphs (stroke icons, currentColor) ─────────────────────────────────────

function DiscoveryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function PipelineIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7">
      <rect x="4" y="5" width="4" height="11" rx="1.1" />
      <rect x="10" y="5" width="4" height="8" rx="1.1" />
      <rect x="16" y="5" width="4" height="13" rx="1.1" />
    </svg>
  );
}

function RadarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 12 5.5 5.5" />
      <path d="M12 4a8 8 0 1 0 8 8" />
      <path d="M12 8a4 4 0 1 0 4 4" />
    </svg>
  );
}

function SparkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  );
}

function PulseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2.5-6 4 14 2.5-8H21" />
    </svg>
  );
}

function SeedIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21V11" />
      <path d="M12 11c0-3.5 2.5-6 6-6 0 3.5-2.5 6-6 6Z" />
      <path d="M12 13C12 9.5 9.5 7 6 7c0 3.5 2.5 6 6 6Z" />
    </svg>
  );
}

function ScoutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a4.5 4.5 0 0 0-1.5 8.74V14l-2 6 3.5-2.5L15.5 20l-2-6v-2.26A4.5 4.5 0 0 0 12 3Z" />
      <circle cx="12" cy="7.5" r="1" />
    </svg>
  );
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1 4.8A2.5 2.5 0 0 0 7 16.5a2.5 2.5 0 0 0 5 .5V6.5A2.5 2.5 0 0 0 9 4.5ZM15 4.5A2.5 2.5 0 0 1 17.5 7a2.5 2.5 0 0 1 1 4.8A2.5 2.5 0 0 1 17 16.5a2.5 2.5 0 0 1-5 .5" />
    </svg>
  );
}
