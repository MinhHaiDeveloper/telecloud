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
const { openTags } = require('./tagFile');

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
  theaudiodb: { label: 'TheAudioDB', online: true, note: 'Pictures from its community, with the public free key (30 searches a minute).' },
  itunes: { label: 'Apple Music', online: true, note: "The picture on the artist's public page." },
  musicbrainz: { label: 'MusicBrainz', online: true, note: 'Photos it links on Wikimedia Commons. Slower: one question a second.' },
};
const DEFAULTS = { search: true, autoSave: false, order: ['local', 'lastfm', 'deezer', 'theaudiodb', 'itunes', 'musicbrainz'], disabled: [] };

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
  const rows = database.initDatabase().prepare("SELECT path, artist, album_artist, size, mtime, storage_type, telegram_message_id, telegram_channel_id FROM music_files WHERE LOWER(artist) LIKE ? ESCAPE '\\' OR LOWER(album_artist) LIKE ? ESCAPE '\\' ORDER BY path").all(like, like);
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
// ---------- moving pictures
// A GIF lives here and in TeleCloud. Tags get its first frame: a GIF in every track would be heavy,
// send every backed-up file up again, and most players wouldn't move it anyway.
const MAX_GIF = 15 * 1024 * 1024;
const isGif = (buf) => buf?.length > 6 && buf.toString('latin1', 0, 3) === 'GIF';
const gifFile = (name) => path.join(dir(), `${crypto.createHash('sha1').update(norm(name)).digest('hex')}.gif`);
const gifKey = (buf) => `g${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}`; // "g": not an album cover
const gifsFile = () => path.join(dir(), 'gifs.json');
let gifs = null; // artist -> { name, key, at } or { name, gone: true, at }: which is newest decides between computers
const loadGifs = () => {
  if (!gifs) { try { gifs = JSON.parse(fs.readFileSync(gifsFile(), 'utf8')) || {}; } catch { gifs = {}; } }
  return gifs;
};
const gifState = (name) => loadGifs()[norm(name)] || null;
function setGifState(name, state) {
  loadGifs()[norm(name)] = { name, at: Date.now(), ...state };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(gifsFile(), JSON.stringify(gifs));
}
/** The browser engine reads GIFs; Electron's nativeImage doesn't */
async function readGif(buf) {
  if (buf.length > MAX_GIF) throw new Error('That GIF is over 15 MB. Use a smaller one.');
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('TeleCloud has no window to read that GIF');
  let r;
  try {
    r = await win.webContents.executeJavaScript(`(async () => {
      const data = await (await fetch('data:image/gif;base64,${buf.toString('base64')}')).arrayBuffer();
      const d = new ImageDecoder({ data, type: 'image/gif' });
      await d.tracks.ready;
      const frames = d.tracks.selectedTrack.frameCount;
      const { image } = await d.decode({ frameIndex: 0 });
      const c = document.createElement('canvas');
      c.width = image.displayWidth;
      c.height = image.displayHeight;
      c.getContext('2d').drawImage(image, 0, 0);
      const out = { frames, width: c.width, height: c.height, still: c.toDataURL('image/jpeg', 0.95) };
      image.close();
      d.close();
      return out;
    })()`);
  } catch { throw new Error('That GIF could not be read'); }
  return { ...r, still: Buffer.from(r.still.split(',')[1], 'base64') };
}
const motionFor = async (name) => (gifState(name)?.key ? fs.promises.readFile(gifFile(name)).catch(() => null) : null);

// What TeleCloud needs: telecloud/service.js puts these in the chat and in the library index
function gifsInStorage(peerId) {
  return Object.values(loadGifs()).filter(g => g.key && fs.existsSync(gifFile(g.name))
    && ownTracks(g.name).some(t => String(t.telegram_channel_id) === String(peerId))).map(g => ({ ...g, file: gifFile(g.name) }));
}
const hasGifKey = (key) => Object.values(loadGifs()).some(g => g.key === key && fs.existsSync(gifFile(g.name)));
/** From another computer: not over a newer choice, or a picture chosen here before GIFs were kept */
function wantsGif(entry) {
  const st = gifState(entry.name);
  if (st) return st.at < entry.at && st.key !== entry.key;
  return loadIndex()[norm(entry.name)]?.source !== 'user';
}
async function gifFromCloud(entry, buf) {
  if (gifKey(buf) !== entry.key) throw new Error('The GIF in TeleCloud does not match the index');
  const gif = await readGif(buf);
  await fs.promises.mkdir(dir(), { recursive: true });
  await fs.promises.writeFile(gifFile(entry.name), buf);
  await fs.promises.writeFile(fileFor(entry.name), resized(gif.still, SHOW_SIDE, 88));
  loadIndex()[norm(entry.name)] = { source: 'user' };
  saveIndex();
  setGifState(entry.name, { key: entry.key, at: entry.at });
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('artists:saved', { name: entry.name }));
  return true;
}
/** The chat and the index follow a GIF that was added, replaced or removed */
function tellCloud(name) {
  const paths = ownTracks(name).filter(t => t.telegram_message_id).map(t => t.path);
  if (paths.length) { try { require('./telecloud/service').indexChanged(paths); } catch { /* TeleCloud not set up */ } }
}

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

// MusicBrainz asks for one request a second from each program
let mbLast = 0;
let mbQueue = Promise.resolve();
const mbGet = (url) => {
  const turn = mbQueue.then(async () => {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    mbLast = Date.now();
    try { return await get(url); } catch (err) {
      if (err.message !== 'HTTP 503') throw err;
      await new Promise(r => setTimeout(r, 2200)); // its way of saying "too many at the moment"
      mbLast = Date.now();
      return get(url);
    }
  });
  mbQueue = turn.catch(() => {});
  return turn;
};
const commonsPhoto = (name) => (/\.(jpe?g|png)$/i.test(name) ? name.replace(/ /g, '_') : null);
/** MusicBrainz has no pictures of its own, it links a photo, directly or through Wikidata */
async function mbPhoto(id) {
  const r = await mbGet(`https://musicbrainz.org/ws/2/artist/${id}?inc=url-rels&fmt=json`);
  const rels = r?.relations || [];
  const direct = /commons\.wikimedia\.org\/wiki\/File:(.+)$/.exec(rels.find(x => x.type === 'image')?.url?.resource || '')?.[1];
  if (direct) return commonsPhoto(decodeURIComponent(direct));
  const q = /wikidata\.org\/wiki\/(Q\d+)/.exec(rels.find(x => x.type === 'wikidata')?.url?.resource || '')?.[1];
  if (!q) return null;
  const w = await get(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${q}&property=P18&format=json`);
  const name = w?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return name ? commonsPhoto(name) : null;
}

const providers = {
  // The API has no artist pictures. The artist's page on Apple Music has one, in the page's own preview.
  async itunes(q) {
    const r = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(q.artist)}&entity=musicArtist&limit=3`);
    const hits = (r?.results || []).filter(a => score(q.artist, a.artistName) >= 0.9 && /^https:\/\/music\.apple\.com\//.test(a.artistLinkUrl || '')).slice(0, 2);
    const found = await Promise.all(hits.map(async (a) => {
      const html = await get(a.artistLinkUrl.split('?')[0], { json: false });
      const og = /property="og:image"\s+content="([^"]+)"/.exec(html || '')?.[1] || '';
      // an artist with no picture shows an album or Apple's logo here instead
      const base = /^(https:\/\/[^/]+\/image\/thumb\/(?:AMCArtistImages|Features)\d+\/.+?)\/\d+x\d+[^/]*$/.exec(og)?.[1];
      return base ? {
        source: 'itunes', artist: a.artistName, thumb: `${base}/320x320bb.jpg`,
        image: { url: `${base}/1000x1000bb.jpg`, fallback: `${base}/600x600bb.jpg` }, score: score(q.artist, a.artistName),
      } : null;
    }));
    return found.filter(Boolean);
  },
  async musicbrainz(q) {
    const term = `artist:"${q.artist.replace(/["\\]/g, '\\$&')}"`;
    const r = await mbGet(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(term)}&fmt=json&limit=3`);
    const hits = (r?.artists || []).filter(a => score(q.artist, a.name) >= 0.9).slice(0, 2);
    const out = [];
    for (const a of hits) {
      const name = await mbPhoto(a.id);
      if (!name) continue;
      const page = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}`;
      out.push({
        source: 'musicbrainz', artist: a.disambiguation ? `${a.name} (${a.disambiguation})` : a.name, thumb: `${page}?width=330`,
        image: { url: `${page}?width=960`, fallback: `${page}?width=500` }, score: score(q.artist, a.name),
      });
    }
    return out;
  },
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
  // The free public key, as its documentation gives it. Its square "thumb" is the artist picture;
  // banners, logos and wide fan art don't fit an artist picture.
  async theaudiodb(q) {
    const r = await get(`https://www.theaudiodb.com/api/v1/json/123/search.php?s=${encodeURIComponent(q.artist)}`);
    return (r?.artists || []).filter(a => /^https:\/\//i.test(a.strArtistThumb || '')).map(a => ({
      source: 'theaudiodb', artist: a.strArtist, size: '700 × 700',
      thumb: `${a.strArtistThumb}/medium`, image: { url: a.strArtistThumb, fallback: `${a.strArtistThumb}/medium` },
      score: score(q.artist, a.strArtist),
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

// ---------- YouTube: its own tab, asked only when that tab is opened. A search costs 100 of the key's
// 10,000 units a day, so an answer is kept for 30 days, the longest YouTube allows.
const YT_KEEP_MS = 30 * 86400000;
const ytFile = () => path.join(app.getPath('userData'), 'youtube-artists.json');
let ytCache = null;
const loadYt = () => {
  if (ytCache) return ytCache;
  try { ytCache = JSON.parse(fs.readFileSync(ytFile(), 'utf8')) || {}; } catch { ytCache = {}; }
  for (const [k, v] of Object.entries(ytCache)) if (!(Date.now() - v.at < YT_KEEP_MS)) delete ytCache[k];
  return ytCache;
};
/** Your own key from Settings, or the one packed with the app */
function ytKey() {
  const own = String(options().youtubeKey || '').trim();
  if (own) return own;
  try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, 'youtube-key.json'), 'utf8')).key || '').trim(); } catch { return ''; }
}
const YT_REFUSED = {
  quotaExceeded: "This key has used up today's YouTube searches. It resets at midnight Pacific time.",
  dailyLimitExceeded: "This key has used up today's YouTube searches. It resets at midnight Pacific time.",
  keyInvalid: 'YouTube did not accept this API key. Check it in Settings.',
  keyExpired: 'This YouTube API key has expired. Make a new one and add it in Settings.',
  accessNotConfigured: 'YouTube Data API v3 is not turned on for this key.',
  ipRefererBlocked: "This key's restrictions don't allow TeleCloud. Remove the application restriction.",
};
const entities = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
async function youtube({ artist }) {
  const q = String(artist || '').trim();
  if (!q) return { results: [] };
  const id = clean(q) || q.toLowerCase();
  const kept = loadYt()[id];
  if (kept && Date.now() - kept.at < YT_KEEP_MS) return { results: kept.results };
  const key = ytKey();
  if (!key) return { needsKey: true, results: [] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let r;
  let body;
  try {
    r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=8&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    body = await r.json().catch(() => null);
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'YouTube took too long to answer.' : 'Could not reach YouTube.', results: [] };
  } finally { clearTimeout(timer); }
  if (!r.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    const invalid = /api key not valid/i.test(body?.error?.message || '');
    console.warn(`[Artist] YouTube refused the search: ${r.status} ${reason || ''}`);
    return { error: YT_REFUSED[invalid ? 'keyInvalid' : reason] || `YouTube refused the search (${r.status}).`, results: [] };
  }
  const results = (body?.items || []).filter(x => /^https:\/\//i.test(x.snippet?.thumbnails?.high?.url || '')).map((x) => {
    const t = x.snippet.thumbnails;
    const name = entities(x.snippet.channelTitle || x.snippet.title);
    return { source: 'youtube', artist: name, thumb: (t.medium || t.high).url, image: { url: t.high.url, fallback: t.medium?.url }, score: score(q, name) };
  }).sort((a, b) => b.score - a.score);
  const cache = loadYt();
  cache[id] = { at: Date.now(), results };
  const ids = Object.keys(cache);
  if (ids.length > 2000) delete cache[ids[0]];
  fs.promises.writeFile(ytFile(), JSON.stringify(cache)).catch(() => {});
  return { results };
}

/** A public link to the artist's picture, for Discord. One chosen here first, then the online sources in order. */
async function onlineArtistPicture(name) {
  if (!name || NOT_AN_ARTIST.test(name.trim())) return { url: null };
  const chosen = loadIndex()[norm(name)]?.url;
  if (chosen) return { url: chosen };
  const o = options();
  let failed = false;
  for (const id of o.order.filter(x => SOURCES[x].online && !o.disabled.includes(x))) {
    try {
      const hit = (await providers[id]({ artist: name })).find(r => r.score >= 0.9 && /^https:\/\//i.test(r.thumb || ''));
      if (hit) return { url: hit.thumb };
    } catch { failed = true; }
  }
  return { url: null, failed };
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
    if (!/\.(jpe?g|png|gif)$/i.test(image.file)) throw new Error('Use a JPG, PNG or GIF picture');
    return fs.promises.readFile(image.file);
  }
  throw new Error('No picture chosen');
}

/** Put the picture in the tag beside what is already there; a front cover is never touched */
function writeTag(file, jpeg, { onlyMissing = false } = {}) {
  const { Picture, PictureType, ByteVector } = require('node-taglib-sharp');
  const f = openTags(file);
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

let stopRequested = false;
const progress = (p) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('artists:progress', p));

async function writeToTracks(name, jpeg, { onlyMissing, allowReadOnly }) {
  const { upsertSingleFile } = require('./music');
  const local = ownTracks(name).filter(t => canHold(t.path));
  const errors = [];
  const files = [];
  let tags = 0;
  let stopped = false;
  let shownAt = 0;
  stopRequested = false;
  progress({ name, done: 0, total: local.length });
  for (const [i, t] of local.entries()) {
    if (stopRequested) { stopped = true; break; }
    if (Date.now() - shownAt > 200) { shownAt = Date.now(); progress({ name, done: i, total: local.length }); }
    try {
      const wrote = withWritable(t.path, allowReadOnly, () => writeTag(t.path, jpeg, { onlyMissing }));
      if (wrote) { tags++; files.push(await upsertSingleFile(t.path)); }
    } catch (err) { errors.push({ path: t.path, ...describeWriteError(err, t.path) }); }
    await new Promise(r => setImmediate(r)); // playback and the window keep going on a big artist
  }
  progress({ name, done: local.length, total: local.length, finished: true });
  announce(name, local.map(t => t.path), files.filter(Boolean));
  return { tags, errors, stopped, total: local.length };
}

async function save({ name, image, onlyMissing = false, allowReadOnly = false }) {
  if (!name || NOT_AN_ARTIST.test(name.trim())) throw new Error('That is not one artist');
  const buf = await loadImage(image);
  const gif = isGif(buf) ? await readGif(buf) : null;
  const moving = gif?.frames > 1; // a GIF of one frame is just a picture
  const jpeg = resized(gif ? gif.still : buf, MAX_SIDE, 90);
  await fs.promises.mkdir(dir(), { recursive: true });
  await fs.promises.writeFile(fileFor(name), resized(jpeg, SHOW_SIDE, 88));
  loadIndex()[norm(name)] = { source: 'user', url: /^https:\/\//i.test(image?.url || '') ? image.url : undefined };
  saveIndex();
  const hadGif = !!gifState(name)?.key;
  if (moving) await fs.promises.writeFile(gifFile(name), buf);
  else await fs.promises.rm(gifFile(name), { force: true }).catch(() => {});
  setGifState(name, moving ? { key: gifKey(buf) } : { gone: true });
  const r = await writeToTracks(name, jpeg, { onlyMissing, allowReadOnly });
  if (moving || hadGif) tellCloud(name);
  console.log(`[Artist] Picture saved: ${r.tags} tags written, ${r.errors.length} files refused${r.stopped ? `, stopped by the user after ${r.tags} of ${r.total}` : ''}`);
  return r;
}

async function remove({ name, allowReadOnly = false }) {
  await fs.promises.rm(fileFor(name), { force: true }).catch(() => {});
  const hadGif = !!gifState(name)?.key;
  await fs.promises.rm(gifFile(name), { force: true }).catch(() => {});
  setGifState(name, { gone: true });
  if (hadGif) tellCloud(name);
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
  const r = await dialog.showOpenDialog(win, { title: 'Choose an artist picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'gif'] }] });
  if (r.canceled || !r.filePaths?.[0]) return null;
  const file = r.filePaths[0];
  const buf = await fs.promises.readFile(file);
  const t = thumbOf(isGif(buf) ? (await readGif(buf)).still : buf);
  if (!t) throw new Error('That file is not a JPG, PNG or GIF picture');
  return { file, ...t, name: path.basename(file) };
}

const wrap = (fn) => async (e, opts) => {
  try { return { success: true, ...(await fn(opts, e)) }; } catch (err) { return { success: false, error: err.message }; }
};
ipcMain.handle('artists:options', () => ({ ...options(), sources: SOURCES }));
ipcMain.handle('artists:set-options', (e, patch) => setOptions(patch || {}));
ipcMain.handle('artists:search', async (e, { query, all, auto }) => search(query || {}, { all, auto }));
ipcMain.handle('artists:youtube', (e, opts) => youtube(opts || {}));
ipcMain.handle('artists:save', wrap(save));
ipcMain.handle('artists:remove', wrap(remove));
ipcMain.handle('artists:has', async (e, { name }) => !!(await pictureFor(name).catch(() => null)));
ipcMain.handle('artists:targets', (e, { name }) => targets(name));
ipcMain.handle('artists:stop', () => { stopRequested = true; });
ipcMain.handle('artists:pick', wrap(async (o, e) => ({ picked: await pick(e) })));

module.exports = { pictureFor, motionFor, onlineArtistPicture, search, save, options, SOURCES, gifState, gifsInStorage, hasGifKey, wantsGif, gifFromCloud };
