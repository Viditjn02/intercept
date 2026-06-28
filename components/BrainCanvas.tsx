"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { cn } from "@/lib/utils";
import { relativeTime, hostFromUrl } from "./format";
import type {
  BrainStatsDoc,
  KnowledgeEntityType,
  KnowledgeFactDoc,
  KnowledgePageDoc,
} from "./types";

// ============================================================================
// BrainCanvas — the compounding brain, made visible. A reactive board of
// entity "knowledge pages" (one per company / competitor / ICP / campaign) that
// the audience can watch GROW run-over-run: every page shows its big factCount,
// how many runs have compounded into it, and its most-recent learned facts. When
// a page was touched in the last couple of minutes it pulses + shows a "+N new"
// badge — the literal "it got smarter this run" moment.
//
// READS via typed function references (the same bind-at-runtime pattern as
// chatApi): convex/knowledge.ts is built in parallel and isn't in the generated
// `api` yet, so `api.knowledge.*` wouldn't type-check. These references compile
// independently and bind once the engine deploys. If the engine ISN'T deployed,
// the query throws during render and the surrounding PanelBoundary shows a calm
// "comes online when deployed" fallback — it never white-screens.
//
// GRACEFUL: while loading → skeleton; zero pages → a tasteful "nothing learned
// yet" hero; missing fields → derived fallbacks. Never throws on its own.
// ============================================================================

// --- typed contract refs (convex/knowledge.ts — engine builder) -------------
/** Every knowledge page, most-recently-updated first. */
const listPagesRef = makeFunctionReference<
  "query",
  { entityType?: string; limit?: number },
  KnowledgePageDoc[]
>("knowledge:listPages");

/** Global brain rollup — pages, total facts, runs compounded. */
const brainStatsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  BrainStatsDoc
>("knowledge:brainStats");

const RECENT_WINDOW_MS = 2 * 60_000; // "this run" pulse window

interface GroupMeta {
  type: KnowledgeEntityType;
  label: string;
  blurb: string;
}

// Display order + copy. Companies first (the thing we sell), then the market.
const GROUPS: readonly GroupMeta[] = [
  { type: "company", label: "Companies", blurb: "Who we're selling" },
  { type: "competitor", label: "Competitors", blurb: "Advertisers we're up against" },
  { type: "icp", label: "Buyer segments", blurb: "ICPs we've learned to target" },
  { type: "campaign", label: "Campaigns", blurb: "Standing outbound motions" },
] as const;

interface BrainCanvasProps {
  /** Optional company slug to highlight (e.g. the active run's company). */
  highlightKey?: string;
}

export default function BrainCanvas({ highlightKey }: BrainCanvasProps) {
  // Both reads come from the same module, so they deploy together; if the
  // module is absent both throw and PanelBoundary catches it once.
  const pages = useQuery(listPagesRef, {}) as KnowledgePageDoc[] | undefined;
  const stats = useQuery(brainStatsRef, {}) as BrainStatsDoc | undefined;

  const grouped = useMemo(() => groupPages(pages ?? []), [pages]);
  const derived = useMemo(() => deriveStats(pages ?? []), [pages]);

  // Prefer engine-provided stats; fall back to numbers derived from the list so
  // the header is correct even if the engine omits a field.
  const header = {
    pages: stats?.pages ?? derived.pages,
    facts: stats?.facts ?? derived.facts,
    runs: stats?.runs ?? derived.runs,
  };

  const loading = pages === undefined;

  return (
    <div className="col-scroll h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-5 py-5">
        <BrainHeader pages={header.pages} facts={header.facts} runs={header.runs} />

        {loading ? (
          <BrainSkeleton />
        ) : header.pages === 0 ? (
          <BrainEmpty />
        ) : (
          <div className="mt-5 space-y-7">
            {GROUPS.map((g) => {
              const list = grouped[g.type];
              if (!list || list.length === 0) return null;
              return (
                <section key={g.type}>
                  <div className="mb-2.5 flex items-baseline gap-2.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                      {g.label}
                    </h3>
                    <span className="text-[11px] text-white/30">{g.blurb}</span>
                    <span className="text-[11px] text-white/30">· {list.length}</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {list.map((p) => (
                      <BrainPageCard
                        key={p._id}
                        page={p}
                        highlighted={
                          !!highlightKey &&
                          p.entityKey.toLowerCase() === highlightKey.toLowerCase()
                        }
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Header — the global "brain" stat strip. Conveys scale at a glance + reinforces
// that the numbers only ever go up.
// ----------------------------------------------------------------------------
function BrainHeader({ pages, facts, runs }: { pages: number; facts: number; runs: number }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-panel/60 px-5 py-4">
      <div className="flex items-center gap-3">
        <span aria-hidden className="text-2xl leading-none">🧠</span>
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-zinc-100">The brain</h2>
          <p className="text-[11px] text-white/40">
            Durable knowledge — it compounds every run, never resets.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-5">
        <Stat value={pages} label="pages" />
        <span className="h-8 w-px bg-line" />
        <Stat value={facts} label="facts" accent />
        <span className="h-8 w-px bg-line" />
        <Stat value={runs} label="runs compounded" />
      </div>
    </div>
  );
}

function Stat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <p
        className={cn(
          "text-xl font-semibold tabular-nums leading-none",
          accent ? "text-accent" : "text-zinc-100",
        )}
      >
        {value.toLocaleString()}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-white/35">{label}</p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Card — one entity page. The big factCount is the hero; the growth pulse + the
// recent facts are the proof that this run made it smarter.
// ----------------------------------------------------------------------------
function BrainPageCard({ page, highlighted }: { page: KnowledgePageDoc; highlighted: boolean }) {
  const facts = page.facts ?? [];
  const factCount = page.factCount ?? facts.length;
  const runCount = page.runCount ?? page.sources?.length ?? 0;
  const updatedAt = page.updatedAt ?? page._creationTime;

  const recent = useMemo(
    () => [...facts].sort((a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0)).slice(0, 3),
    [facts],
  );

  const now = Date.now();
  const newCount = facts.filter((f) => now - (f.learnedAt ?? 0) < RECENT_WINDOW_MS).length;
  const fresh = now - updatedAt < RECENT_WINDOW_MS;

  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border bg-panel/60 p-4 transition-colors",
        fresh
          ? "border-good/40"
          : highlighted
            ? "border-accent/40"
            : "border-line hover:border-white/20",
      )}
    >
      {/* title row + growth pulse */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold text-zinc-100">{page.title}</p>
          <p className="truncate text-[11px] text-white/35">{page.entityKey}</p>
        </div>
        {fresh && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-good/40 bg-good/10 px-2 py-0.5 text-[10px] font-semibold text-good">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-good" />
            </span>
            {newCount > 0 ? `+${newCount} new` : "updated"}
          </span>
        )}
      </div>

      {/* the hero metric — visibly grows run-over-run */}
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums leading-none text-accent">
          {factCount.toLocaleString()}
        </span>
        <span className="text-[11px] text-white/45">
          {factCount === 1 ? "fact" : "facts"} learned
        </span>
      </div>
      <p className="mt-1 text-[10.5px] text-white/35">
        compounded across {runCount} {runCount === 1 ? "run" : "runs"} · updated{" "}
        {relativeTime(updatedAt)}
      </p>

      {/* most-recent learned facts — the proof it's getting smarter */}
      {recent.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-line/70 pt-3">
          {recent.map((f, i) => (
            <FactRow key={i} fact={f} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FactRow({ fact }: { fact: KnowledgeFactDoc }) {
  return (
    <li className="flex items-start gap-2 text-[11.5px] leading-snug">
      <span className="mt-0.5 shrink-0 rounded border border-line bg-white/5 px-1.5 py-px text-[9px] uppercase tracking-wide text-white/45">
        {fact.kind || "note"}
      </span>
      <span className="min-w-0 flex-1 text-white/70">
        {fact.text}
        {fact.url && (
          <a
            href={fact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1.5 whitespace-nowrap text-accent/80 hover:text-accent hover:underline"
          >
            {hostFromUrl(fact.url) || "source"} ↗
          </a>
        )}
      </span>
    </li>
  );
}

// ----------------------------------------------------------------------------
// Loading + empty states.
// ----------------------------------------------------------------------------
function BrainSkeleton() {
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-36 animate-pulse rounded-2xl border border-line bg-white/5" />
      ))}
    </div>
  );
}

function BrainEmpty() {
  return (
    <div className="mt-10 grid place-items-center px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel text-2xl">
        🧠
      </span>
      <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-zinc-100">
        The brain is empty — for now.
      </h3>
      <p className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-white/40">
        Every run leaves durable facts behind. Run a discovery, outbound, or
        competitor scan and watch the first knowledge pages appear here — then
        grow, run after run.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Pure helpers.
// ----------------------------------------------------------------------------
function groupPages(
  pages: readonly KnowledgePageDoc[],
): Record<KnowledgeEntityType, KnowledgePageDoc[]> {
  const out: Record<KnowledgeEntityType, KnowledgePageDoc[]> = {
    company: [],
    competitor: [],
    icp: [],
    campaign: [],
  };
  for (const p of pages) {
    const bucket = out[p.entityType];
    if (bucket) bucket.push(p);
  }
  // most-recently-updated first within each group
  for (const k of Object.keys(out) as KnowledgeEntityType[]) {
    out[k].sort(
      (a, b) => (b.updatedAt ?? b._creationTime) - (a.updatedAt ?? a._creationTime),
    );
  }
  return out;
}

function deriveStats(
  pages: readonly KnowledgePageDoc[],
): { pages: number; facts: number; runs: number } {
  let facts = 0;
  let runs = 0;
  for (const p of pages) {
    facts += p.factCount ?? p.facts?.length ?? 0;
    runs += p.runCount ?? p.sources?.length ?? 0;
  }
  return { pages: pages.length, facts, runs };
}
