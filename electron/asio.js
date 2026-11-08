// Native DSD through ASIO: talks to native/asio/tc-asio.exe, one JSON object per line.
// It only ever plays DSD files natively; everything else stays with mpv.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const TEST_DRIVER = 'TeleCloud test output';
const exePath = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'tc-asio.exe')
  : path.join(__dirname, '..', 'native', 'asio', 'bin', 'tc-asio.exe'));

const events = new EventEmitter();
let proc = null;
let ready = null;
let lineBuf = '';
const waiting = []; // { ev, match, resolve, timer }
const probes = new Map(); // driver -> result, for this session

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const i = waiting.findIndex(w => w.ev === msg.ev && (!w.match || w.match(msg)));
  if (i >= 0) { const w = waiting.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg); }
  events.emit(msg.ev, msg);
}

function start() {
  if (ready) return ready;
  if (!fs.existsSync(exePath())) return Promise.reject(new Error('The ASIO helper is missing'));
  ready = new Promise((resolve, reject) => {
    proc = spawn(exePath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      lineBuf += d;
      let n;
      while ((n = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, n).trim(); lineBuf = lineBuf.slice(n + 1); if (line) onLine(line); }
    });
    proc.on('error', (err) => { ready = null; proc = null; reject(err); });
    proc.on('exit', (code) => {
      ready = null;
      proc = null;
      if (code) events.emit('error', { ev: 'error', msg: `The ASIO helper stopped (${code})` });
    });
    expect('ready', null, 5000).then(resolve, reject);
  });
  return ready;
}

function expect(ev, match, ms = 8000) {
  return new Promise((resolve, reject) => {
    const w = { ev, match, resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(new Error(`ASIO helper: no ${ev}`)); }, ms) };
    waiting.push(w);
  });
}
async function send(cmd) {
  await start();
  proc.stdin.write(`${JSON.stringify(cmd)}\n`);
}

/** The ASIO drivers on this computer (and the test output when tests ask for it) */
async function list() {
  const r = send({ cmd: 'list' }).then(() => expect('drivers'));
  const names = (await r).names || [];
  return process.env.TC_ASIO_TEST_OUT ? [...names, TEST_DRIVER] : names;
}

/** What a driver can do with DSD. Opening a driver takes it for a moment, so this is asked once. */
async function probe(driver, { fresh = false } = {}) {
  if (!fresh && probes.has(driver)) return probes.get(driver);
  await send({ cmd: 'probe', driver });
  const r = await expect('probe', m => m.driver === driver, 15000);
  if (r.ok) probes.set(driver, r);
  return r;
}

/** Start a DSD file; resolves when the device runs, or rejects with the reason */
async function play(info) {
  await send({ cmd: 'play', ...info });
  const r = await Promise.race([expect('started', m => m.id === info.id, 15000), expect('error', null, 15000).then(e => { throw new Error(e.msg); })]);
  return r;
}
const queue = async (info) => { await send({ cmd: 'queue', ...info }); return expect('queued', m => m.id === info.id, 3000); };
const pause = () => send({ cmd: 'pause' });
const resume = () => send({ cmd: 'resume' });
const seek = (sec) => send({ cmd: 'seek', sec });
async function stop() {
  if (!proc) return;
  await send({ cmd: 'stop' });
  await expect('stopped', null, 5000).catch(() => {});
}
function quit() { if (proc) { try { proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* gone */ } } }

const available = () => fs.existsSync(exePath());
/** The output Windows uses by default: "{0.0.0.00000000}.{guid}", or '' */
async function defaultOutput() {
  await send({ cmd: 'default' });
  return (await expect('default', null, 3000)).id || '';
}

module.exports = { events, list, probe, play, queue, pause, resume, seek, stop, quit, available, defaultOutput, TEST_DRIVER };
