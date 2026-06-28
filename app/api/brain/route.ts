// ============================================================================
// INTERCEPT — /api/brain ROUTE
// Bridges the browser to the LOCAL gbrain CLI (lib/gbrain.ts). Runs on the Node
// runtime because it shells out via node:child_process.
//
//   GET  /api/brain?company=<name>   -> prior context the brain already knows
//   POST /api/brain  { slug, content } -> persist durable findings back
//
// Both endpoints degrade gracefully: if the CLI is missing they return a benign
// { available: false } / { ok: false } and NEVER 500 — the brief must never break
// because the brain isn't installed.
// ============================================================================

import { NextResponse } from "next/server";
import { brainAvailable, brainQuery, brainPut } from "@/lib/gbrain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BrainGetResponse {
  available: boolean;
  company: string;
  answer: string;
}

interface BrainPostResponse {
  ok: boolean;
}

/**
 * Build the buyer-intent question we ask the brain for a given company, so the
 * brief can lead with "what we already know about this market".
 */
function buildQuestion(company: string): string {
  return `What do we already know about ${company} — its market, ideal buyers, positioning, the communities where its buyers ask questions, and any prior GTM findings?`;
}

export async function GET(request: Request): Promise<NextResponse<BrainGetResponse>> {
  const company = new URL(request.url).searchParams.get("company")?.trim() ?? "";

  // No company or no CLI -> quiet no-op. The panel renders nothing.
  if (!company || !brainAvailable()) {
    return NextResponse.json({ available: false, company, answer: "" });
  }

  try {
    const { available, answer } = await brainQuery(buildQuestion(company));
    return NextResponse.json({ available, company, answer });
  } catch {
    // Defense in depth — brainQuery already swallows errors, but never 500.
    return NextResponse.json({ available: false, company, answer: "" });
  }
}

export async function POST(request: Request): Promise<NextResponse<BrainPostResponse>> {
  if (!brainAvailable()) {
    return NextResponse.json({ ok: false });
  }

  let slug = "";
  let content = "";
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      if (typeof record.slug === "string") slug = record.slug.trim();
      if (typeof record.content === "string") content = record.content;
    }
  } catch {
    return NextResponse.json({ ok: false });
  }

  if (!slug || !content.trim()) {
    return NextResponse.json({ ok: false });
  }

  try {
    const ok = await brainPut(slug, content);
    return NextResponse.json({ ok });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
