"use client";

/**
 * useMascotIntel — the COMPANION-INTELLIGENCE layer that deepens Acey from a
 * reactive sprite into a proactive, gets-smarter, win-bringing buddy. It sits
 * BESIDE useMascotReactions (which owns mood + ambient one-liners) and adds the
 * three "smart" signals the corner companion surfaces:
 *
 *   1. PROACTIVE WINS — subscribes to api.conversations.recentProactive (the 24/7
 *      cron's overnight `proactive` messages) and surfaces the newest unseen one
 *      as a clickable win ("found 3 hot leads overnight 👀") that focuses its run.
 *   2. GETS SMARTER  — subscribes to api.knowledge.brainStats (factCount) and
 *      reports a "learned N" delta + an antenna `glow` (0–1) that brightens as the
 *      compounding wiki grows. Clicking the badge opens the Brain canvas.
 *   3. GLANCEABLE STATUS — folds the focused run (company / found counts) + brain
 *      facts into a tiny status object for the click-to-open popover, plus a
 *      single NEXT-ACTION nudge ("draft outreach to Acme?") that triggers a real
 *      run via the existing createRun helper (NOT a chat input).
 *
 * GRACEFUL BY CONTRACT: every subscription is "skip"-able and every field is
 * optional — a missing query, an empty brain, or a fresh deployment simply yields
 * `null`/zeros and therefore NO bubble, NO badge, NO nudge. Nothing here can throw
 * or block a run. All state is immutable (new objects, refs for snapshots).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// ---- tunables -------------------------------------------------------------
/** Don't surface overnight wins older than this (ms) — keep it fresh. */
const PROACTIVE_FRESH_MS = 36 * 60 * 60 * 1000; // 36h
/** Antenna reaches full brightness around this many learned facts. */
const GLOW_FULL_FACTS = 160;
/** localStorage key prefix for "already showed this proactive win" (dedupe across reloads). */
const SEEN_KEY = "intercept.acey.seenProactive";

// ---- public shapes --------------------------------------------------------
export interface ProactiveWin {
  /** The proactive message id (also the dedupe key). */
  id: string;
  conversationId: Id<"conversations">;
  /** The run to focus when the bubble is clicked (may be null). */
  runId: Id<"runs"> | null;
  /** A short, fun bubble line distilled from the cron's message. */
  line: string;
  createdAt: number;
}

export interface MascotBrain {
  facts: number;
  pages: number;
  lastUpdatedAt: number;
  /** Facts learned since this mount (drives the "learned N" micro-badge). */
  learnedDelta: number;
  /** 0–1 antenna brightness from the wiki's size (steady "it's getting smarter"). */
  glow: number;
}

export interface MascotStatus {
  /** The company/subject the focused run is working on, if any. */
  company: string | null;
  /** Leads found on the focused run (qualified → sourced fallback), if any. */
  found: number | null;
  /** Total durable facts the brain knows. */
  facts: number;
  /** True while at least one run is running. */
  running: boolean;
  runId: Id<"runs"> | null;
  conversationId: Id<"conversations"> | null;
}

/** A single, real next-action the popover/bubble can trigger via createRun. */
export interface NextAction {
  /** Human label, e.g. "draft outreach to Acme?". */
  label: string;
  /** createRun args (a subset — the component fills trigger/inputType defaults). */
  intent:
    | "analyze"
    | "discovery"
    | "outbound"
    | "outreach"
    | "content"
    | "competitor"
    | "replicate"
    | "social"
    | "onboarding";
  input: string;
  inputType: "url" | "name" | "competitor" | "community" | "text";
  conversationId: Id<"conversations"> | null;
}

export interface MascotIntel {
  /** The newest unseen overnight win, or null. */
  proactiveWin: ProactiveWin | null;
  /** Dismiss the current proactive win (and remember it so it won't nag on reload). */
  dismissProactive: () => void;
  /** Brain growth signals (always present; zeros for an empty brain). */
  brain: MascotBrain;
  /** Glanceable status for the click-to-open popover. */
  status: MascotStatus;
  /** ONE next-action suggestion after a win, or null. */
  nextAction: NextAction | null;
}

interface UseMascotIntelOptions {
  runId?: Id<"runs"> | null;
  conversationId?: Id<"conversations"> | null;
  enabled?: boolean;
}

// Minimal local row shapes (the real queries return supersets of these).
interface ProactiveRow {
  _id: string;
  conversationId: Id<"conversations">;
  runId: Id<"runs"> | null;
  intent: string | null;
  content: string;
  createdAt: number;
}
interface BrainStats {
  pages: number;
  facts: number;
  runs: number;
  lastUpdatedAt: number;
}
interface RunRow {
  _id: string;
  status: string;
}
interface RunDoc {
  _id: Id<"runs">;
  conversationId?: Id<"conversations">;
  intent: string;
  status: string;
  company?: string;
  input: string;
  sourcedCount?: number;
  qualifiedCount?: number;
  contactedCount?: number;
}

export function useMascotIntel(options: UseMascotIntelOptions = {}): MascotIntel {
  const { runId = null, conversationId = null, enabled = true } = options;

  // ----- live subscriptions (all "skip"-able; missing → graceful null) -----
  const proactive = useQuery(
    api.conversations.recentProactive,
    enabled ? { limit: 5 } : "skip",
  ) as ProactiveRow[] | undefined;
  const stats = useQuery(
    api.knowledge.brainStats,
    enabled ? {} : "skip",
  ) as BrainStats | undefined;
  const runs = useQuery(api.runs.listRuns, enabled ? {} : "skip") as
    | RunRow[]
    | undefined;
  const focusedRun = useQuery(
    api.runs.getRun,
    enabled && runId ? { runId } : "skip",
  ) as RunDoc | null | undefined;

  // ===== 1. PROACTIVE WINS =================================================
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  // The newest proactive row that is fresh and not yet seen (this session OR a
  // prior reload). Priming on first load is intentional here: an overnight win is
  // exactly what we WANT to greet the user with — but only once per message id.
  const proactiveWin = useMemo<ProactiveWin | null>(() => {
    if (!proactive || proactive.length === 0) return null;
    const newest = proactive[0];
    if (!newest) return null;
    if (newest._id === dismissedId) return null;
    if (Date.now() - newest.createdAt > PROACTIVE_FRESH_MS) return null;
    if (hasSeenProactive(newest._id)) return null;
    return {
      id: newest._id,
      conversationId: newest.conversationId,
      runId: newest.runId,
      line: distillProactiveLine(newest.content),
      createdAt: newest.createdAt,
    };
  }, [proactive, dismissedId]);

  const dismissProactive = useCallback(() => {
    const id = proactiveWin?.id;
    if (!id) return;
    rememberSeenProactive(id);
    setDismissedId(id);
  }, [proactiveWin?.id]);

  // ===== 2. GETS SMARTER ===================================================
  // Baseline the fact count once (first non-undefined stats) so "learned N" is a
  // since-you-arrived delta, not the absolute total.
  const baselineFacts = useRef<number | null>(null);
  const facts = stats?.facts ?? 0;
  useEffect(() => {
    if (stats && baselineFacts.current === null) {
      baselineFacts.current = stats.facts;
    }
  }, [stats]);
  const learnedDelta =
    baselineFacts.current === null ? 0 : Math.max(0, facts - baselineFacts.current);
  const glow = Math.max(0, Math.min(1, facts / GLOW_FULL_FACTS));

  const brain: MascotBrain = useMemo(
    () => ({
      facts,
      pages: stats?.pages ?? 0,
      lastUpdatedAt: stats?.lastUpdatedAt ?? 0,
      learnedDelta,
      glow,
    }),
    [facts, stats?.pages, stats?.lastUpdatedAt, learnedDelta, glow],
  );

  // ===== 3. GLANCEABLE STATUS + NEXT-ACTION ===============================
  const running = !!runs && runs.some((r) => r.status === "running");
  const status: MascotStatus = useMemo(() => {
    const company =
      focusedRun?.company || (focusedRun ? focusedRun.input : null) || null;
    const found =
      focusedRun?.qualifiedCount ?? focusedRun?.sourcedCount ?? null;
    return {
      company,
      found,
      facts,
      running,
      runId: runId,
      conversationId,
    };
  }, [focusedRun, facts, running, runId, conversationId]);

  // ONE next-action, derived from the focused run once it has settled with a
  // company + something found. Defensive: no run / still running / nothing found
  // → null (no nudge).
  const nextAction = useMemo<NextAction | null>(
    () => deriveNextAction(focusedRun, conversationId),
    [focusedRun, conversationId],
  );

  return { proactiveWin, dismissProactive, brain, status, nextAction };
}

// ---------------------------------------------------------------------------
// Pure helpers (no React, no I/O) — exported-free, kept local to this module.
// ---------------------------------------------------------------------------

/** Turn the cron's (possibly long) proactive message into a short, fun bubble line. */
function distillProactiveLine(content: string): string {
  const clean = content.trim().replace(/\s+/g, " ");
  if (!clean) return "I found something overnight 👀";
  // Prefer a leading count if the cron mentioned one ("found 3 …").
  const m = clean.match(/\b(\d{1,3})\b/);
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const head = firstSentence.length > 88 ? `${firstSentence.slice(0, 85)}…` : firstSentence;
  if (m && !/👀|🌙|✨|🎉|🔥/.test(head)) return `${head} 👀`;
  return head;
}

/** Derive a single, real next-action from a settled focused run. */
function deriveNextAction(
  run: RunDoc | null | undefined,
  conversationId: Id<"conversations"> | null,
): NextAction | null {
  if (!run) return null;
  if (run.status === "running") return null;
  const company = run.company || run.input;
  if (!company) return null;
  const found = run.qualifiedCount ?? run.sourcedCount ?? 0;

  // Discovery / analyze with leads → draft outreach.
  if ((run.intent === "discovery" || run.intent === "analyze") && found > 0) {
    return {
      label: `draft outreach to ${shorten(company)}?`,
      intent: "outbound",
      input: company,
      inputType: "name",
      conversationId,
    };
  }
  // Outbound with drafts ready → send/follow-up.
  if (run.intent === "outbound" && (run.contactedCount ?? 0) === 0 && found > 0) {
    return {
      label: `send the ${found} draft${found === 1 ? "" : "s"}?`,
      intent: "outreach",
      input: company,
      inputType: "name",
      conversationId,
    };
  }
  // A scanned competitor → spin a similar ad.
  if (run.intent === "competitor") {
    return {
      label: `make a winning ad for ${shorten(company)}?`,
      intent: "content",
      input: company,
      inputType: "competitor",
      conversationId,
    };
  }
  return null;
}

function shorten(s: string): string {
  const t = s.trim();
  return t.length > 24 ? `${t.slice(0, 22)}…` : t;
}

// ---- localStorage dedupe (best-effort; never throws) ----------------------
function hasSeenProactive(id: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return false;
    return (JSON.parse(raw) as string[]).includes(id);
  } catch {
    return false;
  }
}

function rememberSeenProactive(id: string): void {
  try {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(SEEN_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    if (list.includes(id)) return;
    const next = [...list, id].slice(-50); // bound
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    // ignore — dedupe is a nicety, not a requirement.
  }
}
