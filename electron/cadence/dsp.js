// Signal helpers for word timing: an FFT, the STFT and inverse STFT exactly as torch computes them for Demucs
// (Hann window, centred, reflect padding, normalised), and a windowed-sinc resampler (44.1 kHz to 16 kHz).

/** In-place radix-2 complex FFT of size n (a power of two); `inverse` without the 1/n scale */
function makeFft(n) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return function fft(re, im, inverse = false) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = sgn * sin[k];
          const a = i + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

/** torch.hann_window(n) (periodic) */
function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** numpy/torch 'reflect' padding (the edge sample is not repeated) */
function reflectPad(x, left, right) {
  const n = x.length, out = new Float64Array(n + left + right);
  const at = (i) => { // reflect an index into [0, n)
    if (n === 1) return 0;
    const p = 2 * (n - 1);
    i = ((i % p) + p) % p;
    return i < n ? i : p - i;
  };
  for (let i = 0; i < out.length; i++) out[i] = x[at(i - left)];
  return out;
}

const cache = new Map();
function kit(nfft) {
  if (!cache.has(nfft)) cache.set(nfft, { fft: makeFft(nfft), win: hann(nfft) });
  return cache.get(nfft);
}

/**
 * torch.stft(x, nfft, hop, window=hann, center=True, pad_mode='reflect', normalized=True, onesided)
 * Returns { re, im } as Float32Array [bins * frames], bin-major (bin b, frame t at b * frames + t).
 */
function stft(x, nfft, hop) {
  const { fft, win } = kit(nfft);
  const xp = reflectPad(x, nfft / 2, nfft / 2);
  const frames = 1 + Math.floor((xp.length - nfft) / hop);
  const bins = nfft / 2 + 1, scale = 1 / Math.sqrt(nfft);
  const re = new Float32Array(bins * frames), im = new Float32Array(bins * frames);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  for (let t = 0; t < frames; t++) {
    const o = t * hop;
    for (let i = 0; i < nfft; i++) { fr[i] = xp[o + i] * win[i]; fi[i] = 0; }
    fft(fr, fi);
    for (let b = 0; b < bins; b++) { re[b * frames + t] = fr[b] * scale; im[b * frames + t] = fi[b] * scale; }
  }
  return { re, im, bins, frames };
}

/** torch.istft(z, nfft, hop, window=hann, center=True, normalized=True, length) for a one-sided spectrogram */
function istft(re, im, bins, frames, nfft, hop, length) {
  const { fft, win } = kit(nfft);
  const full = nfft + hop * (frames - 1);
  const out = new Float64Array(full), env = new Float64Array(full);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  const scale = Math.sqrt(nfft) / nfft; // undo the normalisation, and the inverse FFT's 1/n
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < bins; b++) { fr[b] = re[b * frames + t]; fi[b] = im[b * frames + t]; }
    for (let b = bins; b < nfft; b++) { fr[b] = fr[nfft - b]; fi[b] = -fi[nfft - b]; } // Hermitian
    fi[0] = 0; fi[nfft / 2] = 0;
    fft(fr, fi, true);
    const o = t * hop;
    for (let i = 0; i < nfft; i++) { out[o + i] += fr[i] * scale * win[i]; env[o + i] += win[i] * win[i]; }
  }
  const start = nfft / 2, res = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const k = start + i;
    if (k < full) res[i] = env[k] > 1e-11 ? out[k] / env[k] : 0;
  }
  return res;
}

/** Windowed-sinc resampler for a fixed ratio (up / down after reducing), Kaiser window, cut-off below the lower Nyquist */
function resample(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(from, to), up = to / d, down = from / d;
  const ratio = to / from, cutoff = 0.94 * Math.min(1, ratio), half = 32; // taps each side, in input samples at the lower rate
  const width = Math.ceil(half / Math.min(1, ratio));
  const beta = 8.6, i0 = (v) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (v / (2 * k)) ** 2; s += t; } return s; };
  // one filter per output phase
  const phases = [];
  for (let p = 0; p < up; p++) {
    const frac = (p * down) / up - Math.floor((p * down) / up);
    const taps = new Float64Array(2 * width + 1);
    let sum = 0;
    for (let k = -width; k <= width; k++) {
      const tt = k - frac;
      const s = tt === 0 ? cutoff : Math.sin(Math.PI * cutoff * tt) / (Math.PI * tt);
      const r = tt / (width + 1);
      const w = Math.abs(r) >= 1 ? 0 : i0(beta * Math.sqrt(1 - r * r)) / i0(beta);
      taps[k + width] = s * w; sum += s * w;
    }
    for (let k = 0; k < taps.length; k++) taps[k] /= sum;
    phases.push(taps);
  }
  const n = Math.floor((x.length * up) / down);
  const y = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const pos = (j * down) / up, base = Math.floor(pos), taps = phases[j % up];
    let acc = 0;
    for (let k = -width; k <= width; k++) {
      const idx = base + k;
      if (idx >= 0 && idx < x.length) acc += x[idx] * taps[k + width];
    }
    y[j] = acc;
  }
  return y;
}

module.exports = { makeFft, hann, reflectPad, stft, istft, resample };
