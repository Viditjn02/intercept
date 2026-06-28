import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ============================================================================
// INTERCEPT — UNIFIED PLATFORM · FROZEN SCHEMA CONTRACT
// ----------------------------------------------------------------------------
// ONE AI-native chat. You paste/type anything; the ROUTER classifies intent and
// spawns a RUN (a swarm cycle) on the existing orchestrator. The chat replies
// conversationally on the LEFT; the live CANVAS on the RIGHT subscribes to these
// tables and lights up as the swarm works.
//
// All four capability surfaces write into ONE data model:
//   • CHAT        conversations · messages            (the centerpiece)
//   • ORCHESTRATE runs · agentStatus · events          (the live swarm board)
//   • DISCOVERY   communities · threads · drafts · brief (the moat — Exa/HN/Reddit)
//   • OUTBOUND    campaigns · prospects · emails        (OrangeSlice + Fiber + AgentMail)
//   • CONTENT     creatives · adCreatives               (video + generated ads)
//   • COMPETITOR  ads · adScanCache                      (token-free ad scan)
//
// CONVEX RULES (deploy-safety, do NOT violate):
//   - This module is NOT "use node" (schema never is).
//   - Every field that may be absent is OPTIONAL so a thin agent result still
//     renders. Nothing throws on missing data — the pipeline degrades, never blocks.
//   - `messages` is the CHAT table. The OUTBOUND email sequence lives in `emails`
//     (renamed to avoid the table-name collision). The two are distinct surfaces.
//   - `monitors` is GONE: the 24/7 watch is now an ACTIVE `campaign` (the cron
//     walks campaigns where status === "active").
//
// Keep this in lockstep with lib/contract.ts (the unions here MIRROR the TS types
// there). Changing a field shape is a contract change — tell every builder.
// ============================================================================

// A real, recent buying trigger attached to a prospect/thread. The moat: outreach
// is grounded in THIS signal, not a generic template. Optional everywhere because
// the sourcer may surface a lead before the enricher finds a fresh trigger.
const signalValidator = v.object({
  type: v.union(
    v.literal("funding"),
    v.literal("hiring"),
    v.literal("news"),
    v.literal("post"),
    v.literal("job_change"),
    v.literal("tech"),
    v.literal("other"),
  ),
  summary: v.string(), // one-line human-readable trigger
  url: v.optional(v.string()), // REAL clickable source — verifiable in one tap
  source: v.optional(v.string()), // e.g. "techcrunch.com", "linkedin", "exa"
  foundAt: v.number(),
});

// Raw shape of the input the router classified (kept for enrich/router compat).
const inputTypeValidator = v.union(
  v.literal("url"),
  v.literal("name"),
  v.literal("competitor"),
  v.literal("community"),
  v.literal("text"),
);

// The capability a run executes. The router maps a chat message to exactly one.
// (Mirrors lib/contract.ts Intent / CAPABILITY_PLANS.) "analyze" is the default
// full-swarm sweep when the user just pastes a company with no specific ask.
const intentValidator = v.union(
  v.literal("analyze"), // full sweep: discovery + competitor + content
  v.literal("discovery"), // community/thread intent radar (the moat)
  v.literal("outbound"), // find companies + decision-makers + draft emails
  v.literal("outreach"), // act: send / follow-up approved drafts
  v.literal("content"), // AD FACTORY (create): similar ad — image + copy + variations + video
  v.literal("competitor"), // AD INTELLIGENCE (scan): multi-platform ad scan + scoring
  v.literal("replicate"), // drop a post/ad URL → improved replica
  v.literal("social"), // algorithm hacking: trends + viral posts + reel + calendar
  v.literal("onboarding"), // zero-to-one PLG: in-app onboarding flow / product tour
);

export default defineSchema({
  // ==========================================================================
  // CHAT — the centerpiece. One conversation, a stream of messages. A user
  // message is classified by the router; the assistant message it produces may
  // carry a `runId` linking it to the swarm cycle whose canvas renders beside it.
  // ==========================================================================
  conversations: defineTable({
    title: v.string(), // short auto-title from the first message
    lastIntent: v.optional(v.string()), // last routed capability (for the header)
    createdAt: v.number(),
    lastMessageAt: v.number(),
  }).index("by_recent", ["lastMessageAt"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(), // final, persisted text (authoritative once streaming ends)
    // persistent-text-streaming StreamId — present only WHILE the assistant
    // message is streaming; the live token feed is read over the HTTP action and
    // handed off to `content` on completion.
    streamId: v.optional(v.string()),
    isStreaming: v.optional(v.boolean()),
    // The swarm cycle this message spawned (assistant messages that DID work).
    runId: v.optional(v.id("runs")),
    intent: v.optional(v.string()), // routed capability for this turn
    // True when posted proactively by the 24/7 cron ("overnight I found 3 …").
    proactive: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index("by_conversation", ["conversationId"]),

  // ==========================================================================
  // ORCHESTRATION — one RUN is one capability execution (a swarm cycle). It owns
  // the hard fan-in deadline so the board always settles. Reused, adapted from the
  // previous build: `agentStatus` drives the live tiles verbatim.
  // ==========================================================================
  runs: defineTable({
    // Provenance: which conversation/message/campaign spawned this run.
    conversationId: v.optional(v.id("conversations")),
    messageId: v.optional(v.id("messages")), // the assistant message to attach results to
    campaignId: v.optional(v.id("campaigns")), // set for outbound + 24/7 runs

    input: v.string(), // the raw user input / subject the swarm runs against
    inputType: inputTypeValidator,
    intent: intentValidator, // the capability this run executes
    trigger: v.union(v.literal("manual"), v.literal("chat"), v.literal("cron")),

    status: v.union(
      v.literal("running"),
      v.literal("complete"),
      v.literal("partial"),
      v.literal("failed"),
    ),
    startedAt: v.number(),
    deadlineAt: v.number(), // hard fan-in cap (startedAt + FANIN_DEADLINE_MS)

    company: v.optional(v.string()), // resolved by the router/enrich
    routedDomain: v.optional(v.string()), // canonical apex domain to scrape
    replay: v.optional(v.boolean()), // deterministic demo mode (cached fixture)
    skipVideo: v.optional(v.boolean()), // 24/7 ticks skip Veo to save credits

    // AD FACTORY provenance.
    sourceUrl: v.optional(v.string()), // flow (c): the dropped post/ad URL to replicate
    groundedOnAdId: v.optional(v.id("ads")), // flow (b): the scanned ad "Generate similar" mirrors

    // Roll-up counters for the board summary (best-effort, written by agents).
    sourcedCount: v.optional(v.number()),
    qualifiedCount: v.optional(v.number()),
    contactedCount: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_conversation", ["conversationId"])
    .index("by_campaign", ["campaignId"]),

  // Drives the live swarm board. One row per agent per run. Reused VERBATIM — the
  // orchestrator (convex/run.ts) owns these transitions. `agent` is a free string
  // so each intent's plan can use a different roster (see lib/contract.ts AGENTS).
  agentStatus: defineTable({
    runId: v.id("runs"),
    agent: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("skipped"),
      v.literal("failed"),
    ),
    note: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  }).index("by_run", ["runId"]),

  // A lightweight activity feed for the canvas live ticker. Agents append one line
  // per meaningful action so the UI shows the swarm "working" without coupling to
  // internal agent state. Also the substrate for proactive chat (cron summarizes
  // these into a `messages` row). Purely additive/optional.
  events: defineTable({
    conversationId: v.optional(v.id("conversations")),
    runId: v.optional(v.id("runs")),
    campaignId: v.optional(v.id("campaigns")),
    prospectId: v.optional(v.id("prospects")),
    agent: v.optional(v.string()),
    kind: v.string(), // sourced | enriched | qualified | drafted | sent | replied | found | …
    message: v.string(), // human-readable feed line
    createdAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_conversation", ["conversationId"]),

  // ==========================================================================
  // OUTBOUND — REAL OrangeSlice firmographics + Fiber verified emails + AgentMail.
  // A `campaign` is the standing instruction ("run outbound for <company>") AND
  // the 24/7 monitor: the cron spawns a fresh run for every ACTIVE campaign whose
  // cadence has elapsed. This replaces the old `monitors` table entirely.
  // ==========================================================================
  campaigns: defineTable({
    conversationId: v.optional(v.id("conversations")), // the chat that created it
    company: v.string(), // the seller (the user's own company)
    domain: v.optional(v.string()),
    description: v.optional(v.string()),
    icp: v.string(), // ideal customer profile, free text
    positioning: v.optional(v.string()),
    personas: v.optional(v.array(v.string())), // target titles, e.g. ["Head of Growth"]
    valueProp: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"), // active === the 24/7 watch is on
      v.literal("paused"),
      v.literal("archived"),
    ),
    // review = every send waits in the human-approval queue (default).
    // autopilot = the sender ships approved-quality drafts itself.
    autonomy: v.union(v.literal("review"), v.literal("autopilot")),
    cadenceMinutes: v.optional(v.number()), // how often the cron re-sources
    lastRunAt: v.optional(v.number()),
    lastRunId: v.optional(v.id("runs")),
    createdAt: v.number(),
  }).index("by_status", ["status"]),

  // A sourced decision-maker (company + person), moved through the pipeline stage
  // by stage. The canvas pipeline/kanban reads these. Firmographics from
  // OrangeSlice; verified email from Fiber (emailVerified === Fiber confirmed it).
  prospects: defineTable({
    campaignId: v.optional(v.id("campaigns")),
    runId: v.optional(v.id("runs")), // the swarm cycle that sourced it
    // Company (target account)
    company: v.string(),
    domain: v.optional(v.string()),
    industry: v.optional(v.string()),
    employeeCount: v.optional(v.string()),
    location: v.optional(v.string()),
    // Decision-maker
    name: v.optional(v.string()),
    title: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerified: v.optional(v.boolean()), // true ONLY when Fiber verified it
    linkedinUrl: v.optional(v.string()),
    // The warm trigger the outreach is grounded in (enricher/sourcer fills this).
    signal: v.optional(signalValidator),
    // Qualification
    fitScore: v.optional(v.number()), // 0-100
    fitReason: v.optional(v.string()),
    stage: v.union(
      v.literal("sourced"),
      v.literal("enriched"),
      v.literal("qualified"),
      v.literal("contacted"),
      v.literal("replied"),
      v.literal("booked"),
      v.literal("skipped"),
    ),
    skipReason: v.optional(v.string()),
    // Where the row's data came from, for honest provenance badges in the UI.
    source: v.optional(v.string()), // orangeslice | fiber | exa | html-fallback
    updatedAt: v.number(),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_run", ["runId"])
    .index("by_stage", ["campaignId", "stage"]),

  // The OUTBOUND email sequence (distinct from chat `messages`). `step` 0 is the
  // first touch; 1+ are follow-ups. Gated: the writer only ever creates "draft"; a
  // human (or autopilot) moves it to "approved"; ONLY the sender moves
  // "approved" -> "sent" via AgentMail. Replies land back here as "replied".
  emails: defineTable({
    campaignId: v.optional(v.id("campaigns")),
    prospectId: v.id("prospects"),
    runId: v.optional(v.id("runs")),
    step: v.number(), // 0 = initial, 1.. = follow-up index
    kind: v.union(v.literal("initial"), v.literal("followup")),
    subject: v.string(),
    body: v.string(),
    signalRef: v.optional(v.string()), // the signal summary the copy is grounded in
    to: v.optional(v.string()), // recipient at send time
    status: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("sent"),
      v.literal("replied"),
      v.literal("bounced"),
      v.literal("skipped"),
    ),
    sentAt: v.optional(v.number()),
    replyBody: v.optional(v.string()),
    repliedAt: v.optional(v.number()),
    // AgentMail correlation ids (lib/agentmail send result).
    agentmailId: v.optional(v.string()),
    agentmailThreadId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_prospect", ["prospectId"])
    .index("by_campaign", ["campaignId"])
    .index("by_status", ["status"]),

  // ==========================================================================
  // DISCOVERY (THE MOAT) — real, clickable, intent-scored LIVE conversations.
  // Detective agent (Exa, with the free HN Algolia / Reddit JSON fallback) writes
  // these. Kept VERBATIM from the green build, including the vector index.
  // ==========================================================================
  communities: defineTable({
    runId: v.id("runs"),
    name: v.string(),
    platform: v.string(),
    url: v.string(),
    why: v.string(),
  }).index("by_run", ["runId"]),

  threads: defineTable({
    runId: v.id("runs"),
    communityId: v.optional(v.id("communities")),
    platform: v.string(), // reddit | hackernews | forum
    url: v.string(), // REAL clickable URL — verifiable in one tap
    title: v.string(),
    snippet: v.string(),
    intentScore: v.number(), // 0-100
    intentLabel: v.string(), // browsing | comparing | frustrated | ready_to_buy
    author: v.optional(v.string()),
    // text-embedding-3-small (1536d) of "title\nsnippet". Optional so seeded rows
    // without embeddings stay valid (they simply aren't vector-indexed).
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_run", ["runId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["runId"],
    }),

  // The in-thread community reply, behind the human-approval gate. (Distinct from
  // `emails`: a draft is a reply dropped into the LIVE thread where the buyer is
  // already asking; once approved it can also be emailed via AgentMail.)
  drafts: defineTable({
    runId: v.id("runs"),
    threadId: v.id("threads"),
    body: v.string(),
    confidence: v.number(), // 0-1
    status: v.union(
      v.literal("awaiting_approval"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("posted"),
    ),
    // Stamped when a posted reply was emailed via AgentMail (optional/additive).
    agentmailId: v.optional(v.string()),
    agentmailThreadId: v.optional(v.string()),
  })
    .index("by_run", ["runId"])
    .index("by_thread", ["threadId"]),

  // Per-run resolved ICP + positioning the swarm runs against. Written by enrich,
  // repaired by the orchestrator fan-in so the board always has a brief to render.
  // (A run tied to a campaign seeds its brief from the campaign; an ad-hoc chat run
  // gets a brief with no campaign.)
  brief: defineTable({
    runId: v.id("runs"),
    icp: v.string(),
    positioning: v.string(),
    generatedAt: v.number(),
  }).index("by_run", ["runId"]),

  // ==========================================================================
  // CONTENT — in-house generation. Veo / fal-LTX video ad + a brand-consistent
  // landing page and ad copy built from the brief + the buyers' own language.
  // ==========================================================================
  creatives: defineTable({
    runId: v.id("runs"),
    kind: v.string(), // "video"
    status: v.union(
      v.literal("pending"),
      v.literal("rendering"),
      v.literal("done"),
      v.literal("failed"),
    ),
    model: v.string(),
    prompt: v.string(),
    url: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  }).index("by_run", ["runId"]),

  // ==========================================================================
  // COMPETITOR — Meta Ad Library intel: which of a competitor's ads are live and
  // how long they've run (longevity = a proxy for "this creative is working"), so
  // INTERCEPT can mirror the winning angle.
  // ==========================================================================
  ads: defineTable({
    runId: v.id("runs"),
    advertiser: v.string(),
    platform: v.string(), // facebook | instagram | audience_network | tiktok
    text: v.string(), // ad copy / primary text
    imageUrl: v.optional(v.string()),
    runningSince: v.optional(v.string()), // ISO date the ad started
    daysRunning: v.optional(v.number()), // longevity = proxy for a winning ad
    status: v.string(), // active | inactive
    url: v.string(), // permalink into the Ad Library

    // --- AD INTELLIGENCE (scan) extensions (all optional → existing rows valid) ---
    network: v.optional(v.string()), // "meta" | "tiktok"
    headline: v.optional(v.string()),
    cta: v.optional(v.string()),
    mediaType: v.optional(v.string()), // image | video | carousel | unknown
    thumbnailUrl: v.optional(v.string()),
    videoUrl: v.optional(v.string()),
    lastSeen: v.optional(v.string()),
    engagement: v.optional(
      v.object({
        likes: v.optional(v.number()),
        comments: v.optional(v.number()),
        shares: v.optional(v.number()),
      }),
    ),
    source: v.optional(v.string()), // which scan lane surfaced it
    perfScore: v.optional(v.number()), // 0-100 weighted performance score
    scores: v.optional(
      v.object({
        hook: v.number(),
        clarity: v.number(),
        cta: v.number(),
        quality: v.number(),
        engagement: v.number(),
      }),
    ),
    scalingSignal: v.optional(v.boolean()), // active + ≥21d ⇒ a scaling winner
    winningAngle: v.optional(v.string()),
    rank: v.optional(v.number()),
  }).index("by_run", ["runId"]),

  // ==========================================================================
  // AD FACTORY (create / replicate) — the generated similar/replica ads. adsmith
  // writes one row per generated ad; the image is gpt-image-1 (b64 → Convex
  // storage URL), degrading to a copy-only card when image gen is unavailable.
  // ==========================================================================
  adCreatives: defineTable({
    runId: v.id("runs"),
    kind: v.string(), // "image_ad" | "replica"
    groundedOnAdId: v.optional(v.id("ads")), // which scanned winner it mirrors
    sourceUrl: v.optional(v.string()), // flow (c): the dropped post/URL
    headline: v.string(),
    primaryText: v.string(),
    cta: v.string(),
    variations: v.array(
      v.object({
        headline: v.string(),
        primaryText: v.string(),
        cta: v.string(),
        angle: v.string(),
      }),
    ),
    strategy: v.string(), // OpenAI rationale: why this wins
    imagePrompt: v.string(),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    imageStatus: v.string(), // "done" | "degraded" | "failed"
    degraded: v.boolean(),
    degradedReason: v.optional(v.string()),
    model: v.string(),
    generatedAt: v.number(),
  }).index("by_run", ["runId"]),

  // The no-token scan path is expensive → cache raw ScannedAd[] for 6h per key.
  adScanCache: defineTable({
    key: v.string(), // `${slug(advertiser)}|${country}|${network}`
    ads: v.array(v.any()), // raw ScannedAd[] (pre-score)
    fetchedAt: v.number(),
    source: v.string(),
  }).index("by_key", ["key"]),

  // ==========================================================================
  // TRACK 1 — ALGORITHM HACKING (social / virality engine). The trendscout →
  // composer → reelmaker → calendar lane. The reel REUSES `creatives` with
  // kind "social_video" (kind is a free string) — no table for it here.
  // ==========================================================================

  // Live trends the trendscout surfaced for the run's market (Exa → HN/Reddit).
  trends: defineTable({
    runId: v.id("runs"),
    topic: v.string(),
    angle: v.string(),
    source: v.string(), // "exa" | "hackernews" | "reddit"
    url: v.optional(v.string()),
    score: v.number(), // 0-100 momentum
    why: v.string(),
    foundAt: v.number(),
  }).index("by_run", ["runId"]),

  // Multi-variant viral posts the composer drafted, scored by the virality model.
  posts: defineTable({
    runId: v.id("runs"),
    platform: v.string(), // "linkedin" | "x" | "tiktok" | "instagram"
    variant: v.number(),
    hook: v.string(),
    body: v.string(),
    hashtags: v.array(v.string()),
    angle: v.string(),
    trendRef: v.optional(v.string()),
    viralityScore: v.number(), // 0-100
    viralityBreakdown: v.object({
      hook: v.number(),
      emotion: v.number(),
      clarity: v.number(),
      timeliness: v.number(),
      cta: v.number(),
    }),
    createdAt: v.number(),
  }).index("by_run", ["runId"]),

  // The content calendar the scheduler laid the posts out across.
  contentCalendar: defineTable({
    runId: v.id("runs"),
    dayOffset: v.number(),
    platform: v.string(),
    postId: v.optional(v.id("posts")),
    title: v.string(),
    scheduledLabel: v.string(),
    status: v.string(), // "planned"
  }).index("by_run", ["runId"]),

  // ==========================================================================
  // TRACK 2 — SALES CYBORGS depth (prospect digital twin). The twin simulates a
  // buyer reading a drafted email and scores it before send.
  // ==========================================================================
  simulations: defineTable({
    runId: v.id("runs"),
    emailId: v.id("emails"),
    prospectId: v.id("prospects"),
    replyLikelihood: v.number(), // 0-100
    sentiment: v.string(), // "positive" | "neutral" | "negative"
    predictedReply: v.string(),
    objections: v.array(v.string()),
    suggestions: v.array(v.string()),
    score: v.number(), // 0-100 overall
    model: v.string(),
    createdAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_email", ["emailId"]),

  // ==========================================================================
  // TRACK 3 — ZERO-TO-ONE PLG (onboarding flow generator). The guide produces a
  // structured tour + a ready-to-paste Shepherd.js / OnboardJS embed snippet.
  // ==========================================================================
  onboardingFlows: defineTable({
    runId: v.id("runs"),
    productName: v.string(),
    framework: v.string(), // "shepherd" | "onboardjs"
    tourSteps: v.array(
      v.object({
        order: v.number(),
        target: v.string(), // CSS selector hint
        title: v.string(),
        body: v.string(),
        placement: v.string(), // "top" | "bottom" | "left" | "right" | "center"
        cta: v.optional(v.string()),
      }),
    ),
    embedSnippet: v.string(), // paste-ready init code
    generatedAt: v.number(),
  }).index("by_run", ["runId"]),

  // ==========================================================================
  // KNOWLEDGE ENGINE — the compounding wiki loop (Ingest → Query → Lint).
  // ONE page per GTM entity. Every run's REAL outputs become durable, dedup-able
  // facts here; the NEXT run on that entity pulls them into its prompt via
  // internal.knowledge.queryContext; the daily lint condenses pages so the
  // prompt never bloats. Mirrors lib/knowledge.ts (the single source of truth
  // for the loop's bounds). Every absent-able field is OPTIONAL so a thin
  // first-run page is valid; `embedding` is optional so a page written while
  // OpenAI is down still stores + lists (it simply isn't a vector hit until the
  // next ingest/lint recomputes it). Purely additive — nothing here can block a
  // run or a brief render.
  // ==========================================================================
  knowledge_pages: defineTable({
    entityType: v.union(
      v.literal("company"), // the analyzed/sold company (run.company / routedDomain)
      v.literal("competitor"), // an advertiser surfaced by the ad scan
      v.literal("icp"), // a buyer-segment page (normalized brief.icp)
      v.literal("campaign"), // a standing outbound campaign (campaignId)
    ),
    entityKey: v.string(), // normalized slug — the dedup key (e.g. "resend.com")
    title: v.string(), // human label ("Resend — knowledge")
    content: v.string(), // compiled markdown page body (the injectable narrative)
    facts: v.array(
      v.object({
        text: v.string(), // the durable statement
        kind: v.string(), // thread|prospect|reply|ad|post|copy|onboarding|positioning|trend|insight
        confidence: v.optional(v.number()), // 0-1
        source: v.optional(v.string()), // detective | adscout | writer | ...
        url: v.optional(v.string()), // clickable provenance when present
        runId: v.optional(v.id("runs")), // which run learned it
        learnedAt: v.number(),
      }),
    ),
    sources: v.array(
      v.object({
        runId: v.id("runs"),
        intent: v.string(),
        at: v.number(),
      }),
    ),
    embedding: v.optional(v.array(v.float64())), // text-embedding-3-small (1536d) of title+top facts
    factCount: v.number(), // facts.length — the visible "growing" metric
    runCount: v.number(), // sources.length — how many runs have compounded here
    lintedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_entity", ["entityType", "entityKey"]) // exact upsert lookup
    .index("by_type_updated", ["entityType", "updatedAt"]) // listing
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["entityType"],
    }),
});
