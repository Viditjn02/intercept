// ============================================================================
// INTERCEPT — FIBER AI VERIFIED-CONTACT CLIENT
//
// HONEST SCOPE NOTE: this is the VERIFIED-EMAIL DATA LAYER behind outreach, and
// it is SECONDARY to the real product beat. THE MOAT is the in-thread reply —
// a human-approved answer dropped into the LIVE conversation where the buyer is
// already asking the question (see lib/exa.ts + the reply/draft layer). Fiber is
// only the optional second path: once a draft is approved, the outreach layer
// can ask Fiber to attach a VERIFIED email/contact so the same message can also
// be sent as 1:1 outreach. If Fiber has nothing (or no key), the in-thread reply
// still ships untouched — outreach simply has no verified address to enrich with.
//
// Brand-new REST client (fetch + Authorization: Bearer FIBER_API_KEY). No SDK,
// no vendored source. If FIBER_API_KEY is missing, every call NO-OPs to a
// {verified:false} result and NEVER throws — it must never block the swarm,
// the brief, or the reply draft.
// ============================================================================

const FIBER_BASE_URL =
  process.env.FIBER_BASE_URL ?? "https://api.fiber.ai/v1";

const FIBER_TIMEOUT_MS = 12_000;

/** A best-effort verified contact for a company/role. `verified` is the gate. */
export interface VerifiedContact {
  /** Verified work email, when Fiber could confirm one. */
  email?: string;
  /** Contact's full name, when known. */
  name?: string;
  /** Contact's job title, when known. */
  title?: string;
  /**
   * True ONLY when Fiber returned a contact it marked as verified. The outreach
   * layer should treat `verified:false` as "no verified address — in-thread
   * reply only" and must not invent or send to an unverified address.
   */
  verified: boolean;
}

/** Firmographic-ish domain context Fiber can return alongside contacts. */
export interface FiberDomainInfo {
  domain: string;
  name?: string;
  description?: string;
  industry?: string;
  employeeCount?: string;
  location?: string;
  /** True when the lookup actually resolved against Fiber (vs. a no-op). */
  resolved: boolean;
}

export interface FindContactArgs {
  /** Company name or domain to find a verified contact at. Required. */
  company: string;
  /** Optional role/title to target (e.g. "Head of Growth", "founder"). */
  role?: string;
}

const NO_CONTACT: VerifiedContact = { verified: false };

/** Read the API key fresh each call so env changes are picked up without restart. */
function getApiKey(): string | undefined {
  const key = process.env.FIBER_API_KEY?.trim();
  return key ? key : undefined;
}

/** Pull the first present string field from a record, trying several keys. */
function firstString(
  data: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * fetch with a hard timeout. Wraps any error/timeout into a resolved `null` so
 * callers can degrade gracefully instead of throwing.
 */
async function fiberFetch(
  path: string,
  apiKey: string,
  query: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIBER_TIMEOUT_MS);
  try {
    const params = new URLSearchParams(query).toString();
    const url = `${FIBER_BASE_URL}${path}${params ? `?${params}` : ""}`;
    const resp = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null; // rate limit / unknown / auth — degrade silently
    const data = (await resp.json()) as unknown;
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    // Network error, timeout, bad JSON — never propagate; outreach is secondary.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find a VERIFIED contact (email/name/title) at a company, optionally narrowed
 * by role. The reply/outreach layer calls this AFTER a draft is human-approved
 * to attach a verified email so the answer can also go out as 1:1 outreach.
 *
 * Graceful degradation: returns {verified:false} (a no-op) when the key is
 * missing, Fiber errors, or no verified contact exists. NEVER throws.
 */
export async function findContact(
  args: FindContactArgs,
): Promise<VerifiedContact> {
  const company = args.company?.trim();
  if (!company) return NO_CONTACT;

  const apiKey = getApiKey();
  if (!apiKey) return NO_CONTACT; // no key configured — silent no-op

  const query: Record<string, string> = { company };
  if (args.role?.trim()) query.role = args.role.trim();

  const data = await fiberFetch("/contacts/find", apiKey, query);
  if (!data) return NO_CONTACT;

  // Fiber may nest the contact under `contact`/`result`/`data`; flatten it.
  const nested =
    (data.contact as Record<string, unknown> | undefined) ??
    (data.result as Record<string, unknown> | undefined) ??
    (data.data as Record<string, unknown> | undefined) ??
    data;

  const email = firstString(nested, ["email", "work_email", "verified_email"]);
  // Only claim verified when Fiber says so AND we actually have an email.
  const verifiedFlag =
    nested.verified === true ||
    nested.is_verified === true ||
    firstString(nested, ["status", "verification_status"]) === "verified";

  return {
    email,
    name: firstString(nested, ["name", "full_name"]),
    title: firstString(nested, ["title", "job_title", "role"]),
    verified: Boolean(email) && verifiedFlag,
  };
}

/**
 * Enrich a company DOMAIN into light firmographic context Fiber exposes. Useful
 * for shaping outreach copy, but secondary — the brief's ICP/positioning comes
 * from the enrichment agent, not from here.
 *
 * Graceful degradation: returns {resolved:false} when the key is missing or
 * Fiber errors. NEVER throws.
 */
export async function enrichDomain(domain: string): Promise<FiberDomainInfo> {
  const normalized = domain
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];

  if (!normalized) return { domain: "", resolved: false };

  const apiKey = getApiKey();
  if (!apiKey) return { domain: normalized, resolved: false }; // no-op

  const data = await fiberFetch("/companies/enrich", apiKey, {
    domain: normalized,
  });
  if (!data) return { domain: normalized, resolved: false };

  const nested =
    (data.company as Record<string, unknown> | undefined) ??
    (data.result as Record<string, unknown> | undefined) ??
    (data.data as Record<string, unknown> | undefined) ??
    data;

  return {
    domain: normalized,
    name: firstString(nested, ["name", "company_name"]),
    description: firstString(nested, ["description", "summary"]),
    industry: firstString(nested, ["industry", "sector"]),
    employeeCount: firstString(nested, ["employee_count", "size", "headcount"]),
    location: firstString(nested, ["location", "hq", "headquarters"]),
    resolved: true,
  };
}
