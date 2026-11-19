// Fitting each line's known words to the singing: a wav2vec2 CTC model (Apache-2.0) gives, every 20 ms, how
// likely each letter is; Viterbi forced alignment finds where the line's letters go inside the line's own window.
// Japanese lines use a Japanese model (kana and kanji as written); every other line an English letters model,
// with other scripts romanised (romanize.js).

const { romanize } = require('./romanize');

const HAN = /[㐀-䶿一-鿿豈-﫿]/;
let pinyinLib = null;
/** Each character of a Chinese line with Han characters read as pinyin (the whole line at once, so a character
 *  with several readings gets the one its neighbours call for); other characters as they are */
function readChinese(text) {
  pinyinLib ??= require('pinyin-pro').pinyin;
  const chars = [...text];
  const read = pinyinLib(text, { toneType: 'none', type: 'array', v: true });
  return chars.length === read.length ? chars.map((c, i) => (HAN.test(c) ? read[i] : c)) : chars.map(c => (HAN.test(c) ? pinyinLib(c, { toneType: 'none', v: true }) : c));
}

const RATE = 16000;
const PAD = 0.3; // seconds of slack before the line and after the next line's start
const MAX_LINE = 30;
// Each model's steady lateness, measured on the confirmed test songs (M0, 2026-11-19)
const LAG = { ja: 0.030, en: 0.066 };

const KANA = /[぀-ヿ]/;
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/** Does a song read as Japanese: any kana anywhere (a kanji-only line in it is Japanese too) */
const isJapanese = (lines) => lines.some(l => KANA.test(l.words.map(w => w.text).join('')));

/** log-softmax of logits [frames * vocab] in place, as Float32Array */
function logSoftmax(data, frames, vocab) {
  for (let t = 0; t < frames; t++) {
    const o = t * vocab;
    let max = -Infinity;
    for (let v = 0; v < vocab; v++) if (data[o + v] > max) max = data[o + v];
    let sum = 0;
    for (let v = 0; v < vocab; v++) sum += Math.exp(data[o + v] - max);
    const lse = max + Math.log(sum);
    for (let v = 0; v < vocab; v++) data[o + v] -= lse;
  }
  return data;
}

/**
 * CTC forced alignment (the Viterbi path through blank-letter-blank states), like torchaudio's forced_align.
 * Returns, for each target, { start, end, prob } in frames, or null when the line is too short for its letters.
 */
function forcedAlign(logp, frames, vocab, ids, blank) {
  const L = ids.length, S = 2 * L + 1;
  let need = L;
  for (let i = 1; i < L; i++) if (ids[i] === ids[i - 1]) need++;
  if (!L || frames < need) return null;
  const NEG = -1e30;
  const label = (s) => (s % 2 === 0 ? blank : ids[(s - 1) >> 1]);
  let prev = new Float64Array(S).fill(NEG), cur = new Float64Array(S);
  const back = new Uint8Array(frames * S); // 0 stay, 1 from s-1, 2 from s-2
  prev[0] = logp[label(0)];
  if (S > 1) prev[1] = logp[label(1)];
  for (let t = 1; t < frames; t++) {
    const o = t * vocab;
    // states that can still reach the end in time
    const lo = Math.max(0, S - 2 * (frames - t)), hi = Math.min(S - 1, 2 * t + 1);
    cur.fill(NEG);
    for (let s = lo; s <= hi; s++) {
      let best = prev[s], from = 0;
      if (s >= 1 && prev[s - 1] > best) { best = prev[s - 1]; from = 1; }
      if (s >= 2 && s % 2 === 1 && ids[(s - 1) >> 1] !== ids[(s - 3) >> 1] && prev[s - 2] > best) { best = prev[s - 2]; from = 2; }
      if (best <= NEG / 2) continue;
      cur[s] = best + logp[o + label(s)];
      back[t * S + s] = from;
    }
    [prev, cur] = [cur, prev];
  }
  let s = S > 1 && prev[S - 2] > prev[S - 1] ? S - 2 : S - 1;
  if (prev[s] <= NEG / 2) return null;
  const score = prev[s];
  const spans = ids.map(() => ({ start: -1, end: -1, prob: 0, n: 0 }));
  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const sp = spans[(s - 1) >> 1];
      sp.start = t;
      if (sp.end < 0) sp.end = t;
      sp.prob += Math.exp(logp[t * vocab + ids[(s - 1) >> 1]]); sp.n++;
    }
    if (t > 0) s -= back[t * S + s];
  }
  const out = spans.map(sp => ({ start: sp.start, end: sp.end + 1, prob: sp.n ? sp.prob / sp.n : 0 }));
  out.score = score;
  return out;
}

/** Log-probability of the best free path (each frame's most likely symbol), the yardstick for a forced path */
function bestPath(logp, frames, vocab) {
  let sum = 0;
  for (let t = 0; t < frames; t++) {
    let m = -Infinity;
    for (let v = 0; v < vocab; v++) if (logp[t * vocab + v] > m) m = logp[t * vocab + v];
    sum += m;
  }
  return sum;
}

const hira = (c) => (c >= 'ァ' && c <= 'ヶ' ? String.fromCharCode(c.charCodeAt(0) - 0x60) : c);

/** Target letters for one line, and which word each belongs to (-1: a word gap).
 *  `chinese`: Han characters are read as pinyin (a song without kana); otherwise they give no letters. */
function targets(words, lang, vocab, chinese = false) {
  const ids = [], owner = [];
  if (lang === 'ja') {
    words.forEach((w, i) => {
      for (const c of w.text.normalize('NFKC')) {
        if (vocab[c] != null) { ids.push(vocab[c]); owner.push(i); }
        else if (vocab[hira(c)] != null) { ids.push(vocab[hira(c)]); owner.push(i); }
        // a kanji the model never saw, or Latin letters: left out, the word's time comes from its neighbours
      }
    });
    return { ids, owner };
  }
  const bar = vocab['|'];
  let texts = words.map(w => w.text);
  if (chinese && texts.some(t => HAN.test(t))) {
    const read = readChinese(texts.join(''));
    let k = 0;
    // a Chinese character is its own word: its syllable stands apart from the next one
    texts = texts.map((t) => { const n = [...t].length; const r = read.slice(k, k + n).join(''); k += n; return r; });
  }
  words.forEach((w, i) => {
    const han = chinese && HAN.test(w.text);
    if (ids.length && (han || /^\s/.test(w.text)) && ids[ids.length - 1] !== bar) { ids.push(bar); owner.push(-1); }
    for (const c of romanize(texts[i]).toUpperCase()) if (vocab[c] != null) { ids.push(vocab[c]); owner.push(i); }
    if ((han || /\s$/.test(w.text)) && ids.length && ids[ids.length - 1] !== bar) { ids.push(bar); owner.push(-1); }
  });
  while (ids.length && ids[ids.length - 1] === bar) { ids.pop(); owner.pop(); }
  while (ids.length && ids[0] === bar) { ids.shift(); owner.shift(); }
  return { ids, owner };
}

/** The window a line is searched in, seconds */
function windowOf(line, duration) {
  const a = Math.max(0, line.start - PAD);
  let b = (line.next != null ? line.next : (line.end ?? line.start + 8)) + PAD;
  b = Math.min(b, line.start + MAX_LINE, duration);
  return [a, b];
}

/**
 * Word starts (and the line's end) for one line.
 * `model`: { run(Float32Array) -> Promise<{ data, frames, vocab }>, vocab, blank, lang }
 * Returns { starts: [seconds|null], end: seconds|null, conf: 0..1 } .
 */
async function alignLine(audio, line, model) {
  const n = line.words.length;
  const none = { starts: new Array(n).fill(null), end: null, conf: 0, gap: Infinity, placed: 0 };
  const [a, b] = windowOf(line, audio.length / RATE);
  if (b - a < 0.2) return none;
  const { ids, owner } = targets(line.words, model.lang, model.vocab, model.chinese);
  if (!ids.length) return none;
  const seg = audio.subarray(Math.floor(a * RATE), Math.floor(b * RATE));
  // zero mean, unit variance, as the models were trained
  let mean = 0; for (let i = 0; i < seg.length; i++) mean += seg[i]; mean /= seg.length;
  let v = 0; for (let i = 0; i < seg.length; i++) v += (seg[i] - mean) ** 2;
  const sd = Math.sqrt(v / seg.length) + 1e-7;
  const x = new Float32Array(seg.length);
  for (let i = 0; i < seg.length; i++) x[i] = (seg[i] - mean) / sd;
  const { data, frames, vocab } = await model.run(x);
  logSoftmax(data, frames, vocab);
  const spans = forcedAlign(data, frames, vocab, ids, model.blank);
  if (!spans) return none;
  const fr = (b - a) / frames, lag = LAG[model.lang] || 0;
  const starts = new Array(n).fill(null);
  let end = null, probSum = 0, probN = 0;
  spans.forEach((sp, k) => {
    const o = owner[k];
    if (o < 0) return;
    if (starts[o] == null) starts[o] = a + sp.start * fr - lag;
    end = a + sp.end * fr - lag;
    probSum += sp.prob; probN++;
  });
  // how much worse the line's own letters fit than whatever the model hears, per letter: near 0 when the
  // words are sung there, large when the window holds other words or none
  const gap = (bestPath(data, frames, vocab) - spans.score) / ids.length;
  return { starts, end, conf: probN ? probSum / probN : 0, gap, placed: starts.filter(s => s != null).length };
}

module.exports = { readChinese, HAN, alignLine, forcedAlign, bestPath, logSoftmax, targets, isJapanese, windowOf, CJK, KANA, LAG, RATE };
