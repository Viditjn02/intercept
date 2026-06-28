"use node";

// ============================================================================
// INTERCEPT — SSRF-guarded download -> Convex File Storage.
//
// Isolated in its own "use node" module BECAUSE lib/safeFetch imports
// node:dns/promises. convex/agents/creative.ts cannot import safeFetch directly:
// it defines internalMutation/internalQuery, which Convex forbids in a "use node"
// module. So creative.run calls this action via ctx.runAction to fetch the Veo
// asset behind the SSRF guard and store it on Convex.
// ============================================================================

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { safeFetch } from "../lib/safeFetch";

export const storeFromUrl = internalAction({
  args: { url: v.string() },
  handler: async (ctx, { url }): Promise<{ storageId: Id<"_storage"> }> => {
    const res = await safeFetch(url); // https + DNS-validated + 25MB cap
    if (!res.ok) {
      throw new Error(`storeFromUrl: download failed (${res.status})`);
    }
    const blob = await res.blob();
    const storageId = await ctx.storage.store(blob);
    return { storageId };
  },
});

// ----------------------------------------------------------------------------
// Store raw base64 bytes (the free video worker's MP4) into Convex file storage
// and hand back a publicly-fetchable URL. The worker lives on localhost — which
// the SSRF guard would (correctly) block — so it returns the mp4 inline and we
// decode + store directly instead of fetching a URL. "use node" gives Buffer.
// ----------------------------------------------------------------------------
export const storeFromBase64 = internalAction({
  args: { base64: v.string(), contentType: v.optional(v.string()) },
  handler: async (
    ctx,
    { base64, contentType },
  ): Promise<{ storageId: Id<"_storage">; url: string | null }> => {
    const bytes = Buffer.from(base64, "base64");
    const blob = new Blob([bytes], { type: contentType ?? "video/mp4" });
    const storageId = await ctx.storage.store(blob);
    const url = await ctx.storage.getUrl(storageId);
    return { storageId, url };
  },
});
