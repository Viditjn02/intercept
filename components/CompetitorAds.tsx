"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

// ============================================================================
// CompetitorAds — AI Ad Factories.
// The competitor's LIVE ads from the Meta Ad Library, ranked by how long they
// have been running. Longevity is the signal: advertisers kill losers fast and
// let winners run for months, so "running 47 days" ≈ "this creative converts".
// The top card is the angle INTERCEPT should mirror.
//
// Backend (owned by the adscout agent / convex/ads.ts):
//   api.ads.listByRun({ runId }) : Doc<"ads">[]   (ranked winning-first)
// ============================================================================

interface CompetitorAdsProps {
  runId: Id<"runs">;
}

const PLATFORM_META: Record<string, { label: string; symbol: string; accent: string }> = {
  facebook: { label: "Facebook", symbol: "f", accent: "text-sky-400" },
  instagram: { label: "Instagram", symbol: "◎", accent: "text-pink-400" },
  audience_network: { label: "Audience Network", symbol: "▦", accent: "text-violet-300" },
  messenger: { label: "Messenger", symbol: "✦", accent: "text-sky-300" },
};

function platformMeta(platform: string) {
  return (
    PLATFORM_META[platform.toLowerCase()] ?? {
      label: platform,
      symbol: "#",
      accent: "text-zinc-300",
    }
  );
}

/** Longer-running ads read as stronger signal — tier the badge accordingly. */
function longevityChip(days: number | undefined, active: boolean): string {
  if (!active) return "bg-zinc-500/15 text-zinc-400 ring-1 ring-zinc-500/30";
  if ((days ?? 0) >= 30) return "bg-good/15 text-good ring-1 ring-good/30";
  if ((days ?? 0) >= 7) return "bg-accent/15 text-accent ring-1 ring-accent/30";
  return "bg-amber-400/15 text-amber-400 ring-1 ring-amber-400/30";
}

function longevityLabel(days: number | undefined, active: boolean): string {
  if (!active) return "Ended";
  if (days === undefined) return "Live";
  if (days <= 0) return "Live today";
  return `Running ${days} ${days === 1 ? "day" : "days"}`;
}

interface AdCardProps {
  ad: Doc<"ads">;
  rank: number;
}

function AdCard({ ad, rank }: AdCardProps) {
  const platform = platformMeta(ad.platform);
  const active = ad.status === "active";
  const isTop = rank === 0 && active && (ad.daysRunning ?? 0) >= 7;

  return (
    <article
      className={`group relative flex flex-col gap-3 rounded-2xl border border-line bg-panel/80 p-4 backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-line/80 ${
        isTop ? "shadow-[0_0_40px_-12px_rgba(52,211,153,0.4)]" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <span
            className={`grid h-6 w-6 place-items-center rounded-md bg-ink font-bold ${platform.accent}`}
            aria-hidden
          >
            {platform.symbol}
          </span>
          <span className="truncate text-zinc-300">{ad.advertiser}</span>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${longevityChip(
            ad.daysRunning,
            active,
          )}`}
        >
          {longevityLabel(ad.daysRunning, active)}
        </span>
      </div>

      <p className="line-clamp-4 text-sm leading-relaxed text-zinc-300">
        {ad.text ? `“${ad.text}”` : <span className="text-zinc-600">No ad copy captured.</span>}
      </p>

      <div className="mt-1 flex items-center justify-between gap-3 border-t border-line/70 pt-3 text-xs text-zinc-500">
        <span>
          {platform.label}
          {ad.runningSince ? ` · since ${ad.runningSince.slice(0, 10)}` : ""}
        </span>
        <a
          href={ad.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 font-medium text-zinc-200 ring-1 ring-line transition-colors hover:bg-line/40 hover:text-white"
        >
          View ad
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M7 17 17 7" />
            <path d="M7 7h10v10" />
          </svg>
        </a>
      </div>
    </article>
  );
}

export default function CompetitorAds({ runId }: CompetitorAdsProps) {
  const ads = useQuery(api.ads.listByRun, { runId });
  const loading = ads === undefined;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/80">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Competitor ads · what&apos;s working</h3>
          <p className="text-xs text-zinc-500">
            Live from the Meta Ad Library — ranked by longevity. The longer it runs, the better it converts.
          </p>
        </div>
        {!loading && ads.length > 0 && (
          <span className="rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-accent ring-1 ring-accent/30">
            {ads.length} live
          </span>
        )}
      </header>

      <div className="p-4">
        {loading ? (
          <div className="grid place-items-center py-10">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="relative h-10 w-10">
                <span className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-accent" />
                <span className="absolute inset-2 rounded-full bg-accent/10" />
              </div>
              <p className="text-sm text-zinc-400">Scanning the competitor&apos;s ad factory…</p>
            </div>
          </div>
        ) : ads.length === 0 ? (
          <div className="grid place-items-center py-10 text-center">
            <p className="text-sm text-zinc-400">No live competitor ads surfaced.</p>
            <p className="mt-1 max-w-sm text-xs text-zinc-600">
              The Meta Ad Library returned nothing for this advertiser (commercial-ad search is
              region/identity restricted). The rest of the brief is unaffected.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {ads.map((ad, i) => (
              <AdCard key={ad._id} ad={ad} rank={i} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
