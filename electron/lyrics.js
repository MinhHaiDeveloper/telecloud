// Lyrics search and saving, in the spirit of foobar2000's OpenLyrics:
// an ordered list of sources (tags, a .lrc next to the track, online services), results the user
// can pick from or edit, saved into the file's tags and/or a .lrc file.
const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const database = require('./database');
const { describeWriteError } = require('./fileWrite');

const UA = 'TeleCloud/1.0 (https://github.com/MinhHaiDeveloper/telecloud)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SOURCES = {
  tags: { label: 'Metadata tags', online: false },
  local: { label: 'Local .lrc file', online: false },
  lrclib: { label: 'LRCLIB', online: true },
  netease: { label: 'NetEase Cloud Music', online: true },
  qq: { label: 'QQ Music', online: true },
  kugou: { label: 'Kugou', online: true },
  genius: { label: 'Genius', online: true, note: 'Plain lyrics only. Often blocks apps (403).' },
  musixmatch: { label: 'Musixmatch', online: true, note: 'Unofficial. Often returns placeholder text.' },
};
const DEFAULTS = {
  search: true,                 // look online when a playing track has no lyrics
  autoSave: false,              // save the best result without asking
  saveTo: 'tag',                // 'tag' | 'lrc' | 'both'
  order: ['tags', 'local', 'lrclib', 'netease', 'qq', 'kugou', 'genius', 'musixmatch'],
  disabled: ['genius', 'musixmatch'], // available but not searched until turned on
};

// options live in their own file, so saving the main settings never drops them
const settingsFile = () => path.join(require('electron').app.getPath('userData'), 'lyrics-settings.json');
function options() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { /* defaults */ }
  const order = [...new Set([...(s.order || []).filter(id => SOURCES[id]), ...DEFAULTS.order])];
  return { ...DEFAULTS, ...s, order };
}
function setOptions(patch) {
  const next = { ...options(), ...patch };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------- helpers
// lines that are actual lyrics: no LRC headers, no "Composer: …" style credits (instrumentals often only have those)
const realLines = (text) => (text || '').split(/\r?\n/).map(l => l.replace(/\[[^\]]*\]/g, '').trim())
  .filter(l => l && !/^[^:：]{1,40}[:：]\s*\S/.test(l) && !/^(作词|作曲|编曲|制作|词|曲)/.test(l));
const isSynced = (text) => /^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/m.test(text || '');
const clean = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\..*$|ft\..*$/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const firstArtist = (a) => (a || '').split(/,|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+/i)[0].trim();
async function get(url, { headers = {}, json = true, timeout = 8000, method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    if (!r.ok) throw require('./httpError')(r, url);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}
const decodeEntities = (s) => s.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
// how well a found song matches the track (0..1): title, artist, and duration within 3 s
function score(track, found) {
  let s = 0;
  if (clean(found.title) === clean(track.title)) s += 0.5; else if (clean(found.title).includes(clean(track.title)) || clean(track.title).includes(clean(found.title))) s += 0.3;
  const fa = clean(found.artist), ta = clean(track.artist);
  if (fa && ta && (fa.includes(clean(firstArtist(track.artist))) || ta.includes(fa))) s += 0.3;
  if (track.duration && found.duration) s += Math.abs(track.duration - found.duration) <= 3 ? 0.2 : Math.abs(track.duration - found.duration) <= 10 ? 0.1 : -0.2;
  return Math.max(0, Math.min(1, s));
}

// ---------- sources: each returns [{ source, title, artist, album, duration, lyrics, synced, score }]
const providers = {
  async tags(track) {
    const row = track.path ? database.getFileByPath(track.path) : null;
    const text = row?.lyrics || track.lyrics;
    return text ? [{ source: 'tags', title: track.title, artist: track.artist, lyrics: text, synced: isSynced(text), score: 1 }] : [];
  },
  async local(track) {
    if (!track.path || track.path.startsWith('tc://')) return [];
    const lrc = track.path.replace(/\.[^.\\/]+$/, '.lrc');
    if (!fs.existsSync(lrc)) return [];
    const text = fs.readFileSync(lrc, 'utf8');
    return text.trim() ? [{ source: 'local', title: track.title, artist: track.artist, lyrics: text, synced: isSynced(text), score: 1 }] : [];
  },
  async lrclib(track) {
    const q = new URLSearchParams({ track_name: track.title, artist_name: firstArtist(track.artist) });
    const list = await get(`https://lrclib.net/api/search?${q}`);
    return list.filter(x => x.syncedLyrics || x.plainLyrics).slice(0, 6).map(x => {
      const found = { title: x.trackName, artist: x.artistName, album: x.albumName, duration: x.duration };
      return { source: 'lrclib', ...found, lyrics: x.syncedLyrics || x.plainLyrics, synced: !!x.syncedLyrics, score: score(track, found) + (x.syncedLyrics ? 0.01 : 0) };
    });
  },
  async netease(track) {
    const body = new URLSearchParams({ s: `${track.title} ${firstArtist(track.artist)}`, type: '1', limit: '6', offset: '0' }).toString();
    const r = await get('https://music.163.com/api/search/get', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/', 'User-Agent': BROWSER_UA } });
    const songs = r?.result?.songs || [];
    const out = [];
    for (const s of songs.slice(0, 4)) {
      const found = { title: s.name, artist: (s.artists || []).map(a => a.name).join(', '), album: s.album?.name, duration: s.duration ? s.duration / 1000 : null };
      const sc = score(track, found);
      if (sc < 0.3) continue;
      const l = await get(`https://music.163.com/api/song/lyric?id=${s.id}&lv=1&kv=1&tv=-1`, { headers: { Referer: 'https://music.163.com/', 'User-Agent': BROWSER_UA } });
      const text = l?.lrc?.lyric;
      if (text && text.trim() && !/纯音乐/.test(text)) out.push({ source: 'netease', ...found, lyrics: text, synced: isSynced(text), score: sc });
    }
    return out;
  },
  async qq(track) {
    const q = new URLSearchParams({ w: `${track.title} ${firstArtist(track.artist)}`, format: 'json', n: '6', p: '1', cr: '1' });
    const r = await get(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${q}`, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_UA } });
    const songs = r?.data?.song?.list || [];
    const out = [];
    for (const s of songs.slice(0, 4)) {
      const found = { title: s.songname, artist: (s.singer || []).map(a => a.name).join(', '), album: s.albumname, duration: s.interval || null };
      const sc = score(track, found);
      if (sc < 0.3) continue;
      const l = await get(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${s.songmid}&format=json&nobase64=1&g_tk=5381`, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_UA } });
      const text = l?.lyric ? decodeEntities(l.lyric) : null;
      if (text && text.trim() && !/此歌曲为没有填词的纯音乐/.test(text)) out.push({ source: 'qq', ...found, lyrics: text, synced: isSynced(text), score: sc });
    }
    return out;
  },
  async kugou(track) {
    const q = new URLSearchParams({ ver: '1', man: 'yes', client: 'pc', keyword: `${firstArtist(track.artist)} - ${track.title}`, duration: track.duration ? String(Math.round(track.duration * 1000)) : '', hash: '' });
    const r = await get(`https://lyrics.kugou.com/search?${q}`, { headers: { 'User-Agent': BROWSER_UA } });
    const out = [];
    for (const c of (r?.candidates || []).slice(0, 4)) {
      const found = { title: c.song, artist: c.singer, duration: c.duration ? c.duration / 1000 : null };
      const sc = score(track, found);
      if (sc < 0.3) continue;
      const l = await get(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=lrc&charset=utf8`, { headers: { 'User-Agent': BROWSER_UA } });
      const text = l?.content ? Buffer.from(l.content, 'base64').toString('utf8') : '';
      if (text.trim()) out.push({ source: 'kugou', ...found, lyrics: text, synced: isSynced(text), score: sc });
    }
    return out;
  },
  async genius(track) {
    const r = await get(`https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(`${track.title} ${firstArtist(track.artist)}`)}`, { headers: { 'User-Agent': BROWSER_UA } });
    const hits = (r?.response?.sections || []).filter(s => s.type === 'song').flatMap(s => s.hits || []).map(h => h.result).filter(Boolean);
    const out = [];
    for (const h of hits.slice(0, 2)) {
      const found = { title: h.title, artist: h.primary_artist?.name || h.artist_names };
      const sc = score(track, found);
      if (sc < 0.4 || !h.url) continue;
      const html = await get(h.url, { json: false, headers: { 'User-Agent': BROWSER_UA } });
      const parts = [...html.matchAll(/<div[^>]+data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>(?=\s*<div|\s*<\/div>)/g)].map(m => m[1]);
      const text = decodeEntities(parts.join('\n').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
      if (text) out.push({ source: 'genius', ...found, lyrics: text, synced: false, score: sc });
    }
    return out;
  },
  async musixmatch(track) {
    const base = 'https://apic-desktop.musixmatch.com/ws/1.1';
    const headers = { 'User-Agent': BROWSER_UA, Cookie: 'x-mxm-token-guid=' };
    const tok = await get(`${base}/token.get?app_id=web-desktop-app-v1.0`, { headers });
    const token = tok?.message?.body?.user_token;
    if (!token || /UpgradeOnly/.test(token)) return [];
    const q = new URLSearchParams({ format: 'json', namespace: 'lyrics_richsynched', subtitle_format: 'lrc', app_id: 'web-desktop-app-v1.0', usertoken: token,
      q_track: track.title, q_artist: firstArtist(track.artist), q_duration: String(Math.round(track.duration || 0)) });
    const r = await get(`${base}/macro.subtitles.get?${q}`, { headers });
    const calls = r?.message?.body?.macro_calls || {};
    const sub = calls['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body;
    const plain = calls['track.lyrics.get']?.message?.body?.lyrics?.lyrics_body;
    const info = calls['matcher.track.get']?.message?.body?.track || {};
    const text = sub || plain;
    if (!text) return [];
    const found = { title: info.track_name || track.title, artist: info.artist_name || track.artist, album: info.album_name, duration: info.track_length };
    return [{ source: 'musixmatch', ...found, lyrics: text, synced: !!sub, score: score(track, found) }];
  },
};

/**
 * Search the enabled sources in order. With `all`, every source is asked and all results are
 * returned (the "Search" dialog); otherwise it stops at the first good match (automatic search).
 */
// A good match with timestamps beats a good match without: score 0.7 and up already means the
// length is within 10 s, so it is the same recording.
const goodSynced = (r) => (r.synced && r.score >= 0.7 ? 1 : 0);

async function search(track, { all = false, sources } = {}) {
  const o = options();
  const list = sources || o.order.filter(id => !o.disabled.includes(id));
  const results = [];
  const errors = {};
  for (const id of list) {
    try {
      // at least two real lines, and online results must plausibly be this song
      const found = (await providers[id](track)).filter(r => realLines(r.lyrics).length >= 2 && (!SOURCES[id].online || r.score >= 0.6));
      found.sort((a, b) => goodSynced(b) - goodSynced(a) || b.score - a.score || Number(b.synced) - Number(a.synced));
      results.push(...found);
      // what is on this computer wins; online, keep looking while only unsynced lyrics were found
      if (!all && found.some(r => r.score >= 0.7 && (r.synced || !SOURCES[id].online))) break;
    } catch (err) {
      errors[id] = err.name === 'AbortError' ? 'timed out' : err.message === 'fetch failed' ? 'could not connect' : err.message;
    }
  }
  if (!all) results.sort((a, b) => goodSynced(b) - goodSynced(a)); // the sort keeps source order otherwise
  return { results, errors };
}

// ---------- saving
function writeTag(file, text) {
  const f = require('./tagFile').openTags(file);
  try { f.tag.lyrics = text || ''; f.save(); } finally { f.dispose(); }
}
async function save({ path: file, lyrics, to }) {
  const o = options();
  const where = to || o.saveTo;
  const row = database.getFileByPath(file);
  const local = file && !file.startsWith('tc://') && fs.existsSync(file);
  const done = [];
  if (local && (where === 'tag' || where === 'both')) { writeTag(file, lyrics); done.push('tag'); }
  if (local && (where === 'lrc' || where === 'both')) { fs.writeFileSync(file.replace(/\.[^.\\/]+$/, '.lrc'), lyrics, 'utf8'); done.push('lrc'); }
  // the library keeps a copy too, so cloud-only tracks get lyrics (and the TeleCloud index picks them up)
  if (row) database.initDatabase().prepare('UPDATE music_files SET lyrics = ? WHERE path = ?').run(lyrics || null, file);
  if (row?.telegram_message_id) { try { require('./telecloud/service').indexChanged([file]); } catch { /* TeleCloud not set up */ } }
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('lyrics:saved', { path: file, lyrics }));
  return { saved: done, cloudOnly: !local };
}

ipcMain.handle('lyrics:options', () => ({ ...options(), sources: SOURCES }));
ipcMain.handle('lyrics:set-options', (e, patch) => setOptions(patch || {}));
ipcMain.handle('lyrics:search', async (e, { track, all, sources }) => search(track, { all, sources }));
ipcMain.handle('lyrics:save', async (e, opts) => {
  try { return { success: true, ...(await save(opts)) }; } catch (err) { return { success: false, error: describeWriteError(err, opts?.path).error }; }
});

module.exports = { search, save, options, isSynced, SOURCES };
