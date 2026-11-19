// TeleCloud Cadence: word times for lyrics that only have line times, worked out on this computer.
//   1. mpv decodes the song.
//   2. Demucs (ONNX) keeps the singing voice (optional; better under loud music, the slow step).
//   3. Each line's words are fitted to the voice inside the line's own LRC window by a CTC model (align.js).
//   4. Words the models could not place get their time from their neighbours; unsure lines keep line timing.
// Works in plain Node (tests) and in the app's utility process (worker.js). Nothing here touches Electron.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const demucs = require('./demucs');
const { resample } = require('./dsp');
const { alignLine, isJapanese, CJK, HAN, KANA, RATE } = require('./align');

const MODEL_FILES = {
  demucs: 'htdemucs-vocals.onnx',
  ja: 'w2v-ja-int8.onnx',
  en: 'w2v-en-int8.onnx',
  jaVocab: 'w2v-ja-vocab.json',
  enVocab: 'w2v-en-vocab.json',
};
// a line keeps its line time only when the model placed under half its words, or its letters fit far worse than
// what the model hears there (log-probability per letter; set from the test songs)
const MIN_PLACED = 0.5;
const MAX_GAP = 14;
const LATIN = /[a-z]{2}/i; // drops ~3 % of lines on the test songs; a finer check is still to find (plan, Phase 6)

// ---------- lyrics in and out

const TIME = /\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]/g;
const toSec = (m, s) => Number(m) * 60 + Number(String(s).replace(':', '.'));
const lrcTime = (sec) => {
  const t = Math.max(0, Math.round(sec * 100));
  const m = Math.floor(t / 6000), s = (t % 6000) / 100;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

/** Line-synced LRC to [{ start, next, text }] (word tags already there are dropped; metadata lines kept apart) */
function parseLrc(text) {
  const lines = [], meta = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const times = [...raw.matchAll(TIME)];
    if (!times.length) { if (/^\s*\[[a-z]+:.*\]\s*$/i.test(raw)) meta.push(raw.trim()); continue; }
    const body = raw.replace(TIME, '').replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, '').trim();
    for (const t of times) lines.push({ start: toSec(t[1], t[2]), text: body });
  }
  lines.sort((a, b) => a.start - b.start);
  lines.forEach((l, i) => { l.next = i + 1 < lines.length ? lines[i + 1].start : null; });
  return { lines, meta };
}

/** A line's timed pieces: one per character for Japanese and Chinese, one per word otherwise; spaces stay on the piece before */
function tokenize(text) {
  const out = [];
  const re = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]|[^\s぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+|\s+/g;
  for (const m of String(text).matchAll(re)) {
    const p = m[0];
    if (/^\s+$/.test(p)) { if (out.length) out[out.length - 1].text += p; continue; }
    // small kana and the long-vowel mark belong to the syllable before
    if (out.length && /^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮー]$/.test(p) && !/\s$/.test(out[out.length - 1].text)) { out[out.length - 1].text += p; continue; }
    out.push({ text: p });
  }
  return out;
}

/** Fill the words the model left out from their neighbours, by letters; keep times in order */
function fill(starts, words, lineStart, lineEnd) {
  const n = starts.length, len = (i) => Math.max(1, words[i].text.replace(/\s/g, '').length);
  const s = starts.slice();
  for (let i = 1; i < n; i++) if (s[i] != null && s[i - 1] != null && s[i] < s[i - 1]) s[i] = s[i - 1];
  let i = 0;
  while (i < n) {
    if (s[i] != null) { i++; continue; }
    let j = i;
    while (j < n && s[j] == null) j++;
    const a = i > 0 ? s[i - 1] : lineStart;
    const aLen = i > 0 ? len(i - 1) : 0;
    const b = j < n ? s[j] : lineEnd;
    let total = aLen, acc = aLen;
    for (let k = i; k < j; k++) total += len(k);
    for (let k = i; k < j; k++) { s[k] = a + ((b - a) * acc) / Math.max(1, total); acc += len(k); }
    i = j;
  }
  return s;
}

function toEnhancedLrc(meta, lines) {
  const body = lines.map((l) => {
    if (!l.timed) return `[${lrcTime(l.start)}]${l.text}`;
    const first = Math.min(l.start, l.timed.starts[0]);
    return `[${lrcTime(first)}]${l.words.map((w, i) => `<${lrcTime(l.timed.starts[i])}>${w.text}`).join('')}<${lrcTime(l.timed.end)}>`;
  });
  return [...meta, ...body].join('\n');
}

// ---------- audio

/** Decode with mpv to raw float samples: { channels: [Float32Array], rate } */
function decode(mpvPath, file, { rate, channels }, child) {
  return new Promise((resolve, reject) => {
    const args = ['--no-config', '--no-video', '--media-controls=no', '--load-scripts=no', '--ytdl=no', '--msg-level=all=error',
      `--audio-channels=${channels === 1 ? 'mono' : 'stereo'}`, `--audio-samplerate=${rate}`, '--af=', '--of=f32le', '--oac=pcm_f32le', '--o=-', '--', file];
    const p = spawn(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child) child.current = p;
    try { require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
    const parts = [];
    let err = '';
    p.stdout.on('data', (d) => parts.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(parts);
      const n = Math.floor(buf.length / 4 / channels);
      if (!n) { reject(new Error(`mpv could not decode the file${err ? `: ${err.trim().slice(0, 200)}` : ''}`)); return; }
      const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * channels * 4));
      const out = Array.from({ length: channels }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c][i] = all[i * channels + c];
      resolve({ channels: out, rate, code });
    });
  });
}

// ---------- models

// DirectML gives Demucs silently wrong numbers when it fuses the graph's layers; unfused it is right (checked
// against the CPU to 1e-3) and still fast. WebGPU would be right too, but fails inside Electron (its own
// dxcompiler.dll is the one Windows loads).
const DML_UNFUSED = { name: 'dml', opts: { extra: { 'ep.dml.disable_graph_fusion': '1' } } };

/** An ONNX Runtime session on the first provider that loads it: { s, ep }. A provider: 'cpu' | 'dml' | { name, opts } */
async function session(ort, file, providers, log = () => {}) {
  if (!fs.existsSync(file)) throw new Error(`Missing model file: ${path.basename(file)}`);
  let last;
  for (const p of providers) {
    const name = typeof p === 'string' ? p : p.name;
    try {
      const s = await ort.InferenceSession.create(file, { graphOptimizationLevel: 'all', logSeverityLevel: 3, executionProviders: [name], ...(p.opts || {}) });
      return { s, ep: name };
    } catch (e) { last = e; if (name !== 'cpu') log(`${path.basename(file)}: ${name} not usable here (${String(e.message).slice(0, 120)})`); }
  }
  throw last;
}

/** wav2vec2's frames for n samples (its 7 convolutions) */
function w2vFrames(n) {
  const k = [10, 3, 3, 3, 3, 2, 2], st = [5, 2, 2, 2, 2, 2, 2];
  for (let i = 0; i < k.length; i++) n = Math.floor((n - k[i]) / st[i]) + 1;
  return n;
}

// A GPU compiles each new input length again (seconds each), so lines are padded with silence to steps of
// 2 s and the extra frames cut off again; the CPU takes them as they are.
const BUCKET = 32000;
function ctcRunner(ort, s, bucket) {
  return async (x) => {
    const real = x.length;
    let input = x;
    if (bucket) { input = new Float32Array(Math.ceil(real / BUCKET) * BUCKET); input.set(x); }
    const r = await s.run({ audio: new ort.Tensor('float32', input, [1, input.length]) });
    const [, frames, v] = r.logits.dims;
    const keep = bucket ? Math.min(frames, w2vFrames(real)) : frames;
    return { data: keep === frames ? r.logits.data : r.logits.data.subarray(0, keep * v), frames: keep, vocab: v };
  };
}

/** Share of frames whose most likely letter is the same in two outputs */
function agreement(a, b) {
  if (a.frames !== b.frames || a.vocab !== b.vocab) return 0;
  let same = 0;
  for (let t = 0; t < a.frames; t++) {
    let ia = 0, ib = 0;
    for (let v = 1; v < a.vocab; v++) {
      if (a.data[t * a.vocab + v] > a.data[t * a.vocab + ia]) ia = v;
      if (b.data[t * b.vocab + v] > b.data[t * b.vocab + ib]) ib = v;
    }
    if (ia === ib) same++;
  }
  return same / Math.max(1, a.frames);
}

/**
 * A CTC model. On a GPU provider, its first run is checked against the CPU once: a GPU that gives other
 * letters is dropped for the CPU (DirectML once gave Demucs silently wrong numbers on this kind of card).
 */
async function ctcModel(ort, dir, lang, providers, log) {
  const file = path.join(dir, MODEL_FILES[lang]);
  let { s, ep } = await session(ort, file, providers, log);
  const vocab = JSON.parse(fs.readFileSync(path.join(dir, MODEL_FILES[`${lang}Vocab`]), 'utf8'));
  let run = ctcRunner(ort, s, ep !== 'cpu'), checked = ep === 'cpu';
  const model = {
    lang, vocab, blank: vocab['<pad>'], get ep() { return ep; },
    async run(x) {
      if (checked) return run(x);
      checked = true;
      const gpu = await run(x);
      const cpu = await session(ort, file, ['cpu']);
      const ref = await ctcRunner(ort, cpu.s, false)(x);
      const agree = agreement(gpu, ref);
      if (agree >= 0.8) { await cpu.s.release?.(); log(`${lang} model on ${ep} (agrees with the CPU on ${(agree * 100).toFixed(0)} % of frames)`); return gpu; }
      log(`${lang} model: ${ep} disagrees with the CPU (${(agree * 100).toFixed(0)} % of frames), using the CPU`);
      await s.release?.();
      s = cpu.s; ep = 'cpu'; run = ctcRunner(ort, s, false);
      return ref;
    },
    release: () => s.release?.(),
  };
  return model;
}

/** Which model files are present in `dir` */
function modelsPresent(dir) {
  return Object.fromEntries(Object.entries(MODEL_FILES).map(([k, f]) => [k, fs.existsSync(path.join(dir, f))]));
}

// ---------- the job

/**
 * @param {object} job
 *   file, lyrics (line-synced LRC) or lines ([{ start, next, words: [{ text }] }]), mpvPath, modelsDir, ort,
 *   separate (default true), gpu (default true: DirectML, the CPU if it fails), wordsGpu (default true), onProgress,
 *   isCancelled(), log(text)
 * @returns {{ lyrics, lines, stats }}
 */
async function timeWords(job) {
  const { ort, mpvPath, modelsDir, file, onProgress = () => {}, isCancelled = () => false } = job;
  const separate = job.separate !== false;
  const gpuOn = job.gpu !== false;
  const log = job.log || (() => {});
  const t0 = Date.now(), stats = { separate };
  const check = () => { if (isCancelled()) throw new Error('cancelled'); };
  const child = job.child || {};

  let lines, meta = [];
  if (job.lines) lines = job.lines.map(l => ({ ...l, text: l.text ?? l.words.map(w => w.text).join('') }));
  else ({ lines, meta } = parseLrc(job.lyrics));
  lines = lines.filter(l => l.text && l.text.trim());
  lines.forEach((l) => { if (!l.words) l.words = tokenize(l.text); });
  if (lines.length < 2) throw new Error('The lyrics need at least two timed lines');

  // 1-2. the audio, or the voice alone, at 16 kHz mono
  let audio;
  onProgress({ stage: 'decode', done: 0 });
  if (separate) {
    const dec = await decode(mpvPath, file, { rate: demucs.RATE, channels: 2 }, child);
    check();
    stats.seconds = dec.channels[0].length / demucs.RATE;
    onProgress({ stage: 'voice', done: 0 });
    const t = Date.now();
    const dmFile = path.join(modelsDir, MODEL_FILES.demucs);
    let dm = await session(ort, dmFile, gpuOn ? [DML_UNFUSED, 'cpu'] : ['cpu'], log);
    let voice;
    try {
      const go = () => demucs.vocals(ort, dm.s, dec.channels[0], dec.channels[1], { onProgress: (f) => onProgress({ stage: 'voice', done: f }), isCancelled });
      try {
        voice = await go();
      } catch (e) {
        if (e.code !== 'BAD_OUTPUT' || dm.ep === 'cpu') throw e;
        log(`voice separation: ${dm.ep} gave impossible numbers, again on the CPU`);
        await dm.s.release?.();
        dm = await session(ort, dmFile, ['cpu']);
        voice = await go();
      }
    } finally { await dm.s.release?.(); }
    stats.voiceEp = dm.ep;
    audio = resample(voice, demucs.RATE, RATE);
    stats.voiceMs = Date.now() - t;
  } else {
    const dec = await decode(mpvPath, file, { rate: RATE, channels: 1 }, child);
    audio = dec.channels[0];
    stats.seconds = audio.length / RATE;
  }
  check();

  // 3. the words, line by line, each line with the model for its language
  const japanese = isJapanese(lines);
  const chinese = !japanese && lines.some(l => HAN.test(l.text));
  const langOf = (l) => (japanese && job.japaneseModel !== false && CJK.test(l.text) ? 'ja' : 'en');
  const t = Date.now();
  const models = {};
  try {
    for (let i = 0; i < lines.length; i++) {
      check();
      const l = lines[i], lang = langOf(l);
      if (!models[lang]) { models[lang] = await ctcModel(ort, modelsDir, lang, gpuOn && job.wordsGpu !== false ? ['dml', 'cpu'] : ['cpu'], log); models[lang].chinese = chinese; }
      const r = await alignLine(audio, l, models[lang]);
      // Latin words in a Japanese line ("baby", "I love you"): the Japanese model has no letters for them, so the
      // English model fits the same line and lends them its times
      const latin = lang === 'ja' && job.latin !== false ? l.words.map((w, k) => (LATIN.test(w.text) && !CJK.test(w.text) && r.starts[k] == null ? k : -1)).filter(k => k >= 0) : [];
      if (latin.length) {
        if (!models.en) models.en = await ctcModel(ort, modelsDir, 'en', gpuOn && job.wordsGpu !== false ? ['dml', 'cpu'] : ['cpu'], log);
        // the whole line: the Japanese model squeezes the Latin word's neighbours together (20 ms apart), so the
        // gap between them leaves the English model no room; on the whole line it finds the word (M2c test)
        const e = await alignLine(audio, l, models.en);
        let lent = 0;
        for (const k of latin) if (e.starts[k] != null) { r.starts[k] = e.starts[k]; lent++; }
        r.placed += lent;
        if (lent) l.latin = lent;
      }
      const lineEnd = l.next != null ? l.next : (r.end ?? l.start + 5);
      const ok = r.placed / l.words.length >= MIN_PLACED && r.gap <= MAX_GAP;
      l.conf = Number(r.conf.toFixed(3));
      l.placed = r.placed;
      l.gap = Number(r.gap.toFixed(3));
      l.raw = r.starts;
      l.lang = lang;
      if (ok) {
        const starts = fill(r.starts, l.words, l.start, Math.min(lineEnd, r.end ?? lineEnd));
        const end = Math.max(starts[starts.length - 1] + 0.05, Math.min(r.end ?? lineEnd, lineEnd));
        l.timed = { starts, end };
      }
      onProgress({ stage: 'words', done: (i + 1) / lines.length });
    }
  } finally {
    for (const m of Object.values(models)) await m.release();
  }
  stats.wordsEp = Object.fromEntries(Object.entries(models).map(([k, m]) => [k, m.ep]));
  stats.wordsMs = Date.now() - t;
  stats.totalMs = Date.now() - t0;
  stats.lines = lines.length;
  stats.timedLines = lines.filter(l => l.timed).length;
  stats.japanese = japanese;
  stats.chinese = chinese;
  stats.latinWords = lines.reduce((n, l) => n + (l.latin || 0), 0);
  return { lyrics: toEnhancedLrc(meta, lines), lines, stats };
}

module.exports = { timeWords, parseLrc, tokenize, fill, toEnhancedLrc, modelsPresent, MODEL_FILES, decode };
