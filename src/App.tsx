import React, { useState, useRef, useEffect } from "react";
import { 
  Upload, FileVideo, AlertCircle, Loader2, Video, X, CheckCircle2, 
  Download, Play, Music, RefreshCw, ExternalLink, Clock, Layers,
  Sparkles, Scissors, ArrowLeft, ArrowRight, Wand2, ChevronDown, ChevronUp, Shuffle
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
        className="w-full flex items-center justify-between gap-3 px-3 py-1.5 bg-black/60 border border-white/10 rounded-lg text-sm text-neutral-200 hover:bg-black/80 hover:border-white/20 transition-all focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <span className="truncate">{selectedOption?.label}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-neutral-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      
      {isOpen && (
        <div className={`absolute z-50 w-full bg-[#111111] border border-white/10 rounded-lg shadow-2xl py-1 max-h-48 overflow-y-auto custom-scrollbar ${dropdownUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          {options.map((opt: any) => (
            <button
              key={opt.value}
              type="button"
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                opt.value === value 
                  ? "bg-blue-500/20 text-blue-400 font-medium" 
                  : "text-neutral-300 hover:bg-white/5"
              }`}
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

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#050505] text-neutral-200 font-sans selection:bg-blue-500/30">
      {/* Dynamic Background Glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-blue-900/20 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-cyan-900/10 blur-[120px] pointer-events-none" />

      {/* Header */}
      <header className="relative z-10 w-full border-b border-white/5 bg-black/40 backdrop-blur-md">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 shadow-[0_0_20px_rgba(59,130,246,0.3)]">
              <Video className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-white to-neutral-400">
              Studio
            </h1>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-[1400px] mx-auto px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
          
          {/* LEFT COLUMN: Input & Configuration (7 columns on extra large screens) */}
          <div className="xl:col-span-7 space-y-6">
            
            {/* 1. Media Assets */}
            <section className="glass-panel rounded-2xl p-6 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Layers className="w-5 h-5 text-blue-400" />
                  Media Assets
                </h2>
                {images.length > 0 && (
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
                )}
              </div>
              
              <div 
                id="drop-zone"
                className="border-2 border-dashed border-white/10 hover:border-blue-500/50 hover:bg-blue-500/5 rounded-2xl p-10 cursor-pointer group transition-all duration-300 ease-out"
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
                  <div className="p-4 bg-white/5 rounded-full text-blue-400 group-hover:scale-110 group-hover:bg-blue-500/20 group-hover:shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all duration-300">
                    <Upload className="w-8 h-8" />
                  </div>
                  <div className="text-center">
                    <h3 className="font-semibold text-neutral-200 text-lg">Click to Browse or Drag & Drop</h3>
                    <p className="text-sm text-neutral-500 mt-1">JPG, PNG, WebP • Auto-sorted alphabetically</p>
                  </div>
                </div>
              </div>

              {/* Audio Upload Pill */}
              <div 
                className="flex items-center gap-4 bg-white/[0.03] border border-white/5 rounded-xl p-3 cursor-pointer hover:bg-white/[0.06] transition-colors group"
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
                <div className="p-2.5 bg-blue-500/10 rounded-lg text-blue-400 group-hover:bg-blue-500/20 transition-colors shrink-0">
                  <Music className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-neutral-200 truncate">Background Audio Track</h3>
                  <p className="text-xs text-neutral-500 truncate">Optional • Select MP3, WAV</p>
                </div>
              </div>

              {/* Audio Files List */}
              {audioFiles.length > 0 && (
                <div className="space-y-2 max-h-32 overflow-y-auto custom-scrollbar pr-2">
                  {audioFiles.map((file, idx) => (
                    <div key={`${file.name}-${idx}`} className="flex items-center justify-between p-3 bg-black/40 border border-white/5 rounded-xl">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded font-mono shrink-0">Track {idx + 1}</span>
                        <span className="text-xs font-medium text-neutral-300 truncate">{file.name}</span>
                        <span className="text-[10px] text-neutral-500 shrink-0">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                      </div>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setAudioFiles(prev => prev.filter((_, i) => i !== idx));
                        }}
                        className="p-1.5 hover:bg-white/10 rounded-lg text-neutral-400 hover:text-rose-400 shrink-0 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Image Grid */}
              {images.length > 0 && (
                <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar pt-2">
                  {images.map((file, index) => (
                    <div key={`${file.name}-${index}`} className="relative group aspect-square rounded-xl overflow-hidden bg-black border border-white/10 shadow-lg">
                      <img 
                        src={imageUrls[index]} 
                        alt={file.name} 
                        className="w-full h-full object-cover group-hover:scale-110 group-hover:rotate-1 transition-all duration-500" 
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 backdrop-blur-[2px]">
                        <button 
                          onClick={(e) => { e.stopPropagation(); removeImage(index); }}
                          className="absolute top-2 right-2 p-1.5 bg-rose-500/80 hover:bg-rose-500 text-white rounded-lg transition-colors backdrop-blur-md shadow-lg"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                        <span className="absolute bottom-2 left-2 right-2 text-[10px] font-medium text-white truncate drop-shadow-md">
                          {file.name}
                        </span>
                      </div>
                      <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/60 backdrop-blur-md rounded-md text-[10px] font-mono font-bold text-white shadow-sm border border-white/10">
                        {index + 1}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 3. Timestamps / Durations */}
            <section className="glass-panel rounded-2xl p-6 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Clock className="w-5 h-5 text-cyan-400" />
                  Script / Durations
                </h2>
              </div>
              
              <div className="relative focus-ring-glow rounded-xl transition-all duration-300">
                <textarea 
                  className="w-full h-32 p-4 bg-black/50 border border-white/10 rounded-xl focus:outline-none text-sm font-mono text-neutral-200 resize-none placeholder:text-neutral-600 leading-relaxed custom-scrollbar"
                  placeholder="Paste timestamps (e.g. 1:55.438) or leave empty for uniform slide durations"
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 bg-white/[0.02] p-3 rounded-xl border border-white/5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">Parsed Timestamps:</span>
                  <span className="px-2.5 py-1 bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 rounded-md text-xs font-mono font-bold shadow-inner">
                    {durations.length}
                  </span>
                  {durations.length > 0 && (
                    <span className="text-xs text-neutral-500 font-mono">
                      (~{durations.reduce((a, b) => a + b, 0).toFixed(1)}s total)
                    </span>
                  )}
                </div>

                {durations.length === 0 && (
                  <div className="flex items-center gap-2 text-xs text-neutral-400">
                    <Clock className="w-3.5 h-3.5 text-cyan-500" />
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
                  <span className="text-amber-400 flex items-center gap-1.5 text-xs font-medium px-3 py-1 bg-amber-500/10 rounded-lg border border-amber-500/20">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {images.length} images vs {durations.length} timestamps
                  </span>
                )}
              </div>
            </section>

          </div>

          {/* RIGHT COLUMN: Transitions & Output (5 columns on extra large screens) */}
          <div className="xl:col-span-5 space-y-6">
            
            {/* 2. Video Transitions */}
            <section className="glass-panel rounded-2xl p-6 space-y-6 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-[50px] pointer-events-none" />
              
              <div className="flex flex-wrap items-center justify-between gap-2 relative z-10">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                    <Wand2 className="w-5 h-5 text-blue-400" />
                    Transitions
                  </h2>
                  {images.length > 1 && (
                    <span className="px-2 py-0.5 text-[10px] bg-blue-500/20 text-blue-300 border border-blue-500/30 rounded-md font-mono font-bold shadow-sm">
                      {transitions.filter(t => t !== "none").length} active
                    </span>
                  )}
                </div>

                {images.length > 1 && transitions.some(t => t !== "none") && (
                  <button
                    type="button"
                    onClick={handleResetTransitions}
                    className="px-3 py-1.5 text-xs font-medium bg-white/5 hover:bg-white/10 text-neutral-300 rounded-lg transition-colors border border-white/10"
                  >
                    Reset All
                  </button>
                )}
              </div>

              <p className="text-[11px] text-neutral-500 relative z-10 -mt-2">
                Each transition sits exactly on its cut — half from the outgoing image, half from the incoming
                (e.g. 0.3s = 0.15s + 0.15s). Totals always match your timestamps.
              </p>

              {/* Category Presets */}
              <div className="space-y-4 relative z-30">
                <div className="grid grid-cols-2 gap-3">
                  {TRANSITIONS_CONFIG.map((item) => {
                    const Icon = item.icon;
                    const dur = categoryDurations[item.id] || 0.5;
                    const count = transitions.filter(t => t === item.id).length;

                    return (
                      <div
                        key={item.id}
                        className={`glass-card p-3.5 rounded-xl border flex flex-col gap-3 ${item.border} relative z-10 focus-within:z-50 hover:z-40`}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className={`p-2 rounded-lg ${item.bg} ${item.color} shadow-inner`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-white">{item.name}</div>
                            <div className="text-[10px] text-neutral-400 font-mono mt-0.5">
                              {count} active
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2.5 mt-auto pt-2 border-t border-white/5">
                          {item.id !== "none" ? (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-neutral-400">Duration:</span>
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
                            <div className="text-[11px] text-neutral-500 py-1 font-mono">
                              Hard Cut (0s)
                            </div>
                          )}

                          {images.length > 1 && (
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => handleApplyToAll(item.id)}
                              className="w-full py-1.5 text-xs font-semibold bg-white/5 hover:bg-white/10 text-neutral-200 border border-white/5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                <div className="bg-black/30 rounded-xl border border-white/5 relative z-20">
                  <button
                    onClick={() => setShowAllCuts(!showAllCuts)}
                    className="w-full p-3 flex items-center justify-between text-xs font-semibold text-neutral-300 hover:bg-white/5 transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <Scissors className="w-3.5 h-3.5 text-blue-400" />
                      Individual Cut Settings
                    </span>
                    {showAllCuts ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  
                  {showAllCuts && (
                    <div className="p-3 border-t border-white/5 max-h-60 overflow-y-auto custom-scrollbar space-y-2 bg-black/20">
                      {transitions.map((trans, idx) => {
                        const imgFrom = images[idx]?.name || `Img ${idx + 1}`;
                        const imgTo = images[idx + 1]?.name || `Img ${idx + 2}`;
                        const isActive = trans !== "none";
                        const thisDur = categoryDurations[trans] || 0.5;

                        return (
                          <div key={idx} className="flex items-center justify-between p-2.5 bg-white/5 rounded-lg border border-white/5 hover:bg-white/10 transition-colors">
                            <div className="flex flex-col min-w-0 flex-1">
                              <span className="text-[10px] text-blue-400 font-mono font-bold">Cut #{idx + 1}</span>
                              <div className="flex items-center gap-1.5 text-xs text-neutral-300 mt-1">
                                <span className="truncate max-w-[80px]">{imgFrom}</span>
                                <span className="text-neutral-500">➔</span>
                                <span className="truncate max-w-[80px]">{imgTo}</span>
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
                                <span className="px-2 py-1 bg-white/5 border border-white/10 text-neutral-300 rounded-md text-[10px] font-mono shadow-inner min-w-[3rem] text-center">
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
                <div className="p-4 bg-white/5 rounded-xl border border-white/5 text-xs text-neutral-400 text-center relative z-20">
                  Upload at least 2 images to customize transitions.
                </div>
              )}
            </section>

            {/* 4. Generation & Output */}
            <section className="glass-panel rounded-2xl p-6 space-y-6 relative overflow-hidden">
               <div className="absolute bottom-0 right-0 w-40 h-40 bg-cyan-500/10 blur-[60px] pointer-events-none" />
               
               {error && (
                <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-3 backdrop-blur-md relative z-10">
                  <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-rose-400">Error</h3>
                    <p className="text-xs text-rose-300/80 mt-1">{error}</p>
                  </div>
                </div>
              )}
              
              {successMessage && (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-start gap-3 backdrop-blur-md relative z-10">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-emerald-400">Success</h3>
                    <p className="text-xs text-emerald-300/80 mt-1">{successMessage}</p>
                  </div>
                </div>
              )}

              {videoUrls.length > 0 ? (
                <div className="space-y-4 relative z-10">
                  {videoUrls.length > 1 && (
                    <button
                      onClick={handleDownloadAll}
                      disabled={downloadingAll || loading}
                      className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 active:scale-[0.99] text-white text-sm font-bold rounded-xl transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {downloadingAll ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Downloading {downloadingIndex !== null ? downloadingIndex + 1 : 1} of {videoUrls.length}...</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          <span>Download All ({videoUrls.length} chunks)</span>
                        </>
                      )}
                    </button>
                  )}
                  {videoUrls.map((url, index) => (
                    <div key={index} className="rounded-xl overflow-hidden bg-black/80 border border-white/10 shadow-2xl flex flex-col group backdrop-blur-md">
                      <div className="aspect-video relative flex items-center justify-center">
                        <video 
                          controls 
                          className="w-full h-full object-contain"
                          src={url}
                          controlsList="nodownload"
                        />
                      </div>
                      
                      <div className="bg-white/5 border-t border-white/10 p-4 flex items-center justify-between">
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 rounded-lg shadow-inner">
                          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                          <span className="text-[10px] font-mono font-bold text-neutral-300 tracking-wider">1080p READY</span>
                        </div>
                        
                        <div className="flex gap-2">
                          <button 
                            onClick={() => handleDownload(url, index)}
                            disabled={downloadingIndex === index || downloadingAll}
                            className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 active:scale-95 text-white text-xs font-bold rounded-lg transition-all shadow-[0_0_15px_rgba(59,130,246,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
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
                <div className="aspect-video bg-black/20 rounded-xl border border-dashed border-white/10 flex flex-col items-center justify-center text-neutral-500 gap-4 p-6 text-center relative z-10 shadow-inner">
                  <div className="p-4 bg-white/5 rounded-2xl shadow-inner">
                    <Video className="w-8 h-8 text-neutral-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-neutral-400">Video preview will appear here</p>
                    <p className="text-[11px] text-neutral-600 mt-1">Rendered in 1080p resolution</p>
                  </div>
                </div>
              )}

              <div className="pt-2 relative z-10 space-y-3">
                {/* Output mode: single video vs chunks */}
                <div className="bg-white/[0.03] border border-white/5 rounded-xl p-3">
                  <div className="text-xs font-semibold text-neutral-300 mb-2">Output Format</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setOutputMode("single")}
                      className={`px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                        outputMode === "single"
                          ? "bg-blue-500/20 text-blue-300 border-blue-500/40 shadow-[0_0_15px_rgba(59,130,246,0.25)]"
                          : "bg-white/5 text-neutral-400 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      <div>Single Video</div>
                      <div className="text-[10px] font-normal opacity-70 mt-0.5">Whole output in one file</div>
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setOutputMode("chunks")}
                      className={`px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                        outputMode === "chunks"
                          ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-[0_0_15px_rgba(34,211,238,0.25)]"
                          : "bg-white/5 text-neutral-400 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      <div>Chunks</div>
                      <div className="text-[10px] font-normal opacity-70 mt-0.5">Split per audio track</div>
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={loading || images.length === 0}
                  className={`relative w-full py-4 px-6 rounded-xl font-bold text-base overflow-hidden transition-all duration-300 flex items-center justify-center gap-3 shadow-2xl select-none group
                    ${loading 
                      ? 'bg-neutral-800 border border-blue-500/30 text-white cursor-wait' 
                      : images.length === 0
                        ? 'bg-white/5 border border-white/5 text-neutral-600 cursor-not-allowed'
                        : 'bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 active:scale-[0.98] text-white hover:shadow-[0_0_30px_rgba(34,211,238,0.4)] border border-white/10'
                    }
                  `}
                >
                  {/* Progress Fill Background */}
                  {loading && (
                    <div 
                      className="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-blue-600 to-cyan-600 transition-all duration-300 ease-out opacity-40" 
                      style={{ width: `${uploading ? uploadProgress : progress}%` }}
                    />
                  )}
                  
                  {/* Subtle shimmer effect when ready to generate */}
                  {!loading && images.length > 0 && (
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent group-hover:animate-[shimmer_2s_infinite] skew-x-12" />
                  )}
                  
                  <span className="relative z-10 flex items-center gap-2.5 tracking-wide text-shadow-sm">
                    {loading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-white" />
                        {uploading ? (
                          <span>Uploading ({uploadProgress}%)...</span>
                        ) : progress >= 0 ? (
                          <span>Generating Video... {Math.round(progress)}%</span>
                        ) : (
                          <span>Starting Engine...</span>
                        )}
                      </>
                    ) : (
                      <>
                        <Play className="w-5 h-5 fill-current" />
                        <span>Generate Masterpiece</span>
                      </>
                    )}
                  </span>
                </button>
                
                {loading && (
                  <div className="mt-4 space-y-2 px-2 text-xs font-mono">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-blue-400">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        {uploading
                          ? (uploadStatusText || 'Transferring media...')
                          : (stageDetail || (stage ? `${stage}...` : 'Encoding with FFmpeg Engine...'))}
                      </span>
                      {!uploading && progress > 0 && (
                        <span className="text-cyan-400 font-bold bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20 shadow-inner">
                          ETA: {formatEta(eta)}
                        </span>
                      )}
                    </div>
                    {!uploading && images.length > 50 && (
                      <div className="text-[11px] text-neutral-500">
                        Large job ({images.length} images with transitions renders in segments — progress updates per segment, preview chunks appear as they finish.
                      </div>
                    )}
                    <button
                      onClick={handleCancel}
                      className="w-full py-2 text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/20 rounded-lg transition-colors"
                    >
                      Cancel Job
                    </button>
                  </div>
                )}
              </div>

            </section>
          </div>

        </div>
      </main>
    </div>
  );
}
