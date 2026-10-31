// IPC wrapper around spectrumCore: validates the path, caches results, reports progress.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { assertPlayable } = require('./paths');
const { mpvPath } = require('./player');
const database = require('./database');
const { analyze, effectiveBitDepth, judge } = require('./spectrumCore');

const cache = new Map(); // `${path}|${mtime}` -> result
let running = null;      // { key, controller }

ipcMain.handle('analysis:spectrum', async (event, filePath) => {
  try {
    assertPlayable(filePath);
    const stat = await fs.promises.stat(filePath);
    const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
    if (cache.has(key)) return { success: true, ...cache.get(key) };

    running?.controller.abort();
    const controller = new AbortController();
    running = { key, controller };

    const row = database.getFileByPath(filePath);
    let meta = row ? { duration: row.duration, bits: row.bit_depth, codec: row.codec, lossless: row.lossless } : null;
    if (!meta || !meta.duration) {
      const mm = await import('music-metadata');
      const p = await mm.parseFile(filePath, { duration: true, skipCovers: true });
      meta = { duration: p.format.duration, bits: p.format.bitsPerSample, codec: p.format.codec, lossless: p.format.lossless ? 1 : 0 };
    }
    const ext = path.extname(filePath).toLowerCase();

    const spec = await analyze(mpvPath, filePath, { duration: meta.duration }, {
      signal: controller.signal,
      onProgress: (pct) => { if (!event.sender.isDestroyed()) event.sender.send('analysis:progress', { path: filePath, pct }); },
    });
    const isDsd = ext === '.dsf' || ext === '.dff';
    const effectiveBits = isDsd ? null : await effectiveBitDepth(mpvPath, filePath).catch(() => null);
    const verdict = judge({
      ext, codec: meta.codec, lossless: meta.lossless, declaredBits: meta.bits,
      rate: spec.sampleRate, cutoffHz: spec.cutoffHz, sharp: spec.sharp, effectiveBits, peakDb: spec.peakDb,
    });

    const result = { ...spec, effectiveBits, declaredBits: meta.bits || null, verdict };
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (running && running.controller.signal.aborted === false) running = null;
  }
});

ipcMain.handle('analysis:cancel', () => {
  running?.controller.abort();
  running = null;
});
