"use client";

/**
 * MascotCompanion — the fixed, floating corner companion ("Acey"). Mount this
 * ONCE (app/page.tsx). It now runs TWO layers:
 *
 *   • REACTIVE (useMascotReactions) — mood + ambient one-liners off the live swarm
 *     (thinking / celebrate / concerned / peek / nod). Pure delight.
 *   • INTELLIGENT (useMascotIntel) — the DEEPENED companion:
 *       1. PROACTIVE WINS  — surfaces the 24/7 cron's overnight `proactive`
 *          messages as a clickable bubble ("found 3 hot leads overnight 👀")
 *          that focuses the run that produced them.
 *       2. GETS SMARTER    — a "learned N" micro-badge + an antenna `glow` that
 *          brightens as the compounding brain grows; clicking the badge opens
 *          the Brain canvas/lens.
 *       3. NEXT-ACTION     — after a win, ONE clickable suggestion ("draft
 *          outreach to Acme?") that triggers a REAL run via createRun (NOT a
 *          chat input).
 *       4. GLANCEABLE STATUS — clicking Acey opens a tiny popover ("Working on
 *          <co> · Found <n> · Knows <n> facts") with links + an empty-state greet.
 *
 * GRACEFUL: every new signal is optional — a missing query / empty brain / fresh
 * deployment simply yields no bubble, no badge, no nudge. Nothing here throws or
 * blocks a run. Wiring (onFocusRun / onOpenBrain) is OPTIONAL: without it the
 * popover still informs; with it, clicks navigate. The sprite stays decorative;
 * only the explicit buttons/affordances are interactive (and labelled).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Mascot, useMascotGaze } from "./Mascot";
import { useMascotReactions } from "./useMascotReactions";
import { useMascotIntel } from "./useMascotIntel";
import MascotPopover from "./MascotPopover";
import type { Id } from "@/convex/_generated/dataModel";

/** How long the next-action nudge bubble lingers after a win (ms). */
const NUDGE_MS = 7000;

interface MascotCompanionProps {
  /** The focused run — enables richer per-run wins (threads/emails/posts/ads). */
  runId?: Id<"runs"> | null;
  /** The active conversation — enables event-feed ambient one-liners. */
  conversationId?: Id<"conversations"> | null;
  /** Rendered sprite size (px). */
  size?: number;
  /** OPTIONAL: focus a run's canvas (proactive-win click + popover "focus"). */
  onFocusRun?: (runId: Id<"runs">) => void;
  /** OPTIONAL: open the Brain canvas/lens (badge + popover "brain" links). */
  onOpenBrain?: () => void;
}

export default function MascotCompanion({
  runId = null,
  conversationId = null,
  size = 64,
  onFocusRun,
  onOpenBrain,
}: MascotCompanionProps) {
  const spriteRef = useRef<HTMLButtonElement>(null);
  const gaze = useMascotGaze(spriteRef);
  const { state, speech, dismissSpeech, busy } = useMascotReactions({
    runId,
    conversationId,
  });
  const { proactiveWin, dismissProactive, brain, status, nextAction } =
    useMascotIntel({ runId, conversationId });

  const createRun = useMutation(api.runs.createRun);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [nudgeVisible, setNudgeVisible] = useState(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latch the next-action nudge for a few seconds when a WIN beat fires (so it's
  // clickable past the one-shot animation). Cleared on unmount.
  useEffect(() => {
    if (state === "celebrate" && nextAction) {
      setNudgeVisible(true);
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
      nudgeTimer.current = setTimeout(() => setNudgeVisible(false), NUDGE_MS);
    }
  }, [state, nextAction]);
  useEffect(
    () => () => {
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    },
    [],
  );

  // Fire a next-action: spawn a REAL run via createRun, then focus it. Defensive —
  // any failure is swallowed so the mascot never breaks the page.
  const act = useCallback(async () => {
    if (!nextAction) return;
    setNudgeVisible(false);
    setPopoverOpen(false);
    try {
      const newRunId = await createRun({
        intent: nextAction.intent,
        input: nextAction.input,
        inputType: nextAction.inputType,
        trigger: "manual",
        ...(nextAction.conversationId
          ? { conversationId: nextAction.conversationId }
          : {}),
      });
      if (newRunId && onFocusRun) onFocusRun(newRunId as Id<"runs">);
    } catch {
      // never throw from a delight affordance.
    }
  }, [nextAction, createRun, onFocusRun]);

  // Click a proactive win → focus its run + dismiss it.
  const openProactive = () => {
    if (!proactiveWin) return;
    if (proactiveWin.runId && onFocusRun) onFocusRun(proactiveWin.runId);
    dismissProactive();
  };

  // Click the "learned N" badge → open the Brain canvas.
  const openBrain = () => {
    setPopoverOpen(false);
    onOpenBrain?.();
  };

  const showLearnedBadge = brain.learnedDelta > 0;

  return (
    <div
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2"
    >
      {/* ---- Bubble stack (one at a time, by priority) ---- */}
      {popoverOpen ? (
        <MascotPopover
          status={status}
          brain={brain}
          nextAction={nextAction}
          onFocusRun={
            status.runId && onFocusRun
              ? () => {
                  onFocusRun(status.runId as Id<"runs">);
                  setPopoverOpen(false);
                }
              : undefined
          }
          onOpenBrain={onOpenBrain ? openBrain : undefined}
          onAct={nextAction ? act : undefined}
          onClose={() => setPopoverOpen(false)}
        />
      ) : proactiveWin ? (
        // PROACTIVE WIN — the overnight surprise. Clickable → focus its run.
        <div className="pointer-events-auto flex max-w-[248px] items-stretch gap-1">
          <button
            type="button"
            onClick={openProactive}
            className="flex-1 rounded-2xl rounded-br-sm border border-hairline bg-canvas px-3.5 py-2 text-left text-sm text-ink shadow-xl outline-none transition-opacity hover:opacity-90"
            title="focus this run"
          >
            <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-accent-magenta">
              while you were away
            </span>
            {proactiveWin.line}
          </button>
          <button
            type="button"
            onClick={dismissProactive}
            aria-label="Dismiss"
            className="grid w-6 shrink-0 place-items-center rounded-full text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70"
          >
            ✕
          </button>
        </div>
      ) : nudgeVisible && nextAction ? (
        // NEXT-ACTION nudge after a win — triggers a real run.
        <button
          type="button"
          onClick={act}
          className="pointer-events-auto max-w-[240px] rounded-2xl rounded-br-sm border border-hairline bg-ink px-3.5 py-2 text-left text-sm font-medium text-canvas shadow-xl outline-none transition-opacity hover:opacity-90"
        >
          {nextAction.label}
        </button>
      ) : speech ? (
        // Fun, ambient one-liner. Decorative; tapping dismisses early.
        <button
          type="button"
          onClick={dismissSpeech}
          className="pointer-events-auto max-w-[220px] rounded-2xl rounded-br-sm border border-hairline bg-canvas px-3.5 py-2 text-left text-sm text-ink shadow-xl outline-none transition-opacity hover:opacity-90"
        >
          {speech}
        </button>
      ) : null}

      {/* ---- The sprite + the "learned N" micro-badge ---- */}
      <div className="pointer-events-auto relative">
        <button
          type="button"
          ref={spriteRef}
          onClick={() => setPopoverOpen((v) => !v)}
          aria-label={
            busy ? "Acey — the swarm is working" : "Acey — open status"
          }
          className="grid size-20 place-items-center rounded-full ring-2 ring-transparent outline-none transition-[transform,box-shadow] hover:ring-accent-magenta/25 focus-visible:ring-accent-magenta/40"
          style={{ filter: "drop-shadow(0 6px 14px rgba(15,20,40,0.28))" }}
        >
          <Mascot state={state} size={size} gaze={gaze} glow={brain.glow} />
        </button>

        {/* GETS-SMARTER badge — clicking opens the brain. */}
        {showLearnedBadge && (
          <button
            type="button"
            onClick={openBrain}
            title="open the brain"
            className="absolute -left-1 -top-1 rounded-full border border-hairline bg-accent-magenta px-2 py-0.5 text-[10px] font-semibold leading-none text-white shadow-md transition-transform hover:scale-105"
          >
            learned {brain.learnedDelta}
          </button>
        )}
      </div>
    </div>
  );
}
