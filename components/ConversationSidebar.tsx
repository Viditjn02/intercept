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
      return "bg-sky-400";
    case "outbound":
      return "bg-violet-400";
    case "outreach":
      return "bg-accent";
    case "competitor":
      return "bg-amber-400";
    case "content":
      return "bg-pink-400";
    case "analyze":
      return "bg-good";
    default:
      return "bg-white/30";
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

  if (collapsed) {
    return (
      <div className="flex h-full w-12 flex-col items-center gap-3 border-r border-line bg-ink/60 py-4">
        <button
          onClick={onToggle}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-white/50 transition-colors hover:border-accent/40 hover:text-white"
          aria-label="Expand sidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onNew}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-ink transition-transform hover:scale-105"
          aria-label="New chat"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="mt-auto">
          <button
            onClick={onOpenBrain}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
              brainActive
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-line text-white/50 hover:border-accent/40 hover:text-white",
            )}
            aria-label="Open the brain"
            title="The brain — compounding knowledge"
          >
            <BrainIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-64 flex-col border-r border-line bg-ink/60">
      {/* brand + collapse */}
      <div className="flex items-center justify-between px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-panel">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-accent">
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[14px] font-semibold tracking-tight">INTERCEPT</span>
        </div>
        <button
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/5 hover:text-white"
          aria-label="Collapse sidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* new chat */}
      <div className="px-3 pb-2">
        <button
          onClick={onNew}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-panel/70 px-3 py-2 text-[13px] font-medium text-white/80 transition-all hover:border-accent/40 hover:text-white disabled:opacity-50"
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
              <div key={i} className="h-11 animate-pulse rounded-lg bg-white/5" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11.5px] leading-relaxed text-white/30">
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
                      "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      active ? "bg-white/8" : "hover:bg-white/5",
                    )}
                  >
                    <span className={cn("mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full", intentDot(c.lastIntent))} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[12.5px]", active ? "text-white" : "text-white/70")}>
                        {c.title || "Untitled"}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/30">
                        <span>{intentLabel(c.lastIntent)}</span>
                        <span>·</span>
                        <span>{relativeTime(c.lastMessageAt)}</span>
                      </span>
                    </span>
                    <span
                      onClick={(e) => onDelete(e, c._id)}
                      role="button"
                      tabIndex={-1}
                      className="shrink-0 rounded p-1 text-white/0 transition-colors group-hover:text-white/30 hover:!text-red-300"
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
      <div className="border-t border-line px-3 py-2">
        <button
          onClick={onOpenBrain}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors",
            brainActive
              ? "bg-accent/10 text-accent"
              : "text-white/70 hover:bg-white/5 hover:text-white",
          )}
        >
          <BrainIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">The brain</span>
            <span className="block text-[10px] text-white/30">
              Compounding knowledge — grows every run
            </span>
          </span>
        </button>
      </div>

      <div className="border-t border-line px-3.5 py-2.5 text-[10px] text-white/25">
        Live intent radar · 24/7 outbound
      </div>
    </div>
  );
}
