// The word-timing utility process: started for one job, gone when it ends, so the models' memory goes with it.
// Messages in: { type: 'run', job } and { type: 'cancel' }. Out: { type: 'progress' | 'done' | 'error', ... }.

const { timeWords } = require('./engine');

let cancelled = false;
const child = {};
const send = (m) => process.parentPort.postMessage(m);

process.parentPort.on('message', async ({ data }) => {
  if (data.type === 'cancel') {
    cancelled = true;
    try { child.current?.kill(); } catch { /* gone */ }
    return;
  }
  if (data.type !== 'run') return;
  try {
    const ort = require('onnxruntime-node');
    const res = await timeWords({
      ...data.job, ort, child,
      log: (text) => send({ type: 'log', text }),
      onProgress: (p) => send({ type: 'progress', ...p }),
      isCancelled: () => cancelled,
    });
    send({ type: 'done', lyrics: res.lyrics, stats: res.stats, lines: res.lines.map(l => ({ start: l.start, timed: !!l.timed, conf: l.conf, lang: l.lang })) });
  } catch (e) {
    send({ type: 'error', message: cancelled ? 'cancelled' : (e && e.message) || String(e) });
  }
});
