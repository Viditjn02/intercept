"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";

// ============================================================================
// WorkflowsPanel — the global GTM WORKFLOWS theatre.
// ----------------------------------------------------------------------------
// Mounted ONCE at the app root; it self-opens when a sidebar row dispatches
//   window.dispatchEvent(new CustomEvent("intercept:open-workflows", {
//     detail: { targetUrl } }))
//
// It calls convex/workflows.buildWorkflows({ targetUrl }) to turn INTERCEPT's
// one-off agent runs into 3-4 structured, monitored, production-ready revenue
// workflows. Each renders as a card: name + goal, an ordered step list (status
// dot + play name + health note), the schedule, and the monitored metric →
// target behind a small "monitored" badge.
//
// Bound by NAME via makeFunctionReference (mirrors components/WinBackPanel.tsx)
// so it compiles regardless of deploy order. Graceful by contract: the backend
// never throws (it degrades to a canned set), and every async path here is
// guarded. SSR-safe: the window listener only attaches in an effect. When the
// dispatched detail.targetUrl is empty the panel falls back to the persisted
// settings target itself (via api.settings.getSettings) — no prop threading.
// ============================================================================

type PlayName =
  | "Reading Minds"
  | "Revenue on Autopilot"
  | "Ad Intelligence"
  | "Ad Factory"
  | "Algorithm Hacking"
  | "Zero to One";

type StepStatus = "ready" | "running" | "idle";

interface WorkflowStep {
  name: string;
  play: PlayName;
  status: StepStatus;
  healthNote: string;
}

interface WorkflowMonitor {
  metric: string;
  target: string;
}

interface WorkflowPlan {
  name: string;
  goal: string;
  trigger: string;
  steps: WorkflowStep[];
  schedule: string;
  monitors: WorkflowMonitor;
}

interface WorkflowsResult {
  workflows: WorkflowPlan[];
}

interface OpenWorkflowsDetail {
  targetUrl?: string;
}

// Bound at runtime once convex/workflows.ts deploys (deploy-order safe).
const buildWorkflowsRef = makeFunctionReference<
  "action",
  { targetUrl: string },
  WorkflowsResult
>("workflows:buildWorkflows");

// Each play tints its step pill with its sidebar accent (raw "R G B" triples).
const PLAY_ACCENT: Record<PlayName, string> = {
  "Reading Minds": "var(--block-mint)",
  "Revenue on Autopilot": "var(--block-lime)",
  "Ad Intelligence": "var(--block-coral)",
  "Ad Factory": "var(--block-pink)",
  "Algorithm Hacking": "var(--block-lilac)",
  "Zero to One": "var(--block-cream)",
};

// Status → dot colour + label. ready=green, running=lilac (pulsing), idle=muted.
const STATUS_META: Record<
  StepStatus,
  { dot: string; pulse: boolean; label: string }
> = {
  ready: { dot: "bg-success", pulse: false, label: "Ready" },
  running: { dot: "bg-block-lilac", pulse: true, label: "Running" },
  idle: { dot: "bg-ink/25", pulse: false, label: "Idle" },
};

export default function WorkflowsPanel() {
  const buildWorkflows = useAction(buildWorkflowsRef);

  // The persisted default target — used when the event carries an empty URL.
  const settings = useQuery(api.settings.getSettings, {});
  const persistedTarget = settings?.targetUrl ?? "";
  // Keep the latest persisted target in a ref so the event handler (attached
  // once) always reads the freshest value without re-binding the listener.
  const persistedRef = useRef<string>("");
  useEffect(() => {
    persistedRef.current = persistedTarget;
  }, [persistedTarget]);

  const [open, setOpen] = useState(false);
  const [targetLabel, setTargetLabel] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowPlan[]>([]);

  // Guards a stale async resolve from overwriting a newer open.
  const requestId = useRef(0);

  const close = useCallback(() => setOpen(false), []);

  // ── Self-open on the sidebar event ──────────────────────────────────────────
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenWorkflowsDetail>).detail ?? {};
      const fromDetail = (detail.targetUrl ?? "").trim();
      const target = fromDetail || persistedRef.current || "";

      const reqId = requestId.current + 1;
      requestId.current = reqId;

      setWorkflows([]);
      setError(null);
      setTargetLabel(target || "your pipeline");
      setLoading(true);
      setOpen(true);

      buildWorkflows({ targetUrl: target })
        .then((res) => {
          if (requestId.current !== reqId) return; // superseded
          if (res && Array.isArray(res.workflows) && res.workflows.length > 0) {
            setWorkflows(res.workflows);
          } else {
            setError("Couldn't compose any workflows right now.");
          }
        })
        .catch(() => {
          if (requestId.current !== reqId) return;
          // The backend is graceful, but guard the call site regardless.
          setError("Workflows is warming up — try again in a moment.");
        })
        .finally(() => {
          if (requestId.current === reqId) setLoading(false);
        });
    };

    window.addEventListener("intercept:open-workflows", onOpen as EventListener);
    return () =>
      window.removeEventListener(
        "intercept:open-workflows",
        onOpen as EventListener,
      );
  }, [buildWorkflows]);

  // ── Esc to close + lock body scroll while open ──────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, close]);

  if (!open) return null;

  const ready = !loading && workflows.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="GTM Workflows"
      onClick={close}
    >
      <div
        className="relative flex h-[680px] max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <p className="caption font-mono uppercase tracking-wide text-ink/50">
              GTM Workflows
            </p>
            <h2 className="mt-1 truncate text-[15px] font-fig-headline text-ink">
              One-off runs, now production workflows
            </h2>
            <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
              {loading
                ? `Composing monitored workflows for ${targetLabel}…`
                : "Structured, monitored sequences of INTERCEPT plays"}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-full p-1.5 text-ink/50 transition-colors hover:bg-surface-soft hover:text-ink"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>

        {/* Body — the workflow cards */}
        <div className="col-scroll min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-soft/50 px-5 py-4">
          {loading && workflows.length === 0 && <LoadingState />}

          {error && workflows.length === 0 && (
            <div className="grid h-full place-items-center text-center text-[13px] text-ink/55">
              {error}
            </div>
          )}

          {ready &&
            workflows.map((w, i) => (
              <WorkflowCard key={`${w.name}-${i}`} workflow={w} />
            ))}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <span className="text-[11px] text-ink/45">
            {loading
              ? "Wiring triggers, plays, and monitors…"
              : ready
                ? `${workflows.length} production-ready workflows`
                : " "}
          </span>
          <button
            type="button"
            onClick={close}
            className="rounded-pill bg-ink px-5 py-1.5 text-[12.5px] font-fig-link text-on-primary transition-opacity hover:opacity-90"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One workflow card: name + goal, trigger, ordered step list, schedule, and the
// monitored metric → target behind a small "monitored" badge.
// ---------------------------------------------------------------------------
function WorkflowCard({ workflow }: { workflow: WorkflowPlan }) {
  return (
    <div className="animate-row-in rounded-xl border border-hairline bg-canvas p-4">
      {/* Top row: name + goal, and the monitored badge. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-fig-card text-ink">
            {workflow.name}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink/60">
            {workflow.goal}
          </p>
        </div>
        <MonitoredBadge />
      </div>

      {/* Trigger line. */}
      <p className="mt-3 flex gap-1.5 text-[12px] leading-snug text-ink/80">
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink/45">
          Trigger
        </span>
        <span className="min-w-0">{workflow.trigger}</span>
      </p>

      {/* The ordered step list. */}
      <ol className="mt-3 space-y-1.5">
        {workflow.steps.map((s, i) => (
          <StepRow key={`${s.name}-${i}`} step={s} index={i + 1} />
        ))}
      </ol>

      {/* Schedule + the monitored metric → target. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface-soft px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-ink/55">
          <ClockIcon />
          {workflow.schedule}
        </span>
        <span className="inline-flex items-center gap-1 rounded-pill border border-hairline bg-canvas px-2.5 py-1 text-[11px] text-ink/75">
          <span className="font-mono text-[9.5px] uppercase tracking-wide text-ink/45">
            {workflow.monitors.metric}
          </span>
          <span aria-hidden className="text-ink/35">→</span>
          <span className="font-fig-card tabular-nums text-ink">
            {workflow.monitors.target}
          </span>
        </span>
      </div>
    </div>
  );
}

// One step: ordinal · status dot · play pill · step name + health note.
function StepRow({ step, index }: { step: WorkflowStep; index: number }) {
  const status = STATUS_META[step.status] ?? STATUS_META.idle;
  const accent = PLAY_ACCENT[step.play] ?? "var(--block-mint)";
  return (
    <li className="flex items-start gap-2.5 rounded-lg bg-surface-soft/60 px-2.5 py-2">
      <span className="mt-0.5 font-mono text-[10px] tabular-nums text-ink/40">
        {index}
      </span>
      <span
        className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${status.dot} ${
          status.pulse ? "animate-pulse" : ""
        }`}
        aria-label={status.label}
        title={status.label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-[10.5px] font-fig-card text-ink"
            style={{ background: `rgb(${accent})` }}
          >
            {step.play}
          </span>
          <span className="min-w-0 truncate text-[12.5px] text-ink/85">
            {step.name}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide text-ink/45">
          {status.label} · {step.healthNote}
        </p>
      </div>
    </li>
  );
}

function MonitoredBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-block-mint px-2.5 py-1 text-[10.5px] font-fig-card text-ink">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink/60" aria-hidden />
      monitored
    </span>
  );
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Loading skeletons — three placeholder workflow cards while the build runs.
// ---------------------------------------------------------------------------
function LoadingState() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-hairline bg-canvas p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <div className="h-3.5 w-40 animate-pulse rounded bg-surface-soft" />
              <div className="h-2.5 w-56 animate-pulse rounded bg-surface-soft" />
            </div>
            <div className="h-5 w-20 animate-pulse rounded-pill bg-surface-soft" />
          </div>
          <div className="mt-3 space-y-1.5">
            {[0, 1, 2].map((j) => (
              <div key={j} className="h-8 animate-pulse rounded-lg bg-surface-soft" />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <div className="h-6 w-32 animate-pulse rounded-pill bg-surface-soft" />
            <div className="h-6 w-28 animate-pulse rounded-pill bg-surface-soft" />
          </div>
        </div>
      ))}
    </div>
  );
}
