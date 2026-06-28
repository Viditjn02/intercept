// ============================================================================
// INTERCEPT — AGENTMAIL CLIENT (the outreach beat)
// ----------------------------------------------------------------------------
// Sends the human-APPROVED in-thread reply as a real email/follow-up via
// AgentMail's REST API. The outreach action (convex/outreach.ts) calls
// sendMessage() AFTER a person has explicitly approved the draft — nothing here
// is ever auto-sent, and there is no posting to a community from this module.
//
// OFFICIAL APIs ONLY: every call is a plain fetch to https://api.agentmail.to
// with `Authorization: Bearer ${AGENTMAIL_API_KEY}`. No SDK, no vendored source,
// no extra npm deps — global fetch + AbortController only, so it bundles cleanly
// in Convex's default action runtime.
//
// GRACEFUL DEGRADATION: with no AGENTMAIL_API_KEY (or on any network/API error)
// every function NO-OPs and returns `{ sent:false } / { created:false }` with a
// human-readable `reason`. It NEVER throws, so it can never block the swarm,
// the brief, or the approval flow.
// ============================================================================

const DEFAULT_API_BASE = "https://api.agentmail.to";
const API_VERSION = "v0";
const REQUEST_TIMEOUT_MS = 12_000;

/** Resolve the API base (env override allowed for self-hosting/testing). */
function apiBase(): string {
  return (process.env.AGENTMAIL_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** The bearer key, or null when the feature should silently no-op. */
function apiKey(): string | null {
  const key = process.env.AGENTMAIL_API_KEY?.trim();
  return key ? key : null;
}

interface AgentMailResponse {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  error?: string;
}

/**
 * Single low-level REST call. Returns a structured result instead of throwing
 * so callers can degrade gracefully. Times out via AbortController so a hung
 * AgentMail call can never stall the approval flow.
 */
async function request(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<AgentMailResponse> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, json: null, error: "AGENTMAIL_API_KEY is not set" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${apiBase()}/${API_VERSION}${path}`, {
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
      json = null; // non-JSON / empty body — fine, we only read it defensively
    }

    if (!res.ok) {
      const apiMessage =
        (json && (json.message as string)) ||
        (json && (json.error as string)) ||
        `AgentMail responded ${res.status}`;
      return { ok: false, status: res.status, json, error: apiMessage };
    }

    return { ok: true, status: res.status, json };
  } catch (err: unknown) {
    const reason =
      err instanceof Error
        ? err.name === "AbortError"
          ? `AgentMail request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : err.message
        : "AgentMail request failed";
    return { ok: false, status: 0, json: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** First string field that is present, for tolerant response parsing. */
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
// createInbox — provision a sending inbox. Called once and cached so repeated
// sends reuse the same address. Provide AGENTMAIL_INBOX_ID to skip creation and
// send from an existing inbox.
// ---------------------------------------------------------------------------
export interface CreateInboxArgs {
  /** Desired local-part, e.g. "intercept-outreach". Optional — API may assign. */
  username?: string;
  /** Sending domain, if your AgentMail account has a custom one. Optional. */
  domain?: string;
  /** Friendly display name shown to recipients. Optional. */
  displayName?: string;
}

export interface CreateInboxResult {
  created: boolean;
  /** Inbox id, which is also the sending email address on AgentMail. */
  inboxId?: string;
  address?: string;
  reason?: string;
}

export async function createInbox(
  args: CreateInboxArgs = {},
): Promise<CreateInboxResult> {
  if (!apiKey()) {
    return { created: false, reason: "AGENTMAIL_API_KEY is not set" };
  }

  const body: Record<string, unknown> = {};
  if (args.username) body.username = args.username;
  if (args.domain) body.domain = args.domain;
  if (args.displayName) body.display_name = args.displayName;

  const res = await request("POST", "/inboxes", body);
  if (!res.ok) {
    return { created: false, reason: res.error };
  }

  const inboxId = pickString(res.json, "inbox_id", "id", "address", "email");
  return { created: Boolean(inboxId), inboxId, address: inboxId, reason: inboxId ? undefined : "AgentMail returned no inbox id" };
}

// Module-level cache so we provision at most one inbox per process.
let cachedInboxId: string | null = null;

/**
 * Resolve a usable inbox id: explicit arg > AGENTMAIL_INBOX_ID env > cached >
 * freshly created. Returns null (never throws) if one can't be obtained.
 */
async function ensureInboxId(explicit?: string): Promise<string | null> {
  if (explicit?.trim()) return explicit.trim();
  const envInbox = process.env.AGENTMAIL_INBOX_ID?.trim();
  if (envInbox) return envInbox;
  if (cachedInboxId) return cachedInboxId;

  const created = await createInbox({ username: "intercept-outreach", displayName: "INTERCEPT" });
  if (created.inboxId) {
    cachedInboxId = created.inboxId;
    return cachedInboxId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// sendMessage — send the approved reply as an email / in-thread follow-up.
// ---------------------------------------------------------------------------
export interface SendMessageArgs {
  /** Recipient. Optional — falls back to AGENTMAIL_DEFAULT_TO, else the inbox itself (demo self-send). */
  to?: string;
  subject: string;
  text: string;
  /** Optional HTML body; the text body is always sent. */
  html?: string;
  /** Send from a specific inbox; otherwise resolved/created automatically. */
  inboxId?: string;
}

export interface SendMessageResult {
  sent: boolean;
  /** AgentMail message id, when the send succeeded. */
  id?: string;
  threadId?: string;
  from?: string;
  to?: string;
  reason?: string;
}

export async function sendMessage(args: SendMessageArgs): Promise<SendMessageResult> {
  if (!apiKey()) {
    return { sent: false, reason: "AGENTMAIL_API_KEY is not set" };
  }

  const subject = args.subject?.trim();
  const text = args.text?.trim();
  if (!subject || !text) {
    return { sent: false, reason: "sendMessage requires a non-empty subject and text" };
  }

  const inboxId = await ensureInboxId(args.inboxId);
  if (!inboxId) {
    return { sent: false, reason: "could not resolve or create an AgentMail inbox" };
  }

  // Recipient resolution: explicit > env default > the inbox itself (a safe
  // self-addressed demo send so the outreach beat is always demonstrable).
  const to = args.to?.trim() || process.env.AGENTMAIL_DEFAULT_TO?.trim() || inboxId;

  const body: Record<string, unknown> = { to, subject, text };
  if (args.html?.trim()) body.html = args.html;

  const res = await request(
    "POST",
    `/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
    body,
  );
  if (!res.ok) {
    return { sent: false, from: inboxId, to, reason: res.error };
  }

  const id = pickString(res.json, "message_id", "id", "messageId");
  const threadId = pickString(res.json, "thread_id", "threadId");
  return { sent: Boolean(id) || res.ok, id, threadId, from: inboxId, to };
}
