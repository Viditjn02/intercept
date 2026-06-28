// ============================================================================
// INTERCEPT — EMAIL DESIGN BACKEND
// ----------------------------------------------------------------------------
// The backend for the email-design surface: a small CRUD store of reusable,
// designer-built branded email templates (`emailTemplates`) plus two send
// actions that route a designed (HTML) or plain email through the SAME AgentMail
// path the outreach sender uses (lib/agentmail.sendMessage). The email-design UI
// (built by another agent) binds these BY NAME via makeFunctionReference — the
// exact reference shapes live in components/chatApi.ts, so the names + arg
// validators below mirror that committed contract verbatim:
//
//   CRUD (queries/mutations)
//     • listTemplates(query)     {}                                          -> Doc<"emailTemplates">[]  (newest first)
//     • saveTemplate(mutation)   { templateId?, name, subject?, html, body?, brand? } -> Id<"emailTemplates">
//     • getTemplate(query)       { templateId }                              -> Doc<"emailTemplates"> | null
//     • deleteTemplate(mutation) { templateId }                              -> { ok: boolean }
//
//   SEND (actions — route through AgentMail)
//     • sendDesigned(action) { to?, subject, body, html?, templateId?, emailId?, runId? } -> { sent, reason?, id? }
//     • sendPlain(action)    { to?, subject, body, emailId?, runId? }                     -> { sent, reason?, id? }
//
// CONVEX RULES (deploy-safety): default runtime — NOT "use node" — so it can hold
// queries + mutations alongside the send actions (lib/agentmail is plain fetch +
// AbortController, exactly like convex/agents/sender.ts, so it bundles cleanly).
// `Id`/`Doc` come from ./_generated/dataModel. The send path degrades gracefully:
// with no AGENTMAIL_API_KEY, sendMessage no-ops and returns { sent:false } — it
// never throws. When `emailId` is supplied and the send succeeds we best-effort
// stamp that `emails` row "sent" (guarded) so the pipeline reflects it.
// ============================================================================

import { v } from "convex/values";
import { query, mutation, action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { sendMessage } from "../lib/agentmail";
import { designEmail } from "../lib/brew";

// The send-result shape the UI references expect: a subset of lib/agentmail's
// SendMessageResult ({ sent, id?, threadId?, from?, to?, reason? }).
interface SendResult {
  sent: boolean;
  id?: string;
  threadId?: string;
  from?: string;
  to?: string;
  reason?: string;
}

// Optional brand styling carried on a saved template (mirrors EmailTemplateBrand
// in components/chatApi.ts / lib/brew BrandInfo). Strict object so unknown keys
// are rejected at the boundary.
const brandValidator = v.object({
  company: v.optional(v.string()),
  logoUrl: v.optional(v.string()),
  accentHex: v.optional(v.string()),
  fromName: v.optional(v.string()),
  websiteUrl: v.optional(v.string()),
  footerNote: v.optional(v.string()),
});

// ----------------------------------------------------------------------------
// Pure helpers.
// ----------------------------------------------------------------------------

/** Strip HTML to a readable plain-text fallback (no deps). Used when a designed
 *  template carries only an `html` body but a text part is required to send. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Resolve the plain-text body: explicit body wins, else derive it from html. */
function resolveText(body: string | undefined, html: string | undefined): string {
  const b = body?.trim();
  if (b) return b;
  const h = html?.trim();
  return h ? htmlToText(h) : "";
}

// ----------------------------------------------------------------------------
// CRUD — emailTemplates.
// ----------------------------------------------------------------------------

/**
 * Create or update a branded email template. With `templateId` it patches that
 * row; without one it inserts a new template. Returns the template id. The UI's
 * builder calls this with { name, subject?, html, body?, brand? } on save.
 */
export const saveTemplate = mutation({
  args: {
    templateId: v.optional(v.id("emailTemplates")),
    name: v.string(),
    subject: v.optional(v.string()),
    html: v.string(),
    body: v.optional(v.string()),
    brand: v.optional(brandValidator),
  },
  handler: async (ctx, args): Promise<Id<"emailTemplates">> => {
    const now = Date.now();
    const name = args.name.trim() || "Untitled template";
    const subject = args.subject?.trim() || undefined;
    const html = args.html;
    const body = args.body?.trim() || undefined;

    if (args.templateId) {
      const existing = await ctx.db.get(args.templateId);
      if (existing) {
        await ctx.db.patch(args.templateId, {
          name,
          subject,
          html,
          body,
          brand: args.brand,
          updatedAt: now,
        });
        return args.templateId;
      }
      // Fall through to insert if the id no longer exists (stale client).
    }

    return await ctx.db.insert("emailTemplates", {
      name,
      subject,
      html,
      body,
      brand: args.brand,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** All templates, newest-edited first (the template gallery). */
export const listTemplates = query({
  args: {},
  handler: async (ctx): Promise<Doc<"emailTemplates">[]> => {
    return await ctx.db
      .query("emailTemplates")
      .withIndex("by_updated")
      .order("desc")
      .collect();
  },
});

/** Read a single template (the editor load). Null when it doesn't exist. */
export const getTemplate = query({
  args: { templateId: v.id("emailTemplates") },
  handler: async (ctx, { templateId }): Promise<Doc<"emailTemplates"> | null> => {
    return await ctx.db.get(templateId);
  },
});

/** Delete a template. Idempotent — a missing id is a no-op. */
export const deleteTemplate = mutation({
  args: { templateId: v.id("emailTemplates") },
  handler: async (ctx, { templateId }): Promise<{ ok: boolean }> => {
    const existing = await ctx.db.get(templateId);
    if (!existing) return { ok: false };
    await ctx.db.delete(templateId);
    return { ok: true };
  },
});

// ----------------------------------------------------------------------------
// SEND — route a designed/plain email through the existing AgentMail path.
// ----------------------------------------------------------------------------

/**
 * Send a DESIGNED (branded HTML) email. Either pass a `templateId` (its
 * subject/html/body are used as defaults) or pass subject/body/html inline; any
 * explicit arg overrides the template's stored field. The plain-text part is
 * derived from html when absent. Routes through lib/agentmail.sendMessage (the
 * same path as the outreach sender). When `emailId` is supplied and the send
 * succeeds, the `emails` row is best-effort stamped "sent". Never throws.
 */
export const sendDesigned = action({
  args: {
    to: v.optional(v.string()),
    subject: v.string(),
    body: v.string(),
    html: v.optional(v.string()),
    templateId: v.optional(v.id("emailTemplates")),
    emailId: v.optional(v.id("emails")),
    runId: v.optional(v.id("runs")),
  },
  handler: async (ctx, args): Promise<SendResult> => {
    let subject = args.subject?.trim() || undefined;
    let html = args.html?.trim() || undefined;
    let body = args.body?.trim() || undefined;
    let tplBrand: Doc<"emailTemplates">["brand"] | undefined;

    if (args.templateId) {
      const tpl: Doc<"emailTemplates"> | null = await ctx.runQuery(
        api.emailDesign.getTemplate,
        { templateId: args.templateId },
      );
      if (tpl) {
        // Explicit args override the template's stored fields.
        subject = subject || tpl.subject?.trim() || undefined;
        html = html ?? (tpl.html?.trim() || undefined);
        body = body ?? (tpl.body?.trim() || undefined);
        tplBrand = tpl.brand;
      }
    }

    const resolvedSubject = subject?.trim();

    // "Brew renders on send": when copy is present but no HTML was supplied (the
    // client preview is only a stand-in), render a branded email here — this is
    // the side that holds the real BREW_API_KEY. designEmail never throws and
    // degrades to the default branded template, so the send is never blocked.
    if (!html && resolvedSubject && body) {
      const designed = await designEmail({ subject: resolvedSubject, body, brand: tplBrand });
      html = designed.html;
    }

    const resolvedText = resolveText(body, html);
    if (!resolvedSubject || !resolvedText) {
      return {
        sent: false,
        reason: "sendDesigned requires a subject and a body/html",
      };
    }

    const result = await sendMessage({
      to: args.to?.trim() || undefined,
      subject: resolvedSubject,
      text: resolvedText,
      html,
    });

    if (result.sent && args.emailId) {
      try {
        await ctx.runMutation(internal.emails.setStatus, {
          emailId: args.emailId,
          status: "sent",
          to: result.to,
          sentAt: Date.now(),
          agentmailId: result.id,
          agentmailThreadId: result.threadId,
        });
      } catch {
        // best-effort pipeline stamp — never block the send result.
      }
    }

    return result;
  },
});

/**
 * Send a PLAIN-text email (no template, no HTML) through the same AgentMail
 * path. When `emailId` is supplied and the send succeeds, the `emails` row is
 * best-effort stamped "sent". Never throws — degrades to { sent:false, reason }
 * when AgentMail isn't configured.
 */
export const sendPlain = action({
  args: {
    to: v.optional(v.string()),
    subject: v.string(),
    body: v.string(),
    emailId: v.optional(v.id("emails")),
    runId: v.optional(v.id("runs")),
  },
  handler: async (ctx, { to, subject, body, emailId }): Promise<SendResult> => {
    const s = subject.trim();
    const t = body.trim();
    if (!s || !t) {
      return { sent: false, reason: "sendPlain requires a subject and body" };
    }

    const result = await sendMessage({ to: to?.trim() || undefined, subject: s, text: t });

    if (result.sent && emailId) {
      try {
        await ctx.runMutation(internal.emails.setStatus, {
          emailId,
          status: "sent",
          to: result.to,
          sentAt: Date.now(),
          agentmailId: result.id,
          agentmailThreadId: result.threadId,
        });
      } catch {
        // best-effort pipeline stamp.
      }
    }

    return result;
  },
});
