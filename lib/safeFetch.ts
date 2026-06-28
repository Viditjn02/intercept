// ============================================================================
// INTERCEPT — SSRF-SAFE FETCH
// Server-side fetches of USER-SUPPLIED URLs (reel analysis, company homepage
// scrape) are an SSRF vector: an attacker can point us at cloud metadata
// (169.254.169.254 / metadata.google.internal), loopback, or private ranges to
// exfiltrate credentials or reach internal services. Every such fetch MUST go
// through assertSafeUrl / safeFetch.
//
//   assertSafeUrl(url)  -> sync: throws unless https: (http: only for allowlisted
//                          hosts) and the host is not a private/loopback/
//                          link-local/metadata IP LITERAL or blocked hostname.
//   assertHostPublic(h) -> async: DNS-resolves a hostname and throws if ANY
//                          resolved address is private. Closes the "domain that
//                          resolves to a private IP" rebinding hole that a
//                          string-only check misses.
//   safeFetch(url, init)-> assertSafeUrl + assertHostPublic + 15s timeout + a
//                          size cap, re-validating (string + DNS) every redirect.
//
// node:dns only (no extra deps) so it can't break the Convex bundle. These run
// inside Convex "use node" actions, never the browser.
// ============================================================================

import { lookup as dnsLookup } from "node:dns/promises";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB hard cap
const MAX_REDIRECTS = 5;

const ALLOWED_HTTP_HOSTS: ReadonlySet<string> = new Set(
  (process.env.SAFEFETCH_ALLOWED_HTTP_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "metadata.google.internal",
]);

export interface SafeFetchOptions extends RequestInit {
  /** Abort the request after this many ms. Defaults to 15s. */
  timeoutMs?: number;
  /** Reject (via content-length) responses larger than this. Defaults to 25MB. */
  maxBytes?: number;
}

/** True if `host` is an IPv4 dotted-quad literal in a private/reserved range. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1, 5).map((n) => Number(n));
  if (octets.some((o) => o > 255)) return true; // malformed -> treat as unsafe
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/** True if `host` is an IPv6 literal in a loopback/link-local/ULA range. */
function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  return false;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * Sync validation of a user-supplied URL: protocol + IP-LITERAL host. Returns
 * the parsed URL when safe; throws otherwise. For hostnames, pair with
 * assertHostPublic (DNS) — string checks alone do not stop SSRF via DNS.
 */
export function assertSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`safeFetch: invalid URL: ${rawUrl}`);
  }

  const hostname = bareHost(url);

  if (url.protocol === "http:") {
    if (!ALLOWED_HTTP_HOSTS.has(hostname)) {
      throw new Error(
        `safeFetch: refusing insecure http URL (host not allowlisted): ${url.href}`,
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error(`safeFetch: refusing non-http(s) URL (${url.protocol}): ${url.href}`);
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`safeFetch: refusing blocked host: ${hostname}`);
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    throw new Error(
      `safeFetch: refusing private/loopback/link-local/metadata address: ${hostname}`,
    );
  }

  return url;
}

/**
 * DNS-resolve a hostname and throw if ANY resolved address is private/reserved.
 * This is the key SSRF defense beyond the string check: it blocks a public
 * hostname (e.g. an attacker domain) that resolves to 169.254.169.254 / a
 * loopback / a private RFC1918 address. Skipped for IP literals (already
 * validated synchronously).
 *
 * Residual: a DNS-rebinding adversary can still flip the record in the narrow
 * window between this lookup and undici's own connect-time resolution (TOCTOU).
 * The full fix is pinning the socket to the validated IP via an undici Agent
 * `connect.lookup` hook; deferred to avoid bundler risk in the hackathon build.
 */
export async function assertHostPublic(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (isIpLiteral(host)) return; // literal already checked by assertSafeUrl
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`safeFetch: DNS resolution failed for ${host}`);
  }
  if (addresses.length === 0) {
    throw new Error(`safeFetch: ${host} resolved to no addresses`);
  }
  for (const { address } of addresses) {
    if (isPrivateIpv4(address) || isPrivateIpv6(address)) {
      throw new Error(
        `safeFetch: ${host} resolves to a private/metadata address (${address})`,
      );
    }
  }
}

/**
 * SSRF-safe fetch. Validates the URL string AND its resolved IPs (and every
 * redirect hop), enforces a timeout and a content-length size cap. Drop-in for
 * `fetch` on user-supplied URLs.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
    redirect: _ignoredRedirect,
    ...rest
  } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    // Validate the URL string + resolve & validate its IPs before connecting.
    let current = assertSafeUrl(rawUrl);
    await assertHostPublic(current.hostname);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(current.href, {
        ...rest,
        signal: controller.signal,
        redirect: "manual",
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        // Re-validate (string + DNS) every hop — a safe host can 302 internal.
        const next = assertSafeUrl(new URL(location, current.href).href);
        await assertHostPublic(next.hostname);
        current = next;
        continue;
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxBytes) {
        controller.abort();
        throw new Error(
          `safeFetch: response exceeds ${maxBytes}-byte cap (content-length ${contentLength}).`,
        );
      }

      return response;
    }
    throw new Error(`safeFetch: too many redirects (>${MAX_REDIRECTS}).`);
  } finally {
    clearTimeout(timer);
  }
}
