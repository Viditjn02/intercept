"use client";

import { useCallback, useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

// ============================================================================
// PitchLab — TRACK 2 (sales cyborgs / digital twin) canvas panel.
//
// Renders directly under EmailQueue for outbound runs. For each drafted email it
// shows the prospect's DIGITAL TWIN reaction (convex/agents/twin): a reply-
// likelihood gauge, the predicted buyer reply, objection chips, and the twin's
// suggestions — with one-tap "Improve draft" (critique → grounded rewrite →
// re-score) and "Re-simulate". Empty state offers a one-tap pre-send simulation.
// ============================================================================

type Sim = FunctionReturnType<typeof api.agents.twin.simulationsForRun>[number];

interface PitchLabProps {
  runId: Id<"runs">;
}

function scoreTone(score: number): { ring: string; text: string; label: string } {
  if (score >= 65) return { ring: "#1ea64a", text: "text-success", label: "likely to reply" };
  if (score >= 40) return { ring: "#d97706", text: "text-amber-600", label: "on the fence" };
  return { ring: "#e11d48", text: "text-rose-600", label: "would ignore" };
}

function Gauge({ score }: { score: number }) {
  const tone = scoreTone(score);
  const dash = `${Math.max(0, Math.min(100, score)) * 1.005} 100.5`;
  return (
    <div className="relative h-14 w-14 shrink-0">
      <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
        <circle cx="18" cy="18" r="16" fill="none" stroke="#e6e6e6" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r="16"
          fill="none"
          stroke={tone.ring}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={dash}
          pathLength={100.5}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-[15px] font-bold leading-none", tone.text)}>{score}</span>
      </div>
    </div>
  );
}

function SentimentChip({ sentiment }: { sentiment: string }) {
  const map: Record<string, string> = {
    positive: "border-success/30 bg-success/10 text-success",
    neutral: "border-amber-500/30 bg-amber-500/10 text-amber-700",
    negative: "border-rose-500/30 bg-rose-500/10 text-rose-700",
  };
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide",
        map[sentiment] ?? map.neutral,
      )}
    >
      {sentiment}
    </span>
  );
}

function SimCard({ sim }: { sim: Sim }) {
  const improve = useAction(api.agents.twin.improve);
  const reSim = useAction(api.agents.twin.simulateOne);
  const [busy, setBusy] = useState<null | "improve" | "resim">(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const tone = scoreTone(sim.score);
  const isDraft = sim.emailStatus === "draft";

  const onImprove = useCallback(async () => {
    setBusy("improve");
    setNote(null);
    try {
      const res = await improve({ emailId: sim.emailId });
      if (res.ok) setNote(`Rewrote · reply-likelihood ${res.before} → ${res.after}`);
      else setNote(res.reason ?? "Couldn't improve this draft.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Improve failed.");
    } finally {
      setBusy(null);
    }
  }, [improve, sim.emailId]);

  const onResim = useCallback(async () => {
    setBusy("resim");
    setNote(null);
    try {
      await reSim({ emailId: sim.emailId });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Re-simulate failed.");
    } finally {
      setBusy(null);
    }
  }, [reSim, sim.emailId]);

  return (
    <div className="rounded-xl border border-hairline bg-surface-soft p-3">
      <div className="flex items-start gap-3">
        <Gauge score={sim.score} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SentimentChip sentiment={sim.sentiment} />
            <span className={cn("text-[10px] font-semibold", tone.text)}>{tone.label}</span>
            <span className="text-[10px] text-ink/40">· {sim.replyLikelihood}% reply odds</span>
          </div>
          <button onClick={() => setOpen((v) => !v)} className="mt-1.5 block min-w-0 max-w-full text-left">
            <p className="truncate text-[13px] font-semibold text-ink">{sim.subject}</p>
            <p className="mt-0.5 truncate text-[11px] text-ink/55">
              twin: {sim.prospectName ?? sim.prospectCompany ?? "prospect"}
              {sim.model ? ` · ${sim.model}` : ""}
            </p>
          </button>
        </div>
      </div>

      {sim.predictedReply ? (
        <div className="mt-2.5 rounded-lg border border-hairline bg-block-cream/50 p-2.5">
          <p className="text-[9.5px] font-semibold uppercase tracking-wide text-ink/45">Predicted reply</p>
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] italic leading-relaxed text-ink/80">
            “{sim.predictedReply}”
          </p>
        </div>
      ) : (
        <p className="mt-2.5 text-[11.5px] text-rose-600">
          The twin would not reply to this draft — too generic to earn a response.
        </p>
      )}

      {sim.objections.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {sim.objections.map((o, i) => (
            <span
              key={i}
              className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10.5px] text-rose-700"
            >
              {o}
            </span>
          ))}
        </div>
      )}

      {open && sim.suggestions.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {sim.suggestions.map((s, i) => (
            <li key={i} className="flex gap-2 text-[12px] text-ink/70">
              <span className="mt-px text-primary">→</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        {isDraft ? (
          <button
            onClick={onImprove}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-on-primary transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {busy === "improve" ? "Rewriting…" : "Improve draft"}
          </button>
        ) : (
          <span className="rounded-lg bg-canvas px-2 py-1 text-[10.5px] font-medium uppercase tracking-wide text-ink/55 ring-1 ring-hairline">
            {sim.emailStatus}
          </span>
        )}
        <button
          onClick={onResim}
          disabled={!!busy}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink/70 ring-1 ring-hairline transition-colors hover:bg-ink/5 disabled:opacity-50"
        >
          {busy === "resim" ? "…" : "Re-simulate"}
        </button>
        {sim.suggestions.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-ink/55 underline-offset-2 hover:text-ink hover:underline"
          >
            {open ? "hide" : `${sim.suggestions.length} suggestion${sim.suggestions.length > 1 ? "s" : ""}`}
          </button>
        )}
        {note && <span className="text-[11px] text-ink/55">{note}</span>}
      </div>
    </div>
  );
}

export default function PitchLab({ runId }: PitchLabProps) {
  const sims = useQuery(api.agents.twin.simulationsForRun, { runId });
  const simulateRun = useAction(api.agents.twin.simulateRun);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const onSimulate = useCallback(async () => {
    setRunning(true);
    setNote(null);
    try {
      const res = await simulateRun({ runId });
      if (res.simulated === 0) setNote("No drafts to simulate yet — the writer drafts first.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Simulation failed.");
    } finally {
      setRunning(false);
    }
  }, [simulateRun, runId]);

  // Loading skeleton (mirrors EmailQueue / DesignPanel).
  if (sims === undefined) {
    return (
      <section className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-hairline bg-surface-soft" />
        ))}
      </section>
    );
  }

  const best = sims.length > 0 ? sims[0].score : 0;

  return (
    <section className="space-y-3">
      {/* Sticky header — pins the "what is this" framing to the top of the canvas
          as you scroll, so the digital-twin idea reads at a glance instead of
          being buried under the queue. Light Figma theme (pastel lilac on canvas). */}
      <div className="sticky top-0 z-20 -mx-1 flex items-start justify-between gap-3 rounded-xl border border-hairline bg-canvas/85 px-3 py-2.5 backdrop-blur-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-block-lilac text-ink"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
                <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" fill="currentColor" />
              </svg>
            </span>
            <h3 className="text-[15px] font-semibold text-ink">Pitch Lab</h3>
            <span className="rounded-full bg-block-lilac/60 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-ink/70 ring-1 ring-ink/10">
              digital twin
            </span>
          </div>
          <p className="mt-1 text-[12.5px] leading-snug text-ink/60">
            A simulated prospect reads each draft, predicts their reply, and scores it 0–100 before you send.
          </p>
        </div>
        {sims.length > 0 ? (
          <span className="shrink-0 self-center rounded-full bg-block-lilac px-3 py-1 text-[11px] font-semibold text-ink ring-1 ring-ink/10">
            top {best}/100
          </span>
        ) : null}
      </div>

      {sims.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-hairline bg-surface-soft p-8 text-center">
          <p className="text-[13px] text-ink/70">
            Simulate the prospect&apos;s reaction to each drafted email — see their predicted reply,
            objections, and a 0-100 reply-likelihood score before anything ships.
          </p>
          <button
            onClick={onSimulate}
            disabled={running}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[12.5px] font-semibold text-on-primary transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {running ? "Simulating…" : "Run pre-send simulation"}
          </button>
          {note && <p className="mt-2 text-[11px] text-ink/55">{note}</p>}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {sims.map((s) => (
              <SimCard key={s._id} sim={s} />
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onSimulate}
              disabled={running}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink/70 ring-1 ring-hairline transition-colors hover:bg-ink/5 disabled:opacity-50"
            >
              {running ? "Re-simulating…" : "Re-simulate all drafts"}
            </button>
            {note && <span className="text-[11px] text-ink/55">{note}</span>}
          </div>
        </>
      )}
    </section>
  );
}
