// Background quality check: runs in its own process (Electron utilityProcess) at the lowest priority, so the
// FFT never shares a thread with the app, the player or the Quality check window. mpv, started from here,
// takes the same low priority. One file at a time; electron/qualityScan.js decides what and when.

const os = require('os');
const { analyze, effectiveBitDepth, judge } = require('./spectrumCore');

try { os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW); } catch { /* fine */ }

let controller = null;

process.parentPort.on('message', async ({ data }) => {
  if (data?.cancel) { controller?.abort(); return; }
  const { id, mpvPath, file, meta } = data;
  controller = new AbortController();
  try {
    // the same analysis as the window (900 columns): both always come to the same verdict
    const spec = await analyze(mpvPath, file, { duration: meta.duration }, { signal: controller.signal });
    const effectiveBits = await effectiveBitDepth(mpvPath, file).catch(() => null);
    const v = judge({
      ext: meta.ext, codec: meta.codec, lossless: meta.lossless, declaredBits: meta.bits,
      rate: spec.sampleRate, cutoffHz: spec.cutoffHz, sharp: spec.sharp, effectiveBits, peakDb: spec.peakDb,
      holes: spec.holes, monoHighs: spec.monoHighs, edge: spec.edge, clipped: spec.clipped, dr: spec.dr,
    });
    process.parentPort.postMessage({ id, result: { id: v.id, level: v.level, confidence: v.confidence, params: v.params } });
  } catch (err) {
    process.parentPort.postMessage({ id, error: err.message });
  } finally {
    controller = null;
  }
});
