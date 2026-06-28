"use client";

import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

// ============================================================================
// IconRail — the thin, keyboard-free escape hatch on the far left. One icon per
// canvas mode (threads / pipeline / ads / calendar / brain / onboarding) so a
// user who knows where they're going can jump straight there without a chat
// round-trip. Active mode = a colored left-border accent (its pastel); every
// item teaches itself via an 800ms-delayed hover tooltip showing name +
// shortcut (Linear's teach-without-tutorial pattern).
//
// Tier-1 glass chrome — it's a frame you look *through*, never content you read.
// Purely additive + graceful: modes without a wired handler simply no-op.
// ============================================================================

export type IconRailMode =
  | "threads"
  | "pipeline"
  | "ads"
  | "calendar"
  | "brain"
  | "onboarding";

interface RailItem {
  mode: IconRailMode;
  label: string;
  shortcut: string;
  /** Pastel accent (full Tailwind class) for the active left-border + tint. */
  accent: string;
  icon: (props: { className?: string }) => ReactElement;
}

// Full class literals (no interpolation) so Tailwind's JIT always emits them.
const ITEMS: readonly RailItem[] = [
  { mode: "threads", label: "Threads", shortcut: "⌘1", accent: "bg-block-mint", icon: ThreadsIcon },
  { mode: "pipeline", label: "Pipeline", shortcut: "⌘2", accent: "bg-block-lime", icon: PipelineIcon },
  { mode: "ads", label: "Ad gallery", shortcut: "⌘3", accent: "bg-block-coral", icon: AdsIcon },
  { mode: "calendar", label: "Calendar", shortcut: "⌘4", accent: "bg-block-cream", icon: CalendarIcon },
  { mode: "brain", label: "The brain", shortcut: "⌘5", accent: "bg-block-lilac", icon: BrainGlyph },
  { mode: "onboarding", label: "Onboarding", shortcut: "⌘6", accent: "bg-block-pink", icon: OnboardingIcon },
];

interface IconRailProps {
  /** Which mode is currently reflected on the canvas. */
  activeMode: IconRailMode;
  /** Jump to a mode. Unwired modes pass through and the caller may no-op. */
  onSelect: (mode: IconRailMode) => void;
}

export default function IconRail({ activeMode, onSelect }: IconRailProps) {
  return (
    <nav
      aria-label="Canvas modes"
      className="glass-1 relative z-10 flex h-full w-14 shrink-0 flex-col items-center gap-1 overflow-visible py-3"
    >
      {ITEMS.map((item) => {
        const active = item.mode === activeMode;
        const Icon = item.icon;
        return (
          <button
            key={item.mode}
            type="button"
            onClick={() => onSelect(item.mode)}
            aria-label={`${item.label} (${item.shortcut})`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors duration-quick",
              active ? "text-ink" : "text-ink/55 hover:text-ink hover:bg-canvas/60",
            )}
          >
            {/* active = colored left-border accent (a vertical pastel bar) */}
            <span
              aria-hidden
              className={cn(
                "absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-opacity duration-quick",
                item.accent,
                active ? "opacity-100" : "opacity-0",
              )}
            />
            {/* active tint behind the glyph */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 rounded-xl transition-opacity duration-quick",
                item.accent,
                active ? "opacity-30" : "opacity-0",
              )}
            />
            <Icon className="relative h-[18px] w-[18px]" />

            {/* 800ms-delayed teach tooltip: name + shortcut, crisp ink chip */}
            <span
              role="tooltip"
              className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-fig-link text-canvas opacity-0 shadow-glass-2 transition-opacity delay-0 duration-quick group-hover:opacity-100 group-hover:delay-[800ms]"
            >
              {item.label}
              <kbd className="rounded bg-canvas/20 px-1 font-mono text-[10px] leading-tight text-canvas">
                {item.shortcut}
              </kbd>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// ── glyphs (simple stroke icons, currentColor) ──────────────────────────────

function ThreadsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M5 7.5A2.5 2.5 0 0 1 7.5 5h6A2.5 2.5 0 0 1 16 7.5v3A2.5 2.5 0 0 1 13.5 13H9l-3 2.5V13H7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 16.5a2 2 0 0 0 2 2h3l2.5 2v-2H18a2 2 0 0 0 2-2v-2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PipelineIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="4" y="4" width="4.5" height="12" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="10" y="4" width="4.5" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="16" y="4" width="4.5" height="14" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function AdsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4 9.5v5a1 1 0 0 0 1 1h2l2 3.5V6L7 9.5H5a1 1 0 0 0-1 0Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 6l8-2.5v17L9 18" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M19.5 9.5a3 3 0 0 1 0 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="4" y="5.5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 9.5h16M8 4v3M16 4v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function BrainGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M9 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1 4.8A2.5 2.5 0 0 0 7 16.5a2.5 2.5 0 0 0 5 .5V6.5A2.5 2.5 0 0 0 9 4.5ZM15 4.5A2.5 2.5 0 0 1 17.5 7a2.5 2.5 0 0 1 1 4.8A2.5 2.5 0 0 1 17 16.5a2.5 2.5 0 0 1-5 .5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OnboardingIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 3c3 1.5 5 4.5 5 8.5 0 1.8-.6 3.3-1.5 4.5h-7C7.6 14.8 7 13.3 7 11.5 7 7.5 9 4.5 12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.5 16.5 8 20m6.5-3.5L16 20M12 16.5V21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
