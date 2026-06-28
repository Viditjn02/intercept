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
  }).index("by_status", ["status"]),

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
});
