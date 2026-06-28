"use client";

// ============================================================================
// INTERCEPT — LIVE METRICS PANEL ("analytics" beat)
// A small realtime panel for the swarm board. It tallies live activity:
//   - runs started        (all-time, across the deployment)
//   - threads found        (THE MOAT — for the current run)
//   - replies approved     (human-approved drafts — for the current run)
// Counts are read reactively from Convex (useQuery), so they tick up live on
// camera. Each increment also fires a PostHog event via useCapture() so the
// same numbers show up on the PostHog live dashboard. Fully graceful: with no
// runId it still shows the global runs counter; with no PostHog key the events
// simply no-op (see lib/posthog.ts).
// ============================================================================

import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCapture } from "./PostHogProvider";

interface DraftRow {
  _id: string;
  status: "awaiting_approval" | "approved" | "rejected" | "posted";
}

interface MetricSpec {
  key: "runs" | "threads" | "approvals";
  label: string;
  value: number;
  event: string;
  accent: string; // tailwind text color token
}

function MetricStat({ spec }: { spec: MetricSpec }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line/70 glass px-3 py-2.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">
        {spec.label}
      </span>
      <span
        className={`text-2xl font-semibold tabular-nums leading-none ${spec.accent}`}
      >
        {spec.value}
      </span>
    </div>
  );
}

export default function LiveMetrics({ runId }: { runId?: Id<"runs"> }) {
  const capture = useCapture();

  // Global run count (all-time) + per-run moat/approval counts (reactive).
  const runs = useQuery(api.runs.listRuns, {});
  const threads = useQuery(
    api.brief.getThreads,
    runId ? { runId } : "skip",
  );
  const drafts = useQuery(
    api.brief.getDrafts,
    runId ? { runId } : "skip",
  ) as DraftRow[] | undefined;

  const runsStarted = runs?.length ?? 0;
  const threadsFound = threads?.length ?? 0;
  const approvals = (drafts ?? []).filter(
    (d) => d.status === "approved" || d.status === "posted",
  ).length;

  // Fire a PostHog event whenever a tally increases (the live "analytics" beat).
  const prev = useRef({ runs: 0, threads: 0, approvals: 0 });
  useEffect(() => {
    const p = prev.current;
    if (runsStarted > p.runs) {
      capture("swarm_runs_started", { total: runsStarted });
    }
    if (threadsFound > p.threads) {
      capture("swarm_threads_found", { total: threadsFound, runId });
    }
    if (approvals > p.approvals) {
      capture("swarm_reply_approved", { total: approvals, runId });
    }
    prev.current = { runs: runsStarted, threads: threadsFound, approvals };
  }, [runsStarted, threadsFound, approvals, runId, capture]);

  const metrics: MetricSpec[] = [
    {
      key: "runs",
      label: "Runs started",
      value: runsStarted,
      event: "swarm_runs_started",
      accent: "text-white",
    },
    {
      key: "threads",
      label: "Threads found",
      value: threadsFound,
      event: "swarm_threads_found",
      accent: "text-accent",
    },
    {
      key: "approvals",
      label: "Replies approved",
      value: approvals,
      event: "swarm_reply_approved",
      accent: "text-good",
    },
  ];

  return (
    <section className="w-full">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-white/55">
          Live analytics
        </h3>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-white/30">
          PostHog
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {metrics.map((spec) => (
          <MetricStat key={spec.key} spec={spec} />
        ))}
      </div>
    </section>
  );
}
