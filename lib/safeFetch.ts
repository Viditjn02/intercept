// ============================================================================
// INTERCEPT — SSRF-SAFE FETCH
// Server-side fetches of USER-SUPPLIED URLs (reel analysis, company homepage
// scrape, stored video bytes) are an SSRF vector: an attacker can point us at
// cloud metadata (169.254.169.254 / metadata.google.internal), loopback, or
// private ranges. Every such fetch MUST go through assertSafeUrl / safeFetch.
//
//   assertSafeUrl(url)  -> throws unless https: (http: only for allowlisted
//                          hosts) and the host is not a private/loopback/
//                          link-local/metadata IP LITERAL or blocked hostname.
//   safeFetch(url, init)-> assertSafeUrl + 15s timeout + size cap, re-validating
//                          every redirect hop.
//
// IMPORTANT: this file is imported by Convex DEFAULT-runtime modules (the enrich
// and watcher agents), which cannot use Node built-ins — so all checks here are
// SYNCHRONOUS and dependency-free (no node:dns). Residual: a public hostname that
// *resolves* to a private IP (DNS rebinding) is not caught here. The resolved-IP
// check belongs in the "use node" fetch paths (e.g. convex/storage.ts) where
// node:dns is available; track that as a production hardening follow-up.
// ============================================================================

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
  if (a === 0) return true; // 0.0.0.0/8
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

function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * Validate a user-supplied URL before any server-side fetch. Returns the parsed
 * URL when safe; throws a descriptive Error otherwise. Synchronous + dependency
 * free so it is safe to import into Convex's default runtime.
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
 * SSRF-safe fetch. Validates the URL (and every redirect hop), enforces a
 * timeout and a content-length size cap. Drop-in for `fetch` on user URLs.
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
    // Follow redirects manually so each hop is re-validated against the SSRF
    // guard (a safe host can otherwise 302 to an internal address).
    let current = assertSafeUrl(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(current.href, {
        ...rest,
        signal: controller.signal,
        redirect: "manual",
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        current = assertSafeUrl(new URL(location, current.href).href);
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
