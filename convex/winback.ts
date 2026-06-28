// ============================================================================
// INTERCEPT — WIN-BACK (backend)
// ----------------------------------------------------------------------------
// Surfaces a company's CLOSED-LOST deals, detects when the reason they said no
// has DISSOLVED, and ranks who to re-engage TODAY — with a TRANSPARENT score.
//
//   winbackList(action) { targetUrl } -> { accounts: WinBackAccount[] }
//
// For the target company's space it produces 5 realistic dead deals. Each one
// carries why it died (`lostReason`), what JUST changed to revive it
// (`retrigger`), a transparent 4-factor breakdown, a blended `score` (0-100),
// and a warm re-engage opener that references the change.
//
// CONVEX RULES (deploy-safety, mirrors convex/conversationSim.ts):
//   - DEFAULT runtime — NOT "use node" — so lib/openai bundles cleanly (it's the
//     OpenAI SDK over fetch, valid in the default runtime).
//   - GRACEFUL ABOVE ALL: a missing OPENAI_API_KEY, a model error, or bad JSON
//     degrades to a believable CANNED list of 5 accounts. This action NEVER
//     throws and NEVER returns an empty list.
// ============================================================================

import { v } from "convex/values";
import { action } from "./_generated/server";
import { chatJSON } from "../lib/openai";

// ----------------------------------------------------------------------------
// The result shape. Mirrored in components/WinBackPanel.tsx.
// ----------------------------------------------------------------------------
interface WinBackFactors {
  /** We shipped the thing that was blocking the deal. 0-100. */
  shippedIt: number;
  /** Their world changed — new role, new round, new mandate. 0-100. */
  theyChanged: number;
  /** The relationship never fully went cold. 0-100. */
  stillWarm: number;
  /** Signals this deal looks re-winnable right now. 0-100. */
  looksReWon: number;
}

export interface WinBackAccount {
  company: string;
  /** Role / title of the person to re-engage. */
  persona: string;
  /** Why the deal died, in one line. */
  lostReason: string;
  /** What JUST changed that re-opens the door. */
  retrigger: string;
  factors: WinBackFactors;
  /** 0-100 overall re-engage priority. */
  score: number;
  /** A warm one-line opener referencing the change. */
  reEngageLine: string;
}

interface WinBackResult {
  accounts: WinBackAccount[];
}

const TARGET_COUNT = 5;

function clamp100(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

/** Blend the four factors into a single priority score (transparent + stable). */
function scoreFromFactors(f: WinBackFactors): number {
  const blended =
    0.3 * f.shippedIt + 0.25 * f.theyChanged + 0.25 * f.stillWarm + 0.2 * f.looksReWon;
  return clamp100(blended);
}

/** Bare host for the target, mirroring lib/orangeslice normalizeDomain shape. */
function hostOf(input: string): string {
  let host = (input || "").trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^https?:\/\//, "").replace(/^www\./, "");
  host = host.split("/")[0].split("?")[0].split("#")[0];
  return host.trim();
}

/** A readable brand from a host: "acme.io" -> "Acme". */
function brandOf(host: string): string {
  const stem = host.split(".")[0] || "the company";
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

// ----------------------------------------------------------------------------
// CANNED fallback — a believable, RANKED list of 5 dead-but-revivable deals,
// lightly personalized to the target's brand. Deterministic, never throws.
// ----------------------------------------------------------------------------
function cannedAccounts(targetUrl: string): WinBackAccount[] {
  const brand = brandOf(hostOf(targetUrl) || "your");

  const rows: Omit<WinBackAccount, "score">[] = [
    {
      company: "Northwind Logistics",
      persona: "VP of Revenue Operations",
      lostReason: "Stalled at security review — they had no SSO / SAML on the plan.",
      retrigger: `You shipped SSO + SCIM last month — the exact blocker is gone.`,
      factors: { shippedIt: 95, theyChanged: 62, stillWarm: 78, looksReWon: 90 },
      reEngageLine: `Hi — last year SSO was the dealbreaker for Northwind. We just shipped SAML + SCIM, so I wanted to reopen the door before your next ${brand} cycle.`,
    },
    {
      company: "Brightwave Health",
      persona: "Director of Growth",
      lostReason: "Champion left mid-cycle and the deal lost its internal sponsor.",
      retrigger: "Your old champion just resurfaced as VP Marketing at Brightwave.",
      factors: { shippedIt: 40, theyChanged: 92, stillWarm: 85, looksReWon: 80 },
      reEngageLine:
        "Congrats on the VP role! You championed us at your last company — figured Brightwave might be an even better fit for what we do.",
    },
    {
      company: "Cobalt Analytics",
      persona: "Head of Demand Gen",
      lostReason: "No budget — they were pre-revenue and deferred to next fiscal year.",
      retrigger: "They just announced a $14M Series B — budget is no longer the wall.",
      factors: { shippedIt: 30, theyChanged: 88, stillWarm: 60, looksReWon: 74 },
      reEngageLine:
        "Saw the Series B — congrats. Budget was the only blocker last time we talked, so the timing finally lines up. Worth 15 minutes?",
    },
    {
      company: "Meridian Retail Group",
      persona: "Senior Marketing Manager",
      lostReason: "Chose an incumbent competitor on a 12-month contract.",
      retrigger: "That contract is up for renewal in 6 weeks — the switching window is open.",
      factors: { shippedIt: 55, theyChanged: 58, stillWarm: 52, looksReWon: 66 },
      reEngageLine:
        "I know you went another direction last year — your renewal window is coming up, and a lot has changed on our side. Open to a quick side-by-side?",
    },
    {
      company: "Atlas Fintech",
      persona: "Growth Lead",
      lostReason: "Timing — mid-replatform, asked us to circle back in two quarters.",
      retrigger: "Their replatform shipped — they're now hiring across go-to-market.",
      factors: { shippedIt: 35, theyChanged: 64, stillWarm: 48, looksReWon: 55 },
      reEngageLine:
        "You asked me to circle back once the replatform was done — looks like it just shipped and you're scaling GTM. Perfect moment to pick this back up.",
    },
  ];

  return rows
    .map((r) => ({ ...r, score: scoreFromFactors(r.factors) }))
    .sort((a, b) => b.score - a.score);
}

// ----------------------------------------------------------------------------
// Coerce the model's loose JSON into a strict, ranked WinBackAccount[]. Any
// shape drift (too few rows, missing keys) falls back to the canned list so the
// UI is never empty.
// ----------------------------------------------------------------------------
function normalize(raw: unknown, targetUrl: string): WinBackAccount[] {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawAccounts = Array.isArray(obj.accounts) ? obj.accounts : [];

  const accounts: WinBackAccount[] = [];
  for (const a of rawAccounts) {
    const row = (a ?? {}) as Record<string, unknown>;
    const company = typeof row.company === "string" ? row.company.trim() : "";
    const persona = typeof row.persona === "string" ? row.persona.trim() : "";
    const lostReason = typeof row.lostReason === "string" ? row.lostReason.trim() : "";
    const retrigger = typeof row.retrigger === "string" ? row.retrigger.trim() : "";
    const reEngageLine =
      typeof row.reEngageLine === "string" ? row.reEngageLine.trim() : "";
    if (!company || !persona || !lostReason || !retrigger || !reEngageLine) continue;

    const fObj = (row.factors ?? {}) as Record<string, unknown>;
    const factors: WinBackFactors = {
      shippedIt: clamp100(fObj.shippedIt),
      theyChanged: clamp100(fObj.theyChanged),
      stillWarm: clamp100(fObj.stillWarm),
      looksReWon: clamp100(fObj.looksReWon),
    };

    // Trust the model's score only if it is a real number; otherwise blend it.
    const score =
      typeof row.score === "number" && Number.isFinite(row.score)
        ? clamp100(row.score)
        : scoreFromFactors(factors);

    accounts.push({ company, persona, lostReason, retrigger, factors, score, reEngageLine });
  }

  // Need a real, rankable list — anything less degrades to the canned set.
  if (accounts.length < TARGET_COUNT) {
    return cannedAccounts(targetUrl);
  }

  return accounts
    .slice(0, TARGET_COUNT)
    .sort((a, b) => b.score - a.score);
}

// ----------------------------------------------------------------------------
// The action.
// ----------------------------------------------------------------------------
export const winbackList = action({
  args: { targetUrl: v.string() },
  handler: async (_ctx, { targetUrl }): Promise<WinBackResult> => {
    try {
      const host = hostOf(targetUrl) || "the company";
      const brand = brandOf(host);

      const system =
        "You are INTERCEPT, a revenue copilot focused on WIN-BACK: re-engaging a " +
        "company's closed-lost deals the moment the reason they said no has dissolved. " +
        "You think like a sharp RevOps leader. For the target company's space you " +
        "surface realistic dead deals and, for each, name (1) why it died and (2) the " +
        "SPECIFIC thing that JUST changed to re-open it — e.g. 'You shipped SSO', " +
        "'Champion promoted to VP', 'They raised a Series B', 'Their contract is up for " +
        "renewal'. Score transparently across four factors. The re-engage opener must be " +
        "warm, human, and reference the change — never generic or spammy.";

      const user =
        `TARGET COMPANY\n` +
        `- Domain: ${host}\n` +
        `- Brand: ${brand}\n\n` +
        `Produce ${TARGET_COUNT} realistic closed-lost accounts in ${brand}'s space that ` +
        `are NOW re-winnable. Return a JSON object with this exact shape:\n` +
        `{\n` +
        `  "accounts": [        // EXACTLY ${TARGET_COUNT} entries\n` +
        `    {\n` +
        `      "company": string,        // the prospect company that went dark\n` +
        `      "persona": string,        // the role/title to re-engage (e.g. "VP of RevOps")\n` +
        `      "lostReason": string,     // why the deal died, ONE line\n` +
        `      "retrigger": string,      // what JUST changed to re-open it, ONE line\n` +
        `      "factors": {              // each 0-100, be specific and varied\n` +
        `        "shippedIt": number,    // we shipped the thing that was blocking it\n` +
        `        "theyChanged": number,  // their world changed (role/round/mandate)\n` +
        `        "stillWarm": number,    // the relationship never fully went cold\n` +
        `        "looksReWon": number    // overall signal this is re-winnable now\n` +
        `      },\n` +
        `      "score": number,          // 0-100 overall re-engage priority\n` +
        `      "reEngageLine": string    // one warm opener that references the change\n` +
        `    }\n` +
        `  ]\n` +
        `}\n` +
        `Make the ${TARGET_COUNT} accounts DISTINCT (different lost reasons + different ` +
        `retriggers) and spread the scores so a clear ranking emerges.`;

      const raw = await chatJSON<Record<string, unknown>>({
        system,
        user,
        temperature: 0.7,
        maxTokens: 1200,
      });

      return { accounts: normalize(raw, targetUrl) };
    } catch {
      // Missing key, model error, bad JSON — degrade to the canned list.
      return { accounts: cannedAccounts(targetUrl) };
    }
  },
});
