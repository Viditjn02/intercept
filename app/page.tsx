"use client";

import { FormEvent, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import SwarmBoard from "@/components/SwarmBoard";
import Brief from "@/components/Brief";

const EXAMPLES = [
  "https://linear.app",
  "Resend",
  "vercel.com",
  "an open-source Postgres host",
];

export default function Home() {
  const createRun = useMutation(api.runs.createRun);
  const [value, setValue] = useState("");
  const [runId, setRunId] = useState<Id<"runs"> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input = value.trim();
    if (!input || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const id = (await createRun({ input })) as Id<"runs">;
      setRunId(id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start the run. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setRunId(null);
    setValue("");
    setError(null);
  }

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-8 sm:px-8">
      {/* Header */}
      <header className="flex items-center justify-between">
        <button
          onClick={reset}
          className="group flex items-center gap-2.5 text-left"
          aria-label="HOLMES home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-panel">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-accent">
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[17px] font-semibold tracking-tight">
            HOLMES
          </span>
          <span className="hidden rounded-full border border-line bg-panel px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-white/40 sm:inline">
            live intent radar
          </span>
        </button>
        {runId && (
          <button
            onClick={reset}
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-white/70 transition-colors hover:border-accent/40 hover:text-white"
          >
            New run
          </button>
        )}
      </header>

      {/* Hero + input (only before a run starts) */}
      {!runId && (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <div className="animate-fade-up">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-white/55">
              <span className="h-1.5 w-1.5 rounded-full bg-good" />
              5-agent swarm · live threads · drafted replies · in under 3 minutes
            </p>
            <h1 className="mx-auto max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
              Find the <span className="text-shimmer">live conversations</span>
              <br className="hidden sm:block" /> where your buyers are already asking.
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-white/50">
              Point HOLMES at a company. A swarm of agents surfaces the exact
              threads your buyers are posting in right now — each clickable,
              intent-scored, with a reply drafted and waiting for your approval.
            </p>
          </div>

          <form
            onSubmit={onSubmit}
            className="animate-fade-up mt-9 w-full max-w-2xl"
            style={{ animationDelay: "80ms" }}
          >
            <div className="flex items-center gap-2 rounded-2xl border border-line bg-panel p-2 shadow-2xl shadow-black/40 transition-colors focus-within:border-accent/50">
              <span className="pl-2 text-white/30">
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                  <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Paste a company URL — or anything"
                className="flex-1 bg-transparent px-1 py-2.5 text-[15px] text-white placeholder:text-white/30 focus:outline-none"
                aria-label="Company URL or description"
              />
              <button
                type="submit"
                disabled={!value.trim() || submitting}
                className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-ink transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin-slow rounded-full border-2 border-ink/30 border-t-ink" />
                    Starting
                  </>
                ) : (
                  <>
                    Unleash swarm
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                      <path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </>
                )}
              </button>
            </div>

            {error && (
              <p className="mt-3 text-sm text-red-300">{error}</p>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-white/40">
              <span>Try</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setValue(ex)}
                  className="rounded-full border border-line bg-panel px-3 py-1 text-white/55 transition-colors hover:border-accent/40 hover:text-white"
                >
                  {ex}
                </button>
              ))}
            </div>
          </form>
        </div>
      )}

      {/* Live run view */}
      {runId && (
        <div className="mt-8 flex flex-col gap-8 pb-16">
          <SwarmBoard runId={runId} />
          <Brief runId={runId} />
        </div>
      )}

      {!runId && (
        <footer className="mt-auto pt-8 text-center text-xs text-white/25">
          The moat: a clickable, intent-scored link to a live conversation —
          verifiable in one tap.
        </footer>
      )}
    </main>
  );
}
