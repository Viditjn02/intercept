"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CAPABILITIES,
  ROUTER_INTENTS,
  type Capability,
} from "@/lib/contract";
import { cn } from "@/lib/utils";
import { useTheme } from "./ThemeProvider";
import { listConversationsRef, sendMessageRef } from "./chatApi";
import type { CanvasView } from "./CanvasPanel";
import type { ConversationDoc } from "./types";

// ============================================================================
// CommandPalette — the ⌘K power + discovery layer. ONE keystroke surfaces every
// action INTERCEPT can take: kick off any capability run, jump to a past
// conversation, flip the canvas lens, toggle the theme/sidebar. Fuzzy search,
// keyboard-first, context-ranked to the current canvas mode, with shortcut hints
// next to each row. Mounted ONCE; owns its own ⌘K listener.
//
// It is CHROME you look *through* → Tier-2 glass (glass-2), 1px border, scale-in
// on open (transform/opacity only — never animates backdrop-filter), and a solid
// fallback inherited from the .glass-2 utility under prefers-reduced-transparency.
// ============================================================================

interface CommandPaletteProps {
  conversationId: Id<"conversations"> | null;
  canvasView: CanvasView;
  sidebarCollapsed: boolean;
  /** Select an existing conversation, or pass null to start fresh. */
  onConversation: (id: Id<"conversations"> | null) => void;
  onSetCanvasView: (view: CanvasView) => void;
  onToggleSidebar: () => void;
}

type CommandKind = "create" | "navigate" | "view" | "conversation";

interface Command {
  id: string;
  kind: CommandKind;
  category: string;
  label: string;
  hint?: string;
  /** Display-only shortcut keys (rendered as kbd chips). */
  shortcut?: string[];
  /** Extra haystack tokens for fuzzy matching. */
  keywords?: string;
  /** Ranking nudge toward the current mode. */
  boost?: number;
  perform: () => void | Promise<void>;
}

// The capabilities that spawn a run, with friendly labels + display shortcuts.
const CAPABILITY_COMMANDS: { intent: Capability; label: string; shortcut?: string[] }[] = [
  { intent: "discovery", label: "Find live buyer threads", shortcut: ["⌘", "1"] },
  { intent: "outbound", label: "Build an outbound list", shortcut: ["⌘", "2"] },
  { intent: "competitor", label: "Scan competitor ads", shortcut: ["⌘", "3"] },
  { intent: "content", label: "Make an ad — image + video", shortcut: ["⌘", "4"] },
  { intent: "social", label: "Make it go viral", shortcut: ["⌘", "5"] },
  { intent: "replicate", label: "Replicate & improve a post or ad" },
  { intent: "onboarding", label: "Generate an onboarding flow" },
  { intent: "outreach", label: "Send approved outreach" },
  { intent: "analyze", label: "Run a full sweep on a company" },
];

function routerSpec(intent: Capability) {
  return ROUTER_INTENTS.find((r) => r.intent === intent);
}

// ----------------------------------------------------------------------------
// Fuzzy subsequence scorer. Returns null when `query` is not a subsequence of
// `text`; higher score = better (contiguous + early matches rank up).
// ----------------------------------------------------------------------------
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub + (sub === 0 ? 50 : 0);
  let ti = 0;
  let score = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    score += found === lastMatch + 1 ? 8 : 2; // reward contiguous runs
    if (found < 6) score += 2; // reward early matches
    lastMatch = found;
    ti = found + 1;
  }
  return score;
}

function CategoryIcon({ kind }: { kind: CommandKind }) {
  const common = "h-4 w-4";
  if (kind === "create")
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common} aria-hidden>
        <path d="M5 12h14M12 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (kind === "view")
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common} aria-hidden>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M3.5 9.5h17" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  if (kind === "conversation")
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common} aria-hidden>
        <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l.9-5.2A8 8 0 1 1 21 12Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" fill="none" className={common} aria-hidden>
      <path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="caption flex h-5 min-w-[20px] items-center justify-center rounded border border-hairline bg-canvas px-1.5 text-ink/70"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export default function CommandPalette({
  conversationId,
  canvasView,
  sidebarCollapsed,
  onConversation,
  onSetCanvasView,
  onToggleSidebar,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const send = useMutation(sendMessageRef);
  const theme = useTheme();
  const conversations = useQuery(
    listConversationsRef,
    open ? {} : "skip",
  ) as ConversationDoc[] | undefined;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
    setError(null);
  }, []);

  // Run a templated prompt → spawns the capability run, keeping the palette open
  // only long enough to surface an error if the send fails.
  const runPrompt = useCallback(
    async (text: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await send({ conversationId: conversationId ?? undefined, text });
        if (res?.conversationId) onConversation(res.conversationId);
        onSetCanvasView("run");
        close();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start that. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [send, conversationId, onConversation, onSetCanvasView, close],
  );

  // ── The full action set, rebuilt as inputs change ────────────────────────
  const commands = useMemo<Command[]>(() => {
    const runBoost = canvasView === "run" ? 6 : 0;
    const brainBoost = canvasView === "brain" ? 10 : 0;

    const create: Command[] = CAPABILITY_COMMANDS.map((c) => {
      const spec = routerSpec(c.intent);
      const prompt = spec?.examples[0] ?? c.label;
      return {
        id: `cap-${c.intent}`,
        kind: "create" as const,
        category: spec?.title ?? "Capability",
        label: c.label,
        hint: prompt,
        shortcut: c.shortcut,
        keywords: `${c.intent} ${spec?.keywords?.join(" ") ?? ""} ${spec?.description ?? ""}`,
        boost: runBoost,
        perform: () => runPrompt(prompt),
      };
    });

    const view: Command[] = [
      {
        id: "view-brain",
        kind: "view",
        category: "Canvas",
        label: "Open the Brain canvas",
        hint: "The compounding knowledge board",
        keywords: "brain knowledge memory recall what we learned",
        boost: brainBoost,
        perform: () => {
          onSetCanvasView("brain");
          close();
        },
      },
      {
        id: "view-run",
        kind: "view",
        category: "Canvas",
        label: "Back to the live Run canvas",
        hint: "The active work surface",
        keywords: "run live work canvas swarm",
        boost: runBoost,
        perform: () => {
          onSetCanvasView("run");
          close();
        },
      },
    ];

    const navigate: Command[] = [
      {
        id: "nav-new",
        kind: "navigate",
        category: "Navigate",
        label: "New conversation",
        hint: "Start a fresh thread",
        keywords: "new chat conversation reset start over",
        perform: () => {
          onConversation(null);
          onSetCanvasView("run");
          close();
        },
      },
      {
        id: "nav-sidebar",
        kind: "navigate",
        category: "Navigate",
        label: sidebarCollapsed ? "Expand the conversation rail" : "Collapse the conversation rail",
        hint: "Toggle the left sidebar",
        keywords: "sidebar rail conversations collapse expand toggle",
        perform: () => {
          onToggleSidebar();
          close();
        },
      },
      {
        id: "nav-theme",
        kind: "navigate",
        category: "Navigate",
        label: theme.theme === "dark" ? "Switch to light theme" : "Switch to night theme",
        hint: "Toggle light / night",
        keywords: "theme dark light night appearance mode toggle",
        perform: () => {
          theme.toggle();
          close();
        },
      },
    ];

    const convo: Command[] = (conversations ?? []).slice(0, 6).map((c) => ({
      id: `conv-${c._id}`,
      kind: "conversation" as const,
      category: "Jump to",
      label: c.title || "Untitled conversation",
      hint: c.lastIntent ? `Last: ${c.lastIntent}` : undefined,
      keywords: `conversation thread ${c.title ?? ""} ${c.lastIntent ?? ""}`,
      boost: c._id === conversationId ? -100 : 0, // never surface the current one first
      perform: () => {
        onConversation(c._id);
        onSetCanvasView("run");
        close();
      },
    }));

    return [...create, ...view, ...navigate, ...convo];
  }, [
    canvasView,
    conversations,
    conversationId,
    sidebarCollapsed,
    theme,
    runPrompt,
    onConversation,
    onSetCanvasView,
    onToggleSidebar,
    close,
  ]);

  // ── Filter + rank ─────────────────────────────────────────────────────────
  const results = useMemo<Command[]>(() => {
    const scored: { cmd: Command; score: number }[] = [];
    for (const cmd of commands) {
      const hay = `${cmd.label} ${cmd.category} ${cmd.hint ?? ""} ${cmd.keywords ?? ""}`;
      const score = fuzzyScore(query, hay);
      if (score === null) continue;
      scored.push({ cmd, score: score + (cmd.boost ?? 0) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [commands, query]);

  // Keep the active row in range + scrolled into view.
  useEffect(() => {
    setActive((a) => Math.max(0, Math.min(a, Math.max(0, results.length - 1))));
  }, [results.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // ── Global ⌘K listener (+ a custom event so chrome can open it too) ─────────
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        close();
      }
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("intercept:open-command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("intercept:open-command-palette", onOpenEvent);
    };
  }, [open, close]);

  // Lock scroll + focus the input while open.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.body.style.overflow = "";
      cancelAnimationFrame(t);
    };
  }, [open]);

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void results[active]?.perform();
    } else if (
      // Empty-query quick-jump: plain digit runs the Nth result (no browser
      // shortcut conflict — we're inside a modal and the query is empty).
      query === "" &&
      /^[1-9]$/.test(e.key) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const idx = Number(e.key) - 1;
      if (results[idx]) {
        e.preventDefault();
        void results[idx].perform();
      }
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim/40 px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={close}
    >
      <div
        className="glass-2 w-full max-w-xl overflow-hidden rounded-lg animate-scale-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* search field — a plain transparent input ON the glass chrome */}
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0 text-ink/50" aria-hidden>
            <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Search actions — find threads, build a list, scan ads…"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink/35 focus:outline-none"
            aria-label="Search commands"
            spellCheck={false}
            autoComplete="off"
          />
          {busy && (
            <span className="h-4 w-4 shrink-0 animate-spin-slow rounded-full border-2 border-ink/20 border-t-ink" />
          )}
          <kbd className="caption hidden h-5 items-center rounded border border-hairline bg-canvas px-1.5 text-ink/50 sm:flex">
            ESC
          </kbd>
        </div>

        {/* results */}
        <div ref={listRef} className="col-scroll max-h-[52vh] overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink/50">
              No actions match “{query}”.
            </p>
          ) : (
            results.map((cmd, idx) => {
              const isActive = idx === active;
              const quickKey = query === "" && idx < 9 ? String(idx + 1) : null;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  data-idx={idx}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => void cmd.perform()}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                    isActive ? "bg-ink/[0.06]" : "hover:bg-ink/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors",
                      isActive
                        ? "border-transparent bg-ink text-canvas"
                        : "border-hairline bg-canvas text-ink/70",
                    )}
                  >
                    <CategoryIcon kind={cmd.kind} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-fig-card text-ink">
                      {cmd.label}
                    </span>
                    {cmd.hint && (
                      <span className="block truncate text-[11.5px] font-fig-body text-ink/55">
                        {cmd.hint}
                      </span>
                    )}
                  </span>
                  <span className="caption hidden shrink-0 text-ink/40 md:block">{cmd.category}</span>
                  {cmd.shortcut ? (
                    <Kbd keys={cmd.shortcut} />
                  ) : quickKey ? (
                    <Kbd keys={[quickKey]} />
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        {/* footer hint bar */}
        <div className="flex items-center justify-between border-t border-hairline px-4 py-2">
          <span className="caption text-ink/45">
            {error ? <span className="text-red-500">{error}</span> : "INTERCEPT command palette"}
          </span>
          <span className="caption hidden items-center gap-2.5 text-ink/45 sm:flex">
            <span className="flex items-center gap-1">
              <Kbd keys={["↑", "↓"]} /> navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd keys={["↵"]} /> run
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
