// ============================================================================
// INTERCEPT — ORANGE SLICE ENRICHMENT CLIENT
//
// HONEST SCOPE NOTE: Orange Slice is FIRMOGRAPHIC ENRICHMENT only — it tells us
// who the company is (industry, size, description) so the Enrich agent can shape
// the ICP/positioning brief. It is NOT the on-camera thread source. THE MOAT —
// the real, clickable, intent-scored LIVE conversations — comes from Exa
// (lib/exa.ts), never from here. Keep that separation clear in the demo.
//
// If ORANGESLICE_API_KEY is set we hit the Orange Slice enrichment API.
// Otherwise we fall back to a documented HTTP scrape: fetch the company's
// homepage and parse <title> / <meta description> / og: tags for a best-effort
// firmographic guess. The fallback keeps the swarm running on a bare key set.
// ============================================================================

import { safeFetch } from "./safeFetch";

const ORANGESLICE_BASE_URL =
  process.env.ORANGESLICE_BASE_URL ?? "https://api.orangeslice.ai/v1";

export interface Firmographics {
  domain: string;
  name?: string;
  description?: string;
  industry?: string;
  employeeCount?: string;
  location?: string;
  /** Where the data came from: the enrichment API or the HTML fallback. */
  source: "orangeslice" | "html-fallback";
}

/** Normalize raw user input into a bare domain (no scheme, no path, no www). */
function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/^www\./, "");
  domain = domain.split("/")[0].split("?")[0];
  return domain;
}

function pickMeta(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/\s+/g, " ").trim();
    }
  }
  return undefined;
}

/**
 * Documented HTTP fallback: fetch the homepage and parse meta tags. Best-effort
 * only — returns whatever firmographic signal the HTML exposes.
 */
async function enrichViaHtml(domain: string): Promise<Firmographics> {
  const url = `https://${domain}`;
  let html = "";
  try {
    // SSRF guard: `domain` is user-supplied. safeFetch rejects private/loopback/
    // metadata hosts and re-validates redirects before reading any bytes.
    const resp = await safeFetch(url, {
      headers: { "user-agent": "InterceptBot/1.0 (+enrichment)" },
    });
    if (resp.ok) {
      html = await resp.text();
    }
  } catch {
    // Site unreachable — return the domain alone rather than throwing, so the
    // swarm's Enrich agent can still proceed with a minimal brief.
    return { domain, source: "html-fallback" };
  }

  const title = pickMeta(html, [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ]);
  const description = pickMeta(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ]);

  return {
    domain,
    name: title,
    description,
    source: "html-fallback",
  };
}

/**
 * Enrich a company domain into firmographics. Prefers the Orange Slice API when
 * a key is present; otherwise uses the documented HTML fallback.
 */
export async function enrichCompany(domain: string): Promise<Firmographics> {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    throw new Error("enrichCompany requires a non-empty domain.");
  }

  const apiKey = process.env.ORANGESLICE_API_KEY;
  if (!apiKey) {
    // No key configured — documented fallback path.
    return enrichViaHtml(normalized);
  }

  try {
    const resp = await fetch(
      `${ORANGESLICE_BASE_URL}/enrich?domain=${encodeURIComponent(normalized)}`,
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      },
    );

    if (!resp.ok) {
      // API failed (rate limit / unknown domain) — degrade gracefully.
      return enrichViaHtml(normalized);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return {
      domain: normalized,
      name: (data.name as string) ?? (data.company_name as string) ?? undefined,
      description: (data.description as string) ?? undefined,
      industry: (data.industry as string) ?? undefined,
      employeeCount:
        (data.employee_count as string) ?? (data.size as string) ?? undefined,
      location: (data.location as string) ?? undefined,
      source: "orangeslice",
    };
  } catch {
    return enrichViaHtml(normalized);
  }
}
