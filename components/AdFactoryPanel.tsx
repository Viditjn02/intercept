"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

// ============================================================================
// AdFactoryPanel — AI Ad Factory · CREATE / REPLICATE. Replaces DesignPanel.
//
// Renders the generated ad(s) the adsmith agent produced: the AI hero image in a
// 1:1 / 4:5 ad frame (or a tasteful "image paused" placeholder on the graceful
// degraded path), the primary headline + body + CTA, the copy variations as
// switchable tabs, the strategy ("why this should win"), and a link back to the
// scanned ad it's grounded on (or the replicated source URL).
//
// Backend (adsmith agent):
//   api.agents.adsmith.creativesForRun({ runId }) : Doc<"adCreatives">[]
// ============================================================================

interface AdFactoryPanelProps {
  runId: Id<"runs">;
}

function AdImage({ ad }: { ad: Doc<"adCreatives"> }) {
  if (ad.imageStatus === "done" && ad.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={ad.imageUrl}
        alt={ad.headline || "Generated ad"}
        loading="lazy"
        className="aspect-[4/5] w-full rounded-xl object-cover ring-1 ring-line"
      />
    );
  }

  // Graceful $0 / no-key path — the copy is live, the image is paused.
  return (
    <div className="grid aspect-[4/5] w-full place-items-center rounded-xl border border-dashed border-line bg-ink/60 ring-1 ring-line">
      <div className="flex max-w-[14rem] flex-col items-center gap-2 px-4 text-center">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-accent/10 text-accent ring-1 ring-accent/30">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </div>
        <p className="text-[12px] font-medium text-zinc-300">Image generation paused</p>
        <p className="text-[11px] leading-snug text-zinc-500">
          {ad.degradedReason === "fal_zero_balance"
            ? "fal balance is $0 — the copy is live."
            : "Image gen unavailable — the copy is live."}
        </p>
      </div>
    </div>
  );
}

function AdCard({ ad }: { ad: Doc<"adCreatives"> }) {
  // tab -1 = the primary; 0..N-1 = the variations.
  const [tab, setTab] = useState(-1);
  const variation = tab >= 0 ? ad.variations[tab] : null;
  const headline = variation?.headline ?? ad.headline;
  const primaryText = variation?.primaryText ?? ad.primaryText;
  const cta = variation?.cta ?? ad.cta;

  return (
    <div className="grid gap-0 lg:grid-cols-[1fr_1.2fr]">
      <div className="border-b border-line p-5 lg:border-b-0 lg:border-r">
        <AdImage ad={ad} />
      </div>

      <div className="flex flex-col gap-3 p-5">
        {/* variation tabs */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTab(-1)}
            className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              tab === -1 ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-panel/60 text-white/55 hover:text-white"
            }`}
          >
            Primary
          </button>
          {ad.variations.map((vr, i) => (
            <button
              key={i}
              onClick={() => setTab(i)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                tab === i ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-panel/60 text-white/55 hover:text-white"
              }`}
            >
              {vr.angle || `Variant ${i + 1}`}
            </button>
          ))}
        </div>

        <h4 className="text-base font-semibold leading-snug text-zinc-100">{headline}</h4>
        <p className="text-sm leading-relaxed text-zinc-300">{primaryText}</p>

        <div>
          <span className="inline-flex rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-ink">{cta}</span>
        </div>

        {ad.strategy && (
          <div className="mt-1 rounded-xl border border-line bg-ink/40 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-accent">Why this should win</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-300">{ad.strategy}</p>
          </div>
        )}

        <p className="text-[11px] text-zinc-600">
          {ad.kind === "replica" && ad.sourceUrl ? (
            <>
              Replicated from{" "}
              <a href={ad.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
                the source post
              </a>
            </>
          ) : ad.groundedOnAdId ? (
            "Grounded on the scanned winning ad"
          ) : (
            "Generated from the brief"
          )}
        </p>
      </div>
    </div>
  );
}

export default function AdFactoryPanel({ runId }: AdFactoryPanelProps) {
  const creatives = useQuery(api.agents.adsmith.creativesForRun, { runId });
  const loading = creatives === undefined;
  const hasContent = (creatives?.length ?? 0) > 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/80">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Generated ad</h3>
          <p className="text-xs text-zinc-500">A similar ad in your buyers&apos; own words — image, copy, and variations</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
            hasContent ? "bg-good/15 text-good ring-1 ring-good/30" : "bg-accent/15 text-accent ring-1 ring-accent/30"
          }`}
        >
          {hasContent ? "Ready" : "Generating"}
        </span>
      </header>

      {!hasContent ? (
        <div className="grid place-items-center px-6 py-16">
          <div className="flex max-w-xs flex-col items-center gap-3 text-center">
            {loading ? (
              <>
                <div className="relative h-12 w-12">
                  <span className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-accent" />
                  <span className="absolute inset-2 rounded-full bg-accent/10" />
                </div>
                <p className="text-sm text-zinc-400">Loading the ad factory…</p>
              </>
            ) : (
              <>
                <div className="grid h-12 w-12 place-items-center rounded-full bg-accent/10 text-accent ring-1 ring-accent/30">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="18" height="18" rx="2.5" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-5-5L5 21" />
                  </svg>
                </div>
                <p className="text-sm text-zinc-400">Generating a similar ad grounded in the winning angle…</p>
                <p className="text-xs text-zinc-600">This appears the moment Ad Smith finishes.</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="divide-y divide-line">
          {creatives!.map((ad) => (
            <AdCard key={ad._id} ad={ad} />
          ))}
        </div>
      )}
    </section>
  );
}
