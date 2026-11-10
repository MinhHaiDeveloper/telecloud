// Discord Rich Presence: shows what is playing on the user's Discord status. Talks to the Discord
// desktop app on this computer over its local pipe; no server and no sign-in. Off until turned on.
// The cover is a public link found on the online sources, or the app's logo. Files are never uploaded.
const { ipcMain, app, BrowserWindow } = require('electron');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLIENT_ID = '1568091864295415848';
const LOGO = 'telecloud'; // art asset uploaded to the Discord application
const DEFAULTS = { enabled: false, showPaused: true, showLastPlayed: true, onlineCover: true, showButton: true, statusText: '{track} by {artist}' };
const BUTTON = { label: 'Get TeleCloud', url: 'https://telecloud-music.pages.dev/' };
const MIN_GAP = 4000;  // Discord allows a few updates every 20 s; the newest state always wins
const RETRY = 15000;   // look for Discord again this often while it isn't running

const settingsFile = () => path.join(app.getPath('userData'), 'discord-settings.json');
function options() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

// ---------- what to show (pure, so it is easy to test)
const chars = (s) => Array.from(String(s ?? '').trim());
/** Discord rejects text under 2 or over 128 characters */
function fit(s) {
  const c = chars(s).slice(0, 128);
  if (!c.length) return undefined;
  return c.length < 2 ? `${c.join('')}​` : c.join('');
}
const fill = (template, t) => String(template || DEFAULTS.statusText)
  .replace(/\{track\}/g, t.title || '').replace(/\{artist\}/g, t.artist || '').replace(/\{album\}/g, t.album || '');
const known = (v, unknown) => (v && v !== unknown ? v : '');

/**
 * The activity for a state: { track, playing, position, last }; null when nothing should show.
 * `last` is the track played most recently, shown when the app has nothing loaded.
 */
function buildActivity({ track: current, playing, position, last }, o, coverUrl, now = Date.now(), compat = false, artistUrl = null) {
  const track = current || (o.showLastPlayed ? last : null);
  if (!track) return null;
  if (current && !playing && !o.showPaused) return null;
  const artist = known(track.artist, 'Unknown Artist');
  const album = known(track.album, 'Unknown Album');
  const a = {
    type: 2, // "Listening to"
    details: fit(track.title) || fit('Unknown track'),
    assets: { large_image: coverUrl && coverUrl.length <= 256 ? coverUrl : LOGO },
  };
  if (artist && artistUrl && artistUrl.length <= 256) {
    a.assets.small_image = artistUrl;
    if (fit(artist)) a.assets.small_text = fit(artist);
  }
  if (!compat) {
    a.name = fit(fill(o.statusText, { title: track.title, artist, album })) || 'TeleCloud';
    if (o.showButton) a.buttons = [BUTTON];
  }
  const word = current ? 'Paused' : 'Last played';
  const line = playing ? artist : (artist ? `${word} · ${artist}` : word);
  if (fit(line)) a.state = fit(line);
  if (fit(album)) a.assets.large_text = fit(album);
  if (current && playing) {
    const start = Math.round(now - Math.max(0, position || 0) * 1000);
    a.timestamps = { start };
    if (track.duration > 0) a.timestamps.end = Math.round(start + track.duration * 1000);
  }
  return a;
}

// ---------- the album's cover, found online once per album
const coverCache = new Map();
function firstName(s) {
  return (s || '').split(/[;,、]|\s+[&/]\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim();
}
async function findCover(track) {
  const album = known(track?.album, 'Unknown Album');
  if (!album) return null;
  const owner = firstName(track.albumArtist);
  const artist = owner && !/^various/i.test(owner) ? owner : (owner ? '' : firstName(known(track.artist, 'Unknown Artist')));
  const key = `${album}\u0000${artist}`.toLowerCase();
  if (coverCache.has(key)) return coverCache.get(key);
  const { onlineCoverUrl } = require('./coverSearch');
  const { url, failed } = await onlineCoverUrl({ album, artist });
  // a source being down says nothing about the album: ask again next time
  if (url || !failed) {
    if (coverCache.size > 500) coverCache.clear();
    coverCache.set(key, url);
  }
  return url;
}

/** A picture of the artist, for the small circle on the cover. Public links only, as for covers. */
const artistCache = new Map();
async function findArtist(name) {
  const key = name.toLowerCase();
  if (artistCache.has(key)) return artistCache.get(key);
  const { url, failed } = await require('./artistImages').onlineArtistPicture(name);
  if (url || !failed) {
    if (artistCache.size > 500) artistCache.clear();
    artistCache.set(key, url);
  }
  return url;
}
const artistOf = (t) => firstName(known(t?.artist, 'Unknown Artist'));
const albumOf = (t) => (t ? `${t.album}\u0000${t.albumArtist}` : '');

// ---------- the last track played, kept for the next start
const lastFile = () => path.join(app.getPath('userData'), 'discord-last.json');
let lastTrack;
function loadLast() {
  if (lastTrack === undefined) { try { lastTrack = JSON.parse(fs.readFileSync(lastFile(), 'utf8')) || null; } catch { lastTrack = null; } }
  return lastTrack;
}
function rememberLast(track) {
  if (loadLast()?.path === track.path) return;
  lastTrack = track;
  fs.promises.writeFile(lastFile(), JSON.stringify(track)).catch(() => {});
}

// ---------- the pipe to Discord
let socket = null;
let ready = false;
let connecting = false;
let retryTimer = null;
let incoming = Buffer.alloc(0);
let state = { track: null, playing: false, position: 0, at: Date.now() };
let coverUrl = null;
let coverFor;            // the album and artist the pictures were looked up for
let artistUrl = null;
let artistFor;
let compat = false;       // Discord refused the full activity: send only the basics
let lastSent = 'none';
let lastSentAt = 0;
let sendTimer = null;
let pendingNonce = null;

const pipeNames = () => (process.env.TELECLOUD_DISCORD_PIPE ? [process.env.TELECLOUD_DISCORD_PIPE] : Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`));
const pushStatus = () => BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('discord:status', status()); });
const status = () => (!options().enabled ? 'off' : ready ? 'connected' : 'waiting');

function frame(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function disconnect() {
  clearTimeout(sendTimer);
  sendTimer = null;
  const s = socket;
  socket = null;
  ready = false;
  connecting = false;
  incoming = Buffer.alloc(0);
  lastSent = 'none';
  pendingNonce = null;
  if (s) { s.removeAllListeners(); s.on('error', () => {}); s.destroy(); }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (options().enabled) retryTimer = setTimeout(connect, RETRY);
}

function tryPipe(names, i) {
  if (i >= names.length) { connecting = false; scheduleRetry(); pushStatus(); return; }
  const s = net.createConnection(names[i]);
  s.once('error', () => { s.destroy(); if (socket === null) tryPipe(names, i + 1); });
  s.once('connect', () => {
    s.removeAllListeners('error');
    socket = s;
    connecting = false;
    s.on('data', onData);
    const gone = () => { if (socket === s) { disconnect(); scheduleRetry(); pushStatus(); } };
    s.on('close', gone);
    s.on('error', gone);
    s.write(frame(0, { v: 1, client_id: CLIENT_ID }));
  });
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (socket || connecting || !options().enabled) return;
  connecting = true;
  tryPipe(pipeNames(), 0);
}

function onData(chunk) {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 8) {
    const op = incoming.readInt32LE(0);
    const len = incoming.readInt32LE(4);
    if (incoming.length < 8 + len) return;
    const body = incoming.subarray(8, 8 + len);
    incoming = incoming.subarray(8 + len);
    let msg = null;
    try { msg = JSON.parse(body.toString('utf8')); } catch { /* ignore a bad frame */ }
    if (op === 3 && socket) socket.write(frame(4, msg || {}));
    else if (op === 2) { disconnect(); scheduleRetry(); pushStatus(); return; }
    else if (msg?.evt === 'READY') { ready = true; pushStatus(); refresh(); }
    else if (msg?.evt === 'ERROR' && msg.nonce && msg.nonce === pendingNonce && !compat) {
      // a newer field Discord doesn't take here: fall back to the basics
      console.warn('[Discord] activity refused, retrying without the status text:', msg.data?.message);
      compat = true;
      lastSent = 'none';
      refresh();
    }
  }
}

/** Send the current state, at most once per MIN_GAP; only the newest state goes out */
function refresh() {
  if (!ready || !socket) return;
  const wait = lastSentAt + MIN_GAP - Date.now();
  if (wait > 0) {
    if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = null; refresh(); }, wait);
    return;
  }
  const position = state.playing ? state.position + (Date.now() - state.at) / 1000 : state.position;
  const activity = buildActivity({ ...state, position, last: loadLast() }, options(), coverUrl, Date.now(), compat, artistUrl);
  const key = JSON.stringify(activity && { ...activity, timestamps: undefined, seek: state.at });
  if (key === lastSent) return;
  lastSent = key;
  lastSentAt = Date.now();
  pendingNonce = crypto.randomUUID();
  const args = activity ? { pid: process.pid, activity } : { pid: process.pid };
  socket.write(frame(1, { cmd: 'SET_ACTIVITY', args, nonce: pendingNonce }));
}

/** What the status is about: the current track, or the last one when nothing is loaded */
const showing = () => state.track || (options().showLastPlayed ? loadLast() : null);

let artistLookup = 0;
async function updateArtist() {
  const id = ++artistLookup;
  const o = options();
  const name = artistOf(showing());
  artistFor = name;
  artistUrl = null;
  if (!name || !o.enabled || !o.onlineCover) return;
  const url = await findArtist(name).catch(() => null);
  if (id === artistLookup && url) { artistUrl = url; lastSent = 'none'; refresh(); }
}

let lookup = 0;
async function updateCover() {
  const id = ++lookup;
  const o = options();
  const track = showing();
  coverFor = albumOf(track);
  coverUrl = null;
  if (!track || !o.enabled || !o.onlineCover) return;
  const url = await findCover(track).catch(() => null);
  if (id === lookup && url) { coverUrl = url; lastSent = 'none'; refresh(); }
}

/** From the player: the track, whether it plays, and where it is */
function update({ track, playing, position }) {
  state = { track: track || null, playing: !!playing, position: position || 0, at: Date.now() };
  if (track && playing) rememberLast(track);
  if (!options().enabled) return;
  connect();
  if (albumOf(showing()) !== coverFor) updateCover();
  if (artistOf(showing()) !== artistFor) updateArtist();
  refresh();
}

function setOptions(patch) {
  const before = options();
  const next = { ...before, ...patch };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  if (!next.enabled) {
    if (ready && socket) { try { socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() })); } catch { /* it is closing anyway */ } }
    clearTimeout(retryTimer);
    retryTimer = null;
    setTimeout(disconnect, 150);
    coverUrl = null;
    artistUrl = null;
    coverFor = undefined;
    artistFor = undefined;
    lookup++;
    artistLookup++;
  } else {
    connect();
    if (!before.enabled || before.onlineCover !== next.onlineCover || before.showLastPlayed !== next.showLastPlayed) { updateCover(); updateArtist(); }
    lastSent = 'none';
    refresh();
  }
  setTimeout(pushStatus, 200);
  return next;
}

ipcMain.handle('discord:options', () => ({ ...options(), status: status() }));
ipcMain.handle('discord:set-options', (e, patch) => setOptions(patch || {}));
ipcMain.handle('discord:update', (e, s) => { update(s || {}); });
app.on('before-quit', () => { clearTimeout(retryTimer); retryTimer = null; disconnect(); });

module.exports = { buildActivity, fit, fill, options };
