// Quality check in the background (Settings > Library): every track gets the Quality check window's verdict, one at
// a time, in electron/qualityWorker.js. Results live in the library database beside the track, a few hundred bytes
// each, and stay valid while the file is the same (path, size, date) and the check is the same (VERSION).
//
// When it runs: after a scan or refresh, when a file is added or changed, when a cloud track is cached (played or
// downloaded), and once a little after the app starts. It waits while the computer is on battery, while a track
// plays bit-perfect (exclusive or ASIO), while the Quality check window is analysing, and while the CPU is busy,
// and rests between tracks as long as the last one took, so it uses at most half of one core.
// Lossy, MQA and DSD files are not decoded: their own badge already says what they are (see SKIP).

const { ipcMain, app, powerMonitor, utilityProcess } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const database = require('./database');

const VERSION = 1; // raise when the analysis or judge() changes: every track is checked again
// verdicts that mark a track in the lists; everything else (genuine, rolloff, inconclusive, skipped) shows nothing
const FLAGGED = { transcoded: 'bad', 'upsampled-lossy': 'bad', upsampled: 'warn', 'genuine-padded': 'warn' };
const TEST_DELAY = Number(process.env.TELECLOUD_QUALITY_DELAY) || 0; // tests: shorter waits
const START_DELAY = Number(process.env.TELECLOUD_QUALITY_START) || TEST_DELAY || 2 * 60 * 1000;   // after the app starts
const AFTER_CHANGE = TEST_DELAY || 60 * 1000;      // after files were added or changed: copying and uploading are done by then
const CPU_BUSY = 0.85;               // the whole computer, measured over a second before each track

let db = null;
let enabled = false;
let timer = null;
let running = false;
let rerun = false;
let stopRun = false;
let worker = null;
let status = { state: 'idle' };
let lastSent = 0;

// the database can be closed and made again (Settings > Clear cached data & database): ask for it each time
function table() {
  const now = database.initDatabase();
  if (db === now) return db;
  db = now;
  db.exec(`CREATE TABLE IF NOT EXISTS quality_checks (
    path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, version INTEGER,
    verdict TEXT, level TEXT, confidence TEXT, params TEXT, checked_at INTEGER)`);
  return db;
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readEnabled() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).qualityBackground === true; } catch { return false; }
}

const sendToUi = (ch, payload) => {
  const win = require('./mainWindow').get();
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};
function setStatus(next, force = false) {
  status = next;
  const now = Date.now();
  if (force || now - lastSent > 400) { lastSent = now; sendToUi('quality:status', status); }
}

// ---------- what needs a check

const SKIP = (r) => {
  const ext = (r.ext || path.extname(r.path)).toLowerCase();
  if (ext === '.dsf' || ext === '.dff') return 'skip-dsd';
  if (r.mqa) return 'skip-mqa';
  if (r.lossless === 0 || ['.mp3', '.ogg', '.opus', '.aac'].includes(ext)) return 'skip-lossy';
  return null;
};

const PENDING = `SELECT m.path, m.mtime, m.size, m.duration, m.bit_depth, m.codec, m.lossless, m.ext, m.mqa, m.storage_type, m.cache_path
  FROM music_files m LEFT JOIN quality_checks q ON q.path = m.path
  WHERE q.path IS NULL OR q.version != @v OR q.mtime IS NOT m.mtime OR q.size IS NOT m.size`;

/** The file to read: the track itself, or its cached copy when it lives in the cloud. Null: not here yet. */
function sourceOf(r) {
  const local = r.storage_type !== 'cloud' && !r.path.startsWith('tc://');
  if (local && fs.existsSync(r.path)) return r.path;
  if (r.cache_path && fs.existsSync(r.cache_path)) return r.cache_path;
  return null;
}

function save(r, verdict, level = null, confidence = null, params = null) {
  table().prepare(`INSERT OR REPLACE INTO quality_checks (path, mtime, size, version, verdict, level, confidence, params, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.path, r.mtime, r.size, VERSION, verdict, level, confidence, params ? JSON.stringify(params) : null, Date.now());
}

const flagOf = (verdict) => (FLAGGED[verdict] ? { verdict, level: FLAGGED[verdict] } : null);

/** Counts for Settings: checked, worth a look, waiting in the cloud, left to do */
function summary() {
  const d = table();
  const valid = `FROM quality_checks q JOIN music_files m ON m.path = q.path WHERE q.version = ${VERSION} AND q.mtime IS m.mtime AND q.size IS m.size`;
  const checked = d.prepare(`SELECT COUNT(*) n ${valid} AND q.verdict NOT LIKE 'skip-%' AND q.verdict != 'error'`).get().n;
  const skipped = d.prepare(`SELECT COUNT(*) n ${valid} AND q.verdict LIKE 'skip-%'`).get().n;
  const flagged = d.prepare(`SELECT COUNT(*) n ${valid} AND q.verdict IN (${Object.keys(FLAGGED).map(k => `'${k}'`).join(',')})`).get().n;
  const todo = d.prepare(PENDING).all({ v: VERSION }).filter(r => !SKIP(r));
  const cloud = todo.filter(r => (r.storage_type === 'cloud' || r.path.startsWith('tc://')) && !(r.cache_path && fs.existsSync(r.cache_path))).length;
  return { enabled, checked, skipped, flagged, cloud, left: todo.length - cloud, status };
}

// ---------- the worker

function startWorker() {
  const proc = utilityProcess.fork(path.join(__dirname, 'qualityWorker.js'), [], { serviceName: 'TeleCloud quality check', stdio: 'pipe' });
  proc.stderr?.on('data', (d) => console.warn(`[Quality] ${String(d).trim()}`));
  const w = { proc, waiting: null, seq: 0 };
  proc.on('message', (m) => { const job = w.waiting; if (job && m.id === job.id) { w.waiting = null; job.done(m); } });
  proc.on('exit', () => { if (worker === w) worker = null; w.waiting?.done({ error: 'The check stopped' }); w.waiting = null; });
  return w;
}

function check(file, meta, timeoutMs) {
  if (!worker) worker = startWorker();
  const w = worker;
  const { mpvPath } = require('./player');
  return new Promise((resolve) => {
    const id = ++w.seq;
    const timer = setTimeout(() => { try { w.proc.kill(); } catch { /* gone */ } }, timeoutMs);
    w.waiting = { id, done: (m) => { clearTimeout(timer); resolve(m); } };
    w.proc.postMessage({ id, mpvPath, file, meta });
  });
}

function stopWorker() {
  if (!worker) return;
  try { worker.proc.kill(); } catch { /* gone */ }
  worker = null;
}

// ---------- waiting for a good moment

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, all: 0 });
async function cpuBusy() {
  const a = cpuTimes();
  await sleep(1000);
  const b = cpuTimes();
  const all = b.all - a.all;
  return all > 0 ? 1 - (b.idle - a.idle) / all : 0;
}

/** Why it should wait now, or null */
async function reasonToWait() {
  if (powerMonitor.isOnBatteryPower?.()) return 'battery';
  if (require('./player').playingBitPerfect?.()) return 'bitperfect';
  if (require('./spectrum').busy()) return 'window';
  if (await cpuBusy() > CPU_BUSY) return 'busy';
  return null;
}

// ---------- the run

async function run() {
  if (running || !enabled) return;
  running = true;
  stopRun = false;
  rerun = false;
  const d = table();
  try {
    d.prepare('DELETE FROM quality_checks WHERE path NOT IN (SELECT path FROM music_files)').run(); // tracks gone
    const todo = d.prepare(PENDING).all({ v: VERSION });
    // lossy, MQA and DSD: no decoding, just noted so they are not looked at again
    const skips = todo.filter(r => SKIP(r));
    d.transaction(() => skips.forEach(r => save(r, SKIP(r))))();
    // files on this computer first, folder by folder; cloud tracks that are cached after them
    // (whether each file is really there is looked at when its turn comes, not for thousands at once here)
    const isLocal = (r) => r.storage_type !== 'cloud' && !r.path.startsWith('tc://');
    const list = todo.filter(r => !SKIP(r) && (isLocal(r) || r.cache_path)).map(r => ({ r }))
      .sort((a, b) => (isLocal(b.r) - isLocal(a.r)) || (a.r.path < b.r.path ? -1 : a.r.path > b.r.path ? 1 : 0));
    if (!list.length) return;
    console.log(`[Quality] Checking ${list.length} ${list.length === 1 ? 'track' : 'tracks'} in the background`);
    const started = Date.now();
    let done = 0, flagged = 0, errors = 0;
    setStatus({ state: 'checking', done, total: list.length, flagged }, true);
    for (const { r: first } of list) {
      if (stopRun || !enabled) break;
      for (let why = await reasonToWait(); why; why = await reasonToWait()) {
        setStatus({ state: 'paused', reason: why, done, total: list.length, flagged }, status.state !== 'paused' || status.reason !== why);
        stopWorker(); // nothing held while waiting
        await sleep(5000);
        if (stopRun || !enabled) break;
      }
      if (stopRun || !enabled) break;
      // the row as it is now: changed or removed since the list was made
      const r = d.prepare('SELECT * FROM music_files WHERE path = ?').get(first.path);
      const src = r && !SKIP(r) ? sourceOf(r) : null;
      if (src) {
        const t0 = Date.now();
        const meta = { duration: r.duration, bits: r.bit_depth, codec: r.codec, lossless: r.lossless, ext: (r.ext || path.extname(r.path)).toLowerCase() };
        const m = await check(src, meta, Math.max(120000, (r.duration || 0) * 1000));
        if (stopRun || !enabled) break;
        if (m.result) {
          save(r, m.result.id, m.result.level, m.result.confidence, m.result.params);
          const flag = flagOf(m.result.id);
          if (flag) flagged++;
          sendToUi('quality:flag', { path: r.path, flag });
        } else {
          errors++;
          save(r, 'error', null, null, { message: m.error });
          console.warn(`[Quality] ${path.basename(src)}: ${m.error}`);
        }
        // rest as long as it took (half of one core at most); the second spent measuring the CPU before the next counts
        await sleep(Math.min(30000, Math.max(0, Date.now() - t0 - 1000)));
      }
      done++;
      setStatus({ state: 'checking', done, total: list.length, flagged });
    }
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`[Quality] ${stopRun || !enabled ? 'Stopped' : 'Done'}: ${done} of ${list.length} in ${secs} s, ${flagged} worth a look${errors ? `, ${errors} could not be read` : ''}`);
    setStatus({ state: 'done', done, total: list.length, flagged, stopped: stopRun || !enabled }, true);
  } catch (err) {
    console.error('[Quality] Background check failed:', err.message);
  } finally {
    stopWorker();
    running = false;
    if (status.state !== 'idle') setTimeout(() => { if (!running) setStatus({ state: 'idle' }, true); }, 4000);
    if (rerun && enabled) schedule(AFTER_CHANGE);
  }
}

/** Check soon: something was added or changed. Repeated calls wait for the last one. */
function schedule(ms = AFTER_CHANGE) {
  if (!enabled) return;
  if (running) { rerun = true; return; }
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; run(); }, ms);
}

// ---------- the rest of the app tells it

/** Tags edited here: the music is the same, so the verdict moves to the file's new size and date. */
function carry(filePath, before) {
  if (!before) return;
  const d = table();
  const now = d.prepare('SELECT mtime, size FROM music_files WHERE path = ?').get(filePath);
  if (!now) return;
  d.prepare('UPDATE quality_checks SET mtime = ?, size = ? WHERE path = ? AND mtime IS ? AND size IS ? AND version = ?')
    .run(now.mtime, now.size, filePath, before.mtime, before.size, VERSION);
}

/** The Quality check window's own verdict for a library track: the same analysis, so it is kept too */
function fromWindow(filePath, verdict) {
  const r = database.getFileByPath(filePath);
  if (!r || SKIP(r)) return; // lossy, MQA and DSD stay unmarked in the lists
  save(r, verdict.id, verdict.level, verdict.confidence, verdict.params);
  sendToUi('quality:flag', { path: r.path, flag: flagOf(verdict.id) });
}

function forget(filePath) {
  table().prepare('DELETE FROM quality_checks WHERE path = ?').run(filePath);
}

/** Tracks the lists mark: only verdicts that are still valid */
function flags() {
  return table().prepare(`SELECT q.path, q.verdict FROM quality_checks q JOIN music_files m ON m.path = q.path
    WHERE q.version = ${VERSION} AND q.mtime IS m.mtime AND q.size IS m.size AND q.verdict IN (${Object.keys(FLAGGED).map(k => `'${k}'`).join(',')})`)
    .all().map(r => ({ path: r.path, flag: flagOf(r.verdict) }));
}

function setEnabled(on) {
  enabled = !!on;
  if (enabled) schedule(3000);
  else { clearTimeout(timer); stopRun = true; }
  return summary();
}

ipcMain.handle('quality:flags', () => flags());
ipcMain.handle('quality:summary', () => summary());
ipcMain.handle('quality:enable', (e, on) => setEnabled(on));
ipcMain.handle('quality:stop', () => { stopRun = true; clearTimeout(timer); return true; });
// tests only: check now, without the wait after a change
ipcMain.handle('quality:now', () => { if (!app.isPackaged) { clearTimeout(timer); run(); } return true; });

app.whenReady().then(() => {
  enabled = readEnabled();
  if (enabled) schedule(START_DELAY);
});
app.on('will-quit', () => { stopRun = true; stopWorker(); });

module.exports = { schedule, carry, fromWindow, forget, VERSION, FLAGGED };
