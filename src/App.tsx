import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Upload, AlertCircle, Loader2, X, CheckCircle2,
  Download, Play, Pause, Music, RefreshCw, Clock,
  Sparkles, Scissors, ArrowLeft, ArrowRight, ChevronDown,
  MoveLeft, MoveRight, MoveUp, MoveDown
} from "lucide-react";
import { parseTimestamps } from "./utils/parser";
import { planMotion, motionBadge, introCutoff, MOTION_INTRO_SECONDS } from "./utils/motion";
import type { SlideEnter } from "./utils/slides";

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
      return { ok: false, data: null, error: "Upload failed: Proxy or server returned HTML fallback. Please retry with smaller images." };
    }
    return { ok: true, data: text };
  } catch (err: any) {
    return { ok: false, data: null, error: err.message || "Network or parsing error" };
  }
};

const CustomSelect = ({ value, onChange, options, className = "", dropdownUp = false }: any) => {
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
    <div className={`cselect ${className}`} ref={containerRef}>
      <button type="button" className="cselect-btn" onClick={() => setIsOpen(!isOpen)}>
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
      out.push({ imageIndices: idx, enter, title: typeof s.title === "string" ? s.title.slice(0, 60) : "" });
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

  // Slide editing ops (merge keeps totals: durations are member sums).
  const mergeSlide = (k: number) => setSlides((prev) => {
    const base = prev ?? autoSlides;
    if (k < 0 || k >= base.length - 1) return prev;
    const a = base[k], b = base[k + 1];
    if (a.imageIndices.length + b.imageIndices.length > 3) return prev;
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
    () => introCutoff(unitDurs, { imageCount: unitCount }),
    [unitDurs, unitCount]
  );
  const effTransitions = useMemo(
    () => (motionOn ? unitTransBase.map((t, i) => (i < introEnd ? t : "none")) : unitTransBase),
    [unitTransBase, motionOn, introEnd]
  );
  const effTransDurs = useMemo(
    () => effTransitions.map(t => (t === "none" ? 0 : (categoryDurations[t] || 0.5))),
    [effTransitions, categoryDurations]
  );

  const badgePlan = useMemo(
    () => planMotion(unitDurs, effTransitions, effTransDurs,
      { enabled: motionOn, style: motionStyle, seed: motionSeed },
      { imageCount: unitCount }),
    [unitDurs, effTransitions, effTransDurs, motionOn, motionStyle, motionSeed, unitCount]
  );

  // ── Design-only view state (no business logic) ──────────────────
  const [view, setView] = useState(0);              // 0 Footage · 1 Timeline · 2 Motion · 3 Editor
  const [activeVideo, setActiveVideo] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  // Scrollable viewport height for the imported-media grid (≈15 tiles visible).
  const [mediaGridVh, setMediaGridVh] = useState(0);
  const trCardsRef = useRef<HTMLDivElement>(null);
  const [trCardsVh, setTrCardsVh] = useState(0);

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

  // Cap the motion picker to 4 visible transition cards; the rest scrolls
  // (one row on desktop, two on the 2-col small-screen layout).
  useEffect(() => {
    const el = trCardsRef.current;
    if (!el) return;
    const measure = () => {
      const card = el.querySelector<HTMLElement>(".tr-card");
      if (!card) { setTrCardsVh(0); return; }
      const gap = 13; // .tr-cards gap
      const cols = Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);
      const rows = Math.ceil(4 / cols); // exactly 4 cards visible at once
      setTrCardsVh(rows * (card.offsetHeight + gap) - gap);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const firstCard = el.querySelector<HTMLElement>(".tr-card");
    if (firstCard) ro.observe(firstCard);
    return () => ro.disconnect();
  }, [view]);

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
      const filesArray = Array.from(e.target.files);
      setImages(prev => {
        const newImages = [...prev, ...filesArray].sort((a, b) => {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
        return newImages;
      });
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
      const filesArray = Array.from(e.dataTransfer.files).filter((file: File) => file.type.startsWith('image/'));
      setImages(prev => {
        const newImages = [...prev, ...filesArray].sort((a, b) => {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
        return newImages;
      });
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
    let uploadedCount = 0;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const chunk = files.slice(i, i + BATCH_SIZE);
      const chunkIndices = Array.from({ length: chunk.length }, (_, idx) => i + idx);

      let attempt = 0;
      const retries = 3;

      while (attempt < retries) {
        attempt++;
        try {
          const formData = new FormData();
          formData.append("jobId", jobId);
          formData.append("indices", JSON.stringify(chunkIndices));
          chunk.forEach(f => formData.append("images", f));

          const res = await fetch("/api/upload-batch", { method: "POST", body: formData });
          const parsed = await safeParseResponse(res);
          if (!parsed.ok) {
            throw new Error(parsed.error || `Batch upload failed with status ${res.status}`);
          }
          break;
        } catch (err: any) {
          if (attempt === retries) throw err;
          await new Promise(r => setTimeout(r, attempt * 600));
        }
      }
      uploadedCount += chunk.length;
      setUploadProgress(Math.round((uploadedCount / files.length) * 100));
    }
  };

  const handleGenerate = async () => {
    if (images.length === 0) {
      setError("Please upload at least one image.");
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

      setUploadStatusText("Uploading images...");
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
          motion: { enabled: motionOn, style: motionStyle, seed: motionSeed },
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
  const totalLabel = `${pad2(totalSeconds / 60)}:${(totalSeconds % 60).toFixed(1).padStart(4, "0")}`;
  const liveTransitions = effTransitions.filter(t => t !== "none").length;
  const cutIndices = effTransitions.length > 0 ? effTransitions.map((_, i) => i) : [];
  const visibleCuts = showAllCuts ? cutIndices : cutIndices.slice(0, 6);
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
            Drop frames and a soundtrack. Everything is sorted A→Z automatically, so your file
            names become the story order — no dragging required.
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
              <span className="corner br mono">JPG · PNG · WEBP</span>
              <div className="orb"><Upload className="ic ic-26" /></div>
              <h3>{images.length > 0 ? "Drop more frames" : "Drop frames here"}</h3>
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
                <span className="tag">AUTO-SORT A→Z</span>
                <span className="tag">RENAME TO REORDER</span>
                <span className="tag">NO SIZE LIMIT</span>
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
                {images.map((file, index) => (
                  <div key={`${file.name}-${index}`} className="asset-tile">
                    <div className={`tile-thumb t${(index % 7) + 1}`}>
                      <img src={imageUrls[index]} alt={file.name} className="tile-img" />
                      <span className="tile-idx">{pad2(index + 1)}</span>
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
                      <span className="tile-dur">{(displayDurations[index] ?? defaultDurationPerImage).toFixed(1)}s</span>
                    </div>
                  </div>
                ))}
                <button type="button" className="asset-tile add" onClick={() => fileInputRef.current?.click()}>
                  <span><Upload className="ic ic-20" /> ADD FRAMES</span>
                </button>
              </div>
            ) : (
              <div className="empty-note">No frames yet — drop files above to start your sequence.</div>
            )}

            <div className="sec-head">
              <span className="sec-title">Soundtrack <b>{audioFiles.length}</b></span>
              <span className="mono muted" style={{ fontSize: "9.5px", letterSpacing: ".14em" }}>
                OPTIONAL · LOOPED TO FILL · NEVER MUTE
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
                <div className="kv"><i>Frames</i><b>{images.length}</b></div>
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
                    {images.map((file, index) => (
                      <React.Fragment key={`${file.name}-${index}`}>
                        <div className={`clip-card ${index === 0 ? "on" : ""}`}>
                          <div className={`cc-thumb t${(index % 7) + 1}`}>
                            <img src={imageUrls[index]} alt={file.name} className="tile-img" />
                            <span className="cc-idx">{pad2(index + 1)}</span>
                          </div>
                          <div className="cc-meta">
                            <span className="cc-name">{file.name}</span>
                            <span className="cc-dur">SLIDE <b>{(displayDurations[index] ?? defaultDurationPerImage).toFixed(1)}s</b></span>
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
                    ))}
                    <button type="button" className="clip-add" onClick={() => fileInputRef.current?.click()}>
                      <span><Upload className="ic ic-20" /> ADD CLIP</span>
                    </button>
                  </div>
                  <div className="strip-foot">
                    <span>RENAME FILES TO REORDER · DURATIONS COME FROM YOUR SCRIPT</span>
                    <span>Σ {totalSeconds.toFixed(1)}S · {transitions.length} CUTS</span>
                  </div>
                </>
              ) : (
                <div className="empty-note" style={{ marginTop: 12 }}>
                  No frames yet — add them on step 01 to build the sequence.
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
      <div className="page-shell">
        <div className="page-hero">
          <span className="eyebrow">Step 03 — Motion</span>
          <h1 className="h-display">Direct every <em>cut</em></h1>
          <p className="lede">
            Pick a transition once and push it across the whole sequence, or tune a single cut.
            Every transition lands exactly on its cut — half from the outgoing frame, half from
            the incoming — and your runtime never changes.
          </p>
        </div>

        <div className="motion-grid">
          <div className="motion-main">
            <div
              className={`tr-cards ${loading ? "veil" : ""}`}
              ref={trCardsRef}
              style={trCardsVh ? { maxHeight: trCardsVh } : undefined}
            >
              {TRANSITIONS_CONFIG.map((item) => {
                const Icon = item.icon;
                const dur = categoryDurations[item.id] || 0.5;
                const count = transitions.filter(t => t === item.id).length;
                const isTop = item.id === topTransitionId;

                return (
                  <div key={item.id} className={`tr-card ${isTop ? "on" : ""}`}>
                    <div className={`tr-preview ${pvClassFor(item.id)}`}>
                      {imageUrls.length >= 2 ? (
                        <div
                          className="pv-stage"
                          style={{ "--pv-dur": `${item.id === "none" ? 1.8 : Math.max(0.3, dur) / 0.35}s` } as React.CSSProperties}
                        >
                          <img className="pv-a" src={imageUrls[0]} alt="" />
                          <img className="pv-b" src={imageUrls[1]} alt="" />
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
                    </div>
                    <div className="tr-head">
                      <b style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Icon className="ic ic-14" style={{ color: isTop ? "var(--acc)" : "var(--ink-3)" }} />
                        {item.name}
                      </b>
                      <i>{item.id === "none" ? "0.0s" : `${dur}s`}</i>
                    </div>
                    <p className="tr-desc">{TRANSITION_DESC[item.id]}</p>

                    {item.id !== "none" && (
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
                );
              })}
            </div>

            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">Slide structure</span>
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
                      const slideBadge = motionBadge(badgePlan[k]);
                      const canMerge = k < unitSlides.length - 1 &&
                        sl.imageIndices.length + unitSlides[k + 1].imageIndices.length <= 3;
                      const layoutName = sl.imageIndices.length === 1 ? "1-UP HERO"
                        : sl.imageIndices.length === 2 ? "2-UP SPLIT" : "3-UP GRID";
                      return (
                        <div key={k} className="cut-row">
                          <span className="cut-num">SLIDE #{k + 1}</span>
                          <span className="cut-thumbs">
                            {sl.imageIndices.map((gi) => (
                              <span key={gi} className={`th t${(gi % 7) + 1}`}>
                                {imageUrls[gi] && <img src={imageUrls[gi]} alt="" />}
                              </span>
                            ))}
                          </span>
                          <span className="cut-label">
                            <b>{layoutName} · Σ {unitDurs[k].toFixed(1)}s</b>
                            <i>{slideBadge ? `${slideBadge} · cards enter one-by-one` : "STATIC HOLD"}</i>
                          </span>
                          <input
                            className="slide-title-input"
                            value={sl.title}
                            maxLength={60}
                            placeholder="Headline…"
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
                  Upload frames to compose slides.
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">Cut map</span>
                <span className="count mono">{cutIndices.length} CUTS · {liveTransitions} LIVE</span>
                <span className="head-actions">
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
                      const moveBadge = motionBadge(badgePlan[idx]);
                      const tailCut = motionOn && idx >= introEnd;
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
                        <div key={idx} className="cut-row">
                          <span className="cut-num">CUT #{idx + 1}</span>
                          <span className="cut-thumbs">
                            <span className={`th t${(thumbA % 7) + 1}`}>
                              {imageUrls[thumbA] && <img src={imageUrls[thumbA]} alt="" />}
                            </span>
                            <span className={`cut-dia ${markerModFor(trans)}`}><span className="dia" /></span>
                            <span className={`th t${((thumbB) % 7) + 1}`}>
                              {imageUrls[thumbB] && <img src={imageUrls[thumbB]} alt="" />}
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
                              title={transitions[idx] && transitions[idx] !== "none" ? `Stored: ${transitions[idx]} (restored when motion is off)` : "Intro-only motion: this join always renders as a hard cut"}
                            >
                              CUT-ONLY TAIL
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
                  Upload at least 2 frames to customize transitions.
                </div>
              )}
            </section>
          </div>

          <aside className="motion-aside">
            <div className={`panel cam-card ${motionOn ? "" : "off"}`}>
              <div className="panel-head">
                <span className="panel-title">Camera motion</span>
                <span className={`chip ${motionOn ? "acc" : ""}`}>{motionOn ? "ON" : "OFF"}</span>
              </div>

              <div className="mode-grid cam-switch">
                <button
                  type="button"
                  className={`mode ${motionOn ? "on" : ""}`}
                  disabled={loading}
                  onClick={() => setMotionOn(true)}
                >
                  <b>On</b>
                </button>
                <button
                  type="button"
                  className={`mode ${!motionOn ? "on" : ""}`}
                  disabled={loading}
                  onClick={() => setMotionOn(false)}
                >
                  <b>Off</b>
                </button>
              </div>

              <div className="tr-dur">
                <span>Style</span>
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
              </div>

              <div className="tr-foot">
                <span className="cam-seed">SEED #{motionSeed}</span>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={loading}
                  onClick={() => setMotionSeed(Math.floor(Math.random() * 1_000_000_000))}
                >
                  ⟳ Remix
                </button>
              </div>

              <p className="panel-note">
                Intro-only motion: shots starting in the first {MOTION_INTRO_SECONDS}s move in randomized mix — push, pull, drift on every shot. The rest render as straight cuts on the fast path.
              </p>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="panel-title">Active preset</span></div>
              <div className="kv-list">
                <div className="kv"><i>Global</i><b className="acc-t">{transitionName(globalTransition)}</b></div>
                <div className="kv"><i>Cuts configured</i><b>{transitions.length}</b></div>
                <div className="kv"><i>Live transitions</i><b>{liveTransitions}</b></div>
                <div className="kv"><i>Runtime impact</i><b className="ok-t">0.0s</b></div>
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
              <p><b>Fade</b> carries the story, <b>slides</b> mark the beat changes. One directional slide per chapter keeps motion from feeling random.</p>
            </div>
          </aside>
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
                <>
                  <img src={imageUrls[0]} alt="" className="video-el" />
                  <div className="scene" style={{ opacity: 0.18 }} />
                </>
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
                        : <>NO MEDIA · ADD FRAMES ON STEP 01</>}
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
              SEQ 01 · {images.length} FRAMES · {totalSeconds.toFixed(1)}S · 30FPS
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
                      {uploading ? `UPLOAD ${uploadProgress}%` : `${Math.round(progress)}%`} · {images.length} FRAMES
                    </span>
                    <span className="ep-eta">
                      {!uploading && progress > 0 ? formatEta(eta) : ""}
                    </span>
                  </div>
                </div>
                {!uploading && images.length > 50 && (
                  <p className="panel-note">
                    Large job ({images.length} frames) renders in segments — progress lands per segment,
                    chapters appear as they finish.
                  </p>
                )}
                <button type="button" className="mini-btn danger wide" style={{ marginTop: 10 }} onClick={handleCancel}>
                  Cancel render
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
                    <span>~{totalSeconds.toFixed(0)}s · {images.length} frames · 1080p30 · {transitions.length} cuts</span>
                  </div>
                ) : (
                  <div className="empty-note">Add frames on step 01 to enable rendering.</div>
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
              <span>{images.length} FRAMES</span>
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
        accept="image/*"
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
