"use client";

// ============================================================================
// NumberTicker — animate a count up to its target (the live "analytics" beat).
//
// The brief calls for a framer-motion useSpring count-up, but framer-motion is
// NOT a dependency in this repo (it deliberately stays dep-free — see
// components/mascot/Mascot.tsx). So this hand-rolls the same feel: a spring-ish
// easeOutCubic tween driven by requestAnimationFrame. On mount it counts from 0;
// on every value change it tweens from the last shown number to the new one, so
// runs/threads/replies visibly tick up on camera.
//
// Honors prefers-reduced-motion by snapping straight to the value. Renders a
// <span> with tabular-nums so the width never jitters during the count.
// ============================================================================

import { useEffect, useRef, useState } from "react";
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

interface NumberTickerProps {
  value: number;
  /** Tween duration in ms. */
  duration?: number;
  className?: string;
}

export default function NumberTicker({
  value,
  duration = 900,
  className,
}: NumberTickerProps) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const target = Number.isFinite(value) ? value : 0;

    if (reduced) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    const from = fromRef.current;
    if (from === target) {
      setDisplay(target);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic — fast out, gentle settle (spring-like without the deps)
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(from + (target - from) * eased);
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration, reduced]);

  return (
    <span className={cn("tabular-nums", className)}>
      {display.toLocaleString()}
    </span>
  );
}
