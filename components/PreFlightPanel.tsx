"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";

// ============================================================================
// PreFlightPanel — the global PRE-FLIGHT theatre.
// ----------------------------------------------------------------------------
// Mounted ONCE at the app root; it self-opens when something dispatches
//   window.dispatchEvent(new CustomEvent("intercept:open-preflight", {
//     detail: { targetUrl, draft? } }))
//
// It calls convex/preflight.predict({ targetUrl, draft? }) and renders the
// prediction: the DRAFT being analyzed, a big ATTENTION score, three columns —
// Notice / Ignore / Act on — then the risks and one-tap fixes.
//
// Bound by NAME via makeFunctionReference (mirrors components/WinBackPanel.tsx)
// so it compiles regardless of deploy order. Graceful by contract: the backend
// never throws (it degrades to a canned prediction), and every async path here
// is guarded. SSR-safe: the window listener only attaches in an effect. When the
// dispatched detail.targetUrl is empty the panel falls back to the persisted
// settings target itself (via api.settings.getSettings) — no prop threading.
// ============================================================================

interface PreFlightResult {
  draft: string;
  score: number;
  notice: string[];
  ignore: string[];
  actOn: string[];
  risks: string[];
  fixes: string[];
}

interface OpenPreFlightDetail {
  targetUrl?: string;
  draft?: string;
}

// Bound at runtime once convex/preflight.ts deploys (deploy-order safe).
const predictRef = makeFunctionReference<
  "action",
  { targetUrl: string; draft?: string },
  PreFlightResult
>("preflight:predict");

// The three attention columns, in display order. Each maps to one column.
const COLUMN_META: ReadonlyArray<{
  key: "notice" | "ignore" | "actOn";
  label: string;
  caption: string;
  hex: string;
}> = [
  { key: "notice", label: "Notice", caption: "Eyes land here", hex: "var(--block-lilac)" },
  { key: "ignore", label: "Ignore", caption: "Skimmed past", hex: "var(--block-cream)" },
  { key: "actOn", label: "Act on", caption: "Drives a reply", hex: "var(--block-mint)" },
];

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const EMPTY: PreFlightResult = {
  draft: "",
  score: 0,
  notice: [],
  ignore: [],
  actOn: [],
  risks: [],
  fixes: [],
};

export default function PreFlightPanel() {
  const predict = useAction(predictRef);

  // The persisted default target — used when the event carries an empty URL.
  const settings = useQuery(api.settings.getSettings, {});
  const persistedTarget = settings?.targetUrl ?? "";
  // Keep the latest persisted target in a ref so the event handler (attached
  // once) always reads the freshest value without re-binding the listener.
  const persistedRef = useRef<string>("");
  useEffect(() => {
    persistedRef.current = persistedTarget;
  }, [persistedTarget]);

  const [open, setOpen] = useState(false);
  const [targetLabel, setTargetLabel] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreFlightResult>(EMPTY);

  // Guards a stale async resolve from overwriting a newer open.
  const requestId = useRef(0);

  const close = useCallback(() => setOpen(false), []);

  // ── Self-open on the dispatched event ───────────────────────────────────────
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenPreFlightDetail>).detail ?? {};
      const fromDetail = (detail.targetUrl ?? "").trim();
      const target = fromDetail || persistedRef.current || "";
      const draft = (detail.draft ?? "").trim();

      const reqId = requestId.current + 1;
      requestId.current = reqId;

      setResult(EMPTY);
      setError(null);
      setTargetLabel(target || "your draft");
      setLoading(true);
      setOpen(true);

      predict(draft ? { targetUrl: target, draft } : { targetUrl: target })
        .then((res) => {
          if (requestId.current !== reqId) return; // superseded
          if (res && typeof res.draft === "string" && res.draft.length > 0) {
            setResult({
              draft: res.draft,
              score: clampPct(res.score),
              notice: Array.isArray(res.notice) ? res.notice : [],
              ignore: Array.isArray(res.ignore) ? res.ignore : [],
              actOn: Array.isArray(res.actOn) ? res.actOn : [],
              risks: Array.isArray(res.risks) ? res.risks : [],
              fixes: Array.isArray(res.fixes) ? res.fixes : [],
            });
          } else {
            setError("Couldn't pre-flight this message right now.");
          }
        })
        .catch(() => {
          if (requestId.current !== reqId) return;
          // The backend is graceful, but guard the call site regardless.
          setError("Pre-Flight is warming up — try again in a moment.");
        })
        .finally(() => {
          if (requestId.current === reqId) setLoading(false);
        });
    };

    window.addEventListener("intercept:open-preflight", onOpen as EventListener);
    return () =>
      window.removeEventListener("intercept:open-preflight", onOpen as EventListener);
  }, [predict]);

  // ── Esc to close + lock body scroll while open ──────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, close]);

  if (!open) return null;

  const ready = !loading && result.draft.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pre-Flight"
      onClick={close}
    >
      <div
        className="relative flex h-[680px] max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <p className="caption font-mono uppercase tracking-wide text-ink/50">
              Pre-Flight
            </p>
            <h2 className="mt-1 truncate text-[15px] font-fig-headline text-ink">
              What buyers will notice before you send
            </h2>
            <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
              {loading
                ? `Pre-testing the message for ${targetLabel}…`
                : "Predicted attention — notice, ignore, and what drives a reply"}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-full p-1.5 text-ink/50 transition-colors hover:bg-surface-soft hover:text-ink"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>

        {/* Body */}
        <div className="col-scroll min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-soft/50 px-5 py-4">
          {loading && result.draft.length === 0 && <LoadingState />}

          {error && result.draft.length === 0 && (
            <div className="grid h-full place-items-center text-center text-[13px] text-ink/55">
              {error}
            </div>
          )}

          {ready && (
            <div className="animate-row-in space-y-4">
              {/* Score + draft */}
              <div className="grid grid-cols-[auto_1fr] gap-4">
                <AttentionScore score={clampPct(result.score)} />
                <DraftCard draft={result.draft} />
              </div>

              {/* Three attention columns */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {COLUMN_META.map((c) => (
                  <AttentionColumn
                    key={c.key}
                    label={c.label}
                    caption={c.caption}
                    hex={c.hex}
                    items={result[c.key]}
                  />
                ))}
              </div>

              {/* Risks + one-tap fixes */}
              {(result.risks.length > 0 || result.fixes.length > 0) && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {result.risks.length > 0 && (
                    <ListBlock
                      label="Risks"
                      hex="var(--block-pink)"
                      items={result.risks}
                      prefix="!"
                    />
                  )}
                  {result.fixes.length > 0 && (
                    <ListBlock
                      label="One-tap fixes"
                      hex="var(--block-coral)"
                      items={result.fixes}
                      prefix="→"
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <span className="text-[11px] text-ink/45">
            {loading
              ? "Reading it like a buyer would…"
              : ready
                ? `Predicted attention — pre-tested before send`
                : " "}
          </span>
          <button
            type="button"
            onClick={close}
            className="rounded-pill bg-ink px-5 py-1.5 text-[12.5px] font-fig-link text-on-primary transition-opacity hover:opacity-90"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The big ATTENTION score dial.
// ---------------------------------------------------------------------------
function AttentionScore({ score }: { score: number }) {
  const hex =
    score >= 70 ? "var(--block-mint)" : score >= 45 ? "var(--block-cream)" : "var(--block-pink)";
  return (
    <div
      className="flex h-full min-w-[112px] flex-col items-center justify-center rounded-xl border border-hairline px-4 py-3"
      style={{ background: `rgb(${hex})` }}
      aria-label={`Attention score ${score} of 100`}
    >
      <span className="caption font-mono uppercase tracking-wide text-ink/55">
        Attention
      </span>
      <span className="mt-1 font-fig-card text-[40px] leading-none tabular-nums text-ink">
        {score}
      </span>
      <span className="mt-0.5 text-[10px] text-ink/45">/ 100</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The draft being analyzed, shown verbatim.
// ---------------------------------------------------------------------------
function DraftCard({ draft }: { draft: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-hairline bg-canvas p-3.5">
      <p className="caption font-mono uppercase tracking-wide text-ink/45">
        The message analyzed
      </p>
      <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-ink/80">
        {draft}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One attention column (Notice / Ignore / Act on).
// ---------------------------------------------------------------------------
function AttentionColumn({
  label,
  caption,
  hex,
  items,
}: {
  label: string;
  caption: string;
  hex: string;
  items: string[];
}) {
  return (
    <div className="rounded-xl border border-hairline bg-canvas p-3.5">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `rgb(${hex})` }} />
        <span className="text-[12.5px] font-fig-card text-ink">{label}</span>
      </div>
      <p className="caption mt-0.5 font-mono uppercase tracking-wide text-ink/40">{caption}</p>
      <ul className="mt-2.5 space-y-2">
        {items.length === 0 ? (
          <li className="text-[12px] italic text-ink/40">—</li>
        ) : (
          items.map((item, i) => (
            <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-ink/80">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink/30" />
              <span className="min-w-0">{item}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A labelled list block (Risks / One-tap fixes).
// ---------------------------------------------------------------------------
function ListBlock({
  label,
  hex,
  items,
  prefix,
}: {
  label: string;
  hex: string;
  items: string[];
  prefix: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-canvas p-3.5">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `rgb(${hex})` }} />
        <span className="text-[12.5px] font-fig-card text-ink">{label}</span>
      </div>
      <ul className="mt-2.5 space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-[12px] leading-snug text-ink/80">
            <span className="font-mono text-[11px] text-ink/40">{prefix}</span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — score + draft, three columns, two list blocks.
// ---------------------------------------------------------------------------
function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[auto_1fr] gap-4">
        <div className="h-[100px] w-28 animate-pulse rounded-xl bg-surface-soft" />
        <div className="space-y-2 rounded-xl border border-hairline bg-canvas p-3.5">
          <div className="h-2.5 w-28 animate-pulse rounded bg-surface-soft" />
          <div className="h-3 w-full animate-pulse rounded bg-surface-soft" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-surface-soft" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-surface-soft" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-hairline bg-canvas p-3.5">
            <div className="h-3 w-20 animate-pulse rounded bg-surface-soft" />
            <div className="mt-3 space-y-2">
              {[0, 1, 2].map((j) => (
                <div key={j} className="h-3 w-full animate-pulse rounded bg-surface-soft" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-hairline bg-canvas p-3.5">
            <div className="h-3 w-24 animate-pulse rounded bg-surface-soft" />
            <div className="mt-3 space-y-2">
              {[0, 1].map((j) => (
                <div key={j} className="h-3 w-5/6 animate-pulse rounded bg-surface-soft" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
