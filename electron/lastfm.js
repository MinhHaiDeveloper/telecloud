// Last.fm: scrobbling (from the play history), "now playing", and artist biographies.
// The app's API key/secret come from electron/lastfm-key.json (not in git) or LASTFM_API_KEY /
// LASTFM_API_SECRET. Each user connects their own Last.fm account; the session key is encrypted.
const { ipcMain, app, safeStorage, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stats = require('./stats');

const API = process.env.LASTFM_API_URL || 'https://ws.audioscrobbler.com/2.0/';
const AUTH_URL = process.env.LASTFM_AUTH_URL || 'https://www.last.fm/api/auth/';
function appKey() {
  if (process.env.LASTFM_API_KEY && process.env.LASTFM_API_SECRET) return { apiKey: process.env.LASTFM_API_KEY, secret: process.env.LASTFM_API_SECRET };
  try { const k = JSON.parse(fs.readFileSync(path.join(__dirname, 'lastfm-key.json'), 'utf8')); if (k.apiKey && k.secret) return k; } catch { /* not configured */ }
  return null;
}

// ---- account (session key encrypted with Windows DPAPI via safeStorage)
const accountFile = () => path.join(app.getPath('userData'), 'lastfm.json');
const enc = (s) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : s);
const dec = (s) => (s && s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s);
function account() {
  try { const a = JSON.parse(fs.readFileSync(accountFile(), 'utf8')); return { ...a, sk: dec(a.sk) }; } catch { return null; }
}
function saveAccount(a) {
  if (!a) { fs.rmSync(accountFile(), { force: true }); return; }
  fs.writeFileSync(accountFile(), JSON.stringify({ ...a, sk: enc(a.sk) }, null, 2));
}

// ---- API calls
const sign = (params, secret) => crypto.createHash('md5').update(Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort().map(k => k + params[k]).join('') + secret, 'utf8').digest('hex');
async function call(method, params = {}, { signed = false, post = false } = {}) {
  const key = appKey();
  if (!key) throw new Error('Last.fm is not set up in this build');
  const p = { method, api_key: key.apiKey, ...params };
  Object.keys(p).forEach(k => (p[k] === undefined || p[k] === null || p[k] === '') && delete p[k]);
  if (signed) p.api_sig = sign(p, key.secret);
  p.format = 'json';
  const body = new URLSearchParams(p).toString();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(post ? API : `${API}?${body}`, {
      method: post ? 'POST' : 'GET', body: post ? body : undefined, signal: ctl.signal,
      headers: { 'User-Agent': 'TeleCloud', ...(post ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) { const e = new Error(j.message || `Last.fm error ${j.error}`); e.code = j.error; throw e; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

// ---- connect: desktop auth (token → user approves in the browser → session)
let pendingToken = null;
async function connectStart() {
  const r = await call('auth.getToken', {}, { signed: true });
  pendingToken = r.token;
  shell.openExternal(`${AUTH_URL}?api_key=${appKey().apiKey}&token=${pendingToken}`);
  return { token: pendingToken };
}
async function connectFinish() {
  if (!pendingToken) throw new Error('Start connecting first');
  const r = await call('auth.getSession', { token: pendingToken }, { signed: true });
  pendingToken = null;
  saveAccount({ user: r.session.name, sk: r.session.key, connectedAt: Date.now(), scrobble: true });
  scrobblePending().catch(() => {});
  return { user: r.session.name };
}

// ---- scrobbling: plays are written to the history first, then sent in batches of up to 50.
// Failed batches (offline) stay unsent and go with the next play.
const firstArtist = (a) => (a || '').split(/,|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+/i)[0].trim();
let sending = null;
async function scrobblePending() {
  const a = account();
  if (!a?.sk || a.scrobble === false || !appKey()) return { sent: 0 };
  if (sending) return sending;
  sending = (async () => {
    const db = stats.db();
    // Last.fm takes scrobbles up to 14 days old; from the account's connection on (plus the
    // couple of hours before it, so the track you were playing while connecting still counts)
    const since = Math.max((a.connectedAt || 0) - 2 * 3600000, Date.now() - 13.5 * 86400000);
    let sent = 0;
    for (;;) {
      const rows = db.prepare('SELECT * FROM plays WHERE scrobbled = 0 AND played_at >= ? AND artist IS NOT NULL AND title IS NOT NULL ORDER BY played_at LIMIT 50').all(since);
      if (!rows.length) break;
      const params = { sk: a.sk };
      rows.forEach((r, i) => {
        params[`artist[${i}]`] = firstArtist(r.artist);
        params[`track[${i}]`] = r.title;
        params[`timestamp[${i}]`] = Math.floor(r.played_at / 1000);
        if (r.album) params[`album[${i}]`] = r.album;
        if (r.duration_ms) params[`duration[${i}]`] = Math.round(r.duration_ms / 1000);
      });
      try {
        await call('track.scrobble', params, { signed: true, post: true });
      } catch (err) {
        if (err.code === 9) { saveAccount(null); notify(); } // session revoked on last.fm
        throw err;
      }
      db.prepare(`UPDATE plays SET scrobbled = 1 WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map(r => r.id));
      sent += rows.length;
    }
    return { sent };
  })().finally(() => { sending = null; });
  return sending;
}
stats.onPlay(() => { scrobblePending().catch(() => {}); });
setInterval(() => scrobblePending().catch(() => {}), 10 * 60000).unref?.();

async function nowPlaying(t) {
  const a = account();
  if (!a?.sk || a.scrobble === false || !appKey() || !t?.artist || !t?.title) return false;
  await call('track.updateNowPlaying', { sk: a.sk, artist: firstArtist(t.artist), track: t.title, album: t.album, duration: t.duration ? Math.round(t.duration) : undefined }, { signed: true, post: true });
  return true;
}

// ---- artist biography (cached for a week)
const bioFile = () => path.join(app.getPath('userData'), 'artist-info.json');
let bioCache = null;
const stripHtml = (s) => (s || '').replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/i, '').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
async function artistInfo(name) {
  if (!name) return null;
  if (!bioCache) { try { bioCache = JSON.parse(fs.readFileSync(bioFile(), 'utf8')); } catch { bioCache = {}; } }
  const k = name.toLowerCase();
  const hit = bioCache[k];
  if (hit && Date.now() - hit.at < 7 * 86400000) return hit.info;
  const r = await call('artist.getInfo', { artist: name, autocorrect: 1 });
  const a = r.artist || {};
  const info = {
    name: a.name || name, url: a.url,
    summary: stripHtml(a.bio?.summary), content: stripHtml(a.bio?.content),
    tags: (a.tags?.tag || []).map(t => t.name).slice(0, 6),
    listeners: Number(a.stats?.listeners) || null, playcount: Number(a.stats?.playcount) || null,
    similar: (a.similar?.artist || []).map(s => s.name).slice(0, 6),
  };
  bioCache[k] = { at: Date.now(), info };
  try { fs.writeFileSync(bioFile(), JSON.stringify(bioCache)); } catch { /* cache only */ }
  return info;
}

const status = () => {
  const a = account();
  const pending = stats.db().prepare('SELECT COUNT(*) n FROM plays WHERE scrobbled = 0 AND played_at >= ?').get(Math.max((a?.connectedAt || Date.now()) - 2 * 3600000, Date.now() - 13.5 * 86400000)).n;
  return { available: !!appKey(), user: a?.user || null, scrobble: a ? a.scrobble !== false : false, pending: a ? pending : 0 };
};
const notify = () => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('lastfm:status', status()));

const wrap = (fn) => async (e, arg) => { try { return { success: true, ...(await fn(arg)) }; } catch (err) { return { success: false, error: err.message }; } };
ipcMain.handle('lastfm:status', () => status());
ipcMain.handle('lastfm:connect', wrap(() => connectStart()));
ipcMain.handle('lastfm:finish', wrap(async () => { const r = await connectFinish(); notify(); return r; }));
ipcMain.handle('lastfm:disconnect', wrap(async () => { saveAccount(null); notify(); return {}; }));
ipcMain.handle('lastfm:set-scrobble', wrap(async (on) => { const a = account(); if (a) saveAccount({ ...a, scrobble: !!on }); notify(); return {}; }));
ipcMain.handle('lastfm:now-playing', wrap(async (t) => ({ sent: await nowPlaying(t) })));
ipcMain.handle('lastfm:scrobble-now', wrap(async () => { const r = await scrobblePending(); notify(); return r; }));
ipcMain.handle('lastfm:artist', wrap(async (name) => ({ info: await artistInfo(name) })));

module.exports = { scrobblePending, artistInfo, status, sign, call };
