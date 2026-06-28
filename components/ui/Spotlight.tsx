"use client";

// ============================================================================
// Spotlight — an Aceternity-style soft hero spotlight, recolored to OUR tokens.
// Flat content / glass chrome ethos: this is pure ambient light behind the empty
// state, NOT a default aurora gradient. Three heavily-blurred ellipses in brand
// magenta + lilac + pink at very low opacity, so it reads as a faint glow on the
// white canvas and still sits gracefully on the night (navy) ground.
//
// Dependency-free (no framer-motion in this repo). Entrance is the existing
// `animate-fade-up` utility, suppressed under prefers-reduced-motion. The SVG is
// aria-hidden + pointer-events-none so it never interferes with the UI beneath.
// ============================================================================

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

interface SpotlightProps {
  className?: string;
}

export default function Spotlight({ className }: SpotlightProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 800 600"
      preserveAspectRatio="xMidYMid slice"
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full select-none",
        !reduced && "animate-fade-up",
        className,
      )}
    >
      <g filter="url(#intercept-spotlight-blur)">
        {/* primary magenta beam — the single scarce accent, kept faint */}
        <ellipse
          cx="400"
          cy="165"
          rx="240"
          ry="125"
          style={{ fill: "rgb(var(--accent-magenta))", fillOpacity: 0.13 }}
        />
        {/* lilac + pinkpastel wash so it isn't a flat single-hue blob */}
        <ellipse
          cx="300"
          cy="120"
          rx="160"
          ry="95"
          style={{ fill: "rgb(var(--block-lilac))", fillOpacity: 0.16 }}
        />
        <ellipse
          cx="512"
          cy="135"
          rx="160"
          ry="95"
          style={{ fill: "rgb(var(--block-pink))", fillOpacity: 0.15 }}
        />
      </g>
      <defs>
        <filter
          id="intercept-spotlight-blur"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
          filterUnits="objectBoundingBox"
        >
          <feGaussianBlur stdDeviation="60" />
        </filter>
      </defs>
    </svg>
  );
}
