"use client";

// ============================================================================
// SwarmBoot — the brief "the swarm is spinning up" beat shown on a freshly
// opened / fired RUN board, just before the real board is revealed. It exists
// so a PRE-WARMED (reused / cached) run never snaps in instantly and looks fake:
// a ~1s beat makes every reveal read as real, live work starting.
//
// Purely cosmetic. It echoes the real SwarmBoard's anatomy (live status dot →
// shimmer progress track → a row of agent tiles materialising) using the app's
// OWN skeleton / scan-track / text-shimmer styling, so the boot reads as the
// swarm board itself coming online rather than a generic spinner. Light Figma
// tokens only; never interactive; never throws.
// ============================================================================

export default function SwarmBoot({ label }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label="Spinning up the swarm"
      className="flex h-full min-h-0 items-center justify-center px-5"
    >
      <div className="w-full max-w-md animate-scale-in">
        {/* mode eyebrow — the same wayfinding noun the board will carry */}
        {label && (
          <p className="eyebrow mb-3 text-center text-ink/55">{label}</p>
        )}

        {/* live header echo — a pulsing ink dot + a shimmering headline */}
        <div className="mb-3 flex items-center justify-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5 text-ink" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ink/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ink" />
          </span>
          <h2 className="text-shimmer text-[15px] font-fig-headline text-ink">
            Spinning up the swarm…
          </h2>
        </div>

        {/* shimmer progress track — the same ink scan-line a running tile uses */}
        <div
          className="mx-auto mb-5 h-1 w-full overflow-hidden rounded-full bg-surface-soft"
          aria-hidden
        >
          <div className="scan-track h-full w-full" />
        </div>

        {/* agent tiles materialising — skeleton echoes of the swarm grid */}
        <div className="grid grid-cols-3 gap-2.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex animate-fade-up flex-col gap-2.5 rounded-lg border border-hairline bg-canvas p-3.5"
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <div className="flex items-center justify-between">
                <div className="skeleton h-9 w-9 rounded-md" />
                <div className="skeleton h-4 w-12 rounded-full" />
              </div>
              <div className="skeleton h-3 w-3/4 rounded-full" />
              <div className="skeleton h-2 w-full rounded-full" />
            </div>
          ))}
        </div>

        <p className="mt-4 text-center text-[11.5px] font-fig-body text-ink/55">
          Waking agents · warming the live feed
        </p>
      </div>
    </div>
  );
}
