// The EQ page's live spectrum and Now Playing's VU meters: a second, silent mpv decodes what is playing
// from where it is, through the same filters, so the picture is what you hear. Its samples are read in
// step with the clock (the pipe holds mpv back when it runs ahead) and analysed a few times a second.
// The spectrum reads mono (`analyse`, 4096 points every 60 ms); the meters read stereo (`levels`, each
// channel's RMS and peak over the last 1470 frames, every 33 ms).

const { spawn } = require('child_process');

const RATE = 44100;
const N = 4096;              // FFT size: about 10.8 Hz a bin
const BANDS = 120;           // log-spaced, 20 Hz to 20 kHz
const AHEAD = RATE * 1.5;    // samples kept ahead of the clock before mpv is held back

const FREQS = Array.from({ length: BANDS }, (_, i) => 20 * Math.pow(1000, (i + 0.5) / BANDS));
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => 20 * Math.pow(1000, i / BANDS));
const WINDOW = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
const WINDOW_GAIN = WINDOW.reduce((a, b) => a + b, 0) / N; // Hann: 0.5

// ---- a plain radix-2 FFT on 4096 points
const bits = Math.log2(N);
const REV = new Uint32Array(N);
for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); REV[i] = r; }
const COS = new Float64Array(N / 2), SIN = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / N); SIN[i] = -Math.sin((2 * Math.PI * i) / N); }
function fft(re, im) {
  for (let i = 0; i < N; i++) { const j = REV[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], s = SIN[k * step];
        const a = i + k, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** dBFS in each band for the N samples given (a full-scale sine reads about 0 dB) */
function analyse(samples) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = samples[i] * WINDOW[i];
  fft(re, im);
  const out = new Array(BANDS);
  const hz = RATE / N;
  for (let b = 0; b < BANDS; b++) {
    const lo = Math.max(1, Math.floor(EDGES[b] / hz)), hi = Math.max(lo, Math.min(N / 2 - 1, Math.floor(EDGES[b + 1] / hz)));
    let peak = 0;
    for (let k = lo; k <= hi; k++) peak = Math.max(peak, re[k] * re[k] + im[k] * im[k]);
    const amp = (2 * Math.sqrt(peak)) / (N * WINDOW_GAIN);
    out[b] = Math.max(-120, Number((20 * Math.log10(amp || 1e-9)).toFixed(1)));
  }
  return out;
}

/** Each channel's RMS and peak in dBFS over the window: [left rms, left peak, right rms, right peak] */
function levels(win) {
  let sl = 0, sr = 0, pl = 0, pr = 0;
  for (let i = 0; i + 1 < win.length; i += 2) {
    const l = win[i], r = win[i + 1];
    sl += l * l; sr += r * r;
    const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
    if (al > pl) pl = al;
    if (ar > pr) pr = ar;
  }
  const n = win.length / 2;
  const db = (x) => Math.max(-90, Math.round(200 * Math.log10(x || 1e-9)) / 10);
  return [db(Math.sqrt(sl / n)), db(pl), db(Math.sqrt(sr / n)), db(pr)];
}

/**
 * `channels`: 1 (mono, the spectrum) or 2 (stereo, interleaved, the meters); `window`: frames analysed;
 * `interval`: ms between frames; `analyse`: window (interleaved floats) -> what onFrame gets.
 */
function create({ mpvPath, onFrame, onState = () => {}, channels = 1, window: frames = N, interval = 60, analyse: analyseFn = analyse, state = () => ({ freqs: FREQS }) }) {
  const WIN = frames * channels;     // floats in a window
  const LEAD = AHEAD * channels;     // floats kept ahead of the clock
  let child = null;
  let run = null; // { path, pos, t0, chunks: [{ at, data }], total, timer }

  function stop() {
    if (run) clearInterval(run.timer);
    run = null;
    if (child) { try { child.kill(); } catch { /* gone */ } child = null; }
  }

  function start({ path, pos = 0, af = '' }) {
    stop();
    const args = ['--no-config', '--no-video', '--media-controls=no', '--load-scripts=no', '--ytdl=no', '--msg-level=all=error',
      `--start=${Math.max(0, pos).toFixed(3)}`, `--audio-channels=${channels === 2 ? 'stereo' : 'mono'}`, `--audio-samplerate=${RATE}`,
      '--of=f32le', '--oac=pcm_f32le', '--o=-'];
    if (af) args.push(`--af=${af}`);
    args.push('--', path);
    const me = spawn(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child = me;
    const r = { path, pos, t0: Date.now(), chunks: [], total: 0, carry: null, timer: null };
    run = r;
    me.on('error', () => { if (child === me) { child = null; onState({ running: false }); } });
    me.on('close', () => { if (child === me) child = null; });
    me.stdout.on('data', (buf) => {
      if (run !== r) return;
      // 4-byte floats can be split between two reads
      let b = r.carry ? Buffer.concat([r.carry, buf]) : buf;
      const whole = b.length - (b.length % 4);
      r.carry = whole < b.length ? b.subarray(whole) : null;
      b = b.subarray(0, whole);
      const data = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      r.chunks.push({ at: r.total, data });
      r.total += data.length;
      if (r.total - clock(r) > LEAD) me.stdout.pause();
    });
    r.timer = setInterval(() => tick(r, me), interval);
    onState({ running: true, ...state() });
  }

  // where the music is, in floats of the stream (frames times channels)
  const clock = (r) => Math.floor(((Date.now() - r.t0) / 1000) * RATE) * channels;

  function tick(r, me) {
    if (run !== r) return;
    const now = clock(r);
    if (r.total - now < LEAD / 2 && me.stdout.isPaused()) me.stdout.resume();
    // drop what the window no longer needs
    while (r.chunks.length > 1 && r.chunks[1].at <= now - WIN) r.chunks.shift();
    const end = Math.min(now, r.total - (r.total % channels)); // whole frames only, so left stays left
    if (end < WIN) return;
    const win = new Float32Array(WIN);
    let filled = 0;
    for (const c of r.chunks) {
      const from = Math.max(c.at, end - WIN), to = Math.min(c.at + c.data.length, end);
      if (to <= from) continue;
      win.set(c.data.subarray(from - c.at, to - c.at), from - (end - WIN));
      filled += to - from;
    }
    if (filled < WIN / 2) return;
    onFrame(analyseFn(win));
  }

  return { start, stop, running: () => !!run, startedAt: () => run && { path: run.path, pos: run.pos, t0: run.t0 } };
}

module.exports = { create, analyse, levels, FREQS, RATE, N };
