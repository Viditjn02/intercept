"use client";

// ============================================================================
// GlareCard — a Linear-style hover glare + a *gentle* tilt for content cards.
//
// Intentionally restrained: flat at rest (no transform, no overlay), and on hover
// a soft brand-magenta highlight tracks the cursor while the card tilts only a
// couple of degrees. We do NOT hard 3D-tilt the whole card — this is chrome
// sheen over flat read-content, recolored to OUR tokens (no rainbow glare).
//
// Dependency-free (no framer-motion in this repo). The glare is a radial-gradient
// overlay whose center follows the pointer; the tilt is a small perspective
// rotateX/rotateY. Both are suppressed under prefers-reduced-motion (the card
// stays perfectly flat). The overlay inherits the card's border-radius and is
// pointer-events-none so it never blocks clicks/links inside the card.
// ============================================================================

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
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

interface GlareCardProps {
  children: ReactNode;
  className?: string;
  /** Max tilt in degrees per axis. Keep small — this is a sheen, not a flip. */
  tilt?: number;
  /** Glare tint — defaults to the brand magenta accent at low opacity. */
  glareColor?: string;
}

export default function GlareCard({
  children,
  className,
  tilt = 2.5,
  glareColor = "rgb(var(--accent-magenta) / 0.10)",
}: GlareCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const [active, setActive] = useState(false);
  const [tiltStyle, setTiltStyle] = useState<CSSProperties>({});

  const handleMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    setPos({ x: px * 100, y: py * 100 });
    if (!reduced) {
      const rx = (py - 0.5) * -2 * tilt;
      const ry = (px - 0.5) * 2 * tilt;
      setTiltStyle({
        transform: `perspective(1000px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`,
      });
    }
  };

  const handleLeave = () => {
    setActive(false);
    setTiltStyle({});
  };

  return (
    <div
      ref={ref}
      onMouseEnter={() => setActive(true)}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={tiltStyle}
      className={cn(
        "relative transition-transform duration-standard ease-spring [transform-style:preserve-3d] will-change-transform",
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-quick"
        style={{
          opacity: active ? 1 : 0,
          background: `radial-gradient(circle 160px at ${pos.x}% ${pos.y}%, ${glareColor}, transparent 62%)`,
        }}
      />
    </div>
  );
}
