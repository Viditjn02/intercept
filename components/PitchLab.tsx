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
  if (score >= 65) return { ring: "#34d399", text: "text-good", label: "likely to reply" };
  if (score >= 40) return { ring: "#fbbf24", text: "text-amber-400", label: "on the fence" };
  return { ring: "#fb7185", text: "text-rose-400", label: "would ignore" };
}

function Gauge({ score }: { score: number }) {
  const tone = scoreTone(score);
  const dash = `${Math.max(0, Math.min(100, score)) * 1.005} 100.5`;
  return (
    <div className="relative h-14 w-14 shrink-0">
      <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
        <circle cx="18" cy="18" r="16" fill="none" stroke="#26262b" strokeWidth="3" />
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
    positive: "border-good/30 bg-good/10 text-good",
    neutral: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    negative: "border-rose-400/30 bg-rose-400/10 text-rose-300",
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
    <div className="rounded-xl border border-line bg-panel/70 p-3">
      <div className="flex items-start gap-3">
        <Gauge score={sim.score} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SentimentChip sentiment={sim.sentiment} />
            <span className={cn("text-[10px] font-semibold", tone.text)}>{tone.label}</span>
            <span className="text-[10px] text-white/30">· {sim.replyLikelihood}% reply odds</span>
          </div>
          <button onClick={() => setOpen((v) => !v)} className="mt-1.5 block min-w-0 max-w-full text-left">
            <p className="truncate text-[13px] font-semibold text-zinc-100">{sim.subject}</p>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">
              twin: {sim.prospectName ?? sim.prospectCompany ?? "prospect"}
              {sim.model ? ` · ${sim.model}` : ""}
            </p>
          </button>
        </div>
      </div>

      {sim.predictedReply ? (
        <div className="mt-2.5 rounded-lg border border-line bg-ink/50 p-2.5">
          <p className="text-[9.5px] font-semibold uppercase tracking-wide text-white/35">Predicted reply</p>
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] italic leading-relaxed text-zinc-300">
            “{sim.predictedReply}”
          </p>
        </div>
      ) : (
        <p className="mt-2.5 text-[11.5px] text-rose-300/80">
          The twin would not reply to this draft — too generic to earn a response.
        </p>
      )}

      {sim.objections.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {sim.objections.map((o, i) => (
            <span
              key={i}
              className="rounded-full border border-rose-400/25 bg-rose-400/5 px-2 py-0.5 text-[10.5px] text-rose-200/90"
            >
              {o}
            </span>
          ))}
        </div>
      )}

      {open && sim.suggestions.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {sim.suggestions.map((s, i) => (
            <li key={i} className="flex gap-2 text-[12px] text-zinc-400">
              <span className="mt-px text-accent">→</span>
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-ink transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {busy === "improve" ? "Rewriting…" : "Improve draft"}
          </button>
        ) : (
          <span className="rounded-lg bg-white/5 px-2 py-1 text-[10.5px] font-medium uppercase tracking-wide text-white/40">
            {sim.emailStatus}
          </span>
        )}
        <button
          onClick={onResim}
          disabled={!!busy}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-300 ring-1 ring-line transition-colors hover:bg-white/5 disabled:opacity-50"
        >
          {busy === "resim" ? "…" : "Re-simulate"}
        </button>
        {sim.suggestions.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-white/40 underline-offset-2 hover:text-white/70 hover:underline"
          >
            {open ? "hide" : `${sim.suggestions.length} suggestion${sim.suggestions.length > 1 ? "s" : ""}`}
          </button>
        )}
        {note && <span className="text-[11px] text-zinc-500">{note}</span>}
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
          <div key={i} className="h-24 animate-pulse rounded-xl border border-line bg-panel/50" />
        ))}
      </section>
    );
  }

  const best = sims.length > 0 ? sims[0].score : 0;

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-zinc-50">Pitch Lab · digital twin</h3>
          <p className="text-[12.5px] text-zinc-500">
            A simulated prospect reads each draft, predicts their reply, and scores it before send.
          </p>
        </div>
        {sims.length > 0 ? (
          <span className="rounded-full bg-accent/15 px-3 py-1 text-[11px] font-semibold text-accent ring-1 ring-accent/30">
            top {best}/100
          </span>
        ) : null}
      </div>

      {sims.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-panel/40 p-8 text-center">
          <p className="text-[13px] text-zinc-400">
            Simulate the prospect&apos;s reaction to each drafted email — see their predicted reply,
            objections, and a 0-100 reply-likelihood score before anything ships.
          </p>
          <button
            onClick={onSimulate}
            disabled={running}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-ink transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {running ? "Simulating…" : "Run pre-send simulation"}
          </button>
          {note && <p className="mt-2 text-[11px] text-zinc-500">{note}</p>}
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
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-300 ring-1 ring-line transition-colors hover:bg-white/5 disabled:opacity-50"
            >
              {running ? "Re-simulating…" : "Re-simulate all drafts"}
            </button>
            {note && <span className="text-[11px] text-zinc-500">{note}</span>}
          </div>
        </>
      )}
    </section>
  );
}
