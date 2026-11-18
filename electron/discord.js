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
// Discord takes an update at any time but passes it on to its servers only every ~15 s, dropping what comes
// sooner (while still answering "taken"): updates are spaced that far apart, and the newest state goes out
const MIN_GAP = Number(process.env.TELECLOUD_DISCORD_GAP_MS) || 15000;
const PICTURE_WAIT = 2500; // a new track waits this long at most for its cover and artist picture
const RETRY = 15000;   // look for Discord again this often while it isn't running
const ANSWER = 5000;   // Discord answers each update at once; none in this time and it is sent again
const FOLLOW = Number(process.env.TELECLOUD_DISCORD_FOLLOW_MS) || 16000; // a change is sent once more after this: Discord may sit on one that came too soon
const LAST_WAIT = Number(process.env.TELECLOUD_DISCORD_LAST_WAIT_MS) || 6000; // after connecting, "Last played" waits this long for a track to start
const RESEND = Number(process.env.TELECLOUD_DISCORD_RESEND_MS) || 60000;  // while something shows, it is sent again this often, so a lost update heals itself

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
    if (fit(firstName(artist))) a.assets.small_text = fit(firstName(artist)); // the artist in the picture
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
/** A new artist picture was chosen (or removed): look it up again, now if it is showing */
function artistChanged(name) {
  for (const k of [...artistCache.keys()]) if (!name || k === String(name).toLowerCase()) artistCache.delete(k);
  if (typeof updateArtist === 'function' && (!name || String(artistOf(showing())).toLowerCase() === String(name).toLowerCase())) updateArtist();
}
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
let plain = false;        // refused again: no pictures either (a picture link Discord won't take)
let answerTimer = null;
let resendTimer = null;
let tries = 0;            // sends of the same status without an answer or with a refusal
let lastKind = null;      // playing / paused / last played / cleared, for the log
let followTimer = null;
let readyAt = 0;
let prevSentAt = 0;
let lastContent = null;     // what was last sent, to tell a repeat from a change         // before the last send: a refused update gives its turn back
let coverPending = false;
let artistPending = false;
let picturesBy = 0;         // until when a new track waits for its pictures
let lastSent = 'none';
let lastSentAt = 0;
let sendTimer = null;
let pendingNonce = null;

const pipeNames = () => (process.env.TELECLOUD_DISCORD_PIPE ? [process.env.TELECLOUD_DISCORD_PIPE] : Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`));
const pushStatus = () => BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('discord:status', status()); });
const status = () => (!options().enabled ? 'off' : ready ? 'connected' : 'waiting');
/** For the saved log's report: connection and what kind of status shows, never the song */
const report = () => ({ status: status(), showing: lastKind || 'nothing yet', basic: compat, noPictures: plain, lastSentAt });

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
  clearTimeout(answerTimer);
  answerTimer = null;
  clearInterval(resendTimer);
  resendTimer = null;
  clearTimeout(followTimer);
  followTimer = null;
  if (ready) console.log('[Discord] Disconnected');
  lastContent = null;
  lastKind = null;
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
    else if (msg?.evt === 'READY') {
      ready = true;
      readyAt = Date.now();
      console.log('[Discord] Connected');
      clearInterval(resendTimer);
      resendTimer = setInterval(() => { if (lastKind && lastKind !== 'cleared') { lastSent = 'none'; refresh(); } }, RESEND);
      resendTimer.unref?.();
      pushStatus(); refresh();
    }
    else if (msg?.evt === 'ERROR' && msg.nonce && msg.nonce === pendingNonce) {
      clearTimeout(answerTimer); answerTimer = null;
      tries++;
      // a field Discord doesn't take here: first without the status text and button, then without pictures
      console.warn(`[Discord] Status refused (${msg.data?.code || '?'}: ${String(msg.data?.message || '').slice(0, 160)}); trying again ${!compat ? 'without the status text' : !plain ? 'without pictures' : 'later'}`);
      if (!compat) compat = true; else if (!plain) plain = true;
      lastSent = 'none';
      lastSentAt = prevSentAt; // not shown: it doesn't use up the turn
      lastContent = null;
      if (tries <= 3) refresh();
    }
    else if (msg?.cmd === 'SET_ACTIVITY' && msg.nonce && msg.nonce === pendingNonce) {
      clearTimeout(answerTimer); answerTimer = null; // taken
      tries = 0;
    }
  }
}

/** Send the current state, at most once per MIN_GAP; only the newest state goes out */
function refresh() {
  if (!ready || !socket) return;
  // just connected and nothing loaded: give a track a moment to start before showing "Last played"
  if (!state.track && Date.now() - readyAt < LAST_WAIT) {
    if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = null; refresh(); }, LAST_WAIT - (Date.now() - readyAt) + 50);
    return;
  }
  const position = state.playing ? state.position + (Date.now() - state.at) / 1000 : state.position;
  const activity = buildActivity({ ...state, position, last: loadLast() }, options(), plain ? null : coverUrl, Date.now(), compat, plain ? null : artistUrl);
  const key = JSON.stringify(activity && { ...activity, timestamps: undefined, seek: state.at });
  if (key === lastSent) return;
  // the same as what Discord has (a follow-up, the regular resend, a retry): at once, and it doesn't take a turn
  const repeat = key === lastContent;
  if (!repeat) {
    // a new track: one update with its pictures, if they come soon (looked up before: at once)
    if ((coverPending || artistPending) && Date.now() < picturesBy) {
      if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = null; refresh(); }, picturesBy - Date.now() + 20);
      return;
    }
    const wait = lastSentAt + MIN_GAP - Date.now();
    if (wait > 0) {
      if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = null; refresh(); }, wait);
      return;
    }
  }
  lastSent = key;
  lastContent = key;
  prevSentAt = lastSentAt;
  if (!repeat) lastSentAt = Date.now();
  pendingNonce = crypto.randomUUID();
  const args = activity ? { pid: process.pid, activity } : { pid: process.pid };
  socket.write(frame(1, { cmd: 'SET_ACTIVITY', args, nonce: pendingNonce }));
  const kind = !activity ? 'cleared' : activity.timestamps ? 'playing' : /^Paused/.test(activity.state || '') ? 'paused' : 'last played';
  if (kind !== lastKind) { console.log(`[Discord] Status: ${kind}${compat ? ' (basic)' : ''}${plain ? ' (no pictures)' : ''}`); lastKind = kind; }
  // a change is sent once more a little later, in case Discord sat on it
  if (!repeat) {
    clearTimeout(followTimer);
    followTimer = setTimeout(() => { followTimer = null; lastSent = 'none'; refresh(); }, FOLLOW);
    followTimer.unref?.();
  }
  // no answer in time: Discord missed it (busy, or between restarts); send it again
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => {
    answerTimer = null;
    if (++tries > 3) { console.warn('[Discord] No answer to the status update; it is sent again within a minute'); return; }
    lastSent = 'none';
    refresh();
  }, ANSWER);
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
  if (!name || !o.enabled || !o.onlineCover) { artistPending = false; return; }
  artistPending = true;
  const url = await findArtist(name).catch(() => null);
  if (id !== artistLookup) return;
  artistPending = false;
  if (url) artistUrl = url;
  lastSent = 'none'; refresh();
}

let lookup = 0;
async function updateCover() {
  const id = ++lookup;
  const o = options();
  const track = showing();
  coverFor = albumOf(track);
  coverUrl = null;
  if (!track || !o.enabled || !o.onlineCover) { coverPending = false; return; }
  coverPending = true;
  const url = await findCover(track).catch(() => null);
  if (id !== lookup) return;
  coverPending = false;
  if (url) coverUrl = url;
  lastSent = 'none'; refresh();
}

/** From the player: the track, whether it plays, and where it is */
function update({ track, playing, position }) {
  if ((track?.path || null) !== (state.track?.path || null)) { plain = false; tries = 0; }
  state = { track: track || null, playing: !!playing, position: position || 0, at: Date.now() };
  if (track && playing) rememberLast(track);
  if (!options().enabled) return;
  connect();
  const newCover = albumOf(showing()) !== coverFor, newArtist = artistOf(showing()) !== artistFor;
  if (newCover || newArtist) picturesBy = Date.now() + PICTURE_WAIT;
  if (newCover) updateCover();
  if (newArtist) updateArtist();
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

module.exports = { report, buildActivity, fit, fill, options, artistChanged };
