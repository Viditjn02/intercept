# HOLMES

**Point at a company. Get the live conversations where its buyers are asking the exact question it answers — each as a clickable, intent-scored thread with a drafted, human-approved reply — plus a generated video ad. Live on a realtime board, in under 3 minutes.**

```
                    ┌─────────────────────────────────────────────┐
   "stripe.com"  →  │  🔎 a swarm of AI detectives goes to work    │  →  a board of
   (or a name,      │     router · enrich · detective · creative   │     CLICKABLE,
    competitor,     │     · watcher — in parallel, on Convex       │     intent-scored
    community)      └─────────────────────────────────────────────┘     LIVE threads
```

---

## What HOLMES is

Most "GTM intelligence" tools hand you a **score**, a **list of contacts**, or a **lookalike audience**. None of those are clickable. None of them point at a human who is, right now, asking the exact question your product answers.

HOLMES does. You give it a company (a URL, a name, a competitor, a community, or a blob of text). A swarm of agents:

1. **Figures out who the buyer is** — the ICP and the company's positioning.
2. **Finds the live communities** where that buyer hangs out (Reddit, Hacker News, forums).
3. **Surfaces the actual threads** — real, clickable URLs — where someone is asking the question the company answers, and **scores each by buying intent** (0–100, labelled `browsing · comparing · frustrated · ready_to_buy`).
4. **Drafts the in-thread reply** for the highest-intent threads — sitting behind a **human-approval gate** (nothing is ever posted automatically).
5. **Generates a video ad** (Veo) for the company, in parallel.

All of it streams onto a **realtime Convex board** as each agent reports in. The whole run is bounded by a **90-second fan-in deadline**: whatever has completed by then renders into the brief, and slow agents degrade gracefully to `skipped` instead of blocking the demo.

---

## The moat

> **The atomic deliverable is a clickable, intent-scored link to a LIVE conversation.**

Not a score. Not a contact. Not a "lookalike audience." A **URL you can tap right now** that lands you on a real person, in a real community, asking the question your product answers — ranked by how close they are to buying — with a reply already drafted for you to approve.

That is the thing competitors can't trivially copy, because it requires (a) real-time community search, (b) per-thread intent scoring, and (c) a drafted, context-aware reply — fused into one tappable object. Everything else in HOLMES exists to produce and defend that object.

---

## Architecture (at a glance)

```
 input ──▶ Router ──▶ parallel swarm (Convex Workpool, maxParallelism 8) ──▶ 90s fan-in ──▶ realtime board ──▶ the click
                       ├─ enrich      (Orange Slice + OpenAI → ICP/positioning)
                       ├─ detective   (Exa → communities + intent-scored threads)   ◀── THE MOAT
                       ├─ creative    (Veo 3.1 Fast → video ad)
                       └─ watcher      (Gemini → live signal / freshness)
```

- **Convex** is the backbone: realtime DB + the swarm runtime. The orchestrator (`convex/run.ts`) owns the live board (`agentStatus`) and the deadline/partial-render fan-in.
- **Convex Workpool** (registered as `swarmpool`, `maxParallelism: 8`) fans the agents out to run concurrently.
- **Exa** powers **the moat** — real, clickable community threads.
- **OpenAI** (`gpt-4o-mini`) does routing, intent scoring, and reply drafting.
- **Veo 3.1 Fast** generates the video ad; **Gemini 2.5 Flash** powers the watcher.
- **Next.js 15 (App Router)** renders the board with `useQuery`/`useMutation` from `convex/react` against the `by_run` indexes — so the UI updates the instant any agent writes a result.

Each swarm agent is its own Convex module (`convex/agents/<name>.ts`) exporting `export const run = internalAction(...)`. Agents persist their own results via their own internal mutations and **never touch `agentStatus`** — that belongs to the orchestrator. See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full data-flow diagram and the table/agent map.

### The agents

| Agent | Job | External service | Writes to |
|-----------|-----------------------------------------------------------|----------------------------|-----------------------|
| `router` | Classify the input, decide which agents to run | OpenAI | (orchestration only) |
| `enrich` | Resolve company → ICP + positioning | Orange Slice + OpenAI | `brief` |
| `detective` | Find communities + **intent-scored, clickable threads** | **Exa** + OpenAI | `communities`, `threads` |
| `creative` | Generate the video ad | **Veo 3.1 Fast** | `creatives` |
| `watcher` | Live signal / freshness check on the conversation | Gemini 2.5 Flash | `agentStatus` notes |

### The tables (the frozen contract)

| Table | Role |
|----------------|--------------------------------------------------------------------------------|
| `runs` | One GTM run. Holds the input, status, and the hard `deadlineAt` fan-in clock. |
| `agentStatus` | **Drives the live board** — one row per agent per run. Owned by the orchestrator. |
| `communities` | The live communities where the buyer hangs out. |
| `threads` | **THE MOAT** — `url`, `title`, `snippet`, `intentScore` (0–100), `intentLabel`. |
| `drafts` | The in-thread reply, gated: `awaiting_approval → approved \| rejected → posted`. |
| `creatives` | The generated video ad. |
| `brief` | The synthesized `icp` + `positioning`. |

The full shape lives in `convex/schema.ts` and `lib/contract.ts` — **the frozen contract**. Every package builds against it.

---

## Sponsor mapping

| Sponsor | Where it shows up in HOLMES |
|------------------|----------------------------------------------------------------------------------------|
| **Convex** | The whole realtime backbone: DB, the live swarm board, the Workpool fan-out, the reactive frontend. |
| **Exa** | **The moat.** Real, clickable, intent-scorable community threads — the on-camera thread source. |
| **OpenAI** | Router (input classification), per-thread intent scoring, and reply drafting (`gpt-4o-mini`). |
| **Google / Veo** | Veo 3.1 Fast generates the video ad; Gemini 2.5 Flash powers the watcher agent. |
| **Orange Slice** | **Enrichment + signal** that sharpens the ICP/positioning — *not* the on-camera thread source. |
| **AgentMail / Fiber** | *(vision / v2)* — approval-gate inbox + verified-contact outreach beyond the in-thread reply. |

---

## Setup

**Prereqs:** Node 18+, a Convex account (`npx convex`), and API keys for the services above.

```bash
# 1. Install
npm install

# 2. Configure secrets
cp .env.example .env.local
#   then fill in EXA_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, ORANGE_SLICE_API_KEY

# 3. Boot Convex (creates the deployment, populates CONVEX_DEPLOYMENT + NEXT_PUBLIC_CONVEX_URL,
#    and pushes the schema + functions). Leave this running.
npx convex dev

# 4. Set the API keys ON the Convex deployment (the agents run inside Convex "use node"
#    actions and read process.env there, not from .env.local):
npx convex env set EXA_API_KEY        <key>
npx convex env set OPENAI_API_KEY     <key>
npx convex env set GOOGLE_API_KEY     <key>
npx convex env set ORANGE_SLICE_API_KEY <key>

# 5. In a second terminal, run the app
npm run dev
# → http://localhost:3000
```

> **Why keys go on Convex too:** the swarm agents execute server-side inside Convex `"use node"` actions and read keys from `process.env` *in the Convex runtime*. `.env.local` only covers the Next.js side (`NEXT_PUBLIC_CONVEX_URL`). Set both.

### Environment variables

| Var | Used by | Required |
|--------------------------|-----------------------------------------------|---------------------|
| `NEXT_PUBLIC_CONVEX_URL` | Frontend → Convex client | yes |
| `CONVEX_DEPLOYMENT` | `npx convex dev` | yes |
| `EXA_API_KEY` | detective (the moat) | yes |
| `OPENAI_API_KEY` | router · intent scoring · reply drafting | yes |
| `GOOGLE_API_KEY` | creative (Veo) · watcher (Gemini) | yes (for live video)|
| `ORANGE_SLICE_API_KEY` | enrich | yes |
| `AGENTMAIL_API_KEY` | *(vision / v2)* outreach inbox | no |
| `FIBER_API_KEY` | *(vision / v2)* verified contacts | no |

---

## Run it

1. Open `http://localhost:3000`.
2. Type or paste a company — a URL (`stripe.com`), a name (`Linear`), a competitor, a community, or a blob of text.
3. Hit **Run**. Watch the **swarm board** light up agent-by-agent in realtime.
4. Within ~90s you get the **brief** (ICP + positioning), the **communities**, and the **moat**: a ranked list of clickable, intent-scored threads.
5. Click any thread → it opens the **real live conversation**.
6. Each high-intent thread has a **drafted reply** sitting in `awaiting_approval`. **Approve** or **reject** it — nothing is ever posted without you.
7. The **video ad** finishes rendering alongside.

---

## The deterministic demo (replay mode)

Live multi-agent runs over external APIs are gloriously unpredictable — exactly what you don't want on camera. HOLMES ships a **deterministic replay path** so the on-stage run is instant and cannot flop.

- A run created with `replay: true` is hydrated from a cached fixture instead of hitting external APIs.
- Fixtures live in `fixtures/<slug>.json` and conform to `ReplayFixture` in `lib/contract.ts` (`input`, `enrich`, `communities`, `threads`, `drafts`, `creativeUrl` — a pre-rendered Veo clip).
- Seed them with:

  ```bash
  npm run seed        # tsx scripts/seed-demo.ts — loads the fixture(s) into Convex
  ```

- The board, the threads, the intent scores, the drafts, and the video are **all real artifacts** — they were produced by a real live run, then frozen. Replay just guarantees the *timing* of the demo, not the *substance*.

Run the demo against a seeded fixture for the camera; run live for Q&A.

---

## Honest notes

We'd rather be precise than oversell. The things to know:

- **Veo needs paid billing.** Veo 3.1 Fast (video) requires a Google account with **billing enabled** on the `GOOGLE_API_KEY`. Without it, the `creative` agent will fail gracefully (the run still completes), and the demo uses the **pre-rendered clip** baked into the replay fixture (`creativeUrl`).
- **Orange Slice is enrichment, not the thread source.** Orange Slice sharpens the **ICP/positioning** in the `enrich` step. It is **not** where the on-camera clickable threads come from — **those come from Exa.** Don't conflate the two; the moat is Exa.
- **Outreach is the in-thread reply, and it's human-approved.** HOLMES does **not** auto-post. It *drafts* a reply for high-intent threads; the draft sits in `awaiting_approval` and a human must **approve** before anything is sent. AgentMail/Fiber-style external outreach is **vision/v2**, not this build.
- **The 90s deadline is real and intentional.** The fan-in renders the brief from whatever finished before `runs.deadlineAt` (`FANIN_DEADLINE_MS = 90_000`). A slow or failed agent becomes `skipped`/`failed` — it never blocks the board. Partial results are a feature, not a bug.
- **Caps are deliberate.** `MAX_COMMUNITIES = 5`, `MAX_THREADS = 8` — tuned for signal density and a board that reads cleanly on stage, not exhaustiveness.

---

## Project layout

```
convex/
  schema.ts            # THE FROZEN CONTRACT — tables + indexes
  convex.config.ts     # registers Workpool ("swarmpool") + Agent components
  run.ts               # orchestrator — owns agentStatus + the 90s fan-in
  agents/
    router.ts          # input classification
    enrich.ts          # ICP + positioning
    detective.ts       # communities + intent-scored threads  ◀── THE MOAT
    creative.ts        # Veo video ad
    watcher.ts         # live signal / freshness
lib/
  contract.ts          # shared types: AGENTS, DiscoveredThread, ReplayFixture, caps…
  exa.ts · openai.ts · veo.ts · orangeslice.ts   # external API clients (read process.env)
app/                   # Next.js 15 App Router — the realtime board
fixtures/<slug>.json   # deterministic replay fixtures (ReplayFixture)
scripts/seed-demo.ts   # loads fixtures into Convex for the demo
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full data-flow diagram and the table/agent map.

---

*HOLMES — find the conversation, not the contact.*
