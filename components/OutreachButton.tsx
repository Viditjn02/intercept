"use client";

import { useCallback, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// ============================================================================
// OutreachButton — the AgentMail send beat.
// Sends the human-APPROVED in-thread reply as a real email / follow-up via
// AgentMail. Nothing is sent without prior human approval (the action enforces
// it server-side too) and the API call uses official REST only — see
// lib/agentmail.ts. With no AGENTMAIL_API_KEY the action silently no-ops and the
// button surfaces a quiet "not configured" hint instead of failing.
//
// Integrator wiring:
//   action  : api.outreach.sendApprovedDraft({ draftId })
//   status  : api.outreach.outreachStatus({ draftId })  (reactive)
//   Render <OutreachButton draftId={draft._id} /> next to / after Approve.
// ============================================================================

interface OutreachButtonProps {
  draftId: Id<"drafts">;
  /** Optional extra classes for layout in the host (modal footer, card, etc.). */
  className?: string;
}

type SendResult = {
  sent: boolean;
  id?: string;
  alreadySent?: boolean;
  reason?: string;
};

export function OutreachButton({ draftId, className }: OutreachButtonProps) {
  const send = useAction(api.outreach.sendApprovedDraft);
  const status = useQuery(api.outreach.outreachStatus, { draftId });

  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Server-persisted truth (reactive). Falls back to local result while the
  // query round-trips after a send.
  const alreadySent = status?.sent === true;
  const approved = status?.approved === true;

  const onClick = useCallback(async () => {
    if (sending || alreadySent) return;
    setNote(null);
    setFailed(false);
    setSending(true);
    try {
      const result = (await send({ draftId })) as SendResult;
      if (result.sent) {
        setNote(result.alreadySent ? "Already sent" : "Sent via AgentMail");
        setFailed(false);
      } else {
        setNote(result.reason ?? "Couldn't send — AgentMail not configured.");
        setFailed(true);
      }
    } catch (err: unknown) {
      setNote(err instanceof Error ? err.message : "Send failed. Try again.");
      setFailed(true);
    } finally {
      setSending(false);
    }
  }, [send, draftId, sending, alreadySent]);

  // Sent state — terminal, calm confirmation.
  if (alreadySent) {
    return (
      <span
        className={`inline-flex items-center gap-2 rounded-lg bg-good/15 px-4 py-2 text-sm font-semibold text-good ring-1 ring-good/30 ${className ?? ""}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
        Sent via AgentMail
      </span>
    );
  }

  return (
    <span className={`inline-flex flex-col items-start gap-1 ${className ?? ""}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={sending || !approved}
        title={!approved ? "Approve the reply before sending" : "Send the approved reply via AgentMail"}
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {sending ? (
          "Sending…"
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
            Send via AgentMail
          </>
        )}
      </button>
      {note && (
        <span className={`text-xs ${failed ? "text-zinc-500" : "text-good"}`}>
          {note}
        </span>
      )}
    </span>
  );
}

export default OutreachButton;
