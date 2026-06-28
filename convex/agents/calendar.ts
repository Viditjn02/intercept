// ============================================================================
// INTERCEPT — CALENDAR AGENT  ·  TRACK 1 (algorithm hacking / virality)
// ----------------------------------------------------------------------------
// The final beat of the social lane. Reads the scored posts the composer
// persisted and lays them out across a 2-week content calendar (MAX_CALENDAR_DAYS)
// — highest-virality posts scheduled first, platforms spread so no single feed
// is spammed on the same day. Persists the schedule into `contentCalendar`,
// each slot linked to its source post.
//
// Self-contained: owns its read query, write mutation, and a PUBLIC
// `calendarForRun` query the canvas reads. Pure scheduling (no external calls) —
// it can never stall. NEVER throws past its handler.
//
// RUNTIME: NOT "use node" — co-locates query + mutation with the action.
// ============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { MAX_CALENDAR_DAYS } from "../../lib/contract";

// Best posting windows per platform (kept lightweight — a human label only).
const BEST_TIME: Record<string, string> = {
  linkedin: "8:00 AM",
  x: "12:00 PM",
  tiktok: "7:00 PM",
  instagram: "6:00 PM",
};

// ----------------------------------------------------------------------------
// READ: the run's scored posts, highest-virality first.
// ----------------------------------------------------------------------------
export const postsForCalendar = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"posts">[]> => {
    const rows = await ctx.db
      .query("posts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return rows.sort((a, b) => b.viralityScore - a.viralityScore);
  },
});

// ----------------------------------------------------------------------------
// WRITE: replace this run's calendar slots with the freshly scheduled set.
// ----------------------------------------------------------------------------
export const save = internalMutation({
  args: {
    runId: v.id("runs"),
    slots: v.array(
      v.object({
        dayOffset: v.number(),
        platform: v.string(),
        postId: v.optional(v.id("posts")),
        title: v.string(),
        scheduledLabel: v.string(),
        status: v.string(),
      }),
    ),
  },
  handler: async (ctx, { runId, slots }): Promise<number> => {
    const existing = await ctx.db
      .query("contentCalendar")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    for (const slot of slots) {
      await ctx.db.insert("contentCalendar", { runId, ...slot });
    }
    return slots.length;
  },
});

// ----------------------------------------------------------------------------
// PUBLIC READ: calendar slots for a run, in schedule order. The canvas renders
// these as a 2-week grid.
// ----------------------------------------------------------------------------
export const calendarForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<Doc<"contentCalendar">[]> => {
    const rows = await ctx.db
      .query("contentCalendar")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    return rows.sort((a, b) => a.dayOffset - b.dayOffset);
  },
});

// ----------------------------------------------------------------------------
// ACTION: schedule the scored posts across the calendar horizon. Never blocks.
// ----------------------------------------------------------------------------
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ slots: number }> => {
    const run = await ctx.runQuery(internal.runs.getRunInternal, { runId });
    if (run?.replay) return { slots: 0 };

    const posts = await ctx.runQuery(internal.agents.calendar.postsForCalendar, {
      runId,
    });
    if (posts.length === 0) {
      await ctx.runMutation(internal.agents.calendar.save, { runId, slots: [] });
      return { slots: 0 };
    }

    const slots = scheduleSlots(posts);
    await ctx.runMutation(internal.agents.calendar.save, { runId, slots });
    await logEvent(
      ctx,
      runId,
      "scheduled",
      `Laid out ${slots.length} posts across a ${MAX_CALENDAR_DAYS}-day content calendar.`,
    );
    return { slots: slots.length };
  },
});

// ----------------------------------------------------------------------------
// Scheduling — spread the best posts first across the horizon, avoiding posting
// two of the same platform on the same day. Pure + deterministic.
// ----------------------------------------------------------------------------
interface Slot {
  dayOffset: number;
  platform: string;
  postId: Id<"posts">;
  title: string;
  scheduledLabel: string;
  status: string;
}

function scheduleSlots(posts: Doc<"posts">[]): Slot[] {
  const slots: Slot[] = [];
  const usedPerDay = new Map<number, Set<string>>(); // day -> platforms posted
  const horizon = Math.max(1, MAX_CALENDAR_DAYS);

  posts.forEach((post, index) => {
    // Spread one post roughly every other day, wrapping within the horizon.
    let day = (index * 2) % horizon;
    // Avoid double-booking the same platform on the same day.
    for (let probe = 0; probe < horizon; probe++) {
      const candidate = (day + probe) % horizon;
      const used = usedPerDay.get(candidate);
      if (!used || !used.has(post.platform)) {
        day = candidate;
        break;
      }
    }
    const used = usedPerDay.get(day) ?? new Set<string>();
    used.add(post.platform);
    usedPerDay.set(day, used);

    const time = BEST_TIME[post.platform] ?? "9:00 AM";
    slots.push({
      dayOffset: day,
      platform: post.platform,
      postId: post._id,
      title: post.hook || post.body.slice(0, 80),
      scheduledLabel: `Day ${day + 1} · ${time}`,
      status: "planned",
    });
  });

  return slots.sort((a, b) => a.dayOffset - b.dayOffset);
}

// ----------------------------------------------------------------------------
// Live-feed helper. Best-effort — never blocks the calendar lane.
// ----------------------------------------------------------------------------
async function logEvent(
  ctx: ActionCtx,
  runId: Id<"runs">,
  kind: string,
  message: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.events.log, {
      runId,
      agent: "calendar",
      kind,
      message,
    });
  } catch {
    // ignore — the feed is additive
  }
}
