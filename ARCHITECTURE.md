# INTERCEPT — Architecture

How an input becomes **a clickable, intent-scored link to a live conversation**, on a realtime board, inside 90 seconds.

The contract that everything below is built against lives in `convex/schema.ts` (tables + indexes) and `lib/contract.ts` (shared types + constants). Treat both as frozen.

---

## Data flow

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  USER                                                                                      │
│   types/pastes an input: a URL · company name · competitor · community · raw text          │
└───────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                 │  useMutation(api.run.start)
                                                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR — convex/run.ts        (owns `runs` + `agentStatus` + the fan-in deadline)    │
│                                                                                            │
│   1. insert runs row { input, inputType, status:"running",                                 │
│                        startedAt, deadlineAt = startedAt + FANIN_DEADLINE_MS(90s),         │
│                        replay }                                                            │
│   2. seed agentStatus: one row per AGENT in "queued"                                        │
│   3. ROUTER classifies the input → decides which agents to run                             │
│   4. enqueue each agent on the Workpool ("swarmpool", maxParallelism 8)                     │
└───────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                 │  parallel fan-out
                 ┌───────────────────────────────┼───────────────────────────────┐
                 ▼                                ▼                                ▼
   ┌─────────────────────┐        ┌─────────────────────────┐        ┌─────────────────────┐
   │  enrich             │        │  detective   ◀ THE MOAT │        │  creative           │
   │  Orange Slice+OpenAI│        │  Exa + OpenAI           │        │  Veo 3.1 Fast       │
   │  → brief            │        │  → communities, threads │        │  → creatives        │
   │   (icp,positioning) │        │   (url,intentScore,…)   │        │   (video)           │
   └──────────┬──────────┘        └────────────┬────────────┘        └──────────┬──────────┘
              │                                 │                                │
              │                                 ▼  reply drafting (OpenAI)       │
              │                    ┌─────────────────────────┐                   │
              │                    │  drafts                 │                   │
              │                    │  status:awaiting_approval│                  │
              │                    └────────────┬────────────┘                   │
              │                                 │              ┌─────────────────┴───┐
              │                                 │              │  watcher            │
              │                                 │              │  Gemini 2.5 Flash   │
              │                                 │              │  → agentStatus note │
              │                                 │              └─────────┬───────────┘
              └─────────────────────────────────┴────────────────────────┘
                          each agent writes its OWN results via its OWN internalMutation
                          and updates `agentStatus` ONLY through the orchestrator
                                                 │
                                                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  FAN-IN — convex/run.ts                                                                     │
│   • a scheduled check fires at runs.deadlineAt (startedAt + 90s)                            │
│   • renders the brief from whatever COMPLETED before the deadline                          │
│   • agents still running → marked "skipped";  errored → "failed"  (never block)            │
│   • flips runs.status → "complete"  (all done)  |  "partial"  (deadline hit first)         │
└───────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                 │  Convex reactivity (every write pushes)
                                                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND — Next.js 15 App Router, "use client"                                            │
│   useQuery against the by_run indexes:                                                      │
│     agentStatus → the LIVE SWARM BOARD (lights up agent-by-agent, in realtime)             │
│     threads     → ranked, intent-scored cards                                              │
│     communities → where the buyer lives                                                    │
│     drafts      → the in-thread reply + Approve/Reject buttons (the human gate)            │
│     creatives   → the video ad                                                             │
│     brief        → ICP + positioning                                                       │
└───────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                 │
                                                 ▼
                              ★ THE CLICK ★  user taps a thread →
                              opens the REAL, LIVE conversation (threads.url)
```

Key timing guarantees:

- **`FANIN_DEADLINE_MS = 90_000`** — the brief renders regardless of stragglers. Partial results render; nothing hangs the board.
- **Workpool `maxParallelism: 8`** — the swarm runs concurrently, not serially. With 5 agents the pool never queues, so wall-clock ≈ the slowest single agent, not the sum.
- **Convex reactivity** — every agent write streams to the frontend instantly; there is no polling. The board *is* the database.

---

## Ownership rules (why integration stays clean)

| Concern | Owner | Rule |
|----------------------------|--------------------------------|----------------------------------------------------------------|
| `runs` lifecycle | orchestrator (`convex/run.ts`) | Only the orchestrator creates/flips a run's status. |
| `agentStatus` (the board) | orchestrator | **Agents never write `agentStatus`.** The orchestrator marks queued→running→done/skipped/failed. |
| An agent's own results | that agent (`convex/agents/*`) | Each agent persists via its OWN `internalMutation`(s) in its own module. |
| Reading prior results | the consuming agent | e.g. the reply step reads `threads` via a `ctx.runQuery` to an internal query the module defines. |
| External API access | `lib/*.ts` clients | Keys read from `process.env`; called only from `"use node"` actions. |

Each swarm agent is a module `convex/agents/<name>.ts` exporting:

```ts
export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => { /* do work, persist OWN results */ },
});
```

The orchestrator enqueues these on the `swarmpool` Workpool and is the sole writer of `agentStatus`.

---

## Agent map

| Agent | Reads | External service | Persists (own mutation) | Drives |
|-------------|----------------------------|----------------------------|--------------------------------------|------------------------|
| `router` | `runs.input` | OpenAI | — (returns routing decision) | which agents fan out |
| `enrich` | `runs.input` | Orange Slice + OpenAI | `brief` (icp, positioning) | the brief |
| `detective`| `runs.input`, brief context| **Exa** + OpenAI | `communities`, `threads`, `drafts` | **THE MOAT** + the gate |
| `creative` | brief / positioning | **Veo 3.1 Fast** | `creatives` (video) | the ad |
| `watcher` | `threads` | Gemini 2.5 Flash | `agentStatus` notes (via orch.) | freshness/live signal |

> **detective** is the heart: it finds communities (Exa), pulls real thread URLs, scores each thread's buying intent 0–100 with OpenAI (`browsing · comparing · frustrated · ready_to_buy`), and drafts the in-thread reply into `drafts` as `awaiting_approval`. Exa is the on-camera thread source; Orange Slice (in `enrich`) only sharpens the ICP.

---

## Table map

| Table | Index(es) | Written by | Read by frontend for |
|----------------|------------------------|-------------------------|----------------------------------------|
| `runs` | `by_status` | orchestrator | run status + the deadline clock |
| `agentStatus` | `by_run` | orchestrator | **the live swarm board** |
| `communities` | `by_run` | detective | where the buyer hangs out |
| `threads` | `by_run` | detective | **the clickable, intent-scored moat** |
| `drafts` | `by_run`, `by_thread` | detective; user mutates | the reply + Approve/Reject gate |
| `creatives` | `by_run` | creative | the video ad |
| `brief` | `by_run` | enrich | ICP + positioning |

### The approval gate (`drafts.status`)

```
        ┌──────────────────┐  user approves   ┌──────────┐  send   ┌────────┐
        │ awaiting_approval │ ───────────────▶ │ approved │ ──────▶ │ posted │
        └─────────┬────────┘                  └──────────┘         └────────┘
                  │ user rejects
                  ▼
            ┌──────────┐
            │ rejected │
            └──────────┘
```

Nothing leaves INTERCEPT without a human flipping `awaiting_approval → approved`. The `posted` state is the in-thread reply going out; external outreach (AgentMail/Fiber) is vision/v2.

---

## Deterministic replay path

For the on-camera demo, a run created with `replay: true` skips the external APIs and is hydrated from a cached fixture, so timing is guaranteed.

```
fixtures/<slug>.json  (ReplayFixture)
   { input, enrich, communities, threads, drafts, creativeUrl }
            │  npm run seed → scripts/seed-demo.ts
            ▼
   inserts the same rows the live swarm would have produced
   (runs, brief, communities, threads, drafts, creatives) →
   the frontend renders identically; the artifacts are real, just frozen.
```

The replay path writes into the **same tables** the live swarm uses, so the frontend code is identical for live and demo runs — only the *source* of the rows differs.

---

*See [README.md](./README.md) for product framing, the moat, sponsor mapping, and setup/run instructions.*
