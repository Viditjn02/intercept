"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import CommandSidebar from "@/components/CommandSidebar";
import ChatPanel from "@/components/ChatPanel";
import CanvasPanel, { type CanvasView } from "@/components/CanvasPanel";
import CommandPalette from "@/components/CommandPalette";
import PanelBoundary from "@/components/ErrorBoundary";
import BlipCompanion from "@/components/blip/BlipCompanion";
import DashboardHome from "@/components/DashboardHome";
import QuickActions from "@/components/QuickActions";
import CommandBar from "@/components/CommandBar";
import EmailDesigner from "@/components/EmailDesigner";
import ConversationSimulator from "@/components/ConversationSimulator";
import TargetGate from "@/components/TargetGate";
import { sendMessageRef } from "@/components/chatApi";
import { type Capability, type Intent, spawnsRun } from "@/lib/contract";
import { cn } from "@/lib/utils";

// ============================================================================
// INTERCEPT — the GTM COMMAND CENTER.
//
// Two surfaces, ONE clean left column (CommandSidebar — Blip + the 7 canonical
// tracks + recent chats), switched in place:
//
//   • "dashboard" (the LANDING) — the command center. Live per-track node stat
//     cards + the live agent feed (DashboardHome), the fire-a-play quick-action
//     menu (QuickActions), an editable Target-URL chip (the convex `settings`
//     singleton every play fires against), and the bottom CommandBar.
//
//   • "workspace" — the AI-native chat (ChatPanel) + the live work canvas
//     (CanvasPanel) that follows the conversation / a fired run and renders the
//     boards for whatever capability is in focus. Runs, the dossier Share, and
//     the Brain lens all keep working.
//
// Firing a play (a quick-action card, a dashboard node, or a sidebar track row)
// calls `runs.createRun({ intent, input: targetUrl, inputType: "url",
// trigger: "manual" })` and drills straight into that run's board in the
// workspace. The CommandBar hands free-text to the existing chat router.
// ============================================================================

// Out-of-the-box default if the settings singleton hasn't resolved yet (mirrors
// convex/settings.ts#DEFAULT_TARGET_URL; kept as a literal so we don't import a
// convex server module into the client bundle).
const FALLBACK_TARGET = "nolongerjobless.com";

type Surface = "dashboard" | "workspace";

export default function Home() {
  const [surface, setSurface] = useState<Surface>("dashboard");
  const [conversationId, setConversationId] = useState<Id<"conversations"> | null>(null);
  const [focusedRunId, setFocusedRunId] = useState<Id<"runs"> | null>(null);
  const [activeTrack, setActiveTrack] = useState<Intent | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [canvasView, setCanvasView] = useState<CanvasView>("run");
  // The workspace shows a FULL-WIDTH canvas; the chat history / full sequence is
  // opt-in via this right-hand drawer (reuses ChatPanel), not a permanent column.
  const [historyOpen, setHistoryOpen] = useState(false);

  // The persisted default target URL (always populated — getSettings seeds it).
  const settings = useQuery(api.settings.getSettings, {});
  const setTargetUrl = useMutation(api.settings.setTargetUrl);
  const targetUrl = settings?.targetUrl ?? "";

  const createRun = useMutation(api.runs.createRun);
  const send = useMutation(sendMessageRef);

  // Latest runs (newest-first). Lets the sidebar track rows NAVIGATE to a track's
  // existing work instead of always starting a brand-new run. (Convex shares this
  // subscription with the dashboard's identical listRuns query — no extra cost.)
  const runs = useQuery(api.runs.listRuns, {}) as Doc<"runs">[] | undefined;

  // ── navigation helpers ────────────────────────────────────────────────────
  const goDashboard = useCallback(() => {
    setSurface("dashboard");
    setActiveTrack(null);
    setCanvasView("run");
    setHistoryOpen(false);
  }, []);

  const selectConversation = useCallback((id: Id<"conversations">) => {
    setConversationId(id);
    setFocusedRunId(null); // each conversation follows its own latest run
    setActiveTrack(null);
    setCanvasView("run");
    setSurface("workspace");
    setHistoryOpen(true); // picking a PAST conversation reveals its transcript/history
  }, []);

  const newChat = useCallback(() => {
    setConversationId(null);
    setFocusedRunId(null);
    setActiveTrack(null);
    setCanvasView("run");
    setSurface("workspace");
  }, []);

  const openBrain = useCallback(() => {
    setCanvasView("brain");
    setSurface("workspace");
  }, []);

  // The hackathon radar — its own global surface (like the Brain lens). It's
  // independent of the focused run / target, so we don't touch focusedRunId /
  // activeTrack; just flip the canvas to the radar lens in the workspace.
  const openRadar = useCallback(() => {
    setCanvasView("radar");
    setSurface("workspace");
  }, []);

  // A focused run changed inside the canvas (its mode switcher) — keep the
  // sidebar's active track in sync.
  const focusRun = useCallback((runId: Id<"runs"> | undefined, intent?: string) => {
    setFocusedRunId(runId ?? null);
    if (intent && spawnsRun(intent as Intent)) setActiveTrack(intent as Intent);
  }, []);

  // ── fire a play: one click → a manual run against the default target → drill
  // straight into that track's board in the workspace ───────────────────────
  const fireTrack = useCallback(
    async (intent: Intent) => {
      if (!spawnsRun(intent)) return; // brain/chat never spawn a run
      const input = (targetUrl || FALLBACK_TARGET).trim();
      try {
        const runId = await createRun({
          intent: intent as Capability,
          input,
          inputType: "url",
          trigger: "manual",
        });
        setConversationId(null);
        setFocusedRunId(runId);
        setActiveTrack(intent);
        setCanvasView("run");
        setSurface("workspace");
      } catch {
        /* createRun validates input at the boundary; never break navigation */
      }
    },
    [targetUrl, createRun],
  );

  // Drill into an EXISTING latest run for a track (from a dashboard node).
  const openRun = useCallback((runId: Id<"runs">, intent: Capability) => {
    setConversationId(null);
    setFocusedRunId(runId);
    setActiveTrack(intent);
    setCanvasView("run");
    setSurface("workspace");
  }, []);

  // Sidebar track nav = "take me to that track's work". If a run already exists
  // for the intent, SHOW its latest board (consistent with the dashboard nodes);
  // only start a fresh run when there's nothing there yet. (Quick-action cards
  // still always FIRE — that's the explicit "run this play now" gesture.)
  const goToTrack = useCallback(
    (intent: Intent) => {
      if (!spawnsRun(intent)) return; // brain/chat never spawn a run
      const latest = (runs ?? []).find((r) => r.intent === intent);
      if (latest) openRun(latest._id, intent);
      else void fireTrack(intent);
    },
    [runs, openRun, fireTrack],
  );

  // ── CommandBar → existing chat router (send) ───────────────────────────────
  // Throwing keeps the CommandBar's draft so the user can retry; on success we
  // hand off to the conversation in the workspace.
  const handleCommand = useCallback(
    async (text: string) => {
      const res = await send({ conversationId: conversationId ?? undefined, text });
      if (res?.conversationId) setConversationId(res.conversationId);
      setFocusedRunId(null);
      setActiveTrack(null);
      setCanvasView("run");
      setSurface("workspace");
    },
    [send, conversationId],
  );

  const openPalette = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      window.dispatchEvent(new CustomEvent("intercept:open-command-palette"));
    } catch {
      /* never break the UI */
    }
  }, []);

  return (
    <main className="flex h-[100dvh] w-full overflow-hidden bg-canvas text-ink">
      <PanelBoundary label="Loading the command center…">
        <CommandSidebar
          surface={surface}
          onHome={goDashboard}
          activeId={conversationId}
          onSelectConversation={selectConversation}
          onNewChat={newChat}
          onSelectTrack={goToTrack}
          activeTrack={activeTrack}
          brainActive={surface === "workspace" && canvasView === "brain"}
          onOpenBrain={openBrain}
          radarActive={surface === "workspace" && canvasView === "radar"}
          onOpenRadar={openRadar}
          focusedRunId={focusedRunId}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          onOpenPalette={openPalette}
        />
      </PanelBoundary>

      {surface === "dashboard" ? (
        <DashboardSurface
          targetUrl={targetUrl}
          onSaveTarget={(next) => setTargetUrl({ targetUrl: next })}
          onOpenTrack={fireTrack}
          onOpenRun={openRun}
          onOpenBrain={openBrain}
          onCommand={handleCommand}
        />
      ) : (
        <div className="relative min-w-0 flex-1">
          {/* FULL-WIDTH live canvas — the boards take the whole surface. No
              permanent chat column; the run just runs in front of you. */}
          <PanelBoundary label="Waking the canvas…">
            <CanvasPanel
              conversationId={conversationId}
              focusedRunId={focusedRunId}
              onFocusRun={focusRun}
              view={canvasView}
              onView={setCanvasView}
            />
          </PanelBoundary>

          {/* Floating command bar over the canvas (mirrors the dashboard). */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <CommandBar targetUrl={targetUrl} onSubmit={handleCommand} />
          </div>

          {/* Run transcript — opt-in READ-ONLY history drawer (bottom-left so it
              clears the centred command bar + the corner Blip). Distinct from the
              command bar: the bar is where you TYPE; this is the record of what
              ran. */}
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            title="Open the run transcript — a read-only history of this conversation + run. Type new commands in the command bar below."
            className="glass-1 pointer-events-auto absolute bottom-6 left-4 z-30 inline-flex items-center gap-1.5 rounded-pill border border-hairline px-3 py-2 text-[12px] font-fig-link text-ink shadow-glass-1 transition-colors hover:bg-surface-soft"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-ink/60" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            Transcript
          </button>

          {/* The chat history / full sequence as a right slide-over (reuses
              ChatPanel). Default closed: the user just watches the task run. */}
          {historyOpen && (
            <div className="absolute inset-0 z-40 flex">
              <button
                type="button"
                aria-label="Close history"
                onClick={() => setHistoryOpen(false)}
                className="flex-1 bg-ink/15 backdrop-blur-[1px]"
              />
              <aside className="animate-drawer-in glass-1 flex h-full w-full max-w-[440px] flex-col border-l border-hairline">
                <header className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2.5">
                  <div className="flex flex-col">
                    <span className="font-fig-card text-[12.5px] tracking-tight text-ink">
                      Run transcript
                    </span>
                    <span className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink/45">
                      Read-only history · type in the command bar
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(false)}
                    aria-label="Close"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-ink/55 transition-colors hover:bg-canvas hover:text-ink"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </header>
                <div className="min-h-0 flex-1">
                  <PanelBoundary label="Loading the chat…">
                    <ChatPanel
                      conversationId={conversationId}
                      setConversationId={(id) => setConversationId(id)}
                      focusedRunId={focusedRunId}
                      onFocusRun={focusRun}
                    />
                  </PanelBoundary>
                </div>
              </aside>
            </div>
          )}
        </div>
      )}

      {/* Blip — the fixed bottom-right companion. Shown ONLY when the sidebar is
          collapsed (the sidebar Blip takes over when expanded), so exactly one
          Blip is ever visible. Pure delight; pointer-events-none except the sprite. */}
      <BlipCompanion
        runId={focusedRunId}
        conversationId={conversationId}
        onFocusRun={focusRun}
        onOpenBrain={openBrain}
        hidden={!collapsed}
      />

      {/* ⌘K command palette — mounted once; owns its own global listener. */}
      <CommandPalette
        conversationId={conversationId}
        canvasView={canvasView}
        sidebarCollapsed={collapsed}
        onConversation={(id) => (id ? selectConversation(id) : newChat())}
        onSetCanvasView={(v) => {
          setCanvasView(v);
          setSurface("workspace");
        }}
        onToggleSidebar={() => setCollapsed((v) => !v)}
      />

      {/* Email Designer — a global drawer; opens on the outreach "Design email"
          action (intercept:open-email-designer). Renders nothing until then. */}
      <EmailDesigner />

      {/* Conversation Simulator — a global modal; opens on a prospect card's
          "Simulate" action (intercept:simulate-convo). Renders nothing until then. */}
      <ConversationSimulator />

      {/* Target Gate — the PUBLIC-ONLY welcome overlay. Self-gates on
          NEXT_PUBLIC_PUBLIC_MODE === "1" + an unconfigured browser, so on local
          (env unset) and for returning visitors it renders NOTHING. */}
      <TargetGate />
    </main>
  );
}

// ----------------------------------------------------------------------------
// AutonomyToggle — the 24/7 switch, made PROMINENT + self-explaining (founder
// didn't notice it / "no one would understand what it is"). A clearly-labeled
// "Autonomous · 24/7" pill with an obvious sliding ON/OFF switch, a live caption
// under the label, and a hover tooltip explaining what it does. Reads/writes the
// convex `settings` singleton directly; on toggle it also asks Blip to explain.
//   ON  → INTERCEPT keeps the radar + outreach running 24/7.
//   OFF → each play runs once and stops (default).
// ----------------------------------------------------------------------------
function AutonomyToggle() {
  const settings = useQuery(api.settings.getSettings, {});
  const setAutonomous = useMutation(api.settings.setAutonomous);
  const on = settings?.autonomous ?? false;

  const toggle = () => {
    const next = !on;
    void setAutonomous({ autonomous: next }).catch(() => {});
    // Have Blip narrate the change so the switch is never a mystery.
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(
          new CustomEvent("intercept:blip-say", {
            detail: {
              text: next
                ? "24/7 mode ON — I'll keep watching + drafting."
                : "24/7 mode OFF — each play runs once.",
            },
          }),
        );
      } catch {
        /* never break the toggle if dispatch fails */
      }
    }
  };

  return (
    <div
      className={cn(
        "group relative inline-flex items-center gap-2.5 rounded-pill border px-3 py-1.5 transition-colors",
        on ? "border-success/40 bg-success/10" : "border-hairline bg-surface-soft",
      )}
    >
      <div className="flex flex-col leading-none">
        <span className="font-fig-card text-[12px] tracking-tight text-ink">
          Autonomous · 24/7
        </span>
        <span
          className={cn(
            "mt-1 font-mono text-[9px] uppercase tracking-wide",
            on ? "text-success" : "text-ink/45",
          )}
        >
          {on ? "On · running 24/7" : "Off · runs once"}
        </span>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Autonomous 24/7 mode"
        onClick={toggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20",
          on ? "bg-success" : "bg-ink/20",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
            on ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </button>

      {/* hover/focus caption — explains what the switch actually does */}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute right-0 top-full z-50 mt-2 w-60 rounded-lg border border-hairline",
          "bg-canvas px-3 py-2 text-[11px] leading-snug text-ink/70 shadow-glass-1",
          "opacity-0 transition-opacity duration-150 group-hover:opacity-100",
        )}
      >
        Keeps the radar + outreach running 24/7. Off: each play runs once and stops.
      </span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// DashboardSurface — the LANDING. Editable Target chip on top, the live node
// stat cards + agent feed (DashboardHome) above the fire-a-play quick-action
// menu (QuickActions), and the floating CommandBar pinned to the bottom.
// ----------------------------------------------------------------------------
function DashboardSurface({
  targetUrl,
  onSaveTarget,
  onOpenTrack,
  onOpenRun,
  onOpenBrain,
  onCommand,
}: {
  targetUrl: string;
  onSaveTarget: (next: string) => void | Promise<unknown>;
  onOpenTrack: (intent: Capability) => void;
  onOpenRun: (runId: Id<"runs">, intent: Capability) => void;
  onOpenBrain: () => void;
  onCommand: (text: string) => void | Promise<void>;
}) {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-6 py-2.5">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink/45">
          INTERCEPT · GTM Command Center
        </p>
        <div className="flex items-center gap-2">
          <AutonomyToggle />
          <TargetChip value={targetUrl} onSave={onSaveTarget} />
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {/* The COMPACT node cards + the fire-a-play menu share ONE scroll (the
            menu is passed as children), with the live-activity feed as a side
            rail — so the cards are never trapped in a cramped inner scroll.
            Wrapped in a boundary so any query throw degrades, never white-screens. */}
        <PanelBoundary label="Loading the command center…">
          <DashboardHome
            onOpenTrack={onOpenTrack}
            onOpenRun={onOpenRun}
            onOpenBrain={onOpenBrain}
            targetUrl={targetUrl}
          >
            <QuickActions onFire={onOpenTrack} targetUrl={targetUrl} />
          </DashboardHome>
        </PanelBoundary>

        {/* floating command bar */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
          <CommandBar targetUrl={targetUrl} onSubmit={onCommand} />
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// TargetChip — the editable Target-URL control. Reads the convex `settings`
// singleton (passed in) and persists edits via `settings.setTargetUrl`. Light
// editorial pill; click to edit, Enter / Save to persist, Esc / blur to cancel.
// ----------------------------------------------------------------------------
function TargetChip({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => void | Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  // Keep the draft synced to the persisted value whenever we're not editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) {
      try {
        await onSave(next);
      } catch {
        /* setTargetUrl never throws for the caller; ignore defensively */
      }
    }
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill border border-ink/25 bg-canvas px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink/40">
          Target
        </span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={() => void commit()}
          placeholder="example.com"
          spellCheck={false}
          autoComplete="off"
          aria-label="Target business URL"
          className="w-44 bg-transparent font-mono text-[12.5px] text-ink placeholder:text-ink/30 focus:outline-none"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void commit()}
          className="rounded-pill bg-primary px-2 py-0.5 text-[11px] font-fig-link text-on-primary"
        >
          Save
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Edit the default target — every play fires against it"
      className={cn(
        "group inline-flex items-center gap-2 rounded-pill border border-hairline bg-surface-soft px-3 py-1.5",
        "transition-colors hover:border-ink/25 hover:bg-surface-soft",
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
      <span className="font-mono text-[10px] uppercase tracking-wide text-ink/40">
        Target
      </span>
      <span className="font-mono text-[12.5px] text-ink/85">
        {value || FALLBACK_TARGET}
      </span>
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 text-ink/30 transition-colors group-hover:text-ink/55"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  );
}
