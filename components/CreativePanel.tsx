"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// ============================================================================
// CreativePanel — the generated video ad.
//
// States (NEVER a red error — the brief stays green):
//   • ready      → the finished clip plays.
//   • rendering  → a calm spinner while the creative agent works.
//   • preview    → GRACEFUL DEGRADE: no video rendered (free worker down + no
//                  Veo/fal balance). We show the static gpt-image-1 ad image
//                  (from adsmith, via getCreative.posterUrl) under a soft
//                  "Video preview · queued" caption, or a calm queued card when
//                  no image exists yet. Legacy "failed" rows render the same
//                  calm way — never a scary red "FAILED".
//
// Backend (owned by the creative agent):
//   api.brief.getCreative({ runId }) : (Doc<"creatives"> & {
//     storageUrl: string | null; posterUrl: string | null
//   }) | null
// ============================================================================

interface CreativePanelProps {
  runId: Id<"runs">;
}

export default function CreativePanel({ runId }: CreativePanelProps) {
  const creative = useQuery(api.brief.getCreative, { runId });

  const loading = creative === undefined;
  const status = creative?.status;
  const playbackUrl = creative?.storageUrl ?? creative?.url ?? null;
  const posterUrl = creative?.posterUrl ?? null;
  const ready = status === "done" && !!playbackUrl;
  // "preview" (and legacy "failed") both degrade calmly — never a red error.
  const degraded = status === "preview" || status === "failed";

  const pillLabel = ready ? "Ready" : degraded ? "Preview" : "Rendering";

  return (
    <section className="overflow-hidden rounded-lg border border-hairline bg-canvas">
      <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <div>
          <h3 className="text-headline text-ink">Generated video ad</h3>
          <p className="text-body-sm text-ink/60">
            {creative?.model ? `Rendered with ${creative.model}` : "Video creative"}
          </p>
        </div>
        {status && (
          <span
            className={`caption inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 ${
              ready ? "bg-block-mint text-ink" : "bg-surface-soft text-ink"
            }`}
          >
            {ready && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
            {pillLabel}
          </span>
        )}
      </header>

      <div className="relative aspect-video w-full bg-surface-soft">
        {ready ? (
          <video
            key={playbackUrl}
            src={playbackUrl ?? undefined}
            controls
            playsInline
            poster={posterUrl ?? undefined}
            className="h-full w-full object-contain"
          >
            Your browser does not support embedded video.
          </video>
        ) : degraded && posterUrl ? (
          // GRACEFUL DEGRADE — show the static gpt-image-1 ad image with a calm,
          // non-error caption. The video simply hasn't rendered (free path / no balance).
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={posterUrl}
              alt="Static ad preview"
              loading="lazy"
              className="h-full w-full object-contain"
            />
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/55 to-transparent px-4 py-3">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/90" aria-hidden>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <p className="text-body-sm text-white/90">Video preview · queued — showing the static ad</p>
            </div>
          </>
        ) : (
          <div className="grid h-full w-full place-items-center">
            <div className="flex flex-col items-center gap-3 text-center">
              {degraded ? (
                // No video and no static image yet — a calm queued card. No red.
                <>
                  <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-soft text-ink">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                  </div>
                  <p className="text-body-sm text-ink/70">Video preview · queued</p>
                  <p className="max-w-xs text-body-sm text-ink/50">
                    The static ad is live in the brief. The video renders for free in the
                    background and appears here the moment it&apos;s ready.
                  </p>
                </>
              ) : (
                <>
                  <div className="relative h-12 w-12">
                    <span className="absolute inset-0 animate-spin rounded-full border-2 border-hairline border-t-ink" />
                    <span className="absolute inset-2 rounded-full bg-canvas" />
                  </div>
                  <p className="text-body-sm text-ink/70">
                    {loading ? "Loading creative…" : "Rendering your video ad…"}
                  </p>
                  <p className="max-w-xs text-body-sm text-ink/50">
                    Generating a short ad from the positioning. This appears the moment it
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
