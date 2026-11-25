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

// The newest request wins: an older one, or one cancelled, stops at its next step. A cancel can come while a
// request is still reading the file's details, before there is anything to abort (the window closed at once, or
// opened twice), so each step looks at this number rather than relying on the abort alone.
let latest = 0;
const CANCELLED = 'Cancelled';

ipcMain.handle('analysis:spectrum', async (event, filePath) => {
  const my = ++latest;
  const stale = () => { if (my !== latest) throw new Error(CANCELLED); };
  const controller = new AbortController();
  try {
    assertPlayable(filePath);
    const stat = await fs.promises.stat(filePath);
    stale();
    const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
    if (cache.has(key)) return { success: true, ...cache.get(key) };

    running?.controller.abort();
    running = { key, controller };

    const row = database.getFileByPath(filePath);
    let meta = row ? { duration: row.duration, bits: row.bit_depth, codec: row.codec, lossless: row.lossless } : null;
    if (!meta || !meta.duration) {
      const mm = await import('music-metadata');
      const p = await mm.parseFile(filePath, { duration: true, skipCovers: true });
      meta = { duration: p.format.duration, bits: p.format.bitsPerSample, codec: p.format.codec, lossless: p.format.lossless ? 1 : 0 };
    }
    const ext = path.extname(filePath).toLowerCase();
    // loudness counts a mono file's one channel once (it is decoded to two)
    const channels = await import('music-metadata').then(mm => mm.parseFile(filePath, { duration: false, skipCovers: true })).then(p => p.format.numberOfChannels).catch(() => 2);
    stale();

    const spec = await analyze(mpvPath, filePath, { duration: meta.duration, channels }, {
      signal: controller.signal,
      mastering: true, // loudness, true peak and stereo, for the Mastering tab (the background check leaves them out)
      onProgress: (pct) => { if (my === latest && !event.sender.isDestroyed()) event.sender.send('analysis:progress', { path: filePath, pct }); },
    });
    stale();
    const isDsd = ext === '.dsf' || ext === '.dff';
    const effectiveBits = isDsd ? null : await effectiveBitDepth(mpvPath, filePath).catch(() => null);
    stale();
    const verdict = judge({
      ext, codec: meta.codec, lossless: meta.lossless, declaredBits: meta.bits,
      rate: spec.sampleRate, cutoffHz: spec.cutoffHz, sharp: spec.sharp, effectiveBits, peakDb: spec.peakDb,
      holes: spec.holes, monoHighs: spec.monoHighs, edge: spec.edge, clipped: spec.clipped, dr: spec.dr,
    });
    console.log(`[Quality] ${path.basename(filePath)}: ${verdict.id} (${verdict.confidence}) · ${verdict.evidence.map(e => `${e.id} ${e.status}`).join(', ')}`);

    require('./qualityScan').fromWindow(filePath, verdict);
    const result = { ...spec, effectiveBits, declaredBits: meta.bits || null, codec: meta.codec || null, verdict };
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (running?.controller === controller) running = null;
  }
});

ipcMain.handle('analysis:cancel', () => {
  latest++;
  running?.controller.abort();
  running = null;
});

// the background check waits while this window analyses
module.exports = { busy: () => !!running };
