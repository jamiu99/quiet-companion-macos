// Dev tool: dump frames of a local video to PNGs (no ffmpeg on this machine) and print corner colors.
// Usage: node_modules/.bin/electron scripts/video-frames.mjs <video> <outdir> [t1,t2,...]
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const [video, outdir, times = '0,1.5,3,4.5,6'] = process.argv.slice(2).filter(a => !a.startsWith('-'));
app.dock?.hide();
app.whenReady().then(async () => {
  mkdirSync(outdir, { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, webSecurity: false } });
  await win.loadURL('data:text/html,<video id=v muted playsinline></video><canvas id=c></canvas>');
  const out = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v'), c = document.getElementById('c');
    v.src = ${JSON.stringify(pathToFileURL(resolve(video)).toString())};
    await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error('load failed')); });
    c.width = v.videoWidth; c.height = v.videoHeight; const ctx = c.getContext('2d');
    const res = { size: [v.videoWidth, v.videoHeight], duration: v.duration, frames: [] };
    for (const t of ${JSON.stringify(times.split(',').map(Number))}) {
      v.currentTime = Math.min(t, v.duration - 0.05);
      await new Promise(ok => { v.onseeked = ok; });
      ctx.drawImage(v, 0, 0);
      const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
      res.frames.push({ t, png: c.toDataURL('image/png'), corners: [px(8, 8), px(c.width - 9, 8), px(8, Math.round(c.height * 0.45)), px(c.width - 9, c.height - 9)] });
    }
    return res;
  })()`);
  for (const f of out.frames) {
    const file = join(outdir, `${basename(video).replace(/\.\w+$/, '')}-t${f.t}.png`);
    writeFileSync(file, Buffer.from(f.png.split(',')[1], 'base64'));
    console.log(file, 'corners', JSON.stringify(f.corners));
  }
  console.log('size', out.size, 'duration', out.duration);
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
setTimeout(() => { console.error('timeout'); app.exit(3); }, 30_000);
