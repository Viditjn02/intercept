"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
// BrainCanvas — the compounding brain as an INTERACTIVE FORCE-DIRECTED GRAPH.
//
// Every knowledge page (one per company / competitor / ICP / campaign) becomes a
// node; edges connect pages that were touched by the SAME run or that cite the
// SAME source — i.e. the shared facts that knit the wiki together. The whole
// thing self-organises with a d3 force layout you can drag / zoom / pan; click a
// node and its facts slide out in a side panel.
//
// STYLE — strictly our Figma tokens (no library gradients/aurora):
//   • nodes  → ink, radius ∝ √factCount (bigger page = more learned)
//   • ring   → a constant pastel per entityType (poster panels on any ground)
//   • focus  → magenta fill; a just-ingested OR selected node PULSES magenta
//   • links  → hairline, sub-pixel, weight ∝ shared runs/sources
//   • ground → transparent canvas (flat content); chrome (legend, side panel,
//              header) is the only glass. Palette is read live from CSS vars so
//              it flips perfectly between light + night.
//
// SSR — react-force-graph-2d touches `window`/`canvas`, so it's dynamic-imported
// inside an effect (never on the server). Until it (and the data) arrive we show
// a skeleton; an empty brain shows a calm "the brain is learning…" state.
//
// READS via typed function references (same bind-at-runtime pattern as chatApi):
// convex/knowledge.ts builds in parallel and isn't in the generated `api` yet, so
// these compile independently and bind once the engine deploys. If it ISN'T
// deployed the query throws during render and the surrounding PanelBoundary shows
// a calm fallback — it never white-screens.
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

// react-force-graph-2d's default export, resolved at runtime (client-only).
type ForceGraphComponent = typeof import("react-force-graph-2d")["default"];
// The imperative handle the component hands back via ref.
type ForceGraphHandle = {
  zoomToFit: (durationMs?: number, padding?: number) => unknown;
  centerAt: (x?: number, y?: number, durationMs?: number) => unknown;
  d3ReheatSimulation: () => unknown;
};

// ----------------------------------------------------------------------------
// Graph model. Extra fields ride on the node/link objects the library mutates
// in place (it assigns x/y/vx/vy each tick); we only ever READ ours.
// ----------------------------------------------------------------------------
interface GraphNode {
  id: string;
  entityType: KnowledgeEntityType;
  title: string;
  entityKey: string;
  factCount: number;
  runCount: number;
  fresh: boolean; // touched within the pulse window
  radius: number; // canvas units, ∝ √factCount
  // library-assigned (read-only for us)
  x?: number;
  y?: number;
}
interface GraphLink {
  source: string;
  target: string;
  weight: number; // shared runs/sources
}
interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// Constant pastel ring per entity type — reads as a poster panel on white OR
// navy (these tokens don't flip), so the legend is stable across themes.
const RING: Record<KnowledgeEntityType, string> = {
  company: "#c5b0f4", // block-lilac — the thing we sell
  competitor: "#f3c9b6", // block-coral — who we're up against
  icp: "#c8e6cd", // block-mint — buyer segments
  campaign: "#f4ecd6", // block-cream — standing motions
};
const ENTITY_LABEL: Record<KnowledgeEntityType, string> = {
  company: "Companies",
  competitor: "Competitors",
  icp: "Buyer segments",
  campaign: "Campaigns",
};
const ENTITY_ORDER: readonly KnowledgeEntityType[] = [
  "company",
  "competitor",
  "icp",
  "campaign",
];
const MAGENTA = "#ff3d8b"; // --accent-magenta, constant across themes

interface BrainCanvasProps {
  /** Optional entity key to spotlight (e.g. the active run's company). */
  highlightKey?: string;
}

export default function BrainCanvas({ highlightKey }: BrainCanvasProps) {
  // Both reads come from the same module, so they deploy together; if the
  // module is absent both throw and PanelBoundary catches it once.
  const pages = useQuery(listPagesRef, {}) as KnowledgePageDoc[] | undefined;
  const stats = useQuery(brainStatsRef, {}) as BrainStatsDoc | undefined;

  const graph = useMemo(() => buildGraph(pages ?? []), [pages]);
  const derived = useMemo(() => deriveStats(pages ?? []), [pages]);
  const header = {
    pages: stats?.pages ?? derived.pages,
    facts: stats?.facts ?? derived.facts,
    runs: stats?.runs ?? derived.runs,
  };

  const loading = pages === undefined;
  const empty = !loading && graph.nodes.length === 0;

  // selected node → side panel. Keyed by id; resolved against the live page list.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedPage = useMemo(
    () => (pages ?? []).find((p) => p._id === selectedId) ?? null,
    [pages, selectedId],
  );

  // A node is "focused" (magenta) when selected, just-ingested, or matches the
  // highlightKey passed by the canvas (the active run's company).
  const highlightId = useMemo(() => {
    if (!highlightKey) return null;
    const k = highlightKey.toLowerCase();
    return (pages ?? []).find((p) => p.entityKey.toLowerCase() === k)?._id ?? null;
  }, [pages, highlightKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BrainHeader
        pages={header.pages}
        facts={header.facts}
        runs={header.runs}
        nodeCount={graph.nodes.length}
        linkCount={graph.links.length}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <BrainSkeleton />
        ) : empty ? (
          <BrainEmpty />
        ) : (
          <GraphStage
            graph={graph}
            selectedId={selectedId}
            highlightId={highlightId}
            onSelect={setSelectedId}
          />
        )}

        {/* legend — glass chrome, anchored bottom-left, never blocks the graph */}
        {!loading && !empty && <Legend />}

        {/* facts side-panel — glass chrome, slides in from the right on select */}
        <FactsPanel page={selectedPage} onClose={() => setSelectedId(null)} />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// GraphStage — owns the dynamic import, container sizing, live palette, and the
// canvas-object painters. Everything below is client-only (rendered only after
// `loading` resolves, and the import runs in an effect).
// ----------------------------------------------------------------------------
function GraphStage({
  graph,
  selectedId,
  highlightId,
  onSelect,
}: {
  graph: GraphData;
  selectedId: string | null;
  highlightId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphHandle | undefined>(undefined);

  const [ForceGraph, setForceGraph] = useState<ForceGraphComponent | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const palette = usePalette();
  const reducedMotion = usePrefersReducedMotion();

  // Keep the latest interaction state in refs so the per-frame painters (created
  // once) always read fresh values without re-binding every render.
  const selectedRef = useRef(selectedId);
  const highlightRef = useRef(highlightId);
  const reducedRef = useRef(reducedMotion);
  selectedRef.current = selectedId;
  highlightRef.current = highlightId;
  reducedRef.current = reducedMotion;

  // Dynamic-import the canvas component (avoids SSR `window`/`canvas` access).
  useEffect(() => {
    let active = true;
    import("react-force-graph-2d")
      .then((m) => {
        if (active) setForceGraph(() => m.default);
      })
      .catch(() => {
        /* leaves the skeleton up; PanelBoundary stays calm */
      });
    return () => {
      active = false;
    };
  }, []);

  // Measure the container so the canvas fills it exactly (no window-width spill).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit-to-view once the layout first settles (not on every drag-induced settle).
  const didFit = useRef(false);
  useEffect(() => {
    didFit.current = false;
  }, [graph]);
  const handleEngineStop = useCallback(() => {
    if (didFit.current) return;
    didFit.current = true;
    fgRef.current?.zoomToFit(reducedRef.current ? 0 : 500, 56);
  }, []);

  // --- node painter: ink body, pastel ring, magenta + pulse on focus ---------
  const paintNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = node.radius;
      const focused =
        node.id === selectedRef.current ||
        node.id === highlightRef.current ||
        node.fresh;

      // pulsing magenta halo for focused / just-ingested nodes
      if (focused && !reducedRef.current) {
        const t = (now() % 1600) / 1600; // 0→1 each 1.6s
        const haloR = r + 2 + t * 10;
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, TWO_PI);
        ctx.strokeStyle = rgba(MAGENTA, (1 - t) * 0.5);
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
      }

      // node body
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fillStyle = focused ? MAGENTA : palette.ink;
      ctx.fill();

      // pastel entity ring
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = focused ? rgba(MAGENTA, 0.9) : RING[node.entityType];
      ctx.stroke();

      // label once we're zoomed in (or always for the focused node)
      if (scale > 1.3 || focused) {
        const fontSize = Math.min(13, 11 / scale + 4);
        ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = palette.ink;
        ctx.fillText(truncate(node.title, 22), x, y + r + 3 / scale);
      }
    },
    [palette.ink],
  );

  // Matching hit-area so hover/click land on the visible disc.
  const paintPointerArea = useCallback(
    (node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, node.radius + 2, 0, TWO_PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      onSelect(node.id);
      fgRef.current?.centerAt(node.x, node.y, reducedRef.current ? 0 : 500);
    },
    [onSelect],
  );

  // Keep the canvas redrawing continuously ONLY while something should pulse
  // (a selected / highlighted / just-ingested node) and motion is allowed —
  // otherwise let the renderer pause when idle to spare the CPU.
  const hasPulseTarget =
    !reducedMotion &&
    (selectedId !== null ||
      highlightId !== null ||
      graph.nodes.some((n) => n.fresh));

  const ready = ForceGraph && size.w > 0 && size.h > 0;

  return (
    <div ref={containerRef} className="absolute inset-0 bg-surface-soft/30">
      {ready ? (
        <ForceGraph
          ref={fgRef as never}
          graphData={graph as never}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={1}
          nodeCanvasObject={paintNode as never}
          nodePointerAreaPaint={paintPointerArea as never}
          nodeLabel={((n: GraphNode) =>
            `${n.title} · ${n.factCount} facts`) as never}
          linkColor={(() => palette.hairline) as never}
          linkWidth={((l: GraphLink) =>
            0.4 + Math.min(1.6, (l.weight - 1) * 0.5)) as never}
          linkDirectionalParticles={0}
          onNodeClick={handleNodeClick as never}
          onBackgroundClick={(() => onSelect(null)) as never}
          enableNodeDrag
          cooldownTicks={reducedMotion ? 0 : undefined}
          warmupTicks={reducedMotion ? 120 : 0}
          autoPauseRedraw={!hasPulseTarget}
          onEngineStop={handleEngineStop}
        />
      ) : (
        <BrainSkeleton />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Header — the global "brain" stat strip. Glass chrome, flat numbers.
// ----------------------------------------------------------------------------
function BrainHeader({
  pages,
  facts,
  runs,
  nodeCount,
  linkCount,
}: {
  pages: number;
  facts: number;
  runs: number;
  nodeCount: number;
  linkCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-canvas/80 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <span aria-hidden className="text-2xl leading-none">
          🧠
        </span>
        <div>
          <h2 className="text-sm font-fig-headline text-ink">The brain</h2>
          <p className="caption mt-0.5 text-ink/50">
            {nodeCount} {nodeCount === 1 ? "page" : "pages"} ·{" "}
            {linkCount} {linkCount === 1 ? "link" : "links"} — it compounds every
            run, never resets.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <Stat value={pages} label="pages" />
        <span className="h-7 w-px bg-hairline" />
        <Stat value={facts} label="facts" accent />
        <span className="h-7 w-px bg-hairline" />
        <Stat value={runs} label="runs" />
      </div>
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
          "text-lg font-fig-headline tabular-nums leading-none text-ink",
          !accent && "text-ink/80",
        )}
      >
        {value.toLocaleString()}
      </p>
      <p className="caption mt-1 text-ink/40">{label}</p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Legend — pastel ring key. Glass chrome floating over the canvas.
// ----------------------------------------------------------------------------
function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1.5 rounded-lg border border-hairline bg-canvas/80 px-3 py-2.5 backdrop-blur">
      {ENTITY_ORDER.map((t) => (
        <div key={t} className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full border-2"
            style={{ borderColor: RING[t], background: "transparent" }}
          />
          <span className="caption text-ink/60">{ENTITY_LABEL[t]}</span>
        </div>
      ))}
      <div className="mt-0.5 flex items-center gap-2 border-t border-hairline pt-1.5">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: MAGENTA }}
        />
        <span className="caption text-ink/60">Focused / just learned</span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// FactsPanel — the side panel for a selected node. Glass chrome, flat facts.
// ----------------------------------------------------------------------------
function FactsPanel({
  page,
  onClose,
}: {
  page: KnowledgePageDoc | null;
  onClose: () => void;
}) {
  const open = !!page;
  const facts = useMemo(
    () =>
      [...(page?.facts ?? [])].sort(
        (a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0),
      ),
    [page],
  );
  const factCount = page?.factCount ?? page?.facts?.length ?? 0;
  const runCount = page?.runCount ?? page?.sources?.length ?? 0;
  const updatedAt = page?.updatedAt ?? page?._creationTime ?? 0;

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "absolute inset-y-0 right-0 z-10 flex w-[300px] max-w-[82%] flex-col border-l border-hairline bg-canvas/90 backdrop-blur transition-transform duration-300 ease-out",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      {page && (
        <>
          <div className="flex items-start justify-between gap-2 border-b border-hairline px-4 py-3.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full border-2"
                  style={{ borderColor: RING[page.entityType] }}
                />
                <span className="caption text-ink/45">
                  {ENTITY_LABEL[page.entityType]}
                </span>
              </div>
              <h3 className="mt-1.5 truncate text-[14px] font-fig-headline text-ink">
                {page.title}
              </h3>
              <p className="truncate text-[11px] text-ink/40">{page.entityKey}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-md border border-hairline px-2 py-1 text-[12px] leading-none text-ink/50 transition-colors hover:border-ink/25 hover:text-ink"
            >
              ✕
            </button>
          </div>

          <div className="flex items-baseline gap-4 border-b border-hairline px-4 py-3">
            <div>
              <p className="text-xl font-fig-card tabular-nums leading-none text-ink">
                {factCount.toLocaleString()}
              </p>
              <p className="caption mt-1 text-ink/40">
                {factCount === 1 ? "fact" : "facts"}
              </p>
            </div>
            <div>
              <p className="text-xl font-fig-card tabular-nums leading-none text-ink/80">
                {runCount.toLocaleString()}
              </p>
              <p className="caption mt-1 text-ink/40">
                {runCount === 1 ? "run" : "runs"}
              </p>
            </div>
            <div className="ml-auto self-end text-right">
              <p className="caption text-ink/40">updated {relativeTime(updatedAt)}</p>
            </div>
          </div>

          <div className="col-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {facts.length === 0 ? (
              <p className="text-[12px] leading-relaxed text-ink/45">
                No facts on this page yet — it'll fill in as runs compound.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {facts.map((f, i) => (
                  <FactRow key={i} fact={f} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function FactRow({ fact }: { fact: KnowledgeFactDoc }) {
  const fresh = now() - (fact.learnedAt ?? 0) < RECENT_WINDOW_MS;
  return (
    <li className="flex items-start gap-2 text-[11.5px] leading-snug">
      <span
        className={cn(
          "caption mt-0.5 shrink-0 rounded border px-1.5 py-px",
          fresh
            ? "border-transparent bg-block-mint text-ink"
            : "border-hairline bg-surface-soft text-ink/50",
        )}
      >
        {fact.kind || "note"}
      </span>
      <span className="min-w-0 flex-1 text-ink/70">
        {fact.text}
        {fact.url && (
          <a
            href={fact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1.5 whitespace-nowrap text-ink/70 underline-offset-2 hover:text-ink hover:underline"
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
    <div className="absolute inset-0 grid place-items-center">
      <div className="flex flex-col items-center gap-3">
        <span className="flex h-12 w-12 animate-pulse items-center justify-center rounded-full border border-hairline bg-surface-soft text-2xl">
          🧠
        </span>
        <p className="caption text-ink/40">Wiring the brain…</p>
      </div>
    </div>
  );
}

function BrainEmpty() {
  return (
    <div className="absolute inset-0 grid place-items-center px-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-hairline bg-surface-soft text-2xl">
          🧠
        </span>
        <h3 className="mt-4 text-[15px] font-fig-headline text-ink">
          The brain is learning…
        </h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/50">
          Every run leaves durable facts behind. Run a discovery, outbound, or
          competitor scan and watch the first knowledge nodes appear — then wire
          together and grow, run after run.
        </p>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Live palette — read CSS vars so canvas colors flip with light/night.
// ----------------------------------------------------------------------------
interface Palette {
  ink: string;
  hairline: string;
}
function usePalette(): Palette {
  const read = (): Palette => {
    if (typeof window === "undefined") return { ink: "#000", hairline: "#e6e6e6" };
    const cs = getComputedStyle(document.documentElement);
    return {
      ink: cssRgb(cs.getPropertyValue("--ink"), "0 0 0"),
      hairline: cssRgb(cs.getPropertyValue("--hairline"), "230 230 230"),
    };
  };
  const [palette, setPalette] = useState<Palette>({
    ink: "#000",
    hairline: "#e6e6e6",
  });
  useEffect(() => {
    setPalette(read());
    const target = document.documentElement;
    const obs = new MutationObserver(() => setPalette(read()));
    obs.observe(target, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    return () => obs.disconnect();
  }, []);
  return palette;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

// ----------------------------------------------------------------------------
// Pure helpers.
// ----------------------------------------------------------------------------
const TWO_PI = Math.PI * 2;
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** "230 230 230" (space-separated rgb triplet) → "rgb(230,230,230)". */
function cssRgb(value: string, fallback: string): string {
  const triplet = (value || fallback).trim().split(/[\s,]+/).slice(0, 3);
  if (triplet.length < 3) return `rgb(${fallback.replace(/\s+/g, ",")})`;
  return `rgb(${triplet.join(",")})`;
}

/** "#ff3d8b" + alpha → "rgba(255,61,139,a)". */
function rgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Build {nodes, links} from the knowledge pages. Nodes = pages (radius ∝ √facts,
 * fresh = touched in the pulse window). Links connect pages that share a run (via
 * `sources[].runId` or `facts[].runId`) or cite the same external URL — i.e. the
 * shared facts that knit the wiki together. Weight = how many such overlaps.
 */
function buildGraph(pages: readonly KnowledgePageDoc[]): GraphData {
  const t = Date.now();
  const nodes: GraphNode[] = pages.map((p) => {
    const factCount = p.factCount ?? p.facts?.length ?? 0;
    const updatedAt = p.updatedAt ?? p._creationTime;
    return {
      id: p._id,
      entityType: p.entityType,
      title: p.title,
      entityKey: p.entityKey,
      factCount,
      runCount: p.runCount ?? p.sources?.length ?? 0,
      fresh: t - updatedAt < RECENT_WINDOW_MS,
      radius: 3 + 2.4 * Math.sqrt(factCount),
    };
  });

  const idSet = new Set(nodes.map((n) => n.id));

  // Group node-ids by every "connector" key (a runId, or a source URL). Two
  // pages under the same key are related.
  const buckets = new Map<string, Set<string>>();
  const add = (key: string, id: string) => {
    if (!key) return;
    const set = buckets.get(key) ?? new Set<string>();
    set.add(id);
    buckets.set(key, set);
  };
  for (const p of pages) {
    if (!idSet.has(p._id)) continue;
    for (const s of p.sources ?? []) add(`run:${String(s.runId)}`, p._id);
    for (const f of p.facts ?? []) {
      if (f.runId) add(`run:${String(f.runId)}`, p._id);
      if (f.url) add(`url:${f.url}`, p._id);
    }
  }

  // Accumulate pairwise weights across all shared connectors.
  const weights = new Map<string, number>();
  for (const set of buckets.values()) {
    const ids = [...set];
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
  }

  const links: GraphLink[] = [];
  for (const [key, weight] of weights) {
    const [source, target] = key.split("|");
    links.push({ source, target, weight });
  }

  return { nodes, links };
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
