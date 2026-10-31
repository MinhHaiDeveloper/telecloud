// Small pool of tag-reading worker threads. If workers can't start (unusual packaging, etc.)
// parsing falls back to the main process so scans still work, just less smoothly.

const os = require('os');
const path = require('path');
const { parseTrack } = require('./tags');

let Worker = null;
try { ({ Worker } = require('worker_threads')); } catch { Worker = null; }

const POOL_SIZE = Math.max(1, Math.min(3, (os.cpus()?.length || 2) - 1));
const IDLE_MS = 30000;

let workers = [];
let disabled = !Worker;
let nextId = 0;
let rr = 0;
const waiting = new Map(); // id -> { resolve, reject, worker }
let idleTimer = null;

function spawn() {
  const w = new Worker(path.join(__dirname, 'tagWorker.js'));
  w.unref();
  w.on('message', ({ id, results }) => {
    const job = waiting.get(id);
    if (!job) return;
    waiting.delete(id);
    job.resolve(results);
  });
  w.on('error', (err) => {
    console.error('[TagPool] worker failed:', err.message);
    workers = workers.filter(x => x !== w);
    for (const [id, job] of waiting) {
      if (job.worker === w) { waiting.delete(id); job.reject(err); }
    }
    if (!workers.length) disabled = true;
  });
  return w;
}

function ensure() {
  if (disabled) return false;
  try {
    while (workers.length < POOL_SIZE) workers.push(spawn());
    return true;
  } catch (err) {
    console.error('[TagPool] cannot start workers, parsing in-process:', err.message);
    disabled = true;
    return false;
  }
}

// Stop the threads after a quiet period; they come back on the next scan
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (waiting.size) return;
    workers.forEach(w => w.terminate());
    workers = [];
  }, IDLE_MS);
}

async function parseInProcess(jobs) {
  const out = [];
  for (const j of jobs) out.push(await parseTrack(j.path, { mtimeMs: j.mtimeMs, size: j.size }));
  return out;
}

/** jobs: [{ path, mtimeMs, size }] → parsed rows in the same order */
async function parseMany(jobs) {
  if (!jobs.length) return [];
  if (!ensure()) return parseInProcess(jobs);
  const worker = workers[rr++ % workers.length];
  const id = ++nextId;
  try {
    return await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, worker });
      worker.postMessage({ id, jobs });
    });
  } catch {
    return parseInProcess(jobs);
  } finally {
    scheduleIdle();
  }
}

const size = () => (disabled ? 1 : POOL_SIZE);

module.exports = { parseMany, size };
