"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";

// ============================================================================
// ApprovalModal — the human-in-the-loop gate.
// INTERCEPT drafts an in-thread reply, but nothing is ever posted without a human
// pressing Approve. This modal shows the drafted reply in the context of the
// real thread and calls the drafts mutation.
//
// Expected backend (owned by the drafts agent):
//   api.drafts.setStatus({ draftId, status }) : mutation
//     status ∈ "approved" | "rejected" | "posted"
// ============================================================================

interface ApprovalModalProps {
  draft: Doc<"drafts">;
  thread?: Doc<"threads"> | null;
  onClose: () => void;
}

function confidencePct(confidence: number): number {
  return Math.max(0, Math.min(100, Math.round(confidence * 100)));
}

export default function ApprovalModal({ draft, thread, onClose }: ApprovalModalProps) {
  const setStatus = useMutation(api.drafts.setStatus);
  const [pending, setPending] = useState<null | "approved" | "rejected">(null);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (pending) return;
    onClose();
  }, [pending, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [close]);

  const act = useCallback(
    async (status: "approved" | "rejected") => {
      setError(null);
      setPending(status);
      try {
        await setStatus({ draftId: draft._id, status });
        onClose();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
        setPending(null);
      }
    },
    [setStatus, draft._id, onClose],
  );

  const pct = confidencePct(draft.confidence);
  const decided = draft.status === "approved" || draft.status === "rejected" || draft.status === "posted";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Review drafted reply"
      onClick={close}
    >
      <div
        className="relative flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
              Human approval gate
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-zinc-50">
              {thread?.title ?? "Drafted in-thread reply"}
            </h2>
            {thread && (
              <a
                href={thread.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-accent"
              >
                View the live thread
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M7 17 17 7" />
                  <path d="M7 7h10v10" />
                </svg>
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            disabled={!!pending}
            className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-line/40 hover:text-zinc-200 disabled:opacity-40"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>

        {/* Reply preview */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500">Drafted reply</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">Confidence</span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-good transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-8 text-right text-xs font-semibold tabular-nums text-good">
                {pct}%
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-ink/60 p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
              {draft.body}
            </p>
          </div>

          <p className="mt-3 text-xs text-zinc-500">
            Nothing is posted automatically. Approving marks this reply ready to post in the live
            thread; rejecting discards it.
          </p>

          {error && (
            <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 ring-1 ring-red-500/30">
              {error}
            </p>
          )}
        </div>

        {/* Actions */}
        <footer className="flex items-center justify-end gap-3 border-t border-line px-6 py-4">
          {decided ? (
            <span className="mr-auto text-sm text-zinc-400">
              Already {draft.status.replace("_", " ")}.
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => act("rejected")}
            disabled={!!pending || decided}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-300 ring-1 ring-line transition-colors hover:bg-line/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending === "rejected" ? "Rejecting…" : "Reject"}
          </button>
          <button
            type="button"
            onClick={() => act("approved")}
            disabled={!!pending || decided}
            className="inline-flex items-center gap-2 rounded-lg bg-good px-5 py-2 text-sm font-semibold text-ink transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "approved" ? (
              "Approving…"
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Approve reply
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}
