"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

// ============================================================================
// INTERCEPT — TARGET GATE (the public WELCOME overlay).
// ----------------------------------------------------------------------------
// On the DEPLOYED/public build ONLY, the instant a fresh visitor lands we ask
// which website to point INTERCEPT at — so prod never burns resources running
// our out-of-the-box default (nolongerjobless.com).
//
// Shows ONLY when BOTH are true:
//   1. process.env.NEXT_PUBLIC_PUBLIC_MODE === "1"  (the lead sets this on
//      Vercel + redeploys — UNSET locally, so this overlay is INERT in dev).
//   2. the visitor has NOT yet configured a target in THIS browser
//      (localStorage "intercept.targetConfigured" !== "1").
//
// SSR-safe + never throws: visibility is decided AFTER mount (so SSR and the
// first client render agree on `null`, no hydration mismatch), localStorage is
// only ever touched inside guarded try/catch, and the convex mutation is the
// existing public, never-throws settings.setTargetUrl. When not in public mode
// or already configured it renders NOTHING — local + returning visitors are
// completely unaffected (the pre-warmed default keeps running).
// ============================================================================

// Inlined by Next at build time for BOTH server + client. Unset (local/dev) →
// false → the component is dead weight that always returns null.
const PUBLIC_MODE = process.env.NEXT_PUBLIC_PUBLIC_MODE === "1";

// Per-browser flag: once the visitor configures a target we never gate them again.
const STORAGE_KEY = "intercept.targetConfigured";

/**
 * Normalize an arbitrary URL/domain to a bare host, mirroring
 * convex/settings.ts#normalizeTargetUrl so the value we persist matches the
 * key shape the rest of the pipeline expects. Returns "" when nothing usable
 * remains (so the caller can keep the gate up rather than persist garbage).
 */
function normalizeTargetUrl(input: string): string {
  let host = input.trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^https?:\/\//, "");
  host = host.replace(/^www\./, "");
  host = host.split("/")[0].split("?")[0].split("#")[0];
  return host.trim();
}

export default function TargetGate() {
  // All hooks run unconditionally (before any early return) so the rules of
  // hooks hold regardless of public mode / open state.
  const setTargetUrl = useMutation(api.settings.setTargetUrl);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Decide visibility AFTER mount: SSR + the first client render both produce
  // `null` (open=false), then this effect opens the gate only in the browser,
  // only in public mode, only for an unconfigured visitor. Never throws.
  useEffect(() => {
    if (!PUBLIC_MODE) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== "1") setOpen(true);
    } catch {
      // localStorage unavailable (private mode / blocked) — fail closed: stay
      // hidden rather than risk throwing or trapping the visitor.
    }
  }, []);

  const target = useMemo(() => normalizeTargetUrl(value), [value]);
  const canSubmit = target.length > 0 && !submitting;

  // Persist the per-browser flag (guarded) and drop the overlay.
  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // best-effort; if we can't persist, closing the local state still works.
    }
    setOpen(false);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await setTargetUrl({ targetUrl: target });
    } catch {
      // settings.setTargetUrl is public + never throws for the caller; ignore
      // defensively so a transient hiccup never traps the visitor behind the gate.
    } finally {
      dismiss();
    }
  };

  // Render NOTHING outside public mode or once configured/dismissed — this is
  // what keeps local + returning visitors entirely unaffected.
  if (!PUBLIC_MODE || !open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-scrim/60 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Point INTERCEPT at a company"
    >
      <form
        onSubmit={handleSubmit}
        className="animate-scale-in relative w-full max-w-lg overflow-hidden rounded-lg border border-hairline bg-canvas p-8 shadow-modal sm:p-10"
      >
        {/* eyebrow */}
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
          <p className="caption text-ink/50">INTERCEPT · GTM Command Center</p>
        </div>

        {/* headline */}
        <h2 className="mt-5 font-fig-display text-[clamp(30px,5vw,42px)] leading-[1.06] tracking-[-0.5px] text-ink">
          Point INTERCEPT at a company.
        </h2>

        {/* sub */}
        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-ink/55">
          Paste the website you want to run your GTM on — INTERCEPT does the rest.
        </p>

        {/* input */}
        <label htmlFor="target-gate-url" className="sr-only">
          Company website
        </label>
        <input
          id="target-gate-url"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="yourcompany.com"
          spellCheck={false}
          autoComplete="off"
          inputMode="url"
          aria-label="Company website"
          className="mt-7 w-full rounded-pill border border-hairline bg-surface-soft px-5 py-3.5 font-mono text-[15px] text-ink transition-colors placeholder:text-ink/30 focus:border-ink/30 focus:bg-canvas focus:outline-none focus:ring-2 focus:ring-ink/10"
        />

        {/* primary pill CTA */}
        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-pill bg-primary px-5 py-3.5 font-fig-link text-[15px] text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Pointing INTERCEPT…" : "Run my GTM →"}
        </button>
      </form>
    </div>
  );
}
