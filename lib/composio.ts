// ============================================================================
// INTERCEPT — COMPOSIO GMAIL SEND CLIENT
//
// PRODUCTION Gmail send path (the real outreach beat): triggers the
// GMAIL_SEND_EMAIL action through an OAuth'd Gmail account that the operator has
// already connected in Composio. AgentMail (lib — demo default) is what the
// on-camera run uses; flip the integrator's send strategy to this for a real,
// from-your-own-inbox send.
//
// Thin REST client only — no Composio SDK, no copied source. We call the public
// Composio v3 HTTP API directly:
//   POST /api/v3/tools/execute/{tool_slug}   -> run GMAIL_SEND_EMAIL
//   GET  /api/v3/connected_accounts          -> find an ACTIVE Gmail connection
// Auth is the project key in the `x-api-key` header (read from process.env).
//
// GRACEFUL DEGRADATION: with no COMPOSIO_API_KEY (or no connected Gmail / any
// API error) every export NO-OPs — sendGmail returns { sent: false, ... } and
// isConnected() returns false. Nothing here ever throws, so it can never block
// the swarm or the brief.
// ============================================================================

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev";

// Composio toolkit + action slugs for the OAuth'd Gmail send.
const GMAIL_TOOLKIT_SLUG = "gmail";
const GMAIL_SEND_ACTION = "GMAIL_SEND_EMAIL";

// Optional: pin a specific connected account / multi-user id from the env so a
// multi-connection workspace sends from the right inbox. Both are optional —
// without them we auto-select the first ACTIVE Gmail connection.
const CONNECTED_ACCOUNT_ID = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
const USER_ID = process.env.COMPOSIO_USER_ID;

const REQUEST_TIMEOUT_MS = 20_000;

export interface SendGmailArgs {
  /** Recipient email address. */
  to: string;
  /** Email subject line. */
  subject: string;
  /** Email body. Plain text by default; pass html:true to send as HTML. */
  body: string;
  /** Send `body` as HTML rather than plain text. Defaults to false. */
  html?: boolean;
}

export interface SendGmailResult {
  /** True only when Composio confirms the message was sent. */
  sent: boolean;
  /** Composio message/thread id when available. */
  messageId?: string;
  /** Human-readable reason when not sent (missing key, no connection, error). */
  reason?: string;
}

/** Read the project API key fresh each call so env changes take effect. */
function getApiKey(): string | undefined {
  const key = process.env.COMPOSIO_API_KEY?.trim();
  return key ? key : undefined;
}

/**
 * Small JSON fetch wrapper with a timeout and an `x-api-key` header. Returns the
 * parsed body on a 2xx, or null on any failure (network, timeout, non-2xx, bad
 * JSON). Never throws — callers degrade to the no-op path on null.
 */
async function composioJson(
  path: string,
  init: { method: "GET" | "POST"; apiKey: string; body?: unknown } ,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${COMPOSIO_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        "x-api-key": init.apiKey,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the connected-account id to send from. Prefers an explicit
 * COMPOSIO_CONNECTED_ACCOUNT_ID; otherwise queries the API for the first ACTIVE
 * Gmail connection (optionally scoped to COMPOSIO_USER_ID). Returns undefined
 * when no usable connection exists.
 */
async function resolveGmailAccountId(apiKey: string): Promise<string | undefined> {
  if (CONNECTED_ACCOUNT_ID) return CONNECTED_ACCOUNT_ID;

  const params = new URLSearchParams();
  params.set("toolkit_slugs", GMAIL_TOOLKIT_SLUG);
  params.set("statuses", "ACTIVE");
  params.set("limit", "1");
  if (USER_ID) params.set("user_ids", USER_ID);

  const data = await composioJson(`/api/v3/connected_accounts?${params.toString()}`, {
    method: "GET",
    apiKey,
  });
  if (!data) return undefined;

  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  const active = items.find((it) => (it.status as string) === "ACTIVE") ?? items[0];
  const id = active?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * True when a COMPOSIO_API_KEY is set AND an ACTIVE Gmail account is connected.
 * Used by the integrator to decide whether to offer the production send path.
 * Never throws — returns false on any missing-key / no-connection / error case.
 */
export async function isConnected(): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) return false;
  const accountId = await resolveGmailAccountId(apiKey);
  return Boolean(accountId);
}

/**
 * Send an email through the operator's OAuth'd Gmail via Composio's
 * GMAIL_SEND_EMAIL action. Production alternative to the AgentMail demo send.
 *
 * No-ops to { sent: false, reason } — never throws — when the key is missing, no
 * Gmail account is connected, or the API call fails, so it can never block the
 * swarm or the human-approved reply gate.
 */
export async function sendGmail(args: SendGmailArgs): Promise<SendGmailResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { sent: false, reason: "COMPOSIO_API_KEY not set (production Gmail send disabled)" };
  }

  const to = args.to?.trim();
  const subject = args.subject?.trim();
  const body = args.body ?? "";
  if (!to || !subject) {
    return { sent: false, reason: "sendGmail requires non-empty `to` and `subject`" };
  }

  const connectedAccountId = await resolveGmailAccountId(apiKey);
  if (!connectedAccountId) {
    return { sent: false, reason: "no ACTIVE Gmail connection in Composio" };
  }

  // GMAIL_SEND_EMAIL argument shape (Composio Gmail toolkit).
  const payload: Record<string, unknown> = {
    connected_account_id: connectedAccountId,
    arguments: {
      recipient_email: to,
      subject,
      body,
      is_html: Boolean(args.html),
    },
  };
  if (USER_ID) payload.user_id = USER_ID;

  const data = await composioJson(
    `/api/v3/tools/execute/${encodeURIComponent(GMAIL_SEND_ACTION)}`,
    { method: "POST", apiKey, body: payload },
  );
  if (!data) {
    return { sent: false, reason: "Composio execute request failed" };
  }

  if (data.successful !== true) {
    const err = typeof data.error === "string" ? data.error : "tool execution unsuccessful";
    return { sent: false, reason: err };
  }

  // Pull a best-effort message id out of the tool's variable output shape.
  const out = (data.data ?? {}) as Record<string, unknown>;
  const response = (out.response_data ?? out) as Record<string, unknown>;
  const messageId =
    (typeof response.id === "string" && response.id) ||
    (typeof response.threadId === "string" && response.threadId) ||
    (typeof out.id === "string" && out.id) ||
    undefined;

  return { sent: true, messageId: messageId || undefined };
}
