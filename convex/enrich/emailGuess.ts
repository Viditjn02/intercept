// ============================================================================
// INTERCEPT — PLUS · OSS FREE EMAIL FINDER (Fiber fallback).
//
// Email discovery/verification algorithm ported from email-sleuth (MIT),
// © buyukakyuz — github.com/buyukakyuz/email-sleuth. Pattern generation
// (`src/utils/patterns.rs`), confidence scoring + generic-prefix set
// (`src/core/sleuth.rs`, `config/mod.rs`) ported to TypeScript.
//
// SPONSOR-FIRST preserved: Fiber stays PRIMARY for VERIFIED emails; this is the
// $0 fallback so outbound still produces a (clearly-unverified) address when
// Fiber has no key / no match. A guess NEVER sets `emailVerified` — it is
// honestly unverified until the external SMTP step (below) confirms it.
//
// DEPLOY-SAFETY: NOT "use node"; defines NO Convex functions (pure utility
// module). MX resolution uses DNS-over-HTTPS (fetch), NOT node `dns`, so the
// whole module stays in the default Convex runtime. The live SMTP `RCPT TO`
// probe CANNOT run in Convex (outbound port 25 is blocked) — see `SmtpVerdict`
// / `applySmtpVerdict`: that is the clean handoff to an external worker.
// ============================================================================

export interface EmailGuess {
  email: string;
  pattern: string; // e.g. "first.last" | "first" | "flast"
  confidence: number; // 0-1, normalized from the integer score below
}

// Validity regex from email-sleuth `config/mod.rs:109`.
const EMAIL_REGEX =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Generic / role-account prefixes — ported verbatim from email-sleuth
// `config/mod.rs:68-102`. A local-part in this set is a role inbox, not a
// person, and is penalized hard (-3) by the scorer.
const GENERIC_PREFIXES: ReadonlySet<string> = new Set([
  "info",
  "contact",
  "hello",
  "help",
  "support",
  "sales",
  "admin",
  "administrator",
  "team",
  "office",
  "mail",
  "email",
  "marketing",
  "press",
  "media",
  "pr",
  "jobs",
  "careers",
  "career",
  "hr",
  "recruiting",
  "billing",
  "accounts",
  "accounting",
  "finance",
  "legal",
  "privacy",
  "security",
  "abuse",
  "postmaster",
  "webmaster",
  "hostmaster",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "newsletter",
  "newsletters",
  "notifications",
  "notification",
  "feedback",
  "enquiries",
  "enquiry",
  "inquiries",
  "inquiry",
  "general",
  "service",
  "services",
  "orders",
  "order",
  "partners",
  "partnerships",
  "partner",
  "business",
  "dev",
  "developer",
  "developers",
  "api",
  "root",
  "sysadmin",
  "all",
  "everyone",
  "staff",
  "people",
]);

// ----------------------------------------------------------------------------
// Scoring constants — email-sleuth `config/mod.rs:131-132` + `sleuth.rs`.
// Accept a personal guess at >= 4; role accounts need >= 7 (only an SMTP boost
// can clear that bar — i.e. we never trust a role inbox without a live probe).
// ----------------------------------------------------------------------------
export const MIN_ACCEPT_SCORE = 4;
export const MIN_ROLE_ACCEPT_SCORE = 7;

// Normalization ceiling: base(1) + mx(1) + name(1) + smtp-valid(7) = 10, plus
// the (<1) pattern prior. Keeps unverified guesses honestly low (~0.2-0.36) and
// only a live-SMTP-confirmed address near 1.0.
const SCORE_CEILING = 11;

// ----------------------------------------------------------------------------
// Name handling — `sanitize_name_part` (patterns.rs:9-16): strip diacritics,
// lowercase, keep [a-z0-9] only.
// ----------------------------------------------------------------------------
function sanitizeNamePart(part: string): string {
  return part
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

interface NameParts {
  first: string;
  last?: string;
}

function splitName(name: string): NameParts | null {
  const tokens = name
    .trim()
    .split(/\s+/)
    .map(sanitizeNamePart)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return { first: tokens[0] };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];
}

// ----------------------------------------------------------------------------
// Pattern generation — `generate_email_patterns` (patterns.rs:22-122). Each
// candidate carries a prior in (0,1] reflecting how common the layout is at
// corporate domains; the prior orders ties between equally-scored candidates.
// ----------------------------------------------------------------------------
interface Candidate {
  local: string;
  pattern: string;
  prior: number;
}

function buildCandidates(parts: NameParts): Candidate[] {
  const { first, last } = parts;
  const fi = first.charAt(0);
  const raw: Candidate[] = [];

  if (last) {
    const li = last.charAt(0);
    raw.push(
      { local: `${first}.${last}`, pattern: "first.last", prior: 1.0 },
      { local: `${first}${last}`, pattern: "firstlast", prior: 0.92 },
      { local: `${fi}${last}`, pattern: "flast", prior: 0.88 },
      { local: `${first}`, pattern: "first", prior: 0.7 },
      { local: `${fi}.${last}`, pattern: "f.last", prior: 0.66 },
      { local: `${first}_${last}`, pattern: "first_last", prior: 0.6 },
      { local: `${first}-${last}`, pattern: "first-last", prior: 0.5 },
      { local: `${first}${li}`, pattern: "firstl", prior: 0.45 },
      { local: `${last}.${first}`, pattern: "last.first", prior: 0.4 },
      { local: `${last}${first}`, pattern: "lastfirst", prior: 0.35 },
      { local: `${last}`, pattern: "last", prior: 0.3 },
      { local: `${fi}${li}`, pattern: "fl", prior: 0.2 },
    );
  } else {
    raw.push({ local: `${first}`, pattern: "first", prior: 0.7 });
  }

  // Dedupe by local part, keeping the highest-prior layout for each address.
  const byLocal = new Map<string, Candidate>();
  for (const c of raw) {
    if (!c.local) continue;
    const existing = byLocal.get(c.local);
    if (!existing || c.prior > existing.prior) byLocal.set(c.local, c);
  }
  return [...byLocal.values()];
}

// ----------------------------------------------------------------------------
// Confidence scoring — `calculate_initial_confidence` (sleuth.rs:813-833),
// `is_generic_prefix` (912), `check_name_in_email` (899).
//
//   base 1
//   +1 MX exists      (mx === false → HARD 0: domain can't receive mail)
//   +1 name in local-part
//   -3 generic prefix
//   (+7 / +1 / -10 SMTP boost applied later via applySmtpVerdict)
//
// `mx` is true | false | null (null = unknown, e.g. no DoH lookup yet).
// ----------------------------------------------------------------------------
function isGenericPrefix(local: string): boolean {
  return GENERIC_PREFIXES.has(local.toLowerCase());
}

function nameInLocal(local: string, parts: NameParts): boolean {
  const lower = local.toLowerCase();
  if (parts.first.length >= 2 && lower.includes(parts.first)) return true;
  if (parts.last && parts.last.length >= 2 && lower.includes(parts.last)) {
    return true;
  }
  return false;
}

function scoreCandidate(
  candidate: Candidate,
  parts: NameParts,
  mx: boolean | null,
): number {
  // MX absent → the domain cannot receive mail. Hard zero (email-sleuth gate).
  if (mx === false) return 0;

  let score = 1; // base
  if (mx === true) score += 1; // +1 MX exists
  if (nameInLocal(candidate.local, parts)) score += 1; // +1 name in local
  if (isGenericPrefix(candidate.local)) score -= 3; // -3 generic prefix
  return score;
}

function toConfidence(score: number, prior: number): number {
  if (score <= 0) return 0;
  const blended = (score + prior) / SCORE_CEILING;
  return Math.min(1, Math.max(0, blended));
}

// ----------------------------------------------------------------------------
// Core: rank every valid candidate for a name@domain given MX knowledge.
// ----------------------------------------------------------------------------
function rankCandidates(
  name: string,
  domain: string,
  mx: boolean | null,
): EmailGuess[] {
  const parts = splitName(name);
  const dom = normalizeDomain(domain);
  if (!parts || !dom) return [];

  const ranked: Array<EmailGuess & { _score: number; _prior: number }> = [];
  for (const c of buildCandidates(parts)) {
    const email = `${c.local}@${dom}`;
    if (!EMAIL_REGEX.test(email)) continue;
    const score = scoreCandidate(c, parts, mx);
    const confidence = toConfidence(score, c.prior);
    if (confidence <= 0) continue;
    ranked.push({
      email,
      pattern: c.pattern,
      confidence,
      _score: score,
      _prior: c.prior,
    });
  }

  ranked.sort(
    (a, b) => b._score - a._score || b._prior - a._prior,
  );
  return ranked.map(({ email, pattern, confidence }) => ({
    email,
    pattern,
    confidence,
  }));
}

const EMPTY_GUESS: EmailGuess = { email: "", pattern: "", confidence: 0 };

/**
 * Guess the most likely corporate email for a name at a domain (SYNCHRONOUS;
 * MX unknown). Returns the top-ranked candidate, or an empty zero-confidence
 * guess when the name/domain is unusable. NEVER throws.
 */
export function guessEmail(name: string, domain: string): EmailGuess {
  const ranked = rankCandidates(name, domain, null);
  return ranked[0] ?? EMPTY_GUESS;
}

/** Full ranked candidate list (most→least likely). NEVER throws. */
export function guessEmails(name: string, domain: string): EmailGuess[] {
  return rankCandidates(name, domain, null);
}

// ----------------------------------------------------------------------------
// DNS MX resolution via DNS-over-HTTPS (fetch only — NO node `dns`, so this
// module stays deploy-safe in the default Convex runtime). Mirrors email-sleuth
// `resolve_mail_server` (dns.rs:78-155) with the `resolve_a_record_fallback`
// (158-214): an A record means mail can still be delivered to the host.
//
// Returns: true (can receive) | false (cannot) | null (unknown — DoH failed;
// callers must NOT hard-zero on null).
// ----------------------------------------------------------------------------
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 4_000;

async function dohQuery(
  domain: string,
  type: "MX" | "A",
): Promise<{ status: number; answers: unknown[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=${type}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      Status?: number;
      Answer?: unknown[];
    };
    return {
      status: typeof data.Status === "number" ? data.Status : -1,
      answers: Array.isArray(data.Answer) ? data.Answer : [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function hasRecordOfType(answers: unknown[], dnsType: number): boolean {
  return answers.some((a) => {
    const rec = a as { type?: number } | null;
    return rec != null && rec.type === dnsType;
  });
}

/**
 * True when `domain` can receive mail (MX present, or A-record fallback), false
 * when it provably cannot, null when the lookup could not be completed.
 * NEVER throws.
 */
export async function resolveMx(domain: string): Promise<boolean | null> {
  const dom = normalizeDomain(domain);
  if (!dom) return null;

  const mx = await dohQuery(dom, "MX");
  if (mx === null) return null; // lookup failed → unknown
  if (hasRecordOfType(mx.answers, 15)) return true; // MX record (DNS type 15)

  // No MX: fall back to A record (RFC 5321 §5.1 implicit MX).
  const a = await dohQuery(dom, "A");
  if (a === null) return null;
  if (hasRecordOfType(a.answers, 1)) return true; // A record (DNS type 1)

  // NXDOMAIN (3) or NOERROR with no usable records → cannot receive mail.
  return mx.status === 0 || mx.status === 3 ? false : null;
}

/**
 * MX-aware guess: resolves the domain's mail capability via DoH, then ranks.
 * If the domain provably cannot receive mail, returns an empty zero-confidence
 * guess (honest). On an unknown MX (DoH failed) it falls back to the base
 * (synchronous) confidence so we still surface a candidate. NEVER throws.
 */
export async function guessEmailWithMx(
  name: string,
  domain: string,
): Promise<EmailGuess> {
  let mx: boolean | null = null;
  try {
    mx = await resolveMx(domain);
  } catch {
    mx = null;
  }
  const ranked = rankCandidates(name, domain, mx);
  return ranked[0] ?? EMPTY_GUESS;
}

// ----------------------------------------------------------------------------
// SMTP step — the clean interface for the live `RCPT TO` probe that CANNOT run
// in Convex (outbound port 25 is blocked on Convex/Vercel/Lambda). Deploy a
// tiny worker exposing `POST /verify {email} → SmtpVerdict`; call it from a
// Convex action and feed the result into `applySmtpVerdict` to finalize score.
//
// Boosts — email-sleuth `evaluate_smtp_response` / `perform_catch_all_check`:
//   +7  exists && !catchAll   (a real, deliverable mailbox)
//   +1  exists && catchAll    (accepted, but domain accepts everything)
//   -10 rejected              (5xx + a rejection phrase → dead mailbox)
// ----------------------------------------------------------------------------
export interface SmtpVerdict {
  email: string;
  /** RCPT TO returned a 2xx for this address. */
  exists: boolean;
  /** Domain accepts mail for any local-part (verdict is weak). */
  catchAll: boolean;
  /** RCPT TO returned a 5xx + rejection phrase (mailbox is dead). */
  rejected?: boolean;
  /** Raw 3-digit SMTP code, for logging/debug. */
  code?: number;
}

/** Function shape an external SMTP worker client must satisfy. */
export type SmtpProbe = (email: string) => Promise<SmtpVerdict>;

/**
 * Apply a live SMTP verdict to a guess, re-deriving confidence with the boost.
 * Pure — returns a NEW guess (no mutation). The verdict's `exists`/`rejected`
 * is what finally clears the >= MIN_ACCEPT_SCORE bar and lets outreach treat
 * the address as verified.
 */
export function applySmtpVerdict(
  guess: EmailGuess,
  verdict: SmtpVerdict,
): { guess: EmailGuess; score: number; accepted: boolean } {
  // Recover the pre-SMTP integer score from the normalized confidence so the
  // boost composes correctly even when called standalone.
  const baseScore = Math.round(guess.confidence * SCORE_CEILING);
  let score = baseScore;
  if (verdict.rejected) score -= 10;
  else if (verdict.exists && verdict.catchAll) score += 1;
  else if (verdict.exists) score += 7;

  const threshold = isGenericLocalPart(guess.email)
    ? MIN_ROLE_ACCEPT_SCORE
    : MIN_ACCEPT_SCORE;

  return {
    guess: { ...guess, confidence: Math.min(1, Math.max(0, score / SCORE_CEILING)) },
    score,
    accepted: score >= threshold,
  };
}

function isGenericLocalPart(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return isGenericPrefix(local);
}
