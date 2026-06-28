// ============================================================================
// INTERCEPT — BREW EMAIL DESIGN CLIENT (branded HTML emails)
// ----------------------------------------------------------------------------
// Turns a plain cold-email draft (subject + body, optional brand) into a
// branded, email-safe HTML document. PRIMARY path: Brew's REST API with
// `Authorization: Bearer ${BREW_API_KEY}`. Meant to be a THIN client used by the
// convex email backend (convex/emailDesign.ts → sendDesigned), where the real
// key lives in the Convex env. It is also safe to import on the client for a
// live preview: there `process.env.BREW_API_KEY` is undefined, so designEmail
// simply returns the clean default template (no key leak, no crash).
//
// OFFICIAL APIs ONLY: every call is a plain fetch (no SDK, no vendored source,
// no extra npm deps) — global fetch + AbortController only, so it bundles
// cleanly in Convex's default action runtime AND in the browser.
//
// GRACEFUL DEGRADATION (must hold): with no BREW_API_KEY, or on ANY network /
// API / parse error, designEmail returns a clean default branded template with
// `degraded: true` and a human-readable `reason`. It NEVER throws, so it can
// never block the designer, the approval flow, or a send.
// ============================================================================

const DEFAULT_API_BASE = "https://api.usebrew.com";
const REQUEST_TIMEOUT_MS = 12_000;

// Light Figma palette (email clients can't resolve CSS vars, so these are the
// hex equivalents of the LIGHT theme tokens in app/globals.css).
const TPL = {
  canvas: "#ffffff",
  ink: "#1a1a1a",
  inkSoft: "#5b5b5b",
  surfaceSoft: "#f7f7f5",
  hairline: "#e6e6e6",
  accent: "#c8e6cd", // block-mint
} as const;

/** Resolve the API base (env override allowed for self-hosting/testing). */
function apiBase(): string {
  return (envVar("BREW_API_BASE") ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** Read an env var defensively — `process` may be absent in some bundles. */
function envVar(name: string): string | undefined {
  try {
    const val = typeof process !== "undefined" ? process.env?.[name] : undefined;
    return val && val.trim() ? val.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The bearer key, or null when the feature should silently degrade. */
function apiKey(): string | null {
  return envVar("BREW_API_KEY") ?? null;
}

/** True when a Brew key is present (server-side). Pure read, never throws. */
export function isBrewConfigured(): boolean {
  return apiKey() !== null;
}

// ---------------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------------

export interface BrandInfo {
  company?: string;
  /** Absolute https logo URL, shown in the header when present. */
  logoUrl?: string;
  /** Pastel accent (hex). Defaults to the Figma mint block. */
  accentHex?: string;
  /** Friendly sender name shown in the signature. */
  fromName?: string;
  websiteUrl?: string;
  /** Small print under the footer rule (e.g. address / unsubscribe note). */
  footerNote?: string;
}

/** Visual structure variant of the designed email. Drives both the live default
 *  template and the `layout` hint sent to Brew. */
export type EmailLayout = "minimal" | "branded" | "announcement";

/** Writing-tone hint forwarded to Brew. (No effect on the default template —
 *  Brew uses it to phrase/format on the server render.) */
export type EmailTone = "friendly" | "direct" | "formal" | "playful";

export interface DesignEmailArgs {
  subject: string;
  /** Plain-text draft — the cold-email copy a human approved. */
  body: string;
  brand?: BrandInfo;
  /** Visual structure variant. Defaults to "branded". */
  layout?: EmailLayout;
  /** Writing-tone hint for Brew's server render. */
  tone?: EmailTone;
  /** Optional single call-to-action button. */
  ctaLabel?: string;
  ctaUrl?: string;
  /** Reuse a previously saved Brew template id. */
  templateId?: string;
}

export interface DesignEmailResult {
  /** Always present — Brew's rendered HTML, or the default template. */
  html: string;
  /** True when the default template was used (no key / error). */
  degraded: boolean;
  reason?: string;
  /** Brew template id, when the API returned one. */
  templateId?: string;
  subject: string;
}

// ---------------------------------------------------------------------------
// Low-level REST call. Returns a structured result instead of throwing so
// callers can degrade gracefully. Times out via AbortController.
// ---------------------------------------------------------------------------

interface BrewResponse {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  error?: string;
}

async function request(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<BrewResponse> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, json: null, error: "BREW_API_KEY is not set" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null; // non-JSON / empty body — read defensively below
    }

    if (!res.ok) {
      const apiMessage =
        (json && (json.message as string)) ||
        (json && (json.error as string)) ||
        `Brew responded ${res.status}`;
      return { ok: false, status: res.status, json, error: apiMessage };
    }

    return { ok: true, status: res.status, json };
  } catch (err: unknown) {
    const reason =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Brew request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : err.message
        : "Brew request failed";
    return { ok: false, status: 0, json: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** First non-empty string field present, for tolerant response parsing. */
function pickString(
  json: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!json) return undefined;
  for (const k of keys) {
    const val = json[k];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// designEmail — the one entry point. Brew when keyed, default template always.
// ---------------------------------------------------------------------------

export async function designEmail(args: DesignEmailArgs): Promise<DesignEmailResult> {
  const subject = (args.subject ?? "").trim();
  const body = (args.body ?? "").trim();

  const fallback = (reason?: string): DesignEmailResult => ({
    html: defaultTemplate(args),
    degraded: true,
    reason,
    subject: subject || "(no subject)",
  });

  if (!isBrewConfigured()) return fallback("BREW_API_KEY is not set");
  if (!subject || !body) return fallback("designEmail needs a subject and body");

  const payload: Record<string, unknown> = { subject, body };
  if (args.layout) payload.layout = args.layout;
  if (args.tone) payload.tone = args.tone;
  if (args.templateId) payload.template_id = args.templateId;
  if (args.brand) {
    payload.brand = {
      company: args.brand.company,
      logo_url: args.brand.logoUrl,
      accent: args.brand.accentHex,
      from_name: args.brand.fromName,
      website_url: args.brand.websiteUrl,
      footer_note: args.brand.footerNote,
    };
  }
  if (args.ctaUrl) {
    payload.cta = { label: args.ctaLabel?.trim() || "Learn more", url: args.ctaUrl };
  }

  const res = await request("POST", "/v1/emails/design", payload);
  if (!res.ok) return fallback(res.error);

  const html = pickString(res.json, "html", "body_html", "rendered_html");
  if (!html) return fallback("Brew returned no HTML");

  return {
    html,
    degraded: false,
    templateId: pickString(res.json, "template_id", "id"),
    subject,
  };
}

// ---------------------------------------------------------------------------
// defaultTemplate — a clean, email-safe, light/Figma branded HTML email built
// from the draft. Table-based + inline styles so it survives email clients.
// User content is HTML-escaped (never trust the draft body). Never throws.
// ---------------------------------------------------------------------------

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Turn a plain-text body into escaped <p>/<br> paragraph blocks. */
function bodyToHtml(body: string): string {
  const blocks = body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const paras = blocks.length > 0 ? blocks : ["(no body)"];
  return paras
    .map(
      (block) =>
        `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${TPL.ink};">${escapeHtml(
          block,
        ).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export function defaultTemplate(args: DesignEmailArgs): string {
  const subjectRaw = (args.subject ?? "").trim() || "(no subject)";
  const subject = escapeHtml(subjectRaw);
  const body = (args.body ?? "").trim();
  const bodyHtml = bodyToHtml(body);
  const brand = args.brand ?? {};
  const layout: EmailLayout = args.layout ?? "branded";

  const accent =
    typeof brand.accentHex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(brand.accentHex.trim())
      ? brand.accentHex.trim()
      : TPL.accent;
  const company = brand.company ? escapeHtml(brand.company) : "";
  const fromName = brand.fromName ? escapeHtml(brand.fromName) : "";
  const footerNote = brand.footerNote ? escapeHtml(brand.footerNote) : "";
  const safeLogo =
    typeof brand.logoUrl === "string" && /^https:\/\//i.test(brand.logoUrl.trim())
      ? brand.logoUrl.trim()
      : "";
  const safeSite =
    typeof brand.websiteUrl === "string" && /^https?:\/\//i.test(brand.websiteUrl.trim())
      ? brand.websiteUrl.trim()
      : "";

  const ctaUrl =
    args.ctaUrl && /^https?:\/\//i.test(args.ctaUrl.trim()) ? args.ctaUrl.trim() : "";
  const ctaLabel = escapeHtml((args.ctaLabel ?? "Learn more").trim() || "Learn more");

  /** A single CTA button, colored per layout. Empty when no URL is set. */
  const ctaButton = (bg: string, color: string): string =>
    ctaUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:8px 0 2px 0;">
           <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${bg};color:${color};text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:50px;">${ctaLabel}</a>
         </td></tr></table>`
      : "";

  const logoOrCompany = safeLogo
    ? `<img src="${escapeHtml(safeLogo)}" alt="${company || "logo"}" height="28" style="display:block;height:28px;border:0;outline:none;" />`
    : company
      ? `<span style="font-size:16px;font-weight:600;color:${TPL.ink};letter-spacing:-0.2px;">${company}</span>`
      : "";

  const signature = fromName
    ? `<p style="margin:18px 0 0 0;font-size:15px;line-height:1.6;color:${TPL.ink};">— ${fromName}${
        company ? `, ${company}` : ""
      }</p>`
    : "";

  const footerSite = safeSite
    ? `<a href="${escapeHtml(safeSite)}" style="color:${TPL.inkSoft};text-decoration:none;">${escapeHtml(
        safeSite.replace(/^https?:\/\//i, "").replace(/\/$/, ""),
      )}</a>`
    : "";
  const footerLine = `${footerSite}${footerSite && footerNote ? " · " : ""}${footerNote}`;

  /** Document shell shared by every layout. */
  const shell = (inner: string, pageBg: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:${pageBg};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        ${inner}
        <p style="margin:16px 0 0 0;font-size:11px;color:${TPL.inkSoft};font-family:${FONT};">
          Designed with care · INTERCEPT
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // ── MINIMAL — a clean, text-forward letter: no card chrome, the accent shows
  //    only as a small rule under the subject + the CTA fill. ─────────────────
  if (layout === "minimal") {
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:${TPL.canvas};font-family:${FONT};">
          ${
            logoOrCompany
              ? `<tr><td style="padding:6px 4px 0 4px;">${logoOrCompany}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:${logoOrCompany ? "18px" : "6px"} 4px 0 4px;">
              <h1 style="margin:0 0 6px 0;font-size:19px;line-height:1.3;font-weight:600;color:${TPL.ink};letter-spacing:-0.3px;">${subject}</h1>
              <div style="width:40px;height:3px;background:${accent};border-radius:3px;line-height:3px;font-size:3px;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 4px 8px 4px;">
              ${bodyHtml}
              ${ctaButton(TPL.ink, "#ffffff")}
              ${signature}
            </td>
          </tr>
          ${
            footerLine.trim()
              ? `<tr><td style="padding:18px 4px 0 4px;">
                   <div style="border-top:1px solid ${TPL.hairline};padding-top:12px;">
                     <p style="margin:0;font-size:12px;line-height:1.5;color:${TPL.inkSoft};">${footerLine}</p>
                   </div>
                 </td></tr>`
              : ""
          }
        </table>`;
    return shell(inner, TPL.canvas);
  }

  // ── ANNOUNCEMENT — a bold accent header band with the subject reversed on the
  //    accent, then a centered CTA. Reads like a product/launch announcement. ─
  if (layout === "announcement") {
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${TPL.canvas};border:1px solid ${TPL.hairline};border-radius:16px;overflow:hidden;font-family:${FONT};">
          <tr>
            <td style="background:${accent};padding:30px 32px;text-align:center;">
              ${logoOrCompany ? `<div style="margin-bottom:12px;">${logoOrCompany}</div>` : ""}
              <h1 style="margin:0;font-size:24px;line-height:1.25;font-weight:700;color:${TPL.ink};letter-spacing:-0.4px;">${subject}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 32px 8px 32px;">
              ${bodyHtml}
              <div style="text-align:center;">${ctaButton(TPL.ink, "#ffffff")}</div>
              ${signature}
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px;"><div style="border-top:1px solid ${TPL.hairline};"></div></td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px 32px;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:${TPL.inkSoft};">${footerLine}</p>
            </td>
          </tr>
        </table>`;
    return shell(inner, TPL.surfaceSoft);
  }

  // ── BRANDED (default) — accent top rule, logo header, rounded card. ─────────
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${TPL.canvas};border:1px solid ${TPL.hairline};border-radius:16px;overflow:hidden;font-family:${FONT};">
          <tr>
            <td style="height:6px;background:${accent};line-height:6px;font-size:6px;">&nbsp;</td>
          </tr>
          ${
            logoOrCompany
              ? `<tr><td style="padding:24px 32px 0 32px;">${logoOrCompany}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:${logoOrCompany ? "16px" : "28px"} 32px 8px 32px;">
              <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:600;color:${TPL.ink};letter-spacing:-0.3px;">${subject}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px 32px;">
              ${bodyHtml}
              ${ctaButton(TPL.ink, "#ffffff")}
              ${signature}
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px;"><div style="border-top:1px solid ${TPL.hairline};"></div></td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px 32px;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:${TPL.inkSoft};">${footerLine}</p>
            </td>
          </tr>
        </table>`;
  return shell(inner, TPL.surfaceSoft);
}
