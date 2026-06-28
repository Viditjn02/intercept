// ============================================================================
// INTERCEPT — GTM WORKFLOWS (backend)
// ----------------------------------------------------------------------------
// Turns INTERCEPT's one-off agent runs into structured, monitored, production-
// ready revenue workflows. For a target company it composes 3-4 templates
// (e.g. inbound capture, outbound blitz, re-engagement) — each a named, goal-
// driven sequence of INTERCEPT plays with a trigger, a schedule, and a single
// monitored metric → target.
//
//   buildWorkflows(action) { targetUrl } -> { workflows: WorkflowPlan[] }
//
// Every step names ONE of INTERCEPT's plays (Reading Minds / Revenue on
// Autopilot / Ad Intelligence / Ad Factory / Algorithm Hacking / Zero to One),
// carries a run status ('ready' | 'running' | 'idle'), and a one-line health
// note so the panel reads like a live ops board.
//
// CONVEX RULES (deploy-safety, mirrors convex/winback.ts):
//   - DEFAULT runtime — NOT "use node" — so lib/openai bundles cleanly (it's the
//     OpenAI SDK over fetch, valid in the default runtime).
//   - GRACEFUL ABOVE ALL: a missing OPENAI_API_KEY, a model error, or bad JSON
//     degrades to a believable CANNED set of 3 workflows. This action NEVER
//     throws and NEVER returns an empty list.
// ============================================================================

import { v } from "convex/values";
import { action } from "./_generated/server";
import { chatJSON } from "../lib/openai";

// ----------------------------------------------------------------------------
// The result shape. Mirrored in components/WorkflowsPanel.tsx.
// ----------------------------------------------------------------------------

/** The six INTERCEPT plays a workflow step can invoke. */
export type PlayName =
  | "Reading Minds"
  | "Revenue on Autopilot"
  | "Ad Intelligence"
  | "Ad Factory"
  | "Algorithm Hacking"
  | "Zero to One";

/** A step's live run status. */
export type StepStatus = "ready" | "running" | "idle";

export interface WorkflowStep {
  /** What this step does, in a few words. */
  name: string;
  /** The INTERCEPT play this step runs. */
  play: PlayName;
  /** Live run status of the step. */
  status: StepStatus;
  /** One-line health note (e.g. "Enrichment coverage 96%"). */
  healthNote: string;
}

export interface WorkflowMonitor {
  /** The metric this workflow is watched on. */
  metric: string;
  /** The target value for that metric. */
  target: string;
}

export interface WorkflowPlan {
  /** Short workflow name. */
  name: string;
  /** What the workflow is built to achieve, one line. */
  goal: string;
  /** The event that kicks the workflow off, one line. */
  trigger: string;
  /** The ordered sequence of INTERCEPT plays. */
  steps: WorkflowStep[];
  /** When/how often it runs, one line. */
  schedule: string;
  /** The single monitored metric → target. */
  monitors: WorkflowMonitor;
}

interface WorkflowsResult {
  workflows: WorkflowPlan[];
}

// Need at least 3 real templates; cap the board at 4.
const MIN_COUNT = 3;
const MAX_COUNT = 4;

// The closed set of plays a step may name. Anything else coerces to a safe
// default so a stray label never leaves the step playless.
const PLAYS: ReadonlyArray<PlayName> = [
  "Reading Minds",
  "Revenue on Autopilot",
  "Ad Intelligence",
  "Ad Factory",
  "Algorithm Hacking",
  "Zero to One",
];
const DEFAULT_PLAY: PlayName = "Reading Minds";

const STATUSES: ReadonlyArray<StepStatus> = ["ready", "running", "idle"];
const DEFAULT_STATUS: StepStatus = "idle";

/** Coerce loose text to a valid play (case-insensitive), else the default. */
function coercePlay(raw: unknown): PlayName {
  if (typeof raw !== "string") return DEFAULT_PLAY;
  const needle = raw.trim().toLowerCase();
  const hit = PLAYS.find((p) => p.toLowerCase() === needle);
  return hit ?? DEFAULT_PLAY;
}

/** Coerce loose text to a valid status, else idle. */
function coerceStatus(raw: unknown): StepStatus {
  if (typeof raw !== "string") return DEFAULT_STATUS;
  const needle = raw.trim().toLowerCase();
  const hit = STATUSES.find((s) => s === needle);
  return hit ?? DEFAULT_STATUS;
}

/** Bare host for the target, mirroring convex/winback.ts hostOf. */
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
// CANNED fallback — a believable set of 3 production-ready workflows, lightly
// personalized to the target's brand. Deterministic, never throws.
// ----------------------------------------------------------------------------
function cannedWorkflows(targetUrl: string): WorkflowPlan[] {
  const brand = brandOf(hostOf(targetUrl) || "your");

  return [
    {
      name: "Inbound Intent Capture",
      goal: `Catch high-intent visitors the moment they show buying signals and route them to a touch tuned for ${brand}'s buyers.`,
      trigger: "A tracked account hits pricing or books a demo",
      steps: [
        {
          name: "Read the intent signal",
          play: "Reading Minds",
          status: "ready",
          healthNote: "Intent radar live · 0 gaps",
        },
        {
          name: "Spin up the matched ad",
          play: "Ad Factory",
          status: "ready",
          healthNote: "Creative templates fresh",
        },
        {
          name: "Hand to the outbound swarm",
          play: "Revenue on Autopilot",
          status: "idle",
          healthNote: "Armed — waits on first trigger",
        },
      ],
      schedule: "Real-time · evaluated every 5 min",
      monitors: { metric: "Signal-to-touch time", target: "< 10 min" },
    },
    {
      name: "Outbound Blitz",
      goal: "Run a focused outbound push against a fresh lookalike list and keep every thread warm.",
      trigger: "A new lookalike segment crosses 50 accounts",
      steps: [
        {
          name: "Profile the segment",
          play: "Reading Minds",
          status: "ready",
          healthNote: "Enrichment coverage 96%",
        },
        {
          name: "Generate sequenced creative",
          play: "Ad Factory",
          status: "running",
          healthNote: "3 variants in flight",
        },
        {
          name: "Launch the swarm",
          play: "Revenue on Autopilot",
          status: "running",
          healthNote: "Deliverability nominal",
        },
        {
          name: "Amplify the winners",
          play: "Algorithm Hacking",
          status: "idle",
          healthNote: "Holds until reply-rate clears 8%",
        },
      ],
      schedule: "Weekdays · 9:00 AM send window",
      monitors: { metric: "Reply rate", target: ">= 8%" },
    },
    {
      name: "Dormant Re-engagement",
      goal: "Detect accounts that went quiet and re-open the conversation the moment their context shifts.",
      trigger: "An account stays dark for 30 days",
      steps: [
        {
          name: "Watch for a fresh trigger",
          play: "Reading Minds",
          status: "ready",
          healthNote: "Re-trigger watch armed",
        },
        {
          name: "Study competitor moves",
          play: "Ad Intelligence",
          status: "ready",
          healthNote: "Ad library synced today",
        },
        {
          name: "Warm re-open",
          play: "Revenue on Autopilot",
          status: "idle",
          healthNote: "Queued behind the trigger",
        },
      ],
      schedule: "Daily · 7:00 AM sweep",
      monitors: { metric: "Re-engaged accounts", target: "5 / week" },
    },
  ];
}

// ----------------------------------------------------------------------------
// Coerce a single loose step into a strict WorkflowStep, or null if it has no
// usable name (steps without a name are dropped rather than faked).
// ----------------------------------------------------------------------------
function normalizeStep(raw: unknown): WorkflowStep | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  const healthNote =
    typeof row.healthNote === "string" && row.healthNote.trim()
      ? row.healthNote.trim()
      : "Healthy";
  return {
    name,
    play: coercePlay(row.play),
    status: coerceStatus(row.status),
    healthNote,
  };
}

// ----------------------------------------------------------------------------
// Coerce a single loose workflow into a strict WorkflowPlan, or null if it is
// missing the load-bearing fields (name / goal / trigger / schedule / a step /
// a monitored metric). Anything incomplete drops out so the panel only ever
// renders fully-formed cards.
// ----------------------------------------------------------------------------
function normalizeWorkflow(raw: unknown): WorkflowPlan | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const goal = typeof row.goal === "string" ? row.goal.trim() : "";
  const trigger = typeof row.trigger === "string" ? row.trigger.trim() : "";
  const schedule = typeof row.schedule === "string" ? row.schedule.trim() : "";
  if (!name || !goal || !trigger || !schedule) return null;

  const rawSteps = Array.isArray(row.steps) ? row.steps : [];
  const steps: WorkflowStep[] = [];
  for (const s of rawSteps) {
    const step = normalizeStep(s);
    if (step) steps.push(step);
  }
  if (steps.length === 0) return null;

  const mObj = (row.monitors ?? {}) as Record<string, unknown>;
  const metric = typeof mObj.metric === "string" ? mObj.metric.trim() : "";
  const target = typeof mObj.target === "string" ? mObj.target.trim() : "";
  if (!metric || !target) return null;

  return { name, goal, trigger, steps, schedule, monitors: { metric, target } };
}

// ----------------------------------------------------------------------------
// Coerce the model's loose JSON into a strict WorkflowPlan[]. Too few valid
// workflows degrades to the canned set so the UI is never empty.
// ----------------------------------------------------------------------------
function normalize(raw: unknown, targetUrl: string): WorkflowPlan[] {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawWorkflows = Array.isArray(obj.workflows) ? obj.workflows : [];

  const workflows: WorkflowPlan[] = [];
  for (const w of rawWorkflows) {
    const wf = normalizeWorkflow(w);
    if (wf) workflows.push(wf);
  }

  if (workflows.length < MIN_COUNT) {
    return cannedWorkflows(targetUrl);
  }
  return workflows.slice(0, MAX_COUNT);
}

// ----------------------------------------------------------------------------
// The action.
// ----------------------------------------------------------------------------
export const buildWorkflows = action({
  args: { targetUrl: v.string() },
  handler: async (_ctx, { targetUrl }): Promise<WorkflowsResult> => {
    try {
      const host = hostOf(targetUrl) || "the company";
      const brand = brandOf(host);

      const system =
        "You are INTERCEPT, a revenue copilot that turns one-off agent runs into " +
        "structured, monitored, production-ready GTM workflows. Each workflow is a " +
        "named, goal-driven sequence of INTERCEPT plays with a clear trigger, a " +
        "schedule, and ONE monitored metric → target. Every step must name exactly " +
        "one of these six plays — Reading Minds, Revenue on Autopilot, Ad " +
        "Intelligence, Ad Factory, Algorithm Hacking, Zero to One — and carry a run " +
        "status ('ready' | 'running' | 'idle') plus a short health note. Think like a " +
        "GTM ops lead shipping templates a team can run unattended: inbound capture, " +
        "outbound blitz, re-engagement, and the like. Be concrete and operational.";

      const user =
        `TARGET COMPANY\n` +
        `- Domain: ${host}\n` +
        `- Brand: ${brand}\n\n` +
        `Produce 3-4 production-ready GTM workflow templates for ${brand}. Return a ` +
        `JSON object with this exact shape:\n` +
        `{\n` +
        `  "workflows": [                 // 3 or 4 entries\n` +
        `    {\n` +
        `      "name": string,            // short workflow name\n` +
        `      "goal": string,            // what it achieves, ONE line\n` +
        `      "trigger": string,         // the event that starts it, ONE line\n` +
        `      "steps": [                 // 2-4 ordered steps\n` +
        `        {\n` +
        `          "name": string,        // what the step does, a few words\n` +
        `          "play": string,        // EXACTLY one of: Reading Minds, Revenue on Autopilot, Ad Intelligence, Ad Factory, Algorithm Hacking, Zero to One\n` +
        `          "status": string,      // one of: ready, running, idle\n` +
        `          "healthNote": string   // one-line health note\n` +
        `        }\n` +
        `      ],\n` +
        `      "schedule": string,        // when/how often it runs, ONE line\n` +
        `      "monitors": {              // the single watched metric\n` +
        `        "metric": string,        // what is measured\n` +
        `        "target": string         // the goal value (e.g. ">= 8%", "< 10 min")\n` +
        `      }\n` +
        `    }\n` +
        `  ]\n` +
        `}\n` +
        `Make the workflows DISTINCT (e.g. inbound capture, outbound blitz, ` +
        `re-engagement) with varied plays, statuses, schedules, and monitored metrics.`;

      const raw = await chatJSON<Record<string, unknown>>({
        system,
        user,
        temperature: 0.7,
        maxTokens: 1800,
      });

      return { workflows: normalize(raw, targetUrl) };
    } catch {
      // Missing key, model error, bad JSON — degrade to the canned set.
      return { workflows: cannedWorkflows(targetUrl) };
    }
  },
});
