"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import LinkBreakdown from "./LinkBreakdown";

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
        className="aspect-[4/5] w-full rounded-md object-cover ring-1 ring-hairline"
      />
    );
  }

  // Graceful $0 / no-key path — the copy is live, the image is paused.
  return (
    <div className="grid aspect-[4/5] w-full place-items-center rounded-md border border-hairline bg-surface-soft">
      <div className="flex max-w-[14rem] flex-col items-center gap-2 px-4 text-center">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-canvas text-ink">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </div>
        <p className="text-body-sm text-ink">Image generation paused</p>
        <p className="text-body-sm leading-snug text-ink/60">
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
      <div className="border-b border-hairline p-5 lg:border-b-0 lg:border-r">
        <AdImage ad={ad} />
      </div>

      <div className="flex flex-col gap-3 p-5">
        {/* variation tabs */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTab(-1)}
            className={`rounded-pill px-2.5 py-1 text-[11px] font-fig-link transition-colors ${
              tab === -1 ? "bg-primary text-on-primary" : "border border-hairline bg-canvas text-ink hover:bg-surface-soft"
            }`}
          >
            Primary
          </button>
          {ad.variations.map((vr, i) => (
            <button
              key={i}
              onClick={() => setTab(i)}
              className={`rounded-pill px-2.5 py-1 text-[11px] font-fig-link transition-colors ${
                tab === i ? "bg-primary text-on-primary" : "border border-hairline bg-canvas text-ink hover:bg-surface-soft"
              }`}
            >
              {vr.angle || `Variant ${i + 1}`}
            </button>
          ))}
        </div>

        <h4 className="text-card-title leading-snug text-ink">{headline}</h4>
        <p className="text-body-sm text-ink/80">{primaryText}</p>

        <div>
          <span className="inline-flex rounded-pill bg-primary px-3 py-1.5 text-body-sm font-fig-link text-on-primary">{cta}</span>
        </div>

        {ad.strategy && (
          <div className="mt-1 rounded-md bg-block-lime p-3">
            <p className="eyebrow text-[11px] text-ink">Why this should win</p>
            <p className="mt-1 text-body-sm leading-relaxed text-ink/80">{ad.strategy}</p>
          </div>
        )}

        <p className="text-body-sm text-ink/50">
          {ad.kind === "replica" && ad.sourceUrl ? (
            <>
              Replicated from{" "}
              <a href={ad.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-ink underline underline-offset-2">
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
    <section className="overflow-hidden rounded-lg border border-hairline bg-canvas">
      <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <div>
          <h3 className="text-headline text-ink">Generated ad</h3>
          <p className="text-body-sm text-ink/60">A similar ad in your buyers&apos; own words — image, copy, and variations</p>
        </div>
        <span
          className={`caption inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 ${
            hasContent ? "bg-block-mint text-ink" : "bg-surface-soft text-ink"
          }`}
        >
          {hasContent && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
          {hasContent ? "Ready" : "Generating"}
        </span>
      </header>

      {!hasContent ? (
        <div className="grid place-items-center px-6 py-16">
          <div className="flex max-w-xs flex-col items-center gap-3 text-center">
            {loading ? (
              <>
                <div className="relative h-12 w-12">
                  <span className="absolute inset-0 animate-spin rounded-full border-2 border-hairline border-t-ink" />
                  <span className="absolute inset-2 rounded-full bg-surface-soft" />
                </div>
                <p className="text-body-sm text-ink/70">Loading the ad factory…</p>
              </>
            ) : (
              <>
                <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-soft text-ink">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="18" height="18" rx="2.5" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-5-5L5 21" />
                  </svg>
                </div>
                <p className="text-body-sm text-ink/70">Generating a similar ad grounded in the winning angle…</p>
                <p className="text-body-sm text-ink/50">This appears the moment Ad Smith finishes.</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="divide-y divide-hairline">
          {creatives!.map((ad) => (
            <AdCard key={ad._id} ad={ad} />
          ))}
        </div>
      )}

      {/* Subtle: break down a reference link into angles & hooks for the next ad. */}
      <div className="border-t border-hairline p-5">
        <LinkBreakdown
          title="Inspired by a link? Drop it"
          hint="Paste a competitor ad or video — we'll pull the angles & hooks."
        />
      </div>
    </section>
  );
}
