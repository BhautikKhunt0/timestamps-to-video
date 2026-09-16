import React, { useState, useRef, useEffect } from "react";
import { 
  Upload, FileVideo, AlertCircle, Loader2, Video, X, CheckCircle2, 
  Download, Play, Music, RefreshCw, ExternalLink, Clock, 
  Sparkles, Scissors, ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Shuffle
} from "lucide-react";
import { parseTimestamps } from "./utils/parser";

const TRANSITIONS_CONFIG = [
  { id: "none", name: "None (Cut)", icon: Scissors, color: "text-neutral-400", border: "border-neutral-700/60", bg: "bg-neutral-800" },
  { id: "fade", name: "Fade", icon: Sparkles, color: "text-blue-400", border: "border-blue-500/60", bg: "bg-blue-950/40" },
  { id: "smoothleft", name: "Smooth Slide Left", icon: ArrowLeft, color: "text-cyan-400", border: "border-cyan-500/60", bg: "bg-cyan-950/40" },
  { id: "smoothright", name: "Smooth Slide Right", icon: ArrowRight, color: "text-teal-400", border: "border-teal-500/60", bg: "bg-teal-950/40" }
];

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
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg text-sm transition-all focus:outline-none"
        style={{ background: "rgba(0,0,0,0.5)", border: "1px solid var(--flux-line2)", color: "var(--flux-ink)" }}
      >
        <span className="truncate">{selectedOption?.label}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} style={{ color: "var(--flux-ink3)" }} />
      </button>
      
      {isOpen && (
        <div className={`absolute z-50 w-full rounded-lg shadow-2xl py-1 max-h-48 overflow-y-auto custom-scrollbar ${dropdownUp ? "bottom-full mb-1" : "top-full mt-1"}`} style={{ background: "#17171b", border: "1px solid var(--flux-line2)" }}>
          {options.map((opt: any) => (
            <button
              key={opt.value}
              type="button"
              className="w-full text-left px-3 py-2 text-sm transition-colors"
              style={opt.value === value
                ? { background: "var(--flux-acc-soft)", color: "var(--flux-acc)", fontWeight: 600 }
                : { color: "var(--flux-ink2)" }}
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
    smoothright: 0.5
  });
  const [transitions, setTransitions] = useState<string[]>([]);
  const [showAllCuts, setShowAllCuts] = useState<boolean>(false);

  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState("");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  
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
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  
  const activeEventSourceRef = useRef<WebSocket | null>(null);
  const activePollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const urls = images.map(img => URL.createObjectURL(img));
    setImageUrls(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [images]);

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
    setTimeout(() => setSuccessMessage(""), 3500);
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
    setTimeout(() => setSuccessMessage(""), 4000);
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
    setTimeout(() => setSuccessMessage(""), 3500);
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

    let finalDurations = [...durations];
    if (finalDurations.length === 0) {
      finalDurations = new Array(images.length).fill(defaultDurationPerImage);
    } else if (finalDurations.length < images.length) {
      const lastDur = finalDurations[finalDurations.length - 1] || defaultDurationPerImage;
      while (finalDurations.length < images.length) {
        finalDurations.push(lastDur);
      }
    } else if (finalDurations.length > images.length) {
      finalDurations = finalDurations.slice(0, images.length);
    }

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
          transitions,
          transitionDurations: transitions.map(t => t === "none" ? 0 : (categoryDurations[t] || 0.5)),
          transitionDuration: categoryDurations["fade"] || 0.5,
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
      setTimeout(() => setSuccessMessage(""), 5000);
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
      const c = transitions.filter(x => x === t.id).length;
      if (t.id !== "none" && c > bestCount) { best = t.id; bestCount = c; }
    }
    return bestCount > 0 ? best : "none";
  })();

  return (
    <div className="min-h-screen font-sans" style={{ color: "var(--flux-ink)" }}>

      {/* Brand line (not a navbar — signature + live project status) */}
      <div className="max-w-[860px] mx-auto px-4 sm:px-6 pt-8 pb-2 flex items-center gap-2.5 rise">
        <span className="w-8 h-8 rounded-[11px] inline-flex items-center justify-center" style={{ background: "#1c1c21", border: "1px solid var(--flux-line2)" }}>
          <span className="w-3 h-3 rounded-full border-2" style={{ borderColor: "var(--flux-acc)" }} />
        </span>
        <span className="font-semibold tracking-tight text-[17px]">Fluxcut</span>
        <div className="ml-auto flex items-center gap-2">
          {images.length > 0 ? (
            <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px]" style={{ border: "1px solid var(--flux-line2)", background: "rgba(255,255,255,0.025)" }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--flux-acc)" }} />
              <span className="font-semibold">{images.length} frames</span>
              <span className="font-mono-d" style={{ color: "var(--flux-ink3)" }}>
                {displayDurations.reduce((a, b) => a + b, 0).toFixed(1)}s
              </span>
            </span>
          ) : null}
          {loading ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--flux-acc)" }}>
              <span className="w-1.5 h-1.5 rounded-full breathe" style={{ background: "var(--flux-acc)" }} />
              Rendering {Math.round(uploading ? uploadProgress : progress)}%
            </span>
          ) : videoUrls.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--flux-ok)" }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--flux-ok)" }} />
              Ready
            </span>
          ) : (
            <span className="text-[12px] font-medium" style={{ color: "var(--flux-ink3)" }}>New project</span>
          )}
        </div>
      </div>

      <main className="max-w-[860px] mx-auto px-4 sm:px-6 pb-16">
            {/* 01. Footage */}
            <section className="flux-card p-6 sm:p-8 mb-4 rise r1">
              <div className="flex items-baseline gap-3 pb-1">
                <span className="flux-stepnum">01</span>
                <h2 className="font-serif-d text-[24px] font-semibold tracking-tight">Footage</h2>
                {images.length > 0 && (
                  <span className="ml-auto font-mono-d text-[11px]" style={{ color: "var(--flux-ink3)" }}>
                    {images.length} FRAMES · A–Z
                  </span>
                )}
              </div>
              <p className="flux-eyebrow pb-5" style={{ color: "var(--flux-ink3)" }}>SOURCE MATERIAL</p>
              {images.length > 0 && (
                <div className="flex justify-end pb-3">
                  <button 
                    onClick={() => {
                      setImages([]);
                      setTransitions([]);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="text-xs font-semibold text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1.5 rounded-lg transition-all"
                  >
                    Clear All
                  </button>
                </div>
              )}
              
              <div 
                id="drop-zone"
                className="border-2 border-dashed rounded-2xl p-10 cursor-pointer group transition-all duration-300 ease-out lift"
                style={{ borderColor: "#3a3a42", background: "rgba(255,255,255,0.015)" }}
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <div className="flex flex-col items-center justify-center gap-4 h-full">
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    multiple 
                    accept="image/*"
                    onChange={handleImageChange}
                    className="hidden" 
                  />
                  <div className="p-4 rounded-full transition-all duration-300 group-hover:scale-110" style={{ background: "var(--flux-acc-soft)", color: "var(--flux-acc)" }}>
                    <Upload className="w-8 h-8" />
                  </div>
                  <div className="text-center">
                    <h3 className="font-semibold text-lg" style={{ color: "var(--flux-ink)" }}>Click to Browse or Drag &amp; Drop</h3>
                    <p className="text-sm mt-1" style={{ color: "var(--flux-ink2)" }}>JPG, PNG, WebP • Auto-sorted alphabetically</p>
                  </div>
                </div>
              </div>

              {/* Audio Upload Pill */}
              <div 
                className="flex items-center gap-4 rounded-xl p-3 cursor-pointer transition-colors group mt-5"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--flux-line)" }}
                onClick={() => audioInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={audioInputRef}
                  multiple
                  accept="audio/*"
                  onChange={handleAudioChange}
                  className="hidden"
                />
                <div className="p-2.5 rounded-[10px] transition-colors shrink-0" style={{ background: "var(--flux-acc-soft)", color: "var(--flux-acc)" }}>
                  <Music className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold truncate" style={{ color: "var(--flux-ink)" }}>Soundtrack</h3>
                  <p className="text-xs truncate font-mono-d" style={{ color: "var(--flux-ink3)" }}>
                    {audioFiles.length > 0 ? `${audioFiles.length} TRACKS · LOOPED TO FILL · NEVER MUTE` : "Optional • Select MP3, WAV"}
                  </p>
                </div>
              </div>

              {/* Audio Files List */}
              {audioFiles.length > 0 && (
                <div className="space-y-2 max-h-32 overflow-y-auto custom-scrollbar pr-2 mt-3">
                  {audioFiles.map((file, idx) => (
                    <div key={`${file.name}-${idx}`} className="flex items-center justify-between p-3 rounded-xl" style={{ background: "rgba(0,0,0,0.35)", border: "1px solid var(--flux-line)" }}>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono-d shrink-0" style={{ background: "var(--flux-acc-soft)", color: "var(--flux-acc)" }}>Track {idx + 1}</span>
                        <span className="text-xs font-medium truncate" style={{ color: "var(--flux-ink)" }}>{file.name}</span>
                        <span className="text-[10px] shrink-0 font-mono-d" style={{ color: "var(--flux-ink3)" }}>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                      </div>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setAudioFiles(prev => prev.filter((_, i) => i !== idx));
                        }}
                        className="p-1.5 rounded-lg shrink-0 transition-colors hover:bg-white/10"
                        style={{ color: "var(--flux-ink2)" }}
                        aria-label={`Remove ${file.name}`}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Image Grid */}
              {images.length > 0 && (
                <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar pt-4">
                  {images.map((file, index) => (
                    <div key={`${file.name}-${index}`} className="relative group aspect-square rounded-[14px] overflow-hidden lift" style={{ background: "#000", border: "1px solid var(--flux-line2)" }}>
                      <img 
                        src={imageUrls[index]} 
                        alt={file.name} 
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
                      />
                      {/* Cutting bar: descends from the top edge on hover */}
                      <div className="cutbar absolute top-0 left-0 right-0 flex items-center justify-between gap-1 px-1.5 py-1.5" style={{ background: "rgba(11,11,13,0.88)", borderBottom: "1px solid var(--flux-acc)", backdropFilter: "blur(6px)" }}>
                        <span className="text-[9px] font-mono-d font-bold truncate" style={{ color: "var(--flux-acc)" }}>CUT</span>
                        <button 
                          onClick={(e) => { e.stopPropagation(); removeImage(index); }}
                          className="p-1 rounded-md text-white transition-colors shrink-0"
                          style={{ background: "var(--flux-acc)" }}
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-d font-bold text-white" style={{ background: "rgba(0,0,0,0.6)" }}>
                          {index + 1}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono-d" style={{ background: "rgba(0,0,0,0.6)", color: "var(--flux-acc)" }}>
                          {(displayDurations[index] ?? defaultDurationPerImage).toFixed(1)}s
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 02. Story */}
            <section className="flux-card p-6 sm:p-8 mb-4 rise r2">
              <div className="flex items-baseline gap-3 pb-1">
                <span className="flux-stepnum">02</span>
                <h2 className="font-serif-d text-[24px] font-semibold tracking-tight">Story</h2>
                {durations.length > 0 ? (
                  <span className="ml-auto font-mono-d text-[11px] font-bold" style={{ color: "var(--flux-ok)" }}>
                    ✓ {durations.length} RANGES · Σ {durations.reduce((a, b) => a + b, 0).toFixed(1)}s
                  </span>
                ) : (
                  <span className="ml-auto font-mono-d text-[11px]" style={{ color: "var(--flux-ink3)" }}>AWAITING SCRIPT</span>
                )}
              </div>
              <p className="flux-eyebrow pb-5" style={{ color: "var(--flux-ink3)" }}>TIMESTAMPS · MILLISECOND PRECISE</p>
              <div className="relative focus-ring-glow rounded-xl transition-all duration-300 mt-4">
                <textarea 
                  className="w-full h-36 p-4 rounded-xl focus:outline-none text-[12.5px] font-mono-d resize-none leading-[1.9] custom-scrollbar"
                  style={{ background: "#0e0e11", color: "var(--flux-ink)", border: "1px solid var(--flux-line2)" }}
                  placeholder={"0:00.000 - 0:03.250 intro\n0:03.250 - 0:05.750 hook\n0:05.750 - 0:08.500 demo …"}
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-4">
                {durations.length === 0 ? (
                  <span className="px-3 py-1.5 text-[12px] font-semibold rounded-full" style={{ border: "1px solid var(--flux-line2)", color: "var(--flux-ink3)" }}>
                    No timestamps yet — uniform {defaultDurationPerImage}s slides
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2 px-3 py-1.5 text-[12px] rounded-full" style={{ border: "1px solid var(--flux-line2)" }}>
                    <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--flux-ok)" }} />
                    <strong>{images.length} slides × {durations.length} ranges</strong>
                    <span style={{ color: "var(--flux-ink3)" }}>fit the timeline</span>
                  </span>
                )}
                <span className="ml-auto font-mono-d text-[11px]" style={{ color: "var(--flux-ink3)" }}>
                  TOTAL <strong className="text-[14px]" style={{ color: "var(--flux-ink)" }}>
                    {(durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : displayDurations.reduce((a, b) => a + b, 0)).toFixed(1)}s
                  </strong>
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 p-3 rounded-xl mt-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--flux-line)" }}>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--flux-ink2)" }}>Parsed Timestamps:</span>
                  <span className="px-2.5 py-1 rounded-md text-xs font-mono-d font-bold" style={{ background: "var(--flux-acc-soft)", color: "var(--flux-acc)", border: "1px solid var(--flux-acc-line)" }}>
                    {durations.length}
                  </span>
                  {durations.length > 0 && (
                    <span className="text-xs font-mono-d" style={{ color: "var(--flux-ink3)" }}>
                      (~{durations.reduce((a, b) => a + b, 0).toFixed(1)}s total)
                    </span>
                  )}
                </div>

                {durations.length === 0 && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: "var(--flux-ink2)" }}>
                    <Clock className="w-3.5 h-3.5" style={{ color: "var(--flux-acc)" }} />
                    <span>Default duration:</span>
                    <CustomSelect
                      value={defaultDurationPerImage}
                      onChange={(val: any) => setDefaultDurationPerImage(Number(val))}
                      options={[
                        { value: 2, label: '2s / slide' },
                        { value: 3, label: '3s / slide' },
                        { value: 4, label: '4s / slide' },
                        { value: 5, label: '5s / slide' },
                        { value: 8, label: '8s / slide' },
                        { value: 10, label: '10s / slide' },
                      ]}
                      className="w-32"
                    />
                  </div>
                )}

                {durations.length > 0 && images.length > 0 && durations.length !== images.length && (
                  <span className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-lg" style={{ color: "#fbbf24", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.25)" }}>
                    <AlertCircle className="w-3.5 h-3.5" />
                    {images.length} images vs {durations.length} timestamps
                  </span>
                )}
              </div>
            </section>

            {/* 03. Motion — transitions live here, single-column flow continues */}
            
            {/* 03. Motion */}
            <section className="flux-card p-6 sm:p-8 mb-4 rise r3">
              <div className="flex items-baseline gap-3 pb-1">
                <span className="flux-stepnum">03</span>
                <h2 className="font-serif-d text-[24px] font-semibold tracking-tight">Motion</h2>
                {images.length > 1 ? (
                  <span className="ml-auto px-3 py-1 text-[11px] font-semibold rounded-full" style={{ color: "var(--flux-acc)", background: "var(--flux-acc-soft)", border: "1px solid var(--flux-acc-line)" }}>
                    {transitions.filter(t => t !== "none").length} transitions live
                  </span>
                ) : (
                  <span className="ml-auto px-3 py-1 text-[11px] rounded-full" style={{ border: "1px solid var(--flux-line2)", color: "var(--flux-ink3)" }}>
                    needs 2+ frames
                  </span>
                )}
                {images.length > 1 && transitions.some(t => t !== "none") && (
                  <button
                    type="button"
                    onClick={handleResetTransitions}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
                    style={{ background: "rgba(255,255,255,0.05)", color: "var(--flux-ink2)", border: "1px solid var(--flux-line2)" }}
                  >
                    Reset All
                  </button>
                )}
              </div>
              <p className="flux-eyebrow pb-4" style={{ color: "var(--flux-ink3)" }}>CENTERED ON EVERY CUT</p>

              <p className="text-[13px] pb-5 max-w-[560px] leading-relaxed" style={{ color: "var(--flux-ink2)" }}>
                Each transition lands <em className="font-serif-d">exactly</em> on its cut — half from the outgoing frame, half from the incoming
                <span className="font-mono-d text-[12px]" style={{ color: "var(--flux-ink)" }}> (0.3s = 0.15s + 0.15s)</span>. Totals always match your timestamps.
              </p>

              {/* Category Presets — choose seconds per transition, apply to one cut or all */}
              <div className={loading ? "opacity-40 pointer-events-none saturate-50 transition-opacity" : "transition-opacity"}>
                <div className="grid grid-cols-2 gap-3">
                  {TRANSITIONS_CONFIG.map((item) => {
                    const Icon = item.icon;
                    const dur = categoryDurations[item.id] || 0.5;
                    const count = transitions.filter(t => t === item.id).length;
                    const isTop = item.id === topTransitionId;

                    return (
                      <div
                        key={item.id}
                        className={`rounded-2xl p-3.5 flex flex-col gap-3 lift ${isTop ? "glow-acc" : ""}`}
                        style={{ background: "rgba(255,255,255,0.015)", border: "1px solid var(--flux-line2)" }}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className={`p-2 rounded-[10px] ${item.bg} ${item.color}`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold" style={{ color: "var(--flux-ink)" }}>
                              {item.name}
                              {isTop && (
                                <span className="ml-1.5 text-[9px] font-mono-d font-bold px-1.5 py-0.5 rounded-full text-white align-middle" style={{ background: "var(--flux-acc)" }}>
                                  TOP
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono-d mt-0.5" style={{ color: "var(--flux-ink3)" }}>
                              {count} active
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2.5 mt-auto pt-2" style={{ borderTop: "1px solid var(--flux-line)" }}>
                          {item.id !== "none" ? (
                            <div className="flex items-center justify-between text-xs">
                              <span style={{ color: "var(--flux-ink2)" }}>Seconds:</span>
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
                                className="w-24 font-mono"
                              />
                            </div>
                          ) : (
                            <div className="text-[11px] py-1 font-mono-d" style={{ color: "var(--flux-ink3)" }}>
                              Hard Cut (0s)
                            </div>
                          )}

                          {images.length > 1 && (
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => handleApplyToAll(item.id)}
                              className="w-full py-1.5 text-xs font-semibold rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed lift"
                              style={isTop
                                ? { background: "var(--flux-acc-soft)", color: "var(--flux-acc)", border: "1px solid var(--flux-acc-line)" }
                                : { background: "rgba(255,255,255,0.04)", color: "var(--flux-ink)", border: "1px solid var(--flux-line2)" }}
                            >
                              {loading ? "Rendering..." : (item.id === "none" ? "Apply Cut to All" : "Apply to All")}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Granular Cuts Accordion */}
              {images.length > 1 ? (
                <div className="rounded-xl mt-4" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--flux-line)" }}>
                  <button
                    onClick={() => setShowAllCuts(!showAllCuts)}
                    className="w-full p-3 flex items-center justify-between text-xs font-semibold transition-colors hover:bg-white/[0.03] rounded-xl"
                    style={{ color: "var(--flux-ink2)" }}
                  >
                    <span className="flex items-center gap-2">
                      <Scissors className="w-3.5 h-3.5" style={{ color: "var(--flux-acc)" }} />
                      Individual Cut Settings
                    </span>
                    {showAllCuts ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  
                  {showAllCuts && (
                    <div className="p-3 max-h-60 overflow-y-auto custom-scrollbar space-y-2" style={{ borderTop: "1px solid var(--flux-line)", background: "rgba(0,0,0,0.2)" }}>
                      {transitions.map((trans, idx) => {
                        const imgFrom = images[idx]?.name || `Img ${idx + 1}`;
                        const imgTo = images[idx + 1]?.name || `Img ${idx + 2}`;
                        const isActive = trans !== "none";
                        const thisDur = categoryDurations[trans] || 0.5;

  return (
                          <div key={idx} className="flex items-center justify-between p-2.5 rounded-lg transition-colors hover:bg-white/[0.04]" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--flux-line)", borderLeft: isActive ? "2px solid var(--flux-acc)" : "2px solid #3a3a42" }}>
                            <div className="flex items-center gap-2.5 min-w-0 flex-1">
                              {imageUrls[idx] && (
                                <img src={imageUrls[idx]} alt="" className="w-9 h-9 rounded-[10px] object-cover shrink-0" style={{ border: "1px solid var(--flux-line2)" }} />
                              )}
                              <div className="flex flex-col min-w-0">
                                <span className="text-[10px] font-mono-d font-bold" style={{ color: isActive ? "var(--flux-acc)" : "var(--flux-ink3)" }}>CUT #{idx + 1}</span>
                                <div className="flex items-center gap-1.5 text-xs mt-0.5" style={{ color: "var(--flux-ink2)" }}>
                                  <span className="truncate max-w-[80px]">{imgFrom}</span>
                                  <span style={{ color: "var(--flux-ink3)" }}>→</span>
                                  <span className="truncate max-w-[80px]">{imgTo}</span>
                                </div>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2 shrink-0">
                              <CustomSelect
                                value={trans}
                                onChange={(val: any) => handleSpecificTransition(idx, String(val))}
                                options={[
                                  { value: "none", label: "None" },
                                  { value: "fade", label: "Fade" },
                                  { value: "smoothleft", label: "Slide Left" },
                                  { value: "smoothright", label: "Slide Right" },
                                ]}
                                className="w-32"
                                dropdownUp={idx > transitions.length - 3}
                              />
                              {isActive ? (
                                <span className="px-2 py-1 rounded-md text-[10px] font-mono-d min-w-[3rem] text-center" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--flux-line2)", color: "var(--flux-ink)" }}>
                                  {thisDur}s
                                </span>
                              ) : (
                                <span className="w-12"></span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-4 rounded-xl text-xs text-center mt-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--flux-line)", color: "var(--flux-ink2)" }}>
                  Upload at least 2 frames to customize transitions.
                </div>
              )}
            </section>

            {/* 04. Export */}
            <section className="flux-card p-6 sm:p-8 mb-4 rise r4">
              <div className="flex items-baseline gap-3 pb-1">
                <span className="flux-stepnum">04</span>
                <h2 className="font-serif-d text-[24px] font-semibold tracking-tight">Export</h2>
                {videoUrls.length > 0 ? (
                  <span className="ml-auto font-mono-d text-[11px] font-bold" style={{ color: "var(--flux-ok)" }}>● 1080p READY</span>
                ) : loading ? (
                  <span className="ml-auto font-mono-d text-[11px] font-bold breathe" style={{ color: "var(--flux-acc)" }}>● RENDERING {Math.round(uploading ? uploadProgress : progress)}%</span>
                ) : null}
              </div>
              <p className="flux-eyebrow pb-5" style={{ color: "var(--flux-ink3)" }}>ONE FILE OR CHAPTERS</p>
              
              {error && (
                <div className="p-4 rounded-xl flex items-start gap-3 mb-4" style={{ background: "rgba(244,63,94,0.07)", border: "1px solid rgba(244,63,94,0.25)" }}>
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "#fb7185" }} />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold" style={{ color: "#fda4af" }}>Something needs attention</h3>
                    <p className="text-xs mt-1" style={{ color: "rgba(253,164,175,0.75)" }}>{error}</p>
                  </div>
                </div>
              )}
              
              {successMessage && (
                <div className="p-4 rounded-xl flex items-start gap-3 mb-4" style={{ background: "rgba(52,211,153,0.07)", border: "1px solid rgba(52,211,153,0.25)" }}>
                  <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--flux-ok)" }} />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold" style={{ color: "var(--flux-ok)" }}>Done</h3>
                    <p className="text-xs mt-1" style={{ color: "var(--flux-ink2)" }}>{successMessage}</p>
                  </div>
                </div>
              )}

              {videoUrls.length > 0 ? (
                <div className="space-y-4">
                  {videoUrls.length > 1 && (
                    <button
                      onClick={handleDownloadAll}
                      disabled={downloadingAll || loading}
                      className="w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 text-white text-sm font-bold rounded-2xl transition-all lift disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ background: "var(--flux-ok)", boxShadow: "0 14px 30px -12px rgba(52,211,153,0.55)" }}
                    >
                      {downloadingAll ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Downloading {downloadingIndex !== null ? downloadingIndex + 1 : 1} of {videoUrls.length}...</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          <span>Download All ({videoUrls.length} {outputMode === "single" ? "videos" : "chunks"})</span>
                        </>
                      )}
                    </button>
                  )}
                  {videoUrls.map((url, index) => (
                    <div key={index} className="rounded-2xl overflow-hidden flex flex-col lift" style={{ background: "#000", border: "1px solid var(--flux-line2)" }}>
                      <div className="aspect-video relative flex items-center justify-center">
                        <video 
                          controls 
                          className="w-full h-full object-contain"
                          src={url}
                          controlsList="nodownload"
                        />
                        <span className="absolute top-3 left-3 px-2 py-1 rounded-md text-[10px] font-mono-d font-bold pointer-events-none" style={{ background: "rgba(0,0,0,0.65)", color: "var(--flux-acc)", border: "1px solid var(--flux-line2)" }}>
                          {outputMode === "single" ? `FILM ${index + 1}` : `CHAPTER ${index + 1}`}
                        </span>
                      </div>
                      
                      <div className="p-4 flex items-center justify-between" style={{ background: "rgba(255,255,255,0.02)", borderTop: "1px solid var(--flux-line)" }}>
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: "rgba(0,0,0,0.4)" }}>
                          <span className="w-2 h-2 rounded-full breathe" style={{ background: "var(--flux-ok)" }}></span>
                          <span className="text-[10px] font-mono-d font-bold tracking-wider" style={{ color: "var(--flux-ink2)" }}>1080p READY</span>
                        </div>
                        
                        <div className="flex gap-2">
                          <button 
                            onClick={() => handleDownload(url, index)}
                            disabled={downloadingIndex === index || downloadingAll}
                            className="inline-flex items-center gap-2 px-5 py-2 text-white text-xs font-bold rounded-xl transition-all lift disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ background: "var(--flux-ink)", color: "#0b0b0d" }}
                          >
                            {downloadingIndex === index ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>{downloadProgress > 0 ? `${Math.round(downloadProgress)}%` : 'Saving...'}</span>
                              </>
                            ) : (
                              <>
                                <Download className="w-4 h-4" />
                                <span>Download</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="aspect-video rounded-2xl border border-dashed flex flex-col items-center justify-center gap-4 p-6 text-center" style={{ background: "rgba(255,255,255,0.015)", borderColor: "#3a3a42" }}>
                  <div className="p-4 rounded-2xl" style={{ background: "rgba(255,255,255,0.03)" }}>
                    <Video className="w-8 h-8" style={{ color: "var(--flux-ink3)" }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "var(--flux-ink2)" }}>
                      {loading ? "Rendering your film…" : "Your premiere starts here"}
                    </p>
                    <p className="text-[11px] mt-1 font-mono-d" style={{ color: "var(--flux-ink3)" }}>1080p · H.264 + AAC</p>
                  </div>
                </div>
              )}

              <div className="pt-5 space-y-3">
                {/* Output mode: one film or chapters */}
                <div className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--flux-line)" }}>
                  <div className="text-xs font-semibold mb-2" style={{ color: "var(--flux-ink2)" }}>Deliver as</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setOutputMode("single")}
                      className="px-3 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed lift"
                      style={outputMode === "single"
                        ? { background: "var(--flux-acc-soft)", color: "var(--flux-acc)", border: "1px solid var(--flux-acc-line)" }
                        : { background: "rgba(255,255,255,0.03)", color: "var(--flux-ink2)", border: "1px solid var(--flux-line2)" }}
                    >
                      <div>One film</div>
                      <div className="text-[10px] font-normal opacity-70 mt-0.5">Whole story, single file</div>
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setOutputMode("chunks")}
                      className="px-3 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed lift"
                      style={outputMode === "chunks"
                        ? { background: "var(--flux-acc-soft)", color: "var(--flux-acc)", border: "1px solid var(--flux-acc-line)" }
                        : { background: "rgba(255,255,255,0.03)", color: "var(--flux-ink2)", border: "1px solid var(--flux-line2)" }}
                    >
                      <div>Chapters</div>
                      <div className="text-[10px] font-normal opacity-70 mt-0.5">Split per soundtrack</div>
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={loading || images.length === 0}
                  className={`btn-fire relative w-full py-4 px-6 rounded-2xl font-bold text-base overflow-hidden flex items-center justify-center gap-3 select-none ${loading ? "rendering-glow cursor-wait" : images.length === 0 ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  {/* Progress Fill Background */}
                  {loading && (
                    <div 
                      className="absolute left-0 top-0 bottom-0 transition-all duration-300 ease-out working"
                      style={{ width: `${uploading ? uploadProgress : progress}%`, backgroundColor: "rgba(255,255,255,0.25)" }}
                    />
                  )}
                  
                  <span className="relative z-10 flex items-center gap-2.5 tracking-wide">
                    {loading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-white" />
                        {uploading ? (
                          <span>Uploading ({uploadProgress}%)...</span>
                        ) : progress >= 0 ? (
                          <span>Rendering… {Math.round(progress)}%</span>
                        ) : (
                          <span>Starting Engine...</span>
                        )}
                      </>
                    ) : (
                      <>
                        <Play className="w-5 h-5 fill-current" />
                        <span>Render my film</span>
                        {images.length > 0 && (
                          <span className="font-mono-d font-normal opacity-70 text-[13px]">
                            · ~{displayDurations.reduce((a, b) => a + b, 0).toFixed(0)}s · 1080p
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </button>
                
                {loading && (
                  <div className="mt-4 space-y-2 px-1 font-mono-d text-xs">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2" style={{ color: "var(--flux-acc)" }}>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        {uploading
                          ? (uploadStatusText || 'Transferring media...')
                          : (stageDetail || (stage ? `${stage}...` : 'Firing the render engine...'))}
                      </span>
                      {!uploading && progress > 0 && (
                        <span className="font-bold px-2 py-0.5 rounded" style={{ color: "var(--flux-acc)", background: "var(--flux-acc-soft)", border: "1px solid var(--flux-acc-line)" }}>
                          ETA: {formatEta(eta)}
                        </span>
                      )}
                    </div>
                    {!uploading && images.length > 50 && (
                      <div className="text-[11px]" style={{ color: "var(--flux-ink3)" }}>
                        Large job ({images.length} frames render in segments — progress lands per segment, chapters appear as they finish.
                      </div>
                    )}
                    <button
                      onClick={handleCancel}
                      className="w-full py-2 text-xs font-semibold rounded-lg transition-colors"
                      style={{ background: "rgba(244,63,94,0.08)", color: "#fda4af", border: "1px solid rgba(244,63,94,0.25)" }}
                    >
                      Cancel render
                    </button>
                  </div>
                )}
              </div>

            </section>

            <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pt-2 pb-10 font-mono-d text-[10.5px]" style={{ color: "var(--flux-ink3)" }}>
              <span>FLUXCUT · FFMPEG · 1080p30 · H.264 + AAC</span>
              <span>CENTERED CUTS · EXACT TIMELINES · NO-MUTE AUDIO</span>
            </footer>
      </main>
    </div>
  );
}
