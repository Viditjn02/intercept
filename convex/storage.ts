"use node";

// ============================================================================
// HOLMES — SSRF-guarded download -> Convex File Storage.
//
// Isolated in its own "use node" module BECAUSE lib/safeFetch imports
// node:dns/promises. convex/agents/creative.ts cannot import safeFetch directly:
// it defines internalMutation/internalQuery, which Convex forbids in a "use node"
// module. So creative.run calls this action via ctx.runAction to fetch the Veo
// asset behind the SSRF guard and store it on Convex.
// ============================================================================

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { safeFetch } from "../lib/safeFetch";

export const storeFromUrl = internalAction({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const res = await safeFetch(url); // https + DNS-validated + 25MB cap
    if (!res.ok) {
      throw new Error(`storeFromUrl: download failed (${res.status})`);
    }
    const blob = await res.blob();
    const storageId = await ctx.storage.store(blob);
    return { storageId };
  },
});
