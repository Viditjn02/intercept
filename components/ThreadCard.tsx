"use client";

import type { Doc } from "@/convex/_generated/dataModel";
import type { IntentLabel } from "@/lib/contract";

// ============================================================================
// ThreadCard — THE MOAT.
// A real, clickable, intent-scored link to a LIVE conversation where a buyer is
// asking the exact question the company answers. This is the most important
// component in the product: it must feel verifiable, alive, and high-signal.
// ============================================================================

interface IntentStyle {
  label: string;
  /** Tailwind classes for the score ring + badge accent. */
  ring: string; // hex used in the conic-gradient
  track: string; // hex for the unfilled track
  text: string;
  chip: string;
  glow: string;
  pulse: boolean;
}

const INTENT_STYLES: Record<IntentLabel, IntentStyle> = {
  ready_to_buy: {
    label: "Ready to buy",
    ring: "#34d399",
    track: "rgba(52,211,153,0.15)",
    text: "text-good",
    chip: "bg-good/15 text-good ring-1 ring-good/30",
    glow: "shadow-[0_0_40px_-12px_rgba(52,211,153,0.45)]",
    pulse: true,
  },
  frustrated: {
    label: "Frustrated",
    ring: "#ff6a2b",
    track: "rgba(255,106,43,0.15)",
    text: "text-accent",
    chip: "bg-accent/15 text-accent ring-1 ring-accent/30",
    glow: "shadow-[0_0_40px_-12px_rgba(255,106,43,0.45)]",
    pulse: true,
  },
  comparing: {
    label: "Comparing",
    ring: "#fbbf24",
    track: "rgba(251,191,36,0.15)",
    text: "text-amber-400",
    chip: "bg-amber-400/15 text-amber-400 ring-1 ring-amber-400/30",
    glow: "shadow-[0_0_36px_-14px_rgba(251,191,36,0.4)]",
    pulse: false,
  },
  browsing: {
    label: "Browsing",
    ring: "#60a5fa",
    track: "rgba(96,165,250,0.15)",
    text: "text-sky-400",
    chip: "bg-sky-400/15 text-sky-400 ring-1 ring-sky-400/30",
    glow: "",
    pulse: false,
  },
};

const FALLBACK_INTENT: IntentStyle = {
  label: "Signal",
  ring: "#8b8b94",
  track: "rgba(139,139,148,0.15)",
  text: "text-zinc-300",
  chip: "bg-zinc-500/15 text-zinc-300 ring-1 ring-zinc-500/30",
  glow: "",
  pulse: false,
};

const PLATFORM_META: Record<string, { label: string; symbol: string; accent: string }> = {
  reddit: { label: "Reddit", symbol: "r/", accent: "text-orange-400" },
  hackernews: { label: "Hacker News", symbol: "Y", accent: "text-orange-300" },
  forum: { label: "Forum", symbol: "#", accent: "text-violet-300" },
  discord: { label: "Discord", symbol: "@", accent: "text-indigo-300" },
  twitter: { label: "X", symbol: "x", accent: "text-sky-300" },
};

function intentStyle(label: string): IntentStyle {
  return INTENT_STYLES[label as IntentLabel] ?? FALLBACK_INTENT;
}

function platformMeta(platform: string) {
  return (
    PLATFORM_META[platform.toLowerCase()] ?? {
      label: platform,
      symbol: "#",
      accent: "text-zinc-300",
    }
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

interface ScoreRingProps {
  score: number;
  style: IntentStyle;
}

function ScoreRing({ score, style }: ScoreRingProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const deg = (clamped / 100) * 360;
  return (
    <div
      className="relative grid h-16 w-16 shrink-0 place-items-center rounded-full"
      style={{
        background: `conic-gradient(${style.ring} ${deg}deg, ${style.track} ${deg}deg)`,
      }}
      aria-label={`Intent score ${clamped} of 100`}
    >
      <div className="grid h-[52px] w-[52px] place-items-center rounded-full bg-panel">
        <span className={`text-xl font-bold tabular-nums leading-none ${style.text}`}>
          {clamped}
        </span>
      </div>
      {style.pulse && (
        <span
          className="pointer-events-none absolute inset-0 animate-ping rounded-full opacity-30"
          style={{ boxShadow: `0 0 0 2px ${style.ring}` }}
        />
      )}
    </div>
  );
}

interface ThreadCardProps {
  thread: Doc<"threads">;
  draft?: Doc<"drafts"> | null;
  onReviewDraft?: (draft: Doc<"drafts">) => void;
}

const DRAFT_BADGE: Record<string, { label: string; cls: string }> = {
  awaiting_approval: { label: "Reply ready · review", cls: "bg-accent/15 text-accent ring-1 ring-accent/30" },
  approved: { label: "Approved", cls: "bg-good/15 text-good ring-1 ring-good/30" },
  rejected: { label: "Rejected", cls: "bg-zinc-500/15 text-zinc-400 ring-1 ring-zinc-500/30" },
  posted: { label: "Posted", cls: "bg-good/20 text-good ring-1 ring-good/40" },
};

export default function ThreadCard({ thread, draft, onReviewDraft }: ThreadCardProps) {
  const style = intentStyle(thread.intentLabel);
  const platform = platformMeta(thread.platform);
  const draftBadge = draft ? DRAFT_BADGE[draft.status] : undefined;

  return (
    <article
      className={`group relative flex flex-col gap-4 rounded-2xl border border-line bg-panel/80 p-5 backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-line/80 ${style.glow}`}
    >
      {/* Header: platform + intent chip */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <span
            className={`grid h-6 w-6 place-items-center rounded-md bg-ink font-bold ${platform.accent}`}
            aria-hidden
          >
            {platform.symbol}
          </span>
          <span className="text-zinc-300">{platform.label}</span>
          <span className="text-zinc-600">·</span>
          <span className="truncate text-zinc-500">{hostOf(thread.url)}</span>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${style.chip}`}
        >
          {style.label}
        </span>
      </div>

      {/* Body: score + title + snippet */}
      <div className="flex gap-4">
        <ScoreRing score={thread.intentScore} style={style} />
        <div className="min-w-0 flex-1">
          <a
            href={thread.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[15px] font-semibold leading-snug text-zinc-50 decoration-accent/60 underline-offset-4 transition-colors hover:text-white hover:underline"
          >
            {thread.title}
          </a>
          <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-zinc-400">
            “{thread.snippet}”
          </p>
          {thread.author && (
            <p className="mt-2 text-xs text-zinc-500">
              asked by <span className="text-zinc-300">{thread.author}</span>
            </p>
          )}
        </div>
      </div>

      {/* Footer: the clickable moat link + draft gate */}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-line/70 pt-3">
        <a
          href={thread.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-sm font-medium text-zinc-200 ring-1 ring-line transition-colors hover:bg-line/40 hover:text-white"
        >
          Open live thread
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M7 17 17 7" />
            <path d="M7 7h10v10" />
          </svg>
        </a>

        {draft && draftBadge && (
          <button
            type="button"
            onClick={() => onReviewDraft?.(draft)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-transform hover:scale-[1.02] ${draftBadge.cls}`}
          >
            {draft.status === "awaiting_approval" && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            )}
            {draftBadge.label}
          </button>
        )}
      </div>
    </article>
  );
}
