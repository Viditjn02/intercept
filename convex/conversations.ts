import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================================
// INTERCEPT — CHAT STATE (conversations + messages).
//
// This module owns the CHAT data model: the public `send` mutation, the reactive
// `getMessages` / `getConversations` queries the UI subscribes to, and the
// internal mutations the streaming router (convex/chat.ts) uses to grow an
// assistant message token-by-token.
//
// DEPLOY-SAFETY: this is a queries/mutations module — it is NEVER "use node".
// The router that calls OpenAI/gbrain lives in convex/chat.ts ("use node") and
// only schedules the internal mutations defined here. Streaming is Convex-native:
// `generate` patches `messages.content` incrementally and toggles `isStreaming`;
// the frontend reads the live token feed straight off `getMessages` (no extra
// streaming component, so nothing new to deploy). The 24/7 cron can insert a
// `proactive` assistant message directly via `postProactiveMessage`.
// ============================================================================

const ROLE_VALIDATOR = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system"),
);

/** Short, human title from the first user message (for the sidebar). */
function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "New conversation";
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

// ---------------------------------------------------------------------------
// Reactive reads — the UI subscribes to these.
// ---------------------------------------------------------------------------

/** All conversations, most recently active first (the sidebar). */
export const getConversations = query({
  args: {},
  handler: async (ctx): Promise<Doc<"conversations">[]> => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_recent")
      .order("desc")
      .take(50);
  },
});

/** One conversation header (title + last routed intent). */
export const getConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (
    ctx,
    { conversationId },
  ): Promise<Doc<"conversations"> | null> => {
    return await ctx.db.get(conversationId);
  },
});

/**
 * All messages for a conversation, in send order. Reactive: while the router
 * streams, the assistant row's `content` grows on every patch and re-renders
 * here; `isStreaming` flips false on completion. This IS the live token feed.
 */
export const getMessages = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }): Promise<Doc<"messages">[]> => {
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect();
  },
});

/**
 * Recent PROACTIVE assistant messages across ALL conversations — the 24/7 cron's
 * overnight wins ("overnight I found 3 hot leads…"). Powers Acey's proactive-win
 * bubble. Bounded, read-only, newest-first; returns [] for a fresh deployment so
 * the mascot simply shows no bubble. Never throws.
 *
 * Bounded scan: pulls the newest ~200 messages off the default creation-time
 * index and filters to `proactive`, so it stays cheap even with no dedicated
 * index. The mascot only needs the latest handful.
 */
export const recentProactive = query({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<
    {
      _id: Id<"messages">;
      conversationId: Id<"conversations">;
      runId: Id<"runs"> | null;
      intent: string | null;
      content: string;
      createdAt: number;
    }[]
  > => {
    const take = Math.min(Math.max(limit ?? 5, 1), 20);
    const recent = await ctx.db.query("messages").order("desc").take(200);
    return recent
      .filter((m) => m.proactive === true)
      .slice(0, take)
      .map((m) => ({
        _id: m._id,
        conversationId: m.conversationId,
        runId: m.runId ?? null,
        intent: m.intent ?? null,
        content: m.content,
        createdAt: m.createdAt,
      }));
  },
});

// ---------------------------------------------------------------------------
// Public write — the chat input box calls this.
// ---------------------------------------------------------------------------

/**
 * Send a user message. Creates the conversation on first send, inserts the user
 * message, inserts an empty streaming assistant placeholder, and schedules the
 * router (convex/chat.ts `generate`) to classify + reply. Returns the ids so the
 * client can scroll to the new turn.
 */
export const send = mutation({
  args: {
    text: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (
    ctx,
    { text, conversationId },
  ): Promise<{
    conversationId: Id<"conversations">;
    userMessageId: Id<"messages">;
    assistantMessageId: Id<"messages">;
  }> => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error("send: text must not be empty");
    }

    const now = Date.now();

    let convId: Id<"conversations">;
    if (conversationId) {
      convId = conversationId;
      await ctx.db.patch(convId, { lastMessageAt: now });
    } else {
      convId = await ctx.db.insert("conversations", {
        title: deriveTitle(trimmed),
        createdAt: now,
        lastMessageAt: now,
      });
    }

    const userMessageId = await ctx.db.insert("messages", {
      conversationId: convId,
      role: "user",
      content: trimmed,
      createdAt: now,
    });

    // Empty assistant placeholder, flagged streaming. The router fills it in.
    const assistantMessageId = await ctx.db.insert("messages", {
      conversationId: convId,
      role: "assistant",
      content: "",
      isStreaming: true,
      createdAt: now + 1,
    });

    await ctx.scheduler.runAfter(0, internal.chat.generate, {
      conversationId: convId,
      userMessageId,
      assistantMessageId,
    });

    return { conversationId: convId, userMessageId, assistantMessageId };
  },
});

/**
 * Create an empty conversation up-front (the sidebar "New chat" button). The
 * first `send` with no conversationId also creates one, so this is optional —
 * but the sidebar wants an id immediately to select it.
 */
export const createConversation = mutation({
  args: { title: v.optional(v.string()) },
  handler: async (ctx, { title }): Promise<Id<"conversations">> => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      title: title?.trim() || "New conversation",
      createdAt: now,
      lastMessageAt: now,
    });
  },
});

/** Delete a conversation and all of its messages (sidebar trash button). */
export const deleteConversation = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }): Promise<null> => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect();
    for (const m of msgs) await ctx.db.delete(m._id);
    await ctx.db.delete(conversationId);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal reads/writes — only the router (convex/chat.ts) and cron call these.
// ---------------------------------------------------------------------------

/** Recent messages (tail), so the router has conversation context for routing. */
export const getRecentMessages = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { conversationId, limit }): Promise<Doc<"messages">[]> => {
    const all = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect();
    const n = limit ?? 12;
    return all.slice(Math.max(0, all.length - n));
  },
});

/** Read one message (router + the /chat-stream SSE poller use this). */
export const getMessageInternal = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<Doc<"messages"> | null> => {
    return await ctx.db.get(messageId);
  },
});

/** Overwrite a streaming assistant message's content (idempotent token flush). */
export const appendToMessage = internalMutation({
  args: { messageId: v.id("messages"), content: v.string() },
  handler: async (ctx, { messageId, content }): Promise<void> => {
    await ctx.db.patch(messageId, { content });
  },
});

/**
 * Finalize a streamed assistant message: persist the authoritative text, clear
 * the streaming flag, and stamp the routed intent. Called once at the end of a
 * `generate` turn.
 */
export const finalizeStream = internalMutation({
  args: {
    messageId: v.id("messages"),
    content: v.string(),
    intent: v.optional(v.string()),
    runId: v.optional(v.id("runs")),
  },
  handler: async (ctx, { messageId, content, intent, runId }): Promise<void> => {
    const patch: {
      content: string;
      isStreaming: boolean;
      intent?: string;
      runId?: Id<"runs">;
    } = { content, isStreaming: false };
    if (intent) patch.intent = intent;
    if (runId) patch.runId = runId;
    await ctx.db.patch(messageId, patch);
  },
});

/** Record the last routed intent on the conversation (header chip). */
export const setConversationIntent = internalMutation({
  args: { conversationId: v.id("conversations"), intent: v.string() },
  handler: async (ctx, { conversationId, intent }): Promise<void> => {
    await ctx.db.patch(conversationId, { lastIntent: intent });
  },
});

/**
 * Insert a complete (non-streaming) assistant message for an EXTRA capability run
 * fanned out from a compound prompt ("find competitors AND customers AND ads").
 * The router (convex/chat.ts) creates one of these per additional capability and
 * links a run to it, so each capability gets its own board on the canvas. Returns
 * the new messageId so the caller can attach a run via api.runs.createRun.
 */
export const addRunMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    intent: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { conversationId, content, intent },
  ): Promise<Id<"messages">> => {
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversationId,
      role: "assistant",
      content,
      isStreaming: false,
      intent,
      createdAt: now + 2,
    });
    await ctx.db.patch(conversationId, { lastMessageAt: now });
    return messageId;
  },
});

/**
 * Insert a proactive assistant message (the 24/7 cron summarizing what it found
 * overnight). Distinct from a streamed reply: it's complete on insert and tagged
 * `proactive` so the UI can badge it ("while you were away…").
 */
export const postProactiveMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    runId: v.optional(v.id("runs")),
    intent: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { conversationId, content, runId, intent },
  ): Promise<Id<"messages">> => {
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversationId,
      role: "assistant",
      content,
      proactive: true,
      isStreaming: false,
      runId,
      intent,
      createdAt: now,
    });
    await ctx.db.patch(conversationId, { lastMessageAt: now });
    return messageId;
  },
});
