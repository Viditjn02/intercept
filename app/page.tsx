"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import ConversationSidebar from "@/components/ConversationSidebar";
import type { IconRailMode } from "@/components/IconRail";
import ChatPanel from "@/components/ChatPanel";
import CanvasPanel, { type CanvasView } from "@/components/CanvasPanel";
import CommandPalette from "@/components/CommandPalette";
import PanelBoundary from "@/components/ErrorBoundary";
import BlipCompanion from "@/components/blip/BlipCompanion";

// ============================================================================
// INTERCEPT — the single chat+canvas surface. ONE AI-native chat (left); a live
// work canvas (right) that follows the conversation and renders whatever the
// router decided to do. A collapsible rail of past conversations on the far left.
// ============================================================================

// Per-rail-mode starter prompt — dropped into the composer on click so the icon
// rail is a real launcher, not decoration. "brain" is handled separately (it
// opens the knowledge graph rather than composing a prompt).
const RAIL_PROMPT: Partial<Record<IconRailMode, string>> = {
  threads: "Find where buyers are complaining about resume tools — for nolongerjobless.com",
  pipeline: "Find decision-makers and verified emails for nolongerjobless.com's ICP",
  ads: "Find competitors and scan their winning ads for nolongerjobless.com",
  calendar: "Plan a viral content calendar for nolongerjobless.com",
  onboarding: "Design a PLG onboarding flow for nolongerjobless.com",
};

export default function Home() {
  const [conversationId, setConversationId] = useState<Id<"conversations"> | null>(null);
  const [focusedRunId, setFocusedRunId] = useState<Id<"runs"> | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [canvasView, setCanvasView] = useState<CanvasView>("run");

  const selectConversation = (id: Id<"conversations"> | null) => {
    setConversationId(id);
    setFocusedRunId(null); // each conversation follows its own latest run
    setCanvasView("run"); // picking a chat returns to its live work surface
  };

  const focusRun = (runId: Id<"runs"> | undefined) => {
    setFocusedRunId(runId ?? null);
  };

  // The left icon rail: "brain" opens the knowledge graph; every other mode
  // drops that track's ready-to-run prompt into the composer (one click → the
  // swarm builds it). Pure window-event handoff to ChatPanel; never throws.
  const onSelectMode = (mode: IconRailMode) => {
    if (mode === "brain") {
      setCanvasView("brain");
      return;
    }
    setCanvasView("run");
    const text = RAIL_PROMPT[mode];
    if (text && typeof window !== "undefined") {
      try {
        window.dispatchEvent(
          new CustomEvent("intercept:compose", { detail: { text, submit: false } }),
        );
      } catch {
        /* never break navigation */
      }
    }
  };

  return (
    <main className="flex h-[100dvh] w-full overflow-hidden bg-canvas text-ink">
      <PanelBoundary label="Loading conversations…">
        <ConversationSidebar
          activeId={conversationId}
          onSelect={selectConversation}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          brainActive={canvasView === "brain"}
          onOpenBrain={() => setCanvasView("brain")}
          onSelectMode={onSelectMode}
        />
      </PanelBoundary>

      <div className="min-w-0 flex-1">
        <ResizablePanelGroup direction="horizontal" autoSaveId="intercept-split">
          <ResizablePanel defaultSize={38} minSize={28} maxSize={58} className="min-w-0">
            <PanelBoundary label="Starting the chat…">
              <ChatPanel
                conversationId={conversationId}
                setConversationId={(id) => setConversationId(id)}
                focusedRunId={focusedRunId}
                onFocusRun={focusRun}
              />
            </PanelBoundary>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize={62} minSize={42} className="min-w-0">
            <PanelBoundary label="Waking the canvas…">
              <CanvasPanel
                conversationId={conversationId}
                focusedRunId={focusedRunId}
                onFocusRun={focusRun}
                view={canvasView}
                onView={setCanvasView}
              />
            </PanelBoundary>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Blip — a fixed bottom-right corner companion that lights up on the live
          swarm's wins. Pure delight, never a chat input; pointer-events-none
          except the sprite, so it never blocks the UI. */}
      <BlipCompanion
        runId={focusedRunId}
        conversationId={conversationId}
        onFocusRun={focusRun}
        onOpenBrain={() => setCanvasView("brain")}
      />

      {/* ⌘K command palette — mounted once; owns its own global listener. The
          power + discovery layer: kick off any capability, jump conversations,
          flip the canvas lens, toggle theme/sidebar — all keyboard-first. */}
      <CommandPalette
        conversationId={conversationId}
        canvasView={canvasView}
        sidebarCollapsed={collapsed}
        onConversation={selectConversation}
        onSetCanvasView={setCanvasView}
        onToggleSidebar={() => setCollapsed((v) => !v)}
      />
    </main>
  );
}
