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
  const { jobId, durations } = req.body;
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

    // Pixel-perfect Normalization
    jobs.get(jobId).status = "normalizing";
    const normalizedFiles = [];
    
    // Normalize sequentially for simplicity and safety
    for (let i = 0; i < rawImages.length; i++) {
      const img = rawImages[i];
      const inPath = path.join(jobDir, img);
      const outPath = path.join(jobDir, `norm_${i}.png`);
      
      const filter = "scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(1920-iw)/2:(1080-ih)/2:black,setsar=1,format=yuv420p";
      const cmd = `"${ffmpegPath}" -y -i "${inPath}" -vf "${filter}" -vframes 1 "${outPath}"`;
      
      await new Promise((resolve, reject) => {
        exec(cmd, (err) => {
          if (err) reject(err);
          else resolve(null);
        });
      });
      normalizedFiles.push(outPath);
      
      const p = jobs.get(jobId);
      if (p) {
        p.progress = Math.round(((i + 1) / rawImages.length) * 15); // Normalization is first 15%
        p.lastUpdateTime = Date.now();
        broadcast(jobId, "progress", { progress: p.progress, eta: null });
      }
    }

    // Build concat.txt EXACTLY
    const concatTxtPath = path.join(jobDir, "concat.txt");
    let concatContent = "";
    let totalDuration = 0;
    
    for (let i = 0; i < normalizedFiles.length; i++) {
      concatContent += `file '${normalizedFiles[i].replace(/'/g, "'\\''")}'\n`;
      concatContent += `duration ${finalDurations[i]}\n`;
      totalDuration += finalDurations[i];
    }
    // FFmpeg concat requires the last file to be repeated without duration
    concatContent += `file '${normalizedFiles[normalizedFiles.length - 1].replace(/'/g, "'\\''")}'\n`;
    
    fs.writeFileSync(concatTxtPath, concatContent);

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

    // We will segment the output into approx 120 second chunks
    const playlistPath = path.join(jobDir, "playlist.csv");
    const chunkPattern = path.join(jobDir, "chunk_%03d.mp4");

    let ffmpegArgs = [
      "-y", "-nostdin",
      "-f", "concat",
      "-safe", "0",
      "-i", concatTxtPath
    ];

    if (hasAudio) {
      if (audioFiles.length === 1) {
        ffmpegArgs.push("-i", path.join(jobDir, audioFiles[0]));
      } else {
        audioFiles.forEach(f => {
          ffmpegArgs.push("-i", path.join(jobDir, f));
        });
      }
    }

    ffmpegArgs = ffmpegArgs.concat([
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p"
    ]);

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
          // Normalize sample rate and channels BEFORE concat to prevent dropping streams
          filterComplexStr += `[${i + 1}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
          concatStreams += `[a${i}]`;
        }
        // Concat the normalized streams and add apad to fill any remaining video duration with silence
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
      "-segment_time", "240",
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
        let currentProgress = 15 + Math.min(84, (frame / totalFrames) * 84); // 15% to 99%
        
        const job = jobs.get(jobId);
        if (job && currentProgress > job.progress) {
          const now = Date.now();
          const elapsed = (now - job.startTime) / 1000;
          const pct = currentProgress / 100;
          let newEta = pct > 0 ? (elapsed / pct) - elapsed : 0;
          
          job.progress = currentProgress;
          job.eta = newEta;
          job.lastUpdateTime = now;
          broadcast(jobId, "progress", { progress: currentProgress, eta: newEta });
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
