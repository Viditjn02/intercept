"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import ThreadCard from "./ThreadCard";
import ApprovalModal from "./ApprovalModal";
import CreativePanel from "./CreativePanel";

// ============================================================================
// Brief — the rendered GTM brief for a run.
// ICP + positioning header, the discovered communities, and the THREADS as the
// hero (THE MOAT). Each thread carries its drafted reply behind the approval
// gate, and the generated video ad renders alongside.
//
// Expected backend public queries (owned by the brief/agent modules), all keyed
// by the by_run indexes in convex/schema.ts:
//   api.brief.getBrief({ runId })        : Doc<"brief"> | null
//   api.brief.getCommunities({ runId })  : Doc<"communities">[]
//   api.brief.getThreads({ runId })      : Doc<"threads">[]
//   api.brief.getDrafts({ runId })       : Doc<"drafts">[]
//   api.brief.getCreative({ runId })     : Doc<"creatives"> | null   (in CreativePanel)
// ============================================================================

interface BriefProps {
  runId: Id<"runs">;
}

function SkeletonLine({ w }: { w: string }) {
  return <div className={`h-3 ${w} animate-pulse rounded bg-line`} />;
}

export default function Brief({ runId }: BriefProps) {
  const brief = useQuery(api.brief.getBrief, { runId });
  const communities = useQuery(api.brief.getCommunities, { runId });
  const threads = useQuery(api.brief.getThreads, { runId });
  const drafts = useQuery(api.brief.getDrafts, { runId });

  const [activeDraftId, setActiveDraftId] = useState<Id<"drafts"> | null>(null);

  // Index drafts by their thread so each card can surface its reply.
  const draftByThread = useMemo(() => {
    const map = new Map<string, Doc<"drafts">>();
    for (const d of drafts ?? []) map.set(d.threadId, d);
    return map;
  }, [drafts]);

  // Hero ordering: highest intent first — the strongest buying signal on top.
  const rankedThreads = useMemo(() => {
    return [...(threads ?? [])].sort((a, b) => b.intentScore - a.intentScore);
  }, [threads]);

  const activeDraft = useMemo(
    () => (drafts ?? []).find((d) => d._id === activeDraftId) ?? null,
    [drafts, activeDraftId],
  );
  const activeThread = useMemo(
    () => (threads ?? []).find((t) => t._id === activeDraft?.threadId) ?? null,
    [threads, activeDraft],
  );

  const briefLoading = brief === undefined;
  const threadsLoading = threads === undefined;
  const readyDrafts = (drafts ?? []).filter((d) => d.status === "awaiting_approval").length;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 text-zinc-200">
      {/* ───────────────── Brief: ICP + positioning ───────────────── */}
      <section className="rounded-2xl border border-line bg-panel/80 p-6 backdrop-blur">
        {briefLoading ? (
          <div className="space-y-3">
            <SkeletonLine w="w-24" />
            <SkeletonLine w="w-3/4" />
            <SkeletonLine w="w-2/3" />
          </div>
        ) : brief ? (
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                Ideal customer
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-200">{brief.icp}</p>
            </div>
            <div className="sm:border-l sm:border-line sm:pl-6">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                Positioning
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-200">{brief.positioning}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Building the brief…</p>
        )}
      </section>

      {/* ───────────────── Communities ───────────────── */}
      {communities && communities.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Where the buyers gather
          </h2>
          <div className="flex flex-wrap gap-2">
            {communities.map((c) => (
              <a
                key={c._id}
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                title={c.why}
                className="group inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-accent/50 hover:text-white"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                {c.name}
                <span className="text-xs text-zinc-600 group-hover:text-zinc-400">
                  {c.platform}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* ───────────────── THREADS — the hero / the moat ───────────────── */}
      <section>
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-50">Live conversations to win</h2>
            <p className="text-sm text-zinc-500">
              Real threads where buyers are asking the exact question you answer — ranked by intent.
            </p>
          </div>
          {readyDrafts > 0 && (
            <span className="whitespace-nowrap rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent ring-1 ring-accent/30">
              {readyDrafts} {readyDrafts === 1 ? "reply" : "replies"} awaiting approval
            </span>
          )}
        </div>

        {threadsLoading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-48 animate-pulse rounded-2xl border border-line bg-panel/60" />
            ))}
          </div>
        ) : rankedThreads.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-panel/40 p-10 text-center text-sm text-zinc-500">
            No live threads surfaced yet — the detective is still on the case.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {rankedThreads.map((thread) => (
              <ThreadCard
                key={thread._id}
                thread={thread}
                draft={draftByThread.get(thread._id) ?? null}
                onReviewDraft={(d) => setActiveDraftId(d._id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ───────────────── Creative ───────────────── */}
      <CreativePanel runId={runId} />

      {/* ───────────────── Approval gate ───────────────── */}
      {activeDraft && (
        <ApprovalModal
          draft={activeDraft}
          thread={activeThread}
          onClose={() => setActiveDraftId(null)}
        />
      )}
    </div>
  );
}
