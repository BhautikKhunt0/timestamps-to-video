const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const jobDir = 'output/job_1788684033402_4vdcnwo';
const files = fs.readdirSync(jobDir);
const audioFiles = files.filter(f => f.startsWith('audio_')).sort((a,b)=>parseInt(a.match(/\d+/)[0])-parseInt(b.match(/\d+/)[0]));

let ffmpegArgs = ['-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', path.join(jobDir, 'concat.txt')];
audioFiles.forEach(f => ffmpegArgs.push('-i', path.join(jobDir, f)));

let filterComplexStr = '';
let concatStreams = '';
for (let i = 0; i < audioFiles.length; i++) {
  filterComplexStr += `[${i + 1}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
  concatStreams += `[a${i}]`;
}
filterComplexStr += `${concatStreams}concat=n=${audioFiles.length}:v=0:a=1,aresample=async=1000,apad[aout]`;

ffmpegArgs.push(
  '-filter_complex', filterComplexStr,
  '-map', '0:v',
  '-map', '[aout]',
  '-c:a', 'aac',
  '-b:a', '320k',
  '-shortest',
  '-t', '1200',
  '-f', 'segment',
  '-segment_time', '120',
  'test_%03d.mp4'
);

const ffmpeg = spawn('node_modules/ffmpeg-static/ffmpeg.exe', ffmpegArgs);
ffmpeg.stderr.on('data', data => process.stdout.write(data.toString()));
ffmpeg.on('close', code => console.log('Exited with', code));
