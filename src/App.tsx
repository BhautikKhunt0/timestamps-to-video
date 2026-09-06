import React, { useState, useRef, useEffect } from "react";
import { Upload, FileVideo, AlertCircle, Loader2, Video, X, CheckCircle2, Download, Play, Music, RefreshCw, ExternalLink, Clock, Layers } from "lucide-react";
import { parseTimestamps } from "./utils/parser";

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

export default function App() {
  const [images, setImages] = useState<File[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [script, setScript] = useState("");
  const [defaultDurationPerImage, setDefaultDurationPerImage] = useState(5);
  
  const [audioFiles, setAudioFiles] = useState<File[]>([]);

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
  
  const [downloadingIndex, setDownloadingIndex] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  
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
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
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
    setUploadProgress(0);
    
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

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.jobId === jobId) {
            if (data.type === "progress") {
              setProgress(data.progress);
              if (data.eta !== undefined) setEta(data.eta);
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
              setSuccessMessage("Video segments generated successfully!");
              setLoading(false);
              ws.close();
            } else if (data.type === "error") {
              setError("Generation failed: " + (data.error || "Unknown error"));
              setLoading(false);
              ws.close();
            }
          }
        } catch (e) {}
      };

      activeEventSourceRef.current = ws as any;

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          jobId,
          durations: finalDurations
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
      stopActiveTracking();
    }
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
      // Add download query param so the server sets Content-Disposition attachment
      link.href = url + "?download=1";
      link.download = `rendered_video_${index + 1}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Download error:', err);
      alert('Failed to download video. You can still right-click the video and save it.');
    } finally {
      // Small timeout to allow the click to register before clearing the loading state
      setTimeout(() => {
        setDownloadingIndex(null);
        setDownloadProgress(0);
      }, 1000);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-neutral-200 font-sans selection:bg-indigo-500/30">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10">
          <div className="lg:col-span-7 space-y-8">
            <div className="bg-neutral-800/40 p-5 sm:p-6 rounded-2xl border border-neutral-700/40 shadow-sm space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Layers className="w-5 h-5 text-indigo-400" />
                  1. Media Assets
                </h2>
                {images.length > 0 && (
                  <button 
                    onClick={() => {
                      setImages([]);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="text-xs font-semibold text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 px-2.5 py-1 rounded transition-colors"
                  >
                    Clear All
                  </button>
                )}
              </div>
              
              <div 
                id="drop-zone"
                className="border-2 border-dashed border-neutral-700 hover:border-indigo-500/60 bg-neutral-900/40 hover:bg-indigo-950/10 rounded-xl p-6 sm:p-8 text-center cursor-pointer transition-all duration-200"
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
              >
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  multiple 
                  accept="image/*"
                  onChange={handleImageChange}
                  className="hidden" 
                />
                <div className="flex flex-col items-center gap-2.5">
                  <div className="p-3 bg-neutral-800 rounded-full text-neutral-400 group-hover:text-indigo-400">
                    <Upload className="w-6 h-6" />
                  </div>
                  <span className="font-medium text-sm text-neutral-200">
                    Click to browse or drag & drop images
                  </span>
                  <span className="text-xs text-neutral-500">
                    JPG, PNG, WebP • Auto-sorted alphabetically (1.jpg, 2.jpg...)
                  </span>
                </div>
              </div>

              {/* Audio Upload */}
              <div className="pt-2 border-t border-neutral-700/40">
                <div 
                  className="mt-3 flex items-center gap-4 bg-neutral-900/60 border border-neutral-700/60 rounded-xl p-4 cursor-pointer hover:border-indigo-500/50 transition-colors"
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
                  <div className="p-2.5 bg-neutral-800 rounded-full text-indigo-400 shrink-0">
                    <Music className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-neutral-200 truncate">
                      Add Background Audio (Optional)
                    </h3>
                    <p className="text-xs text-neutral-500 truncate">
                      Click to select MP3, WAV, AAC (Multiple files supported)
                    </p>
                  </div>
                </div>

                {audioFiles.length > 0 && (
                  <div className="mt-3 space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                    {audioFiles.map((file, idx) => (
                      <div key={`${file.name}-${idx}`} className="flex items-center justify-between p-2.5 bg-neutral-900 border border-neutral-800 rounded-lg">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded font-mono shrink-0">
                            {idx + 1}
                          </span>
                          <span className="text-xs font-medium text-neutral-300 truncate">
                            {file.name}
                          </span>
                          <span className="text-[10px] text-neutral-500 shrink-0">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </span>
                        </div>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setAudioFiles(prev => prev.filter((_, i) => i !== idx));
                          }}
                          className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-red-400 shrink-0 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {images.length > 0 && (
                <div className="pt-2">
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                    {images.map((file, index) => (
                      <div key={`${file.name}-${index}`} className="relative group aspect-square rounded-lg overflow-hidden bg-neutral-900 border border-neutral-800">
                        <img 
                          src={imageUrls[index]} 
                          alt={file.name} 
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" 
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <button 
                            onClick={(e) => { e.stopPropagation(); removeImage(index); }}
                            className="absolute top-1.5 right-1.5 p-1 bg-black/60 hover:bg-red-500 text-white rounded-full transition-colors backdrop-blur-sm"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <span className="absolute bottom-1.5 left-2 right-2 text-[10px] font-mono text-white truncate drop-shadow-md">
                            {file.name}
                          </span>
                        </div>
                        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/70 backdrop-blur-md rounded text-[10px] font-mono text-neutral-300">
                          {index + 1}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-neutral-800/40 p-5 sm:p-6 rounded-2xl border border-neutral-700/40 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Clock className="w-5 h-5 text-indigo-400" />
                  2. Exact Timestamps
                </h2>
              </div>
              
              <textarea 
                className="w-full h-36 p-3.5 bg-neutral-900/90 border border-neutral-700 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-xs sm:text-sm font-mono text-neutral-200 resize-none placeholder:text-neutral-600 leading-relaxed"
                placeholder="Paste timestamps (e.g. 1:55.438) or leave empty for uniform slide durations"
                value={script}
                onChange={(e) => setScript(e.target.value)}
              />

              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-neutral-400">Parsed Timestamps:</span>
                  <span className="px-2 py-0.5 bg-indigo-950/80 text-indigo-300 border border-indigo-800/60 rounded font-mono font-semibold">
                    {durations.length}
                  </span>
                  {durations.length > 0 && (
                    <span className="text-neutral-500 font-mono">
                      (Total: ~{durations.reduce((a, b) => a + b, 0).toFixed(1)}s)
                    </span>
                  )}
                </div>

                {durations.length === 0 && (
                  <div className="flex items-center gap-2 text-neutral-400">
                    <Clock className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Default duration:</span>
                    <select
                      value={defaultDurationPerImage}
                      onChange={(e) => setDefaultDurationPerImage(Number(e.target.value))}
                      className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 text-neutral-200 text-xs font-mono"
                    >
                      <option value={2}>2s / image</option>
                      <option value={3}>3s / image</option>
                      <option value={4}>4s / image</option>
                      <option value={5}>5s / image</option>
                      <option value={8}>8s / image</option>
                      <option value={10}>10s / image</option>
                    </select>
                  </div>
                )}

                {durations.length > 0 && images.length > 0 && durations.length !== images.length && (
                  <span className="text-amber-400 flex items-center gap-1 font-medium">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {images.length} images vs {durations.length} timestamps (auto-aligned)
                  </span>
                )}
              </div>
            </div>

          </div>

          <div className="lg:col-span-5 space-y-6">
            <div className="bg-neutral-800/60 backdrop-blur-sm p-5 sm:p-6 rounded-2xl border border-neutral-700/60 shadow-xl space-y-6 sticky top-8">
              
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Video className="w-5 h-5 text-indigo-400" />
                  3. Preview & Export
                </h2>
                {videoUrls.length > 0 && !loading && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2.5 py-1 rounded-full font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Ready
                  </span>
                )}
              </div>

              {error && (
                <div className="p-4 bg-red-950/50 border border-red-900/50 rounded-xl flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-red-400">Error</h3>
                    <p className="text-xs text-red-300 mt-1 break-words">{error}</p>
                  </div>
                </div>
              )}
              
              {successMessage && (
                <div className="p-4 bg-emerald-950/40 border border-emerald-900/50 rounded-xl flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-emerald-400">Success</h3>
                    <p className="text-xs text-emerald-300/80 mt-1">{successMessage}</p>
                  </div>
                </div>
              )}

              {videoUrls.length > 0 ? (
                <div className="space-y-4">
                  {videoUrls.map((url, index) => (
                    <div key={index} className="rounded-xl overflow-hidden bg-black border border-neutral-700/50 shadow-2xl flex flex-col group">
                      <div className="aspect-video bg-black relative flex items-center justify-center group">
                        <video 
                          controls 
                          className="w-full h-full object-contain"
                          src={url}
                          controlsList="nodownload"
                        >
                          Your browser does not support the video tag.
                        </video>
                      </div>
                      
                      <div className="bg-neutral-900 border-t border-neutral-800 p-3 flex items-center justify-between">
                        <div className="flex items-center gap-2 px-2.5 py-1 bg-neutral-800 rounded-md">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          <span className="text-[11px] font-mono font-medium text-neutral-300 uppercase tracking-wider">HD 1080p</span>
                        </div>
                        
                        <div className="flex gap-2">
                          <a 
                            href={url} 
                            target="_blank" 
                            rel="noreferrer"
                            className="p-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white rounded-lg transition-colors flex items-center justify-center shadow-sm"
                            title="Open in new tab"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                          <button 
                            onClick={() => handleDownload(url, index)}
                            disabled={downloadingIndex === index}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-xs font-semibold rounded-lg transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {downloadingIndex === index ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Downloading... {downloadProgress > 0 ? `${Math.round(downloadProgress)}%` : ''}</span>
                              </>
                            ) : (
                              <>
                                <Download className="w-3.5 h-3.5" />
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
                <div className="aspect-video bg-neutral-900/60 rounded-xl border-2 border-dashed border-neutral-800 flex flex-col items-center justify-center text-neutral-500 gap-3 p-6 text-center">
                  <div className="p-4 bg-neutral-800/60 rounded-full">
                    <Video className="w-8 h-8 text-neutral-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-neutral-300">Video output will appear here</p>
                    <p className="text-xs text-neutral-500 mt-1">
                      Rendered in precise 1080p {audioFiles.length > 0 ? "with Audio Sync" : "H.264 MP4"}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-2.5 pt-4">
                <button
                  id="generate-video-btn"
                  onClick={handleGenerate}
                  disabled={loading || images.length === 0}
                  className={`relative w-full py-4 px-6 rounded-xl font-bold text-sm sm:text-base overflow-hidden transition-all duration-200 flex items-center justify-center gap-2.5 shadow-lg select-none
                    ${loading 
                      ? 'bg-neutral-800 border border-indigo-500/40 text-white cursor-wait' 
                      : images.length === 0
                        ? 'bg-neutral-800/80 border border-neutral-700/60 text-neutral-500 cursor-not-allowed'
                        : 'bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white hover:shadow-indigo-500/20'
                    }
                  `}
                >
                  {loading && (
                    <div 
                      className="absolute left-0 top-0 bottom-0 bg-indigo-600 transition-all duration-150 ease-out opacity-90" 
                      style={{ width: `${uploading ? uploadProgress : progress}%` }}
                    />
                  )}
                  
                  <span className="relative z-10 flex items-center gap-2 tracking-wide">
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
                        <span>Generate Video</span>
                      </>
                    )}
                  </span>
                </button>
                {loading && (
                  <div className="flex items-center justify-between px-1 text-xs text-neutral-400">
                    <span className="flex items-center gap-1.5 text-neutral-400">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                      {uploading ? (uploadStatusText || 'Transferring media...') : 'Encoding with FFmpeg...'}
                    </span>
                    {!uploading && progress > 0 && (
                      <span className="font-mono text-indigo-300 font-medium">
                        {formatEta(eta)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
