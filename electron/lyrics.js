// Lyrics search and saving, in the spirit of foobar2000's OpenLyrics:
// an ordered list of sources (tags, a .lrc next to the track, online services), results the user
// can pick from or edit, saved into the file's tags and/or a .lrc file.
const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const database = require('./database');
const { describeWriteError } = require('./fileWrite');
const { decryptQrc, qrcText } = require('./qrc');

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
  wordByWord: true,             // ask NetEase, QQ Music and Kugou for their word-by-word lyrics, and prefer them
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
const realLines = (text) => (text || '').split(/\r?\n/).map(l => l.replace(/\[[^\]]*\]|<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, '').trim()) // word times too
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
// Words that mark another version of a song: its lyrics or their timing differ (a remix, a live take,
// a sped-up edit), so a found song with one counts against the match unless the track has it too.
const VARIANT = /\b(remix(?:es)?|mix|live|acoustic|unplugged|instrumental|karaoke|sped[ -]?up|speed[ -]?up|slowed|reverb|nightcore|8d|lo-?fi|cover|demo|mashup|bootleg|vip|piano|orchestral|a cappella)\b|伴奏|纯音乐|现场|翻唱|加速|降速|慢速|\bdj\b|dj版|女声版|男声版|抖音版/gi;
const variants = (s) => new Set([...String(s || '').toLowerCase().matchAll(VARIANT)].map(m => m[0].replace(/[\s-]+/g, '')));
// the title inside the lyrics ([ti:...]) can say more than the search result: Kugou lists "Faded" with "[ti:Faded (Remix)]"
const titleTag = (text) => /^\s*\[ti:([^\]]*)\]/mi.exec(text || '')?.[1] || '';
function variantPenalty(track, ...titles) {
  const mine = variants(track.title);
  const theirs = new Set(titles.flatMap(t => [...variants(t)]));
  let p = 0;
  for (const v of theirs) if (!mine.has(v)) p += 0.35; // another version: even a perfect match drops below 0.7
  for (const v of mine) if (!theirs.has(v)) p += 0.15; // the track is a version, this may be the original
  return Math.min(p, 0.6);
}
// how well a found song matches the track (0..1): title, artist, and duration within 3 s
function score(track, found) {
  let s = 0;
  if (clean(found.title) === clean(track.title)) s += 0.5; else if (clean(found.title).includes(clean(track.title)) || clean(track.title).includes(clean(found.title))) s += 0.3;
  const fa = clean(found.artist), ta = clean(track.artist);
  if (fa && ta && (fa.includes(clean(firstArtist(track.artist))) || ta.includes(fa))) s += 0.3;
  if (track.duration && found.duration) s += Math.abs(track.duration - found.duration) <= 3 ? 0.2 : Math.abs(track.duration - found.duration) <= 10 ? 0.1 : -0.2;
  return Math.max(0, Math.min(1, s));
}

// ---------- word-by-word lyrics from NetEase (YRC), QQ Music (QRC) and Kugou (KRC), turned into Enhanced LRC
// Enhanced LRC: [mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word<mm:ss.xx>, a time before each word and the last word's end
const lrcTime = (ms) => {
  const t = Math.max(0, Math.round(ms / 10)); // hundredths
  const m = Math.floor(t / 6000), s = (t % 6000) / 100;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
/**
 * One word-timed line, as both formats give it: the line's start, then (start, length, text) for each word.
 * `relative`: the word times count from the line's start (KRC) instead of from the song's (YRC).
 */
function wordLine(lineStart, words, relative) {
  const ws = words.map(([t, d, text]) => ({ t: relative ? lineStart + t : t, d, text })).filter(w => w.text !== '');
  if (!ws.length) return null;
  const last = ws[ws.length - 1];
  return `[${lrcTime(lineStart)}]${ws.map(w => `<${lrcTime(w.t)}>${w.text}`).join('')}<${lrcTime(last.t + last.d)}>`;
}
/** NetEase YRC: [start,length](wordStart,wordLength,0)word(...)word, times in ms from the song's start */
function yrcToLrc(yrc) {
  const out = [];
  for (const raw of String(yrc || '').split(/\r?\n/)) {
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
    if (!m) continue; // the {"t":...} credit lines and anything else
    const words = [...m[3].matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)].map(w => [Number(w[1]), Number(w[2]), w[3]]);
    const line = wordLine(Number(m[1]), words, false);
    if (line) out.push(line);
  }
  return out.length >= 2 ? out.join('\n') : null;
}
/** Kugou KRC (after decoding): [start,length]<offset,length,0>word..., word times from the line's start */
function krcToLrc(krc) {
  const out = [];
  for (const raw of String(krc || '').split(/\r?\n/)) {
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
    if (!m) continue; // [ti:], [ar:], [language:] headers
    const words = [...m[3].matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)].map(w => [Number(w[1]), Number(w[2]), w[3]]);
    const line = wordLine(Number(m[1]), words, true);
    if (line) out.push(line);
  }
  return out.length >= 2 ? out.join('\n') : null;
}
/** QQ Music QRC (after decoding): [start,length]word(start,length)word(start,length), times from the song's start */
function qrcToLrc(qrc) {
  const out = [];
  for (const raw of String(qrc || '').split(/\r?\n/)) {
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
    if (!m) continue; // [ti:], [ar:] headers
    // a word is whatever comes before its (start,length), brackets in the lyrics included
    const words = [...m[3].matchAll(/((?:[^(]|\((?!\d+,\d+\)))*)\((\d+),(\d+)\)/g)].map(w => [Number(w[2]), Number(w[3]), w[1]]);
    const line = wordLine(Number(m[1]), words, false);
    if (line) out.push(line);
  }
  return out.length >= 2 ? out.join('\n') : null;
}
// KRC files: "krc1", then XOR with a fixed key, then zlib
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
function decodeKrc(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.toString('latin1', 0, 4) !== 'krc1') return null;
  const body = Buffer.from(buf.subarray(4));
  for (let i = 0; i < body.length; i++) body[i] ^= KRC_KEY[i % KRC_KEY.length];
  return require('zlib').inflateSync(body).toString('utf8').replace(/^\uFEFF/, '');
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
      const words = options().wordByWord;
      const l = await get(words ? `https://music.163.com/api/song/lyric/v1?id=${s.id}&lv=-1&yv=-1&tv=-1` : `https://music.163.com/api/song/lyric?id=${s.id}&lv=1&kv=1&tv=-1`, { headers: { Referer: 'https://music.163.com/', 'User-Agent': BROWSER_UA } });
      const text = l?.lrc?.lyric;
      if (!text || !text.trim() || /纯音乐/.test(text)) continue;
      const byWord = words ? yrcToLrc(l?.yrc?.lyric) : null;
      if (byWord) out.push({ source: 'netease', ...found, lyrics: byWord, synced: true, words: true, score: sc });
      out.push({ source: 'netease', ...found, lyrics: text, synced: isSynced(text), score: sc });
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
      if (options().wordByWord && s.songid) {
        try {
          const xml = await get(`https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg?version=15&miniversion=82&lrctype=4&musicid=${s.songid}`, { json: false, headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_UA } });
          const hex = /<content[^>]*>\s*<!\[CDATA\[([0-9A-Fa-f]+)\]\]>/.exec(xml || '')?.[1];
          const byWord = hex ? qrcToLrc(qrcText(decryptQrc(hex))) : null;
          if (byWord) out.push({ source: 'qq', ...found, lyrics: byWord, synced: true, words: true, score: sc });
        } catch { /* no word version: the line one below */ }
      }
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
      if (options().wordByWord) {
        try {
          const k = await get(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=krc&charset=utf8`, { headers: { 'User-Agent': BROWSER_UA } });
          const krc = k?.content ? decodeKrc(k.content) : null;
          const byWord = krcToLrc(krc);
          // the word version drops the [ti:] header, so keep its title for the version check
          if (byWord) out.push({ source: 'kugou', ...found, lyrics: byWord, synced: true, words: true, score: sc, tagTitle: titleTag(krc) });
        } catch { /* no word version: the line one below */ }
      }
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
// with word by word on, a good match with word times beats one with line times only
const goodWords = (r) => (r.words && r.score >= 0.7 ? 1 : 0);

async function search(track, { all = false, sources } = {}) {
  const o = options();
  const list = sources || o.order.filter(id => !o.disabled.includes(id));
  const results = [];
  const errors = {};
  for (const id of list) {
    try {
      // at least two real lines, and online results must plausibly be this song
      const found = (await providers[id](track))
        .map(r => (SOURCES[id].online ? { ...r, score: Math.max(0, r.score - variantPenalty(track, r.title, r.tagTitle || titleTag(r.lyrics))) } : r))
        .filter(r => realLines(r.lyrics).length >= 2 && (!SOURCES[id].online || r.score >= 0.6));
      found.sort((a, b) => goodWords(b) - goodWords(a) || goodSynced(b) - goodSynced(a) || b.score - a.score || Number(b.synced) - Number(a.synced));
      results.push(...found);
      // what is on this computer wins; online, keep looking while only unsynced lyrics were found (and,
      // with word by word on, while none has word times: line-synced ones are still used if that is all)
      const enough = (r) => r.score >= 0.7 && (!SOURCES[id].online || (o.wordByWord ? r.words : r.synced));
      if (!all && found.some(enough)) break;
    } catch (err) {
      errors[id] = err.name === 'AbortError' ? 'timed out' : err.message === 'fetch failed' ? 'could not connect' : err.message;
    }
  }
  if (!all) results.sort((a, b) => (o.wordByWord ? goodWords(b) - goodWords(a) : 0) || goodSynced(b) - goodSynced(a)); // the sort keeps source order otherwise
  noteSearch(all, results, errors);
  return { results, errors };
}

// What the searches of this session gave, for the saved log's report: sources and kinds, never a song
const session = { searches: 0, picked: {}, nothing: 0, errors: {} };
function noteSearch(all, results, errors) {
  for (const [id, e] of Object.entries(errors)) {
    const k = `${id}: ${String(e).slice(0, 60)}`;
    session.errors[k] = (session.errors[k] || 0) + 1;
  }
  if (all) return; // the Search window lists everything; what the automatic search takes is what counts
  session.searches++;
  const top = results[0];
  if (!top) { session.nothing++; return; }
  const k = `${top.source} ${top.words ? 'word by word' : top.synced ? 'synced' : 'plain'}`;
  session.picked[k] = (session.picked[k] || 0) + 1;
}
function sessionReport() {
  const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ');
  return { searches: session.searches, picked: list(session.picked) || 'none', nothing: session.nothing, errors: list(session.errors) || 'none' };
}

// ---------- saving
function writeTag(file, text) {
  // the playing track: written when it stops, so mpv doesn't stumble over a file that moves under it
  return require('./tagFile').writeWhenFree(file, () => {
    const f = require('./tagFile').openTags(file);
    try { f.tag.lyrics = text || ''; f.save(); } finally { f.dispose(); }
  });
}
async function save({ path: file, lyrics, to }) {
  const o = options();
  const where = to || o.saveTo;
  const row = database.getFileByPath(file);
  const local = file && !file.startsWith('tc://') && fs.existsSync(file);
  const done = [];
  let held = false;
  if (local && (where === 'tag' || where === 'both')) { held = writeTag(file, lyrics).held; done.push('tag'); }
  if (local && (where === 'lrc' || where === 'both')) { fs.writeFileSync(file.replace(/\.[^.\\/]+$/, '.lrc'), lyrics, 'utf8'); done.push('lrc'); }
  // the library keeps a copy too, so cloud-only tracks get lyrics (and the TeleCloud index picks them up)
  if (row) database.initDatabase().prepare('UPDATE music_files SET lyrics = ? WHERE path = ?').run(lyrics || null, file);
  if (row?.telegram_message_id) { try { require('./telecloud/service').indexChanged([file]); } catch { /* TeleCloud not set up */ } }
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('lyrics:saved', { path: file, lyrics }));
  return { saved: done, cloudOnly: !local, held };
}

ipcMain.handle('lyrics:options', () => ({ ...options(), sources: SOURCES }));
ipcMain.handle('lyrics:set-options', (e, patch) => setOptions(patch || {}));
ipcMain.handle('lyrics:search', async (e, { track, all, sources }) => search(track, { all, sources }));
ipcMain.handle('lyrics:save', async (e, opts) => {
  try { return { success: true, ...(await save(opts)) }; } catch (err) { return { success: false, error: describeWriteError(err, opts?.path).error }; }
});

module.exports = { search, save, options, isSynced, SOURCES, _words: { yrcToLrc, krcToLrc, decodeKrc, qrcToLrc }, _variantPenalty: variantPenalty, sessionReport };
