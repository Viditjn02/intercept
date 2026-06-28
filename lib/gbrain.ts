// ============================================================================
// INTERCEPT — GBRAIN CLIENT (compounding knowledge)
// gbrain is a LOCAL CLI (a personal knowledge brain) on PATH at ~/.bun/bin/gbrain.
// We treat it as an external dependency and shell out to it — we NEVER bundle its
// source. Every INTERCEPT run can ask the brain what it already knows about a
// market (brainQuery) and write durable findings back (brainPut), so knowledge
// compounds across runs.
//
// GRACEFUL DEGRADATION: if the CLI is not installed / not resolvable, every entry
// point no-ops — brainAvailable() -> false, brainQuery() -> {available:false},
// brainPut() -> false. Nothing here ever throws, so it can never block a swarm or
// a brief render.
//
// node:child_process + node:fs only (no new deps). Server-side only (Next.js
// "nodejs" runtime / Node actions) — never imported into the browser bundle.
// ============================================================================

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const QUERY_TIMEOUT_MS = 25_000;
const PUT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1MB cap on CLI stdout

// gbrain prints this when a query has no hits — treat it as "available but empty".
const NO_RESULTS_RE = /^no results\.?$/i;

/**
 * Resolve an absolute path to the gbrain executable, or null if it can't be
 * found. Order: explicit GBRAIN_BIN override, the documented ~/.bun/bin install,
 * a couple of common global locations, then a scan of $PATH. We resolve to an
 * absolute path so this works even when the Node/Next.js process inherits a
 * trimmed PATH that omits ~/.bun/bin.
 */
function resolveBin(): string | null {
  const candidates: string[] = [];

  const override = process.env.GBRAIN_BIN?.trim();
  if (override) candidates.push(override);

  const home = homedir();
  if (home) {
    candidates.push(join(home, ".bun", "bin", "gbrain"));
    candidates.push(join(home, ".local", "bin", "gbrain"));
  }
  candidates.push("/usr/local/bin/gbrain", "/opt/homebrew/bin/gbrain");

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const trimmed = dir.trim();
    if (trimmed) candidates.push(join(trimmed, "gbrain"));
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable candidate, keep scanning
    }
  }
  return null;
}

/**
 * True when the gbrain CLI is resolvable on this host. Cheap, synchronous,
 * filesystem-only — safe to call on a hot path. Never throws.
 */
export function brainAvailable(): boolean {
  try {
    return resolveBin() !== null;
  } catch {
    return false;
  }
}

export interface BrainQueryResult {
  /** False when the CLI is missing or the query failed — caller should no-op. */
  available: boolean;
  /** Synthesized answer text (empty string when there were no results). */
  answer: string;
}

/**
 * Ask the brain what it already knows. Runs `gbrain query "<question>"` and
 * returns the synthesized answer. If the CLI is missing or errors for any
 * reason, returns { available: false, answer: "" } — never throws.
 */
export function brainQuery(question: string): Promise<BrainQueryResult> {
  return new Promise((resolve) => {
    const bin = resolveBin();
    // Strip leading dashes/space so a question beginning with "-"/"--" can't be
    // smuggled to the gbrain CLI as a flag (argv flag injection). execFile already
    // prevents shell injection (array args, no shell); this closes the flag vector
    // without depending on gbrain supporting a "--" options terminator.
    const safeQuestion = (question ?? "").trim().replace(/^[-\s]+/, "").trim();
    if (!bin || !safeQuestion) {
      resolve({ available: false, answer: "" });
      return;
    }

    let settled = false;
    const done = (result: BrainQueryResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      execFile(
        bin,
        ["query", trimmed],
        {
          timeout: QUERY_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout) => {
          // A non-zero exit / timeout means we couldn't get an answer. Degrade
          // gracefully rather than surfacing CLI noise into the brief.
          if (error) {
            done({ available: false, answer: "" });
            return;
          }
          const out = (stdout ?? "").toString().trim();
          const answer = NO_RESULTS_RE.test(out) ? "" : out;
          done({ available: true, answer });
        },
      );
    } catch {
      done({ available: false, answer: "" });
    }
  });
}

/**
 * Write durable knowledge back to the brain by piping markdown to
 * `gbrain put <slug>`. Returns true on success, false if the CLI is missing or
 * the write failed. Never throws.
 */
export function brainPut(slug: string, markdown: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bin = resolveBin();
    const cleanSlug = (slug ?? "").trim();
    const content = markdown ?? "";
    if (!bin || !cleanSlug || !content.trim()) {
      resolve(false);
      return;
    }

    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const child = spawn(bin, ["put", cleanSlug], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        done(false);
      }, PUT_TIMEOUT_MS);

      child.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0);
      });

      // Pipe the markdown to stdin; ignore EPIPE if the child closed early.
      child.stdin.on("error", () => {});
      child.stdin.end(content);
    } catch {
      done(false);
    }
  });
}
