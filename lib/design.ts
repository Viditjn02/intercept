// ============================================================================
// INTERCEPT — IN-HOUSE DESIGN GENERATION (AI Ad Factories)
//
// From the GTM brief + the buyers' OWN language (mined from the moat threads),
// generate a brand-consistent, single-file campaign landing page plus a set of
// ad-copy headline variants. Everything is produced by OpenAI (gpt-4o-mini)
// through lib/openai — no external assets, no second service.
//
// Design philosophy (original, inspired by — not copied from — open-design's
// structured DESIGN.md prompting): we hand the model a tight rubric (atmosphere,
// a single accent, restrained type scale, generous whitespace, one decisive CTA)
// and force it to echo the buyers' verbatim phrasing in the headline + section
// copy. The result is a modern, responsive page whose words sound like the
// people INTERCEPT found mid-conversation.
//
// GRACEFUL DEGRADATION: if OPENAI_API_KEY is missing (or any call fails) this
// NEVER throws — it returns a clean, on-brief static fallback so the board still
// renders a real landing page and three headline variants.
// ============================================================================

import { chatText, chatJSON } from "./openai";

// ----------------------------------------------------------------------------
// Public interface (the integrator + the designer agent build against this).
// ----------------------------------------------------------------------------
export interface GenerateLandingInput {
  /** Resolved company name (e.g. "Superhuman"). */
  company: string;
  /** Ideal Customer Profile, from the brief. */
  icp: string;
  /** Market positioning, from the brief. */
  positioning: string;
  /**
   * The buyers' own words — short phrases / thread titles mined from the moat.
   * Drives the headline + section copy so the page speaks their language.
   */
  buyerLanguage: string[];
}

export interface GenerateLandingResult {
  /** A short, buyer-voiced page title (used as the design row title). */
  title: string;
  /** Self-contained responsive landing page: inline CSS, no external assets. */
  html: string;
  /** Three ad-copy headline variants, newline-separated ("1. …\n2. …\n3. …"). */
  copy: string;
}

const MODEL = "gpt-4o-mini";
const MAX_BUYER_PHRASES = 6;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** True only when an OpenAI key is present — gate every model call on this. */
function hasKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** Minimal HTML escaping for any model/brief text injected into the fallback. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Clean + de-duplicate + cap the buyer phrases we feed the model. */
function normalizeBuyerLanguage(phrases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phrases) {
    const phrase = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase.slice(0, 160));
    if (out.length >= MAX_BUYER_PHRASES) break;
  }
  return out;
}

/**
 * Pull the document title out of generated HTML so the design row gets a
 * buyer-voiced title even when the model didn't return one separately.
 */
function titleFromHtml(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title && title.length > 0 ? title.slice(0, 120) : fallback;
}

// ----------------------------------------------------------------------------
// Static fallback — a real, modern, responsive landing page with zero API calls.
// Used when there's no key or the model call fails. Never throws.
// ----------------------------------------------------------------------------
function fallbackLanding(input: GenerateLandingInput): GenerateLandingResult {
  const { company, icp, positioning } = input;
  const phrases = normalizeBuyerLanguage(input.buyerLanguage);
  const hero =
    phrases[0] ??
    `${company}: the answer your buyers are already searching for`;
  const subhead =
    positioning?.trim() ||
    `Built for the people who keep asking the question ${company} answers.`;

  const painPoints =
    phrases.length > 0
      ? phrases.slice(0, 3)
      : [
          "You've outgrown the workaround.",
          "The status quo costs you more every week.",
          "You want a fix that just works.",
        ];

  const painCards = painPoints
    .map(
      (p) => `        <article class="card">
          <span class="quote-mark">&ldquo;</span>
          <p class="card-text">${esc(p)}</p>
        </article>`,
    )
    .join("\n");

  const title = `${company} — landing page`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(company)} — for the people already asking</title>
<style>
  :root {
    --ink: #0e1116;
    --muted: #5b6472;
    --bg: #fbfbfd;
    --panel: #ffffff;
    --accent: #5b5bff;
    --accent-soft: #ececff;
    --line: #e7e8ee;
    --radius: 16px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink);
    background: var(--bg);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  header.nav { display: flex; align-items: center; justify-content: space-between; padding: 22px 0; }
  .brand { font-weight: 700; font-size: 18px; letter-spacing: -0.02em; }
  .nav a.cta { background: var(--ink); color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 999px; font-size: 14px; font-weight: 600; }
  .hero { padding: 72px 0 56px; text-align: center; }
  .eyebrow { display: inline-block; background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 600; padding: 6px 14px; border-radius: 999px; margin-bottom: 22px; }
  .hero h1 { font-size: clamp(34px, 6vw, 60px); line-height: 1.04; letter-spacing: -0.03em; max-width: 14ch; margin: 0 auto 20px; }
  .hero p.lede { font-size: clamp(17px, 2.4vw, 21px); color: var(--muted); max-width: 60ch; margin: 0 auto 32px; }
  .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .btn { text-decoration: none; font-weight: 600; font-size: 16px; padding: 14px 26px; border-radius: 12px; }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.ghost { background: var(--panel); color: var(--ink); border: 1px solid var(--line); }
  section.band { padding: 56px 0; }
  .section-title { font-size: clamp(24px, 4vw, 34px); letter-spacing: -0.02em; text-align: center; margin-bottom: 8px; }
  .section-sub { text-align: center; color: var(--muted); max-width: 56ch; margin: 0 auto 36px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 26px; position: relative; }
  .quote-mark { color: var(--accent); font-size: 40px; line-height: 1; font-weight: 700; }
  .card-text { font-size: 17px; margin-top: 6px; }
  .closer { background: var(--ink); color: #fff; border-radius: 22px; padding: 56px 32px; text-align: center; margin: 40px 0 64px; }
  .closer h2 { font-size: clamp(26px, 4vw, 38px); letter-spacing: -0.02em; margin-bottom: 14px; }
  .closer p { color: #b9c0cc; max-width: 52ch; margin: 0 auto 26px; }
  .closer .btn.primary { background: #fff; color: var(--ink); }
  footer { text-align: center; color: var(--muted); font-size: 13px; padding: 28px 0 48px; }
  @media (max-width: 640px) { .hero { padding: 48px 0 40px; } }
</style>
</head>
<body>
  <div class="wrap">
    <header class="nav">
      <span class="brand">${esc(company)}</span>
      <a class="cta" href="#start">Get started</a>
    </header>

    <section class="hero">
      <span class="eyebrow">For ${esc(icp ? icp.split(/[.,]/)[0].slice(0, 48) : "your team")}</span>
      <h1>${esc(hero)}</h1>
      <p class="lede">${esc(subhead)}</p>
      <div class="actions">
        <a class="btn primary" href="#start">Start free</a>
        <a class="btn ghost" href="#how">See how it works</a>
      </div>
    </section>
  </div>

  <section class="band" id="how" style="background:var(--panel);border-top:1px solid var(--line);border-bottom:1px solid var(--line);">
    <div class="wrap">
      <h2 class="section-title">In their words</h2>
      <p class="section-sub">The exact things your buyers are already saying — and what ${esc(company)} does about each one.</p>
      <div class="cards">
${painCards}
      </div>
    </div>
  </section>

  <div class="wrap">
    <div class="closer" id="start">
      <h2>Stop searching. Start with ${esc(company)}.</h2>
      <p>${esc(positioning || `${company} meets your buyers exactly where the question gets asked.`)}</p>
      <a class="btn primary" href="#start">Get started today</a>
    </div>
  </div>

  <footer class="wrap">© ${new Date().getFullYear()} ${esc(company)} · This campaign page was generated by INTERCEPT.</footer>
</body>
</html>`;

  const copy = [
    `1. ${hero}`,
    `2. ${company}: ${painPoints[0] ?? "the fix you've been asking for"}`,
    `3. Finally — ${positioning?.split(/[.,]/)[0]?.trim() || `${company} done right`}.`,
  ].join("\n");

  return { title, html, copy };
}

// ----------------------------------------------------------------------------
// Ad-copy variants — three distinct headline angles in the buyers' voice.
// ----------------------------------------------------------------------------
interface AdCopyOutput {
  variants?: unknown;
}

async function generateAdCopy(input: GenerateLandingInput): Promise<string | null> {
  const phrases = normalizeBuyerLanguage(input.buyerLanguage);
  try {
    const result = await chatJSON<AdCopyOutput>({
      model: MODEL,
      temperature: 0.8,
      maxTokens: 400,
      system:
        "You are a senior direct-response copywriter. You write ad headlines " +
        "that mirror the customer's own words back to them — concrete, " +
        "punchy, no jargon, no exclamation-mark spam. Each headline is a " +
        "single line under 90 characters.",
      user: [
        `Company: ${input.company}`,
        `Positioning: ${input.positioning || "(not provided)"}`,
        `Ideal customer: ${input.icp || "(not provided)"}`,
        phrases.length
          ? `Buyers are literally saying:\n${phrases.map((p) => `- ${p}`).join("\n")}`
          : "No verbatim buyer quotes available — infer their pain from the positioning.",
        "",
        "Write THREE distinct ad headlines, each a different angle:",
        "  1) pain-mirror (echo their frustration),",
        "  2) outcome (the after-state they want),",
        "  3) bold contrarian hook.",
      ].join("\n"),
      schemaHint: '{ "variants": ["headline 1", "headline 2", "headline 3"] }',
    });

    const variants = Array.isArray(result.variants)
      ? result.variants
          .map((v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""))
          .filter(Boolean)
          .slice(0, 3)
      : [];

    if (variants.length === 0) return null;
    return variants.map((v, i) => `${i + 1}. ${v}`).join("\n");
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Landing-page HTML — the model returns a complete single-file document.
// ----------------------------------------------------------------------------
async function generateLandingHtml(
  input: GenerateLandingInput,
): Promise<string | null> {
  const phrases = normalizeBuyerLanguage(input.buyerLanguage);
  try {
    const html = await chatText(
      [
        "You are an elite product designer + front-end engineer who ships",
        "conversion-grade marketing pages. You output ONE complete, valid HTML5",
        "document and NOTHING else (no markdown fences, no commentary).",
        "",
        "Hard design rules:",
        "- Single self-contained file. All CSS inline in one <style> block.",
        "- NO external assets: no <img> with remote src, no web fonts, no CDN,",
        "  no <script>. Use system font stacks and pure CSS for any visuals.",
        "- Modern, clean, generous whitespace, ONE accent color used sparingly,",
        "  a restrained type scale, fully responsive (CSS clamp + flex/grid,",
        "  a mobile breakpoint).",
        "- Structure: sticky-free top bar with brand + CTA, a hero (eyebrow,",
        "  big headline, sub-headline, primary + secondary CTA), a 3-card",
        "  'in their words' section, a benefits/how-it-works band, a bold final",
        "  CTA band, and a small footer.",
        "- VOICE: the headline and section copy must reuse the buyers' OWN",
        "  phrasing below. Sound like the people who wrote those quotes.",
        "- Put a short, buyer-voiced page title in <title>.",
      ].join("\n"),
      [
        `Company: ${input.company}`,
        `Positioning: ${input.positioning || "(not provided)"}`,
        `Ideal customer profile: ${input.icp || "(not provided)"}`,
        phrases.length
          ? `The buyers' own words (mirror these in the copy):\n${phrases
              .map((p) => `- ${p}`)
              .join("\n")}`
          : "No verbatim buyer quotes available — write the copy from the positioning and ICP.",
        "",
        `Generate the complete landing page for ${input.company} now.`,
      ].join("\n"),
      { model: MODEL, temperature: 0.65, maxTokens: 3200 },
    );

    // Strip any stray markdown fences and ensure we actually got a document.
    const cleaned = html
      .replace(/^```(?:html)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    if (!/<html[\s>]/i.test(cleaned) || !/<\/html>/i.test(cleaned)) {
      return null;
    }
    return cleaned;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// PUBLIC: generate the landing page + ad copy. Never throws.
// ----------------------------------------------------------------------------
export async function generateLanding(
  input: GenerateLandingInput,
): Promise<GenerateLandingResult> {
  const company = input.company?.trim() || "Your company";
  const safeInput: GenerateLandingInput = {
    company,
    icp: input.icp ?? "",
    positioning: input.positioning ?? "",
    buyerLanguage: Array.isArray(input.buyerLanguage) ? input.buyerLanguage : [],
  };

  // No key → deterministic, on-brief fallback. No network, no throw.
  if (!hasKey()) {
    return fallbackLanding(safeInput);
  }

  const fallback = fallbackLanding(safeInput);

  // Generate page + copy concurrently; either can independently fall back.
  const [html, copy] = await Promise.all([
    generateLandingHtml(safeInput),
    generateAdCopy(safeInput),
  ]);

  const finalHtml = html ?? fallback.html;
  return {
    title: titleFromHtml(finalHtml, fallback.title),
    html: finalHtml,
    copy: copy ?? fallback.copy,
  };
}
