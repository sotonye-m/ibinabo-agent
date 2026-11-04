// Builds demo.mp4 from out/plan.json: "show" at 1x, "wait" squeezed to ≤1 s, "skip" dropped.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const OUT = new URL('./out/', import.meta.url).pathname;
const plan = JSON.parse(fs.readFileSync(OUT + 'plan.json', 'utf8'));
const V = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-preset', 'veryfast', '-crf', '20', '-an'];
const clips = []; let n = 0;
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
function seg(video, a, b, speed) {
  const f = `${OUT}clip_${String(n++).padStart(3, '0')}.mp4`;
  ff(['-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', video, '-vf', `setpts=${speed.toFixed(4)}*(PTS-STARTPTS),scale=1280:800,fps=30`, ...V, f]);
  clips.push(f);
}
function image(img, s) { const f = `${OUT}clip_${String(n++).padStart(3, '0')}.mp4`; ff(['-loop', '1', '-t', String(s), '-i', img, '-vf', 'scale=1280:800,fps=30', ...V, f]); clips.push(f); }
function video(item, from = 0, to = Infinity) {
  for (const s of item.segments) {
    const a = Math.max(s.a, from), b = Math.min(s.b, to);
    if (b - a < 0.05 || s.mode === 'skip') continue;
    if (s.mode === 'show') seg(item.video, a, b, 1);
    else seg(item.video, a, b, Math.min(1, 1.0 / (b - a)));
  }
}
for (let i = 0; i < plan.length; i++) {
  const it = plan[i];
  if (it.image) { image(it.image, it.seconds); continue; }
  if (it.splitAt) { video(it, 0, it.splitAt); const c = plan[++i]; image(c.image, c.seconds); video(it, it.splitAt); continue; }
  video(it);
}
fs.writeFileSync(OUT + 'list.txt', clips.map((c) => `file '${c}'`).join('\n'));
ff(['-f', 'concat', '-safe', '0', '-i', OUT + 'list.txt', '-c', 'copy', OUT + 'demo.mp4']);
console.log(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT + 'demo.mp4']).toString().trim(), 's');
