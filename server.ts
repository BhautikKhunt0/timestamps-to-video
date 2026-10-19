import express from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs";
import { exec, spawn } from "child_process";
import { createServer as createViteServer } from "vite";
import ffmpegPath from "ffmpeg-static";

import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import {
  planMotion,
  buildMotionBranch,
  normalizeMotionConfig,
  introCutoff,
  type ShotMotion,
} from "./src/utils/motion";
import {
  normalizeSlideSpec,
  layoutSlide,
  buildSlideFilter,
  SLIDE_W,
  SLIDE_H,
  SLIDE_FPS,
  SLIDE_BG,
  type SlideSpec,
} from "./src/utils/slides";


const getMediaDuration = (filePath: string): Promise<number> => {
  return new Promise((resolve) => {
    exec(`"${ffmpegPath}" -i "${filePath}"`, (err, stdout, stderr) => {
      const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}(\.\d+)?)/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        const secs = parseFloat(match[3]);
        resolve(hours * 3600 + mins * 60 + secs);
      } else {
        resolve(0); 
      }
    });
  });
};

// ---------- Frame-grid timeline (cut-accuracy fix) ----------
// Output is 30fps, so every cut can only land on a whole frame: a script
// timestamp like 00:18:14.582 sits inside frame 17 (0.5667s-0.6000s) and is
// honored to the nearest frame (±16.7ms — the physical limit of the format).
// The OLD code converted each slide duration to frames INDEPENDENTLY, so the
// per-slide rounding error accumulated along the timeline: measured on a
// 120-image job, cuts drifted ~200ms early (batch path) and ~350ms late
// (xfade path), growing with every cut — the visible "cut lands away from its
// timestamp" bug. Quantizing the CUMULATIVE timeline instead bounds every
// cut's error to half a frame forever, and totals stay frame-exact.
const RENDER_FPS = 30;
const toFrames = (sec: number) => Math.round(sec * RENDER_FPS);
const toSeconds = (frames: number) => frames / RENDER_FPS;
const quantizeTimelineToFrames = (durs: number[]): number[] => {
  let prevFrames = 0;
  let cumSec = 0;
  return durs.map((d) => {
    cumSec += Number.isFinite(d) && d > 0 ? d : 0;
    let f = toFrames(cumSec) - prevFrames;
    if (f < 1) f = 1; // never emit an empty (sub-frame) slide
    prevFrames += f;
    return toSeconds(f);
  });
};

// ---------- Transition pipeline helpers (fix for stuck transitions) ----------

// ffmpeg xfade supports these in ffmpeg-static 5.x. Anything else falls back to fade
// so a single typo / unsupported name can never hang the whole job.
const VALID_XFADE = new Set([
  "fade", "fadeblack", "fadewhite",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circlecrop", "rectcrop", "distance", "radial",
  "hblur", "dissolve", "pixelize",
]);
const normalizeTransition = (t: string): string => {
  if (!t || t === "none") return "none";
  if (VALID_XFADE.has(t)) return t;
  if (t === "slideleft" || t === "slideright") return t;
  return "fade";
};

const SEGMENT_SIZE = 20; // images per segment -> bounds filter graph + memory for 300+ images
const RUN_CONCURRENCY = 3; // heavy xfade+veryfast encodes: oversubscription thrash measured at 6 (Phase 1)
const PROBE_CONCURRENCY = 20; // getMediaDuration probes are I/O-light; parallelize (Phase 1)
const MUX_CONCURRENCY = 4; // final per-chunk concat+mux are independent files (Phase 1)
// NOTE (Phase 1 finding): explicit -threads caps HURT (single big xfade encode
// slowed 6.2s -> 8.0s with -threads 4). libx264 auto-threading stays.

// Encode settings per content type (tuned in perf phases; SSIM-gated, see PERF.md).
// Static content (holds, batches, Mode A) shares ONE family: ultrafast is ~2x
// faster than veryfast on stills and the lower CRF + stillimage tune keeps
// fidelity (Phase 3a: gated >= 0.995 vs veryfast/crf20).
const HOLD_PRESET = "ultrafast";
const HOLD_CRF = "18";
const HOLD_TUNE: string[] = ["-tune", "stillimage"];
const RUN_PRESET = "veryfast"; // Phase 3b NEGATIVE RESULT: superfast gave +4% speed for
const RUN_CRF = "20";         // +80% file size on typical runs (per-process overhead dominates
                              // small runs, not the encoder core) — reverted, size/quality stable.
const HOLD_BATCH_CONCURRENCY = 2; // Phase 5 (single-decode graph): hold pieces fell ~35s -> ~2.5s,
                                  // so wide parallelism now loses to turbo/power limits — measured
                                  // 3-wide (11.9s) slower than serial (7.4s) on 20-slide batches.
                                  // 2 keeps overlap for tiny mode-B single-slide batches.
const HOLD_THREADS = 4;           // Phase 5 measured: auto all-core x264 threads hurt these short
                                  // pieces (2467ms -> 1914ms single; also best at 3-wide).
const RUN_THREADS = 8;            // Phase 5 measured: run pieces stay CPU-bound after the graph
                                  // fix; 3 concurrent x 8 threads beat auto (107.7s -> 98.6s).

// 1080p canvas filter applied INLINE at encode time from the original upload
// (Phase 2: the norm_*.png intermediate stage is gone — identical pixels,
// zero intermediate I/O). Ends with format (callers may append fps etc).
// Phase 5: runs ONCE per image (before the loop filter), never per frame.
const SCALE_FILTER = "scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(1920-iw)/2:(1080-ih)/2:black,setsar=1,format=yuv420p";
// Pre-rendered slide clips are already 1920x1080 yuv420p CFR-30: branches
// only normalize the timebase — never rescale (SCALE_FILTER would resample
// identical pixels and soften them).
const CLIP_TAIL = "setsar=1,format=yuv420p";
// Slide pre-render encode (overlay choreography only, no camera motion).
const SLIDE_PRESET = "ultrafast";
const SLIDE_CRF = "18";
const SLIDE_PRE_CONCURRENCY = 4;
// Headline font, filesystem path (the filter graph uses the escaped
// SLIDE_FONT_FILE from slides.ts). Missing file => slides render titleless,
// never fail: the check runs per job in the slide pre-render step.
const SLIDE_FONT_PATH = "C:/Windows/Fonts/arialbd.ttf";

const app = express();
const PORT = 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/api/ws" });

const clients = new Set<WebSocket>();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

const broadcast = (jobId: string, type: string, payload: any) => {
  const msg = JSON.stringify({ jobId, type, ...payload });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
};

const appendLog = (jobDir: string, name: string, text: string) => {
  try {
    const logDir = path.join(jobDir, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, name), text + "\n");
  } catch {}
};

// Bounded worker pool: run fn over items with at most `conc` in flight,
// results in input order. Used for independent per-file ffmpeg work.
const mapPool = async <T, R>(items: T[], conc: number, fn: (t: T, idx: number) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const active = Math.max(1, Math.min(conc, items.length));
  await Promise.all(Array.from({ length: active }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
};

// Perf marks: every job writes output/<job>/logs/perf.log with per-stage wall
// times + the encode settings used, so speedup phases are measured, not guessed.
const perfMark = (jobDir: string, t0: number, label: string) => {
  appendLog(jobDir, "perf.log", `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
};

const jobs = new Map();

const checkCancelled = (jobId: string) => {
  const j: any = jobs.get(jobId);
  if (j?.cancelled) throw new Error("Job cancelled by user");
};

const setJobProgress = (jobId: string, progress: number, stage?: string, detail?: string, eta?: number | null) => {
  const j: any = jobs.get(jobId);
  if (!j) return;
  j.progress = Math.max(0, Math.min(100, Math.round(progress)));
  if (stage) j.stage = stage;
  if (detail) j.detail = detail;
  j.lastUpdateTime = Date.now();
  if (typeof eta === "number") j.eta = eta;
  else if (j.startTime) {
    const elapsed = (Date.now() - j.startTime) / 1000;
    if (j.progress > 3) j.eta = Math.max(0, Math.round((elapsed / j.progress) * (100 - j.progress)));
    else j.eta = null;
  }
  broadcast(jobId, "progress", { progress: j.progress, eta: j.eta, stage: j.stage, detail: j.detail });
};

// Run ffmpeg with timeout + captured stderr. Never hangs forever (old bug:
// xfade with offset=0 + exact-duration inputs waited for frames indefinitely).
const runFfmpeg = (args: string[], opts: { jobDir: string; label: string; timeoutMs?: number }): Promise<void> => {
  const timeoutMs = opts.timeoutMs ?? 180000;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let proc: any;
    try {
      proc = spawn(ffmpegPath as string, args);
    } catch (e: any) {
      return reject(new Error(`${opts.label} failed to spawn: ${e.message}`));
    }
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\n[TIMEOUT after ${timeoutMs}ms]`;
      appendLog(opts.jobDir, "ffmpeg.log", `[TIMEOUT] ${opts.label}\nCMD: ${args.join(" ")}\nTAIL:\n${stderr.slice(-4000)}`);
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`${opts.label} timed out after ${Math.round(timeoutMs / 1000)}s. See output/logs/ffmpeg.log`));
    }, timeoutMs);
    try { (timer as any).unref?.(); } catch {}
    proc.stderr?.on("data", (d: any) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.on("error", (err: any) => {
      clearTimeout(timer);
      appendLog(opts.jobDir, "ffmpeg.log", `[SPAWN-ERROR] ${opts.label}: ${err.message}`);
      reject(new Error(`${opts.label} spawn error: ${err.message}`));
    });
    proc.on("close", (code: number) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code === 0) {
        resolve();
      } else {
        appendLog(opts.jobDir, "ffmpeg.log", `[FAIL code=${code} ${ms}ms] ${opts.label}\nCMD: ${(ffmpegPath as string)} ${args.join(" ")}\nSTDERR TAIL:\n${stderr.slice(-4000)}`);
        reject(new Error(`${opts.label} failed (code ${code}): ${stderr.slice(-500)}`));
      }
    });
  });
};

// Clamp per-cut transition durations so the centered half+half transitions can
// never overlap each other: each T <= 0.8 * min(adjacent slides) guarantees the
// two halves meeting inside any slide stay below its full duration.
const computeSafeTransDurations = (
  parsedTransitions: string[],
  rawTransDurs: any[],
  baseDur: number,
  finalDurations: number[]
): number[] => {
  return parsedTransitions.map((t, i) => {
    if (t === "none") return 0;
    const requested = typeof rawTransDurs[i] === "number" && rawTransDurs[i] > 0 ? rawTransDurs[i] : baseDur;
    const a = finalDurations[i] ?? 5;
    const b = finalDurations[i + 1] ?? 5;
    // very short slides can't host a transition -> force cut
    if (Math.min(a, b) < 0.4) return 0;
    const maxAllowed = Math.min(a, b) * 0.8;
    // Whole-frame clamp (30fps): never exceed 0.8x the adjacent slides so the
    // centered half+half fades stay inside both slides; band 0.2s..2.0s.
    const maxFrames = Math.floor(maxAllowed * RENDER_FPS);
    const wantFrames = toFrames(requested);
    const frames = Math.max(Math.min(wantFrames, maxFrames, 2 * RENDER_FPS), toFrames(0.2));
    return toSeconds(frames);
  });
};

// Build offsets for a standard overlapping xfade chain:
// offset_k = sum(D[0..k]) - sum(T[0..k])
// Inputs are frame-exact seconds (whole/half frames for the centered fades).
// Full precision is REQUIRED here: the old toFixed(3) rounding pushed offsets
// off the frame grid and shifted every fade center by up to ~2 frames.
const computeXfadeOffsets = (durs: number[], transDurs: number[]): number[] => {
  const offsets: number[] = [];
  let sumD = 0;
  let sumT = 0;
  for (let k = 0; k < transDurs.length; k++) {
    sumD += durs[k];
    sumT += transDurs[k];
    offsets.push(sumD - sumT);
  }
  return offsets;
};

app.use(express.json());

const UPLOAD_DIR = path.join(process.cwd(), "output");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Extension for an uploaded file: prefer a sane on-disk extension from the
 * original name, else derive it from the browser's MIME type. Files with no
 * usable extension still land (ffmpeg needs one to sniff the format), so the
 * MIME fallback matters for clipboard pastes / extension-less uploads.
 */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
};
const fileExt = (file: Express.Multer.File): string => {
  const raw = path.extname(file.originalname || "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(raw)) return raw === ".jpeg" ? ".jpg" : raw;
  return EXT_BY_MIME[String(file.mimetype || "").toLowerCase().split(";")[0]] || "";
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobId = req.body.jobId;
    if (!jobId) return cb(new Error("Missing jobId"), "");
    const jobDir = path.join(UPLOAD_DIR, jobId);
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
    cb(null, jobDir);
  },
  // The temp name MUST be unique per file. Writing `file.originalname`
  // verbatim made browsers that send several files with the SAME name
  // (IMG_1234.png from two sources, three "image.jpg" exports) overwrite each
  // other on disk; the rename below then hit ENOENT and failed the WHOLE batch
  // with a 500, so images never landed. Unique names make the rename total.
  filename: (req, file, cb) => {
    const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
    cb(null, `up_${uniq}${fileExt(file)}`);
  },
});
const upload = multer({ storage });

// Multer/storage errors must be JSON like every other API response — an HTML
// error page here reads as "proxy returned HTML" in the client. Wrapping the
// multer middleware catches its errors too (they fire before the route handler).
const uploadRoute = (mw: any, handler: (req: any, res: any) => void) => (req: any, res: any) =>
  mw(req, res, (err: any) => {
    if (err) {
      if (!res.headersSent) res.status(500).json({ error: err?.message || "Upload failed" });
      return;
    }
    Promise.resolve(handler(req, res)).catch((e: any) => {
      if (!res.headersSent) res.status(500).json({ error: e?.message || "Upload failed" });
    });
  });

// Generate unique job ID
app.get("/api/init-job", (req, res) => {
  const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
  const jobDir = path.join(UPLOAD_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  res.json({ jobId });
});

// Upload images in batch
app.post("/api/upload-batch", uploadRoute(upload.array("images"), (req, res) => {
  try {
    const { indices, jobId } = req.body;
    const parsedIndices = indices ? JSON.parse(indices) : [];
    
    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const jobDir = path.join(UPLOAD_DIR, jobId);
    const files = req.files as Express.Multer.File[];
    
    // One bad file must not sink the whole batch: rename per file and report
    // exactly what landed. (Multer temp names are unique now, so these
    // renames cannot collide the way original names did.)
    const saved: number[] = [];
    const failed: string[] = [];
    files.forEach((file, i) => {
      const originalIndex = parsedIndices[i] !== undefined ? parsedIndices[i] : i;
      try {
        fs.renameSync(file.path, path.join(jobDir, `raw_${originalIndex}${fileExt(file)}`));
        saved.push(originalIndex);
      } catch (e: any) {
        failed.push(`${file.originalname}: ${e.message}`);
      }
    });

    res.json({ success: failed.length === 0 && saved.length > 0, count: saved.length, indices: parsedIndices, failed });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to process batch upload" });
  }
}));

// Upload audio
app.post("/api/upload-audio", uploadRoute(upload.array("audio", 50), (req, res) => {
  try {
    const { jobId } = req.body;
    if (!req.files || !Array.isArray(req.files) || !jobId) {
      return res.status(400).json({ error: "Missing files or jobId" });
    }
    const jobDir = path.join(UPLOAD_DIR, jobId);
    
    // Append after the HIGHEST existing index (not the file count) so a
    // re-upload never overwrites an earlier track.
    const existing = fs.existsSync(jobDir)
      ? fs.readdirSync(jobDir)
          .map((f) => /^audio_(\d+)\./.exec(f))
          .filter((m): m is RegExpExecArray => !!m)
          .map((m) => Number(m[1]))
      : [];
    let startIndex = existing.length ? Math.max(...existing) + 1 : 0;

    const files = req.files as Express.Multer.File[];
    const failed: string[] = [];
    files.forEach((file) => {
      try {
        fs.renameSync(file.path, path.join(jobDir, `audio_${startIndex}${fileExt(file)}`));
        startIndex++;
      } catch (e: any) {
        failed.push(`${file.originalname}: ${e.message}`);
      }
    });

    res.json({ success: failed.length === 0 && files.length > 0, count: files.length - failed.length, failed });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to upload audio" });
  }
}));

// ---------- Transition SFX library (stored in the project, once) ----------
// Sounds live in <root>/sfx/ with an index.json manifest, so a user imports
// a sound ONCE and it stays available for every future job — no re-uploads.
// type SfxEntry = { id: string; name: string; file: string; dur: number };
const SFX_DIR = path.join(process.cwd(), "sfx");
const SFX_MANIFEST = path.join(SFX_DIR, "index.json");
type SfxEntry = { id: string; name: string; file: string; dur: number };

const readSfxManifest = (): SfxEntry[] => {
  try {
    const parsed = JSON.parse(fs.readFileSync(SFX_MANIFEST, "utf8"));
    if (Array.isArray(parsed)) return parsed.filter((e: any) => e && typeof e.id === "string" && typeof e.file === "string");
  } catch { /* fresh install or corrupted file: start over */ }
  return [];
};
const writeSfxManifest = (entries: SfxEntry[]): void => {
  if (!fs.existsSync(SFX_DIR)) fs.mkdirSync(SFX_DIR, { recursive: true });
  const tmp = SFX_MANIFEST + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, SFX_MANIFEST);
};
const sfxPublicList = (entries: SfxEntry[]) => entries
  .filter((e) => fs.existsSync(path.join(SFX_DIR, e.file)))
  .map((e) => ({ id: e.id, name: e.name, dur: e.dur, url: `/api/sfx/${e.id}/file` }));

// True when ffmpeg sniffs an actual audio stream (rejects video-only/none).
const probeHasAudio = (filePath: string): Promise<boolean> =>
  new Promise((resolve) => {
    exec(`"${ffmpegPath}" -i "${filePath}"`, (err, _o, stderr) => {
      resolve(/Stream #\d+:\d+.*Audio:/.test(stderr || ""));
    });
  });

const sfxStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(SFX_DIR)) fs.mkdirSync(SFX_DIR, { recursive: true });
    cb(null, SFX_DIR);
  },
  // Unique on-disk id per import (same-name files never collide); the
  // friendly display name rides in the manifest.
  filename: (req, file, cb) => {
    const id = `sfx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    cb(null, `${id}${fileExt(file) || ".m4a"}`);
  },
});
const sfxUpload = multer({ storage: sfxStorage, limits: { files: 24 } });

app.get("/api/sfx/list", (_req, res) => {
  // Auto-heal: entries whose file vanished are pruned from the manifest.
  const entries = readSfxManifest().filter((e) => fs.existsSync(path.join(SFX_DIR, e.file)));
  if (entries.length !== readSfxManifest().length) writeSfxManifest(entries);
  res.json({ sounds: sfxPublicList(entries) });
});

app.post("/api/sfx/upload", uploadRoute(sfxUpload.array("sfx"), async (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No audio files received" });
  }
  const entries = readSfxManifest();
  const failed: string[] = [];
  let count = 0;
  for (const file of files) {
    try {
      const dur = await getMediaDuration(file.path);
      if (!(dur >= 0.03 && dur <= 20)) throw new Error("Audio must be 0.03–20s");
      if (!(await probeHasAudio(file.path))) throw new Error("No audio stream found");
      const base = path.basename(file.originalname || "Sound", path.extname(file.originalname || ""));
      const friendly = base.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 42) || "Sound";
      entries.push({
        id: path.basename(file.filename, path.extname(file.filename)),
        name: friendly,
        file: file.filename,
        dur: Number(dur.toFixed(3)),
      });
      count++;
    } catch (e: any) {
      failed.push(`${path.basename(file.originalname || "file")}: ${e.message}`);
      try { fs.unlinkSync(file.path); } catch { /* already gone */ }
    }
  }
  writeSfxManifest(entries);
  res.json({ success: count > 0, count, failed, sounds: sfxPublicList(entries) });
}));

// Starter pack: synthesizes a palette of transition sounds with ffmpeg lavfi
// so the rack is playable immediately. Skipped by id on re-runs (stable ids).
const SFX_STARTERS: { name: string; input: string; filters: string; dur: number }[] = [
  {
    name: "Swoosh Soft", dur: 1.1, input: "anoisesrc=color=pink:r=48000:a=0.65:d=1.1",
    filters: "highpass=f=240,lowpass=f=2600,volume='pow(sin(PI*t/1.1),2.6)':eval=frame",
  },
  {
    name: "Swoosh Deep", dur: 1.5, input: "anoisesrc=color=brown:r=48000:a=0.85:d=1.5",
    filters: "lowpass=f=750,volume='pow(sin(PI*t/1.5),3)':eval=frame,asetrate=40000,aresample=48000",
  },
  {
    name: "Riser", dur: 1.7,
    input: "aevalsrc=exprs='0.5*sin(2*PI*(280+2400*pow(t/1.7,2.2))*t)*pow(t/1.7,1.4)+0.2*sin(2*PI*80*t)*pow(t/1.7,2)':s=48000:d=1.7",
    filters: "volume='min(1,1.6)':eval=frame,lowpass=f=5200",
  },
  {
    name: "Pop", dur: 0.16, input: "sine=f=620:r=48000:d=0.16",
    filters: "volume='exp(-20*t)':eval=frame",
  },
  {
    name: "Punch", dur: 0.5, input: "sine=f=115:r=48000:d=0.5",
    filters: "volume='exp(-8.5*t)':eval=frame,lowpass=f=1100",
  },
  {
    name: "Sparkle", dur: 0.9, input: "sine=f=2350:r=48000:d=0.9",
    filters: "tremolo=f=8.5:d=0.85,volume='0.7*exp(-3.2*t)':eval=frame",
  },
  {
    name: "Tick", dur: 0.07, input: "anoisesrc=color=white:r=48000:a=0.85:d=0.07",
    filters: "highpass=f=3200,volume='exp(-55*t)':eval=frame",
  },
];
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

app.post("/api/sfx/seed", async (_req, res) => {
  if (!fs.existsSync(SFX_DIR)) fs.mkdirSync(SFX_DIR, { recursive: true });
  const entries = readSfxManifest();
  let added = 0;
  try {
    for (const def of SFX_STARTERS) {
      const id = `sfx_st_${slugify(def.name)}`;
      if (entries.some((e) => e.id === id)) continue;
      const file = `${id}.m4a`;
      await runFfmpeg(
        ["-y", "-nostdin", "-f", "lavfi", "-i", def.input, "-af", def.filters,
         "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "160k", path.join(SFX_DIR, file)],
        { jobDir: UPLOAD_DIR, label: `sfx_seed_${def.name}`, timeoutMs: 60000 });
      entries.push({ id, name: def.name, file, dur: def.dur });
      added++;
    }
    writeSfxManifest(entries);
    res.json({ success: true, added, sounds: sfxPublicList(entries) });
  } catch (e: any) {
    writeSfxManifest(entries);
    res.status(500).json({ error: e?.message || "Starter pack failed", sounds: sfxPublicList(entries) });
  }
});

app.delete("/api/sfx/:id", (req, res) => {
  const id = String(req.params.id || "");
  const entries = readSfxManifest();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return res.status(404).json({ error: "Sound not found" });
  try { fs.unlinkSync(path.join(SFX_DIR, entry.file)); } catch { /* already gone */ }
  const next = entries.filter((e) => e.id !== id);
  writeSfxManifest(next);
  res.json({ success: true, sounds: sfxPublicList(next) });
});

app.get("/api/sfx/:id/file", (req, res) => {
  const id = String(req.params.id || "");
  const entry = readSfxManifest().find((e) => e.id === id);
  if (!entry || !fs.existsSync(path.join(SFX_DIR, entry.file))) {
    return res.status(404).json({ error: "Sound not found" });
  }
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(path.join(SFX_DIR, entry.file));
});

// Cancel a running job (checked between segments/batches)
app.post("/api/cancel/:jobId", (req, res) => {
  const job: any = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  job.cancelled = true;
  job.status = "cancelled";
  broadcast(req.params.jobId, "error", { error: "Job cancelled by user" });
  res.json({ ok: true });
});

app.post("/api/generate", async (req, res) => {
  const { jobId, durations, transitions, transitionDurations, transitionDuration, outputMode, motion, slides, sfx } = req.body;
  if (!jobId || !durations || !Array.isArray(durations)) {
    return res.status(400).json({ error: "Invalid payload" });
  }
  // "single" = whole output in one video (default for new clients),
  // "chunks" = legacy per-audio-length chunk splitting.
  const mode: "single" | "chunks" = outputMode === "single" ? "single" : "chunks";

  const jobDir = path.join(UPLOAD_DIR, jobId);
  if (!fs.existsSync(jobDir)) {
    return res.status(400).json({ error: "Job directory not found" });
  }

  res.json({ message: "Started", jobId });

  jobs.set(jobId, {
    status: "processing",
    progress: 0,
    eta: null,
    stage: "starting",
    detail: "",
    chunks: [],
    startTime: Date.now(),
    lastUpdateTime: Date.now(),
    cancelled: false,
  });
  const perfT0 = Date.now();
  perfMark(jobDir, perfT0, `start mode=${mode} slides=${Array.isArray(durations) ? durations.length : "?"} cpus=${os.cpus().length} settings={runConc:${RUN_CONCURRENCY},batchConc:${HOLD_BATCH_CONCURRENCY},probeConc:${PROBE_CONCURRENCY},muxConc:${MUX_CONCURRENCY},threads:hold=${HOLD_THREADS}/run${RUN_THREADS},hold:${HOLD_PRESET}/crf${HOLD_CRF}${HOLD_TUNE.length ? "+" + HOLD_TUNE.join(" ") : ""},run:${RUN_PRESET}/crf${RUN_CRF}}`);

  // Render one static hold (single image -> mp4). Fast and never hangs.
  // Input is the RAW upload; canvas scaling happens inline (Phase 2).
  // Pre-rendered slide clips (isClip) carry baked animation: consume their
  // real frames via a range trim instead of freezing frame 0 + loop.
  const renderHold = async (rawPath: string, dur: number, outPath: string, label: string,
    motion?: { shot: ShotMotion; tOff?: number } | null, isClip: boolean = false) => {
    // Whole frames only (no toFixed(3), which could push an exact frame count
    // off the grid and add a stray frame); 0.1s floor kept for encode safety.
    const frames = Math.max(toFrames(0.1), toFrames(dur));
    const d = toSeconds(frames);
    const head = isClip
      ? ["-y", "-nostdin", "-i", rawPath]
      : ["-y", "-nostdin", "-framerate", "30", "-i", rawPath];
    const tail = [
      "-r", "30", "-c:v", "libx264", "-preset", HOLD_PRESET, "-crf", HOLD_CRF,
      "-pix_fmt", "yuv420p", "-threads", String(HOLD_THREADS), "-t", d.toString(), outPath,
    ];
    const staticArgs = isClip
      ? [
          ...head,
          "-vf", `trim=start_frame=0:end_frame=${frames},setpts=PTS-STARTPTS,settb=1/30,${CLIP_TAIL}`,
          ...tail,
        ]
      : [
          ...head,
          "-vf", `trim=end_frame=1,setpts=PTS-STARTPTS,settb=1/30,${SCALE_FILTER},loop=loop=${frames - 1}:size=1`,
          ...tail.slice(0, 3), ...HOLD_TUNE, ...tail.slice(3),
        ];
    const args = motion
      ? [
          ...head,
          "-filter_complex",
          buildMotionBranch(motion.shot, {
            mode: "fc", inputIdx: 0, outLabel: "vout",
            loopFrames: frames, tOff: motion.tOff ?? 0,
            inputKind: isClip ? "video" : "still",
          }),
          "-map", "[vout]",
          // stillimage tune only fits static frames — moving content drops it.
          ...tail,
        ]
      : staticArgs;
    try {
      await runFfmpeg(args, { jobDir, label, timeoutMs: 120000 });
    } catch (e) {
      // Motion safety net: the animated zoom re-initialises the scaler every
      // frame and faults on some long shots in this ffmpeg build. One branch
      // must never fail a whole job — redo it as a clean still instead.
      if (!motion) throw e;
      appendLog(jobDir, "ffmpeg.log", `[motion retry] ${label}: ${(e as Error).message}`);
      try {
        // The fault is intermittent (per-frame scaler reinit), so one retry
        // usually keeps the camera move instead of dropping to a still.
        await runFfmpeg(args, { jobDir, label: `${label} (motion retry)`, timeoutMs: 120000 });
        return d;
      } catch (e2) {
        appendLog(jobDir, "ffmpeg.log", `[motion fallback to static] ${label}: ${(e2 as Error).message}`);
        await runFfmpeg(staticArgs, { jobDir, label: `${label} (static)`, timeoutMs: 120000 });
      }
    }
    return d;
  };

  // Render a batch of consecutive static holds in ONE filter pass (Phase 2/4):
  // per-image single-decode inputs (loop FILTER) joined by the concat FILTER —
  // exact by construction.
  // (The concat DEMUXER + trailer recipe proved nondeterministic at scale:
  // 2/8 batches lost ~1s each in the 300-soak, so it is banned from video.)
  const renderHoldBatch = async (items: { path: string; dur: number; motion?: ShotMotion | null; tOff?: number; clip?: boolean }[], outPath: string, label: string) => {
    // Frame-exact per-slide durations (cumulative quantization: idempotent for
    // already-quantized input, absorbs stray values such as mid-chunk splits).
    // Every -t and the output total are then exact multiples of 1/30s, so cuts
    // land exactly where the timeline says — no per-slide drift.
    const durs = quantizeTimelineToFrames(items.map((it) => it.dur));
    const total = durs.reduce((a, b) => a + b, 0);
    const anyMotion = items.some(it => it.motion);
    const anyClip = items.some(it => it.clip);
    // Branch builder: withMotion=false reproduces today's static graph exactly
    // (used both for non-motion items and as the whole-batch retry).
    const buildBatch = (withMotion: boolean) => {
      const head: string[] = ["-y", "-nostdin"];
      // -framerate is an image-demuxer flag: stills need it, clip .mp4s must
      // not take it.
      items.forEach((it) => it.clip
        ? head.push("-i", it.path)
        : head.push("-framerate", "30", "-i", it.path));
      let f = "";
      items.forEach((_, i) => {
        const frames = Math.max(1, Math.round(durs[i] * 30));
        if (withMotion && items[i].motion) {
          // Motion shot: same loop frame budget, animated crop window instead of
          // the static scale/copy branch (branch string ends in ";" + [vN]).
          f += buildMotionBranch(items[i].motion!, {
            mode: "fc", inputIdx: i, outLabel: `v${i}`,
            loopFrames: frames, tOff: items[i].tOff ?? 0,
            inputKind: items[i].clip ? "video" : "still",
          });
        } else if (items[i].clip) {
          // Baked slide animation: consume real frames, never rescale.
          f += `[${i}:v]trim=start_frame=0:end_frame=${frames},setpts=PTS-STARTPTS,settb=1/30,${CLIP_TAIL},settb=AVTB[v${i}];`;
        } else {
          f += `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,settb=1/30,${SCALE_FILTER},loop=loop=${frames - 1}:size=1,settb=AVTB[v${i}];`;
        }
      });
      f += items.map((_, i) => `[v${i}]`).join("") + `concat=n=${items.length}:v=1:a=0[vout]`;
      return [
        ...head,
        "-filter_complex", f,
        "-map", "[vout]",
        "-r", "30", "-filter_complex_threads", String(HOLD_THREADS),
        "-c:v", "libx264", "-preset", HOLD_PRESET,
        // stillimage tune fits still frames only — motion or clips drop it.
        "-crf", HOLD_CRF, ...(withMotion || anyClip ? [] : HOLD_TUNE), "-pix_fmt", "yuv420p",
        "-threads", String(HOLD_THREADS),
        "-t", total.toString(),
        outPath,
      ];
    };
    try {
      await runFfmpeg(buildBatch(anyMotion), { jobDir, label, timeoutMs: 600000 });
    } catch (e) {
      // Motion safety net (see renderHold): a faulty motion branch must never
      // fail the batch — rerun the identical timeline as clean stills.
      if (!anyMotion) throw e;
      appendLog(jobDir, "ffmpeg.log", `[motion retry] ${label}: ${(e as Error).message}`);
      try {
        await runFfmpeg(buildBatch(true), { jobDir, label: `${label} (motion retry)`, timeoutMs: 600000 });
        return total;
      } catch (e2) {
        appendLog(jobDir, "ffmpeg.log", `[motion fallback to static] ${label}: ${(e2 as Error).message}`);
        await runFfmpeg(buildBatch(false), { jobDir, label: `${label} (static)`, timeoutMs: 600000 });
      }
    }
    return total;
  };

  // Render a run of >=2 images joined by real (overlapping) xfade transitions.
  // Each transition is centered EXACTLY on its cut: T/2 comes from the tail of
  // image i and T/2 from the head of image i+1 (0.3s = 0.15s + 0.15s, and the
  // same half+half rule for 0.5 / 0.8 / 1.0 / 1.5 / 2.0s).
  // To achieve this, input i is extended by halves of its adjacent transitions,
  // so visible spans and the total duration (exactly sum(durs)) match the
  // pasted timestamps — transitions never shrink or shift the timeline.
  const renderXfadeRun = async (
    normPaths: string[], durs: number[], trans: string[], transDurs: number[],
    outPath: string, label: string, plan?: (ShotMotion | null)[], clip?: boolean[]
  ): Promise<number> => {
    const n = normPaths.length;
    // Frame-exact inputs: cumulative quantization for slide lengths, whole
    // frames per transition (idempotent — callers already pass quantized
    // values). Math stays in full-precision seconds: offsets land on the
    // half-frame grid the centered half+half fades require; the old toFixed(3)
    // pushed them off the frame grid and shifted every fade center by up to
    // ~2 frames (measured drift: +350ms over a 120-image job).
    const qDurs = quantizeTimelineToFrames(durs);
    const qTrans = transDurs.map((t) => (t > 0 ? toSeconds(Math.max(1, toFrames(t))) : 0));
    // Whole-frame half-extensions (must mirror planMotion extFor): odd-frame
    // transitions split floor-right / ceil-left so halves sum to the full
    // transition and every offset lands exactly on the frame grid. A raw /2
    // lands mid-frame (0.5s = 15f -> 7.5f) and misaligns each blend by 0.5f,
    // breaking the mirror handoff's position/velocity match (visible pop).
    const halfDownF = (frames: number) => Math.floor(frames / 2);
    const inDurs = qDurs.map((d, i) => d
      + (i > 0 ? toSeconds(toFrames(qTrans[i - 1]) - halfDownF(toFrames(qTrans[i - 1]))) : 0)
      + (i < qDurs.length - 1 ? toSeconds(halfDownF(toFrames(qTrans[i]))) : 0));
    const expected = qDurs.reduce((a, b) => a + b, 0);
    const offsets = computeXfadeOffsets(inDurs, qTrans);
    const anyMotion = !!plan?.some(Boolean);
    // withMotion=false reproduces today's static branch graph exactly, and is
    // also the whole-run retry if a motion branch faults (see renderHold).
    // Clip inputs (baked slide animation) consume real frame windows and are
    // never rescaled; stills keep the single-decode + loop filter path.
    const buildRun = (withMotion: boolean) => {
      const a: string[] = ["-y", "-nostdin"];
      // Single-decode inputs (Phase 5): decode + scale ONCE per image, repeat the
      // frame with the loop FILTER — the old -loop 1 demuxer re-read and re-decoded
      // the file for every output frame (dominant run cost before the fix).
      // Frame budget keeps the old "+0.5s so xfade never hits EOF exactly at
      // offset+duration" pad: ceil never lands below it, extra tail frames are
      // simply unused by xfade, so EOF behavior is unchanged.
      for (let i = 0; i < n; i++) {
        if (clip?.[i]) a.push("-i", normPaths[i]);
        else a.push("-framerate", "30", "-i", normPaths[i]);
      }
      let f = "";
      for (let i = 0; i < n; i++) {
        const frames = Math.max(1, Math.ceil((inDurs[i] + 0.5) * 30 + 1e-6));
        if (withMotion && plan?.[i]) {
          // Motion shot: same "+0.5s" frame budget the static loop uses, but the
          // crop window animates across the (extended) input span. On the
          // retry-fade path transDurs differ from the plan's — the curve then
          // clips or holds; fallback path only.
          f += buildMotionBranch(plan[i]!, {
            mode: "fc", inputIdx: i, outLabel: `v${i}`,
            loopFrames: frames, tOff: 0,
            inputKind: clip?.[i] ? "video" : "still",
          });
        } else if (clip?.[i]) {
          f += `[${i}:v]trim=start_frame=0:end_frame=${frames},setpts=PTS-STARTPTS,settb=1/30,${CLIP_TAIL},settb=AVTB[v${i}];`;
        } else {
          f += `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,settb=1/30,${SCALE_FILTER},loop=loop=${frames - 1}:size=1,settb=AVTB[v${i}];`;
        }
      }
      let cur = "[v0][v1]";
      let outLabel = "[x1]";
      // first transition
      f += `${cur}xfade=transition=${trans[0]}:duration=${qTrans[0]}:offset=${offsets[0]}${outLabel};`;
      for (let k = 1; k < trans.length; k++) {
        const nextIn = `[v${k + 1}]`;
        const prevOut = outLabel;
        outLabel = `[x${k + 1}]`;
        f += `${prevOut}${nextIn}xfade=transition=${trans[k]}:duration=${qTrans[k]}:offset=${offsets[k]}${outLabel};`;
      }
      f += `${outLabel}format=yuv420p[vout]`;
      a.push(
        "-filter_complex", f, "-map", "[vout]",
        "-r", "30", "-filter_complex_threads", String(RUN_THREADS),
        "-c:v", "libx264", "-preset", RUN_PRESET,
        "-crf", RUN_CRF, "-pix_fmt", "yuv420p",
        "-threads", String(RUN_THREADS),
        "-t", expected.toString(),
        outPath
      );
      return a;
    };
    try {
      await runFfmpeg(buildRun(anyMotion), { jobDir, label, timeoutMs: 300000 });
    } catch (e) {
      // Motion safety net (see renderHold): rerun the identical run as static
      // xfades rather than losing the job to a faulty motion branch.
      if (!anyMotion) throw e;
      appendLog(jobDir, "ffmpeg.log", `[motion retry] ${label}: ${(e as Error).message}`);
      try {
        await runFfmpeg(buildRun(true), { jobDir, label: `${label} (motion retry)`, timeoutMs: 300000 });
        return expected;
      } catch (e2) {
        appendLog(jobDir, "ffmpeg.log", `[motion fallback to static] ${label}: ${(e2 as Error).message}`);
        await runFfmpeg(buildRun(false), { jobDir, label: `${label} (static)`, timeoutMs: 300000 });
      }
    }
    return expected;
  };

  // Concat helper: try stream-copy first (fast), fall back to re-encode (robust).
  const concatPieces = async (piecePaths: string[], outPath: string, label: string) => {
    const listPath = outPath + ".txt";
    const content = piecePaths.map(p => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`).join("");
    fs.writeFileSync(listPath, content);
    try {
      await runFfmpeg(["-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
        { jobDir, label: label + " (copy)", timeoutMs: 180000 });
    } catch (e) {
      appendLog(jobDir, "ffmpeg.log", `[concat copy failed, retrying with re-encode] ${label}: ${(e as Error).message}`);
      await runFfmpeg(["-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", outPath],
        { jobDir, label: label + " (re-encode)", timeoutMs: 600000 });    }
  };

  // ---- Professional audio pipeline ----
  // Every output chunk gets the exact audio slice matching its video timeline,
  // sliced from one continuous full-length track. No chunk is ever mute and
  // video is never truncated to fit audio (the old mute/second-chunk bug).
  const concatAudios = async (audioPaths: string[], outPath: string): Promise<number> => {
    const listPath = outPath + ".txt";
    fs.writeFileSync(listPath, audioPaths.map(p => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`).join(""));
    await runFfmpeg(["-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:a", "aac", "-b:a", "192k", outPath],
      { jobDir, label: "concat_audios", timeoutMs: 300000 });
    return getMediaDuration(outPath);
  };

  // Build a continuous audio track exactly covering totalDur: trim if longer,
  // loop if shorter (background music fills the whole video, never silence).
  const buildFullAudio = async (combinedPath: string, combinedDur: number, totalDur: number, outPath: string): Promise<void> => {
    if (combinedDur >= totalDur - 0.05) {
      await runFfmpeg(["-y", "-nostdin", "-i", combinedPath,
        "-t", totalDur.toString(), "-c:a", "aac", "-b:a", "192k", outPath],
        { jobDir, label: "trim_audio", timeoutMs: 300000 });
    } else {
      const loops = Math.max(1, Math.ceil(totalDur / Math.max(0.1, combinedDur)));
      await runFfmpeg(["-y", "-nostdin", "-stream_loop", loops.toString(), "-i", combinedPath,
        "-t", totalDur.toString(), "-c:a", "aac", "-b:a", "192k", outPath],
        { jobDir, label: "loop_audio", timeoutMs: 300000 });
    }
  };

  // Extract the audio slice [offset, offset+dur] for one chunk.
  // Stream-copy cut (Phase 2c): no re-encode. +0.5s safety head so the slice
  // always covers its video; mux -shortest then trims AUDIO to video (never
  // the reverse), absorbing copy-cut boundary imprecision (inaudible ms).
  const extractAudioSlice = async (fullAudio: string, offset: number, dur: number, outPath: string): Promise<void> => {
    await runFfmpeg(["-y", "-nostdin", "-ss", Math.max(0, offset).toString(), "-i", fullAudio,
      "-t", (Math.max(0.1, dur) + 0.5).toString(), "-c:a", "copy", outPath],
      { jobDir, label: `audio_slice_${offset.toFixed(1)}`, timeoutMs: 60000 });
  };

  // Mux with explicit stream maps. Video is the timeline master.
  // Fast path (Phase 2c): stream-copy both (slice is already AAC) capped with
  // -shortest — audio is always the longer side by construction (+0.5s head),
  // so only audio is ever trimmed. apad re-encode kept as fallback.
  const muxVideoAudio = async (videoPath: string, audioPath: string | null, outPath: string, label: string): Promise<void> => {
    if (!audioPath) {
      fs.copyFileSync(videoPath, outPath);
      return;
    }
    try {
      await runFfmpeg(["-y", "-nostdin", "-i", videoPath, "-i", audioPath,
        "-map", "0:v:0", "-map", "1:a:0?",
        "-c:v", "copy", "-c:a", "copy", "-shortest", outPath],
        { jobDir, label: label + " (copy)", timeoutMs: 120000 });
    } catch (e) {
      appendLog(jobDir, "ffmpeg.log", `[mux copy failed, retrying with apad re-encode] ${label}: ${(e as Error).message}`);
      await runFfmpeg(["-y", "-nostdin", "-i", videoPath, "-i", audioPath,
        "-map", "0:v:0", "-map", "1:a:0?",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-af", "apad", "-shortest", outPath],
        { jobDir, label: label + " (re-encode)", timeoutMs: 300000 });
    }
  };

  // ---- Transition SFX mixing: ONE pass over the FULL-LENGTH track ----
  // Each cut sound is TRIMMED to its user-selected slice (atrim within the
  // sound file), delayed to be CENTERED on its cut (cut - sliceDur/2) and
  // summed into the music bed with amix(normalize=0) + a limiter guard
  // (summed peaks stay under 1.0; music level is never re-scaled).
  // Mixing the full-length track (not per chunk) means a sound centered near
  // a chunk boundary spills naturally across the slice boundary — no clicks,
  // no per-chunk bookkeeping. Without music, a silent bed carries the SFX.
  // Per-cut volume + window offset are baked before the delay.
  const mixSfxLayer = async (
    basePath: string | null,
    totalDur: number,
    cuts: { at: number; file: string; vol: number; sliceStart: number; sliceDur: number }[],
    outPath: string
  ): Promise<void> => {
    let base = basePath;
    if (!base) {
      base = path.join(jobDir, "sfx_bed.m4a");
      await runFfmpeg(["-y", "-nostdin", "-f", "lavfi", "-i",
        `anullsrc=r=48000:cl=stereo:d=${Math.max(0.2, totalDur).toFixed(3)}`,
        "-c:a", "aac", "-b:a", "128k", base],
        { jobDir, label: "sfx_bed", timeoutMs: 60000 });
    }
    const args: string[] = ["-y", "-nostdin", "-i", base];
    for (const c of cuts) args.push("-i", c.file);
    const vars: string[] = [
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[bed]`,
    ];
    cuts.forEach((c, k) => {
      const dMs = Math.max(0, Math.round((c.at - c.sliceDur / 2) * 1000));
      // Trim first (carve the drag-selected window), then volume, then delay.
      const trim = c.sliceDur > 0 || c.sliceStart > 0
        ? `atrim=start=${c.sliceStart.toFixed(3)}:end=${(c.sliceStart + c.sliceDur).toFixed(3)},asetpts=PTS-STARTPTS,`
        : "";
      vars.push(
        `[${k + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
        trim +
        `volume=${c.vol.toFixed(3)},adelay=${dMs}|${dMs}[s${k}]`);
    });
    const mixInputs = `[bed]` + cuts.map((_c, k) => `[s${k}]`).join("");
    const filter =
      vars.join(";") + ";" +
      `${mixInputs}amix=inputs=${cuts.length + 1}:normalize=0,alimiter=limit=0.96[aout]`;
    await runFfmpeg([
      ...args, "-filter_complex", filter, "-map", "[aout]",
      "-c:a", "aac", "-b:a", "192k", outPath,
    ], { jobDir, label: "mix_sfx", timeoutMs: 300000 });
  };

  try {
    const files = fs.readdirSync(jobDir);
    const rawImages = files
      .filter(f => f.startsWith("raw_"))
      .sort((a, b) => {
        const matchA = a.match(/raw_(\d+)/);
        const matchB = b.match(/raw_(\d+)/);
        const numA = matchA ? parseInt(matchA[1], 10) : 0;
        const numB = matchB ? parseInt(matchB[1], 10) : 0;
        return numA - numB;
      });

    if (rawImages.length === 0) {
      throw new Error("No images found for job");
    }

    // ---- Slide structure (multi-card slides, optional) ----
    // Payload `slides` aligns with `durations`: one entry per timeline unit.
    // Each entry groups raw images: {images:[rawIdx], layout, enter, title}.
    // Strict validation — every raw image covered EXACTLY once, indices in
    // range. Anything off => legacy per-image timeline (byte-identical).
    // Trivial slides (1 image, no title, enter none) keep the still path.
    let slideMode = false;
    let unitSpecs: { spec: SlideSpec; rawPaths: string[]; clipPath: string }[] = [];
    {
      const sArr = Array.isArray(slides) ? slides : [];
      const dArr = Array.isArray(durations) ? durations : [];
      if (sArr.length > 0 && sArr.length === dArr.length) {
        const seen = new Set<number>();
        let ok = true;
        const tmp: typeof unitSpecs = [];
        for (let i = 0; i < sArr.length && ok; i++) {
          const spec = normalizeSlideSpec({ ...(sArr[i] as any), duration: Number(dArr[i]) || 5 });
          if (!spec) { ok = false; break; }
          for (const ri of spec.images) {
            if (ri >= rawImages.length || seen.has(ri)) { ok = false; break; }
            seen.add(ri);
          }
          if (!ok) break;
          tmp.push({
            spec,
            rawPaths: spec.images.map((ri) => path.join(jobDir, rawImages[ri])),
            clipPath: path.join(jobDir, `slide_${i}.mp4`),
          });
        }
        if (ok && seen.size === rawImages.length) {
          slideMode = true;
          unitSpecs = tmp;
        } else {
          appendLog(jobDir, "ffmpeg.log", `[slides] invalid structure; using legacy per-image timeline`);
        }
      }
    }
    // Timeline length in UNITS (slides when structured, images otherwise).
    // Every array below (durations, transitions, motion plan, files) is
    // unit-indexed from here on.
    const unitCount = slideMode ? unitSpecs.length : rawImages.length;

    let finalDurations: number[] = [...durations].map((d: any) => Number(d) || 5);
    while (finalDurations.length < unitCount) {
      finalDurations.push(finalDurations[finalDurations.length - 1] || 5);
    }
    finalDurations = finalDurations.slice(0, unitCount);
    // Honor every script timestamp to the nearest frame WITHOUT accumulating
    // rounding error along the timeline (see quantizeTimelineToFrames).
    finalDurations = quantizeTimelineToFrames(finalDurations);

    // ---- Parse + sanitize transitions ----
    const allowedIn = new Set(["none", "fade", "smoothleft", "smoothright", "slideleft", "slideright", "slideup", "slidedown"]);
    let parsedTransitions: string[] = [];
    if (Array.isArray(transitions)) {
      parsedTransitions = transitions.map((t: any) => {
        const s = String(t || "none");
        return normalizeTransition(allowedIn.has(s) ? s : "none");
      });
    }
    while (parsedTransitions.length < unitCount - 1) parsedTransitions.push("none");
    parsedTransitions = parsedTransitions.slice(0, Math.max(0, unitCount - 1));

    const rawTransDurs = Array.isArray(transitionDurations) ? transitionDurations : [];
    const baseTransDuration = typeof transitionDuration === "number" && transitionDuration > 0 ? transitionDuration : 0.5;
    let safeTransDurations = computeSafeTransDurations(parsedTransitions, rawTransDurs, baseTransDuration, finalDurations);
    // Force "none" where clamping decided the slide is too short
    parsedTransitions = parsedTransitions.map((t, i) => (t !== "none" && safeTransDurations[i] <= 0 ? "none" : t));
    safeTransDurations = safeTransDurations.map((d, i) => (parsedTransitions[i] === "none" ? 0 : d));

    // ---- Camera motion (Ken Burns) plan: TWO PHASES ----
    // Phase 1 (opening, cfg.introSeconds default 60s): randomized Ken Burns
    // across every shot (push/pull/pan/drift pool). Phase 2 (the rest):
    // subtle alternating pan-l/pan-r glide (cfg.tail="pan") or static cuts
    // (cfg.tail="none"). Purely additive when disabled: normalizeMotionConfig
    // off yields [] and every render path below produces byte-identical
    // ffmpeg args to the static pipeline.
    const motionCfg = normalizeMotionConfig(motion);
    // The tail moves but its JOINS still render as hard cuts (speed: no
    // xfade re-encodes across the tail). Gate tail transitions BEFORE the
    // motion plan so curve extensions match the rendered graph.
    const introEnd = introCutoff(finalDurations, { introSeconds: motionCfg.introSeconds });
    if (motionCfg.enabled) {
      // Gate tail transitions BEFORE the motion plan so curve extensions
      // match the rendered graph (tail joins are hard cuts => zero ext).
      // The join between segments is already a hard cut (see below).
      for (let i = introEnd; i < parsedTransitions.length; i++) parsedTransitions[i] = "none";
      safeTransDurations = safeTransDurations.map((d, i) => (parsedTransitions[i] === "none" ? 0 : d));
    }
    // ---- Transition SFX schedule (per-cut, centered on the cut point) ----
    // Client sends resolved per-cut entries { i, sfx, vol, start }. The cut
    // for join i sits at the end of unit i on the frame-quantized timeline —
    // the SAME anchor transitions use. The slice that plays inside the cut is
    // the TRANSITION'S effective duration (safeTransDurations after every
    // clamp + motion gating), carved from the sound at the user's chosen
    // `start` offset — drag-selected in the UI. "none" joins (hard cuts,
    // motion-tail) play the whole sound.
    const sfxSchedule: { at: number; file: string; vol: number; sliceStart: number; sliceDur: number }[] = [];
    if (sfx && typeof sfx === "object" && Array.isArray((sfx as any).cuts)) {
      const cutStartAt: number[] = [];
      {
        let a = 0;
        for (const d of finalDurations) { cutStartAt.push(a); a += d; }
      }
      const byId = new Map(readSfxManifest().map((e) => [e.id, e]));
      const EPS = 0.01;
      for (const c of (sfx as any).cuts) {
        const entry = byId.get(String(c?.sfx || ""));
        if (!entry) continue;
        const file = path.join(SFX_DIR, entry.file);
        if (!fs.existsSync(file)) continue;
        const joinIdx = Math.floor(Number(c?.i ?? -1));
        const at = cutStartAt[joinIdx + 1];
        if (!Number.isFinite(at)) continue;
        const volRaw = Number(c?.vol ?? 1);
        const vol = Number.isFinite(volRaw) ? Math.min(3, Math.max(0.01, volRaw)) : 1;
        const natural = Math.max(0.05, entry.dur || 0.6);
        // Window width = the transition's rendered duration, capped by the
        // sound itself; start clamps inside [0, natural - window].
        const window = safeTransDurations[joinIdx] > 0
          ? Math.min(safeTransDurations[joinIdx], natural)
          : natural;
        const startRaw = Number(c?.start ?? 0);
        const start = Number.isFinite(startRaw)
          ? Math.min(Math.max(0, startRaw), Math.max(0, natural - window))
          : 0;
        sfxSchedule.push({
          at, file, vol,
          sliceStart: start < EPS ? 0 : start,
          sliceDur: window < natural - EPS ? window : natural,
        });
      }
      if (sfxSchedule.length) {
        console.log(`[job ${jobId}] sfx schedule: ${sfxSchedule.length} cut sound(s)`);
        perfMark(jobDir, perfT0, `sfx schedule (${sfxSchedule.length} sounds)`);
      }
    }

    // planMotion owns both phases: intro shots full-pool, tail shots subtle
    // alternating pans (or null when tail="none"). No server-side clamping —
    // the planner is the single source of truth so badges == output.
    const motionPlan: (ShotMotion | null)[] = motionCfg.enabled
      ? planMotion(finalDurations, parsedTransitions, safeTransDurations, motionCfg)
      : [];
    if (motionPlan.length) {
      const moving = motionPlan.filter(Boolean).length;
      const punches = motionPlan.filter((s) => s?.punch).length;
      console.log(`[job ${jobId}] motion plan: style=${motionCfg.style} seed=${motionCfg.seed} moving=${moving}/${motionPlan.length} punches=${punches}`);
      perfMark(jobDir, perfT0, `motion plan style=${motionCfg.style} seed=${motionCfg.seed} moving=${moving} punches=${punches}`);
    }

    const hasActiveTransitions = unitCount > 1 && parsedTransitions.some(t => t !== "none");
    console.log(`[job ${jobId}] units=${unitCount} slideMode=${slideMode} activeTrans=${parsedTransitions.filter(t => t !== "none").length} hasActive=${hasActiveTransitions} mode=${mode}`);

    // ---- Timeline unit inputs ----
    // Legacy: raw uploads feed encodes directly (Phase 2) — canvas scaling
    // runs inline in each encode from the original pixels (identical math,
    // zero intermediate I/O). Slide mode: non-trivial slides pre-render to
    // CFR-30 clips (baked card choreography); trivial slides keep the still
    // path, so untouched jobs render byte-identical output.
    setJobProgress(jobId, 1, "preparing", `Preparing ${unitCount} unit${unitCount === 1 ? "" : "s"}...`);
    for (const img of rawImages) {
      checkCancelled(jobId);
      const f = path.join(jobDir, img);
      if (!fs.existsSync(f)) throw new Error(`Missing image file ${path.basename(f)}`);
    }
    let slideFiles: string[] = rawImages.map((img) => path.join(jobDir, img));
    let unitIsClip: boolean[] = new Array(unitCount).fill(false);
    if (slideMode) {
      // Extended-span mirror of renderXfadeRun's inDurs (same whole-frame
      // halves): clips must cover the consumed span + the 0.5s anti-EOF pad.
      const qD = quantizeTimelineToFrames(finalDurations);
      const qT = safeTransDurations.map((t) => (t > 0 ? toSeconds(Math.max(1, toFrames(t))) : 0));
      const halfDn = (fr: number) => Math.floor(fr / 2);
      const spanOf = (i: number) => qD[i]
        + (i > 0 ? toSeconds(toFrames(qT[i - 1]) - halfDn(toFrames(qT[i - 1]))) : 0)
        + (i < qD.length - 1 ? toSeconds(halfDn(toFrames(qT[i]))) : 0);
      const fontOk = fs.existsSync(SLIDE_FONT_PATH);
      if (!fontOk) appendLog(jobDir, "ffmpeg.log", `[slides] headline font missing; rendering titleless`);
      setJobProgress(jobId, 2, "preparing", `Compositing ${unitSpecs.length} slides...`);
      const built = await mapPool(unitSpecs, SLIDE_PRE_CONCURRENCY, async (u, i) => {
        checkCancelled(jobId);
        const trivial = u.spec.images.length === 1 && !u.spec.title && u.spec.enter === "none";
        if (trivial) return { path: u.rawPaths[0], clip: false };
        try {
          const D = finalDurations[i];
          const totalFrames = Math.max(1, Math.round(((hasActiveTransitions ? spanOf(i) + 0.5 : D)) * SLIDE_FPS));
          const totalLen = totalFrames / SLIDE_FPS;
          const effSpec: SlideSpec = fontOk ? u.spec : { ...u.spec, title: "" };
          const geom = layoutSlide(effSpec);
          const { filter } = buildSlideFilter(effSpec, geom, totalLen);
          const args: string[] = ["-y", "-nostdin"];
          args.push("-f", "lavfi", "-i", `color=c=${SLIDE_BG}:s=${SLIDE_W}x${SLIDE_H}:r=${SLIDE_FPS}:d=${totalLen}`);
          for (const rp of u.rawPaths) args.push("-framerate", "30", "-loop", "1", "-i", rp);
          if (geom.title && effSpec.title) {
            args.push("-f", "lavfi", "-i", `color=c=black:s=${SLIDE_W}x${geom.title.boxH}:r=${SLIDE_FPS}:d=${totalLen}`);
          }
          args.push(
            "-filter_complex", filter, "-map", "[slide]",
            "-r", "30", "-c:v", "libx264", "-preset", SLIDE_PRESET, "-crf", SLIDE_CRF,
            "-pix_fmt", "yuv420p", "-t", String(totalLen), u.clipPath
          );
          await runFfmpeg(args, { jobDir, label: `slide_${i}x${u.spec.images.length}`, timeoutMs: 120000 });
          return { path: u.clipPath, clip: true };
        } catch (e) {
          // One bad slide must never fail the job: fall back to its first
          // image as a still (downstream handles still+motion already).
          appendLog(jobDir, "ffmpeg.log", `[slides] slide ${i} pre-render failed, using still: ${(e as Error).message}`);
          return { path: u.rawPaths[0], clip: false };
        }
      });
      slideFiles = built.map((b) => b.path);
      unitIsClip = built.map((b) => b.clip);
      const nClip = unitIsClip.filter(Boolean).length;
      perfMark(jobDir, perfT0, `slides composited (${nClip}/${unitSpecs.length} clips, rest stills)`);
    }
    setJobProgress(jobId, 2, "preparing", `Preparing ${unitCount} unit${unitCount === 1 ? "" : "s"}...`);
    perfMark(jobDir, perfT0, `prepare done (${unitCount} units, slideMode=${slideMode})`);

    // ---- Audio discovery ----
    const audioFiles = files
      .filter(f => f.startsWith("audio_") || f.startsWith("audio."))
      .sort((a, b) => {
        const matchA = a.match(/audio_(\d+)/);
        const matchB = b.match(/audio_(\d+)/);
        const numA = matchA ? parseInt(matchA[1], 10) : 0;
        const numB = matchB ? parseInt(matchB[1], 10) : 0;
        return numA - numB;
      });
    const audioDurations: number[] = [];
    for (const f of audioFiles) {
      audioDurations.push(await getMediaDuration(path.join(jobDir, f)));
    }
    perfMark(jobDir, perfT0, `audio probe done (${audioFiles.length} tracks)`);

    const job: any = jobs.get(jobId);
    if (job) job.chunks = [];

    if (!hasActiveTransitions) {
      // MODE A: fast concat demuxer. Video is rendered WITHOUT audio first;
      // audio is then sliced from one continuous track per chunk, so no chunk
      // is ever mute and video is never truncated to fit audio.
      setJobProgress(jobId, 16, "planning", `No transitions — using fast concat path (${mode} mode)...`);
      const rawBlocks = slideFiles.map((_, i) => ({ type: "image" as const, imgIndex: i, dur: finalDurations[i] }));
      // Chunk boundaries: single mode = one chunk; chunks mode = per-audio targets (legacy) or 120s.
      const targets: number[] = mode === "single"
        ? [Number.MAX_SAFE_INTEGER]
        : (audioDurations.length > 0 ? [...audioDurations] : []);
      const chunks: any[] = [];
      let currentChunkIdx = 0;
      let currentAudioTarget = targets[currentChunkIdx] ?? 120;
      let currentChunkTime = 0;
      let currentChunkBlocks: any[] = [];
      for (const block of rawBlocks) {
        let remainingDur = block.dur;
        // Camera-curve offset of the current slice WITHIN this image (a block
        // split across chunk boundaries continues its motion curve).
        let blockTOff = 0;
        while (remainingDur > 0.001) {
          checkCancelled(jobId);
          let spaceLeft = currentAudioTarget - currentChunkTime;
          if (spaceLeft <= 0.001) {
            chunks.push({ index: currentChunkIdx, blocks: currentChunkBlocks, dur: currentChunkTime });
            currentChunkIdx++;
            currentAudioTarget = targets[currentChunkIdx] ?? 120;
            currentChunkTime = 0;
            currentChunkBlocks = [];
            spaceLeft = currentAudioTarget;
          }
          const take = Math.min(remainingDur, spaceLeft);
          currentChunkBlocks.push({ type: block.type, imgIndex: block.imgIndex, dur: take, tOff: blockTOff });
          remainingDur -= take;
          currentChunkTime += take;
          blockTOff += take;
        }
      }
      if (currentChunkBlocks.length > 0) {
        chunks.push({ index: currentChunkIdx, blocks: currentChunkBlocks, dur: currentChunkTime });
      }
      // Render video via segment-bounded concat-filter batches (exact by
      // construction), then stream-copy them per chunk. Mid-image split takes
      // ride along as partial durations. Singletons use plain renderHold.
      type BatchJob = { chunkIdx: number; items: { path: string; dur: number; motion?: ShotMotion | null; tOff?: number; clip?: boolean }[]; outPath: string };
      const batchJobs: BatchJob[] = [];
      chunks.forEach((chunk: any, c: number) => {
        let cur: { path: string; dur: number; motion?: ShotMotion | null; tOff?: number; clip?: boolean }[] = [];
        let curSeg = -1;
        const flush = () => {
          if (cur.length === 0) return;
          batchJobs.push({ chunkIdx: c, items: cur, outPath: path.join(jobDir, `abatch_${batchJobs.length}.mp4`) });
          cur = [];
        };
        chunk.blocks.forEach((block: any) => {
          const seg = Math.floor(block.imgIndex / SEGMENT_SIZE);
          if (cur.length > 0 && seg !== curSeg) flush();
          curSeg = seg;
          cur.push({ path: slideFiles[block.imgIndex], dur: block.dur, motion: motionPlan[block.imgIndex] ?? null, tOff: block.tOff || 0, clip: unitIsClip[block.imgIndex] });
        });
        flush();
        chunk.offset = chunks.slice(0, c).reduce((a: number, x: any) => a + x.dur, 0);
      });
      {
        let bDone = 0;
        await mapPool(batchJobs, HOLD_BATCH_CONCURRENCY, async (bj) => {
          checkCancelled(jobId);
          if (bj.items.length === 1) {
            await renderHold(bj.items[0].path, bj.items[0].dur, bj.outPath, `ahold_${bj.chunkIdx}`,
              bj.items[0].motion ? { shot: bj.items[0].motion, tOff: bj.items[0].tOff } : null,
              bj.items[0].clip ?? false);
          } else {
            await renderHoldBatch(bj.items, bj.outPath, `abatch_${bj.chunkIdx}x${bj.items.length}`);
          }
          bDone++;
          setJobProgress(jobId, 15 + Math.round((bDone / batchJobs.length) * 55), "encoding",
            `Encoding ${mode === "single" ? "video" : "holds"} (fast path, batch ${bDone}/${batchJobs.length})...`);
        });
      }
      for (let c = 0; c < chunks.length; c++) {
        checkCancelled(jobId);
        const chunk = chunks[c];
        const parts = batchJobs.filter(b => b.chunkIdx === c).map(b => b.outPath);
        const tmpVideo = path.join(jobDir, `video_tmp_${c}.mp4`);
        if (parts.length === 1) fs.copyFileSync(parts[0], tmpVideo);
        else await concatPieces(parts, tmpVideo, `assembleA_${c}`);
        chunk.tmpVideo = tmpVideo;
      }
      perfMark(jobDir, perfT0, `modeA video encode done (${chunks.length} chunks, ${batchJobs.length} batches)`);
      // Build one continuous audio track covering the whole timeline (loop if short).
      const totalVideoDur = chunks.reduce((a: number, x: any) => a + x.dur, 0);
      let fullAudio: string | null = null;
      if (audioFiles.length > 0) {
        setJobProgress(jobId, 72, "preparing audio", "Combining audio tracks...");
        const combinedPath = path.join(jobDir, "combined_audio.m4a");
        const combinedDur = await concatAudios(audioFiles.map(f => path.join(jobDir, f)), combinedPath);
        const fullPath = path.join(jobDir, "full_audio.m4a");
        setJobProgress(jobId, 76, "preparing audio", combinedDur < totalVideoDur ? "Looping audio to cover full video..." : "Trimming audio to video length...");
        await buildFullAudio(combinedPath, combinedDur, totalVideoDur, fullPath);
        fullAudio = fullPath;
      }
      if (sfxSchedule.length > 0) {
        // SFX rides on the full-length bed (music already looped/trimmed) —
        // one mix pass, chunk slicing and muxing below stay untouched.
        setJobProgress(jobId, 78, "mixing audio", "Mixing transition sound effects...");
        const sfxPath = path.join(jobDir, "full_audio_sfx.m4a");
        await mixSfxLayer(fullAudio, totalVideoDur, sfxSchedule, sfxPath);
        fullAudio = sfxPath;
        perfMark(jobDir, perfT0, `sfx mixed (mode A)`);
      }
      perfMark(jobDir, perfT0, `modeA audio prep done`);
      // Mux each chunk with its exact audio slice (independent files -> parallel).
      {
        const urls: string[] = new Array(chunks.length);
        let muxDone = 0;
        await mapPool(chunks, MUX_CONCURRENCY, async (chunk: any, c: number) => {
          checkCancelled(jobId);
          let slice: string | null = null;
          if (fullAudio) {
            slice = path.join(jobDir, `audio_slice_${c}.m4a`);
            await extractAudioSlice(fullAudio, chunk.offset, chunk.dur, slice);
          }
          const chunkFileName = `chunk_${c.toString().padStart(3, "0")}.mp4`;
          const chunkOutPath = path.join(jobDir, chunkFileName);
          await muxVideoAudio(chunk.tmpVideo, slice, chunkOutPath, `mux_${c}`);
          urls[c] = `/api/video/job/${jobId}/${chunkFileName}`;
          broadcast(jobId, "chunk_ready", { chunkUrl: urls[c] });
          muxDone++;
          setJobProgress(jobId, 80 + Math.round((muxDone / chunks.length) * 18), "muxing audio", `Muxing audio ${mode === "single" ? "" : `${muxDone}/${chunks.length} `}(video is never cut)...`);
        });
        for (const u of urls) if (job) job.chunks.push(u);
      }
      perfMark(jobDir, perfT0, `modeA mux done`);
    } else {
      // MODE B: segmented xfade runs (scales to 300+ images, never hangs)
      const nSeg = Math.max(1, Math.ceil(slideFiles.length / SEGMENT_SIZE));
      setJobProgress(jobId, 16, "planning", `Planning ${nSeg} segment(s) for ${slideFiles.length} images with transitions...`);

      type Run = {
        imgPaths: string[]; durs: number[]; trans: string[]; transDurs: number[];
        outPath: string; estDur: number; segIdx: number; runIdx: number;
        plan?: (ShotMotion | null)[];
        clip?: boolean[];
      };
      // Pieces in timeline order. Consecutive single-image holds in a segment
      // batch into ONE demuxer encode; xfade runs render directly (Phase 2).
      type Piece =
        | { kind: "batch"; outPath: string; estDur: number; segIdx: number; order: number; items: { path: string; dur: number; motion?: ShotMotion | null; tOff?: number; clip?: boolean }[] }
        | { kind: "xrun"; outPath: string; estDur: number; segIdx: number; order: number; run: Run };
      const pieces: Piece[] = [];
      let runCounter = 0;
      for (let s = 0; s < nSeg; s++) {
        const start = s * SEGMENT_SIZE;
        const end = Math.min((s + 1) * SEGMENT_SIZE, slideFiles.length);
        // Split segment at hard cuts ("none") into xfade-able runs.
        let runStart = start;
        let streak: { path: string; dur: number; motion?: ShotMotion | null; tOff?: number; clip?: boolean }[] = [];
        const flushStreak = () => {
          if (streak.length === 0) return;
          pieces.push({
            kind: "batch",
            outPath: path.join(jobDir, `batch_${runCounter++}.mp4`),
            estDur: Number(streak.reduce((a, b) => a + b.dur, 0).toFixed(3)),
            segIdx: s, order: pieces.length, items: streak,
          });
          streak = [];
        };
        for (let i = start; i < end; i++) {
          const boundary = i < end - 1 ? parsedTransitions[i] : null; // transition i->i+1
          const isLastInSeg = i === end - 1;
          if (boundary === null || boundary === "none" || isLastInSeg) {
            // run = images [runStart..i]
            const idxs: number[] = [];
            for (let k = runStart; k <= i; k++) idxs.push(k);
            if (idxs.length === 1) {
              const gi = idxs[0];
              streak.push({ path: slideFiles[gi], dur: finalDurations[gi], motion: motionPlan[gi] ?? null, tOff: 0, clip: unitIsClip[gi] });
            } else {
              flushStreak();
              const t = idxs.slice(0, -1).map(k => parsedTransitions[k]);
              const td = idxs.slice(0, -1).map(k => safeTransDurations[k]);
              const dd = idxs.map(k => finalDurations[k]);
              // Centered transitions preserve the timestamp total exactly.
              const est = Number(dd.reduce((a, b) => a + b, 0).toFixed(3));
              const run: Run = {
                imgPaths: idxs.map(k => slideFiles[k]), durs: dd,
                trans: t, transDurs: td,
                outPath: path.join(jobDir, `run_${runCounter++}.mp4`),
                estDur: est, segIdx: s, runIdx: pieces.length,
                plan: motionPlan.length ? idxs.map(k => motionPlan[k]) : undefined,
                clip: idxs.map(k => unitIsClip[k]),
              };
              pieces.push({ kind: "xrun", outPath: run.outPath, estDur: est, segIdx: s, order: pieces.length, run });
            }
            runStart = i + 1;
          }
        }
        flushStreak();
        // NOTE: transition at index end-1 (between segments) intentionally becomes
        // a hard cut so segments stay independent. Documented limitation for scale.
      }

      // Render pieces with bounded concurrency + per-piece fallback (never fail whole job).
      let done = 0;
      const totalUnits = pieces.length;
      const reportUnit = (piece: Piece) => {
        done++;
        setJobProgress(jobId, 15 + Math.round((done / totalUnits) * 45),
          "rendering transitions", `Rendering transitions ${done}/${totalUnits} (segment ${piece.segIdx + 1}/${nSeg})...`);
      };
      // Light hold batches first, wide parallelism.
      await mapPool(pieces.filter(p => p.kind === "batch"), HOLD_BATCH_CONCURRENCY, async (piece) => {
        checkCancelled(jobId);
        const b = piece as Extract<Piece, { kind: "batch" }>;
        const label = `holdbatch_${b.order}x${b.items.length}`;
        try {
          await renderHoldBatch(b.items, b.outPath, label);
        } catch (e1: any) {
          // Fallback: individual holds concatenated (same pixels, more spawns).
          appendLog(jobDir, "ffmpeg.log", `[batch fallback] ${label}: ${(e1 as Error).message}`);
          const holdPaths: string[] = [];
          for (let h = 0; h < b.items.length; h++) {
            const hp = path.join(jobDir, `batch_${b.order}_fb_${h}.mp4`);
            await renderHold(b.items[h].path, b.items[h].dur, hp, `${label}_fb${h}`,
              b.items[h].motion ? { shot: b.items[h].motion, tOff: b.items[h].tOff } : null,
              b.items[h].clip ?? false);
            holdPaths.push(hp);
          }
          await concatPieces(holdPaths, b.outPath, `${label}_fbConcat`);
        }
        reportUnit(piece);
      });
      // Heavy xfade runs, narrow parallelism.
      const xrunPieces = pieces.filter(p => p.kind === "xrun") as Extract<Piece, { kind: "xrun" }>[];
      for (let i = 0; i < xrunPieces.length; i += RUN_CONCURRENCY) {
        checkCancelled(jobId);
        const batch = xrunPieces.slice(i, i + RUN_CONCURRENCY);
        await Promise.all(batch.map(async (piece) => {
          const run = piece.run;
          const label = `xfade_r${run.runIdx}_${run.trans.join("+")}`;
          try {
            await renderXfadeRun(run.imgPaths, run.durs, run.trans, run.transDurs, run.outPath, label, run.plan, run.clip);
          } catch (e1: any) {
            appendLog(jobDir, "ffmpeg.log", `[retry fade] ${label}: ${(e1 as Error).message}`);
            try {
              // Retry 1: force fade (most compatible transition)
              const fadeDurs = run.transDurs.map(() => 0.5);
              // re-clamp fades to fit (whole frames, same 0.2s..0.5s band)
              const maxAllowed = Math.min(...run.durs) * 0.8;
              const fdFrames = Math.max(Math.min(toFrames(0.5), Math.floor(maxAllowed * RENDER_FPS)), toFrames(0.2));
              const fd = fadeDurs.map(() => toSeconds(fdFrames));
              await renderXfadeRun(run.imgPaths, run.durs, run.trans.map(() => "fade"), fd, run.outPath, label + "_retryFade", run.plan, run.clip);
              run.estDur = Number(run.durs.reduce((a, b) => a + b, 0).toFixed(3));
              piece.estDur = run.estDur;
            } catch (e2: any) {
              // Retry 2: fall back to hard cuts for this run (holds concatenated)
              appendLog(jobDir, "ffmpeg.log", `[fallback cuts] ${label}: ${(e2 as Error).message}`);
              const holdPaths: string[] = [];
              for (let h = 0; h < run.imgPaths.length; h++) {
                const hp = path.join(jobDir, `run_${run.runIdx}_fb_${h}.mp4`);
                await renderHold(run.imgPaths[h], run.durs[h], hp, `${label}_fb${h}`,
                  run.plan?.[h] ? { shot: run.plan[h]!, tOff: 0 } : null,
                  run.clip?.[h] ?? false);
                holdPaths.push(hp);
              }
              await concatPieces(holdPaths, run.outPath, `${label}_fbConcat`);
              run.estDur = Number(run.durs.reduce((a, b) => a + b, 0).toFixed(3));
              piece.estDur = run.estDur;
            }
          }
          reportUnit(piece);
        }));
      }
      perfMark(jobDir, perfT0, `modeB pieces rendered (${pieces.length}: ${pieces.filter(p => p.kind === "batch").length} batches + ${xrunPieces.length} xruns)`);

      // Probe ACTUAL piece durations (estimates drift by ±1 frame per piece —
      // the old timeline-misalignment bug). Chunking uses real numbers.
      setJobProgress(jobId, 60, "measuring", "Measuring rendered segments for exact A/V sync...");
      await mapPool(pieces, PROBE_CONCURRENCY, async (piece) => {
        checkCancelled(jobId);
        const probed = await getMediaDuration(piece.outPath);
        (piece as any).actualDur = probed > 0.05 ? Number(probed.toFixed(3)) : piece.estDur;
      });
      const pieceDur = (p: Piece) => (p as any).actualDur as number;
      const totalVideoDur = Number(pieces.reduce((a, p) => a + pieceDur(p), 0).toFixed(3));
      perfMark(jobDir, perfT0, `modeB probe done (${pieces.length} pieces)`);

      // One continuous audio track for the whole timeline (loop if short).
      let fullAudio: string | null = null;
      if (audioFiles.length > 0) {
        setJobProgress(jobId, 62, "preparing audio", "Combining audio tracks...");
        const combinedPath = path.join(jobDir, "combined_audio.m4a");
        const combinedDur = await concatAudios(audioFiles.map(f => path.join(jobDir, f)), combinedPath);
        const fullPath = path.join(jobDir, "full_audio.m4a");
        setJobProgress(jobId, 64, "preparing audio", combinedDur < totalVideoDur ? "Looping audio to cover full video..." : "Trimming audio to video length...");
        await buildFullAudio(combinedPath, combinedDur, totalVideoDur, fullPath);
        fullAudio = fullPath;
      }
      if (sfxSchedule.length > 0) {
        setJobProgress(jobId, 65, "mixing audio", "Mixing transition sound effects...");
        const sfxPath = path.join(jobDir, "full_audio_sfx.m4a");
        await mixSfxLayer(fullAudio, totalVideoDur, sfxSchedule, sfxPath);
        fullAudio = sfxPath;
        perfMark(jobDir, perfT0, `sfx mixed (mode B)`);
      }
      perfMark(jobDir, perfT0, `modeB audio prep done`);

      // Greedy chunk assignment: whole pieces only, never cut inside a transition.
      // Single mode = everything in one video; chunks mode = per-audio targets.
      type Chunk = { pieces: Piece[]; dur: number; offset: number };
      const chunks: Chunk[] = [];
      if (mode === "single") {
        chunks.push({ pieces: [...pieces], dur: totalVideoDur, offset: 0 });
      } else {
        let curPieces: Piece[] = [];
        let curTime = 0;
        let baseOffset = 0;
        const targetFor = (idx: number) => audioDurations[idx] ?? 120;
        let ci = 0;
        for (const piece of pieces) {
          const target = targetFor(ci);
          if (curPieces.length > 0 && curTime + pieceDur(piece) > target + 0.001) {
            chunks.push({ pieces: curPieces, dur: Number(curTime.toFixed(3)), offset: Number(baseOffset.toFixed(3)) });
            baseOffset += curTime;
            ci++;
            curPieces = [];
            curTime = 0;
          }
          curPieces.push(piece);
          curTime += pieceDur(piece);
        }
        if (curPieces.length > 0) chunks.push({ pieces: curPieces, dur: Number(curTime.toFixed(3)), offset: Number(baseOffset.toFixed(3)) });
      }

      for (let c = 0; c < chunks.length; c++) {
        checkCancelled(jobId);
        const chunk = chunks[c];
        setJobProgress(jobId, 66 + Math.round((c / chunks.length) * 20),
          "assembling", `Assembling ${mode === "single" ? "final video" : `video ${c + 1}/${chunks.length}`}...`);
        const tmpVideo = path.join(jobDir, `assembled_${c}.mp4`);
        await concatPieces(chunk.pieces.map(p => p.outPath), tmpVideo, `assemble_${c}`);
        // Exact audio slice for this chunk's timeline window — every chunk has
        // audio, timelines stay aligned, video is never cut.
        let slice: string | null = null;
        if (fullAudio) {
          slice = path.join(jobDir, `audio_slice_${c}.m4a`);
          await extractAudioSlice(fullAudio, chunk.offset, chunk.dur, slice);
        }
        (chunk as any).tmpVideo = tmpVideo;
        (chunk as any).slice = slice;
      }
      perfMark(jobDir, perfT0, `modeB assemble done (${chunks.length} chunks)`);
      // Mux is per-chunk independent -> parallel, order-preserving.
      {
        const urls: string[] = new Array(chunks.length);
        let muxDone = 0;
        await mapPool(chunks, MUX_CONCURRENCY, async (chunk, c) => {
          checkCancelled(jobId);
          const chunkFileName = `chunk_${c.toString().padStart(3, "0")}.mp4`;
          const chunkOutPath = path.join(jobDir, chunkFileName);
          await muxVideoAudio((chunk as any).tmpVideo, (chunk as any).slice, chunkOutPath, `mux_${c}`);
          urls[c] = `/api/video/job/${jobId}/${chunkFileName}`;
          broadcast(jobId, "chunk_ready", { chunkUrl: urls[c] });
          muxDone++;
          setJobProgress(jobId, 86 + Math.round((muxDone / chunks.length) * 12),
            "muxing audio", `Muxing audio ${mode === "single" ? "" : `${muxDone}/${chunks.length} `}(video is never cut)...`);
        });
        for (const u of urls) if (job) job.chunks.push(u);
      }
      perfMark(jobDir, perfT0, `modeB assemble+mux done (${chunks.length} chunks)`);
    }

    checkCancelled(jobId);
    const j = jobs.get(jobId);
    if (j) {
      j.status = "completed";
      j.progress = 100;
      j.eta = 0;
      j.stage = "done";
      j.detail = "";
      j.lastUpdateTime = Date.now();
      broadcast(jobId, "complete", { chunks: j.chunks });
      perfMark(jobDir, perfT0, `JOB DONE total (${j.chunks.length} outputs)`);
    }
  } catch (error: any) {
    const j: any = jobs.get(jobId);
    if (j) {
      const cancelled = j.cancelled || error.message === "Job cancelled by user";
      j.status = cancelled ? "cancelled" : "error";
      j.error = error.message;
      j.lastUpdateTime = Date.now();
      console.error(`[job ${jobId}] FAILED:`, error.message);
      broadcast(jobId, "error", { error: cancelled ? "Job cancelled by user" : error.message });
      try { perfMark(jobDir, perfT0, `JOB FAILED: ${error.message}`); } catch {}
    } else {
      console.error(`[job ${jobId}] FAILED (no job record):`, error.message);
    }
  }
});

app.get("/api/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job) {
    res.json(job);
  } else {
    res.status(404).json({ error: "Job not found" });
  }
});

app.get("/api/video/job/:jobId/:filename", async (req, res) => {
  const { jobId, filename } = req.params;
  const safeFilename = path.basename(filename);
  const safeJobId = path.basename(jobId);
  const filePath = path.join(UPLOAD_DIR, safeJobId, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head: any = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/mp4",
    };
    if (req.query.download) {
      head["Content-Disposition"] = `attachment; filename="${safeFilename}"`;
    }
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head: any = {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    };
    if (req.query.download) {
      head["Content-Disposition"] = `attachment; filename="${safeFilename}"`;
    }
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Anything under /api that did not match a route above would otherwise fall through to
// Vite's SPA middleware (dev) or the static handler (prod) and return index.html with a
// 200 — which the client then reports as "Proxy or server returned HTML fallback".
// Answer with a real JSON 404 so a missing/misspelled endpoint is obvious.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No API endpoint for ${req.method} ${req.originalUrl}` });
});

// Vite middleware for dev
if (process.env.NODE_ENV !== "production") {
  createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  }).then(vite => {
    app.use(vite.middlewares);
    server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
  });
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  server.listen(PORT, "0.0.0.0", () => console.log(`Production server running on port ${PORT}`));
}
