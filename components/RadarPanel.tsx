"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { cn } from "@/lib/utils";
import { relativeTime, hostFromUrl } from "./format";
import type {
  BorrowEffort,
  RadarFeatureToBorrow,
  RadarProject,
  RadarRankedEntry,
  RadarReport,
} from "@/lib/radar";

// ============================================================================
// RadarPanel — the HACKATHON RADAR surface. INTERCEPT turns its own GTM engine
// on the YC AI Growth Hackathon field and caches a single "us-vs-the-field"
// report: where WE lead, where we lag, the field ranked by threat, and a list of
// features worth borrowing (each with its source repo for one-click verification).
//
// This is its OWN read-only surface (like the Brain lens) — reachable on ANY
// localhost URL, independent of the current target company / focused run.
//
// BIND-AT-RUNTIME: the backend lives in convex/hackathonRadar.ts and may not be
// in the generated `api` yet, so we reference it via typed `makeFunctionReference`
// (mirrors components/chatApi.ts). The component compiles independently and binds
// once the module deploys. Both reads are guarded: `undefined` === still loading,
// `null` === the radar has never run. It never throws.
// ============================================================================

// --- typed contract refs (convex/hackathonRadar.ts) -------------------------
/** The cached "us-vs-the-field" report (null until the radar first runs). */
const getReportRef = makeFunctionReference<
  "query",
  Record<string, never>,
  RadarReport | null
>("hackathonRadar:getReport");

/** Every project on the field — used to hang repo/demo links off each ranked row. */
const listProjectsRef = makeFunctionReference<
  "query",
  { limit?: number },
  RadarProject[]
>("hackathonRadar:listProjects");

// ----------------------------------------------------------------------------
// Threat / effort tints — strictly inside the pastel palette so the cards read
// as poster panels on the light Figma ground.
// ----------------------------------------------------------------------------
function threatMeta(score: number): { label: string; chip: string } {
  if (score >= 70) return { label: "High threat", chip: "bg-block-coral text-ink" };
  if (score >= 40) return { label: "Watch", chip: "bg-block-cream text-ink" };
  return { label: "Low", chip: "bg-surface-soft text-ink/70" };
}

const EFFORT_META: Record<BorrowEffort, { label: string; chip: string }> = {
  low: { label: "Low lift", chip: "bg-block-mint text-ink" },
  medium: { label: "Medium lift", chip: "bg-block-cream text-ink" },
  high: { label: "High lift", chip: "bg-block-coral text-ink" },
};

function effortMeta(effort: BorrowEffort) {
  return EFFORT_META[effort] ?? EFFORT_META.medium;
}

/** Normalize a project name so ranked entries match listProjects rows. Total. */
function normName(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ============================================================================
// RadarPanel — the surface. Header → summary → ranked field → strengths/gaps →
// features to borrow. Loading skeletons + a calm empty state. Never throws.
// ============================================================================
export default function RadarPanel() {
  // `undefined` while loading; `null` when the radar has never run.
  const report = useQuery(getReportRef, {}) as
    | RadarReport
    | null
    | undefined;
  const projects = useQuery(listProjectsRef, {}) as
    | RadarProject[]
    | undefined;

  // Index the field by normalized name so each ranked row can surface its
  // repo + demo links without the report having to carry them.
  const projectByName = useMemo(() => {
    const m = new Map<string, RadarProject>();
    for (const p of projects ?? []) {
      const key = normName(p.name);
      if (key && !m.has(key)) m.set(key, p);
    }
    return m;
  }, [projects]);

  // Defensive copy, ranked by threat (the report is already ranked, but never
  // trust the order — sort an immutable copy descending by score).
  const ranked = useMemo(() => {
    const list = report?.ranked ?? [];
    return [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [report]);

  const loading = report === undefined;
  const empty = report === null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RadarHeader report={report} fieldCount={projects?.length} />
      <div className="col-scroll min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <RadarSkeleton />
        ) : empty || !report ? (
          <RadarEmpty />
        ) : (
          <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-5">
            {report.summary && (
              <p className="mb-6 whitespace-pre-wrap text-[14px] leading-relaxed text-ink/80">
                {report.summary}
              </p>
            )}

            <RankedField ranked={ranked} projectByName={projectByName} />

            <div className="mt-7 grid gap-4 sm:grid-cols-2">
              <StrengthsColumn strengths={report.ourStrengths ?? []} />
              <GapsColumn gaps={report.ourGaps ?? []} />
            </div>

            <FeaturesToBorrow features={report.featuresToBorrow ?? []} />
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Header — the global radar stat strip. Flat numbers, glass-ish chrome.
// ----------------------------------------------------------------------------
function RadarHeader({
  report,
  fieldCount,
}: {
  report: RadarReport | null | undefined;
  fieldCount: number | undefined;
}) {
  const fieldSize = report?.fieldSize ?? fieldCount ?? 0;
  const borrowCount = report?.featuresToBorrow?.length ?? 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-canvas/80 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <span aria-hidden className="text-2xl leading-none">
          📡
        </span>
        <div>
          <p className="eyebrow font-mono text-[10px] uppercase tracking-[0.18em] text-ink/45">
            Hackathon Radar
          </p>
          <h2 className="text-sm font-fig-headline text-ink">
            INTERCEPT vs the field
          </h2>
          <p className="caption mt-0.5 text-ink/50">
            {report
              ? `Cached read of the field${
                  report.generatedAt
                    ? ` · scanned ${relativeTime(report.generatedAt)}`
                    : ""
                }`
              : "The us-vs-the-field report — read-only"}
          </p>
        </div>
      </div>
      {report && (
        <div className="flex items-center gap-4">
          <Stat value={fieldSize} label="on the field" />
          <span className="h-7 w-px bg-hairline" />
          <Stat value={borrowCount} label="to borrow" accent />
        </div>
      )}
    </div>
  );
}

function Stat({
  value,
  label,
  accent,
}: {
  value: number;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="text-right">
      <p
        className={cn(
          "text-lg font-fig-headline tabular-nums leading-none",
          accent ? "text-ink" : "text-ink/80",
        )}
      >
        {value.toLocaleString()}
      </p>
      <p className="caption mt-1 text-ink/40">{label}</p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// RankedField — the leaderboard. Each row: rank, name, threat chip, one-liner,
// and (matched from listProjects) repo + demo links opening in a new tab.
// ----------------------------------------------------------------------------
function RankedField({
  ranked,
  projectByName,
}: {
  ranked: RadarRankedEntry[];
  projectByName: Map<string, RadarProject>;
}) {
  return (
    <section>
      <SectionLabel
        title="Ranked field"
        sub="Competitors by threat — how directly each overlaps our space"
      />
      {ranked.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline bg-surface-soft/40 px-4 py-6 text-center text-[12.5px] text-ink/55">
          No competitors ranked on this run yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {ranked.map((entry, i) => (
            <RankedRow
              key={`${normName(entry.name)}-${i}`}
              rank={i + 1}
              entry={entry}
              project={projectByName.get(normName(entry.name))}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function RankedRow({
  rank,
  entry,
  project,
}: {
  rank: number;
  entry: RadarRankedEntry;
  project: RadarProject | undefined;
}) {
  const threat = threatMeta(entry.score ?? 0);
  const repoUrl = project?.githubUrl;
  const demoUrl = project?.demoUrl;

  return (
    <li className="flex items-start gap-3 rounded-lg border border-hairline bg-canvas p-3.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-soft font-mono text-[12px] tabular-nums text-ink/55">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="truncate text-[13.5px] font-fig-headline text-ink">
            {entry.name || "Untitled"}
          </h4>
          <span
            className={cn(
              "caption inline-flex items-center gap-1 whitespace-nowrap rounded-pill px-2 py-0.5",
              threat.chip,
            )}
            title={`Threat score ${entry.score ?? 0}/100 — how directly this overlaps INTERCEPT's space`}
          >
            {threat.label} · {entry.score ?? 0}
          </span>
        </div>
        {entry.oneLiner && (
          <p className="mt-1 text-[12.5px] leading-snug text-ink/70">
            {entry.oneLiner}
          </p>
        )}
        {(repoUrl || demoUrl) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {repoUrl && <LinkPill href={repoUrl} label="Repo" />}
            {demoUrl && (
              <LinkPill href={demoUrl} label={hostFromUrl(demoUrl) || "Demo"} />
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ----------------------------------------------------------------------------
// OUR STRENGTHS — the ✓ list. Where INTERCEPT clearly leads the field.
// ----------------------------------------------------------------------------
function StrengthsColumn({ strengths }: { strengths: string[] }) {
  return (
    <section className="rounded-lg border border-hairline bg-canvas p-4">
      <SectionLabel title="Our strengths" sub="Where INTERCEPT leads" inline />
      {strengths.length === 0 ? (
        <p className="text-[12.5px] text-ink/45">No clear leads recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {strengths.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug text-ink/85">
              <span
                aria-hidden
                className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
              {s}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// OUR GAPS — a watch-list. Where INTERCEPT lags / the field has something we don't.
// ----------------------------------------------------------------------------
function GapsColumn({ gaps }: { gaps: string[] }) {
  return (
    <section className="rounded-lg border border-hairline bg-canvas p-4">
      <SectionLabel title="Our gaps" sub="On the watch-list" inline />
      {gaps.length === 0 ? (
        <p className="text-[12.5px] text-ink/45">No gaps flagged — for now.</p>
      ) : (
        <ul className="space-y-2">
          {gaps.map((g, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug text-ink/85">
              <span
                aria-hidden
                className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-magenta"
              />
              {g}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// FEATURES TO BORROW — the actionable cards. Each: feature, "from {sourceProject}",
// an effort pill, the why, and a link to the source repo (the founder deep-links
// into this section). Verifiable in one click.
// ----------------------------------------------------------------------------
function FeaturesToBorrow({ features }: { features: RadarFeatureToBorrow[] }) {
  return (
    <section className="mt-7">
      <SectionLabel
        title="Features to borrow"
        sub="Worth lifting from the field — each links to its source repo"
      />
      {features.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline bg-surface-soft/40 px-4 py-6 text-center text-[12.5px] text-ink/55">
          Nothing flagged to borrow yet.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {features.map((f, i) => (
            <BorrowCard key={`${normName(f.feature)}-${i}`} feature={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function BorrowCard({ feature }: { feature: RadarFeatureToBorrow }) {
  const effort = effortMeta(feature.effort);
  return (
    <article className="flex flex-col gap-2.5 rounded-lg border border-hairline bg-canvas p-4">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-[13.5px] font-fig-headline leading-snug text-ink">
          {feature.feature || "Feature"}
        </h4>
        <span
          className={cn(
            "caption shrink-0 whitespace-nowrap rounded-pill px-2 py-0.5",
            effort.chip,
          )}
          title={`Adoption effort: ${feature.effort}`}
        >
          {effort.label}
        </span>
      </div>

      {feature.sourceProject && (
        <p className="caption font-mono text-[10.5px] uppercase tracking-wide text-ink/45">
          from {feature.sourceProject}
        </p>
      )}

      {feature.why && (
        <p className="text-[12.5px] leading-relaxed text-ink/75">{feature.why}</p>
      )}

      {feature.sourceRepoUrl && (
        <div className="mt-auto pt-1">
          <LinkPill href={feature.sourceRepoUrl} label="Source repo" />
        </div>
      )}
    </article>
  );
}

// ----------------------------------------------------------------------------
// Shared bits — a section heading, a link pill, loading + empty states.
// ----------------------------------------------------------------------------
function SectionLabel({
  title,
  sub,
  inline,
}: {
  title: string;
  sub?: string;
  inline?: boolean;
}) {
  return (
    <div className={cn(inline ? "mb-3" : "mb-3")}>
      <h3 className="text-[13px] font-fig-headline text-ink">{title}</h3>
      {sub && <p className="caption mt-0.5 text-ink/45">{sub}</p>}
    </div>
  );
}

function LinkPill({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="caption inline-flex items-center gap-1 rounded-pill border border-hairline bg-canvas px-2 py-0.5 text-ink/75 transition-colors hover:bg-surface-soft"
    >
      <span className="truncate max-w-[160px]">{label}</span>
      <svg
        width="11"
        height="11"
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
  );
}

function RadarSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-5">
      <div className="mb-6 space-y-2">
        <div className="h-3.5 w-full animate-pulse rounded bg-surface-soft" />
        <div className="h-3.5 w-5/6 animate-pulse rounded bg-surface-soft" />
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-soft" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg border border-hairline bg-surface-soft/60"
          />
        ))}
      </div>
      <div className="mt-7 grid gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-lg border border-hairline bg-surface-soft/60"
          />
        ))}
      </div>
    </div>
  );
}

function RadarEmpty() {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-hairline bg-surface-soft text-2xl">
          📡
        </span>
        <h3 className="mt-4 text-[15px] font-fig-headline text-ink">
          No radar yet
        </h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/50">
          The hackathon radar runs when the field is in — it scrapes every
          submission, reads each repo, and synthesizes a single us-vs-the-field
          report: where we lead, where we lag, and what's worth borrowing. Check
          back once it's scanned the field.
        </p>
      </div>
    </div>
  );
}
