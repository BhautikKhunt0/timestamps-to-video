import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { exec, spawn } from "child_process";
import { createServer as createViteServer } from "vite";
import ffmpegPath from "ffmpeg-static";

import { WebSocketServer, WebSocket } from "ws";
import http from "http";


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

app.use(express.json());

const UPLOAD_DIR = path.join(process.cwd(), "output");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobId = req.body.jobId;
    if (!jobId) return cb(new Error("Missing jobId"), "");
    const jobDir = path.join(UPLOAD_DIR, jobId);
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
    cb(null, jobDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

const jobs = new Map();

// Generate unique job ID
app.get("/api/init-job", (req, res) => {
  const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
  const jobDir = path.join(UPLOAD_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  res.json({ jobId });
});

// Upload images in batch
app.post("/api/upload-batch", upload.array("images"), (req, res) => {
  try {
    const { indices, jobId } = req.body;
    const parsedIndices = indices ? JSON.parse(indices) : [];
    
    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const jobDir = path.join(UPLOAD_DIR, jobId);
    const files = req.files as Express.Multer.File[];
    
    files.forEach((file, i) => {
      const originalIndex = parsedIndices[i] !== undefined ? parsedIndices[i] : i;
      const ext = path.extname(file.originalname);
      const newPath = path.join(jobDir, `raw_${originalIndex}${ext}`);
      fs.renameSync(file.path, newPath);
    });

    res.json({ success: true, count: files.length, indices: parsedIndices });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to process batch upload" });
  }
});

// Upload audio
app.post("/api/upload-audio", upload.array("audio", 50), (req, res) => {
  try {
    const { jobId } = req.body;
    if (!req.files || !Array.isArray(req.files) || !jobId) {
      return res.status(400).json({ error: "Missing files or jobId" });
    }
    const jobDir = path.join(UPLOAD_DIR, jobId);
    
    // Make sure we keep multiple audio files in sequence
    // First, find what max audio index currently exists to allow appending if needed
    const existingAudio = fs.existsSync(jobDir) 
      ? fs.readdirSync(jobDir).filter(f => f.startsWith("audio_"))
      : [];
    let startIndex = existingAudio.length;

    const files = req.files as Express.Multer.File[];
    files.forEach((file) => {
      const ext = path.extname(file.originalname);
      const newPath = path.join(jobDir, `audio_${startIndex}${ext}`);
      fs.renameSync(file.path, newPath);
      startIndex++;
    });

    res.json({ success: true, count: files.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to upload audio" });
  }
});

app.post("/api/generate", async (req, res) => {
  const { jobId, durations, transitions, transitionDurations, transitionDuration } = req.body;
  if (!jobId || !durations || !Array.isArray(durations)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const jobDir = path.join(UPLOAD_DIR, jobId);
  if (!fs.existsSync(jobDir)) {
    return res.status(400).json({ error: "Job directory not found" });
  }

  res.json({ message: "Started", jobId });

  jobs.set(jobId, {
    status: "processing",
    progress: 0,
    eta: null,
    chunks: [],
    startTime: Date.now(),
    lastUpdateTime: Date.now()
  });

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

    let finalDurations = [...durations];
    while (finalDurations.length < rawImages.length) {
      finalDurations.push(finalDurations[finalDurations.length - 1] || 5);
    }
    finalDurations = finalDurations.slice(0, rawImages.length);

    // Calculate total duration
    const totalDuration = Number(finalDurations.reduce((acc, d) => acc + d, 0).toFixed(3));

    // Pixel-perfect Normalization
    jobs.get(jobId).status = "normalizing";
    const normalizedFiles = [];
    
    // Normalize in batches to avoid overwhelming the CPU
    const CONCURRENCY_LIMIT = 5;
    for (let i = 0; i < rawImages.length; i += CONCURRENCY_LIMIT) {
      const batch = rawImages.slice(i, i + CONCURRENCY_LIMIT);
      
      await Promise.all(batch.map(async (img, batchIndex) => {
        const globalIndex = i + batchIndex;
        const inPath = path.join(jobDir, img);
        const outPath = path.join(jobDir, `norm_${globalIndex}.png`);
        
        const filter = "scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(1920-iw)/2:(1080-ih)/2:black,setsar=1,format=yuv420p";
        const cmd = `"${ffmpegPath}" -y -i "${inPath}" -vf "${filter}" -vframes 1 "${outPath}"`;
        
        await new Promise((resolve, reject) => {
          exec(cmd, (err) => {
            if (err) reject(err);
            else resolve(null);
          });
        });
        
        normalizedFiles[globalIndex] = outPath;
      }));
      
      const p = jobs.get(jobId);
      if (p) {
        p.progress = Math.round((Math.min(i + CONCURRENCY_LIMIT, rawImages.length) / rawImages.length) * 15); // Normalization is first 15%
        p.lastUpdateTime = Date.now();
        broadcast(jobId, "progress", { progress: p.progress, eta: null });
      }
    }

    // Process Transitions
    const allowedTransitions = new Set(["none", "fade", "smoothleft", "smoothright", "slideleft", "slideright"]);
    let parsedTransitions: string[] = [];
    if (Array.isArray(transitions)) {
      parsedTransitions = transitions.map(t => allowedTransitions.has(t) ? t : "none");
    }
    while (parsedTransitions.length < normalizedFiles.length - 1) {
      parsedTransitions.push("none");
    }
    parsedTransitions = parsedTransitions.slice(0, normalizedFiles.length - 1);

    const rawTransDurs = Array.isArray(transitionDurations) ? transitionDurations : [];
    const baseTransDuration = typeof transitionDuration === "number" && transitionDuration > 0
      ? transitionDuration
      : 0.5;

    const hasActiveTransitions = normalizedFiles.length > 1 && parsedTransitions.some(t => t !== "none");

    // Check for audio
    const audioFiles = files
      .filter(f => f.startsWith("audio_") || f.startsWith("audio."))
      .sort((a, b) => {
        const matchA = a.match(/audio_(\d+)/);
        const matchB = b.match(/audio_(\d+)/);
        const numA = matchA ? parseInt(matchA[1], 10) : 0;
        const numB = matchB ? parseInt(matchB[1], 10) : 0;
        return numA - numB;
      });
      
    const hasAudio = audioFiles.length > 0;
    const audioDurations: number[] = [];
    if (hasAudio) {
      for (const f of audioFiles) {
        const dur = await getMediaDuration(path.join(jobDir, f));
        audioDurations.push(dur);
      }
    }

    if (!hasActiveTransitions) {
      // MODE A: Ultra-fast concat demuxer (when all transitions are 'none' or single image)
      
      const rawBlocks = [];
      for (let i = 0; i < normalizedFiles.length; i++) {
        rawBlocks.push({ type: 'image', imgIndex: i, dur: finalDurations[i] });
      }

      const chunks: any[] = [];
      let currentChunkIdx = 0;
      let currentAudioTarget = audioDurations[currentChunkIdx] || 120;
      let currentChunkTime = 0;
      let currentChunkBlocks: any[] = [];

      for (const block of rawBlocks) {
        let remainingDur = block.dur;
        
        while (remainingDur > 0.001) {
          let spaceLeft = currentAudioTarget - currentChunkTime;
          
          if (spaceLeft <= 0.001) {
            chunks.push({ index: currentChunkIdx, audio: audioFiles[currentChunkIdx], blocks: currentChunkBlocks, targetDur: currentAudioTarget });
            currentChunkIdx++;
            currentAudioTarget = audioDurations[currentChunkIdx] || 120;
            currentChunkTime = 0;
            currentChunkBlocks = [];
            spaceLeft = currentAudioTarget;
          }
          
          let take = Math.min(remainingDur, spaceLeft);
          
          currentChunkBlocks.push({
            type: block.type,
            imgIndex: block.imgIndex,
            dur: take,
            isSplit: take < block.dur,
            originalDur: block.dur
          });
          
          remainingDur -= take;
          currentChunkTime += take;
        }
      }
      if (currentChunkBlocks.length > 0) {
        chunks.push({ index: currentChunkIdx, audio: audioFiles[currentChunkIdx], blocks: currentChunkBlocks, targetDur: currentChunkTime });
      }

      const job = jobs.get(jobId);
      if (job) job.chunks = [];

      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        const concatTxtPath = path.join(jobDir, `concat_chunk_${c}.txt`);
        let concatContent = "";
        
        chunk.blocks.forEach((block: any) => {
          concatContent += `file '${normalizedFiles[block.imgIndex].replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;
          concatContent += `duration ${block.dur}\n`;
        });
        // concat demuxer requires the last file to be repeated without duration
        if (chunk.blocks.length > 0) {
           const lastBlock = chunk.blocks[chunk.blocks.length - 1];
           concatContent += `file '${normalizedFiles[lastBlock.imgIndex].replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;
        }
        fs.writeFileSync(concatTxtPath, concatContent);

        const chunkFileName = `chunk_${c.toString().padStart(3, '0')}.mp4`;
        const chunkOutPath = path.join(jobDir, chunkFileName);

        let ffmpegArgs = [
          "-y", "-nostdin",
          "-f", "concat", "-safe", "0", "-i", concatTxtPath
        ];

        if (chunk.audio) {
          ffmpegArgs.push("-i", path.join(jobDir, chunk.audio));
        }

        ffmpegArgs = ffmpegArgs.concat([
          "-r", "30",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "18",
          "-tune", "stillimage",
          "-pix_fmt", "yuv420p"
        ]);

        if (chunk.audio) {
          ffmpegArgs.push("-c:a", "aac", "-b:a", "320k", "-shortest");
        }

        ffmpegArgs.push(chunkOutPath);

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegPath as string, ffmpegArgs);
          proc.stderr.on("data", () => {});
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Failed rendering final chunk ${c}`));
          });
        });

        const chunkUrl = `/api/video/job/${jobId}/${chunkFileName}`;
        if (job) job.chunks.push(chunkUrl);
        broadcast(jobId, "chunk_ready", { chunkUrl });
        
        if (job) {
           job.progress = 15 + Math.round(((c + 1) / chunks.length) * 85);
           broadcast(jobId, "progress", { progress: job.progress, eta: null });
        }
      }

    } else {
      // MODE B: Pure video concat pipeline with pre-rendered holds and xfade transition clips
      const safeTransDurations: number[] = [];
      for (let i = 0; i < parsedTransitions.length; i++) {
        if (parsedTransitions[i] !== "none") {
          const requested = typeof rawTransDurs[i] === "number" && rawTransDurs[i] > 0
            ? rawTransDurs[i]
            : baseTransDuration;
          const maxAllowed = Math.min(finalDurations[i], finalDurations[i + 1]) * 0.8;
          safeTransDurations[i] = Number(Math.min(requested, Math.max(0.15, maxAllowed)).toFixed(3));
        } else {
          safeTransDurations[i] = 0;
        }
      }
      const halfDurations = safeTransDurations.map(d => Number((d / 2).toFixed(3)));

      const rawBlocks = [];
      for (let i = 0; i < normalizedFiles.length; i++) {
        const incomingHalf = i > 0 ? halfDurations[i - 1] : 0;
        const outgoingHalf = i < parsedTransitions.length ? halfDurations[i] : 0;
        const staticHold = Number(Math.max(0.04, finalDurations[i] - incomingHalf - outgoingHalf).toFixed(3));
        rawBlocks.push({ type: 'hold', imgIndex: i, dur: staticHold });

        if (i < parsedTransitions.length && parsedTransitions[i] !== "none") {
          const dur = safeTransDurations[i];
          rawBlocks.push({ type: 'trans', imgIndex: i, dur: dur });
        }
      }

      const chunks: { index: number, audio: string, blocks: any[], targetDur: number }[] = [];
      let currentChunkIdx = 0;
      let currentAudioTarget = audioDurations[currentChunkIdx] || 120;
      let currentChunkTime = 0;
      let currentChunkBlocks: any[] = [];

      for (const block of rawBlocks) {
        let remainingDur = block.dur;
        
        while (remainingDur > 0.001) {
          let spaceLeft = currentAudioTarget - currentChunkTime;
          
          if (spaceLeft <= 0.001) {
            chunks.push({ index: currentChunkIdx, audio: audioFiles[currentChunkIdx], blocks: currentChunkBlocks, targetDur: currentAudioTarget });
            currentChunkIdx++;
            currentAudioTarget = audioDurations[currentChunkIdx] || 120;
            currentChunkTime = 0;
            currentChunkBlocks = [];
            spaceLeft = currentAudioTarget;
          }
          
          let take = Math.min(remainingDur, spaceLeft);
          
          if (block.type === 'trans' && take < remainingDur) {
            take = remainingDur; 
          }
          
          currentChunkBlocks.push({
            type: block.type,
            imgIndex: block.imgIndex,
            dur: take,
            isSplit: take < block.dur,
            originalDur: block.dur
          });
          
          remainingDur -= take;
          currentChunkTime += take;
        }
      }
      
      if (currentChunkBlocks.length > 0) {
        chunks.push({ index: currentChunkIdx, audio: audioFiles[currentChunkIdx], blocks: currentChunkBlocks, targetDur: currentChunkTime });
      }

      const tasks: { type: 'hold' | 'trans'; index: number; args: string[]; outPath: string }[] = [];
      let holdSubId = 0;

      chunks.forEach(chunk => {
        chunk.blocks.forEach(block => {
          if (block.type === 'hold') {
            const outPath = path.join(jobDir, `hold_${block.imgIndex}_${holdSubId++}.mp4`);
            block.outPath = outPath;
            tasks.push({
              type: 'hold',
              index: block.imgIndex,
              outPath: outPath,
              args: [
                "-y", "-nostdin",
                "-loop", "1", "-t", block.dur.toString(), "-i", normalizedFiles[block.imgIndex],
                "-r", "30", "-c:v", "libx264", "-preset", "ultrafast",
                "-tune", "stillimage", "-crf", "18", "-pix_fmt", "yuv420p",
                outPath
              ]
            });
          } else if (block.type === 'trans') {
            const outPath = path.join(jobDir, `trans_${block.imgIndex}.mp4`);
            block.outPath = outPath;
            if (!tasks.find(t => t.outPath === outPath)) {
              tasks.push({
                type: 'trans',
                index: block.imgIndex,
                outPath: outPath,
                args: [
                  "-y", "-nostdin",
                  "-loop", "1", "-t", block.dur.toString(), "-i", normalizedFiles[block.imgIndex],
                  "-loop", "1", "-t", block.dur.toString(), "-i", normalizedFiles[block.imgIndex + 1],
                  "-filter_complex", `[0:v][1:v]xfade=transition=${parsedTransitions[block.imgIndex]}:duration=${block.dur}:offset=0[v]`,
                  "-map", "[v]",
                  "-r", "30", "-c:v", "libx264", "-preset", "ultrafast",
                  "-crf", "18", "-pix_fmt", "yuv420p",
                  outPath
                ]
              });
            }
          }
        });
      });

      const BATCH_CONCURRENCY = 10;
      let completedMicroTasks = 0;
      for (let i = 0; i < tasks.length; i += BATCH_CONCURRENCY) {
        const batch = tasks.slice(i, i + BATCH_CONCURRENCY);
        await Promise.all(batch.map(async (task) => {
          await new Promise<void>((resolve, reject) => {
            const proc = spawn(ffmpegPath as string, task.args);
            proc.stderr.on("data", () => {});
            proc.on("error", reject);
            proc.on("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`Failed rendering ${task.type}_${task.index} (code ${code})`));
            });
          });

          completedMicroTasks++;
          const p = jobs.get(jobId);
          if (p) {
            p.progress = 15 + Math.round((completedMicroTasks / tasks.length) * 35);
            p.lastUpdateTime = Date.now();
            broadcast(jobId, "progress", { progress: p.progress, eta: null });
          }
        }));
      }

      const job = jobs.get(jobId);
      if (job) job.chunks = [];

      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        const concatTxtPath = path.join(jobDir, `concat_chunk_${c}.txt`);
        let concatContent = "";
        
        chunk.blocks.forEach(block => {
          concatContent += `file '${block.outPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;
        });
        fs.writeFileSync(concatTxtPath, concatContent);

        const chunkFileName = `chunk_${c.toString().padStart(3, '0')}.mp4`;
        const chunkOutPath = path.join(jobDir, chunkFileName);

        let ffmpegArgs = [
          "-y", "-nostdin",
          "-f", "concat", "-safe", "0", "-i", concatTxtPath
        ];

        if (chunk.audio) {
          ffmpegArgs.push("-i", path.join(jobDir, chunk.audio));
        }

        ffmpegArgs.push("-c:v", "copy");

        if (chunk.audio) {
          ffmpegArgs.push("-c:a", "aac", "-b:a", "320k", "-shortest");
        }

        ffmpegArgs.push(chunkOutPath);

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegPath as string, ffmpegArgs);
          proc.stderr.on("data", () => {});
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Failed rendering final chunk ${c}`));
          });
        });

        const chunkUrl = `/api/video/job/${jobId}/${chunkFileName}`;
        if (job) job.chunks.push(chunkUrl);
        broadcast(jobId, "chunk_ready", { chunkUrl });
        
        if (job) {
           job.progress = 50 + Math.round(((c + 1) / chunks.length) * 50);
           broadcast(jobId, "progress", { progress: job.progress, eta: null });
        }
      }
    }

    let code = 0;
    const job = jobs.get(jobId);
    if (code === 0) {
        if (job) {
          job.status = "completed";
          job.progress = 100;
          job.eta = 0;
          job.lastUpdateTime = Date.now();
          broadcast(jobId, "complete", { chunks: job.chunks });
        }
      } else {
        if (job) {
          job.status = "error";
          job.error = "FFmpeg process failed";
          job.lastUpdateTime = Date.now();
          broadcast(jobId, "error", { error: job.error });
        }
      }
  } catch (error: any) {
    const job = jobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = error.message;
      job.lastUpdateTime = Date.now();
      broadcast(jobId, "error", { error: error.message });
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
