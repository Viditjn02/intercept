"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import LinkBreakdown from "./LinkBreakdown";

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
  if (score >= 75) return "text-success";
  if (score >= 55) return "text-ink";
  return "text-ink/50";
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
    <section className="overflow-hidden rounded-lg border border-hairline bg-canvas">
      <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <div>
          <h3 className="text-headline text-ink">Algorithm hacking</h3>
          <p className="text-body-sm text-ink/60">
            Live trends, scored viral posts, a short reel, and a content calendar
          </p>
        </div>
        <span
          className={`caption inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 ${
            hasAnything ? "bg-block-mint text-ink" : "bg-surface-soft text-ink"
          }`}
        >
          {hasAnything && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
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

      {/* Subtle: break down a reference video/post to reverse-engineer what works. */}
      <div className="border-t border-hairline p-5">
        <LinkBreakdown
          title="Break down a reference"
          hint="Drop a viral video or post — we'll reverse-engineer the hooks."
        />
      </div>
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
              <span className="absolute inset-0 animate-spin rounded-full border-2 border-hairline border-t-ink" />
              <span className="absolute inset-2 rounded-full bg-surface-soft" />
            </div>
            <p className="text-body-sm text-ink/70">Loading the social engine…</p>
          </>
        ) : (
          <>
            <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-soft text-ink">
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
            <p className="text-body-sm text-ink/70">
              Scanning trends, drafting scored viral posts, rendering a reel, and
              laying out a content calendar…
            </p>
            <p className="text-body-sm text-ink/50">
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
            className="group relative rounded-md border border-hairline bg-surface-soft px-3 py-2"
            title={t.why}
          >
            <div className="flex items-center gap-2">
              <span className="text-body-sm font-fig-headline text-ink">{t.topic}</span>
              <span className={`text-body-sm font-fig-card ${scoreTone(t.score)}`}>
                {t.score}
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-ink"
                style={{ width: `${Math.max(4, Math.min(100, t.score))}%` }}
              />
            </div>
            <p className="mt-1 max-w-[220px] truncate text-body-sm text-ink/50">
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
            <h5 className="eyebrow mb-2 text-[12px] text-ink">
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
      className={`flex flex-col gap-2 rounded-md border p-4 ${
        best ? "border-transparent bg-block-mint" : "border-hairline bg-surface-soft"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-body-sm font-fig-headline leading-snug text-ink">
          {best && <span className="mr-1 text-success">★</span>}
          {post.hook}
        </p>
        <ViralityGauge score={post.viralityScore} />
      </div>
      <p className="whitespace-pre-line text-body-sm leading-relaxed text-ink/70">
        {post.body}
      </p>
      {post.hashtags.length > 0 && (
        <p className="text-body-sm text-ink/60">{post.hashtags.join(" ")}</p>
      )}
      <Breakdown breakdown={post.viralityBreakdown} />
    </div>
  );
}

function ViralityGauge({ score }: { score: number }) {
  return (
    <div className="flex shrink-0 flex-col items-center">
      <span className={`text-card-title leading-none ${scoreTone(score)}`}>
        {score}
      </span>
      <span className="caption text-ink/60 text-[9px]">viral</span>
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
          <span className="caption w-16 shrink-0 text-ink/60 text-[9px]">
            {dim}
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-canvas">
            <div
              className="h-full rounded-full bg-ink"
              style={{ width: `${Math.max(2, Math.min(100, breakdown[dim]))}%` }}
            />
          </div>
          <span className="nums w-6 shrink-0 text-right text-[9px] text-ink/70">
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
              className="aspect-[9/16] w-full rounded-md border border-hairline bg-surface-soft object-cover"
            />
          ) : (
            <div className="grid aspect-[9/16] w-full place-items-center rounded-md border border-hairline bg-surface-soft px-3 text-center text-body-sm text-ink/50">
              {failed
                ? "Reel render unavailable on this key — the rest of the brief is unaffected."
                : "Rendering the reel…"}
            </div>
          )}
        </div>
        <div className="flex-1">
          <p className="eyebrow text-[12px] text-ink">
            Reel script / prompt
          </p>
          <p className="mt-1.5 whitespace-pre-line text-body-sm leading-relaxed text-ink/60">
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
              className="flex min-h-[84px] flex-col gap-1.5 rounded-md border border-hairline bg-surface-soft p-2"
            >
              <span className="caption text-ink/60 text-[10px]">
                Day {day + 1}
              </span>
              {daySlots.map((s) => {
                const score = s.postId ? scoreByPost.get(s.postId) : undefined;
                return (
                  <div
                    key={s._id}
                    className="rounded-sm border border-hairline bg-canvas p-1.5"
                    title={s.title}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="caption truncate text-ink text-[10px]">
                        {PLATFORM_LABEL[s.platform] ?? s.platform}
                      </span>
                      {score !== undefined && (
                        <span className={`text-[10px] font-fig-card ${scoreTone(score)}`}>
                          {score}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-ink/70">
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
      <h4 className="eyebrow text-ink">
        {title}
      </h4>
      <p className="text-body-sm text-ink/50">{subtitle}</p>
    </div>
  );
}
