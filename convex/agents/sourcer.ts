// ============================================================================
// INTERCEPT — SOURCER AGENT  (REAL outbound discovery)
// ----------------------------------------------------------------------------
// Turns the run's brief (or its campaign) into a list of real decision-makers,
// each a `prospects` row the canvas pipeline renders. The data is REAL and
// layered, degrading gracefully:
//
//   1. ACCOUNTS  — OrangeSlice/Apollo `discoverCompanies(icp)` when a key is set;
//                  otherwise lib/sourcing's LLM+seed synthesis (labeled honestly).
//   2. PEOPLE    — OrangeSlice/Apollo `findPeople(domain, personas)` for real
//                  decision-makers at each account (emails locked here).
//   3. EMAIL     — Fiber `findContact` for a VERIFIED work email (emailVerified
//                  is true ONLY when Fiber confirmed it). FALLBACK: when Fiber
//                  has no match, the OSS guesser (enrich/emailGuess, email-sleuth
//                  port) yields a clearly-UNVERIFIED best-effort address so
//                  outbound still has a target — emailVerified stays UNSET.
//   4. SIGNAL    — lib/signals `findSignal` attaches one warm buying trigger.
//
// Each prospect is enriched then inserted at "enriched" (the qualifier scores it
// next). NEVER throws — a single prospect failure can't abort the run; the
// orchestrator owns this agent's board tile.
// ============================================================================

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { CampaignBrief, SourcedProspect, Signal } from "../../lib/contract";
import { MAX_PROSPECTS_PER_RUN } from "../../lib/contract";
import { sourceProspects } from "../../lib/sourcing";
import {
  discoverCompanies,
  findPeople,
  enrichCompany,
  hasOrangeSliceKey,
} from "../../lib/orangeslice";
import { findContact, hasFiberKey } from "../../lib/fiber";
import { findSignal } from "../../lib/signals";
import { guessEmailWithMx } from "../enrich/emailGuess";

const DEFAULT_PERSONAS = [
  "Head of Growth",
  "VP of Sales",
  "Founder",
  "Head of RevOps",
];

interface EnrichedRow extends SourcedProspect {
  employeeCount?: string;
  email?: string;
  emailVerified?: boolean;
  signal?: Signal;
  source?: string;
}

export const run = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<{ sourced: number }> => {
    const runDoc: Doc<"runs"> | null = await ctx.runQuery(
      internal.runs.getRunInternal,
      { runId },
    );
    if (!runDoc) throw new Error(`sourcer: run ${runId} not found`);

    const brief = await buildBrief(ctx, runDoc);
    const personas =
      brief.personas && brief.personas.length > 0 ? brief.personas : DEFAULT_PERSONAS;

    // 1. Source target prospects (real Apollo accounts+people, else LLM+seed).
    const sourced = await sourceList(brief, personas);

    let inserted = 0;
    await Promise.allSettled(
      sourced.slice(0, MAX_PROSPECTS_PER_RUN).map(async (p) => {
        // 2. Enrich: firmographics + verified email + warm signal (parallel).
        const [firmo, contact, signal] = await Promise.all([
          p.domain
            ? enrichCompany(p.domain).catch(() => null)
            : Promise.resolve(null),
          findContact({ company: p.company, role: p.title, name: p.name }).catch(
            () => null,
          ),
          findSignal(p).catch(() => undefined),
        ]);

        // 3. EMAIL — Fiber (verified) stays PRIMARY. When Fiber has no verified
        //    match, fall back to the OSS email guesser (email-sleuth port): a
        //    best-effort, clearly-UNVERIFIED address so outbound still has a
        //    target. `emailVerified` stays UNSET for a guess — ONLY Fiber sets
        //    it true. Degrades to no email if name/domain are missing.
        let email = contact?.verified ? contact.email : undefined;
        const verified = Boolean(contact?.verified && email);
        let source = verified
          ? "fiber"
          : p.source ?? (hasOrangeSliceKey() ? "orangeslice" : "synthesized");
        let guessConfidence: number | undefined;

        if (!verified) {
          const guessName = p.name ?? contact?.name;
          const guessDomain = p.domain;
          if (guessName && guessDomain) {
            const guess = await guessEmailWithMx(guessName, guessDomain).catch(
              () => null,
            );
            if (guess && guess.email && guess.confidence > 0) {
              email = guess.email;
              source = "guess";
              guessConfidence = guess.confidence;
            }
          }
        }

        const prospectId = await ctx.runMutation(internal.prospects.insert, {
          runId,
          campaignId: runDoc.campaignId,
          company: p.company,
          domain: p.domain,
          industry: p.industry ?? firmo?.industry,
          employeeCount: p.employeeCount ?? firmo?.employeeCount,
          location: p.location ?? firmo?.location,
          name: p.name ?? contact?.name,
          title: p.title ?? contact?.title,
          email,
          emailVerified: verified ? true : undefined,
          linkedinUrl: p.linkedinUrl ?? contact?.linkedinUrl,
          signal: signal ?? undefined,
          stage: "enriched",
          source,
        });
        inserted += 1;

        await ctx.runMutation(internal.events.log, {
          runId,
          prospectId,
          agent: "sourcer",
          kind: "sourced",
          message: `Sourced ${p.name ?? contact?.name ?? "a contact"}${
            p.title ? `, ${p.title}` : ""
          } at ${p.company}`,
        });
        if (verified && email) {
          await ctx.runMutation(internal.events.log, {
            runId,
            prospectId,
            agent: "sourcer",
            kind: "verified",
            message: `Fiber verified ${email} for ${p.name ?? p.company}`,
          });
        } else if (email && guessConfidence !== undefined) {
          await ctx.runMutation(internal.events.log, {
            runId,
            prospectId,
            agent: "sourcer",
            kind: "enriched",
            message: `Guessed ${email} (unverified · ${Math.round(
              guessConfidence * 100,
            )}% · Fiber had no match)`,
          });
        }
        if (signal) {
          await ctx.runMutation(internal.events.log, {
            runId,
            prospectId,
            agent: "sourcer",
            kind: "signal",
            message: `Signal · ${p.company}: ${signal.summary}`,
          });
        }
      }),
    );

    await ctx.runMutation(internal.runs.bumpCounters, {
      runId,
      sourcedCount: inserted,
    });

    return { sourced: inserted };
  },
});

// ---------------------------------------------------------------------------
// Sourcing: real Apollo accounts+people first, else LLM+seed synthesis.
// ---------------------------------------------------------------------------
async function sourceList(
  brief: CampaignBrief,
  personas: string[],
): Promise<EnrichedRow[]> {
  const rows: EnrichedRow[] = [];

  if (hasOrangeSliceKey()) {
    try {
      const accounts = await discoverCompanies({
        keywords: keywordsFromBrief(brief),
        limit: MAX_PROSPECTS_PER_RUN,
      });
      for (const account of accounts) {
        let person:
          | { name?: string; title?: string; linkedinUrl?: string }
          | undefined;
        if (account.domain) {
          const people = await findPeople(account.domain, personas, 1).catch(
            () => [],
          );
          person = people[0];
        }
        rows.push({
          company: account.company,
          domain: account.domain,
          industry: account.industry,
          location: account.location,
          employeeCount: account.employeeCount,
          name: person?.name,
          title: person?.title ?? personas[0],
          linkedinUrl: person?.linkedinUrl ?? account.linkedinUrl,
          source: "orangeslice",
        });
      }
    } catch {
      // Apollo down — fall through to synthesis.
    }
  }

  if (rows.length === 0) {
    const synthesized = await sourceProspects(brief, MAX_PROSPECTS_PER_RUN);
    for (const p of synthesized) {
      rows.push({ ...p, source: hasFiberKey() ? "orangeslice" : "synthesized" });
    }
  }

  return rows;
}

function keywordsFromBrief(brief: CampaignBrief): string {
  const parts = [brief.positioning, brief.icp, brief.description]
    .filter(Boolean)
    .join(" ");
  const words = parts
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Build the CampaignBrief the sourcer runs against: from the campaign when this
// run is campaign-scoped, else from the run's brief + resolved company.
// ---------------------------------------------------------------------------
async function buildBrief(
  ctx: ActionCtx,
  runDoc: Doc<"runs">,
): Promise<CampaignBrief> {
  if (runDoc.campaignId) {
    const campaign: Doc<"campaigns"> | null = await ctx.runQuery(
      internal.campaigns.getCampaignInternal,
      { campaignId: runDoc.campaignId },
    );
    if (campaign) {
      return {
        company: campaign.company,
        domain: campaign.domain,
        description: campaign.description,
        icp: campaign.icp,
        positioning: campaign.positioning,
        personas: campaign.personas,
        valueProp: campaign.valueProp,
      };
    }
  }

  const briefRow = await ctx.runQuery(api.brief.getBrief, { runId: runDoc._id });
  const company = (runDoc.company ?? runDoc.input ?? "").trim() || "the company";
  return {
    company,
    domain: runDoc.routedDomain ?? undefined,
    icp: briefRow?.icp ?? `Teams and buyers who would purchase ${company}.`,
    positioning: briefRow?.positioning ?? undefined,
  };
}
