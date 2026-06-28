"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

// ============================================================================
// AdGallery — AI Ad Factory · AD INTELLIGENCE (scan). Replaces CompetitorAds.
//
// The competitor's LIVE ads, scanned across Meta + TikTok with NO API token and
// ranked by a per-ad performance score + run-duration. Each card shows the
// network/platform, media, active status + longevity, the 5-axis score, the
// winning angle, and a "Generate similar" button that spawns a CREATE run
// grounded on that exact ad (api.runs.generateSimilar) and focuses it.
//
// Backend (adscout agent / convex/ads.ts):
//   api.ads.listByRun({ runId }) : Doc<"ads">[]   (ranked winning-first)
//   api.runs.generateSimilar({ adId }) : Id<"runs">
// ============================================================================

interface AdGalleryProps {
  runId: Id<"runs">;
  onFocusRun?: (runId: Id<"runs"> | undefined, intent?: string) => void;
}

const NETWORK_META: Record<string, { label: string; symbol: string; accent: string }> = {
  meta: { label: "Meta", symbol: "f", accent: "text-sky-400" },
  facebook: { label: "Facebook", symbol: "f", accent: "text-sky-400" },
  instagram: { label: "Instagram", symbol: "◎", accent: "text-pink-400" },
  audience_network: { label: "Audience Network", symbol: "▦", accent: "text-violet-300" },
  messenger: { label: "Messenger", symbol: "✦", accent: "text-sky-300" },
  tiktok: { label: "TikTok", symbol: "♪", accent: "text-fuchsia-300" },
};

function networkMeta(ad: Doc<"ads">) {
  const key = (ad.network ?? ad.platform ?? "").toLowerCase();
  return NETWORK_META[key] ?? { label: ad.platform || "Ad", symbol: "#", accent: "text-zinc-300" };
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

const SCORE_AXES: { key: keyof NonNullable<Doc<"ads">["scores"]>; label: string }[] = [
  { key: "hook", label: "Hook" },
  { key: "clarity", label: "Clarity" },
  { key: "cta", label: "CTA" },
  { key: "quality", label: "Quality" },
  { key: "engagement", label: "Engagement" },
];

function ScoreBars({ scores }: { scores: NonNullable<Doc<"ads">["scores"]> }) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {SCORE_AXES.map((axis) => {
        const val = Math.max(0, Math.min(100, scores[axis.key] ?? 0));
        return (
          <div key={axis.key} className="flex flex-col items-center gap-1">
            <div className="flex h-10 w-full items-end overflow-hidden rounded bg-white/5">
              <div
                className="w-full rounded-t bg-gradient-to-t from-accent to-good"
                style={{ height: `${Math.max(val, 4)}%` }}
              />
            </div>
            <span className="text-[8.5px] uppercase tracking-wide text-zinc-500">{axis.label}</span>
          </div>
        );
      })}
    </div>
  );
}

interface AdCardProps {
  ad: Doc<"ads">;
  rank: number;
  onFocusRun?: (runId: Id<"runs"> | undefined, intent?: string) => void;
}

function AdCard({ ad, rank, onFocusRun }: AdCardProps) {
  const net = networkMeta(ad);
  const active = ad.status === "active";
  const scaling = ad.scalingSignal === true;
  const isTop = rank === 0 && active;
  const media = ad.thumbnailUrl ?? ad.imageUrl ?? null;
  const generateSimilar = useMutation(api.runs.generateSimilar);
  const [pending, setPending] = useState(false);

  const onGenerate = async () => {
    setPending(true);
    try {
      const newRunId = await generateSimilar({ adId: ad._id });
      onFocusRun?.(newRunId, "content");
    } catch {
      // best-effort — leave the gallery as-is on failure
    } finally {
      setPending(false);
    }
  };

  return (
    <article
      className={`group relative flex flex-col gap-3 rounded-2xl border border-line bg-panel/80 p-4 backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-line/80 ${
        isTop ? "shadow-[0_0_40px_-12px_rgba(52,211,153,0.4)]" : ""
      }`}
    >
      {scaling && (
        <span className="absolute -right-1 -top-1 rounded-bl-lg rounded-tr-2xl bg-good/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-good ring-1 ring-good/30">
          Scaling
        </span>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <span className={`grid h-6 w-6 place-items-center rounded-md bg-ink font-bold ${net.accent}`} aria-hidden>
            {net.symbol}
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

      {media && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media}
          alt={`${ad.advertiser} ad creative`}
          loading="lazy"
          className="h-40 w-full rounded-xl object-cover ring-1 ring-line"
        />
      )}

      {(ad.perfScore !== undefined || ad.scores) && (
        <div className="flex items-center gap-3">
          {ad.perfScore !== undefined && (
            <div className="flex flex-col items-center">
              <span className="text-lg font-bold tabular-nums text-good">{Math.round(ad.perfScore)}</span>
              <span className="text-[8.5px] uppercase tracking-wide text-zinc-500">Score</span>
            </div>
          )}
          {ad.scores && (
            <div className="flex-1">
              <ScoreBars scores={ad.scores} />
            </div>
          )}
        </div>
      )}

      {ad.headline && <p className="text-sm font-semibold leading-snug text-zinc-100">{ad.headline}</p>}

      <p className="line-clamp-4 text-sm leading-relaxed text-zinc-300">
        {ad.text ? `“${ad.text}”` : <span className="text-zinc-600">No ad copy captured.</span>}
      </p>

      {ad.winningAngle && (
        <p className="rounded-lg bg-accent/5 px-2.5 py-1.5 text-[11px] leading-snug text-accent ring-1 ring-accent/15">
          Winning angle: {ad.winningAngle}
        </p>
      )}

      <div className="mt-1 flex items-center justify-between gap-2 border-t border-line/70 pt-3 text-xs text-zinc-500">
        <a
          href={ad.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 font-medium text-zinc-200 ring-1 ring-line transition-colors hover:bg-line/40 hover:text-white"
        >
          View ad
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7 17 17 7" />
            <path d="M7 7h10v10" />
          </svg>
        </a>
        <button
          onClick={onGenerate}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent/15 px-3 py-1.5 font-semibold text-accent ring-1 ring-accent/30 transition-colors hover:bg-accent/25 disabled:opacity-50"
        >
          {pending ? "Generating…" : "Generate similar"}
        </button>
      </div>
    </article>
  );
}

export default function AdGallery({ runId, onFocusRun }: AdGalleryProps) {
  const ads = useQuery(api.ads.listByRun, { runId });
  const loading = ads === undefined;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/80">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Ad intelligence · what&apos;s winning right now</h3>
          <p className="text-xs text-zinc-500">
            No API token — scanned live across Meta + TikTok, scored and ranked.
          </p>
        </div>
        {!loading && ads.length > 0 && (
          <span className="rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-accent ring-1 ring-accent/30">
            {ads.length} scanned
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
              Nothing came back for this advertiser on the scanned networks. The rest of the brief is unaffected.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {ads.map((ad, i) => (
              <AdCard key={ad._id} ad={ad} rank={i} onFocusRun={onFocusRun} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
