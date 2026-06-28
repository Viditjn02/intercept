// Shared UI document shapes. These mirror convex/schema.ts so components can use
// useQuery/useMutation results (and the typed function references in
// components/chatApi.ts) without depending on cross-package return inference.
// Keep in lockstep with the schema. Optional fields mirror the schema's optionals
// so a thin agent result still renders.
import type { Id } from "@/convex/_generated/dataModel";
import type {
  Autonomy,
  CampaignStatus,
  ChatRole,
  EmailStatus,
  Intent,
  ProspectStage,
  RunStatus,
  SignalType,
} from "@/lib/contract";

export interface SignalDoc {
  type: SignalType;
  summary: string;
  url?: string;
  source?: string;
  foundAt: number;
}

// ---------------------------------------------------------------------------
// CHAT — the centerpiece tables.
// ---------------------------------------------------------------------------
export interface ConversationDoc {
  _id: Id<"conversations">;
  _creationTime: number;
  title: string;
  lastIntent?: string;
  createdAt: number;
  lastMessageAt: number;
}

export interface ChatMessageDoc {
  _id: Id<"messages">;
  _creationTime: number;
  conversationId: Id<"conversations">;
  role: ChatRole;
  content: string;
  // persistent-text-streaming StreamId — present only WHILE streaming.
  streamId?: string;
  isStreaming?: boolean;
  runId?: Id<"runs">;
  intent?: string;
  proactive?: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// OUTBOUND — campaigns / prospects / emails.
// ---------------------------------------------------------------------------
export interface CampaignDoc {
  _id: Id<"campaigns">;
  _creationTime: number;
  conversationId?: Id<"conversations">;
  company: string;
  domain?: string;
  description?: string;
  icp: string;
  positioning?: string;
  personas?: string[];
  valueProp?: string;
  status: CampaignStatus;
  autonomy: Autonomy;
  cadenceMinutes?: number;
  lastRunAt?: number;
  lastRunId?: Id<"runs">;
  createdAt: number;
}

export interface ProspectDoc {
  _id: Id<"prospects">;
  _creationTime: number;
  campaignId?: Id<"campaigns">;
  runId?: Id<"runs">;
  company: string;
  domain?: string;
  industry?: string;
  employeeCount?: string;
  location?: string;
  name?: string;
  title?: string;
  email?: string;
  emailVerified?: boolean;
  linkedinUrl?: string;
  signal?: SignalDoc;
  fitScore?: number;
  fitReason?: string;
  stage: ProspectStage;
  skipReason?: string;
  source?: string;
  updatedAt: number;
}

// The OUTBOUND email sequence (distinct from chat `messages`).
export interface EmailDoc {
  _id: Id<"emails">;
  _creationTime: number;
  campaignId?: Id<"campaigns">;
  prospectId: Id<"prospects">;
  runId?: Id<"runs">;
  step: number;
  kind: "initial" | "followup";
  subject: string;
  body: string;
  signalRef?: string;
  to?: string;
  status: EmailStatus;
  sentAt?: number;
  replyBody?: string;
  repliedAt?: number;
  agentmailId?: string;
  agentmailThreadId?: string;
  createdAt: number;
}

export interface EventDoc {
  _id: Id<"events">;
  _creationTime: number;
  conversationId?: Id<"conversations">;
  runId?: Id<"runs">;
  campaignId?: Id<"campaigns">;
  prospectId?: Id<"prospects">;
  agent?: string;
  kind: string;
  message: string;
  createdAt: number;
}

export interface PipelineCounts {
  sourced: number;
  enriched: number;
  qualified: number;
  contacted: number;
  replied: number;
  booked: number;
  skipped: number;
  total: number;
}

export interface RunSummary {
  _id: Id<"runs">;
  status: RunStatus;
  intent: Intent;
  trigger: "manual" | "chat" | "cron";
  startedAt: number;
  deadlineAt: number;
  company?: string;
  sourcedCount?: number;
  qualifiedCount?: number;
  contactedCount?: number;
}

// ---------------------------------------------------------------------------
// KNOWLEDGE — the compounding brain (convex/knowledge.ts `knowledge_pages`).
// One page per GTM entity; `facts[]` is the visible "getting smarter" metric.
// Mirrors the schema plan; every absent-able field is optional so a thin
// first-run page (or a partially-deployed engine) still renders. These shapes
// let the UI consume the typed function references in BrainCanvas without
// depending on cross-package return inference (same pattern as chatApi).
// ---------------------------------------------------------------------------
export type KnowledgeEntityType = "company" | "competitor" | "icp" | "campaign";

export interface KnowledgeFactDoc {
  text: string;
  kind: string;
  confidence?: number;
  source?: string;
  url?: string;
  runId?: Id<"runs">;
  learnedAt: number;
}

export interface KnowledgeSourceDoc {
  runId: Id<"runs">;
  intent: string;
  at: number;
}

export interface KnowledgePageDoc {
  // `string`, not Id<"knowledge_pages">: the table is added by the engine builder
  // in parallel and isn't in the generated dataModel yet, so a branded Id here
  // would not type-check. The UI only uses it as a React key + dedup id.
  _id: string;
  _creationTime: number;
  entityType: KnowledgeEntityType;
  entityKey: string;
  title: string;
  content?: string;
  facts?: KnowledgeFactDoc[];
  sources?: KnowledgeSourceDoc[];
  factCount?: number;
  runCount?: number;
  lintedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

// The global header stat. All fields optional so the UI can fall back to
// deriving the numbers from the page list if the engine omits a field.
export interface BrainStatsDoc {
  pages?: number;
  facts?: number;
  runs?: number;
  byType?: Partial<Record<KnowledgeEntityType, number>>;
  lastUpdatedAt?: number;
}
