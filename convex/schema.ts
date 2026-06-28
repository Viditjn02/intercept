import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ============================================================================
// INTERCEPT — FROZEN SCHEMA CONTRACT
// Every package builds against this. Do not change field shapes without telling
// the integrator (P1). The frontend, the orchestrator, and the agents all read
// and write these tables. The live swarm board is driven by `agentStatus`; the
// moat is `threads` (real, clickable, intent-scored live conversations).
// ============================================================================

export default defineSchema({
  // One GTM run. The fan-in renders the brief from whatever completed before
  // deadlineAt, then flips status -> "complete" (or "partial").
  runs: defineTable({
    input: v.string(),
    inputType: v.union(
      v.literal("url"),
      v.literal("name"),
      v.literal("competitor"),
      v.literal("community"),
      v.literal("text"),
    ),
    status: v.union(
      v.literal("running"),
      v.literal("complete"),
      v.literal("partial"),
      v.literal("failed"),
    ),
    startedAt: v.number(),
    deadlineAt: v.number(), // hard fan-in deadline (startedAt + ~90s)
    company: v.optional(v.string()),
    // Canonical apex domain resolved by the router (e.g. "superhuman.com"), so
    // enrich scrapes the real homepage instead of "https://<raw input>".
    routedDomain: v.optional(v.string()),
    replay: v.boolean(), // deterministic demo mode (cached fixture)
    monitorId: v.optional(v.id("monitors")), // set when this run came from a 24/7 monitor tick
    skipVideo: v.optional(v.boolean()), // background ticks skip Veo to save credits
  })
    .index("by_status", ["status"])
    .index("by_monitor", ["monitorId"]),

  // Drives the live swarm board. One row per agent per run.
  agentStatus: defineTable({
    runId: v.id("runs"),
    agent: v.string(), // router | enrich | detective | creative | watcher
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("skipped"),
      v.literal("failed"),
    ),
    note: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  }).index("by_run", ["runId"]),

  communities: defineTable({
    runId: v.id("runs"),
    name: v.string(),
    platform: v.string(),
    url: v.string(),
    why: v.string(),
  }).index("by_run", ["runId"]),

  // THE MOAT: a real, clickable, intent-scored link to a live conversation.
  threads: defineTable({
    runId: v.id("runs"),
    communityId: v.optional(v.id("communities")),
    platform: v.string(), // reddit | hackernews | forum
    url: v.string(), // REAL clickable URL — verifiable in one tap
    title: v.string(),
    snippet: v.string(),
    intentScore: v.number(), // 0-100
    intentLabel: v.string(), // browsing | comparing | frustrated | ready_to_buy
    author: v.optional(v.string()),
    // text-embedding-3-small (1536d) of "title\nsnippet". Optional so existing /
    // seeded rows without embeddings stay valid (they simply aren't indexed).
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_run", ["runId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["runId"],
    }),

  // The in-thread reply, behind the human-approval gate.
  drafts: defineTable({
    runId: v.id("runs"),
    threadId: v.id("threads"),
    body: v.string(),
    confidence: v.number(), // 0-1
    status: v.union(
      v.literal("awaiting_approval"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("posted"),
    ),
  })
    .index("by_run", ["runId"])
    .index("by_thread", ["threadId"]),

  creatives: defineTable({
    runId: v.id("runs"),
    kind: v.string(), // "video"
    status: v.union(
      v.literal("pending"),
      v.literal("rendering"),
      v.literal("done"),
      v.literal("failed"),
    ),
    model: v.string(),
    prompt: v.string(),
    url: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  }).index("by_run", ["runId"]),

  brief: defineTable({
    runId: v.id("runs"),
    icp: v.string(),
    positioning: v.string(),
    generatedAt: v.number(),
  }).index("by_run", ["runId"]),

  // Competitor ad intelligence from the Meta Ad Library (AI Ad Factories angle):
  // which of a competitor's ads are live + how long they've run (a proxy for
  // "this creative is working"), so INTERCEPT can mirror the winning angle.
  ads: defineTable({
    runId: v.id("runs"),
    advertiser: v.string(),
    platform: v.string(), // facebook | instagram | audience_network
    text: v.string(), // ad copy / primary text
    imageUrl: v.optional(v.string()),
    runningSince: v.optional(v.string()), // ISO date the ad started
    daysRunning: v.optional(v.number()), // longevity = proxy for a winning ad
    status: v.string(), // active | inactive
    url: v.string(), // permalink into the Ad Library
  }).index("by_run", ["runId"]),

  // A 24/7 watch: a Convex cron re-runs the swarm on a schedule and surfaces only
  // NEW intent threads since the last tick. Found drafts still land in the human
  // approval queue — autonomous discovery, human-approved outreach.
  monitors: defineTable({
    company: v.string(),
    input: v.string(),
    inputType: v.union(
      v.literal("url"),
      v.literal("name"),
      v.literal("competitor"),
      v.literal("community"),
      v.literal("text"),
    ),
    active: v.boolean(),
    cadenceMinutes: v.number(), // how often the cron ticks this monitor
    lastRunAt: v.optional(v.number()),
    lastRunId: v.optional(v.id("runs")),
    createdAt: v.number(),
  }).index("by_active", ["active"]),
});
