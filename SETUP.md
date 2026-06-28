# HOLMES — Local Setup & Demo Replay

Point at a company → a swarm of agents finds the live communities where its
buyers are asking the exact question the company answers, returns each as a
clickable, intent-scored thread + a drafted in-thread reply (behind a
human-approval gate), and generates a Veo video ad — live on a realtime Convex
board in under 3 minutes.

This document covers running HOLMES locally **and** the deterministic replay
harness that guarantees the on-camera demo cannot flop.

---

## Prerequisites

- **Node.js 20.6+** (22 recommended) and **npm**
- A **Convex** account (free) — `npx convex dev` will prompt you to log in
- API keys for the live pipeline (see `.env.example`). For the *replay* demo you
  only need a Convex deployment — no external keys are required.

---

## 1. Install dependencies

```bash
npm install
```

## 2. Start Convex (creates your deployment + generates the API)

In a dedicated terminal, run:

```bash
npx convex dev
```

The first run logs you in, creates a dev deployment, prints your
`NEXT_PUBLIC_CONVEX_URL`, and writes `CONVEX_DEPLOYMENT` into `.env.local`. Leave
this process **running** — it watches `convex/` and regenerates
`convex/_generated/` (which the seed script and frontend import).

## 3. Fill in `.env.local`

```bash
cp .env.example .env.local
```

Then edit `.env.local`. For the deterministic replay demo, the only required
value is the Convex URL (Convex populates the deployment vars for you):

```bash
CONVEX_DEPLOYMENT=        # written by `npx convex dev`
NEXT_PUBLIC_CONVEX_URL=   # printed by `npx convex dev` — REQUIRED for seeding
```

For the **live** pipeline, also fill in the agent keys (`EXA_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ORANGE_SLICE_API_KEY`). These are read by
the Convex `"use node"` actions, not by the replay harness.

> Set the agent secrets on the Convex deployment too (so server-side actions can
> read them), e.g. `npx convex env set OPENAI_API_KEY sk-...`.

## 4. Run the app

In a second terminal:

```bash
npm run dev
```

Open http://localhost:3000. The board reads from Convex reactively, so anything
the swarm (or the seeder) writes appears live.

---

## 5. Seed the deterministic demo (the flawless on-camera run)

The replay harness materializes a real `ReplayFixture`
(`fixtures/superhuman.json`) into Convex in one atomic mutation — a completed
run, the lit-up swarm board, the brief, 3 communities, 5 intent-scored moat
threads, 3 approval-gated reply drafts, and the pre-rendered creative
(`/demo-ad.mp4`).

With `npx convex dev` running and `NEXT_PUBLIC_CONVEX_URL` set:

```bash
npm run seed
```

You'll get back a `runId`. Open that run on the board — it loads instantly,
makes **zero** live API calls, can't rate-limit, and looks identical every time.

Seed a different fixture:

```bash
npm run seed -- fixtures/<other>.json
```

### How the replay path works

- `fixtures/superhuman.json` — the recorded fixture (shape = `ReplayFixture` in
  `lib/contract.ts`).
- `scripts/seed-demo.ts` — validates the fixture, loads `.env.local`, and calls
  the public Convex mutation through `ConvexHttpClient`.
- `convex/seed.ts` → `seed.seedFixture` — the single public mutation that writes
  the run with `replay: true`, flips every agent on the board to `done`, and
  inserts the brief, communities, threads, drafts (`awaiting_approval`), and the
  creative. It is fully self-contained: it does **not** depend on the live agents
  or external services, which is exactly why the demo can't flop.

### Recording / rehearsing the on-camera run

1. Verify or tweak `fixtures/superhuman.json` (thread titles, snippets, intent
   scores, draft copy).
2. Drop the pre-rendered Veo clip at `public/demo-ad.mp4` so `/demo-ad.mp4`
   resolves.
3. `npm run seed` → copy the returned `runId`.
4. Load that run on the board and rehearse. Re-run `npm run seed` any time for a
   fresh, identical run.

---

## 6. Type-check (optional)

```bash
npm run typecheck
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `NEXT_PUBLIC_CONVEX_URL is not set` | Run `npx convex dev` and copy the URL into `.env.local`. |
| `Cannot find module '../convex/_generated/api'` | `npx convex dev` hasn't generated the API yet — start it and wait for the first sync. |
| `Convex mutation failed … convex/seed.ts` | Ensure `npx convex dev` is running and has deployed `convex/seed.ts` (watch its logs). |
| Video shows nothing on the board | Put the clip at `public/demo-ad.mp4` (the fixture's `creativeUrl`). |
| Live run is empty / rate-limited on stage | Use the replay: `npm run seed` — it bypasses every external API. |
