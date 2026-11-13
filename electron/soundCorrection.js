// Settings > Sound > Correction: a room or headphone correction from a file. A WAV impulse response
// (as REW, Dirac or an HRTF tool exports it) becomes its frequency response; a text file of
// "frequency gain" lines is taken as it is. The curve is then played as a linear-phase FIR.

const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const POINTS = 160;
const MAX_TAPS = 1 << 17;

/** A WAV file's samples, all channels averaged: { rate, samples } */
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('That is not a WAV file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // extensible: the real format
      fmt = { format, channels, rate, bits };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('The WAV file has no audio in it');
  const { format, channels, rate, bits } = fmt;
  const bytes = bits / 8;
  if (!channels || !rate || ![16, 24, 32, 64].includes(bits) || ![1, 3].includes(format)) throw new Error('Use a 16, 24 or 32-bit WAV');
  const frames = Math.min(MAX_TAPS, Math.floor(data.length / (bytes * channels)));
  const read = (o) => {
    if (format === 3) return bits === 64 ? data.readDoubleLE(o) : data.readFloatLE(o);
    if (bits === 16) return data.readInt16LE(o) / 32768;
    if (bits === 24) return data.readIntLE(o, 3) / 8388608;
    return data.readInt32LE(o) / 2147483648;
  };
  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read((i * channels + c) * bytes);
    samples[i] = sum / channels;
  }
  return { rate, samples };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Log-spaced frequencies from 20 Hz to the top the file can describe */
const grid = (top) => Array.from({ length: POINTS }, (_, i) => 20 * Math.pow(Math.min(20000, top) / 20, i / (POINTS - 1)));

/** Level so the middle (200 Hz to 5 kHz) sits at 0 dB: the file's own loudness doesn't matter */
function centred(points) {
  const mid = points.filter(([f]) => f >= 200 && f <= 5000);
  const mean = mid.length ? mid.reduce((a, [, g]) => a + g, 0) / mid.length : 0;
  return points.map(([f, g]) => [Number(f.toFixed(1)), Number(Math.max(-30, Math.min(30, g - mean)).toFixed(2))]);
}

/** An impulse response's magnitude, smoothed to 1/12 octave, on the grid */
function responseOfIr({ rate, samples }) {
  if (samples.length < 16) throw new Error('The impulse response is too short');
  let n = 1;
  while (n < Math.max(samples.length, 8192)) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(samples);
  fft(re, im);
  const hz = rate / n;
  const mag = (k) => Math.hypot(re[k], im[k]);
  const points = grid(rate / 2).map((f) => {
    const lo = Math.max(1, Math.floor((f / Math.pow(2, 1 / 24)) / hz)), hi = Math.max(lo, Math.min(n / 2 - 1, Math.ceil((f * Math.pow(2, 1 / 24)) / hz)));
    let pow = 0;
    for (let k = lo; k <= hi; k++) pow += mag(k) ** 2;
    return [f, 10 * Math.log10(pow / (hi - lo + 1) || 1e-12)];
  });
  return centred(points);
}

/** "frequency gain" lines (REW, Squiglink, CSV) */
function responseOfText(text) {
  const raw = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([\d.]+(?:e[+-]?\d+)?)[\s,;\t]+(-?[\d.]+(?:e[+-]?\d+)?)/i.exec(line);
    if (m) raw.push([Number(m[1]), Number(m[2])]);
  }
  const ok = raw.filter(([f, g]) => f > 0 && Number.isFinite(g)).sort((a, b) => a[0] - b[0]);
  if (ok.length < 2) throw new Error('No "frequency gain" lines in that file');
  const at = (f) => {
    if (f <= ok[0][0]) return ok[0][1];
    if (f >= ok[ok.length - 1][0]) return ok[ok.length - 1][1];
    const i = ok.findIndex(([x]) => x >= f);
    const [x0, y0] = ok[i - 1], [x1, y1] = ok[i];
    return y0 + ((Math.log(f) - Math.log(x0)) / (Math.log(x1) - Math.log(x0))) * (y1 - y0);
  };
  return centred(grid(20000).map(f => [f, at(f)]));
}

function load(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (buf.length > 64 * 1024 * 1024) throw new Error('That file is too large');
  if (ext === '.wav') {
    const wav = readWav(buf);
    return { name: path.basename(file), kind: 'ir', rate: wav.rate, taps: wav.samples.length, points: responseOfIr(wav) };
  }
  return { name: path.basename(file), kind: 'curve', points: responseOfText(buf.toString('utf8')) };
}

ipcMain.handle('sound:load-correction', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Room or headphone correction',
    properties: ['openFile'],
    filters: [{ name: 'Impulse response or curve', extensions: ['wav', 'txt', 'csv'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const out = load(r.filePaths[0]);
    console.log(`[Sound] Correction loaded: ${out.kind === 'ir' ? `impulse response, ${out.taps} taps at ${out.rate} Hz` : 'curve'}`);
    return out;
  } catch (err) {
    console.error('[Sound] Correction refused:', err.message);
    return { error: err.message };
  }
});

module.exports = { load, readWav, responseOfIr, responseOfText };
