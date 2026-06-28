"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AGENTS, type AgentName } from "@/lib/contract";

// ----------------------------------------------------------------------------
// Status vocabulary (mirrors convex/schema.ts agentStatus.status).
// ----------------------------------------------------------------------------
type AgentStatusValue =
  | "queued"
  | "running"
  | "done"
  | "skipped"
  | "failed";

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
  company?: string;
  startedAt: number;
  deadlineAt: number;
}

// ----------------------------------------------------------------------------
// Per-agent presentation. Icons are inline SVG glyphs (no emoji).
// ----------------------------------------------------------------------------
const AGENT_META: Record<
  AgentName,
  { label: string; tagline: string; icon: JSX.Element }
> = {
  router: {
    label: "Router",
    tagline: "Reading the input, dispatching the swarm",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <path
          d="M5 12h6m0 0 4-4m-4 4 4 4M11 12h8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="5" cy="12" r="1.8" fill="currentColor" />
      </svg>
    ),
  },
  enrich: {
    label: "Enrich",
    tagline: "Building the ICP & positioning",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <path
          d="M12 3v18M3 8l9 4 9-4M3 16l9 4 9-4"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  detective: {
    label: "Detective",
    tagline: "Hunting live, intent-scored threads",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <circle
          cx="10.5"
          cy="10.5"
          r="6.5"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path
          d="m20 20-4.5-4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  creative: {
    label: "Creative",
    tagline: "Rendering the Veo video ad",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <rect
          x="3"
          y="6"
          width="18"
          height="12"
          rx="2.5"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" />
      </svg>
    ),
  },
  watcher: {
    label: "Watcher",
    tagline: "Scoring buying intent in real time",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <path
          d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
};

// Visual treatment per status.
const STATUS_STYLE: Record<
  AgentStatusValue,
  { ring: string; chip: string; dot: string; text: string; label: string }
> = {
  queued: {
    ring: "border-line/80",
    chip: "bg-white/5 text-white/40 border-white/10",
    dot: "bg-white/30",
    text: "text-white/35",
    label: "Queued",
  },
  running: {
    ring: "border-accent/70 shadow-[0_0_30px_-6px_rgba(255,106,43,0.55)]",
    chip: "bg-accent/15 text-accent border-accent/30",
    dot: "bg-accent",
    text: "text-white",
    label: "Running",
  },
  done: {
    ring: "border-good/45",
    chip: "bg-good/15 text-good border-good/30",
    dot: "bg-good",
    text: "text-white",
    label: "Done",
  },
  skipped: {
    ring: "border-line/60",
    chip: "bg-white/5 text-white/40 border-white/10",
    dot: "bg-white/30",
    text: "text-white/45",
    label: "Skipped",
  },
  failed: {
    ring: "border-red-500/40",
    chip: "bg-red-500/15 text-red-300 border-red-500/30",
    dot: "bg-red-400",
    text: "text-white/70",
    label: "Failed",
  },
};

function StatusIcon({ status }: { status: AgentStatusValue }) {
  if (status === "running") {
    return (
      <span className="h-4 w-4 animate-spin-slow rounded-full border-2 border-accent/30 border-t-accent" />
    );
  }
  if (status === "done") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-good">
        <path
          d="m5 12.5 4 4 10-10"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-red-300">
        <path
          d="m7 7 10 10M17 7 7 17"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (status === "skipped") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-white/35">
        <path
          d="M6 12h12"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <span className="h-2.5 w-2.5 rounded-full bg-white/30 animate-blink" />
  );
}

function AgentTile({
  agent,
  status,
  note,
  index,
}: {
  agent: AgentName;
  status: AgentStatusValue;
  note?: string;
  index: number;
}) {
  const meta = AGENT_META[agent];
  const s = STATUS_STYLE[status];
  const isRunning = status === "running";

  return (
    <div
      className={`group relative flex flex-col gap-3 rounded-2xl border ${s.ring} glass p-4 transition-all duration-500 animate-fade-up`}
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* running pulse ring overlay */}
      {isRunning && (
        <span className="pointer-events-none absolute inset-0 rounded-2xl animate-pulse-ring" />
      )}

      <div className="flex items-center justify-between">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
            isRunning
              ? "border-accent/40 bg-accent/10 text-accent"
              : status === "done"
                ? "border-good/30 bg-good/10 text-good"
                : "border-white/10 bg-white/5 text-white/45"
          }`}
        >
          {meta.icon}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${s.chip}`}
        >
          <StatusIcon status={status} />
          {s.label}
        </span>
      </div>

      <div>
        <h3 className={`text-[15px] font-semibold leading-tight ${s.text}`}>
          {meta.label}
        </h3>
        <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-white/45">
          {note ?? meta.tagline}
        </p>
      </div>

      {/* progress track — animated scan only while running */}
      <div className="mt-auto h-1 w-full overflow-hidden rounded-full bg-white/5">
        {isRunning ? (
          <div className="scan-track h-full w-full" />
        ) : (
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              status === "done"
                ? "w-full bg-good"
                : status === "failed"
                  ? "w-full bg-red-500/60"
                  : status === "skipped"
                    ? "w-full bg-white/15"
                    : "w-0"
            }`}
          />
        )}
      </div>
    </div>
  );
}

export default function SwarmBoard({ runId }: { runId: Id<"runs"> }) {
  const run = useQuery(api.runs.getRun, { runId }) as
    | RunDoc
    | null
    | undefined;
  const statuses = useQuery(api.runs.agentStatuses, { runId }) as
    | AgentStatusRow[]
    | undefined;

  // Map latest status row per agent name; default to "queued".
  const byAgent = new Map<string, AgentStatusRow>();
  for (const row of statuses ?? []) {
    byAgent.set(row.agent, row);
  }

  const doneCount = (statuses ?? []).filter(
    (r) => r.status === "done" || r.status === "skipped",
  ).length;
  const total = AGENTS.length;
  const pct = Math.round((doneCount / total) * 100);

  const runStatus = run?.status ?? "running";
  const headline =
    runStatus === "complete"
      ? "Swarm complete"
      : runStatus === "partial"
        ? "Brief rendered at the deadline"
        : runStatus === "failed"
          ? "Run failed"
          : "Swarm is live";

  return (
    <section className="w-full">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`relative flex h-2.5 w-2.5 ${
              runStatus === "running" ? "" : "opacity-60"
            }`}
          >
            {runStatus === "running" && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                runStatus === "failed"
                  ? "bg-red-400"
                  : runStatus === "running"
                    ? "bg-accent"
                    : "bg-good"
              }`}
            />
          </span>
          <h2 className="text-lg font-semibold tracking-tight">
            {headline}
            {run?.company ? (
              <span className="text-white/45"> · {run.company}</span>
            ) : null}
          </h2>
        </div>
        <span className="text-xs font-medium tabular-nums text-white/40">
          {doneCount}/{total} agents · {pct}%
        </span>
      </div>

      {/* overall progress bar */}
      <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent to-good transition-all duration-700 ease-out"
          style={{ width: `${Math.max(pct, runStatus === "running" ? 6 : 0)}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {AGENTS.map((agent, i) => {
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
