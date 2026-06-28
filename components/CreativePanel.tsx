"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// ============================================================================
// CreativePanel — the generated Veo video ad.
// Renders the finished clip, or a graceful "rendering" state while the creative
// agent is still working.
//
// Expected backend (owned by the creative agent):
//   api.brief.getCreative({ runId }) : Doc<"creatives"> | null
// ============================================================================

interface CreativePanelProps {
  runId: Id<"runs">;
}

export default function CreativePanel({ runId }: CreativePanelProps) {
  const creative = useQuery(api.brief.getCreative, { runId });

  const loading = creative === undefined;
  const status = creative?.status;
  const ready = status === "done" && !!creative?.url;
  const failed = status === "failed";

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/80">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Generated video ad</h3>
          <p className="text-xs text-zinc-500">
            {creative?.model ? `Rendered with ${creative.model}` : "Veo creative"}
          </p>
        </div>
        {status && (
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
              ready
                ? "bg-good/15 text-good ring-1 ring-good/30"
                : failed
                  ? "bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
                  : "bg-accent/15 text-accent ring-1 ring-accent/30"
            }`}
          >
            {ready ? "Ready" : failed ? "Failed" : "Rendering"}
          </span>
        )}
      </header>

      <div className="aspect-video w-full bg-ink">
        {ready ? (
          <video
            key={creative.url}
            src={creative.url}
            controls
            playsInline
            poster={undefined}
            className="h-full w-full object-contain"
          >
            Your browser does not support embedded video.
          </video>
        ) : (
          <div className="grid h-full w-full place-items-center">
            <div className="flex flex-col items-center gap-3 text-center">
              {failed ? (
                <>
                  <div className="grid h-12 w-12 place-items-center rounded-full bg-red-500/10 text-red-300 ring-1 ring-red-500/30">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                    </svg>
                  </div>
                  <p className="text-sm text-zinc-400">Video render failed.</p>
                </>
              ) : (
                <>
                  <div className="relative h-12 w-12">
                    <span className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-accent" />
                    <span className="absolute inset-2 rounded-full bg-accent/10" />
                  </div>
                  <p className="text-sm text-zinc-400">
                    {loading ? "Loading creative…" : "Rendering your video ad…"}
                  </p>
                  <p className="max-w-xs text-xs text-zinc-600">
                    Veo is generating a short ad from the positioning. This appears the moment it
                    finishes.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
