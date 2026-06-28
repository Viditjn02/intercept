"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import ConversationSidebar from "@/components/ConversationSidebar";
import ChatPanel from "@/components/ChatPanel";
import CanvasPanel, { type CanvasView } from "@/components/CanvasPanel";
import CommandPalette from "@/components/CommandPalette";
import PanelBoundary from "@/components/ErrorBoundary";
import MascotCompanion from "@/components/mascot/MascotCompanion";

// ============================================================================
// INTERCEPT — the single chat+canvas surface. ONE AI-native chat (left); a live
// work canvas (right) that follows the conversation and renders whatever the
// router decided to do. A collapsible rail of past conversations on the far left.
// ============================================================================

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

      {/* Reactive delight mascot — a fixed bottom-right corner companion that
          lights up on the live swarm's wins. Pure delight, never a chat input;
          pointer-events-none except the sprite, so it never blocks the UI. */}
      <MascotCompanion
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
