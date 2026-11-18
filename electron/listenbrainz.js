// ListenBrainz: scrobbling with the user's own token (listenbrainz.org/settings), next to Last.fm.
// Listens come from the play history, like Last.fm's: every play that counts is a row in `plays`, and
// `lb_sent` marks the ones ListenBrainz has, so plays made offline go out later and a restart loses none.
// Each listen carries MusicBrainz IDs when they are sure: from the file's tags, or else one search per
// track (kept in `mb_ids`), so ListenBrainz links the listen to the exact recording and release.
const { ipcMain, app, safeStorage, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const stats = require('./stats');

const API = process.env.LISTENBRAINZ_API_URL || 'https://api.listenbrainz.org';
const MB_API = process.env.MUSICBRAINZ_API_URL || 'https://musicbrainz.org/ws/2';
const VERSION = require('../package.json').version;
const UA = `TeleCloud/${VERSION} ( https://github.com/MinhHaiDeveloper/telecloud )`;
const BATCH = 100; // ListenBrainz takes up to 1000 listens a call; smaller calls fail smaller

// ---- account (token encrypted with Windows DPAPI via safeStorage, as Last.fm's session key)
const accountFile = () => path.join(app.getPath('userData'), 'listenbrainz.json');
const enc = (s) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : s);
const dec = (s) => (s && s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s);
function account() {
  try {
    const a = JSON.parse(fs.readFileSync(accountFile(), 'utf8'));
    const token = dec(a.token);
    require('./logger').addSecrets([token]);
    return { ...a, token };
  } catch { return null; }
}
function saveAccount(a) {
  if (!a) { fs.rmSync(accountFile(), { force: true }); return; }
  fs.writeFileSync(accountFile(), JSON.stringify({ ...a, token: enc(a.token) }, null, 2));
}

// ---- the history: one more column, and the IDs found for each track
function db() {
  const d = stats.db();
  if (!d.__lb) {
    try { d.exec('ALTER TABLE plays ADD COLUMN lb_sent INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
    d.exec(`CREATE TABLE IF NOT EXISTS mb_ids (
      path TEXT PRIMARY KEY,
      recording TEXT, release TEXT, artists TEXT,
      source TEXT,         -- 'tags', 'search' or 'none' (looked for, nothing sure)
      checked_at INTEGER NOT NULL
    )`);
    d.__lb = true;
  }
  return d;
}

async function request(url, { method = 'GET', token, body, timeout = 10000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method, signal: ctl.signal, body: body ? JSON.stringify(body) : undefined,
      headers: { 'User-Agent': UA, ...(token ? { Authorization: `Token ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const text = await r.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) {
      const e = require('./httpError')(r, url);
      e.status = r.status;
      if (j?.error) e.message = `${j.error} (HTTP ${r.status})`;
      throw e;
    }
    return j || {};
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('ListenBrainz did not answer in time');
    if (err.message === 'fetch failed') throw new Error("couldn't connect");
    throw err;
  } finally { clearTimeout(t); }
}

// ---- MusicBrainz IDs
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const firstArtist = (a) => (a || '').split(/,|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+/i)[0].trim();

async function idsFromTags(file) {
  if (!file || file.startsWith('tc://') || !fs.existsSync(file)) return null;
  const mm = await import('music-metadata');
  const { common } = await mm.parseFile(file, { duration: false, skipCovers: true, skipPostHeaders: true });
  const recording = MBID.test(common.musicbrainz_recordingid || '') ? common.musicbrainz_recordingid : null;
  if (!recording) return null;
  return {
    recording,
    release: MBID.test(common.musicbrainz_albumid || '') ? common.musicbrainz_albumid : null,
    artists: (common.musicbrainz_artistid || []).filter(id => MBID.test(id)),
  };
}

// MusicBrainz allows one request a second from an app: searches wait their turn
let mbLast = 0;
let mbChain = Promise.resolve();
const mbTurn = () => {
  const turn = mbChain.then(async () => {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    mbLast = Date.now();
  });
  mbChain = turn.catch(() => {});
  return turn;
};

/** A sure match only: the title and the main artist the same, the length within 3 s, the album when known */
async function idsFromSearch({ title, artist, album, durationMs }) {
  if (!title || !artist) return null;
  const quote = (s) => `"${String(s).replace(/["\\]/g, ' ')}"`;
  const parts = [`recording:${quote(title)}`, `artist:${quote(firstArtist(artist))}`];
  if (album) parts.push(`release:${quote(album)}`);
  await mbTurn();
  const r = await request(`${MB_API}/recording?query=${encodeURIComponent(parts.join(' AND '))}&fmt=json&limit=10`);
  const want = { title: clean(title), artist: clean(firstArtist(artist)), album: clean(album) };
  for (const rec of r.recordings || []) {
    if (clean(rec.title) !== want.title) continue;
    const credit = rec['artist-credit'] || [];
    if (!credit.some(c => clean(c.name || c.artist?.name) === want.artist)) continue;
    if (durationMs && rec.length && Math.abs(rec.length - durationMs) > 3000) continue;
    const releases = rec.releases || [];
    const release = want.album ? releases.find(x => clean(x.title) === want.album) : null;
    if (want.album && !release) continue; // the song, but on another album: not sure enough
    return { recording: rec.id, release: release?.id || null, artists: credit.map(c => c.artist?.id).filter(Boolean) };
  }
  return null;
}

const mbFails = new Map(); // path -> when a search failed (offline): try again after a while
async function idsFor(play) {
  const d = db();
  const kept = d.prepare('SELECT * FROM mb_ids WHERE path = ?').get(play.path);
  if (kept) return kept.source === 'none' ? null : { recording: kept.recording, release: kept.release, artists: JSON.parse(kept.artists || '[]') };
  if (Date.now() - (mbFails.get(play.path) || 0) < 30 * 60000) return null;
  let ids = null, source = 'none';
  try {
    ids = await idsFromTags(play.path).catch(() => null);
    if (ids) source = 'tags';
    else {
      ids = await idsFromSearch({ title: play.title, artist: play.artist, album: play.album, durationMs: play.duration_ms });
      if (ids) source = 'search';
    }
  } catch (err) {
    mbFails.set(play.path, Date.now()); // not reached: no answer is not "no match", ask again later
    console.warn(`[ListenBrainz] MusicBrainz lookup failed: ${err.message}`);
    return null;
  }
  d.prepare('INSERT OR REPLACE INTO mb_ids (path, recording, release, artists, source, checked_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(play.path, ids?.recording || null, ids?.release || null, JSON.stringify(ids?.artists || []), source, Date.now());
  return ids;
}

function trackMetadata(t, ids) {
  const info = { submission_client: 'TeleCloud', submission_client_version: VERSION, media_player: 'TeleCloud' };
  if (t.durationMs) info.duration_ms = Math.round(t.durationMs);
  if (ids?.recording) info.recording_mbid = ids.recording;
  if (ids?.release) info.release_mbid = ids.release;
  if (ids?.artists?.length) info.artist_mbids = ids.artists;
  const m = { artist_name: t.artist, track_name: t.title, additional_info: info };
  if (t.album) m.release_name = t.album;
  return m;
}

// ---- sending
let state = { lastSend: null, lastError: null };
const since = (a) => (a.connectedAt || Date.now()) - 2 * 3600000; // the track playing while the token was added counts too
let sending = null;
async function sendPending() {
  const a = account();
  if (!a?.token || a.scrobble === false || a.refused) return { sent: 0 };
  if (sending) return sending;
  sending = (async () => {
    const d = db();
    let sent = 0;
    for (;;) {
      const rows = d.prepare('SELECT * FROM plays WHERE lb_sent = 0 AND played_at >= ? AND artist IS NOT NULL AND title IS NOT NULL ORDER BY played_at LIMIT ?').all(since(a), BATCH);
      if (!rows.length) break;
      const payload = [];
      for (const r of rows) {
        const ids = await idsFor(r);
        payload.push({ listened_at: Math.floor(r.played_at / 1000), track_metadata: trackMetadata({ artist: r.artist, title: r.title, album: r.album, durationMs: r.duration_ms }, ids) });
      }
      try {
        await request(`${API}/1/submit-listens`, { method: 'POST', token: a.token, body: { listen_type: payload.length === 1 ? 'single' : 'import', payload } });
      } catch (err) {
        state = { ...state, lastError: err.message };
        if (err.status === 401) { saveAccount({ ...a, refused: true }); notify(); } // token reset or wrong: stop until it is fixed
        throw err;
      }
      d.prepare(`UPDATE plays SET lb_sent = 1 WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map(r => r.id));
      sent += rows.length;
      state = { lastSend: Date.now(), lastError: null };
    }
    if (sent) { console.log(`[ListenBrainz] sent ${sent} ${sent === 1 ? 'listen' : 'listens'}`); notify(); }
    return { sent };
  })().finally(() => { sending = null; });
  return sending;
}
stats.onPlay(() => { sendPending().catch(err => console.warn(`[ListenBrainz] not sent yet: ${err.message}`)); });
setInterval(() => sendPending().catch(() => {}), 10 * 60000).unref?.();

async function nowPlaying(t) {
  const a = account();
  if (!a?.token || a.scrobble === false || a.refused || !t?.artist || !t?.title) return false;
  await request(`${API}/1/submit-listens`, { method: 'POST', token: a.token, body: { listen_type: 'playing_now', payload: [{ track_metadata: trackMetadata({ artist: t.artist, title: t.title, album: t.album, durationMs: t.duration ? t.duration * 1000 : 0 }) }] } });
  return true;
}

async function connect(token) {
  const tk = String(token || '').trim();
  if (!/^[0-9a-f-]{20,}$/i.test(tk)) throw new Error('That is not a ListenBrainz user token. Copy it from listenbrainz.org/settings.');
  const r = await request(`${API}/1/validate-token`, { token: tk });
  if (!r.valid) throw new Error('ListenBrainz does not know this token. Copy it again from listenbrainz.org/settings.');
  require('./logger').addSecrets([tk]);
  saveAccount({ user: r.user_name, token: tk, connectedAt: Date.now(), scrobble: true });
  sendPending().catch(() => {});
  return { user: r.user_name };
}

function status() {
  const a = account();
  let pending = 0;
  if (a) { try { pending = db().prepare('SELECT COUNT(*) n FROM plays WHERE lb_sent = 0 AND played_at >= ? AND artist IS NOT NULL AND title IS NOT NULL').get(since(a)).n; } catch { /* no history yet */ } }
  let ids = {};
  if (a) { try { ids = Object.fromEntries(db().prepare('SELECT source, COUNT(*) n FROM mb_ids GROUP BY source').all().map(r => [r.source, r.n])); } catch { /* none yet */ } }
  return { user: a?.user || null, scrobble: a ? a.scrobble !== false : false, refused: !!a?.refused, pending, lastSend: state.lastSend, lastError: state.lastError, ids };
}
const notify = () => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('listenbrainz:status', status()));

const wrap = (fn) => async (e, arg) => { try { return { success: true, ...(await fn(arg)) }; } catch (err) { return { success: false, error: err.message }; } };
ipcMain.handle('listenbrainz:status', () => status());
ipcMain.handle('listenbrainz:connect', wrap(async (token) => { const r = await connect(token); notify(); return r; }));
ipcMain.handle('listenbrainz:disconnect', wrap(async () => { saveAccount(null); state = { lastSend: null, lastError: null }; notify(); return {}; }));
ipcMain.handle('listenbrainz:set-scrobble', wrap(async (on) => { const a = account(); if (a) saveAccount({ ...a, scrobble: !!on }); notify(); if (on) sendPending().catch(() => {}); return {}; }));
ipcMain.handle('listenbrainz:now-playing', wrap(async (t) => ({ sent: await nowPlaying(t) })));
ipcMain.handle('listenbrainz:send-now', wrap(async () => { const r = await sendPending(); notify(); return r; }));

module.exports = { status, sendPending, _idsFromSearch: idsFromSearch, _idsFor: idsFor };
