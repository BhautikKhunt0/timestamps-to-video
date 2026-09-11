import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { exec, spawn } from "child_process";
import { createServer as createViteServer } from "vite";
import ffmpegPath from "ffmpeg-static";

import { WebSocketServer, WebSocket } from "ws";
import http from "http";

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

    const playlistPath = path.join(jobDir, "playlist.csv");
    const chunkPattern = path.join(jobDir, "chunk_%03d.mp4");

    let ffmpegArgs: string[] = ["-y", "-nostdin"];

    if (!hasActiveTransitions) {
      // MODE A: Ultra-fast concat demuxer (when all transitions are 'none' or single image)
      const concatTxtPath = path.join(jobDir, "concat.txt");
      let concatContent = "";
      
      for (let i = 0; i < normalizedFiles.length; i++) {
        concatContent += `file '${normalizedFiles[i].replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;
        concatContent += `duration ${finalDurations[i]}\n`;
      }
      concatContent += `file '${normalizedFiles[normalizedFiles.length - 1].replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;
      fs.writeFileSync(concatTxtPath, concatContent);

      ffmpegArgs.push(
        "-f", "concat",
        "-safe", "0",
        "-i", concatTxtPath
      );

      if (hasAudio) {
        audioFiles.forEach(f => {
          ffmpegArgs.push("-i", path.join(jobDir, f));
        });
      }

      ffmpegArgs = ffmpegArgs.concat([
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "18",
        "-tune", "stillimage",
        "-pix_fmt", "yuv420p"
      ]);
    } else {
      // MODE B: Pure video concat pipeline with pre-rendered holds and xfade transition clips
      // 1. Calculate per-transition durations ensuring each transition does not exceed 80% of adjacent clip durations
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

      // 2. Prepare micro-encode tasks for both static holds and active transition clips
      const tasks: { type: 'hold' | 'trans'; index: number; args: string[]; outPath: string }[] = [];

      for (let i = 0; i < normalizedFiles.length; i++) {
        const incomingHalf = i > 0 ? halfDurations[i - 1] : 0;
        const outgoingHalf = i < parsedTransitions.length ? halfDurations[i] : 0;
        const staticHold = Number(Math.max(0.04, finalDurations[i] - incomingHalf - outgoingHalf).toFixed(3));
        const holdPath = path.join(jobDir, `hold_${i}.mp4`);

        tasks.push({
          type: 'hold',
          index: i,
          outPath: holdPath,
          args: [
            "-y", "-nostdin",
            "-loop", "1", "-t", staticHold.toString(), "-i", normalizedFiles[i],
            "-r", "30", "-c:v", "libx264", "-preset", "ultrafast",
            "-tune", "stillimage", "-crf", "18", "-pix_fmt", "yuv420p",
            holdPath
          ]
        });

        if (i < parsedTransitions.length && parsedTransitions[i] !== "none") {
          const transPath = path.join(jobDir, `trans_${i}.mp4`);
          const dur = safeTransDurations[i];
          const transType = parsedTransitions[i];
          tasks.push({
            type: 'trans',
            index: i,
            outPath: transPath,
            args: [
              "-y", "-nostdin",
              "-loop", "1", "-t", dur.toString(), "-i", normalizedFiles[i],
              "-loop", "1", "-t", dur.toString(), "-i", normalizedFiles[i + 1],
              "-filter_complex", `[0:v][1:v]xfade=transition=${transType}:duration=${dur}:offset=0[v]`,
              "-map", "[v]",
              "-r", "30", "-c:v", "libx264", "-preset", "ultrafast",
              "-crf", "18", "-pix_fmt", "yuv420p",
              transPath
            ]
          });
        }
      }

      // 3. Render micro-encode tasks in parallel worker pool (concurrency 10)
      const BATCH_CONCURRENCY = 10;
      let completedTasks = 0;
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

          completedTasks++;
          const p = jobs.get(jobId);
          if (p) {
            p.progress = 15 + Math.round((completedTasks / tasks.length) * 35); // 15% to 50%
            p.lastUpdateTime = Date.now();
            broadcast(jobId, "progress", { progress: p.progress, eta: null });
          }
        }));
      }

      // 4. Assemble pure video concat.txt (all MP4s, 100% demuxer compatible)
      const concatTxtPath = path.join(jobDir, "concat.txt");
      let concatContent = "";
      for (let i = 0; i < normalizedFiles.length; i++) {
        const holdPath = path.join(jobDir, `hold_${i}.mp4`);
        concatContent += `file '${holdPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;

        if (i < parsedTransitions.length && parsedTransitions[i] !== "none") {
          const transPath = path.join(jobDir, `trans_${i}.mp4`);
          concatContent += `file '${transPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;
        }
      }
      fs.writeFileSync(concatTxtPath, concatContent);

      ffmpegArgs.push(
        "-f", "concat",
        "-safe", "0",
        "-i", concatTxtPath
      );

      if (hasAudio) {
        audioFiles.forEach(f => {
          ffmpegArgs.push("-i", path.join(jobDir, f));
        });
      }

      ffmpegArgs = ffmpegArgs.concat([
        "-c:v", "copy"
      ]);
    }

    if (hasAudio) {
      if (audioFiles.length === 1) {
        ffmpegArgs = ffmpegArgs.concat([
          "-c:a", "aac",
          "-b:a", "320k",
          "-af", "aresample=async=1000,apad"
        ]);
      } else {
        let filterComplexStr = "";
        let concatStreams = "";
        for (let i = 0; i < audioFiles.length; i++) {
          filterComplexStr += `[${i + 1}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
          concatStreams += `[a${i}]`;
        }
        filterComplexStr += `${concatStreams}concat=n=${audioFiles.length}:v=0:a=1,aresample=async=1000,apad[aout]`;
        
        ffmpegArgs = ffmpegArgs.concat([
          "-filter_complex", filterComplexStr,
          "-map", "0:v",
          "-map", "[aout]",
          "-c:a", "aac",
          "-b:a", "320k"
        ]);
      }
    }

    ffmpegArgs = ffmpegArgs.concat([
      "-shortest",
      "-t", totalDuration.toString(),
      "-f", "segment",
      "-segment_time", "120",
      "-segment_list", playlistPath,
      "-segment_list_type", "csv",
      "-reset_timestamps", "1",
      "-progress", "pipe:1",
      chunkPattern
    ]);

    const ffmpegProcess = spawn(ffmpegPath as string, ffmpegArgs);
    
    // Drain stderr to prevent the 64KB pipe buffer from filling up and hanging the process
    ffmpegProcess.stderr.on("data", () => {});
    
    let totalFrames = totalDuration * 30; // approx
    let knownChunks = new Set<string>();

    const chunkPoller = setInterval(() => {
      if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf8');
        const lines = content.trim().split('\n');
        lines.forEach(line => {
          const file = line.split(',')[0];
          if (file && !knownChunks.has(file)) {
            knownChunks.add(file);
            const chunkUrl = `/api/video/job/${jobId}/${file}`;
            
            // Add chunk to job record
            const job = jobs.get(jobId);
            if (job) {
              if (!job.chunks) job.chunks = [];
              if (!job.chunks.includes(chunkUrl)) job.chunks.push(chunkUrl);
            }
            
            broadcast(jobId, "chunk_ready", { chunkUrl });
          }
        });
      }
    }, 1000);

    ffmpegProcess.stdout.on("data", (data) => {
      const output = data.toString();
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        const frame = parseInt(frameMatch[1], 10);
        const basePct = hasActiveTransitions ? 50 : 15;
        const remainingPct = 99 - basePct;
        let currentProgress = basePct + Math.min(remainingPct, (frame / totalFrames) * remainingPct);
        
        const job = jobs.get(jobId);
        if (job && currentProgress > job.progress) {
          const now = Date.now();
          const elapsed = (now - job.startTime) / 1000;
          const pct = currentProgress / 100;
          let newEta = pct > 0 ? (elapsed / pct) - elapsed : 0;
          
          job.progress = Math.round(currentProgress);
          job.eta = newEta;
          job.lastUpdateTime = now;
          broadcast(jobId, "progress", { progress: job.progress, eta: newEta });
        }
      }
    });

    ffmpegProcess.on("close", (code) => {
      clearInterval(chunkPoller);
      // Final poll to catch last chunk
      if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf8');
        const lines = content.trim().split('\n');
        lines.forEach(line => {
          const file = line.split(',')[0];
          if (file && !knownChunks.has(file)) {
            knownChunks.add(file);
            const chunkUrl = `/api/video/job/${jobId}/${file}`;
            const job = jobs.get(jobId);
            if (job) {
              if (!job.chunks) job.chunks = [];
              if (!job.chunks.includes(chunkUrl)) job.chunks.push(chunkUrl);
            }
            broadcast(jobId, "chunk_ready", { chunkUrl });
          }
        });
      }

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
    });

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
