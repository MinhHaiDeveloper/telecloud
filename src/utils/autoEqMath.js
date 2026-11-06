// EQ math shared by the EQ page: filter responses, curve handling, Squiglink / EqualizerAPO
// text import-export and the AutoEQ optimizer. Pure functions, no React.

// ISO 1/3-octave centres: the default 31-band layout
export const STANDARD_FREQUENCIES = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];
export const DEFAULT_Q = 4.32; // a 1/3-octave peak
export const MAX_BANDS = 31;
export const GAIN_LIMIT = 20;
export const flatBands = () => STANDARD_FREQUENCIES.map(f => ({ freq: f, q: DEFAULT_Q, gain: 0, type: 'Peak' }));

const FS = 48000; // response preview rate (what Squiglink and most EQ tools assume)

/** Log-spaced frequency grid, 20 Hz–20 kHz */
export function logGrid(points = 480, lo = 20, hi = 20000) {
  const out = new Float64Array(points);
  for (let i = 0; i < points; i++) out[i] = lo * Math.pow(hi / lo, i / (points - 1));
  return out;
}

// RBJ cookbook biquads; shelves use Q like Squiglink's LSQ/HSQ
function coefficients({ type, freq, q, gain }) {
  const A = Math.pow(10, gain / 40);
  const w0 = 2 * Math.PI * Math.min(freq, FS * 0.49) / FS;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(q, 0.01));
  if (type === 'LSF' || type === 'HSF') {
    const s = type === 'HSF' ? -1 : 1;
    const sq = 2 * Math.sqrt(A) * alpha;
    const b0 = A * ((A + 1) - s * (A - 1) * cos + sq);
    const b1 = 2 * s * A * ((A - 1) - s * (A + 1) * cos);
    const b2 = A * ((A + 1) - s * (A - 1) * cos - sq);
    const a0 = (A + 1) + s * (A - 1) * cos + sq;
    const a1 = -2 * s * ((A - 1) + s * (A + 1) * cos);
    const a2 = (A + 1) + s * (A - 1) * cos - sq;
    return [b0, b1, b2, a0, a1, a2];
  }
  return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
}

/** Magnitude (dB) of one band at each grid frequency */
export function bandResponse(band, freqs, out = new Float64Array(freqs.length)) {
  if (!band.gain) { out.fill(0); return out; }
  const [b0, b1, b2, a0, a1, a2] = coefficients(band);
  const nb = b0 * b0 + b1 * b1 + b2 * b2, nb1 = 2 * (b0 * b1 + b1 * b2), nb2 = 2 * b0 * b2;
  const na = a0 * a0 + a1 * a1 + a2 * a2, na1 = 2 * (a0 * a1 + a1 * a2), na2 = 2 * a0 * a2;
  for (let i = 0; i < freqs.length; i++) {
    const w = 2 * Math.PI * freqs[i] / FS;
    const c1 = Math.cos(w), c2 = Math.cos(2 * w);
    out[i] = 10 * Math.log10((nb + nb1 * c1 + nb2 * c2) / (na + na1 * c1 + na2 * c2));
  }
  return out;
}

/** Sum of all band responses (dB, no preamp) */
export function totalResponse(bands, freqs) {
  const total = new Float64Array(freqs.length);
  const tmp = new Float64Array(freqs.length);
  for (const b of bands) {
    if (!b.gain) continue;
    bandResponse(b, freqs, tmp);
    for (let i = 0; i < total.length; i++) total[i] += tmp[i];
  }
  return total;
}

/** Response at a single frequency (for placing a band's handle on the curve) */
export function responseAt(bands, f) {
  return totalResponse(bands, [f])[0];
}

/** Preamp that keeps the EQ from clipping: minus the biggest boost, rounded down */
export function autoPreamp(bands, freqs = logGrid(240)) {
  const peak = Math.max(0, ...totalResponse(bands, freqs));
  return peak > 0 ? -Math.ceil(peak * 10) / 10 : 0;
}

// ---------- curves (measurements / targets) ----------

/** "frequency value" text (CSV, TSV, Squiglink .txt, REW export) → [{ x, y }] */
export function parseCurveText(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^[#*;a-z"]/i.test(t)) continue; // comments and header rows
    const parts = t.split(/[\s,;]+/);
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0) out.push({ x, y });
  }
  return out.sort((a, b) => a.x - b.x);
}

/** Resample a curve onto the grid (linear in log-frequency) */
export function resample(data, freqs) {
  const out = new Float64Array(freqs.length);
  if (!data || !data.length) return out;
  let j = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f <= data[0].x) { out[i] = data[0].y; continue; }
    if (f >= data[data.length - 1].x) { out[i] = data[data.length - 1].y; continue; }
    while (data[j + 1].x < f) j++;
    const a = data[j], b = data[j + 1];
    const t = (Math.log(f) - Math.log(a.x)) / (Math.log(b.x) - Math.log(a.x));
    out[i] = a.y + t * (b.y - a.y);
  }
  return out;
}

/** Fractional-octave smoothing on a log grid; width may vary with frequency */
export function smooth(values, freqs, octaves) {
  if (!octaves) return Float64Array.from(values);
  const width = typeof octaves === 'function' ? octaves : () => octaves;
  const step = Math.log2(freqs[1] / freqs[0]);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const half = Math.max(0, Math.round(width(freqs[i]) / 2 / step));
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) { sum += values[k]; n++; }
    out[i] = sum / n;
  }
  return out;
}

/** Mean level between lo and hi (used to line curves up) */
export function meanIn(values, freqs, lo = 300, hi = 3000) {
  let sum = 0, n = 0;
  for (let i = 0; i < freqs.length; i++) if (freqs[i] >= lo && freqs[i] <= hi) { sum += values[i]; n++; }
  return n ? sum / n : 0;
}

// ---------- Squiglink / EqualizerAPO text ----------

const TYPE_IN = { PK: 'Peak', PEQ: 'Peak', PEAK: 'Peak', LSQ: 'LSF', LSC: 'LSF', LS: 'LSF', LSF: 'LSF', HSQ: 'HSF', HSC: 'HSF', HS: 'HSF', HSF: 'HSF' };
const TYPE_OUT = { Peak: 'PK', LSF: 'LSQ', HSF: 'HSQ' };

/** Parse "Preamp: -1.9 dB" + "Filter 1: ON PK Fc 20 Hz Gain 0.5 dB Q 4.3" lines */
export function parseEqText(text) {
  let preamp = 0;
  const bands = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const pre = line.match(/^Preamp:\s*(-?[\d.]+)\s*dB/i);
    if (pre) { preamp = parseFloat(pre[1]); continue; }
    const m = line.match(/^Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Z]+)\s+Fc\s+([\d.]+)\s*(k?)Hz(?:\s+Gain\s+(-?[\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/i);
    if (!m || m[1].toUpperCase() === 'OFF') continue;
    const type = TYPE_IN[m[2].toUpperCase()];
    if (!type) continue;
    bands.push({
      type,
      freq: parseFloat(m[3]) * (m[4] ? 1000 : 1),
      gain: m[5] !== undefined ? parseFloat(m[5]) : 0,
      q: m[6] !== undefined ? parseFloat(m[6]) : (type === 'Peak' ? 1.41 : 0.71),
    });
  }
  return { preamp: Number.isFinite(preamp) ? preamp : 0, bands: bands.slice(0, MAX_BANDS) };
}

const trim = (v, d) => String(Number(v.toFixed(d)));

/** Squiglink-style export (also loads in EqualizerAPO / Peace / Wavelet) */
export function formatEqText(bands, preamp) {
  const lines = [`Preamp: ${trim(preamp, 2)} dB`];
  bands.forEach((b, i) => {
    lines.push(`Filter ${i + 1}: ON ${TYPE_OUT[b.type] || 'PK'} Fc ${trim(b.freq, b.freq < 100 ? 1 : 0)} Hz Gain ${trim(b.gain, 1)} dB Q ${trim(b.q, 2)}`);
  });
  return lines.join('\n') + '\n';
}

// ---------- Audacity / graphic curves ----------

// The points Audacity's Graphic EQ preset uses (the same in the files people share)
export const AUDACITY_FREQUENCIES = [
  10, 11.7, 13.6, 15.9, 18.5, 21.6, 25.2, 29.4, 34.3, 40, 46.6, 54.4, 63.4, 74, 86.3, 100.7, 117.5, 137, 159.8, 186.4,
  217.5, 253.6, 295.9, 345.1, 402.6, 469.6, 547.7, 638.9, 745.3, 869.3, 1014, 1182.8, 1379.7, 1609.3, 1877.2, 2189.7,
  2554.2, 2979.4, 3475.3, 4053.8, 4728.5, 5515.6, 6433.7, 7504.7, 8753.9, 10211, 11910.7, 13893.3, 16205.9, 18903.4,
];

const num = (s) => parseFloat(String(s).replace(',', '.'));

/**
 * A graphic EQ curve from text, or null when the text isn't one:
 *  - Audacity preset: GraphicEq:f0="10" … v0="0.17" …  (or FilterCurve:)
 *  - Audacity's exported curves: <point f="10" d="0.17"/>
 *  - EqualizerAPO: GraphicEQ: 20 -1.2; 31 0.4; …
 */
export function parseGraphicCurve(text) {
  const t = String(text);
  const points = [];
  if (/\bf0\s*=\s*"/.test(t) && /\bv0\s*=\s*"/.test(t)) {
    const vals = new Map([...t.matchAll(/\bv(\d+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], num(m[2])]));
    for (const m of t.matchAll(/\bf(\d+)\s*=\s*"([^"]*)"/g)) points.push({ x: num(m[2]), y: vals.get(m[1]) });
  } else if (/<point\b/i.test(t)) {
    for (const m of t.matchAll(/<point\b[^>]*?\bf\s*=\s*"([^"]*)"[^>]*?\bd\s*=\s*"([^"]*)"/gi)) points.push({ x: num(m[1]), y: num(m[2]) });
  } else {
    const m = /GraphicEQ\s*:\s*([^\r\n]*)/i.exec(t);
    if (!m) return null;
    for (const pair of m[1].split(';')) {
      const [f, g] = pair.trim().split(/\s+/);
      points.push({ x: num(f), y: num(g) });
    }
  }
  const byFreq = new Map();
  points.forEach(p => { if (Number.isFinite(p.x) && p.x > 0 && Number.isFinite(p.y)) byFreq.set(p.x, p.y); });
  const out = [...byFreq.entries()].map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x);
  return out.length >= 2 ? out : null;
}

/** Solve A x = b (small, dense) with partial pivoting */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Parametric bands that follow a graphic curve. The app's EQ is made of filters, so a curve with
 * more points than bands is approximated: bands stay where the curve changes most, and their gains
 * are solved together. `maxError` says how close it got, in dB, across 20 Hz–20 kHz.
 */
export function fitCurve(points, maxBands = MAX_BANDS) {
  const lo = Math.max(20, points[0].x);
  const hi = Math.min(20000, points[points.length - 1].x);
  let kept = points.filter(p => p.x >= 20 && p.x <= 20000);
  if (kept.length < 2) {
    kept = Array.from({ length: maxBands }, (_, i) => ({ x: 20 * Math.pow(1000, i / (maxBands - 1)), y: 0 }));
  }
  // drop the points that a straight line between their neighbours explains best
  while (kept.length > maxBands) {
    let drop = 1, least = Infinity;
    for (let i = 1; i < kept.length - 1; i++) {
      const a = kept[i - 1], b = kept[i], c = kept[i + 1];
      const t = Math.log(b.x / a.x) / Math.log(c.x / a.x);
      const miss = Math.abs(b.y - (a.y + t * (c.y - a.y)));
      if (miss < least) { least = miss; drop = i; }
    }
    kept.splice(drop, 1);
  }
  const qFor = (i) => {
    const below = kept[Math.max(0, i - 1)].x, above = kept[Math.min(kept.length - 1, i + 1)].x;
    const octaves = Math.log2(above / below) / (i === 0 || i === kept.length - 1 ? 1 : 2);
    const span = Math.pow(2, Math.max(octaves * 1.5, 0.05));
    return Number(Math.min(10, Math.sqrt(span) / (span - 1)).toFixed(2));
  };
  const freqs = logGrid(600, 20, 20000);
  const want = resample(points, freqs);
  const bands = kept.map((p, i) => ({ type: 'Peak', freq: Number(p.x.toFixed(p.x < 100 ? 1 : 0)), q: qFor(i), gain: 0 }));

  const unit = bands.map(b => bandResponse({ ...b, gain: 1 }, freqs));
  const n = bands.length;
  const AtA = bands.map((_, i) => bands.map((__, j) => {
    let s = i === j ? 1e-3 : 0; // a little damping keeps neighbours from fighting each other
    for (let k = 0; k < freqs.length; k++) s += unit[i][k] * unit[j][k];
    return s;
  }));
  // filters don't add up perfectly at higher gains: solve, measure what is left, solve again
  for (let pass = 0; pass < 4; pass++) {
    const now = totalResponse(bands, freqs);
    const Atb = unit.map(u => { let s = 0; for (let k = 0; k < freqs.length; k++) s += u[k] * (want[k] - now[k]); return s; });
    const d = solve(AtA, Atb);
    for (let i = 0; i < n; i++) bands[i].gain = Math.max(-GAIN_LIMIT, Math.min(GAIN_LIMIT, bands[i].gain + d[i]));
  }
  bands.forEach(b => { b.gain = Number(b.gain.toFixed(2)); });
  const got = totalResponse(bands, freqs);
  let maxError = 0;
  for (let k = 0; k < freqs.length; k++) if (freqs[k] >= lo && freqs[k] <= hi) maxError = Math.max(maxError, Math.abs(got[k] - want[k]));
  return { bands, preamp: autoPreamp(bands), maxError };
}

/** The current EQ as an Audacity Graphic EQ preset. The preamp goes into the curve: it has no other place. */
export function formatAudacityText(bands, preamp) {
  const gains = totalResponse(bands, AUDACITY_FREQUENCIES);
  const f = AUDACITY_FREQUENCIES.map((x, i) => `f${i}="${x}"`).join(' ');
  const v = AUDACITY_FREQUENCIES.map((x, i) => `v${i}="${Number((gains[i] + (preamp || 0)).toFixed(3))}"`).join(' ');
  return `GraphicEq:${f} FilterLength="8191" InterpolateLin="0" InterpolationMethod="B-spline" ${v} \n`;
}

// ---------- AutoEQ ----------

/**
 * Fit parametric filters so measurement + EQ follows the target.
 * Greedy placement on the largest remaining error, then a joint coordinate-descent refine.
 * Treble is smoothed more and weighted less: measurements there vary with fit and insertion depth.
 */
export function autoEq({ measurement, target, minFreq = 20, maxFreq = 16000, maxFilters = 10, maxGain = 6, maxQ = 4, shelves = true }) {
  const freqs = logGrid(400);
  const meas = resample(measurement, freqs);
  const targ = resample(target, freqs);
  const offset = meanIn(targ, freqs) - meanIn(meas, freqs);
  const rawError = targ.map((t, i) => t - meas[i] - offset);
  const error = smooth(rawError, freqs, f => (f < 3000 ? 1 / 12 : f < 7000 ? 1 / 6 : 1 / 2));
  const weight = freqs.map(f => (f < minFreq || f > maxFreq ? 0 : f > 9000 ? 0.3 : f < 30 ? 0.15 : f < 40 ? 0.35 : 1));
  const baseWeight = weight.slice();
  const clampF = (b) => (b.type === 'LSF' ? [60, 200] : b.type === 'HSF' ? [6000, 12000] : [Math.max(20, minFreq), Math.min(20000, maxFreq)]);
  const clampQ = (b) => (b.type === 'Peak' ? [0.4, maxQ] : [0.5, 1.0]);

  const filters = [];
  const resp = [];
  const eqSum = new Float64Array(freqs.length);
  // Fit error plus a cost per dB of gain (boosts cost more): stops filters fighting each
  // other and keeps the preamp, and so the loss of loudness, small
  const loss = () => {
    let s = 0;
    for (let i = 0; i < freqs.length; i++) { const r = error[i] - eqSum[i]; s += weight[i] * r * r; }
    for (const b of filters) s += Math.abs(b.gain) * (b.gain > 0 ? 4 : 2);
    // stacked filters may not boost past the gain limit either (that is what the preamp pays for)
    for (let i = 0; i < freqs.length; i++) if (eqSum[i] > maxGain) s += 40 * (eqSum[i] - maxGain) ** 2;
    return s;
  };
  const add = (b) => { const r = bandResponse(b, freqs); filters.push(b); resp.push(r); for (let i = 0; i < r.length; i++) eqSum[i] += r[i]; };
  const swap = (k, b) => {
    const old = resp[k];
    const r = bandResponse(b, freqs);
    for (let i = 0; i < r.length; i++) eqSum[i] += r[i] - old[i];
    filters[k] = b; resp[k] = r;
  };

  const refine = (passes) => {
    const steps = filters.map(() => ({ f: 0.12, g: 1.5, q: 0.25 }));
    for (let pass = 0; pass < passes; pass++) {
      let improved = false;
      for (let k = 0; k < filters.length; k++) {
        for (const p of ['g', 'f', 'q']) {
          const st = steps[k];
          let best = loss();
          let moved = false;
          for (const dir of [1, -1]) {
            const b = { ...filters[k] };
            if (p === 'g') b.gain = Math.max(-maxGain, Math.min(maxGain, b.gain + dir * st.g));
            if (p === 'f') { const [lo, hi] = clampF(b); b.freq = Math.max(lo, Math.min(hi, b.freq * Math.pow(2, dir * st.f))); }
            if (p === 'q') { const [lo, hi] = clampQ(b); b.q = Math.max(lo, Math.min(hi, b.q * Math.pow(2, dir * st.q))); }
            const prev = filters[k];
            swap(k, b);
            const l = loss();
            if (l < best - 1e-9) { best = l; moved = true; improved = true; break; }
            swap(k, prev);
          }
          if (!moved) st[p] *= 0.6;
        }
      }
      if (!improved && steps.every(s => s.g < 0.02)) break;
    }
  };

  if (shelves && minFreq < 105) add({ type: 'LSF', freq: 105, q: 0.7, gain: 0 });
  if (shelves && maxFreq >= 10000) add({ type: 'HSF', freq: 10000, q: 0.7, gain: 0 });
  if (filters.length) refine(12);

  while (filters.length < maxFilters) {
    // biggest weighted remaining error decides where the next peak goes
    let at = -1, worst = 0.25;
    for (let i = 0; i < freqs.length; i++) {
      const r = Math.abs(error[i] - eqSum[i]) * weight[i];
      if (r > worst) { worst = r; at = i; }
    }
    if (at < 0) break;
    // a peak right next to an existing one means that one isn't done yet: let refine handle it
    if (filters.some(b => b.type === 'Peak' && Math.abs(Math.log2(b.freq / freqs[at])) < 0.2)) {
      weight[at] *= 0.5;
      refine(4);
      if (weight[at] < 0.05) break;
      continue;
    }
    const r0 = error[at] - eqSum[at];
    let lo = at, hi = at;
    while (lo > 0 && Math.sign(error[lo - 1] - eqSum[lo - 1]) === Math.sign(r0) && Math.abs(error[lo - 1] - eqSum[lo - 1]) > Math.abs(r0) / 2) lo--;
    while (hi < freqs.length - 1 && Math.sign(error[hi + 1] - eqSum[hi + 1]) === Math.sign(r0) && Math.abs(error[hi + 1] - eqSum[hi + 1]) > Math.abs(r0) / 2) hi++;
    const bw = Math.max(0.1, Math.log2(freqs[hi] / freqs[lo]));
    const q = Math.sqrt(Math.pow(2, bw)) / (Math.pow(2, bw) - 1);
    add({ type: 'Peak', freq: freqs[at], q: Math.max(0.4, Math.min(maxQ, q)), gain: Math.max(-maxGain, Math.min(maxGain, r0)) });
    refine(6);
  }
  refine(40);

  // Peaks that drifted onto each other during refining do one job: merge them and refine again
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < filters.length && !merged; a++) {
      for (let b = a + 1; b < filters.length && !merged; b++) {
        const A = filters[a], B = filters[b];
        if (A.type !== 'Peak' || B.type !== 'Peak' || Math.abs(Math.log2(A.freq / B.freq)) > 0.33) continue;
        const keep = Math.abs(A.gain) >= Math.abs(B.gain) ? a : b;
        const drop = keep === a ? b : a;
        swap(keep, { ...filters[keep], gain: Math.max(-maxGain, Math.min(maxGain, A.gain + B.gain)) });
        swap(drop, { ...filters[drop], gain: 0 });
        filters.splice(drop, 1);
        resp.splice(drop, 1);
        merged = true;
      }
    }
    if (merged) refine(20);
  }

  const rounded = filters
    .filter(b => Math.abs(b.gain) >= 0.2)
    .map(b => ({ type: b.type, freq: Number(b.freq.toFixed(b.freq < 100 ? 1 : 0)), gain: Number(b.gain.toFixed(1)), q: Number(b.q.toFixed(2)) }))
    .sort((a, b) => a.freq - b.freq);
  const before = Math.sqrt(meanSquare(rawError, baseWeight));
  const after = Math.sqrt(meanSquare(rawError.map((e, i) => e - totalResponse(rounded, [freqs[i]])[0]), baseWeight));
  return { bands: rounded, preamp: autoPreamp(rounded), offset, rmsBefore: before, rmsAfter: after };
}

function meanSquare(values, weight) {
  let s = 0, w = 0;
  for (let i = 0; i < values.length; i++) { s += weight[i] * values[i] * values[i]; w += weight[i]; }
  return w ? s / w : 0;
}
