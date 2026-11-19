// Word timing ("TeleCloud Cadence", Phase 6): runs the engine in electron/cadence in its own utility process, one song
// at a time, so the interface and the music never wait on it and the models' memory goes away when it ends.
//   wordTiming:status -> { ready, japanese, separation, dir }: which model packs are there (cadenceModels.js)
//   wordTiming:run    ({ path, lyrics, separate?, gpu?, withoutJapanese? }) -> { ok, lyrics, stats, lines }
//                      | { ok: false, error, needs?: 'en' | 'ja' } (needs: the pack to download first)
//   wordTiming:cancel
//   'wordTiming:progress' events: { stage: 'fetch' | 'decode' | 'voice' | 'words', done: 0..1 }
// A cloud-only track (tc://) is timed from its copy in the TeleCloud cache, downloaded first when needed ('fetch').
// The models live in userData/models/cadence (TELECLOUD_CADENCE_MODELS overrides it), downloaded and deleted in
// Settings > Lyrics. A Japanese song needs the Japanese pack; withoutJapanese runs it with the English model
// (kana are read, kanji lines keep their line time). Without the voice pack, songs are timed on the full mix.

const { app, ipcMain, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const { mpvPath } = require('./player');
const { isPlayablePath, isInAppStorage } = require('./paths');
const models = require('./cadenceModels');

const modelsDir = () => models.dir();
const KANA = /[぀-ヿ]/;

let running = null; // { proc, sender }
let fetching = null; // { cancelled } while a cloud-only track downloads into the cache for timing

function status() {
  return { dir: modelsDir(), ready: models.installed('en'), japanese: models.installed('ja'), separation: models.installed('voice') };
}

function run(sender, { path: file, lyrics, separate = true, gpu = true, withoutJapanese = false }) {
  return new Promise((resolve) => {
    const st = status();
    if (!st.ready) { resolve({ ok: false, error: 'Download the English and other languages pack first', needs: 'en' }); return; }
    const japanese = KANA.test(lyrics);
    if (japanese && !st.japanese && !withoutJapanese) { resolve({ ok: false, error: 'This song is in Japanese: download the Japanese pack first', needs: 'ja' }); return; }
    if (separate && !st.separation) separate = false;
    // the worker loads onnxruntime-node from the app's own node_modules (unpacked from the asar when packaged)
    const proc = utilityProcess.fork(path.join(__dirname, 'cadence', 'worker.js'), [], { serviceName: 'TeleCloud word timing', stdio: 'pipe' });
    proc.stdout?.on('data', (d) => console.log(`[WordTiming] ${String(d).trim()}`));
    proc.stderr?.on('data', (d) => console.warn(`[WordTiming] ${String(d).trim()}`));
    const job = { proc, sender, done: false };
    running = job;
    const finish = (res) => {
      if (job.done) return;
      job.done = true;
      if (running === job) running = null;
      try { proc.kill(); } catch { /* gone */ }
      resolve(res);
    };
    const name = path.basename(file);
    console.log(`[WordTiming] ${name}: started (${separate ? 'voice separated' : 'full mix'}, ${gpu ? 'GPU if possible' : 'CPU'})`);
    proc.on('message', (m) => {
      if (m.type === 'log') { console.log(`[WordTiming] ${name}: ${m.text}`); return; }
      if (m.type === 'progress') { if (!sender.isDestroyed()) sender.send('wordTiming:progress', { stage: m.stage, done: m.done }); return; }
      if (m.type === 'done') {
        const s = m.stats;
        const eps = Object.entries(s.wordsEp || {}).map(([k, v]) => `${k} ${v}`).join(', ');
        console.log(`[WordTiming] ${name}: ${s.timedLines}/${s.lines} lines timed in ${(s.totalMs / 1000).toFixed(1)} s` +
          `${s.voiceMs != null ? ` (voice ${(s.voiceMs / 1000).toFixed(1)} s on ${s.voiceEp}, words ${(s.wordsMs / 1000).toFixed(1)} s on ${eps})` : ` (words on ${eps})`}, ${Math.round(s.seconds)} s of audio`);
        finish({ ok: true, lyrics: m.lyrics, stats: s, lines: m.lines });
      } else if (m.type === 'error') {
        if (m.message !== 'cancelled') console.warn(`[WordTiming] ${name}: ${m.message}`);
        finish({ ok: false, error: m.message });
      }
    });
    proc.on('exit', (code) => finish({ ok: false, error: job.cancelled ? 'cancelled' : `The word-timing process stopped (${code})` }));
    proc.postMessage({ type: 'run', job: { file, lyrics, separate, gpu, mpvPath, modelsDir: modelsDir(), japaneseModel: st.japanese } });
  });
}

ipcMain.handle('wordTiming:status', () => status());

ipcMain.handle('wordTiming:run', async (event, opts = {}) => {
  let file = String(opts.path || '');
  if (!opts.lyrics || typeof opts.lyrics !== 'string') return { ok: false, error: 'No line-synced lyrics' };
  if (running || fetching) return { ok: false, error: 'Another song is being timed' };
  if (!status().ready) return { ok: false, error: 'Download the English and other languages pack first', needs: 'en' };
  if (KANA.test(opts.lyrics) && !status().japanese && !opts.withoutJapanese) return { ok: false, error: 'This song is in Japanese: download the Japanese pack first', needs: 'ja' };
  // a cloud-only track: its copy in the TeleCloud cache, downloaded from Telegram first when it is not there
  if (file.startsWith('tc://')) {
    fetching = { cancelled: false };
    const me = fetching;
    try {
      if (!event.sender.isDestroyed()) event.sender.send('wordTiming:progress', { stage: 'fetch', done: 0 });
      file = await require('./telecloud/service')._internals.cacheTrack(file);
    } catch (e) {
      return { ok: false, error: `Could not download the track from TeleCloud: ${e.message}` };
    } finally { fetching = null; }
    if (me.cancelled) return { ok: false, error: 'cancelled' };
  }
  if (!file || (!isPlayablePath(file) && !isInAppStorage(file)) || !fs.existsSync(file)) return { ok: false, error: 'Not a playable file' };
  return run(event.sender, { ...opts, path: file });
});

ipcMain.handle('wordTiming:cancel', () => {
  if (fetching) { fetching.cancelled = true; return true; } // the download itself finishes into the cache
  if (!running) return false;
  running.cancelled = true;
  try { running.proc.postMessage({ type: 'cancel' }); } catch { /* gone */ }
  const job = running;
  setTimeout(() => { try { job.proc.kill(); } catch { /* gone */ } }, 3000);
  return true;
});

app.on('before-quit', () => { try { running?.proc.kill(); } catch { /* gone */ } });

models.setTimingCheck(() => !!running || !!fetching); // no deleting a pack while a song is being timed

module.exports = { status, modelsDir };
