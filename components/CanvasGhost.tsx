"use client";

import { cn } from "@/lib/utils";
import { CAPABILITIES, ROUTER_INTENTS, type Capability } from "@/lib/contract";

// ============================================================================
// CanvasGhost — the canvas-level empty state. NEVER a blank board: a row of
// ghosted preview tiles (what *will* appear) + ONE pulsing CTA that points the
// user back to the composer. Editorial/flat (it's content you read, not chrome)
// — no glass here. All motion is gated on `reducedMotion`.
// ============================================================================

// Per-capability dot colour — reuses the pastel block system as a breadcrumb.
const GHOST_BLOCK: Partial<Record<Capability, string>> = {
  analyze: "bg-block-lime",
  discovery: "bg-block-mint",
  outbound: "bg-block-lilac",
  competitor: "bg-block-pink",
  content: "bg-block-cream",
  social: "bg-block-navy",
};

// Best-effort, non-breaking: ask the composer to take focus. The page/ChatPanel
// may listen for the event; we also try a direct focus as a graceful fallback.
function focusComposer() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("intercept:focus-composer"));
    const el = document.querySelector<HTMLTextAreaElement>(
      "[data-composer-input], textarea",
    );
    el?.focus();
  } catch {
    /* never break the canvas */
  }
}

interface CanvasGhostProps {
  hasConversation: boolean;
  reducedMotion: boolean;
}

export default function CanvasGhost({
  hasConversation,
  reducedMotion,
}: CanvasGhostProps) {
  // 4 real capabilities, shown ghosted as "what could render here".
  const preview = ROUTER_INTENTS.filter((r) =>
    (CAPABILITIES as readonly string[]).includes(r.intent),
  ).slice(0, 4);

  return (
    <div className="relative grid h-full place-items-center overflow-hidden px-6">
      <div
        className={cn(
          "w-full max-w-2xl text-center",
          !reducedMotion && "animate-fade-up",
        )}
      >
        <p className="eyebrow text-ink/60">The live canvas</p>
        <h2 className="mt-2 text-headline text-ink">
          {hasConversation ? "Ready when you are" : "Whatever you ask renders here"}
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink/70">
          {hasConversation
            ? "Send a message — the swarm spins up below, live."
            : "Drop a company, ask for prospects, or scan a competitor. The work assembles itself in this space."}
        </p>

        {/* ghosted board preview — never a blank surface */}
        <div
          aria-hidden
          className="mt-7 grid gap-3 text-left sm:grid-cols-2"
        >
          {preview.map((c, i) => (
            <div
              key={c.intent}
              className={cn(
                "rounded-lg border border-hairline bg-surface-soft/60 p-3.5",
                "opacity-[.55] [mask-image:linear-gradient(to_bottom,black,transparent)]",
              )}
              style={{ opacity: 0.6 - i * 0.08 }}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    GHOST_BLOCK[c.intent as Capability] ?? "bg-block-lime",
                  )}
                />
                <span className="h-2.5 w-1/2 rounded-full bg-ink/15" />
              </div>
              <div className="mt-3 space-y-2">
                <span className="block h-2 w-full rounded-full bg-ink/10" />
                <span className="block h-2 w-4/5 rounded-full bg-ink/10" />
              </div>
            </div>
          ))}
        </div>

        {/* ONE pulsing CTA — points back to the composer */}
        <div className="mt-7 flex items-center justify-center gap-3">
          <button
            onClick={focusComposer}
            className={cn(
              "inline-flex items-center gap-2 rounded-pill bg-primary px-5 py-2.5 text-[13px] font-fig-link text-on-primary transition-transform hover:-translate-y-px",
              !reducedMotion && "animate-pulse-ring",
            )}
          >
            <span className="relative flex h-2 w-2">
              {!reducedMotion && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-on-primary/60" />
              )}
              <span className="relative inline-flex h-2 w-2 rounded-full bg-on-primary" />
            </span>
            {hasConversation ? "Type a message to begin" : "Start in the composer"}
          </button>
        </div>
        <p className="mt-3 text-[11px] text-ink/45">
          or press{" "}
          <kbd className="rounded border border-hairline bg-surface-soft px-1.5 py-0.5 font-fig-mono text-[10px] text-ink/70">
            ⌘K
          </kbd>{" "}
          for everything
        </p>
      </div>
    </div>
  );
}
