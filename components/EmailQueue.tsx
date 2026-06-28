"use client";

import { useCallback, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { EmailStatus } from "@/lib/contract";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import { EMAIL_STATUS_META, tintStyle } from "./pipelineMeta";
import {
  emailsByRunRef,
  sendEmailRef,
  setEmailStatusRef,
} from "./chatApi";
import type { EmailDoc } from "./types";

// ============================================================================
// EmailQueue — the 24/7 outreach approval gate, read as a lifecycle FLOW:
// Awaiting approval → Approved → Sent → Replied. Signal-grounded drafts from the
// writer agent; nothing leaves without a human Approve, and only the sender
// (AgentMail) flips approved → sent. ONE "Email Studio" button at the top of the
// board opens the global email designer (the EmailDesigner drawer listens for
// `intercept:open-email-designer`) with the top draft prefilled and the full list
// of open drafts in tow — inside the studio the human switches draft / starts
// blank and DESIGNS. Reads emails:byRun reactively.
// ============================================================================

/** A draft handed to the Email Studio so the human can switch between them. */
interface StudioDraft {
  emailId: Id<"emails">;
  to?: string;
  subject?: string;
  body?: string;
  label?: string;
}

/**
 * Open the global Email Studio. The first draft (if any) is prefilled; the whole
 * `drafts` list rides along so the studio can offer a draft switcher + "start
 * blank". Fire-and-forget — the EmailDesigner drawer is mounted once at app root.
 */
function openEmailStudio(emails: EmailDoc[]): void {
  if (typeof window === "undefined") return;
  const drafts: StudioDraft[] = emails.map((e) => ({
    emailId: e._id,
    to: e.to ?? undefined,
    subject: e.subject,
    body: e.body,
    label: e.to ? `to ${e.to}` : e.signalRef ?? e.subject,
  }));
  const top = drafts[0];
  window.dispatchEvent(
    new CustomEvent("intercept:open-email-designer", {
      detail: {
        ...(top
          ? { emailId: top.emailId, to: top.to, subject: top.subject, body: top.body }
          : {}),
        drafts,
      },
    }),
  );
}

function EmailRow({ email }: { email: EmailDoc }) {
  const setStatus = useMutation(setEmailStatusRef);
  const sendEmail = useAction(sendEmailRef);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "approve" | "skip" | "send">(null);
  const [note, setNote] = useState<string | null>(null);

  const meta = EMAIL_STATUS_META[email.status];
  const isDraft = email.status === "draft";
  const isApproved = email.status === "approved";
  const isSent = email.status === "sent" || email.status === "replied";

  const approve = useCallback(async () => {
    setBusy("approve");
    setNote(null);
    try {
      await setStatus({ emailId: email._id, status: "approved" });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't approve.");
    } finally {
      setBusy(null);
    }
  }, [setStatus, email._id]);

  const skip = useCallback(async () => {
    setBusy("skip");
    setNote(null);
    try {
      await setStatus({ emailId: email._id, status: "skipped" });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't skip.");
    } finally {
      setBusy(null);
    }
  }, [setStatus, email._id]);

  const send = useCallback(async () => {
    setBusy("send");
    setNote(null);
    try {
      const res = await sendEmail({ emailId: email._id });
      if (!res?.sent) setNote(res?.reason ?? "AgentMail not configured.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setBusy(null);
    }
  }, [sendEmail, email._id]);

  return (
    <div className="rounded-lg border border-hairline bg-canvas p-3">
      <div className="flex items-start justify-between gap-3">
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span
              className="caption rounded-full border px-2 py-0.5"
              style={tintStyle(meta.hex)}
            >
              {meta.label}
            </span>
            {email.kind === "followup" && (
              <span className="caption rounded-full bg-surface-soft px-1.5 py-0.5 text-ink/50">
                follow-up {email.step}
              </span>
            )}
          </div>
          <p className="mt-1.5 truncate text-[13px] font-fig-headline text-ink">{email.subject}</p>
          <p className="mt-0.5 truncate text-[11px] text-ink/50">
            {email.to ? `to ${email.to}` : "recipient resolved at send"}
            {email.signalRef ? ` · ${email.signalRef}` : ""}
          </p>
        </button>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className={cn("mt-1 h-4 w-4 shrink-0 text-ink/30 transition-transform", open && "rotate-180")}
        >
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && (
        <div className="mt-2.5 rounded-md border border-hairline bg-surface-soft p-3">
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/70">{email.body}</p>
        </div>
      )}

      {email.status === "replied" && email.replyBody && (
        <div className="mt-2 rounded-md border border-hairline bg-block-mint p-2.5">
          <p className="caption text-success">They replied {relativeTime(email.repliedAt)}</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[12px] text-ink/80">{email.replyBody}</p>
        </div>
      )}

      {/* actions */}
      {!isSent && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {isDraft && (
            <>
              <button
                onClick={approve}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-pill bg-block-mint px-4 py-1.5 text-[12px] font-fig-link text-ink transition-colors hover:bg-block-mint/80 disabled:opacity-50"
              >
                {busy === "approve" ? "Approving…" : "Approve"}
              </button>
              <button
                onClick={skip}
                disabled={!!busy}
                className="rounded-pill border border-hairline bg-canvas px-4 py-1.5 text-[12px] font-fig-link text-ink transition-colors hover:bg-surface-soft disabled:opacity-50"
              >
                {busy === "skip" ? "…" : "Skip"}
              </button>
            </>
          )}
          {isApproved && (
            <button
              onClick={send}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-[12px] font-fig-link text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                <path d="m22 2-7 20-4-9-9-4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M22 2 11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {busy === "send" ? "Sending…" : "Send via AgentMail"}
            </button>
          )}
          {note && <span className="text-[11px] text-ink/50">{note}</span>}
        </div>
      )}
      {isSent && (
        <p className="mt-2 text-[11px] text-success">
          {email.status === "replied" ? "Replied" : "Sent"} via AgentMail {relativeTime(email.sentAt)}
        </p>
      )}
    </div>
  );
}

// One lifecycle stage of the outreach flow. Rendered only when it has emails, with
// a consistent colored-dot header + count so the whole queue reads top-to-bottom.
function Stage({
  label,
  statusKey,
  emails,
}: {
  label: string;
  statusKey: EmailStatus;
  emails: EmailDoc[];
}) {
  if (emails.length === 0) return null;
  const hex = EMAIL_STATUS_META[statusKey].hex;
  // Sequence within a stage: initials first, then follow-ups by step.
  const ordered = [...emails].sort((a, b) => a.step - b.step || a.createdAt - b.createdAt);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="h-2 w-2 rounded-full" style={{ background: hex }} />
        <span className="text-[12px] font-fig-headline text-ink">{label}</span>
        <span className="rounded-full border border-hairline bg-canvas px-2 py-0.5 text-[10px] font-fig-bodysm tabular-nums text-ink/60">
          {emails.length}
        </span>
      </div>
      <div className="space-y-2">
        {ordered.map((e) => (
          <EmailRow key={e._id} email={e} />
        ))}
      </div>
    </div>
  );
}

export default function EmailQueue({ runId }: { runId: Id<"runs"> }) {
  const emails = useQuery(emailsByRunRef, { runId }) as EmailDoc[] | undefined;

  const groups = useMemo(() => {
    const by: Record<EmailStatus, EmailDoc[]> = {
      draft: [],
      approved: [],
      sent: [],
      replied: [],
      bounced: [],
      skipped: [],
    };
    for (const e of emails ?? []) by[e.status].push(e);
    return by;
  }, [emails]);

  if (emails === undefined) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border border-hairline bg-surface-soft" />
        ))}
      </div>
    );
  }

  const awaiting = groups.draft.length;
  const skipped = groups.skipped.length;

  // Drafts the studio can design: anything not yet sent. Top one is prefilled.
  const designable = useMemo(
    () =>
      [...groups.draft, ...groups.approved].sort(
        (a, b) => a.step - b.step || a.createdAt - b.createdAt,
      ),
    [groups.draft, groups.approved],
  );

  // Funnel readout, consistent with the pipeline's left→right story.
  const funnel: { label: string; n: number }[] = [
    { label: "awaiting", n: groups.draft.length },
    { label: "approved", n: groups.approved.length },
    { label: "sent", n: groups.sent.length },
    { label: "replied", n: groups.replied.length },
  ];

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-fig-headline text-ink">Outreach queue</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink/60">
            {funnel.map((f, i) => (
              <span key={f.label} className="inline-flex items-center gap-1.5">
                {i > 0 && <span className="text-ink/25">›</span>}
                <span className="tabular-nums text-ink/80">{f.n}</span>
                <span>{f.label}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/* ONE entry point — opens the Email Studio with the top draft + the
              rest of the open drafts so the human can design + switch inside. */}
          <button
            type="button"
            onClick={() => openEmailStudio(designable)}
            title="Open the Email Studio to design a branded email"
            className="inline-flex items-center gap-1.5 rounded-pill bg-ink px-4 py-2 text-[12.5px] font-fig-link text-on-primary transition-opacity hover:opacity-90"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <path d="M12 19l7-7 3 3-7 7-3-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M2 2l7.586 7.586" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="11" cy="11" r="2" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            Email Studio
          </button>
          {awaiting > 0 && (
            <span className="caption rounded-full bg-block-cream px-3 py-1 text-ink">
              {awaiting} awaiting approval
            </span>
          )}
        </div>
      </div>

      {(emails?.length ?? 0) === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline bg-surface-soft p-10 text-center text-[13px] text-ink/60">
          The writer drafts a signal-grounded email per qualified prospect — they queue here for your approval, then flow to sent and replied.
        </div>
      ) : (
        <div className="space-y-4">
          <Stage label="Awaiting approval" statusKey="draft" emails={groups.draft} />
          <Stage label="Approved · ready to send" statusKey="approved" emails={groups.approved} />
          <Stage label="Sent" statusKey="sent" emails={groups.sent} />
          <Stage label="Replied" statusKey="replied" emails={groups.replied} />
          <Stage label="Bounced" statusKey="bounced" emails={groups.bounced} />
          {skipped > 0 && (
            <p className="px-0.5 text-[11px] text-ink/40">
              {skipped} skipped {skipped === 1 ? "draft" : "drafts"} off-ramped
            </p>
          )}
        </div>
      )}
    </section>
  );
}
