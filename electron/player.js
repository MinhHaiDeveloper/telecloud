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

let lastOutLogged = '';
const OUTPUT_NOT_READY = /audio output initiali[sz]ation failed|could not open\/initiali[sz]e audio device/i;
let outputRetry = { path: null, tries: 0 };
const RETRY_EVERY = 500;
const RETRY_TRIES = 12; // about 6 s

/** Load the track playing again from where it was, once the output may be back */
function retryOutput() {
  if (outputRetry.path !== currentPath) outputRetry = { path: currentPath, tries: 0 };
  if (outputRetry.tries >= RETRY_TRIES) return false;
  outputRetry.tries++;
  if (outputRetry.tries === 1) console.warn('[Player] The output did not open yet (a DAC switching back from ASIO takes about a second): trying again');
  const file = currentPath;
  const at = Math.max(0, lastTimeSent);
  const queued = nextPath;
  setTimeout(async () => {
    if (currentPath !== file || native) return;
    try {
      currentEntryId = await loadFile(file, 'replace', at > 0 ? `start=${at.toFixed(3)}` : '');
      nextEntryId = null;
      nextPath = null;
      if (queued) { nextEntryId = await loadFile(queued, 'append'); nextPath = queued; }
      tellDsd();
    } catch (err) { send('playback-error', { error: err.message }); }
  }, RETRY_EVERY);
  return true;
}

/** Wait until a WASAPI output is listed again (it vanishes while a DAC leaves ASIO) */
function waitForOutput(id, ms = 4000) {
  if (!id || id === '-1') return Promise.resolve(true);
  const guid = (/\{[0-9a-f-]{36}\}/i.exec(id) || [''])[0].toLowerCase();
  const started = Date.now();
  return new Promise((resolve) => {
    const look = () => execFile(mpvPath, ['--no-config', '--audio-device=help'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      if (String(out || '').toLowerCase().includes(guid)) {
        const took = Date.now() - started;
        if (took > 200) console.log(`[Player] The output came back after ${took} ms`);
        resolve(true);
      } else if (Date.now() - started > ms) resolve(false);
      else setTimeout(look, 200);
    });
    look();
  });
}
let currentPath = null;        // file of the entry that is playing
let duration = 0;
let muted = false;
let xfade = null;               // crossfade in progress for the current track

// Filter chain bookkeeping: what mpv's "af" holds, so EQ edits can be sent as live commands
let eqState = null;
let appliedChain = null;

let mpvDevices = [];
let currentDevice = '-1';
let currentAudioSettings = { replayGain: 'no', crossfade: 0, maxBitDepth: null, maxSampleRate: null, dsdMode: 'pcm', dopMax: 512, asioDriver: '' };

// ---------- DSD: DoP where it can be bit-perfect, PCM everywhere else
const mqaEntries = new Set();  // mpv playlist entries of MQA tracks sent untouched
const entryPlans = new Map();  // mpv playlist entry -> { path, dop, rate, reason, verified }
const refused = new Set();     // "device|rate" a DAC didn't take as DoP this session
let chainWaiting = false;      // a filter change that waited for DoP to end
const DSD_FILE = /\.(dsf|dff)$/i;
const REASONS = {
  setting: 'DSD playback is set to PCM',
  shared: 'DoP needs WASAPI Exclusive',
  eq: 'the EQ is on',
  balance: 'channel balance is on',
  crossfeed: 'crossfeed is on',
  limit: 'above the output limit',
  max: 'above the highest DSD rate set for DoP',
  refused: 'the DAC refused DoP at this rate',
  cloud: 'not on this computer yet',
  format: 'not plain DSD',
};

// ---------- native DSD through ASIO (asio.js). Tried first when chosen; DoP, then PCM, if it can't.
const asio = require('./asio');
let native = null;        // { id, path, rate, channels, driver, paused, pos, queued: { id, path } }
let nativeIds = 0;
let releasingMpv = false; // mpv is being closed so the DAC is free for ASIO: not a stop the window should see
const nativeInfo = (info, id, file) => ({ id, path: file, kind: info.kind, rate: info.rate, channels: info.channels, dataStart: info.dataStart, blockSize: info.blockSize || 0, bytes: Math.ceil(info.samples / 8), lsbFirst: info.lsbFirst });

/** Can this file go out as native DSD? { ok, info } or { ok: false, why } */
async function nativePlan(filePath, { mayRelease = false } = {}) {
  const s = currentAudioSettings;
  if (!s.asioDriver) return { ok: false, why: 'no ASIO driver chosen' };
  if (!asio.available()) return { ok: false, why: 'the ASIO helper is missing' };
  if (dspWhy()) return { ok: false, why: REASONS[dspWhy()] };
  if (/^https?:/i.test(filePath) || !fs.existsSync(filePath)) return { ok: false, why: 'not on this computer yet' };
  const info = require('./dsd').probe(filePath);
  if (!info) return { ok: false, why: 'not plain DSD' };
  let p = await asio.probe(s.asioDriver).catch(err => ({ ok: false, msg: err.message }));
  // the DAC may be held by mpv in exclusive mode: when a new track starts anyway, free it and ask again
  if (!p.ok && mayRelease && proc) { await releaseMpv(); p = await asio.probe(s.asioDriver).catch(err => ({ ok: false, msg: err.message })); }
  if (!p.ok) return { ok: false, why: `${s.asioDriver}: ${p.msg || 'did not open'}` };
  if (!p.dsd) return { ok: false, why: `${s.asioDriver} doesn't take DSD` };
  if (!p.rates.includes(info.rate)) return { ok: false, why: `${s.asioDriver} doesn't take DSD${info.rate / 44100} natively` };
  if (p.outputs < info.channels) return { ok: false, why: `${s.asioDriver} has fewer outputs than the file's channels` };
  return { ok: true, info };
}

/** mpv holds the DAC in exclusive mode: close it so the ASIO driver can have the device */
async function releaseMpv() {
  if (!proc) return;
  releasingMpv = true;
  const gone = new Promise(r => proc.once('exit', r));
  command(['quit']).catch(() => {});
  await Promise.race([gone, new Promise(r => setTimeout(r, 3000))]);
  if (proc) { try { proc.kill(); } catch { /* gone */ } }
  releasingMpv = false;
}

async function startNative(filePath, plan, startSec = 0, paused = false) {
  await releaseMpv();
  const id = ++nativeIds;
  native = { id, path: filePath, rate: plan.info.rate, channels: plan.info.channels, driver: currentAudioSettings.asioDriver, paused, pos: startSec, queued: null, starting: true };
  currentEntryId = `asio:${id}`;
  currentPath = filePath;
  entryPlans.set(currentEntryId, { path: filePath, native: true, rate: plan.info.rate, driver: native.driver, reason: null, verified: true });
  try {
    await asio.play({ driver: native.driver, start: startSec, ...nativeInfo(plan.info, id, filePath) });
  } catch (err) {
    console.warn(`[Player] Native DSD failed: ${err.message}`);
    const at = native ? native.pos : startSec;
    native = null;
    return { failed: err.message, at };
  }
  native.starting = false;
  if (paused) await asio.pause();
  send('player:audio-out', { format: 'dsd', samplerate: plan.info.rate, channels: plan.info.channels });
  console.log(`[Player] Output: native DSD ${plan.info.rate} Hz ${plan.info.channels} ch through ASIO`);
  return { ok: true };
}

/** Leave native DSD and carry on through mpv from the same moment (DoP if it can, else PCM) */
async function nativeToMpv(why) {
  if (!native) return;
  const { path: file, pos, paused } = native;
  const queued = native.queued?.path || nextPath;
  native = null;
  await asio.stop().catch(() => {});
  console.warn(`[Player] Native DSD stopped: ${why}. Carrying on through mpv.`);
  await waitForOutput(currentDevice);
  await startMpv();
  const plan = await dsdPlan(file, { skipNative: true, nativeWhy: why });
  currentEntryId = await loadFile(file, 'replace', `start=${pos.toFixed(3)}${paused ? ',pause=yes' : ''}`, plan);
  currentPath = file;
  nextEntryId = null;
  nextPath = null;
  if (queued) { nextEntryId = await loadFile(queued, 'append'); nextPath = queued; }
  tellDsd();
  send('player:dsd-notice', `Native DSD stopped (${why}). Playing on through ${plan?.dop ? 'DoP' : 'PCM'}.`);
}

asio.events.on('pos', (m) => {
  if (!native || native.paused) return;
  native.pos = m.sec - (m.id === native.id ? 0 : 0);
  send('time-pos', Math.round(m.sec * 10) / 10);
});
asio.events.on('advanced', (m) => {
  if (!native?.queued || m.id !== native.queued.id) return;
  native.id = m.id;
  native.path = native.queued.path;
  native.queued = null;
  currentEntryId = `asio:${m.id}`;
  currentPath = native.path;
  entryPlans.set(currentEntryId, { path: native.path, native: true, rate: native.rate, driver: native.driver, verified: true });
  nextPath = null;
  send('player:advanced', { path: native.path });
  tellDsd();
});
asio.events.on('ended', (m) => {
  if (!native || m.id !== native.id) return;
  console.log('[Player] Native DSD: end of track');
  send('track-ended');
});
// while starting, a failure is handled where play was asked; afterwards the track moves to mpv
asio.events.on('error', (m) => { if (native && !native.starting) nativeToMpv(m.msg || 'the ASIO driver failed'); });
/** How a DSD file will play, and why */
async function dsdPlan(filePath, { skipNative = false, nativeWhy = null, mayRelease = false } = {}) {
  const s = currentAudioSettings;
  let why = nativeWhy;
  if (s.dsdMode === 'native' && !skipNative) {
    const n = await nativePlan(filePath, { mayRelease });
    if (n.ok) return { native: true, info: n.info, rate: n.info.rate };
    why = n.why;
  }
  const plan = await dopPlan(filePath, s);
  if (why) plan.nativeWhy = why;
  return plan;
}

async function dopPlan(filePath, s) {
  if (!['dop', 'native'].includes(s.dsdMode)) return { dop: false, reason: 'setting' };
  if (!currentDevice || currentDevice === '-1') return { dop: false, reason: 'shared' };
  if (dspWhy()) return { dop: false, reason: dspWhy() };
  if (/^https?:/i.test(filePath) || !fs.existsSync(filePath)) return { dop: false, reason: 'cloud' };
  const src = await require('./dsd').dopSource(filePath).catch(() => null);
  if (!src) return { dop: false, reason: 'format' };
  if (s.dopMax && src.dsdRate > s.dopMax * 44100) return { dop: false, reason: 'max', rate: src.rate };
  if (s.maxSampleRate && src.rate > s.maxSampleRate * 1000) return { dop: false, reason: 'limit', rate: src.rate };
  if (refused.has(`${currentDevice}|${src.rate}`)) return { dop: false, reason: 'refused', rate: src.rate };
  return { dop: true, rate: src.rate, src };
}
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

/**
 * DSD can't reach the DAC as DSD from here: mpv turns it into PCM at 1/8 of the DSD rate, 2822.4 kHz
 * for DSD512, as floating point, and the device then settles on whatever it can. That uneven result
 * (384 kHz from 705.6 kHz) is where DACs went silent. Ask for 352.8 kHz, an even step down from every
 * DSD rate, as whole numbers, or the highest rate of that family under the output limit.
 */
function dsdOptions(filePath) {
  if (!/\.(dsf|dff)$/i.test(filePath || '')) return '';
  const cap = currentAudioSettings.maxSampleRate ? currentAudioSettings.maxSampleRate * 1000 : Infinity;
  const rate = [352800, 176400, 88200, 44100].find(r => r <= cap) || 44100;
  const format = currentAudioSettings.maxBitDepth === 16 ? 's16' : 's32';
  return `audio-samplerate=${rate},audio-format=${format}`;
}

/** loadfile and return the playlist entry id of the new item. */
async function loadFile(filePath, mode, extra, given) {
  let plan = given !== undefined ? given : DSD_FILE.test(filePath || '') ? await dsdPlan(filePath, { skipNative: true }) : null;
  if (plan?.native) plan = await dsdPlan(filePath, { skipNative: true }); // mpv can't play native DSD
  // A gapless join at the same rate and channels keeps the device open as it was: it already took this
  // rate, so there is nothing to check and nothing to mute. The start of anything else waits, silent.
  const playing = entryPlans.get(currentEntryId);
  const proven = !!(plan?.dop && mode === 'append' && playing?.dop && playing.rate === plan.rate
    && playing.channels === plan.src.channels && playing.device === currentDevice);
  // DoP: no filters at all, and silent until the device is known to take the exact rate
  // MQA sent to an MQA DAC: the hidden layer only survives untouched samples, so no filters and no ReplayGain
  let untouched = false;
  if (!plan && !/^https?:/i.test(filePath || '')) {
    const mqa = require('./mqa');
    const check = mqa.checkTrack(filePath).catch(() => null); // once per track; the first look takes ~0.2 s
    if (currentAudioSettings.mqaMode === 'decoder') {
      await Promise.race([check, new Promise(r => setTimeout(r, 2000))]);
      untouched = !!mqa.mqaOfPath(filePath);
    }
  }
  const options = (plan?.dop ? [extra, plan.src.options, 'af=', proven ? '' : 'mute=yes'] : [extra, dsdOptions(filePath), untouched ? 'af=,replaygain=no' : '']).filter(Boolean).join(',');
  const target = plan?.dop ? plan.src.url : filePath;
  const args = options ? ['loadfile', target, mode, -1, options] : ['loadfile', target, mode];
  let res;
  try {
    res = await command(args);
  } catch (err) {
    if (!plan?.dop) throw err;
    console.warn(`[Player] DoP could not be opened (${err.message}): playing as PCM`);
    return loadFile(filePath, mode, extra, { dop: false, reason: 'format' });
  }
  let id = res && res.playlist_entry_id;
  if (!id) {
    const count = await getProp('playlist-count');
    id = await getProp(`playlist/${mode === 'append' ? count - 1 : 0}/id`);
  }
  if (untouched) {
    mqaEntries.add(id);
    if (mqaEntries.size > 20) mqaEntries.delete(mqaEntries.values().next().value);
    console.log('[Player] MQA: sent untouched for an MQA DAC (no filters, no ReplayGain)');
  }
  if (plan) {
    entryPlans.set(id, { path: filePath, dop: plan.dop, rate: plan.rate, channels: plan.src?.channels, device: currentDevice, reason: plan.reason || null, nativeWhy: plan.nativeWhy || null, verified: false, joined: proven });
    if (entryPlans.size > 20) entryPlans.delete(entryPlans.keys().next().value);
  }
  return id;
}

/** Tell the window how the DSD file now playing reaches the DAC */
function tellDsd() {
  const p = entryPlans.get(currentEntryId);
  if (p) {
    const how = p.native ? `native through ASIO (${p.driver}) at ${p.rate} Hz` : p.dop ? `DoP at ${p.rate} Hz${p.joined ? ', joined without a gap' : ''}` : `PCM (${REASONS[p.reason] || p.reason})`;
    console.log(`[Player] DSD: ${how}${p.nativeWhy ? `; native DSD not used: ${p.nativeWhy}` : ''}`);
  }
  send('player:dsd', p ? { path: p.path, mode: p.native ? 'native' : p.dop ? 'dop' : 'pcm', rate: p.rate || null, driver: p.driver || null, reason: p.reason ? REASONS[p.reason] : null, nativeWhy: p.nativeWhy || null } : { path: currentPath, mode: null });
  if (p?.dop) watchDop(currentEntryId);
}

/** Unmute DoP once mpv opened the device at exactly the DoP rate, as whole numbers; otherwise go to PCM */
function judgeDop(params) {
  const p = entryPlans.get(currentEntryId);
  if (!p?.dop || !params?.samplerate) return;
  const fine = params.samplerate === p.rate && /^s(24|32)/.test(String(params.format));
  if (fine && p.verified) return;
  if (fine) {
    p.verified = true;
    console.log(`[Player] DoP accepted: ${params.format} ${params.samplerate} Hz`);
    if (!muted) setProp('mute', false).catch(() => {});
  } else {
    refused.add(`${currentDevice}|${p.rate}`);
    console.warn(`[Player] DoP refused: asked ${p.rate} Hz, the device opened ${params.format} ${params.samplerate} Hz. Playing as PCM.`);
    fallbackToPcm('refused');
  }
}
/** The same format between two DoP tracks sends no new event: ask, and give up safely after a while */
function watchDop(entry) {
  const started = Date.now();
  const tick = async () => {
    const p = entryPlans.get(entry);
    if (entry !== currentEntryId || !p || p.verified) return;
    const r = await getProp('audio-out-params').catch(() => null);
    const params = r?.data ?? r;
    if (params?.samplerate) { judgeDop(params); return; }
    if (Date.now() - started > 5000) { console.warn('[Player] DoP: the device did not open, playing as PCM'); fallbackToPcm('refused'); return; }
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}

let falling = false;
/** Leave DoP for this track and carry on as PCM from the same moment */
async function fallbackToPcm(reason) {
  const p = entryPlans.get(currentEntryId);
  if (!p?.dop || falling) return;
  falling = true;
  try {
    const r = await getProp('time-pos').catch(() => null);
    const pos = Math.max(0, Number(r?.data ?? r) || 0);
    const paused = !!((await getProp('pause').catch(() => null))?.data);
    const queued = nextPath;
    p.dop = false; // so its leftovers are judged no more
    const saved = currentAudioSettings.dsdMode;
    currentAudioSettings.dsdMode = reason === 'refused' ? saved : 'pcm-once';
    currentEntryId = await loadFile(p.path, 'replace', `start=${pos.toFixed(3)}${paused ? ',pause=yes' : ''}`);
    currentAudioSettings.dsdMode = saved;
    const plan = entryPlans.get(currentEntryId);
    if (plan && reason !== 'refused') plan.reason = reason;
    nextEntryId = null;
    nextPath = null;
    if (queued) { nextEntryId = await loadFile(queued, 'append'); nextPath = queued; }
    tellDsd();
    if (reason === 'refused') send('player:dsd-notice', `Your DAC didn't take DoP at ${(p.rate / 1000).toFixed(1)} kHz, so this plays as PCM.`);
    if (chainWaiting) { chainWaiting = false; appliedChain = null; scheduleChain(); }
  } finally { falling = false; }
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
      if (msg.name === 'audio-device-list') {
        devicesMayHaveChanged();
      } else if (msg.name === 'time-pos' && typeof msg.data === 'number') {
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
        // what really goes to the device: the first thing to look at when a DAC stays silent
        const out = `${msg.data.format} ${msg.data.samplerate} Hz ${msg.data['channel-count']} ch`;
        const plan = entryPlans.get(currentEntryId);
        if (out !== lastOutLogged) console.log(`[Player] Output: ${out}${plan ? (plan.dop ? ' (DoP)' : ' (DSD converted to PCM)') : ''}`);
        lastOutLogged = out;
        outputRetry = { path: currentPath, tries: 0 };
        judgeDop(msg.data);
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
        tellDsd();
        if (chainWaiting && !entryPlans.get(currentEntryId)?.dop && !mqaEntries.has(currentEntryId)) { chainWaiting = false; appliedChain = null; scheduleChain(); }
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
      // The output didn't open. After ASIO lets go of a DAC, its WASAPI output is gone for about a
      // second while the driver switches back to PCM: wait and try the same track again.
      if (msg.reason === 'error' && msg.playlist_entry_id === currentEntryId && OUTPUT_NOT_READY.test(msg.file_error || '')) {
        if (retryOutput()) break;
      }
      // a DoP file that failed before its device was checked: it goes on as PCM, never as an error
      if (msg.reason === 'error' && msg.playlist_entry_id === currentEntryId && entryPlans.get(currentEntryId)?.dop && !entryPlans.get(currentEntryId).verified) {
        const p = entryPlans.get(currentEntryId);
        refused.add(`${currentDevice}|${p.rate}`); // remembered, so the same rate isn't tried again and again
        console.warn('[Player] DoP failed to start: playing as PCM');
        fallbackToPcm('refused');
        break;
      }
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
  // tests only: a forced output rate stands in for a DAC that won't take a DoP rate
  if (process.env.TELECLOUD_MPV_TEST_RATE) args.push(`--audio-samplerate=${Number(process.env.TELECLOUD_MPV_TEST_RATE)}`);

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
    if (!releasingMpv && !native) send('player:state', { paused: true, stopped: true });
  });

  readyPromise = connect().then(async () => {
    await command(['request_log_messages', 'warn']).catch(() => {});
    await command(['observe_property', 1, 'time-pos']);
    await command(['observe_property', 2, 'pause']);
    await command(['observe_property', 3, 'audio-out-params']);
    await command(['observe_property', 4, 'duration']);
    await command(['observe_property', 5, 'audio-device-list']);
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

// Headphone crossfeed (Bauer stereo-to-binaural): Jan Meier's setting blends least, the bs2b default most
const CROSSFEED = { light: 'jmeier', medium: 'cmoy', strong: 'default' };
/** What changes the samples, as a REASONS key: DoP, native DSD and MQA need none of it */
function dspWhy() {
  if (normalizeEq(eqState)) return 'eq';
  if (currentAudioSettings.balance) return 'balance';
  if (CROSSFEED[currentAudioSettings.crossfeed]) return 'crossfeed';
  return null;
}
/** Left and right gains for a balance in dB: the louder side stays at 1, so nothing can clip */
function balanceGains(db) {
  return { left: db > 0 ? 10 ** (-db / 20) : 1, right: db < 0 ? 10 ** (db / 20) : 1 };
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
  const bal = currentAudioSettings.balance || 0;
  const xfeed = CROSSFEED[currentAudioSettings.crossfeed];
  // both work on two channels: mono plays on both sides, as it would anyway
  if (bal || xfeed) parts.push('@stereo:lavfi=[aformat=channel_layouts=stereo]');
  if (bal) {
    const g = balanceGains(bal);
    parts.push(`@bal:lavfi=[pan=stereo|c0=${g.left.toFixed(6)}*c0|c1=${g.right.toFixed(6)}*c1]`);
  }
  if (xfeed) parts.push(`@xfeed:lavfi=[bs2b=profile=${xfeed}]`);
  if (crossfadeSlot) parts.push('@xf:lavfi=[volume=volume=1]');
  if (extra) parts.push(extra);
  const cap = capFilter(currentAudioSettings);
  if (cap) parts.push(`@fmt:lavfi=[${cap}]`);
  return { af: parts.join(','), eq, key: JSON.stringify([eq && eq.bands.map(b => b.kind), bal, xfeed, crossfadeSlot, cap]) };
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
  // an MQA track sent untouched keeps no filters: the change waits for the next track
  if (mqaEntries.has(currentEntryId)) { chainWaiting = true; return; }
  if (entryPlans.get(currentEntryId)?.dop) {
    // filters can't work on DoP: turning one on moves this track to PCM; anything else waits for the next track
    const why = dspWhy();
    if (why) { chainWaiting = true; await fallbackToPcm(why); return; }
    chainWaiting = true;
    return;
  }
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
  if (!mqaEntries.has(currentEntryId)) await setProp('replaygain', gainMode());
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
  if (mqaEntries.has(currentEntryId) || mqaEntries.has(nextEntryId)) return; // a fade would change MQA's bits
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

// Windows registers Bluetooth audio under BTHENUM (classic), BTHHFENUM (hands-free) or BTHLE (LE Audio):
// their output's GUID is the key of a Render entry whose values name one of those.
const RENDER_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render';
function parseBluetoothOutputs(text) {
  const ids = new Set();
  let key = null;
  for (const line of String(text).split(/\r?\n/)) {
    const k = /\\Render\\(\{[0-9a-f-]+\})/i.exec(line);
    if (/^HKEY_/i.test(line)) { key = k ? k[1].toLowerCase() : null; continue; }
    if (key && /BTH(ENUM|HFENUM|LE)/i.test(line)) ids.add(key);
  }
  return ids;
}
let bluetoothOutputs = new Set();
const refreshBluetooth = () => new Promise((resolve) => {
  execFile('reg', ['query', RENDER_KEY, '/s', '/f', 'BTH', '/d'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
    if (!err || stdout) bluetoothOutputs = parseBluetoothOutputs(stdout);
    resolve(bluetoothOutputs);
  });
});
const guidOf = (id) => (/\{[0-9a-f-]{36}\}\s*$/i.exec(String(id || '')) || [''])[0].toLowerCase();

/** The output in use: its name, and whether it is Bluetooth. "System default" asks Windows which that is. */
async function outputInfo() {
  if (!bluetoothOutputs.size) await refreshBluetooth();
  let id = currentDevice;
  if (!id || id === '-1') id = await asio.defaultOutput().catch(() => '');
  const guid = guidOf(id);
  const dev = mpvDevices.find(d => guidOf(d.id) === guid);
  return { name: dev ? dev.name.replace(/ \(WASAPI\)$/, '') : '', bluetooth: !!guid && bluetoothOutputs.has(guid), viaDefault: !currentDevice || currentDevice === '-1' };
}
let lastOutput = null;
async function tellOutput() {
  const info = await outputInfo().catch(() => null);
  if (!info) return;
  if (JSON.stringify(info) !== JSON.stringify(lastOutput)) console.log(`[Player] Output device: ${info.name || 'unknown'}${info.viaDefault ? ' (Windows default)' : ''}${info.bluetooth ? ', Bluetooth' : ''}`);
  lastOutput = info;
  send('player:output', info);
}
ipcMain.handle('player:output', () => outputInfo());

// Native DSD holds the DAC: Windows hides its output while the driver has it and for a moment after.
const DAC_HOLD_MS = 8000;
let deviceTimer = null;
let lastDevices = '';
const listDevices = () => new Promise((resolve) => {
  execFile(mpvPath, ['--no-config', '--audio-device=help'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
    if (err && !stdout) { console.error('[Player] device list failed', err.message); resolve(mpvDevices); return; }
    const now = [];
    for (const line of String(stdout).split('\n')) {
      const m = line.match(/^\s*'([^']+)'\s+\((.+)\)/);
      if (m && m[1].startsWith('wasapi/')) now.push({ id: m[1], name: `${m[2]} (WASAPI)` });
    }
    // the DAC in the driver's hands has not left
    const at = mpvDevices.findIndex(d => d.id === currentDevice);
    const held = at >= 0 && !now.some(d => d.id === currentDevice) && (!!native || Date.now() - asio.stoppedAt() < DAC_HOLD_MS);
    if (held) {
      now.splice(Math.min(at, now.length), 0, mpvDevices[at]);
      if (!native) { clearTimeout(deviceTimer); deviceTimer = setTimeout(publishDevices, DAC_HOLD_MS + 500); }
    }
    mpvDevices = now;
    refreshBluetooth().then(() => {
      mpvDevices.forEach((d) => { d.bluetooth = bluetoothOutputs.has(guidOf(d.id)); });
      resolve(mpvDevices);
    });
  });
});
async function publishDevices() {
  const list = await listDevices();
  const now = JSON.stringify(list);
  if (now === lastDevices) return;
  lastDevices = now;
  console.log(`[Player] Outputs now: ${list.map(d => d.name.replace(/ \(WASAPI\)$/, '')).join(', ') || 'none'}`);
  send('player:devices', list);
}
/** mpv saw an output come or go. Windows announces one change several times: look once it settles. */
function devicesMayHaveChanged() {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(publishDevices, 3000);
}
ipcMain.handle('get-audio-devices', () => listDevices());

ipcMain.handle('play-audio', async (event, { filePath, deviceId, startPaused } = {}) => {
  console.log(`[Player] Play ${filePath}`);
  checkPlayable(filePath);
  if (deviceId !== undefined && String(deviceId) !== currentDevice) await setDeviceInternal(String(deviceId)).catch(() => {});
  const plan = DSD_FILE.test(filePath) ? await dsdPlan(filePath, { mayRelease: true }) : null;
  nextEntryId = null;
  nextPath = null;
  lastTimeSent = -1;
  duration = 0;
  if (plan?.native) {
    cancelCrossfade();
    const r = await startNative(filePath, plan, 0, !!startPaused);
    if (r.ok) { tellDsd(); return { success: true }; }
    // the driver didn't play it: through mpv, and say why
    await asio.stop().catch(() => {});
    await waitForOutput(currentDevice);
    const fallback = await dsdPlan(filePath, { skipNative: true, nativeWhy: r.failed });
    await startMpv();
    currentEntryId = await loadFile(filePath, 'replace', '', fallback);
    currentPath = filePath;
    await setProp('pause', !!startPaused);
    tellDsd();
    send('player:dsd-notice', `Native DSD didn't start (${r.failed}). Playing through ${fallback.dop ? 'DoP' : 'PCM'}.`);
    return { success: true };
  }
  if (native) { native = null; await asio.stop().catch(() => {}); await waitForOutput(currentDevice); } // give the DAC back to mpv
  await startMpv();
  if (deviceId !== undefined && String(deviceId) !== currentDevice) await setDeviceInternal(String(deviceId));
  cancelCrossfade();
  // loadfile with "replace" starts this track and drops anything queued
  currentEntryId = await loadFile(filePath, 'replace', '', plan);
  currentPath = filePath;
  await setProp('pause', !!startPaused);
  tellDsd();
  tellOutput();
  if (chainWaiting && !entryPlans.get(currentEntryId)?.dop && !mqaEntries.has(currentEntryId)) { chainWaiting = false; appliedChain = null; scheduleChain(); }
  return { success: true };
});

// Queue the following track inside mpv so it starts with no gap
ipcMain.handle('player:set-next', async (event, filePath) => {
  if (native) {
    // native DSD: another DSD file at the same rate joins without a gap; anything else starts after it ends
    nextPath = filePath || null;
    native.queued = null;
    if (!filePath || !DSD_FILE.test(filePath)) return { success: true };
    const plan = await dsdPlan(filePath);
    if (plan?.native && plan.info.rate === native.rate && plan.info.channels === native.channels) {
      const id = ++nativeIds;
      const r = await asio.queue(nativeInfo(plan.info, id, filePath)).catch(() => ({ refused: true }));
      if (!r.refused) native.queued = { id, path: filePath };
    }
    return { success: true };
  }
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
    const plan = DSD_FILE.test(filePath) ? await dsdPlan(filePath) : null;
    nextPath = filePath;
    if (plan?.native) return { success: true }; // ASIO takes over when this one ends
    nextEntryId = await loadFile(filePath, 'append', '', plan);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pause-audio', async (event, paused) => {
  if (native) {
    native.paused = !!paused;
    await (paused ? asio.pause() : asio.resume());
    send('player:state', { paused: !!paused });
    return;
  }
  if (!(await live())) return;
  if (paused) cancelCrossfade();
  await setProp('pause', !!paused);
});

ipcMain.handle('seek-audio', async (event, timePos) => {
  if (native) { native.pos = num(timePos, 0, 86400); native.queued = null; await asio.seek(native.pos); return; }
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
  if (native) { await (muted ? asio.pause() : native.paused ? null : asio.resume()); return muted; } // DSD silence while muted
  if (await live()) await setProp('mute', muted).catch(() => {});
  return muted;
});

ipcMain.handle('stop-audio', async () => {
  cancelCrossfade();
  if (native) { native = null; await asio.stop().catch(() => {}); }
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
  if (deviceId === '-1' && entryPlans.get(currentEntryId)?.dop) await fallbackToPcm('shared');
  tellOutput();
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
  if (native) { if (normalizeEq(eqState)) await nativeToMpv('the EQ is on'); return; }
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
    dsdMode: ['dop', 'native'].includes(settings?.dsdMode) ? settings.dsdMode : 'pcm',
    asioDriver: typeof settings?.asioDriver === 'string' ? settings.asioDriver.slice(0, 200) : '',
    dopMax: [64, 128, 256, 512].includes(settings?.dopMax) ? settings.dopMax : 512,
    balance: Math.round(num(settings?.balance, -12, 12) * 2) / 2,
    crossfeed: CROSSFEED[settings?.crossfeed] ? settings.crossfeed : 'off',
    mqaMode: settings?.mqaMode === 'decoder' ? 'decoder' : 'plain',
  };
  logGain();
  if (!currentAudioSettings.crossfade) cancelCrossfade();
  if (sock) await applyAudioSettingsToMpv().catch(err => console.error('[Player] settings rejected:', err.message));
  // native DSD can't take filters either: what plays now moves to mpv, as when the EQ is turned on
  if (native && dspWhy()) await nativeToMpv(REASONS[dspWhy()]).catch(() => {});
}

ipcMain.handle('get-audio-settings', () => currentAudioSettings);
ipcMain.handle('player:replaygain-auto', async (event, mode) => {
  autoGainMode = mode === 'album' ? 'album' : 'track';
  logGain();
  if (sock && currentAudioSettings.replayGain === 'auto' && !mqaEntries.has(currentEntryId)) await setProp('replaygain', autoGainMode).catch(() => {});
  return autoGainMode;
});
// exact playback position (the 'time-pos' event is throttled to ~4/s) — used to sync lyrics by hand
ipcMain.handle('player:position', async () => {
  if (native) return native.pos; try { const t = await getProp('time-pos'); return typeof t?.data === 'number' ? t.data : (typeof t === 'number' ? t : null); } catch { return null; } });

app.on('before-quit', () => {
  asio.quit();
  cancelCrossfade();
  try { proc?.kill(); } catch { /* ignore */ }
});

module.exports = { applyAudioSettings, buildEqFilter, capFilter, chainSpec, mpvPath, getProp, setStreamPrefix, parseBluetoothOutputs,
  // tests only: feed a message as if mpv sent it, and see what is playing
  _mpvMessage: (msg) => handleMessage(msg), _playing: () => ({ entry: currentEntryId, path: currentPath, refused: [...refused] }) };
