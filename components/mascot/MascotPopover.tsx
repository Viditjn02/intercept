"use client";

/**
 * MascotPopover — the small, GLANCEABLE status card that opens when you click
 * Acey. It answers, at a glance: what is the swarm working on, how much has it
 * found, and how much does the brain now know — plus ONE optional next-action
 * nudge and quick links. It is a Tier-2 floating overlay (glass chrome you look
 * THROUGH), 1px-bordered, never animating backdrop-filter.
 *
 * Pure presentational: all data + the action come from props (useMascotIntel +
 * the parent's createRun wiring). Graceful: with no focused run it greets the
 * empty state instead of showing blanks. Never throws.
 */

import type { MascotBrain, MascotStatus, NextAction } from "./useMascotIntel";

interface MascotPopoverProps {
  status: MascotStatus;
  brain: MascotBrain;
  nextAction: NextAction | null;
  /** Focus the status run's canvas (if any). */
  onFocusRun?: () => void;
  /** Open the Brain canvas/lens. */
  onOpenBrain?: () => void;
  /** Trigger the next-action (createRun under the hood). */
  onAct?: () => void;
  /** Close the popover. */
  onClose: () => void;
}

export default function MascotPopover({
  status,
  brain,
  nextAction,
  onFocusRun,
  onOpenBrain,
  onAct,
  onClose,
}: MascotPopoverProps) {
  const hasWork = !!status.company;
  const found = status.found ?? 0;

  return (
    <div
      role="dialog"
      aria-label="Acey status"
      className="mascot-glass pointer-events-auto w-[244px] rounded-2xl rounded-br-sm border border-hairline p-3 text-left text-ink shadow-xl"
      style={{
        // Tier-2 glass — backdrop on the CHROME, solid fallback under
        // prefers-reduced-transparency (see the <style> block below).
        background: "rgba(var(--glass-2-bg, 255 255 255) / var(--glass-2-alpha, .9))",
        backdropFilter: "blur(16px) saturate(160%)",
        WebkitBackdropFilter: "blur(16px) saturate(160%)",
      }}
    >
      <ReducedTransparencyFallback />

      {/* Header line */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/60">
          {status.running ? "working…" : "Acey"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-5 place-items-center rounded-full text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70"
        >
          ✕
        </button>
      </div>

      {hasWork ? (
        <div className="space-y-1.5">
          <StatusRow
            label="On"
            value={status.company ?? "—"}
            onClick={onFocusRun}
            clickLabel="focus"
          />
          <StatusRow label="Found" value={found > 0 ? `${found}` : "—"} />
          <StatusRow
            label="Knows"
            value={`${brain.facts} fact${brain.facts === 1 ? "" : "s"}`}
            onClick={onOpenBrain}
            clickLabel="brain"
          />
        </div>
      ) : (
        // Empty-state greet: no run focused yet.
        <p className="text-sm leading-snug text-ink/80">
          {brain.facts > 0
            ? `hey 👋 I know ${brain.facts} fact${brain.facts === 1 ? "" : "s"} so far — point me at a company and I'll dig in.`
            : "hey 👋 start a chat and I'll get to work — I learn from every run."}
        </p>
      )}

      {/* ONE next-action nudge — triggers a real run, never a chat input. */}
      {nextAction && (
        <button
          type="button"
          onClick={onAct}
          className="mt-2.5 w-full rounded-full border border-hairline bg-ink px-3 py-1.5 text-center text-[13px] font-medium text-canvas transition-opacity hover:opacity-90"
        >
          {nextAction.label}
        </button>
      )}

      {/* Brain quick-link (always available so the user can explore what it knows). */}
      {!hasWork && brain.facts > 0 && onOpenBrain && (
        <button
          type="button"
          onClick={onOpenBrain}
          className="mt-2 w-full rounded-full border border-hairline px-3 py-1.5 text-center text-[13px] font-medium text-ink transition-colors hover:bg-ink/5"
        >
          open the brain →
        </button>
      )}
    </div>
  );
}

function StatusRow({
  label,
  value,
  onClick,
  clickLabel,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  clickLabel?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink/45">
        {label}
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-sm font-medium text-ink">{value}</span>
        {onClick && (
          <button
            type="button"
            onClick={onClick}
            className="shrink-0 text-[11px] font-medium text-accent-magenta underline-offset-2 hover:underline"
          >
            {clickLabel}
          </button>
        )}
      </span>
    </div>
  );
}

/** Solid fallback when the user prefers reduced transparency (a11y / glass rule). */
function ReducedTransparencyFallback() {
  return (
    <style>{`
@media (prefers-reduced-transparency: reduce) {
  .mascot-glass { background: rgb(var(--canvas, 255 255 255)) !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
}
`}</style>
  );
}
