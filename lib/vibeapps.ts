// ============================================================================
// INTERCEPT — VIBEAPPS SCRAPER (Hackathon Radar field source)
// ----------------------------------------------------------------------------
// Turn a vibeapps.dev tag page (e.g. /tag/ycgrowthhackathon) into a list of
// RadarProject cards — name, tagline, author, demo URL, and GitHub repo link.
//
// vibeapps.dev is a JS-rendered Convex SPA: a plain fetch returns an empty HTML
// shell with NO project data. So we PREFER lib/supadata.webScrape (which renders
// JS and returns clean markdown). Each project on the tag page links to a story
// page (/s/<slug>) that holds the repo + live links, so we:
//   1) scrape the tag page → story entries (name + story URL),
//   2) window the tag markdown for any inline repo/demo/author already present,
//   3) follow story pages (BOUNDED) only for entries still missing a repo,
//   4) emit RadarProject[] with owner/repo parsed and honest provenance notes.
//
// GRACEFUL BY CONTRACT: NEVER throws. No Supadata key, no network, an empty/JS
// page, or a thin card all degrade to fewer/empty results — the radar keeps
// running on whatever it got. Public data only (the public tag + story pages).
//
// RUNTIME-SAFE: only `fetch` (global) + lib/supadata (fetch-based) + lib/radar
// (pure). No node builtins — import-safe in Convex's DEFAULT action runtime.
// ============================================================================

import { supadata } from "./supadata";
import {
  type RadarProject,
  RADAR_MAX_STORY_FETCHES,
  parseRepoUrl,
  isLikelyDemoUrl,
  cleanText,
  truncate,
} from "./radar";

const USER_AGENT = "intercept-radar (+https://github.com/intercept)";
const FETCH_TIMEOUT_MS = 15_000;
/** Don't let a pathological page balloon the field. */
const MAX_PROJECTS = 150;

/**
 * vibeapps.dev runs on a PUBLIC Convex deployment and its tag pages load the
 * project list from these query functions — hitting them directly is far more
 * reliable than rendering the SPA (which only ever yields a static shell).
 * Confirmed live deployment first; we still fall back to scraping if both fail.
 */
const VIBEAPPS_CONVEX_URLS = [
  "https://whimsical-dalmatian-205.convex.cloud",
  "https://happy-otter-123.convex.cloud",
];

interface PageText {
  markdown: string;
  title?: string;
  description?: string;
}

interface MarkdownLink {
  text: string;
  url: string;
}

/** A provisional project assembled from the tag page (+ optional story detail). */
interface Entry {
  name: string;
  storyUrl?: string;
  tagline?: string;
  author?: string;
  githubUrl?: string;
  demoUrl?: string;
  /** Where the detail came from, for honest provenance. */
  detailSource: "card" | "story";
}

// ============================================================================
// PUBLIC ENTRYPOINT
// ============================================================================

/**
 * Scrape a vibeapps tag page into the field of submitted projects. Returns []
 * (never throws) on any failure — partial/empty is fine and expected.
 */
export async function fetchHackathonProjects(
  tagUrl: string,
): Promise<RadarProject[]> {
  const url = cleanText(tagUrl);
  if (!/^https?:\/\//i.test(url)) return [];

  // PRIMARY: vibeapps' own public Convex API — the SPA's real data source.
  const viaApi = await fetchViaVibeappsApi(url);
  if (viaApi.length > 0) return viaApi.slice(0, MAX_PROJECTS);

  // FALLBACK: render + scrape the tag page if the API path yields nothing.
  const page = await readMarkdown(url);
  if (!page || !page.markdown.trim()) return [];

  const links = extractLinks(page.markdown);

  // 1) Story entries — the canonical per-app anchors on the tag page.
  let entries = buildStoryEntries(page.markdown, links);

  // 2) No story links at all (thin/odd scrape): fall back to bare repo links.
  if (entries.length === 0) {
    return dedupeProjects(buildProjectsFromRepoLinks(links));
  }

  // 3) Follow story pages — ONLY for entries still missing a repo, BOUNDED.
  entries = await enrichEntriesFromStories(entries);

  // 4) Map → RadarProject (never throws per entry).
  const projects = entries
    .map(entryToProject)
    .filter((p): p is RadarProject => p !== null);

  return dedupeProjects(projects).slice(0, MAX_PROJECTS);
}

// ============================================================================
// PRIMARY INGEST — vibeapps' own public Convex API (the SPA's real source).
//   tags:getBySlug({slug}) → tagId, then stories:listApproved({tagId,…}) → the
//   submitted stories (title, url=demo, githubUrl, description, submitterName).
// Paginated, multi-deployment, totally graceful — [] on any failure.
// ============================================================================

async function fetchViaVibeappsApi(tagUrl: string): Promise<RadarProject[]> {
  const slug = tagSlugFromUrl(tagUrl);
  if (!slug) return [];

  for (const base of VIBEAPPS_CONVEX_URLS) {
    try {
      const tag = (await convexQuery(base, "tags:getBySlug", { slug })) as
        | { _id?: string }
        | null;
      const tagId = tag?._id;
      if (!tagId) continue;

      const projects: RadarProject[] = [];
      let cursor: string | null = null;
      for (let p = 0; p < 12; p++) {
        const res = (await convexQuery(base, "stories:listApproved", {
          paginationOpts: { numItems: 100, cursor },
          tagId,
        })) as
          | { page?: unknown[]; isDone?: boolean; continueCursor?: string | null }
          | null;
        const pageItems = Array.isArray(res?.page) ? res!.page! : [];
        for (const s of pageItems) {
          const proj = storyToProject(s);
          if (proj) projects.push(proj);
        }
        if (!res || res.isDone || !res.continueCursor) break;
        cursor = res.continueCursor;
      }
      if (projects.length > 0) return dedupeProjects(projects);
    } catch {
      // try the next deployment, then fall through to scraping.
    }
  }
  return [];
}

/** POST a public query to a vibeapps Convex deployment; null on any failure.
 *  Uses a manual AbortController (NOT AbortSignal.timeout, which isn't reliable
 *  in Convex's default runtime — mirrors lib/github.ts). */
async function convexQuery(
  base: string,
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { status?: string; value?: unknown };
    return json?.status === "success" ? json.value : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function tagSlugFromUrl(tagUrl: string): string | null {
  const m = tagUrl.match(/\/tag\/([A-Za-z0-9._-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Map one vibeapps story doc → RadarProject (total; null only if unnamed). */
function storyToProject(s: unknown): RadarProject | null {
  if (!s || typeof s !== "object") return null;
  const st = s as Record<string, unknown>;
  const str = (k: string): string =>
    typeof st[k] === "string" ? (st[k] as string) : "";

  const name = cleanText(str("title"));
  if (!name) return null;

  const githubUrl = str("githubUrl") || undefined;
  const parsed = githubUrl ? parseRepoUrl(githubUrl) : null;
  const tagline = cleanText(str("description") || str("longDescription"));
  const author = cleanText(str("submitterName") || str("teamName"));
  const demo = str("url") || undefined;

  return {
    name: truncate(name, 120),
    tagline: tagline ? truncate(tagline, 200) : undefined,
    demoUrl: demo,
    githubUrl: parsed?.url,
    owner: parsed?.owner,
    repo: parsed?.repo,
    author: author ? truncate(author, 60) : undefined,
    maturity: "unknown",
    threatLevel: 0,
    analyzedFromRepo: false,
    note: parsed
      ? "From vibeapps (public Convex API)."
      : "From vibeapps (public Convex API) — submitter gave no repo link.",
  };
}

// ============================================================================
// READ — Supadata first (renders JS), plain fetch as a graceful fallback.
// ============================================================================

async function readMarkdown(url: string): Promise<PageText | null> {
  // Primary: Supadata web scrape (handles JS-rendered SPAs like vibeapps).
  try {
    const r = await supadata.webScrape(url);
    if (r.ok && r.data && r.data.markdown.trim()) {
      return {
        markdown: r.data.markdown,
        title: r.data.title,
        description: r.data.description,
      };
    }
  } catch {
    // supadata is graceful by contract, but never let it throw past here.
  }

  // Fallback: plain fetch + HTML→markdown-ish (works for non-JS pages only).
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const markdown = htmlToMarkdownish(html);
    if (!markdown.trim()) return null;
    return {
      markdown,
      title: extractHtmlTitle(html),
      description: extractMetaContent(html, "description"),
    };
  } catch {
    return null;
  }
}

// ============================================================================
// PARSE — links, story entries, repo-link fallback.
// ============================================================================

/** All links in markdown: `[text](url)` plus bare `https://…`. Deduped by url. */
function extractLinks(md: string): MarkdownLink[] {
  const out: MarkdownLink[] = [];
  const seen = new Set<string>();

  const push = (text: string, rawUrl: string): void => {
    const url = resolveUrl(rawUrl);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ text: cleanText(text), url });
  };

  // [text](url)
  const linkRe = /\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(md)) !== null) push(m[1] ?? "", m[2] ?? "");

  // bare URLs (keep order; texts empty)
  const bareRe = /https?:\/\/[^\s)<>"'\]]+/g;
  while ((m = bareRe.exec(md)) !== null) push("", m[0]);

  return out;
}

/** Resolve an absolute or vibeapps-relative href; trim trailing punctuation. */
function resolveUrl(raw: string): string | null {
  let u = (raw ?? "").trim();
  if (!u) return null;
  if (u.startsWith("//")) u = `https:${u}`;
  else if (u.startsWith("/")) u = `https://vibeapps.dev${u}`;
  if (!/^https?:\/\//i.test(u)) return null;
  u = u.replace(/[.,);:'"\]>]+$/, "");
  return u.length > 8 ? u : null;
}

const STORY_RE = /vibeapps\.dev\/s\/([A-Za-z0-9._-]+)/i;

/** Build one entry per unique story link, pre-filled from the tag-page window. */
function buildStoryEntries(md: string, links: MarkdownLink[]): Entry[] {
  const storyLinks = links.filter((l) => STORY_RE.test(l.url));
  if (storyLinks.length === 0) return [];

  // Window the markdown by story-link position so we can grab any inline
  // repo/demo/author that a rich scrape already surfaced on the card itself.
  const positions = storyLinks
    .map((l) => ({ link: l, idx: md.indexOf(l.url) }))
    .filter((p) => p.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  const bySlug = new Map<string, Entry>();
  for (let i = 0; i < positions.length; i++) {
    const { link, idx } = positions[i];
    const slug = (link.url.match(STORY_RE)?.[1] ?? "").toLowerCase();
    if (!slug) continue;

    const end = i + 1 < positions.length ? positions[i + 1].idx : md.length;
    const windowText = md.slice(idx, Math.min(end, idx + 1200));
    const windowLinks = extractLinks(windowText);

    const entry: Entry = {
      name: cleanText(link.text) || prettySlug(slug),
      storyUrl: link.url,
      githubUrl: pickRepoUrl(windowLinks),
      demoUrl: pickDemoUrl(windowLinks),
      tagline: pickTagline(windowText, link.text),
      author: pickAuthor(windowText, windowLinks),
      detailSource: "card",
    };

    // Keep the richest card if a slug appears twice.
    const prior = bySlug.get(slug);
    if (!prior || score(entry) > score(prior)) bySlug.set(slug, entry);
  }

  return Array.from(bySlug.values());
}

/** When there are no story links, treat each distinct repo link as a project. */
function buildProjectsFromRepoLinks(links: MarkdownLink[]): RadarProject[] {
  const byRepo = new Map<string, RadarProject>();
  for (const l of links) {
    const parsed = parseRepoUrl(l.url);
    if (!parsed) continue;
    const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    if (byRepo.has(key)) continue;
    byRepo.set(key, {
      name: cleanText(l.text) || parsed.repo,
      githubUrl: parsed.url,
      owner: parsed.owner,
      repo: parsed.repo,
      maturity: "unknown",
      threatLevel: 0,
      analyzedFromRepo: false,
      note: "Discovered via repo link on the tag page (no story card).",
    });
  }
  return Array.from(byRepo.values());
}

// ============================================================================
// ENRICH — follow story pages (bounded) for entries still missing a repo.
// ============================================================================

async function enrichEntriesFromStories(entries: Entry[]): Promise<Entry[]> {
  // Prioritize entries that have a story URL but no repo yet.
  const needsDetail = entries.filter((e) => e.storyUrl && !e.githubUrl);
  const toFetch = needsDetail.slice(0, RADAR_MAX_STORY_FETCHES);
  const fetchSet = new Set(toFetch.map((e) => e.storyUrl));

  const detailByUrl = new Map<string, PageText | null>();
  await Promise.all(
    toFetch.map(async (e) => {
      const page = e.storyUrl ? await readMarkdown(e.storyUrl) : null;
      if (e.storyUrl) detailByUrl.set(e.storyUrl, page);
    }),
  );

  return entries.map((e) => {
    if (!e.storyUrl || !fetchSet.has(e.storyUrl)) return e;
    const page = detailByUrl.get(e.storyUrl);
    if (!page || !page.markdown.trim()) return e;
    return mergeStoryDetail(e, page);
  });
}

/** Merge a scraped story page into an entry — only filling gaps. */
function mergeStoryDetail(entry: Entry, page: PageText): Entry {
  const links = extractLinks(page.markdown);
  const detailName = cleanTitle(page.title);
  const detailTagline =
    cleanText(page.description) || pickTagline(page.markdown, entry.name);

  return {
    name: detailName || entry.name,
    storyUrl: entry.storyUrl,
    githubUrl: entry.githubUrl ?? pickRepoUrl(links),
    demoUrl: entry.demoUrl ?? pickDemoUrl(links),
    tagline: entry.tagline ?? (detailTagline || undefined),
    author: entry.author ?? pickAuthor(page.markdown, links),
    detailSource: "story",
  };
}

// ============================================================================
// FIELD PICKERS (all total / never throw).
// ============================================================================

/** First valid GitHub repo URL among links. */
function pickRepoUrl(links: MarkdownLink[]): string | undefined {
  for (const l of links) {
    const parsed = parseRepoUrl(l.url);
    if (parsed) return parsed.url;
  }
  return undefined;
}

/** First plausible live/demo URL — preferring links whose text says so. */
function pickDemoUrl(links: MarkdownLink[]): string | undefined {
  const eligible = links.filter((l) => isLikelyDemoUrl(l.url));
  if (eligible.length === 0) return undefined;
  const preferRe = /visit|live|demo|website|try|open|launch|app\b|view\s+app/i;
  const preferred = eligible.find((l) => preferRe.test(l.text));
  return (preferred ?? eligible[0]).url;
}

/** A short tagline from a window/page — first substantial non-link, non-heading line. */
function pickTagline(text: string, exclude: string): string | undefined {
  const skip = cleanText(exclude).toLowerCase();
  const lines = text.split(/\n+/);
  for (const raw of lines) {
    const line = cleanText(raw.replace(/^[#>*\-\s]+/, ""));
    if (line.length < 16 || line.length > 240) continue;
    if (/^\[|\]\(|https?:\/\//i.test(line)) continue; // link-y line
    if (line.toLowerCase() === skip) continue;
    if (/^(submitted|posted|created|tags?|share|comments?|upvote)/i.test(line)) continue;
    return truncate(line, 200);
  }
  return undefined;
}

const PROFILE_RE = /vibeapps\.dev\/(?:u|user|profile)\/([A-Za-z0-9._-]+)/i;

/** Best-effort author — a profile link or a "submitted by …" phrase. */
function pickAuthor(text: string, links: MarkdownLink[]): string | undefined {
  for (const l of links) {
    const m = l.url.match(PROFILE_RE);
    if (m) return cleanText(l.text) || `@${m[1]}`;
  }
  const by = text.match(
    /(?:submitted|posted|created|built|made|by)\s+by[:\s]+([^\n|·•@]+?)(?:\s{2,}|\n|$)/i,
  );
  if (by) {
    const name = cleanText(by[1]);
    if (name && name.length <= 60) return name;
  }
  const handle = text.match(/(?:^|\s)@([A-Za-z0-9_]{2,30})\b/);
  if (handle) return `@${handle[1]}`;
  return undefined;
}

// ============================================================================
// MAP + DEDUPE.
// ============================================================================

function entryToProject(e: Entry): RadarProject | null {
  const name = cleanText(e.name);
  if (!name) return null;
  const parsed = e.githubUrl ? parseRepoUrl(e.githubUrl) : null;

  const note = parsed
    ? `Repo linked from vibeapps ${e.detailSource}.`
    : "Card scraped from vibeapps — no public repo link found.";

  return {
    name: truncate(name, 120),
    tagline: e.tagline ? truncate(e.tagline, 200) : undefined,
    demoUrl: e.demoUrl,
    githubUrl: parsed?.url,
    owner: parsed?.owner,
    repo: parsed?.repo,
    author: e.author ? truncate(e.author, 60) : undefined,
    maturity: "unknown",
    threatLevel: 0,
    analyzedFromRepo: false,
    note,
  };
}

/** Dedupe by repo (owner/repo) first, then by lowercased name. */
function dedupeProjects(projects: RadarProject[]): RadarProject[] {
  const byKey = new Map<string, RadarProject>();
  for (const p of projects) {
    const key = p.owner && p.repo
      ? `repo:${p.owner}/${p.repo}`.toLowerCase()
      : `name:${cleanText(p.name).toLowerCase()}`;
    const prior = byKey.get(key);
    if (!prior || projectScore(p) > projectScore(prior)) byKey.set(key, p);
  }
  return Array.from(byKey.values());
}

// ============================================================================
// Small pure helpers.
// ============================================================================

function score(e: Entry): number {
  return (
    (e.githubUrl ? 4 : 0) +
    (e.demoUrl ? 2 : 0) +
    (e.tagline ? 1 : 0) +
    (e.author ? 1 : 0)
  );
}

function projectScore(p: RadarProject): number {
  return (
    (p.githubUrl ? 4 : 0) +
    (p.demoUrl ? 2 : 0) +
    (p.tagline ? 1 : 0) +
    (p.author ? 1 : 0)
  );
}

function prettySlug(slug: string): string {
  return cleanText(slug.replace(/[-_]+/g, " "))
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Strip the vibeapps site suffix from a page <title>. */
function cleanTitle(title?: string): string {
  const t = cleanText(title);
  if (!t) return "";
  return t.replace(/\s*[-–|]\s*(vibe apps|vibeapps(?:\.dev)?)\s*$/i, "").trim();
}

// --- HTML fallback parsing (only used when Supadata is unavailable) ---------

function htmlToMarkdownish(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  // Preserve anchor hrefs as markdown links so link extraction works uniformly.
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_full, href, inner) => `[${stripTags(inner)}](${href}) `,
  );
  s = stripTags(s);
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractHtmlTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanText(decodeEntities(stripTags(m[1]))) || undefined : undefined;
}

function extractMetaContent(html: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  return m ? cleanText(decodeEntities(m[1])) || undefined : undefined;
}
