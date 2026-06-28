"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import SwarmBoard from "@/components/SwarmBoard";
import Brief from "@/components/Brief";

// ============================================================================
// HOLMES — RUN-BY-ID VIEW
// Renders a single run's live swarm board + brief from the URL. This is the
// render path for the deterministic replay: scripts/seed-demo.ts returns a
// runId, and `/run/<id>` opens it on stage (no live API calls — it cannot flop).
// It also lets any in-flight live run be deep-linked / refreshed.
// ============================================================================

export default function RunPage() {
  const params = useParams<{ id: string }>();
  const runId = params?.id as Id<"runs"> | undefined;

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-8 sm:px-8">
      <header className="flex items-center justify-between">
        <Link
          href="/"
          className="group flex items-center gap-2.5 text-left"
          aria-label="HOLMES home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-panel">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-accent">
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[17px] font-semibold tracking-tight">HOLMES</span>
          <span className="hidden rounded-full border border-line bg-panel px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-white/40 sm:inline">
            live intent radar
          </span>
        </Link>
        <Link
          href="/"
          className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-white/70 transition-colors hover:border-accent/40 hover:text-white"
        >
          New run
        </Link>
      </header>

      {runId ? (
        <div className="mt-8 flex flex-col gap-8 pb-16">
          <SwarmBoard runId={runId} />
          <Brief runId={runId} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center py-20 text-sm text-white/45">
          No run id in the URL.
        </div>
      )}
    </main>
  );
}
