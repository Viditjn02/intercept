"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { ROUTER_INTENTS } from "@/lib/contract";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import {
  createConversationRef,
  deleteConversationRef,
  listConversationsRef,
} from "./chatApi";
import type { ConversationDoc } from "./types";
import ThemeToggle from "./ThemeToggle";
import IconRail, { type IconRailMode } from "./IconRail";

// ============================================================================
// ConversationSidebar — the rail of past conversations + "New chat".
// Collapsible so the canvas can take the full width on demand.
// ============================================================================

interface ConversationSidebarProps {
  activeId: Id<"conversations"> | null;
  onSelect: (id: Id<"conversations"> | null) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** Whether the canvas is currently showing the Brain lens. */
  brainActive?: boolean;
  /** Open the compounding-knowledge Brain board on the canvas. */
  onOpenBrain?: () => void;
  /**
   * Jump the canvas to a mode from the left icon rail. Optional + graceful:
   * brain always falls back to `onOpenBrain`; modes the page hasn't wired yet
   * simply no-op (the rail still teaches name + shortcut via its tooltip).
   */
  onSelectMode?: (mode: IconRailMode) => void;
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M9 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1 4.8A2.5 2.5 0 0 0 7 16.5a2.5 2.5 0 0 0 5 .5V6.5A2.5 2.5 0 0 0 9 4.5ZM15 4.5A2.5 2.5 0 0 1 17.5 7a2.5 2.5 0 0 1 1 4.8A2.5 2.5 0 0 1 17 16.5a2.5 2.5 0 0 1-5 .5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function intentDot(intent?: string): string {
  switch (intent) {
    case "discovery":
      return "bg-block-mint";
    case "outbound":
      return "bg-block-lilac";
    case "outreach":
      return "bg-block-coral";
    case "competitor":
      return "bg-block-cream";
    case "content":
      return "bg-block-pink";
    case "analyze":
      return "bg-success";
    default:
      return "bg-ink/30";
  }
}

function intentLabel(intent?: string): string {
  if (!intent) return "Chat";
  return ROUTER_INTENTS.find((r) => r.intent === intent)?.title.split(" ")[0] ?? intent;
}

export default function ConversationSidebar({
  activeId,
  onSelect,
  collapsed,
  onToggle,
  brainActive = false,
  onOpenBrain,
  onSelectMode,
}: ConversationSidebarProps) {
  const conversations = useQuery(listConversationsRef, {}) as
    | ConversationDoc[]
    | undefined;
  const createConversation = useMutation(createConversationRef);
  const deleteConversation = useMutation(deleteConversationRef);
  const [busy, setBusy] = useState(false);

  const onNew = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await createConversation({});
      onSelect(id);
    } catch {
      // Backend not ready yet — start a blank local session; send() will create one.
      onSelect(null);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (e: React.MouseEvent, id: Id<"conversations">) => {
    e.stopPropagation();
    try {
      await deleteConversation({ conversationId: id });
    } catch {
      /* ignore */
    }
    if (id === activeId) onSelect(null);
  };

  // The left icon rail is the keyboard-free escape hatch. Brain is wired today
  // via `onOpenBrain`; everything else passes through `onSelectMode` (which the
  // page may not provide yet — graceful no-op, never throws).
  const activeMode: IconRailMode = brainActive ? "brain" : "threads";
  const onRailSelect = (mode: IconRailMode) => {
    if (mode === "brain") onOpenBrain?.();
    onSelectMode?.(mode);
  };

  if (collapsed) {
    return (
      <div className="flex h-full">
      <IconRail activeMode={activeMode} onSelect={onRailSelect} />
      <div className="glass-1 flex h-full w-12 flex-col items-center gap-3 py-4">
        <button
          onClick={onToggle}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline text-ink transition-colors hover:bg-canvas"
          aria-label="Expand sidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onNew}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-canvas text-ink border border-hairline transition-transform hover:scale-105"
          aria-label="New chat"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="mt-auto flex flex-col items-center gap-3">
          <button
            onClick={onOpenBrain}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
              brainActive
                ? "bg-primary text-on-primary"
                : "border border-hairline text-ink hover:bg-canvas",
            )}
            aria-label="Open the brain"
            title="The brain — compounding knowledge"
          >
            <BrainIcon className="h-4 w-4" />
          </button>
          <ThemeToggle />
        </div>
      </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
    <IconRail activeMode={activeMode} onSelect={onRailSelect} />
    <div className="glass-1 flex h-full w-64 flex-col">
      {/* brand + collapse */}
      <div className="flex items-center justify-between px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-canvas text-ink">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[16px] font-fig-card tracking-tight text-ink">INTERCEPT</span>
        </div>
        <button
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-full text-ink transition-colors hover:bg-canvas"
          aria-label="Collapse sidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* new chat — secondary pill (Send stays the chat's one primary) */}
      <div className="px-3 pb-2">
        <button
          onClick={onNew}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-pill border border-hairline bg-canvas px-3 py-2 text-[13px] font-fig-link text-ink transition-all hover:bg-surface-soft disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          New chat
        </button>
      </div>

      {/* list */}
      <div className="col-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations === undefined ? (
          <div className="space-y-1.5 px-1 py-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-md bg-surface-soft" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11.5px] leading-relaxed text-ink">
            No conversations yet. Start one above.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => {
              const active = c._id === activeId;
              return (
                <li key={c._id}>
                  <button
                    onClick={() => onSelect(c._id)}
                    className={cn(
                      "group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                      active ? "bg-canvas" : "hover:bg-canvas",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-white/55",
                        intentDot(c.lastIntent),
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[12.5px] text-ink", active && "font-fig-headline")}>
                        {c.title || "Untitled"}
                      </span>
                      <span className="caption mt-1 flex items-center gap-1.5 text-ink">
                        <span>{intentLabel(c.lastIntent)}</span>
                        <span>·</span>
                        <span>{relativeTime(c.lastMessageAt)}</span>
                      </span>
                    </span>
                    <span
                      onClick={(e) => onDelete(e, c._id)}
                      role="button"
                      tabIndex={-1}
                      className="shrink-0 rounded p-1 text-transparent transition-colors group-hover:text-ink/40 hover:!text-red-500"
                      aria-label="Delete conversation"
                    >
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* the brain — the compounding-knowledge board, always one click away */}
      <div className="border-t border-hairline px-3 py-2">
        <button
          onClick={onOpenBrain}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors",
            brainActive
              ? "bg-block-lilac text-ink"
              : "text-ink hover:bg-canvas",
          )}
        >
          <BrainIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block font-fig-headline">The brain</span>
            <span className="block text-[10px] text-ink">
              Compounding knowledge — grows every run
            </span>
          </span>
        </button>
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-3.5 py-2.5">
        <span className="caption text-ink">Live intent radar · 24/7</span>
        <ThemeToggle />
      </div>
    </div>
    </div>
  );
}
