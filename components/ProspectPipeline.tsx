"use client";

import { useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { PIPELINE_STAGES, type ProspectStage } from "@/lib/contract";
import { cn } from "@/lib/utils";
import { prospectsByRunRef } from "./chatApi";
import type { ProspectDoc } from "./types";
import { STAGE_META, SIGNAL_META, fitColor, tintStyle } from "./pipelineMeta";
import { hostFromUrl, initials } from "./format";
import GlareCard from "./ui/GlareCard";

// ============================================================================
// ProspectPipeline — the outbound kanban. OrangeSlice firmographics + Fiber
// verified emails, moving stage by stage (sourced → … → booked) with a skipped
// off-ramp. Reads prospects:listByRun reactively.
// ============================================================================

function FitRing({ score }: { score?: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(score ?? 0)));
  const hex = fitColor(score);
  const deg = (clamped / 100) * 360;
  return (
    <div
      className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full"
      style={{ background: `conic-gradient(${hex} ${deg}deg, rgb(var(--ink) / 0.08) ${deg}deg)` }}
      title={`Fit ${clamped}/100`}
    >
      <div className="grid h-7 w-7 place-items-center rounded-full bg-canvas">
        <span className="text-[11px] font-fig-card tabular-nums text-ink">
          {score === undefined ? "–" : clamped}
        </span>
      </div>
    </div>
  );
}

function ProspectCard({ p }: { p: ProspectDoc }) {
  const sig = p.signal;
  const sigMeta = sig ? SIGNAL_META[sig.type] : null;
  return (
    <div className="rounded-lg border border-hairline bg-canvas p-3 transition-colors hover:border-ink/20 animate-row-in">
      <div className="flex items-start gap-2.5">
        <FitRing score={p.fitScore} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-fig-headline text-ink">{p.company}</p>
          {(p.name || p.title) && (
            <p className="mt-0.5 truncate text-[11.5px] text-ink/60">
              {p.name}
              {p.name && p.title ? " · " : ""}
              {p.title}
            </p>
          )}
        </div>
      </div>

      {/* email + verification */}
      {p.email && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="truncate text-[11px] text-ink/60">{p.email}</span>
          {p.emailVerified ? (
            <span className="caption inline-flex items-center gap-1 rounded-full bg-block-mint px-1.5 py-0.5 text-ink">
              <svg viewBox="0 0 24 24" fill="none" className="h-2.5 w-2.5 text-success">
                <path d="m5 12.5 4 4 10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Fiber
            </span>
          ) : (
            <span className="caption rounded-full bg-surface-soft px-1.5 py-0.5 text-ink/40">
              unverified
            </span>
          )}
        </div>
      )}

      {/* warm signal */}
      {sig && sigMeta && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5"
          style={tintStyle(sigMeta.hex)}
        >
          <span className="caption mt-0.5">{sigMeta.label}</span>
          <span className="line-clamp-2 text-[11px] leading-snug">{sig.summary}</span>
        </div>
      )}

      {/* footer */}
      <div className="mt-2 flex items-center justify-between text-[10.5px] text-ink/50">
        <span className="truncate">{p.domain ? hostFromUrl(p.domain) : p.industry ?? ""}</span>
        {p.linkedinUrl ? (
          <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-ink/70 hover:underline">
            in/
          </a>
        ) : (
          <span className="text-ink/40">{initials(p.name, p.company)}</span>
        )}
      </div>
    </div>
  );
}

function Column({ stage, items }: { stage: ProspectStage; items: ProspectDoc[] }) {
  const meta = STAGE_META[stage];
  return (
    <div className="flex w-60 shrink-0 flex-col rounded-lg border border-hairline bg-surface-soft">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: meta.hex }} />
          <span className="text-[12px] font-fig-headline text-ink">{meta.label}</span>
        </div>
        <span className="rounded-full border border-hairline bg-canvas px-2 py-0.5 text-[10px] font-fig-bodysm tabular-nums text-ink/60">
          {items.length}
        </span>
      </div>
      <div className="col-scroll col-fade flex max-h-[460px] min-h-[80px] flex-col gap-2 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="px-1 py-3 text-center text-[11px] text-ink/40">{meta.blurb}</p>
        ) : (
          items.map((p) => (
            <GlareCard key={p._id} className="rounded-lg">
              <ProspectCard p={p} />
            </GlareCard>
          ))
        )}
      </div>
    </div>
  );
}

export default function ProspectPipeline({ runId }: { runId: Id<"runs"> }) {
  const prospects = useQuery(prospectsByRunRef, { runId }) as ProspectDoc[] | undefined;

  const byStage = new Map<ProspectStage, ProspectDoc[]>();
  for (const stage of PIPELINE_STAGES) byStage.set(stage, []);
  const skipped: ProspectDoc[] = [];
  for (const p of prospects ?? []) {
    if (p.stage === "skipped") skipped.push(p);
    else byStage.get(p.stage)?.push(p);
  }

  const total = prospects?.length ?? 0;
  const verified = (prospects ?? []).filter((p) => p.emailVerified).length;

  if (prospects === undefined) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {PIPELINE_STAGES.map((s) => (
          <div key={s} className="h-64 w-60 shrink-0 animate-pulse rounded-lg border border-hairline bg-surface-soft" />
        ))}
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-fig-headline text-ink">Outbound pipeline</h3>
          <p className="text-[12.5px] text-ink/60">
            {total} sourced · {verified} Fiber-verified · OrangeSlice firmographics
          </p>
        </div>
        {skipped.length > 0 && (
          <span className="rounded-full border border-hairline bg-surface-soft px-2.5 py-1 text-[11px] text-ink/60">
            {skipped.length} skipped
          </span>
        )}
      </div>

      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline bg-surface-soft p-10 text-center text-[13px] text-ink/60">
          The sourcer is matching companies + decision-makers — prospects land here as they&apos;re found.
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {PIPELINE_STAGES.map((stage) => (
            <Column key={stage} stage={stage} items={byStage.get(stage) ?? []} />
          ))}
          {skipped.length > 0 && (
            <Column stage="skipped" items={skipped} />
          )}
        </div>
      )}
    </section>
  );
}
