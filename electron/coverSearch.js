// Album cover search and saving, the same idea as lyrics.js: an ordered list of sources, results the
// user can pick from, saved as a cover.jpg next to the tracks and/or inside their tags.
const { ipcMain, BrowserWindow, dialog, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const database = require('./database');
const covers = require('./covers');
const { describeWriteError, withWritable } = require('./fileWrite');
const { tx } = require('./i18n');

const UA = 'TeleCloud/1.0 (https://github.com/MinhHaiDeveloper/telecloud)';
const IMAGE_EXT = /\.(jpe?g|png)$/i;
const COVER_NAME = /(cover|front|folder|album)/i;
const MAX_SIDE = 1400;
const MAX_DOWNLOAD = 30 * 1024 * 1024;

const SOURCES = {
  get local() { return { label: tx('This computer'), online: false, note: tx('Other tracks of the album, and pictures in its folder.') }; },
  itunes: { label: 'Apple Music', online: true },
  deezer: { label: 'Deezer', online: true },
  get qq() { return { label: 'QQ Music', online: true, note: tx('Best for Chinese and other Asian albums.') }; },
  get musicbrainz() { return { label: 'MusicBrainz', online: true, note: tx('Cover Art Archive. Best for older and rarer releases.') }; },
  lastfm: { label: 'Last.fm', online: true },
};
const DEFAULTS = {
  search: true,    // look online when a playing track has no cover
  autoSave: false, // save the best result without asking
  saveTo: 'file',  // 'file' (cover.jpg) | 'tag' | 'both'
  order: ['local', 'itunes', 'deezer', 'qq', 'musicbrainz', 'lastfm'],
  disabled: [],
};

const settingsFile = () => path.join(require('electron').app.getPath('userData'), 'cover-settings.json');
function options() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { /* defaults */ }
  const order = [...new Set([...(s.order || []).filter(id => SOURCES[id]), ...DEFAULTS.order])];
  return { ...DEFAULTS, ...s, order };
}
function setOptions(patch) {
  const next = { ...options(), ...patch };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  autoCache.clear(); // other sources may find what these didn't
  return next;
}

// the automatic search runs once per album in a session: a playing album asks only for its first track
const autoCache = new Map();

// ---------- helpers
const clean = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const isLocal = (p) => p && !p.startsWith('tc://') && fs.existsSync(p);
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function get(url, { json = true, method = 'GET', timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw require('./httpError')(r, url);
    return json ? await r.json() : r;
  } finally { clearTimeout(t); }
}

/** How well a found album matches (0..1): the album name, then the artist */
function score(q, found) {
  const fa = clean(found.album), qa = clean(q.album);
  const fr = clean(found.artist), qr = clean(q.artist);
  let s = 0;
  if (qa && fa === qa) s += 0.6; else if (qa && fa && (fa.includes(qa) || qa.includes(fa))) s += 0.4;
  if (qr && fr && (fr === qr || fr.includes(qr) || qr.includes(fr))) s += 0.4;
  return Math.min(1, s);
}

const thumbOf = (buf, side = 320) => {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const small = Math.max(width, height) > side ? img.resize(width >= height ? { width: side, quality: 'good' } : { height: side, quality: 'good' }) : img;
  return { thumb: `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}`, width, height };
};

async function embeddedPicture(file) {
  const mm = await import('music-metadata');
  const meta = await mm.parseFile(file, { duration: false, skipCovers: false, skipPostHeaders: true });
  const data = mm.selectCover(covers.coverPictures(meta.common.picture))?.data;
  return data ? Buffer.from(data) : null;
}

// ---------- sources: each returns [{ source, album, artist, thumb, image, score, size? }]
const providers = {
  async local(q) {
    const out = [];
    const seen = new Set();
    const add = (buf, image, sc, label) => {
      const id = sha(buf);
      if (seen.has(id)) return;
      seen.add(id);
      const t = thumbOf(buf);
      if (t) out.push({ source: 'local', album: label, artist: q.artist, ...t, size: `${t.width} × ${t.height}`, image, score: sc });
    };
    const paths = (q.paths || []).slice(0, 300);
    for (const p of paths.slice(0, 30)) {
      if (!isLocal(p)) continue;
      const buf = await embeddedPicture(p).catch(() => null);
      if (buf) add(buf, { track: p }, 1, `From ${path.basename(p)}`);
    }
    for (const dir of new Set(paths.filter(isLocal).map(p => path.dirname(p)))) {
      for (const name of await fs.promises.readdir(dir).catch(() => [])) {
        if (!IMAGE_EXT.test(name)) continue;
        const file = path.join(dir, name);
        const buf = await fs.promises.readFile(file).catch(() => null);
        if (buf) add(buf, { file }, COVER_NAME.test(name) ? 0.85 : 0.5, name);
      }
    }
    // TeleCloud keeps a smaller copy of the same picture, so it only counts when nothing else was found
    for (const p of out.length ? [] : paths) {
      const key = database.getFileByPath(p)?.cloud_cover;
      if (!key) continue;
      const file = covers.cloudCoverFile(key);
      const buf = await covers.readIfExists(file);
      if (buf) add(buf, { file }, 1, 'From TeleCloud');
    }
    return out;
  },
  async itunes(q) {
    const term = encodeURIComponent(`${q.artist || ''} ${q.album || ''}`.trim());
    const r = await get(`https://itunes.apple.com/search?term=${term}&entity=album&limit=12`);
    return (r.results || []).filter(x => x.artworkUrl100).map(x => {
      const found = { album: x.collectionName, artist: x.artistName };
      return {
        source: 'itunes', ...found, year: (x.releaseDate || '').slice(0, 4), size: '1400 × 1400',
        thumb: x.artworkUrl100.replace('100x100bb', '400x400bb'),
        image: { url: x.artworkUrl100.replace('100x100bb', '1400x1400bb'), fallback: x.artworkUrl100.replace('100x100bb', '400x400bb') },
        score: score(q, found),
      };
    });
  },
  async deezer(q) {
    const term = encodeURIComponent(`${q.artist || ''} ${q.album || ''}`.trim());
    const r = await get(`https://api.deezer.com/search/album?q=${term}&limit=12`);
    return (r.data || []).filter(x => x.cover_xl || x.cover_big).map(x => {
      const found = { album: x.title, artist: x.artist?.name };
      return {
        source: 'deezer', ...found, size: x.cover_xl ? '1000 × 1000' : '500 × 500',
        thumb: x.cover_big || x.cover_xl, image: { url: x.cover_xl || x.cover_big, fallback: x.cover_big }, score: score(q, found),
      };
    });
  },
  // QQ Music: strongest for Chinese and other Asian albums. The album search gives an id, and the cover
  // comes from the id at 1200 px (real 1200, checked); an id without a cover answers 404.
  async qq(q) {
    const w = `${q.artist || ''} ${q.album || ''}`.trim();
    if (!w) return [];
    const p = new URLSearchParams({ w, format: 'json', n: '8', p: '1', cr: '1', t: '8' });
    const r = await get(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${p}`);
    const pic = (mid, side) => `https://y.gtimg.cn/music/photo_new/T002R${side}x${side}M000${mid}.jpg`;
    return (r?.data?.album?.list || []).filter(x => x.albumMID && x.albumPic).map(x => {
      const found = { album: x.albumName, artist: x.singerName || (x.singer_list || []).map(s => s.name).join(', ') };
      return {
        source: 'qq', ...found, year: (x.publicTime || '').slice(0, 4), size: '1200 × 1200',
        thumb: pic(x.albumMID, 300), image: { url: pic(x.albumMID, 1200), fallback: pic(x.albumMID, 800) },
        score: score(q, found),
      };
    });
  },
  async musicbrainz(q) {
    const quote = (s) => `"${String(s).replace(/["\\]/g, ' ')}"`;
    const parts = [];
    if (q.album) parts.push(`releasegroup:${quote(q.album)}`);
    if (q.artist) parts.push(`artist:${quote(q.artist)}`);
    const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(parts.join(' AND '))}&fmt=json&limit=6`;
    // MusicBrainz allows one request a second and answers 503 past that: wait and ask once more
    const r = await get(url).catch(async (err) => {
      if (err.message !== 'HTTP 503') throw err;
      await new Promise(done => setTimeout(done, 1500));
      return get(url);
    });
    const groups = (r['release-groups'] || []).map(x => {
      const found = { album: x.title, artist: (x['artist-credit'] || []).map(c => c.name).join(', ') };
      return {
        source: 'musicbrainz', ...found, year: (x['first-release-date'] || '').slice(0, 4),
        thumb: `https://coverartarchive.org/release-group/${x.id}/front-500`,
        image: { url: `https://coverartarchive.org/release-group/${x.id}/front`, fallback: `https://coverartarchive.org/release-group/${x.id}/front-500` },
        score: score(q, found),
      };
    }).filter(x => x.score > 0);
    // not every release has art: keep the ones the archive can serve
    const ok = await Promise.all(groups.map(g => get(g.thumb, { json: false, method: 'HEAD' }).then(() => true).catch(() => false)));
    return groups.filter((g, i) => ok[i]);
  },
  async lastfm(q) {
    if (!q.album) return [];
    const { call } = require('./lastfm');
    const list = [];
    if (q.artist) {
      const r = await call('album.getInfo', { artist: q.artist, album: q.album, autocorrect: 1 }).catch(() => null);
      if (r?.album) list.push(r.album);
    }
    if (!list.length) {
      const r = await call('album.search', { album: q.album, limit: 8 });
      list.push(...(r?.results?.albummatches?.album || []));
    }
    const out = [];
    for (const a of list) {
      const img = [...(a.image || [])].reverse().find(i => i['#text'])?.['#text'];
      if (!img || img.includes('2a96cbd8b46e442fc41c2b86b821562f')) continue; // Last.fm's "no picture" star
      const found = { album: a.name, artist: typeof a.artist === 'string' ? a.artist : a.artist?.name };
      out.push({ source: 'lastfm', ...found, thumb: img, image: { url: img.replace(/\/i\/u\/[^/]+\//, '/i/u/ar0/'), fallback: img }, score: score(q, found) });
    }
    return out;
  },
};

/** With `all`, every source is asked (the dialog); otherwise it stops at the first good match */
async function search(q, { all = false, auto = false } = {}) {
  const o = options();
  const list = o.order.filter(id => !o.disabled.includes(id));
  const key = `${clean(q.album)}|${clean(q.artist)}`;
  if (auto && autoCache.has(key)) return autoCache.get(key);
  const results = [];
  const errors = {};
  const ask = async (id) => {
    try {
      const found = (await providers[id](q)).filter(r => !SOURCES[id].online || r.score >= 0.3);
      // which source a picture comes from travels with it, so saving it can remember the link
      if (SOURCES[id].online) for (const r of found) if (r.image) r.image.source = id;
      found.sort((a, b) => b.score - a.score);
      return found;
    } catch (err) {
      errors[id] = err.name === 'AbortError' ? 'timed out' : err.message === 'fetch failed' ? 'could not connect' : err.message;
      return [];
    }
  };
  if (all) {
    (await Promise.all(list.map(ask))).forEach(r => results.push(...r));
    results.sort((a, b) => b.score - a.score); // best matches first; the sort keeps source order on ties
  }
  else {
    for (const id of list) {
      const found = await ask(id);
      results.push(...found);
      if (found.some(r => r.score >= 0.7)) break;
    }
  }
  noteSearch(results, errors);
  const out = { results, errors };
  if (auto && !Object.keys(errors).length) {
    if (autoCache.size > 500) autoCache.clear();
    autoCache.set(key, out);
  }
  return out;
}

/** A public picture of the album for showing outside the app: the first good match online, if any */
async function onlineCoverUrl(q) {
  const o = options();
  let failed = false;
  for (const id of o.order.filter(x => SOURCES[x].online && !o.disabled.includes(x))) {
    try {
      const best = (await providers[id](q)).filter(r => r.score >= 0.7 && /^https:\/\//i.test(r.thumb)).sort((a, b) => b.score - a.score)[0];
      if (best) return { url: best.thumb, failed: false };
    } catch { failed = true; }
  }
  return { url: null, failed };
}

// ---------- saving
async function download(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Bad image address');
  const r = await get(url, { json: false, timeout: 25000 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error(tx('The picture is too large'));
  return buf;
}

async function loadImage(image, used = () => {}) {
  if (image?.url) {
    // the largest size isn't always there: the size shown in the results is
    try {
      const buf = await download(image.url);
      used(image.url);
      return buf;
    } catch (err) {
      if (!image.fallback) throw err;
      const buf = await download(image.fallback);
      used(image.fallback);
      return buf;
    }
  }
  if (image?.track) return (await embeddedPicture(image.track)) || Promise.reject(new Error(tx('That track has no picture')));
  if (image?.file) {
    if (!IMAGE_EXT.test(image.file)) throw new Error(tx('Use a JPG or PNG picture'));
    return fs.promises.readFile(image.file);
  }
  throw new Error(tx('No picture chosen'));
}

/** Every cover is stored as a JPEG of at most 1400 px, so an album's tags don't grow by much */
function toJpeg(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error(tx('That file is not a JPG or PNG picture'));
  const { width, height } = img.getSize();
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (Math.max(width, height) <= MAX_SIDE && isJpeg) return buf;
  const fit = Math.max(width, height) > MAX_SIDE ? img.resize(width >= height ? { width: MAX_SIDE, quality: 'best' } : { height: MAX_SIDE, quality: 'best' }) : img;
  return fit.toJPEG(90);
}

const { openTags, writeWhenFree, isBusy, setCoverLink } = require('./tagFile');
/** The playing track: decided now (reading is safe), written when it stops */
function writeTag(file, jpeg, opts = {}) {
  if (!isBusy(file)) return writeTagNow(file, jpeg, opts);
  if (opts.onlyMissing || opts.onlyIfEmbedded) {
    const f = openTags(file);
    let had;
    try { const all = f.tag.pictures || []; had = all.some(p => !covers.isArtistTagPicture(p)); } finally { f.dispose(); }
    if ((opts.onlyMissing && had) || (opts.onlyIfEmbedded && !had)) return false;
  }
  covers.holdCover(file, jpeg); // shown at once; in the file once the track stops
  writeWhenFree(file, () => { try { writeTagNow(file, jpeg, opts); } finally { covers.releaseCover(file); } });
  return true;
}
function writeTagNow(file, jpeg, { onlyMissing = false, onlyIfEmbedded = false, link } = {}) {
  const { Picture, PictureType, ByteVector } = require('node-taglib-sharp');
  const f = openTags(file);
  try {
    // an Artist picture is not a cover: it doesn't count as one, and it stays
    const all = f.tag.pictures || [];
    const artist = all.filter(covers.isArtistTagPicture);
    const had = all.length > artist.length;
    if ((onlyMissing && had) || (onlyIfEmbedded && !had)) return false;
    const pic = Picture.fromFullData(ByteVector.fromByteArray(jpeg), PictureType.FrontCover, 'image/jpeg', '');
    f.tag.pictures = [...artist, pic]; // the cover last: Windows' thumbnail for a FLAC is its last picture
    if (link !== undefined) setCoverLink(f, link); // the file is saved anyway: the link goes with the picture
    f.save();
    return true;
  } finally { f.dispose(); }
}

/** Only the link (or taking it out), when the picture itself was not written into the tags */
function writeLinkOnly(file, link) {
  const go = () => {
    const f = openTags(file);
    try { if (setCoverLink(f, link)) f.save(); } finally { f.dispose(); }
  };
  if (isBusy(file)) writeWhenFree(file, go); else go();
}

const albumId = (r) => `${r?.album || ''}\u0000${(r?.album_artist || '').toLowerCase()}`;
/** Does this folder hold another album? Then a cover.jpg would show on that album too. */
function folderHasOtherAlbum(dir, albums) {
  const like = `${dir.replace(/[\\%_]/g, c => `\\${c}`)}${path.sep === '\\' ? '\\\\' : path.sep}%`;
  const rows = database.initDatabase().prepare("SELECT path, album, album_artist FROM music_files WHERE path LIKE ? ESCAPE '\\'").all(like);
  return rows.some(r => path.dirname(r.path) === dir && !albums.has(albumId(r)));
}

async function save({ paths, image, to, onlyMissing = false, allowReadOnly = false }) {
  const where = to || options().saveTo;
  // a picture from an online source: its link is remembered for the album (Discord shows covers from links),
  // in the library always and in the tags when the cover goes into the tags. Any other picture forgets it.
  let usedUrl = null;
  const jpeg = toJpeg(await loadImage(image, (u) => { usedUrl = u; }));
  const src = image?.source && SOURCES[image.source];
  const link = usedUrl && src?.online && /^https:\/\//i.test(usedUrl) ? { url: usedUrl, source: src.label } : null;
  // filling in only missing covers leaves the tracks that already had one as they were, link and all
  const keep = new Set();
  if (onlyMissing) for (const p of paths || []) if (await (isLocal(p) ? covers.coverForFile(p) : covers.artFor(p)).catch(() => null)) keep.add(p);
  const previous = (paths || []).map(p => database.getFileByPath(p)?.cloud_cover).filter(Boolean);
  const { upsertSingleFile, toFrontend } = require('./music');
  const files = [];
  const errors = [];
  const done = { file: 0, tag: 0, cloud: 0 };

  const dirs = new Map();
  const cloudOnly = [];
  for (const p of paths || []) {
    if (isLocal(p)) {
      const d = path.dirname(p);
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(p);
    } else if (database.getFileByPath(p)) cloudOnly.push(p);
  }

  for (const [dir, list] of dirs) {
    const albums = new Set(list.map(p => albumId(database.getFileByPath(p))));
    let wantTag = where !== 'file';
    if (where !== 'tag') {
      if (folderHasOtherAlbum(dir, albums)) wantTag = true;
      else {
        const target = path.join(dir, 'cover.jpg');
        if (!(onlyMissing && fs.existsSync(target))) {
          try { await fs.promises.writeFile(target, jpeg); done.file++; } catch { wantTag = true; }
        }
      }
    }
    for (const p of list) {
      try {
        // embedded art wins over cover.jpg, so a replaced cover has to replace it there too
        const tagLink = keep.has(p) ? undefined : wantTag ? link : null; // a cover.jpg only: no link in the tags
        const wrote = withWritable(p, allowReadOnly, () => writeTag(p, jpeg, wantTag ? { onlyMissing, link: tagLink } : { onlyIfEmbedded: !onlyMissing, onlyMissing, link: tagLink }));
        if (wrote) { done.tag++; files.push(await upsertSingleFile(p)); }
        else if (tagLink !== undefined) {
          // the picture stayed out of the tags: an older link there would now be wrong
          try { withWritable(p, allowReadOnly, () => writeLinkOnly(p, tagLink)); } catch (err) { console.warn(`[Covers] Could not update the cover link in ${path.basename(p)}: ${err.message}`); }
        }
      } catch (err) { errors.push({ path: p, ...describeWriteError(err, p) }); }
    }
  }

  if (cloudOnly.length) {
    const small = nativeImage.createFromBuffer(jpeg);
    const { width, height } = small.getSize();
    const buf = Math.max(width, height) > 600 ? small.resize(width >= height ? { width: 600, quality: 'good' } : { height: 600, quality: 'good' }).toJPEG(88) : jpeg;
    const key = sha(buf).slice(0, 20);
    const file = covers.cloudCoverFile(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, buf);
    const set = database.initDatabase().prepare('UPDATE music_files SET cloud_cover = ? WHERE path = ?');
    for (const p of cloudOnly) { set.run(key, p); files.push(toFrontend(database.getFileByPath(p))); done.cloud++; }
  }

  // '' is "forgotten on purpose": the album's other tracks' link is not borrowed for this one
  const remember = database.initDatabase().prepare('UPDATE music_files SET cover_url = ?, cover_source = ? WHERE path = ?');
  const failed = new Set(errors.map(e => e.path));
  for (const p of paths || []) if (!keep.has(p) && !failed.has(p)) remember.run(link ? link.url : '', link ? link.source : null, p);
  try { require('./discord').coverChanged?.(paths || []); } catch { /* Discord off or not loaded */ }

  covers.clearMissing();
  const service = (() => { try { return require('./telecloud/service'); } catch { return null; } })();
  service?.coversChanged?.(paths, previous).catch(err => console.warn('[TeleCloud] cover upload failed:', err.message));
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('covers:saved', { paths, files: files.filter(Boolean) }));
  return { ...done, errors };
}

/** How many of these tracks hold a picture inside: saving a new cover has to replace it */
async function embeddedCount(paths) {
  let n = 0;
  for (const p of (paths || []).filter(isLocal)) {
    try {
      const f = openTags(p);
      try { if ((f.tag.pictures || []).some(p => !covers.isArtistTagPicture(p))) n++; } finally { f.dispose(); }
    } catch { /* unreadable: the save reports it */ }
  }
  return n;
}

async function pick(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: tx('Choose a cover picture'), properties: ['openFile'], filters: [{ name: tx('Pictures'), extensions: ['jpg', 'jpeg', 'png'] }] });
  if (r.canceled || !r.filePaths?.[0]) return null;
  const file = r.filePaths[0];
  const t = thumbOf(await fs.promises.readFile(file));
  if (!t) throw new Error(tx('That file is not a JPG or PNG picture'));
  return { file, ...t, name: path.basename(file) };
}

const wrap = (fn) => async (e, opts) => {
  try { return { success: true, ...(await fn(opts, e)) }; } catch (err) { return { success: false, error: err.message }; }
};
ipcMain.handle('covers:options', () => ({ ...options(), sources: SOURCES }));
ipcMain.handle('covers:set-options', (e, patch) => setOptions(patch || {}));
ipcMain.handle('covers:search', async (e, { query, all, auto }) => search(query || {}, { all, auto }));
ipcMain.handle('covers:save', wrap(save));
ipcMain.handle('covers:embedded', async (e, { paths }) => embeddedCount(paths));
ipcMain.handle('covers:pick', wrap(async (o, e) => ({ picked: await pick(e) })));

// What the searches of this session gave, for the saved log's report: sources only, never a name
const session = { searches: 0, good: {}, nothing: 0, errors: {} };
function noteSearch(results, errors) {
  session.searches++;
  for (const [id, e] of Object.entries(errors)) {
    const k = `${id}: ${String(e).slice(0, 60)}`;
    session.errors[k] = (session.errors[k] || 0) + 1;
  }
  const good = [...new Set(results.filter(r => r.score >= 0.7).map(r => r.source))];
  if (!good.length) session.nothing++;
  good.forEach(id => { session.good[id] = (session.good[id] || 0) + 1; });
}
function sessionReport() {
  const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ');
  return { searches: session.searches, good: list(session.good) || 'none', nothing: session.nothing, errors: list(session.errors) || 'none' };
}

module.exports = { sessionReport, search, save, options, SOURCES, onlineCoverUrl };
