"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { Intent } from "@/lib/contract";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import { deleteConversationRef, listConversationsRef } from "./chatApi";
import type { ConversationDoc } from "./types";
import { Blip, useBlipGaze } from "./blip/Blip";
import { useBlipReactions } from "./blip/useBlipReactions";
import { useBlipIntel } from "./blip/useBlipIntel";
import ThemeToggle from "./ThemeToggle";

// ============================================================================
// CommandSidebar — ONE clean ~256px column that replaces the old double rail
// (IconRail + ConversationSidebar). Light Figma editorial: white-ish glass
// ground, ink text, a pastel color-block per track, pill affordances, Inter +
// JetBrains-Mono labels.
//
// Layout, top → bottom:
//   • BRAND      — INTERCEPT wordmark.
//   • BLIP       — the reactive, centered mascot (SidebarBlip) — alive off the
//                  live swarm (mood + gaze + the "learned N" brain glow).
//   • NAV        — Home, the 7 canonical tracks (→ onSelectTrack(intent): show
//                  the track's latest run or start one), and the brain
//                  (→ onOpenBrain). ONE label each, canonical everywhere.
//   • RECENT     — past conversations (select / delete) + New chat.
//   • FOOTER     — a persistent ⌘K affordance + theme toggle.
//
// Standalone-compilable: reads conversations + the focused run via existing
// refs/`api`; never imports another new dashboard file. activeTrack/brainActive/
// surface drive the single highlighted nav item.
// ============================================================================

// ── canonical track registry (ONE label each) ──────────────────────────────
// Local + read-only so this file compiles before lib/contract's DASHBOARD_TRACKS
// lands; full bg-block-* literals (no interpolation) so Tailwind's JIT emits them.
interface TrackNav {
  key: Capability7;
  label: string;
  tagline: string;
  accent: string;
  icon: (props: { className?: string }) => ReactElement;
}

type Capability7 =
  | "discovery"
  | "outbound"
  | "competitor"
  | "content"
  | "social"
  | "onboarding"
  | "scout";

const TRACKS: readonly TrackNav[] = [
  { key: "discovery", label: "Reading Minds", tagline: "Intent radar", accent: "bg-block-mint", icon: MindIcon },
  { key: "outbound", label: "Revenue on Autopilot", tagline: "Outbound swarm", accent: "bg-block-lime", icon: RevenueIcon },
  { key: "competitor", label: "Ad Intelligence", tagline: "Scan their ads", accent: "bg-block-coral", icon: ScanIcon },
  { key: "content", label: "Ad Factory", tagline: "Make the ad", accent: "bg-block-pink", icon: FactoryIcon },
  { key: "social", label: "Algorithm Hacking", tagline: "Go viral", accent: "bg-block-lilac", icon: ViralIcon },
  { key: "onboarding", label: "Zero to One", tagline: "PLG onboarding", accent: "bg-block-cream", icon: LaunchIcon },
  { key: "scout", label: "GitHub Scout", tagline: "Dissect projects", accent: "bg-block-navy", icon: ScoutIcon },
] as const;

interface CommandSidebarProps {
  /** Which top-level surface the page is showing. Home highlights on "dashboard". */
  surface: "dashboard" | "workspace";
  /** Return to the dashboard landing. */
  onHome: () => void;
  /** The currently open conversation (highlighted in Recent), if any. */
  activeId: Id<"conversations"> | null;
  /** Open a past conversation. */
  onSelectConversation: (id: Id<"conversations">) => void;
  /** Start a fresh chat. */
  onNewChat: () => void;
  /**
   * Navigate to a track: SHOW its latest existing run if there is one, else
   * start a fresh one. Either way it flips the page into the workspace. (The
   * page resolves "show vs. start" so the sidebar stays presentational.)
   */
  onSelectTrack: (intent: Intent) => void;
  /** The track whose board is in focus, so its nav row reads active. */
  activeTrack?: Intent | null;
  /** Whether the canvas is showing the brain lens. */
  brainActive?: boolean;
  /** Open the compounding-knowledge brain board. */
  onOpenBrain: () => void;
  /** Whether the canvas is showing the hackathon-radar lens. */
  radarActive?: boolean;
  /** Open the global hackathon radar (us-vs-the-field) surface. */
  onOpenRadar: () => void;
  /** The run powering Blip's live ping; pulses while it is running. */
  focusedRunId?: Id<"runs"> | null;
  /** Collapsed → a thin icon rail; expanded → the full column. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Optional: open the ⌘K command palette from the footer affordance. */
  onOpenPalette?: () => void;
}

// ── RECENT declutter — dedupe near-duplicate titles, keep it to a handful ───
const RECENT_LIMIT = 5;

function dedupeRecent(
  list: ConversationDoc[] | undefined,
): ConversationDoc[] {
  if (!list) return [];
  const seen = new Set<string>();
  const out: ConversationDoc[] = [];
  for (const c of list) {
    const key = (c.title || "Untitled").trim().toLowerCase();
    if (seen.has(key)) continue; // drop a near-duplicate title
    seen.add(key);
    out.push(c);
    if (out.length >= RECENT_LIMIT) break;
  }
  return out;
}

export default function CommandSidebar({
  surface,
  onHome,
  activeId,
  onSelectConversation,
  onNewChat,
  onSelectTrack,
  activeTrack = null,
  brainActive = false,
  onOpenBrain,
  radarActive = false,
  onOpenRadar,
  focusedRunId = null,
  collapsed,
  onToggleCollapsed,
  onOpenPalette,
}: CommandSidebarProps) {
  const conversations = useQuery(listConversationsRef, {}) as
    | ConversationDoc[]
    | undefined;
  const deleteConversation = useMutation(deleteConversationRef);

  // PERF: the conversations subscription can return up to 50 rows; render only a
  // deduped handful (RECENT_LIMIT) and memoize the derivation so unrelated
  // re-renders (focused-run pings, Blip reactions, hover state) don't rebuild the
  // whole list — the sidebar felt sluggish when it mapped all 50 every render.
  const recent = useMemo(() => dedupeRecent(conversations), [conversations]);

  // The Recent scroll region — wired to the up/down chevron affordances so the
  // founder can see (and drive) that the list scrolls.
  const recentScrollRef = useRef<HTMLDivElement>(null);

  // Selecting a past conversation must do TWO things: switch the page to that
  // conversation (onSelectConversation → page sets conversationId + workspace)
  // AND reveal its transcript, because the rehydrated message history renders in
  // the page's "Run transcript" drawer — which is closed by default. The page
  // owns that drawer, so we signal it over the same intercept:* CustomEvent bus
  // the rest of the app uses (intercept:compose, intercept:open-command-palette).
  // Without this, a selected conversation lands on the canvas with its history
  // hidden, which reads as "the history is empty".
  // REPORT (cross-file): app/page.tsx must open the drawer on this signal — add
  //   useEffect(() => { const h = () => setHistoryOpen(true);
  //     window.addEventListener("intercept:open-transcript", h);
  //     return () => window.removeEventListener("intercept:open-transcript", h);
  //   }, []);
  // (Equivalently: add `setHistoryOpen(true)` inside `selectConversation`.)
  const handleSelectConversation = (id: Id<"conversations">) => {
    onSelectConversation(id);
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new CustomEvent("intercept:open-transcript"));
      } catch {
        /* selection still works even if the signal can't be dispatched */
      }
    }
  };

  const onDelete = async (e: React.MouseEvent, id: Id<"conversations">) => {
    e.stopPropagation();
    try {
      await deleteConversation({ conversationId: id });
    } catch {
      /* backend not ready — ignore */
    }
  };

  // ── collapsed: a thin icons-only rail. NO sidebar Blip here — when collapsed
  // the bottom-right BlipCompanion takes over (coordinated from page.tsx), so
  // exactly one Blip is ever visible. Icons: expand · home · tracks · brain ·
  // new · ⌘K · theme. ──────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <div
        data-intercept-surface={surface}
        className="glass-1 flex h-full w-14 flex-col items-center gap-2 py-3"
      >
        <button
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          className="flex h-9 w-9 items-center justify-center rounded-xl text-ink/60 transition-colors hover:bg-canvas hover:text-ink"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onHome}
          aria-label="Home"
          aria-current={surface === "dashboard" ? "page" : undefined}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
            surface === "dashboard" ? "bg-canvas text-ink" : "text-ink/55 hover:bg-canvas/60 hover:text-ink",
          )}
        >
          <HomeIcon className="h-[18px] w-[18px]" />
        </button>
        <div className="my-1 h-px w-6 bg-hairline" />
        {TRACKS.map((t) => {
          const Icon = t.icon;
          const active = surface === "workspace" && activeTrack === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onSelectTrack(t.key)}
              aria-label={t.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                active ? "text-ink" : "text-ink/55 hover:bg-canvas/60 hover:text-ink",
              )}
            >
              <span
                aria-hidden
                className={cn("absolute inset-0 rounded-xl transition-opacity", t.accent, active ? "opacity-30" : "opacity-0")}
              />
              <Icon className="relative h-[18px] w-[18px]" />
            </button>
          );
        })}
        <button
          onClick={onOpenBrain}
          aria-label="The brain"
          aria-current={brainActive ? "page" : undefined}
          className={cn(
            "relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
            brainActive ? "text-ink" : "text-ink/55 hover:bg-canvas/60 hover:text-ink",
          )}
        >
          <span aria-hidden className={cn("absolute inset-0 rounded-xl bg-block-lilac transition-opacity", brainActive ? "opacity-30" : "opacity-0")} />
          <BrainIcon className="relative h-[18px] w-[18px]" />
        </button>
        <button
          onClick={onOpenRadar}
          aria-label="Hackathon Radar"
          aria-current={radarActive ? "page" : undefined}
          className={cn(
            "relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
            radarActive ? "text-ink" : "text-ink/55 hover:bg-canvas/60 hover:text-ink",
          )}
        >
          <span aria-hidden className={cn("absolute inset-0 rounded-xl bg-block-coral transition-opacity", radarActive ? "opacity-30" : "opacity-0")} />
          <RadarIcon className="relative h-[18px] w-[18px]" />
        </button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            onClick={onNewChat}
            aria-label="New chat"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-canvas text-ink transition-transform hover:scale-105"
          >
            <PlusIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => onOpenPalette?.()}
            aria-label="Command palette (⌘K)"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-ink/55 transition-colors hover:bg-canvas hover:text-ink"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="m20 20-3.6-3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
          <ThemeToggle />
        </div>
      </div>
    );
  }

  // ── expanded: the full single column ──────────────────────────────────────
  return (
    <div
      data-intercept-surface={surface}
      className="glass-1 flex h-full w-64 flex-col"
    >
      {/* brand + collapse */}
      <div className="flex items-center justify-between px-3.5 pt-3.5 pb-2">
        <button onClick={onHome} className="flex items-center gap-2" aria-label="INTERCEPT home">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-canvas text-ink">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-4.6-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[16px] font-fig-card tracking-tight text-ink">INTERCEPT</span>
        </button>
        <button
          onClick={onToggleCollapsed}
          aria-label="Collapse sidebar"
          className="flex h-7 w-7 items-center justify-center rounded-full text-ink transition-colors hover:bg-canvas"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* BLIP — centered, bigger, and ALIVE (the same reactive sprite/behavior as
          the corner companion: live swarm mood + gaze + the "learned N" glow).
          Only mounted when EXPANDED, so its hooks/queries don't run collapsed. */}
      <SidebarBlip focusedRunId={focusedRunId} conversationId={activeId} surface={surface} />

      {/* NAV — Home, the 7 tracks, the brain */}
      <nav aria-label="Tracks" className="px-2 pt-1">
        <NavRow
          label="Home"
          sublabel="Command center"
          active={surface === "dashboard"}
          accent="bg-ink/10"
          icon={<HomeIcon className="h-4 w-4" />}
          onClick={onHome}
        />
        <div className="my-1.5 px-2">
          <span className="caption font-mono uppercase tracking-wider text-ink/45">Tracks</span>
        </div>
        {TRACKS.map((t) => {
          const Icon = t.icon;
          return (
            <NavRow
              key={t.key}
              label={t.label}
              sublabel={t.tagline}
              active={surface === "workspace" && activeTrack === t.key}
              accent={t.accent}
              icon={<Icon className="h-4 w-4" />}
              onClick={() => onSelectTrack(t.key)}
            />
          );
        })}
        <NavRow
          label="The brain"
          sublabel="Compounding knowledge"
          active={brainActive}
          accent="bg-block-lilac"
          icon={<BrainIcon className="h-4 w-4" />}
          onClick={onOpenBrain}
        />
        <NavRow
          label="Hackathon Radar"
          sublabel="Us vs. the field"
          active={radarActive}
          accent="bg-block-coral"
          icon={<RadarIcon className="h-4 w-4" />}
          onClick={onOpenRadar}
        />
        {/* WIN-BACK — opens the global modal (mounted once in app/page.tsx). It
            self-resolves the target from the persisted settings when the detail
            URL is empty, so NO prop threading is needed here. Guarded dispatch. */}
        <NavRow
          label="Win-Back"
          sublabel="Revive dead deals"
          active={false}
          accent="bg-block-coral"
          icon={<WinBackIcon className="h-4 w-4" />}
          onClick={() => {
            if (typeof window === "undefined") return;
            try {
              window.dispatchEvent(
                new CustomEvent("intercept:open-winback", {
                  detail: { targetUrl: "" },
                }),
              );
            } catch {
              /* never break the nav on a dispatch failure */
            }
          }}
        />
        {/* ── Radar-borrowed edge features — rebuilt natively from the field.
            Each opens a global modal (mounted once in app/page.tsx) and
            self-resolves the target from settings, so no prop threading. ── */}
        <NavRow
          label="AI Pick Rate"
          sublabel="Does AI recommend you"
          active={false}
          accent="bg-block-mint"
          icon={
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
              <path d="m8.5 12 2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
          onClick={() => {
            if (typeof window === "undefined") return;
            try {
              window.dispatchEvent(new CustomEvent("intercept:open-pickrate", { detail: { targetUrl: "" } }));
            } catch {
              /* never break the nav */
            }
          }}
        />
        <NavRow
          label="GTM Workflows"
          sublabel="Production-ready, monitored"
          active={false}
          accent="bg-block-lime"
          icon={
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="18" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="6" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 7l8 4M8 17l8-4" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          }
          onClick={() => {
            if (typeof window === "undefined") return;
            try {
              window.dispatchEvent(new CustomEvent("intercept:open-workflows", { detail: { targetUrl: "" } }));
            } catch {
              /* never break the nav */
            }
          }}
        />
        <NavRow
          label="Pre-Flight"
          sublabel="Predict before you send"
          active={false}
          accent="bg-block-pink"
          icon={
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          }
          onClick={() => {
            if (typeof window === "undefined") return;
            try {
              window.dispatchEvent(new CustomEvent("intercept:open-preflight", { detail: { targetUrl: "" } }));
            } catch {
              /* never break the nav */
            }
          }}
        />
      </nav>

      {/* RECENT conversations */}
      <div className="mt-3 flex items-center justify-between px-3.5 pb-1">
        <span className="caption font-mono uppercase tracking-wider text-ink/45">Recent</span>
        <button
          onClick={onNewChat}
          className="flex items-center gap-1 rounded-pill border border-hairline bg-canvas px-2 py-0.5 text-[11px] font-fig-link text-ink transition-colors hover:bg-surface-soft"
        >
          <PlusIcon className="h-3 w-3" />
          New
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={recentScrollRef}
          className="col-scroll h-full overflow-y-auto px-2 pb-2"
        >
        {conversations === undefined ? (
          <div className="space-y-1.5 px-1 py-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 animate-pulse rounded-md bg-surface-soft" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p className="px-2 py-5 text-center text-[11.5px] leading-relaxed text-ink/60">
            No conversations yet. Fire a track or start a chat.
          </p>
        ) : (
          <ul className="space-y-px">
            {recent.map((c) => {
              const active = c._id === activeId && surface === "workspace";
              return (
                <li key={c._id}>
                  <button
                    onClick={() => handleSelectConversation(c._id)}
                    className={cn(
                      "group flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left transition-colors",
                      active ? "bg-canvas" : "hover:bg-canvas",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[12.5px] leading-tight text-ink", active && "font-fig-headline")}>
                        {c.title || "Untitled"}
                      </span>
                      <span className="caption text-ink/55">{relativeTime(c.lastMessageAt)}</span>
                    </span>
                    <span
                      onClick={(e) => onDelete(e, c._id)}
                      role="button"
                      tabIndex={-1}
                      aria-label="Delete conversation"
                      className="shrink-0 rounded p-1 text-transparent transition-colors group-hover:text-ink/40 hover:!text-red-500"
                    >
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        </div>
        <ScrollChevrons scrollRef={recentScrollRef} />
      </div>

      {/* FOOTER — persistent ⌘K affordance + theme */}
      <div className="flex items-center justify-between border-t border-hairline px-3 py-2.5">
        <button
          onClick={() => onOpenPalette?.()}
          className="group flex items-center gap-2 rounded-pill border border-hairline bg-canvas px-2.5 py-1 text-[11.5px] text-ink transition-colors hover:bg-surface-soft"
          aria-label="Open command palette"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-ink/60">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
            <path d="m20 20-3.6-3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <span className="font-fig-link">Command</span>
          <kbd className="rounded bg-surface-soft px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink/70">⌘K</kbd>
        </button>
        <ThemeToggle />
      </div>
    </div>
  );
}

// ── one nav row (icon + accent chip + label + sublabel) ─────────────────────
function NavRow({
  label,
  sublabel,
  active,
  accent,
  icon,
  onClick,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  accent: string;
  icon: ReactElement;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        active ? "bg-canvas" : "hover:bg-canvas",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink transition-opacity",
          accent,
          active ? "opacity-100" : "opacity-70 group-hover:opacity-100",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12.5px] text-ink", active ? "font-fig-headline" : "font-fig-link")}>
          {label}
        </span>
        <span className="caption block truncate text-ink/50">{sublabel}</span>
      </span>
    </button>
  );
}

// ── ScrollChevrons — tiny up/down affordances overlaid on a scroll region so it
// reads as scrollable. Pure + presentational: each chevron fades in only when
// there is overflow in that direction, and nudges the region ~80% of a page on
// click. Lives over a `relative` wrapper; needs only the scroll element's ref. ──
function ScrollChevrons({
  scrollRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [edges, setEdges] = useState({ up: false, down: false });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setEdges({
        up: scrollTop > 4,
        down: scrollTop + clientHeight < scrollHeight - 4,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollRef]);

  const nudge = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({
      top: dir * Math.max(el.clientHeight * 0.8, 96),
      behavior: "smooth",
    });
  };

  return (
    <div aria-hidden={!edges.up && !edges.down} className="pointer-events-none">
      <button
        type="button"
        onClick={() => nudge(-1)}
        aria-label="Scroll up"
        tabIndex={edges.up ? 0 : -1}
        className={cn(
          "absolute left-1/2 top-1 z-10 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-hairline bg-canvas/90 text-ink/70 shadow-sm backdrop-blur transition-opacity hover:text-ink",
          edges.up ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
          <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => nudge(1)}
        aria-label="Scroll down"
        tabIndex={edges.down ? 0 : -1}
        className={cn(
          "absolute bottom-1 left-1/2 z-10 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-hairline bg-canvas/90 text-ink/70 shadow-sm backdrop-blur transition-opacity hover:text-ink",
          edges.down ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

// ── SidebarBlip — the centered, bigger, ALIVE mascot. It reuses the EXACT same
// reactive layers as the corner BlipCompanion (useBlipReactions for live swarm
// mood + ambient one-liners, useBlipGaze for cursor tracking, useBlipIntel for
// the compounding-brain glow + the "learned N" badge). Decorative; no input. ───
const SIDEBAR_STATUS: Record<
  string,
  { label: string; dot: string; pulse: boolean }
> = {
  thinking: { label: "Swarm working", dot: "bg-accent-magenta", pulse: true },
  talking: { label: "Thinking out loud", dot: "bg-accent-magenta", pulse: true },
  celebrate: { label: "Nice — a win", dot: "bg-success", pulse: false },
  happy: { label: "Nice — a win", dot: "bg-success", pulse: false },
  concerned: { label: "Hmm, that stalled", dot: "bg-ink/40", pulse: false },
  idle: { label: "Idle · listening", dot: "bg-ink/25", pulse: false },
};

function SidebarBlip({
  focusedRunId,
  conversationId,
  surface,
}: {
  focusedRunId: Id<"runs"> | null;
  conversationId: Id<"conversations"> | null;
  surface: "dashboard" | "workspace";
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gaze = useBlipGaze(wrapRef);
  // Map the page surface → Blip's suggestion bucket so the hint matches the view:
  // the landing reads as "dashboard"; any workspace/board reads as "board".
  const { state, speech, dismissSpeech, busy } = useBlipReactions({
    runId: focusedRunId,
    conversationId,
    surface: surface === "dashboard" ? "dashboard" : "board",
  });
  const { brain } = useBlipIntel({ runId: focusedRunId, conversationId });

  const meta =
    SIDEBAR_STATUS[state] ??
    (busy ? SIDEBAR_STATUS.thinking : SIDEBAR_STATUS.idle);

  // Only surface a status when Blip is ACTIVELY doing something — never the
  // ambient "idle · listening" label (it read as clutter).
  const showStatus = meta !== SIDEBAR_STATUS.idle;

  return (
    <div className="relative mx-3 mb-1 mt-0.5 flex flex-col items-center gap-2 rounded-2xl border border-hairline bg-canvas/70 px-3 py-4">
      <div ref={wrapRef} className="relative">
        <Blip state={state} size={72} gaze={gaze} glow={brain.glow} />
        {brain.learnedDelta > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full border border-hairline bg-accent-magenta px-1.5 py-0.5 text-[9px] font-semibold leading-none text-white shadow-sm">
            +{brain.learnedDelta}
          </span>
        )}
      </div>
      {/* Fixed-height message slot — sits exactly where the status used to, INSIDE
          the card. The bubble renders HERE so it never grows the card (no menu
          shift) and never spills out below onto the nav. */}
      <div className="flex h-[48px] w-full items-center justify-center">
        {speech ? (
          <button
            type="button"
            onClick={dismissSpeech}
            className="max-h-[48px] max-w-[200px] overflow-hidden rounded-xl border border-hairline bg-canvas px-2.5 py-1 text-center text-[11px] leading-tight text-ink shadow-sm transition-opacity hover:opacity-80"
          >
            {speech}
          </button>
        ) : showStatus ? (
          <span className="caption flex items-center gap-1.5 text-ink">
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot, meta.pulse && "animate-blink")} />
            <span className="truncate">{meta.label}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── glyphs (stroke icons, currentColor) ─────────────────────────────────────
function HomeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4 11.5 12 5l8 6.5M6 10v8.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function MindIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 4c3.3 0 6 2.4 6 5.6 0 1.8-.9 3.2-2.2 4.2V18l-2.4-1.2a7 7 0 0 1-1.4.1C8.7 16.9 6 14.5 6 11.3 6 7.9 8.7 4 12 4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9.5 10.5h5M9.5 13h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function RevenueIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4 16.5 9 11l3.5 3L20 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 6h5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ScanIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="m20 20-3.5-3.5M11 8v6M8 11h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function FactoryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4 19.5V11l5 3V11l5 3V8l6 4v7.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
function ViralIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.6 2.6M14.9 14.9l2.6 2.6M17.5 6.5l-2.6 2.6M9.1 14.9l-2.6 2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function LaunchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 3c3 1.5 5 4.6 5 8.6 0 1.5-.4 2.7-1 3.7l-4 .1-4-.1c-.6-1-1-2.2-1-3.7C7 7.6 9 4.5 12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.5 16.5 8 20m6.5-3.5L16 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function ScoutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M9 19c-3.5 1-3.5-1.8-5-2.3m10 4.3v-3.1a2.6 2.6 0 0 0-.7-2c2.4-.3 5-1.2 5-5.4a4.2 4.2 0 0 0-1.2-2.9 3.9 3.9 0 0 0-.1-2.9s-1-.3-3.2 1.2a11 11 0 0 0-5.6 0C5.8 3.7 4.8 4 4.8 4a3.9 3.9 0 0 0-.1 2.9A4.2 4.2 0 0 0 3.5 9.8c0 4.2 2.6 5.1 5 5.4a2.6 2.6 0 0 0-.7 2V21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function BrainIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M9 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1 4.8A2.5 2.5 0 0 0 7 16.5a2.5 2.5 0 0 0 5 .5V6.5A2.5 2.5 0 0 0 9 4.5ZM15 4.5A2.5 2.5 0 0 1 17.5 7a2.5 2.5 0 0 1 1 4.8A2.5 2.5 0 0 1 17 16.5a2.5 2.5 0 0 1-5 .5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function RadarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 12 18.5 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 4a8 8 0 1 0 8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 8a4 4 0 1 0 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}
function WinBackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 4v4h-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
