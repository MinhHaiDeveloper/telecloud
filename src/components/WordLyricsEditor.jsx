import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import WordLyricsGuide, { GUIDE_SEEN } from './WordLyricsGuide';
import { Progress, Toggle, Callout } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { parseWordLrc, toWordLrc, linesOf, fmtTime, evenWords, windowOf, splitWords } from '../utils/wordLrc';
import { t } from '../i18n';

const mb = (n) => `${Math.round(n / 1048576)} MB`;
const STAGE = { get fetch() { return t('Downloading the track from TeleCloud'); }, get decode() { return t('Reading the song'); }, get voice() { return t('Taking the music away'); }, get words() { return t('Fitting the words'); } };
// how far each stage takes the bar, with and without voice separation
const SPAN = { true: { fetch: [0, 0], decode: [0, 4], voice: [4, 70], words: [70, 100] }, false: { fetch: [0, 0], decode: [0, 10], words: [10, 100] } };

// Copied word times (Ctrl+C), kept while the app runs so they can go to another song too: per line, each word's
// start and the line's end as seconds after the line's own time
let clipboard = null; // [{ words: [{ dt, text }], end } | null]
const piecesOf = (l) => (l.words?.length ? l.words.map(w => w.text) : splitWords(l.text));

const clone = (doc) => ({ items: doc.items.map(i => (i.kind === 'line' ? { ...i, words: i.words ? i.words.map(w => ({ ...w })) : null } : i)) });

/**
 * The word-by-word tab of the lyrics dialog: every line with its words, the selected line on a timeline where
 * each word's start can be dragged, nudged with the arrow keys or tapped in time with the music, and Cadence to
 * work out the word times of the whole song on this computer.
 */
const WordLyricsEditor = ({ text, onEdit, onEditText, file, isThis, isPlaying, pos, duration, onSeek, onPlayFile, onTogglePlay, cloudOnly }) => {
  const doc = useMemo(() => parseWordLrc(text), [text]);
  const lines = useMemo(() => linesOf(doc), [doc]);
  const [sel, setSel] = useState(0);
  const [anchor, setAnchor] = useState(null); // the other end of a range of lines (Shift+click, Shift+arrows)
  const [flash, setFlash] = useState(null); // a short note after copy and paste
  const [wordDraft, setWordDraft] = useState(null); // { k, text } while a word's spelling is fixed
  const flashTimer = useRef(0);
  // the guide opens by itself the first time this tab is used
  const [guide, setGuide] = useState(() => { try { return !localStorage.getItem(GUIDE_SEEN); } catch { return false; } });
  const closeGuide = () => { setGuide(false); try { localStorage.setItem(GUIDE_SEEN, '1'); } catch { /* this session only */ } rootRef.current?.focus(); };
  const [selWord, setSelWord] = useState(null);
  const [drag, setDrag] = useState(null); // { k, time } while a word's start is dragged; k = words.length for the end
  const [tap, setTap] = useState(null); // { line, k }: the next tap times word k of that line (k = length: its end)
  const [unsure, setUnsure] = useState(() => new Set()); // lines Cadence left with their line time only
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const stripRef = useRef(null);

  const line = lines[sel];
  const [r0, r1] = anchor == null ? [sel, sel] : [Math.min(anchor, sel), Math.max(anchor, sel)];
  const inRange = (i) => i >= r0 && i <= r1;
  const say = (t) => { setFlash(t); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(null), 5000); };
  const timedCount = lines.filter(l => l.words?.length).length;

  // ---- editing: work on a copy of the document, write it back as Enhanced LRC
  const change = (fn) => {
    const next = clone(doc);
    const ls = linesOf(next);
    fn(ls);
    onEdit(toWordLrc(next));
  };
  const setWordTime = (i, k, t) => change((ls) => {
    const l = ls[i];
    if (!l.words) return;
    if (k >= l.words.length) { l.end = Math.max(t, l.words[l.words.length - 1].time + 0.05); return; }
    const lo = k > 0 ? l.words[k - 1].time + 0.02 : 0;
    const hi = k + 1 < l.words.length ? l.words[k + 1].time - 0.02 : (l.end ?? Infinity) - 0.02;
    l.words[k].time = Math.min(Math.max(t, lo), hi);
    if (k === 0) l.time = Math.min(l.time, l.words[0].time);
  });
  const shiftLine = (i, d) => change((ls) => {
    const l = ls[i];
    l.time = Math.max(0, l.time + d);
    if (l.words) l.words.forEach(w => { w.time = Math.max(0, w.time + d); });
    if (l.end != null) l.end = Math.max(0, l.end + d);
  });
  const shiftAll = (d) => change((ls) => ls.forEach((l) => {
    l.time = Math.max(0, l.time + d);
    if (l.words) l.words.forEach(w => { w.time = Math.max(0, w.time + d); });
    if (l.end != null) l.end = Math.max(0, l.end + d);
  }));
  const evenLine = (i) => change((ls) => { const e = evenWords(ls[i], ls[i + 1]?.time); if (e) { ls[i].words = e.words; ls[i].end = e.end; } });
  const clearLine = (i) => change((ls) => { ls[i].words = null; ls[i].end = null; });

  // ---- copy and paste word times: a chorus or a loop sung the same way again gets the same timing
  const copy = (cut = false) => {
    const picked = lines.slice(r0, r1 + 1);
    if (!picked.some(l => l.words?.length)) { say(t('Nothing to copy: these lines have no word times')); return; }
    clipboard = picked.map(l => (l.words?.length ? { words: l.words.map(w => ({ dt: w.time - l.time, text: w.text })), end: l.end != null ? l.end - l.time : null } : null));
    const n = clipboard.filter(Boolean).length;
    if (cut) change((ls) => { for (let i = r0; i <= r1; i++) { ls[i].words = null; ls[i].end = null; } });
    say(t('{value} the word times of {n} {n|line|lines}. Pick where they go and press Ctrl+V.', { value: cut ? t('Cut') : t('Copied'), n }));
  };
  const paste = () => {
    if (!clipboard) { say(t('Copy the word times of a line first (Ctrl+C)')); return; }
    // one copied line goes onto every picked line; several go onto the lines from the first picked one down
    const plan = clipboard.length === 1 ? Array.from({ length: r1 - r0 + 1 }, (_, j) => [r0 + j, clipboard[0]]) : clipboard.map((c, j) => [r0 + j, c]);
    // other words: the times would not fit, so those lines are left as they are
    const fits = plan.filter(([i, c]) => lines[i] && c && piecesOf(lines[i]).length === c.words.length);
    const done = fits.length, skipped = plan.filter(([i, c]) => lines[i] && c).length - done;
    if (done) {
      change((ls) => {
        for (const [i, c] of fits) {
          const l = ls[i], pieces = piecesOf(l);
          l.words = c.words.map((w, k) => ({ time: Math.max(0, l.time + w.dt), text: pieces[k] }));
          l.end = c.end != null ? l.time + c.end : null;
        }
      });
    }
    say(t('Pasted onto {done} {done|line|lines}{value}. Ctrl+Z undoes it.', { done, value: skipped ? t('; {skipped} skipped: {skipped|its words differ|their words differ} from the copied line', { skipped }) : '' }));
  };
  const setWordText = (i, k, t) => change((ls) => {
    const l = ls[i];
    if (!l.words?.[k] || !t.trim()) return;
    const space = /\s$/.test(l.words[k].text) ? ' ' : '';
    l.words[k].text = t.trim() + space;
    l.text = l.words.map(w => w.text).join('').trim();
  });

  // ---- following the music: the line and the word the song is at
  const playing = useMemo(() => {
    if (!isThis || pos == null) return { line: -1, word: -1 };
    let li = -1;
    lines.forEach((l, i) => { if (l.time <= pos + 0.05) li = i; });
    let wi = -1;
    if (li >= 0 && lines[li].words) lines[li].words.forEach((w, k) => { if (w.time <= pos + 0.02) wi = k; });
    return { line: li, word: wi };
  }, [isThis, pos, lines]);
  // keep the playing line in view in the list while tapping or playing
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-i="${tap ? tap.line : playing.line}"]`);
    if (el && listRef.current && (tap || isPlaying)) {
      const box = listRef.current.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: 'center' });
    }
  }, [playing.line, tap, isPlaying]);
  // the selected line follows the music while tapping
  useEffect(() => { if (tap) setSel(tap.line); }, [tap]);

  // ---- playing a line
  const playFrom = (t) => {
    if (!isThis) { onPlayFile?.(file); return; }
    onSeek?.(Math.max(0, t));
    if (!isPlaying) onTogglePlay?.();
  };
  const playLine = (i) => playFrom((lines[i]?.time ?? 0) - 0.4);

  // ---- tapping: each tap puts the playing time on the next word
  const startTap = (i) => {
    const l = lines[i];
    if (!l) return;
    if (!l.words?.length) evenLine(i); // words to tap into
    setTap({ line: i, k: 0 });
    setSelWord(0);
    playFrom(l.time - 1.5);
    rootRef.current?.focus();
  };
  const stamp = async () => {
    if (!tap) return;
    const t = await window.ipcRenderer.invoke('player:position').catch(() => null);
    if (t == null) return;
    const l = lines[tap.line];
    if (!l?.words) { setTap(null); return; }
    if (tap.k < l.words.length) {
      setWordTime(tap.line, tap.k, t);
      setTap({ line: tap.line, k: tap.k + 1 });
      setSelWord(tap.k + 1 < l.words.length ? tap.k + 1 : l.words.length);
      return;
    }
    // the end of the line, then on to the next line that has text (one change, so neither undoes the other)
    let n = tap.line + 1;
    while (n < lines.length && !lines[n].text.trim()) n++;
    change((ls) => {
      const cur = ls[tap.line];
      cur.end = Math.max(t, cur.words[cur.words.length - 1].time + 0.05);
      if (n < ls.length && !ls[n].words?.length) { const e = evenWords(ls[n], ls[n + 1]?.time); if (e) { ls[n].words = e.words; ls[n].end = e.end; } }
    });
    if (n >= lines.length) { setTap(null); setSelWord(null); return; }
    setTap({ line: n, k: 0 });
    setSelWord(0);
  };

  const onKeyDown = (e) => {
    if (e.target.closest('input, textarea, button.no-keys, .wlg')) return;
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (ctrl && !e.shiftKey && !e.altKey && ['c', 'x', 'v', 'a'].includes(key)) {
      e.preventDefault();
      if (key === 'c') copy();
      else if (key === 'x') copy(true);
      else if (key === 'v') paste();
      else { setAnchor(0); setSel(lines.length - 1); setSelWord(null); }
      return;
    }
    if (tap && (e.key === ' ' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey)))) { e.preventDefault(); stamp(); return; }
    // Esc stops tapping only; it must not reach the dialog, which would close and lose the edits
    if (e.key === 'Escape' && tap) { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.(); setTap(null); return; }
    if (!line) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.shiftKey) { if (anchor == null) setAnchor(sel); } else setAnchor(null);
      setSel(s => Math.max(0, Math.min(lines.length - 1, s + (e.key === 'ArrowDown' ? 1 : -1))));
      setSelWord(null);
      return;
    }
    if (e.key === 'Enter' && !ctrl && selWord != null && line.words?.[selWord]) { e.preventDefault(); setWordDraft({ k: selWord, text: line.words[selWord].text.trim() }); return; }
    if (selWord == null || !line.words) return;
    const n = line.words.length;
    if (e.key === 'Tab') { e.preventDefault(); setSelWord(k => ((k ?? -1) + (e.shiftKey ? n : 1)) % (n + 1)); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = (e.shiftKey ? 0.01 : e.altKey ? 0.2 : 0.05) * (e.key === 'ArrowLeft' ? -1 : 1);
      const cur = selWord >= n ? (line.end ?? line.words[n - 1].time + 0.3) : line.words[selWord].time;
      setWordTime(sel, selWord, cur + step);
    }
  };

  // ---- the timeline of the selected line
  const [wa, wb] = line ? windowOf(lines, sel, duration) : [0, 1];
  const xOf = (t) => `${((t - wa) / (wb - wa)) * 100}%`;
  const timeAt = (clientX) => {
    const r = stripRef.current.getBoundingClientRect();
    return wa + ((clientX - r.left) / r.width) * (wb - wa);
  };
  const beginDrag = (k) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSelWord(k);
    const move = (ev) => setDrag({ k, time: timeAt(ev.clientX) });
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      setWordTime(sel, k, timeAt(ev.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const shown = (k) => {
    if (drag?.k === k) return drag.time;
    if (!line?.words) return null;
    return k >= line.words.length ? (line.end ?? line.words[line.words.length - 1].time + 0.3) : line.words[k].time;
  };
  const ticks = useMemo(() => {
    const out = [];
    for (let t = Math.ceil(wa * 2) / 2; t <= wb; t += 0.5) out.push(t);
    return out;
  }, [wa, wb]);

  // ---- Cadence: models, running, and its progress
  const [models, setModels] = useState(null); // wordTiming:status
  const [packs, setPacks] = useState(null); // cadence:models
  const [job, setJob] = useState(null); // { stage, done } while running
  const [note, setNote] = useState(null); // { tone, text, needs? }
  const [dl, setDl] = useState(null); // { pack, done, total } while a pack downloads from here
  const [separate, setSeparate] = useState(true);
  const running = useRef(false);
  useEffect(() => {
    const ipc = window.ipcRenderer;
    const refresh = () => { ipc.invoke('wordTiming:status').then(setModels).catch(() => {}); ipc.invoke('cadence:models').then(setPacks).catch(() => {}); };
    refresh();
    const onProg = (e, p) => setJob(p);
    const onModels = (e, s) => { setPacks(s); ipc.invoke('wordTiming:status').then(setModels).catch(() => {}); };
    const onDl = (e, p) => setDl(p);
    ipcOn(ipc, 'wordTiming:progress', onProg);
    ipcOn(ipc, 'cadence:models', onModels);
    ipcOn(ipc, 'cadence:progress', onDl);
    return () => {
      ipcOff(ipc, 'wordTiming:progress', onProg);
      ipcOff(ipc, 'cadence:models', onModels);
      ipcOff(ipc, 'cadence:progress', onDl);
      if (running.current) ipc.invoke('wordTiming:cancel'); // the dialog closed while timing
    };
  }, []);
  const pack = (id) => packs?.packs.find(p => p.id === id);
  const hasLineTimes = lines.length >= 2;

  const runCadence = async ({ only = 'all', withoutJapanese = false } = {}) => {
    if (running.current) return;
    running.current = true;
    setNote(null);
    setJob({ stage: 'decode', done: 0 });
    const source = toWordLrc({ items: doc.items.map(i => (i.kind === 'line' ? { ...i, words: null, end: null } : i)) });
    const r = await window.ipcRenderer.invoke('wordTiming:run', { path: file.path, lyrics: source, separate, withoutJapanese }).catch((e) => ({ ok: false, error: e.message }));
    running.current = false;
    setJob(null);
    if (!r?.ok) {
      if (r?.error === 'cancelled') { setNote({ tone: 'info', text: t('Stopped. Nothing was changed.') }); return; }
      setNote({ tone: r?.needs ? 'warn' : 'danger', text: r?.error || t('Cadence could not time this song'), needs: r?.needs });
      return;
    }
    // match Cadence's lines to ours in order (it skips lines without text, as we do here)
    const got = linesOf(parseWordLrc(r.lyrics));
    const flags = r.lines || [];
    const next = clone(doc);
    const ls = linesOf(next).filter(l => l.text.trim());
    const nowUnsure = new Set();
    let timed = 0;
    ls.forEach((l, i) => {
      const g = got[i];
      if (only === 'missing' && l.words?.length) return;
      if (g?.words?.length && flags[i]?.timed !== false) { l.words = g.words; l.end = g.end; l.time = Math.min(l.time, g.words[0].time); timed++; } else nowUnsure.add(l.time);
    });
    onEdit(toWordLrc(next));
    setUnsure(nowUnsure);
    const s = r.stats || {};
    const secs = Math.round((s.totalMs || 0) / 1000);
    setNote({ tone: 'ok', text: t('{timed} of {length} lines timed in {secs} s{value}.{value2} Play it through and fix any word that is off.', { timed, length: ls.length, secs, value: s.separate ? '' : t(' (full mix)'), value2: nowUnsure.size ? t(' {size} kept their line time: they are marked Check.', { size: nowUnsure.size }) : '' }) });
  };
  const download = async (id, thenRun) => {
    setNote(null);
    const r = await window.ipcRenderer.invoke('cadence:download', id);
    setDl(null);
    if (!r?.ok) { if (r?.error !== 'cancelled') setNote({ tone: 'danger', text: t('Could not download: {error}', { error: r?.error }) }); return; }
    if (thenRun) runCadence();
  };
  const jobPct = job ? (() => { const span = SPAN[!!(separate && models?.separation)][job.stage] || [0, 100]; return span[0] + (span[1] - span[0]) * (job.done || 0); })() : 0;

  return (
    <div className="wle" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="wle-cadence">
        <div className="wle-cad-head">
          <Icon name="sparkle" />
          <div className="wle-cad-text">
            <b>Cadence</b>
            {note?.tone === 'ok' ? <span className="ok-text">{note.text}</span> : <span>{!hasLineTimes ? t('Sync the lines first (Sync tab): Cadence fits the words inside each line\'s time.')
                : models && !models.ready ? t('Works out when each word is sung, on this computer. It needs the English and other languages pack ({mb}).', { mb: mb(pack('en')?.size || 0) })
                  : t('Works out when each word is sung, on this computer: about a minute a song{value}. {value2}', { value: cloudOnly ? t(', once the track has downloaded from TeleCloud') : '', value2: timedCount ? t('{timedCount} of {length} lines have word times now.', { timedCount, length: lines.length }) : t('No word times yet.') })}</span>}
          </div>
          {!job && models?.separation && <span className="wle-sep" title={t('Takes the music away first: better under loud music, slower')}><Toggle checked={separate} onChange={setSeparate} label={t('Voice separation')} /></span>}
          {job
            ? <button className="btn-ghost" onClick={() => window.ipcRenderer.invoke('wordTiming:cancel')}>{t('Stop')}</button>
            : models && !models.ready
              ? (dl?.pack === 'en' ? <button className="btn-ghost" onClick={() => window.ipcRenderer.invoke('cadence:cancel')}>{t('Cancel')}</button>
                : <button className="btn-primary sm-btn" disabled={!!dl} onClick={() => download('en', hasLineTimes)}><Icon name="download" />{t('Download {mb}', { mb: mb(pack('en')?.size || 0) })}</button>)
              : (
                <>
                  {timedCount > 0 && timedCount < lines.length && <button className="btn-ghost" disabled={!hasLineTimes} onClick={() => runCadence({ only: 'missing' })} title={t('Keep the words already timed')}>{t('Only untimed lines')}</button>}
                  <button className="btn-primary sm-btn" disabled={!hasLineTimes || !models} onClick={() => runCadence()}><Icon name="sparkle" />{timedCount ? t('Time all words again') : t('Time the words')}</button>
                </>
              )}
        </div>
        {job && (
          <div className="wle-job">
            <span>{STAGE[job.stage] || t('Working')}…{job.stage === 'fetch' ? '' : ` ${Math.floor(jobPct)} %`}</span>
            <Progress value={jobPct} />
          </div>
        )}
        {dl && (
          <div className="wle-job">
            <span>{t('Downloading {title}… {mb} of {mb2}', { title: pack(dl.pack)?.title, mb: mb(dl.done), mb2: mb(dl.total) })}</span>
            <Progress value={(dl.done / dl.total) * 100} />
          </div>
        )}
        {note && note.tone !== 'ok' && (
          <Callout tone={note.tone}>
            {note.text}
            {note.needs && (
              <span className="wle-needs">
                <button className="btn-primary sm-btn" disabled={!!dl} onClick={() => download(note.needs, true)}><Icon name="download" />{t('Download {title}', { title: pack(note.needs)?.title })} ({mb(pack(note.needs)?.size || 0)})</button>
                {note.needs === 'ja' && <button className="btn-ghost" onClick={() => runCadence({ withoutJapanese: true })}>{t('Use the English model')}</button>}
              </span>
            )}
          </Callout>
        )}
      </div>

      <div className="wle-lines" ref={listRef}>
        {!lines.length && <div className="lyr-empty">{/^\s*(<\?xml[^>]*>\s*)?<tt[\s>]/i.test(text || '') ? t('These lyrics are TTML: they play word by word as they are, but are edited as text in the Sync tab.') : t('No synced lines yet. Sync the lines in the Sync tab first.')}</div>}
        {lines.map((l, i) => (
          <div
            key={i} data-i={i}
            className={`wle-line ${i === sel ? 'on' : ''} ${i !== sel && anchor != null && inRange(i) ? 'inrange' : ''} ${i === playing.line ? 'now' : ''} ${tap?.line === i ? 'tapping' : ''}`}
            onClick={(e) => {
              if (e.shiftKey) { if (anchor == null) setAnchor(sel); window.getSelection()?.removeAllRanges(); } else setAnchor(null);
              setSel(i); setSelWord(null); setWordDraft(null);
            }}
            onDoubleClick={() => playLine(i)}
          >
            <span className="mono wle-t">{fmtTime(l.time)}</span>
            <span className="wle-text">
              {l.words?.length
                ? l.words.map((w, k) => <span key={k} className={`wle-w ${i === playing.line && k === playing.word ? 'now' : ''} ${i === playing.line && k < playing.word ? 'past' : ''}`}>{w.text}</span>)
                : <span className="wle-plain">{l.text || '…'}</span>}
            </span>
            {!l.words?.length && l.text.trim() && <span className={`badge mono ${unsure.has(l.time) ? 'b-cached' : 'b-local'}`}>{unsure.has(l.time) ? t('Check') : t('Line only')}</span>}
          </div>
        ))}
      </div>

      {guide && <WordLyricsGuide onClose={closeGuide} />}
      {line && (
        <div className="wle-detail">
          <div className="wle-dhead">
            <span className="mono">{r1 > r0 ? t('Lines {value}–{value2}', { value: r0 + 1, value2: r1 + 1 }) : t('Line {value}', { value: sel + 1 })} · {fmtTime(line.time)}</span>
            {wordDraft ? (
              <form className="wle-wordedit" onSubmit={(e) => { e.preventDefault(); setWordText(sel, wordDraft.k, wordDraft.text); setWordDraft(null); rootRef.current?.focus(); }}>
                <span>{t('Word {value}', { value: wordDraft.k + 1 })}</span>
                <input className="input sm" autoFocus value={wordDraft.text} aria-label={t('Word')} onChange={(e) => setWordDraft({ ...wordDraft, text: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.(); setWordDraft(null); rootRef.current?.focus(); } }} />
                <button className="btn-primary sm-btn" type="submit">{t('Done')}</button>
              </form>
            ) : <b>{line.text || '…'}</b>}
            {flash && !tap && <span className="wle-flash">{flash}</span>}
            {tap && <span className="wle-tapping">{t('Tapping: press Space on each word, then once more at the end · Esc stops')}</span>}
            <button className="btn-ghost sm wle-guidebtn" onClick={() => setGuide(true)} title={t('Steps, the ways to fix a word, and every key')}><Icon name="info" />{t('How it works')}</button>
          </div>
          <div className="wle-strip" ref={stripRef} onPointerDown={(e) => { if (e.target === stripRef.current || e.target.classList.contains('wle-tick')) playFrom(timeAt(e.clientX)); }}>
            {ticks.map(t => <i key={t} className={`wle-tick ${Math.abs(t - Math.round(t)) < 1e-6 ? 'sec' : ''}`} style={{ left: xOf(t) }}>{Math.abs(t - Math.round(t)) < 1e-6 ? <em>{fmtTime(t).slice(0, 5)}</em> : null}</i>)}
            {line.words?.map((w, k) => {
              const a = shown(k), b = shown(k + 1);
              return (
                <div key={k} className={`wle-block ${selWord === k ? 'sel' : ''} ${tap?.line === sel && tap.k === k ? 'next' : ''} ${sel === playing.line && k === playing.word ? 'now' : ''}`}
                  style={{ left: xOf(a), width: `calc(${xOf(b)} - ${xOf(a)})` }}
                  onPointerDown={(e) => { e.stopPropagation(); setSelWord(k); }}
                  onDoubleClick={() => playFrom(a - 0.3)}
                  title={`${w.text.trim()} · ${fmtTime(a)}`}>
                  <span className="wle-grip" onPointerDown={beginDrag(k)} />
                  <span className="wle-label">{w.text.trim()}</span>
                </div>
              );
            })}
            {line.words?.length > 0 && <span className={`wle-endgrip ${selWord === line.words.length ? 'sel' : ''}`} style={{ left: xOf(shown(line.words.length)) }} onPointerDown={beginDrag(line.words.length)} title={t('Where the line ends')} />}
            {isThis && pos != null && pos >= wa && pos <= wb && <i className="wle-head" style={{ left: xOf(pos) }} />}
            {!line.words?.length && <div className="wle-nowords">{t('No word times on this line. Tap them in, spread them evenly, or let Cadence time the song.')}</div>}
          </div>
          <div className="lyr-tools wle-tools">
            <button className="btn-primary sm-btn" onClick={() => (tap ? setTap(null) : startTap(sel))} disabled={!line.text.trim()} title={t('Plays the line; press Space as each word starts')}>{tap ? t('Stop tapping') : t('Tap the words')}</button>
            <button className="btn-ghost sm" onClick={() => playLine(sel)} title={t('Play from this line (or double-click it)')}>{t('Play line')}</button>
            <span>{t('Line')}</span>
            <button className="btn-ghost sm" onClick={() => shiftLine(sel, -0.1)} title={t('The line and its words 0.1 s earlier')}>−0.1s</button>
            <button className="btn-ghost sm" onClick={() => shiftLine(sel, 0.1)} title={t('The line and its words 0.1 s later')}>+0.1s</button>
            <button className="btn-ghost sm" onClick={() => evenLine(sel)} disabled={!line.text.trim()} title={t('Spread the words over the line by their letters')}>{t('Spread evenly')}</button>
            <button className="btn-ghost sm" onClick={() => clearLine(sel)} disabled={!line.words} title={t('Back to a line time only')}>{t('Clear words')}</button>
            <button className="btn-ghost sm" onClick={() => copy()} title={t('Copy the word times of the picked lines (Ctrl+C; Shift+click picks several)')}>{t('Copy')}</button>
            <button className="btn-ghost sm" onClick={paste} disabled={!clipboard} title={t('Put the copied word times on the picked lines, from their own line time (Ctrl+V)')}>{t('Paste')}</button>
            {onEditText && <button className="btn-ghost sm" onClick={() => onEditText(line.time)} title={t('Change the words of this line in the Sync tab')}>{t('Edit text')}</button>}
            <span>{t('All')}</span>
            <button className="btn-ghost sm" onClick={() => shiftAll(-0.05)} title={t('Every line and word 0.05 s earlier')}>−0.05s</button>
            <button className="btn-ghost sm" onClick={() => shiftAll(0.05)} title={t('Every line and word 0.05 s later')}>+0.05s</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default WordLyricsEditor;
