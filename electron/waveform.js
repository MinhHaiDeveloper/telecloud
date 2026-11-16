// The waveform seek bar: a track's loudness over time, worked out once with mpv and kept in userData
// (by path, size and date, so a changed file is read again). One file at a time; a newer request wins.

const { app, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { mpvPath } = require('./player');
const { isPlayablePath, isInAppStorage } = require('./paths');

const BARS = 600;
const RATE = 11025; // plenty for a loudness outline, and quick to decode
const dir = () => path.join(app.getPath('userData'), 'waveforms');

let running = null; // { key, child, promise }

/** 0..1 for each bar: the loudest moment in it, on a gentle curve so quiet music still shows */
function shape(peaks) {
  const max = Math.max(1e-6, ...peaks);
  return peaks.map(p => Number(Math.pow(p / max, 0.7).toFixed(3)));
}

function decode(file, duration) {
  return new Promise((resolve, reject) => {
    const args = ['--no-config', '--no-video', '--media-controls=no', '--load-scripts=no', '--ytdl=no', '--msg-level=all=error',
      '--audio-channels=mono', `--audio-samplerate=${RATE}`, '--of=f32le', '--oac=pcm_f32le', '--o=-', '--', file];
    const child = spawn(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    // in the background: the music that plays and the window come first
    try { require('os').setPriority(child.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
    // the number of samples is only known for sure at the end: keep the peaks of small blocks, then fold them
    const BLOCK = 256;
    const blocks = [];
    let carry = Buffer.alloc(0);
    let blockMax = 0, inBlock = 0;
    child.stdout.on('data', (d) => {
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const whole = buf.length - (buf.length % 4);
      for (let i = 0; i < whole; i += 4) {
        const v = Math.abs(buf.readFloatLE(i));
        if (v > blockMax) blockMax = v;
        if (++inBlock === BLOCK) { blocks.push(blockMax); blockMax = 0; inBlock = 0; }
      }
      carry = buf.subarray(whole);
    });
    child.on('error', reject);
    child.on('close', () => {
      if (inBlock) blocks.push(blockMax);
      if (!blocks.length) { reject(new Error('No audio')); return; }
      const peaks = new Array(BARS).fill(0);
      blocks.forEach((v, i) => { const b = Math.min(BARS - 1, Math.floor((i / blocks.length) * BARS)); if (v > peaks[b]) peaks[b] = v; });
      resolve({ peaks: shape(peaks), seconds: (blocks.length * BLOCK) / RATE || duration || 0 });
    });
    running.child = child;
  });
}

async function waveformFor(file) {
  if (!isPlayablePath(file) && !isInAppStorage(file)) throw new Error('Not a playable file');
  const st = await fs.promises.stat(file);
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex');
  const cacheFile = path.join(dir(), `${key}.json`);
  try { return JSON.parse(await fs.promises.readFile(cacheFile, 'utf8')); } catch { /* not yet */ }
  if (running?.key === key) return running.promise;
  if (running) { try { running.child?.kill(); } catch { /* gone */ } }
  const job = { key, child: null, promise: null };
  running = job;
  job.promise = decode(file).then(async (w) => {
    await fs.promises.mkdir(dir(), { recursive: true });
    await fs.promises.writeFile(cacheFile, JSON.stringify(w));
    return w;
  }).finally(() => { if (running === job) running = null; });
  return job.promise;
}

ipcMain.handle('waveform:get', async (event, file) => {
  try { return { ok: true, ...(await waveformFor(String(file || ''))) }; } catch (err) {
    if (!/killed|SIGTERM/i.test(err.message)) console.warn(`[Waveform] Could not read ${path.basename(String(file || ''))}: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

module.exports = { waveformFor, BARS };
