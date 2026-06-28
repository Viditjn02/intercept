"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CAPABILITIES,
  ROUTER_INTENTS,
  type Capability,
} from "@/lib/contract";
import { cn } from "@/lib/utils";
import SwarmBoard from "./SwarmBoard";
import DiscoveryBoard from "./DiscoveryBoard";
import ProspectPipeline from "./ProspectPipeline";
import EmailQueue from "./EmailQueue";
import EventFeed from "./EventFeed";
import AdGallery from "./AdGallery";
import AdFactoryPanel from "./AdFactoryPanel";
import CreativePanel from "./CreativePanel";
import BrainPanel from "./BrainPanel";
import BrainCanvas from "./BrainCanvas";
import PanelBoundary from "./ErrorBoundary";
import LiveMetrics from "./LiveMetrics";
import ContentCalendar from "./ContentCalendar";
import PitchLab from "./PitchLab";
import OnboardingCanvas from "./OnboardingCanvas";
import {
  campaignForRunRef,
  getMessagesRef,
  setCampaignStatusRef,
} from "./chatApi";
import type { CampaignDoc, ChatMessageDoc } from "./types";

// ============================================================================
// CanvasPanel — the live work surface (right). It follows the conversation:
// resolves the active run (a pinned one, else the latest), reads the run's
// intent, and renders ONLY the boards that capability produces — no empty
// clutter. The swarm tiles + live event feed frame every capability.
// ============================================================================

// The canvas has two lenses: the live `run` work surface (default) and the
// `brain` — the compounding knowledge board. `view`/`onView` are optional so the
// panel still works standalone; when supplied (by the page) the left-rail Brain
// item can drive the lens too.
export type CanvasView = "run" | "brain";

interface CanvasPanelProps {
  conversationId: Id<"conversations"> | null;
  focusedRunId?: Id<"runs"> | null;
  onFocusRun?: (runId: Id<"runs"> | undefined, intent?: string) => void;
  view?: CanvasView;
  onView?: (view: CanvasView) => void;
}

interface RunRef {
  runId: Id<"runs">;
  intent: Capability;
  messageId: Id<"messages">;
}

function asCapability(intent?: string): Capability {
  return (CAPABILITIES as readonly string[]).includes(intent ?? "")
    ? (intent as Capability)
    : "analyze";
}

function capabilityTitle(intent: Capability): string {
  return ROUTER_INTENTS.find((r) => r.intent === intent)?.title ?? intent;
}

export default function CanvasPanel({
  conversationId,
  focusedRunId,
  onFocusRun,
  view: controlledView,
  onView,
}: CanvasPanelProps) {
  const messages = useQuery(
    getMessagesRef,
    conversationId ? { conversationId } : "skip",
  ) as ChatMessageDoc[] | undefined;

  // The lens can be controlled by the page (left-rail Brain item) or owned
  // locally when the panel is used standalone.
  const [localView, setLocalView] = useState<CanvasView>("run");
  const view = controlledView ?? localView;
  const setView = onView ?? setLocalView;

  // Every run spawned in this conversation, in order.
  const runs: RunRef[] = useMemo(() => {
    const out: RunRef[] = [];
    for (const m of messages ?? []) {
      if (m.role === "assistant" && m.runId) {
        out.push({ runId: m.runId, intent: asCapability(m.intent), messageId: m._id });
      }
    }
    return out;
  }, [messages]);

  const activeRun =
    runs.find((r) => r.runId === focusedRunId) ?? runs[runs.length - 1] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CanvasLens view={view} onView={setView} />
      <div className="min-h-0 flex-1">
        {view === "brain" ? (
          // The brain board comes online the moment its Convex functions deploy;
          // until then PanelBoundary shows a calm fallback instead of crashing.
          <PanelBoundary label="Waking the brain…">
            <BrainCanvas />
          </PanelBoundary>
        ) : activeRun ? (
          <CanvasForRun
            run={activeRun}
            runs={runs}
            focusedRunId={focusedRunId ?? null}
            onFocusRun={onFocusRun}
          />
        ) : (
          <CanvasEmpty hasConversation={!!conversationId} />
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// CanvasLens — the Run | Brain toggle. Run = the live work surface for the
// active run; Brain = the compounding knowledge board (global, always available
// — even before any run exists).
// ----------------------------------------------------------------------------
function CanvasLens({
  view,
  onView,
}: {
  view: CanvasView;
  onView: (view: CanvasView) => void;
}) {
  return (
    <div className="flex items-center justify-end border-b border-line/60 px-5 py-2">
      <div className="inline-flex rounded-lg border border-line bg-panel/60 p-0.5 text-[11px] font-medium">
        <LensTab active={view === "run"} onClick={() => onView("run")}>
          Run
        </LensTab>
        <LensTab active={view === "brain"} onClick={() => onView("brain")}>
          <span aria-hidden className="mr-1">🧠</span>Brain
        </LensTab>
      </div>
    </div>
  );
}

function LensTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1 transition-colors",
        active ? "bg-accent/15 text-accent" : "text-white/50 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function CanvasForRun({
  run,
  runs,
  focusedRunId,
  onFocusRun,
}: {
  run: RunRef;
  runs: RunRef[];
  focusedRunId: Id<"runs"> | null;
  onFocusRun?: (runId: Id<"runs"> | undefined, intent?: string) => void;
}) {
  const runDoc = useQuery(api.runs.getRun, { runId: run.runId });
  const brief = useQuery(api.brief.getBrief, { runId: run.runId });
  const intent = asCapability(runDoc?.intent ?? run.intent);
  const company = runDoc?.company ?? runDoc?.input ?? "";

  return (
    <div className="col-scroll h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-5 py-5">
        {/* run switcher (only when more than one run) */}
        {runs.length > 1 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {runs.map((r) => {
              const active = r.runId === run.runId;
              return (
                <button
                  key={r.runId}
                  onClick={() => onFocusRun?.(r.runId, r.intent)}
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    active
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-line bg-panel/60 text-white/55 hover:text-white",
                  )}
                >
                  {capabilityTitle(r.intent).split(" ")[0]}
                </button>
              );
            })}
            {focusedRunId && runs[runs.length - 1]?.runId !== focusedRunId && (
              <button
                onClick={() => onFocusRun?.(undefined)}
                className="ml-1 rounded-lg px-2.5 py-1 text-[11px] text-white/45 hover:text-white"
              >
                Jump to latest →
              </button>
            )}
          </div>
        )}

        {/* capability header */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-accent">
              {capabilityTitle(intent)}
            </span>
            {company && <span className="truncate text-[13px] text-white/55">{company}</span>}
          </div>
          <CampaignControl runId={run.runId} intent={intent} />
        </div>

        {/* ICP / positioning strip */}
        {brief && (brief.icp || brief.positioning) && (
          <div className="mb-4 grid gap-3 rounded-2xl border border-line bg-panel/60 p-4 sm:grid-cols-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">Ideal customer</p>
              <p className="mt-1 text-[13px] leading-relaxed text-zinc-200">{brief.icp}</p>
            </div>
            {brief.positioning && (
              <div className="sm:border-l sm:border-line sm:pl-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">Positioning</p>
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-200">{brief.positioning}</p>
              </div>
            )}
          </div>
        )}

        {/* swarm tiles — always */}
        <div className="mb-5">
          <SwarmBoard runId={run.runId} intent={intent} />
        </div>

        {/* capability-specific boards */}
        <div className="space-y-6">
          {(intent === "discovery" || intent === "analyze") && <DiscoveryBoard runId={run.runId} />}

          {(intent === "outbound" || intent === "outreach") && (
            <>
              <ProspectPipeline runId={run.runId} />
              <EmailQueue runId={run.runId} />
              <PitchLab runId={run.runId} />
            </>
          )}

          {(intent === "competitor" || intent === "analyze") && (
            <AdGallery runId={run.runId} onFocusRun={onFocusRun} />
          )}

          {(intent === "content" || intent === "analyze") && (
            <>
              <AdFactoryPanel runId={run.runId} />
              <CreativePanel runId={run.runId} />
            </>
          )}

          {intent === "replicate" && <AdFactoryPanel runId={run.runId} />}

          {intent === "social" && <ContentCalendar runId={run.runId} />}

          {intent === "onboarding" && <OnboardingCanvas runId={run.runId} />}

          {/* compounding brain — only renders when it knows something */}
          {company && <BrainPanel company={company} />}

          {/* live activity + analytics */}
          <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
            <EventFeed runId={run.runId} />
            <LiveMetrics runId={run.runId} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// CampaignControl — the 24/7 watch toggle. `active` campaign === the cron keeps
// re-sourcing + drafting overnight. Renders only for outbound/outreach runs that
// actually have a campaign behind them.
// ----------------------------------------------------------------------------
function CampaignControl({ runId, intent }: { runId: Id<"runs">; intent: Capability }) {
  const campaign = useQuery(campaignForRunRef, { runId }) as CampaignDoc | null | undefined;
  const setStatus = useMutation(setCampaignStatusRef);

  if (intent !== "outbound" && intent !== "outreach") return null;
  if (!campaign) return null;

  const active = campaign.status === "active";
  const toggle = () =>
    setStatus({ campaignId: campaign._id, status: active ? "paused" : "active" }).catch(() => {});

  return (
    <button
      onClick={toggle}
      className={cn(
        "inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? "border-good/40 bg-good/10 text-good"
          : "border-line bg-panel/60 text-white/60 hover:border-accent/40 hover:text-white",
      )}
      title={active ? "24/7 watch is on — click to pause" : "Turn on the 24/7 watch"}
    >
      <span className={cn("relative flex h-2 w-2")}>
        {active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good/70" />}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", active ? "bg-good" : "bg-white/30")} />
      </span>
      {active ? "24/7 watch on" : "Start 24/7 watch"}
    </button>
  );
}

// ----------------------------------------------------------------------------
// CanvasEmpty — the tasteful idle state (no clutter): the product's capabilities.
// ----------------------------------------------------------------------------
function CanvasEmpty({ hasConversation }: { hasConversation: boolean }) {
  const caps = ROUTER_INTENTS.filter((r) =>
    (CAPABILITIES as readonly string[]).includes(r.intent),
  );
  return (
    <div className="relative grid h-full place-items-center overflow-hidden px-6">
      <div className="grid-bg pointer-events-none absolute inset-0 -z-10 opacity-60" />
      <div className="w-full max-w-lg text-center animate-fade-up">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel">
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-accent">
            <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <h2 className="mt-4 text-lg font-semibold tracking-tight">The live canvas</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">
          {hasConversation
            ? "Send a message — the swarm spins up here, live."
            : "Whatever you ask, the work renders here as it happens."}
        </p>
        <div className="mt-6 grid gap-2 text-left sm:grid-cols-2">
          {caps.map((c) => (
            <div key={c.intent} className="rounded-xl border border-line bg-panel/50 p-3">
              <p className="text-[12.5px] font-semibold text-white/80">{c.title}</p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-white/40">{c.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
