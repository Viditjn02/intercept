/**
 * HOLMES — DETERMINISTIC REPLAY SEEDER
 * ============================================================================
 * Reads a ReplayFixture JSON (see lib/contract.ts) and writes it into Convex
 * through the public `seed.seedFixture` mutation. The result is a fully
 * materialized run — completed board, brief, communities, the moat threads,
 * the human-approval drafts, and the pre-rendered creative — exactly as a
 * flawless live run would leave it, but instant and identical every time.
 *
 * THIS IS HOW WE RECORD THE FLAWLESS ON-CAMERA RUN.
 *   1. Build / verify the fixture (fixtures/superhuman.json).
 *   2. `npm run seed` (this script) -> get back a runId.
 *   3. Open the board for that runId on stage. It never hits a live API, never
 *      rate-limits, never returns an empty result. It cannot flop.
 *
 * Usage:
 *   npm run seed                          # seeds fixtures/superhuman.json
 *   npm run seed -- fixtures/<other>.json # seeds a different fixture
 *   tsx scripts/seed-demo.ts <path.json>
 *
 * Requires NEXT_PUBLIC_CONVEX_URL (populated by `npx convex dev`) in .env.local.
 * ============================================================================
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { ReplayFixture } from "../lib/contract";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_FIXTURE = resolve(PROJECT_ROOT, "fixtures/superhuman.json");

// ---------------------------------------------------------------------------
// Minimal .env loader (no dotenv dependency). Loads .env.local then .env;
// existing process.env values always win so CI / shell exports take precedence.
// ---------------------------------------------------------------------------
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Fixture validation — fail fast with a readable message before touching Convex.
// ---------------------------------------------------------------------------
const VALID_INTENT = new Set([
  "browsing",
  "comparing",
  "frustrated",
  "ready_to_buy",
]);

function fail(message: string): never {
  console.error(`\n✗ seed-demo: ${message}\n`);
  process.exit(1);
}

function validateFixture(data: unknown, source: string): ReplayFixture {
  if (typeof data !== "object" || data === null) {
    fail(`${source} is not a JSON object.`);
  }
  const f = data as Record<string, unknown>;

  if (typeof f.input !== "string" || f.input.length === 0) {
    fail(`${source}: "input" must be a non-empty string.`);
  }

  const enrich = f.enrich as Record<string, unknown> | undefined;
  if (
    !enrich ||
    typeof enrich.company !== "string" ||
    typeof enrich.icp !== "string" ||
    typeof enrich.positioning !== "string"
  ) {
    fail(`${source}: "enrich" must have company, icp, positioning strings.`);
  }

  if (!Array.isArray(f.communities) || f.communities.length === 0) {
    fail(`${source}: "communities" must be a non-empty array.`);
  }

  if (!Array.isArray(f.threads) || f.threads.length === 0) {
    fail(`${source}: "threads" must be a non-empty array (this is the moat).`);
  }
  f.threads.forEach((t: unknown, i: number) => {
    const th = t as Record<string, unknown>;
    if (typeof th.url !== "string" || !/^https?:\/\//.test(th.url as string)) {
      fail(`${source}: threads[${i}].url must be a real http(s) URL.`);
    }
    if (
      typeof th.intentScore !== "number" ||
      (th.intentScore as number) < 0 ||
      (th.intentScore as number) > 100
    ) {
      fail(`${source}: threads[${i}].intentScore must be 0-100.`);
    }
    if (!VALID_INTENT.has(th.intentLabel as string)) {
      fail(
        `${source}: threads[${i}].intentLabel must be one of ${[...VALID_INTENT].join(", ")}.`,
      );
    }
  });

  if (!Array.isArray(f.drafts)) {
    fail(`${source}: "drafts" must be an array.`);
  }

  if (typeof f.creativeUrl !== "string" || f.creativeUrl.length === 0) {
    fail(`${source}: "creativeUrl" must be a non-empty string.`);
  }

  return data as ReplayFixture;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  loadEnvFile(resolve(PROJECT_ROOT, ".env.local"));
  loadEnvFile(resolve(PROJECT_ROOT, ".env"));

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    fail(
      "NEXT_PUBLIC_CONVEX_URL is not set. Run `npx convex dev` once to create a " +
        "deployment, then copy the value into .env.local (see .env.example).",
    );
  }

  const argPath = process.argv[2];
  const fixturePath = argPath
    ? isAbsolute(argPath)
      ? argPath
      : resolve(process.cwd(), argPath)
    : DEFAULT_FIXTURE;

  if (!existsSync(fixturePath)) {
    fail(`Fixture not found: ${fixturePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (error) {
    fail(
      `Could not parse ${fixturePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const fixture = validateFixture(parsed, fixturePath);

  console.log("HOLMES deterministic replay seeder");
  console.log(`  fixture : ${fixturePath}`);
  console.log(`  company : ${fixture.enrich.company}`);
  console.log(`  convex  : ${convexUrl}`);
  console.log(
    `  payload : ${fixture.communities.length} communities, ${fixture.threads.length} threads, ${fixture.drafts.length} drafts`,
  );

  const client = new ConvexHttpClient(convexUrl);

  let result: { runId: string; counts: Record<string, number> };
  try {
    result = await client.mutation(api.seed.seedFixture, { fixture });
  } catch (error) {
    fail(
      `Convex mutation failed: ${
        error instanceof Error ? error.message : String(error)
      }\n  Is \`npx convex dev\` running and has it deployed convex/seed.ts?`,
    );
  }

  console.log("\n✓ Replay seeded.");
  console.log(`  runId   : ${result.runId}`);
  console.log(
    `  wrote   : ${result.counts.communities} communities, ${result.counts.threads} threads, ${result.counts.drafts} drafts`,
  );
  console.log(
    "\nOpen the app (npm run dev) and load this run on the board. It is fully\n" +
      "deterministic — no live API calls, nothing to rate-limit, it cannot flop.\n",
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
