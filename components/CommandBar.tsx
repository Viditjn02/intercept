"use client";

// ============================================================================
// CommandBar — the bottom-center command input for INTERCEPT.
//
// Light Figma editorial chrome: a floating glass pill that sits centred at the
// bottom of the workspace. The integrator wires `onSubmit` to the existing
// `conversations.send` mutation; this component owns NO data layer — it only
// captures intent text and surfaces the active Target URL as a chip on the left.
//
// Standalone-compilable: depends only on React + two zero-dep local helpers
// (`cn`, `hostFromUrl`). No convex / generated-api imports.
// ============================================================================

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import { hostFromUrl } from "./format";

export interface CommandBarHandle {
  /** Focus the input (e.g. when the workspace surface mounts or ⌘K is hit). */
  focus: () => void;
  /** Replace the current draft text (e.g. to prefill a command). */
  setText: (text: string) => void;
}

export interface CommandBarProps {
  /** Active subject URL shown as a chip on the left ("Target: …"). */
  targetUrl?: string;
  /**
   * Fired with the trimmed command text on Execute / Enter.
   * May be async — the bar shows a working state until it resolves.
   */
  onSubmit: (text: string) => void | Promise<void>;
  /** Disables input + Execute (e.g. while the workspace is booting). */
  disabled?: boolean;
  /** Placeholder override; defaults to the canonical INTERCEPT prompt. */
  placeholder?: string;
  /** Extra classes on the outer (full-width, pointer-events-none) layer. */
  className?: string;
}

const DEFAULT_PLACEHOLDER = "Tell INTERCEPT what to do…";

export const CommandBar = forwardRef<CommandBarHandle, CommandBarProps>(
  function CommandBar(
    { targetUrl, onSubmit, disabled = false, placeholder, className },
    ref,
  ) {
    const [text, setText] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => inputRef.current?.focus(),
        setText: (next: string) => {
          setText(next);
          requestAnimationFrame(() => inputRef.current?.focus());
        },
      }),
      [],
    );

    const trimmed = text.trim();
    const canSubmit = trimmed.length > 0 && !submitting && !disabled;
    const host = hostFromUrl(targetUrl);

    const submit = async () => {
      if (!canSubmit) return;
      const payload = trimmed;
      setSubmitting(true);
      try {
        await onSubmit(payload);
        setText(""); // clear only after a successful handoff
      } catch {
        // Keep the draft so the user can retry; the integrator surfaces errors.
      } finally {
        setSubmitting(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };

    const onFormSubmit = (e: FormEvent) => {
      e.preventDefault();
      void submit();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void submit();
      }
    };

    return (
      <div
        className={cn(
          // Full-width layer so the pill can centre itself; clicks pass through
          // the gutters but not the pill (pointer-events re-enabled below).
          "pointer-events-none relative flex w-full justify-center px-md pb-lg",
          className,
        )}
      >
        {/* Scrim — fades scrolling content into the canvas BEFORE it reaches the
            bar, and gives the pill a solid backing so nothing shows through it
            (founder: "nothing should scroll behind the command bar"). Token-based
            so it tracks the light/dark canvas. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-12 bottom-0 bg-gradient-to-t from-canvas via-canvas/92 to-transparent"
        />
        <form
          onSubmit={onFormSubmit}
          className={cn(
            "glass-1 pointer-events-auto relative z-10 flex w-full max-w-[680px] items-center gap-sm",
            "rounded-pill border border-hairline pl-xs pr-xs py-1.5 shadow-glass-1",
            "transition-shadow focus-within:shadow-glass-2",
            disabled && "opacity-60",
          )}
        >
          {/* Target URL chip — left rail context. */}
          {host ? (
            <span
              title={targetUrl}
              className={cn(
                "ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-pill",
                "bg-surface-soft px-sm py-1.5 font-mono text-caption uppercase tracking-fig-caption text-ink/60",
              )}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
              />
              <span className="max-w-[140px] truncate normal-case tracking-normal text-ink/75">
                {host}
              </span>
            </span>
          ) : null}

          {/* Command input. */}
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={placeholder ?? DEFAULT_PLACEHOLDER}
            aria-label="Command input"
            enterKeyHint="send"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              "min-w-0 flex-1 bg-transparent px-2 py-1.5 text-body-sm text-ink",
              "placeholder:text-ink/35 focus:outline-none disabled:cursor-not-allowed",
            )}
          />

          {/* Execute pill. */}
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-primary",
              "px-lg py-2 font-sans text-button text-on-primary",
              "transition-all hover:brightness-110 active:scale-[0.98]",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100",
            )}
          >
            {submitting ? (
              <span
                aria-hidden
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-on-primary/30 border-t-on-primary"
              />
            ) : (
              <ExecuteGlyph />
            )}
            <span>{submitting ? "Working" : "Execute"}</span>
          </button>
        </form>
      </div>
    );
  },
);

function ExecuteGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <path
        d="M2.5 7h8M7 3.5 10.5 7 7 10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default CommandBar;
