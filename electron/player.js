// Audio engine: one long-lived mpv process driven over its JSON IPC pipe.
// Keeping mpv alive gives instant track changes, true gapless playback (the next track is
// queued inside mpv) and lets us read the real output format for the signal path.

const { ipcMain, BrowserWindow, app } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { assertPlayable } = require('./paths');

// TeleCloud streams: only URLs of our own local stream server (secret token in the prefix)
let streamPrefix = null;
const setStreamPrefix = (prefix) => { streamPrefix = prefix || null; };
const checkPlayable = (p) => (streamPrefix && typeof p === 'string' && p.startsWith(streamPrefix) && /^[0-9a-z-]+$/.test(p.slice(streamPrefix.length)) ? p : assertPlayable(p));

const mpvPath = app.isPackaged
  ? path.join(process.resourcesPath, 'mpv.exe')
  : path.join(__dirname, '..', 'mpv.exe');

let proc = null;
let sock = null;
let pipeName = '';
let readyPromise = null;
let requestId = 0;
const pending = new Map();      // request_id -> { resolve, reject }
let lineBuffer = '';

// Playback bookkeeping
let currentEntryId = null;      // mpv playlist entry of the track we asked to play
let nextEntryId = null;         // entry queued for gapless continuation
let nextPath = null;
let lastTimeSent = -1;
let lastTimeAt = 0;

let currentPath = null;        // file of the entry that is playing
let duration = 0;
let muted = false;
let xfade = null;               // crossfade in progress for the current track

// Filter chain bookkeeping: what mpv's "af" holds, so EQ edits can be sent as live commands
let eqState = null;
let appliedChain = null;

let mpvDevices = [];
let currentDevice = '-1';
let currentAudioSettings = { replayGain: 'no', crossfade: 0, maxBitDepth: null, maxSampleRate: null };
// Lines that repeat every time mpv opens the output and say nothing is wrong: the first is about an
// option we set on purpose; the others are the exclusive device being reopened, which takes a few
// tries when switching output. If it really can't be opened, mpv's "no sound" error is still logged.
let lastDeviceBusy = 0;
function isMpvNoise(text) {
  if (/audio-stream-silence option is set|^Retrying in \d+/.test(text)) return true;
  if (!/AUDCLNT_E_DEVICE_IN_USE/.test(text)) return false;
  const now = Date.now();
  const repeat = now - lastDeviceBusy < 2000;
  lastDeviceBusy = now;
  return repeat;
}
let lastGainLogged = 'no';
function logGain() {
  const m = currentAudioSettings.replayGain;
  const now = m === 'auto' ? `auto, ${autoGainMode} gain now` : m;
  if (now !== lastGainLogged) console.log(`[Player] ReplayGain: ${now}`);
  lastGainLogged = now;
}
let autoGainMode = 'track'; // what ReplayGain "auto" means for the track playing now
const gainMode = () => {
  const m = currentAudioSettings.replayGain;
  if (m === 'auto') return autoGainMode;
  return ['track', 'album'].includes(m) ? m : 'no';
};

const send = (channel, payload) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// ---------- process / IPC plumbing ----------

function command(args) {
  return new Promise((resolve, reject) => {
    if (!sock || sock.destroyed) { reject(new Error('Player not running')); return; }
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ command: args, request_id: id }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`mpv timeout: ${args[0]}`)); }
    }, 8000);
  });
}

const setProp = (name, value) => command(['set_property', name, value]);
const getProp = (name) => command(['get_property', name]);

/** loadfile and return the playlist entry id of the new item. */
async function loadFile(filePath, mode, options) {
  const args = options ? ['loadfile', filePath, mode, -1, options] : ['loadfile', filePath, mode];
  const res = await command(args);
  if (res && res.playlist_entry_id) return res.playlist_entry_id;
  const count = await getProp('playlist-count');
  return getProp(`playlist/${mode === 'append' ? count - 1 : 0}/id`);
}

function handleMessage(msg) {
  if (msg.request_id && pending.has(msg.request_id)) {
    const { resolve, reject } = pending.get(msg.request_id);
    pending.delete(msg.request_id);
    if (msg.error === 'success') resolve(msg.data); else reject(new Error(msg.error));
    return;
  }

  switch (msg.event) {
    case 'property-change':
      if (msg.name === 'time-pos' && typeof msg.data === 'number') {
        maybeCrossfade(msg.data);
        // ~4 updates per second is plenty for the seek bar and synced lyrics
        const now = Date.now();
        if (now - lastTimeAt >= 250 || Math.abs(msg.data - lastTimeSent) >= 1) {
          lastTimeAt = now;
          lastTimeSent = msg.data;
          send('time-pos', Math.round(msg.data * 10) / 10);
        }
      } else if (msg.name === 'duration') {
        duration = typeof msg.data === 'number' ? msg.data : 0;
      } else if (msg.name === 'pause') {
        send('player:state', { paused: !!msg.data });
      } else if (msg.name === 'audio-out-params' && msg.data) {
        send('player:audio-out', {
          format: msg.data.format, samplerate: msg.data.samplerate, channels: msg.data['channel-count'],
        });
      }
      break;

    case 'start-file':
      // mpv moved on to the queued track by itself: gapless advance
      if (nextEntryId && msg.playlist_entry_id === nextEntryId) {
        currentEntryId = nextEntryId;
        const advancedTo = nextPath;
        currentPath = nextPath;
        duration = 0;
        if (xfade && !xfade.ramping) cancelCrossfade();
        nextEntryId = null;
        nextPath = null;
        command(['playlist-remove', 0]).catch(() => {});
        send('player:advanced', { path: advancedTo });
      }
      break;

    case 'file-loaded':
      // A new file can rebuild the filters from the "af" string; re-send live EQ values
      resyncLiveEq();
      break;

    case 'log-message':
      // mpv's own warnings and errors, for the log file only
      if (!isMpvNoise(String(msg.text || ''))) console.warn(`[mpv] ${msg.prefix}: ${String(msg.text || '').trim()}`);
      break;

    case 'end-file':
      if (nextEntryId && msg.playlist_entry_id === nextEntryId && msg.reason === 'error') {
        // The preloaded track can't be opened; let the current one finish and report it then
        nextEntryId = null;
        nextPath = null;
        break;
      }
      if (msg.playlist_entry_id !== currentEntryId) break;
      if (msg.reason === 'error') {
        console.warn(`[Player] Could not play (${msg.file_error || 'unknown error'})`);
        send('playback-error', { error: msg.file_error || 'Could not play this file' });
      } else if (msg.reason === 'eof' && !nextEntryId) {
        send('track-ended');
      }
      break;

    default:
      break;
  }
}

function connect(retries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const s = net.createConnection(pipeName);
      s.once('connect', () => {
        sock = s;
        s.setEncoding('utf8');
        s.on('data', (chunk) => {
          // Messages are newline-delimited; a chunk can hold half a line
          lineBuffer += chunk;
          let nl;
          while ((nl = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, nl);
            lineBuffer = lineBuffer.slice(nl + 1);
            if (!line) continue;
            try { handleMessage(JSON.parse(line)); } catch { /* ignore malformed */ }
          }
        });
        s.on('close', () => { if (sock === s) sock = null; });
        resolve();
      });
      s.once('error', () => {
        if (left > 0 && proc) setTimeout(() => attempt(left - 1), 100);
        else reject(new Error('Could not connect to mpv'));
      });
    };
    attempt(retries);
  });
}

function startMpv() {
  if (readyPromise) return readyPromise;
  if (!fs.existsSync(mpvPath)) return Promise.reject(new Error(`mpv not found at ${mpvPath}`));

  pipeName = `\\\\.\\pipe\\telecloud-mpv-${process.pid}-${Date.now()}`;
  lineBuffer = '';
  const args = [
    '--idle=yes',
    '--no-config',
    '--no-video',
    '--no-terminal',
    '--ytdl=no',
    '--load-scripts=no',
    `--input-ipc-server=${pipeName}`,
    // weak: gapless only between tracks with the same format; otherwise reopen the device at the
    // new format ("yes" keeps the first track's format and resamples everything after it)
    '--gapless-audio=weak',
    '--prefetch-playlist=yes',
    '--keep-open=no',
    '--initial-audio-sync=no',
    '--audio-stream-silence=yes',
    '--cache=yes',
    '--demuxer-readahead-secs=20',
    '--demuxer-max-bytes=64MiB',
    '--demuxer-max-back-bytes=16MiB',
    '--volume-max=100',
  ];
  // automated tests: play to a silent output instead of the real device
  if (process.env.TELECLOUD_MPV_AO) args.push(`--ao=${process.env.TELECLOUD_MPV_AO}`);

  proc = spawn(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  proc.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
  proc.on('exit', (code) => {
    // no exit code means it was stopped from outside, as on every normal quit: not an error
    if (code) console.error(`[Player] mpv exited (${code})`, stderrTail.slice(-400));
    else console.log('[Player] mpv stopped');
    proc = null;
    sock = null;
    readyPromise = null;
    currentEntryId = null;
    nextEntryId = null;
    appliedChain = null;
    cancelCrossfade();
    pending.forEach(p => p.reject(new Error('mpv exited')));
    pending.clear();
    send('player:state', { paused: true, stopped: true });
  });

  readyPromise = connect().then(async () => {
    await command(['request_log_messages', 'warn']).catch(() => {});
    await command(['observe_property', 1, 'time-pos']);
    await command(['observe_property', 2, 'pause']);
    await command(['observe_property', 3, 'audio-out-params']);
    await command(['observe_property', 4, 'duration']);
    appliedChain = null;
    await applyDevice(currentDevice);
    await applyAudioSettingsToMpv();
    if (muted) await setProp('mute', true);
  }).catch(err => {
    readyPromise = null;
    try { proc?.kill(); } catch { /* already gone */ }
    throw err;
  });
  return readyPromise;
}

// ---------- validation helpers ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, lo, hi, def = 0) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : def);

/** Validated EQ settings (from the renderer) as numbers mpv can take; null when off. */
function normalizeEq(eq) {
  if (!eq || !eq.enabled || !Array.isArray(eq.bands)) return null;
  const bands = eq.bands.slice(0, 64).map((b) => ({
    kind: b.type === 'HSF' ? 'highshelf' : b.type === 'LSF' ? 'lowshelf' : 'equalizer',
    f: Number(num(b.freq, 10, 24000, 1000).toFixed(1)),
    w: Number(num(b.q, 0.05, 20, 1).toFixed(3)),
    g: Number(num(b.gain, -30, 30).toFixed(2)),
  }));
  return { preamp: Number(num(eq.preamp, -30, 30).toFixed(2)), bands };
}

const STANDARD_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000];

/** Output cap as an aformat filter: it only converts when the source is above the cap. */
function capFilter(s) {
  const opts = [];
  if (s.maxBitDepth === 16) opts.push('sample_fmts=s16|s16p');
  else if (s.maxBitDepth === 24) opts.push('sample_fmts=s16|s16p|s32|s32p'); // 24-bit PCM travels in 32-bit words
  if (s.maxSampleRate) {
    const rates = STANDARD_RATES.filter(r => r <= s.maxSampleRate * 1000);
    if (rates.length) opts.push(`sample_rates=${rates.join('|')}`);
  }
  return opts.length ? `aformat=${opts.join(':')}` : '';
}

/**
 * The whole audio filter chain. Every EQ band gets its own labelled filter (gain 0 included)
 * so later edits can be sent with af-command instead of rebuilding the chain, which would
 * click. Built from numbers only, never from a raw string out of the renderer.
 */
function chainSpec({ crossfadeSlot = currentAudioSettings.crossfade > 0, extra = '' } = {}) {
  const eq = normalizeEq(eqState);
  const parts = [];
  if (eq) {
    parts.push(`@pre:lavfi=[volume=volume=${eq.preamp}dB]`);
    eq.bands.forEach((b, i) => parts.push(`@b${i}:lavfi=[${b.kind}=f=${b.f}:width_type=q:w=${b.w}:g=${b.g}]`));
  }
  if (crossfadeSlot) parts.push('@xf:lavfi=[volume=volume=1]');
  if (extra) parts.push(extra);
  const cap = capFilter(currentAudioSettings);
  if (cap) parts.push(`@fmt:lavfi=[${cap}]`);
  return { af: parts.join(','), eq, key: JSON.stringify([eq && eq.bands.map(b => b.kind), crossfadeSlot, cap]) };
}

/** EQ part only (used by tests and the spectrum preview). */
function buildEqFilter(eq) {
  const n = normalizeEq(eq);
  if (!n) return '';
  const parts = n.preamp !== 0 ? [`volume=volume=${n.preamp.toFixed(2)}dB`] : [];
  for (const b of n.bands) if (b.g !== 0) parts.push(`${b.kind}=f=${b.f.toFixed(1)}:width_type=q:w=${b.w.toFixed(3)}:g=${b.g.toFixed(2)}`);
  return parts.length ? `lavfi=[${parts.join(',')}]` : '';
}

function liveCommands(from, to) {
  const cmds = [];
  if (from.preamp !== to.preamp) cmds.push(['af-command', 'pre', 'volume', `${to.preamp}dB`, 'volume']);
  to.bands.forEach((b, i) => {
    const o = from.bands[i];
    for (const k of ['f', 'w', 'g']) if (o[k] !== b[k]) cmds.push(['af-command', `b${i}`, k, String(b[k]), b.kind]);
  });
  return cmds;
}

/** Push the current chain to mpv: live commands when only values changed, else a rebuild. */
async function applyChain() {
  if (!sock) return;
  const spec = chainSpec();
  const live = appliedChain && (appliedChain.live || appliedChain.eq);
  if (appliedChain && appliedChain.key === spec.key && spec.eq && live && currentEntryId) {
    try {
      for (const c of liveCommands(live, spec.eq)) await command(c);
      appliedChain = { ...appliedChain, live: spec.eq };
      return;
    } catch { /* filters not running (e.g. between files): rebuild below */ }
  }
  if (appliedChain && appliedChain.af === spec.af && !appliedChain.live) return;
  await setProp('af', spec.af);
  appliedChain = spec;
}

// One chain update at a time; edits that arrive meanwhile are folded into the next run, so a
// fast drag can't interleave old and new values
let chainRun = null;
let chainDirty = false;
function scheduleChain() {
  if (chainRun) { chainDirty = true; return chainRun; }
  chainRun = (async () => {
    do {
      chainDirty = false;
      await applyChain().catch(err => console.error('[Player] filter chain rejected:', err.message));
    } while (chainDirty);
  })().finally(() => { chainRun = null; });
  return chainRun;
}

/** mpv rebuilds filters from the "af" string on some file changes; send the live values again. */
async function resyncLiveEq() {
  if (!appliedChain || !appliedChain.live || !appliedChain.eq) return;
  for (const c of liveCommands(appliedChain.eq, appliedChain.live)) await command(c).catch(() => {});
}

async function applyDevice(deviceId) {
  const exclusive = !!deviceId && deviceId !== '-1';
  await setProp('audio-exclusive', exclusive);
  await setProp('audio-device', exclusive ? deviceId : 'auto');
  if (exclusive) await setProp('volume', 100); // never scale samples in exclusive mode
  if (currentEntryId) await command(['ao-reload']).catch(() => {});
}

async function applyAudioSettingsToMpv() {
  const s = currentAudioSettings;
  await setProp('replaygain', gainMode());
  await scheduleChain();
}

// ---------- crossfade ----------
// mpv plays one file at a time, so the outgoing track's last seconds are played by a short-lived
// second mpv that fades out, while the main player moves on to the queued track and fades in.
// Exclusive mode owns the device and can't mix two streams, so crossfade only runs in shared mode.

const XF_LEAD = 0.4; // seconds the tail player gets to open the device
let xfadeTried = null;

function maybeCrossfade(t) {
  const X = currentAudioSettings.crossfade;
  if (!X || xfade || muted || !nextEntryId || !currentPath || currentDevice !== '-1' || xfadeTried === currentEntryId) return;
  if (!(duration > X * 2 + 1) || t < duration - X - XF_LEAD) return;
  startCrossfade(t, X).catch(err => { console.error('[Player] crossfade failed:', err.message); cancelCrossfade(); });
}

async function startCrossfade(t, X) {
  xfadeTried = currentEntryId; // one attempt per track; on failure it simply plays gapless
  const startAt = t + XF_LEAD;
  const outgoing = currentPath;
  const state = { tail: null, ramp: null, ramping: false, entry: currentEntryId };
  xfade = state;
  const volume = await getProp('volume').catch(() => 100);
  const replaygain = gainMode();
  if (xfade !== state) return;
  const fade = `@fade:lavfi=[afade=t=out:st=${startAt.toFixed(3)}:d=${X}]`;
  const tail = spawn(mpvPath, [
    '--no-config', '--no-video', '--no-input-terminal', '--msg-level=all=error,cplayer=info', '--term-status-msg=',
    `--start=${startAt.toFixed(3)}`, `--volume=${volume}`, `--replaygain=${replaygain}`,
    `--af=${chainSpec({ crossfadeSlot: false, extra: fade }).af}`, '--audio-device=auto', '--', outgoing,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  state.tail = tail;
  tail.on('exit', () => { if (state.tail === tail) state.tail = null; });

  // Hand over once the tail player has opened the device (it prints "AO: ...")
  const opened = await new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => resolve(false), 1500);
    tail.stdout.on('data', (d) => {
      out += d;
      if (/^AO:/m.test(out)) { clearTimeout(timer); resolve(true); }
    });
    tail.on('exit', () => { clearTimeout(timer); resolve(false); });
  });
  if (xfade !== state || !opened || state.entry !== currentEntryId || !nextEntryId) {
    if (xfade === state) cancelCrossfade();
    return;
  }
  await command(['af-command', 'xf', 'volume', '0', 'volume']);
  state.ramping = true;
  await command(['playlist-next', 'force']);
  const t0 = Date.now();
  state.ramp = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / (X * 1000));
    // equal-power curve keeps the sum of both tracks at a steady loudness
    command(['af-command', 'xf', 'volume', Math.sin(k * Math.PI / 2).toFixed(4), 'volume']).catch(() => {});
    if (k >= 1) {
      clearInterval(state.ramp);
      state.ramp = null;
      state.ramping = false;
      if (xfade === state) xfade = null;
    }
  }, 50);
}

/** Stop a crossfade (seek, pause, new track): kill the tail and put the main volume back. */
function cancelCrossfade() {
  const state = xfade;
  if (!state) return;
  xfade = null;
  if (state.ramp) clearInterval(state.ramp);
  if (state.tail) { try { state.tail.kill(); } catch { /* gone */ } }
  if (state.ramping && sock) command(['af-command', 'xf', 'volume', '1', 'volume']).catch(() => {});
}

// ---------- IPC ----------

/** True once mpv is reachable; waits through a start/restart instead of dropping the command. */
async function live() {
  if (!sock && readyPromise) await readyPromise.catch(() => {});
  return !!sock;
}

ipcMain.handle('get-audio-devices', () => new Promise((resolve) => {
  execFile(mpvPath, ['--no-config', '--audio-device=help'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
    if (err && !stdout) { console.error('[Player] device list failed', err.message); resolve(mpvDevices); return; }
    mpvDevices = [];
    for (const line of String(stdout).split('\n')) {
      const m = line.match(/^\s*'([^']+)'\s+\((.+)\)/);
      if (m && m[1].startsWith('wasapi/')) mpvDevices.push({ id: m[1], name: `${m[2]} (WASAPI)` });
    }
    resolve(mpvDevices);
  });
}));

ipcMain.handle('play-audio', async (event, { filePath, deviceId, startPaused } = {}) => {
  console.log(`[Player] Play ${filePath}`);
  checkPlayable(filePath);
  await startMpv();
  if (deviceId !== undefined && String(deviceId) !== currentDevice) await setDeviceInternal(String(deviceId));
  cancelCrossfade();
  nextEntryId = null;
  nextPath = null;
  lastTimeSent = -1;
  duration = 0;
  // loadfile with "replace" starts this track and drops anything queued
  currentEntryId = await loadFile(filePath, 'replace');
  currentPath = filePath;
  await setProp('pause', !!startPaused);
  return { success: true };
});

// Queue the following track inside mpv so it starts with no gap
ipcMain.handle('player:set-next', async (event, filePath) => {
  if (!(await live())) return { success: false, error: 'Player not running' };
  try {
    if (nextEntryId) {
      const count = await getProp('playlist-count');
      if (count > 1) await command(['playlist-remove', count - 1]);
      nextEntryId = null;
      nextPath = null;
    }
    if (!filePath) return { success: true };
    checkPlayable(filePath);
    nextEntryId = await loadFile(filePath, 'append');
    nextPath = filePath;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pause-audio', async (event, paused) => {
  if (!(await live())) return;
  if (paused) cancelCrossfade();
  await setProp('pause', !!paused);
});

ipcMain.handle('seek-audio', async (event, timePos) => {
  if (!(await live())) return;
  cancelCrossfade();
  await command(['seek', num(timePos, 0, 86400), 'absolute', 'exact']).catch(() => {});
});

ipcMain.handle('set-volume', async (event, vol) => {
  if (!(await live()) || (currentDevice && currentDevice !== '-1')) return;
  await setProp('volume', num(vol, 0, 100, 100));
});

// Mute is a separate switch, so it also works in exclusive mode where volume is locked
ipcMain.handle('set-mute', async (event, on) => {
  muted = !!on;
  if (muted) cancelCrossfade();
  if (await live()) await setProp('mute', muted).catch(() => {});
  return muted;
});

ipcMain.handle('stop-audio', async () => {
  cancelCrossfade();
  currentEntryId = null;
  currentPath = null;
  nextEntryId = null;
  nextPath = null;
  if (await live()) await command(['stop']).catch(() => {});
  return { success: true };
});

async function setDeviceInternal(deviceId) {
  if (deviceId !== '-1' && !mpvDevices.some(d => d.id === deviceId)) throw new Error('Unknown audio device');
  currentDevice = deviceId;
  if (sock) await applyDevice(deviceId);
}

ipcMain.handle('set-audio-device', async (event, deviceId) => {
  try {
    await setDeviceInternal(String(deviceId));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('set-eq', async (event, eq) => {
  eqState = eq && typeof eq === 'object' ? { enabled: !!eq.enabled, preamp: eq.preamp, bands: Array.isArray(eq.bands) ? eq.bands : [] } : null;
  if (!sock) await startMpv().catch(() => {});
  if (!sock) return;
  await scheduleChain();
});

// Apply audio settings (called from settings view)
async function applyAudioSettings(settings) {
  currentAudioSettings = {
    replayGain: ['track', 'album', 'auto'].includes(settings?.replayGain) ? settings.replayGain : 'no',
    crossfade: num(settings?.crossfade, 0, 15),
    maxBitDepth: [16, 24, 32].includes(settings?.maxBitDepth) ? settings.maxBitDepth : null,
    maxSampleRate: settings?.maxSampleRate ? num(settings.maxSampleRate, 8, 768) : null,
  };
  logGain();
  if (!currentAudioSettings.crossfade) cancelCrossfade();
  if (sock) await applyAudioSettingsToMpv().catch(err => console.error('[Player] settings rejected:', err.message));
}

ipcMain.handle('get-audio-settings', () => currentAudioSettings);
ipcMain.handle('player:replaygain-auto', async (event, mode) => {
  autoGainMode = mode === 'album' ? 'album' : 'track';
  logGain();
  if (sock && currentAudioSettings.replayGain === 'auto') await setProp('replaygain', autoGainMode).catch(() => {});
  return autoGainMode;
});
// exact playback position (the 'time-pos' event is throttled to ~4/s) — used to sync lyrics by hand
ipcMain.handle('player:position', async () => { try { const t = await getProp('time-pos'); return typeof t?.data === 'number' ? t.data : (typeof t === 'number' ? t : null); } catch { return null; } });

app.on('before-quit', () => {
  cancelCrossfade();
  try { proc?.kill(); } catch { /* ignore */ }
});

module.exports = { applyAudioSettings, buildEqFilter, capFilter, chainSpec, mpvPath, getProp, setStreamPrefix };
