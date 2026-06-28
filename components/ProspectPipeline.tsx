"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { prospectsByRunRef, emailsByRunRef } from "./chatApi";
import type { ProspectDoc, EmailDoc } from "./types";
import { STAGE_META, EMAIL_STATUS_META, SIGNAL_META, fitColor, tintStyle } from "./pipelineMeta";
import { hostFromUrl, initials } from "./format";
import GlareCard from "./ui/GlareCard";

// ============================================================================
// ProspectPipeline — the outbound flow, read LEFT → RIGHT as one company moves
// stage by stage: Sourced → Qualified → Drafted → Sent → Replied (Skipped is the
// off-ramp). OrangeSlice firmographics + Fiber-verified emails + the writer's
// drafts + AgentMail sends, all on one board.
//
// ROOT-CAUSE NOTE (the "12 sourced · empty columns" bug): the sourcer inserts
// prospects at stage "enriched" (never "sourced"), and the qualifier advances
// them straight to "qualified"/"skipped". A board that bucketed strictly on the
// raw `stage` therefore left its leading "Sourced"/"Enriched" columns perpetually
// empty while the header counted all 12. This board instead derives each
// prospect's FLOW LANE from stage *and* its email(s), so every prospect always
// lands in a lane and visibly flows rightward. Reads prospects:byRun + emails:byRun.
// ============================================================================

// ---------------------------------------------------------------------------
// FLOW LANES — the founder-legible left→right funnel. laneFor() resolves each
// prospect's FURTHEST lane (stage + its drafted/sent emails) → a `rank`; a
// prospect then appears in EVERY lane it has reached (rank >= the lane's rank),
// so the leading lanes stay full and each lane's count equals the funnel number.
// Hexes reuse the shared pastel block palette so the pipeline + outreach queue
// read as one system. `rank` drives the funnel (how many prospects reached this lane).
// ---------------------------------------------------------------------------
type FlowLane = "sourced" | "qualified" | "drafted" | "sent" | "replied";

const FLOW_LANES: readonly FlowLane[] = ["sourced", "qualified", "drafted", "sent", "replied"];

const LANE_META: Record<FlowLane | "skipped", { label: string; hex: string; blurb: string; rank: number }> = {
  sourced: { label: "Sourced", hex: STAGE_META.sourced.hex, blurb: "Found + enriched", rank: 0 },
  qualified: { label: "Qualified", hex: STAGE_META.qualified.hex, blurb: "Cleared the fit bar", rank: 1 },
  drafted: { label: "Drafted", hex: EMAIL_STATUS_META.draft.hex, blurb: "Email written", rank: 2 },
  sent: { label: "Sent", hex: EMAIL_STATUS_META.sent.hex, blurb: "Shipped via AgentMail", rank: 3 },
  replied: { label: "Replied", hex: EMAIL_STATUS_META.replied.hex, blurb: "They wrote back", rank: 4 },
  skipped: { label: "Skipped", hex: STAGE_META.skipped.hex, blurb: "Off-ramped", rank: 0 },
};

/**
 * Resolve a prospect's FURTHEST flow lane from its stage AND its email(s). The
 * caller then renders it into every lane up to and including this one (cumulative
 * funnel). This is what makes the 12 sourced prospects actually appear: a
 * freshly-sourced row (stage "enriched") reaches "Sourced"; once the writer
 * drafts it, it reaches "Drafted" (and still counts under Sourced + Qualified);
 * the sender pushes it to "Sent"; a reply lands it in "Replied".
 */
function laneFor(p: ProspectDoc, emails: EmailDoc[]): FlowLane | "skipped" {
  if (p.stage === "skipped") return "skipped";
  if (p.stage === "replied" || p.stage === "booked" || emails.some((e) => e.status === "replied")) return "replied";
  if (p.stage === "contacted" || emails.some((e) => e.status === "sent")) return "sent";
  if (emails.some((e) => e.status === "draft" || e.status === "approved")) return "drafted";
  if (p.stage === "qualified") return "qualified";
  return "sourced"; // sourced / enriched / anything not yet advanced
}

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

function ProspectCard({ p, lane }: { p: ProspectDoc; lane: FlowLane | "skipped" }) {
  const sig = p.signal;
  const sigMeta = sig ? SIGNAL_META[sig.type] : null;
  const booked = p.stage === "booked";
  return (
    <div className="rounded-lg border border-hairline bg-canvas p-3 transition-colors hover:border-ink/20 animate-row-in">
      <div className="flex items-start gap-2.5">
        <FitRing score={p.fitScore} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13px] font-fig-headline text-ink">{p.company}</p>
            {booked && (
              <span className="caption shrink-0 rounded-full bg-block-mint px-1.5 py-0.5 text-ink">Booked</span>
            )}
          </div>
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

function Lane({ lane, items }: { lane: FlowLane | "skipped"; items: ProspectDoc[] }) {
  const meta = LANE_META[lane];
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
              <ProspectCard p={p} lane={lane} />
            </GlareCard>
          ))
        )}
      </div>
    </div>
  );
}

// Small chevron between lanes — makes the left→right flow direction explicit.
function FlowArrow() {
  return (
    <div className="flex shrink-0 items-center self-stretch px-0.5 text-ink/25" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
        <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export default function ProspectPipeline({ runId }: { runId: Id<"runs"> }) {
  const prospects = useQuery(prospectsByRunRef, { runId }) as ProspectDoc[] | undefined;
  const emails = useQuery(emailsByRunRef, { runId }) as EmailDoc[] | undefined;

  const { byLane, skipped, total, verified, reach } = useMemo(() => {
    // Group emails by prospect so laneFor can see the draft/send state.
    const emailsByProspect = new Map<string, EmailDoc[]>();
    for (const e of emails ?? []) {
      const arr = emailsByProspect.get(e.prospectId) ?? [];
      arr.push(e);
      emailsByProspect.set(e.prospectId, arr);
    }

    // Resolve each prospect's FURTHEST lane (stage + its email state) → a rank.
    // A skipped prospect was still SOURCED, so it counts at rank 0 (it shows in
    // the "Sourced" lane) AND is listed in the Skipped off-ramp.
    const all = prospects ?? [];
    const skipped: ProspectDoc[] = [];
    const ranked: { p: ProspectDoc; rank: number }[] = [];
    for (const p of all) {
      const lane = laneFor(p, emailsByProspect.get(p._id) ?? []);
      if (lane === "skipped") {
        skipped.push(p);
        ranked.push({ p, rank: LANE_META.sourced.rank });
        continue;
      }
      ranked.push({ p, rank: LANE_META[lane].rank });
    }

    // CUMULATIVE FUNNEL — the fix for the "empty Sourced/Qualified columns" bug.
    // A prospect belongs to EVERY lane it has reached (its furthest rank >= the
    // lane's rank), not just its single furthest lane. That fills the leading
    // lanes (all 12 were sourced; the 7 that qualified also show under Qualified
    // and Drafted) and makes each lane's count badge equal the header funnel.
    // reach[k] (the funnel) is therefore exactly the size of lane k.
    const byLane = new Map<FlowLane, ProspectDoc[]>();
    const reach = [0, 0, 0, 0, 0];
    for (const lane of FLOW_LANES) {
      const laneRank = LANE_META[lane].rank;
      const items = ranked.filter((r) => r.rank >= laneRank).map((r) => r.p);
      byLane.set(lane, items);
      reach[laneRank] = items.length;
    }

    const total = all.length;
    const verified = all.filter((p) => p.emailVerified).length;
    return { byLane, skipped, total, verified, reach };
  }, [prospects, emails]);

  if (prospects === undefined) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {FLOW_LANES.map((s) => (
          <div key={s} className="h-64 w-60 shrink-0 animate-pulse rounded-lg border border-hairline bg-surface-soft" />
        ))}
      </div>
    );
  }

  // Compact funnel readout — replaces the misleading "{total} sourced" line. Each
  // number is "how many reached this stage", so it always agrees with the lanes.
  const funnel: { label: string; n: number }[] = [
    { label: "sourced", n: reach[0] },
    { label: "qualified", n: reach[1] },
    { label: "drafted", n: reach[2] },
    { label: "sent", n: reach[3] },
  ];

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-fig-headline text-ink">Outbound flow</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink/60">
            {funnel.map((f, i) => (
              <span key={f.label} className="inline-flex items-center gap-1.5">
                {i > 0 && <span className="text-ink/25">›</span>}
                <span className="tabular-nums text-ink/80">{f.n}</span>
                <span>{f.label}</span>
              </span>
            ))}
            <span className="text-ink/25">·</span>
            <span className="tabular-nums text-ink/80">{verified}</span>
            <span>Fiber-verified</span>
          </div>
        </div>
        {skipped.length > 0 && (
          <span className="shrink-0 rounded-full border border-hairline bg-surface-soft px-2.5 py-1 text-[11px] text-ink/60">
            {skipped.length} skipped
          </span>
        )}
      </div>

      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline bg-surface-soft p-10 text-center text-[13px] text-ink/60">
          The sourcer is matching companies + decision-makers — prospects land here as they&apos;re found, then flow rightward as they qualify, get drafted, and ship.
        </div>
      ) : (
        <div className="flex items-stretch gap-1 overflow-x-auto pb-2">
          {FLOW_LANES.map((lane, i) => (
            <div key={lane} className="flex items-stretch">
              {i > 0 && <FlowArrow />}
              <Lane lane={lane} items={byLane.get(lane) ?? []} />
            </div>
          ))}
          {skipped.length > 0 && (
            <div className={cn("flex items-stretch")}>
              <div className="flex shrink-0 items-center self-stretch px-1 text-ink/20" aria-hidden="true">
                <span className="h-full w-px bg-hairline" />
              </div>
              <Lane lane="skipped" items={skipped} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
