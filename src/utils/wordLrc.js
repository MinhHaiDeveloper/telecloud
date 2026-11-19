// Lyrics as lines and words, for the word-by-word editor: Enhanced LRC in, Enhanced LRC out.
//   [mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word<mm:ss.xx>   (a time before each word, then when the last one ends)
// A line with several times ([00:10.00][01:20.00]chorus) becomes one line per time. Tag lines ([ti:...]) and
// blank lines are kept where they are.

const LINE_TIME = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const WORD_TIME = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const sec = (m, s) => Number(m) * 60 + Number(String(s).replace(':', '.'));

export const fmtTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** { items: [{ kind: 'meta' | 'blank', raw } | { kind: 'line', time, text, words: [{ time, text }] | null, end }] } */
export function parseWordLrc(text) {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const times = [...raw.matchAll(LINE_TIME)];
    if (!times.length) { items.push(raw.trim() ? { kind: 'meta', raw } : { kind: 'blank', raw }); continue; }
    const body = raw.replace(LINE_TIME, '');
    const marks = [...body.matchAll(WORD_TIME)];
    let words = null, end = null;
    if (marks.length) {
      words = [];
      marks.forEach((m, i) => {
        const from = m.index + m[0].length, to = i + 1 < marks.length ? marks[i + 1].index : body.length;
        const piece = body.slice(from, to);
        if (piece) words.push({ time: sec(m[1], m[2]), text: piece });
        else if (i === marks.length - 1) end = sec(m[1], m[2]); // the closing time
      });
      // text before the first time goes with the first word
      const lead = body.slice(0, marks[0].index);
      if (lead && words.length) words[0].text = lead + words[0].text;
      if (!words.length) words = null;
    }
    const plain = body.replace(WORD_TIME, '').trim();
    for (const t of times) {
      const time = sec(t[1], t[2]);
      // a repeated line keeps its word times only for the first time it is sung
      const own = t === times[0] && words ? words.map(w => ({ ...w })) : null;
      items.push({ kind: 'line', time, text: plain, words: own, end: own ? end : null });
    }
  }
  // lines in time order, tags and blanks left where they were relative to the first line
  const lines = items.filter(i => i.kind === 'line').sort((a, b) => a.time - b.time);
  let k = 0;
  return { items: items.map(i => (i.kind === 'line' ? lines[k++] : i)) };
}

export const linesOf = (doc) => doc.items.filter(i => i.kind === 'line');

export function toWordLrc(doc) {
  return doc.items.map((i) => {
    if (i.kind !== 'line') return i.raw;
    if (!i.words?.length) return `[${fmtTime(i.time)}]${i.text}`;
    const first = Math.min(i.time, i.words[0].time);
    const last = i.words[i.words.length - 1];
    const end = i.end != null && i.end > last.time ? i.end : last.time + 0.3;
    return `[${fmtTime(first)}]${i.words.map(w => `<${fmtTime(w.time)}>${w.text}`).join('')}<${fmtTime(end)}>`;
  }).join('\n');
}

/** A line's pieces to time: one per character for Japanese, Chinese and Korean, one per word otherwise */
export function splitWords(text) {
  const out = [];
  const CJK = '぀-ヿ㐀-䶿一-鿿豈-﫿가-힯';
  const re = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, 'g');
  for (const m of String(text).matchAll(re)) {
    const p = m[0];
    if (/^\s+$/.test(p)) { if (out.length) out[out.length - 1] += p; continue; }
    if (out.length && /^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮー]$/.test(p) && !/\s$/.test(out[out.length - 1])) { out[out.length - 1] += p; continue; }
    out.push(p);
  }
  return out;
}

/** Word times spread over the line by letters, from its start to the next line (at most 8 s) */
export function evenWords(line, next) {
  const pieces = splitWords(line.text);
  if (!pieces.length) return null;
  const end = Math.min(next ?? line.time + 5, line.time + 8);
  const len = pieces.map(p => Math.max(1, p.replace(/\s/g, '').length));
  const total = len.reduce((a, b) => a + b, 0);
  let acc = 0;
  return { words: pieces.map((p, i) => { const w = { time: line.time + ((end - line.time) * acc) / total, text: p }; acc += len[i]; return w; }), end };
}

/** The line's time window: where its words may go */
export function windowOf(lines, i, duration) {
  const l = lines[i];
  const next = lines[i + 1]?.time;
  const a = Math.max(0, l.time - 0.5);
  const b = Math.min(next != null ? next + 0.3 : (l.end ?? l.time + 6) + 1, duration || Infinity, l.time + 30);
  return [a, Math.max(b, a + 1)];
}
