#!/usr/bin/env node
// ============================================================================
// INTERCEPT — FREE VIDEO WORKER  ·  MoneyPrinter path (no fal / no Veo payment)
// ----------------------------------------------------------------------------
// A tiny, self-contained local HTTP service that turns a {script/topic, scenes}
// request into a finished vertical (or square/landscape) MP4 — for $0:
//
//   1. STOCK FOOTAGE  — Pexels video search (free PEXELS_API_KEY), one clip per
//                       scene, scaled+cropped to the target frame.
//   2. NARRATION      — FREE Microsoft Edge-TTS (msedge-tts npm, NO key, no cost)
//                       synthesizes a voiceover per scene.
//   3. CAPTIONS       — ffmpeg drawtext burns each scene's line on-screen.
//   4. STITCH         — ffmpeg concats the scene segments + muxes the narration
//                       into one final.mp4, served back over HTTP.
//
// It mirrors the MoneyPrinterTurbo pipeline (search → per-scene clip → TTS →
// captioned concat) but in pure Node, with NO Python and NO paid API.
//
// GRACEFUL DEGRADATION (the whole point):
//   • ffmpeg missing            → 200 { ok:false, degraded, reason:"ffmpeg_not_installed" }
//   • PEXELS_API_KEY missing /   → falls back to a solid-color captioned frame
//     no clip found                (still produces a usable narrated video)
//   • Edge-TTS fails for a scene → that scene gets a silent gap (video still ok)
//   • any hard failure           → 200 { ok:false, degraded, reason } — NEVER 500
//
// The Convex side (convex/agents/reelmaker.ts + creative.ts) POSTs here, stores
// the returned bytes in Convex file storage, and no-ops if we're unreachable.
//
// Run:  npm run video-worker      (PORT 8787, override with VIDEO_WORKER_PORT)
// ============================================================================

import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileP = promisify(execFile);

// ----------------------------------------------------------------------------
// Config / constants
// ----------------------------------------------------------------------------
const PORT = Number(process.env.VIDEO_WORKER_PORT || 8787);
const PUBLIC_BASE = (process.env.VIDEO_WORKER_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";
const DEFAULT_VOICE = process.env.EDGE_TTS_VOICE || "en-US-AndrewNeural";
const MEDIA_DIR = path.join(tmpdir(), "intercept-video-worker");
const MAX_SCENES = 6;
const MIN_SCENE_SECONDS = 1.6;
const FALLBACK_SCENE_SECONDS = 2.6;
const MAX_B64_BYTES = 24 * 1024 * 1024; // don't inline videos larger than ~24MB
const FPS = 30;
const BG_COLOR = "0x0B1220"; // deep slate, matches the canvas

const ASPECTS = {
  "9:16": { w: 1080, h: 1920, orientation: "portrait" },
  "16:9": { w: 1920, h: 1080, orientation: "landscape" },
  "1:1": { w: 1080, h: 1080, orientation: "square" },
};

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

// ----------------------------------------------------------------------------
// Tiny utils
// ----------------------------------------------------------------------------
const log = (...a) => console.log(new Date().toISOString(), "[video-worker]", ...a);
const id = () => crypto.randomBytes(8).toString("hex");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function which(bin) {
  try {
    const { stdout } = await execFileP("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Some ffmpeg builds (e.g. certain Homebrew bottles) ship WITHOUT libfreetype,
// so the `drawtext` filter is missing. Detect it once and skip captions if so —
// the video still renders, just without burned-in text.
let DRAWTEXT_OK = null;
async function drawtextAvailable() {
  if (DRAWTEXT_OK !== null) return DRAWTEXT_OK;
  try {
    const { stdout } = await execFileP("ffmpeg", ["-hide_banner", "-filters"], {
      maxBuffer: 1024 * 1024 * 8,
    });
    DRAWTEXT_OK = /\bdrawtext\b/.test(stdout);
  } catch {
    DRAWTEXT_OK = false;
  }
  if (!DRAWTEXT_OK) log("ffmpeg has no drawtext filter — captions disabled (install ffmpeg with libfreetype to enable)");
  return DRAWTEXT_OK;
}

let FONT_FILE = null;
async function resolveFont() {
  if (FONT_FILE !== null) return FONT_FILE;
  for (const f of FONT_CANDIDATES) {
    if (await exists(f)) {
      FONT_FILE = f;
      return f;
    }
  }
  FONT_FILE = "";
  return "";
}

async function ffprobeDuration(file) {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

// drawtext is picky; we pass text via a sidecar file and only escape the
// filter-syntax special chars in the *paths*. Paths here never contain them.
function quoteFilterPath(p) {
  return `'${p.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:")}'`;
}

// Wrap caption text to a readable on-screen width.
function wrapCaption(text, maxChars = 24) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4).join("\n");
}

// ----------------------------------------------------------------------------
// Scene derivation: normalize whatever the caller sent into [{text, query}].
// ----------------------------------------------------------------------------
function splitSentences(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function keywordsFrom(text, topic) {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
    "your", "you", "it", "is", "are", "that", "this", "how", "why", "what", "who",
    "everyone", "almost", "nobody", "gets", "show", "screen", "here", "old", "way",
    "new", "more", "now", "matters", "talking", "about", "single", "bold", "caption",
  ]);
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w));
  const picked = words.slice(0, 2).join(" ");
  return [topic, picked].filter(Boolean).join(" ").trim() || topic || "business technology";
}

function deriveScenes(body) {
  const topic = String(body.topic || "").trim();
  let scenes = [];

  if (Array.isArray(body.scenes) && body.scenes.length > 0) {
    scenes = body.scenes.map((s) => {
      if (typeof s === "string") return { text: s, query: keywordsFrom(s, topic) };
      return {
        text: String(s.text || s.caption || s.narration || "").trim(),
        query: String(s.query || s.keywords || keywordsFrom(s.text || "", topic)).trim(),
      };
    });
  } else if (body.script) {
    scenes = splitSentences(body.script).map((t) => ({ text: t, query: keywordsFrom(t, topic) }));
  } else if (topic) {
    scenes = [{ text: topic, query: topic }];
  }

  scenes = scenes.filter((s) => s.text).slice(0, MAX_SCENES);
  if (scenes.length === 0 && topic) scenes = [{ text: topic, query: topic }];
  return { topic, scenes };
}

// ----------------------------------------------------------------------------
// Pexels stock footage (free). Returns a downloadable mp4 link or null.
// ----------------------------------------------------------------------------
async function pexelsClipUrl(query, aspect) {
  if (!PEXELS_API_KEY) return null;
  const params = new URLSearchParams({
    query: query || "business",
    per_page: "15",
    orientation: aspect.orientation,
    size: "medium",
  });
  try {
    const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
      headers: { Authorization: PEXELS_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log("pexels search failed", res.status, query);
      return null;
    }
    const json = await res.json();
    const videos = Array.isArray(json.videos) ? json.videos : [];
    if (videos.length === 0) return null;

    // Pick a random-ish video (variety across scenes), then its best-fit file.
    const candidates = videos.filter((v) => Array.isArray(v.video_files) && v.video_files.length);
    if (candidates.length === 0) return null;
    const v = candidates[Math.floor(Math.random() * Math.min(candidates.length, 8))];

    const files = v.video_files
      .filter((f) => f.file_type === "video/mp4" && f.link)
      .map((f) => ({ ...f, area: (f.width || 0) * (f.height || 0) }));
    if (files.length === 0) return null;

    const targetArea = aspect.w * aspect.h;
    // Prefer the smallest file that still covers the target frame; else largest.
    const covering = files
      .filter((f) => f.width >= aspect.w && f.height >= aspect.h)
      .sort((a, b) => a.area - b.area);
    const chosen = covering[0] || files.sort((a, b) => Math.abs(a.area - targetArea) - Math.abs(b.area - targetArea))[0];
    return chosen?.link || null;
  } catch (e) {
    log("pexels error", String(e?.message || e));
    return null;
  }
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return dest;
}

// ----------------------------------------------------------------------------
// Edge-TTS narration (FREE, no key). Returns true on success.
// ----------------------------------------------------------------------------
let MsEdgeTTS = null;
let OUTPUT_FORMAT = null;
let ttsLoadAttempted = false;
async function loadTts() {
  if (ttsLoadAttempted) return !!MsEdgeTTS;
  ttsLoadAttempted = true;
  try {
    const mod = await import("msedge-tts");
    MsEdgeTTS = mod.MsEdgeTTS;
    OUTPUT_FORMAT = mod.OUTPUT_FORMAT;
    return true;
  } catch (e) {
    log("msedge-tts unavailable — narration will be silent:", String(e?.message || e));
    return false;
  }
}

async function synthScene(text, voice, dir, outPath) {
  if (!(await loadTts())) return false;
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice || DEFAULT_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioFilePath } = await tts.toFile(dir, text);
    try {
      tts.close?.();
    } catch {
      /* ignore */
    }
    if (audioFilePath && (await exists(audioFilePath))) {
      // msedge-tts writes `${dir}/audio.mp3`; move to a stable per-scene name.
      const buf = await readFile(audioFilePath);
      await writeFile(outPath, buf);
      await rm(audioFilePath, { force: true }).catch(() => {});
      return (await ffprobeDuration(outPath)) > 0;
    }
    return false;
  } catch (e) {
    log("tts scene failed:", String(e?.message || e));
    return false;
  }
}

async function makeSilence(seconds, outPath) {
  await execFileP("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=24000:cl=mono`,
    "-t",
    String(seconds),
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    outPath,
  ]);
  return outPath;
}

// ----------------------------------------------------------------------------
// Build one captioned, fixed-duration, audio-less video segment.
// ----------------------------------------------------------------------------
async function buildSegment({ clipPath, duration, caption, aspect, captionsOn, dir, index, outPath }) {
  const fontFile = await resolveFont();
  const vfParts = [];

  if (clipPath) {
    vfParts.push(
      `scale=${aspect.w}:${aspect.h}:force_original_aspect_ratio=increase`,
      `crop=${aspect.w}:${aspect.h}`,
      `fps=${FPS}`,
    );
  }

  if (captionsOn && fontFile && caption && (await drawtextAvailable())) {
    const capPath = path.join(dir, `cap_${index}.txt`);
    await writeFile(capPath, wrapCaption(caption));
    const fontSize = aspect.h >= aspect.w ? 56 : 48;
    const yPos = aspect.h >= aspect.w ? "h-text_h-260" : "h-text_h-90";
    vfParts.push(
      [
        `drawtext=fontfile=${quoteFilterPath(fontFile)}`,
        `textfile=${quoteFilterPath(capPath)}`,
        `reload=0`,
        `fontcolor=white`,
        `fontsize=${fontSize}`,
        `line_spacing=12`,
        `box=1`,
        `boxcolor=black@0.55`,
        `boxborderw=28`,
        `x=(w-text_w)/2`,
        `y=${yPos}`,
      ].join(":"),
    );
  }

  const vf = vfParts.join(",");
  const common = [
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-r",
    String(FPS),
    "-t",
    String(duration),
  ];

  if (clipPath) {
    await execFileP(
      "ffmpeg",
      ["-y", "-stream_loop", "-1", "-i", clipPath, ...(vf ? ["-vf", vf] : []), ...common, outPath],
      { maxBuffer: 1024 * 1024 * 64 },
    );
  } else {
    // No footage → solid colored background, still captioned + narrated.
    const lavfi = `color=c=${BG_COLOR}:s=${aspect.w}x${aspect.h}:r=${FPS}`;
    await execFileP(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", lavfi, ...(vf ? ["-vf", vf] : []), ...common, outPath],
      { maxBuffer: 1024 * 1024 * 64 },
    );
  }
  return outPath;
}

async function concatList(files, listPath) {
  const body = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, body);
  return listPath;
}

// ----------------------------------------------------------------------------
// The render pipeline. Returns { ok, path, url, videoBase64, ... } — never throws.
// ----------------------------------------------------------------------------
async function render(body) {
  const model = "moneyprinter-pexels-edgetts";
  if (!(await which("ffmpeg")) || !(await which("ffprobe"))) {
    return {
      ok: false,
      degraded: true,
      reason: "ffmpeg_not_installed",
      error: "ffmpeg/ffprobe not found on PATH. Install with: brew install ffmpeg",
      model,
    };
  }

  const aspect = ASPECTS[body.aspectRatio] || ASPECTS["9:16"];
  const voice = body.voice || DEFAULT_VOICE;
  const captionsOn = body.captions !== false;
  const targetTotal = Number(body.durationSeconds) > 0 ? Number(body.durationSeconds) : 0;

  const { topic, scenes } = deriveScenes(body);
  if (scenes.length === 0) {
    return { ok: false, degraded: true, reason: "no_scenes", error: "No script/topic/scenes provided.", model };
  }

  const work = await mkdtemp(path.join(tmpdir(), "vw-"));
  try {
    await mkdir(MEDIA_DIR, { recursive: true });

    const segPaths = [];
    const audPaths = [];
    let usedPexels = false;
    let usedTts = false;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      // 1) Narration first — its duration drives the scene length (caption sync).
      const audPath = path.join(work, `aud_${i}.mp3`);
      const ttsDir = path.join(work, `tts_${i}`);
      await mkdir(ttsDir, { recursive: true });
      const ok = await synthScene(scene.text, voice, ttsDir, audPath);
      let duration;
      if (ok) {
        usedTts = true;
        duration = Math.max(MIN_SCENE_SECONDS, (await ffprobeDuration(audPath)) + 0.35);
        // pad the narration so the cut doesn't clip the last word
        const padded = path.join(work, `auds_${i}.mp3`);
        await execFileP("ffmpeg", [
          "-y", "-i", audPath, "-af", `apad=pad_dur=0.35`, "-t", String(duration),
          "-acodec", "libmp3lame", "-q:a", "5", padded,
        ]).catch(() => {});
        audPaths.push((await exists(padded)) ? padded : audPath);
      } else {
        duration = FALLBACK_SCENE_SECONDS;
        await makeSilence(duration, audPath);
        audPaths.push(audPath);
      }

      // 2) Stock footage for the scene (best effort).
      let clipPath = null;
      const link = await pexelsClipUrl(scene.query || topic, aspect);
      if (link) {
        try {
          clipPath = await download(link, path.join(work, `clip_${i}.mp4`));
          usedPexels = true;
        } catch (e) {
          log("clip download failed:", String(e?.message || e));
          clipPath = null;
        }
      }

      // 3) Build the captioned segment.
      const segPath = path.join(work, `seg_${i}.mp4`);
      await buildSegment({
        clipPath,
        duration,
        caption: scene.text,
        aspect,
        captionsOn,
        dir: work,
        index: i,
        outPath: segPath,
      });
      segPaths.push(segPath);
    }

    // 4) Concat video segments (identical codec params → stream copy).
    const vList = await concatList(segPaths, path.join(work, "vlist.txt"));
    const silentVideo = path.join(work, "video.mp4");
    await execFileP("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", vList, "-c", "copy", silentVideo], {
      maxBuffer: 1024 * 1024 * 64,
    });

    // 5) Concat narration, then mux into the final.
    const aList = await concatList(audPaths, path.join(work, "alist.txt"));
    const narration = path.join(work, "narration.mp3");
    await execFileP("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", aList, "-c", "copy", narration], {
      maxBuffer: 1024 * 1024 * 64,
    }).catch(async () => {
      // copy can fail across mp3 frames — re-encode as a fallback.
      await execFileP("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", aList, "-acodec", "libmp3lame", narration]);
    });

    const outId = id();
    const finalPath = path.join(MEDIA_DIR, `${outId}.mp4`);
    await execFileP(
      "ffmpeg",
      [
        "-y", "-i", silentVideo, "-i", narration,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
        "-shortest", "-movflags", "+faststart", finalPath,
      ],
      { maxBuffer: 1024 * 1024 * 64 },
    );

    const st = await stat(finalPath);
    const totalDuration = await ffprobeDuration(finalPath);

    let videoBase64;
    if (st.size <= MAX_B64_BYTES) {
      videoBase64 = (await readFile(finalPath)).toString("base64");
    }

    log(`rendered ${finalPath} (${(st.size / 1024 / 1024).toFixed(2)}MB, ${totalDuration.toFixed(1)}s, ${scenes.length} scenes)`);

    return {
      ok: true,
      degraded: !usedPexels || !usedTts,
      reason: !usedPexels ? "no_stock_footage" : !usedTts ? "no_narration" : undefined,
      model,
      path: finalPath,
      url: `${PUBLIC_BASE}/media/${outId}.mp4`,
      contentType: "video/mp4",
      bytes: st.size,
      durationSeconds: totalDuration,
      scenes: scenes.length,
      usedPexels,
      usedTts,
      videoBase64,
      ...(targetTotal ? { requestedDuration: targetTotal } : {}),
    };
  } catch (e) {
    log("render failed:", String(e?.stack || e?.message || e));
    return { ok: false, degraded: true, reason: "render_failed", error: String(e?.message || e), model };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// HTTP server
// ----------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function serveMedia(req, res, file) {
  const safe = path.basename(file);
  const full = path.join(MEDIA_DIR, safe);
  if (!full.startsWith(MEDIA_DIR) || !(await exists(full))) {
    return sendJson(res, 404, { ok: false, error: "not found" });
  }
  const st = await stat(full);
  res.writeHead(200, { "content-type": "video/mp4", "content-length": st.size, "accept-ranges": "bytes" });
  createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const ffmpeg = !!(await which("ffmpeg"));
      const ttsReady = await loadTts();
      return sendJson(res, 200, {
        ok: true,
        service: "intercept-video-worker",
        ffmpeg,
        ffprobe: !!(await which("ffprobe")),
        pexels: !!PEXELS_API_KEY,
        tts: ttsReady,
        captions: ffmpeg ? await drawtextAvailable() : false,
        voice: DEFAULT_VOICE,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      return serveMedia(req, res, url.pathname.slice("/media/".length));
    }

    if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/render")) {
      const body = await readBody(req);
      const result = await render(body);
      // Always 200 — the caller degrades on { ok:false }, never on a thrown 500.
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    log("request error:", String(e?.message || e));
    return sendJson(res, 200, { ok: false, degraded: true, reason: "worker_error", error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  log(`listening on ${PUBLIC_BASE}  (POST / to render, GET /health)`);
  log(`pexels=${PEXELS_API_KEY ? "set" : "MISSING (will use color backgrounds)"} voice=${DEFAULT_VOICE}`);
  if (!PEXELS_API_KEY) log("set PEXELS_API_KEY to enable stock footage");
});
