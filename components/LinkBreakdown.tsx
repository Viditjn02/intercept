"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { LinkBreakdownResult } from "@/convex/linkScan";

// ============================================================================
// LinkBreakdown — a small, tasteful "drop a link, break it down" input.
// ----------------------------------------------------------------------------
// Paste a URL (a competitor video, a viral TikTok, an article) → we transcribe
// or scrape it (Supadata) and distil it into a summary + reusable angles + hooks
// (OpenAI), rendered inline as compact chips. A quiet flex, not a giant feature.
//
// Backend: convex/linkScan.ts `breakdown({ url })`. Bound here via
// makeFunctionReference so this compiles standalone before codegen, exactly like
// the chatApi refs. Graceful by contract — the action never throws; a missing
// key / unreadable link surfaces as a soft inline note, never a crash.
// ============================================================================

const breakdownRef = makeFunctionReference<
  "action",
  { url: string },
  LinkBreakdownResult
>("linkScan:breakdown");

interface LinkBreakdownProps {
  /** Section eyebrow, e.g. "Inspired by a link? Drop it". */
  title?: string;
  /** One-line subtitle under the eyebrow. */
  hint?: string;
  /** Input placeholder. */
  placeholder?: string;
}

export default function LinkBreakdown({
  title = "Inspired by a link? Drop it",
  hint = "Paste a video or article — we'll break down the angles & hooks.",
  placeholder = "https://…",
}: LinkBreakdownProps) {
  const breakdown = useAction(breakdownRef);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LinkBreakdownResult | null>(null);

  const disabled = loading || url.trim().length === 0;

  async function run() {
    const trimmed = url.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await breakdown({ url: trimmed });
      setResult(res);
    } catch {
      // The action is graceful, but guard the client too — never throw to the UI.
      setResult({
        source: trimmed,
        kind: "unknown",
        summary: "",
        angles: [],
        hooks: [],
        ok: false,
        degraded: true,
        note: "Couldn't break this down right now — try again.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border border-hairline bg-surface-soft p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-canvas text-ink" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="eyebrow text-[12px] text-ink">{title}</p>
          <p className="text-body-sm text-ink/50">{hint}</p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-3 py-2 text-body-sm text-ink placeholder:text-ink/40 focus:outline-none focus:ring-1 focus:ring-ink/20"
        />
        <button
          onClick={() => void run()}
          disabled={disabled}
          className={`shrink-0 rounded-md px-3 py-2 text-body-sm font-fig-link transition-colors ${
            disabled
              ? "cursor-not-allowed bg-surface-soft text-ink/40 ring-1 ring-hairline"
              : "bg-primary text-on-primary hover:opacity-90"
          }`}
        >
          {loading ? "Breaking down…" : "Break it down"}
        </button>
      </div>

      {result && (
        <div className="mt-3 flex flex-col gap-3">
          {result.summary && (
            <div className="rounded-md bg-canvas p-3">
              <div className="flex items-center gap-1.5">
                <span className="caption rounded-pill bg-surface-soft px-2 py-0.5 text-[10px] text-ink/70">
                  {result.kind === "video" ? "Video" : result.kind === "article" ? "Article" : "Link"}
                </span>
                <a
                  href={result.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-[11px] text-ink/40 underline underline-offset-2 hover:text-ink/70"
                >
                  {prettyUrl(result.source)}
                </a>
              </div>
              <p className="mt-1.5 text-body-sm leading-relaxed text-ink/80">{result.summary}</p>
            </div>
          )}

          {result.angles.length > 0 && (
            <ChipGroup label="Angles" chips={result.angles} tone="lime" />
          )}
          {result.hooks.length > 0 && (
            <ChipGroup label="Hooks" chips={result.hooks} tone="mint" />
          )}

          {result.note && (
            <p className="text-body-sm text-ink/50">{result.note}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ChipGroup({
  label,
  chips,
  tone,
}: {
  label: string;
  chips: string[];
  tone: "lime" | "mint";
}) {
  const bg = tone === "lime" ? "bg-block-lime" : "bg-block-mint";
  return (
    <div>
      <p className="eyebrow mb-1.5 text-[11px] text-ink">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip, i) => (
          <span
            key={i}
            className={`rounded-pill ${bg} px-2.5 py-1 text-[11px] leading-snug text-ink`}
          >
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Trim a URL to a compact host + path for inline display. */
function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 24 ? u.pathname.slice(0, 24) + "…" : u.pathname;
    return (u.hostname.replace(/^www\./, "") + (path === "/" ? "" : path)).slice(0, 48);
  } catch {
    return url.slice(0, 48);
  }
}
