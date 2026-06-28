"use client";

import { useEffect, useState } from "react";

// ============================================================================
// BrainPanel — "What the brain already knows about this market".
// Standalone, self-contained card the integrator can mount in the brief. It
// fetches /api/brain?company=X (the LOCAL gbrain CLI) and renders prior,
// compounding context for the company's market.
//
// GRACEFUL DEGRADATION: renders NOTHING while loading, when the brain CLI is
// unavailable, or when there's no prior knowledge yet. It never errors and never
// blocks the rest of the brief.
//
//   import BrainPanel from "@/components/BrainPanel";
//   <BrainPanel company={run.company ?? run.input} />
// ============================================================================

interface BrainPanelProps {
  company: string;
}

interface BrainApiResponse {
  available: boolean;
  company: string;
  answer: string;
}

export default function BrainPanel({ company }: BrainPanelProps) {
  const [answer, setAnswer] = useState<string>("");

  useEffect(() => {
    const trimmed = company?.trim();
    if (!trimmed) {
      setAnswer("");
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/brain?company=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as BrainApiResponse;
        if (cancelled) return;
        if (data.available && data.answer.trim()) {
          setAnswer(data.answer.trim());
        } else {
          setAnswer("");
        }
      } catch {
        // Network/abort/parse — stay silent, the panel simply won't render.
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [company]);

  // Nothing the brain knows (or unavailable) -> render nothing at all.
  if (!answer) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/60">
      <header className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span aria-hidden className="text-base leading-none">
          🧠
        </span>
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">
            What the brain already knows about this market
          </h3>
          <p className="text-[11px] text-zinc-500">
            Compounding context from prior INTERCEPT runs
          </p>
        </div>
      </header>

      <div className="px-5 py-4">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
          {answer}
        </p>
      </div>
    </section>
  );
}
