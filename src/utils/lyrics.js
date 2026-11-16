// Lyrics as TeleCloud reads them: plain lines, LRC with a time per line, Enhanced LRC with a time per word
// (<mm:ss.xx> inside a line), and TTML (Apple Music and many tools: <p begin> lines, <span begin> words).
// Every line is { time, text, words?: [{ time, text }], end? }; `end` is when the last word stops.

const LINE_TAG = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{2}(?:\.\d{1,3})?)>/g;
const sec = (m, s) => parseInt(m, 10) * 60 + parseFloat(s);

/** A line's text split at its word times. The text before the first time belongs to the line's start. */
function wordsOf(text, lineTime) {
  if (!/<\d{1,3}:\d{2}/.test(text)) return null;
  const words = [];
  let at = lineTime, last = 0, m, end = null;
  WORD_TAG.lastIndex = 0;
  while ((m = WORD_TAG.exec(text)) !== null) {
    const piece = text.slice(last, m.index);
    if (piece) words.push({ time: at, text: piece });
    at = sec(m[1], m[2]);
    last = WORD_TAG.lastIndex;
  }
  const tail = text.slice(last);
  if (tail) words.push({ time: at, text: tail });
  else end = at; // a time with nothing after it: when the last word ends
  const kept = words.filter(w => w.text.trim());
  // leading spaces belong to the word before, so the line reads the same
  for (let i = 0; i < words.length; i++) if (!words[i].text.trim() && kept.length) { const k = kept.find(w => w.time >= words[i].time) || kept[kept.length - 1]; k.text = words[i].text + k.text; }
  return kept.length ? { words: kept, end } : null;
}

// ---------- TTML
/** "01:02:03.45", "02:03.45", "3.5s", "350ms", "12.3" in seconds */
function ttmlTime(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m;
  if ((m = /^(\d+(?:\.\d+)?)ms$/.exec(s))) return parseFloat(m[1]) / 1000;
  if ((m = /^(\d+(?:\.\d+)?)s$/.exec(s))) return parseFloat(m[1]);
  if ((m = /^(\d+(?:\.\d+)?)m$/.exec(s))) return parseFloat(m[1]) * 60;
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}
export const isTtml = (text) => /^\s*(<\?xml[^>]*>\s*)?<tt[\s>]/i.test(text || '');

function parseTtml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return { isSynced: false, lines: [] };
  const lines = [];
  for (const p of Array.from(doc.getElementsByTagNameNS('*', 'p'))) {
    const begin = ttmlTime(p.getAttribute('begin'));
    const end = ttmlTime(p.getAttribute('end'));
    const words = [];
    const walk = (node) => {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) { // text between words: a space usually, kept with the word before
          const t = n.nodeValue.replace(/\s+/g, ' ');
          if (words.length) words[words.length - 1].text += t; else if (t.trim()) words.push({ time: begin ?? 0, text: t });
        } else if (n.nodeType === 1 && /span$/i.test(n.localName || n.nodeName)) {
          const b = ttmlTime(n.getAttribute('begin'));
          if (b != null && !n.getElementsByTagNameNS('*', 'span').length) words.push({ time: b, text: n.textContent.replace(/\s+/g, ' ') });
          else walk(n);
        } else if (n.nodeType === 1 && /^br$/i.test(n.localName || '')) {
          if (words.length) words[words.length - 1].text += ' ';
        }
      }
    };
    walk(p);
    const text = words.map(w => w.text).join('').replace(/\s+/g, ' ').trim() || p.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const timed = words.length > 1 && words.every(w => w.time != null);
    lines.push({ time: begin ?? (words[0]?.time ?? 0), text, ...(timed ? { words: words.filter(w => w.text.trim()).map(w => ({ time: w.time, text: w.text })), end } : {}), ...(end != null ? { end } : {}) });
  }
  const synced = lines.some(l => l.time > 0);
  return { isSynced: synced, lines: synced ? lines.sort((a, b) => a.time - b.time) : lines, words: lines.some(l => l.words) };
}

// ---------- word timings as JSON (lyrics tools export them like this): turned into Enhanced LRC,
// which every player that reads word times understands
const lrcTime = (s) => {
  const t = Math.max(0, Number(s) || 0);
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};
export const looksLikeJson = (text) => /^\s*[[{]/.test(text || '') && /"(time|start|startTime)"\s*:/.test(text || '');

/**
 * { enhancedLyrics: [{ time, text, words: [{ time, end_time, word }] }] }, or the list itself, or { lines }:
 * Enhanced LRC, one line per line, a time before each word and the last word's end. Null if it isn't that.
 */
export function enhancedJsonToLrc(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const lines = Array.isArray(data) ? data : (data?.enhancedLyrics || data?.lines || data?.lyrics);
  if (!Array.isArray(lines) || !lines.length) return null;
  const num = (...v) => v.map(Number).find(Number.isFinite);
  const out = [];
  for (const l of lines) {
    const start = num(l?.time, l?.start, l?.startTime, l?.begin);
    if (start === undefined) continue;
    const words = (Array.isArray(l.words) ? l.words : Array.isArray(l.syllables) ? l.syllables : [])
      .map(w => ({ time: num(w?.time, w?.start, w?.startTime), end: num(w?.end_time, w?.end, w?.endTime), text: String(w?.word ?? w?.text ?? '').trim() }))
      .filter(w => w.time !== undefined && w.text);
    if (words.length) {
      const last = words[words.length - 1];
      out.push(`[${lrcTime(start)}]${words.map(w => `<${lrcTime(w.time)}>${w.text}`).join(' ')}${last.end !== undefined ? `<${lrcTime(last.end)}>` : ''}`);
    } else {
      out.push(`[${lrcTime(start)}]${String(l.text ?? l.words ?? '').trim()}`);
    }
  }
  return out.length ? out.join('\n') : null;
}

/** Plain, LRC, Enhanced LRC, TTML, or word timings as JSON: { isSynced, lines, words } */
export function parseLyrics(lyrics) {
  if (!lyrics) return { isSynced: false, lines: [], words: false };
  if (isTtml(lyrics)) return parseTtml(lyrics);
  if (looksLikeJson(lyrics)) { const lrc = enhancedJsonToLrc(lyrics); if (lrc) return parseLyrics(lrc); }
  const result = [];
  let hasTime = false;
  lyrics.split(/\r?\n/).forEach((line, index) => {
    const times = [];
    let match;
    LINE_TAG.lastIndex = 0;
    while ((match = LINE_TAG.exec(line)) !== null) {
      hasTime = true;
      times.push(sec(match[1], match[2]));
    }
    const body = line.replace(LINE_TAG, '');
    const text = body.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
    if (times.length) {
      times.forEach((t) => {
        const w = wordsOf(body.trim(), t);
        result.push({ time: t, text: text || '♪', ...(w ? { words: w.words, ...(w.end != null ? { end: w.end } : {}) } : {}) });
      });
    } else if (!hasTime && text) result.push({ time: index, text });
  });
  return hasTime
    ? { isSynced: true, lines: result.sort((a, b) => a.time - b.time), words: result.some(l => l.words) }
    : { isSynced: false, lines: result, words: false };
}

/** When a word stops: the next word, the line's end, or the next line */
export function wordEnd(line, i, nextLineTime) {
  if (i + 1 < line.words.length) return line.words[i + 1].time;
  return line.end ?? nextLineTime ?? line.words[i].time + 1;
}
