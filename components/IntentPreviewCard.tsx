"use client";

import { useCallback, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

// ============================================================================
// IntentPreviewCard — the LAST gate before any external-effect action fires.
// INTERCEPT never fires-and-forgets: before a real send leaves the building
// (AgentMail reply, Composio schedule) the agent surfaces a compact chat-style
// card that summarizes EXACTLY what is about to happen — channel, recipient,
// subject, and the body — plus three deliberate choices:
//
//   • Send Now → commit the action (here: api.outreach.sendApprovedDraft)
//   • Edit     → back out to revise (host decides — usually closes the gate)
//   • Skip     → don't send (host decides — usually discards/rejects the draft)
//
// The card is editorial-flat (content you READ — never glass): 1px border, soft
// surface, crisp text. It self-gates on the server's approval truth and degrades
// gracefully — with no AgentMail key the action no-ops and the card shows a quiet
// "not configured" note instead of throwing.
// ============================================================================

type SendChannel = "AgentMail" | "Composio";

interface IntentPreviewCardProps {
  /** The approved draft whose send this card gates. */
  draftId: Id<"drafts">;
  /** Which external surface the action leaves through (drives the label). */
  channel?: SendChannel;
  /** Short headline for the action (e.g. the thread title). */
  title?: string;
  /** Who/where it goes (recipient, thread, audience). */
  to?: string;
  /** Optional subject line (email sends). */
  subject?: string;
  /** The content being sent — shown verbatim so there are no surprises. */
  body: string;
  /** Back out to revise. */
  onEdit: () => void;
  /** Don't send (host discards/rejects). */
  onSkip: () => void;
  /** True while the host is processing the skip. */
  skipping?: boolean;
  className?: string;
}

type SendResult = {
  sent: boolean;
  id?: string;
  alreadySent?: boolean;
  reason?: string;
};

const CHANNEL_COPY: Record<SendChannel, { verb: string; surface: string }> = {
  AgentMail: { verb: "Send", surface: "AgentMail" },
  Composio: { verb: "Schedule", surface: "Composio" },
};

export default function IntentPreviewCard({
  draftId,
  channel = "AgentMail",
  title,
  to,
  subject,
  body,
  onEdit,
  onSkip,
  skipping = false,
  className,
}: IntentPreviewCardProps) {
  const send = useAction(api.outreach.sendApprovedDraft);
  const status = useQuery(api.outreach.outreachStatus, { draftId });

  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Server-persisted truth (reactive) — the gate only opens once approved.
  const alreadySent = status?.sent === true;
  const approved = status?.approved === true;
  const copy = CHANNEL_COPY[channel];

  const onSend = useCallback(async () => {
    if (sending || alreadySent) return;
    setNote(null);
    setFailed(false);
    setSending(true);
    try {
      const result = (await send({ draftId })) as SendResult;
      if (result.sent) {
        setNote(result.alreadySent ? "Already sent." : `Sent via ${copy.surface}.`);
        setFailed(false);
      } else {
        setNote(result.reason ?? `Couldn't send — ${copy.surface} not configured.`);
        setFailed(true);
      }
    } catch (err: unknown) {
      setNote(err instanceof Error ? err.message : "Send failed. Try again.");
      setFailed(true);
    } finally {
      setSending(false);
    }
  }, [send, draftId, sending, alreadySent, copy.surface]);

  // Terminal state — the action left the building. Calm, final confirmation.
  if (alreadySent) {
    return (
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-lg border border-hairline bg-block-mint px-4 py-3 text-ink animate-scale-in",
          className,
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas text-success">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-fig-card leading-tight">Sent via {copy.surface}</p>
          {title && <p className="mt-0.5 truncate text-[11.5px] font-fig-body text-ink/70">{title}</p>}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-hairline bg-surface-soft p-4 animate-scale-in",
        className,
      )}
      role="group"
      aria-label={`Confirm before sending via ${copy.surface}`}
    >
      {/* eyebrow — names the external surface so the stakes are unmistakable */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="caption inline-flex items-center gap-1.5 rounded-full bg-canvas px-2.5 py-1 text-ink">
          <span className="live-dot text-accent-magenta" />
          About to {copy.verb.toLowerCase()} · {copy.surface}
        </span>
        {!approved && (
          <span className="caption text-ink/50">Approve first</span>
        )}
      </div>

      {/* action summary — exactly what is about to happen */}
      <div className="rounded-md border border-hairline bg-canvas p-3">
        {(title || to) && (
          <div className="mb-2 flex flex-col gap-0.5">
            {title && <p className="text-[13px] font-fig-card leading-tight text-ink">{title}</p>}
            {to && (
              <p className="text-[11.5px] font-fig-body text-ink/70">
                <span className="text-ink/45">To </span>
                {to}
              </p>
            )}
            {subject && (
              <p className="text-[11.5px] font-fig-body text-ink/70">
                <span className="text-ink/45">Subject </span>
                {subject}
              </p>
            )}
          </div>
        )}
        <p className="line-clamp-4 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/80">
          {body}
        </p>
      </div>

      {note && (
        <p className={cn("mt-2.5 text-[11.5px]", failed ? "text-ink/55" : "text-success")}>
          {note}
        </p>
      )}

      {/* the three deliberate choices */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !approved}
          title={!approved ? "Approve the reply before sending" : `${copy.verb} via ${copy.surface}`}
          className="inline-flex items-center gap-2 rounded-pill bg-accent-magenta px-5 py-2 text-sm font-fig-link text-on-primary transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin-slow rounded-full border-2 border-on-primary/40 border-t-on-primary" />
              {copy.verb}ing…
            </>
          ) : (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
              {copy.verb} Now
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={sending}
          className="rounded-pill border border-hairline bg-canvas px-4 py-2 text-sm font-fig-link text-ink transition-colors hover:bg-surface-soft disabled:opacity-40"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={sending || skipping}
          className="rounded-pill px-4 py-2 text-sm font-fig-link text-ink/60 transition-colors hover:bg-canvas hover:text-ink disabled:opacity-40"
        >
          {skipping ? "Skipping…" : "Skip"}
        </button>
      </div>
    </div>
  );
}
