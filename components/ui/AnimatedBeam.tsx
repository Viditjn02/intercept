"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";

// ============================================================================
// AnimatedBeam — an Aceternity-style animated connection beam between two DOM
// nodes, recolored to OUR Figma tokens (ink hairline base + a travelling
// magenta→ink "comet" pulse). Ported to pure SVG + CSS (no framer-motion):
// the path is measured from the two refs relative to a container, and the pulse
// is a dashed stroke whose offset is animated along a pathLength-normalised
// curve. Beams are CALM at rest (hairline only) and only show the travelling
// pulse when `active` is true — i.e. while the swarm is flowing.
//
// Motion is fully gated behind prefers-reduced-motion: the keyframes are wrapped
// in @media (prefers-reduced-motion: no-preference) so reduced-motion users see
// a static, dimmed hairline link instead of a moving pulse.
// ============================================================================

const FX_STYLE_ID = "animated-beam-fx";
const FX_CSS = `
@keyframes intercept-beam-flow{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}
.intercept-beam-pulse{opacity:0}
@media (prefers-reduced-motion: no-preference){
.intercept-beam-pulse{opacity:1;animation:intercept-beam-flow var(--beam-duration,2.4s) linear infinite;animation-delay:var(--beam-delay,0s)}
}`;

function ensureBeamStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(FX_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = FX_STYLE_ID;
  el.textContent = FX_CSS;
  document.head.appendChild(el);
}

interface Point {
  x: number;
  y: number;
}

interface Geometry {
  width: number;
  height: number;
  d: string;
  from: Point;
  to: Point;
}

interface AnimatedBeamProps {
  /** The positioned ancestor the SVG is sized to and coordinates are relative to. */
  containerRef: RefObject<HTMLElement | null>;
  /** Source node — the beam starts at its centre. */
  fromRef: RefObject<HTMLElement | null>;
  /** Target node — the beam ends at its centre. */
  toRef: RefObject<HTMLElement | null>;
  /** Vertical lift of the curve's control point (px). Positive arcs upward. */
  curvature?: number;
  /** Travel the pulse from target→source instead of source→target. */
  reverse?: boolean;
  /** Seconds for one pulse traversal. */
  duration?: number;
  /** Stagger (seconds) before the pulse starts. */
  delay?: number;
  /** When true the travelling pulse renders; otherwise only the calm hairline. */
  active?: boolean;
  /** Opacity of the resting hairline base path. */
  baseOpacity?: number;
  className?: string;
}

export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  curvature = 26,
  reverse = false,
  duration = 2.4,
  delay = 0,
  active = false,
  baseOpacity = 0.1,
  className,
}: AnimatedBeamProps) {
  const gradientId = useId().replace(/:/g, "");
  const [geo, setGeo] = useState<Geometry | null>(null);

  useEffect(() => {
    ensureBeamStyles();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const from = fromRef.current;
    const to = toRef.current;
    if (!container || !from || !to) return;

    const measure = () => {
      const c = container.getBoundingClientRect();
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      if (c.width === 0 || c.height === 0) return;

      const start: Point = {
        x: a.left - c.left + a.width / 2,
        y: a.top - c.top + a.height / 2,
      };
      const end: Point = {
        x: b.left - c.left + b.width / 2,
        y: b.top - c.top + b.height / 2,
      };
      const controlX = (start.x + end.x) / 2;
      const controlY = (start.y + end.y) / 2 - curvature;

      setGeo({
        width: c.width,
        height: c.height,
        from: start,
        to: end,
        d: `M ${start.x},${start.y} Q ${controlX},${controlY} ${end.x},${end.y}`,
      });
    };

    measure();
    // Re-measure once after the tile entrance animation settles (transforms shift
    // getBoundingClientRect while fade-up is running).
    const settle = window.setTimeout(measure, 620);

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    ro.observe(from);
    ro.observe(to);
    window.addEventListener("resize", measure);

    return () => {
      window.clearTimeout(settle);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
    // `active` is included so each status transition (which re-renders the board
    // and can nudge layout) triggers a fresh measurement.
  }, [containerRef, fromRef, toRef, curvature, active]);

  if (!geo) return null;

  return (
    <svg
      aria-hidden
      fill="none"
      width={geo.width}
      height={geo.height}
      viewBox={`0 0 ${geo.width} ${geo.height}`}
      className={cn("pointer-events-none absolute left-0 top-0", className)}
    >
      {/* Resting hairline — always visible, calm. */}
      <path
        d={geo.d}
        stroke="rgb(var(--ink))"
        strokeOpacity={baseOpacity}
        strokeWidth={1}
        strokeLinecap="round"
        pathLength={100}
      />
      {/* Travelling comet — only while the swarm flows. */}
      {active && (
        <path
          d={geo.d}
          stroke={`url(#${gradientId})`}
          strokeWidth={1.5}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="11 89"
          className="intercept-beam-pulse"
          style={
            {
              "--beam-duration": `${duration}s`,
              "--beam-delay": `${delay}s`,
              animationDirection: reverse ? "reverse" : "normal",
            } as React.CSSProperties
          }
        />
      )}
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={geo.from.x}
          y1={geo.from.y}
          x2={geo.to.x}
          y2={geo.to.y}
        >
          <stop offset="0%" stopColor="rgb(var(--ink))" stopOpacity={0} />
          <stop offset="22%" stopColor="rgb(var(--ink))" stopOpacity={0.45} />
          <stop offset="50%" stopColor="rgb(var(--accent-magenta))" stopOpacity={1} />
          <stop offset="78%" stopColor="rgb(var(--ink))" stopOpacity={0.45} />
          <stop offset="100%" stopColor="rgb(var(--ink))" stopOpacity={0} />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default AnimatedBeam;
