// Settings > Library > Your data: export and import of what is yours beyond the music files, so nothing
// keeps you in TeleCloud and a new computer gets it back. One .zip of plain JSON (and M3U8, CSV):
//   history.json               every play: when, how long, title, artist, album, and the track it was
//   history-listenbrainz.json  the same plays in ListenBrainz's import format, for other services
//   playlists.json + .m3u8     playlists (smart ones keep their rules), favourites.json
//   library.csv                what the library holds, for reference
//   settings.json              only when asked: sound, EQ, look, sources' order; never keys, sign-ins or paths
// Import adds to what is here (nothing is replaced, a play already here is not counted twice) and
// finds each track on this computer by its checksum, MusicBrainz id, tags and length, or file name.
// A track this computer doesn't have yet waits (data-pending.json) and joins its playlist or the
// favourites when it shows up: after a library scan or a restore from TeleCloud. Its plays need no
// waiting: they keep their title, artist and album, and stats.js re-attaches them by those tags.

const { app, dialog, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { tx } = require('./i18n');

const FORMAT = 'telecloud-data';
const userFile = (name) => path.join(app.getPath('userData'), name);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); };
const send = (channel, payload) => BrowserWindow.getAllWindows().forEach(w => !w.isDestroyed() && w.webContents.send(channel, payload));
const statsDb = () => require('./stats').db();

// ---------- which track is which, from one computer to another

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
// the file's own name, which survives being moved to other folders and other computers
const tail = (p) => (String(p || '').split(/[\\/]/).filter(Boolean).pop() || '').toLowerCase();
const artistsOf = (s) => new Set(String(s || '').split(/[,;、/&]|\s+(?:feat\.?|ft\.?|featuring|x)\s+/i).map(norm).filter(Boolean));

/** What another computer needs to recognise a track: its library row when there is one, else what was kept with it */
function identity(p, row, fallback = {}) {
  p = String(p || '').replace(/^imported:/, '');
  const meta = fallback.metadata || fallback;
  const durationMs = row?.duration ? Math.round(row.duration * 1000) : (fallback.duration_ms || (meta.duration ? Math.round(meta.duration * 1000) : 0));
  return {
    title: row?.title ?? meta.title ?? null, artist: row?.artist ?? meta.artist ?? null, album: row?.album ?? meta.album ?? null,
    durationMs: durationMs || null, sha256: row?.cloud_checksum || null, mbid: row?.mbid || null,
    file: tail(p), size: row?.size ?? fallback.size ?? null, path: p || null,
  };
}

/**
 * Finds a track of this library for an identity: the same path with the same title, checksum, MusicBrainz id,
 * then title and length (within 2 s) with the album or one artist in common (tags read on two computers
 * often differ a little: "A" against "A, B"), then the file's name and size.
 */
function matcher() {
  const rows = require('./database').getAllFiles();
  let mb = new Map();
  try { mb = new Map(statsDb().prepare("SELECT recording, path FROM mb_ids WHERE recording IS NOT NULL AND recording != ''").all().map(r => [r.recording, r.path])); } catch { /* none yet */ }
  const byPath = new Map(rows.map(r => [r.path, r]));
  const bySha = new Map(rows.filter(r => r.cloud_checksum).map(r => [r.cloud_checksum, r]));
  const group = (key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const byTitle = group(r => norm(r.title));
  const byName = group(r => tail(r.path));
  return (id) => {
    if (!id) return null;
    if (id.path && byPath.has(id.path)) {
      const r = byPath.get(id.path);
      // the same path is only the same track if the tags agree (another computer may use the same folders)
      if (!id.title || norm(r.title) === norm(id.title)) return r;
    }
    if (id.sha256 && bySha.has(id.sha256)) return bySha.get(id.sha256);
    if (id.mbid && mb.has(id.mbid) && byPath.has(mb.get(id.mbid))) return byPath.get(mb.get(id.mbid));
    const artists = artistsOf(id.artist);
    const score = (r) => (norm(r.album) === norm(id.album) ? 2 : 0) + ([...artistsOf(r.artist)].some(a => artists.has(a)) ? 2 : 0)
      + (norm(r.artist) === norm(id.artist) ? 1 : 0) + (tail(r.path) === id.file ? 1 : 0);
    const same = (byTitle.get(norm(id.title)) || [])
      .filter(r => !id.durationMs || !r.duration || Math.abs(r.duration * 1000 - id.durationMs) <= 2000)
      .map(r => [r, score(r)]).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    if (same.length) return same[0][0];
    // tags changed: the file's name, with its size (or its title when the size is not known)
    const named = (byName.get(id.file) || []).filter(r => (id.size ? r.size === id.size : norm(r.title) === norm(id.title)));
    return named[0] || null;
  };
}

/** Plays of tracks an import did not find (kept as "imported:<their path>"), onto the tracks now here */
function relinkImported(find) {
  const d = statsDb();
  const orphans = d.prepare("SELECT DISTINCT path, title, artist, album, duration_ms FROM plays WHERE path LIKE 'imported:%'").all();
  const move = d.prepare('UPDATE plays SET path = ? WHERE path = ?');
  let n = 0;
  d.transaction(() => {
    for (const o of orphans) {
      const row = find(identity(o.path, null, o));
      if (row) n += move.run(row.path, o.path).changes;
    }
  })();
  return n;
}

// ---------- a small .zip reader (the writer is in logExport.js)

function unzip(buf) {
  const files = new Map();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(tx('That file is not a .zip'));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(tx('That .zip is damaged'));
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- export

const SETTING_FILES = { eq: 'eq.json', sound: 'sound.json', lyrics: 'lyrics-settings.json', covers: 'cover-settings.json', artistPictures: 'artist-picture-settings.json', discord: 'discord-settings.json' };
// in settings.json, what belongs to this computer and stays here
const MACHINE_KEYS = ['musicFolderList', 'downloadFolder', 'asioDriver', 'lastSeenVersion', 'highPerformanceGpu'];
// your own API keys (YouTube and the like) are not part of an export
const noKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => !/key|token|secret|password|session/i.test(k))) : o);
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

async function buildExport({ includeSettings = false, local = {} } = {}) {
  const rows = require('./database').getAllFiles();
  let mbIds = new Map();
  try { mbIds = new Map(statsDb().prepare('SELECT path, recording FROM mb_ids').all().map(r => [r.path, r.recording])); } catch { /* none */ }
  const byPath = new Map(rows.map(r => [r.path, { ...r, mbid: mbIds.get(r.path) || null }]));
  const idOf = (p, fallback) => identity(p, byPath.get(p), fallback);

  const plays = statsDb().prepare('SELECT * FROM plays ORDER BY played_at').all();
  const history = plays.map(p => ({ at: p.played_at, listenedMs: p.listened_ms, durationMs: p.duration_ms, title: p.title, artist: p.artist, album: p.album, quality: p.quality, track: idOf(p.path, p) }));
  const listenbrainz = plays.filter(p => p.title && p.artist).map(p => ({
    listened_at: Math.floor(p.played_at / 1000),
    track_metadata: { artist_name: p.artist, track_name: p.title, ...(p.album ? { release_name: p.album } : {}), additional_info: { duration_ms: p.duration_ms || undefined, submission_client: 'TeleCloud' } },
  }));
  const favourites = readJson(userFile('favorites.json'), []).filter(f => f?.path).map(f => idOf(f.path, f));
  const lists = readJson(userFile('playlists.json'), []).filter(p => p && p.name);
  const playlists = lists.map(p => ({ name: p.name, smart: p.smart || null, tracks: p.smart ? [] : (p.songs || []).filter(s => s?.path).map(s => idOf(s.path, s)) }));

  const entries = [];
  const json = (name, value) => entries.push({ name, text: JSON.stringify(value, null, 1) });
  json('history.json', history);
  json('history-listenbrainz.json', listenbrainz);
  json('favourites.json', favourites);
  json('playlists.json', playlists);
  // each playlist for other players too (paths of this computer)
  const used = new Set();
  for (const p of lists.filter(x => !x.smart)) {
    let base = String(p.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'Playlist';
    while (used.has(base.toLowerCase())) base += '_';
    used.add(base.toLowerCase());
    const lines = ['#EXTM3U', ...(p.songs || []).filter(s => s?.path).flatMap(s => [`#EXTINF:${Math.round(s.metadata?.duration || 0)},${s.metadata?.artist || ''} - ${s.metadata?.title || s.name || ''}`, s.path])];
    entries.push({ name: `playlists/${base}.m3u8`, text: `${lines.join('\r\n')}\r\n` });
  }
  const head = ['artist', 'title', 'album', 'album artist', 'year', 'genre', 'track', 'disc', 'duration s', 'format', 'bit depth', 'sample rate', 'in TeleCloud', 'path'];
  entries.push({ name: 'library.csv', text: `\ufeff${[head.join(','), ...rows.filter(r => !String(r.path).startsWith('tc://') || r.title).map(r => [r.artist, r.title, r.album, r.album_artist, r.year, r.genre, r.track_number, r.disc_number, r.duration ? Math.round(r.duration) : '', (r.ext || path.extname(r.path)).replace('.', ''), r.bit_depth, r.sample_rate, r.telegram_message_id ? 'yes' : '', r.path].map(csvCell).join(','))].join('\r\n')}\r\n` });

  let settingsCount = 0;
  if (includeSettings) {
    const settings = readJson(userFile('settings.json'), {});
    MACHINE_KEYS.forEach(k => delete settings[k]);
    const extra = {};
    for (const [k, f] of Object.entries(SETTING_FILES)) { const v = readJson(userFile(f), null); if (v) extra[k] = noKeys(v); }
    const look = Object.fromEntries(Object.entries(local || {}).filter(([k, v]) => /^tc-(appearance|theme|theme-light|theme-dark|language)$/.test(k) && typeof v === 'string'));
    json('settings.json', { settings, ...extra, local: look });
    settingsCount = 1;
  }
  const counts = { plays: history.length, playlists: playlists.length, favourites: favourites.length, tracks: rows.length, settings: !!settingsCount };
  json('manifest.json', { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), app: require('../package.json').version, counts });
  return { data: await require('./logExport').zip(entries), counts };
}

// ---------- import

let opened = null; // the export picked, until it is imported

function readExport(file) {
  const files = unzip(fs.readFileSync(file));
  const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') || 'null');
  if (manifest?.format !== FORMAT) throw new Error(tx('That is not a TeleCloud data export'));
  const get = (n, fb) => { try { return JSON.parse(files.get(n)?.toString('utf8') || 'null') ?? fb; } catch { return fb; } };
  return { manifest, history: get('history.json', []), favourites: get('favourites.json', []), playlists: get('playlists.json', []), settings: get('settings.json', null) };
}

const playKey = (at, title, artist) => `${at}|${norm(title)}|${norm(artist)}`;

function importHistory(list, find) {
  const d = statsDb();
  try { d.exec('ALTER TABLE plays ADD COLUMN lb_sent INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  const have = new Set(d.prepare('SELECT played_at, title, artist FROM plays').all().map(r => playKey(r.played_at, r.title, r.artist)));
  // imported plays were scrobbled from the other computer already: never sent again
  const add = d.prepare(`INSERT INTO plays (path, played_at, listened_ms, duration_ms, title, artist, album, quality, scrobbled, lb_sent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
  let added = 0, skipped = 0, found = 0;
  d.transaction(() => {
    for (const h of list) {
      if (!h || !Number.isFinite(Number(h.at))) continue;
      const k = playKey(Number(h.at), h.title, h.artist);
      if (have.has(k)) { skipped++; continue; }
      have.add(k);
      const row = find(h.track);
      if (row) found++;
      // not here yet: kept under the other computer's path (marked, so it never lands on a different file of the same
      // name here), and stats.js re-attaches it by its tags when the track shows up
      add.run(row?.path || `imported:${h.track?.path || h.title || ''}`, Number(h.at), Number(h.listenedMs) || 0, Number(h.durationMs) || 0, h.title || null, h.artist || null, h.album || null, h.quality || null);
      added++;
    }
  })();
  return { added, skipped, found };
}

function importLists(data, find) {
  const { toFrontend } = require('./music');
  const pending = readJson(userFile('data-pending.json'), []);
  const waits = new Set(pending.map(w => JSON.stringify(w)));
  const wait = (w) => { const k = JSON.stringify(w); if (!waits.has(k)) { waits.add(k); pending.push(w); } };
  const favourites = readJson(userFile('favorites.json'), []);
  const favPaths = new Set(favourites.map(f => f.path));
  const report = { favourites: 0, favouritesWaiting: 0, playlists: 0, playlistsHere: 0, tracks: 0, tracksWaiting: 0 };
  for (const id of data.favourites || []) {
    const row = find(id);
    if (row) { if (!favPaths.has(row.path)) { favourites.push(toFrontend(row)); favPaths.add(row.path); report.favourites++; } }
    else { wait({ kind: 'favourite', track: id }); report.favouritesWaiting++; }
  }
  const lists = readJson(userFile('playlists.json'), []);
  const names = new Set(lists.map(p => norm(p.name)));
  let n = 0;
  // the same export imported twice: its playlists are here already
  const origins = new Set(lists.map(p => p.importedFrom).filter(Boolean));
  for (const p of data.playlists || []) {
    const origin = crypto.createHash('sha1').update(JSON.stringify([p.name, p.smart, p.tracks])).digest('hex').slice(0, 16);
    if (origins.has(origin)) { report.playlistsHere++; continue; }
    origins.add(origin);
    let name = String(p.name || tx('Imported playlist')).slice(0, 200);
    if (names.has(norm(name))) name = tx('{name} (imported)', { name });
    names.add(norm(name));
    const id = `${Date.now()}${String(n++).padStart(3, '0')}`;
    const songs = [];
    const seen = new Set();
    (p.tracks || []).forEach((t, i) => {
      const row = find(t);
      if (row) { if (!seen.has(row.path)) { songs.push(toFrontend(row)); seen.add(row.path); report.tracks++; } }
      else { wait({ kind: 'playlist', playlistId: id, position: i, track: t }); report.tracksWaiting++; }
    });
    lists.push({ id, name, ...(p.smart ? { smart: p.smart } : {}), songs, importedFrom: origin });
    report.playlists++;
  }
  writeJson(userFile('favorites.json'), favourites);
  writeJson(userFile('playlists.json'), lists);
  writeJson(userFile('data-pending.json'), pending);
  return report;
}

function importSettings(s) {
  if (!s) return { local: {} };
  const current = readJson(userFile('settings.json'), {});
  const next = { ...current, ...(s.settings || {}) };
  MACHINE_KEYS.forEach(k => { if (k in current) next[k] = current[k]; else delete next[k]; });
  writeJson(userFile('settings.json'), next);
  // merged into what is here, so a key of this computer stays
  for (const [k, f] of Object.entries(SETTING_FILES)) if (s[k] && typeof s[k] === 'object') writeJson(userFile(f), Array.isArray(s[k]) ? s[k] : { ...readJson(userFile(f), {}), ...noKeys(s[k]) });
  return { local: s.local || {} };
}

/**
 * Tracks an import was waiting for that are in the library now: into their playlist (where it was) or the
 * favourites. Runs after a library scan, a restore from TeleCloud, and when the app starts.
 */
function resolvePending() {
  const pending = readJson(userFile('data-pending.json'), []);
  const find = matcher();
  let plays = 0;
  try { plays = relinkImported(find); } catch (err) { console.warn('[Data] imported plays:', err.message); }
  if (plays) { console.log(`[Data] ${plays} imported plays found their tracks`); send('stats:changed', {}); }
  if (!pending.length) return plays;
  const { toFrontend } = require('./music');
  const favourites = readJson(userFile('favorites.json'), []);
  const lists = readJson(userFile('playlists.json'), []);
  const left = [];
  let done = 0;
  for (const w of pending) {
    const row = find(w.track);
    const list = w.kind === 'playlist' ? lists.find(p => p.id === w.playlistId) : null;
    if (w.kind === 'playlist' && !list) { done++; continue; } // the playlist was deleted: nothing to wait for
    if (!row) { left.push(w); continue; }
    if (w.kind === 'favourite') { if (!favourites.some(f => f.path === row.path)) favourites.push(toFrontend(row)); }
    else if (!list.songs.some(s => s.path === row.path)) {
      // where it was in the list: its place, less the tracks before it that still wait (they come in list
      // order, so the ones before it that came are in the list already)
      const before = left.filter(o => o.kind === 'playlist' && o.playlistId === w.playlistId && o.position < w.position).length;
      list.songs.splice(Math.min(list.songs.length, Math.max(0, w.position - before)), 0, toFrontend(row));
    }
    done++;
  }
  if (!done) return 0;
  writeJson(userFile('favorites.json'), favourites);
  writeJson(userFile('playlists.json'), lists);
  writeJson(userFile('data-pending.json'), left);
  console.log(`[Data] ${done} waiting ${done === 1 ? 'track' : 'tracks'} joined their playlists and favourites; ${left.length} still waiting`);
  send('data:changed', { waiting: left.length });
  return done;
}
let resolveTimer = null;
/** After the library changed: a little later, once (scans come in batches) */
function scheduleResolve() { clearTimeout(resolveTimer); resolveTimer = setTimeout(() => { try { resolvePending(); } catch (err) { console.warn('[Data] waiting tracks:', err.message); } }, 3000); }

// ---------- IPC

const stamp = () => new Date().toISOString().slice(0, 10);
ipcMain.handle('data:export', async (e, opts = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    // tests of a dev build name the file; the app itself always asks
    const r = !app.isPackaged && opts.file ? { filePath: opts.file } : await dialog.showSaveDialog(win, { title: tx('Export your data'), defaultPath: path.join(app.getPath('documents'), `TeleCloud data ${stamp()}.zip`), filters: [{ name: tx('Zip archive'), extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return { success: false, canceled: true };
    const built = await buildExport({ includeSettings: !!opts.includeSettings, local: opts.local || {} });
    fs.writeFileSync(r.filePath, built.data);
    console.log(`[Data] Exported ${built.counts.plays} plays, ${built.counts.playlists} playlists, ${built.counts.favourites} favourites${built.counts.settings ? ', settings' : ''}`);
    return { success: true, file: r.filePath, counts: built.counts };
  } catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('data:open', async (e, file) => {
  try {
    let picked = !app.isPackaged && typeof file === 'string' ? file : null;
    if (!picked) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, { title: tx('Import data'), properties: ['openFile'], filters: [{ name: tx('Zip archive'), extensions: ['zip'] }] });
      if (r.canceled || !r.filePaths[0]) return { success: false, canceled: true };
      picked = r.filePaths[0];
    }
    opened = readExport(picked);
    const m = opened.manifest;
    return { success: true, exportedAt: m.exportedAt, app: m.app, counts: { plays: opened.history.length, playlists: opened.playlists.length, favourites: opened.favourites.length, settings: !!opened.settings } };
  } catch (err) { opened = null; return { success: false, error: err.message }; }
});
ipcMain.handle('data:import', async (e, opts = {}) => {
  try {
    if (!opened) throw new Error(tx('Pick the export again'));
    const find = matcher();
    const report = {};
    if (opts.history !== false) report.history = importHistory(opened.history, find);
    if (opts.lists !== false) Object.assign(report, importLists(opened, find));
    if (opts.settings && opened.settings) report.settings = importSettings(opened.settings);
    opened = null;
    console.log(`[Data] Imported: ${JSON.stringify({ ...report, settings: report.settings ? 'yes' : 'no' })}`);
    send('data:changed', {});
    send('stats:changed', {});
    return { success: true, ...report };
  } catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('data:waiting', () => readJson(userFile('data-pending.json'), []).length);

app.whenReady().then(() => setTimeout(scheduleResolve, 8000));

module.exports = { buildExport, readExport, resolvePending, scheduleResolve, _internals: { matcher, identity, unzip } };
