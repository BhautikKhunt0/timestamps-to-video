const fs = require('fs');

const serverCode = `
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { exec, spawn } from "child_process";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

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
      const newPath = path.join(jobDir, \`raw_\${originalIndex}\${ext}\`);
      fs.renameSync(file.path, newPath);
    });

    res.json({ success: true, count: files.length, indices: parsedIndices });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to process batch upload" });
  }
});

// Upload audio
app.post("/api/upload-audio", upload.single("audio"), (req, res) => {
  try {
    const { jobId } = req.body;
    if (!req.file || !jobId) {
      return res.status(400).json({ error: "Missing file or jobId" });
    }
    const jobDir = path.join(UPLOAD_DIR, jobId);
    const ext = path.extname(req.file.originalname);
    const newPath = path.join(jobDir, \`audio\${ext}\`);
    fs.renameSync(req.file.path, newPath);
    res.json({ success: true, audioPath: newPath });
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
        const numA = parseInt(a.replace(/\\D/g, ""), 10);
        const numB = parseInt(b.replace(/\\D/g, ""), 10);
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
    
    // Normalize in batches to avoid overwhelming the CPU
    const CONCURRENCY_LIMIT = 5;
    for (let i = 0; i < rawImages.length; i += CONCURRENCY_LIMIT) {
      const batch = rawImages.slice(i, i + CONCURRENCY_LIMIT);
      
      await Promise.all(batch.map(async (img, batchIndex) => {
        const globalIndex = i + batchIndex;
        const inPath = path.join(jobDir, img);
        const outPath = path.join(jobDir, \`norm_\${globalIndex}.png\`);
        
        const filter = "scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(1920-iw)/2:(1080-ih)/2:black,setsar=1,format=yuv420p";
        const cmd = \`ffmpeg -y -i "\${inPath}" -vf "\${filter}" -vframes 1 "\${outPath}"\`;
        
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
      }
    }

    // Build concat.txt EXACTLY
    const concatTxtPath = path.join(jobDir, "concat.txt");
    let concatContent = "";
    let totalDuration = 0;
    
    for (let i = 0; i < normalizedFiles.length; i++) {
      concatContent += \`file '\${normalizedFiles[i].replace(/'/g, "'\\\\''")}'\\n\`;
      concatContent += \`duration \${finalDurations[i]}\\n\`;
      totalDuration += finalDurations[i];
    }
    // FFmpeg concat requires the last file to be repeated without duration
    concatContent += \`file '\${normalizedFiles[normalizedFiles.length - 1].replace(/'/g, "'\\\\''")}'\\n\`;
    
    fs.writeFileSync(concatTxtPath, concatContent);

    // Check for audio
    const audioFiles = files.filter(f => f.startsWith("audio."));
    const hasAudio = audioFiles.length > 0;
    const audioPath = hasAudio ? path.join(jobDir, audioFiles[0]) : null;

    const outFilename = \`\${jobId}_out.mp4\`;
    const outputPath = path.join(UPLOAD_DIR, outFilename);

    let ffmpegArgs = [
      "-y", "-nostdin",
      "-f", "concat",
      "-safe", "0",
      "-i", concatTxtPath
    ];

    if (hasAudio) {
      ffmpegArgs.push("-i", audioPath);
    }

    // Exact Pixel Perfect synchronization settings
    ffmpegArgs = ffmpegArgs.concat([
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "18",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p"
    ]);

    if (hasAudio) {
      ffmpegArgs = ffmpegArgs.concat([
        "-c:a", "aac",
        "-b:a", "320k",
        "-af", "aresample=async=1000",
        "-shortest" // Cut video/audio to match exactly
      ]);
    }

    ffmpegArgs = ffmpegArgs.concat([
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      outputPath
    ]);

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);
    
    let totalFrames = totalDuration * 30; // approx

    ffmpegProcess.stdout.on("data", (data) => {
      const output = data.toString();
      const frameMatch = output.match(/frame=\\s*(\\d+)/);
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
        }
      }
    });

    ffmpegProcess.on("close", (code) => {
      const job = jobs.get(jobId);
      if (code === 0) {
        if (job) {
          job.status = "completed";
          job.progress = 100;
          job.eta = 0;
          job.chunks = [\`/api/video/\${outFilename}\`];
          job.lastUpdateTime = Date.now();
        }
      } else {
        if (job) {
          job.status = "error";
          job.error = "FFmpeg process failed";
          job.lastUpdateTime = Date.now();
        }
      }
    });

  } catch (error: any) {
    const job = jobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = error.message;
      job.lastUpdateTime = Date.now();
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

app.get("/api/video/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, filename);

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
    const head = {
      "Content-Range": \`bytes \${start}-\${end}/\${fileSize}\`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/mp4",
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    };
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
    app.listen(PORT, "0.0.0.0", () => console.log(\`Server running on port \${PORT}\`));
  });
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  app.listen(PORT, "0.0.0.0", () => console.log(\`Production server running on port \${PORT}\`));
}
`;

fs.writeFileSync('server.ts', serverCode);
