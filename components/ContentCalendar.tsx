"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

// ============================================================================
// ContentCalendar — TRACK 1 (algorithm hacking / virality) canvas panel.
//
// Follows the social run and renders, top to bottom:
//   • trend chips (momentum bars) from the trendscout
//   • multi-variant post cards grouped by platform, each with a virality gauge
//     + a 5-dimension breakdown (the harsh-reviewer rubric)
//   • the generated vertical reel <video>
//   • a 2-week content calendar grid
// Graceful loading + empty states per the DesignPanel pattern — the panel never
// looks broken while the swarm is still working.
// ============================================================================

interface ContentCalendarProps {
  runId: Id<"runs">;
}

const PLATFORM_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X / Twitter",
  tiktok: "TikTok",
  instagram: "Instagram",
};

const DIMENSIONS = ["hook", "emotion", "clarity", "timeliness", "cta"] as const;

function scoreTone(score: number): string {
  if (score >= 75) return "text-good";
  if (score >= 55) return "text-accent";
  return "text-white/50";
}

export default function ContentCalendar({ runId }: ContentCalendarProps) {
  const trends = useQuery(api.agents.trendscout.trendsForRun, { runId });
  const posts = useQuery(api.agents.composer.postsForRun, { runId });
  const reel = useQuery(api.agents.reelmaker.reelForRun, { runId });
  const calendar = useQuery(api.agents.calendar.calendarForRun, { runId });

  const loading =
    trends === undefined &&
    posts === undefined &&
    reel === undefined &&
    calendar === undefined;

  const hasAnything =
    (trends?.length ?? 0) > 0 ||
    (posts?.length ?? 0) > 0 ||
    Boolean(reel) ||
    (calendar?.length ?? 0) > 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/80">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Algorithm hacking</h3>
          <p className="text-xs text-zinc-500">
            Live trends, scored viral posts, a short reel, and a content calendar
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
            hasAnything
              ? "bg-good/15 text-good ring-1 ring-good/30"
              : "bg-accent/15 text-accent ring-1 ring-accent/30"
          }`}
        >
          {hasAnything ? "Ready" : "Generating"}
        </span>
      </header>

      {!hasAnything ? (
        <EmptyState loading={loading} />
      ) : (
        <div className="flex flex-col gap-6 p-5">
          {(trends?.length ?? 0) > 0 && <TrendChips trends={trends!} />}
          {(posts?.length ?? 0) > 0 && <PostVariants posts={posts!} />}
          {reel && <ReelBlock reel={reel} />}
          {(calendar?.length ?? 0) > 0 && (
            <CalendarGrid slots={calendar!} posts={posts ?? []} />
          )}
        </div>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="grid place-items-center px-6 py-16">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        {loading ? (
          <>
            <div className="relative h-12 w-12">
              <span className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-accent" />
              <span className="absolute inset-2 rounded-full bg-accent/10" />
            </div>
            <p className="text-sm text-zinc-400">Loading the social engine…</p>
          </>
        ) : (
          <>
            <div className="grid h-12 w-12 place-items-center rounded-full bg-accent/10 text-accent ring-1 ring-accent/30">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
              </svg>
            </div>
            <p className="text-sm text-zinc-400">
              Scanning trends, drafting scored viral posts, rendering a reel, and
              laying out a content calendar…
            </p>
            <p className="text-xs text-zinc-600">
              Boards appear the moment each agent finishes.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
function TrendChips({ trends }: { trends: Doc<"trends">[] }) {
  return (
    <div>
      <SectionTitle title="Trending now" subtitle="What the market is talking about, scored for momentum" />
      <div className="mt-3 flex flex-wrap gap-2">
        {trends.map((t) => (
          <div
            key={t._id}
            className="group relative rounded-xl border border-line bg-ink/40 px-3 py-2"
            title={t.why}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-zinc-100">{t.topic}</span>
              <span className={`text-[11px] font-bold ${scoreTone(t.score)}`}>
                {t.score}
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(4, Math.min(100, t.score))}%` }}
              />
            </div>
            <p className="mt-1 max-w-[220px] truncate text-[11px] text-zinc-500">
              {t.angle}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
function PostVariants({ posts }: { posts: Doc<"posts">[] }) {
  // Group by platform; within each, sort by score (server already does, but be safe).
  const byPlatform = new Map<string, Doc<"posts">[]>();
  for (const p of posts) {
    const arr = byPlatform.get(p.platform) ?? [];
    arr.push(p);
    byPlatform.set(p.platform, arr);
  }
  for (const arr of byPlatform.values()) {
    arr.sort((a, b) => b.viralityScore - a.viralityScore);
  }

  return (
    <div>
      <SectionTitle
        title="Viral post variants"
        subtitle="Multiple angles per platform, scored by the virality model — the winner is starred"
      />
      <div className="mt-3 flex flex-col gap-5">
        {Array.from(byPlatform.entries()).map(([platform, variants]) => (
          <div key={platform}>
            <h5 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              {PLATFORM_LABEL[platform] ?? platform}
            </h5>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {variants.map((p, i) => (
                <PostCard key={p._id} post={p} best={i === 0} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PostCard({ post, best }: { post: Doc<"posts">; best: boolean }) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border p-4 ${
        best ? "border-good/40 bg-good/5" : "border-line bg-ink/40"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-semibold leading-snug text-zinc-100">
          {best && <span className="mr-1 text-good">★</span>}
          {post.hook}
        </p>
        <ViralityGauge score={post.viralityScore} />
      </div>
      <p className="whitespace-pre-line text-[12px] leading-relaxed text-zinc-400">
        {post.body}
      </p>
      {post.hashtags.length > 0 && (
        <p className="text-[11px] text-accent/80">{post.hashtags.join(" ")}</p>
      )}
      <Breakdown breakdown={post.viralityBreakdown} />
    </div>
  );
}

function ViralityGauge({ score }: { score: number }) {
  return (
    <div className="flex shrink-0 flex-col items-center">
      <span className={`text-base font-bold leading-none ${scoreTone(score)}`}>
        {score}
      </span>
      <span className="text-[9px] uppercase tracking-wide text-zinc-600">viral</span>
    </div>
  );
}

function Breakdown({
  breakdown,
}: {
  breakdown: Doc<"posts">["viralityBreakdown"];
}) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {DIMENSIONS.map((dim) => (
        <div key={dim} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[9px] uppercase tracking-wide text-zinc-600">
            {dim}
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent/70"
              style={{ width: `${Math.max(2, Math.min(100, breakdown[dim]))}%` }}
            />
          </div>
          <span className="w-6 shrink-0 text-right text-[9px] tabular-nums text-zinc-500">
            {breakdown[dim]}
          </span>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
function ReelBlock({ reel }: { reel: Doc<"creatives"> }) {
  const ready = reel.status === "done" && Boolean(reel.url);
  const failed = reel.status === "failed";
  return (
    <div>
      <SectionTitle
        title="Short-form reel"
        subtitle={`Vertical 9:16 video · ${reel.model}`}
      />
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <div className="w-full max-w-[220px]">
          {ready ? (
            <video
              src={reel.url}
              controls
              playsInline
              className="aspect-[9/16] w-full rounded-xl border border-line bg-black object-cover"
            />
          ) : (
            <div className="grid aspect-[9/16] w-full place-items-center rounded-xl border border-line bg-ink/60 text-center text-[12px] text-zinc-500">
              {failed
                ? "Reel render unavailable on this key — the rest of the brief is unaffected."
                : "Rendering the reel…"}
            </div>
          )}
        </div>
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Reel script / prompt
          </p>
          <p className="mt-1.5 whitespace-pre-line text-[12px] leading-relaxed text-zinc-500">
            {reel.prompt}
          </p>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
function CalendarGrid({
  slots,
  posts,
}: {
  slots: Doc<"contentCalendar">[];
  posts: Doc<"posts">[];
}) {
  const scoreByPost = new Map<Id<"posts">, number>(
    posts.map((p) => [p._id, p.viralityScore] as const),
  );
  // Bucket slots by day for a tidy grid.
  const maxDay = slots.reduce((m, s) => Math.max(m, s.dayOffset), 0);
  const days = Array.from({ length: maxDay + 1 }, (_, i) => i);
  const byDay = new Map<number, Doc<"contentCalendar">[]>();
  for (const s of slots) {
    const arr = byDay.get(s.dayOffset) ?? [];
    arr.push(s);
    byDay.set(s.dayOffset, arr);
  }

  return (
    <div>
      <SectionTitle
        title="Content calendar"
        subtitle="The scored posts laid out across the next two weeks"
      />
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {days.map((day) => {
          const daySlots = byDay.get(day) ?? [];
          return (
            <div
              key={day}
              className="flex min-h-[84px] flex-col gap-1.5 rounded-lg border border-line bg-ink/30 p-2"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                Day {day + 1}
              </span>
              {daySlots.map((s) => {
                const score = s.postId ? scoreByPost.get(s.postId) : undefined;
                return (
                  <div
                    key={s._id}
                    className="rounded-md border border-line bg-panel/70 p-1.5"
                    title={s.title}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-[10px] font-medium text-accent">
                        {PLATFORM_LABEL[s.platform] ?? s.platform}
                      </span>
                      {score !== undefined && (
                        <span className={`text-[10px] font-bold ${scoreTone(score)}`}>
                          {score}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-zinc-400">
                      {s.title}
                    </p>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
        {title}
      </h4>
      <p className="text-[11px] text-zinc-600">{subtitle}</p>
    </div>
  );
}
