// The singing voice alone, with htdemucs (MIT, Meta) as ONNX: the network runs in ONNX Runtime, the STFT and its
// inverse run here (dsp.js), and the song is cut in 7.8 s segments that overlap by a quarter and are blended with
// a triangle, as Demucs' own apply_model does. Input: 44.1 kHz stereo. Output: 44.1 kHz mono vocals.

const { stft, istft, reflectPad } = require('./dsp');

const RATE = 44100;
const SEG = 343980; // the model's training segment (7.8 s), fixed in the ONNX file
const NFFT = 4096, HOP = 1024;
const OVERLAP = 0.25;

/** Demucs' _spec: pad so frames = ceil(len / hop), drop the top bin; complex as channels [L re, L im, R re, R im] */
function spec(chs, len) {
  const le = Math.ceil(len / HOP), pad = (HOP / 2) * 3;
  const bins = NFFT / 2; // the top bin is dropped
  const out = new Float32Array(4 * bins * le);
  chs.forEach((x, c) => {
    // pad1d reflect (pad, pad + le * hop - len); with a 7.8 s segment the signal is always long enough
    const padded = reflectPad(x, pad, pad + le * HOP - len);
    const z = stft(padded, NFFT, HOP); // frames = le + 4
    for (let b = 0; b < bins; b++) {
      for (let t = 0; t < le; t++) {
        out[((2 * c) * bins + b) * le + t] = z.re[b * z.frames + t + 2];
        out[((2 * c + 1) * bins + b) * le + t] = z.im[b * z.frames + t + 2];
      }
    }
  });
  return { data: out, frames: le };
}

/** Demucs' _ispec for one channel of the (cac) output: add the top bin and 2 frames each side, inverse, trim */
function ispec(data, c, le, len) {
  const bins = NFFT / 2 + 1, frames = le + 4, pad = (HOP / 2) * 3;
  const re = new Float32Array(bins * frames), im = new Float32Array(bins * frames);
  for (let b = 0; b < NFFT / 2; b++) {
    for (let t = 0; t < le; t++) {
      re[b * frames + t + 2] = data[((2 * c) * (NFFT / 2) + b) * le + t];
      im[b * frames + t + 2] = data[((2 * c + 1) * (NFFT / 2) + b) * le + t];
    }
  }
  const total = HOP * Math.ceil(len / HOP) + 2 * pad;
  const x = istft(re, im, bins, frames, NFFT, HOP, total);
  return x.subarray(pad, pad + len);
}

/** One segment (exactly SEG samples per channel) through the network: vocals, two channels */
async function segment(ort, session, L, R) {
  const s = spec([L, R], SEG);
  const mix = new Float32Array(2 * SEG);
  mix.set(L, 0); mix.set(R, SEG);
  const res = await session.run({
    mix: new ort.Tensor('float32', mix, [1, 2, SEG]),
    spec: new ort.Tensor('float32', s.data, [1, 4, NFFT / 2, s.frames]),
  });
  const so = res.spec_out.data, wo = res.wave_out.data;
  return [0, 1].map((c) => {
    const f = ispec(so, c, s.frames, SEG);
    const out = new Float32Array(SEG);
    for (let i = 0; i < SEG; i++) out[i] = f[i] + wo[c * SEG + i];
    return out;
  });
}

/**
 * Vocals of a whole song. `left`, `right`: Float32Array at 44.1 kHz. `onProgress(fraction)`, `isCancelled()`.
 * Returns a Float32Array, mono, 44.1 kHz.
 */
async function vocals(ort, session, left, right, { onProgress, isCancelled } = {}) {
  const n = left.length;
  // normalise by the mono mix, as Demucs' separate does; undone at the end
  let mean = 0;
  for (let i = 0; i < n; i++) mean += (left[i] + right[i]) / 2;
  mean /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = (left[i] + right[i]) / 2 - mean; v += d * d; }
  const std = Math.sqrt(v / Math.max(1, n - 1)) || 1;
  const stride = Math.floor(SEG * (1 - OVERLAP));
  // triangle weight, as apply_model (transition power 1)
  const weight = new Float32Array(SEG);
  const halfSeg = Math.floor(SEG / 2);
  for (let i = 0; i < SEG; i++) weight[i] = i < halfSeg ? i + 1 : SEG - i;
  const wmax = weight.reduce((a, b) => Math.max(a, b), 0);
  for (let i = 0; i < SEG; i++) weight[i] /= wmax;
  const out = new Float32Array(n), sum = new Float32Array(n);
  const L = new Float32Array(SEG), R = new Float32Array(SEG);
  const offsets = [];
  for (let o = 0; o < n; o += stride) offsets.push(o);
  for (let k = 0; k < offsets.length; k++) {
    if (isCancelled?.()) throw new Error('cancelled');
    const o = offsets[k], len = Math.min(SEG, n - o);
    // a short last piece is centred in a full segment that takes the audio around it, zeros past the ends
    // (TensorChunk.padded)
    const lead = Math.floor((SEG - len) / 2), start = o - lead;
    for (let i = 0; i < SEG; i++) {
      const j = start + i, inside = j >= 0 && j < n;
      L[i] = inside ? (left[j] - mean) / std : 0;
      R[i] = inside ? (right[j] - mean) / std : 0;
    }
    const [vl, vr] = await segment(ort, session, L, R);
    // the voice can never be far louder than the whole mix: a GPU that gets the numbers wrong is caught here
    let inE = 0, outE = 0, finite = true;
    for (let i = 0; i < SEG; i += 7) {
      inE += L[i] * L[i] + R[i] * R[i];
      const a = vl[i], b = vr[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { finite = false; break; }
      outE += a * a + b * b;
    }
    if (!finite || outE > 16 * inE + 1) { const e = new Error('Voice separation gave impossible numbers'); e.code = 'BAD_OUTPUT'; throw e; }
    for (let i = 0; i < len; i++) {
      const w = weight[i];
      out[o + i] += w * (vl[lead + i] + vr[lead + i]) / 2;
      sum[o + i] += w;
    }
    onProgress?.((k + 1) / offsets.length);
  }
  for (let i = 0; i < n; i++) out[i] = (sum[i] > 0 ? out[i] / sum[i] : 0) * std + mean;
  return out;
}

module.exports = { vocals, RATE, SEG, _spec: spec, _ispec: ispec };
