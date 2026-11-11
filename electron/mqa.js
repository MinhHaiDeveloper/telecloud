// MQA: the encoder hides a signal in the low bits of an ordinary 44.1/48 kHz file. An MQA DAC finds it and
// unfolds the music, but only when the bits reach it untouched. TeleCloud can't unfold MQA (that needs a
// licensed decoder): it finds which tracks are MQA, shows it, and can send them untouched.
//
// Detection follows MQA_identifier by Stavros Avramidis (purpl3F0x/MQA_identifier, Apache-2.0): the
// XOR of the two channels, at the 16th bit from the top, carries a 36-bit sync word, then the original
// sample rate and whether it is MQA Studio.
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const database = require('./database');

const SYNC = 0xbe0498c88;
const WORD = 2 ** 36;
const SECONDS = 3; // the sync word comes early: the first seconds are enough
const LOSSLESS = /\.(flac|wav|aiff?|aifc|m4a|alac|wv|ape)$/i;

/** The original sample rate from its 4-bit code: lowest bit picks 44.1 or 48 kHz, the rest a power of two */
function originalRate(c) {
  const base = (c & 1) ? 48000 : 44100;
  let mult = 1 << (((c >> 3) & 1) | (((c >> 2) & 1) << 1) | (((c >> 1) & 1) << 2));
  if (mult > 16) mult *= 2;
  return base * mult;
}

/**
 * Look for MQA in interleaved stereo samples, 32-bit little-endian (what mpv gives with --audio-format=s32,
 * where 16- and 24-bit audio sits at the top, so the bit to read is always bit 16).
 * @returns {{ mqa: boolean, studio?: boolean, rate?: number }}
 */
function findMqa(buf) {
  const n = Math.floor(buf.length / 8);
  const bit = (i, p) => ((buf.readInt32LE(i * 8) ^ buf.readInt32LE(i * 8 + 4)) >>> (16 + p)) & 1;
  const words = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < 3; p++) {
      words[p] = (words[p] * 2 + bit(i, p)) % WORD;
      if (words[p] !== SYNC) continue;
      let code = 0;
      for (let m = 3; m < 8 && i + m < n; m++) code |= bit(i + m, p) << (7 - m);
      let provenance = 0;
      for (let m = 29; m < 34 && i + m < n; m++) provenance |= bit(i + m, p) << (33 - m);
      return { mqa: true, studio: provenance > 8, rate: originalRate(code) };
    }
  }
  return { mqa: false };
}

/** Could this track be MQA? 16/24-bit lossless at a rate MQA uses: 44.1/48 kHz, and 2x or 4x of them (2L's MQA files are 88.2 kHz) */
function candidate(row) {
  if (!row || !LOSSLESS.test(row.path) || row.path.startsWith('tc://')) return false;
  if (row.sample_rate && ![44100, 48000, 88200, 96000, 176400, 192000].includes(row.sample_rate)) return false;
  if (row.bit_depth && ![16, 24].includes(row.bit_depth)) return false;
  return fs.existsSync(row.path);
}

/** Decode the first seconds with mpv, exactly as they are, and look */
function scanFile(file) {
  const { mpvPath } = require('./player');
  const out = path.join(os.tmpdir(), `tc-mqa-${crypto.randomBytes(6).toString('hex')}.raw`);
  return new Promise((resolve, reject) => {
    execFile(mpvPath, [
      '--no-config', '--no-video', '--msg-level=all=no', '--ao=pcm', `--ao-pcm-file=${out}`, '--ao-pcm-waveheader=no',
      '--audio-format=s32', '--audio-channels=stereo', '--audio-samplerate=0', '--replaygain=no', '--af=', '--volume=100',
      `--length=${SECONDS}`, '--', file,
    ], { windowsHide: true, timeout: 30000 }, (err) => {
      fs.readFile(out, (e2, buf) => {
        fs.rm(out, { force: true }, () => {});
        if (e2) { reject(err || e2); return; }
        resolve(findMqa(buf));
      });
    });
  });
}

const send = (ch, p) => BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send(ch, p); });
const save = (p, r) => {
  const value = r.mqa ? (r.studio ? 2 : 1) : 0;
  database.initDatabase().prepare('UPDATE music_files SET mqa = ?, mqa_rate = ? WHERE path = ?').run(value, r.mqa ? r.rate : null, p);
  send('library:mqa', { path: p, mqa: value, mqaRate: r.mqa ? r.rate : null });
  if (r.mqa) console.log(`[MQA] ${path.basename(p)}: MQA${r.studio ? ' Studio' : ''}, ${r.rate} Hz original`);
};

const checking = new Map();
/** Check one track once; later plays use what was found */
function checkTrack(p) {
  const row = database.getFileByPath(p);
  if (!candidate(row) || row.mqa != null) return Promise.resolve(row?.mqa ?? null);
  if (checking.has(p)) return checking.get(p);
  const job = scanFile(p).then((r) => { save(p, r); return r.mqa ? (r.studio ? 2 : 1) : 0; })
    .catch((err) => { console.warn(`[MQA] Could not check ${path.basename(p)}: ${err.message}`); return null; })
    .finally(() => checking.delete(p));
  checking.set(p, job);
  return job;
}

// ---------- the whole library, from Settings
let job = null;
async function checkLibrary() {
  if (job) return job.state;
  const rows = database.initDatabase().prepare("SELECT path, sample_rate, bit_depth, mqa FROM music_files WHERE mqa IS NULL AND path NOT LIKE 'tc://%'").all().filter(candidate);
  const state = { done: 0, total: rows.length, found: 0, stopped: false, inLibrary: 0 };
  job = { state, stop: false };
  send('mqa:progress', { ...state });
  (async () => {
    const queue = [...rows];
    const worker = async () => {
      while (queue.length && !job.stop) {
        const r = queue.shift();
        const found = await checkTrack(r.path);
        state.done++;
        if (found) state.found++;
        send('mqa:progress', { ...state });
      }
    };
    await Promise.all([worker(), worker()]);
    state.stopped = job.stop;
    state.inLibrary = database.initDatabase().prepare('SELECT COUNT(*) n FROM music_files WHERE mqa > 0').get().n;
    console.log(`[MQA] Library check: ${state.done} of ${state.total} tracks, ${state.found} MQA${state.stopped ? ', stopped' : ''}`);
    send('mqa:progress', { ...state, finished: true });
    job = null;
  })();
  return state;
}

ipcMain.handle('mqa:check-library', () => checkLibrary());
ipcMain.handle('mqa:stop', () => { if (job) job.stop = true; });
app.on('before-quit', () => { if (job) job.stop = true; });

/** For the player: is the track that is about to play MQA? Looks at the library row of a file or its cached copy. */
function mqaOfPath(p) {
  const db = database.initDatabase();
  const row = db.prepare('SELECT mqa FROM music_files WHERE path = ? OR cache_path = ?').get(p, p);
  return row?.mqa || 0;
}

module.exports = { findMqa, originalRate, checkTrack, checkLibrary, mqaOfPath, candidate };
