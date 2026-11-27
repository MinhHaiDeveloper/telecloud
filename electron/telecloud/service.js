// TeleCloud: your Telegram account as cloud storage for the library.
// Sign-in (with two-step verification), the backup queue, downloads into a size-capped cache,
// restore on another computer, and the encryption key. Telegram traffic itself runs in the
// worker process (worker.js); this file keeps the database and the UI in step.

const { ipcMain, shell, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const ElectronStore = require('electron-store');
const CredentialManager = require('../credentialManager');
const { getCacheDir, getTempDir, isInAppStorage } = require('../paths');
const covers = require('../covers');
const worker = require('./workerClient');
const { buildCaption, buildManifestCaption, buildCoverCaption, parseCaption, trackInfo } = require('./caption');
const { newMasterKey, fingerprint, toRecoveryKey, fromRecoveryKey } = require('./crypto');
const store = require('./store');
const { inferRow } = require('../inferTags');
const { getLibraryRoots } = require('../paths');
const { tx } = require('../i18n');

const CHANNEL_TITLE = 'TeleCloud Music Library';
const CHANNEL_ABOUT = 'Private music library storage for TeleCloud';
const MAX_ATTEMPTS = 3;
// autoBackup: new tracks in the music folders are backed up by themselves (off until turned on).
// schedule: backups wait for a time window, for every track or only chosen folders and albums (off until turned on).
const DEFAULT_SCHEDULE = { on: false, from: '01:00', to: '07:00', scope: 'all', folders: [], albums: [] };
const DEFAULT_OPTIONS = { encrypt: true, cacheLimitGB: 5, rateKBps: 0, paused: false, autoBackup: false, autoBackupStorage: null, schedule: DEFAULT_SCHEDULE };
const MIME = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.dsf': 'audio/dsf', '.dff': 'audio/dff', '.ape': 'audio/ape', '.wv': 'audio/wavpack' };

const kv = new ElectronStore.default({ name: 'telecloud-sync', encryptionKey: 'telecloud-sync-secure-key-v1' });
let cmInstance = null;
const cm = () => (cmInstance ||= new CredentialManager(kv));
const options = () => ({ ...DEFAULT_OPTIONS, ...(kv.get('teleCloudOptions') || {}) });
const setOptions = (patch) => kv.set('teleCloudOptions', { ...options(), ...patch });

const send = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
};

let setup = {};           // sign-in in progress
let connected = null;     // promise of the connected account
let keyCache = null;

function masterKey() {
  if (keyCache !== null) return keyCache || null;
  const k = cm().getCredentials()?.masterKey;
  keyCache = k ? Buffer.from(k, 'base64') : false;
  return keyCache || null;
}

// ---------- a sign-in Telegram has ended
// Telegram ends a sign-in that isn't used for a while (the account's "Automatically terminate old sessions",
// a week to a year), or when it is ended from another device. Every call then fails with one of these. The
// backups, the storages and the settings stay; only the sign-in has to be done again.
const SESSION_ENDED = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|AUTH_KEY_INVALID|AUTH_KEY_PERM_EMPTY|USER_DEACTIVATED/;
const sessionEnded = () => kv.get('teleCloudSessionEnded') || null;
/** Signed in, and Telegram still takes the sign-in */
const signedIn = () => cm().isAuthenticated() && !sessionEnded();
/** Telegram's choices (a week, 1, 3 or 6 months, a year) in words; any other number of days as days */
function ttlWords(days) {
  const d = Number(days);
  if (!d) return null;
  if (d === 7) return 'a week';
  if (d >= 28 && d <= 31) return 'a month';
  if (d >= 360 && d <= 366) return 'a year';
  const months = Math.round(d / 30.4);
  if (months >= 2 && Math.abs(d - months * 30.4) <= 3) return `${months} months`;
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}
function endedText(info) {
  const days = ttlWords(info?.ttlDays);
  if (/SESSION_REVOKED/.test(info?.reason || '')) return 'This sign-in was ended from Telegram (Settings > Devices, on another device).';
  if (/USER_DEACTIVATED/.test(info?.reason || '')) return 'Telegram says this account is deactivated.';
  return `Telegram ends a sign-in that isn't used for ${days || 'a while'} (Telegram > Settings > Devices > Automatically terminate old sessions), or when it is ended from another device.`;
}
function markSessionEnded(err) {
  const reason = (String(err?.message || err).match(SESSION_ENDED) || ['AUTH_KEY_UNREGISTERED'])[0];
  if (!sessionEnded()) {
    const info = { at: Date.now(), reason, ttlDays: kv.get('teleCloudSessionTtl') || null };
    kv.set('teleCloudSessionEnded', info);
    console.warn(`[TeleCloud] Telegram ended this sign-in (${reason}${info.ttlDays ? `; this account ends sign-ins unused for ${ttlWords(info.ttlDays)}` : ''}). Backups and settings are kept; sign in again to carry on.`);
    send('telecloud-sync:session-ended', info);
  }
  connected = null;
}
/** What the window shows for a call that failed because the sign-in ended */
const endedError = () => `Telegram signed TeleCloud out. ${endedText(sessionEnded())} Your backups and settings are kept: sign in again in Settings > TeleCloud Sync to carry on.`;

/** Connect the worker with the saved session (once; again after it restarts) */
function ensureConnected() {
  if (connected) return connected;
  const creds = cm().getCredentials();
  if (!creds?.session) return Promise.reject(new Error(tx('TeleCloud is not set up')));
  if (sessionEnded()) return Promise.reject(new Error(endedError()));
  connected = worker.call('connect', { apiId: creds.apiId, apiHash: creds.apiHash, session: creds.session, masterKey: creds.masterKey || null })
    .then(async (me) => {
      await migrateLegacy(creds);
      // how long Telegram keeps this sign-in without use, for the TeleCloud page (and the message if it ends)
      worker.call('sessionTtl').then(r => { if (r?.days) kv.set('teleCloudSessionTtl', r.days); }).catch(() => {});
      return me;
    })
    .catch((err) => {
      connected = null;
      if (SESSION_ENDED.test(err.message || '')) { markSessionEnded(err); throw new Error(endedError()); }
      throw err;
    });
  return connected;
}
worker.events.on('exit', () => { connected = null; keyInWorker = false; });

// ---------- storages of any kind ----------
// A storage is a Telegram chat or a folder (a drive, a NAS share). Only Telegram needs the sign-in; a
// folder only needs the worker to hold the encryption key, which connecting to Telegram also gives it.

let keyInWorker = false;
const hasTelegramStorage = () => store.storages.all().some(store.isTelegram);
/** Backups can run: there is somewhere to put them, and the Telegram sign-in holds if a chat is one of them */
const cloudReady = () => store.storages.count() > 0 && (!hasTelegramStorage() || signedIn());

/** What a job needs before it touches these storages */
async function readyFor(storages) {
  const list = (Array.isArray(storages) ? storages : [storages]).filter(Boolean);
  if (list.some(store.isTelegram)) { await ensureConnected(); keyInWorker = true; return; }
  if (!keyInWorker) {
    await worker.call('setKey', { masterKey: cm().getCredentials()?.masterKey || null });
    keyInWorker = true;
  }
}
const readyForAll = () => readyFor(store.storages.all());

/** The encryption key, made on first use (a folder can be the first storage, before any Telegram sign-in) */
function ensureMasterKey() {
  const creds = cm().getCredentials();
  if (creds?.masterKey) return;
  cm().saveCredentials({ ...(creds || {}), masterKey: newMasterKey().toString('base64'), enabled: true });
  keyCache = null;
  keyInWorker = false;
}

/** Setups from earlier versions kept only a channel id and "restored/..." paths */
async function migrateLegacy(creds) {
  if (!store.storages.all().length && creds.channelId) {
    const ch = await worker.call('findChannel', { id: creds.channelId });
    if (ch) store.storages.add({ kind: 'channel', peerId: ch.id, accessHash: ch.accessHash, title: ch.title, isDefault: true });
  }
  store.library.migrateLegacyPaths();
}

function defaultStorage() {
  const s = store.storages.default();
  if (!s) throw new Error(tx('No storage chat yet. Finish TeleCloud setup first.'));
  return s;
}

// ---------- index of what is in the cloud ----------

/** Read new file messages of a storage chat into cloud_index (incremental by message id) */
async function refreshIndex(storage, { full = false } = {}) {
  if (full) store.storages.resetIndex(storage.id);
  const fresh = store.storages.get(storage.id);
  const msgs = await worker.call('listMessages', { peer: store.toPeer(fresh), minId: fresh.last_indexed_id || 0 });
  const key = masterKey();
  let needKey = 0;
  let maxId = fresh.last_indexed_id || 0;
  const ours = [];
  for (const m of msgs) {
    maxId = Math.max(maxId, m.id);
    const c = parseCaption(m.caption, key);
    if (!c.ours) continue;
    ours.push(m.id);
    if (c.kind === 'manifest') { if (!c.needsKey && !c.wrongKey) store.storages.setManifest(storage.id, m.id, c.iv, m.date * 1000, false, c.sha256); continue; }
    if (c.kind === 'cover') { if (!c.needsKey && !c.wrongKey) store.covers.put(storage.id, c.key, m.id, c.iv); continue; }
    if (c.needsKey || c.wrongKey) { needKey++; continue; }
    const d = c.data;
    store.index.put(storage.id, { messageId: m.id, sha256: d.sha256, size: d.size || m.size, name: d.name || m.fileName, iv: d.iv || null, info: d.info || null, date: m.date * 1000 });
  }
  store.storages.setIndexed(storage.id, maxId);
  return { scanned: msgs.length, ours, needKey };
}

// ---------- checking the backup ----------

/**
 * Compare the library and its index with what is really in each chat. Reads the list of messages
 * only: nothing is downloaded or changed, so damage inside a file of the right size can't be seen.
 */
async function checkBackup() {
  if (runner) throw new Error(tx('A backup is running. Check again when it has finished.'));
  await readyForAll();
  const key = masterKey();
  const db = store.db();
  const totals = { tracks: 0, ok: 0, missing: 0, damaged: 0, unreadable: 0, extra: 0, indexOnly: 0, coversMissing: 0 };
  const out = [];
  for (const s of store.storages.all()) {
    const msgs = await worker.call('listMessages', { peer: store.toPeer(s), minId: 0 });
    const real = new Map();
    let unreadable = 0;
    for (const m of msgs) {
      const c = parseCaption(m.caption, key);
      // a file whose caption was edited away is still there: keep it, it just can't be identified
      const bad = !!(c.ours && (c.needsKey || c.wrongKey));
      if (bad) unreadable++;
      real.set(m.id, { size: m.size, kind: c.ours ? c.kind : null, unreadable: bad, declared: c.data?.size });
    }
    const rows = db.prepare('SELECT path, title, name, size, telegram_message_id AS id, storage_type, cloud_cover, cache_path FROM music_files WHERE telegram_channel_id = ? AND telegram_message_id IS NOT NULL').all(String(s.peer_id));
    const index = new Map(store.index.all(s.id).map(e => [e.message_id, e]));
    let manifest = null;
    let manifestState = 'ok';
    if (!s.manifest_id) manifestState = rows.length ? 'missing' : 'ok';
    else if (!real.has(s.manifest_id)) manifestState = 'missing from Telegram';
    else {
      try { manifest = await loadManifest(s); if (!manifest) manifestState = 'unreadable'; } catch { manifestState = 'unreadable'; }
    }
    const missing = [];
    const damaged = [];
    const linked = new Set();
    let ok = 0;
    for (const r of rows) {
      linked.add(r.id);
      const hasLocal = !r.path.startsWith('tc://') && fs.existsSync(r.path);
      const cached = !hasLocal && !!r.cache_path && fs.existsSync(r.cache_path);
      const item = { path: r.path, title: r.title || r.name || path.basename(r.path), hasLocal, cached, id: r.id, storageId: s.id };
      const m = real.get(r.id);
      if (!m) { missing.push(item); continue; }
      // the size recorded when it was uploaded; a tag edit on this computer doesn't change the copy
      const expected = index.get(r.id)?.size || m.declared;
      if (expected && m.size !== expected) { damaged.push(item); continue; }
      ok++;
    }
    const known = new Set([...linked, ...(manifest?.tracks || []).map(t => t.id)]);
    let extra = 0;
    for (const [id, m] of real) if (m.kind === 'track' && !m.unreadable && !known.has(id)) extra++;
    const indexOnly = (manifest?.tracks || []).filter(t => !real.has(t.id) && !linked.has(t.id)).length;
    const coverKeys = new Set([...rows.map(r => r.cloud_cover).filter(Boolean), ...require('../artistImages').gifsInStorage(s.peer_id).map(g => g.key)]);
    const missingCovers = [...coverKeys].filter((k) => { const c = store.covers.get(s.id, k); return !c || !real.has(c.message_id); });
    const coversMissing = missingCovers.length;
    const manifestOk = manifestState === 'ok';
    out.push({ id: s.id, title: s.title || 'Storage', missing, damaged, manifestOk, manifestState, unreadable, extra, indexOnly, coversMissing, missingCovers, ok });
    totals.tracks += rows.length;
    totals.ok += ok;
    totals.missing += missing.length;
    totals.damaged += damaged.length;
    totals.unreadable += unreadable;
    totals.extra += extra;
    totals.indexOnly += indexOnly;
    totals.coversMissing += coversMissing;
  }
  console.log(`[TeleCloud] Backup check: ${totals.tracks} tracks, ${totals.ok} fine, ${totals.missing} missing, ${totals.damaged} wrong size, ${totals.unreadable} unreadable, ${totals.coversMissing} covers missing, ${out.filter(s => !s.manifestOk).length} indexes to fix`);
  return { storages: out, totals };
}

/** Upload a cover the chat lost, from the copy kept here or from a track's own file. False if neither exists. */
async function restoreCover(storageId, key) {
  const s = store.storages.get(storageId);
  store.covers.remove(s.id, key);
  if (isArtistGif(key)) return require('../artistImages').hasGifKey(key); // the index goes back up with it
  const users = store.db().prepare('SELECT path FROM music_files WHERE telegram_channel_id = ? AND cloud_cover = ?').all(String(s.peer_id), key).map(r => r.path);
  const buffer = await covers.readIfExists(covers.cloudCoverFile(key));
  if (buffer && users.length) return !!await ensureCover(users[0], s, { key, buffer });
  for (const p of users) {
    if (fs.existsSync(p) && await ensureCover(p, s)) return true;
  }
  return false;
}

/** After a check: tracks still on this computer go back in the queue, lost covers go back, indexes that need it are saved */
async function repairBackup({ paths }) {
  if (runner) throw new Error(tx('A backup is running. Try again when it has finished.'));
  await readyForAll();
  const report = await checkBackup();
  const wanted = new Set(paths || []);
  const byStorage = new Map();
  const covers_ = { restored: 0, left: 0 };
  for (const s of report.storages) {
    for (const t of [...s.missing, ...s.damaged]) {
      if (!t.hasLocal || !wanted.has(t.path)) continue;
      const row = store.library.row(t.path);
      if (!row) continue;
      if (row.cache_path && isInAppStorage(row.cache_path)) await fs.promises.rm(row.cache_path, { force: true }).catch(() => {});
      store.db().prepare("UPDATE music_files SET storage_type = 'local', telegram_message_id = NULL, telegram_channel_id = NULL, cloud_checksum = NULL, cloud_cover = NULL, cache_path = NULL, last_synced_at = NULL WHERE path = ?").run(t.path);
      require('../database').deleteSyncState(t.path);
      store.index.remove(s.id, [t.id]);
      if (!byStorage.has(s.id)) byStorage.set(s.id, []);
      byStorage.get(s.id).push(t.path);
      manifestDirty.add(s.id);
    }
    // A wrong-size copy has to leave the chat: the next scan would index it again, and the upload
    // would see the same hash and link back to it. A copy another track still uses stays.
    const bad = [...new Set(s.damaged.filter(t => t.hasLocal && wanted.has(t.path)).map(t => t.id))]
      .filter(id => store.library.linkCount(store.storages.get(s.id).peer_id, id) === 0);
    if (bad.length) await worker.call('deleteMessages', { peer: store.toPeer(store.storages.get(s.id)), ids: bad });
    if (!s.manifestOk || s.indexOnly) manifestDirty.add(s.id);
    for (const key of s.missingCovers) {
      if (await restoreCover(s.id, key)) covers_.restored++; else covers_.left++;
      manifestDirty.add(s.id);
    }
  }
  let queued = 0;
  for (const [id, list] of byStorage) { store.queue.add(list, id); queued += list.length; }
  pushTracks([...byStorage.values()].flat());
  const index = manifestDirty.size > 0;
  if (index) await writeDirtyManifests();
  if (queued) { setOptions({ paused: false }); startRunner(); }
  console.log(`[TeleCloud] Backup repair: ${queued} tracks queued again, ${covers_.restored} covers put back, ${covers_.left} covers without a copy${index ? ', index saved' : ''}`);
  return { queued, index, covers: covers_.restored, coversLeft: covers_.left };
}

// ---------- backup queue ----------

let runner = null;
let activeJob = null;
let queueSnapshot = { active: null };

// ---------- the upload schedule: a time window, for everything or for chosen folders and albums

const minutesOf = (hm) => { const [h, m] = String(hm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
/** Now inside the window? It can run past midnight (23:30 to 06:00); from = to means all day. */
function inWindow(sch, d = new Date()) {
  const now = d.getHours() * 60 + d.getMinutes();
  const a = minutesOf(sch.from), b = minutesOf(sch.to);
  if (a === b) return true;
  return a < b ? now >= a && now < b : now >= a || now < b;
}
function msUntilWindow(sch, d = new Date()) {
  let mins = minutesOf(sch.from) - (d.getHours() * 60 + d.getMinutes());
  if (mins <= 0) mins += 1440;
  return mins * 60000 - d.getSeconds() * 1000 - d.getMilliseconds();
}
const under = (p, folder) => {
  const f = String(folder).replace(/[\\/]+$/, '').toLowerCase();
  const x = p.toLowerCase();
  return x === f || x.startsWith(`${f}\\`) || x.startsWith(`${f}/`);
};
/** Does the schedule cover this track? Everything, or the chosen folders and albums */
function inScope(sch, p) {
  if (sch.scope !== 'chosen') return true;
  if ((sch.folders || []).some(f => under(p, f))) return true;
  const row = store.library.row(p);
  if (!row) return false;
  const owner = (row.album_artist || row.artist || '').toLowerCase();
  return (sch.albums || []).some(a => (a.album || '').toLowerCase() === (row.album || '').toLowerCase() && (a.artist || '').toLowerCase() === owner);
}
let scheduleOverride = false; // "Back up now anyway": until this run ends
let scheduleTimer = null;
/** Waits for the window: the schedule is on, now is outside it, and the track is covered */
function held(p) {
  const sch = options().schedule;
  return !!(sch?.on && !scheduleOverride && !inWindow(sch) && inScope(sch, p));
}
/** The next backup that may go now (held ones are skipped, not reordered) */
function nextItem() {
  const first = store.queue.next();
  if (!first || !held(first.path)) return first;
  for (const it of store.queue.queued()) if (!held(it.path)) return it;
  return null;
}
/** Start the queue again when the window opens, if anything waits for it */
function planWindow() {
  clearTimeout(scheduleTimer);
  scheduleTimer = null;
  const sch = options().schedule;
  if (!sch?.on || inWindow(sch)) return;
  if (!store.queue.queued().some(it => held(it.path))) return;
  const ms = msUntilWindow(sch);
  scheduleTimer = setTimeout(() => { scheduleTimer = null; startRunner(); pushQueue(); }, ms);
  scheduleTimer.unref?.();
  console.log(`[TeleCloud] Backups wait for the upload window at ${sch.from} (in ${Math.round(ms / 60000)} min)`);
}

function queueState() {
  const counts = store.queue.counts();
  const sch = options().schedule;
  const waiting = sch?.on ? store.queue.queued().filter(it => held(it.path)).length : 0;
  return { ...counts, paused: options().paused, running: !!runner, active: queueSnapshot.active, errors: store.queue.errors().slice(0, 10), held: waiting, windowFrom: waiting ? sch.from : null, windowTo: waiting ? sch.to : null };
}
function pushQueue() {
  const s = queueState();
  send('telecloud-sync:queue', s);
  // the home card and the old progress UI listen to this one
  if (s.active) {
    const total = s.queued + s.done + s.error + 1;
    send('telecloud-sync:progress', { currentFile: s.active.name, current: s.done + s.error + 1, total, uploadProgress: s.active.size ? Math.round((s.active.bytes / s.active.size) * 100) : 0 });
  }
}

worker.events.on('progress', (p) => {
  if (activeJob && p.jobId === activeJob.id && queueSnapshot.active) {
    const now = Date.now();
    const a = queueSnapshot.active;
    const dt = (now - a.t) / 1000;
    if (dt >= 0.5) { a.speed = Math.max(0, (p.bytes - a.bytes) / dt); a.t = now; a.bytes = p.bytes; }
    a.size = p.size;
    a.done = p.bytes;
    pushQueue();
  }
  if (downloads.has(p.jobId)) send('telecloud-sync:download-progress', { path: downloads.get(p.jobId), progress: Math.round((p.bytes / p.size) * 100), bytes: p.bytes, size: p.size });
});

/** Tell the library view that tracks changed (cloud status, cache) or were removed */
function pushTracks(paths, removed = []) {
  try {
    const { toFrontend } = require('../music');
    const files = paths.map(p => store.library.row(p)).filter(Boolean).map(toFrontend);
    for (let i = 0; i < Math.max(files.length, removed.length); i += 500) {
      send('library:partial', { files: files.slice(i, i + 500), removed: removed.slice(i, i + 500) });
    }
  } catch { /* window gone */ }
}
const pushTrack = (p) => pushTracks([p]);

async function uploadOne(item) {
  const row = store.library.row(item.path);
  if (!row) { store.queue.set(item.path, 'done'); return 'gone'; }
  if (!fs.existsSync(item.path)) throw new Error(tx('File is missing on disk'));
  const storage = store.storages.get(item.storage_id) || defaultStorage();
  const size = fs.statSync(item.path).size;
  store.queue.set(item.path, 'uploading', { size });
  console.log(`[TeleCloud] Backing up ${item.path} (${(size / 1048576).toFixed(1)} MB${row.telegram_message_id ? ', replacing its old copy' : ''})`);
  queueSnapshot.active = { path: item.path, name: row.title || path.basename(item.path), size, bytes: 0, done: 0, speed: 0, t: Date.now(), stage: 'checking' };
  pushQueue();

  const { sha256 } = await worker.call('hashFile', { path: item.path });
  // the file changed since its last backup (e.g. edited tags): its old copy goes once this one is up
  const previous = row.telegram_message_id && row.cloud_checksum && row.cloud_checksum !== sha256 ? row.telegram_message_id : null;
  const previousStorage = previous ? store.storages.byPeer(row.telegram_channel_id) : null;
  const done = async (messageId, home = storage) => {
    store.library.linkUpload(item.path, { storage: home, messageId, sha256 });
    if (previous) {
      store.library.setCache(item.path, null);
      if (previousStorage && !(previous === messageId && previousStorage.id === home.id) && store.library.linkCount(previousStorage.peer_id, previous) === 0) {
        await worker.call('deleteMessages', { peer: store.toPeer(previousStorage), ids: [previous] }).catch(() => {});
        store.index.remove(previousStorage.id, [previous]);
        manifestDirty.add(previousStorage.id);
      }
    }
    await ensureCover(item.path, home).catch(err => console.error('[TeleCloud] cover upload failed:', err.message));
    manifestDirty.add(home.id);
    pushTrack(item.path);
  };
  // the same audio already in this or another storage: link to it (each track lives in one place)
  const existing = store.index.bySha(storage.id, sha256) || store.index.byShaAnywhere(sha256);
  if (existing) {
    await done(existing.message_id, store.storages.get(existing.storage_id) || storage);
    console.log(`[TeleCloud] Already backed up, linked: ${item.path}`);
    return 'linked';
  }

  const key = masterKey();
  const encrypt = options().encrypt && !!key;
  const iv = encrypt ? crypto.randomBytes(16).toString('base64') : null;
  const ext = path.extname(item.path).toLowerCase();
  const name = path.basename(item.path);
  const info = infoOf(row);
  const caption = buildCaption({ name, size, sha256, info, enc: encrypt ? { iv } : null, master: key });
  activeJob = { id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  queueSnapshot.active.stage = 'uploading';
  try {
    const res = await worker.call('upload', {
      jobId: activeJob.id, path: item.path, peer: store.toPeer(storage), caption, iv,
      fileName: encrypt ? `${sha256.slice(0, 16)}.tc` : name,
      mimeType: encrypt ? 'application/octet-stream' : (MIME[ext] || 'application/octet-stream'),
      rateBytes: (options().rateKBps || 0) * 1024,
    });
    store.index.put(storage.id, { messageId: res.messageId, sha256, size, name, iv, info, date: Date.now() });
    await done(res.messageId);
    console.log(`[TeleCloud] Backed up ${item.path}`);
    return 'uploaded';
  } finally {
    worker.call('forget', { jobId: activeJob.id }).catch(() => {});
    activeJob = null;
  }
}

function startRunner() {
  if (runner || options().paused) return runner;
  if (hasTelegramStorage() && sessionEnded()) return runner; // the queue waits for the sign-in; it starts by itself after it
  runner = (async () => {
    let sinceCheckpoint = 0;
    let lastCheckpoint = Date.now();
    try {
      await readyForAll();
      // what is already in each storage (also catches uploads made from another computer)
      for (const s of store.storages.all()) {
        await refreshIndex(s);
        // backed up before covers and the manifest existed: add them now
        if (!store.storages.get(s.id).manifest_id && store.index.all(s.id).length) {
          for (const p of store.library.withoutCover(s.peer_id)) {
            if (options().paused) break;
            await ensureCover(p, s).catch(() => {});
          }
          manifestDirty.add(s.id);
        }
      }
      for (;;) {
        if (options().paused) break;
        const item = nextItem();
        if (!item) break;
        try {
          await uploadOne(item);
          store.queue.set(item.path, 'done');
          sinceCheckpoint++;
          if (manifestDirty.size && (sinceCheckpoint >= CHECKPOINT_TRACKS || Date.now() - lastCheckpoint >= CHECKPOINT_MS) && nextItem()) {
            queueSnapshot.active = { name: 'Library index', stage: 'manifest', size: 0, bytes: 0, done: 0 };
            pushQueue();
            await writeDirtyManifests();
            sinceCheckpoint = 0;
            lastCheckpoint = Date.now();
          }
        } catch (err) {
          if (err.message === 'CANCELLED') { store.queue.set(item.path, 'queued'); break; }
          if (err.floodWait) {
            console.warn(`[TeleCloud] Telegram asked to wait ${err.floodWait} s`);
            // Telegram asked us to slow down for longer than the client waits by itself
            store.queue.set(item.path, 'queued');
            queueSnapshot.active = { ...(queueSnapshot.active || {}), stage: 'waiting', waitUntil: Date.now() + err.floodWait * 1000 };
            pushQueue();
            await new Promise(r => setTimeout(r, err.floodWait * 1000));
            continue;
          }
          if (SESSION_ENDED.test(err.message || '')) { store.queue.set(item.path, 'queued'); throw err; } // not this file's fault
          const attempts = (item.attempts || 0) + 1;
          console.error(`[TeleCloud] Backup failed (attempt ${attempts} of ${MAX_ATTEMPTS}): ${item.path}: ${err.message}`);
          store.queue.set(item.path, attempts >= MAX_ATTEMPTS ? 'error' : 'queued', { error: err.message, attempt: true });
          if (attempts < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 2000 * attempts));
        }
        queueSnapshot.active = null;
        pushQueue();
      }
      // full tags, lyrics and covers for other computers (also when paused: what is up is indexed)
      if (manifestDirty.size) {
        queueSnapshot.active = { name: 'Library index', stage: 'manifest', size: 0, bytes: 0, done: 0 };
        pushQueue();
        await writeDirtyManifests();
        queueSnapshot.active = null;
      }
      cm().updateCredentials({ lastSync: new Date().toISOString() });
    } catch (err) {
      console.error('[TeleCloud] backup stopped:', err.message);
      if (SESSION_ENDED.test(err.message || '')) markSessionEnded(err);
      send('telecloud-sync:queue-error', { error: sessionEnded() ? endedError() : err.message });
    } finally {
      queueSnapshot.active = null;
      runner = null;
      scheduleOverride = false;
      planWindow(); // what waits for the window starts by itself then
      pushQueue();
      send('telecloud-sync:stopped');
    }
  })();
  return runner;
}

async function pauseQueue() {
  setOptions({ paused: true });
  if (activeJob) await worker.call('cancel', { jobId: activeJob.id }).catch(() => {});
  pushQueue();
}

// ---------- library manifest and album covers ----------
// Captions only fit the basics, so each storage chat also holds:
//  - one small file per album cover (uploaded once, shared by the album's tracks), and
//  - a pinned "manifest": every track's full tags, lyrics and cover, gzipped (encrypted when
//    encryption is on). A new computer reads it to show the library exactly like the original.
// The manifest is rebuilt from what this computer knows, merged with the previous manifest
// (tracks uploaded elsewhere keep their info).

const manifestDirty = new Set();
const isArtistGif = (key) => String(key).startsWith('g');
// During a long backup the index is also saved along the way, so a crash or lost connection
// never leaves many uploaded tracks out of it
const CHECKPOINT_TRACKS = Number(process.env.TELECLOUD_MANIFEST_EVERY) || 25;
const CHECKPOINT_MS = 5 * 60 * 1000;
const manifestFile = (storageId) => path.join(app.getPath('userData'), 'telecloud', `manifest-${storageId}.json`);
const newIv = () => (options().encrypt && masterKey() ? crypto.randomBytes(16).toString('base64') : null);
// a file without tags keeps what the app worked out from its name and folders: another computer has neither
const infoOf = (row) => trackInfo(inferRow(row, getLibraryRoots()));
const fullInfo = (row) => ({ ...infoOf(row), lyrics: row.lyrics || null });

async function uploadSmall({ storage, buffer, fileName, caption, iv, mime }) {
  const tmp = path.join(getTempDir(), `tc-up-${crypto.randomBytes(6).toString('hex')}`);
  await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
  await fs.promises.writeFile(tmp, buffer);
  const jobId = `sm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const res = await worker.call('upload', { jobId, path: tmp, peer: store.toPeer(storage), caption, iv, fileName, mimeType: iv ? 'application/octet-stream' : mime });
    return res.messageId;
  } finally {
    fs.promises.rm(tmp, { force: true }).catch(() => {});
    worker.call('forget', { jobId }).catch(() => {});
  }
}

/** A small file (manifest, cover, GIF) into memory; with sha256, it must match (the worker checks it) */
async function downloadSmall({ storage, messageId, iv, sha256 = null }) {
  const tmp = path.join(getTempDir(), `tc-dl-${crypto.randomBytes(6).toString('hex')}`);
  const jobId = `sd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await worker.call('download', { jobId, peer: store.toPeer(storage), messageId, targetPath: tmp, iv: iv || null, sha256 });
    return await fs.promises.readFile(tmp);
  } finally {
    fs.promises.rm(tmp, { force: true }).catch(() => {});
    worker.call('forget', { jobId }).catch(() => {});
  }
}

/**
 * Which artists move in this chat, for the index. The newest choice wins, so a computer that has
 * not restored yet doesn't undo another's. A GIF nothing needs any more leaves the chat.
 */
async function artistGifs(s, prev) {
  const images = require('../artistImages');
  const keep = new Map();
  const wanted = (prev?.artists || []).filter((a) => { const st = images.gifState(a.name); return !st || st.at < a.at; });
  wanted.forEach(a => keep.set(a.name.toLowerCase(), a));
  for (const g of images.gifsInStorage(s.peer_id)) {
    if (keep.has(g.name.toLowerCase())) continue;
    try {
      if (!store.covers.get(s.id, g.key)) {
        const iv = newIv();
        const id = await uploadSmall({
          storage: s, buffer: await fs.promises.readFile(g.file), iv, mime: 'application/octet-stream', // never turned into a video by Telegram
          fileName: `${g.key}.${iv ? 'tcc' : 'tcg'}`, caption: buildCoverCaption({ key: g.key, iv, master: masterKey() }),
        });
        store.covers.put(s.id, g.key, id, iv);
      }
      keep.set(g.name.toLowerCase(), { name: g.name, key: g.key, at: g.at });
    } catch (err) { console.warn('[TeleCloud] artist GIF not uploaded:', err.message); }
  }
  const inUse = new Set([...keep.values()].map(a => a.key));
  const unused = store.covers.all(s.id).filter(c => isArtistGif(c.cover_key) && !inUse.has(c.cover_key));
  if (unused.length) {
    await worker.call('deleteMessages', { peer: store.toPeer(s), ids: unused.map(c => c.message_id) }).catch(() => {});
    unused.forEach(c => store.covers.remove(s.id, c.cover_key));
  }
  return [...keep.values()];
}

/** Upload the track's album cover once per storage; remember which cover the track uses */
async function ensureCover(libraryPath, storage, given) {
  const cj = given || await covers.coverJpeg(libraryPath);
  if (!cj) return null;
  store.library.setCover(libraryPath, cj.key);
  const local = covers.cloudCoverFile(cj.key);
  if (!fs.existsSync(local)) {
    await fs.promises.mkdir(path.dirname(local), { recursive: true });
    await fs.promises.writeFile(local, cj.buffer);
  }
  if (!store.covers.get(storage.id, cj.key)) {
    const iv = newIv();
    const id = await uploadSmall({
      storage, buffer: cj.buffer, iv, mime: 'image/jpeg',
      fileName: iv ? `${cj.key}.tcc` : `cover-${cj.key}.jpg`,
      caption: buildCoverCaption({ key: cj.key, iv, master: masterKey() }),
    });
    store.covers.put(storage.id, cj.key, id, iv);
  }
  return cj.key;
}

async function loadManifest(storage) {
  const s = store.storages.get(storage.id);
  if (!s?.manifest_id) return null;
  try {
    const cached = JSON.parse(await fs.promises.readFile(manifestFile(s.id), 'utf8'));
    if (cached.messageId === s.manifest_id) return cached.data;
  } catch { /* not cached yet */ }
  // checked against the checksum in its caption; one written before checksums (no manifest_sha) is read as before
  const buf = await downloadSmall({ storage: s, messageId: s.manifest_id, iv: s.manifest_iv, sha256: s.manifest_sha || null });
  const data = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  await saveManifestCache(s.id, s.manifest_id, data);
  return data;
}

async function saveManifestCache(storageId, messageId, data) {
  await fs.promises.mkdir(path.dirname(manifestFile(storageId)), { recursive: true });
  await fs.promises.writeFile(manifestFile(storageId), JSON.stringify({ messageId, data }));
}

async function writeManifest(storageId) {
  const s = store.storages.get(storageId);
  if (!s) return null;
  let prev = null;
  try { prev = await loadManifest(s); } catch (err) { console.error('[TeleCloud] previous manifest unreadable:', err.message); }
  const prevTracks = new Map((prev?.tracks || []).map(t => [t.id, t]));
  const tracks = store.index.all(s.id).map((e) => {
    const row = store.library.byMessage(s.peer_id, e.message_id);
    const old = prevTracks.get(e.message_id);
    return {
      id: e.message_id, sha256: e.sha256, size: e.size, name: e.name,
      info: row ? fullInfo(row) : (old?.info || (e.info ? JSON.parse(e.info) : {})),
      cover: row?.cloud_cover || old?.cover || null,
    };
  });
  const artists = await artistGifs(s, prev);
  const data = { v: 1, at: Date.now(), tracks, artists, covers: store.covers.all(s.id).map(c => ({ key: c.cover_key, id: c.message_id, iv: c.iv })) };
  const iv = newIv();
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  const id = await uploadSmall({
    storage: s, buffer: gz, iv, mime: 'application/gzip',
    fileName: iv ? 'library.tcm' : 'telecloud-library.json.gz',
    caption: buildManifestCaption({ iv, master: masterKey(), sha256: sha }),
  });
  await worker.call('pin', { peer: store.toPeer(s), id }).catch(err => console.error('[TeleCloud] pin failed:', err.message));
  const old = s.manifest_id;
  store.storages.setManifest(s.id, id, iv, Date.now(), true, sha);
  await saveManifestCache(s.id, id, data);
  console.log(`[TeleCloud] Index saved: ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}, ${data.covers.length} ${data.covers.length === 1 ? 'cover' : 'covers'}`);
  if (old && old !== id) await worker.call('deleteMessages', { peer: store.toPeer(s), ids: [old] }).catch(() => {});
  return { id, tracks: tracks.length };
}

/**
 * Tags or lyrics of backed-up tracks changed in the app (lyrics editor, metadata editor): their
 * storages' index is rewritten shortly after, so other computers restore the new text. The audio
 * file itself is re-uploaded by the file watcher when its bytes changed.
 */
let indexTimer = null;
/**
 * Delete replaced covers from the chat, unless a track still uses them. Tracks in the index that
 * this library doesn't have count too: their cover is only known from the last manifest.
 */
async function dropReplacedCovers(s, keys) {
  const replaced = [...new Set(keys)].map(k => store.covers.get(s.id, k)).filter(Boolean);
  if (!replaced.length) return;
  const manifest = await loadManifest(s);
  const known = new Map((manifest?.tracks || []).map(t => [t.id, t.cover]));
  const inUse = new Set(store.index.all(s.id).map(e => store.library.byMessage(s.peer_id, e.message_id)?.cloud_cover || known.get(e.message_id)));
  const unused = replaced.filter(c => !inUse.has(c.cover_key));
  if (!unused.length) return;
  await worker.call('deleteMessages', { peer: store.toPeer(s), ids: unused.map(c => c.message_id) });
  unused.forEach(c => store.covers.remove(s.id, c.cover_key));
}

/** A cover was chosen in the app: put the new picture in TeleCloud and the index, and drop the old one */
async function coversChanged(paths, previous = []) {
  const rows = (paths || []).map(p => store.library.row(p)).filter(r => r?.telegram_message_id);
  if (!rows.length || !cloudReady()) return;
  await readyForAll();
  const touched = new Map();
  for (const row of rows) {
    const s = store.storages.byPeer(row.telegram_channel_id);
    if (!s) continue;
    touched.set(s.id, s);
    if (fs.existsSync(row.path)) await ensureCover(row.path, s);
    else if (row.cloud_cover) {
      const buffer = await covers.readIfExists(covers.cloudCoverFile(row.cloud_cover));
      if (buffer) await ensureCover(row.path, s, { key: row.cloud_cover, buffer });
    }
  }
  for (const s of touched.values()) {
    await dropReplacedCovers(s, previous).catch(err => console.warn('[TeleCloud] old cover not removed:', err.message));
  }
  indexChanged(paths);
}

function indexChanged(paths) {
  for (const p of paths || []) {
    const row = store.library.row(p);
    const s = row?.telegram_message_id && store.storages.byPeer(row.telegram_channel_id);
    if (s) manifestDirty.add(s.id);
  }
  if (!manifestDirty.size) return;
  clearTimeout(indexTimer);
  indexTimer = setTimeout(async () => {
    if (runner || !cloudReady()) return; // a running backup writes it at its next checkpoint
    try { await readyForAll(); await writeDirtyManifests(); } catch (err) { console.warn('[TeleCloud] index update failed:', err.message); }
  }, 5000);
}

async function writeDirtyManifests() {
  for (const id of [...manifestDirty]) {
    manifestDirty.delete(id);
    try { await writeManifest(id); } catch (err) {
      manifestDirty.add(id); // tried again after the next backup
      console.error('[TeleCloud] manifest update failed:', err.message);
      send('telecloud-sync:queue-error', { error: tx('Couldn\'t save the library index (tags, lyrics, covers): {message}. It is retried after the next backup, or use Save now.', { message: err.message }) });
    }
  }
}

/** A cloud cover image on this computer (downloaded when a restored track needs it) */
async function fetchCover(storage, key, manifest) {
  const local = covers.cloudCoverFile(key);
  if (fs.existsSync(local)) return true;
  const known = store.covers.get(storage.id, key) || (manifest?.covers || []).find(c => c.key === key);
  const messageId = known?.message_id ?? known?.id;
  if (!messageId) return false;
  const buf = await downloadSmall({ storage, messageId, iv: known.iv });
  // a cover's key is the start of its SHA-1: what came back must be that picture
  if (/^[0-9a-f]{20}$/.test(key) && crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) !== key) {
    throw new Error(`The cover ${key} in TeleCloud does not match its checksum`);
  }
  await fs.promises.mkdir(path.dirname(local), { recursive: true });
  await fs.promises.writeFile(local, buf);
  return true;
}

// ---------- streaming ----------
// The worker serves cloud tracks at a local URL while it downloads them block by block
// (stream.js); here we hand out those URLs and record the cache file once a stream completes.

const streamKeys = new Map();   // stream key -> library path

worker.events.on('stream-progress', (p) => {
  const libraryPath = streamKeys.get(p.key);
  if (libraryPath) send('telecloud-sync:stream', { path: libraryPath, ranges: p.ranges, speed: p.speed, complete: p.complete });
});
worker.events.on('stream-complete', async (p) => {
  const libraryPath = streamKeys.get(p.key);
  if (!libraryPath) return;
  const row = store.library.row(libraryPath);
  store.library.setCache(libraryPath, p.path);
  if (row && row.storage_type === 'cloud') await readTagsFromCache(row, p.path);
  await enforceCacheLimit(p.path);
  pushTrack(libraryPath);
});
worker.events.on('stream-error', (p) => {
  const libraryPath = streamKeys.get(p.key);
  if (libraryPath) send('telecloud-sync:stream', { path: libraryPath, error: p.error });
});

/** A path or URL mpv can open for this track: the cached file, or a stream that fills the cache */
async function streamTrack(libraryPath) {
  const row = store.library.row(libraryPath);
  if (!row || !row.telegram_message_id) throw new Error(tx('This track is not in TeleCloud'));
  if (row.cache_path && isInAppStorage(row.cache_path) && fs.existsSync(row.cache_path)) {
    const now = new Date();
    fs.promises.utimes(row.cache_path, now, now).catch(() => {});
    return { path: row.cache_path, streaming: false };
  }
  const storage = store.storages.byPeer(row.telegram_channel_id);
  if (!storage) throw new Error(tx('The storage of this track is not connected'));
  await readyFor(storage);
  let entry = store.index.get(storage.id, row.telegram_message_id);
  if (!entry) { await refreshIndex(storage); entry = store.index.get(storage.id, row.telegram_message_id); }
  const finalPath = cacheFileFor(row, entry);
  const key = `${storage.id}-${row.telegram_message_id}`;
  streamKeys.set(key, libraryPath);
  const r = await worker.call('openStream', {
    key, peer: store.toPeer(storage), messageId: row.telegram_message_id, iv: entry?.iv || null,
    sha256: entry?.sha256 || row.cloud_checksum || null, size: entry?.size || row.size,
    ext: path.extname(finalPath), partPath: `${finalPath}.part`, finalPath,
  });
  require('../player').setStreamPrefix(r.prefix);
  return { path: r.url, streaming: true };
}

/** How fast Telegram delivers to this computer (downloads part of the biggest cloud file) */
async function speedTest() {
  const storage = defaultStorage();
  await readyFor(storage);
  const biggest = store.index.all(storage.id).sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (!biggest) throw new Error(tx('Back up at least one track first: the test downloads part of it'));
  return worker.call('speedTest', { peer: store.toPeer(storage), messageId: biggest.message_id, size: biggest.size });
}

// ---------- downloads into the cache ----------

const downloads = new Map();     // jobId -> library path (for progress events)
const inFlight = new Map();      // library path -> promise

function cacheFileFor(row, entry) {
  const ext = path.extname(entry?.name || row.name || row.path) || '.flac';
  const id = (entry?.sha256 || row.cloud_checksum || `${row.telegram_channel_id}-${row.telegram_message_id}`).slice(0, 24);
  return path.join(getCacheDir(), `${id}${ext.toLowerCase()}`);
}

async function cacheTrack(libraryPath) {
  if (inFlight.has(libraryPath)) return inFlight.get(libraryPath);
  const job = (async () => {
    const row = store.library.row(libraryPath);
    if (!row || !row.telegram_message_id) throw new Error(tx('This track is not in TeleCloud'));
    if (row.cache_path && isInAppStorage(row.cache_path) && fs.existsSync(row.cache_path)) {
      const now = new Date();
      fs.promises.utimes(row.cache_path, now, now).catch(() => {}); // recently used: evicted last
      return row.cache_path;
    }
    const storage = store.storages.byPeer(row.telegram_channel_id);
    if (!storage) throw new Error(tx('The storage of this track is not connected'));
    console.log(`[TeleCloud] Downloading to the cache: ${libraryPath}`);
    await readyFor(storage);
    let entry = store.index.get(storage.id, row.telegram_message_id);
    if (!entry) { await refreshIndex(storage); entry = store.index.get(storage.id, row.telegram_message_id); }
    const target = cacheFileFor(row, entry);
    const jobId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    downloads.set(jobId, libraryPath);
    try {
      await worker.call('download', { jobId, peer: store.toPeer(storage), messageId: row.telegram_message_id, targetPath: target, iv: entry?.iv || null, sha256: entry?.sha256 || row.cloud_checksum || null });
    } finally {
      downloads.delete(jobId);
      worker.call('forget', { jobId }).catch(() => {});
    }
    store.library.setCache(libraryPath, target);
    if (row.storage_type === 'cloud') await readTagsFromCache(row, target);
    await enforceCacheLimit(target);
    return target;
  })().finally(() => inFlight.delete(libraryPath));
  inFlight.set(libraryPath, job);
  return job;
}

/** A cloud-only track's first download fills in what the caption can't hold (lyrics, all tags) */
async function readTagsFromCache(row, file) {
  try {
    const database = require('../database');
    const { parseTrack } = require('../music');
    const data = await parseTrack(file, await fs.promises.stat(file));
    // The cache file has a hashed name: where the file has no tag, the reader falls back to that
    // name or "Unknown …". Keep what we already know (from the upload) in those cases.
    const fallback = { title: path.basename(file, path.extname(file)), artist: 'Unknown Artist', album: 'Unknown Album' };
    const known = { title: row.title, artist: row.artist, album: row.album, year: row.year, genre: row.genre, trackNumber: row.track_number, discNumber: row.disc_number };
    for (const [k, old] of Object.entries(known)) {
      if (old && (data[k] === undefined || data[k] === null || data[k] === '' || data[k] === fallback[k])) data[k] = old;
    }
    database.insertOrUpdateFile({ ...data, path: row.path, name: row.name, ext: row.ext, mtime: row.mtime, size: row.size, addedAt: row.created_at });
  } catch (err) {
    console.error('[TeleCloud] reading tags of cached track failed:', err.message);
  }
}

// ---------- kept offline: albums and playlists whose cloud tracks stay in the cache
// Sets are { label, kind: 'album' | 'playlist', paths }, by a key the page gives ("album:<key>", "playlist:<id>").
// The page sends a set's tracks again when they change (a track added to the playlist, restored into the album).
// Their cloud-only tracks are downloaded in the background, one at a time, and the cache limit never removes them.

const offlineSets = () => kv.get('offlineSets') || {};
const pinnedPaths = () => new Set(Object.values(offlineSets()).flatMap(s => s.paths || []));
const cloudOnly = (row) => !!row && (row.storage_type === 'cloud' || row.path.startsWith('tc://')) && !!row.telegram_message_id;
const hasCache = (row) => !!row?.cache_path && isInAppStorage(row.cache_path) && fs.existsSync(row.cache_path);

async function offlineList() {
  const out = [];
  for (const [key, set] of Object.entries(offlineSets())) {
    let need = 0, ready = 0, bytes = 0;
    for (const p of set.paths || []) {
      const row = store.library.row(p);
      if (!cloudOnly(row)) continue;
      need++;
      if (hasCache(row)) { ready++; try { bytes += (await fs.promises.stat(row.cache_path)).size; } catch { /* gone */ } }
    }
    out.push({ key, label: set.label, kind: set.kind, tracks: (set.paths || []).length, cloudTracks: need, ready, bytes });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function setOffline({ key, label, kind, paths, on }) {
  key = String(key || '').slice(0, 300);
  if (!key) throw new Error('No album or playlist');
  const sets = offlineSets();
  if (!on) delete sets[key];
  else {
    const list = [...new Set((Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string').slice(0, 20000))];
    const same = sets[key] && sets[key].paths.length === list.length && sets[key].paths.every((p, i) => p === list[i]) && sets[key].label === label;
    if (same) return false;
    sets[key] = { label: String(label || key).slice(0, 200), kind: kind === 'playlist' ? 'playlist' : 'album', paths: list };
  }
  kv.set('offlineSets', sets);
  scheduleOfflineFetch(500);
  return true;
}

let offlineRun = null;
let offlineTimer = null;
const scheduleOfflineFetch = (ms = 2000) => { clearTimeout(offlineTimer); offlineTimer = setTimeout(() => { offlineTimer = null; fetchOffline(); }, ms); };
/** Download what the kept sets still miss; tells the page how far it is */
function fetchOffline() {
  if (offlineRun) { scheduleOfflineFetch(5000); return offlineRun; }
  offlineRun = (async () => {
    const todo = [...pinnedPaths()].map(p => store.library.row(p)).filter(r => cloudOnly(r) && !hasCache(r));
    if (!todo.length) return;
    console.log(`[TeleCloud] Keeping offline: ${todo.length} ${todo.length === 1 ? 'track' : 'tracks'} to download`);
    let done = 0, failed = 0;
    for (const row of todo) {
      if (!pinnedPaths().has(row.path)) continue; // unpinned meanwhile
      send('telecloud-sync:offline', { state: 'downloading', done, total: todo.length, name: row.title || path.basename(row.path) });
      try { await cacheTrack(row.path); } catch (err) { failed++; console.warn(`[TeleCloud] Keep offline: ${row.path}: ${err.message}`); }
      done++;
    }
    console.log(`[TeleCloud] Kept offline: ${done - failed} downloaded${failed ? `, ${failed} failed` : ''}`);
    send('telecloud-sync:offline', { state: 'done', done: done - failed, failed, total: todo.length });
  })().catch(err => console.error('[TeleCloud] keep offline:', err.message)).finally(() => { offlineRun = null; });
  return offlineRun;
}

/** Keep the cache under the limit, removing the least recently played files first. Kept offline: never removed. */
async function enforceCacheLimit(keep) {
  const limit = (Number(options().cacheLimitGB) > 0 ? Number(options().cacheLimitGB) : DEFAULT_OPTIONS.cacheLimitGB) * 1024 ** 3;
  const pinned = pinnedPaths();
  const files = [];
  for (const r of store.library.cached()) {
    if (!isInAppStorage(r.cache_path)) continue;
    try { const st = await fs.promises.stat(r.cache_path); files.push({ ...r, size: st.size, used: st.mtimeMs }); }
    catch { store.library.setCache(r.path, null); }
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  const evicted = [];
  files.sort((a, b) => a.used - b.used);
  for (const f of files) {
    if (total <= limit) break;
    if (f.cache_path === keep || pinned.has(f.path)) continue;
    await fs.promises.rm(f.cache_path, { force: true });
    store.library.setCache(f.path, null);
    evicted.push(f.path);
    total -= f.size;
  }
  if (evicted.length) pushTracks(evicted);
  return total;
}

async function cacheUsage() {
  let bytes = 0;
  for (const r of store.library.cached()) {
    try { bytes += (await fs.promises.stat(r.cache_path)).size; } catch { /* gone */ }
  }
  return bytes;
}

/** Leftovers from older versions (temp downloads) and interrupted downloads */
async function cleanTemp() {
  const dirs = [getCacheDir(), path.join(require('os').tmpdir(), 'telecloud')];
  for (const dir of dirs) {
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (n.endsWith('.part') || n.endsWith('.part.map') || (dir !== getCacheDir() && n.startsWith('telecloud_'))) await fs.promises.rm(path.join(dir, n), { force: true }).catch(() => {});
    }
  }
}

// ---------- restore ----------

async function restore() {
  await readyForAll();
  const database = require('../database');
  let restored = 0, skipped = 0, updated = 0, needKey = 0, coversFetched = 0, gifsFetched = 0;
  const added = [];
  const changed = [];
  for (const storage of store.storages.all()) {
    const r = await refreshIndex(storage, { full: true });
    needKey += r.needKey;
    let manifest = null;
    try { manifest = await loadManifest(storage); } catch (err) { console.error('[TeleCloud] manifest unreadable, using captions:', err.message); }
    const fromManifest = new Map((manifest?.tracks || []).map(t => [t.id, t]));
    const linked = store.library.linkedMessages(storage.peer_id);
    const wantCovers = new Map(); // cover key -> library paths
    const rowFields = (info) => ({
      title: info.title, artist: info.artist, album: info.album, albumArtist: info.albumArtist ?? '', year: info.year, genre: info.genre,
      trackNumber: info.track, discNumber: info.disc, duration: info.duration, bitrate: info.bitrate,
      sampleRate: info.sampleRate, bitDepth: info.bitDepth, codec: info.codec, lossless: info.lossless, lyrics: info.lyrics || null,
    });
    for (const e of store.index.all(storage.id)) {
      const m = fromManifest.get(e.message_id);
      const info = m?.info || (e.info ? JSON.parse(e.info) : {});
      if (linked.has(e.message_id)) {
        // a cloud-only track restored before (maybe from captions only): bring its info up to date
        const row = store.library.byMessage(storage.peer_id, e.message_id);
        if (row && row.storage_type === 'cloud' && m) {
          database.insertOrUpdateFile({ ...rowFields(info), albumArtist: info.albumArtist ?? row.album_artist, path: row.path, name: row.name, ext: row.ext, size: row.size, mtime: row.mtime, addedAt: row.created_at });
          if (m.cover) { store.library.setCover(row.path, m.cover); wantCovers.set(m.cover, [...(wantCovers.get(m.cover) || []), row.path]); }
          changed.push(row.path);
          updated++;
        } else skipped++;
        continue;
      }
      const local = e.sha256 && store.library.byChecksum(e.sha256);
      if (local) { skipped++; continue; }
      const p = `tc://${storage.peer_id}/${e.message_id}`;
      database.insertOrUpdateFile({ ...rowFields(info), path: p, name: e.name || `${info.title || 'Track'}.flac`, ext: path.extname(e.name || '.flac'), size: e.size || 0, mtime: 0 });
      database.updateCloudMetadata(p, { storage_type: 'cloud', telegram_message_id: e.message_id, telegram_channel_id: storage.peer_id, cloud_checksum: e.sha256, last_synced_at: new Date(e.date || Date.now()).toISOString() });
      if (m?.cover) { store.library.setCover(p, m.cover); wantCovers.set(m.cover, [...(wantCovers.get(m.cover) || []), p]); }
      restored++;
      added.push(p);
    }
    // album covers: one small download per album
    for (const key of wantCovers.keys()) {
      try { if (await fetchCover(storage, key, manifest)) coversFetched++; } catch (err) { console.error('[TeleCloud] cover download failed:', err.message); }
    }
    // artists' GIFs: their tracks' tags only hold a still picture
    const images = require('../artistImages');
    for (const a of manifest?.artists || []) {
      try {
        if (!images.wantsGif(a)) continue;
        const known = store.covers.get(storage.id, a.key) || (manifest.covers || []).find(c => c.key === a.key);
        const messageId = known?.message_id ?? known?.id;
        if (messageId && await images.gifFromCloud(a, await downloadSmall({ storage, messageId, iv: known.iv }))) gifsFetched++;
      } catch (err) { console.error('[TeleCloud] artist GIF download failed:', err.message); }
    }
  }
  pushTracks([...added, ...changed]);
  if (restored || updated) require('../dataPort').scheduleResolve(); // tracks an import was waiting for
  console.log(`[TeleCloud] Restore: ${restored} added, ${updated} updated, ${skipped} already here, ${coversFetched} covers, ${gifsFetched} artist GIFs${needKey ? `, ${needKey} need the recovery key` : ''}`);
  if (Object.keys(offlineSets()).length) scheduleOfflineFetch(); // tracks of kept albums and playlists may be here now
  return { restoredCount: restored, skippedCount: skipped, updatedCount: updated, needKey, covers: coversFetched };
}

// ---------- storages (up to 5 chats) ----------
// Each track lives in exactly one storage. "Back up to" sends tracks that aren't in TeleCloud yet
// to a chosen storage; "Move to" forwards existing copies to another storage on Telegram's side
// (no re-upload) and removes them from the old one.

const MAX_STORAGES = 5;

function listStorages() {
  const stats = new Map(store.storages.stats().map(r => [String(r.peer), r]));
  return store.storages.all().map(s => ({
    id: s.id, title: s.title, kind: s.kind, peerId: s.peer_id, isDefault: !!s.is_default,
    location: s.kind === 'folder' ? store.configOf(s).root || null : null,
    tracks: stats.get(String(s.peer_id))?.tracks || 0, bytes: stats.get(String(s.peer_id))?.bytes || 0,
  }));
}

/** Chats that could become storages: Saved Messages and channels/supergroups this account runs */
async function storageCandidates() {
  await ensureConnected();
  const taken = new Set(store.storages.all().map(s => String(s.peer_id)));
  const chats = await worker.call('listChats');
  const out = chats.filter(c => !taken.has(String(c.id))).map(c => ({ id: c.id, title: c.title, kind: c.kind }));
  if (!taken.has('self')) out.unshift({ id: 'self', title: 'Saved Messages', kind: 'self' });
  return out;
}

/**
 * A folder as storage: a second drive, a NAS share. TeleCloud keeps its files in a "TeleCloud" folder
 * inside it, so a whole drive can be picked. No Telegram sign-in is needed; the encryption key is made
 * here if this is the first storage.
 */
async function addFolderStorage({ folder: picked, title }) {
  const chosen = path.resolve(String(picked || ''));
  if (!picked || !fs.existsSync(chosen)) throw new Error(tx('That folder can\'t be reached'));
  const root = path.basename(chosen).toLowerCase() === 'telecloud' ? chosen : path.join(chosen, 'TeleCloud');
  await fs.promises.mkdir(root, { recursive: true });
  const probe = path.join(root, `.write-test-${process.pid}`);
  try { await fs.promises.writeFile(probe, 'ok'); await fs.promises.rm(probe, { force: true }); } catch { throw new Error(tx('TeleCloud can\'t write in that folder')); }
  const peerId = `folder-${crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12)}`;
  if (store.storages.byPeer(peerId)) throw new Error(tx('That folder is already a storage'));
  ensureMasterKey();
  const name = String(title || '').trim().slice(0, 120) || path.basename(chosen) || chosen;
  return store.storages.add({ kind: 'folder', peerId, title: name, config: { root }, isDefault: store.storages.count() === 0 });
}

async function addStorage({ title, chatId, folder: picked }) {
  if (store.storages.count() >= MAX_STORAGES) throw new Error(tx('TeleCloud can use up to {MAX_STORAGES} storages', { MAX_STORAGES }));
  let added;
  if (picked) {
    added = await addFolderStorage({ folder: picked, title });
    await readyFor(added);
    // a folder used before (or by another computer) may already hold TeleCloud files
    const r = await refreshIndex(added, { full: true });
    if (!options().paused && store.queue.counts().queued) startRunner();
    return { storage: listStorages().find(s => s.id === added.id), existingFiles: store.index.all(added.id).length, needKey: r.needKey };
  }
  await ensureConnected();
  if (chatId === 'self') {
    added = store.storages.add({ kind: 'self', peerId: 'self', title: 'Saved Messages' });
  } else if (chatId) {
    const chat = (await worker.call('listChats')).find(c => String(c.id) === String(chatId));
    if (!chat) throw new Error(tx('That chat is not available to this account'));
    added = store.storages.add({ kind: chat.kind === 'group' ? 'group' : 'channel', peerId: chat.id, accessHash: chat.accessHash, title: chat.title });
  } else {
    const name = String(title || '').trim().slice(0, 120);
    if (!name) throw new Error(tx('Give the new channel a name'));
    const ch = await worker.call('createChannel', { title: name, about: CHANNEL_ABOUT });
    added = store.storages.add({ kind: 'channel', peerId: ch.id, accessHash: ch.accessHash, title: ch.title });
  }
  // a chat used before (or by another computer) may already hold TeleCloud files
  const r = await refreshIndex(added, { full: true });
  return { storage: listStorages().find(s => s.id === added.id), existingFiles: store.index.all(added.id).length, needKey: r.needKey };
}

async function renameStorage({ id, title }) {
  const s = store.storages.get(id);
  const name = String(title || '').trim().slice(0, 120);
  if (!s || !name) throw new Error(tx('Nothing to rename'));
  if (s.kind !== 'self' && store.isTelegram(s)) {
    await ensureConnected();
    await worker.call('renameChat', { peer: store.toPeer(s), title: name });
  }
  store.storages.rename(id, name);
}

/** Stop using a storage on this computer; its files stay in Telegram */
function removeStorage({ id }) {
  const s = store.storages.get(id);
  if (!s) return;
  if (store.storages.count() === 1) throw new Error(tx('Keep at least one storage, or disconnect TeleCloud instead'));
  const { gone, kept } = store.library.unlinkStorage(s.peer_id);
  store.storages.remove(id);
  fs.promises.rm(manifestFile(id), { force: true }).catch(() => {});
  pushTracks(kept, gone);
}

/** Queue tracks that aren't in TeleCloud yet for one storage; tell what was left out and why */
/** Where a new track belongs: the storage holding most of its album, else its folder's backed-up tracks */
function homeOf(row) {
  const owner = row.album_artist || row.artist;
  if (row.album && owner) {
    const a = store.library.albumHome(row.album, owner);
    const s = a && store.storages.byPeer(a.peer);
    if (s) return s;
  }
  const dir = path.dirname(row.path);
  const counts = new Map();
  for (const r of store.library.backedUpUnder(dir + path.sep)) {
    if (path.dirname(r.path).toLowerCase() !== dir.toLowerCase()) continue; // the same folder, not one below it
    counts.set(r.peer, (counts.get(r.peer) || 0) + 1);
  }
  const best = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  return (best && store.storages.byPeer(best[0])) || null;
}

function backupTo({ paths, storageId }) {
  const storage = store.storages.get(storageId);
  if (!storage) throw new Error('Unknown storage');
  if (store.isTelegram(storage) && sessionEnded()) throw new Error(endedError());
  const queued = [];
  const elsewhere = [];
  let missing = 0;
  for (const p of paths) {
    const row = store.library.row(p);
    if (!row) continue;
    if (row.telegram_message_id) { elsewhere.push(p); continue; }
    if (p.startsWith('tc://') || !fs.existsSync(p)) { missing++; continue; }
    queued.push(p);
  }
  if (queued.length) {
    store.queue.add(queued, storage.id);
    setOptions({ paused: false });
    startRunner();
    pushQueue();
  }
  return { queued: queued.length, alreadyInCloud: elsewhere.length, missing };
}

/** Forward tracks (and their covers) to another storage, then delete the old copies */
async function moveTo({ paths, storageId }) {
  const target = store.storages.get(storageId);
  if (!target) throw new Error('Unknown storage');
  await readyForAll();
  const bySource = new Map();
  for (const p of paths) {
    const row = store.library.row(p);
    if (!row?.telegram_message_id || String(row.telegram_channel_id) === String(target.peer_id)) continue;
    const src = store.storages.byPeer(row.telegram_channel_id);
    if (!src) continue;
    if (!bySource.has(src.id)) bySource.set(src.id, { src, rows: [] });
    bySource.get(src.id).rows.push(row);
  }
  let moved = 0;
  for (const { src, rows } of bySource.values()) {
    const ids = [...new Set(rows.map(r => r.telegram_message_id))];
    const newIds = await worker.call('forward', { fromPeer: store.toPeer(src), toPeer: store.toPeer(target), ids });
    const map = new Map(ids.map((id, i) => [id, newIds[i]]));
    for (const id of ids) {
      const e = store.index.get(src.id, id);
      store.index.put(target.id, { messageId: map.get(id), sha256: e?.sha256, size: e?.size, name: e?.name, iv: e?.iv, info: e?.info ? JSON.parse(e.info) : null, date: Date.now() });
    }
    for (const r of rows) store.library.relink(r.path, target.peer_id, map.get(r.telegram_message_id));
    // their album covers go along (forwarded too, unless the target already has them)
    const coverKeys = [...new Set(rows.map(r => r.cloud_cover).filter(Boolean))].filter(k => !store.covers.get(target.id, k));
    const coverRows = coverKeys.map(k => store.covers.get(src.id, k)).filter(Boolean);
    if (coverRows.length) {
      const newCoverIds = await worker.call('forward', { fromPeer: store.toPeer(src), toPeer: store.toPeer(target), ids: coverRows.map(c => c.message_id) });
      coverRows.forEach((c, i) => store.covers.put(target.id, c.cover_key, newCoverIds[i], c.iv));
    }
    // old copies: only those no other track still points at
    const orphaned = ids.filter(id => store.library.linkCount(src.peer_id, id) === 0);
    if (orphaned.length) {
      await worker.call('deleteMessages', { peer: store.toPeer(src), ids: orphaned });
      store.index.remove(src.id, orphaned);
    }
    // covers no track of the old storage uses any more
    const unusedCovers = store.covers.all(src.id).filter(c => !isArtistGif(c.cover_key) && store.library.coverUsers(src.peer_id, c.cover_key) === 0);
    if (unusedCovers.length) {
      await worker.call('deleteMessages', { peer: store.toPeer(src), ids: unusedCovers.map(c => c.message_id) }).catch(() => {});
      unusedCovers.forEach(c => store.covers.remove(src.id, c.cover_key));
    }
    moved += rows.length;
    manifestDirty.add(src.id);
    manifestDirty.add(target.id);
    pushTracks(rows.map(r => r.path));
  }
  if (moved) await writeDirtyManifests();
  return { moved };
}

/**
 * Delete tracks from the storage that holds them (only those tracks; the rest of the storage
 * stays). Tracks with a file on this computer become plain local tracks; cloud-only tracks leave
 * the library, since TeleCloud held their only copy. Album covers nothing uses any more go too.
 */
async function removeFromCloud({ paths }) {
  await readyForAll();
  const database = require('../database');
  const byStorage = new Map();
  for (const p of paths) {
    const row = store.library.row(p);
    if (!row?.telegram_message_id) continue;
    const s = store.storages.byPeer(row.telegram_channel_id);
    if (!s) continue;
    if (!byStorage.has(s.id)) byStorage.set(s.id, { s, rows: [] });
    byStorage.get(s.id).rows.push(row);
  }
  const keptLocal = [];
  const gone = [];
  let deleted = 0;
  let shared = 0;
  for (const { s, rows } of byStorage.values()) {
    for (const row of rows) {
      if (row.cache_path && isInAppStorage(row.cache_path)) await fs.promises.rm(row.cache_path, { force: true }).catch(() => {});
      const cloudOnly = row.storage_type === 'cloud' || row.path.startsWith('tc://') || !fs.existsSync(row.path);
      if (cloudOnly) {
        database.deleteFile(row.path);
        gone.push(row.path);
      } else {
        store.db().prepare("UPDATE music_files SET storage_type = 'local', telegram_message_id = NULL, telegram_channel_id = NULL, cloud_checksum = NULL, cloud_cover = NULL, cache_path = NULL, last_synced_at = NULL WHERE path = ?").run(row.path);
        keptLocal.push(row.path);
      }
      database.deleteSyncState(row.path);
    }
    // a copy another file still points at (same audio) stays
    const ids = [...new Set(rows.map(r => r.telegram_message_id))];
    const free = ids.filter(id => store.library.linkCount(s.peer_id, id) === 0);
    shared += ids.length - free.length;
    if (free.length) {
      await worker.call('deleteMessages', { peer: store.toPeer(s), ids: free });
      store.index.remove(s.id, free);
      deleted += free.length;
    }
    const unusedCovers = store.covers.all(s.id).filter(c => !isArtistGif(c.cover_key) && store.library.coverUsers(s.peer_id, c.cover_key) === 0);
    if (unusedCovers.length) {
      await worker.call('deleteMessages', { peer: store.toPeer(s), ids: unusedCovers.map(c => c.message_id) }).catch(() => {});
      unusedCovers.forEach(c => store.covers.remove(s.id, c.cover_key));
    }
    manifestDirty.add(s.id);
  }
  pushTracks(keptLocal, gone);
  if (byStorage.size) await writeDirtyManifests();
  return { deleted, keptLocal: keptLocal.length, removedFromLibrary: gone.length, shared };
}

// ---------- status ----------

async function status() {
  const creds = cm().getCredentials();
  if (!creds?.session) {
    // folders only (a drive, a NAS): no Telegram account, the rest of the page works the same
    if (!store.storages.count()) return { success: true, isAuthenticated: false };
    const s = store.storages.default();
    const synced = store.library.syncedStats();
    const key = masterKey();
    return {
      success: true, isAuthenticated: true, telegram: false,
      lastSync: creds?.lastSync || null, syncedItems: synced.count, storageUsed: synced.bytes,
      storage: s ? { title: s.title, kind: s.kind } : null,
      index: s ? { savedAt: store.storages.get(s.id).manifest_at || null, tracks: store.index.all(s.id).length, covers: store.covers.all(s.id).length, pending: manifestDirty.has(s.id) } : null,
      storageLocation: 'folder',
      options: options(),
      encryption: { hasKey: !!key, fingerprint: key ? fingerprint(key) : null },
      cacheBytes: await cacheUsage(),
      queue: queueState(),
    };
  }
  const ended = sessionEnded();
  if (ended) {
    const s0 = store.storages.default();
    return { success: true, isAuthenticated: false, sessionEnded: { ...ended, text: endedText(ended) }, phoneNumber: creds.phoneNumber, storage: s0 ? { title: s0.title, kind: s0.kind } : null, syncedItems: store.library.syncedStats().count };
  }
  const s = store.storages.default();
  const synced = store.library.syncedStats();
  const key = masterKey();
  return {
    success: true,
    isAuthenticated: true,
    telegram: true,
    phoneNumber: creds.phoneNumber,
    lastSync: creds.lastSync,
    syncedItems: synced.count,
    storageUsed: synced.bytes,
    storage: s ? { title: s.title, kind: s.kind } : null,
    index: s ? { savedAt: store.storages.get(s.id).manifest_at || null, tracks: store.index.all(s.id).length, covers: store.covers.all(s.id).length, pending: manifestDirty.has(s.id) } : null,
    storageLocation: s?.kind === 'self' ? 'saved_messages' : s?.kind === 'folder' ? 'folder' : 'private_channel',
    sessionTtlDays: kv.get('teleCloudSessionTtl') || null,
    sessionTtlText: ttlWords(kv.get('teleCloudSessionTtl')),
    options: options(),
    encryption: { hasKey: !!key, fingerprint: key ? fingerprint(key) : null },
    cacheBytes: await cacheUsage(),
    queue: queueState(),
  };
}

// ---------- IPC ----------

function setupTeleCloudSyncHandlers() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    try { return await fn(...args); } catch (err) {
      console.error(`[TeleCloud] ${channel}:`, err.message);
      if (SESSION_ENDED.test(err.message || '')) markSessionEnded(err);
      return { success: false, error: sessionEnded() ? endedError() : err.message, floodWait: err.floodWait || null, sessionEnded: !!sessionEnded() };
    }
  });

  ipcMain.handle('open-external', async (event, url) => {
    try {
      // Only plain https links; file:, ms-*, custom protocol handlers etc. could launch programs
      const parsed = new URL(String(url));
      if (parsed.protocol !== 'https:') return { success: false, error: tx('Only https links can be opened') };
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  handle('telecloud-sync:check-auth', status);

  handle('telecloud-sync:save-temp-credentials', async ({ apiId, apiHash } = {}) => {
    if (!/^\d+$/.test(String(apiId || '')) || !/^[0-9a-f]{32}$/i.test(String(apiHash || ''))) throw new Error(tx('API ID is a number and the API hash has 32 letters/digits'));
    setup = { apiId: String(apiId), apiHash: String(apiHash) };
    return { success: true };
  });

  handle('telecloud-sync:send-code', async ({ phoneNumber, apiId, apiHash } = {}) => {
    setup = { ...setup, apiId: String(apiId || setup.apiId), apiHash: String(apiHash || setup.apiHash), phoneNumber };
    if (!setup.apiId || !setup.apiHash) throw new Error(tx('API credentials not provided'));
    const r = await worker.call('sendCode', { apiId: setup.apiId, apiHash: setup.apiHash, phone: phoneNumber });
    setup.phoneCodeHash = r.phoneCodeHash;
    setup.codeNext = r.next;
    console.log(`[TeleCloud] Login code sent: ${r.via}${r.next ? `, a resend would come by ${r.next}` : ''}${r.timeout ? ` after ${r.timeout} s` : ''}`);
    return { success: true, viaApp: r.viaApp, via: r.via, next: r.next, timeout: r.timeout };
  });

  // Resend. Telegram's resend means "another way" (SMS, a call): when it offers one, use it; when it has none
  // (SEND_CODE_UNAVAILABLE, or no next way given), ask for a code in the app again, as before.
  handle('telecloud-sync:resend-code', async () => {
    if (!setup.phoneCodeHash || !setup.phoneNumber) throw new Error(tx('Request a new code first'));
    let r;
    if (setup.codeNext) {
      r = await worker.call('resendCode', { phone: setup.phoneNumber, phoneCodeHash: setup.phoneCodeHash }).catch((err) => {
        if (/SEND_CODE_UNAVAILABLE/.test(err.message || '')) return null;
        throw err;
      });
    }
    if (!r) r = await worker.call('sendCode', { apiId: setup.apiId, apiHash: setup.apiHash, phone: setup.phoneNumber });
    setup.codeNext = r.next;
    setup.phoneCodeHash = r.phoneCodeHash;
    console.log(`[TeleCloud] Login code sent again: ${r.via}${r.next ? `, next by ${r.next}` : ''}`);
    return { success: true, viaApp: r.viaApp, via: r.via, next: r.next, timeout: r.timeout };
  });

  handle('telecloud-sync:verify-code', async ({ code, phoneNumber } = {}) => {
    if (!setup.phoneCodeHash) throw new Error(tx('Request a new code first'));
    const r = await worker.call('signIn', { phone: phoneNumber || setup.phoneNumber, phoneCodeHash: setup.phoneCodeHash, code }).catch((err) => {
      // each new code makes the last one stop working: say so in words
      if (/PHONE_CODE_INVALID/.test(err.message || '')) throw new Error(tx('That code does not match. Check it, or use the newest code Telegram sent.'));
      if (/PHONE_CODE_EXPIRED/.test(err.message || '')) throw new Error(tx('That code has expired. Ask for a new one.'));
      throw err;
    });
    if (r.passwordNeeded) return { success: true, passwordNeeded: true };
    setup.session = r.session;
    return { success: true };
  });

  handle('telecloud-sync:check-password', async ({ password } = {}) => {
    const r = await worker.call('checkPassword', { password: String(password || '') });
    setup.session = r.session;
    return { success: true };
  });

  // Sign in again after Telegram ended the sign-in: the same account, API keys, storages and settings
  handle('telecloud-sync:resign-start', async () => {
    const creds = cm().getCredentials();
    if (!creds?.apiId || !creds?.phoneNumber) throw new Error(tx('TeleCloud is not set up'));
    setup = { apiId: creds.apiId, apiHash: creds.apiHash, phoneNumber: creds.phoneNumber, resign: true };
    const r = await worker.call('sendCode', { apiId: setup.apiId, apiHash: setup.apiHash, phone: setup.phoneNumber });
    setup.phoneCodeHash = r.phoneCodeHash;
    setup.codeNext = r.next;
    console.log(`[TeleCloud] Login code sent: ${r.via} (signing in again)`);
    return { success: true, phoneNumber: setup.phoneNumber, viaApp: r.viaApp };
  });
  handle('telecloud-sync:resign-finish', async () => {
    if (!setup.resign || !setup.session) throw new Error(tx('Sign in first'));
    cm().updateCredentials({ session: setup.session });
    setup = {};
    kv.delete('teleCloudSessionEnded');
    connected = null;
    await ensureConnected();
    console.log('[TeleCloud] Signed in again; backups and settings carried on');
    if (!options().paused && store.queue.counts().queued) startRunner();
    pushQueue();
    send('telecloud-sync:stopped'); // every page that shows the TeleCloud status reads it again
    return { success: true };
  });

  handle('telecloud-sync:complete-setup', async (config = {}) => {
    if (!setup.session) throw new Error(tx('Sign in first'));
    kv.delete('teleCloudSessionEnded');
    const existing = cm().getCredentials();
    const keyB64 = existing?.masterKey || newMasterKey().toString('base64');
    cm().saveCredentials({
      apiId: setup.apiId, apiHash: setup.apiHash, phoneNumber: setup.phoneNumber, session: setup.session, masterKey: keyB64,
      enabled: true, autoSync: false, syncAudioFiles: true, storageLocation: config.storageLocation || 'private_channel', lastSync: null,
    });
    keyCache = null;
    setOptions({ encrypt: config.encrypt !== false, cacheLimitGB: Number(config.cacheLimitGB) || DEFAULT_OPTIONS.cacheLimitGB, paused: false });
    setup = {};
    connected = null;
    await ensureConnected();
    if (config.storageLocation === 'saved_messages') {
      store.storages.add({ kind: 'self', peerId: 'self', title: 'Saved Messages', isDefault: true });
    } else {
      const ch = await worker.call('ensureChannel', { title: CHANNEL_TITLE, about: CHANNEL_ABOUT });
      store.storages.add({ kind: 'channel', peerId: ch.id, accessHash: ch.accessHash, title: ch.title, isDefault: true });
    }
    const s = defaultStorage();
    const idx = await refreshIndex(s, { full: true });
    return { success: true, storage: { title: s.title }, existingFiles: store.index.all(s.id).length, needKey: idx.needKey };
  });

  handle('telecloud-sync:disconnect', async () => {
    await pauseQueue();
    await worker.call('disconnect').catch(() => {});
    worker.stop();
    connected = null;
    keyCache = null;
    cm().deleteCredentials();
    kv.delete('teleCloudOptions');
    kv.delete('teleCloudSessionEnded');
    kv.delete('teleCloudSessionTtl');
    store.storages.clear();
    store.index.clear();
    store.queue.clear();
    return { success: true };
  });

  // Back up local tracks that have no cloud copy yet
  handle('telecloud-sync:sync-now', async () => {
    if (hasTelegramStorage() && sessionEnded()) throw new Error(endedError()); // said once, here; no backup starts to fail again
    const storage = defaultStorage();
    const paths = store.library.notUploaded().filter(p => fs.existsSync(p));
    store.queue.add(paths, storage.id);
    setOptions({ paused: false });
    startRunner();
    pushQueue();
    return { success: true, queued: store.queue.counts().queued };
  });
  handle('telecloud-sync:stop-sync', async () => { await pauseQueue(); return { success: true }; });
  handle('telecloud-sync:resume', async () => { if (hasTelegramStorage() && sessionEnded()) throw new Error(endedError()); setOptions({ paused: false }); store.queue.retryErrors(); startRunner(); pushQueue(); return { success: true }; });
  handle('telecloud-sync:queue-state', async () => queueState());
  // outside the upload window: start the waiting backups now, this once
  handle('telecloud-sync:backup-now-anyway', async () => { scheduleOverride = true; setOptions({ paused: false }); startRunner(); pushQueue(); return { success: true }; });
  handle('telecloud-sync:offline-list', async () => ({ success: true, sets: await offlineList() }));
  handle('telecloud-sync:offline-set', async (opts = {}) => { const changed = setOffline(opts); return { success: true, changed, sets: await offlineList() }; });
  handle('telecloud-sync:check-sync-status', async () => ({ isSyncing: !!runner }));

  handle('telecloud-sync:cache-track', async (libraryPath) => {
    const p = await cacheTrack(String(libraryPath));
    const { toFrontend } = require('../music');
    return { success: true, path: p, file: toFrontend(store.library.row(String(libraryPath))) };
  });

  handle('telecloud-sync:stream-track', async (libraryPath) => ({ success: true, ...(await streamTrack(String(libraryPath))) }));
  // Write the library index now (also adds covers still missing for older backups)
  handle('telecloud-sync:save-index', async () => {
    const s = defaultStorage();
    await readyFor(s);
    await refreshIndex(s);
    for (const p of store.library.withoutCover(s.peer_id)) await ensureCover(p, s).catch(() => {});
    manifestDirty.delete(s.id);
    const r = await writeManifest(s.id);
    return { success: true, tracks: r.tracks, covers: store.covers.all(s.id).length };
  });
  handle('telecloud-sync:storages', async () => ({ success: true, storages: listStorages(), max: MAX_STORAGES }));
  handle('telecloud-sync:storage-candidates', async () => ({ success: true, chats: await storageCandidates() }));
  handle('telecloud-sync:storage-add', async (opts = {}) => ({ success: true, ...(await addStorage(opts)) }));
  // Windows' folder picker, for a folder storage (a drive, a NAS share)
  handle('telecloud-sync:pick-folder', async () => {
    const { dialog } = require('electron');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, { title: tx('Choose a folder for your backup'), properties: ['openDirectory', 'createDirectory'] });
    return { success: true, folder: r.canceled ? null : r.filePaths[0] || null };
  });
  handle('telecloud-sync:storage-rename', async (opts = {}) => { await renameStorage(opts); return { success: true, storages: listStorages() }; });
  handle('telecloud-sync:storage-default', async ({ id } = {}) => { store.storages.setDefault(id); return { success: true, storages: listStorages() }; });
  handle('telecloud-sync:storage-remove', async (opts = {}) => { removeStorage(opts); return { success: true, storages: listStorages() }; });
  handle('telecloud-sync:backup-to', async (opts = {}) => ({ success: true, ...backupTo({ paths: (opts.paths || []).map(String), storageId: opts.storageId }) }));
  handle('telecloud-sync:remove-from-cloud', async (opts = {}) => ({ success: true, ...(await removeFromCloud({ paths: (opts.paths || []).map(String) })) }));
  handle('telecloud-sync:move-to', async (opts = {}) => ({ success: true, ...(await moveTo({ paths: (opts.paths || []).map(String), storageId: opts.storageId })) }));
  handle('telecloud-sync:speed-test', async () => ({ success: true, ...(await speedTest()) }));

  handle('telecloud-sync:restore-from-cloud', async () => ({ success: true, ...(await restore()) }));
  handle('telecloud-sync:check-backup', async () => ({ success: true, ...(await checkBackup()) }));
  handle('telecloud-sync:check-repair', async (opts = {}) => ({ success: true, ...(await repairBackup({ paths: opts.paths })) }));

  // Only TeleCloud's own messages are deleted; the local library is kept (cloud links reset)
  handle('telecloud-sync:delete-all', async () => {
    await pauseQueue();
    await readyForAll();
    let deleted = 0;
    for (const storage of store.storages.all()) {
      const r = await refreshIndex(storage, { full: true });
      if (r.ours.length) deleted += (await worker.call('deleteMessages', { peer: store.toPeer(storage), ids: r.ours })).deleted;
      store.index.remove(storage.id, r.ours);
    }
    for (const c of store.library.cached()) if (isInAppStorage(c.cache_path)) await fs.promises.rm(c.cache_path, { force: true }).catch(() => {});
    const affected = store.library.cloudRows();
    store.library.resetCloud();
    // cloud-only tracks are gone; backed-up local tracks are plain local tracks again
    pushTracks(affected.filter(r => !r.cloudOnly).map(r => r.path), affected.filter(r => r.cloudOnly).map(r => r.path));
    for (const s of store.storages.all()) await fs.promises.rm(manifestFile(s.id), { force: true }).catch(() => {});
    store.index.clear();
    store.queue.clear();
    setOptions({ paused: false });
    return { success: true, deletedCount: deleted };
  });

  handle('telecloud-sync:get-recovery-key', async () => {
    const key = masterKey();
    return { success: true, key: key ? toRecoveryKey(key) : null, fingerprint: key ? fingerprint(key) : null };
  });

  // Use the key from another computer (needed to play files it encrypted)
  handle('telecloud-sync:set-recovery-key', async ({ key } = {}) => {
    const buf = fromRecoveryKey(key);
    cm().updateCredentials({ masterKey: buf.toString('base64') });
    keyCache = null;
    if (worker.isRunning()) await worker.call('setKey', { masterKey: buf.toString('base64') });
    return { success: true, fingerprint: fingerprint(buf) };
  });

  handle('telecloud-sync:set-options', async (patch = {}) => {
    const next = {};
    if (patch.encrypt !== undefined) next.encrypt = !!patch.encrypt;
    if (patch.cacheLimitGB !== undefined) next.cacheLimitGB = Math.min(2000, Math.max(0.5, Number(patch.cacheLimitGB) || DEFAULT_OPTIONS.cacheLimitGB));
    if (patch.rateKBps !== undefined) next.rateKBps = Math.max(0, Math.round(Number(patch.rateKBps) || 0));
    if (patch.autoBackup !== undefined) next.autoBackup = !!patch.autoBackup;
    if (patch.autoBackupStorage !== undefined) next.autoBackupStorage = store.storages.get(patch.autoBackupStorage) ? Number(patch.autoBackupStorage) : null;
    if (patch.schedule !== undefined) {
      const s = { ...DEFAULT_SCHEDULE, ...options().schedule, ...(patch.schedule || {}) };
      const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
      next.schedule = {
        on: !!s.on, from: hm(s.from, DEFAULT_SCHEDULE.from), to: hm(s.to, DEFAULT_SCHEDULE.to), scope: s.scope === 'chosen' ? 'chosen' : 'all',
        folders: [...new Set((Array.isArray(s.folders) ? s.folders : []).filter(f => typeof f === 'string' && path.isAbsolute(f)))].slice(0, 200),
        albums: (Array.isArray(s.albums) ? s.albums : []).filter(a => a && typeof a.album === 'string').map(a => ({ album: a.album.slice(0, 300), artist: String(a.artist || '').slice(0, 300) })).slice(0, 500),
      };
    }
    setOptions(next);
    if (next.schedule) { planWindow(); if (!runner) startRunner(); pushQueue(); }
    if (next.cacheLimitGB !== undefined) await enforceCacheLimit(null);
    return { success: true, options: options(), cacheBytes: await cacheUsage() };
  });

  handle('telecloud-sync:clear-cache', async () => {
    const cleared = [];
    const pinned = pinnedPaths(); // kept offline: stays
    for (const c of store.library.cached()) {
      if (pinned.has(c.path)) continue;
      if (isInAppStorage(c.cache_path)) await fs.promises.rm(c.cache_path, { force: true }).catch(() => {});
      store.library.setCache(c.path, null);
      cleared.push(c.path);
    }
    pushTracks(cleared);
    return { success: true };
  });

  // Backed-up files edited on disk: queue a fresh backup (the old cloud copy is replaced)
  require('../music').onCloudFilesChanged((paths) => {
    if (!store.storages.default() || !cloudReady()) return;
    // back up into the storage that held the old copy
    for (const p of paths) {
      const row = store.library.row(p);
      const home = (row && store.storages.byPeer(row.telegram_channel_id)) || store.storages.default();
      store.queue.add([p], home.id);
    }
    startRunner();
    pushQueue();
  });

  // New tracks in the music folders (Settings > TeleCloud Sync > Back up new tracks): each goes where its album
  // already is, else where its folder's backed-up tracks are, else the storage picked for new tracks
  require('../music').onTracksAdded((paths) => {
    const o = options();
    if (!o.autoBackup || !store.storages.all().length) return;
    const fallback = store.storages.get(o.autoBackupStorage) || store.storages.default();
    if (!fallback) return;
    const byStorage = new Map();
    for (const p of paths) {
      if (p.startsWith('tc://') || isInAppStorage(p)) continue;
      const row = store.library.row(p);
      if (!row || row.telegram_message_id) continue;
      const home = homeOf(row) || fallback;
      if (!byStorage.has(home.id)) byStorage.set(home.id, []);
      byStorage.get(home.id).push(p);
    }
    if (!byStorage.size) return;
    for (const [id, list] of byStorage) store.queue.add(list, id);
    const n = [...byStorage.values()].reduce((a, l) => a + l.length, 0);
    console.log(`[TeleCloud] Backing up ${n} new ${n === 1 ? 'track' : 'tracks'} by itself (${[...byStorage.keys()].map(id => store.storages.get(id)?.title).join(', ')})`);
    startRunner();
    pushQueue();
  });

  // kept offline: anything a set still misses (after a restart, a restore, a cleared cache)
  setTimeout(() => { if (Object.keys(offlineSets()).length) fetchOffline(); }, 20000).unref?.();
  planWindow();

  cleanTemp().catch(() => {});
  // Telegram ends a sign-in nobody uses: connecting when the app opens (and twice a day while it stays open)
  // counts as using it, and finds out early when it has ended
  // (a small request on the open connection: nothing playing or uploading is interrupted)
  const keepAlive = () => {
    if (!signedIn()) return;
    ensureConnected()
      .then(() => worker.call('sessionTtl'))
      .then((r) => { if (r?.days) kv.set('teleCloudSessionTtl', r.days); })
      .catch((err) => { if (SESSION_ENDED.test(err.message || '')) markSessionEnded(err); else console.warn('[TeleCloud] connect:', err.message); });
  };
  setTimeout(keepAlive, 15000);
  setInterval(keepAlive, 12 * 3600 * 1000).unref?.();
  // Resume a backup that was running when the app closed
  setTimeout(() => {
    try {
      if (cloudReady() && !options().paused && store.queue.counts().queued) startRunner();
    } catch (err) { console.error('[TeleCloud] resume failed:', err.message); }
  }, 4000);
}

function cleanupTeleCloudSync() {
  worker.stop();
}

/** For the saved log's report: counts and states only, no phone number, names, keys or file names */
async function logStatus() {
  const creds = cm().getCredentials();
  const ended = sessionEnded();
  const q = store.queue.counts();
  const s = store.storages.default();
  return {
    signIn: !creds?.session ? 'not signed in' : ended ? `ended by Telegram (${ended.reason}) at ${new Date(ended.at).toISOString()}` : 'signed in',
    unusedSignInKeptDays: kv.get('teleCloudSessionTtl') || null,
    encryption: options().encrypt !== false ? 'on' : 'off',
    hasKey: !!masterKey(),
    backups: `${q.queued || 0} waiting, ${q.error || 0} failed, ${options().paused ? 'paused' : runner ? 'running' : 'idle'}`,
    index: s ? (manifestDirty.has(s.id) ? 'changes not saved yet' : 'saved') : 'no storage',
    cache: `${(await cacheUsage() / 1073741824).toFixed(2)} GB of ${options().cacheLimitGB || DEFAULT_OPTIONS.cacheLimitGB} GB`,
  };
}

module.exports = { logStatus, setupTeleCloudSyncHandlers, cleanupTeleCloudSync, indexChanged, coversChanged, _internals: { cacheTrack, refreshIndex, restore, startRunner, enforceCacheLimit, store, options, setOptions } };
