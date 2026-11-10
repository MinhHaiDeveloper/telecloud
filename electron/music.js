// Local library: folder walking, metadata parsing, diffing against the database,
// plus the small JSON stores (favorites, playlists, recent, settings).

const { ipcMain, dialog, app, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const database = require('./database');
const { AUDIO_EXTENSIONS, getLibraryRoots, getDownloadFolder, isInLibrary, isInAppStorage, safeFileName } = require('./paths');

// ---------- metadata ----------

const { parseTrack } = require('./tags');
const { inferRow } = require('./inferTags');
const tagPool = require('./tagPool');

// The music folders, re-read at most once a second (only rows with missing tags need them)
let rootsCache = { at: 0, roots: [] };
const rootsNow = () => {
  if (Date.now() - rootsCache.at > 1000) rootsCache = { at: Date.now(), roots: getLibraryRoots() };
  return rootsCache.roots;
};

/** Database row → object the renderer works with. */
function toFrontend(dbRow) {
  // tags that are missing are filled in from the file name and folders, for display only
  const row = inferRow(dbRow, rootsNow());
  return {
    name: row.name || path.basename(row.path),
    path: row.path,
    ext: (row.ext || path.extname(row.path)).toLowerCase(),
    size: row.size,
    mtime: row.mtime,
    metadata: {
      title: row.title,
      artist: row.artist,
      album: row.album,
      albumArtist: row.album_artist || '',
      inferred: row.inferred || [],
      year: row.year,
      genre: row.genre,
      track: row.track_number || 0,
      disc: row.disc_number || 0,
      duration: row.duration,
      bitrate: row.bitrate,
      sampleRate: row.sample_rate,
      bitsPerSample: row.bit_depth,
      codec: row.codec,
      lossless: row.lossless,
      lyrics: row.lyrics || '',
    },
    hasCover: !!row.has_cover,
    storage_type: row.storage_type || 'local',
    telegram_message_id: row.telegram_message_id,
    telegram_channel_id: row.telegram_channel_id,
    cache_path: row.cache_path,
    cloud_checksum: row.cloud_checksum,
    last_synced_at: row.last_synced_at,
    added_at: row.created_at,
  };
}

// ---------- folder walking ----------

/**
 * Iterative walk (no recursion limit, skips hidden folders and symlink loops).
 * Returns the folders that could not be read, so their tracks aren't mistaken for deleted ones.
 */
async function walk(root, onFile) {
  const unreadable = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try { real = await fs.promises.realpath(dir); } catch { unreadable.push(dir); continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (err) {
      console.error(`[Library] Cannot read ${dir}: ${err.message}`);
      unreadable.push(dir);
      continue;
    }
    const audio = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) audio.push(full);
    }
    const stats = await Promise.all(audio.map(f => fs.promises.stat(f).catch(() => null)));
    stats.forEach((st, i) => { if (st) onFile(audio[i], st); });
  }
  return unreadable;
}

const isUnder = (file, dir) => {
  const rel = path.relative(dir.toLowerCase(), file.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// ---------- sync (refresh / full scan) ----------

let syncInFlight = null;
const cloudChangeListeners = [];
/** Called with the paths of backed-up files whose content changed on disk */
const onCloudFilesChanged = (fn) => cloudChangeListeners.push(fn);
function notifyCloudChanged(paths) {
  // their cloud copy is out of date: back them up again (TeleCloud replaces the old copy)
  paths.forEach(p => database.setStorageType(p, 'local'));
  cloudChangeListeners.forEach(fn => { try { fn(paths); } catch (err) { console.error('[Library] cloud change listener:', err.message); } });
}
let cancelRequested = false;
const BATCH = 200;          // rows per database transaction / UI update

const yieldToEventLoop = () => new Promise(r => setImmediate(r));

/**
 * Bring the database in line with the music folders.
 *  - refresh: parse only new files and files whose size/mtime changed; drop files that vanished
 *  - full:    re-read the tags of every file (after editing tags in another app, for example)
 * Cloud-backed tracks whose local copy disappeared are kept as cloud-only.
 *
 * Results are written and reported in batches (`onBatch`), so the library fills in while the
 * scan is still running and the main process never blocks for long.
 */
async function syncLibrary({ mode = 'refresh', onProgress, onBatch } = {}) {
  database.initDatabase();
  cancelRequested = false;
  const roots = getLibraryRoots();
  const progress = (p) => onProgress && onProgress(p);
  progress({ stage: 'indexing', current: 0, total: 0, message: 'Looking for music files…' });

  const onDisk = new Map();
  const unreadable = [];
  for (const root of roots) {
    unreadable.push(...await walk(root, (p, stat) => onDisk.set(p, stat)));
  }
  // A whole music folder offline (external drive unplugged, network share down)
  const unavailable = roots.filter(r => unreadable.some(u => isUnder(r, u)));

  const rows = database.getAllFiles();
  const byPath = new Map(rows.map(r => [r.path, r]));

  const toParse = [];
  const cloudChanged = []; // backed-up files that are different now (edited tags, re-encoded…)
  let unchanged = 0;
  for (const [p, stat] of onDisk) {
    const row = byPath.get(p);
    const changed = !row || Math.round(row.mtime) !== Math.round(stat.mtimeMs) || row.size !== stat.size;
    if (row && changed && row.telegram_message_id && (row.storage_type === 'both' || row.storage_type === 'cloud')) cloudChanged.push(p);
    if (mode === 'full' || changed) toParse.push({ p, stat, isNew: !row });
    else unchanged++;
  }
  // New files first, then folder by folder so the disk reads neighbouring files together
  toParse.sort((a, b) => (a.isNew === b.isNew ? (a.p < b.p ? -1 : 1) : a.isNew ? -1 : 1));

  // Files that are gone from disk (or whose folder was removed from the library)
  const removed = [];
  const demoted = [];
  for (const row of rows) {
    if (onDisk.has(row.path)) continue;
    // Can't see the folder right now: keep the track (and its lyrics, playlists, plays)
    if (unreadable.some(dir => isUnder(row.path, dir))) continue;
    const inCloud = row.telegram_message_id && (row.storage_type === 'both' || row.storage_type === 'cloud');
    if (inCloud) {
      if (row.storage_type !== 'cloud') demoted.push(row.path);
    } else if (!isInAppStorage(row.path)) {
      removed.push(row.path);
    }
  }
  // Backed-up files that are on disk again (moved back, drive reconnected): local + cloud again
  const promoted = rows.filter(r => r.storage_type === 'cloud' && r.telegram_message_id && onDisk.has(r.path)).map(r => r.path);

  if (removed.length) database.deleteFilesBatch(removed);
  demoted.forEach(p => database.setStorageType(p, 'cloud'));
  promoted.forEach(p => database.setStorageType(p, 'both'));
  if (onBatch && (removed.length || demoted.length || promoted.length)) {
    onBatch({ removed, files: database.getFilesByPaths([...demoted, ...promoted]).map(toFrontend) });
  }

  let added = 0;
  let updated = 0;
  let done = 0;
  const addedAt = Date.now();
  let pending = [];
  let lastProgress = 0;

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    database.insertOrUpdateFilesBatch(batch);
    if (onBatch) onBatch({ files: database.getFilesByPaths(batch.map(b => b.path)).map(toFrontend) });
    await yieldToEventLoop();
  };

  // Tags are read off the main thread in chunks; results are written as they come back
  const CHUNK = 40;
  let next = 0;
  const feeder = async () => {
    while (next < toParse.length && !cancelRequested) {
      const chunk = toParse.slice(next, next + CHUNK);
      next += chunk.length;
      const results = await tagPool.parseMany(chunk.map(({ p, stat }) => ({ path: p, mtimeMs: stat.mtimeMs, size: stat.size })));
      chunk.forEach(({ isNew }, i) => {
        pending.push({ ...results[i], addedAt });
        if (isNew) added++; else updated++;
      });
      done += chunk.length;
      if (pending.length >= BATCH) await flush();
      const now = Date.now();
      if (now - lastProgress > 250 || done === toParse.length) {
        lastProgress = now;
        progress({ stage: 'parsing', current: done, total: toParse.length, message: `Reading tags ${done.toLocaleString()} / ${toParse.length.toLocaleString()}` });
      }
    }
  };
  // Keep every worker busy: a few chunks in flight per worker
  await Promise.all(Array.from({ length: Math.min(tagPool.size() * 2, Math.ceil(toParse.length / CHUNK)) }, feeder));
  await flush();

  const cancelled = cancelRequested;
  cancelRequested = false;
  if (cloudChanged.length) notifyCloudChanged(cloudChanged);
  // With onBatch the UI already has every change; skip re-sending the whole library
  const files = onBatch ? null : database.getAllFiles().map(toFrontend);
  const total = files ? files.length : database.countFiles();
  const summary = { added, updated, removed: removed.length, unchanged, total, mode, cancelled, unavailable };
  progress({ stage: 'complete', current: total, total, message: cancelled ? `Stopped · ${describe(summary)}` : describe(summary) });
  console.log(`[Library] Sync (${mode}): ${total} tracks. ${describe(summary)}`);
  return files ? { files, ...summary } : summary;
}

function describe(s) {
  const parts = [];
  if (s.added) parts.push(`${s.added.toLocaleString()} added`);
  if (s.updated) parts.push(`${s.updated.toLocaleString()} ${s.mode === 'full' ? 're-read' : 'updated'}`);
  if (s.removed) parts.push(`${s.removed.toLocaleString()} removed`);
  if (s.unavailable?.length) parts.push(`${s.unavailable.length} ${s.unavailable.length === 1 ? 'folder' : 'folders'} offline, tracks kept`);
  return parts.length ? parts.join(' · ') : 'No changes';
}

const sendToUi = (ch, payload) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};

let rerunRequested = false;
const afterSync = () => {
  syncInFlight = null;
  if (rerunRequested) {
    rerunRequested = false;
    backgroundRefresh();
  }
};

/** Quiet refresh triggered by the folder watcher; queues itself if a scan is running. */
async function backgroundRefresh() {
  if (syncInFlight) { rerunRequested = true; return; }
  syncInFlight = syncLibrary({ mode: 'refresh', onBatch: (b) => sendToUi('library:partial', b) });
  try {
    const r = await syncInFlight;
    if (r.added || r.removed) sendToUi('library:partial', { summary: { added: r.added, removed: r.removed } });
  } catch (err) {
    console.error('[Library] Background refresh failed:', err.message);
  } finally {
    afterSync();
  }
}

/**
 * Libraries from before the album artist was stored: read that one tag for every file, once, in
 * the background. Only this column changes, so nothing counts as modified or is uploaded again.
 */
let backfillRan = false;
async function backfillAlbumArtists() {
  if (backfillRan) return;
  backfillRan = true;
  const d = database.initDatabase();
  const todo = d.prepare("SELECT path FROM music_files WHERE album_artist IS NULL AND path NOT LIKE 'tc://%'").all().map(r => r.path);
  const set = d.prepare('UPDATE music_files SET album_artist = ? WHERE path = ?');
  const backedUp = [];
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = [];
    for (const p of todo.slice(i, i + 40)) {
      const stat = await fs.promises.stat(p).catch(() => null);
      if (stat) chunk.push({ path: p, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    if (!chunk.length) continue;
    const results = await tagPool.parseMany(chunk);
    const changed = [];
    d.transaction(() => results.forEach((r, k) => {
      set.run(r.albumArtist || '', chunk[k].path);
      if (r.albumArtist) changed.push(chunk[k].path);
    }))();
    if (changed.length) {
      const rows = database.getFilesByPaths(changed);
      sendToUi('library:partial', { files: rows.map(toFrontend) });
      rows.forEach(r => { if (r.telegram_message_id) backedUp.push(r.path); });
    }
    await yieldToEventLoop();
  }
  if (backedUp.length) { try { require('./telecloud/service').indexChanged(backedUp); } catch { /* TeleCloud not set up */ } }
}

ipcMain.handle('library:sync', async (event, opts = {}) => {
  const mode = opts.mode === 'full' ? 'full' : 'refresh';
  if (syncInFlight) return { busy: true };
  const onProgress = opts.silent ? null : (p) => sendToUi('scan-progress', { ...p, mode });
  const onBatch = (b) => sendToUi('library:partial', b);
  syncInFlight = syncLibrary({ mode, onProgress, onBatch });
  try {
    const result = await syncInFlight;
    backfillAlbumArtists().catch(err => console.error('[Library] Album artist update failed:', err.message));
    return result;
  } finally {
    afterSync();
  }
});

// Stop a running scan; everything read so far is kept
ipcMain.handle('library:cancel', () => {
  if (syncInFlight) cancelRequested = true;
  return { success: true };
});

ipcMain.handle('load-library', async () => {
  try {
    return database.getAllFiles().map(toFrontend);
  } catch (err) {
    console.error('Error loading library from database:', err);
    return [];
  }
});

/** Used by the folder watcher for a single added/changed file. */
async function upsertSingleFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const before = database.getFileByPath(filePath);
  const data = await parseTrack(filePath, stat);
  database.insertOrUpdateFile(data);
  // a backed-up file whose bytes changed (tags edited here or in another program): back it up again
  if (before?.telegram_message_id && (before.storage_type === 'both' || before.storage_type === 'cloud')
    && (before.size !== stat.size || Math.round(before.mtime || 0) !== Math.round(stat.mtimeMs))) {
    notifyCloudChanged([filePath]);
  }
  return toFrontend(database.getFileByPath(filePath));
}

ipcMain.handle('select-music-folder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

// ---------- JSON stores ----------

const storePaths = {
  favorites: path.join(app.getPath('userData'), 'favorites.json'),
  playlists: path.join(app.getPath('userData'), 'playlists.json'),
  recent: path.join(app.getPath('userData'), 'recent.json'),
  settings: path.join(app.getPath('userData'), 'settings.json'),
  eq: path.join(app.getPath('userData'), 'eq.json'),
};
const OBJECT_STORES = new Set(['settings', 'eq']);

ipcMain.handle('load-store', async (event, storeName) => {
  try {
    const p = storePaths[storeName];
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`Error loading store ${storeName}:`, err);
  }
  return OBJECT_STORES.has(storeName) ? {} : [];
});

ipcMain.handle('save-store', async (event, storeName, data) => {
  const p = storePaths[storeName];
  if (!p) return false;
  try {
    if (storeName === 'settings') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
      // Folder lists must be absolute paths; anything else is dropped
      if (data.musicFolderList !== undefined) {
        data.musicFolderList = (Array.isArray(data.musicFolderList) ? data.musicFolderList : [])
          .filter(f => typeof f === 'string' && path.isAbsolute(f));
      }
      if (data.downloadFolder !== undefined && !(typeof data.downloadFolder === 'string' && path.isAbsolute(data.downloadFolder))) {
        delete data.downloadFolder;
      }
    } else if (storeName === 'eq') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    } else if (!Array.isArray(data)) {
      return false;
    }
    // Write atomically so a crash mid-write can't leave a truncated file
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    console.error(`Error saving store ${storeName}:`, err);
    return false;
  }
});

// ---------- file operations ----------

// Moves the file to the Recycle Bin (recoverable) and removes it from the library
ipcMain.handle('delete-song', async (event, file) => {
  try {
    const row = file && typeof file.path === 'string' ? database.getFileByPath(file.path) : null;
    if (!row) return { success: false, error: 'Track is not in the library' };

    if (row.storage_type !== 'cloud' && fs.existsSync(row.path)) {
      if (!isInLibrary(row.path)) return { success: false, error: 'File is outside your music folders' };
      await shell.trashItem(row.path);
    }
    if (row.cache_path && isInAppStorage(row.cache_path) && fs.existsSync(row.cache_path)) {
      await fs.promises.unlink(row.cache_path).catch(() => {});
    }
    database.deleteFile(row.path);
    return { success: true };
  } catch (err) {
    console.error('Error deleting song:', err);
    return { success: false, error: err.message };
  }
});

/** The folder a track downloads into: its album's name, or none when it has no album */
function albumFolder(album) {
  if (!album || album === 'Unknown Album') return '';
  const name = safeFileName(String(album).replace(/[/\\]/g, '_'), '').replace(/[. ]+$/, ''); // Windows drops these itself
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name}_` : name;
}

// Copies a library file into the download folder chosen in Settings
ipcMain.handle('download-song', async (event, file) => {
  try {
    const dest = getDownloadFolder();
    if (!dest) return { success: false, error: 'No download folder set' };
    const row = file && typeof file.path === 'string' ? database.getFileByPath(file.path) : null;
    if (!row) return { success: false, error: 'Track is not in the library' };
    const source = fs.existsSync(row.path) && isInLibrary(row.path) ? row.path
      : (row.cache_path && isInAppStorage(row.cache_path) && fs.existsSync(row.cache_path) ? row.cache_path : null);
    if (!source) return { success: false, error: 'No local copy of this track' };

    const name = safeFileName(row.name || path.basename(row.path));
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const folder = path.join(dest, albumFolder(row.album));
    await fs.promises.mkdir(folder, { recursive: true });
    let target = path.join(folder, name);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(folder, `${stem} (${n})${ext}`);
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    // A cloud-only track saved into a music folder becomes a local track that is also in the cloud
    if (row.path.startsWith('tc://') && isInLibrary(target)) {
      const data = await parseTrack(target, await fs.promises.stat(target));
      database.insertOrUpdateFile({ ...data, addedAt: row.created_at });
      database.updateCloudMetadata(target, {
        storage_type: 'both', telegram_message_id: row.telegram_message_id, telegram_channel_id: row.telegram_channel_id,
        cloud_checksum: row.cloud_checksum, last_synced_at: row.last_synced_at, cache_path: row.cache_path,
      });
      database.deleteFile(row.path);
      return { success: true, path: target, replaced: row.path, file: toFrontend(database.getFileByPath(target)) };
    }
    return { success: true, path: target };
  } catch (err) {
    console.error('Error downloading song:', err);
    return { success: false, error: err.message };
  }
});

// Track menu: show the track's own file. Cloud-only and cached tracks have none to show.
ipcMain.handle('show-in-folder', async (event, filePath) => {
  const row = typeof filePath === 'string' ? database.getFileByPath(filePath) : null;
  if (!row || !isInLibrary(row.path) || !fs.existsSync(row.path)) return { success: false, error: 'The file is no longer there' };
  shell.showItemInFolder(row.path);
  return { success: true };
});

ipcMain.handle('check-file-exists', async (event, filePath) => {
  if (!(isInLibrary(filePath) || isInAppStorage(filePath))) return false;
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
});

module.exports = { syncLibrary, backgroundRefresh, parseTrack, toFrontend, upsertSingleFile, onCloudFilesChanged };
