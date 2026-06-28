"use client";

/**
 * useBlipReactions — maps INTERCEPT's LIVE Convex state onto the blip's mood
 * and a fun, ambient one-liner speech bubble. The blip is pure delight that
 * reacts to the swarm working beside you; it NEVER takes input.
 *
 * Reaction model (priority high → low):
 *   1. a one-shot beat is active (celebrate / concerned / peek / nod)  → show it
 *   2. any run is currently "running"                                  → thinking
 *   3. otherwise                                                       → idle
 *
 * What fires a one-shot:
 *   celebrate (a WIN, one-shot → back to idle):
 *     • a run flips running → complete | partial           (api.runs.listRuns)
 *     • an email flips → "replied"                          (api.emails.byRun)
 *     • a hot lead: a thread with intentScore ≥ 80 appears  (api.brief.getThreads)
 *     • a post scores high: viralityScore ≥ 80 appears      (api.agents.composer.postsForRun)
 *     • an ad is generated: a new adCreative appears        (api.agents.adsmith.creativesForRun)
 *   concerned (soft worry, one-shot):
 *     • a run flips → "failed"                              (api.runs.listRuns)
 *   peek / nod (tiny ambient beats off the event feed, if a conversationId is given):
 *     • "found" / "sourced" / "qualified" → peek + a one-liner ("found a hot lead 👀")
 *     • "sent"                            → nod  + a one-liner ("sending…")
 *
 * GLOBAL by default: with NO ids it subscribes only to `api.runs.listRuns`
 * (the all-deployment run feed) — enough for thinking / celebrate / concerned.
 * Pass the focused `runId` and/or `conversationId` for the richer per-run wins
 * and the event-feed one-liners.
 *
 * ALIVE TO THE WHOLE PAGE (not just the swarm): this hook also adds two layers so
 * Blip reacts to EVERY interaction across the app, like the original mascot —
 * minus the heavy whole-body locomotion:
 *   • GLOBAL INTERACTION REACTIVITY — a throttled, SILENT micro-beat (a quick
 *     nod on a click, a peek on a keypress / scroll) acknowledges activity
 *     anywhere on the page. Shared single throttle so it never chatters; sits
 *     BELOW the swarm one-shots so a real win/worry is never stomped by a click.
 *   • SPEAKS CONTEXTUALLY — listens for `window` event "intercept:blip-say"
 *     ({ detail: { text, mood? } }) and shows that line in the speech bubble (the
 *     dashboard's 24/7 toggle dispatches this). Plus ambient one-liners on key
 *     moments: a play fired ("on it 🚀"), a run completed, the brain learned N.
 *
 * Defensive: every query is real (verified against the repo) but each detector
 * PRIMES on its first non-empty result, so mounting on a deployment that already
 * has completed runs / replies does NOT trigger a celebrate storm — only changes
 * AFTER mount fire. Missing ids → that query is "skip"ped and simply contributes
 * nothing. Listeners honor prefers-reduced-motion + auto-clean. Nothing here can
 * throw or block.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { BlipState } from "./Blip";

/** One-shot beats auto-return to the resolved base (idle/thinking) after this
 *  long, so the beat reads, then resolves. */
const ONE_SHOT_MS = 2200;
/** A fun one-liner lingers a touch longer than the pose, then auto-dismisses. */
const SPEECH_MS = 4600;
/** "Hot lead" / "winning post" thresholds (schema: intentScore + viralityScore 0–100). */
const HOT_INTENT = 80;
const HOT_VIRALITY = 80;

/** A SILENT "acknowledge you" micro-beat plays this briefly on a page interaction
 *  (click / key / scroll) — short, so it settles right back to thinking/idle. */
const INTERACTION_BEAT_MS = 720;
/** At most one interaction micro-beat per this window — the "don't be annoying"
 *  throttle. ALL interaction channels (click/key/scroll) share this single gate. */
const INTERACTION_THROTTLE_MS = 2600;
/** "Learned something" bubbles are rate-limited to this so a fact-burst can't spam. */
const LEARNED_THROTTLE_MS = 30000;

/** Poses an `intercept:blip-say` payload may request (anything else → "talking"). */
const SAY_MOODS = new Set<BlipState>([
  "talking",
  "happy",
  "celebrate",
  "concerned",
  "peek",
  "nod",
  "wave",
  "thinking",
  "idle",
]);

// Minimal row shapes (kept local so this file doesn't couple to the full Doc<>
// types; the real queries return supersets of these).
interface RunRow { _id: string; status: string }
interface ThreadRow { _id: string; intentScore?: number }
interface EmailRow { _id: string; status: string }
interface PostRow { _id: string; viralityScore?: number }
interface CreativeRow { _id: string }
interface EventRow { _id: string; kind: string; message: string; createdAt: number }

export interface BlipReaction {
  /** The mood to feed into <Blip state={...} />. */
  state: BlipState;
  /** A fun ambient one-liner for an OPTIONAL speech bubble, or null. Never an input. */
  speech: string | null;
  /** Dismiss the current speech bubble early (e.g. on click). */
  dismissSpeech: () => void;
  /** True while at least one run is running (handy for an aria-label / tooltip). */
  busy: boolean;
}

interface UseBlipReactionsOptions {
  /** The focused run — enables per-run win signals (threads/emails/posts/ads). */
  runId?: Id<"runs"> | null;
  /** The active conversation — enables the event-feed ambient one-liners. */
  conversationId?: Id<"conversations"> | null;
  /** Master switch (default true). When false, the blip just idles. */
  enabled?: boolean;
}

export function useBlipReactions(
  options: UseBlipReactionsOptions = {},
): BlipReaction {
  const { runId = null, conversationId = null, enabled = true } = options;

  // ----- live subscriptions (all reactive; "skip" when an id is absent) -----
  const runs = useQuery(api.runs.listRuns, enabled ? {} : "skip") as
    | RunRow[]
    | undefined;
  const threads = useQuery(
    api.brief.getThreads,
    enabled && runId ? { runId } : "skip",
  ) as ThreadRow[] | undefined;
  const emails = useQuery(
    api.emails.byRun,
    enabled && runId ? { runId } : "skip",
  ) as EmailRow[] | undefined;
  const posts = useQuery(
    api.agents.composer.postsForRun,
    enabled && runId ? { runId } : "skip",
  ) as PostRow[] | undefined;
  const creatives = useQuery(
    api.agents.adsmith.creativesForRun,
    enabled && runId ? { runId } : "skip",
  ) as CreativeRow[] | undefined;
  const feed = useQuery(
    api.events.feedForConversation,
    enabled && conversationId ? { conversationId } : "skip",
  ) as EventRow[] | undefined;
  // The compounding brain's size — drives the "learned N" ambient one-liner.
  const brainStats = useQuery(api.knowledge.brainStats, enabled ? {} : "skip") as
    | { facts: number }
    | undefined;

  // ----- one-shot + speech beat (latest beat wins; auto-resolves) -----
  const [oneShot, setOneShot] = useState<BlipState | null>(null);
  const [speech, setSpeech] = useState<string | null>(null);
  const oneShotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A short, throttled, SILENT interaction micro-beat for page activity. Kept
  // SEPARATE from `oneShot` (and resolved at LOWER priority) so a click can nod
  // then settle back, but it can never stomp a real celebrate / concerned.
  const [interactionBeat, setInteractionBeat] = useState<BlipState | null>(null);
  const interactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards read by listeners (which close over render-time values) for fresh timing:
  const oneShotUntil = useRef(0); // a swarm one-shot owns the sprite until this ts
  const lastInteractAt = useRef(0); // shared throttle gate across all interactions

  const fire = useCallback((state: BlipState, line?: string | null) => {
    setOneShot(state);
    oneShotUntil.current = Date.now() + ONE_SHOT_MS;
    if (oneShotTimer.current) clearTimeout(oneShotTimer.current);
    oneShotTimer.current = setTimeout(() => setOneShot(null), ONE_SHOT_MS);
    if (line) {
      setSpeech(line);
      if (speechTimer.current) clearTimeout(speechTimer.current);
      speechTimer.current = setTimeout(() => setSpeech(null), SPEECH_MS);
    }
  }, []);

  const dismissSpeech = useCallback(() => {
    if (speechTimer.current) clearTimeout(speechTimer.current);
    setSpeech(null);
  }, []);

  // A throttled, SILENT interaction micro-beat (no speech). Skips while a swarm
  // one-shot owns the sprite, while the tab is hidden, and is rate-limited so it
  // never chatters no matter how fast you click / type / scroll.
  const pulse = useCallback((beat: BlipState) => {
    const now = Date.now();
    if (now < oneShotUntil.current) return; // don't stomp a win / worry
    if (now - lastInteractAt.current < INTERACTION_THROTTLE_MS) return;
    if (typeof document !== "undefined" && document.hidden) return;
    lastInteractAt.current = now;
    setInteractionBeat(beat);
    if (interactionTimer.current) clearTimeout(interactionTimer.current);
    interactionTimer.current = setTimeout(
      () => setInteractionBeat(null),
      INTERACTION_BEAT_MS,
    );
  }, []);

  useEffect(
    () => () => {
      if (oneShotTimer.current) clearTimeout(oneShotTimer.current);
      if (speechTimer.current) clearTimeout(speechTimer.current);
      if (interactionTimer.current) clearTimeout(interactionTimer.current);
    },
    [],
  );

  // ----- GLOBAL PAGE-INTERACTION REACTIVITY -----------------------------------
  // Blip stays alive to the WHOLE app: a throttled, silent micro-beat acknowledges
  // clicks, key actions and scrolls anywhere on the page (the original mascot's
  // "reacts to every interaction" feel, minus the heavy whole-body locomotion).
  // All channels share ONE throttle gate (pulse()), so it can never get annoying.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const reduced =
      !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return; // honor reduced-motion: no decorative interaction beats

    const onPointerDown = () => pulse("nod"); // a click → a small acknowledging nod
    const onKeyDown = (e: KeyboardEvent) => {
      // ignore lone modifier keys so a chord prefix (⌘/Ctrl/Alt/Shift) is no beat
      if (
        e.key === "Shift" ||
        e.key === "Control" ||
        e.key === "Alt" ||
        e.key === "Meta"
      )
        return;
      pulse("peek"); // a keypress → a quick glance
    };
    const onScroll = () => pulse("peek"); // scrolling → a brief glance

    window.addEventListener("pointerdown", onPointerDown, {
      passive: true,
      capture: true,
    });
    window.addEventListener("keydown", onKeyDown, { passive: true });
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [enabled, pulse]);

  // ----- Blip SPEAKS contextually (window event) ------------------------------
  // Any part of the app can make Blip say something:
  //   window.dispatchEvent(new CustomEvent("intercept:blip-say",
  //     { detail: { text: "24/7 mode on — I'll keep hunting 🌙", mood: "talking" } }))
  // `text` is required; `mood` is an optional BlipState pose (default "talking").
  // Defensive: empty / non-string / oversized payloads are ignored — never throws.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onSay = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { text?: unknown; mood?: unknown }
        | undefined;
      const text = typeof detail?.text === "string" ? detail.text.trim() : "";
      if (!text) return;
      const capped = text.length > 140 ? `${text.slice(0, 137)}…` : text;
      const mood = SAY_MOODS.has(detail?.mood as BlipState)
        ? (detail!.mood as BlipState)
        : "talking";
      fire(mood, capped);
    };
    window.addEventListener("intercept:blip-say", onSay);
    return () => window.removeEventListener("intercept:blip-say", onSay);
  }, [enabled, fire]);

  // ----- detectors. Each PRIMES on first load (snapshot, no fire) then reacts
  // only to changes AFTER mount. All immutable; refs hold the prior snapshot. -----

  // Runs: running → complete|partial = WIN; → failed = CONCERNED.
  const runStatus = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!runs) return;
    const next = new Map(runs.map((r) => [r._id, r.status]));
    const prev = runStatus.current;
    runStatus.current = next;
    if (!prev) return; // prime
    let firedNew = false;
    for (const [id, status] of next) {
      if (!prev.has(id)) {
        // a brand-new run id = a PLAY was just fired. Greet it once (non-terminal
        // only, so a backfilled historical run doesn't read as "just started").
        if (
          !firedNew &&
          status !== "complete" &&
          status !== "partial" &&
          status !== "failed"
        ) {
          fire("nod", "on it — hunting now 🚀");
          firedNew = true;
        }
        continue;
      }
      const was = prev.get(id);
      if (was === status) continue;
      if ((status === "complete" || status === "partial") && was === "running") {
        fire("celebrate", "done — take a look 👀");
      } else if (status === "failed" && was !== "failed") {
        fire("concerned", "hmm, that one stalled");
      }
    }
  }, [runs, fire]);

  // Threads: a NEW thread with intentScore ≥ 80 is a hot lead.
  const seenThreads = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!threads) return;
    const prev = seenThreads.current;
    seenThreads.current = new Set(threads.map((t) => t._id));
    if (!prev) return; // prime
    const hotNew = threads.some(
      (t) => !prev.has(t._id) && (t.intentScore ?? 0) >= HOT_INTENT,
    );
    if (hotNew) fire("celebrate", "found a hot lead 👀");
  }, [threads, fire]);

  // Emails: a transition into "replied" is a win.
  const emailStatus = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!emails) return;
    const next = new Map(emails.map((e) => [e._id, e.status]));
    const prev = emailStatus.current;
    emailStatus.current = next;
    if (!prev) return; // prime
    for (const [id, status] of next) {
      if (status === "replied" && prev.get(id) !== "replied") {
        fire("celebrate", "got a reply 🎉");
        break;
      }
    }
  }, [emails, fire]);

  // Posts: a NEW post scoring ≥ 80 virality is a banger.
  const seenPosts = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!posts) return;
    const prev = seenPosts.current;
    seenPosts.current = new Set(posts.map((p) => p._id));
    if (!prev) return; // prime
    const bangerNew = posts.some(
      (p) => !prev.has(p._id) && (p.viralityScore ?? 0) >= HOT_VIRALITY,
    );
    if (bangerNew) fire("celebrate", "that post's a banger 🔥");
  }, [posts, fire]);

  // Ad factory: a NEW generated creative is a win.
  const seenCreatives = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!creatives) return;
    const prev = seenCreatives.current;
    seenCreatives.current = new Set(creatives.map((c) => c._id));
    if (!prev) return; // prime
    const fresh = creatives.some((c) => !prev.has(c._id));
    if (fresh) fire("celebrate", "that ad's a winner!");
  }, [creatives, fire]);

  // Brain growth: a bump in durable facts after mount = "it just learned
  // something". Primes once (snapshot, no fire); rate-limited so a fact-burst
  // during a run can't spam — a tasteful, occasional "getting smarter" beat.
  const lastFacts = useRef<number | null>(null);
  const lastLearnedAt = useRef(0);
  useEffect(() => {
    const facts = brainStats?.facts;
    if (typeof facts !== "number") return;
    if (lastFacts.current === null) {
      lastFacts.current = facts; // prime
      return;
    }
    const jump = facts - lastFacts.current;
    lastFacts.current = facts;
    if (jump <= 0) return;
    const now = Date.now();
    if (now - lastLearnedAt.current < LEARNED_THROTTLE_MS) return;
    lastLearnedAt.current = now;
    fire(
      "happy",
      jump === 1 ? "learned something new 🧠" : `learned ${jump} new things 🧠`,
    );
  }, [brainStats, fire]);

  // Event feed: small ambient beats + one-liners (peek/nod). Reacts to the
  // newest event id only, and only to NEW ones after priming. Replies are
  // already celebrated above; here we cover the lighter "in-progress" beats.
  const lastEventId = useRef<string | null>(null);
  const primedFeed = useRef(false);
  useEffect(() => {
    if (!feed || feed.length === 0) return;
    const newest = feed[0]; // feedForConversation is newest-first
    if (!primedFeed.current) {
      primedFeed.current = true;
      lastEventId.current = newest._id;
      return; // prime
    }
    if (newest._id === lastEventId.current) return;
    lastEventId.current = newest._id;
    const line = ambientLineFor(newest);
    if (!line) return;
    fire(line.state, line.text);
  }, [feed, fire]);

  // ----- resolve the final state -----
  // Priority: swarm one-shot (win/worry/play)  ›  interaction micro-beat (click/
  // key/scroll acknowledge)  ›  thinking (a run is running)  ›  idle (cursor gaze).
  const busy = !!runs && runs.some((r) => r.status === "running");
  const state: BlipState =
    oneShot ?? interactionBeat ?? (busy ? "thinking" : "idle");

  return { state, speech, dismissSpeech, busy };
}

/**
 * Map an event-feed row to a tasteful ambient beat + one-liner. Returns null for
 * kinds that shouldn't surface a bubble (keeps the blip from chattering). FUN,
 * never instructional — and never a prompt for input.
 */
function ambientLineFor(
  ev: EventRow,
): { state: BlipState; text: string } | null {
  const kind = ev.kind.toLowerCase();
  switch (kind) {
    case "found":
    case "sourced":
      return { state: "peek", text: "found a hot lead 👀" };
    case "qualified":
      return { state: "peek", text: "ooh, this one's a fit 👀" };
    case "enriched":
      return { state: "nod", text: "digging up the details…" };
    case "drafted":
      return { state: "nod", text: "drafting something good ✍️" };
    case "sent":
      return { state: "nod", text: "sending…" };
    case "replied":
      return { state: "celebrate", text: "got a reply 🎉" };
    case "rendered":
      return { state: "celebrate", text: "the creative's ready 🎬" };
    default:
      return null;
  }
}

/**
 * A few static "overnight" lines for the proactive-cron beat. The 24/7 cron posts
 * a proactive `messages` row ("overnight I found 3 signals…"); a mount that wants
 * to echo that delight can pass one of these to the bubble. Exported so the
 * companion wrapper can show one when a `proactive` message lands.
 */
export const PROACTIVE_LINES = [
  "overnight I found 3 signals 🌙",
  "while you were away, the swarm kept working ✨",
  "fresh leads waiting for you 👀",
] as const;
