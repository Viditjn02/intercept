import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { AGENTS, FANIN_DEADLINE_MS } from "../lib/contract";

// ============================================================================
// HOLMES — DETERMINISTIC REPLAY SEED (harness-owned)
//
// One atomic public mutation that materializes a full ReplayFixture
// (see lib/contract.ts) into Convex exactly as a flawless live run would leave
// it: a completed `runs` row (replay = true), every agent on the live board
// flipped to "done", the brief, communities, the moat threads, the
// human-approval drafts, and the pre-rendered creative.
//
// Why this exists: scripts/seed-demo.ts runs through ConvexHttpClient, which can
// only call PUBLIC functions. The swarm agents persist their results through
// INTERNAL mutations, so they can't be invoked from the seed script. Rather than
// couple the harness to nine other worktrees' not-yet-stable APIs, the replay
// path is fully self-contained here — that is what guarantees the on-camera demo
// cannot flop, regardless of the state of the live pipeline.
// ============================================================================

const fixtureValidator = v.object({
  input: v.string(),
  enrich: v.object({
    company: v.string(),
    icp: v.string(),
    positioning: v.string(),
  }),
  communities: v.array(
    v.object({
      name: v.string(),
      platform: v.string(),
      url: v.string(),
      why: v.string(),
    }),
  ),
  threads: v.array(
    v.object({
      platform: v.string(),
      url: v.string(),
      title: v.string(),
      snippet: v.string(),
      intentScore: v.number(),
      intentLabel: v.string(),
      author: v.optional(v.string()),
      communityName: v.optional(v.string()),
    }),
  ),
  drafts: v.array(
    v.object({
      threadUrl: v.string(),
      body: v.string(),
      confidence: v.number(),
    }),
  ),
  creativeUrl: v.string(),
});

export const seedFixture = mutation({
  args: { fixture: fixtureValidator },
  handler: async (ctx, { fixture }) => {
    const now = Date.now();

    // 1. The run — already complete, flagged as deterministic replay.
    const runId = await ctx.db.insert("runs", {
      input: fixture.input,
      inputType: "name",
      status: "complete",
      startedAt: now,
      deadlineAt: now + FANIN_DEADLINE_MS,
      company: fixture.enrich.company,
      replay: true,
    });

    // 2. Live swarm board — every agent done so the board renders fully lit.
    for (const agent of AGENTS) {
      await ctx.db.insert("agentStatus", {
        runId,
        agent,
        status: "done",
        note: "replay",
        startedAt: now,
        finishedAt: now,
      });
    }

    // 3. The brief (ICP + positioning).
    await ctx.db.insert("brief", {
      runId,
      icp: fixture.enrich.icp,
      positioning: fixture.enrich.positioning,
      generatedAt: now,
    });

    // 4. Communities — keep a name -> id map to link threads back.
    const communityIdByName = new Map<string, Id<"communities">>();
    for (const c of fixture.communities) {
      const communityId = await ctx.db.insert("communities", {
        runId,
        name: c.name,
        platform: c.platform,
        url: c.url,
        why: c.why,
      });
      communityIdByName.set(c.name, communityId);
    }

    // 5. Threads (THE MOAT) — keep a url -> id map to attach drafts.
    const threadIdByUrl = new Map<string, Id<"threads">>();
    for (const t of fixture.threads) {
      const communityId = t.communityName
        ? communityIdByName.get(t.communityName)
        : undefined;
      const threadId = await ctx.db.insert("threads", {
        runId,
        communityId,
        platform: t.platform,
        url: t.url,
        title: t.title,
        snippet: t.snippet,
        intentScore: t.intentScore,
        intentLabel: t.intentLabel,
        author: t.author,
      });
      threadIdByUrl.set(t.url, threadId);
    }

    // 6. Drafts — behind the human-approval gate (awaiting_approval).
    let draftsInserted = 0;
    for (const d of fixture.drafts) {
      const threadId = threadIdByUrl.get(d.threadUrl);
      if (!threadId) continue; // skip drafts whose thread isn't in the fixture
      await ctx.db.insert("drafts", {
        runId,
        threadId,
        body: d.body,
        confidence: d.confidence,
        status: "awaiting_approval",
      });
      draftsInserted++;
    }

    // 7. The pre-rendered creative.
    await ctx.db.insert("creatives", {
      runId,
      kind: "video",
      status: "done",
      model: "veo-3.1-fast",
      prompt: `30s vertical video ad for ${fixture.enrich.company}: ${fixture.enrich.positioning}`,
      url: fixture.creativeUrl,
    });

    return {
      runId,
      counts: {
        communities: fixture.communities.length,
        threads: fixture.threads.length,
        drafts: draftsInserted,
      },
    };
  },
});
