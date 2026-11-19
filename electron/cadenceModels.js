// Cadence's models: downloaded only when asked for, one pack at a time, from the telecloud-models GitHub release
// this build knows (electron/cadence/manifest.json, cadence-1), and deletable at any time.
//   Packs: en (needed), ja (Japanese songs), voice (voice separation, optional).
//   A download goes to <file>.part, resumes from there (HTTP range), and only becomes the file once its size and
//   SHA-256 match the manifest. Cancel keeps the .part for later. installed.json keeps each file's SHA-256, so a
//   build with a newer models release (cadence-2...) downloads only the files that changed, and removes the old
//   release's files no pack uses any more.
//   cadence:models          -> status (below)
//   cadence:download (pack) -> { ok } | { ok: false, error }
//   cadence:cancel
//   cadence:delete (pack | 'all') -> { ok } | { ok: false, error }
//   events: 'cadence:models' (status, after every change), 'cadence:progress' ({ pack, done, total })

const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST = require('./cadence/manifest.json');
const dir = () => process.env.TELECLOUD_CADENCE_MODELS || path.join(app.getPath('userData'), 'models', 'cadence');
const recordFile = () => path.join(dir(), 'installed.json');

let current = null; // { pack, abort, done, total }
let lastError = null; // { pack, message }
let isTiming = () => false; // set by wordTiming.js

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
const readRecord = () => { try { return JSON.parse(fs.readFileSync(recordFile(), 'utf8')); } catch { return { packs: {} }; } };
function writeRecord(r) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(recordFile(), JSON.stringify(r, null, 1));
}

/**
 * A file is in place when it has the manifest's size and the SHA-256 recorded when it was downloaded is the
 * manifest's (installed.json, files). A file from an older models release with the same name then counts as
 * outdated, and only the files that changed download again. Files from before the record kept hashes count by size.
 */
function fileState(f, rec) {
  const s = sizeOf(path.join(dir(), f.name));
  const sum = rec.files?.[f.name];
  if (s === f.size && (sum == null || sum === f.sha256)) return 'ok';
  if (s >= 0 && sum != null && sum !== f.sha256) return 'old';
  return 'missing';
}

function packState(id, rec = readRecord()) {
  const p = MANIFEST.packs[id];
  let have = 0, partial = 0, need = 0, old = false, complete = true;
  for (const f of p.files) {
    const st = fileState(f, rec);
    if (st === 'ok') { have += f.size; continue; }
    complete = false;
    need += f.size;
    if (st === 'old') old = true;
    const part = sizeOf(path.join(dir(), `${f.name}.part`));
    if (part > 0) partial += Math.min(part, f.size);
  }
  return { complete, have, partial, need, old };
}

function folderSize() {
  let n = 0;
  try { for (const f of fs.readdirSync(dir())) n += Math.max(0, sizeOf(path.join(dir(), f))); } catch { /* none yet */ }
  return n;
}

function status() {
  const rec = readRecord();
  const packs = Object.entries(MANIFEST.packs).map(([id, p]) => {
    const st = packState(id, rec);
    return {
      id, title: p.title, required: p.required, size: p.size,
      installed: st.complete,
      // files of an older models release: the pack needs `need` bytes to be current
      outdated: !st.complete && st.old,
      need: st.need,
      // bytes of a download stopped part-way (.part files), and whether any of its files are on disk at all
      partial: st.complete ? 0 : st.partial,
      present: st.complete || st.have > 0 || st.partial > 0 || st.old,
      downloading: current?.pack === id ? { done: current.done, total: current.total } : null,
      error: lastError?.pack === id ? lastError.message : null,
    };
  });
  return { tag: MANIFEST.tag, dir: dir(), packs, used: folderSize(), busy: !!current, timing: isTiming() };
}

const installed = (id) => packState(id).complete;

function broadcast() {
  const st = status();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cadence:models', st);
}
let lastProgress = 0;
function progress(force) {
  const now = Date.now();
  if (!force && now - lastProgress < 250) return;
  lastProgress = now;
  const p = { pack: current.pack, done: current.done, total: current.total };
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cadence:progress', p);
}

async function hashFile(file, hash) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
  });
}

/** One file: resume its .part, check size and SHA-256, then move it into place */
async function fetchFile(f, signal) {
  const final = path.join(dir(), f.name), part = `${final}.part`;
  if (fileState(f, readRecord()) === 'ok') { current.done += f.size; return; }
  let have = sizeOf(part);
  if (have > f.size) { fs.rmSync(part, { force: true }); have = -1; }
  const hash = crypto.createHash('sha256');
  if (have > 0) await hashFile(part, hash); else have = 0;
  current.done += have;
  if (have < f.size) {
    const res = await fetch(MANIFEST.base + encodeURIComponent(f.name), { signal, redirect: 'follow', headers: have ? { Range: `bytes=${have}-` } : {} });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${f.name}`);
    let restart = false;
    if (have && res.status !== 206) { restart = true; current.done -= have; have = 0; } // the server sent the whole file
    const fh = await fs.promises.open(part, restart || !have ? 'w' : 'a');
    const h = restart ? crypto.createHash('sha256') : hash;
    try {
      for await (const chunk of res.body) {
        await fh.write(chunk);
        h.update(chunk);
        have += chunk.length;
        current.done += chunk.length;
        progress();
      }
    } finally { await fh.close(); }
    if (have !== f.size) throw new Error(`${f.name} came in short (${have} of ${f.size} bytes)`);
    const sum = h.digest('hex');
    if (sum !== f.sha256) { fs.rmSync(part, { force: true }); throw new Error(`${f.name} did not match its checksum; it will download again`); }
  } else {
    const sum = hash.digest('hex');
    if (sum !== f.sha256) { fs.rmSync(part, { force: true }); throw new Error(`${f.name} did not match its checksum; it will download again`); }
  }
  fs.rmSync(final, { force: true }); // an older release's file of the same name
  fs.renameSync(part, final);
  const rec = readRecord();
  rec.files = { ...(rec.files || {}), [f.name]: f.sha256 };
  writeRecord(rec);
}

/** Files an older models release put here that no pack of this one uses (only files this app downloaded) */
function dropStale() {
  const rec = readRecord();
  const used = new Set(Object.values(MANIFEST.packs).flatMap(p => p.files.map(f => f.name)));
  let freed = 0;
  for (const name of Object.keys(rec.files || {})) {
    if (used.has(name) || path.basename(name) !== name) continue;
    for (const n of [name, `${name}.part`]) { const file = path.join(dir(), n), sz = sizeOf(file); if (sz >= 0) { fs.rmSync(file, { force: true }); freed += sz; } }
    delete rec.files[name];
  }
  if (freed) { writeRecord(rec); console.log(`[Cadence] Removed ${(freed / 1048576).toFixed(0)} MB of files from an older models release`); }
}

async function download(id) {
  const p = MANIFEST.packs[id];
  if (!p) return { ok: false, error: 'No such pack' };
  if (current) return { ok: false, error: current.pack === id ? 'Already downloading' : 'Another pack is downloading' };
  fs.mkdirSync(dir(), { recursive: true });
  const abort = new AbortController();
  current = { pack: id, abort, done: 0, total: p.size };
  lastError = null;
  broadcast();
  const t0 = Date.now();
  console.log(`[Cadence] Downloading the ${p.title} pack (${(p.size / 1048576).toFixed(0)} MB) from ${MANIFEST.tag}`);
  try {
    for (const f of p.files) await fetchFile(f, abort.signal);
    dropStale();
    const rec = readRecord();
    rec.packs = { ...(rec.packs || {}), [id]: { tag: MANIFEST.tag, at: new Date().toISOString() } };
    writeRecord(rec);
    console.log(`[Cadence] ${p.title} pack ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return { ok: true };
  } catch (e) {
    const cancelled = abort.signal.aborted;
    if (!cancelled) { lastError = { pack: id, message: e.message }; console.warn(`[Cadence] ${p.title} pack: ${e.message}`); }
    else console.log(`[Cadence] ${p.title} pack: download stopped, ${(current.done / 1048576).toFixed(0)} MB kept to resume`);
    return { ok: false, error: cancelled ? 'cancelled' : e.message };
  } finally {
    current = null;
    broadcast();
  }
}

function remove(which) {
  if (isTiming()) return { ok: false, error: 'A song is being timed; try again when it is done' };
  const ids = which === 'all' ? Object.keys(MANIFEST.packs) : [which];
  if (ids.some(id => !MANIFEST.packs[id])) return { ok: false, error: 'No such pack' };
  if (current && ids.includes(current.pack)) return { ok: false, error: 'That pack is downloading; cancel it first' };
  let freed = 0;
  for (const id of ids) {
    for (const f of MANIFEST.packs[id].files) {
      for (const name of [f.name, `${f.name}.part`]) {
        const file = path.join(dir(), name), s = sizeOf(file);
        if (s >= 0) { fs.rmSync(file, { force: true }); freed += s; }
      }
    }
  }
  const rec = readRecord();
  for (const id of ids) {
    delete rec.packs?.[id];
    for (const f of MANIFEST.packs[id].files) if (rec.files) delete rec.files[f.name];
  }
  if (which === 'all') fs.rmSync(recordFile(), { force: true }); else if (fs.existsSync(dir())) writeRecord(rec);
  if (which === 'all') { try { if (!fs.readdirSync(dir()).length) fs.rmdirSync(dir()); } catch { /* not there */ } }
  if (lastError && ids.includes(lastError.pack)) lastError = null;
  console.log(`[Cadence] Deleted ${which === 'all' ? 'every pack' : `the ${MANIFEST.packs[which].title} pack`} (${(freed / 1048576).toFixed(0)} MB)`);
  broadcast();
  return { ok: true, freed };
}

ipcMain.handle('cadence:models', () => status());
ipcMain.handle('cadence:download', (e, id) => download(String(id)));
ipcMain.handle('cadence:cancel', () => { if (!current) return false; current.abort.abort(); return true; });
ipcMain.handle('cadence:delete', (e, id) => remove(String(id)));

app.on('before-quit', () => { try { current?.abort.abort(); } catch { /* gone */ } });

module.exports = { status, installed, dir, setTimingCheck: (fn) => { isTiming = fn; }, MANIFEST };
