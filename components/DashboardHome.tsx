"use client";

// ============================================================================
// DashboardHome — the GTM Command Center landing surface (light Figma editorial).
//
// Renders the per-track COMPACT NODE STAT CARDS (one per capability) with REAL
// live counts + a real status chip + a tiny inline sparkline, plus a right-hand
// live-activity feed merged from the most-recent runs. Clicking a node fires
// `onOpenTrack` (or drills into its latest board via `onOpenRun` when one exists).
// `children` (the fire-a-play menu) renders in the SAME scroll under the grid.
//
// DATA: derived PURELY from the two queries that exist in the generated `api`
// (runs.listRuns + knowledge.brainStats). There is intentionally NO Tier-B
// `dashboard:overview` query — Convex `useQuery` THROWS synchronously on a missing
// function (it does NOT return undefined), which crashed the landing; the cards
// are a run roll-up grouped by intent (see deriveStats / deriveTrackStatus).
// ============================================================================

import { useMemo, type ReactElement, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import type { Capability } from "@/lib/contract";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import { eventsByRunRef } from "./chatApi";
import type { EventDoc } from "./types";
import NumberTicker from "./ui/NumberTicker";

// ---------------------------------------------------------------------------
// Track registry — the canonical 7 nodes (label/tagline/accent/headline noun).
// One pastel color-block per track (brand-constant across themes).
// ---------------------------------------------------------------------------
interface TrackMeta {
  key: Capability;
  label: string;
  tagline: string;
  accent: string; // full Tailwind pastel literal (JIT-safe)
  statNoun: string; // what the headline number counts
  zero: string; // zero-state nudge
  icon: (p: { className?: string }) => ReactElement;
}

const TRACKS: readonly TrackMeta[] = [
  {
    key: "discovery",
    label: "Reading Minds",
    tagline: "Live buyer threads — HN + Reddit, intent-scored.",
    accent: "bg-block-mint",
    statNoun: "threads found",
    zero: "No threads yet — start the radar",
    icon: IconRadar,
  },
  {
    key: "outbound",
    label: "Revenue on Autopilot",
    tagline: "Decision-makers + verified emails, drafted 24/7.",
    accent: "bg-block-lilac",
    statNoun: "qualified prospects",
    zero: "No prospects yet — find buyers",
    icon: IconPipeline,
  },
  {
    key: "competitor",
    label: "Ad Intelligence",
    tagline: "Discover rivals, scan their winning live ads.",
    accent: "bg-block-pink",
    statNoun: "competitor ads",
    zero: "No ads scanned — scout competitors",
    icon: IconScan,
  },
  {
    key: "content",
    label: "Ad Factory",
    tagline: "Scroll-stopping ad — image, copy, variations, video.",
    accent: "bg-block-cream",
    statNoun: "creatives made",
    zero: "No creative yet — make an ad",
    icon: IconSpark,
  },
  {
    key: "social",
    label: "Algorithm Hacking",
    tagline: "A viral content calendar, every post scored.",
    accent: "bg-block-coral",
    statNoun: "posts scored",
    zero: "No posts yet — engineer virality",
    icon: IconPulse,
  },
  {
    key: "onboarding",
    label: "Zero to One",
    tagline: "A PLG onboarding flow that activates new users.",
    accent: "bg-block-lime",
    statNoun: "tour steps",
    zero: "No flow yet — design onboarding",
    icon: IconSeed,
  },
  {
    key: "scout",
    label: "GitHub Scout",
    tagline: "Point at an event/org/topic — dissect what's shipping.",
    accent: "bg-block-mint",
    statNoun: "projects dissected",
    zero: "Nothing scouted — point at an event",
    icon: IconScout,
  },
] as const;

// ---------------------------------------------------------------------------
// Stat shapes — the per-card model derived from the run roll-up.
// ---------------------------------------------------------------------------
type TrackStatStatus = "idle" | "working" | "radar" | "done";

interface TrackStat {
  key: Capability;
  count: number; // headline number (0 when none)
  sub?: number; // optional secondary (e.g. emails)
  runCount: number; // all-time runs for this track
  status: TrackStatStatus;
  latestRunId?: Id<"runs">;
  spark: number[]; // bucketed series for the sparkline
}

const SPARK_BUCKETS = 12;
const SPARK_WINDOW_MS = 24 * 60 * 60 * 1000; // last 24h
const FEED_RUN_SLOTS = 6; // recent runs whose events we merge into the feed

// ---------------------------------------------------------------------------
export interface DashboardHomeProps {
  /** Fire the track like a quick-action (used for idle nodes / no latest run). */
  onOpenTrack: (intent: Capability) => void;
  /** Drill into the latest board for a track that has one. */
  onOpenRun?: (runId: Id<"runs">, intent: Capability) => void;
  /** Open the compounding brain. */
  onOpenBrain?: () => void;
  /** The default target business URL (display only here). */
  targetUrl?: string;
  /** Rendered in the SAME scroll column under the node grid (the fire-a-play menu)
   *  so the cards + plays read as one page instead of two cramped scroll boxes. */
  children?: ReactNode;
}

export default function DashboardHome({
  onOpenTrack,
  onOpenRun,
  onOpenBrain,
  children,
}: DashboardHomeProps) {
  // Both reads are deployed in the generated api. (There is NO convex/dashboard.ts
  // "overview" query — subscribing to a missing function THROWS synchronously and
  // crashed the landing, so the cards are derived purely from these two.)
  const runs = useQuery(api.runs.listRuns, {}) as Doc<"runs">[] | undefined;
  const brainStats = useQuery(api.knowledge.brainStats, {}) as
    | { pages: number; facts: number; runs: number; lastUpdatedAt: number }
    | undefined;

  // Derive the per-track stat cards from the run roll-up (grouped by intent).
  const stats = useMemo<TrackStat[]>(
    () => deriveStats(TRACKS, runs ?? []),
    [runs],
  );
  const statByKey = useMemo(
    () => new Map(stats.map((s) => [s.key, s])),
    [stats],
  );

  const brain = deriveBrain(brainStats);

  const handleOpen = (s: TrackStat | undefined, key: Capability) => {
    if (s?.latestRunId && onOpenRun) onOpenRun(s.latestRunId, key);
    else onOpenTrack(key);
  };

  const loading = runs === undefined;

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas text-ink">
      {/* ── main column: ONE scroll for the COMPACT node grid + the plays
          (children). Cards are sized to fit ABOVE THE FOLD — no one should have
          to scroll to read the key plays. pb clears the floating CommandBar so
          nothing ever hides behind it. ─────────────────────────────────────── */}
      <div className="col-scroll min-h-0 flex-1 overflow-y-auto px-7 pb-32 pt-5">
        <header className="mb-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink/45">
            GTM Command Center
          </p>
          <h1 className="mt-0.5 text-[21px] font-fig-headline leading-tight tracking-tight">
            Pick a play.
          </h1>
        </header>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {TRACKS.map((t) => (
            <NodeCard
              key={t.key}
              track={t}
              stat={statByKey.get(t.key)}
              loading={loading}
              onClick={() => handleOpen(statByKey.get(t.key), t.key)}
            />
          ))}
          <BrainCard brain={brain} loading={loading} onClick={onOpenBrain} />
        </div>

        {/* the fire-a-play menu shares this scroll, passed in by the dashboard
            surface, so cards + plays read as one page (never a split). */}
        {children ? <div className="mt-6">{children}</div> : null}
      </div>

      {/* ── right rail: COMPACT live-activity feed. Capped to a short fixed
          height (upper portion) so it reads as a glance-able ticker, never a
          long column (founder asked twice to shorten it). ────────────────── */}
      <aside className="hidden w-[300px] shrink-0 border-l border-hairline bg-surface-soft/40 p-3 lg:block">
        <div className="flex max-h-[300px] flex-col overflow-hidden rounded-xl border border-hairline bg-canvas shadow-soft">
          <ActivityFeed runs={runs} />
        </div>
      </aside>
    </div>
  );
}

// ===========================================================================
// Node stat card
// ===========================================================================
function NodeCard({
  track,
  stat,
  loading,
  onClick,
}: {
  track: TrackMeta;
  stat: TrackStat | undefined;
  loading: boolean;
  onClick: () => void;
}) {
  const Icon = track.icon;
  const count = stat?.count ?? 0;
  const isEmpty = !loading && count === 0 && (stat?.runCount ?? 0) === 0;
  const spark = stat?.spark ?? [];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border border-hairline bg-canvas p-3.5 text-left",
        "transition-all duration-150 hover:-translate-y-0.5 hover:border-ink/25 hover:shadow-[0_8px_24px_-14px_rgb(var(--ink)/0.22)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg text-ink/80",
            track.accent,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <StatusPill status={stat?.status ?? "idle"} />
      </div>

      <div>
        <h3 className="text-[13.5px] font-fig-card leading-tight tracking-tight">
          {track.label}
        </h3>
        <p className="mt-0.5 line-clamp-1 text-[11.5px] leading-snug text-ink/55">
          {track.tagline}
        </p>
      </div>

      <div className="mt-1 flex items-end justify-between gap-3">
        <div>
          {loading ? (
            <div className="h-6 w-14 animate-pulse rounded bg-ink/5" />
          ) : isEmpty ? (
            <p className="max-w-[160px] text-[11px] font-medium leading-tight text-ink/45">
              {track.zero}
            </p>
          ) : (
            <>
              <NumberTicker
                value={count}
                className="text-[21px] font-fig-card leading-none text-ink"
              />
              <p className="mt-0.5 font-mono text-[9.5px] uppercase tracking-wide text-ink/40">
                {track.statNoun}
                {typeof stat?.sub === "number" && stat.sub > 0
                  ? ` · ${stat.sub} drafted`
                  : ""}
              </p>
            </>
          )}
        </div>
        {spark.some((n) => n > 0) ? (
          <Sparkline data={spark} className="text-ink/35" />
        ) : null}
      </div>
    </button>
  );
}

function BrainCard({
  brain,
  loading,
  onClick,
}: {
  brain: { facts: number; pages: number; status: "idle" | "working" | "done" };
  loading: boolean;
  onClick?: () => void;
}) {
  const isEmpty = !loading && brain.facts === 0 && brain.pages === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border border-hairline bg-block-navy/10 p-3.5 text-left",
        "transition-all duration-150 hover:-translate-y-0.5 hover:border-ink/25 hover:shadow-[0_8px_24px_-14px_rgb(var(--ink)/0.22)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-block-navy/20 text-ink/80">
          <IconBrain className="h-4 w-4" />
        </span>
        <StatusPill status={brain.status} />
      </div>
      <div>
        <h3 className="text-[13.5px] font-fig-card leading-tight tracking-tight">
          The brain
        </h3>
        <p className="mt-0.5 line-clamp-1 text-[11.5px] leading-snug text-ink/55">
          What every run taught us — it compounds.
        </p>
      </div>
      <div className="mt-1">
        {loading ? (
          <div className="h-6 w-14 animate-pulse rounded bg-ink/5" />
        ) : isEmpty ? (
          <p className="text-[11px] font-medium text-ink/45">
            The brain is empty — it grows per run
          </p>
        ) : (
          <>
            <NumberTicker
              value={brain.facts}
              className="text-[21px] font-fig-card leading-none text-ink"
            />
            <p className="mt-0.5 font-mono text-[9.5px] uppercase tracking-wide text-ink/40">
              facts · {brain.pages.toLocaleString()} pages
            </p>
          </>
        )}
      </div>
    </button>
  );
}

// ===========================================================================
// Status pill
// ===========================================================================
const STATUS_META: Record<
  TrackStatStatus,
  { label: string; dot: string; text: string; pulse?: boolean }
> = {
  working: { label: "Working", dot: "bg-emerald-500", text: "text-emerald-700", pulse: true },
  radar: { label: "On radar", dot: "bg-sky-500", text: "text-sky-700", pulse: true },
  done: { label: "Done", dot: "bg-ink/40", text: "text-ink/50" },
  idle: { label: "Idle", dot: "bg-ink/20", text: "text-ink/40" },
};

function StatusPill({ status }: { status: TrackStatStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-2.5 py-0.5",
        "font-mono text-[9.5px] uppercase tracking-wide",
        m.text,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot, m.pulse && "animate-pulse")} />
      {m.label}
    </span>
  );
}

// ===========================================================================
// Sparkline — tiny inline SVG, no deps.
// ===========================================================================
function Sparkline({ data, className }: { data: number[]; className?: string }) {
  const w = 56;
  const h = 22;
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data
    .map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ===========================================================================
// Activity feed — merge events across the most-recent runs (light editorial).
// Fixed slot count so the hook order is stable; absent slots use "skip".
// ===========================================================================
const KIND_COLOR: Record<string, string> = {
  sourced: "#8b7cf6",
  enriched: "#a78bfa",
  qualified: "#f59e0b",
  drafted: "#ff6a2b",
  sent: "#10b981",
  replied: "#06b6d4",
  found: "#3b82f6",
  rendered: "#ec4899",
  scored: "#f59e0b",
};
const kindColor = (k: string) => KIND_COLOR[k] ?? "#94a3b8";

function ActivityFeed({ runs }: { runs: Doc<"runs">[] | undefined }) {
  const ids = (runs ?? []).slice(0, FEED_RUN_SLOTS).map((r) => r._id);

  // Stable, unrolled hook calls — never inside a loop/condition.
  const s0 = useQuery(eventsByRunRef, ids[0] ? { runId: ids[0] } : "skip") as EventDoc[] | undefined;
  const s1 = useQuery(eventsByRunRef, ids[1] ? { runId: ids[1] } : "skip") as EventDoc[] | undefined;
  const s2 = useQuery(eventsByRunRef, ids[2] ? { runId: ids[2] } : "skip") as EventDoc[] | undefined;
  const s3 = useQuery(eventsByRunRef, ids[3] ? { runId: ids[3] } : "skip") as EventDoc[] | undefined;
  const s4 = useQuery(eventsByRunRef, ids[4] ? { runId: ids[4] } : "skip") as EventDoc[] | undefined;
  const s5 = useQuery(eventsByRunRef, ids[5] ? { runId: ids[5] } : "skip") as EventDoc[] | undefined;

  const rows = useMemo(() => {
    const merged = [...(s0 ?? []), ...(s1 ?? []), ...(s2 ?? []), ...(s3 ?? []), ...(s4 ?? []), ...(s5 ?? [])];
    return merged.sort((a, b) => b.createdAt - a.createdAt).slice(0, 24);
  }, [s0, s1, s2, s3, s4, s5]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
        <span className="live-dot text-emerald-500" />
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wide text-ink/55">
          Live activity
        </span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink/30">
          {rows.length}
        </span>
      </div>

      {runs === undefined ? (
        <div className="space-y-1.5 p-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-7 animate-pulse rounded bg-ink/5" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="m-4 rounded-xl border border-dashed border-hairline px-4 py-8 text-center text-[12px] text-ink/40">
          Activity from the swarm appears here in real time.
        </p>
      ) : (
        <ul className="col-scroll min-h-0 flex-1 divide-y divide-hairline/60 overflow-y-auto">
          {rows.map((e) => (
            <li key={e._id} className="flex items-center gap-2.5 px-4 py-1.5 animate-row-in">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: kindColor(e.kind) }}
              />
              {e.agent ? (
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-ink/35">
                  {e.agent}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink/75">
                {e.message}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink/25">
                {relativeTime(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ===========================================================================
// Stat derivation
// ===========================================================================
function deriveStats(
  tracks: readonly TrackMeta[],
  runs: readonly Doc<"runs">[],
): TrackStat[] {
  // Run roll-up grouped by intent.
  const now = Date.now();
  return tracks.map((t) => {
    const mine = runs.filter((r) => r.intent === t.key);
    const latest = mine[0]; // listRuns is newest-first
    return {
      key: t.key,
      count: mine.length,
      runCount: mine.length,
      status: deriveTrackStatus(latest, now),
      latestRunId: latest?._id,
      spark: bucketByTime(mine.map((r) => r.startedAt), now),
    };
  });
}

// Grace past the hard fan-in deadline before we treat a still-"running" run as
// stale. A run whose orchestrator never flipped its terminal status (common in
// dev) must NOT read "Working" forever — that was the "everything's working" bug.
const STALE_GRACE_MS = 8_000;

/**
 * Map a track's LATEST run → its real status. The cards must reflect reality:
 *   • IDLE    — no run for this intent at all.
 *   • WORKING — the latest run is genuinely running (a manual/chat run, before
 *               its fan-in deadline). A stale "running" past the deadline is NOT
 *               working — it's settled, so it reads DONE.
 *   • RADAR   — the track is AUTONOMOUS (a 24/7 cron run): the watch is on,
 *               whether the latest tick is mid-flight or between ticks.
 *   • DONE    — the latest run has settled (completed / partial / stalled).
 */
function deriveTrackStatus(
  latest: Doc<"runs"> | undefined,
  now: number,
): TrackStatStatus {
  if (!latest) return "idle";
  const autonomous = latest.trigger === "cron";
  const liveRunning =
    latest.status === "running" && now <= latest.deadlineAt + STALE_GRACE_MS;
  if (liveRunning) return autonomous ? "radar" : "working";
  // Settled (or a stale "running" we no longer trust).
  if (autonomous && latest.status !== "failed") return "radar";
  return "done";
}

function deriveBrain(
  stats: { facts: number; pages: number; lastUpdatedAt: number } | undefined,
): { facts: number; pages: number; status: "idle" | "working" | "done" } {
  if (!stats) return { facts: 0, pages: 0, status: "idle" };
  // Honest: "working" only while the brain was JUST written (a run is actively
  // teaching it); otherwise it's idle (empty) or done (it knows things).
  const fresh = Date.now() - stats.lastUpdatedAt < 90 * 1000;
  const status = stats.facts === 0 ? "idle" : fresh ? "working" : "done";
  return { facts: stats.facts, pages: stats.pages, status };
}

function bucketByTime(times: readonly number[], now: number): number[] {
  const buckets = emptySpark();
  const start = now - SPARK_WINDOW_MS;
  const span = SPARK_WINDOW_MS / SPARK_BUCKETS;
  for (const t of times) {
    if (t < start || t > now) continue;
    const idx = Math.min(SPARK_BUCKETS - 1, Math.floor((t - start) / span));
    buckets[idx] += 1;
  }
  return buckets;
}

function emptySpark(): number[] {
  return new Array(SPARK_BUCKETS).fill(0);
}

// ===========================================================================
// Inline stroke glyphs (currentColor) — no shared import, light editorial.
// ===========================================================================
function IconRadar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12 19 5" />
      <path d="M12 12a4 4 0 1 0 4 4" />
    </svg>
  );
}
function IconPipeline({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M4 12h10M4 17h6" />
    </svg>
  );
}
function IconScan({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M4 12h16" />
    </svg>
  );
}
function IconSpark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  );
}
function IconPulse({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2-6 4 14 2-8h6" />
    </svg>
  );
}
function IconSeed({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21v-7" />
      <path d="M12 14c0-3 2-5 5-5 0 3-2 5-5 5Z" />
      <path d="M12 14c0-3-2-5-5-5 0 3 2 5 5 5Z" />
    </svg>
  );
}
function IconScout({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function IconBrain({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 1 5 3 3 0 0 0 3 3M9 4v16M9 4a3 3 0 0 1 3 3M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-1 5 3 3 0 0 1-3 3M15 4v16" />
    </svg>
  );
}
