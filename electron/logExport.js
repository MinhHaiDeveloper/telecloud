// Settings > About > Logs: pack the log into a .zip for the user to send. Nothing is sent from here.
const { app, dialog, ipcMain, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const logger = require('./logger');
const { getLibraryRoots, readSettings } = require('./paths');
const { tx } = require('./i18n');

const deflate = promisify(zlib.deflateRaw);
const AUDIO = 'flac|wav|aiff?|aifc|alac|m4a|m4b|ape|wv|tta|dsf|dff|mp3|ogg|opus|aac|wma|mka|mpc|lrc|jpe?g|png|cue';

// ---------- a small .zip writer (deflate, no extra dependency)
async function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, text } of entries) {
    const data = Buffer.from(text, 'utf8');
    const packed = await deflate(data, { level: 6 });
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, packed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(8, 10);
    head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// ---------- hiding music names (the default)
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Latin letters and digits make words: a name starting or ending with one needs a break there.
// Names in scripts without spaces (Japanese, Chinese) can't be told apart that way, so they match anywhere.
const WORD = /[a-z0-9\u00c0-\u024f]/i;
const standsAlone = (line, i, name) => (
  !(WORD.test(name[0]) && i > 0 && WORD.test(line[i - 1]))
  && !(WORD.test(name[name.length - 1]) && WORD.test(line[i + name.length] || ''))
);

/** Finds known names in a line without a slow pattern: looks each position up by its first letters */
function nameFinder(names) {
  const buckets = new Map();
  for (const raw of names) {
    const n = String(raw || '').trim().toLowerCase();
    if (n.length < 3 || /^(unknown album|unknown artist)$/.test(n)) continue;
    const k = n.slice(0, 3);
    if (!buckets.has(k)) buckets.set(k, new Set());
    buckets.get(k).add(n);
  }
  for (const [k, set] of buckets) buckets.set(k, [...set].sort((a, b) => b.length - a.length));
  return (line) => {
    const low = line.toLowerCase();
    if (low.length !== line.length) return line; // case changes that move letters: paths are already gone
    let out = '';
    let i = 0;
    while (i < line.length) {
      const list = buckets.get(low.slice(i, i + 3));
      const hit = list && list.find(n => low.startsWith(n, i) && standsAlone(low, i, n));
      if (hit) { out += '<name>'; i += hit.length; } else { out += line[i]; i++; }
    }
    return out;
  };
}

function nameHider() {
  const roots = getLibraryRoots().map(r => logger.redact(r));
  const rootPattern = roots.length ? new RegExp(`(?:${roots.map(escape).join('|')})(?:[\\\\/][^\\\\/:*?"<>|\\r\\n]*)*`, 'gi') : null;
  const filePattern = new RegExp(`(?:[A-Za-z]:|~|\\\\\\\\[^\\\\/\\s]+)[\\\\/](?:[^\\\\/:*?"<>|\\r\\n]+[\\\\/])*[^\\\\/:*?"<>|\\r\\n]*?\\.(${AUDIO})\\b`, 'gi');
  let rows = [];
  try { rows = require('./database').getAllFiles(); } catch { /* no library yet */ }
  const find = nameFinder(rows.flatMap(r => [r.title, r.artist, r.album, r.album_artist, r.name, ...String(r.artist || '').split(/[,;]/), ...String(r.album_artist || '').split(';')]));
  return (line) => {
    let s = line.replace(filePattern, (m, ext) => `<file>.${ext.toLowerCase()}`);
    if (rootPattern) s = s.replace(rootPattern, '<music folder>');
    return find(s);
  };
}

// ---------- what the zip holds
function lineTime(line) {
  const m = logger.LINE_TIME.exec(line);
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}`) : null;
}

/** Log text between two times; lines without a time (stack traces) follow the line before them */
async function logBetween(text, from, to, clean) {
  const out = [];
  let keep = false;
  let first = null;
  let last = null;
  let count = 0;
  let sinceBreak = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    // a big log takes a while: keep the buttons and the player answering meanwhile
    if (++sinceBreak >= 1500) { sinceBreak = 0; await new Promise(setImmediate); }
    const t = lineTime(line);
    if (t !== null) { keep = t >= from && t <= to; if (keep) { first = first ?? t; last = t; count++; } }
    if (keep) out.push(clean(line));
  }
  return { text: out.length ? `${out.join('\n')}\n` : '', first, last, count };
}

// Only these settings go in the report; anything added later stays out until listed here
const SAFE_SETTINGS = ['skipDuplicates', 'artistFilter', 'autoContinue', 'replayGainEnabled', 'replayGainMode', 'crossfadeEnabled', 'crossfadeDuration', 'maxSamplingEnabled', 'maxBitDepth', 'maxSampleRate', 'dsdMode', 'dopMax', 'asioDriver', 'highPerformanceGpu', 'lowMemoryMode', 'closeToTray', 'channelBalance', 'crossfeed', 'skipSilence', 'mqaMode', 'releaseOnPause', 'pauseFade', 'exclusiveBuffer', 'lastSeenVersion'];

async function systemReport({ days, includeNames }) {
  const lines = [];
  const add = (k, v) => lines.push(`${k}: ${v}`);
  add('App version', app.getVersion());
  add('Channel', require('../package.json').version.includes('-') ? 'TeleCloud Beta' : 'TeleCloud');
  add('Packaged', app.isPackaged);
  add('Running for', `${Math.round(process.uptime() / 60)} min`);
  add('Electron', process.versions.electron);
  add('Windows', `${os.release()} ${os.arch()}`);
  add('Memory', `${Math.round(os.totalmem() / 1073741824)} GB, app using ${Math.round(process.memoryUsage().rss / 1048576)} MB (main process)`);
  add('CPU', `${os.cpus()?.[0]?.model || 'unknown'} x${os.cpus()?.length || 0}`);
  add('Language', app.getLocale());
  try {
    const { screen } = require('electron');
    add('Displays', screen.getAllDisplays().map(d => `${d.size.width}x${d.size.height} at ${Math.round(d.scaleFactor * 100)}%${d.displayFrequency ? ` ${Math.round(d.displayFrequency)} Hz` : ''}${d.internal ? ' (built in)' : ''}`).join(', '));
  } catch { /* no screen yet */ }
  try {
    const g = app.getGPUFeatureStatus();
    add('Graphics', `compositing ${g.gpu_compositing}, rasterization ${g.rasterization}, video decode ${g.video_decode}`);
  } catch { /* not ready */ }
  add('Time zone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  add('Log period', typeof days === 'number' ? `last ${days} days` : 'chosen dates');
  add('Music names in the log', includeNames ? 'included' : 'hidden');
  lines.push('');
  try {
    const rows = require('./database').getAllFiles();
    const byExt = {};
    rows.forEach(r => { byExt[r.ext || '?'] = (byExt[r.ext || '?'] || 0) + 1; });
    add('Tracks', rows.length);
    add('Cloud-only tracks', rows.filter(r => r.storage_type === 'cloud').length);
    add('Backed-up tracks', rows.filter(r => r.telegram_message_id).length);
    add('Formats', JSON.stringify(byExt));
  } catch (err) { add('Library', `unreadable: ${err.message}`); }
  try { add('Music folders', getLibraryRoots().length); } catch { /* not set */ }
  lines.push('');
  try {
    const s = readSettings() || {};
    const safe = Object.fromEntries(SAFE_SETTINGS.filter(k => k in s).map(k => [k, s[k]]));
    add('Settings', JSON.stringify(safe));
    add('Download folder set', !!s.downloadFolder);
  } catch { /* not set */ }
  add('Appearance', appearance ? JSON.stringify(appearance) : 'not reported');
  try {
    const eq = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'eq.json'), 'utf8'));
    add('Equalizer', JSON.stringify({ enabled: !!eq.enabled, bands: eq.bands?.length || 0, separatePerOutput: !!eq.perDevice, outputsWithTheirOwn: Object.keys(eq.profiles || {}).length }));
  } catch { add('Equalizer', 'defaults'); }
  try {
    const pb = require('./player')._playback();
    add('Playback now', `${pb.state}, ${pb.output}, exclusive buffer ${pb.exclusiveBuffer}, filters ${pb.filters.length ? pb.filters.join(' ') : 'none'}${pb.why ? ` (not bit-perfect: ${pb.why})` : ''}, ${pb.underrunsThisSession} under-runs since start`);
  } catch { /* player not loaded */ }
  try { const snd = require('./player')._sound(); const sc = require('./soundChain'); add('Sound', sc.soundSummary(snd.soundState, { exclusive: false }).join(', ') || 'nothing on'); if (snd.clipShown) add('Clipping', 'yes, right now'); } catch { /* player not loaded */ }
  for (const [name, file, keys] of [['Covers', 'cover-settings.json', ['search', 'autoSave', 'saveTo', 'order', 'disabled']], ['Artist pictures', 'artist-picture-settings.json', ['search', 'autoSave', 'order', 'disabled']], ['Discord', 'discord-settings.json', ['enabled', 'showPaused', 'onlineCover', 'showButton']]]) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), file), 'utf8'));
      add(name, JSON.stringify(Object.fromEntries(keys.filter(k => k in s).map(k => [k, s[k]]))));
    } catch { add(name, 'defaults'); }
  }
  // the lyrics options in use (defaults filled in), so Word by word shows even when never changed
  try { const o = require('./lyrics').options(); add('Lyrics', JSON.stringify({ search: o.search, wordByWord: o.wordByWord, autoSave: o.autoSave, saveTo: o.saveTo, order: o.order, disabled: o.disabled })); } catch { add('Lyrics', 'defaults'); }
  // what the online searches gave this session: which source answered, which failed and why (no song names)
  try { const r = require('./lyrics').sessionReport(); add('Lyrics since start', `${r.searches} automatic searches, taken: ${r.picked}, nothing found ${r.nothing}; not reached: ${r.errors}`); } catch { /* not loaded */ }
  try { const r = require('./coverSearch').sessionReport(); add('Cover searches since start', `${r.searches}, good match from: ${r.good}, none ${r.nothing}; not reached: ${r.errors}`); } catch { /* not loaded */ }
  try { const r = require('./artistImages').sessionReport(); add('Artist picture searches since start', `${r.searches}, good match from: ${r.good}, none ${r.nothing}; not reached: ${r.errors}`); } catch { /* not loaded */ }
  try { const d = require('./discord').report(); add('Discord now', `${d.status}, showing ${d.showing}${d.basic ? ', basic (Discord refused the full status)' : ''}${d.noPictures ? ', without pictures' : ''}${d.lastSentAt ? `, last sent ${new Date(d.lastSentAt).toISOString()}` : ''}`); } catch { /* not loaded */ }
  // Windows media controls, media keys and the sleep timer
  try {
    const m = require('./media')._media();
    add('Media controls', `${m.helperOk ? 'in Windows' : 'helper not running'}, media keys ${m.keysHeld ? 'held by TeleCloud' : 'not held'}${m.sleep ? ', sleep timer set' : ''}`);
  } catch { /* not loaded */ }
  try { const f = require('./floatingLyrics').status(); add('Floating lyrics', `${f.open ? 'open' : 'closed'}${f.locked ? ', locked' : ''}`); } catch { /* not loaded */ }
  try { add('Waveforms kept', fs.readdirSync(path.join(app.getPath('userData'), 'waveforms')).length); } catch { add('Waveforms kept', 0); }
  // playlists: how many, how many are smart and which rules they use (no names)
  try {
    const pls = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'playlists.json'), 'utf8'));
    const smart = pls.filter(p => p && p.smart);
    const fields = [...new Set(smart.flatMap(p => (p.smart.rules || []).map(r => r.field)))];
    add('Playlists', `${pls.length} (${smart.length} smart${fields.length ? `: rules on ${fields.join(', ')}` : ''}), ${pls.reduce((s, p) => s + (p?.songs?.length || 0), 0)} tracks in the others`);
  } catch { add('Playlists', 'none'); }
  // the play history behind Most played, On this day and the Dashboard
  try {
    const d = require('./stats').db();
    const all = d.prepare('SELECT COUNT(*) n, MIN(played_at) first FROM plays').get();
    const month = d.prepare('SELECT COUNT(*) n FROM plays WHERE played_at >= ?').get(Date.now() - 30 * 86400000).n;
    add('Play history', `${all.n.toLocaleString('en')} plays${all.first ? ` since ${new Date(all.first).toISOString().slice(0, 7)}` : ''}, ${month} in the last 30 days`);
  } catch { add('Play history', 'unreadable'); }
  try {
    const store = require('./telecloud/store');
    add('TeleCloud storages', store.storages.all().length);
  } catch { /* not set up */ }
  try {
    const tc = await Promise.race([require('./telecloud/service').logStatus(), new Promise(r => setTimeout(() => r(null), 5000))]);
    if (tc) add('TeleCloud', `${tc.signIn}${tc.unusedSignInKeptDays ? ` (Telegram ends unused sign-ins after ${tc.unusedSignInKeptDays} days)` : ''}, encryption ${tc.encryption}${tc.hasKey ? '' : ', no key on this computer'}, backups: ${tc.backups}, index ${tc.index}, cache ${tc.cache}`);
  } catch (err) { add('TeleCloud', `not read: ${err.message}`); }
  try {
    const u = require('./updater').status();
    add('Updates', `${u.state}${u.next ? ` (${u.next})` : ''}${u.percent != null && u.state === 'downloading' ? ` ${u.percent}%` : ''}${u.checkedAt ? `, last checked ${new Date(u.checkedAt).toISOString()}` : ''}${u.error ? `: ${u.error}` : ''}`);
  } catch { /* not loaded */ }
  try {
    const ud = app.getPath('userData');
    const size = (f) => { try { return fs.statSync(path.join(ud, f)).size; } catch { return 0; } };
    const dirSize = (d) => { try { return fs.readdirSync(path.join(ud, d)).reduce((n, f) => { try { return n + fs.statSync(path.join(ud, d, f)).size; } catch { return n; } }, 0); } catch { return 0; } };
    const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
    add('Data on disk', `library ${mb(size('music-library.db') + size('music-library.db-wal'))}, covers ${mb(dirSize('cover-cache'))}, artist pictures ${mb(dirSize('artist-images'))}, waveforms ${mb(dirSize('waveforms'))}, logs ${mb(dirSize('logs'))}`);
  } catch { /* not readable */ }
  lines.push('');
  // audio outputs, as mpv sees them: their names help with DAC problems (no music in them)
  try {
    const devices = await Promise.race([require('./player').listDevices(), new Promise(r => setTimeout(() => r(null), 5000))]);
    add('Audio outputs', devices ? devices.map(d => d.name || d.description || d.id).join(' | ') : 'not listed in time');
  } catch (err) { add('Audio outputs', `not listed: ${err.message}`); }
  try {
    const rows = require('./database').getAllFiles();
    add('MQA', `${rows.filter(r => r.mqa > 0).length} tracks (${rows.filter(r => r.mqa === 2).length} MQA Studio), ${rows.filter(r => r.mqa == null).length} not checked yet`);
  } catch { /* no library */ }
  try {
    const l = require('./lastfm').status();
    add('Last.fm', l.user ? `connected, scrobbling ${l.scrobble ? 'on' : 'off'}, ${l.pending} waiting` : (l.available ? 'not connected' : 'no app key in this build'));
  } catch { /* not loaded */ }
  try {
    const lb = require('./listenbrainz').status(); // never the token or the user name
    add('ListenBrainz', lb.user ? `connected, sending ${lb.scrobble ? 'on' : 'off'}${lb.refused ? ', token refused' : ''}, ${lb.pending} waiting, last sent ${lb.lastSend ? new Date(lb.lastSend).toISOString() : 'not this session'}${lb.lastError ? `, last error: ${lb.lastError}` : ''}, MusicBrainz IDs: ${lb.ids.tags || 0} from tags, ${lb.ids.search || 0} found, ${lb.ids.none || 0} without` : 'not connected');
  } catch { /* not loaded */ }
  // the remote: on or off, how many devices and which browsers (no addresses, names or keys)
  try {
    const remote = require('./remote');
    const r = remote.status();
    add('Remote', `${r.enabled ? 'on' : 'off'}${r.running ? ', running' : ''}, ${r.devices.length} paired (${r.devices.filter(d => d.readOnly).length} view only), keep awake ${r.keepAwake ? 'on' : 'off'}, ${r.addresses.length} network addresses (${r.addresses.filter(a => a.virtual).length} virtual)`);
    if (r.devices.length) add('Remote devices', r.devices.map(d => `${d.label}${d.online ? ' (connected)' : ''}`).join(' | '));
    const nets = await Promise.race([remote.networkProfile(), new Promise(res => setTimeout(() => res([]), 8000))]);
    if (nets.length) add('Networks', nets.map(n => n.category).join(', '));
  } catch { /* not loaded */ }
  return logger.redact(`${lines.join('\n')}\n`);
}

async function buildZip({ days, from, to, includeNames }) {
  logger.flush();
  const end = to ? new Date(`${to}T23:59:59.999`).getTime() : Date.now();
  const start = typeof days === 'number' ? Date.now() - days * 86400000 : new Date(`${from}T00:00:00`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error(tx('Choose a start date before the end date'));
  const hide = includeNames ? (l) => l : nameHider();
  // redacted when written, redacted again here: this is the last check before it leaves the app
  const clean = (l) => hide(logger.redact(l));
  const entries = [];
  let lines = 0;
  let first = null;
  let last = null;
  for (const name of logger.listFiles()) {
    const dayStart = new Date(`${name.slice(0, 10)}T00:00:00`).getTime();
    if (dayStart + 86400000 + 86400000 < start || dayStart - 86400000 > end) continue;
    const text = await fs.promises.readFile(path.join(logger.logDir(), name), 'utf8').catch(() => '');
    const part = await logBetween(text, start, end, clean);
    if (!part.count) continue;
    entries.push({ name: `logs/${name}`, text: part.text });
    lines += part.count;
    first = first === null ? part.first : Math.min(first, part.first);
    last = last === null ? part.last : Math.max(last, part.last);
    await new Promise(setImmediate);
  }
  const system = await systemReport({ days, includeNames });
  entries.unshift({ name: 'system.txt', text: system });
  const oldest = logger.listFiles()[0]?.slice(0, 10) || null;
  const missingBefore = oldest && new Date(`${oldest}T00:00:00`).getTime() > start ? oldest : null;
  return { data: await zip(entries), lines, first, last, missingBefore };
}

let lastExport = null;

// The theme lives in the window, so the window reports it. Only checked values reach the log.
let appearance = null;
ipcMain.handle('logs:appearance', (e, a = {}) => {
  const theme = /^[a-z]{1,20}$/.test(a.theme) ? a.theme : 'unknown';
  const next = { theme, followCover: !!a.followCover, reduceMotion: !!a.reduceMotion, waveSeek: a.waveSeek !== false, sidePanel: a.sidePanel !== false, coverAnimation: /^(webgl|none|off)$/.test(a.coverAnimation) ? a.coverAnimation : 'unknown' };
  if (appearance && JSON.stringify(appearance) === JSON.stringify(next)) return;
  appearance = next;
  console.log(`[Appearance] Theme: ${theme}, follow the cover: ${next.followCover ? 'on' : 'off'}, reduce motion: ${next.reduceMotion ? 'on' : 'off'}, cover animation: ${next.coverAnimation === 'webgl' ? 'WebGL' : next.coverAnimation === 'none' ? 'no WebGL, covers just change' : 'off'}, waveform seek bar: ${next.waveSeek ? 'on' : 'off'}, side panel: ${next.sidePanel ? 'shown' : 'put away'}`);
});
ipcMain.handle('logs:eq-output', (e, a = {}) => {
  console.log(`[EQ] Output changed: ${a.shared ? 'using the shared EQ' : a.known ? "using this output's own EQ" : 'first time on this output, keeping the current EQ'}`);
});

ipcMain.handle('logs:info', () => {
  logger.flush();
  const files = logger.listFiles();
  let bytes = 0;
  files.forEach(n => { try { bytes += fs.statSync(path.join(logger.logDir(), n)).size; } catch { /* gone */ } });
  return { bytes, oldest: files[0]?.slice(0, 10) || null, days: files.length, verbose: logger.isVerbose(), keepDays: logger.KEEP_DAYS };
});

ipcMain.handle('logs:export', async (e, opts = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    const stampName = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: tx('Save the log'),
      defaultPath: path.join(app.getPath('downloads'), `TeleCloud-log-${stampName}.zip`),
      filters: [{ name: tx('Zip archive'), extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return { success: false, canceled: true };
    const built = await buildZip(opts);
    await fs.promises.writeFile(r.filePath, built.data);
    lastExport = r.filePath;
    return { success: true, path: r.filePath, bytes: built.data.length, lines: built.lines, missingBefore: built.missingBefore };
  } catch (err) {
    console.error('[Log] Export failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('logs:reveal', () => { if (lastExport) shell.showItemInFolder(lastExport); });
ipcMain.handle('logs:set-verbose', (e, v) => { logger.setVerbose(v); return logger.isVerbose(); });
ipcMain.handle('logs:clear', () => {
  logger.flush();
  for (const n of logger.listFiles()) { try { fs.rmSync(path.join(logger.logDir(), n)); } catch { /* still in use */ } }
  console.log('[Log] Logs cleared by the user');
  return { success: true };
});

module.exports = { buildZip, zip, nameFinder, _systemReport: systemReport };

