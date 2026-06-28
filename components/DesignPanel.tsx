"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// ============================================================================
// DesignPanel — the in-house generated campaign landing page (AI Ad Factories).
//
// Renders the generated single-file landing page inside a sandboxed <iframe
// srcDoc={html} /> with the three ad-copy headline variants beside it. Graceful
// empty + loading states so the panel never looks broken while the designer
// agent is still working.
//
// Backend (owned by the designer agent):
//   api.agents.designer.designsForRun({ runId }) : Doc<"designs">[]
//     rows: { kind: "landing", html }  and  { kind: "ad_copy", copy }
// ============================================================================

interface DesignPanelProps {
  runId: Id<"runs">;
}

/** Split the persisted "1. …\n2. …" copy blob into clean individual variants. */
function parseVariants(copy: string | undefined | null): string[] {
  if (!copy) return [];
  return copy
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

export default function DesignPanel({ runId }: DesignPanelProps) {
  const designs = useQuery(api.agents.designer.designsForRun, { runId });

  const loading = designs === undefined;
  const landing = designs?.find((d) => d.kind === "landing" && d.html) ?? null;
  const adCopy = designs?.find((d) => d.kind === "ad_copy") ?? null;
  const variants = parseVariants(adCopy?.copy);
  const hasContent = Boolean(landing?.html) || variants.length > 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/80">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">
            Generated landing page
          </h3>
          <p className="text-xs text-zinc-500">
            {landing?.title
              ? landing.title
              : "A campaign page in your buyers' own words"}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
            hasContent
              ? "bg-good/15 text-good ring-1 ring-good/30"
              : "bg-accent/15 text-accent ring-1 ring-accent/30"
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
                <p className="text-sm text-zinc-400">Loading designs…</p>
              </>
            ) : (
              <>
                <div className="grid h-12 w-12 place-items-center rounded-full bg-accent/10 text-accent ring-1 ring-accent/30">
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 19l7-7 3 3-7 7-3-3z" />
                    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                    <path d="M2 2l7.586 7.586" />
                    <circle cx="11" cy="11" r="2" />
                  </svg>
                </div>
                <p className="text-sm text-zinc-400">
                  Designing a campaign page from the brief and the buyers&apos;
                  own language…
                </p>
                <p className="text-xs text-zinc-600">
                  This appears the moment the designer agent finishes.
                </p>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-0 lg:grid-cols-[1.6fr_1fr]">
          {/* Generated landing page — sandboxed, self-contained HTML. */}
          <div className="border-b border-line lg:border-b-0 lg:border-r">
            {landing?.html ? (
              <iframe
                title={landing.title || "Generated landing page"}
                srcDoc={landing.html}
                sandbox=""
                loading="lazy"
                className="h-[520px] w-full bg-white"
              />
            ) : (
              <div className="grid h-[520px] place-items-center bg-ink text-sm text-zinc-500">
                Landing page still rendering…
              </div>
            )}
          </div>

          {/* Ad-copy headline variants. */}
          <div className="flex flex-col gap-3 p-5">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Ad-copy variants
              </h4>
              <p className="text-xs text-zinc-600">
                Three headline angles, in their voice
              </p>
            </div>

            {variants.length > 0 ? (
              <ol className="flex flex-col gap-3">
                {variants.map((variant, i) => (
                  <li
                    key={i}
                    className="rounded-xl border border-line bg-ink/40 p-4"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">
                        {i + 1}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                        {["Pain mirror", "Outcome", "Bold hook"][i] ?? "Variant"}
                      </span>
                    </div>
                    <p className="text-sm leading-snug text-zinc-100">
                      {variant}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-zinc-500">
                Headline variants are still generating…
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
