"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import IntentPreviewCard from "@/components/IntentPreviewCard";

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
      className="fixed inset-0 z-50 grid place-items-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Review drafted reply"
      onClick={close}
    >
      <div
        className="relative flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-hairline bg-canvas shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-5">
          <div className="min-w-0">
            <p className="caption text-ink/60">
              Human approval gate
            </p>
            <h2 className="mt-1 truncate text-lg font-fig-headline text-ink">
              {thread?.title ?? "Drafted in-thread reply"}
            </h2>
            {thread && (
              <a
                href={thread.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-ink/60 hover:text-ink"
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
            className="shrink-0 rounded-full p-1.5 text-ink/50 transition-colors hover:bg-surface-soft hover:text-ink disabled:opacity-40"
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
            <span className="caption text-ink/50">Drafted reply</span>
            <div className="flex items-center gap-2">
              <span className="caption text-ink/50">Confidence</span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-soft">
                <div
                  className="h-full rounded-full bg-success transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-8 text-right text-xs font-fig-headline tabular-nums text-success">
                {pct}%
              </span>
            </div>
          </div>

          <div className="rounded-md border border-hairline bg-surface-soft p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/80">
              {draft.body}
            </p>
          </div>

          <p className="mt-3 text-xs text-ink/50">
            Nothing is posted automatically. Approving marks this reply ready to post in the live
            thread; rejecting discards it.
          </p>

          {error && (
            <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500 ring-1 ring-red-500/30">
              {error}
            </p>
          )}

          {/* Pre-send intent gate — the LAST confirmation before this reply leaves
              via AgentMail. Surfaces only once the human has approved; Edit backs
              out to the thread, Skip discards, Send Now commits the real send. */}
          {draft.status === "approved" && (
            <div className="mt-4">
              <IntentPreviewCard
                draftId={draft._id}
                channel="AgentMail"
                title={thread?.title ?? "In-thread reply"}
                to={thread?.title ? `the “${thread.title}” thread` : undefined}
                body={draft.body}
                onEdit={onClose}
                onSkip={() => void act("rejected")}
                skipping={pending === "rejected"}
              />
            </div>
          )}
        </div>

        {/* Actions */}
        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-hairline px-6 py-4">
          <div className="mr-auto flex items-center gap-3">
            {decided ? (
              <span className="text-sm text-ink/60">
                {/* The approved send is gated by the IntentPreviewCard above. */}
                {draft.status === "approved" ? "Approved — confirm the send above." : `Already ${draft.status.replace("_", " ")}.`}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => act("rejected")}
            disabled={!!pending || decided}
            className="rounded-pill border border-hairline bg-canvas px-5 py-2 text-sm font-fig-link text-ink transition-colors hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending === "rejected" ? "Rejecting…" : "Reject"}
          </button>
          <button
            type="button"
            onClick={() => act("approved")}
            disabled={!!pending || decided}
            className="inline-flex items-center gap-2 rounded-pill bg-block-mint px-6 py-2 text-sm font-fig-link text-ink transition-colors hover:bg-block-mint/80 disabled:cursor-not-allowed disabled:opacity-50"
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
