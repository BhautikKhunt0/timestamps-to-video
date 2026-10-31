import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Upload, AlertCircle, Loader2, X, CheckCircle2,
  Download, Play, Pause, Music, RefreshCw, Clock,
  Sparkles, Scissors, ArrowLeft, ArrowRight, ChevronDown,
  MoveLeft, MoveRight, MoveUp, MoveDown, Volume2, VolumeX
} from "lucide-react";
import { parseTimestamps } from "./utils/parser";
import { planMotion, motionBadge, introCutoff, MOTION_INTRO_SECONDS } from "./utils/motion";
import type { SlideEnter } from "./utils/slides";
import { appendInUploadOrder } from "./utils/imorder";

const TRANSITIONS_CONFIG = [
  { id: "none", name: "Hard Cut", icon: Scissors, color: "text-neutral-400", border: "border-neutral-700/60", bg: "bg-neutral-800" },
  { id: "fade", name: "Cross Fade", icon: Sparkles, color: "text-blue-400", border: "border-blue-500/60", bg: "bg-blue-950/40" },
  { id: "smoothleft", name: "Wipe Left", icon: ArrowLeft, color: "text-cyan-400", border: "border-cyan-500/60", bg: "bg-cyan-950/40" },
  { id: "smoothright", name: "Wipe Right", icon: ArrowRight, color: "text-teal-400", border: "border-teal-500/60", bg: "bg-teal-950/40" },
  { id: "slideleft", name: "Slide Left", icon: MoveLeft, color: "text-indigo-400", border: "border-indigo-500/60", bg: "bg-indigo-950/40" },
  { id: "slideright", name: "Slide Right", icon: MoveRight, color: "text-violet-400", border: "border-violet-500/60", bg: "bg-violet-950/40" },
  { id: "slideup", name: "Slide Up", icon: MoveUp, color: "text-amber-400", border: "border-amber-500/60", bg: "bg-amber-950/40" },
  { id: "slidedown", name: "Slide Down", icon: MoveDown, color: "text-rose-400", border: "border-rose-500/60", bg: "bg-rose-950/40" }
];

const TRANSITION_DESC: Record<string, string> = {
  none: "Frame swaps instantly. Zero frames of blend — the sharpest edit.",
  fade: "Both frames blend through the cut. Soft, cinematic, always safe.",
  smoothleft: "New frame sweeps across from the right behind a soft edge — a wipe.",
  smoothright: "New frame sweeps across from the left behind a soft edge. Mirror of wipe-left.",
  slideleft: "Old frame pushes off to the left while the new slides in — a true push.",
  slideright: "Old frame pushes off to the right while the new slides in. Mirror of slide-left.",
  slideup: "Frames travel upward — the incoming frame rises from below.",
  slidedown: "Frames travel downward — the incoming frame drops from above."
};

const STEPS = [
  { label: "Footage" },
  { label: "Timeline" },
  { label: "Motion" },
  { label: "Editor" }
];

const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, "0");

// A timeline asset is either a still or a live video clip. Browsers
// occasionally hand us an empty MIME type, so the extension is the fallback.
const isVideoFile = (file?: File | null): boolean =>
  !!file && (file.type.startsWith("video/") ||
    /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp|mts?|ts|ogv|f4v|h264|h265|hevc)$/i.test(file.name));

const isImageFile = (file: File): boolean =>
  file.type.startsWith("image/") ||
  /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i.test(file.name);

type MediaMeta = { thumb?: string; dur?: number; vol?: number };

// Pull a poster frame + duration out of a local video before it is uploaded.
// The poster drives every still-only preview surface (cuts, phases, xfade
// preview); the duration is shown on the asset tile so users can see how much
// source footage a slot consumes.
const probeVideoMeta = (file: File): Promise<MediaMeta> => new Promise((resolve) => {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  let meta: MediaMeta = {};
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { v.removeAttribute("src"); v.load(); } catch { /* detached */ }
    URL.revokeObjectURL(url);
    resolve(meta);
  };
  const capture = () => {
    try {
      const vw = v.videoWidth || 640;
      const vh = v.videoHeight || 360;
      const scale = Math.min(1, 480 / Math.max(1, vw));
      const c = document.createElement("canvas");
      c.width = Math.max(2, Math.round(vw * scale));
      c.height = Math.max(2, Math.round(vh * scale));
      const g = c.getContext("2d");
      if (g && vw > 0 && vh > 0) {
        g.drawImage(v, 0, 0, c.width, c.height);
        meta = { ...meta, thumb: c.toDataURL("image/jpeg", 0.8) };
      }
    } catch { /* poster unavailable — tiles fall back to the video element */ }
    finish();
  };
  const timer = setTimeout(finish, 12000);
  v.onloadedmetadata = () => {
    if (Number.isFinite(v.duration) && v.duration > 0) meta = { ...meta, dur: v.duration };
    try {
      v.currentTime = Math.min(1, Math.max(0, (v.duration || 0) * 0.05));
      if (!(v.duration > 0)) capture();
    } catch { capture(); }
  };
  v.onseeked = capture;
  v.onerror = finish;
  v.src = url;
});

const toTimecode = (sec: number) => {
  // Derive from whole frames so the readout always equals the 30fps render
  // grid (rounds to nearest frame; no :29 clamp edge at .999s boundaries).
  const total = Math.max(0, Math.round((sec || 0) * 30));
  const ff = total % 30;
  const totalSec = (total - ff) / 30;
  return `${pad2(totalSec / 3600)}:${pad2((totalSec % 3600) / 60)}:${pad2(totalSec % 60)}:${pad2(ff)}`;
};

const pvClassFor = (id: string) =>
  id === "none" ? "pv-cut"
  : id === "fade" ? "pv-fade"
  : id === "smoothleft" ? "pv-left"
  : id === "smoothright" ? "pv-right"
  : id === "slideleft" ? "pv-slide-l"
  : id === "slideright" ? "pv-slide-r"
  : id === "slideup" ? "pv-slide-u"
  : "pv-slide-d";

const pvLabelFor = (id: string) =>
  id === "none" ? "HARD"
  : id === "fade" ? "DISSOLVE"
  : id === "smoothleft" || id === "smoothright" ? "WIPE"
  : "PUSH";

// Deterministic pseudo-waveform for SFX rack chips (pure visual fingerprint —
// stable per sound id, never re-shuffles between renders).
const waveBarsFor = (id: string): number[] => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rnd = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h ^= h >>> 13;
    return ((h >>> 0) % 1000) / 1000;
  };
  return Array.from({ length: 18 }, (_, i) =>
    0.2 + 0.8 * (0.55 * Math.abs(Math.sin(i * 1.7 + rnd() * 2.4)) + 0.45 * rnd()));
};

// Randomize-cut pool — weighted so fades stay the cinematic default, slides
// add motion variety, and hard cuts still punctuate. One pick per join.
const RANDOM_TRANS_POOL = [
  "fade", "fade", "fade",
  "smoothleft", "smoothright",
  "slideleft", "slideright", "slideup", "slidedown",
  "none",
];

const markerModFor = (t?: string) =>
  t === "none" ? "none"
  : t === "smoothleft" ? "left"
  : t === "smoothright" ? "right"
  : t === "slideleft" ? "sl"
  : t === "slideright" ? "sr"
  : t === "slideup" ? "su"
  : t === "slidedown" ? "sd"
  : "";

const safeParseResponse = async (res: Response): Promise<{ ok: boolean; data: any; error?: string }> => {
  try {
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      if (!res.ok || data?.error) {
        return { ok: false, data: null, error: data?.error || `Server error (${res.status})` };
      }
      return { ok: true, data };
    }
    const text = await res.text();
    if (!res.ok) {
      if (text.toLowerCase().includes("<!doctype html>")) {
        return { ok: false, data: null, error: `Server error (${res.status}). Payload may be too large or connection interrupted.` };
      }
      return { ok: false, data: null, error: `Server returned HTTP ${res.status}: ${text.substring(0, 100)}` };
    }
    if (text.toLowerCase().includes("<!doctype html>")) {
      return { ok: false, data: null, error: "Upload failed: Proxy or server returned HTML fallback. Please retry — large media is uploaded in chunks." };
    }
    return { ok: true, data: text };
  } catch (err: any) {
    const msg = err?.message === "Failed to fetch"
      ? "Network error — the server did not respond. Check that the app is running, then retry."
      : (err.message || "Network or parsing error");
    return { ok: false, data: null, error: msg };
  }
};

const CustomSelect = ({ value, onChange, options, className = "", dropdownUp = false, disabled = false }: any) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedOption = options.find((opt: any) => opt.value === value) || options[0];

  return (
    <div className={`cselect ${className} ${disabled ? "dis" : ""}`} ref={containerRef}>
      <button type="button" className="cselect-btn" disabled={disabled} onClick={() => setIsOpen(!isOpen)}>
        <span className="trunc">{selectedOption?.label}</span>
        <ChevronDown className={`ic ic-14 sel-chev ${isOpen ? "open" : ""}`} />
      </button>

      {isOpen && (
        <div className={`cselect-menu ${dropdownUp ? "up" : ""}`}>
          {options.map((opt: any) => (
            <button
              key={opt.value}
              type="button"
              className={`cselect-opt ${opt.value === value ? "on" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// One composited timeline unit: 1-3 images, one headline, one entrance.
interface SlideItem { imageIndices: number[]; enter: SlideEnter; title: string }

export default function App() {
  const [images, setImages] = useState<File[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [script, setScript] = useState("");
  const [defaultDurationPerImage, setDefaultDurationPerImage] = useState(5);

  const [audioFiles, setAudioFiles] = useState<File[]>([]);

  // Transition States
  const [globalTransition, setGlobalTransition] = useState<string>("none");
  const [categoryDurations, setCategoryDurations] = useState<Record<string, number>>({
    fade: 0.5,
    smoothleft: 0.5,
    smoothright: 0.5,
    slideleft: 0.5,
    slideright: 0.5,
    slideup: 0.5,
    slidedown: 0.5
  });
  const [transitions, setTransitions] = useState<string[]>([]);
  const [showAllCuts, setShowAllCuts] = useState<boolean>(false);

  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState("");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // Auto-dismiss render toasts after 3s — error on failure, done on complete.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 3000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(""), 3000);
    return () => clearTimeout(t);
  }, [successMessage]);

  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [durations, setDurations] = useState<number[]>([]);
  const [progress, setProgress] = useState<number>(0);
  const [eta, setEta] = useState<number | null>(null);
  const [stage, setStage] = useState<string>("");
  const [stageDetail, setStageDetail] = useState<string>("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const [downloadingIndex, setDownloadingIndex] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadingAll, setDownloadingAll] = useState(false);

  // Output mode: "single" = whole output in one video, "chunks" = split per audio track.
  const [outputMode, setOutputMode] = useState<"single" | "chunks">("single");

  // Pro Camera (Ken Burns) motion — one shared planner drives both the server
  // render and these cut-map badges, so preview and output always agree.
  const [motionOn, setMotionOn] = useState(true);
  const [motionStyle, setMotionStyle] = useState<"subtle" | "mixed" | "dynamic">("mixed");
  const [motionSeed, setMotionSeed] = useState(() => Math.floor(Math.random() * 1_000_000_000));
  // Two-phase motion director: phase 1 = full-random Ken Burns on the first
  // `motionIntroSec` seconds; phase 2 = the rest of the timeline — "pan" runs
  // a subtle strictly-alternating pan-l/pan-r glide, "none" keeps static cuts.
  const [motionIntroSec, setMotionIntroSec] = useState(MOTION_INTRO_SECONDS);
  const [motionTail, setMotionTail] = useState<"none" | "pan">("pan");

  // ---- Transition SFX: project-stored library + per-type assignment ----
  // Files live server-side under <project>/sfx/ (upload once, forever).
  // Assignment (transition type -> sound + volume + window offset) persists
  // in localStorage; per-CUT tweaks (volume/mute) are session state,
  // resettable in one click. `start` = seconds into the sound where the
  // slice that plays inside the transition window begins.
  type SfxItem = { id: string; name: string; dur: number; url: string };
  type SfxAssign = { id: string; vol: number; start: number };
  const [sfxLib, setSfxLib] = useState<SfxItem[]>([]);
  const [sfxAssign, setSfxAssign] = useState<Record<string, SfxAssign | null>>(() => {
    // v2 adds `start`; old v1 rows migrate with start=0.
    try {
      const raw = JSON.parse(localStorage.getItem("sfxAssignV2") || localStorage.getItem("sfxAssignV1") || "{}");
      for (const k of Object.keys(raw)) {
        if (raw[k] && typeof raw[k].start !== "number") raw[k].start = 0;
      }
      return raw;
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem("sfxAssignV2", JSON.stringify(sfxAssign)); } catch { /* private mode */ }
  }, [sfxAssign]);
  const [cutSfxOv, setCutSfxOv] = useState<Record<number, { vol?: number; off?: boolean; id?: string }>>({});
  const [sfxPlaying, setSfxPlaying] = useState<string | null>(null);
  const [sfxMsg, setSfxMsg] = useState("");
  const sfxInputRef = useRef<HTMLInputElement>(null);

  // Motion page split into TWO focused pages: "plan" (camera rhythm) and
  // "cuts" (transitions + SFX + per-join map). Pure UI organization —
  // settings live in one state each, nothing is duplicated.
  const [motionTab, setMotionTab] = useState<"plan" | "cuts">("plan");
  // Selected transition type in the library rail (the inspector edits it).
  const [trSel, setTrSel] = useState<string>("fade");

  // WebAudio preview engine: decode each library sound ONCE, then play exact
  // slices [start, start+dur) through a GainNode so preview == render (same
  // window, same volume even above 100%) and there is no latency drift.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sfxBufRef = useRef<Map<string, AudioBuffer>>(new Map());
  const sfxSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const getAudioCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  };
  const stopSlice = () => {
    try { sfxSrcRef.current?.stop(); } catch { /* already stopped */ }
    sfxSrcRef.current = null;
    setSfxPlaying(null);
  };
  const playSlice = async (item: SfxItem, opts?: { start?: number; dur?: number; vol?: number; key?: string }) => {
    // Exactly one preview at a time — re-click stops.
    const key = opts?.key ?? item.id;
    const was = sfxPlaying;
    try {
      let buf = sfxBufRef.current.get(item.id);
      if (!buf) {
        const res = await fetch(item.url);
        const ab = await res.arrayBuffer();
        buf = await getAudioCtx().decodeAudioData(ab);
        sfxBufRef.current.set(item.id, buf);
      }
      stopSlice();
      if (was === key) return; // stop requested
      const ctx = getAudioCtx();
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* stays muted until a gesture */ } }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(2, (opts?.vol ?? 100) / 100));
      src.connect(gain).connect(ctx.destination);
      sfxSrcRef.current = src;
      setSfxPlaying(key);
      src.onended = () => {
        if (sfxSrcRef.current === src) {
          sfxSrcRef.current = null;
          setSfxPlaying(null);
        }
      };
      // Slice [start, start+dur) — the exact window rendered into the video.
      const start = Math.max(0, Math.min(opts?.start ?? 0, Math.max(0, buf.duration - 0.01)));
      const dur = opts?.dur != null ? Math.min(opts.dur, buf.duration - start) : undefined;
      src.start(undefined, start, dur);
    } catch {
      setSfxPlaying(null);
      setSfxMsg("Sound decode failed — re-import this sound");
      window.setTimeout(() => setSfxMsg((m) => (m === "Sound decode failed — re-import this sound" ? "" : m)), 4000);
    }
  };

  useEffect(() => {
    let dead = false;
    fetch("/api/sfx/list").then((r) => r.json()).then((j: any) => {
      if (!dead && Array.isArray(j.sounds)) {
        const lib: SfxItem[] = j.sounds;
        setSfxLib(lib);
        // Self-heal: assignments pointing at sounds that no longer exist
        // would silently no-op in the render — clear them instead.
        const ids = new Set(lib.map((s) => s.id));
        setSfxAssign((prev) => {
          const next: Record<string, SfxAssign | null> = {};
          let changed = false;
          for (const k of Object.keys(prev)) {
            const v = prev[k];
            const fixed = v && !ids.has(v.id) ? null : v;
            next[k] = fixed;
            if (fixed !== v) changed = true;
          }
          return changed ? next : prev;
        });
        setCutSfxOv((prev) => {
          const next: Record<number, { vol?: number; off?: boolean; id?: string }> = {};
          let changed = false;
          for (const k of Object.keys(prev)) {
            const v = prev[Number(k)];
            const fixed = v?.id && !ids.has(v.id) ? { vol: v.vol, off: v.off } : v;
            next[Number(k)] = fixed;
            if (fixed !== v) changed = true;
          }
          return changed ? next : prev;
        });
      }
    }).catch(() => { /* rack stays empty until a server lists sounds */ });
    return () => {
      dead = true;
      try { sfxSrcRef.current?.stop(); } catch { /* already idle */ }
      sfxSrcRef.current = null;
      audioCtxRef.current?.close().catch(() => { /* already closed */ });
    };
  }, []);

  // Slide structure: groups of 1-3 images rendered as ONE composited unit
  // (staggered card entrances + headline). null = legacy auto (1/slide).
  // Layout is always the member count; slide duration is the SUM of member
  // image durations, so script timestamps keep working untouched.
  const [slides, setSlides] = useState<SlideItem[] | null>(null);

  // Badge plan — mirrors the EXACT arrays handleGenerate sends (sized durations
  // + per-join transition durations) so badges match the rendered camera moves.
  const sizedDurs = useMemo(() => {
    let d = durations.length ? [...durations] : [];
    if (d.length === 0) {
      d = new Array(images.length).fill(defaultDurationPerImage);
    } else if (d.length < images.length) {
      const lastDur = d[d.length - 1] || defaultDurationPerImage;
      while (d.length < images.length) d.push(lastDur);
    } else if (d.length > images.length) {
      d = d.slice(0, images.length);
    }
    return d;
  }, [durations, images.length, defaultDurationPerImage]);

  // Slide structure derivation: validated explicit groups, else legacy auto.
  // structActive (anything non-trivial) switches durations / joins / badges /
  // payload to unit level; otherwise every legacy per-image path runs
  // untouched and output is byte-identical to before.
  const autoSlides = useMemo<SlideItem[]>(
    () => images.map((_, i) => ({ imageIndices: [i], enter: "none" as SlideEnter, title: "" })),
    [images]
  );
  const structSlides = useMemo<SlideItem[] | null>(() => {
    if (!slides || images.length === 0) return null;
    const seen = new Set<number>();
    const out: SlideItem[] = [];
    for (const s of slides) {
      const idx = (s.imageIndices || []).filter((v) => Number.isInteger(v) && v >= 0 && v < images.length && !seen.has(v));
      if (idx.length === 0 || idx.length > 3) return null;
      idx.forEach((v) => seen.add(v));
      const enter: SlideEnter = s.enter === "up" || s.enter === "down" || s.enter === "left" || s.enter === "right" || s.enter === "none" ? s.enter : "none";
      const title = typeof s.title === "string" ? s.title.slice(0, 60) : "";
      // A video always plays as its own live unit — slides composite stills.
      if (idx.some((v) => isVideoFile(images[v])) && (idx.length > 1 || !!title || enter !== "none")) return null;
      out.push({ imageIndices: idx, enter, title });
    }
    return seen.size === images.length ? out : null;
  }, [slides, images]);
  const structActive = !!structSlides && structSlides.some((s) => s.imageIndices.length > 1 || s.title !== "" || s.enter !== "none");
  const unitSlides: SlideItem[] = structActive && structSlides ? structSlides : autoSlides;
  // Unit durations: slide sums when structured, per-image otherwise.
  const unitDurs = useMemo(() => {
    if (!structActive || !structSlides) return sizedDurs;
    return structSlides.map((s) => s.imageIndices.reduce((a, j) => a + (sizedDurs[j] ?? defaultDurationPerImage), 0));
  }, [structActive, structSlides, sizedDurs, defaultDurationPerImage]);
  // Unit joins: the image join at each slide boundary when structured.
  const unitTransBase = useMemo(() => {
    if (!structActive || !structSlides) return transitions;
    const out: string[] = [];
    for (let k = 0; k < structSlides.length - 1; k++) {
      const last = structSlides[k].imageIndices[structSlides[k].imageIndices.length - 1];
      out.push(transitions[last] || "none");
    }
    return out;
  }, [structActive, structSlides, transitions]);
  const unitCount = structActive && structSlides ? structSlides.length : images.length;
  // Which timeline units are live video clips (no Ken Burns, no card compose).
  const unitIsVideo = useMemo(
    () => unitSlides.map((s) => s.imageIndices.length === 1 && isVideoFile(images[s.imageIndices[0]])),
    [unitSlides, images]
  );

  // Slide editing ops (merge keeps totals: durations are member sums).
  const slideHasVideo = (indices: number[]) => indices.some((gi) => isVideoFile(images[gi]));
  const mergeSlide = (k: number) => setSlides((prev) => {
    const base = prev ?? autoSlides;
    if (k < 0 || k >= base.length - 1) return prev;
    const a = base[k], b = base[k + 1];
    if (a.imageIndices.length + b.imageIndices.length > 3) return prev;
    // Live clips never get composited into a still slide — they play as-is.
    if (slideHasVideo([...a.imageIndices, ...b.imageIndices])) return prev;
    const next = [...base];
    next.splice(k, 2, { imageIndices: [...a.imageIndices, ...b.imageIndices], enter: a.enter, title: a.title });
    return next;
  });
  const splitSlide = (k: number) => setSlides((prev) => {
    const base = prev ?? autoSlides;
    const s = base[k];
    if (!s || s.imageIndices.length < 2) return prev;
    const next = [...base];
    next.splice(k, 1,
      { imageIndices: [s.imageIndices[0]], enter: s.enter, title: s.title },
      { imageIndices: s.imageIndices.slice(1), enter: "none" as SlideEnter, title: "" });
    return next;
  });
  // Image join -> unit join (-1 = inside a slide, no rendered join).
  const slideJoinAfter = (imgIdx: number): number => {
    if (!structActive || !structSlides) return imgIdx;
    for (let k = 0; k < structSlides.length - 1; k++) {
      const last = structSlides[k].imageIndices[structSlides[k].imageIndices.length - 1];
      if (last === imgIdx) return k;
    }
    return -1;
  };
  const slideBoundaryOf = (joinK: number): number => {
    if (!structActive || !structSlides) return joinK;
    return structSlides[joinK].imageIndices[structSlides[joinK].imageIndices.length - 1];
  };

  // Intro-only motion: when camera motion is on, shots starting in the first
  // MOTION_INTRO_SECONDS keep their transitions — the tail renders as
  // straight cuts on the fast path. The stored `transitions` state is left
  // intact (turning motion off restores it); everything below — badges,
  // payload, markers — reads the effective timeline so preview == output.
  const introEnd = useMemo(
    () => introCutoff(unitDurs, { imageCount: unitCount, introSeconds: motionIntroSec }),
    [unitDurs, unitCount, motionIntroSec]
  );
  const effTransitions = useMemo(
    () => (motionOn ? unitTransBase.map((t, i) => (i < introEnd ? t : "none")) : unitTransBase),
    [unitTransBase, motionOn, introEnd]
  );
  // Visible start time of the first tail shot — the phase-2 boundary the
  // motion UI shows on the coverage bar and phase labels.
  const motionTailStart = useMemo(
    () => unitDurs.slice(0, Math.min(introEnd, unitDurs.length)).reduce((a, d) => a + d, 0),
    [unitDurs, introEnd]
  );
  const effTransDurs = useMemo(
    () => effTransitions.map(t => (t === "none" ? 0 : (categoryDurations[t] || 0.5))),
    [effTransitions, categoryDurations]
  );

  const badgePlan = useMemo(
    () => planMotion(unitDurs, effTransitions, effTransDurs,
      { enabled: motionOn, style: motionStyle, seed: motionSeed, introSeconds: motionIntroSec, tail: motionTail },
      { imageCount: unitCount }),
    [unitDurs, effTransitions, effTransDurs, motionOn, motionStyle, motionSeed, motionIntroSec, motionTail, unitCount]
  );
  // Live video units never receive a Ken Burns move on the server, so the
  // badge map must not claim one either.
  const shownBadgePlan = useMemo(
    () => badgePlan.map((b, i) => (unitIsVideo[i] ? null : b)),
    [badgePlan, unitIsVideo]
  );

  // ── Design-only view state (no business logic) ──────────────────
  const [view, setView] = useState(0);              // 0 Footage · 1 Timeline · 2 Motion · 3 Editor
  const [activeVideo, setActiveVideo] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  // Scrollable viewport height for the imported-media grid (≈15 tiles visible).
  const [mediaGridVh, setMediaGridVh] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const mediaGridRef = useRef<HTMLDivElement>(null);

  const activeEventSourceRef = useRef<WebSocket | null>(null);
  const activePollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const urls = images.map(img => URL.createObjectURL(img));
    setImageUrls(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [images]);

  // Video poster frames + source durations, keyed by the File object (indexes
  // shift when assets are removed; the File identity does not).
  const [mediaMeta, setMediaMeta] = useState<Map<File, MediaMeta>>(new Map());
  const mediaMetaRef = useRef(mediaMeta);
  mediaMetaRef.current = mediaMeta;
  const probingVideosRef = useRef<Set<File>>(new Set());
  useEffect(() => {
    const alive = new Set(images);
    setMediaMeta((prev) => {
      let changed = false;
      const next = new Map<File, MediaMeta>();
      for (const [f, m] of prev) {
        if (alive.has(f)) next.set(f, m);
        else changed = true;
      }
      return changed ? next : prev;
    });
    const missing = images.filter((f) =>
      isVideoFile(f) && !mediaMetaRef.current.has(f) && !probingVideosRef.current.has(f));
    if (missing.length === 0) return;
    let dead = false;
    missing.forEach((f) => probingVideosRef.current.add(f));
    (async () => {
      const queue = [...missing];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const file = queue.shift()!;
          const meta = await probeVideoMeta(file);
          probingVideosRef.current.delete(file);
          if (dead) continue;
          setMediaMeta((prev) => {
            // Merge, never replace: a volume set before probing finished lands
            // in the map first and must survive the probe result.
            const next = new Map(prev);
            next.set(file, { ...meta, vol: prev.get(file)?.vol });
            return next;
          });
        }
      }));
    })();
    return () => {
      dead = true;
      missing.forEach((f) => probingVideosRef.current.delete(f));
    };
  }, [images]);

  const posterFor = (index: number): string | undefined => {
    const file = images[index];
    if (!file) return undefined;
    return isVideoFile(file) ? mediaMeta.get(file)?.thumb : imageUrls[index];
  };
  const sourceDurFor = (index: number): number | undefined => {
    const file = images[index];
    return file && isVideoFile(file) ? mediaMeta.get(file)?.dur : undefined;
  };

  // Per-clip ORIGINAL-audio level in PERCENT (100 = as recorded, 0 = mute,
  // up to 200 to lift quiet sources). Keyed by the File object so it survives
  // reorders and removals exactly like the poster/duration do.
  const clipVolFor = (index: number): number => {
    const file = images[index];
    const v = file ? mediaMeta.get(file)?.vol : undefined;
    return typeof v === "number" ? v : 100;
  };
  const setClipVol = (index: number, pct: number) => {
    const file = images[index];
    if (!file) return;
    const v = Math.min(200, Math.max(0, Math.round(pct)));
    const cur = mediaMeta.get(file);
    setMediaMeta((prev) => {
      const next = new Map(prev);
      next.set(file, { thumb: cur?.thumb, dur: cur?.dur, vol: v });
      return next;
    });
    const el = document.querySelector(`video[data-vid-idx="${index}"]`) as HTMLVideoElement | null;
    if (el && !el.muted) el.volume = Math.min(1, v / 100);
  };

  // Click-to-listen: hover previews must stay muted (browsers refuse audio
  // without a real gesture), so the speaker button is the gesture that unmutes
  // ONE clip at its slider level while you dial it in.
  const [listeningIdx, setListeningIdx] = useState<number | null>(null);
  const stopListening = () => {
    setListeningIdx((cur) => {
      if (cur == null) return cur;
      const el = document.querySelector(`video[data-vid-idx="${cur}"]`) as HTMLVideoElement | null;
      if (el) { el.pause(); el.muted = true; }
      return null;
    });
  };
  const toggleListen = (index: number) => {
    const el = document.querySelector(`video[data-vid-idx="${index}"]`) as HTMLVideoElement | null;
    if (!el) { setListeningIdx(null); return; }
    if (listeningIdx === index) { stopListening(); return; }
    stopListening();
    el.muted = false;
    el.volume = Math.min(1, clipVolFor(index) / 100);
    el.loop = true;
    try { el.currentTime = 0; } catch { /* not seekable yet */ }
    el.play()
      .then(() => setListeningIdx(index))
      .catch(() => { el.muted = true; });
  };
  // Leaving the footage page or changing the asset list ends any listening
  // session (indexes shift on removal, so a stale one must not linger).
  useEffect(() => { stopListening(); }, [images, view]);

  // Cap the imported-media grid to a ~15-tile viewport; everything past it scrolls.
  useEffect(() => {
    const el = mediaGridRef.current;
    if (!el) return;
    const measure = () => {
      const tile = el.querySelector<HTMLElement>(".asset-tile:not(.add)");
      if (!tile) { setMediaGridVh(0); return; }
      const gap = 11;        // .asset-grid gap
      const minTile = 158;   // .asset-grid minmax(...) minimum
      const cols = Math.max(1, Math.floor((el.clientWidth + gap) / (minTile + gap)));
      const rowH = tile.offsetHeight + gap;
      setMediaGridVh(Math.ceil(15 / cols) * rowH - gap); // ≈ 15 tiles visible
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [images.length, view]);

  useEffect(() => {
    return () => {
      if (activeEventSourceRef.current) activeEventSourceRef.current.close();
      if (activePollIntervalRef.current) clearInterval(activePollIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    const parsed = parseTimestamps(script);
    setDurations(parsed);
  }, [script]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArray = (Array.from(e.target.files ?? []) as File[])
        .filter((file) => isImageFile(file) || isVideoFile(file));
      // Pick order = timeline order. Never re-sort by filename: same-named
      // files from different folders would otherwise swap places.
      setImages(prev => appendInUploadOrder(prev, filesArray));
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleAudioChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArray = Array.from(e.target.files);
      setAudioFiles(prev => [...prev, ...filesArray]);
      if (audioInputRef.current) audioInputRef.current.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    if (e.dataTransfer.files) {
      const filesArray = (Array.from(e.dataTransfer.files ?? []) as File[])
        .filter((file: File) => file.type.startsWith('image/') || isVideoFile(file) || isImageFile(file));
      // Drop order is pick order (see handleImageChange).
      setImages(prev => appendInUploadOrder(prev, filesArray));
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
  };

  useEffect(() => {
    const needed = Math.max(0, images.length - 1);
    setTransitions(prev => {
      if (prev.length === needed) return prev;
      if (prev.length < needed) {
        const added = new Array(needed - prev.length).fill("none");
        return [...prev, ...added];
      }
      return prev.slice(0, needed);
    });
  }, [images.length]);

  const handleCategoryDurationChange = (category: string, newDuration: number) => {
    if (category === "none") return;
    if (loading) return;
    setCategoryDurations(prev => ({
      ...prev,
      [category]: newDuration
    }));

    const categoryName = TRANSITIONS_CONFIG.find(c => c.id === category)?.name || category;
    setSuccessMessage(`Updated all ${categoryName} transitions duration to ${newDuration}s.`);
    // The segment editor window width follows this duration — keep every
    // assigned window inside its sound.
    setSfxAssign(prev => {
      const asg = prev[category] ?? null;
      if (!asg) return prev;
      const snd = sfxLib.find(s => s.id === asg.id);
      if (!snd) return prev;
      const maxStart = Math.max(0, snd.dur - newDuration);
      const clamped = Math.min(Math.max(0, asg.start), maxStart);
      return clamped === asg.start ? prev : { ...prev, [category]: { ...asg, start: clamped } };
    });
  };

  const handleApplyToAll = (transType: string) => {
    if (loading) return;
    if (images.length <= 1) return;
    const needed = Math.max(0, images.length - 1);
    const chosenDur = categoryDurations[transType] || 0.5;
    setTransitions(new Array(needed).fill(transType));
    setGlobalTransition(transType);
    const catName = TRANSITIONS_CONFIG.find(t => t.id === transType)?.name || transType;
    setSuccessMessage(`Applied "${catName}" (${transType === "none" ? "Cut" : chosenDur + "s"}) to all ${needed} cuts.`);
  };

  const handleSpecificTransition = (index: number, transType: string) => {
    if (loading) return;
    setTransitions(prev => {
      const updated = [...prev];
      updated[index] = transType;
      return updated;
    });
  };

  const handleResetTransitions = () => {
    if (loading) return;
    const needed = Math.max(0, images.length - 1);
    setTransitions(new Array(needed).fill("none"));
    setGlobalTransition("none");
    setSuccessMessage("Reset all cuts to standard Cuts (None).");
  };

  // 🎲 Randomize cuts: one click gives EVERY join a fresh transition from a
  // weighted pool (fades lead, slides add motion, occasional hard cut).
  // Structured-slide mode only reads boundary joins, so rerolling all of
  // them keeps grouped interiors untouched while regrouping changes which
  // boundary is live — always a coherent shuffle.
  const randomizeTransitions = () => {
    if (loading) return;
    if (transitions.length === 0) return;
    setTransitions(transitions.map(() => RANDOM_TRANS_POOL[Math.floor(Math.random() * RANDOM_TRANS_POOL.length)]));
    stopSlice();
    setSuccessMessage("🎲 Randomized a fresh transition on every cut — fine-tune any single one in the map below.");
  };

  // ---- SFX handlers: preview / import / starter pack / delete / assign ----
  // Chart of the three slice-preview call sites:
  //  · rack chip        → whole sound, 90% volume
  //  · card strip / cut → [start, start+window) at the chosen volume,
  //                       exactly what the render will produce.
  const previewSfx = (sfxId: string, opts?: { start?: number; dur?: number; vol?: number }) => {
    const item = sfxLib.find((s) => s.id === sfxId);
    if (!item) return;
    playSlice(item, { key: sfxId, ...opts });
  };

  const flashSfxMsg = (msg: string) => {
    setSfxMsg(msg);
    window.setTimeout(() => setSfxMsg((m) => (m === msg ? "" : m)), 4500);
  };

  const handleSfxFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list: File[] = e.target.files ? Array.from(e.target.files) : [];
    if (!list.length) return;
    const fd = new FormData();
    for (const f of list) fd.append("sfx", f);
    flashSfxMsg(`Importing ${list.length} sound${list.length === 1 ? "" : "s"}…`);
    try {
      const r = await fetch("/api/sfx/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (Array.isArray(j.sounds)) setSfxLib(j.sounds);
      if (j.failed?.length) flashSfxMsg(`${j.count} imported · ${j.failed.length} failed: ${j.failed[0]}`);
      else if (j.count > 0) flashSfxMsg(`${j.count} sound${j.count === 1 ? "" : "s"} added to the project`);
      else flashSfxMsg("Import failed — no readable audio found");
    } catch {
      flashSfxMsg("Import failed — server unreachable");
    }
    if (sfxInputRef.current) sfxInputRef.current.value = "";
  };

  const handleSeedSfx = async () => {
    flashSfxMsg("Synthesizing starter pack…");
    try {
      const r = await fetch("/api/sfx/seed", { method: "POST" });
      const j = await r.json();
      if (Array.isArray(j.sounds)) setSfxLib(j.sounds);
      flashSfxMsg(j.added > 0 ? `Starter pack: ${j.added} sounds synthesized` : "Starter pack already installed");
    } catch {
      flashSfxMsg("Starter pack failed — server unreachable");
    }
  };

  const deleteSfx = async (id: string) => {
    // Deleting a sound that is previewing or assigned must leave no ghosts.
    const r = await fetch(`/api/sfx/${encodeURIComponent(id)}`, { method: "DELETE" });
    const j = await r.json().catch(() => null);
    if (j?.sounds) {
      setSfxLib(j.sounds);
      if (sfxPlaying === id) { stopSlice(); }
      sfxBufRef.current.delete(id); // stale decoded waveform would mislead
      setSfxAssign((prev) => {
        const next: Record<string, SfxAssign | null> = {};
        for (const k of Object.keys(prev)) next[k] = prev[k]?.id === id ? null : prev[k];
        return next;
      });
      setCutSfxOv((prev) => {
        const next: Record<number, { vol?: number; off?: boolean; id?: string }> = {};
        for (const k of Object.keys(prev)) {
          const v = prev[Number(k)];
          next[Number(k)] = v?.id === id ? { vol: v.vol, off: v.off } : v;
        }
        return next;
      });
    }
  };

  const setSfxForType = (type: string, assign: SfxAssign | null) =>
    setSfxAssign((prev) => ({ ...prev, [type]: assign }));

  const patchCutSfx = (idx: number, patch: { vol?: number; off?: boolean; id?: string }) =>
    setCutSfxOv((prev) => ({ ...prev, [idx]: { ...prev[idx], ...patch } }));

  // What a cut plays (id + window offset + volume) — the single source for
  // both the per-cut preview button and the generate payload, so what you
  // hear is exactly what the render bakes in.
  const cutSfxEff = (idx: number, trans: string): { id: string; start: number; win: number; vol: number } | null => {
    const ov = cutSfxOv[idx];
    if (ov?.off) return null;
    const base = sfxAssign[trans] ?? null;
    const id = ov?.id ?? base?.id ?? null;
    if (!id) return null;
    const snd = sfxLib.find((s) => s.id === id);
    if (!snd) return null;
    if (ov?.id && ov.id !== (base?.id ?? null)) {
      // Per-cut different sound: full sound, default offset (UI keeps the
      // per-cut strip to volume/mute only).
      return { id, start: 0, win: snd.dur, vol: ov.vol ?? base?.vol ?? 100 };
    }
    const win = sfxWindowFor(trans, snd.dur);
    const maxi = Math.max(0, snd.dur - win);
    return {
      id,
      start: Math.min(Math.max(0, base?.start ?? 0), maxi),
      win,
      vol: ov?.vol ?? base?.vol ?? 100,
    };
  };

  // Effective window of a type's sound slice: full sound for hard cuts
  // ("none" has zero transition length), else the transition's seconds.
  const sfxWindowFor = (type: string, sndDur: number): number => {
    const wd = categoryDurations[type] || 0.5;
    return type === "none" ? sndDur : Math.min(wd, sndDur);
  };

  // ---- Segment editors: real waveform of each assigned sound ----
  const sfxWaveRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const drawWaveResolveRef = useRef<Map<string, (() => void)>>(new Map());
  const ensureBuf = async (id: string): Promise<AudioBuffer | null> => {
    const item = sfxLib.find((s) => s.id === id);
    if (!item) return null;
    let buf = sfxBufRef.current.get(id);
    if (buf) return buf;
    try {
      const res = await fetch(item.url);
      const ab = await res.arrayBuffer();
      buf = await getAudioCtx().decodeAudioData(ab);
      sfxBufRef.current.set(id, buf);
      return buf;
    } catch { return null; }
  };
  const drawSfxWave = (typeId: string) => {
    const cv = sfxWaveRefs.current[typeId];
    if (!cv) return;
    // Decode + draw asynchronously; a re-render while pending redraws again.
    const token = typeId + (sfxAssign[typeId]?.id ?? "");
    if (drawWaveResolveRef.current.has(token)) return;
    drawWaveResolveRef.current.set(token, () => {});
    (async () => {
      const buf = await ensureBuf(sfxAssign[typeId]?.id ?? "");
      drawWaveResolveRef.current.delete(token);
      if (!buf || !cv.isConnected) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(80, cv.clientWidth), H = Math.max(26, cv.clientHeight);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      const g = cv.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const asg = sfxAssign[typeId] ?? null;
      if (!asg) return;
      const sndDur = buf.duration;
      const win = sfxWindowFor(typeId, sndDur);
      const maxi = Math.max(0, sndDur - win);
      const st = Math.min(Math.max(0, asg.start), maxi);
      // Background
      g.clearRect(0, 0, W, H);
      g.fillStyle = "#0a0a0d";
      g.fillRect(0, 0, W, H);
      // Center rail
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.beginPath();
      g.moveTo(0, H / 2); g.lineTo(W, H / 2);
      g.stroke();
      // Real peaks: one bar per 2px, min/max of the channel range.
      const ch = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(ch.length / W));
      const barW = 2;
      for (let x = 0; x + barW < W; x += barW + 1) {
        let lo = 0, hi = 0;
        const i0 = Math.floor((x / W) * ch.length);
        for (let k = 0; k < step; k++) {
          const v = ch[Math.min(ch.length - 1, i0 + k)] || 0;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const h = Math.max(1.5, (hi - lo) * (H - 6) * 0.5);
        g.fillStyle = "rgba(255,255,255,0.16)";
        g.fillRect(x, H / 2 - h / 2, barW, h);
      }
      // Used window: green tint + edge ticks; outside dimmed.
      const x0 = (st / sndDur) * W, x1 = ((st + win) / sndDur) * W;
      g.fillStyle = "rgba(0,0,0,0.55)";
      if (x0 > 0) g.fillRect(0, 0, x0, H);
      if (x1 < W) g.fillRect(x1, 0, W - x1, H);
      g.fillStyle = "rgba(52,211,153,0.10)";
      g.fillRect(x0, 0, x1 - x0, H);
      g.fillStyle = "rgba(52,211,153,0.35)";
      g.fillRect(x0, 0, 2, H);
      g.fillRect(x1 - 2, 0, 2, H);
      g.strokeStyle = "rgba(52,211,153,0.8)";
      g.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0 - 1), H - 1);
    })();
  };
  // Redraw all visible editors after every render (cheap; pending decodes
  // re-run once resolved because the resolve-token is freed).
  useEffect(() => {
    for (const typeId of Object.keys(sfxWaveRefs.current)) {
      if (sfxWaveRefs.current[typeId] && sfxAssign[typeId]) drawSfxWave(typeId);
      else delete sfxWaveRefs.current[typeId];
    }
  });
  const handleWaveDrag = (e: React.PointerEvent<HTMLCanvasElement>, typeId: string) => {
    const cv = e.currentTarget;
    const asg = sfxAssign[typeId];
    if (!asg) return;
    const snd = sfxLib.find((s) => s.id === asg.id);
    if (!snd) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = "grabbing";
    const move = (ev: PointerEvent) => {
      const rect = cv.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / Math.max(1, rect.width)));
      const win = sfxWindowFor(typeId, snd.dur);
      const maxi = Math.max(0, snd.dur - win);
      const st = Math.min(maxi, Math.max(0, frac * maxi));
      setSfxForType(typeId, { id: asg.id, vol: asg.vol, start: st });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cv.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- REAL transition preview: your first two images, the actual
  // transition animating between them, with the selected sound slice
  // playing exactly when the render would play it. Loops until stopped.
  const [pvPlaying, setPvPlaying] = useState<string | null>(null);
  const pvRunRef = useRef<{ id: string | null }>({ id: null });
  const pvCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadImageEl = (u: string) =>
    new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("image"));
      im.src = u;
    });
  const stopTransitionPreview = () => {
    pvRunRef.current.id = null;
    setPvPlaying(null);
    stopSlice();
  };
  const startTransitionPreview = async ( typeId: string ) => {
    const pA = posterFor(0);
    const pB = posterFor(1);
    if (!pA || !pB) return;
    stopSlice();
    pvRunRef.current.id = typeId;
    setPvPlaying(typeId);
    let imgA: HTMLImageElement, imgB: HTMLImageElement;
    try {
      [imgA, imgB] = await Promise.all([loadImageEl(pA), loadImageEl(pB)]);
    } catch {
      stopTransitionPreview();
      return;
    }
    if (pvRunRef.current.id !== typeId) return;
    const cv = pvCanvasRef.current;
    if (!cv) { setPvPlaying(null); return; }
    const stage = cv.parentElement!;
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(2, Math.round(r.width * dpr));
    cv.height = Math.max(2, Math.round(r.height * dpr));
    const g = cv.getContext("2d");
    if (!g) { setPvPlaying(null); return; }
    const drawCover = (im: HTMLImageElement, dx: number, dy: number, alpha = 1) => {
      const s = Math.max(cv.width / (im.naturalWidth || 1), cv.height / (im.naturalHeight || 1));
      const w = (im.naturalWidth || 1) * s, h = (im.naturalHeight || 1) * s;
      g.globalAlpha = alpha;
      g.drawImage(im, dx + (cv.width - w) / 2, dy + (cv.height - h) / 2, w, h);
      g.globalAlpha = 1;
    };
    // Frame painters matching the ffmpeg filters' visual families.
    const paint = (p: number) => {
      g.fillStyle = "#07070a";
      g.fillRect(0, 0, cv.width, cv.height);
      const W = cv.width, H = cv.height;
      if (typeId === "none") {
        drawCover(imgA, 0, 0);
        if (p >= 0.5) drawCover(imgB, 0, 0);
      } else if (typeId === "fade") {
        drawCover(imgA, 0, 0);
        drawCover(imgB, 0, 0, p);
      } else if (typeId === "smoothleft" || typeId === "smoothright") {
        drawCover(imgA, 0, 0);
        // Soft-edge wipe: the incoming frame emerges behind the edge band
        // (L→R for wipe-left, mirrored for wipe-right).
        const edge = (0.104 + p * 1.09) - 0.104; // 0 → ~1.09 across the sweep
        const f = 0.06 * W;
        g.save();
        g.beginPath();
        if (typeId === "smoothleft") {
          g.rect(0, 0, edge * W + f / 2, H);
        } else {
          g.rect((1 - edge) * W - f / 2, 0, W, H);
        }
        g.clip();
        drawCover(imgB, 0, 0);
        g.restore();
        // Feathered edge highlight
        const ex = typeId === "smoothleft" ? edge * W : (1 - edge) * W;
        const grad = g.createLinearGradient(ex - f, 0, ex + f, 0);
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.22)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.fillRect(ex - f, 0, f * 2, H);
      } else {
        // slideright / slideleft / slideup / slidedown — true pushes
        const dir =
          typeId === "slideright" ? { x: 1, y: 0 } :
          typeId === "slideup" ? { x: 0, y: -1 } :
          typeId === "slidedown" ? { x: 0, y: 1 } :
          { x: -1, y: 0 };
        drawCover(imgB, dir.x * (1 - p) * W, dir.y * (1 - p) * H);
        drawCover(imgA, dir.x * (-p) * W, dir.y * (-p) * H);
      }
    };
    const secs = categoryDurations[typeId] || 0.5;
    const T = typeId === "none" ? 0.4 : Math.max(0.3, Math.min(2, secs));
    const HOLD = 0.5;
    const cycle = HOLD + T + HOLD;
    let t0: number | null = null;
    let lastCycle = -1;
    const asg = sfxAssign[typeId] ?? null;
    const snd = asg ? sfxLib.find((s) => s.id === asg.id) ?? null : null;
    const frame = (now: number) => {
      if (pvRunRef.current.id !== typeId) return; // stopped
      if (t0 === null) t0 = now;
      const t = (now - t0) / 1000;
      const cyc = Math.floor(t / cycle);
      const tc = t % cycle;
      // Sound fires exactly when the transition starts, each cycle —
      // the slice + volume the render will bake in.
      if (tc >= HOLD && tc < HOLD + T && cyc !== lastCycle && snd) {
        lastCycle = cyc;
        const win = sfxWindowFor(typeId, snd.dur);
        const maxi = Math.max(0, snd.dur - win);
        const st = Math.min(Math.max(0, asg?.start ?? 0), maxi);
        playSlice(snd, { key: snd.id, start: st, dur: win, vol: asg?.vol ?? 100 });
      }
      paint(Math.min(1, Math.max(0, (tc - HOLD) / T)));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  const toggleTransitionPreview = (typeId: string) => {
    if (pvRunRef.current.id === typeId) stopTransitionPreview();
    else startTransitionPreview(typeId);
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
    setTransitions(prev => {
      if (prev.length === 0) return [];
      const transIndexToRemove = index === 0 ? 0 : index - 1;
      return prev.filter((_, i) => i !== transIndexToRemove);
    });
  };

  const stopActiveTracking = () => {
    if (activeEventSourceRef.current) {
      activeEventSourceRef.current.close();
      activeEventSourceRef.current = null;
    }
    if (activePollIntervalRef.current) {
      clearInterval(activePollIntervalRef.current);
      activePollIntervalRef.current = null;
    }
  };

  const uploadBatchChunked = async (jobId: string, files: File[]) => {
    const BATCH_SIZE = 5;
    // 3 MiB keeps every multipart request comfortably under common proxy
    // limits (the cause of "Failed to fetch" on large single-body uploads).
    const CHUNK_SIZE = 3 * 1024 * 1024;
    const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0) || 1;
    const videoCount = files.filter(isVideoFile).length;
    let videoNo = 0;
    let doneBytes = 0;
    const pushProgress = () =>
      setUploadProgress(Math.max(0, Math.min(100, Math.round((doneBytes / totalBytes) * 100))));

    const uploadImageBatch = async (batch: File[], indices: number[]) => {
      let attempt = 0;
      const retries = 3;
      while (attempt < retries) {
        attempt++;
        try {
          const formData = new FormData();
          formData.append("jobId", jobId);
          formData.append("indices", JSON.stringify(indices));
          batch.forEach(f => formData.append("images", f));

          const res = await fetch("/api/upload-batch", { method: "POST", body: formData });
          const parsed = await safeParseResponse(res);
          if (!parsed.ok) {
            throw new Error(parsed.error || `Batch upload failed with status ${res.status}`);
          }
          // Trust nothing: a 200 only means the request completed. Confirm the
          // server actually stored EVERY file in this chunk (it reports
          // per-file failures instead of failing the whole batch).
          const saved = parsed.data?.count;
          if (typeof saved === "number" && saved !== batch.length) {
            const why = Array.isArray(parsed.data?.failed) && parsed.data.failed.length
              ? parsed.data.failed.join("; ")
              : "server reported no detail";
            throw new Error(`Only ${saved}/${batch.length} assets were saved — ${why}`);
          }
          break;
        } catch (err: any) {
          if (attempt === retries) throw err;
          await new Promise(r => setTimeout(r, attempt * 600));
        }
      }
    };

    const uploadVideoChunked = async (file: File, index: number) => {
      if (file.size <= 0) throw new Error(`"${file.name}" is empty — upload a playable video.`);
      const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      const extMatch = /\.([a-z0-9]{1,8})$/i.exec(file.name || "");
      const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : "";
      for (let c = 0; c < totalChunks; c++) {
        const start = c * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const blob = file.slice(start, end);
        let lastErr: any = null;
        // Transport failures throw TypeError("Failed to fetch") — retry the
        // SAME chunk with backoff instead of restarting the whole video.
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            const formData = new FormData();
            formData.append("jobId", jobId);
            formData.append("idx", String(index));
            formData.append("chunkIndex", String(c));
            formData.append("totalChunks", String(totalChunks));
            if (ext) formData.append("ext", ext);
            formData.append("chunk", blob, `${file.name || "video"}.part`);

            const res = await fetch("/api/upload-chunk", { method: "POST", body: formData });
            const parsed = await safeParseResponse(res);
            if (!parsed.ok || parsed.data?.success === false) {
              throw new Error(parsed.error || `Chunk ${c + 1}/${totalChunks} was rejected`);
            }
            lastErr = null;
            break;
          } catch (err: any) {
            lastErr = err;
            if (attempt < 5) await new Promise(r => setTimeout(r, 700 * 2 ** (attempt - 1)));
          }
        }
        if (lastErr) {
          throw new Error(
            `Video "${file.name}" failed to upload (chunk ${c + 1}/${totalChunks}): ${lastErr.message}. ` +
            `The connection was interrupted — press Render again to retry.`
          );
        }
        doneBytes += end - start;
        pushProgress();
      }
    };

    let i = 0;
    while (i < files.length) {
      if (isVideoFile(files[i])) {
        videoNo++;
        setUploadStatusText(videoCount > 1
          ? `Uploading video ${videoNo}/${videoCount} — ${files[i].name}`
          : `Uploading video — ${files[i].name}`);
        await uploadVideoChunked(files[i], i);
        i++;
        continue;
      }
      // Consecutive images still ride one request (small bodies).
      const batch: File[] = [];
      const indices: number[] = [];
      while (i < files.length && batch.length < BATCH_SIZE && !isVideoFile(files[i])) {
        batch.push(files[i]);
        indices.push(i);
        i++;
      }
      setUploadStatusText(batch.length === 1
        ? `Uploading image — ${batch[0].name}`
        : `Uploading ${batch.length} images…`);
      await uploadImageBatch(batch, indices);
      doneBytes += batch.reduce((a, f) => a + (f.size || 0), 0);
      pushProgress();
    }
    setUploadProgress(100);
  };

  const handleGenerate = async () => {
    if (images.length === 0) {
      setError("Please add at least one image or video.");
      return;
    }

    stopActiveTracking();

    // Unit durations mirror badgePlan exactly (slide sums when structured).
    const finalDurations = [...unitDurs];

    setLoading(true);
    setError("");
    setSuccessMessage("");
    setVideoUrls([]);
    setProgress(0);
    setEta(null);
    setStage("");
    setStageDetail("");
    setUploadProgress(0);
    setActiveJobId(null);

    try {
      setUploading(true);
      setUploadStatusText("Initializing backend job...");
      const initRes = await fetch("/api/init-job");
      const initParsed = await safeParseResponse(initRes);

      if (!initParsed.ok) {
        throw new Error(initParsed.error || "Failed to initialize job on the server");
      }

      const jobId = initParsed.data.jobId;
      // Guard against a stale backend (e.g. an old `npm start` build): the
      // chunked video upload route does not exist there, which otherwise
      // fails only after the video's chunks are attempted.
      if (Number(initParsed.data?.serverVersion || 0) < 2) {
        throw new Error("The server is running an older build without video upload support. Stop it and restart `npm run dev` (or rebuild with `npm run build` then `npm start`), then refresh this page.");
      }

      setUploadStatusText("Uploading media...");
      await uploadBatchChunked(jobId, images);

      if (audioFiles.length > 0) {
        for (let i = 0; i < audioFiles.length; i++) {
          setUploadStatusText(`Uploading audio track ${i + 1} of ${audioFiles.length}...`);

          let attempt = 0;
          const retries = 3;
          while (attempt < retries) {
            attempt++;
            try {
              const audioData = new FormData();
              audioData.append("jobId", jobId);
              audioData.append("audio", audioFiles[i]);

              const audioRes = await fetch("/api/upload-audio", { method: "POST", body: audioData });
              const audioParsed = await safeParseResponse(audioRes);
              if (!audioParsed.ok) {
                throw new Error(audioParsed.error || `Failed to upload audio file ${i + 1}`);
              }
              const savedAudio = audioParsed.data?.count;
              if (typeof savedAudio === "number" && savedAudio < 1) {
                throw new Error(`Audio track ${i + 1} was not saved on the server`);
              }
              break;
            } catch (err: any) {
              if (attempt === retries) throw err;
              await new Promise(r => setTimeout(r, attempt * 1000));
            }
          }
        }
      }

      setUploading(false);
      setUploadStatusText("");
      setActiveJobId(jobId);

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      let lastWsMsgAt = Date.now();

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.jobId === jobId) {
            lastWsMsgAt = Date.now();
            if (data.type === "progress") {
              setProgress(data.progress);
              if (data.eta !== undefined) setEta(data.eta);
              if (data.stage !== undefined) setStage(data.stage);
              if (data.detail !== undefined) setStageDetail(data.detail);
            } else if (data.type === "chunk_ready") {
              setVideoUrls(prev => {
                if (!prev.includes(data.chunkUrl)) {
                    return [...prev, data.chunkUrl];
                }
                return prev;
              });
            } else if (data.type === "complete") {
              if (data.chunks) setVideoUrls(data.chunks);
              setProgress(100);
              setEta(0);
              setStage("done");
              setStageDetail("");
              setSuccessMessage("Video segments generated successfully!");
              setLoading(false);
              setActiveJobId(null);
              stopActiveTracking();
              ws.close();
            } else if (data.type === "error") {
              setError("Generation failed: " + (data.error || "Unknown error"));
              setLoading(false);
              setActiveJobId(null);
              stopActiveTracking();
              ws.close();
            }
          }
        } catch (e) {}
      };

      activeEventSourceRef.current = ws as any;

      // Fallback poller: if WS drops/stale (proxy, HMR), poll /api/progress so
      // large 300+ image jobs never look "stuck" with a frozen %.
      if (activePollIntervalRef.current) clearInterval(activePollIntervalRef.current);
      activePollIntervalRef.current = setInterval(async () => {
        // only poll while this job is still loading
        try {
          const r = await fetch(`/api/progress/${jobId}`);
          if (!r.ok) return;
          const j = await r.json();
          if (typeof j.progress === "number") {
            // Don't move the bar backwards; WS is authoritative when fresh.
            const wsStale = Date.now() - lastWsMsgAt > 8000;
            if (wsStale) {
              setProgress(j.progress);
              if (j.eta !== undefined) setEta(j.eta);
              if (j.stage) setStage(j.stage);
              if (j.detail) setStageDetail(j.detail);
            }
          }
          if (j.status === "completed" && j.chunks) {
            setVideoUrls(j.chunks);
            setProgress(100);
            setEta(0);
            setSuccessMessage("Video segments generated successfully!");
            setLoading(false);
            setActiveJobId(null);
            stopActiveTracking();
          } else if (j.status === "error") {
            setError("Generation failed: " + (j.error || "Unknown error"));
            setLoading(false);
            setActiveJobId(null);
            stopActiveTracking();
          }
        } catch {}
      }, 5000);

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          jobId,
          durations: finalDurations,
          transitions: effTransitions,
          transitionDurations: effTransDurs,
          transitionDuration: categoryDurations["fade"] || 0.5,
          motion: { enabled: motionOn, style: motionStyle, seed: motionSeed, introSeconds: motionIntroSec, tail: motionTail },
          // Per-clip original-audio level (percent, unit-indexed). The server
          // keeps each clip's own sound, scaled and placed on the timeline.
          clipVolumes: unitSlides.map((s, k) =>
            unitIsVideo[k] ? clipVolFor(s.imageIndices[0]) : 100),
          // Per-cut SFX: resolved here (inherit type assignment -> cut override)
          // so the server only sees final { join, sound, volume, window } entries.
          sfx: {
            cuts: effTransitions.flatMap((t, i) => {
              const eff = cutSfxEff(i, t);
              if (!eff) return [];
              return [{ i, sfx: eff.id, vol: Math.max(0.01, eff.vol / 100), start: eff.start }];
            }),
          },
          // Slide structure (omitted when legacy: server then runs the
          // byte-identical per-image timeline).
          slides: structActive && structSlides
            ? structSlides.map((s) => ({ images: s.imageIndices, layout: s.imageIndices.length, enter: s.enter, title: s.title }))
            : undefined,
          outputMode
        })
      });

      const genResult = await safeParseResponse(response);
      if (!genResult.ok) {
        stopActiveTracking();
        throw new Error(genResult.error || "Generation request failed on the server.");
      }

    } catch (err: any) {
      setError(err.message || "An error occurred");
      setLoading(false);
      setUploading(false);
      setActiveJobId(null);
      stopActiveTracking();
    }
  };

  const handleCancel = async () => {
    if (!activeJobId) {
      stopActiveTracking();
      setLoading(false);
      setUploading(false);
      return;
    }
    try {
      await fetch(`/api/cancel/${activeJobId}`, { method: "POST" });
    } catch {}
    stopActiveTracking();
    setLoading(false);
    setUploading(false);
    setActiveJobId(null);
    setStage("cancelled");
    setStageDetail("");
  };

  const formatEta = (seconds: number | null) => {
    if (seconds === null || isNaN(seconds) || seconds < 0) return "Calculating ETA...";
    if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
    return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s remaining`;
  };

  const handleDownload = (url: string, index: number) => {
    try {
      setDownloadingIndex(index);
      const link = document.createElement("a");
      link.href = url + "?download=1";
      link.download = `rendered_video_${index + 1}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Download error:', err);
      alert('Failed to download video. You can still right-click the video and save it.');
    } finally {
      setTimeout(() => {
        setDownloadingIndex(null);
        setDownloadProgress(0);
      }, 1000);
    }
  };

  const handleDownloadAll = async () => {
    if (videoUrls.length === 0 || downloadingAll || loading) return;
    setDownloadingAll(true);
    setError("");
    try {
      for (let i = 0; i < videoUrls.length; i++) {
        setDownloadingIndex(i);
        const link = document.createElement("a");
        link.href = videoUrls[i] + "?download=1";
        link.download = `rendered_video_${i + 1}_of_${videoUrls.length}.mp4`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // Stagger downloads so browsers don't block them as popups.
        if (i < videoUrls.length - 1) {
          await new Promise(r => setTimeout(r, 900));
        }
      }
      setSuccessMessage(`Started download of all ${videoUrls.length} chunks. Check your downloads folder.`);
    } catch (err) {
      console.error('Download all error:', err);
      setError("Failed to download all chunks. Try downloading them one by one.");
    } finally {
      setDownloadingAll(false);
      setDownloadingIndex(null);
      setDownloadProgress(0);
    }
  };

  // Display-only mirrors (read-only; handlers and payloads are untouched).
  // Per-slide durations follow the same padding rule used when generating —
  // this only labels thumbnails and the project pill.
  const displayDurations: number[] =
    images.length === 0
      ? []
      : durations.length === 0
        ? new Array(images.length).fill(defaultDurationPerImage)
        : durations.length < images.length
          ? [...durations, ...new Array(images.length - durations.length).fill(durations[durations.length - 1] || defaultDurationPerImage)]
          : durations.slice(0, images.length);

  // The single transition card allowed a professional glow: the most-used one.
  const topTransitionId = (() => {
    let best = "none";
    let bestCount = 0;
    for (const t of TRANSITIONS_CONFIG) {
      const c = transitions.filter(x => x.id === t.id).length;
      if (t.id !== "none" && c > bestCount) { best = t.id; bestCount = c; }
    }
    return bestCount > 0 ? best : "none";
  })();

  /* ── derived display values (design only) ─────────────────────── */
  const totalSeconds = displayDurations.reduce((a, b) => a + b, 0);
  // Motion phase-1 span as a share of the runtime (coverage bar width).
  const motionCoversAll = introEnd >= unitCount && unitCount > 0;
  const motionIntroPct = totalSeconds > 0
    ? Math.max(0, Math.min(100, (motionTailStart / totalSeconds) * 100))
    : 100;
  const totalLabel = `${pad2(totalSeconds / 60)}:${(totalSeconds % 60).toFixed(1).padStart(4, "0")}`;
  const fmtSec = (v: number) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
  const motionPresetLine = !motionOn ? "Off"
    : motionCoversAll ? "Full mix — whole timeline"
    : motionTail === "pan"
      ? `0–${fmtSec(motionTailStart)}s mix · ${fmtSec(motionTailStart)}s → pans`
      : `0–${fmtSec(motionTailStart)}s mix · static tail`;
  // Phase ribbon: one marker per join, positioned by cumulative unit time.
  // Director stat chips: how many shots move in each phase.
  const introMoves = shownBadgePlan.slice(0, Math.min(introEnd, badgePlan.length)).filter(Boolean).length;
  const tailMoves = shownBadgePlan.slice(Math.min(introEnd, badgePlan.length)).filter(Boolean).length;
  const liveTransitions = effTransitions.filter(t => t !== "none").length;
  const cutIndices = effTransitions.length > 0 ? effTransitions.map((_, i) => i) : [];
  const visibleCuts = showAllCuts ? cutIndices : cutIndices.slice(0, 6);
  // Phase ribbon: one marker per join, positioned by cumulative unit time.
  // Color: accent = a live transition rides the cut; dashed-tail = tail cut.
  const ribbonTicks = useMemo(() => {
    const durs = unitDurs.length ? unitDurs : displayDurations;
    let acc = 0;
    return cutIndices.map((idx) => {
      acc += Number(durs[idx]) || 0;
      const trans = effTransitions[idx] || "none";
      return {
        pct: totalSeconds > 0 ? Math.max(0, Math.min(100, (acc / totalSeconds) * 100)) : 0,
        live: trans !== "none",
        tail: motionOn && idx >= introEnd,
        label: `Cut #${idx + 1} · ${trans !== "none" ? `${trans} ${categoryDurations[trans] || 0.5}s` : "hard cut"}`,
      };
    });
  }, [unitDurs, displayDurations, cutIndices, effTransitions, totalSeconds, motionOn, introEnd, categoryDurations]);
  const currentVideoUrl =
    videoUrls.length > 0 ? videoUrls[Math.min(activeVideo, videoUrls.length - 1)] : "";
  const hasVideo = !!currentVideoUrl;

  const stepGo = (i: number) => setView(Math.max(0, Math.min(3, i)));

  const clearAllImages = () => {
    setImages([]);
    setTransitions([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const seekBy = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const dur = isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.max(0, Math.min(dur, v.currentTime + delta));
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  };

  const transitionName = (id: string) => TRANSITIONS_CONFIG.find(t => t.id === id)?.name || id;

  /* ── shared fragments ─────────────────────────────────────────── */
  const stepper = (
    <nav className="stepper" aria-label="Project progress">
      <div className="step-track">
        <div className="step-fill" style={{ width: `${(view / 3) * 100}%` }} />
      </div>
      {STEPS.map((s, i) => (
        <button
          key={s.label}
          type="button"
          className={`step ${i === view ? "active" : i < view ? "done" : ""}`}
          onClick={() => stepGo(i)}
        >
          <span className="step-dot">
            {i < view ? <CheckCircle2 className="ic ic-12" /> : <i>{i + 1}</i>}
            {i === 3 && loading && <span className="step-live" />}
          </span>
          <span className="step-lbl">{s.label}</span>
        </button>
      ))}
    </nav>
  );

  const navButtons = (
    <div className="tb-right">
      {view > 0 && (
        <button type="button" className="btn btn-ghost" onClick={() => stepGo(view - 1)}>
          <ArrowLeft className="ic ic-14" />
          {STEPS[view - 1].label}
        </button>
      )}
      {view < 3 && (
        <button type="button" className="btn btn-accent" onClick={() => stepGo(view + 1)}>
          {view === 0 ? "Continue to Timeline" : view === 1 ? "Continue to Motion" : "Open Editor"}
          <ArrowRight className="ic ic-14" />
        </button>
      )}
    </div>
  );

  /* ═══════════════ VIEW 01 · FOOTAGE ═══════════════ */
  const footageView = (
    <main className="page-body">
      <div className="page-shell">
        <div className="page-hero">
          <span className="eyebrow">Step 01 — Source material</span>
          <h1 className="h-display">Bring in your <em>footage</em></h1>
          <p className="lede">
            Drop frames, video clips and a soundtrack. Images hold for their slot; videos are
            trimmed from the top to the exact timeline length and loop when the slot runs longer.
          </p>
        </div>

        <div className="media-grid">
          <div className="media-main">
            <div
              id="drop-zone"
              className="drop-hero"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <span className="corner tl mono">DROP ZONE</span>
              <span className="corner br mono">JPG · PNG · MP4 · MOV · WEBM</span>
              <div className="orb"><Upload className="ic ic-26" /></div>
              <h3>{images.length > 0 ? "Drop more media" : "Drop images or videos here"}</h3>
              <div className="or">OR</div>
              <div className="drop-actions">
                <button
                  type="button"
                  className="mini-btn accent"
                  onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                >
                  <Upload className="ic ic-12" /> Browse files
                </button>
                {images.length > 0 && (
                  <button type="button" className="mini-btn danger" onClick={(e) => { e.stopPropagation(); clearAllImages(); }}>
                    <X className="ic ic-12" /> Clear all
                  </button>
                )}
              </div>
              <div className="drop-tags">
                <span className="tag">IMAGES + VIDEO</span>
                <span className="tag">AUTO-TRIM TO SLOT</span>
                <span className="tag">SHORT CLIPS LOOP</span>
              </div>
            </div>

            <div className="sec-head">
              <span className="sec-title">Imported <b>{images.length}</b></span>
              <span className="sec-tools">
                <span className="chip">A–Z SORTED</span>
                {images.length > 0 && (
                  <button type="button" className="mini-btn danger" onClick={clearAllImages}>Clear all</button>
                )}
              </span>
            </div>

            {images.length > 0 ? (
              <div
                className="asset-grid"
                ref={mediaGridRef}
                style={mediaGridVh ? { maxHeight: mediaGridVh } : undefined}
              >
                {images.map((file, index) => {
                  const vid = isVideoFile(file);
                  const srcDur = sourceDurFor(index);
                  const slotDur = displayDurations[index] ?? defaultDurationPerImage;
                  const loops = vid && srcDur != null && slotDur > srcDur + 0.05;
                  const trims = vid && srcDur != null && slotDur < srcDur - 0.05;
                  const vol = clipVolFor(index);
                  return (
                  <div key={`${file.name}-${index}`} className="asset-tile">
                    <div className={`tile-thumb t${(index % 7) + 1}`}>
                      {vid ? (
                        <video
                          className="tile-img"
                          data-vid-idx={index}
                          src={imageUrls[index]}
                          poster={posterFor(index)}
                          muted
                          loop
                          playsInline
                          preload={posterFor(index) ? "none" : "metadata"}
                          onMouseEnter={(e) => {
                            if (listeningIdx === index) return;
                            e.currentTarget.play().catch(() => {});
                          }}
                          onMouseLeave={(e) => {
                            if (listeningIdx === index) return;
                            const v = e.currentTarget;
                            v.pause();
                            try { v.currentTime = 0; } catch { /* not seekable yet */ }
                          }}
                        />
                      ) : (
                        <img src={imageUrls[index]} alt={file.name} className="tile-img" />
                      )}
                      <span className="tile-idx">{pad2(index + 1)}</span>
                      {vid && (
                        <span className={`tile-vid ${loops ? "loop" : "trim"}`}>
                          VIDEO{srcDur ? ` · ${srcDur.toFixed(1)}s` : ""}{loops ? " · LOOPS" : trims ? " · TRIM" : ""}
                        </span>
                      )}
                      <button
                        type="button"
                        className="tile-x"
                        onClick={() => removeImage(index)}
                        aria-label={`Remove ${file.name}`}
                      >
                        <X className="ic ic-12" />
                      </button>
                    </div>
                    <div className="tile-bar">
                      <span className="tile-name">{file.name}</span>
                      <span
                        className="tile-dur"
                        title={vid
                          ? srcDur != null
                            ? loops
                              ? `Source ${srcDur.toFixed(2)}s loops to fill this ${slotDur.toFixed(2)}s slot`
                              : `Uses the first ${slotDur.toFixed(2)}s of this ${srcDur.toFixed(2)}s clip`
                            : `Trimmed to the ${slotDur.toFixed(2)}s timeline slot`
                          : `Visible for ${slotDur.toFixed(2)}s`}
                      >
                        {slotDur.toFixed(1)}s
                      </span>
                    </div>
                    {vid && (
                      <div className="tile-vol">
                        <button
                          type="button"
                          className={`vol-btn${listeningIdx === index ? " on" : ""}${vol === 0 ? " mute" : ""}`}
                          onClick={() => toggleListen(index)}
                          title={vol === 0
                            ? "Clip audio muted — raise the level to hear it"
                            : listeningIdx === index
                              ? "Stop listening"
                              : "Play this clip's original sound"}
                          aria-label={`Listen to the original sound of ${file.name}`}
                        >
                          {vol === 0 ? <VolumeX className="ic ic-12" /> : <Volume2 className="ic ic-12" />}
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={200}
                          step={5}
                          value={vol}
                          onChange={(e) => setClipVol(index, Number(e.target.value))}
                          aria-label={`Original audio level for ${file.name}`}
                        />
                        <span className="vol-pct">{vol === 0 ? "MUTE" : `${vol}%`}</span>
                      </div>
                    )}
                  </div>
                  );
                })}
                <button type="button" className="asset-tile add" onClick={() => fileInputRef.current?.click()}>
                  <span><Upload className="ic ic-20" /> ADD MEDIA</span>
                </button>
              </div>
            ) : (
              <div className="empty-note">No media yet — drop images or videos above to start your sequence.</div>
            )}

            <div className="sec-head">
              <span className="sec-title">Soundtrack <b>{audioFiles.length}</b></span>
              <span className="mono muted" style={{ fontSize: "9.5px", letterSpacing: ".14em" }}>
                OPTIONAL · LOOPED TO FILL · CLIPS KEEP THEIR OWN AUDIO
              </span>
            </div>

            <button type="button" className="audio-row" onClick={() => audioInputRef.current?.click()}>
              <span className="au-ic"><Music className="ic" /></span>
              <span className="au-meta">
                <b>{audioFiles.length > 0 ? "Add another track" : "Add soundtrack"}</b>
                <i>MP3 · WAV · M4A</i>
              </span>
              <span className="chip">BROWSE</span>
            </button>

            {audioFiles.length > 0 && (
              <div className="audio-files">
                {audioFiles.map((file, idx) => (
                  <span key={`${file.name}-${idx}`} className="audio-file" title={file.name}>
                    <Music className="ic ic-12" />
                    <span className="af-name">{file.name}</span>
                    <button
                      type="button"
                      className="af-x"
                      onClick={() => setAudioFiles(prev => prev.filter((_, i) => i !== idx))}
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="ic ic-12" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <aside className="media-aside">
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">Session</span>
                <span className="count mono">LIVE</span>
              </div>
              <div className="kv-list">
                <div className="kv"><i>Assets</i><b>{images.length}</b></div>
                <div className="kv"><i>Soundtracks</i><b>{audioFiles.length}</b></div>
                <div className="kv"><i>Est. runtime</i><b className="acc-t">{totalSeconds.toFixed(1)}s</b></div>
                <div className="kv"><i>Output</i><b>1080p30</b></div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="panel-title">Ready check</span></div>
              <div className="checklist">
                <div className={`check ${images.length > 0 ? "ok" : ""}`}>
                  <span className="bullet">{images.length > 0 ? <CheckCircle2 className="ic ic-12" /> : <i />}</span>
                  Files sorted A → Z
                </div>
                <div className={`check ${audioFiles.length > 0 ? "ok" : ""}`}>
                  <span className="bullet">{audioFiles.length > 0 ? <CheckCircle2 className="ic ic-12" /> : <i />}</span>
                  Soundtrack attached
                </div>
                <div className={`check ${durations.length > 0 ? "ok" : ""}`}>
                  <span className="bullet">{durations.length > 0 ? <CheckCircle2 className="ic ic-12" /> : <i />}</span>
                  Timestamps parsed on step 02
                </div>
              </div>
            </div>

            <div className="panel tip-panel">
              <span className="eyebrow">Pro tip</span>
              <p>Name files like <b>01_intro.jpg</b> · <b>02_hook.jpg</b> and the order takes care of itself — forever.</p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );

  /* ═══════════════ VIEW 02 · TIMELINE ═══════════════ */
  const timelineView = (
    <main className="page-body">
      <div className="page-shell">
        <div className="page-hero">
          <span className="eyebrow">Step 02 — Sequence</span>
          <h1 className="h-display">Lay out the <em>timeline</em></h1>
          <p className="lede">
            Every frame gets a place and a duration. Write millisecond timestamps and they map
            one-to-one onto your clips — or fall back to a uniform slide length.
          </p>
        </div>

        <div className="tl-grid">
          <div className="tl-main">
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">Clip sequence</span>
                <span className="count mono">{images.length} CLIPS · A→Z</span>
              </div>

              {images.length > 0 ? (
                <>
                  <div className="seq-strip">
                    {images.map((file, index) => {
                      const vid = isVideoFile(file);
                      const srcDur = sourceDurFor(index);
                      const slotDur = displayDurations[index] ?? defaultDurationPerImage;
                      const fit = srcDur == null ? ""
                        : slotDur > srcDur + 0.05 ? " · LOOPS"
                        : slotDur < srcDur - 0.05 ? " · TRIM" : "";
                      return (
                      <React.Fragment key={`${file.name}-${index}`}>
                        <div className={`clip-card ${index === 0 ? "on" : ""}`}>
                          <div className={`cc-thumb t${(index % 7) + 1}`}>
                            {vid ? (
                              <video
                                className="tile-img"
                                src={imageUrls[index]}
                                poster={posterFor(index)}
                                muted
                                loop
                                playsInline
                                preload={posterFor(index) ? "none" : "metadata"}
                                onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }}
                                onMouseLeave={(e) => {
                                  const v = e.currentTarget;
                                  v.pause();
                                  try { v.currentTime = 0; } catch { /* not seekable yet */ }
                                }}
                              />
                            ) : (
                              <img src={imageUrls[index]} alt={file.name} className="tile-img" />
                            )}
                            <span className="cc-idx">{pad2(index + 1)}</span>
                            {vid && (
                              <span className={`cc-vid ${fit.includes("LOOPS") ? "loop" : fit.includes("TRIM") ? "trim" : ""}`}>
                                VIDEO{srcDur ? ` · ${srcDur.toFixed(1)}s` : ""}{fit}
                              </span>
                            )}
                          </div>
                          <div className="cc-meta">
                            <span className="cc-name">{file.name}</span>
                            <span className="cc-dur">{vid ? "CLIP" : "SLIDE"} <b>{(displayDurations[index] ?? defaultDurationPerImage).toFixed(1)}s</b></span>
                          </div>
                        </div>
                        {index < images.length - 1 && (() => {
                          const sj = slideJoinAfter(index);
                          const mt = sj >= 0 ? (effTransitions[sj] || "none") : "none";
                          const grouped = structActive && sj < 0;
                          return (
                            <div className={`seq-marker ${markerModFor(mt)}`}>
                              <span className="dia" />
                              <span className="m-lab">
                                {grouped
                                  ? "GROUPED"
                                  : mt === "none"
                                    ? "CUT"
                                    : `${categoryDurations[mt] || 0.5}s`}
                              </span>
                            </div>
                          );
                        })()}
                      </React.Fragment>
                      );
                    })}
                    <button type="button" className="clip-add" onClick={() => fileInputRef.current?.click()}>
                      <span><Upload className="ic ic-20" /> ADD CLIP</span>
                    </button>
                  </div>
                  <div className="strip-foot">
                    <span>PICK ORDER = TIMELINE ORDER · FILENAMES NEVER REORDER · DURATIONS COME FROM YOUR SCRIPT</span>
                    <span>Σ {totalSeconds.toFixed(1)}S · {transitions.length} CUTS</span>
                  </div>
                </>
              ) : (
                <div className="empty-note" style={{ marginTop: 12 }}>
                  No media yet — add images or videos on step 01 to build the sequence.
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">Script — timestamps</span>
                <span className="count mono">
                  {durations.length} RANGES · Σ {(durations.reduce((a, b) => a + b, 0)).toFixed(1)}S
                </span>
              </div>
              <textarea
                className="script-ta"
                placeholder={"0:00.000 - 0:03.250 intro\n0:03.250 - 0:05.750 hook\n0:05.750 - 0:08.500 demo …"}
                value={script}
                onChange={(e) => setScript(e.target.value)}
              />
              <div className="strip-foot">
                <span>MILLISECOND PRECISE · ONE RANGE PER CLIP</span>
                <span className={durations.length > 0 ? "ok-t" : ""}>
                  {durations.length > 0 ? "✓ PARSED" : "AWAITING SCRIPT"}
                </span>
              </div>
            </section>
          </div>

          <aside className="tl-aside">
            <div className="panel">
              <div className="panel-head"><span className="panel-title">Timing</span></div>
              <div className="field-row" style={{ marginTop: 10 }}>
                <label>Default per slide</label>
                <span className="chip acc">{defaultDurationPerImage}s</span>
              </div>
              <div className="dur-opts">
                {[2, 3, 4, 5, 8, 10].map(v => (
                  <button
                    key={v}
                    type="button"
                    className={`dur-opt ${defaultDurationPerImage === v ? "on" : ""}`}
                    onClick={() => setDefaultDurationPerImage(v)}
                  >
                    {v}s
                  </button>
                ))}
              </div>
              <p className="panel-note">Used only when no script ranges are present.</p>
              <div style={{ marginTop: 10 }}>
                {durations.length === 0 ? (
                  <div className="empty-note">No timestamps yet — uniform {defaultDurationPerImage}s slides</div>
                ) : (
                  <div className="note">
                    <CheckCircle2 className="ic ic-14" />
                    <span>{durations.length} ranges parsed — timestamps override the default.</span>
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">Runtime</span>
                <span className="count mono">TARGET</span>
              </div>
              <div className="big-total">
                <b>{totalLabel}</b>
                <i>MINUTES : SECONDS</i>
              </div>
              <div className="stat-grid" style={{ marginTop: 10 }}>
                <div className="stat"><i>Clips</i><b>{images.length}</b></div>
                <div className="stat"><i>Ranges</i><b className={durations.length ? "ok-t" : ""}>{durations.length}</b></div>
                <div className="stat"><i>Avg slide</i><b>{images.length ? (totalSeconds / images.length).toFixed(1) : "0.0"}s</b></div>
                <div className="stat"><i>Frames</i><b>{Math.round(totalSeconds * 30)}</b></div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="panel-title">Sequence</span></div>
              <div className="kv-list">
                <div className="kv"><i>Order</i><b>A → Z (auto)</b></div>
                <div className="kv"><i>Script ranges</i><b>{durations.length}</b></div>
                <div className="kv"><i>Transitions</i><b>{transitions.length}</b></div>
                <div className="kv"><i>Fit</i>
                  <b className={durations.length === 0 || durations.length === images.length ? "ok-t" : ""}>
                    {durations.length === 0 ? "UNIFORM" : durations.length === images.length ? "EXACT" : "MISMATCH"}
                  </b>
                </div>
              </div>
              {durations.length > 0 && images.length > 0 && durations.length !== images.length && (
                <div className="note warn" style={{ marginTop: 10 }}>
                  <AlertCircle className="ic ic-14" />
                  <span>{images.length} images vs {durations.length} timestamps</span>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );

  /* ═══════════════ VIEW 03 · MOTION ═══════════════ */
  const motionView = (
    <main className="page-body">
      <div className="page-shell motion-shell">
        <div className="page-hero">
          <span className="eyebrow">Step 03 — Motion</span>
          <h1 className="h-display">Direct every <em>cut</em></h1>
          <p className="lede">
            Two focused pages, one timeline. The <b>camera plan</b> drives the opening mix and the
            tail glide; <b>cuts &amp; sound</b> assigns a transition + sound to every join — by hand
            or with one lucky reroll. Your runtime never changes.
          </p>
          {unitCount > 0 && (
            <div className="hero-meta mono">
              <span className="hm-dot" />
              <span>{unitCount} SHOT{unitCount === 1 ? "" : "S"}</span>
              <span className="hm-sep">/</span>
              <span>{fmtSec(totalSeconds)}S</span>
              <span className="hm-sep">/</span>
              <span>OPENING {motionCoversAll ? "FULL" : `${fmtSec(motionTailStart)}S`}</span>
              <span className="hm-sep">/</span>
              <span>TAIL {motionOn ? (motionTail === "pan" ? "PANS" : "STATIC") : "OFF"}</span>
            </div>
          )}
        </div>

        {/* ─── Two-page switcher: camera plan ↔ cuts & sound ─── */}
        <div className="m-tabbar">
          <button
            type="button"
            className={`m-tab ${motionTab === "plan" ? "on" : ""}`}
            onClick={() => { if (motionTab !== "plan") { stopTransitionPreview(); setMotionTab("plan"); } }}
          >
            <Sparkles className="m-tab-ic" />
            <span className="mt-txt">
              <b>Camera plan</b>
              <i>motion director · phases · ribbon</i>
            </span>
            <span className="mt-count mono">{motionOn ? (motionCoversAll ? "FULL MIX" : `OPEN ${fmtSec(motionTailStart)}S`) : "CAMERA OFF"}</span>
          </button>
          <button
            type="button"
            className={`m-tab ${motionTab === "cuts" ? "on" : ""}`}
            onClick={() => { if (motionTab !== "cuts") { stopTransitionPreview(); setMotionTab("cuts"); } }}
          >
            <Music className="m-tab-ic" />
            <span className="mt-txt">
              <b>Cuts &amp; sound</b>
              <i>transitions · sfx · per-join map</i>
            </span>
            <span className="mt-count mono">{liveTransitions}/{Math.max(0, unitCount - 1)} LIVE · {sfxLib.length} SFX</span>
          </button>
        </div>

        <div className={`motion-grid mode-${motionTab}`}>
          <div className="motion-main">

            {motionTab === "plan" ? (<>
            {/* ═══ MOTION DIRECTOR — the two phases, live ═══ */}
            <section className="panel director">
              <div className="dir-head">
                <div className="dir-head-l">
                  <span className="eyebrow">Pro camera · Ken Burns</span>
                  <h2 className="dir-title"><span className="sec-no mono">01</span>Direct the motion</h2>
                </div>
                <button
                  type="button"
                  className={`power ${motionOn ? "on" : ""}`}
                  disabled={loading}
                  onClick={() => setMotionOn(v => !v)}
                  aria-pressed={motionOn}
                  title={motionOn ? "Turn the camera off — static frames, fastest render" : "Turn the camera on — Ken Burns mix"}
                >
                  <span className="power-track"><span className="power-knob" /></span>
                  <span className="power-label mono">{motionOn ? "CAMERA ON" : "CAMERA OFF"}</span>
                </button>
              </div>

              {/* ── CONTROL DECK: every director setting in one strip ── */}
              <div className="dir-deck">
                <div className="deck-cell">
                  <span className="deck-no mono">A</span>
                  <span className="deck-label">Style</span>
                  <CustomSelect
                    value={motionStyle}
                    onChange={(val: any) => setMotionStyle(val)}
                    options={[
                      { value: "subtle", label: "Subtle" },
                      { value: "mixed", label: "Mixed" },
                      { value: "dynamic", label: "Dynamic" },
                    ]}
                    className="w-32"
                  />
                  <span className="deck-hint">
                    {motionStyle === "subtle" ? "6–9% breath per shot" : motionStyle === "dynamic" ? "11–18% breath per shot" : "8–15% breath per shot"}
                  </span>
                </div>
                <div className="deck-cell">
                  <span className="deck-no mono">B</span>
                  <span className="deck-label">Opening runs for</span>
                  <CustomSelect
                    value={motionIntroSec}
                    onChange={(val: any) => setMotionIntroSec(Number(val))}
                    options={[
                      { value: 15, label: "15 seconds" },
                      { value: 30, label: "30 seconds" },
                      { value: 60, label: "60 seconds" },
                      { value: 90, label: "90 seconds" },
                      { value: 120, label: "2 minutes" },
                      { value: 180, label: "3 minutes" },
                      { value: 999999, label: "Whole video" },
                    ]}
                    className="w-32"
                    dropdownUp
                  />
                  <span className="deck-hint">
                    {motionCoversAll ? "the mix covers the whole timeline" : `hands over to the tail at ${fmtSec(motionTailStart)}s`}
                  </span>
                </div>
                <div className="deck-cell">
                  <span className="deck-no mono">C</span>
                  <span className="deck-label">Move seed</span>
                  <div className="deck-seed">
                    <span className="deck-seed-n mono">#{motionSeed}</span>
                    <button
                      type="button"
                      className="mini-btn"
                      disabled={loading}
                      onClick={() => setMotionSeed(Math.floor(Math.random() * 1_000_000_000))}
                      title="Roll a new seed — a fresh set of moves"
                    >⟳ Remix</button>
                  </div>
                  <span className="deck-hint">same seed = the same exact moves</span>
                </div>
                <div className="deck-cell">
                  <span className="deck-no mono">D</span>
                  <span className="deck-label">After the opening</span>
                  <div className="ph-modes deck-modes">
                    <button
                      type="button"
                      className={`mode ${motionOn && motionTail === "pan" ? "on" : ""}`}
                      disabled={loading || !motionOn}
                      onClick={() => { if (!loading) setMotionTail("pan"); }}
                    >
                      <MoveLeft className="ic ic-14" /><b>Subtle pans</b><MoveRight className="ic ic-14" />
                    </button>
                    <button
                      type="button"
                      className={`mode ${motionOn && motionTail === "none" ? "on" : ""}`}
                      disabled={loading || !motionOn}
                      onClick={() => { if (!loading) setMotionTail("none"); }}
                    >
                      <Scissors className="ic ic-14" /><b>Static cuts</b>
                    </button>
                  </div>
                  <span className="deck-hint">
                    {motionTail === "pan" ? "calm alternating glides · joins cut hard" : "straight cuts · fastest path"}
                  </span>
                </div>
              </div>

              <div className="dir-stats">
                {unitCount > 0 ? (
                  <>
                    <span className="stat-chip"><b>{unitCount}</b> SHOTS</span>
                    <span className="stat-chip"><b>{fmtSec(totalSeconds)}s</b> RUNTIME</span>
                    <span className="stat-chip acc"><b>{introMoves}</b> OPENING MOVES</span>
                    <span className="stat-chip acc">
                      {motionOn
                        ? motionCoversAll
                          ? "MIX COVERS ALL"
                          : motionTail === "pan" ? <><b>{tailMoves}</b> TAIL PANS</> : "STATIC TAIL"
                        : "MOTION OFF"}
                    </span>
                  </>
                ) : (
                  <span className="stat-chip">UPLOAD IMAGES TO DIRECT THE CAMERA</span>
                )}
              </div>
            </section>

            {/* ═══ LIVE PHASES — real previews of the opening & rest camera ═══ */}
            <section className="panel phases">
              <div className="panel-head">
                <span className="panel-title"><span className="sec-no mono">02</span>Live phases</span>
                <span className="count mono">OPENING → REST · PLAYING ON IMAGE 1</span>
              </div>

              <div className="dir-grid">
                {/* ── PHASE 1 · OPENING ── */}
                <div className={`ph-card ${motionOn ? "on" : "off"}`}>
                  <div className="ph-head">
                    <span className="ph-num mono">01</span>
                    <span className="ph-tag">OPENING</span>
                    <span className="ph-range">
                      {motionOn ? (motionCoversAll ? "0s → END" : `0s → ${fmtSec(motionTailStart)}s`) : "—"}
                    </span>
                  </div>

                  <div
                    className="ph-stage ph-anim-zoom"
                    style={{ "--ph-z1": motionStyle === "subtle" ? 1.07 : motionStyle === "dynamic" ? 1.2 : 1.14 } as React.CSSProperties}
                  >
                    {posterFor(0) && <img src={posterFor(0)} alt="" />}
                    {motionOn && <span className="ph-live"><span className="pulse" />LIVE</span>}
                    <span className="ph-stage-cap mono">
                      {motionStyle === "subtle" ? "6–9% BREATH" : motionStyle === "dynamic" ? "11–18% BREATH" : "8–15% BREATH"}
                    </span>
                  </div>

                  <div className="ph-title">
                    <b>Opening mix</b>
                    <i>a seeded move on every shot</i>
                  </div>

                  <div className="ph-pool">
                    <span>PUSH</span><span>PULL</span><span>PAN ←</span><span>PAN →</span><span>DRIFT</span>
                  </div>
                </div>

                {/* ── PHASE 2 · THE REST ── */}
                <div className={`ph-card ${motionOn ? "on" : "off"}`}>
                  <div className="ph-head">
                    <span className="ph-num mono">02</span>
                    <span className="ph-tag">THE REST</span>
                    <span className="ph-range">
                      {motionOn ? (motionCoversAll ? "COVERED BY 01" : `${fmtSec(motionTailStart)}s → END`) : "—"}
                    </span>
                  </div>

                  <div className={`ph-stage ${motionTail === "pan" ? "ph-anim-pan" : "ph-anim-none"}`}>
                    {posterFor(0) && <img src={posterFor(0)} alt="" />}
                    {motionOn && <span className="ph-live"><span className="pulse" />LIVE</span>}
                    <span className="ph-stage-cap mono">
                      {motionTail === "pan" ? "ALT PANS · ~0.55PX/FRAME" : "STATIC FRAMES"}
                    </span>
                  </div>

                  <div className="ph-title">
                    <b>The rest</b>
                    <i>{motionTail === "pan" ? "left / right glide, alternating" : "straight cuts, full speed"}</i>
                  </div>

                  <div className="ph-pool">
                    {motionTail === "pan" ? (
                      <>
                        <span>GLIDE ←</span><span>GLIDE →</span><span>ALT SHOT</span><span>HARD JOINS</span>
                      </>
                    ) : (
                      <>
                        <span>STATIC</span><span>FULL SPEED</span><span>HARD JOINS</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* ═══ PHASE RIBBON — the whole timeline's rhythm map ═══ */}
            {unitCount > 0 && (
              <section className="panel ribbon-panel">
                <div className="panel-head">
                  <span className="panel-title"><span className="sec-no mono">03</span>Phase ribbon</span>
                  <span className="count mono">
                    {cutIndices.length} CUTS · {ribbonTicks.filter(t => t.live).length} TRANSITIONS
                  </span>
                </div>
                <div className="ribbon">
                  <div className="ribbon-ticks">
                    {ribbonTicks.map((t, i) => (
                      <span
                        key={i}
                        className={`ribbon-tick ${t.live ? "live" : ""} ${t.tail ? "tail" : ""}`}
                        style={{ left: `${t.pct}%` }}
                        title={t.label}
                      />
                    ))}
                    {motionOn && !motionCoversAll && (
                      <span
                        className="ribbon-cursor"
                        style={{ left: `${motionIntroPct}%` }}
                        title={`Phase 1 hands over at ${fmtSec(motionTailStart)}s`}
                      />
                    )}
                  </div>
                  <div className="ribbon-track">
                    {motionOn ? (
                      <>
                        <span className="seg-open" style={{ width: `${motionIntroPct}%` }} />
                        <span className={`seg-tail ${motionTail === "pan" ? "pans" : "flat"}`} style={{ width: `${100 - motionIntroPct}%` }} />
                      </>
                    ) : (
                      <span className="seg-open muted" style={{ width: "100%" }} />
                    )}
                  </div>
                  <div className="ribbon-lab mono">
                    <span>0s</span>
                    <span>
                      {motionOn
                        ? motionCoversAll
                          ? "FULL MIX — WHOLE TIMELINE"
                          : motionTail === "pan"
                            ? `PANS GLIDE ${fmtSec(motionTailStart)}s ONWARD`
                            : `STRAIGHT CUTS ${fmtSec(motionTailStart)}s ONWARD`
                        : "CAMERA STATIC — HARD CUTS ONLY"}
                    </span>
                    <span>{fmtSec(totalSeconds)}s</span>
                  </div>
                </div>
              </section>
            )}
            </>) : null}

            {motionTab === "cuts" ? (<>
            {/* ═══ CUTS & SOUND · beat console: randomize + counts ═══ */}
            <section className="panel cut-console">
              <div className="console-l">
                <span className="eyebrow">Beat console</span>
                <h3 className="console-title">Cut every join your way</h3>
                <p className="console-note">
                  Per-cut transitions land centered on each boundary. Assign by hand below,
                  or roll the dice and refine whatever chance gives you.
                </p>
              </div>
              <button
                type="button"
                className="rnd-btn"
                disabled={loading || transitions.length === 0}
                onClick={randomizeTransitions}
                title="Give every cut a random transition — fades lead, slides spice, occasional hard cut keeps the pace"
              >
                <span className="rnd-face" aria-hidden>🎲</span>
                <span className="rnd-txt">
                  <b>Randomize all cuts</b>
                  <i>a fresh rhythm on every join · refine after</i>
                </span>
              </button>
              <div className="console-meta mono">
                <span className="cm-chip">{transitions.length} JOINS</span>
                <span className="cm-chip accent">{liveTransitions} LIVE</span>
                <span className="cm-chip">{sfxLib.length} SFX IN RACK</span>
              </div>
            </section>

            <section className="panel sfx-rack">
              <div className="panel-head">
                <span className="panel-title"><span className="sec-no mono">01</span>Sound rack · sfx</span>
                <span className="count mono">{sfxLib.length} SOUND{sfxLib.length === 1 ? "" : "S"} · STORED IN PROJECT</span>
                <span className="head-actions">
                  <button type="button" className="mini-btn" onClick={() => sfxInputRef.current?.click()} title="Import sounds once — they stay in the project for every future video">+ Import sounds</button>
                  <button type="button" className="mini-btn" onClick={handleSeedSfx} title="Synthesize a palette of 7 starter sounds">⚡ Starter pack</button>
                </span>
              </div>
              {sfxMsg && <div className="sfx-msg mono">{sfxMsg}</div>}
              {sfxLib.length > 0 ? (
                <div className="rack-row">
                  {sfxLib.map((s) => (
                    <div key={s.id} className={`rack-chip ${sfxPlaying === s.id ? "playing" : ""}`}>
                      <button type="button" className="rack-play" onClick={() => previewSfx(s.id)} title={sfxPlaying === s.id ? "Stop" : "Preview"}>
                        {sfxPlaying === s.id ? "■" : "▶"}
                      </button>
                      <div className="rack-meta">
                        <b>{s.name}</b>
                        <span className="rack-wave" aria-hidden>
                          {waveBarsFor(s.id).map((h, i) => (
                            <i key={i} style={{ height: `${Math.round(h * 100)}%` }} />
                          ))}
                        </span>
                      </div>
                      <span className="rack-dur mono">{s.dur.toFixed(2)}s</span>
                      <button type="button" className="rack-x" onClick={() => deleteSfx(s.id)} title="Remove from library">✕</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rack-empty">
                  <span>No sounds yet — import your whooshes once and they stay in the project forever, ready for every render.</span>
                </div>
              )}
              <input ref={sfxInputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" multiple hidden onChange={handleSfxFiles} />
            </section>

            <section className={`panel lib-split ${loading ? "veil" : ""}`}>
              <div className="panel-head">
                <span className="panel-title"><span className="sec-no mono">02</span>Transition library</span>
                <span className="count mono">PICK A TYPE TO EDIT · {liveTransitions} LIVE</span>
              </div>
              <div className="split">
                {/* ── left rail: every type at a glance — click to inspect ── */}
                <div className="type-rail" role="listbox" aria-label="Transition types">
                  {TRANSITIONS_CONFIG.map((railItem) => {
                    const Icon = railItem.icon;
                    const dur = categoryDurations[railItem.id] || 0.5;
                    const count = transitions.filter((t) => t === railItem.id).length;
                    const fam = railItem.id === "none" ? "cut" : railItem.id === "fade" ? "fade" : railItem.id.startsWith("smooth") ? "wipe" : "push";
                    return (
                      <button
                        key={railItem.id}
                        type="button"
                        role="option"
                        aria-selected={trSel === railItem.id}
                        className={`type-row fam-${fam} ${trSel === railItem.id ? "sel" : ""}`}
                        onClick={() => { stopTransitionPreview(); setTrSel(railItem.id); }}
                        title={`Edit ${railItem.name} — seconds, sound, slice`}
                      >
                        <span className="ty-ic"><Icon className="ic ic-14" /></span>
                        <span className="ty-n"><b>{railItem.name}</b></span>
                        <span className="ty-d mono">{railItem.id === "none" ? "0.0" : dur.toFixed(1)}s</span>
                        <span className={`ty-c mono ${count > 0 ? "on" : ""}`}>{count > 0 ? count : "·"}</span>
                        {sfxAssign[railItem.id]?.id && <span className="ty-sfx mono" title="Sound assigned">♪</span>}
                      </button>
                    );
                  })}
                </div>

                {/* ── inspector: seconds, sound & slice for the SELECTED type ── */}
                <div className="inspector">
                  {(() => {
                    const item = TRANSITIONS_CONFIG.find((t) => t.id === trSel) ?? TRANSITIONS_CONFIG[0];
                    const Icon = item.icon;
                    const dur = categoryDurations[item.id] || 0.5;
                    const count = transitions.filter(t => t === item.id).length;
                    const isTop = item.id === topTransitionId;
                    // Visual family: blend / wipe / push / cut — colors the whole card.
                    const fam = item.id === "none" ? "cut" : item.id === "fade" ? "fade" : item.id.startsWith("smooth") ? "wipe" : "push";
                    const famLabel = fam === "cut" ? "HARD CUT" : fam === "fade" ? "BLEND" : fam === "wipe" ? "WIPE" : "PUSH";
                    const pvPosterA = posterFor(0);
                    const pvPosterB = posterFor(1);
                    return (
                      <div className={`insp-card fam-${fam} ${isTop ? "on" : ""}`}>
                    <div className={`tr-preview ${pvClassFor(item.id)} ${pvPlaying === item.id ? "live" : ""}`}>
                      {pvPlaying === item.id ? (
                        <canvas className="pv-live" ref={pvCanvasRef} />
                      ) : pvPosterA && pvPosterB ? (
                        <div
                          className="pv-stage"
                          style={{ "--pv-dur": `${item.id === "none" ? 1.8 : Math.max(0.3, dur) / 0.35}s` } as React.CSSProperties}
                        >
                          <img className="pv-a" src={pvPosterA} alt="" />
                          <img className="pv-b" src={pvPosterB} alt="" />
                        </div>
                      ) : (
                        <>
                          {item.id === "smoothleft" && <span className="pv-arrow">←</span>}
                          {item.id === "smoothright" && <span className="pv-arrow">→</span>}
                          {item.id === "slideleft" && <span className="pv-arrow">←</span>}
                          {item.id === "slideright" && <span className="pv-arrow">→</span>}
                          {item.id === "slideup" && <span className="pv-arrow">↑</span>}
                          {item.id === "slidedown" && <span className="pv-arrow">↓</span>}
                          <span className="pv-lab">{pvLabelFor(item.id)}</span>
                        </>
                      )}
                      <button
                        type="button"
                        className={`pv-run ${pvPlaying === item.id ? "stop" : ""}`}
                        disabled={pvPlaying !== null ? pvPlaying !== item.id : !(pvPosterA && pvPosterB)}
                        onClick={() => toggleTransitionPreview(item.id)}
                        title={
                          pvPlaying === item.id
                            ? "Stop preview"
                            : pvPosterA && pvPosterB
                              ? `Real preview: your first two assets, the ${item.name} transition + your SFX`
                              : "Upload at least 2 media assets to preview with your footage"
                        }
                      >
                        {pvPlaying === item.id ? "■ STOP" : "▶ PREVIEW"}
                      </button>
                      {pvPlaying === item.id && (
                        <span className="pv-run-cap mono">
                          REAL PREVIEW · {item.name.toUpperCase()}{item.id !== "none" ? ` ${dur}s` : ""}
                          {sfxAssign[item.id] ? ` · SFX ${sfxAssign[item.id]!.vol}%` : " · NO SFX"}
                        </span>
                      )}
                    </div>
                    <div className="insp-meta">
                      <div className="tr-head insp-head">
                        <b>
                          <Icon className="ic ic-16" />
                          {item.name}
                        </b>
                        <i className="insp-fam">{famLabel}</i>
                      </div>
                      <p className="tr-desc">{TRANSITION_DESC[item.id]}</p>

                      {item.id !== "none" ? (
                        <div className="tr-dur">
                          <span>Seconds</span>
                          <CustomSelect
                            value={dur}
                            onChange={(val: any) => handleCategoryDurationChange(item.id, Number(val))}
                            options={[
                              { value: 0.3, label: '0.3s' },
                              { value: 0.5, label: '0.5s' },
                              { value: 0.8, label: '0.8s' },
                              { value: 1.0, label: '1.0s' },
                              { value: 1.5, label: '1.5s' },
                              { value: 2.0, label: '2.0s' },
                            ]}
                            className="w-20"
                            dropdownUp
                          />
                        </div>
                      ) : (
                        <div className="tr-dur hard">
                          <span>Render</span>
                          <b className="mono">0 FRAMES · ON THE CUT</b>
                        </div>
                      )}

                      <div className="tr-foot">
                        <span className={`chip ${count > 0 ? "acc" : ""}`}>{count} CUTS</span>
                        <button
                          type="button"
                          className={`mini-btn ${isTop ? "accent" : ""}`}
                          disabled={loading || images.length <= 1}
                          onClick={() => handleApplyToAll(item.id)}
                        >
                          {loading ? "Rendering…" : "Apply to all"}
                        </button>
                      </div>
                    </div>
                    <div className="card-sfx">
                      <span className="cs-label mono">SFX</span>
                      <CustomSelect
                        value={sfxAssign[item.id]?.id ?? ""}
                        onChange={(val: any) => setSfxForType(item.id, val ? { id: String(val), vol: sfxAssign[item.id]?.vol ?? 100, start: sfxAssign[item.id]?.start ?? 0 } : null)}
                        options={[
                          { value: "", label: "None" },
                          ...sfxLib.map((s) => ({ value: s.id, label: `${s.name} · ${s.dur.toFixed(1)}s` })),
                        ]}
                        className="cs-select"
                        dropdownUp
                      />
                      {(() => {
                        const asg = sfxAssign[item.id] ?? null;
                        if (!asg) return null;
                        const snd = sfxLib.find((s) => s.id === asg.id);
                        if (!snd) return null;
                        const win = sfxWindowFor(item.id, snd.dur);
                        const maxi = Math.max(0, snd.dur - win);
                        const st = Math.min(Math.max(0, asg.start), maxi);
                        return (
                          <>
                            <button
                              type="button"
                              className={`mini-play ${sfxPlaying === asg.id ? "on" : ""}`}
                              onClick={() => previewSfx(asg.id, { start: st, dur: win, vol: asg.vol })}
                              title={sfxPlaying === asg.id ? "Stop" : `Preview slice ${st.toFixed(2)}s–${(st + win).toFixed(2)}s at ${asg.vol}%`}
                            >
                              {sfxPlaying === asg.id ? "■" : "▶"}
                            </button>
                            <input
                              type="range"
                              className="cs-vol"
                              min={0}
                              max={200}
                              step={5}
                              value={asg.vol}
                              onChange={(e) => setSfxForType(item.id, { id: asg.id, vol: Number(e.target.value), start: asg.start })}
                              title={`Sound volume: ${asg.vol}% — preview plays exactly this`}
                            />
                            <span className="cs-pct mono">{asg.vol}%</span>
                          </>
                        );
                      })()}
                    </div>
                    {(() => {
                      // Segment editor: drag WHICH part of the sound plays
                      // inside this transition's window. The drawn canvas is
                      // the sound's real waveform (decoded once per sound);
                      // the window's WIDTH is the transition's seconds.
                      const asg = sfxAssign[item.id] ?? null;
                      if (!asg) return null;
                      const snd = sfxLib.find((s) => s.id === asg.id);
                      if (!snd) return null;
                      const win = sfxWindowFor(item.id, snd.dur);
                      const maxi = Math.max(0, snd.dur - win);
                      const st = Math.min(Math.max(0, asg.start), maxi);
                      const isFull = maxi <= 0.01;
                      return (
                        <div className="sfx-ed">
                          <div className="sfx-ed-head mono">
                            <span>{item.id === "none" ? "FULL SOUND ON EVERY CUT" : "SLIDE THE WINDOW TO PICK THE PART"}</span>
                            <span className={isFull ? "" : "acc-t"}>{st.toFixed(2)}s → {(st + win).toFixed(2)}s</span>
                          </div>
                          <canvas
                            className={`sfx-wave ${isFull ? "" : "draggable"}`}
                            ref={(el) => { sfxWaveRefs.current[item.id] = el; }}
                            onPointerDown={isFull ? undefined : (e) => handleWaveDrag(e, item.id)}
                            title={isFull ? "The whole sound is used" : "Drag to move the used window inside the sound"}
                          />
                          {!isFull && (
                            <div className="sfx-ed-note">
                              Window = {win.toFixed(2)}s ({item.id === "none" ? "transition" : `${categoryDurations[item.id] || 0.5}s transition`} · sound {snd.dur.toFixed(2)}s) — the render trims exactly this part, centered on the cut.
                            </div>
                          )}
                        </div>
                      );
                    })()}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </section>

            </>) : null}
            {motionTab === "plan" ? (<>

            <section className="panel">
              <div className="panel-head">
                <span className="panel-title"><span className="sec-no mono">04</span>Shot structure</span>
                <span className="count mono">
                  {unitSlides.length} SLIDE{unitSlides.length === 1 ? "" : "S"}
                  {structActive ? " · COMPOSED" : " · 1/SLIDE"}
                </span>
                <span className="head-actions">
                  {slides !== null && (
                    <button type="button" className="mini-btn danger" onClick={() => setSlides(null)}>Reset to 1/slide</button>
                  )}
                </span>
              </div>

              {unitSlides.length > 0 ? (
                <>
                  <div className="cut-map">
                    {unitSlides.map((sl, k) => {
                      const unitVid = unitIsVideo[k];
                      const slideBadge = motionBadge(shownBadgePlan[k]);
                      const canMerge = k < unitSlides.length - 1 && !unitVid && !unitIsVideo[k + 1] &&
                        sl.imageIndices.length + unitSlides[k + 1].imageIndices.length <= 3;
                      const layoutName = unitVid ? "LIVE CLIP" : sl.imageIndices.length === 1 ? "1-UP HERO"
                        : sl.imageIndices.length === 2 ? "2-UP SPLIT" : "3-UP GRID";
                      return (
                        <div key={k} className="cut-row">
                          <span className="cut-num">{unitVid ? `CLIP #${k + 1}` : `SLIDE #${k + 1}`}</span>
                          <span className="cut-thumbs">
                            {sl.imageIndices.map((gi) => (
                              <span key={gi} className={`th t${(gi % 7) + 1}`}>
                                {posterFor(gi) && <img src={posterFor(gi)} alt="" />}
                                {isVideoFile(images[gi]) && <span className="th-vid">▶</span>}
                              </span>
                            ))}
                          </span>
                          <span className="cut-label">
                            <b>{layoutName} · Σ {unitDurs[k].toFixed(1)}s</b>
                            <i>
                              {unitVid
                                ? "VIDEO TRIMMED TO SLOT · PLAYS AS-IS"
                                : slideBadge ? `${slideBadge} · cards enter one-by-one` : "STATIC HOLD"}
                            </i>
                          </span>
                          <input
                            className="slide-title-input"
                            value={sl.title}
                            maxLength={60}
                            placeholder={unitVid ? "Video plays as-is" : "Headline…"}
                            disabled={unitVid}
                            title={unitVid ? "Live video units do not composite headlines" : undefined}
                            onChange={(e) => {
                              const v = e.target.value;
                              setSlides((prev) => {
                                const base = prev ?? autoSlides;
                                if (k >= base.length) return prev;
                                const next = [...base];
                                next[k] = { ...next[k], title: v.slice(0, 60) };
                                return next;
                              });
                            }}
                          />
                          <CustomSelect
                            value={sl.enter}
                            disabled={unitVid}
                            onChange={(val: any) => {
                              const enter = String(val) as SlideEnter;
                              setSlides((prev) => {
                                const base = prev ?? autoSlides;
                                if (k >= base.length) return prev;
                                const next = [...base];
                                next[k] = { ...next[k], enter };
                                return next;
                              });
                            }}
                            options={[
                              { value: "none", label: "Still" },
                              { value: "up", label: "From bottom" },
                              { value: "down", label: "From top" },
                              { value: "left", label: "From left" },
                              { value: "right", label: "From right" },
                            ]}
                            className="w-32"
                          />
                          <span className="slide-ops">
                            {sl.imageIndices.length > 1 && (
                              <button type="button" className="mini-btn" onClick={() => splitSlide(k)}>Split</button>
                            )}
                            {canMerge && (
                              <button type="button" className="mini-btn" onClick={() => mergeSlide(k)}>Merge ↓</button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="strip-foot" style={{ marginTop: 12 }}>
                    <span>
                      GROUP UP TO 3 IMAGES PER SLIDE · CARDS ENTER ONE-BY-ONE ·
                      TITLES STAGGER FIRST
                    </span>
                  </div>
                </>
              ) : (
                <div className="empty-note" style={{ marginTop: 12 }}>
                  Add images to compose slides.
                </div>
              )}
            </section>

            </>) : null}
            {motionTab === "cuts" ? (<>

            <section className="panel">
              <div className="panel-head">
                <span className="panel-title"><span className="sec-no mono">03</span>Cut map</span>
                <span className="count mono">{cutIndices.length} CUTS · {liveTransitions} LIVE</span>
                <span className="head-actions">
                  {Object.keys(cutSfxOv).length > 0 && (
                    <button type="button" className="mini-btn" onClick={() => setCutSfxOv({})} title="Restore every cut to its transition's default sound + volume">Reset sfx tweaks</button>
                  )}
                  {liveTransitions > 0 && (
                    <button type="button" className="mini-btn danger" onClick={handleResetTransitions}>Reset all</button>
                  )}
                </span>
              </div>

              {cutIndices.length > 0 ? (
                <>
                  <div className="cut-map">
                    {visibleCuts.map(idx => {
                      const trans = effTransitions[idx] || "none";
                      const isActive = trans !== "none";
                      const thisDur = categoryDurations[trans] || 0.5;
                      const moveBadge = motionBadge(shownBadgePlan[idx]);
                      const tailCut = motionOn && idx >= introEnd;
                      const tailChip = motionTail === "pan" ? "PAN TAIL · CUTS" : "CUT-ONLY TAIL";
                      // Slide joins read the boundary images; legacy reads raw names.
                      const fromSlide = structActive && structSlides ? structSlides[idx] : null;
                      const toSlide = structActive && structSlides ? structSlides[idx + 1] : null;
                      const imgFrom = fromSlide
                        ? `Slide ${idx + 1} (${fromSlide.imageIndices.length}-up)`
                        : (images[idx]?.name || `Img ${idx + 1}`);
                      const imgTo = toSlide
                        ? `Slide ${idx + 2} (${toSlide.imageIndices.length}-up)`
                        : (images[idx + 1]?.name || `Img ${idx + 2}`);
                      const thumbA = fromSlide
                        ? fromSlide.imageIndices[fromSlide.imageIndices.length - 1]
                        : idx;
                      const thumbB = toSlide ? toSlide.imageIndices[0] : idx + 1;
                      const onJoinChange = (val: any) => handleSpecificTransition(
                        structActive ? slideBoundaryOf(idx) : idx, String(val));

                      return (
                        <div key={idx} className={`cut-row ${isActive ? "live" : ""} ${tailCut ? "tail" : ""}`}>
                          <span className="cut-num">CUT #{idx + 1}</span>
                          <span className="cut-thumbs">
                            <span className={`th t${(thumbA % 7) + 1}`}>
                              {posterFor(thumbA) && <img src={posterFor(thumbA)} alt="" />}
                              {isVideoFile(images[thumbA]) && <span className="th-vid">▶</span>}
                            </span>
                            <span className={`cut-dia ${markerModFor(trans)}`}><span className="dia" /></span>
                            <span className={`th t${((thumbB) % 7) + 1}`}>
                              {posterFor(thumbB) && <img src={posterFor(thumbB)} alt="" />}
                              {isVideoFile(images[thumbB]) && <span className="th-vid">▶</span>}
                            </span>
                          </span>
                          <span className="cut-label">
                            <b>{imgFrom} → {imgTo}</b>
                            <i>{isActive ? `${thisDur}s · CENTERED ON CUT` : "HARD CUT · 0 FRAMES"}</i>
                          </span>
                          {moveBadge && <span className="cut-move">{moveBadge}</span>}
                          {tailCut ? (
                            <span
                              className="cut-locked"
                              title={
                                transitions[idx] && transitions[idx] !== "none"
                                  ? `Stored: ${transitions[idx]} (restored when motion is off)`
                                  : motionTail === "pan"
                                    ? "Rest of timeline: subtle pans glide in, joins stay hard cuts (fast path)"
                                    : "Intro-only motion: this join always renders as a hard cut"
                              }
                            >
                              {tailChip}
                            </span>
                          ) : (
                          <CustomSelect
                            value={trans}
                            onChange={onJoinChange}
                            options={[
                              { value: "none", label: "None" },
                              { value: "fade", label: "Fade" },
                              { value: "smoothleft", label: "Wipe Left" },
                              { value: "smoothright", label: "Wipe Right" },
                              { value: "slideleft", label: "Slide Left" },
                              { value: "slideright", label: "Slide Right" },
                              { value: "slideup", label: "Slide Up" },
                              { value: "slidedown", label: "Slide Down" },
                            ]}
                            className="w-32"
                            dropdownUp={idx > cutIndices.length - 3}
                          />
                          )}
                          {(() => {
                            const ov = cutSfxOv[idx];
                            if (ov?.off) {
                              return (sfxAssign[trans]?.id || ov.id) ? (
                                <button
                                  type="button"
                                  className="cut-sfx-muted"
                                  title="Sound silenced for this cut — click to restore"
                                  onClick={() => patchCutSfx(idx, { off: false })}
                                >♪ muted</button>
                              ) : null;
                            }
                            const eff = cutSfxEff(idx, trans);
                            if (!eff) return null;
                            const cid = eff.id;
                            return (
                              <span className="cut-sfx" title="Sound effect bound to this cut — plays the window chosen on its transition card, centered on the cut point">
                                <button
                                  type="button"
                                  className={`mini-play sm ${sfxPlaying === cid ? "on" : ""}`}
                                  onClick={() => previewSfx(cid, { start: eff.start, dur: eff.win, vol: eff.vol })}
                                  title={`Preview what this cut plays: ${eff.start.toFixed(2)}s–${(eff.start + eff.win).toFixed(2)}s at ${eff.vol}%`}
                                >
                                  {sfxPlaying === cid ? "■" : "▶"}
                                </button>
                                <input
                                  type="range"
                                  className="cs-vol xs"
                                  min={0}
                                  max={200}
                                  step={5}
                                  value={eff.vol}
                                  onChange={(e) => patchCutSfx(idx, { vol: Number(e.target.value) })}
                                />
                                <span className="cs-pct xs mono">{eff.vol}%</span>
                                <button
                                  type="button"
                                  className="mini-play sm mute"
                                  title="Silence this cut only"
                                  onClick={() => patchCutSfx(idx, { off: true })}
                                >✕</button>
                              </span>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>

                  <div className="strip-foot" style={{ marginTop: 12 }}>
                    <span>
                      {Math.min(visibleCuts.length, cutIndices.length)} OF {cutIndices.length} CUTS SHOWN ·
                      TRANSITIONS CENTER ON THE CUT
                    </span>
                    {cutIndices.length > 6 && (
                      <button type="button" className="mini-btn" onClick={() => setShowAllCuts(!showAllCuts)}>
                        {showAllCuts ? "Show fewer" : `Show all ${cutIndices.length}`}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-note" style={{ marginTop: 12 }}>
                  Add at least 2 assets to customize transitions.
                </div>
              )}
            </section>
            </>) : null}
          </div>

          {motionTab === "plan" && (
          <aside className="motion-aside">
            <div className="panel">
              <div className="panel-head"><span className="panel-title">Render plan</span></div>
              <div className="kv-list">
                <div className="kv"><i>Motion</i><b className="acc-t">{motionPresetLine}</b></div>
                <div className="kv"><i>Global</i><b className="acc-t">{transitionName(globalTransition)}</b></div>
                <div className="kv"><i>Cuts configured</i><b>{transitions.length}</b></div>
                <div className="kv"><i>Live transitions</i><b>{liveTransitions}</b></div>
              </div>
              <p className="panel-note">
                Motion eats into the slides, never past them — totals always match your timestamps.
              </p>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="panel-title">Rules</span></div>
              <div className="rule-list">
                <div className="rule">
                  <CheckCircle2 className="ic ic-14" />
                  <span>Every transition is <b>centered</b> on its cut — half in, half out.</span>
                </div>
                <div className="rule">
                  <CheckCircle2 className="ic ic-14" />
                  <span>Your <b>{totalSeconds.toFixed(1)}s</b> runtime never changes.</span>
                </div>
                <div className="rule">
                  <CheckCircle2 className="ic ic-14" />
                  <span>Hard cuts stay <b>0 frames</b> — no accidental dissolve.</span>
                </div>
              </div>
            </div>

            <div className="panel tip-panel">
              <span className="eyebrow">Signature move</span>
              <p><b>Open on full mix, land on glide.</b> The ribbon shows exactly where the camera hands over — <b>fades</b> carry the story, <b>slides</b> mark the beat changes.</p>
            </div>
          </aside>
          )}
        </div>
      </div>
    </main>
  );

  /* ═══════════════ VIEW 04 · EDITOR ═══════════════ */
  const editorView = (
    <>
      <div className="editor-body">
        <section className="stage">
          <div className="viewer-wrap">
            <div className="viewer" ref={viewerRef}>
              {hasVideo ? (
                <video
                  ref={videoRef}
                  className="video-el"
                  src={currentVideoUrl}
                  controls
                  playsInline
                  muted={isMuted}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
              ) : images.length > 0 ? (
                isVideoFile(images[0]) ? (
                  <>
                    <video
                      className="video-el"
                      src={imageUrls[0]}
                      poster={posterFor(0)}
                      muted
                      loop
                      playsInline
                      controls
                    />
                    <div className="scene" style={{ opacity: 0.18 }} />
                  </>
                ) : (
                  <>
                    <img src={posterFor(0) ?? imageUrls[0]} alt="" className="video-el" />
                    <div className="scene" style={{ opacity: 0.18 }} />
                  </>
                )
              ) : (
                <>
                  <div className="scene">
                    <div className="sky-glow" />
                    <div className="skyline" />
                    <div className="street" />
                  </div>
                  <div className="v-copy">
                    <span className="v-kicker">Program monitor · seq 01</span>
                    <span className="v-title">Your premiere starts here</span>
                    <span className="v-rule" />
                  </div>
                </>
              )}

              <div className="v-top">
                <span className="v-badge">
                  <i className={`dot ${hasVideo ? "acc" : "idle"}`} />
                  {hasVideo
                    ? (outputMode === "single" ? `PROGRAM · FILM ${Math.min(activeVideo, videoUrls.length - 1) + 1}` : `PROGRAM · CHAPTER ${Math.min(activeVideo, videoUrls.length - 1) + 1}`)
                    : "PROGRAM · SEQ 01"}
                </span>
                <span className="v-badge ghost">1080P · 30FPS</span>
              </div>

              {!hasVideo && (
                <div className="v-bottom">
                  <div className="v-note">
                    <span>
                      {images.length > 0
                        ? <><b>{images[0].name}</b> · SOURCE FRAME 01</>
                        : <>NO MEDIA · ADD MEDIA ON STEP 01</>}
                    </span>
                    <span className="acc-t">
                      {images.length > 0 ? "PRESS RENDER TO FILL THE PROGRAM" : "AWAITING FOOTAGE"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="transport">
            <div className="t-group">
              <span className="tc-now">{toTimecode(totalSeconds)}</span>
              <span className="tc-sub">SEQ DUR</span>
            </div>

            <div className="t-buttons">
              <button type="button" className="tbtn sm" disabled={!hasVideo} onClick={() => seekBy(-5)} aria-label="Back 5 seconds">
                <svg className="ic ic-14 ic-fill" viewBox="0 0 24 24"><path d="M11 6v12l-8-6zM19 6v12l-8-6z" /></svg>
              </button>
              <button type="button" className="tbtn" disabled={!hasVideo} onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
                {isPlaying
                  ? <Pause className="ic ic-fill" />
                  : <Play className="ic ic-fill" />}
              </button>
              <button type="button" className="tbtn sm" disabled={!hasVideo} onClick={() => seekBy(5)} aria-label="Forward 5 seconds">
                <svg className="ic ic-14 ic-fill" viewBox="0 0 24 24"><path d="M13 6v12l8-6zM5 6v12l8-6z" /></svg>
              </button>
            </div>

            <div className="t-right">
              <span className="chip">{images.length} CLIPS</span>
              <span className="chip">30 FPS</span>
              <button type="button" className="tbtn sm" disabled={!hasVideo} onClick={toggleMute} aria-label="Mute">
                <svg className="ic ic-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5L6.5 9H3v6h3.5L11 19z" />
                  {!isMuted ? <path d="M15 9.5a3.5 3.5 0 010 5" /> : <path d="M16 10l4 4M20 10l-4 4" />}
                </svg>
              </button>
              <button
                type="button"
                className="tbtn sm"
                disabled={!hasVideo}
                onClick={() => viewerRef.current?.requestFullscreen?.()}
                aria-label="Fullscreen"
              >
                <svg className="ic ic-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                </svg>
              </button>
            </div>
          </div>
        </section>

        {/* ══════════ EXPORT-ONLY SETTINGS ══════════ */}
        <aside className="export-panel">
          <div className="exp-head">
            <div className="panel-head">
              <span className="panel-title">Export</span>
              <span className={`badge ${videoUrls.length > 0 ? "ok" : loading ? "" : "idle"}`}>
                {loading
                  ? <><i className="dot acc" />RENDERING</>
                  : videoUrls.length > 0
                    ? <><i className="dot ok" />READY</>
                    : <><i className="dot idle" />IDLE</>}
              </span>
            </div>
            <p className="exp-sub mono">
              SEQ 01 · {images.length} ASSETS · {totalSeconds.toFixed(1)}S · 30FPS
            </p>
          </div>

          <div className="exp-scroll">
            <section className="exp-sec">
              <div className="exp-label">Deliver as</div>
              <div className="mode-grid">
                <button
                  type="button"
                  className={`mode ${outputMode === "single" ? "on" : ""}`}
                  disabled={loading}
                  onClick={() => setOutputMode("single")}
                >
                  <b>One film</b>
                  <i>Whole story, single file</i>
                </button>
                <button
                  type="button"
                  className={`mode ${outputMode === "chunks" ? "on" : ""}`}
                  disabled={loading}
                  onClick={() => setOutputMode("chunks")}
                >
                  <b>Chapters</b>
                  <i>Split per soundtrack</i>
                </button>
              </div>
            </section>

            <section className="exp-sec">
              <div className="exp-label">Format</div>
              <div className="spec-list">
                <div className="spec-row"><span>Container</span><b>MP4</b></div>
                <div className="spec-row"><span>Codec</span><b>H.264 + AAC</b></div>
                <div className="spec-row"><span>Resolution</span><b>1920 × 1080</b></div>
                <div className="spec-row"><span>Frame rate</span><b>30 fps</b></div>
              </div>
            </section>

            {loading && (
              <section className="exp-sec">
                <div className="exp-label">Progress</div>
                <div className="exp-progress">
                  <div className="ep-top">
                    <span className="ep-state">
                      <RefreshCw className="ic ic-12 spin" style={{ display: "inline", verticalAlign: "-2px", marginRight: 5 }} />
                      {uploading
                        ? (uploadStatusText || "Transferring media…")
                        : (stageDetail || (stage ? `${stage}…` : "Firing the render engine…"))}
                    </span>
                  </div>
                  <div className="bar">
                    <i style={{ width: `${uploading ? uploadProgress : progress}%` }} />
                  </div>
                  <div className="ep-top">
                    <span className="ep-eta">
                      {uploading ? `UPLOAD ${uploadProgress}%` : `${Math.round(progress)}%`} · {images.length} ASSETS
                    </span>
                    <span className="ep-eta">
                      {!uploading && progress > 0 ? formatEta(eta) : ""}
                    </span>
                  </div>
                </div>
                {!uploading && images.length > 50 && (
                  <p className="panel-note">
                    Large job ({images.length} assets) renders in segments — progress lands per segment,
                    chapters appear as they finish.
                  </p>
                )}
                <button type="button" className="mini-btn danger wide" style={{ marginTop: 10 }} onClick={handleCancel} disabled={uploading}>
                  {uploading ? "Uploading media…" : "Cancel render"}
                </button>
              </section>
            )}

            {videoUrls.length > 0 && (
              <section className="exp-sec">
                <div className="exp-label">Deliveries · {videoUrls.length}</div>
                {videoUrls.length > 1 && (
                  <button
                    type="button"
                    className="mini-btn wide"
                    disabled={downloadingAll || loading}
                    onClick={handleDownloadAll}
                  >
                    {downloadingAll
                      ? `Downloading ${downloadingIndex !== null ? downloadingIndex + 1 : 1} of ${videoUrls.length}…`
                      : `Download all (${videoUrls.length} ${outputMode === "single" ? "videos" : "chunks"})`}
                  </button>
                )}
                <div className="deliver-list">
                  {videoUrls.map((url, index) => (
                    <div className="deliver-row" key={index}>
                      <button
                        type="button"
                        className={`deliver-pick ${index === Math.min(activeVideo, videoUrls.length - 1) ? "on" : ""}`}
                        onClick={() => setActiveVideo(index)}
                      >
                        <span className="deliver-idx">{pad2(index + 1)}</span>
                        <span className="deliver-name">
                          {outputMode === "single" ? `film_${index + 1}.mp4` : `chapter_${index + 1}.mp4`}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        disabled={downloadingIndex === index || downloadingAll}
                        onClick={() => handleDownload(url, index)}
                        aria-label={`Download segment ${index + 1}`}
                      >
                        {downloadingIndex === index
                          ? <Loader2 className="ic ic-12 spin" />
                          : <Download className="ic ic-12" />}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!loading && videoUrls.length === 0 && (
              <section className="exp-sec">
                <div className="exp-label">Ready</div>
                {images.length > 0 ? (
                  <div className="note">
                    <Clock className="ic ic-14" />
                    <span>~{totalSeconds.toFixed(0)}s · {images.length} assets · 1080p30 · {transitions.length} cuts</span>
                  </div>
                ) : (
                  <div className="empty-note">Add media on step 01 to enable rendering.</div>
                )}
              </section>
            )}
          </div>

          <div className="exp-foot">
            <button
              type="button"
              className="btn-export"
              onClick={handleGenerate}
              disabled={loading || images.length === 0}
            >
              {loading && (
                <span className="fill" style={{ width: `${uploading ? uploadProgress : progress}%` }} />
              )}
              <span className="lbl">
                {loading ? (
                  uploading ? (
                    <><Loader2 className="ic ic-14 spin" /> Uploading {uploadProgress}%…</>
                  ) : (
                    <><Loader2 className="ic ic-14 spin" /> Rendering… {Math.round(progress)}%</>
                  )
                ) : (
                  <>
                    <Play className="ic ic-14 ic-fill" />
                    Render my film
                    {images.length > 0 && (
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 400, opacity: 0.75, fontSize: 11 }}>
                        · ~{totalSeconds.toFixed(0)}s
                      </span>
                    )}
                  </>
                )}
              </span>
            </button>
            <div className="foot-meta mono">
              <span>1080P30 · H.264 + AAC</span>
              <span>{images.length} ASSETS</span>
            </div>
          </div>
        </aside>
      </div>

    </>
  );

  return (
    <div className={`app ${view === 3 ? "app-editor" : ""}`}>
      <header className="topbar">
        <div className="tb-left">
          <span className="brand">
            <span className="brand-mark"><span /></span>
            <span className="brand-name">Fluxcut</span>
            <span className="brand-tag">STUDIO</span>
          </span>
        </div>

        {stepper}
        {navButtons}
      </header>

      {view === 0 && footageView}
      {view === 1 && timelineView}
      {view === 2 && motionView}
      {view === 3 && editorView}

      <input
        type="file"
        ref={fileInputRef}
        multiple
        accept="image/*,video/*"
        onChange={handleImageChange}
        className="hidden"
      />
      <input
        type="file"
        ref={audioInputRef}
        multiple
        accept="audio/*"
        onChange={handleAudioChange}
        className="hidden"
      />

      {(error || successMessage) && (
        <div className="toast-stack">
          {error && (
            <div className="toast err">
              <AlertCircle className="ic t-ic" />
              <div className="toast-body">
                <b>Something needs attention</b>
                <p>{error}</p>
              </div>
              <button type="button" className="toast-x" onClick={() => setError("")} aria-label="Dismiss">
                <X className="ic ic-12" />
              </button>
            </div>
          )}
          {successMessage && (
            <div className="toast ok">
              <CheckCircle2 className="ic t-ic" />
              <div className="toast-body">
                <b>Done</b>
                <p>{successMessage}</p>
              </div>
              <button type="button" className="toast-x" onClick={() => setSuccessMessage("")} aria-label="Dismiss">
                <X className="ic ic-12" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
