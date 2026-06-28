"use client";

import type { ReactElement } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AGENTS,
  AGENT_REGISTRY,
  boardAgentsForIntent,
  type AgentId,
  type Capability,
} from "@/lib/contract";
import { cn } from "@/lib/utils";

// ============================================================================
// SwarmBoard — the live agent grid for ONE run. Intent-aware: it renders only
// the agents in that capability's plan (boardAgentsForIntent), so an outbound
// run shows Sourcer/Qualifier/Writer and a discovery run shows the Detective —
// never a wall of idle, irrelevant tiles. Reads agentStatus reactively.
// ============================================================================

type AgentStatusValue = "queued" | "running" | "done" | "skipped" | "failed";

interface AgentStatusRow {
  _id: string;
  runId: Id<"runs">;
  agent: string;
  status: AgentStatusValue;
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface RunDoc {
  _id: Id<"runs">;
  status: "running" | "complete" | "partial" | "failed";
  intent?: Capability;
  company?: string;
  startedAt: number;
  deadlineAt: number;
}

// ----------------------------------------------------------------------------
// Per-agent presentation (inline SVG glyphs, no emoji). Full roster coverage.
// ----------------------------------------------------------------------------
function icon(path: ReactElement): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      {path}
    </svg>
  );
}

const AGENT_META: Record<AgentId, { tagline: string; icon: ReactElement }> = {
  router: {
    tagline: "Reading the input, dispatching the swarm",
    icon: icon(
      <>
        <path d="M5 12h6m0 0 4-4m-4 4 4 4M11 12h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="5" cy="12" r="1.8" fill="currentColor" />
      </>,
    ),
  },
  enrich: {
    tagline: "Building the ICP & positioning",
    icon: icon(<path d="M12 3v18M3 8l9 4 9-4M3 16l9 4 9-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />),
  },
  detective: {
    tagline: "Hunting live, intent-scored threads",
    icon: icon(
      <>
        <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="m20 20-4.5-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>,
    ),
  },
  reply: {
    tagline: "Drafting in-thread replies",
    icon: icon(<path d="M9 17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4l-3 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />),
  },
  sourcer: {
    tagline: "Companies + verified contacts",
    icon: icon(
      <>
        <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 11l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>,
    ),
  },
  qualifier: {
    tagline: "Scoring fit 0-100, dropping the misses",
    icon: icon(
      <>
        <path d="M12 3l2.5 5.2 5.5.7-4 3.9 1 5.5-5-2.8-5 2.8 1-5.5-4-3.9 5.5-.7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </>,
    ),
  },
  writer: {
    tagline: "Signal-grounded outbound emails",
    icon: icon(<path d="M4 20h16M5 16l9.5-9.5a2 2 0 1 1 2.8 2.8L7.8 18.8 4 20l1.2-3.8z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />),
  },
  sender: {
    tagline: "Sending the approved sequence via AgentMail",
    icon: icon(
      <>
        <path d="m22 2-7 20-4-9-9-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M22 2 11 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>,
    ),
  },
  follower: {
    tagline: "Watching replies, scheduling follow-ups",
    icon: icon(
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M3 4v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>,
    ),
  },
  adscout: {
    tagline: "Scouting winning competitor ads",
    icon: icon(
      <>
        <path d="M4 9v6h3l5 4V5L7 9H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M16.5 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>,
    ),
  },
  creative: {
    tagline: "Rendering the video ad",
    icon: icon(
      <>
        <rect x="3" y="6" width="18" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" />
      </>,
    ),
  },
  designer: {
    tagline: "Designing the landing page + ad copy",
    icon: icon(
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="3" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 8h5M8 12h8M8 16h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>,
    ),
  },
  watcher: {
    tagline: "Tearing down competitor video ads",
    icon: icon(
      <>
        <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      </>,
    ),
  },
  trendscout: {
    tagline: "Scanning live trends & topics",
    icon: icon(<path d="M3 17l5-5 4 4 8-8m0 0h-5m5 0v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />),
  },
  composer: {
    tagline: "Spinning up multi-variant viral posts",
    icon: icon(
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>,
    ),
  },
  reelmaker: {
    tagline: "Rendering a short vertical reel",
    icon: icon(
      <>
        <rect x="6" y="3" width="12" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="m11 9 4 2.5-4 2.5z" fill="currentColor" />
      </>,
    ),
  },
  calendar: {
    tagline: "Laying out the content calendar",
    icon: icon(
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.5 9.5h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>,
    ),
  },
  twin: {
    tagline: "Simulating the buyer's reply before send",
    icon: icon(
      <>
        <circle cx="8.5" cy="9" r="3" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="15.5" cy="9" r="3" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.5 19a5 5 0 0 1 10 0M10.5 19a5 5 0 0 1 10 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>,
    ),
  },
  guide: {
    tagline: "Generating the in-app onboarding tour",
    icon: icon(
      <>
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>,
    ),
  },
};

const STATUS_STYLE: Record<
  AgentStatusValue,
  { ring: string; chip: string; label: string; text: string }
> = {
  queued: { ring: "border-line/80", chip: "bg-white/5 text-white/40 border-white/10", label: "Queued", text: "text-white/40" },
  running: { ring: "border-accent/70 shadow-[0_0_28px_-8px_rgba(255,106,43,0.5)]", chip: "bg-accent/15 text-accent border-accent/30", label: "Running", text: "text-white" },
  done: { ring: "border-good/45", chip: "bg-good/15 text-good border-good/30", label: "Done", text: "text-white" },
  skipped: { ring: "border-line/60", chip: "bg-white/5 text-white/40 border-white/10", label: "Skipped", text: "text-white/45" },
  failed: { ring: "border-red-500/40", chip: "bg-red-500/15 text-red-300 border-red-500/30", label: "Failed", text: "text-white/70" },
};

function StatusIcon({ status }: { status: AgentStatusValue }) {
  if (status === "running")
    return <span className="h-3.5 w-3.5 animate-spin-slow rounded-full border-2 border-accent/30 border-t-accent" />;
  if (status === "done")
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-good">
        <path d="m5 12.5 4 4 10-10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-red-300">
        <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  if (status === "skipped")
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-white/35">
        <path d="M6 12h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  return <span className="h-2 w-2 rounded-full bg-white/30 animate-blink" />;
}

function AgentTile({
  agent,
  status,
  note,
  index,
}: {
  agent: AgentId;
  status: AgentStatusValue;
  note?: string;
  index: number;
}) {
  const meta = AGENT_META[agent];
  const spec = AGENT_REGISTRY[agent];
  const s = STATUS_STYLE[status];
  const isRunning = status === "running";

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-2.5 rounded-xl border glass p-3.5 transition-all duration-500 animate-fade-up",
        s.ring,
      )}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {isRunning && <span className="pointer-events-none absolute inset-0 rounded-xl animate-pulse-ring" />}
      <div className="flex items-center justify-between">
        <div
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors",
            isRunning
              ? "border-accent/40 bg-accent/10 text-accent"
              : status === "done"
                ? "border-good/30 bg-good/10 text-good"
                : "border-white/10 bg-white/5 text-white/45",
          )}
        >
          {meta.icon}
        </div>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide", s.chip)}>
          <StatusIcon status={status} />
          {s.label}
        </span>
      </div>
      <div>
        <h3 className={cn("text-[13.5px] font-semibold leading-tight", s.text)}>{spec.label}</h3>
        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-white/45">{note ?? meta.tagline}</p>
      </div>
      <div className="mt-auto h-0.5 w-full overflow-hidden rounded-full bg-white/5">
        {isRunning ? (
          <div className="scan-track h-full w-full" />
        ) : (
          <div
            className={cn(
              "h-full rounded-full transition-all duration-700",
              status === "done"
                ? "w-full bg-good"
                : status === "failed"
                  ? "w-full bg-red-500/60"
                  : status === "skipped"
                    ? "w-full bg-white/15"
                    : "w-0",
            )}
          />
        )}
      </div>
    </div>
  );
}

export default function SwarmBoard({
  runId,
  intent,
}: {
  runId: Id<"runs">;
  /** When provided, only that capability's roster is shown. */
  intent?: Capability;
}) {
  const run = useQuery(api.runs.getRun, { runId }) as RunDoc | null | undefined;
  const statuses = useQuery(api.runs.agentStatuses, { runId }) as AgentStatusRow[] | undefined;

  // The roster: prefer the prop, else the run's intent, else the full list.
  const resolvedIntent = intent ?? run?.intent;
  const roster: AgentId[] = resolvedIntent ? boardAgentsForIntent(resolvedIntent) : [...AGENTS];

  const byAgent = new Map<string, AgentStatusRow>();
  for (const row of statuses ?? []) byAgent.set(row.agent, row);

  // Only count agents that are actually on the board for this run.
  const rosterRows = roster.map((a) => byAgent.get(a));
  const doneCount = rosterRows.filter((r) => r?.status === "done" || r?.status === "skipped").length;
  const total = roster.length || 1;
  const pct = Math.round((doneCount / total) * 100);

  const runStatus = run?.status ?? "running";
  const headline =
    runStatus === "complete"
      ? "Swarm complete"
      : runStatus === "partial"
        ? "Settled at the deadline"
        : runStatus === "failed"
          ? "Run failed"
          : "Swarm is live";

  return (
    <section className="w-full">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={cn("relative flex h-2.5 w-2.5", runStatus === "running" ? "" : "opacity-60")}>
            {runStatus === "running" && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70" />
            )}
            <span
              className={cn(
                "relative inline-flex h-2.5 w-2.5 rounded-full",
                runStatus === "failed" ? "bg-red-400" : runStatus === "running" ? "bg-accent" : "bg-good",
              )}
            />
          </span>
          <h2 className="text-[15px] font-semibold tracking-tight">
            {headline}
            {run?.company ? <span className="text-white/45"> · {run.company}</span> : null}
          </h2>
        </div>
        <span className="text-[11px] font-medium tabular-nums text-white/40">
          {doneCount}/{total} agents · {pct}%
        </span>
      </div>

      <div className="mb-4 h-1 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent to-good transition-all duration-700 ease-out"
          style={{ width: `${Math.max(pct, runStatus === "running" ? 6 : 0)}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
        {roster.map((agent, i) => {
          const row = byAgent.get(agent);
          return (
            <AgentTile
              key={agent}
              agent={agent}
              index={i}
              status={(row?.status as AgentStatusValue) ?? "queued"}
              note={row?.note}
            />
          );
        })}
      </div>
    </section>
  );
}
