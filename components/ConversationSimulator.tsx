"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

// ============================================================================
// ConversationSimulator — the global OUTBOUND PREVIEW theatre.
// ----------------------------------------------------------------------------
// Mounted ONCE at the app root; it self-opens when a prospect card dispatches
//   window.dispatchEvent(new CustomEvent("intercept:simulate-convo", {
//     detail: { prospectId, name } }))
//
// It calls convex/conversationSim.simulate(prospectId) for a hyper-personalized
// thread, then PLAYS it like a live chat: each message lands after a brief typing
// indicator (animated dots), an intent meter climbs message-by-message, and the
// thread closes on the score + verdict chip.
//
// Bound by NAME via makeFunctionReference (mirrors components/chatApi.ts) so this
// compiles regardless of deploy order. Graceful by contract: the backend never
// throws (it degrades to a canned thread), and every async path here is guarded.
// SSR-safe: the window listener only attaches in an effect.
// ============================================================================

type Speaker = "us" | "them";

interface SimMessage {
  from: Speaker;
  text: string;
  intent: number;
}

type Verdict = "Book a call" | "Nurture" | "Pass";

interface SimResult {
  name: string;
  company: string;
  title?: string;
  signal?: string;
  opener: string;
  messages: SimMessage[];
  score: number;
  verdict: Verdict;
  degraded: boolean;
}

interface SimulateConvoDetail {
  prospectId: Id<"prospects">;
  name?: string;
}

// Bound at runtime once convex/conversationSim.ts deploys (deploy-order safe).
const simulateRef = makeFunctionReference<
  "action",
  { prospectId: Id<"prospects"> },
  SimResult
>("conversationSim:simulate");

const VERDICT_META: Record<Verdict, { hex: string; tone: string; sub: string }> = {
  "Book a call": { hex: "var(--block-mint)", tone: "text-ink", sub: "High intent — get it on the calendar" },
  Nurture: { hex: "var(--block-cream)", tone: "text-ink", sub: "Warm — keep the signal loop running" },
  Pass: { hex: "var(--block-pink)", tone: "text-ink", sub: "Low fit — save the touches" },
};

// Pacing for the playback (ms). Tuned to feel live but stay demo-snappy.
const TYPING_MIN = 480;
const TYPING_PER_CHAR = 9;
const TYPING_MAX = 1300;
const SETTLE = 360;

function typingDelay(text: string): number {
  return Math.min(TYPING_MAX, Math.max(TYPING_MIN, text.length * TYPING_PER_CHAR));
}

export default function ConversationSimulator() {
  const simulate = useAction(simulateRef);

  const [open, setOpen] = useState(false);
  const [headerName, setHeaderName] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);

  // Playback state.
  const [shown, setShown] = useState<SimMessage[]>([]);
  const [typingFrom, setTypingFrom] = useState<Speaker | null>(null);
  const [intent, setIntent] = useState(0);
  const [done, setDone] = useState(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const resetPlayback = useCallback(() => {
    clearTimers();
    setShown([]);
    setTypingFrom(null);
    setIntent(0);
    setDone(false);
  }, [clearTimers]);

  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  // ── Self-open on the prospect-card event ────────────────────────────────────
  useEffect(() => {
    const onSimulate = (e: Event) => {
      const detail = (e as CustomEvent<SimulateConvoDetail>).detail;
      if (!detail?.prospectId) return;

      resetPlayback();
      setResult(null);
      setError(null);
      setHeaderName(detail.name?.trim() || "this prospect");
      setLoading(true);
      setOpen(true);

      simulate({ prospectId: detail.prospectId })
        .then((res) => {
          if (res && Array.isArray(res.messages) && res.messages.length > 0) {
            setResult(res);
          } else {
            setError("Couldn't build a simulation for this prospect.");
          }
        })
        .catch(() => {
          // The backend is graceful, but guard the call site regardless.
          setError("The simulator is warming up — try again in a moment.");
        })
        .finally(() => setLoading(false));
    };

    window.addEventListener("intercept:simulate-convo", onSimulate as EventListener);
    return () =>
      window.removeEventListener("intercept:simulate-convo", onSimulate as EventListener);
  }, [simulate, resetPlayback]);

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

  // ── Drive the playback once a result lands ──────────────────────────────────
  useEffect(() => {
    if (!result) return;
    clearTimers();
    setShown([]);
    setTypingFrom(null);
    setIntent(0);
    setDone(false);

    const msgs = result.messages;
    let cursor = 0;

    const step = () => {
      if (cursor >= msgs.length) {
        setTypingFrom(null);
        const t = setTimeout(() => setDone(true), SETTLE);
        timers.current.push(t);
        return;
      }
      const msg = msgs[cursor];
      setTypingFrom(msg.from);

      const reveal = setTimeout(() => {
        setShown((prev) => [...prev, msg]);
        setTypingFrom(null);
        setIntent(msg.intent);
        cursor += 1;
        const next = setTimeout(step, SETTLE);
        timers.current.push(next);
      }, typingDelay(msg.text));
      timers.current.push(reveal);
    };

    // Small beat before the opener so the modal settles first.
    const kickoff = setTimeout(step, 420);
    timers.current.push(kickoff);

    return () => clearTimers();
  }, [result, clearTimers]);

  // Keep the transcript pinned to the newest message / typing bubble.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown, typingFrom, done]);

  if (!open) return null;

  const verdictMeta = result ? VERDICT_META[result.verdict] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Conversation Simulator"
      onClick={close}
    >
      <div
        className="relative flex h-[640px] max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <p className="caption font-mono uppercase tracking-wide text-ink/50">
              Conversation Simulator
            </p>
            <h2 className="mt-1 truncate text-[15px] font-fig-headline text-ink">
              {result ? `${result.name} · ${result.company}` : headerName}
            </h2>
            <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
              {result?.title
                ? result.title
                : loading
                  ? "Simulating a live outbound thread…"
                  : "A preview of how this conversation could play out"}
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

        {/* Intent meter */}
        <IntentMeter intent={intent} live={!done && !!result} />

        {/* Transcript */}
        <div
          ref={scrollRef}
          className="col-scroll min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-soft/50 px-5 py-4"
        >
          {loading && !result && <LoadingState name={headerName} />}

          {error && !result && (
            <div className="grid h-full place-items-center text-center text-[13px] text-ink/55">
              {error}
            </div>
          )}

          {result?.signal && (
            <div className="mx-auto mb-1 w-fit rounded-full border border-hairline bg-canvas px-3 py-1 text-[10.5px] text-ink/55">
              <span className="font-mono uppercase tracking-wide text-ink/40">signal</span>{" "}
              {result.signal}
            </div>
          )}

          {shown.map((m, i) => (
            <Bubble key={i} from={m.from} text={m.text} />
          ))}

          {typingFrom && <TypingBubble from={typingFrom} />}

          {done && result && verdictMeta && (
            <div className="animate-row-in pt-2">
              <div className="rounded-xl border border-hairline bg-canvas p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="caption font-mono uppercase tracking-wide text-ink/45">
                      Final read
                    </p>
                    <p className="mt-1 text-2xl font-fig-card tabular-nums text-ink">
                      {result.score}
                      <span className="text-sm text-ink/40">/100</span>
                    </p>
                  </div>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-[12.5px] font-fig-link text-ink"
                    style={{ background: `rgb(${verdictMeta.hex})` }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
                      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {result.verdict}
                  </span>
                </div>
                <p className="mt-2 text-[12px] text-ink/60">{verdictMeta.sub}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <span className="text-[11px] text-ink/45">
            {result?.degraded
              ? "Offline preview · connect a model key for live simulation"
              : done
                ? "Simulation complete"
                : result
                  ? "Playing…"
                  : " "}
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
// Intent meter — a thin bar that climbs as the prospect warms up.
// ---------------------------------------------------------------------------
function IntentMeter({ intent, live }: { intent: number; live: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(intent)));
  const hex = pct >= 70 ? "var(--block-mint)" : pct >= 40 ? "var(--block-cream)" : "var(--block-pink)";
  return (
    <div className="border-b border-hairline bg-canvas px-5 py-2.5">
      <div className="flex items-center justify-between">
        <span className="caption font-mono uppercase tracking-wide text-ink/45">
          Buying intent
        </span>
        <span className="text-[12px] font-fig-card tabular-nums text-ink">
          {pct}
          <span className="text-ink/40">%</span>
          {live && <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success align-middle" />}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-ink/8">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%`, background: `rgb(${hex})` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat bubbles.
// ---------------------------------------------------------------------------
function Bubble({ from, text }: { from: Speaker; text: string }) {
  const us = from === "us";
  return (
    <div className={cn("flex animate-row-in", us ? "justify-end" : "justify-start")}>
      <div className="max-w-[80%]">
        <span
          className={cn(
            "mb-1 block text-[9.5px] font-mono uppercase tracking-[0.14em]",
            us ? "text-right text-ink/40" : "text-ink/40",
          )}
        >
          {us ? "INTERCEPT" : "Prospect"}
        </span>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed",
            us
              ? "rounded-br-md bg-ink text-on-primary"
              : "rounded-bl-md border border-hairline bg-canvas text-ink",
          )}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

function TypingBubble({ from }: { from: Speaker }) {
  const us = from === "us";
  return (
    <div className={cn("flex animate-row-in", us ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex items-center gap-1 rounded-2xl px-4 py-3",
          us ? "rounded-br-md bg-ink/85" : "rounded-bl-md border border-hairline bg-canvas",
        )}
        aria-label={us ? "INTERCEPT is typing" : "Prospect is typing"}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "inline-block h-1.5 w-1.5 animate-bounce rounded-full",
              us ? "bg-on-primary/70" : "bg-ink/40",
            )}
            style={{ animationDelay: `${i * 140}ms`, animationDuration: "900ms" }}
          />
        ))}
      </div>
    </div>
  );
}

function LoadingState({ name }: { name: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <div className="mx-auto flex w-fit items-center gap-1 rounded-2xl border border-hairline bg-canvas px-4 py-3">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-ink/40"
              style={{ animationDelay: `${i * 140}ms`, animationDuration: "900ms" }}
            />
          ))}
        </div>
        <p className="mt-3 text-[12.5px] text-ink/55">
          Drafting a personalized thread for {name}…
        </p>
      </div>
    </div>
  );
}
