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
  const args = ['--no-config', '--no-video', '--media-controls=no', '--load-scripts=no', '--ytdl=no', '--msg-level=all=info', ...fmt, '--o=-'];
  if (channels === 'mono') args.push('--audio-channels=mono');
  if (channels === 'stereo') args.push('--audio-channels=stereo');
  if (lengthSec) args.push(`--length=${lengthSec}`);
  args.push('--', filePath);

  const child = spawn(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let rate = 0;
  let chans = channels === 'mono' ? 1 : channels === 'stereo' ? 2 : 0;
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
// LAME lowpass defaults: 128k ≈ 17 kHz, 192k ≈ 19 kHz, 256k ≈ 19.5–20 kHz, 320k ≈ 20–20.5 kHz
const kbpsFor = (hz) => (hz < 17600 ? '≤128' : hz < 19200 ? '~192' : hz < 19900 ? '~256' : '~320');

/**
 * The measured numbers as a verdict and the evidence behind it. Only ids and numbers: the window words them
 * (src/components/SpectrumModal.jsx), in the app's language.
 *   id: genuine | genuine-padded | rolloff | transcoded | upsampled | upsampled-lossy | lossy-format | inconclusive
 *   evidence: [{ id, status: good | bad | warn | neutral | na, params }]
 */
function judge({ ext, codec, lossless, declaredBits, rate, cutoffHz, sharp, effectiveBits, peakDb, holes, monoHighs, edge, clipped, dr }) {
  const nyquist = rate / 2;
  const lossyContainer = LOSSY_EXT.has(ext) || lossless === 0 || /aac|mp3|vorbis|opus/i.test(codec || '');
  const isDsd = ext === '.dsf' || ext === '.dff';
  const upsampled = rate > 48000 && edge && edge.drop >= 15;
  const top = upsampled ? Math.min(cutoffHz, edge.hz) : cutoffHz;
  const sharpLossy = sharp && cutoffHz < nyquist * 0.93 && cutoffHz >= 10000 && cutoffHz <= 20800;
  const fullBand = !upsampled && cutoffHz >= nyquist * 0.93;
  const evidence = [];

  evidence.push({
    id: 'cutoff',
    status: lossyContainer ? 'neutral' : sharpLossy || upsampled ? 'bad' : fullBand ? 'good' : 'neutral',
    params: { hz: top, nyquist, sharp: !!sharp || !!upsampled, kbps: sharpLossy || lossyContainer ? kbpsFor(cutoffHz) : null },
  });
  if (rate > 48000) {
    evidence.push({ id: 'upsample', status: upsampled ? 'bad' : 'good', params: { drop: edge?.drop ?? null, hz: edge?.hz ?? null, from: edge && edge.hz > 22600 ? 48 : 44.1 } });
  }
  const holesOk = holes && holes.bands >= 4 && holes.loudColumns >= 20;
  const holesStatus = !holesOk ? 'na' : holes.ratio >= 0.1 ? 'bad' : holes.ratio >= 0.03 ? 'warn' : 'good';
  evidence.push({ id: 'holes', status: lossyContainer && holesOk ? 'neutral' : holesStatus, params: { ratio: holes?.ratio ?? 0 } });
  const monoStatus = !monoHighs?.applicable ? 'na' : monoHighs.fraction >= 0.5 ? 'bad' : monoHighs.fraction >= 0.2 ? 'warn' : 'good';
  evidence.push({ id: 'monoHighs', status: lossyContainer && monoStatus !== 'na' ? 'neutral' : monoStatus, params: { fraction: monoHighs?.fraction ?? 0, monoRecording: !!monoHighs?.monoRecording, sideMid: monoHighs?.sideMid ?? null, sideHigh: monoHighs?.sideHigh ?? null } });
  const padded = declaredBits > 16 && effectiveBits && effectiveBits <= 16;
  if (!isDsd && !lossyContainer) {
    evidence.push({ id: 'bits', status: !effectiveBits || !declaredBits ? 'na' : padded ? 'bad' : 'good', params: { declared: declaredBits || null, effective: effectiveBits || null } });
  }
  evidence.push({ id: 'clipping', status: clipped > 0 ? 'warn' : 'good', params: { count: clipped || 0, peakDb } });
  if (dr != null) evidence.push({ id: 'dr', status: 'neutral', params: { dr } });

  const out = (id, level, confidence, params = {}) => ({ id, level, confidence, params, evidence });
  if (peakDb < -80) return out('inconclusive', 'info', 'low', { reason: 'quiet' });
  if (lossyContainer) return out('lossy-format', 'info', 'high', { hz: cutoffHz, kbps: kbpsFor(cutoffHz) });

  const signs = (holesStatus === 'bad' ? 1 : 0) + (monoStatus === 'bad' ? 1 : 0);
  if (upsampled) {
    const fromLossy = (sharp && top < 20500) || holesStatus === 'bad';
    return out(fromLossy ? 'upsampled-lossy' : 'upsampled', fromLossy ? 'bad' : 'warn', 'high', { rate, from: edge.hz > 22600 ? 48 : 44.1, hz: top });
  }
  if (sharpLossy) return out('transcoded', 'bad', signs ? 'high' : 'medium', { hz: cutoffHz, kbps: kbpsFor(cutoffHz) });
  if (signs) return out('inconclusive', 'warn', 'low', { reason: 'signs', hz: cutoffHz });
  if (fullBand) return out(padded ? 'genuine-padded' : 'genuine', padded ? 'warn' : 'ok', holesStatus === 'warn' || monoStatus === 'warn' ? 'medium' : 'high', { hz: cutoffHz, nyquist, bits: effectiveBits });
  return out('rolloff', 'info', 'medium', { hz: cutoffHz, nyquist, padded: !!padded, bits: effectiveBits });
}

// ---------- analysis ----------

function fftSizeFor(rate) {
  if (rate <= 48000) return 4096;
  if (rate <= 96000) return 8192;
  return 16384;
}

/**
 * Full analysis. `meta` = { duration }.
 * The file is decoded as stereo: the spectrogram shows the mid (L+R), and the side (L−R) is measured beside it,
 * because a lossy encoder gives the side far fewer bits than the mid, most of all in the highs.
 * Returns the spectrogram (columns x rows, Uint8 0..255 = -120..0 dBFS) and the numbers judge() reads.
 */
async function analyze(mpvPath, filePath, meta = {}, { columns = 900, rows = 480, onProgress, signal } = {}) {
  const duration = Math.max(1, meta.duration || 0);
  let N = 0, hop = 0, ringM = null, ringS = null, writeIdx = 0, sampleCount = 0, nextCol = 0, nextEnd = 0;
  let fft = null, win = null, re = null, im = null, reS = null, imS = null, midPower = null, sidePower = null, colsDone = 0;
  let data = null, binsPerRow = 1, rateSeen = 0, carry = Buffer.alloc(0), peak = 0, total = 0;
  let lastProgress = 0;
  // per column: the mid's level in 500 Hz bands from 8 kHz (for holes), mid and side in 12 to 16 kHz
  let bandEdges = [], colBands = null, colMidHi = null, colSideHi = null, colRef = null;
  // clipping: samples at full scale, two or more in a row on one channel; dynamic range: 3 s blocks per channel
  let clipped = 0; const run = [0, 0];
  let blockLen = 0, blockN = 0; const blockSq = [0, 0], blockPeak = [0, 0]; const blocks = [[], []];

  const setup = (rate) => {
    rateSeen = rate;
    N = fftSizeFor(rate);
    total = Math.round(duration * rate);
    hop = Math.max(1, (total - N) / columns);
    ringM = new Float32Array(N);
    ringS = new Float32Array(N);
    fft = makeFft(N);
    win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    re = new Float64Array(N); im = new Float64Array(N);
    reS = new Float64Array(N); imS = new Float64Array(N);
    midPower = new Float64Array(N / 2);
    sidePower = new Float64Array(N / 2);
    binsPerRow = (N / 2) / rows;
    data = new Uint8Array(columns * rows);
    nextEnd = N;
    for (let f = 8000; f <= Math.min(rate / 2, 24000); f += 500) bandEdges.push(f);
    colBands = new Float32Array(columns * Math.max(1, bandEdges.length - 1));
    colMidHi = new Float32Array(columns); colSideHi = new Float32Array(columns); colRef = new Float32Array(columns);
    blockLen = rate * 3;
  };

  const sumBins = (arrRe, arrIm, fromHz, toHz, norm2) => {
    const binHz = rateSeen / N;
    const a = Math.max(1, Math.round(fromHz / binHz)), b = Math.min(N / 2 - 1, Math.round(toHz / binHz));
    let s = 0;
    for (let k = a; k <= b; k++) s += (arrRe[k] * arrRe[k] + arrIm[k] * arrIm[k]) / norm2;
    return b >= a ? s / (b - a + 1) : 0;
  };

  const computeColumn = () => {
    for (let i = 0; i < N; i++) {
      const j = (writeIdx + i) % N;
      re[i] = ringM[j] * win[i]; im[i] = 0;
      reS[i] = ringS[j] * win[i]; imS[i] = 0;
    }
    fft(re, im);
    fft(reS, imS);
    const norm = N / 4; // full-scale sine -> 0 dB with a Hann window
    const norm2 = norm * norm;
    const colBase = nextCol * rows;
    let rowMax = 0;
    let row = 0;
    let nextRowBin = binsPerRow;
    for (let k = 0; k < N / 2; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) / norm2;
      midPower[k] += p;
      sidePower[k] += (reS[k] * reS[k] + imS[k] * imS[k]) / norm2;
      if (p > rowMax) rowMax = p;
      if (k + 1 >= nextRowBin || k === N / 2 - 1) {
        const db = 10 * Math.log10(rowMax + 1e-20);
        data[colBase + row] = Math.max(0, Math.min(255, Math.round(((db + 120) / 120) * 255)));
        row++;
        nextRowBin += binsPerRow;
        rowMax = 0;
      }
    }
    const nb = bandEdges.length - 1;
    for (let b = 0; b < nb; b++) colBands[nextCol * nb + b] = 10 * Math.log10(sumBins(re, im, bandEdges[b], bandEdges[b + 1], norm2) + 1e-20);
    colRef[nextCol] = 10 * Math.log10(sumBins(re, im, 1000, 3000, norm2) + 1e-20);
    if (rateSeen >= 34000) {
      colMidHi[nextCol] = 10 * Math.log10(sumBins(re, im, 12000, 16000, norm2) + 1e-20);
      colSideHi[nextCol] = 10 * Math.log10(sumBins(reS, imS, 12000, 16000, norm2) + 1e-20);
    }
    nextCol++;
    colsDone++;
    nextEnd = Math.round(N + nextCol * hop);
  };

  // frames: interleaved L, R
  const push = (lr) => {
    const frames = lr.length >> 1;
    let off = 0;
    for (let i = 0; i < frames; i++) {
      const l = lr[2 * i], r = lr[2 * i + 1];
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      if (al >= 0.9999) { if (++run[0] === 2) clipped += 2; else if (run[0] > 2) clipped++; } else run[0] = 0;
      if (ar >= 0.9999) { if (++run[1] === 2) clipped += 2; else if (run[1] > 2) clipped++; } else run[1] = 0;
      blockSq[0] += l * l; blockSq[1] += r * r;
      if (al > blockPeak[0]) blockPeak[0] = al;
      if (ar > blockPeak[1]) blockPeak[1] = ar;
      if (++blockN >= blockLen) {
        for (let c = 0; c < 2; c++) { blocks[c].push([Math.sqrt(2 * blockSq[c] / blockN), blockPeak[c]]); blockSq[c] = 0; blockPeak[c] = 0; }
        blockN = 0;
      }
    }
    while (off < frames && nextCol < columns) {
      const need = nextEnd - sampleCount;
      const take = Math.min(need, frames - off);
      for (let i = off; i < off + take; i++) {
        ringM[writeIdx] = (lr[2 * i] + lr[2 * i + 1]) / 2;
        ringS[writeIdx] = (lr[2 * i] - lr[2 * i + 1]) / 2;
        writeIdx = (writeIdx + 1) % N;
      }
      off += take;
      sampleCount += take;
      if (sampleCount >= nextEnd) computeColumn();
    }
    sampleCount += frames - off; // samples after the last column are just counted
  };

  const dec = decode(mpvPath, filePath, { format: 'f32', channels: 'stereo' }, (buf, rate) => {
    if (!N) setup(rate);
    const chunk = carry.length ? Buffer.concat([carry, buf]) : buf;
    const usable = chunk.length - (chunk.length % 8); // whole stereo frames
    carry = chunk.subarray(usable);
    const aligned = Buffer.from(chunk.subarray(0, usable)); // copy → 4-byte aligned for Float32Array
    push(new Float32Array(aligned.buffer, aligned.byteOffset, usable / 4));
    if (onProgress && total) {
      const pct = Math.min(99, Math.round((sampleCount / total) * 100));
      if (pct !== lastProgress) { lastProgress = pct; onProgress(pct); }
    }
  });
  if (signal) signal.addEventListener('abort', () => dec.child.kill(), { once: true });
  await dec.promise;
  if (signal?.aborted) throw new Error('Cancelled');
  if (!colsDone) throw new Error('File is too short to analyse');

  // Long-term average spectrum → highest frequency that carries real content
  const bins = N / 2;
  const binHz = rateSeen / N;
  const avgDb = new Float64Array(bins);
  for (let k = 0; k < bins; k++) avgDb[k] = 10 * Math.log10(midPower[k] / colsDone + 1e-20);
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
  const band = (arr, fromHz, toHz) => {
    const a = Math.max(0, Math.round(fromHz / binHz)), b = Math.min(bins - 1, Math.round(toHz / binHz));
    let s = 0, c = 0;
    for (let k = a; k <= b; k++) { s += arr[k]; c++; }
    return c ? s / c : -200;
  };
  const below = band(smooth, cutoffHz - 1200, cutoffHz - 300);
  const above = band(smooth, cutoffHz + 300, cutoffHz + 1200);
  const sharp = cutoffHz < rateSeen / 2 * 0.97 && below - above > 25;

  // a hi-res file made from 44.1 or 48 kHz has an edge below the old limit (22.05 or 24 kHz): the level falls away
  // within a kilohertz and stays down, where a real recording fades gradually
  let edge = null;
  if (rateSeen >= 88000) {
    edge = { hz: 0, drop: -200 };
    for (let hz = 19000; hz <= 24500; hz += 100) {
      const d = band(smooth, hz - 1000, hz - 200) - band(smooth, hz + 200, hz + 1000);
      if (d > edge.drop) edge = { hz, drop: d };
    }
    edge.drop = Math.round(edge.drop * 10) / 10;
  }
  // where the music really stops: the cutoff, or the edge of a file made from a lower rate
  const contentTop = edge && edge.drop >= 15 ? Math.min(cutoffHz, edge.hz) : cutoffHz;

  // Spectral holes: in a loud moment, a 500 Hz band under the cutoff that is all but silent, where the music
  // around it is not (an encoder ran out of bits and dropped it). Real recordings keep at least their noise there.
  const nb = bandEdges.length - 1;
  const usableBands = bandEdges.filter((f, b) => b < nb && bandEdges[b + 1] <= contentTop * 0.97).length;
  const holesMap = new Uint8Array(colsDone);
  let loud = 0, holed = 0, cells = 0, empty = 0;
  for (let c = 0; c < colsDone; c++) {
    if (colRef[c] < -50 || !usableBands) continue;
    loud++;
    let n = 0;
    const vals = Array.from(colBands.subarray(c * nb, c * nb + usableBands)).sort((x, y) => x - y);
    const median = vals[vals.length >> 1];
    for (let b = 0; b < usableBands; b++) { cells++; const v = colBands[c * nb + b]; if (v < median - 30 && v < -100) n++; }
    holesMap[c] = n;
    empty += n;
    if (n) holed++;
  }
  const holes = { ratio: loud ? holed / loud : 0, cells: cells ? empty / cells : 0, loudColumns: loud, bands: usableBands };

  // Mono highs: how far below the mid the side sits in the highs, against how far in the mids
  const sm = (fromHz, toHz) => 10 * Math.log10((band(sidePower, fromHz, toHz) + 1e-30) / (band(midPower, fromHz, toHz) + 1e-30));
  const sideMid = sm(1000, 6000);
  const hiTop = Math.min(16000, contentTop * 0.95);
  const applicable = rateSeen >= 34000 && hiTop > 12500 && sideMid > -30;
  const sideHigh = applicable ? sm(12000, hiTop) : null;
  let hiCols = 0, monoCols = 0;
  if (applicable) {
    for (let c = 0; c < colsDone; c++) {
      if (colMidHi[c] < -85) continue;
      hiCols++;
      if (colSideHi[c] < colMidHi[c] - 40) monoCols++;
    }
  }
  const monoHighs = { applicable, sideMid: Math.round(sideMid * 10) / 10, sideHigh: sideHigh == null ? null : Math.round(sideHigh * 10) / 10, drop: sideHigh == null ? null : Math.round((sideMid - sideHigh) * 10) / 10, fraction: hiCols ? monoCols / hiCols : 0, monoRecording: sideMid <= -30 };

  // Dynamic range as DR meters count it: the second highest peak against the loudest fifth of the 3 s blocks
  const drOf = (list) => {
    if (list.length < 2) return null;
    const rms = list.map(b => b[0]).sort((a, b) => b - a);
    const top = rms.slice(0, Math.max(1, Math.round(list.length * 0.2)));
    const rmsTop = Math.sqrt(top.reduce((s, v) => s + v * v, 0) / top.length);
    const peaks = list.map(b => b[1]).sort((a, b) => b - a);
    return rmsTop > 0 ? 20 * Math.log10(peaks[1] / rmsTop) : null;
  };
  const drs = blocks.map(drOf).filter(v => v != null);
  const dr = drs.length ? Math.round(drs.reduce((s, v) => s + v, 0) / drs.length) : null;

  const profileOf = (power) => {
    const out = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      const a = Math.floor(r * binsPerRow), b = Math.min(bins, Math.floor((r + 1) * binsPerRow));
      let m = -200;
      for (let k = a; k < b; k++) m = Math.max(m, 10 * Math.log10(power[k] / colsDone + 1e-20));
      out[r] = m;
    }
    return Array.from(out, v => Math.round(v * 10) / 10);
  };

  return {
    sampleRate: rateSeen,
    duration,
    columns: colsDone,
    allocatedColumns: columns,
    rows,
    fftSize: N,
    data,
    profile: profileOf(midPower),
    profileSide: profileOf(sidePower),
    cutoffHz: Math.round(cutoffHz),
    sharp,
    peakDb: Math.round(20 * Math.log10(peak + 1e-12) * 10) / 10,
    holes: { ...holes, ratio: Math.round(holes.ratio * 1000) / 1000, cells: Math.round(holes.cells * 1000) / 1000 },
    edge,
    holesMap: Array.from(holesMap),
    monoHighs: { ...monoHighs, fraction: Math.round(monoHighs.fraction * 1000) / 1000 },
    clipped,
    dr,
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
