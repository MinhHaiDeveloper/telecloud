// Spectrogram + "is this really lossless?" analysis.
// mpv decodes the file (any format it can play, DSD included) to raw float PCM on stdout;
// we run a short-time FFT over evenly spaced windows while the data streams in, so memory
// stays small even for long 24/192 files. No Electron imports: this file is unit-testable.

const { spawn } = require('child_process');

// ---------- FFT ----------

function makeFft(n) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }

  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] + im[b] * sin[k];
          const ti = -re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

// ---------- mpv decoding ----------

/** Stream decoded samples. Resolves with the output sample rate once mpv reports it. */
function decode(mpvPath, filePath, { format = 'f32', channels = 'mono', lengthSec } = {}, onData) {
  const fmt = format === 's32' ? ['--of=s32le', '--oac=pcm_s32le'] : ['--of=f32le', '--oac=pcm_f32le'];
  const args = ['--no-config', '--no-video', '--load-scripts=no', '--ytdl=no', '--msg-level=all=info', ...fmt, '--o=-'];
  if (channels === 'mono') args.push('--audio-channels=mono');
  if (lengthSec) args.push(`--length=${lengthSec}`);
  args.push('--', filePath);

  const child = spawn(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let rate = 0;
  let chans = channels === 'mono' ? 1 : 0;
  let held = [];
  let stderr = '';

  const promise = new Promise((resolve, reject) => {
    child.stderr.on('data', d => {
      stderr = (stderr + d.toString()).slice(-4000);
      if (!rate) {
        const m = stderr.match(/AO: \[lavc\] (\d+)Hz \S+ (\d+)ch/);
        if (m) {
          rate = Number(m[1]);
          chans = Number(m[2]);
          held.forEach(b => onData(b, rate, chans));
          held = null;
        }
      }
    });
    child.stdout.on('data', buf => {
      if (rate) onData(buf, rate, chans); else held.push(buf);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (!rate) reject(new Error(code ? `Could not decode the file (${stderr.split('\n').filter(Boolean).pop() || code})` : 'No audio stream found'));
      else resolve({ rate, channels: chans });
    });
  });
  return { child, promise };
}

// ---------- verdict ----------

const LOSSY_EXT = new Set(['.mp3', '.ogg', '.opus', '.aac']);

/** Turn the measured numbers into a plain-language answer. */
function judge({ ext, codec, lossless, declaredBits, rate, cutoffHz, sharp, effectiveBits, peakDb }) {
  const nyquist = rate / 2;
  const khz = (hz) => `${(hz / 1000).toFixed(1)} kHz`;
  const lossyContainer = LOSSY_EXT.has(ext) || lossless === 0 || /aac|mp3|vorbis|opus/i.test(codec || '');
  const notes = [];

  if (peakDb < -80) {
    return { level: 'info', title: 'Mostly silence', detail: 'Not enough signal to judge this file.', notes };
  }
  if (lossyContainer) {
    return {
      level: 'info',
      title: 'Lossy format',
      detail: `This is a lossy file by design. Its content stops around ${khz(cutoffHz)}.`,
      notes,
    };
  }

  if (declaredBits > 16 && effectiveBits && effectiveBits <= 16) {
    notes.push(`Declared ${declaredBits}-bit, but only ${effectiveBits} bits carry data — it is ${effectiveBits}-bit audio padded with zeros.`);
  }

  const fullBand = cutoffHz >= nyquist * 0.93;
  let verdict;
  if (rate > 48000 && cutoffHz <= 24500) {
    verdict = {
      level: 'warn',
      title: 'Upsampled from CD quality',
      detail: `Sample rate is ${khz(rate)}, but nothing is above ${khz(cutoffHz)}. The music was most likely made at 44.1/48 kHz and converted up.`,
    };
    if (sharp && cutoffHz < 20500) verdict = {
      level: 'bad',
      title: 'Likely a lossy source',
      detail: `Hard cutoff at ${khz(cutoffHz)} — typical of an MP3/AAC that was converted to hi-res.`,
    };
  } else if (sharp && cutoffHz < nyquist * 0.93 && cutoffHz >= 10000 && cutoffHz <= 20800) {
    // LAME lowpass defaults: 128k ≈ 17 kHz, 192k ≈ 19 kHz, 256k ≈ 19.5–20 kHz, 320k ≈ 20–20.5 kHz
    const kbps = cutoffHz < 17600 ? '≤128 kbps' : cutoffHz < 19200 ? '~192 kbps' : cutoffHz < 19900 ? '~256 kbps' : '~320 kbps';
    verdict = {
      level: 'bad',
      title: 'Likely transcoded from lossy',
      detail: `There is a brick-wall cutoff at ${khz(cutoffHz)}, the signature of a ${kbps} MP3/AAC encoder. Real lossless audio usually reaches ${khz(nyquist * 0.95)} or more.`,
    };
  } else if (fullBand) {
    verdict = {
      level: notes.length ? 'warn' : 'ok',
      title: notes.length ? 'Full bandwidth, padded bit depth' : 'Looks genuinely lossless',
      detail: `Content reaches ${khz(cutoffHz)} (the limit at ${khz(rate)} is ${khz(nyquist)}). No sign of lossy encoding.`,
    };
  } else {
    verdict = {
      level: 'info',
      title: 'Probably lossless, natural roll-off',
      detail: `The highs fade out gradually around ${khz(cutoffHz)} instead of stopping abruptly. That is common for older recordings and quiet masters.`,
    };
  }
  return { ...verdict, notes };
}

// ---------- analysis ----------

function fftSizeFor(rate) {
  if (rate <= 48000) return 4096;
  if (rate <= 96000) return 8192;
  return 16384;
}

/**
 * Full analysis. `meta` = { duration, declaredBits, ext, codec, lossless }.
 * Returns the spectrogram (columns x rows, Uint8 0..255 = -120..0 dBFS) and a verdict.
 */
async function analyze(mpvPath, filePath, meta = {}, { columns = 900, rows = 480, onProgress, signal } = {}) {
  const duration = Math.max(1, meta.duration || 0);
  let N = 0, hop = 0, ring = null, writeIdx = 0, sampleCount = 0, nextCol = 0, nextEnd = 0;
  let fft = null, win = null, re = null, im = null, binPower = null, colsDone = 0;
  let data = null, binsPerRow = 1, rateSeen = 0, carry = Buffer.alloc(0), peak = 0, total = 0;
  let lastProgress = 0;

  const setup = (rate) => {
    rateSeen = rate;
    N = fftSizeFor(rate);
    total = Math.round(duration * rate);
    hop = Math.max(1, (total - N) / columns);
    ring = new Float32Array(N);
    fft = makeFft(N);
    win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    re = new Float64Array(N);
    im = new Float64Array(N);
    binPower = new Float64Array(N / 2);
    binsPerRow = (N / 2) / rows;
    data = new Uint8Array(columns * rows);
    nextEnd = N;
  };

  const computeColumn = () => {
    for (let i = 0; i < N; i++) {
      re[i] = ring[(writeIdx + i) % N] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const norm = N / 4; // full-scale sine -> 0 dB with a Hann window
    const colBase = nextCol * rows;
    let rowMax = 0;
    let row = 0;
    let nextRowBin = binsPerRow;
    for (let k = 0; k < N / 2; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) / (norm * norm);
      binPower[k] += p;
      if (p > rowMax) rowMax = p;
      if (k + 1 >= nextRowBin || k === N / 2 - 1) {
        const db = 10 * Math.log10(rowMax + 1e-20);
        data[colBase + row] = Math.max(0, Math.min(255, Math.round(((db + 120) / 120) * 255)));
        row++;
        nextRowBin += binsPerRow;
        rowMax = 0;
      }
    }
    nextCol++;
    colsDone++;
    nextEnd = Math.round(N + nextCol * hop);
  };

  const push = (floats) => {
    let off = 0;
    while (off < floats.length && nextCol < columns) {
      const need = nextEnd - sampleCount;
      const take = Math.min(need, floats.length - off);
      // copy into the ring, wrapping around once if needed
      let left = take, src = off;
      while (left > 0) {
        const n = Math.min(left, N - writeIdx);
        ring.set(floats.subarray(src, src + n), writeIdx);
        writeIdx = (writeIdx + n) % N;
        src += n; left -= n;
      }
      for (let i = off; i < off + take; i++) { const a = Math.abs(floats[i]); if (a > peak) peak = a; }
      off += take;
      sampleCount += take;
      if (sampleCount >= nextEnd) computeColumn();
    }
    sampleCount += floats.length - off; // samples after the last column are just counted
  };

  const run = decode(mpvPath, filePath, { format: 'f32', channels: 'mono' }, (buf, rate) => {
    if (!N) setup(rate);
    let chunk = carry.length ? Buffer.concat([carry, buf]) : buf;
    const usable = chunk.length - (chunk.length % 4);
    carry = chunk.subarray(usable);
    const aligned = Buffer.from(chunk.subarray(0, usable)); // copy → 4-byte aligned for Float32Array
    push(new Float32Array(aligned.buffer, aligned.byteOffset, usable / 4));
    if (onProgress && total) {
      const pct = Math.min(99, Math.round((sampleCount / total) * 100));
      if (pct !== lastProgress) { lastProgress = pct; onProgress(pct); }
    }
  });
  if (signal) signal.addEventListener('abort', () => run.child.kill(), { once: true });
  await run.promise;
  if (signal?.aborted) throw new Error('Cancelled');
  if (!colsDone) throw new Error('File is too short to analyse');

  // Long-term average spectrum → highest frequency that carries real content
  const bins = N / 2;
  const binHz = rateSeen / N;
  const avgDb = new Float64Array(bins);
  for (let k = 0; k < bins; k++) avgDb[k] = 10 * Math.log10(binPower[k] / colsDone + 1e-20);
  const smooth = new Float64Array(bins);
  const radius = Math.max(1, Math.round(150 / binHz));
  for (let k = 0; k < bins; k++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, k - radius); j <= Math.min(bins - 1, k + radius); j++) { s += avgDb[j]; c++; }
    smooth[k] = s / c;
  }
  const refStart = Math.round(1000 / binHz), refEnd = Math.min(bins - 1, Math.round(8000 / binHz));
  let refDb = -200;
  for (let k = refStart; k <= refEnd; k++) refDb = Math.max(refDb, smooth[k]);
  // Floor: median level of the top 3% of the band (near Nyquist)
  const topSlice = Array.from(smooth.subarray(Math.floor(bins * 0.97))).sort((a, b) => a - b);
  const floorDb = topSlice[Math.floor(topSlice.length / 2)];
  const threshold = Math.max(floorDb + 12, refDb - 75);
  const span = Math.max(2, Math.round(400 / binHz));
  let cutoffBin = bins - 1;
  for (let k = bins - span - 1; k > refStart; k--) {
    let ok = true;
    for (let j = 0; j < span; j++) if (smooth[k - j] < threshold) { ok = false; break; }
    if (ok) { cutoffBin = k; break; }
  }
  if (floorDb > refDb - 20) cutoffBin = bins - 1; // content right up to Nyquist (no floor at all)
  const cutoffHz = Math.min(rateSeen / 2, cutoffBin * binHz);

  // "Sharp" = the level falls by a lot within ~1 kHz above the cutoff
  const band = (fromHz, toHz) => {
    const a = Math.max(0, Math.round(fromHz / binHz)), b = Math.min(bins - 1, Math.round(toHz / binHz));
    let s = 0, c = 0;
    for (let k = a; k <= b; k++) { s += smooth[k]; c++; }
    return c ? s / c : -200;
  };
  const below = band(cutoffHz - 1200, cutoffHz - 300);
  const above = band(cutoffHz + 300, cutoffHz + 1200);
  const sharp = cutoffHz < rateSeen / 2 * 0.97 && below - above > 25;

  const rowsDb = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    const a = Math.floor(r * binsPerRow), b = Math.min(bins, Math.floor((r + 1) * binsPerRow));
    let m = -200;
    for (let k = a; k < b; k++) m = Math.max(m, avgDb[k]);
    rowsDb[r] = m;
  }

  return {
    sampleRate: rateSeen,
    duration,
    columns: colsDone,
    allocatedColumns: columns,
    rows,
    fftSize: N,
    data,
    profile: Array.from(rowsDb, v => Math.round(v * 10) / 10),
    cutoffHz: Math.round(cutoffHz),
    sharp,
    peakDb: Math.round(20 * Math.log10(peak + 1e-12) * 10) / 10,
  };
}

/** Effective bit depth from the first minute: count the always-zero low bits. */
async function effectiveBitDepth(mpvPath, filePath) {
  let acc = 0;
  let carry = Buffer.alloc(0);
  const run = decode(mpvPath, filePath, { format: 's32', channels: 'native', lengthSec: 60 }, (buf) => {
    let chunk = carry.length ? Buffer.concat([carry, buf]) : buf;
    const usable = chunk.length - (chunk.length % 4);
    for (let i = 0; i < usable; i += 4) acc |= chunk.readInt32LE(i);
    carry = chunk.subarray(usable);
  });
  await run.promise;
  if (acc === 0) return null;
  let tz = 0;
  while (tz < 32 && ((acc >>> tz) & 1) === 0) tz++;
  return 32 - tz;
}

module.exports = { analyze, effectiveBitDepth, judge, makeFft };
