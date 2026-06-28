// ============================================================================
// INTERCEPT — LINK SCAN  ·  "drop a link, break it down"
// ----------------------------------------------------------------------------
// A single public action — `breakdown({ url })` — that turns any dropped URL into
// an actionable creative brief:
//
//   1) READ the link via Supadata (lib/supadata):
//        • video URLs (YouTube / TikTok / IG reels / X / Vimeo) → transcript
//        • everything else (articles, competitor / landing pages) → clean scrape
//   2) DISTILL the text with OpenAI (lib/openai.chatJSON) into:
//        { source, kind, summary, angles[], hooks[] }
//
// GRACEFUL BY CONTRACT — it NEVER throws past the handler. Missing Supadata key,
// missing OpenAI key, an unreadable link, an exhausted free-tier budget, or a bad
// URL all degrade to a clean "couldn't break this down" state (`ok:false`,
// `degraded:true`, a friendly `note`) instead of an error. When the link reads
// but OpenAI is off, we still hand back a light summary so the panel shows life.
//
// RUNTIME: default action runtime (NOT "use node"). lib/supadata is fetch-based
// and lib/openai is the fetch-based OpenAI SDK — both run here, like the other
// agents. Bound from the UI via makeFunctionReference("linkScan:breakdown").
// ============================================================================

import { v } from "convex/values";
import { action } from "./_generated/server";
import { supadata, isVideoUrl } from "../lib/supadata";
import { chatJSON } from "../lib/openai";

/** What `breakdown` distils a dropped link into — the UI's contract. */
export interface LinkBreakdownResult {
  /** The URL that was broken down (echoed back so the UI can link to it). */
  source: string;
  /** What kind of source it was. */
  kind: "video" | "article" | "unknown";
  /** A tight 1-3 sentence distillation of what the link is about. */
  summary: string;
  /** Reusable creative angles the marketer can borrow. */
  angles: string[];
  /** Scroll-stopping hook lines, in the source's own energy. */
  hooks: string[];
  /** True when we produced a full AI breakdown. */
  ok: boolean;
  /** True when this is a partial / no-op result (see `note`). */
  degraded: boolean;
  /** Friendly, human-readable reason when degraded. */
  note?: string;
}

const MAX_CONTENT_CHARS = 6000;

export const breakdown = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }): Promise<LinkBreakdownResult> => {
    const clean = (url ?? "").trim();

    // --- Guard: a real http(s) URL -----------------------------------------
    if (!/^https?:\/\//i.test(clean)) {
      return degraded(
        clean,
        "unknown",
        "Paste a full link (starting with https://) to break it down.",
      );
    }

    const kind: LinkBreakdownResult["kind"] = isVideoUrl(clean) ? "video" : "article";

    // --- 1) READ the link (transcript for video, scrape otherwise) ---------
    let content = "";
    let title: string | undefined;
    try {
      if (kind === "video") {
        const tx = await supadata.transcript(clean);
        if (tx.ok && tx.data?.text) {
          content = tx.data.text;
        } else {
          // Transcript unavailable — try a plain scrape of the page as a fallback.
          const page = await supadata.webScrape(clean);
          if (page.ok && page.data) {
            content = page.data.markdown;
            title = page.data.title;
          } else {
            return readFailureNote(clean, kind, tx.reason);
          }
        }
      } else {
        const page = await supadata.webScrape(clean);
        if (page.ok && page.data) {
          content = page.data.markdown;
          title = page.data.title;
        } else {
          return readFailureNote(clean, kind, page.reason);
        }
      }
    } catch {
      // Supadata never throws, but guard anyway — never surface an error.
      return degraded(clean, kind, "Couldn't read this link right now.");
    }

    const trimmed = content.replace(/\s+/g, " ").trim().slice(0, MAX_CONTENT_CHARS);
    if (!trimmed) {
      return degraded(clean, kind, "This link didn't have any readable content.");
    }

    // --- 2) No OpenAI key → hand back a light summary, honestly degraded ----
    if (!process.env.OPENAI_API_KEY) {
      const lite = (title ? `${title} — ` : "") + trimmed.slice(0, 280).trim();
      return {
        source: clean,
        kind,
        summary: lite + (trimmed.length > 280 ? "…" : ""),
        angles: [],
        hooks: [],
        ok: false,
        degraded: true,
        note: "Connect an OpenAI key to distil angles & hooks.",
      };
    }

    // --- 3) DISTIL with OpenAI → summary + angles + hooks ------------------
    try {
      const distilled = await distil(trimmed, kind, title);
      return { source: clean, kind, ...distilled, ok: true, degraded: false };
    } catch {
      return degraded(clean, kind, "Couldn't break this down right now — try again.");
    }
  },
});

// ----------------------------------------------------------------------------
// OpenAI distillation — a tight, validator-safe creative brief from the content.
// ----------------------------------------------------------------------------
interface Distilled {
  summary: string;
  angles: string[];
  hooks: string[];
}

async function distil(
  content: string,
  kind: "video" | "article" | "unknown",
  title?: string,
): Promise<Distilled> {
  const system = [
    "You are a sharp content strategist who reverse-engineers what makes a piece of content work.",
    "Given a transcript or article, distil it into a brief a marketer can act on immediately.",
    "Be concrete and specific to THIS content — no generic filler, no fabricated claims.",
  ].join(" ");

  const user = [
    title ? `Title: ${title}` : "",
    `Source kind: ${kind}`,
    "",
    "Content:",
    content,
    "",
    "Distil this into:",
    "- summary: 1-3 tight sentences on what it's about and why it lands.",
    "- angles: 3-5 reusable creative angles a marketer could borrow.",
    "- hooks: 3-5 scroll-stopping opening lines, in the source's own energy.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const schemaHint = `{
  "summary": "string",
  "angles": ["string", "..."],
  "hooks": ["string", "..."]
}`;

  const raw = await chatJSON<Record<string, unknown>>({
    system,
    user,
    schemaHint,
    temperature: 0.5,
    maxTokens: 700,
  });

  return {
    summary: asString(raw.summary, "A breakdown of the dropped link."),
    angles: asStringArray(raw.angles),
    hooks: asStringArray(raw.hooks),
  };
}

// ----------------------------------------------------------------------------
// helpers — coercion + graceful degrade states
// ----------------------------------------------------------------------------
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, 6);
}

/** A clean "couldn't break this down" state — never an error. */
function degraded(
  source: string,
  kind: LinkBreakdownResult["kind"],
  note: string,
): LinkBreakdownResult {
  return { source, kind, summary: "", angles: [], hooks: [], ok: false, degraded: true, note };
}

/** Map a Supadata read failure into a friendly degrade note. */
function readFailureNote(
  source: string,
  kind: LinkBreakdownResult["kind"],
  reason: string,
): LinkBreakdownResult {
  const note =
    reason === "no_api_key"
      ? "Connect a Supadata key to read links."
      : reason === "budget_exhausted"
        ? "Transcript budget reached for this session — try an article link."
        : reason === "rate_limited"
          ? "Rate-limited for a moment — try again shortly."
          : "Couldn't read this link.";
  return degraded(source, kind, note);
}
