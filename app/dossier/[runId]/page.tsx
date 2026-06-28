"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  Dossier,
  DossierAd,
  DossierCompetitor,
  DossierDecisionMaker,
  DossierThread,
} from "@/convex/dossier";
import { cn } from "@/lib/utils";
import ThemeToggle from "@/components/ThemeToggle";

// ============================================================================
// INTERCEPT — PUBLIC INTELLIGENCE DOSSIER  ·  /dossier/[runId]
// ----------------------------------------------------------------------------
// A read-only, shareable, screenshot-worthy aggregation of one run's REAL data,
// rendered in the Figma editorial design system: a monochrome editorial frame
// interrupted by oversized pastel color-block "poster" panels.
//
// The dossier is a LIGHT-CONSTANT poster set: pastel panels and their forced-dark
// text stay constant across both themes, floating on a theme-flipping page ground
// (white desk in light, navy desk at night). The hero sits directly on the ground
// so it reads as black-on-white or white-on-navy. Result: consistent, beautiful
// screenshots whichever theme the recipient is in.
//
// Convex provider + fonts + ThemeProvider all come from app/layout.tsx (the root
// layout wraps every route), so this client component just needs useQuery.
// ============================================================================

// Forced-dark ink for text drawn DIRECTLY on a constant light pastel panel (so it
// never inverts to white in night theme). Cards inside panels use their own surface.
const INK = "text-[#17162b]";
const INK_SOFT = "text-[#17162b]/65";
const HAIR = "border-[#17162b]/12";

const INTENT_META: Record<string, { label: string; chip: string; pulse: boolean }> = {
  ready_to_buy: { label: "Ready to buy", chip: "bg-block-mint", pulse: true },
  frustrated: { label: "Frustrated", chip: "bg-block-coral", pulse: true },
  comparing: { label: "Comparing", chip: "bg-block-cream", pulse: false },
  browsing: { label: "Browsing", chip: "bg-block-lilac", pulse: false },
};

const PLATFORM_META: Record<string, { label: string; symbol: string }> = {
  reddit: { label: "Reddit", symbol: "r/" },
  hackernews: { label: "Hacker News", symbol: "Y" },
  forum: { label: "Forum", symbol: "#" },
  discord: { label: "Discord", symbol: "@" },
  twitter: { label: "X", symbol: "𝕏" },
  x: { label: "X", symbol: "𝕏" },
  linkedin: { label: "LinkedIn", symbol: "in" },
};

const NETWORK_META: Record<string, { label: string; symbol: string }> = {
  meta: { label: "Meta", symbol: "f" },
  facebook: { label: "Facebook", symbol: "f" },
  instagram: { label: "Instagram", symbol: "◎" },
  audience_network: { label: "Audience Network", symbol: "▦" },
  messenger: { label: "Messenger", symbol: "✦" },
  tiktok: { label: "TikTok", symbol: "♪" },
  google: { label: "Google", symbol: "G" },
};

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function intentMeta(label: string) {
  return INTENT_META[label] ?? { label: "Signal", chip: "bg-surface-soft", pulse: false };
}

function fmtDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

// ----------------------------------------------------------------------------
// PAGE
// ----------------------------------------------------------------------------
export default function DossierPage() {
  const params = useParams<{ runId: string }>();
  const runId = params?.runId as Id<"runs"> | undefined;
  const dossier = useQuery(api.dossier.get, runId ? { runId } : "skip") as
    | Dossier
    | null
    | undefined;

  if (dossier === undefined) return <DossierLoading />;
  if (dossier === null) return <DossierNotFound />;

  return (
    <main className="min-h-[100dvh] bg-canvas text-ink">
      <TopBar dossier={dossier} />
      <div className="mx-auto w-full max-w-content px-5 pb-24 sm:px-8">
        <Hero dossier={dossier} />
        <div className="space-y-7 sm:space-y-10">
          {dossier.icp && <IcpPanel icp={dossier.icp} positioning={dossier.positioning} />}
          {dossier.topThreads.length > 0 && <ThreadsPanel threads={dossier.topThreads} />}
          {dossier.competitors.length > 0 && (
            <CompetitorsPanel competitors={dossier.competitors} />
          )}
          {dossier.decisionMakers.length > 0 && (
            <DecisionMakersPanel makers={dossier.decisionMakers} />
          )}
          <PlayPanel dossier={dossier} />
          <BrainStrip dossier={dossier} />
        </div>
        <Footer dossier={dossier} />
      </div>
    </main>
  );
}

// ----------------------------------------------------------------------------
// Top bar — minimal glass chrome: wordmark + "shareable" pill + theme toggle.
// ----------------------------------------------------------------------------
function TopBar({ dossier }: { dossier: Dossier }) {
  return (
    <header className="glass-1 sticky top-0 z-20 flex items-center justify-between gap-3 px-5 py-2.5 sm:px-8">
      <div className="flex items-center gap-2.5">
        <Wordmark />
        <span className="hidden text-[12px] text-ink/45 sm:inline">·</span>
        <span className="caption hidden text-ink/60 sm:inline">Intelligence Dossier</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="caption hidden rounded-pill bg-surface-soft px-2.5 py-1 text-ink/70 sm:inline">
          {dossier.intent}
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="grid h-5 w-5 place-items-center rounded-sm bg-primary text-on-primary">
        <span className="text-[11px] font-fig-card leading-none">I</span>
      </span>
      <span className="text-[15px] font-fig-headline tracking-[-0.02em] text-ink">INTERCEPT</span>
    </span>
  );
}

// ----------------------------------------------------------------------------
// Hero — sits on the page ground (flips cleanly with theme).
// ----------------------------------------------------------------------------
function Hero({ dossier }: { dossier: Dossier }) {
  const { stats } = dossier;
  return (
    <section className="pb-10 pt-12 sm:pb-14 sm:pt-20">
      <p className="eyebrow flex items-center gap-2 text-ink/70">
        <span className="relative inline-flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-magenta opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-magenta" />
        </span>
        Intelligence Dossier · built by INTERCEPT
      </p>

      <h1 className="mt-5 max-w-[14ch] text-[40px] font-fig-display leading-[0.98] tracking-[-0.04em] text-ink sm:text-[72px]">
        Market intelligence for{" "}
        <span className="box-decoration-clone bg-block-lime px-2 text-[#17162b]">
          {dossier.company}
        </span>
      </h1>

      {dossier.positioning && (
        <p className="mt-6 max-w-[44ch] text-subhead text-ink/80 sm:text-[26px]">
          {dossier.positioning}
        </p>
      )}

      <div className="mt-8 flex flex-wrap gap-2.5">
        <StatPill n={stats.threads} label="live buyer threads" />
        <StatPill n={stats.competitorAds} label="competitor ads scanned" />
        <StatPill n={stats.decisionMakers} label="decision-makers" />
        {stats.verifiedEmails > 0 && (
          <StatPill n={stats.verifiedEmails} label="verified emails" />
        )}
      </div>

      <p className="caption mt-6 text-ink/45">
        Prepared {fmtDate(dossier.generatedAt)} · every finding below is real and clickable
      </p>
    </section>
  );
}

function StatPill({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-2 rounded-pill border border-hairline bg-canvas px-4 py-2">
      <span className="nums text-[20px] font-fig-card leading-none text-ink">{n}</span>
      <span className="text-[13px] text-ink/60">{label}</span>
    </span>
  );
}

// ----------------------------------------------------------------------------
// Generic poster panel scaffold (constant light pastel, forced-dark text).
// ----------------------------------------------------------------------------
function Panel({
  color,
  eyebrow,
  title,
  intro,
  children,
}: {
  color: string;
  eyebrow: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("color-block", color, INK)}>
      <p className={cn("eyebrow", INK_SOFT)}>{eyebrow}</p>
      <h2 className="mt-3 max-w-[20ch] text-[28px] font-fig-display leading-[1.05] tracking-[-0.02em] sm:text-[40px]">
        {title}
      </h2>
      {intro && <p className={cn("mt-3 max-w-[60ch] text-body-lg", INK_SOFT)}>{intro}</p>}
      <div className="mt-7">{children}</div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// ICP poster (lime) — who your buyers are.
// ----------------------------------------------------------------------------
function IcpPanel({ icp, positioning }: { icp: string; positioning: string }) {
  return (
    <section className={cn("color-block bg-block-lime", INK)}>
      <div className="grid gap-8 sm:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className={cn("eyebrow", INK_SOFT)}>Who you sell to</p>
          <h2 className="mt-3 text-[28px] font-fig-display leading-[1.05] tracking-[-0.02em] sm:text-[40px]">
            Your ideal customer, in their own words.
          </h2>
        </div>
        <div className="self-center">
          <p className="text-[22px] font-fig-display leading-[1.3] tracking-[-0.01em] sm:text-[26px]">
            {icp}
          </p>
          {positioning && (
            <p className={cn("mt-5 border-t pt-5 text-body-lg", HAIR, INK_SOFT)}>
              <span className="eyebrow mr-2 align-middle">Positioning</span>
              {positioning}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Threads poster (mint) — where your buyers are complaining.
// ----------------------------------------------------------------------------
function ThreadsPanel({ threads }: { threads: DossierThread[] }) {
  return (
    <Panel
      color="bg-block-mint"
      eyebrow="The moat · live demand"
      title="Where your buyers are complaining right now"
      intro="Real, intent-scored conversations where someone is asking the exact question you answer. Click any one — it's a live link, not a screenshot."
    >
      <div className="grid gap-4 md:grid-cols-2">
        {threads.map((t, i) => (
          <ThreadCard key={`${t.url}-${i}`} thread={t} />
        ))}
      </div>
    </Panel>
  );
}

function ScoreRing({ score, pulse }: { score: number; pulse: boolean }) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const deg = (clamped / 100) * 360;
  return (
    <div
      className="relative grid h-14 w-14 shrink-0 place-items-center rounded-full"
      style={{
        background: `conic-gradient(rgb(var(--ink)) ${deg}deg, rgb(var(--ink) / 0.12) ${deg}deg)`,
      }}
      aria-label={`Intent score ${clamped} of 100`}
    >
      <div className="grid h-[46px] w-[46px] place-items-center rounded-full bg-canvas">
        <span className="nums text-[18px] font-fig-card leading-none text-ink">{clamped}</span>
      </div>
      {pulse && (
        <span
          className="pointer-events-none absolute inset-0 animate-ping rounded-full opacity-20"
          style={{ boxShadow: "0 0 0 2px rgb(var(--ink))" }}
        />
      )}
    </div>
  );
}

function ThreadCard({ thread }: { thread: DossierThread }) {
  const meta = intentMeta(thread.intentLabel);
  const plat =
    PLATFORM_META[thread.platform.toLowerCase()] ?? { label: thread.platform, symbol: "#" };
  return (
    <a
      href={thread.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col gap-3.5 rounded-lg border border-hairline bg-canvas p-5 transition-colors hover:border-ink/25"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-surface-soft font-fig-card text-ink">
          {plat.symbol}
        </span>
        <span className="text-ink">{plat.label}</span>
        <span className="text-ink/30">·</span>
        <span className="truncate text-ink/45">{hostOf(thread.url)}</span>
        <span className={cn("caption ml-auto rounded-full px-2.5 py-1 text-[#17162b]", meta.chip)}>
          {meta.label}
        </span>
      </div>
      <div className="flex gap-4">
        <ScoreRing score={thread.intentScore} pulse={meta.pulse} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-fig-headline leading-snug text-ink underline-offset-4 group-hover:underline">
            {thread.title}
          </p>
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink/60">
            “{thread.snippet}”
          </p>
          {thread.author && (
            <p className="mt-2 text-xs text-ink/45">
              asked by <span className="text-ink/70">{thread.author}</span>
            </p>
          )}
        </div>
      </div>
    </a>
  );
}

// ----------------------------------------------------------------------------
// Competitors poster (cream) — what your competitors are running.
// ----------------------------------------------------------------------------
function CompetitorsPanel({ competitors }: { competitors: DossierCompetitor[] }) {
  return (
    <Panel
      color="bg-block-cream"
      eyebrow="Ad intelligence · what's winning"
      title="What your competitors are running"
      intro="Scanned live across Meta + TikTok with no API token, scored and ranked. How long an ad has run is a proxy for how well it converts."
    >
      <div className="grid gap-4 md:grid-cols-2">
        {competitors.map((c, i) => (
          <CompetitorCard key={`${c.advertiser}-${i}`} competitor={c} />
        ))}
      </div>
    </Panel>
  );
}

function longevityLabel(days: number | null, active: boolean): string {
  if (!active) return "Ended";
  if (days === null) return "Live";
  if (days <= 0) return "Live today";
  return `Running ${days} ${days === 1 ? "day" : "days"}`;
}

function longevityChip(days: number | null, active: boolean): string {
  if (!active) return "bg-surface-soft";
  if ((days ?? 0) >= 30) return "bg-block-mint";
  if ((days ?? 0) >= 7) return "bg-block-lime";
  return "bg-block-cream";
}

function CompetitorCard({ competitor }: { competitor: DossierCompetitor }) {
  const ad: DossierAd = competitor.topAd;
  const active = ad.status === "active";
  const net = NETWORK_META[ad.network] ?? { label: ad.network || "Ad", symbol: "#" };
  return (
    <article className="relative flex flex-col gap-3 rounded-lg border border-hairline bg-canvas p-4">
      {ad.scalingSignal && (
        <span className="caption absolute -right-1 -top-1 inline-flex items-center gap-1 rounded-bl-lg rounded-tr-lg bg-block-mint px-2 py-1 text-[#17162b]">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          Scaling
        </span>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-surface-soft font-fig-card text-ink">
            {net.symbol}
          </span>
          <span className="truncate text-body-sm font-fig-headline text-ink">
            {competitor.advertiser}
          </span>
        </div>
        <span
          className={cn(
            "caption whitespace-nowrap rounded-pill px-2.5 py-1 text-[#17162b]",
            longevityChip(ad.daysRunning, active),
          )}
        >
          {longevityLabel(ad.daysRunning, active)}
        </span>
      </div>

      {ad.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ad.imageUrl}
          alt={`${competitor.advertiser} ad creative`}
          loading="lazy"
          className="h-40 w-full rounded-md object-cover ring-1 ring-hairline"
        />
      )}

      {ad.perfScore !== null && (
        <div className="flex items-baseline gap-2">
          <span className="nums text-card-title text-success">{Math.round(ad.perfScore)}</span>
          <span className="caption text-ink/50">performance score</span>
          {competitor.adCount > 1 && (
            <span className="caption ml-auto text-ink/45">{competitor.adCount} live ads</span>
          )}
        </div>
      )}

      {ad.headline && (
        <p className="text-body-sm font-fig-headline leading-snug text-ink">{ad.headline}</p>
      )}
      {ad.text && <p className="line-clamp-3 text-body-sm text-ink/75">“{ad.text}”</p>}

      {ad.winningAngle && (
        <p className="rounded-md bg-block-lime px-2.5 py-1.5 text-body-sm leading-snug text-[#17162b]">
          <span className="eyebrow mr-1 text-[11px]">Winning angle</span>
          {ad.winningAngle}
        </p>
      )}

      <a
        href={ad.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-pill border border-hairline bg-canvas px-3 py-1.5 text-body-sm font-fig-link text-ink transition-colors hover:bg-surface-soft"
      >
        View live ad
        <ArrowUpRight />
      </a>
    </article>
  );
}

// ----------------------------------------------------------------------------
// Decision-makers poster (lilac) — who to reach.
// ----------------------------------------------------------------------------
function DecisionMakersPanel({ makers }: { makers: DossierDecisionMaker[] }) {
  return (
    <Panel
      color="bg-block-lilac"
      eyebrow="Outbound · the people"
      title="Who to reach — and why now"
      intro="Real decision-makers at companies that fit, each tied to a live trigger. Verified emails are confirmed deliverable, not guessed."
    >
      <div className="grid gap-3">
        {makers.map((m, i) => (
          <DecisionMakerRow key={`${m.name}-${i}`} maker={m} />
        ))}
      </div>
    </Panel>
  );
}

function DecisionMakerRow({ maker }: { maker: DossierDecisionMaker }) {
  const initials =
    maker.name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "•";
  return (
    <div className="flex items-center gap-4 rounded-lg border border-hairline bg-canvas p-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface-soft text-[14px] font-fig-card text-ink">
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[15px] font-fig-headline text-ink">{maker.name}</span>
          {maker.title && <span className="text-[13px] text-ink/60">{maker.title}</span>}
          <span className="text-ink/25">·</span>
          <span className="text-[13px] text-ink/70">{maker.company}</span>
        </div>
        {maker.email && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="nums truncate text-[13px] text-ink/75">{maker.email}</span>
            {maker.verified && (
              <span className="caption inline-flex items-center gap-1 rounded-full bg-block-mint px-2 py-0.5 text-[#17162b]">
                <Check />
                verified
              </span>
            )}
          </div>
        )}
        {maker.signal && (
          <p className="mt-1.5 line-clamp-1 text-[12.5px] text-ink/55">
            <span className="eyebrow mr-1 text-[10px] text-ink/45">Signal</span>
            {maker.signal}
          </p>
        )}
      </div>
      {maker.fitScore !== null && (
        <div className="hidden shrink-0 flex-col items-center sm:flex">
          <span className="nums text-[20px] font-fig-card leading-none text-ink">
            {Math.round(maker.fitScore)}
          </span>
          <span className="caption text-ink/45">fit</span>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// "What we'd do" finale (navy) — the recommended play + drafted outreach +
// the generated creative. Dark constant ground, forced-light text.
// ----------------------------------------------------------------------------
function PlayPanel({ dossier }: { dossier: Dossier }) {
  const { recommendedPlay, draftedOutreach, creative } = dossier;
  return (
    <section className="color-block bg-block-navy text-white">
      <p className="eyebrow text-white/55">The play · what we&apos;d do next</p>
      <h2 className="mt-3 max-w-[20ch] text-[28px] font-fig-display leading-[1.05] tracking-[-0.02em] sm:text-[40px]">
        Here&apos;s exactly how we&apos;d win this market.
      </h2>
      <p className="mt-4 max-w-[62ch] text-body-lg text-white/75">{recommendedPlay.summary}</p>

      {recommendedPlay.steps.length > 0 && (
        <ol className="mt-7 grid gap-3">
          {recommendedPlay.steps.map((step, i) => (
            <li
              key={i}
              className="flex gap-4 rounded-lg border border-white/10 bg-white/[0.06] p-4"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-[13px] font-fig-card text-[#1f1d3d]">
                {i + 1}
              </span>
              <p className="text-[15px] leading-relaxed text-white/90">{step}</p>
            </li>
          ))}
        </ol>
      )}

      {(draftedOutreach || creative) && (
        <div className="mt-7 grid gap-5 lg:grid-cols-2">
          {draftedOutreach && <EmailPreview outreach={draftedOutreach} />}
          {creative && <CreativeShowcase creative={creative} />}
        </div>
      )}
    </section>
  );
}

function EmailPreview({
  outreach,
}: {
  outreach: NonNullable<Dossier["draftedOutreach"]>;
}) {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg bg-white text-[#17162b] ring-1 ring-white/10">
      <div className={cn("flex items-center gap-2 border-b px-4 py-3", HAIR)}>
        <span className="h-2.5 w-2.5 rounded-full bg-block-coral" />
        <span className="h-2.5 w-2.5 rounded-full bg-block-cream" />
        <span className="h-2.5 w-2.5 rounded-full bg-block-mint" />
        <span className="caption ml-2 text-[#17162b]/50">drafted outreach</span>
      </div>
      <div className="flex flex-col gap-3 p-5">
        {outreach.to && (
          <p className="text-[12.5px] text-[#17162b]/55">
            <span className="eyebrow mr-2 text-[10px] text-[#17162b]/40">To</span>
            {outreach.to}
          </p>
        )}
        <p className="text-[16px] font-fig-headline leading-snug">{outreach.subject}</p>
        <p className="whitespace-pre-line text-[14px] leading-relaxed text-[#17162b]/80">
          {outreach.body}
        </p>
      </div>
    </article>
  );
}

function CreativeShowcase({
  creative,
}: {
  creative: NonNullable<Dossier["creative"]>;
}) {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg bg-white text-[#17162b] ring-1 ring-white/10">
      {creative.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={creative.imageUrl}
          alt={creative.headline}
          loading="lazy"
          className="h-52 w-full object-cover"
        />
      ) : (
        <div className="grid h-28 w-full place-items-center bg-block-lilac">
          <span className="caption text-[#17162b]/60">creative · copy ready</span>
        </div>
      )}
      <div className="flex flex-col gap-2.5 p-5">
        <span className="caption text-[#17162b]/45">The ad we&apos;d run</span>
        <p className="text-[17px] font-fig-headline leading-snug">{creative.headline}</p>
        <p className="text-[14px] leading-relaxed text-[#17162b]/75">{creative.primaryText}</p>
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="inline-flex rounded-pill bg-primary px-4 py-1.5 text-[13px] font-fig-link text-on-primary">
            {creative.cta}
          </span>
          {creative.variations.length > 0 && (
            <span className="caption text-[#17162b]/45">
              +{creative.variations.length} variations
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

// ----------------------------------------------------------------------------
// Brain strip — "INTERCEPT learned N things building this."
// ----------------------------------------------------------------------------
function BrainStrip({ dossier }: { dossier: Dossier }) {
  const { stats, learnedFacts } = dossier;
  const learned = stats.brainFacts;
  if (learned <= 0 && learnedFacts.length === 0) return null;
  return (
    <section className={cn("color-block bg-block-coral", INK)}>
      <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div>
          <p className={cn("eyebrow", INK_SOFT)}>Compounding memory</p>
          <h2 className="mt-3 text-[26px] font-fig-display leading-[1.05] tracking-[-0.02em] sm:text-[34px]">
            INTERCEPT learned{" "}
            <span className="nums">{learned.toLocaleString()}</span> things building this — across{" "}
            <span className="nums">{stats.brainPages}</span> pages and{" "}
            <span className="nums">{stats.brainRuns}</span> runs.
          </h2>
          <p className={cn("mt-2 max-w-[52ch] text-body", INK_SOFT)}>
            Every run compounds into a private wiki, so the next dossier starts smarter than this one.
          </p>
        </div>
      </div>
      {learnedFacts.length > 0 && (
        <ul className="mt-6 grid gap-2 sm:grid-cols-2">
          {learnedFacts.slice(0, 6).map((f, i) => (
            <li
              key={i}
              className={cn("flex items-start gap-2.5 rounded-md bg-white/45 px-3 py-2", INK)}
            >
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#17162b]" />
              <span className="text-[13px] leading-relaxed">{f.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// Footer — the outreach hook + share affordance.
// ----------------------------------------------------------------------------
function Footer({ dossier }: { dossier: Dossier }) {
  const [copied, setCopied] = useState(false);
  const onShare = () => {
    try {
      const url =
        typeof window !== "undefined" ? `${window.location.origin}/dossier/${dossier.runId}` : "";
      navigator.clipboard?.writeText(url).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        },
        () => {},
      );
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  return (
    <footer className="mt-12 flex flex-col items-start gap-5 border-t border-hairline pt-10 sm:mt-16">
      <Wordmark />
      <p className="max-w-[40ch] text-subhead text-ink/80 sm:text-[26px]">
        We built this about your market — free. The live version updates itself, every day.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="/"
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-5 py-2.5 text-[15px] font-fig-link text-on-primary transition-opacity hover:opacity-90"
        >
          See the live version
          <ArrowUpRight />
        </a>
        <button
          onClick={onShare}
          className="inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-canvas px-5 py-2.5 text-[15px] font-fig-link text-ink transition-colors hover:bg-surface-soft"
        >
          {copied ? "Link copied" : "Copy share link"}
        </button>
      </div>
      <p className="caption mt-2 text-ink/40">
        Generated by INTERCEPT · a read-only snapshot of one intelligence run
      </p>
    </footer>
  );
}

// ----------------------------------------------------------------------------
// States + tiny glyphs.
// ----------------------------------------------------------------------------
function DossierLoading() {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-canvas text-ink">
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="relative h-12 w-12">
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-hairline border-t-ink" />
          <span className="absolute inset-2.5 rounded-full bg-surface-soft" />
        </div>
        <div>
          <p className="text-[17px] font-fig-headline text-ink">Assembling the dossier…</p>
          <p className="mt-1 text-body-sm text-ink/55">Aggregating this run&apos;s live intelligence.</p>
        </div>
      </div>
    </main>
  );
}

function DossierNotFound() {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-canvas px-6 text-ink">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-lg bg-block-cream text-[#17162b]">
          <span className="text-[20px] font-fig-card">?</span>
        </span>
        <div>
          <h1 className="text-[24px] font-fig-display tracking-[-0.02em] text-ink">
            This dossier isn&apos;t available
          </h1>
          <p className="mt-2 text-body-sm text-ink/60">
            The link may be incomplete, or this intelligence run no longer exists.
          </p>
        </div>
        <a
          href="/"
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-5 py-2.5 text-[15px] font-fig-link text-on-primary transition-opacity hover:opacity-90"
        >
          Go to INTERCEPT
          <ArrowUpRight />
        </a>
      </div>
    </main>
  );
}

function ArrowUpRight() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
