// Main-process side of the TeleCloud worker: starts it on first use, sends calls, relays events.
// If the worker dies, the next call starts a fresh one.

const path = require('path');
const { EventEmitter } = require('events');
const logger = require('../logger');

const events = new EventEmitter();
let child = null;
let seq = 0;
const pending = new Map();
let inProcess = null;

function start() {
  if (process.env.TELECLOUD_IN_PROCESS) {
    // tests: same process, no Electron needed
    const { createWorker } = require('./worker');
    inProcess = createWorker((event, data) => events.emit(event, data));
    return;
  }
  const { utilityProcess } = require('electron');
  child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { serviceName: 'TeleCloud', stdio: 'pipe' });
  // the Telegram library is chatty: its normal output only with detailed logging on
  child.stdout?.on('data', logger.stream('DEBUG', 'telecloud'));
  child.stderr?.on('data', logger.stream('WARN', 'telecloud'));
  child.on('message', (msg) => {
    if (msg && msg.event) { events.emit(msg.event, msg.data); return; }
    const p = msg && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) {
      const err = new Error(msg.error);
      if (msg.floodWait) err.floodWait = msg.floodWait;
      p.reject(err);
    } else p.resolve(msg.result);
  });
  child.on('exit', (code) => {
    if (code) logger.write('WARN', 'telecloud', `Worker stopped (exit ${code})`);
    child = null;
    for (const p of pending.values()) p.reject(new Error('TeleCloud worker stopped'));
    pending.clear();
    events.emit('exit');
  });
}

async function call(method, params = {}) {
  if (!child && !inProcess) start();
  if (inProcess) {
    const r = await inProcess({ id: ++seq, method, params });
    if (r.error) { const err = new Error(r.error); if (r.floodWait) err.floodWait = r.floodWait; throw err; }
    return r.result;
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.postMessage({ id, method, params });
  });
}

function stop() {
  if (child) { try { child.kill(); } catch { /* gone */ } }
  child = null;
  inProcess = null;
}

const isRunning = () => !!(child || inProcess);

module.exports = { call, events, stop, isRunning };
