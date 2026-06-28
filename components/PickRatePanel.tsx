"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

// ============================================================================
// PickRatePanel — the global AI PICK RATE theatre.
// ----------------------------------------------------------------------------
// Mounted ONCE at the app root; it self-opens when a sidebar row dispatches
//   window.dispatchEvent(new CustomEvent("intercept:open-pickrate", {
//     detail: { targetUrl } }))
//
// It calls convex/pickrate.measure({ targetUrl }) and renders the headline PICK
// RATE — the % of buyer questions where an AI assistant actually recommends the
// target — then each simulated buyer question with a picked / not-picked chip
// and who won instead, the competitors stealing the recommendations, and the
// gaps to close.
//
// Bound by NAME via makeFunctionReference (mirrors components/WinBackPanel.tsx)
// so it compiles regardless of deploy order. Graceful by contract: the backend
// never throws (it degrades to a canned read), and every async path here is
// guarded. SSR-safe: the window listener only attaches in an effect. When the
// dispatched detail.targetUrl is empty the panel falls back to the persisted
// settings target itself (via api.settings.getSettings) — no prop threading.
// ============================================================================

interface PickRateQuestion {
  question: string;
  picked: boolean;
  winners: string[];
}

interface PickRateResult {
  score: number;
  questions: PickRateQuestion[];
  competitorsStealingPicks: string[];
  gaps: string[];
}

interface OpenPickRateDetail {
  targetUrl?: string;
}

// Bound at runtime once convex/pickrate.ts deploys (deploy-order safe).
const measureRef = makeFunctionReference<
  "action",
  { targetUrl: string },
  PickRateResult
>("pickrate:measure");

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Pastel band for the headline score, mirroring WinBackPanel's ScoreChip. */
function scoreHex(score: number): string {
  return score >= 60
    ? "var(--block-mint)"
    : score >= 35
      ? "var(--block-cream)"
      : "var(--block-pink)";
}

export default function PickRatePanel() {
  const measure = useAction(measureRef);

  // The persisted default target — used when the event carries an empty URL.
  const settings = useQuery(api.settings.getSettings, {});
  const persistedTarget = settings?.targetUrl ?? "";
  // Keep the latest persisted target in a ref so the event handler (attached
  // once) always reads the freshest value without re-binding the listener.
  const persistedRef = useRef<string>("");
  useEffect(() => {
    persistedRef.current = persistedTarget;
  }, [persistedTarget]);

  const [open, setOpen] = useState(false);
  const [targetLabel, setTargetLabel] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PickRateResult | null>(null);

  // Guards a stale async resolve from overwriting a newer open.
  const requestId = useRef(0);

  const close = useCallback(() => setOpen(false), []);

  // ── Self-open on the sidebar event ──────────────────────────────────────────
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenPickRateDetail>).detail ?? {};
      const fromDetail = (detail.targetUrl ?? "").trim();
      const target = fromDetail || persistedRef.current || "";

      const reqId = requestId.current + 1;
      requestId.current = reqId;

      setResult(null);
      setError(null);
      setTargetLabel(target || "your company");
      setLoading(true);
      setOpen(true);

      measure({ targetUrl: target })
        .then((res) => {
          if (requestId.current !== reqId) return; // superseded
          if (res && Array.isArray(res.questions) && res.questions.length > 0) {
            setResult(res);
          } else {
            setError("Couldn't measure pick rate right now.");
          }
        })
        .catch(() => {
          if (requestId.current !== reqId) return;
          // The backend is graceful, but guard the call site regardless.
          setError("Pick Rate is warming up — try again in a moment.");
        })
        .finally(() => {
          if (requestId.current === reqId) setLoading(false);
        });
    };

    window.addEventListener("intercept:open-pickrate", onOpen as EventListener);
    return () =>
      window.removeEventListener("intercept:open-pickrate", onOpen as EventListener);
  }, [measure]);

  // ── Esc to close + lock body scroll while open ──────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, close]);

  if (!open) return null;

  const ready = !loading && !!result && result.questions.length > 0;
  const score = result ? clampPct(result.score) : 0;
  const pickedCount = result ? result.questions.filter((q) => q.picked).length : 0;
  const totalCount = result ? result.questions.length : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="AI Pick Rate"
      onClick={close}
    >
      <div
        className="relative flex h-[680px] max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <p className="caption font-mono uppercase tracking-wide text-ink/50">
              AI Pick Rate
            </p>
            <h2 className="mt-1 truncate text-[15px] font-fig-headline text-ink">
              Does AI recommend you?
            </h2>
            <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
              {loading
                ? `Asking AI assistants what they'd recommend for ${targetLabel}…`
                : "GEO tells you if AI sees you — this measures if AI picks you"}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-full p-1.5 text-ink/50 transition-colors hover:bg-surface-soft hover:text-ink"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>

        {/* Body */}
        <div className="col-scroll min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-soft/50 px-5 py-4">
          {loading && !result && <LoadingState />}

          {error && !result && (
            <div className="grid h-full place-items-center text-center text-[13px] text-ink/55">
              {error}
            </div>
          )}

          {ready && result && (
            <>
              <ScoreHero score={score} picked={pickedCount} total={totalCount} />

              <Section label="Buyer questions — who AI picks">
                <div className="space-y-2.5">
                  {result.questions.map((q, i) => (
                    <QuestionCard key={`${q.question}-${i}`} question={q} />
                  ))}
                </div>
              </Section>

              {result.competitorsStealingPicks.length > 0 && (
                <Section label="Competitors stealing your picks">
                  <div className="flex flex-wrap gap-1.5">
                    {result.competitorsStealingPicks.map((c, i) => (
                      <span
                        key={`${c}-${i}`}
                        className="inline-flex items-center rounded-pill border border-hairline bg-canvas px-2.5 py-1 text-[12px] font-fig-card text-ink/80"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {result.gaps.length > 0 && (
                <Section label="Gaps to close">
                  <ul className="space-y-1.5">
                    {result.gaps.map((g, i) => (
                      <li
                        key={`${g}-${i}`}
                        className="flex gap-2 text-[12.5px] leading-snug text-ink/80"
                      >
                        <span
                          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: "rgb(var(--block-coral))" }}
                          aria-hidden
                        />
                        <span className="min-w-0">{g}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <span className="text-[11px] text-ink/45">
            {loading
              ? "Simulating buyer questions…"
              : ready
                ? `Recommended in ${pickedCount} of ${totalCount} buyer questions`
                : " "}
          </span>
          <button
            type="button"
            onClick={close}
            className="rounded-pill bg-ink px-5 py-1.5 text-[12.5px] font-fig-link text-on-primary transition-opacity hover:opacity-90"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The headline PICK RATE — the % of buyer questions where AI recommends you.
// ---------------------------------------------------------------------------
function ScoreHero({ score, picked, total }: { score: number; picked: number; total: number }) {
  const hex = scoreHex(score);
  return (
    <div className="animate-row-in rounded-2xl border border-hairline bg-canvas p-5">
      <div className="flex items-center gap-5">
        <div
          className="grid h-24 w-24 shrink-0 place-items-center rounded-full"
          style={{ background: `rgb(${hex})` }}
          aria-label={`Pick rate ${score} percent`}
        >
          <span className="text-[34px] font-fig-headline leading-none tabular-nums text-ink">
            {score}
            <span className="text-[15px] text-ink/45">%</span>
          </span>
        </div>
        <div className="min-w-0">
          <p className="caption font-mono uppercase tracking-wide text-ink/45">
            Pick Rate
          </p>
          <p className="mt-1 text-[15px] font-fig-card leading-snug text-ink">
            AI recommends you in {picked} of {total} buyer questions
          </p>
          <p className="mt-1 text-[12px] leading-snug text-ink/55">
            The share of prospect questions where an AI assistant actually names you.
          </p>
        </div>
      </div>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-ink/8">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${score}%`, background: `rgb(${hex})` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One simulated buyer question: the ask, a picked / not-picked chip, and who
// the AI recommended instead (or alongside).
// ---------------------------------------------------------------------------
function QuestionCard({ question }: { question: PickRateQuestion }) {
  const { picked, winners } = question;
  return (
    <div className="animate-row-in rounded-xl border border-hairline bg-canvas p-3.5">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-snug text-ink/85">
          {question.question}
        </p>
        <PickChip picked={picked} />
      </div>
      {winners.length > 0 && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[11.5px] leading-snug">
          <span className="font-mono text-[9.5px] uppercase tracking-wide text-ink/40">
            {picked ? "Recommended" : "Won instead"}
          </span>
          {winners.map((w, i) => (
            <span
              key={`${w}-${i}`}
              className="rounded-pill px-2 py-0.5 text-[11px] font-fig-card text-ink"
              style={{ background: "rgb(var(--block-cream))" }}
            >
              {w}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function PickChip({ picked }: { picked: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-pill px-2.5 py-1 text-[11px] font-fig-card text-ink",
      )}
      style={{
        background: picked ? "rgb(var(--block-mint))" : "rgb(var(--block-pink))",
      }}
      aria-label={picked ? "Picked by AI" : "Not picked by AI"}
    >
      {picked ? "Picked" : "Not picked"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// A labelled section wrapper.
// ---------------------------------------------------------------------------
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="animate-row-in">
      <p className="caption mb-2 font-mono uppercase tracking-wide text-ink/40">
        {label}
      </p>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Loading skeletons — a score hero plus three placeholder question cards.
// ---------------------------------------------------------------------------
function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-hairline bg-canvas p-5">
        <div className="flex items-center gap-5">
          <div className="h-24 w-24 shrink-0 animate-pulse rounded-full bg-surface-soft" />
          <div className="flex-1 space-y-2">
            <div className="h-2.5 w-20 animate-pulse rounded bg-surface-soft" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface-soft" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-soft" />
          </div>
        </div>
        <div className="mt-4 h-2 w-full animate-pulse rounded-full bg-surface-soft" />
      </div>
      <div className="space-y-2.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-hairline bg-canvas p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="h-3.5 w-3/5 animate-pulse rounded bg-surface-soft" />
              <div className="h-6 w-16 animate-pulse rounded-pill bg-surface-soft" />
            </div>
            <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-surface-soft" />
          </div>
        ))}
      </div>
    </div>
  );
}
