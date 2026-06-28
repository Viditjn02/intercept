"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

// ============================================================================
// WinBackPanel — the global WIN-BACK theatre.
// ----------------------------------------------------------------------------
// Mounted ONCE at the app root; it self-opens when a sidebar row dispatches
//   window.dispatchEvent(new CustomEvent("intercept:open-winback", {
//     detail: { targetUrl } }))
//
// It calls convex/winback.winbackList({ targetUrl }) for the target company's
// re-winnable closed-lost deals, then renders them RANKED by score: each row
// shows why the deal died (red), what JUST changed (green), a TRANSPARENT
// 4-mini-bar score breakdown (Shipped it · They changed · Still warm · Looks
// re-won), a total score chip, and a warm re-engage opener.
//
// Bound by NAME via makeFunctionReference (mirrors components/chatApi.ts) so it
// compiles regardless of deploy order. Graceful by contract: the backend never
// throws (it degrades to a canned list), and every async path here is guarded.
// SSR-safe: the window listener only attaches in an effect. When the dispatched
// detail.targetUrl is empty the panel falls back to the persisted settings
// target itself (via api.settings.getSettings) — no prop threading required.
// ============================================================================

interface WinBackFactors {
  shippedIt: number;
  theyChanged: number;
  stillWarm: number;
  looksReWon: number;
}

interface WinBackAccount {
  company: string;
  persona: string;
  lostReason: string;
  retrigger: string;
  factors: WinBackFactors;
  score: number;
  reEngageLine: string;
}

interface WinBackResult {
  accounts: WinBackAccount[];
}

interface OpenWinBackDetail {
  targetUrl?: string;
}

// Bound at runtime once convex/winback.ts deploys (deploy-order safe).
const winbackListRef = makeFunctionReference<
  "action",
  { targetUrl: string },
  WinBackResult
>("winback:winbackList");

// The four transparent factors, in display order. Each maps to one mini-bar.
const FACTOR_META: ReadonlyArray<{
  key: keyof WinBackFactors;
  label: string;
  hex: string;
}> = [
  { key: "shippedIt", label: "Shipped it", hex: "var(--block-mint)" },
  { key: "theyChanged", label: "They changed", hex: "var(--block-lilac)" },
  { key: "stillWarm", label: "Still warm", hex: "var(--block-cream)" },
  { key: "looksReWon", label: "Looks re-won", hex: "var(--block-coral)" },
];

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export default function WinBackPanel() {
  const winbackList = useAction(winbackListRef);

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
  const [accounts, setAccounts] = useState<WinBackAccount[]>([]);

  // Guards a stale async resolve from overwriting a newer open.
  const requestId = useRef(0);

  const close = useCallback(() => setOpen(false), []);

  // ── Self-open on the sidebar event ──────────────────────────────────────────
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenWinBackDetail>).detail ?? {};
      const fromDetail = (detail.targetUrl ?? "").trim();
      const target = fromDetail || persistedRef.current || "";

      const reqId = requestId.current + 1;
      requestId.current = reqId;

      setAccounts([]);
      setError(null);
      setTargetLabel(target || "your pipeline");
      setLoading(true);
      setOpen(true);

      winbackList({ targetUrl: target })
        .then((res) => {
          if (requestId.current !== reqId) return; // superseded
          if (res && Array.isArray(res.accounts) && res.accounts.length > 0) {
            const ranked = [...res.accounts].sort((a, b) => b.score - a.score);
            setAccounts(ranked);
          } else {
            setError("Couldn't surface any win-back accounts right now.");
          }
        })
        .catch(() => {
          if (requestId.current !== reqId) return;
          // The backend is graceful, but guard the call site regardless.
          setError("Win-Back is warming up — try again in a moment.");
        })
        .finally(() => {
          if (requestId.current === reqId) setLoading(false);
        });
    };

    window.addEventListener("intercept:open-winback", onOpen as EventListener);
    return () =>
      window.removeEventListener("intercept:open-winback", onOpen as EventListener);
  }, [winbackList]);

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

  const ready = !loading && accounts.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Win-Back"
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
              Win-Back
            </p>
            <h2 className="mt-1 truncate text-[15px] font-fig-headline text-ink">
              Closed-lost, now re-winnable
            </h2>
            <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
              {loading
                ? `Re-scanning dead deals for ${targetLabel}…`
                : "Their reason for saying no just dissolved — re-engage today"}
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

        {/* Body — the ranked list */}
        <div className="col-scroll min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-soft/50 px-5 py-4">
          {loading && accounts.length === 0 && <LoadingState />}

          {error && accounts.length === 0 && (
            <div className="grid h-full place-items-center text-center text-[13px] text-ink/55">
              {error}
            </div>
          )}

          {ready &&
            accounts.map((a, i) => (
              <AccountCard key={`${a.company}-${i}`} account={a} rank={i + 1} />
            ))}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <span className="text-[11px] text-ink/45">
            {loading
              ? "Detecting dissolved objections…"
              : ready
                ? `${accounts.length} accounts ranked by re-engage priority`
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
// One ranked account card.
// ---------------------------------------------------------------------------
function AccountCard({ account, rank }: { account: WinBackAccount; rank: number }) {
  const score = clampPct(account.score);
  return (
    <div className="animate-row-in rounded-xl border border-hairline bg-canvas p-4">
      {/* Top row: rank + company + persona, and the total score chip. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-soft font-mono text-[11px] tabular-nums text-ink/60">
            {rank}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-fig-card text-ink">
              {account.company}
            </p>
            <p className="caption truncate font-mono uppercase tracking-wide text-ink/45">
              {account.persona}
            </p>
          </div>
        </div>
        <ScoreChip score={score} />
      </div>

      {/* Lost / Now lines. */}
      <div className="mt-3 space-y-1.5">
        <p className="flex gap-1.5 text-[12.5px] leading-snug text-ink/80">
          <span className="font-mono text-[10px] uppercase tracking-wide text-red-500/80">
            Lost
          </span>
          <span className="min-w-0">{account.lostReason}</span>
        </p>
        <p className="flex gap-1.5 text-[12.5px] leading-snug text-ink/80">
          <span className="font-mono text-[10px] uppercase tracking-wide text-success">
            Now
          </span>
          <span className="min-w-0">{account.retrigger}</span>
        </p>
      </div>

      {/* Transparent 4-mini-bar score breakdown. */}
      <div className="mt-3 grid grid-cols-4 gap-2">
        {FACTOR_META.map((f) => (
          <FactorBar
            key={f.key}
            label={f.label}
            value={clampPct(account.factors[f.key])}
            hex={f.hex}
          />
        ))}
      </div>

      {/* The warm re-engage opener, as a quote. */}
      <blockquote className="mt-3 rounded-lg border-l-2 border-ink/20 bg-surface-soft/60 px-3 py-2 text-[12.5px] italic leading-relaxed text-ink/75">
        “{account.reEngageLine}”
      </blockquote>
    </div>
  );
}

function ScoreChip({ score }: { score: number }) {
  const hex = score >= 70 ? "var(--block-mint)" : score >= 45 ? "var(--block-cream)" : "var(--block-pink)";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-pill px-3 py-1 text-[12.5px] font-fig-card tabular-nums text-ink"
      style={{ background: `rgb(${hex})` }}
      aria-label={`Re-engage score ${score} of 100`}
    >
      {score}
      <span className="text-[10px] text-ink/45">/100</span>
    </span>
  );
}

function FactorBar({ label, value, hex }: { label: string; value: number; hex: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-1">
        <span className="block truncate font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink/45">
          {label}
        </span>
        <span className="font-mono text-[9px] tabular-nums text-ink/55">{value}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/8">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${value}%`, background: `rgb(${hex})` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeletons — three placeholder cards while the scan runs.
// ---------------------------------------------------------------------------
function LoadingState() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-hairline bg-canvas p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="h-6 w-6 animate-pulse rounded-full bg-surface-soft" />
              <div className="space-y-1.5">
                <div className="h-3.5 w-32 animate-pulse rounded bg-surface-soft" />
                <div className="h-2.5 w-20 animate-pulse rounded bg-surface-soft" />
              </div>
            </div>
            <div className="h-6 w-14 animate-pulse rounded-pill bg-surface-soft" />
          </div>
          <div className="mt-3 space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-surface-soft" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-soft" />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="h-4 animate-pulse rounded bg-surface-soft" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
