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

const CHANNEL_TITLE = 'TeleCloud Music Library';
const CHANNEL_ABOUT = 'Private music library storage for TeleCloud';
const MAX_ATTEMPTS = 3;
const DEFAULT_OPTIONS = { encrypt: true, cacheLimitGB: 5, rateKBps: 0, paused: false };
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

/** Connect the worker with the saved session (once; again after it restarts) */
function ensureConnected() {
  if (connected) return connected;
  const creds = cm().getCredentials();
  if (!creds?.session) return Promise.reject(new Error('TeleCloud is not set up'));
  connected = worker.call('connect', { apiId: creds.apiId, apiHash: creds.apiHash, session: creds.session, masterKey: creds.masterKey || null })
    .then(async (me) => {
      await migrateLegacy(creds);
      return me;
    })
    .catch((err) => { connected = null; throw err; });
  return connected;
}
worker.events.on('exit', () => { connected = null; });

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
  if (!s) throw new Error('No storage chat yet. Finish TeleCloud setup first.');
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
    if (c.kind === 'manifest') { if (!c.needsKey && !c.wrongKey) store.storages.setManifest(storage.id, m.id, c.iv, m.date * 1000); continue; }
    if (c.kind === 'cover') { if (!c.needsKey && !c.wrongKey) store.covers.put(storage.id, c.key, m.id, c.iv); continue; }
    if (c.needsKey || c.wrongKey) { needKey++; continue; }
    const d = c.data;
    store.index.put(storage.id, { messageId: m.id, sha256: d.sha256, size: d.size || m.size, name: d.name || m.fileName, iv: d.iv || null, info: d.info || null, date: m.date * 1000 });
  }
  store.storages.setIndexed(storage.id, maxId);
  return { scanned: msgs.length, ours, needKey };
}

// ---------- backup queue ----------

let runner = null;
let activeJob = null;
let queueSnapshot = { active: null };

function queueState() {
  const counts = store.queue.counts();
  return { ...counts, paused: options().paused, running: !!runner, active: queueSnapshot.active, errors: store.queue.errors().slice(0, 10) };
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
  if (!fs.existsSync(item.path)) throw new Error('File is missing on disk');
  const storage = store.storages.get(item.storage_id) || defaultStorage();
  const size = fs.statSync(item.path).size;
  store.queue.set(item.path, 'uploading', { size });
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
    return 'linked';
  }

  const key = masterKey();
  const encrypt = options().encrypt && !!key;
  const iv = encrypt ? crypto.randomBytes(16).toString('base64') : null;
  const ext = path.extname(item.path).toLowerCase();
  const name = path.basename(item.path);
  const info = trackInfo(row);
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
    return 'uploaded';
  } finally {
    worker.call('forget', { jobId: activeJob.id }).catch(() => {});
    activeJob = null;
  }
}

function startRunner() {
  if (runner || options().paused) return runner;
  runner = (async () => {
    let sinceCheckpoint = 0;
    let lastCheckpoint = Date.now();
    try {
      await ensureConnected();
      // what is already in the chat (also catches uploads made from another computer)
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
        const item = store.queue.next();
        if (!item) break;
        try {
          await uploadOne(item);
          store.queue.set(item.path, 'done');
          sinceCheckpoint++;
          if (manifestDirty.size && (sinceCheckpoint >= CHECKPOINT_TRACKS || Date.now() - lastCheckpoint >= CHECKPOINT_MS) && store.queue.next()) {
            queueSnapshot.active = { name: 'Library index', stage: 'manifest', size: 0, bytes: 0, done: 0 };
            pushQueue();
            await writeDirtyManifests();
            sinceCheckpoint = 0;
            lastCheckpoint = Date.now();
          }
        } catch (err) {
          if (err.message === 'CANCELLED') { store.queue.set(item.path, 'queued'); break; }
          if (err.floodWait) {
            // Telegram asked us to slow down for longer than the client waits by itself
            store.queue.set(item.path, 'queued');
            queueSnapshot.active = { ...(queueSnapshot.active || {}), stage: 'waiting', waitUntil: Date.now() + err.floodWait * 1000 };
            pushQueue();
            await new Promise(r => setTimeout(r, err.floodWait * 1000));
            continue;
          }
          const attempts = (item.attempts || 0) + 1;
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
      send('telecloud-sync:queue-error', { error: err.message });
    } finally {
      queueSnapshot.active = null;
      runner = null;
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
// During a long backup the index is also saved along the way, so a crash or lost connection
// never leaves many uploaded tracks out of it
const CHECKPOINT_TRACKS = Number(process.env.TELECLOUD_MANIFEST_EVERY) || 25;
const CHECKPOINT_MS = 5 * 60 * 1000;
const manifestFile = (storageId) => path.join(app.getPath('userData'), 'telecloud', `manifest-${storageId}.json`);
const newIv = () => (options().encrypt && masterKey() ? crypto.randomBytes(16).toString('base64') : null);
const fullInfo = (row) => ({ ...trackInfo(row), lyrics: row.lyrics || null });

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

async function downloadSmall({ storage, messageId, iv }) {
  const tmp = path.join(getTempDir(), `tc-dl-${crypto.randomBytes(6).toString('hex')}`);
  const jobId = `sd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await worker.call('download', { jobId, peer: store.toPeer(storage), messageId, targetPath: tmp, iv: iv || null, sha256: null });
    return await fs.promises.readFile(tmp);
  } finally {
    fs.promises.rm(tmp, { force: true }).catch(() => {});
    worker.call('forget', { jobId }).catch(() => {});
  }
}

/** Upload the track's album cover once per storage; remember which cover the track uses */
async function ensureCover(libraryPath, storage) {
  const cj = await covers.coverJpeg(libraryPath);
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
  const buf = await downloadSmall({ storage: s, messageId: s.manifest_id, iv: s.manifest_iv });
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
  const data = { v: 1, at: Date.now(), tracks, covers: store.covers.all(s.id).map(c => ({ key: c.cover_key, id: c.message_id, iv: c.iv })) };
  const iv = newIv();
  const id = await uploadSmall({
    storage: s, buffer: zlib.gzipSync(Buffer.from(JSON.stringify(data))), iv, mime: 'application/gzip',
    fileName: iv ? 'library.tcm' : 'telecloud-library.json.gz',
    caption: buildManifestCaption({ iv, master: masterKey() }),
  });
  await worker.call('pin', { peer: store.toPeer(s), id }).catch(err => console.error('[TeleCloud] pin failed:', err.message));
  const old = s.manifest_id;
  store.storages.setManifest(s.id, id, iv);
  await saveManifestCache(s.id, id, data);
  if (old && old !== id) await worker.call('deleteMessages', { peer: store.toPeer(s), ids: [old] }).catch(() => {});
  return { id, tracks: tracks.length };
}

/**
 * Tags or lyrics of backed-up tracks changed in the app (lyrics editor, metadata editor): their
 * storages' index is rewritten shortly after, so other computers restore the new text. The audio
 * file itself is re-uploaded by the file watcher when its bytes changed.
 */
let indexTimer = null;
function indexChanged(paths) {
  for (const p of paths || []) {
    const row = store.library.row(p);
    const s = row?.telegram_message_id && store.storages.byPeer(row.telegram_channel_id);
    if (s) manifestDirty.add(s.id);
  }
  if (!manifestDirty.size) return;
  clearTimeout(indexTimer);
  indexTimer = setTimeout(async () => {
    if (runner || !cm().isAuthenticated()) return; // a running backup writes it at its next checkpoint
    try { await ensureConnected(); await writeDirtyManifests(); } catch (err) { console.warn('[TeleCloud] index update failed:', err.message); }
  }, 5000);
}

async function writeDirtyManifests() {
  for (const id of [...manifestDirty]) {
    manifestDirty.delete(id);
    try { await writeManifest(id); } catch (err) {
      manifestDirty.add(id); // tried again after the next backup
      console.error('[TeleCloud] manifest update failed:', err.message);
      send('telecloud-sync:queue-error', { error: `Couldn't save the library index (tags, lyrics, covers): ${err.message}. It is retried after the next backup, or use Save now.` });
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
  if (!row || !row.telegram_message_id) throw new Error('This track is not in TeleCloud');
  if (row.cache_path && isInAppStorage(row.cache_path) && fs.existsSync(row.cache_path)) {
    const now = new Date();
    fs.promises.utimes(row.cache_path, now, now).catch(() => {});
    return { path: row.cache_path, streaming: false };
  }
  const storage = store.storages.byPeer(row.telegram_channel_id);
  if (!storage) throw new Error('The Telegram chat for this track is not connected');
  await ensureConnected();
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
  await ensureConnected();
  const storage = defaultStorage();
  const biggest = store.index.all(storage.id).sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (!biggest) throw new Error('Back up at least one track first: the test downloads part of it');
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
    if (!row || !row.telegram_message_id) throw new Error('This track is not in TeleCloud');
    if (row.cache_path && isInAppStorage(row.cache_path) && fs.existsSync(row.cache_path)) {
      const now = new Date();
      fs.promises.utimes(row.cache_path, now, now).catch(() => {}); // recently used: evicted last
      return row.cache_path;
    }
    const storage = store.storages.byPeer(row.telegram_channel_id);
    if (!storage) throw new Error('The Telegram chat for this track is not connected');
    await ensureConnected();
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

/** Keep the cache under the limit, removing the least recently played files first */
async function enforceCacheLimit(keep) {
  const limit = (Number(options().cacheLimitGB) > 0 ? Number(options().cacheLimitGB) : DEFAULT_OPTIONS.cacheLimitGB) * 1024 ** 3;
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
    if (f.cache_path === keep) continue;
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
  await ensureConnected();
  const database = require('../database');
  let restored = 0, skipped = 0, updated = 0, needKey = 0, coversFetched = 0;
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
      title: info.title, artist: info.artist, album: info.album, year: info.year, genre: info.genre,
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
          database.insertOrUpdateFile({ ...rowFields(info), path: row.path, name: row.name, ext: row.ext, size: row.size, mtime: row.mtime, addedAt: row.created_at });
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
  }
  pushTracks([...added, ...changed]);
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

async function addStorage({ title, chatId }) {
  if (store.storages.count() >= MAX_STORAGES) throw new Error(`TeleCloud can use up to ${MAX_STORAGES} chats`);
  await ensureConnected();
  let added;
  if (chatId === 'self') {
    added = store.storages.add({ kind: 'self', peerId: 'self', title: 'Saved Messages' });
  } else if (chatId) {
    const chat = (await worker.call('listChats')).find(c => String(c.id) === String(chatId));
    if (!chat) throw new Error('That chat is not available to this account');
    added = store.storages.add({ kind: chat.kind === 'group' ? 'group' : 'channel', peerId: chat.id, accessHash: chat.accessHash, title: chat.title });
  } else {
    const name = String(title || '').trim().slice(0, 120);
    if (!name) throw new Error('Give the new channel a name');
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
  if (!s || !name) throw new Error('Nothing to rename');
  if (s.kind !== 'self') {
    await ensureConnected();
    await worker.call('renameChat', { peer: store.toPeer(s), title: name });
  }
  store.storages.rename(id, name);
}

/** Stop using a storage on this computer; its files stay in Telegram */
function removeStorage({ id }) {
  const s = store.storages.get(id);
  if (!s) return;
  if (store.storages.count() === 1) throw new Error('Keep at least one storage, or disconnect TeleCloud instead');
  const { gone, kept } = store.library.unlinkStorage(s.peer_id);
  store.storages.remove(id);
  fs.promises.rm(manifestFile(id), { force: true }).catch(() => {});
  pushTracks(kept, gone);
}

/** Queue tracks that aren't in TeleCloud yet for one storage; tell what was left out and why */
function backupTo({ paths, storageId }) {
  const storage = store.storages.get(storageId);
  if (!storage) throw new Error('Unknown storage');
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
  await ensureConnected();
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
    const unusedCovers = store.covers.all(src.id).filter(c => store.library.coverUsers(src.peer_id, c.cover_key) === 0);
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
  await ensureConnected();
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
    const unusedCovers = store.covers.all(s.id).filter(c => store.library.coverUsers(s.peer_id, c.cover_key) === 0);
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
  if (!creds?.session) return { success: true, isAuthenticated: false };
  const s = store.storages.default();
  const synced = store.library.syncedStats();
  const key = masterKey();
  return {
    success: true,
    isAuthenticated: true,
    phoneNumber: creds.phoneNumber,
    lastSync: creds.lastSync,
    syncedItems: synced.count,
    storageUsed: synced.bytes,
    storage: s ? { title: s.title, kind: s.kind } : null,
    index: s ? { savedAt: store.storages.get(s.id).manifest_at || null, tracks: store.index.all(s.id).length, covers: store.covers.all(s.id).length, pending: manifestDirty.has(s.id) } : null,
    storageLocation: s?.kind === 'self' ? 'saved_messages' : 'private_channel',
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
      return { success: false, error: err.message, floodWait: err.floodWait || null };
    }
  });

  ipcMain.handle('open-external', async (event, url) => {
    try {
      // Only plain https links; file:, ms-*, custom protocol handlers etc. could launch programs
      const parsed = new URL(String(url));
      if (parsed.protocol !== 'https:') return { success: false, error: 'Only https links can be opened' };
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  handle('telecloud-sync:check-auth', status);

  handle('telecloud-sync:save-temp-credentials', async ({ apiId, apiHash } = {}) => {
    if (!/^\d+$/.test(String(apiId || '')) || !/^[0-9a-f]{32}$/i.test(String(apiHash || ''))) throw new Error('API ID is a number and the API hash has 32 letters/digits');
    setup = { apiId: String(apiId), apiHash: String(apiHash) };
    return { success: true };
  });

  handle('telecloud-sync:send-code', async ({ phoneNumber, apiId, apiHash } = {}) => {
    setup = { ...setup, apiId: String(apiId || setup.apiId), apiHash: String(apiHash || setup.apiHash), phoneNumber };
    if (!setup.apiId || !setup.apiHash) throw new Error('API credentials not provided');
    const r = await worker.call('sendCode', { apiId: setup.apiId, apiHash: setup.apiHash, phone: phoneNumber });
    setup.phoneCodeHash = r.phoneCodeHash;
    return { success: true };
  });

  handle('telecloud-sync:verify-code', async ({ code, phoneNumber } = {}) => {
    if (!setup.phoneCodeHash) throw new Error('Request a new code first');
    const r = await worker.call('signIn', { phone: phoneNumber || setup.phoneNumber, phoneCodeHash: setup.phoneCodeHash, code });
    if (r.passwordNeeded) return { success: true, passwordNeeded: true };
    setup.session = r.session;
    return { success: true };
  });

  handle('telecloud-sync:check-password', async ({ password } = {}) => {
    const r = await worker.call('checkPassword', { password: String(password || '') });
    setup.session = r.session;
    return { success: true };
  });

  handle('telecloud-sync:complete-setup', async (config = {}) => {
    if (!setup.session) throw new Error('Sign in first');
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
    store.storages.clear();
    store.index.clear();
    store.queue.clear();
    return { success: true };
  });

  // Back up local tracks that have no cloud copy yet
  handle('telecloud-sync:sync-now', async () => {
    const storage = defaultStorage();
    const paths = store.library.notUploaded().filter(p => fs.existsSync(p));
    store.queue.add(paths, storage.id);
    setOptions({ paused: false });
    startRunner();
    pushQueue();
    return { success: true, queued: store.queue.counts().queued };
  });
  handle('telecloud-sync:stop-sync', async () => { await pauseQueue(); return { success: true }; });
  handle('telecloud-sync:resume', async () => { setOptions({ paused: false }); store.queue.retryErrors(); startRunner(); pushQueue(); return { success: true }; });
  handle('telecloud-sync:queue-state', async () => queueState());
  handle('telecloud-sync:check-sync-status', async () => ({ isSyncing: !!runner }));

  handle('telecloud-sync:cache-track', async (libraryPath) => {
    const p = await cacheTrack(String(libraryPath));
    const { toFrontend } = require('../music');
    return { success: true, path: p, file: toFrontend(store.library.row(String(libraryPath))) };
  });

  handle('telecloud-sync:stream-track', async (libraryPath) => ({ success: true, ...(await streamTrack(String(libraryPath))) }));
  // Write the library index now (also adds covers still missing for older backups)
  handle('telecloud-sync:save-index', async () => {
    await ensureConnected();
    const s = defaultStorage();
    await refreshIndex(s);
    for (const p of store.library.withoutCover(s.peer_id)) await ensureCover(p, s).catch(() => {});
    manifestDirty.delete(s.id);
    const r = await writeManifest(s.id);
    return { success: true, tracks: r.tracks, covers: store.covers.all(s.id).length };
  });
  handle('telecloud-sync:storages', async () => ({ success: true, storages: listStorages(), max: MAX_STORAGES }));
  handle('telecloud-sync:storage-candidates', async () => ({ success: true, chats: await storageCandidates() }));
  handle('telecloud-sync:storage-add', async (opts = {}) => ({ success: true, ...(await addStorage(opts)) }));
  handle('telecloud-sync:storage-rename', async (opts = {}) => { await renameStorage(opts); return { success: true, storages: listStorages() }; });
  handle('telecloud-sync:storage-default', async ({ id } = {}) => { store.storages.setDefault(id); return { success: true, storages: listStorages() }; });
  handle('telecloud-sync:storage-remove', async (opts = {}) => { removeStorage(opts); return { success: true, storages: listStorages() }; });
  handle('telecloud-sync:backup-to', async (opts = {}) => ({ success: true, ...backupTo({ paths: (opts.paths || []).map(String), storageId: opts.storageId }) }));
  handle('telecloud-sync:remove-from-cloud', async (opts = {}) => ({ success: true, ...(await removeFromCloud({ paths: (opts.paths || []).map(String) })) }));
  handle('telecloud-sync:move-to', async (opts = {}) => ({ success: true, ...(await moveTo({ paths: (opts.paths || []).map(String), storageId: opts.storageId })) }));
  handle('telecloud-sync:speed-test', async () => ({ success: true, ...(await speedTest()) }));

  handle('telecloud-sync:restore-from-cloud', async () => ({ success: true, ...(await restore()) }));

  // Only TeleCloud's own messages are deleted; the local library is kept (cloud links reset)
  handle('telecloud-sync:delete-all', async () => {
    await pauseQueue();
    await ensureConnected();
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
    setOptions(next);
    if (next.cacheLimitGB !== undefined) await enforceCacheLimit(null);
    return { success: true, options: options(), cacheBytes: await cacheUsage() };
  });

  handle('telecloud-sync:clear-cache', async () => {
    const cleared = [];
    for (const c of store.library.cached()) {
      if (isInAppStorage(c.cache_path)) await fs.promises.rm(c.cache_path, { force: true }).catch(() => {});
      store.library.setCache(c.path, null);
      cleared.push(c.path);
    }
    pushTracks(cleared);
    return { success: true };
  });

  // Backed-up files edited on disk: queue a fresh backup (the old cloud copy is replaced)
  require('../music').onCloudFilesChanged((paths) => {
    if (!store.storages.default() || !cm().isAuthenticated()) return;
    // back up into the storage that held the old copy
    for (const p of paths) {
      const row = store.library.row(p);
      const home = (row && store.storages.byPeer(row.telegram_channel_id)) || store.storages.default();
      store.queue.add([p], home.id);
    }
    startRunner();
    pushQueue();
  });

  cleanTemp().catch(() => {});
  // Resume a backup that was running when the app closed
  setTimeout(() => {
    try {
      if (cm().isAuthenticated() && !options().paused && store.queue.counts().queued) startRunner();
    } catch (err) { console.error('[TeleCloud] resume failed:', err.message); }
  }, 4000);
}

function cleanupTeleCloudSync() {
  worker.stop();
}

module.exports = { setupTeleCloudSyncHandlers, cleanupTeleCloudSync, indexChanged, _internals: { cacheTrack, refreshIndex, restore, startRunner, enforceCacheLimit, store, options, setOptions } };
