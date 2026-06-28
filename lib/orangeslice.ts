// ============================================================================
// INTERCEPT — ORANGE SLICE ENRICHMENT + SOURCING + SIGNAL ENGINE  (REAL DATA)
// ----------------------------------------------------------------------------
// This talks to the REAL Orange Slice backend (our #1 sponsor + organizer). The
// `orangeslice` npm package wraps POST calls to an "execute" gateway; we call
// that gateway DIRECTLY via fetch instead of importing the package, because the
// package pulls in Node-only `node:async_hooks` (AsyncLocalStorage) and would
// break the Convex default-runtime bundle (same class of bug that bit us with
// node:dns). Direct fetch over the documented endpoints sidesteps that entirely.
//
//   Base URL : https://enrichly-production.up.railway.app   (ORANGESLICE_BASE_URL)
//   Auth     : Authorization: Bearer ${ORANGESLICE_API_KEY}
//   Transport: POST <endpoint> { ...payload, inlineWaitMs }. If the gateway
//              replies `{ pending: true, requestId | pollUrl }` we poll
//              /function/result/:requestId until it resolves (bounded).
//
// REAL endpoints wired (path == the value the SDK passes to its post() helper):
//   • enrichCompany(domain)        → POST /execute/sql            (b2b LinkedIn
//        firmographics: linkedin_company ⋈ lkd_company by domain — the SDK's
//        company.linkedin.enrich query over 1.15B profiles).
//   • discoverCompanies(filters)   → POST /execute/oceanio        (ocean
//        search-companies: ICP filters → target accounts).
//   • findPeople(domain, titles)   → POST /execute/b2b-company-employees
//        (decision-makers at a company; emails stay LOCKED here).
//   • revealContactEmail(person)   → POST /execute/contact-waterfall
//        (person.contact.get: reveal a verified work email).
//   • fetchCompanySignals(domain)  → POST /execute/predictleads
//        (predictLeads: hiring / funding triggers).
//
// GRACEFUL DEGRADATION: with no ORANGESLICE_API_KEY (or a placeholder), or on ANY
// network/timeout/non-2xx/error response, every call catches and returns the
// existing fallback:
//   - enrichCompany  → documented homepage HTML meta-tag scrape (real, thinner),
//   - discoverCompanies / findPeople → []   (the sourcer layers an LLM + seed
//     fallback on top, so the pipeline is never empty),
//   - revealContactEmail / fetchCompanySignals → null.
// It NEVER throws — outbound must degrade, never block the swarm. We keep the
// `source: "orangeslice"` provenance labels and the existing call signatures so
// the rest of the swarm is unchanged.
// ============================================================================

import { safeFetch } from "./safeFetch";

const ORANGESLICE_BASE_URL = (
  process.env.ORANGESLICE_BASE_URL ?? "https://enrichly-production.up.railway.app"
).replace(/\/+$/, "");

// Per-request timeout for a single POST/poll hop, the inline wait we ask the
// gateway to hold a request open for, and the overall budget for async polling.
const ORANGESLICE_TIMEOUT_MS = 15_000;
const ORANGESLICE_INLINE_WAIT_MS = 5_000;
const ORANGESLICE_POLL_TIMEOUT_MS = 30_000;
const ORANGESLICE_POLL_INTERVAL_MS = 1_500;

// Ocean + predictLeads operation ids (mirrors the SDK's exported constants).
const OCEAN_SEARCH_COMPANIES = "search-companies";
const PREDICT_LEADS_JOB_OPENINGS = "company_job_openings";
const PREDICT_LEADS_FINANCING_EVENTS = "company_financing_events";

export interface Firmographics {
  domain: string;
  name?: string;
  description?: string;
  industry?: string;
  employeeCount?: string;
  location?: string;
  /** Honest provenance: the Orange Slice enrichment API or the HTML fallback. */
  source: "orangeslice" | "html-fallback";
}

/** A company surfaced by an ICP search (outbound discovery). */
export interface DiscoveredAccount {
  company: string;
  domain?: string;
  industry?: string;
  employeeCount?: string;
  location?: string;
  linkedinUrl?: string;
  source: "orangeslice";
}

/** A decision-maker at a target account. Email is locked behind a reveal step. */
export interface DiscoveredPerson {
  name?: string;
  title?: string;
  linkedinUrl?: string;
  /** Revealed work email when unlocked; locked rows leave this undefined. */
  email?: string;
  emailLocked: boolean;
  location?: string;
  source: "orangeslice";
}

export interface DiscoverCompaniesArgs {
  /** Free-text keywords describing the ICP (industry, category, niche). */
  keywords?: string;
  /** Headcount buckets, e.g. ["11,50","51,200"] (Apollo-style) or ["11-50"]. */
  employeeRanges?: string[];
  /** Locations (cities / regions / countries) to bias toward. */
  locations?: string[];
  /** How many accounts to pull (capped at 25). */
  limit?: number;
}

/** Inputs for a person email reveal via the Orange Slice contact waterfall. */
export interface RevealContactArgs {
  linkedinUrl?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  domain?: string;
}

/** Hiring + funding triggers for a company, via predictLeads. */
export interface CompanySignals {
  domain: string;
  jobOpenings: number;
  financingEvents: number;
  latestFinancing?: { round?: string; amount?: string; announcedAt?: string };
  source: "orangeslice";
}

// ----------------------------------------------------------------------------
// Key + low-level transport.
// ----------------------------------------------------------------------------

// Obvious placeholders we treat as "no key" so a half-configured env degrades
// gracefully instead of firing authenticated calls that will 401.
const PLACEHOLDER_KEY_PATTERN = /^(your|placeholder|changeme|example|dummy|test[-_]?key|xxx)/i;

/** Read the key fresh each call so env changes are picked up without restart. */
function apiKey(): string | undefined {
  const key = process.env.ORANGESLICE_API_KEY?.trim();
  if (!key) return undefined;
  if (PLACEHOLDER_KEY_PATTERN.test(key)) return undefined;
  return key;
}

/** True when a real Orange Slice key is configured (callers can choose a path). */
export function hasOrangeSliceKey(): boolean {
  return apiKey() !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Single Orange Slice gateway POST. Adds the bearer auth + inline wait, follows
 * the SDK's async polling protocol, and returns the parsed object body — or
 * `null` on any missing-key / timeout / non-2xx / error-body case so callers
 * degrade gracefully instead of throwing. Uses safeFetch (SSRF guard + timeout).
 */
async function slicePost(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const key = apiKey();
  if (!key) return null;

  try {
    const res = await safeFetch(`${ORANGESLICE_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ ...payload, inlineWaitMs: ORANGESLICE_INLINE_WAIT_MS }),
      timeoutMs: ORANGESLICE_TIMEOUT_MS,
    });
    if (!res.ok) return null;

    const body = await readBody(res);
    if (isRecord(body) && body.pending === true) {
      return await pollSliceResult(body);
    }
    if (!isRecord(body)) return null;
    if (typeof body.error === "string") return null; // 2xx carrying an error field
    return body;
  } catch {
    return null; // network / timeout / bad JSON — never propagate
  }
}

/** Poll /function/result/:requestId (or an explicit pollUrl) until resolved. */
async function pollSliceResult(
  pending: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const pollPath =
    typeof pending.pollUrl === "string" && pending.pollUrl.trim().length > 0
      ? pending.pollUrl
      : typeof pending.requestId === "string"
        ? `/function/result/${pending.requestId}`
        : undefined;
  if (!pollPath) return null;

  let pollUrl: string;
  try {
    pollUrl = new URL(pollPath, `${ORANGESLICE_BASE_URL}/`).toString();
  } catch {
    return null;
  }

  const deadline = Date.now() + ORANGESLICE_POLL_TIMEOUT_MS;
  let interval =
    typeof pending.pollAfterMs === "number" && pending.pollAfterMs > 0
      ? Math.min(pending.pollAfterMs, 3_000)
      : ORANGESLICE_POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      const res = await safeFetch(pollUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeoutMs: ORANGESLICE_TIMEOUT_MS,
      });
      const body = await readBody(res);
      if (res.status === 202 || (isRecord(body) && body.pending === true)) {
        if (isRecord(body) && typeof body.pollAfterMs === "number" && body.pollAfterMs > 0) {
          interval = Math.min(body.pollAfterMs, 3_000);
        }
        continue;
      }
      if (!res.ok) return null;
      if (!isRecord(body)) return null;
      if (typeof body.error === "string") return null;
      return body;
    } catch {
      return null;
    }
  }
  return null; // polling budget exhausted — degrade
}

// ----------------------------------------------------------------------------
// Parsing helpers.
// ----------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function firstString(
  data: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!data) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

/** First non-empty string found inside an array-valued field. */
function firstFromArray(
  data: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!data) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) return item.trim();
      }
    }
  }
  return undefined;
}

/** Escape a value for inlining into a single-quoted SQL string literal. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Normalize raw user input into a bare domain (no scheme, no path, no www). */
function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/^www\./, "");
  domain = domain.split("/")[0].split("?")[0];
  return domain;
}

/** Build "City, Region, Country" from split location fields. */
function joinParts(parts: ReadonlyArray<string | undefined>): string | undefined {
  const filtered = parts.filter((p): p is string => Boolean(p && p.trim()));
  return filtered.length > 0 ? filtered.join(", ") : undefined;
}

/** Headcount as a number → a human range bucket. */
function bucketHeadcount(rec: Record<string, unknown> | undefined): string | undefined {
  const raw =
    rec?.["estimated_num_employees"] ??
    rec?.["employee_count"] ??
    rec?.["employeeCountLinkedin"] ??
    rec?.["employeeCountOcean"];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return firstString(rec, ["employee_count", "size", "headcount", "companySize"]);
  }
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  if (n <= 5000) return "1001-5000";
  return "5000+";
}

// ----------------------------------------------------------------------------
// HTML fallback (no key / no match) — documented homepage meta-tag scrape.
// ----------------------------------------------------------------------------
function pickMeta(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+/g, " ").trim();
  }
  return undefined;
}

async function enrichViaHtml(domain: string): Promise<Firmographics> {
  const url = `https://${domain}`;
  let html = "";
  try {
    // SSRF guard: `domain` is user-supplied. safeFetch rejects private/loopback/
    // metadata hosts and re-validates redirects before reading any bytes.
    const resp = await safeFetch(url, {
      headers: { "user-agent": "InterceptBot/1.0 (+enrichment)" },
    });
    if (resp.ok) html = await resp.text();
  } catch {
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

  return { domain, name: title, description, source: "html-fallback" };
}

// ----------------------------------------------------------------------------
// Company row lookup (b2b LinkedIn firmographics by domain) via /execute/sql.
// Mirrors the SDK's company.linkedin.enrich domain query, selecting the whole
// row so callers can read firmographics + the slug/url we need for people.
// ----------------------------------------------------------------------------
async function getCompanyRow(domain: string): Promise<Record<string, unknown> | null> {
  const bare = domain.replace(/^www\./, "");
  const escaped = bare.replace(/\./g, "\\.");
  const websiteRegex = `^https?://(www\\.)?${escaped}(/([a-z]{2}(-[a-z]{2})?)?)?(\\?.*)?/?$`;
  const sql = `SELECT lkd.*
FROM linkedin_company lc
JOIN lkd_company lkd ON lkd.linkedin_company_id = lc.id
WHERE lc.domain IN (${sqlString(bare)}, ${sqlString("www." + bare)})
ORDER BY CASE WHEN lc.website ~ ${sqlString(websiteRegex)} THEN 0 ELSE 1 END,
  lc.employee_count DESC NULLS LAST
LIMIT 1`;

  const data = await slicePost("/execute/sql", { sql });
  if (!data) return null;
  const rows = Array.isArray(data["rows"]) ? data["rows"] : [];
  const first = rows[0];
  return isRecord(first) ? first : null;
}

// ----------------------------------------------------------------------------
// PUBLIC: enrichCompany — REAL firmographics via Orange Slice b2b enrich.
// ----------------------------------------------------------------------------
/**
 * Enrich a company domain into firmographics. Prefers the real Orange Slice
 * `/execute/sql` b2b LinkedIn enrich (labeled `source:"orangeslice"`); otherwise
 * falls back to the documented homepage HTML scrape. Never throws.
 */
export async function enrichCompany(domain: string): Promise<Firmographics> {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    throw new Error("enrichCompany requires a non-empty domain.");
  }

  if (!hasOrangeSliceKey()) {
    return enrichViaHtml(normalized);
  }

  const row = await getCompanyRow(normalized);
  if (!row) {
    return enrichViaHtml(normalized);
  }

  const firmo: Firmographics = {
    domain: normalized,
    name: firstString(row, ["name", "company_name"]),
    description: firstString(row, ["description", "tagline", "summary"]),
    industry: firstString(row, ["industry", "industry_name"]),
    employeeCount: bucketHeadcount(row),
    location: joinParts([
      firstString(row, ["locality", "city"]),
      firstString(row, ["region", "state"]),
      firstString(row, ["country_name", "country", "country_iso"]),
    ]),
    source: "orangeslice",
  };

  // An essentially-empty row is thinner than a homepage scrape — prefer the scrape.
  if (!firmo.name && !firmo.description) {
    return enrichViaHtml(normalized);
  }
  return firmo;
}

// ----------------------------------------------------------------------------
// PUBLIC: discoverCompanies — REAL ICP → target accounts via Ocean search.
// ----------------------------------------------------------------------------
/** Map an Apollo-style "11,50" / "11-50" headcount range to an Ocean bucket. */
const OCEAN_SIZE_BUCKETS: ReadonlySet<string> = new Set([
  "0-1",
  "2-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
]);
function toOceanSize(range: string): string | undefined {
  const norm = range.trim().replace(/\s+/g, "").replace(",", "-");
  return OCEAN_SIZE_BUCKETS.has(norm) ? norm : undefined;
}

/**
 * Surface real companies matching an ICP via Orange Slice Ocean
 * `/execute/oceanio` (operation `search-companies`). Returns [] when no key /
 * no match (the sourcer layers its own LLM + seed fallback on top). Never throws.
 */
export async function discoverCompanies(
  args: DiscoverCompaniesArgs,
): Promise<DiscoveredAccount[]> {
  if (!hasOrangeSliceKey()) return [];

  const size = Math.max(1, Math.min(25, args.limit ?? 12));
  const companiesFilters: Record<string, unknown> = {};

  if (args.keywords?.trim()) {
    const industries = args.keywords
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (industries.length > 0) companiesFilters.industries = industries;
  }
  if (args.locations && args.locations.length > 0) {
    companiesFilters.countries = args.locations;
  }
  if (args.employeeRanges && args.employeeRanges.length > 0) {
    const sizes = args.employeeRanges
      .map(toOceanSize)
      .filter((s): s is string => Boolean(s));
    if (sizes.length > 0) companiesFilters.companySizes = sizes;
  }

  const data = await slicePost("/execute/oceanio", {
    operationId: OCEAN_SEARCH_COMPANIES,
    params: { companiesFilters, size },
  });
  const matches = Array.isArray(data?.["companies"])
    ? (data!["companies"] as unknown[])
    : [];

  const accounts: DiscoveredAccount[] = [];
  for (const match of matches) {
    // Ocean wraps each hit as { company: {...}, relevance }; tolerate a flat shape.
    const company = asRecord(asRecord(match)?.["company"]) ?? asRecord(match);
    const name = firstString(company, ["name", "legalName"]);
    if (!name) continue;

    const rawDomain = firstString(company, ["domain", "rootUrl"]);
    const medias = asRecord(company?.["medias"]);
    const linkedinMedia = asRecord(medias?.["linkedin"]);
    const firstLocation = Array.isArray(company?.["locations"])
      ? asRecord((company!["locations"] as unknown[])[0])
      : undefined;

    accounts.push({
      company: name,
      domain: rawDomain ? normalizeDomain(rawDomain) : undefined,
      industry:
        firstString(company, ["linkedinIndustry"]) ??
        firstFromArray(company, ["industries", "industryCategories"]),
      employeeCount:
        firstString(company, ["companySize"]) ?? bucketHeadcount(company),
      location:
        joinParts([
          firstString(firstLocation, ["locality"]),
          firstString(firstLocation, ["region", "state"]),
          firstString(firstLocation, ["country"]),
        ]) ??
        firstString(company, ["primaryCountry"]) ??
        firstFromArray(company, ["countries"]),
      linkedinUrl: firstString(linkedinMedia, ["url"]),
      source: "orangeslice",
    });
  }
  return accounts;
}

// ----------------------------------------------------------------------------
// PUBLIC: findPeople — REAL decision-makers at a domain via b2b employees.
// ----------------------------------------------------------------------------
/**
 * Find decision-makers at a company domain via Orange Slice
 * `/execute/b2b-company-employees`, filtered by title variations. We first
 * resolve the company's LinkedIn slug/url from the b2b enrich row, then pull its
 * current employees. Emails are LOCKED here (use revealContactEmail to unlock).
 * Returns [] when no key / no company match. Never throws.
 */
export async function findPeople(
  domain: string,
  titles: readonly string[],
  limit = 3,
): Promise<DiscoveredPerson[]> {
  const normalized = normalizeDomain(domain);
  if (!normalized || !hasOrangeSliceKey()) return [];

  const row = await getCompanyRow(normalized);
  const companySlug = firstString(row, ["slug"]);
  const linkedinUrl = firstString(row, ["linkedin_url", "linkedinUrl"]);
  if (!companySlug && !linkedinUrl) return [];

  const cleanTitles = titles.map((t) => t.trim()).filter(Boolean).slice(0, 10);
  const payload: Record<string, unknown> = {
    limit: Math.max(1, Math.min(25, limit)),
    onlyCurrent: true,
  };
  if (companySlug) payload.companySlug = companySlug;
  if (linkedinUrl) payload.linkedinUrl = linkedinUrl;
  if (cleanTitles.length > 0) payload.titleVariations = cleanTitles;

  const data = await slicePost("/execute/b2b-company-employees", payload);
  const employees = Array.isArray(data?.["employees"])
    ? (data!["employees"] as unknown[])
    : [];

  const people: DiscoveredPerson[] = [];
  for (const item of employees) {
    const e = asRecord(item);
    if (!e) continue;
    const name =
      firstString(e, ["lp_formatted_name"]) ??
      ([firstString(e, ["lp_first_name"]), firstString(e, ["lp_last_name"])]
        .filter(Boolean)
        .join(" ") ||
        undefined);
    people.push({
      name: name || undefined,
      title: firstString(e, ["lp_title", "lp_headline"]),
      linkedinUrl: firstString(e, ["lp_public_profile_url"]),
      email: undefined,
      emailLocked: true, // b2b people search never reveals — see revealContactEmail
      location: firstString(e, ["lp_location_name"]),
      source: "orangeslice",
    });
  }
  return people;
}

// ----------------------------------------------------------------------------
// PUBLIC: revealContactEmail — REAL work-email reveal via contact waterfall.
// ----------------------------------------------------------------------------
/**
 * Reveal a verified work email for a person via Orange Slice
 * `/execute/contact-waterfall` (person.contact.get). Prefers a work email,
 * falls back to a personal email, and returns `null` when no key / no match.
 * Never throws.
 */
export async function revealContactEmail(args: RevealContactArgs): Promise<string | null> {
  if (!hasOrangeSliceKey()) return null;

  let firstName = args.firstName?.trim();
  let lastName = args.lastName?.trim();
  if (!firstName && args.name?.trim()) {
    const parts = args.name.trim().split(/\s+/);
    firstName = parts[0];
    lastName = parts.slice(1).join(" ") || undefined;
  }

  // Need at least a LinkedIn URL or a (name + domain) to anchor the lookup.
  if (!args.linkedinUrl && !(firstName && args.domain)) return null;

  const payload: Record<string, unknown> = { required: ["work_email"] };
  if (args.linkedinUrl) payload.linkedinUrl = args.linkedinUrl;
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  if (args.company) payload.company = args.company;
  if (args.domain) payload.domain = normalizeDomain(args.domain);

  const data = await slicePost("/execute/contact-waterfall", payload);
  if (!data) return null;

  for (const key of ["work_emails", "personal_emails"] as const) {
    const emails = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
    for (const candidate of emails) {
      if (typeof candidate === "string" && candidate.includes("@")) {
        return candidate.trim();
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// PUBLIC: fetchCompanySignals — REAL hiring/funding triggers via predictLeads.
// ----------------------------------------------------------------------------
/** Count the items in a predictLeads-style `{ data: [...] }` response. */
function predictLeadsCount(data: Record<string, unknown> | null): number {
  if (!data) return 0;
  const arr =
    data["data"] ?? data["results"] ?? data["job_openings"] ?? data["financing_events"];
  return Array.isArray(arr) ? arr.length : 0;
}

/** First item's attributes from a predictLeads-style `{ data: [...] }` response. */
function predictLeadsFirstAttributes(
  data: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const arr = data["data"] ?? data["results"] ?? data["financing_events"];
  if (Array.isArray(arr) && isRecord(arr[0])) {
    return asRecord(arr[0]["attributes"]) ?? asRecord(arr[0]);
  }
  return undefined;
}

/**
 * Fetch hiring + funding signals for a company via Orange Slice
 * `/execute/predictleads` (operations `company_job_openings` +
 * `company_financing_events`). Returns `null` when no key / nothing resolved.
 * The predictLeads response shape is best-effort parsed. Never throws.
 */
export async function fetchCompanySignals(domain: string): Promise<CompanySignals | null> {
  const normalized = normalizeDomain(domain);
  if (!normalized || !hasOrangeSliceKey()) return null;

  const [jobsData, financingData] = await Promise.all([
    slicePost("/execute/predictleads", {
      operationId: PREDICT_LEADS_JOB_OPENINGS,
      params: { domain: normalized },
    }),
    slicePost("/execute/predictleads", {
      operationId: PREDICT_LEADS_FINANCING_EVENTS,
      params: { domain: normalized },
    }),
  ]);

  if (!jobsData && !financingData) return null;

  const attrs = predictLeadsFirstAttributes(financingData);
  const latestFinancing = attrs
    ? {
        round: firstString(attrs, ["round_type", "round", "type"]),
        amount: firstString(attrs, ["amount", "amount_normalized", "raised"]),
        announcedAt: firstString(attrs, ["announced_date", "date", "happened_at"]),
      }
    : undefined;

  return {
    domain: normalized,
    jobOpenings: predictLeadsCount(jobsData),
    financingEvents: predictLeadsCount(financingData),
    latestFinancing:
      latestFinancing &&
      (latestFinancing.round || latestFinancing.amount || latestFinancing.announcedAt)
        ? latestFinancing
        : undefined,
    source: "orangeslice",
  };
}

// ============================================================================
// AD-SCAN SOURCING WRAPPERS — token-free competitor ad intelligence.
// ----------------------------------------------------------------------------
// Thin wrappers over the same Orange Slice gateway (`slicePost`) that the rest
// of this module uses, exposing the three SDK services the no-token ad scan
// (lib/adscan.ts) needs. Routing them through `slicePost` keeps the bearer-auth,
// async polling, and SSRF-guarded transport identical to every other call, and
// means a missing/placeholder key degrades to a clean empty result instead of
// throwing. These mirror `services.browser.execute` (→ /execute/kernel),
// `services.apify.runActor` (→ /execute/apify) and `services.scrape.website`
// (→ /execute/firecrawl) without importing the Node-only SDK bundle.
// ============================================================================

/** Result of a single Orange Slice browser-pool run (Playwright `page` in scope). */
export interface OsBrowserResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Run Playwright `code` (with `page` in scope) in the managed Chromium pool —
 * a residential-IP browser that sidesteps the 403/CAPTCHA wall on the public
 * Meta Ad Library, so we can read commercial ads with NO Graph API token.
 * Never throws: no key / timeout / non-2xx ⇒ `{ success:false }`.
 */
export async function osBrowserExecute(
  code: string,
  opts?: { timeoutSec?: number },
): Promise<OsBrowserResult> {
  const data = await slicePost("/execute/kernel", {
    code,
    timeout_sec: opts?.timeoutSec ?? 90,
  });
  if (!data) return { success: false, error: "no_response" };
  return {
    success: data["success"] === true,
    result: data["result"],
    error: typeof data["error"] === "string" ? (data["error"] as string) : undefined,
  };
}

/** Result of an Orange Slice Apify actor run. */
export interface OsApifyResult {
  items: Record<string, unknown>[];
  usageTotalUsd: number;
}

/**
 * Run an Apify actor through the Orange Slice gateway and return its dataset
 * items. Used as the ad-scan fallback (Meta + TikTok scrapers) when the direct
 * browser path comes back thin. Never throws: no key / failure ⇒ empty items.
 */
export async function osRunApifyActor(
  actor: string,
  input: Record<string, unknown>,
  datasetListParams?: Record<string, unknown>,
): Promise<OsApifyResult> {
  const data = await slicePost("/execute/apify", {
    actor,
    input,
    ...(datasetListParams ? { datasetListParams } : {}),
  });
  if (!data) return { items: [], usageTotalUsd: 0 };
  const items = Array.isArray(data["items"])
    ? (data["items"] as Record<string, unknown>[])
    : [];
  const usageTotalUsd =
    typeof data["usageTotalUsd"] === "number" ? (data["usageTotalUsd"] as number) : 0;
  return { items, usageTotalUsd };
}

/** Result of an Orange Slice firecrawl scrape (markdown + links + social URLs). */
export interface OsScrapeResult {
  markdown: string;
  data: Array<{ markdown: string; links: string[] }>;
  socialUrls?: Record<string, string[]>;
}

/**
 * Scrape a single URL via Orange Slice firecrawl — used to resolve the creative
 * image behind a Meta `ad_snapshot_url` (a 302→login redirect that the browser
 * pool can render). Never throws: no key / failure ⇒ `null`.
 */
export async function osScrapeWebsite(
  url: string,
  params?: Record<string, unknown>,
): Promise<OsScrapeResult | null> {
  const data = await slicePost("/execute/firecrawl", {
    url,
    limit: 1,
    scrapeOptions: {
      formats: ["markdown", "links"],
      onlyMainContent: false,
      removeBase64Images: true,
      blockAds: true,
      timeout: 30_000,
      ...(params ?? {}),
    },
  });
  if (!data) return null;
  const markdown = typeof data["markdown"] === "string" ? (data["markdown"] as string) : "";
  const rows = Array.isArray(data["data"])
    ? (data["data"] as unknown[]).flatMap((row) => {
        if (!isRecord(row)) return [];
        return [
          {
            markdown: typeof row["markdown"] === "string" ? (row["markdown"] as string) : "",
            links: Array.isArray(row["links"])
              ? (row["links"] as unknown[]).filter((l): l is string => typeof l === "string")
              : [],
          },
        ];
      })
    : [];
  const socialUrls = isRecord(data["socialUrls"])
    ? (data["socialUrls"] as Record<string, string[]>)
    : undefined;
  return { markdown, data: rows, socialUrls };
}
