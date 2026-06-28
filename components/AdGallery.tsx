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

// Network identity — labels + glyphs. Glyphs sit on a neutral surface tile and
// read in ink (palette migration: no per-network hues).
const NETWORK_META: Record<string, { label: string; symbol: string }> = {
  meta: { label: "Meta", symbol: "f" },
  facebook: { label: "Facebook", symbol: "f" },
  instagram: { label: "Instagram", symbol: "◎" },
  audience_network: { label: "Audience Network", symbol: "▦" },
  messenger: { label: "Messenger", symbol: "✦" },
  tiktok: { label: "TikTok", symbol: "♪" },
};

function networkMeta(ad: Doc<"ads">) {
  const key = (ad.network ?? ad.platform ?? "").toLowerCase();
  return NETWORK_META[key] ?? { label: ad.platform || "Ad", symbol: "#" };
}

/** Longer-running ads read as stronger signal — tier the block tint accordingly. */
function longevityChip(days: number | undefined, active: boolean): string {
  if (!active) return "bg-surface-soft text-ink";
  if ((days ?? 0) >= 30) return "bg-block-mint text-ink";
  if ((days ?? 0) >= 7) return "bg-block-lime text-ink";
  return "bg-block-cream text-ink";
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
            <div className="flex h-10 w-full items-end overflow-hidden rounded-sm bg-surface-soft">
              <div
                className="w-full rounded-t-sm bg-ink"
                style={{ height: `${Math.max(val, 4)}%` }}
              />
            </div>
            <span className="caption text-ink/60 text-[8.5px]">{axis.label}</span>
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
      className={`group relative flex flex-col gap-3 rounded-lg border bg-canvas p-4 transition-colors ${
        isTop ? "border-ink" : "border-hairline"
      }`}
    >
      {scaling && (
        <span className="caption absolute -right-1 -top-1 inline-flex items-center gap-1 rounded-bl-lg rounded-tr-lg bg-block-mint px-2 py-1 text-ink">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          Scaling
        </span>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-surface-soft font-fig-card text-ink" aria-hidden>
            {net.symbol}
          </span>
          <span className="truncate text-body-sm text-ink">{ad.advertiser}</span>
        </div>
        <span
          className={`caption whitespace-nowrap rounded-pill px-2.5 py-1 ${longevityChip(
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
          className="h-40 w-full rounded-md object-cover ring-1 ring-hairline"
        />
      )}

      {(ad.perfScore !== undefined || ad.scores) && (
        <div className="flex items-center gap-3">
          {ad.perfScore !== undefined && (
            <div className="flex flex-col items-center">
              <span className="nums text-card-title text-success">{Math.round(ad.perfScore)}</span>
              <span className="caption text-ink/60 text-[8.5px]">Score</span>
            </div>
          )}
          {ad.scores && (
            <div className="flex-1">
              <ScoreBars scores={ad.scores} />
            </div>
          )}
        </div>
      )}

      {ad.headline && <p className="text-body-sm font-fig-headline leading-snug text-ink">{ad.headline}</p>}

      <p className="line-clamp-4 text-body-sm text-ink/80">
        {ad.text ? `“${ad.text}”` : <span className="text-ink/40">No ad copy captured.</span>}
      </p>

      {ad.winningAngle && (
        <p className="rounded-md bg-block-lime px-2.5 py-1.5 text-body-sm leading-snug text-ink">
          <span className="eyebrow mr-1 text-[11px]">Winning angle</span>
          {ad.winningAngle}
        </p>
      )}

      <div className="mt-1 flex items-center justify-between gap-2 border-t border-hairline pt-3">
        <a
          href={ad.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-canvas px-3 py-1.5 text-body-sm font-fig-link text-ink transition-colors hover:bg-surface-soft"
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
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-body-sm font-fig-link text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
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
    <section className="overflow-hidden rounded-lg border border-hairline bg-canvas">
      <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <div>
          <h3 className="text-headline text-ink">Ad intelligence · what&apos;s winning right now</h3>
          <p className="text-body-sm text-ink/60">
            No API token — scanned live across Meta + TikTok, scored and ranked.
          </p>
        </div>
        {!loading && ads.length > 0 && (
          <span className="caption rounded-pill bg-surface-soft px-2.5 py-1 text-ink">
            {ads.length} scanned
          </span>
        )}
      </header>

      <div className="p-4">
        {loading ? (
          <div className="grid place-items-center py-10">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="relative h-10 w-10">
                <span className="absolute inset-0 animate-spin rounded-full border-2 border-hairline border-t-ink" />
                <span className="absolute inset-2 rounded-full bg-surface-soft" />
              </div>
              <p className="text-body-sm text-ink/70">Scanning the competitor&apos;s ad factory…</p>
            </div>
          </div>
        ) : ads.length === 0 ? (
          <div className="grid place-items-center py-10 text-center">
            <p className="text-body-sm text-ink/70">No live competitor ads surfaced yet.</p>
            <p className="mt-1 max-w-sm text-body-sm text-ink/50">
              We identified the real competitors and scanned their live ads across Google, Meta, and TikTok (token-free) — none are running right now. The rest of the brief is unaffected.
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
