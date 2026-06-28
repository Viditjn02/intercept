// ============================================================================
// INTERCEPT — SHARED TYPE CONTRACT (imported by agents, orchestrator, frontend)
// ============================================================================

export const AGENTS = ["router", "enrich", "detective", "creative", "watcher"] as const;
export type AgentName = (typeof AGENTS)[number];

export type IntentLabel = "browsing" | "comparing" | "frustrated" | "ready_to_buy";

// What the Detective agent returns — THE MOAT (real, clickable, intent-scored threads).
export interface DiscoveredThread {
  platform: string; // "reddit" | "hackernews" | "forum"
  url: string; // REAL clickable URL
  title: string;
  snippet: string;
  intentScore: number; // 0-100
  intentLabel: IntentLabel;
  author?: string;
  communityName?: string;
}

export interface DiscoveredCommunity {
  name: string;
  platform: string;
  url: string;
  why: string;
}

export interface EnrichResult {
  company: string;
  icp: string;
  positioning: string;
}

export interface ReplyDraft {
  threadUrl: string;
  body: string;
  confidence: number; // 0-1
}

// Deterministic replay fixture — scripts/seed-demo.ts loads this so the on-camera
// run is instant and cannot flop. fixtures/<slug>.json conforms to this shape.
export interface ReplayFixture {
  input: string;
  enrich: EnrichResult;
  communities: DiscoveredCommunity[];
  threads: DiscoveredThread[];
  drafts: ReplyDraft[];
  creativeUrl: string; // pre-rendered Veo clip (public URL or /public path)
}

// Agent contract: every swarm agent is an async function that hits an external API
// and returns typed data. The orchestrator wraps each in a Workpool action, writes
// agentStatus + results to Convex reactively, and the fan-in renders the brief from
// whatever completed before runs.deadlineAt. Slow/failed agents -> "skipped"/"failed",
// never block. See convex/run.ts.
export interface SwarmInput {
  input: string;
  inputType: "url" | "name" | "competitor" | "community" | "text";
}

export const FANIN_DEADLINE_MS = 90_000; // hard deadline; brief renders regardless
export const MAX_COMMUNITIES = 5;
export const MAX_THREADS = 8;
