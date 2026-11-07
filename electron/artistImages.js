// Artist pictures, the same idea as album covers: an ordered list of sources, results the user can
// pick from. A chosen picture goes into the tags of the artist's own tracks as an "Artist" picture,
// which other players read too, and a copy stays here so the pages can show it straight away.
const { app, ipcMain, BrowserWindow, dialog, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const database = require('./database');
const { describeWriteError, withWritable } = require('./fileWrite');
const { isArtistPictureType, isArtistTagPicture } = require('./covers');

const UA = 'TeleCloud/1.0 (https://github.com/MinhHaiDeveloper/telecloud)';
const MAX_SIDE = 1000; // inside every track of the artist: stays small
const SHOW_SIDE = 600;
const NO_PICTURE = '2a96cbd8b46e442fc41c2b86b821562f'; // Last.fm's star
const SCAN_TRACKS = 8;
const FOLDER_NAMES = /^(artist|band|performer)\.(jpe?g|png)$/i;
// A label for many artists, not an artist: a search would return somebody else's face
const NOT_AN_ARTIST = /^(various( artists)?|va|v\.a\.?|compilations?|unknown( artist)?)$/i;

const SOURCES = {
  local: { label: 'This computer', online: false, note: 'Artist pictures in the tags of their tracks, and artist.jpg next to them.' },
  lastfm: { label: 'Last.fm', online: true, note: 'The pictures on the artist\'s public page.' },
  deezer: { label: 'Deezer', online: true },
};
const DEFAULTS = { search: true, autoSave: false, order: ['local', 'lastfm', 'deezer'], disabled: [] };

const settingsFile = () => path.join(app.getPath('userData'), 'artist-picture-settings.json');
function options() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { /* defaults */ }
  const order = [...new Set([...(s.order || []).filter(id => SOURCES[id]), ...DEFAULTS.order])];
  return { ...DEFAULTS, ...s, order };
}
function setOptions(patch) {
  const next = { ...options(), ...patch };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  autoCache.clear();
  return next;
}

// ---------- whose tracks are these? The same rules as src/utils/albums.js
const norm = (s) => (s || '').trim().toLowerCase();
const clean = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const splitArtists = (s) => (s || '').split(/[,;、]|\s+[&/]\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i).map(a => a.trim()).filter(Boolean);
const albumArtists = (s) => (s || '').split(/\s*[;、]\s*/).map(a => a.trim()).filter(Boolean);
function artistsOfRow(r) {
  return r.album_artist && norm(r.artist) === norm(r.album_artist) ? albumArtists(r.album_artist) : splitArtists(r.artist);
}
/** A track says who it shows only when it belongs to one artist: "A feat. B" under album artist A is A's */
function isOwnTrack(r, name) {
  const who = norm(name);
  const names = artistsOfRow(r).map(norm);
  if (names.length === 1 && names[0] === who) return true;
  const owners = albumArtists(r.album_artist).map(norm);
  return names[0] === who && owners.length === 1 && owners[0] === who;
}
function ownTracks(name) {
  const like = `%${String(name).toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
  const rows = database.initDatabase().prepare("SELECT path, artist, album_artist, size, mtime, storage_type, telegram_message_id FROM music_files WHERE LOWER(artist) LIKE ? ESCAPE '\\' OR LOWER(album_artist) LIKE ? ESCAPE '\\' ORDER BY path").all(like, like);
  return rows.filter(r => isOwnTrack(r, name));
}
const isLocal = (p) => p && !p.startsWith('tc://') && fs.existsSync(p);
// These formats label each picture. An M4A only has a list of covers, so an artist picture there
// would turn into a second album cover in every player.
const LABELS_PICTURES = /\.(flac|mp3|ogg|oga|opus|wav|aiff?|aifc|dsf)$/i;
const canHold = (p) => isLocal(p) && LABELS_PICTURES.test(p);

// ---------- the copy kept here
const dir = () => path.join(app.getPath('userData'), 'artist-images');
const fileFor = (name) => path.join(dir(), `${crypto.createHash('sha1').update(norm(name)).digest('hex')}.jpg`);
const indexFile = () => path.join(dir(), 'index.json');
let index = null;
const loadIndex = () => {
  if (!index) { try { index = JSON.parse(fs.readFileSync(indexFile(), 'utf8')) || {}; } catch { index = {}; } }
  return index;
};
let saveTimer = null;
const saveIndex = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.promises.mkdir(dir(), { recursive: true }).then(() => fs.promises.writeFile(indexFile(), JSON.stringify(index))).catch(() => {});
  }, 500);
};
/** Changes when one of the tracks that could hold the picture changes: then they are read again */
const signature = (tracks) => tracks.slice(0, SCAN_TRACKS).map(t => `${t.path}|${t.size}|${Math.round(t.mtime || 0)}`).join('\n');

const resized = (buf, side, quality) => {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('That file is not a JPG or PNG picture');
  const { width, height } = img.getSize();
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (Math.max(width, height) <= side && isJpeg) return buf;
  const fit = Math.max(width, height) > side ? img.resize(width >= height ? { width: side, quality: 'best' } : { height: side, quality: 'best' }) : img;
  return fit.toJPEG(quality);
};

async function pictureInTrack(file) {
  const mm = await import('music-metadata');
  const meta = await mm.parseFile(file, { duration: false, skipCovers: false, skipPostHeaders: true });
  const pic = (meta.common.picture || []).find(p => isArtistPictureType(p.type));
  return pic ? Buffer.from(pic.data) : null;
}

const jobs = new Map();
let running = 0;
const waiting = [];
const slot = () => new Promise((resolve) => { if (running < 2) { running++; resolve(); } else waiting.push(resolve); });
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

/** The picture to show: one chosen here, or one already in the artist's tags. Null when neither. */
async function pictureFor(name) {
  const key = norm(name);
  if (!key || NOT_AN_ARTIST.test(key)) return null;
  const file = fileFor(name);
  const known = loadIndex()[key];
  if (known?.source === 'user') return fs.promises.readFile(file).catch(() => null);
  const tracks = ownTracks(name);
  const sig = signature(tracks);
  if (known && known.sig === sig) return known.source === 'tag' ? fs.promises.readFile(file).catch(() => null) : null;
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    await slot();
    try {
      for (const t of tracks.filter(x => canHold(x.path)).slice(0, SCAN_TRACKS)) {
        const buf = await pictureInTrack(t.path).catch(() => null);
        if (!buf) continue;
        const small = resized(buf, SHOW_SIDE, 88);
        await fs.promises.mkdir(dir(), { recursive: true });
        await fs.promises.writeFile(file, small);
        index[key] = { source: 'tag', sig };
        saveIndex();
        return small;
      }
      await fs.promises.rm(file, { force: true }).catch(() => {});
      index[key] = { source: 'none', sig };
      saveIndex();
      return null;
    } finally { release(); }
  })().finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}

// ---------- sources: each returns [{ source, artist, thumb, image, score, size? }]
async function get(url, { json = true, timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}
const score = (q, found) => {
  const a = clean(q);
  const b = clean(found);
  if (a && a === b) return 1;
  if (a && b && (a.includes(b) || b.includes(a))) return 0.5;
  return 0.1;
};
const thumbOf = (buf, side = 320) => {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const small = Math.max(width, height) > side ? img.resize(width >= height ? { width: side, quality: 'good' } : { height: side, quality: 'good' }) : img;
  return { thumb: `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}`, width, height };
};

const providers = {
  async local(q) {
    const out = [];
    const seen = new Set();
    const add = (buf, image, label) => {
      const id = crypto.createHash('sha1').update(buf).digest('hex');
      if (seen.has(id)) return;
      seen.add(id);
      const t = thumbOf(buf);
      if (t) out.push({ source: 'local', artist: label, ...t, size: `${t.width} × ${t.height}`, image, score: 1 });
    };
    const tracks = ownTracks(q.artist).filter(t => isLocal(t.path));
    for (const t of tracks.filter(x => canHold(x.path)).slice(0, 30)) {
      const buf = await pictureInTrack(t.path).catch(() => null);
      if (buf) add(buf, { artistTrack: t.path }, `From ${path.basename(t.path)}`);
    }
    const folders = new Set();
    tracks.forEach((t) => { const d = path.dirname(t.path); folders.add(d); folders.add(path.dirname(d)); });
    for (const d of folders) {
      for (const f of await fs.promises.readdir(d).catch(() => [])) {
        if (!FOLDER_NAMES.test(f)) continue;
        const file = path.join(d, f);
        const buf = await fs.promises.readFile(file).catch(() => null);
        if (buf) add(buf, { file }, f);
      }
    }
    return out;
  },
  // Last.fm's API only answers with its star. The public page of the artist has the real pictures.
  async lastfm(q) {
    const page = encodeURIComponent(q.artist).replace(/%20/g, '+');
    const html = await get(`https://www.last.fm/music/${page}/+images`, { json: false });
    if (!html) return [];
    const og = /property="og:image"\s+content="([^"]+)"/.exec(html)?.[1] || '';
    const base = /^(https:\/\/[^/]+\/i\/u\/)/.exec(og)?.[1];
    if (!base) return [];
    const title = /<h1[^>]*class="[^"]*header-new-title[^"]*"[^>]*>([^<]+)</.exec(html)?.[1]?.trim()
      || /<title>([^<|]+)/.exec(html)?.[1]?.replace(/\s*(images|pictures|photos).*$/i, '').trim() || q.artist;
    const name = title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    const hashes = [...new Set([...`${og}\n${html}`.matchAll(/\/i\/u\/[^/"'\s]+\/([0-9a-f]{32})/g)].map(m => m[1]))].filter(h => h !== NO_PICTURE);
    const sc = score(q.artist, name);
    return hashes.slice(0, 12).map((h, i) => ({
      source: 'lastfm', artist: name, thumb: `${base}300x300/${h}.jpg`,
      image: { url: `${base}ar0/${h}.jpg`, fallback: `${base}770x0/${h}.jpg` },
      score: i === 0 ? sc : sc - 0.05, // the page's own main picture first
    }));
  },
  async deezer(q) {
    const r = await get(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q.artist)}&limit=8`);
    return (r?.data || []).filter(x => (x.picture_xl || x.picture_big) && !/\/artist\/\//.test(x.picture_xl || x.picture_big)).map(x => ({
      source: 'deezer', artist: x.name, size: x.picture_xl ? '1000 × 1000' : '500 × 500',
      thumb: x.picture_big || x.picture_xl, image: { url: x.picture_xl || x.picture_big, fallback: x.picture_big },
      score: score(q.artist, x.name),
    }));
  },
};

const autoCache = new Map();
async function search(q, { all = false, auto = false } = {}) {
  if (!q?.artist || NOT_AN_ARTIST.test(q.artist.trim())) return { results: [], errors: {} };
  const key = clean(q.artist);
  if (auto && autoCache.has(key)) return autoCache.get(key);
  const o = options();
  const list = o.order.filter(id => !o.disabled.includes(id));
  const errors = {};
  const ask = async (id) => {
    try {
      const found = await providers[id](q);
      return found.filter(r => !SOURCES[id].online || r.score >= 0.3).sort((a, b) => b.score - a.score);
    } catch (err) {
      errors[id] = err.name === 'AbortError' ? 'timed out' : err.message === 'fetch failed' ? 'could not connect' : err.message;
      return [];
    }
  };
  const results = [];
  if (all) {
    (await Promise.all(list.map(ask))).forEach(r => results.push(...r));
    results.sort((a, b) => b.score - a.score);
  } else {
    for (const id of list) {
      const found = await ask(id);
      results.push(...found);
      if (found.some(r => r.score >= 0.9)) break;
    }
  }
  const out = { results, errors };
  if (auto && !Object.keys(errors).length) {
    if (autoCache.size > 500) autoCache.clear();
    autoCache.set(key, out);
  }
  return out;
}

// ---------- saving
async function download(url) {
  if (!/^https:\/\//i.test(url)) throw new Error('Bad image address');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 30 * 1024 * 1024) throw new Error('The picture is too large');
    return buf;
  } finally { clearTimeout(t); }
}
async function loadImage(image) {
  if (image?.url) {
    try { return await download(image.url); } catch (err) {
      if (!image.fallback) throw err;
      return download(image.fallback);
    }
  }
  if (image?.artistTrack) return (await pictureInTrack(image.artistTrack)) || Promise.reject(new Error('That track has no artist picture'));
  if (image?.file) {
    if (!/\.(jpe?g|png)$/i.test(image.file)) throw new Error('Use a JPG or PNG picture');
    return fs.promises.readFile(image.file);
  }
  throw new Error('No picture chosen');
}

/** Put the picture in the tag beside what is already there; a front cover is never touched */
function writeTag(file, jpeg, { onlyMissing = false } = {}) {
  const { File, Picture, PictureType, ByteVector } = require('node-taglib-sharp');
  const f = File.createFromPath(file);
  try {
    const all = f.tag.pictures || [];
    const others = all.filter(p => !isArtistTagPicture(p));
    if (onlyMissing && others.length !== all.length) return false;
    const pics = jpeg ? [...others, Picture.fromFullData(ByteVector.fromByteArray(jpeg), PictureType.Artist, 'image/jpeg', '')] : others;
    if (!jpeg && others.length === all.length) return false;
    f.tag.pictures = pics;
    f.save();
    return true;
  } finally { f.dispose(); }
}

function announce(name, paths, files) {
  BrowserWindow.getAllWindows().forEach((w) => {
    w.webContents.send('artists:saved', { name });
    if (files.length) w.webContents.send('covers:saved', { paths, files });
  });
}

async function writeToTracks(name, jpeg, { onlyMissing, allowReadOnly }) {
  const { upsertSingleFile } = require('./music');
  const local = ownTracks(name).filter(t => canHold(t.path));
  const errors = [];
  const files = [];
  let tags = 0;
  for (const t of local) {
    try {
      const wrote = withWritable(t.path, allowReadOnly, () => writeTag(t.path, jpeg, { onlyMissing }));
      if (wrote) { tags++; files.push(await upsertSingleFile(t.path)); }
    } catch (err) { errors.push({ path: t.path, ...describeWriteError(err, t.path) }); }
    await new Promise(r => setImmediate(r)); // playback and the window keep going on a big artist
  }
  announce(name, local.map(t => t.path), files.filter(Boolean));
  return { tags, errors };
}

async function save({ name, image, onlyMissing = false, allowReadOnly = false }) {
  if (!name || NOT_AN_ARTIST.test(name.trim())) throw new Error('That is not one artist');
  const buf = await loadImage(image);
  const jpeg = resized(buf, MAX_SIDE, 90);
  await fs.promises.mkdir(dir(), { recursive: true });
  await fs.promises.writeFile(fileFor(name), resized(jpeg, SHOW_SIDE, 88));
  loadIndex()[norm(name)] = { source: 'user' };
  saveIndex();
  const r = await writeToTracks(name, jpeg, { onlyMissing, allowReadOnly });
  console.log(`[Artist] Picture saved: ${r.tags} tags written, ${r.errors.length} files refused`);
  return r;
}

async function remove({ name, allowReadOnly = false }) {
  await fs.promises.rm(fileFor(name), { force: true }).catch(() => {});
  const r = await writeToTracks(name, null, { allowReadOnly });
  // none now, until a track's tags change
  loadIndex()[norm(name)] = { source: 'none', sig: signature(ownTracks(name)) };
  saveIndex();
  console.log(`[Artist] Picture removed: ${r.tags} tags changed, ${r.errors.length} files refused`);
  return r;
}

/** What saving would touch, for the dialog to say so first */
function targets(name) {
  const own = ownTracks(name);
  const local = own.filter(t => canHold(t.path));
  const onDisk = own.filter(t => isLocal(t.path));
  return {
    local: local.length,
    backedUp: local.filter(t => t.telegram_message_id).length,
    skipped: onDisk.length - local.length,
    cloudOnly: own.length - onDisk.length,
  };
}

async function pick(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: 'Choose an artist picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png'] }] });
  if (r.canceled || !r.filePaths?.[0]) return null;
  const file = r.filePaths[0];
  const t = thumbOf(await fs.promises.readFile(file));
  if (!t) throw new Error('That file is not a JPG or PNG picture');
  return { file, ...t, name: path.basename(file) };
}

const wrap = (fn) => async (e, opts) => {
  try { return { success: true, ...(await fn(opts, e)) }; } catch (err) { return { success: false, error: err.message }; }
};
ipcMain.handle('artists:options', () => ({ ...options(), sources: SOURCES }));
ipcMain.handle('artists:set-options', (e, patch) => setOptions(patch || {}));
ipcMain.handle('artists:search', async (e, { query, all, auto }) => search(query || {}, { all, auto }));
ipcMain.handle('artists:save', wrap(save));
ipcMain.handle('artists:remove', wrap(remove));
ipcMain.handle('artists:has', async (e, { name }) => !!(await pictureFor(name).catch(() => null)));
ipcMain.handle('artists:targets', (e, { name }) => targets(name));
ipcMain.handle('artists:pick', wrap(async (o, e) => ({ picked: await pick(e) })));

module.exports = { pictureFor, search, save, options, SOURCES };
