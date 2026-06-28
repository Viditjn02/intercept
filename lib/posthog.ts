// ============================================================================
// INTERCEPT — POSTHOG LIVE ANALYTICS (REST ONLY, NO SDK, NO DEPS)
// capture(event, props) POSTs to ${NEXT_PUBLIC_POSTHOG_HOST}/i/v0/e/ with the
// project's NEXT_PUBLIC_POSTHOG_KEY. Works from BOTH server and client via the
// global fetch. It is GRACEFUL by contract:
//   - NO-OPs silently if NEXT_PUBLIC_POSTHOG_KEY is unset.
//   - NEVER throws / never rejects — analytics must never block the swarm,
//     the brief, or any agent. Every failure is swallowed.
// No npm dependency, no SDK source — just fetch to the public capture endpoint.
// ============================================================================

const DEFAULT_HOST = "https://us.i.posthog.com";
const DISTINCT_ID_KEY = "intercept_ph_distinct_id";
const LIB = "intercept-rest";

export type CaptureProps = Record<string, unknown> & {
  /** Override the distinct_id (e.g. pass a runId from a server action). */
  distinctId?: string;
};

/** Trimmed project key, or undefined when analytics is disabled. */
function getKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
}

/** Capture host, trailing slashes stripped. Falls back to PostHog US cloud. */
function getHost(): string {
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  return (host && host.length ? host : DEFAULT_HOST).replace(/\/+$/, "");
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the Math.random fallback below
  }
  return `anon_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Stable anonymous id. On the client it is persisted in localStorage so the
 * same viewer is one person across events. On the server (no localStorage) the
 * caller-supplied override is used, else a fixed server id.
 */
export function getDistinctId(override?: string): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  if (!isBrowser()) return "intercept-server";
  try {
    const existing = window.localStorage.getItem(DISTINCT_ID_KEY);
    if (existing) return existing;
    const fresh = randomId();
    window.localStorage.setItem(DISTINCT_ID_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}

/**
 * Fire a single PostHog event. Resolves once the POST settles (or immediately
 * when disabled). Awaiting is optional — callers can fire-and-forget. Never
 * throws: a missing key, network error, or bad host is swallowed silently.
 */
export async function capture(event: string, props: CaptureProps = {}): Promise<void> {
  const key = getKey();
  if (!key || !event) return; // graceful no-op — feature disabled

  const { distinctId, ...rest } = props;
  try {
    const body = JSON.stringify({
      api_key: key,
      event,
      distinct_id: getDistinctId(distinctId),
      properties: {
        $lib: LIB,
        $source: isBrowser() ? "client" : "server",
        ...rest,
      },
      timestamp: new Date().toISOString(),
    });

    await fetch(`${getHost()}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // keepalive lets a client event survive a page unload (e.g. a link tap).
      keepalive: isBrowser(),
    });
  } catch {
    // Swallow — analytics must NEVER throw or block the swarm/brief.
  }
}

/** True when a PostHog key is configured (handy for conditional UI). */
export function isAnalyticsEnabled(): boolean {
  return Boolean(getKey());
}
