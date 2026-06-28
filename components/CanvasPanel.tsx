"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CAPABILITIES,
  ROUTER_INTENTS,
  type Capability,
} from "@/lib/contract";
import { cn } from "@/lib/utils";
import CanvasGhost from "./CanvasGhost";
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

// Mode identity: a short, scannable name + the board noun it renders + the
// pastel breadcrumb colour. Echoes the "Pipeline · Kanban" wayfinding pattern.
const MODE_META: Record<Capability, { label: string; board: string; dot: string }> = {
  analyze: { label: "Full Sweep", board: "Overview", dot: "bg-block-lime" },
  discovery: { label: "Discovery", board: "Threads", dot: "bg-block-mint" },
  outbound: { label: "Outbound", board: "Pipeline", dot: "bg-block-lilac" },
  outreach: { label: "Outreach", board: "Pipeline", dot: "bg-block-coral" },
  competitor: { label: "Ad Intel", board: "Gallery", dot: "bg-block-pink" },
  content: { label: "Ad Factory", board: "Studio", dot: "bg-block-cream" },
  replicate: { label: "Replicate", board: "Studio", dot: "bg-block-cream" },
  social: { label: "Social", board: "Calendar", dot: "bg-block-navy" },
  onboarding: { label: "Onboarding", board: "Tour", dot: "bg-block-lilac" },
};

function modeMeta(intent: Capability) {
  return MODE_META[intent] ?? MODE_META.analyze;
}

// Honour the user's motion preference so the morph never fights accessibility.
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return reduced;
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

  const reducedMotion = usePrefersReducedMotion();

  // MORPH, don't swap. Wrap any mode change in the View Transitions API so the
  // outgoing board fades while the incoming one scales in. Always feature-detect
  // and never throw — a failed transition must still complete the state change.
  const morph = useCallback(
    (apply: () => void) => {
      const start =
        !reducedMotion &&
        typeof document !== "undefined" &&
        typeof (document as Document & {
          startViewTransition?: (cb: () => void) => unknown;
        }).startViewTransition === "function"
          ? (document as Document & {
              startViewTransition: (cb: () => void) => unknown;
            }).startViewTransition.bind(document)
          : null;
      if (!start) {
        apply();
        return;
      }
      try {
        start(() => flushSync(apply));
      } catch {
        apply();
      }
    },
    [reducedMotion],
  );

  const morphView = useCallback(
    (next: CanvasView) => morph(() => setView(next)),
    [morph, setView],
  );

  const morphFocus = useMemo(
    () =>
      onFocusRun
        ? (runId: Id<"runs"> | undefined, intent?: string) =>
            morph(() => onFocusRun(runId, intent))
        : undefined,
    [morph, onFocusRun],
  );

  // Restore scroll position when the user returns to a previously-seen board —
  // what makes the morph feel "smart" instead of stateless. Keyed by morphKey,
  // and held in a ref so it survives the keyed remount of the board container.
  const scrollMem = useRef<Map<string, number>>(new Map());

  // One key per distinct board view. Changing it remounts the board container,
  // which is what triggers the incoming scale-in (and gives us a restore point).
  const morphKey =
    view === "brain"
      ? "brain"
      : activeRun
        ? `run:${activeRun.runId}`
        : "empty";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CanvasHeader
        view={view}
        onView={morphView}
        runs={runs}
        activeRun={activeRun}
        onFocusRun={morphFocus}
      />
      <div className="min-h-0 flex-1">
        <div
          key={morphKey}
          className={cn("h-full min-h-0", !reducedMotion && "animate-scale-in")}
        >
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
              onFocusRun={morphFocus}
              scrollMem={scrollMem}
              scrollKey={morphKey}
            />
          ) : (
            <CanvasGhost
              hasConversation={!!conversationId}
              reducedMotion={reducedMotion}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// CanvasHeader — Tier-1 glass chrome bar. Carries the persistent MODE IDENTITY
// PILL (top-left, "you are here" + chevron quick-switcher), a faded ⌘K hint, and
// the Run | Brain lens toggle. Glass goes here (chrome you look through) — never
// on the boards below (content you read).
// ----------------------------------------------------------------------------
function CanvasHeader({
  view,
  onView,
  runs,
  activeRun,
  onFocusRun,
}: {
  view: CanvasView;
  onView: (view: CanvasView) => void;
  runs: RunRef[];
  activeRun: RunRef | null;
  onFocusRun?: (runId: Id<"runs"> | undefined, intent?: string) => void;
}) {
  return (
    <header className="glass-1 relative z-10 flex items-center justify-between gap-3 px-4 py-2">
      <ModeIdentityPill
        view={view}
        onView={onView}
        runs={runs}
        activeRun={activeRun}
        onFocusRun={onFocusRun}
      />
      <div className="flex items-center gap-2">
        <CmdKHint />
        <div className="inline-flex rounded-pill border border-hairline bg-canvas/70 p-0.5 text-[11px] font-fig-link">
          <LensTab active={view === "run"} onClick={() => onView("run")}>
            Run
          </LensTab>
          <LensTab active={view === "brain"} onClick={() => onView("brain")}>
            Brain
          </LensTab>
        </div>
      </div>
    </header>
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
        "rounded-pill px-2.5 py-1 transition-colors",
        active ? "bg-primary text-on-primary" : "text-ink hover:bg-surface-soft",
      )}
    >
      {children}
    </button>
  );
}

// ----------------------------------------------------------------------------
// ModeIdentityPill — the persistent "Pipeline · Kanban ⌄" wayfinder. Answers
// "what mode am I in?" at a glance and doubles as a quick-switcher across every
// run in the conversation plus the Brain lens. A live-dot rides the pill while
// the active run's swarm is still running.
// ----------------------------------------------------------------------------
function ModeIdentityPill({
  view,
  onView,
  runs,
  activeRun,
  onFocusRun,
}: {
  view: CanvasView;
  onView: (view: CanvasView) => void;
  runs: RunRef[];
  activeRun: RunRef | null;
  onFocusRun?: (runId: Id<"runs"> | undefined, intent?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside-click / Escape — standard popover hygiene.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const inRun = view === "run" && !!activeRun;
  const meta = inRun ? modeMeta(activeRun!.intent) : null;
  const label = inRun ? meta!.label : "Brain";
  const board = inRun ? meta!.board : "Knowledge";
  const dot = inRun ? meta!.dot : "bg-block-navy";

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-pill border border-hairline bg-canvas/70 px-3 py-1.5 text-[12px] font-fig-link text-ink transition-colors hover:bg-surface-soft"
      >
        {inRun ? (
          <LiveDot runId={activeRun!.runId} dot={dot} />
        ) : (
          <span className={cn("h-2.5 w-2.5 rounded-full ring-2 ring-canvas", dot)} />
        )}
        <span className="text-ink">{label}</span>
        <span className="text-ink/35">·</span>
        <span className="text-ink/60">{board}</span>
        <svg
          viewBox="0 0 16 16"
          className={cn(
            "h-3.5 w-3.5 text-ink/45 transition-transform",
            open && "rotate-180",
          )}
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="glass-2 absolute left-0 top-[calc(100%+6px)] z-20 w-60 animate-scale-in overflow-hidden rounded-lg p-1"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-ink/45">
            Switch board
          </p>
          {runs.length === 0 && (
            <p className="px-2.5 py-2 text-[11.5px] leading-snug text-ink/55">
              No runs yet — message the chat to spin one up.
            </p>
          )}
          {runs
            .slice()
            .reverse()
            .map((r) => {
              const m = modeMeta(r.intent);
              const active = view === "run" && activeRun?.runId === r.runId;
              return (
                <button
                  key={r.runId}
                  role="menuitem"
                  onClick={() => {
                    if (view !== "run") onView("run");
                    onFocusRun?.(r.runId, r.intent);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                    active ? "bg-surface-soft" : "hover:bg-surface-soft/70",
                  )}
                >
                  <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", m.dot)} />
                  <span className="truncate text-ink">{m.label}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-ink/45">
                    {m.board}
                  </span>
                </button>
              );
            })}
          <div className="my-1 h-px bg-hairline" />
          <button
            role="menuitem"
            onClick={() => {
              onView("brain");
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
              view === "brain" ? "bg-surface-soft" : "hover:bg-surface-soft/70",
            )}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-block-navy" />
            <span className="truncate text-ink">Brain</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-ink/45">
              Knowledge
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// LiveDot — pulses while the run is still working; settles to a calm breadcrumb
// once it completes. Read-only query; never affects run behaviour.
function LiveDot({ runId, dot }: { runId: Id<"runs">; dot: string }) {
  const run = useQuery(api.runs.getRun, { runId });
  const live = run?.status === "running";
  return (
    <span className="relative flex h-2.5 w-2.5">
      {live && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-70",
            dot,
          )}
        />
      )}
      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-canvas", dot)} />
    </span>
  );
}

// CmdKHint — a faded ⌘K affordance that retires after first use (persisted).
// It does NOT own the palette; it just dispatches an open-intent the palette
// layer can listen for, and fades once the user discovers the shortcut.
const CMDK_SEEN_KEY = "intercept:cmdk-seen";

function CmdKHint() {
  const [seen, setSeen] = useState(true);

  useEffect(() => {
    let dismissed = true;
    try {
      dismissed = window.localStorage.getItem(CMDK_SEEN_KEY) === "1";
    } catch {
      /* private mode — just keep it hidden */
    }
    setSeen(dismissed);

    if (dismissed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dismiss = () => {
    setSeen(true);
    try {
      window.localStorage.setItem(CMDK_SEEN_KEY, "1");
      window.dispatchEvent(new CustomEvent("intercept:open-command-palette"));
    } catch {
      /* never break the header */
    }
  };

  if (seen) return null;

  return (
    <button
      onClick={dismiss}
      title="Command palette"
      className="hidden items-center gap-1 rounded-pill border border-hairline bg-canvas/60 px-2 py-1 text-[10.5px] text-ink/50 transition-colors hover:text-ink sm:inline-flex"
    >
      <kbd className="font-fig-mono text-[10px] text-ink/60">⌘K</kbd>
      <span>for everything</span>
    </button>
  );
}

function CanvasForRun({
  run,
  runs,
  focusedRunId,
  onFocusRun,
  scrollMem,
  scrollKey,
}: {
  run: RunRef;
  runs: RunRef[];
  focusedRunId: Id<"runs"> | null;
  onFocusRun?: (runId: Id<"runs"> | undefined, intent?: string) => void;
  scrollMem: React.MutableRefObject<Map<string, number>>;
  scrollKey: string;
}) {
  const runDoc = useQuery(api.runs.getRun, { runId: run.runId });
  const brief = useQuery(api.brief.getBrief, { runId: run.runId });
  const intent = asCapability(runDoc?.intent ?? run.intent);
  const company = runDoc?.company ?? runDoc?.input ?? "";

  // Restore the saved scroll offset for this board on (re)mount; persist it as
  // the user scrolls so returning to a mode lands exactly where they left off.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = scrollMem.current.get(scrollKey) ?? 0;
  }, [scrollKey, scrollMem]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) scrollMem.current.set(scrollKey, el.scrollTop);
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="col-scroll h-full min-h-0 overflow-y-auto"
    >
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
                    "rounded-pill px-2.5 py-1 text-[11px] font-fig-link transition-colors",
                    active
                      ? "bg-primary text-on-primary"
                      : "border border-hairline bg-canvas text-ink hover:bg-surface-soft",
                  )}
                >
                  {capabilityTitle(r.intent).split(" ")[0]}
                </button>
              );
            })}
            {focusedRunId && runs[runs.length - 1]?.runId !== focusedRunId && (
              <button
                onClick={() => onFocusRun?.(undefined)}
                className="ml-1 rounded-full px-2.5 py-1 text-[11px] text-ink hover:bg-surface-soft"
              >
                Jump to latest →
              </button>
            )}
          </div>
        )}

        {/* capability header */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="eyebrow rounded-pill bg-surface-soft px-3 py-1 text-[11px] text-ink">
              {capabilityTitle(intent)}
            </span>
            {company && <span className="truncate text-[13px] text-ink">{company}</span>}
          </div>
          <CampaignControl runId={run.runId} intent={intent} />
        </div>

        {/* ICP / positioning strip */}
        {brief && (brief.icp || brief.positioning) && (
          <div className="mb-4 grid gap-3 rounded-lg bg-block-lime p-lg text-ink sm:grid-cols-2">
            <div>
              <p className="eyebrow text-ink">Ideal customer</p>
              <p className="mt-1 text-[15px] leading-relaxed text-ink">{brief.icp}</p>
            </div>
            {brief.positioning && (
              <div className="sm:border-l sm:border-ink/15 sm:pl-4">
                <p className="eyebrow text-ink">Positioning</p>
                <p className="mt-1 text-[15px] leading-relaxed text-ink">{brief.positioning}</p>
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
        "inline-flex items-center gap-2 rounded-pill px-3 py-1.5 text-[12px] font-fig-link transition-colors",
        active
          ? "bg-block-mint text-ink"
          : "bg-accent-magenta text-on-primary hover:opacity-90",
      )}
      title={active ? "24/7 watch is on — click to pause" : "Turn on the 24/7 watch"}
    >
      <span className={cn("relative flex h-2 w-2", active ? "text-success" : "text-on-primary")}>
        {active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full bg-current")} />
      </span>
      {active ? "24/7 watch on" : "Start 24/7 watch"}
    </button>
  );
}

