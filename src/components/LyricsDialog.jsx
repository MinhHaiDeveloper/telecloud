import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { enhancedJsonToLrc, looksLikeJson, isTtml } from '../utils/lyrics';
import Icon from './Icon';
import { Dialog, Segmented, Toggle } from './ui';
import WordLyricsEditor from './WordLyricsEditor';

const readSide = () => { try { return localStorage.getItem('lyrics-side') !== '0'; } catch { return true; } };
const readFollow = () => { try { return localStorage.getItem('lyrics-follow') !== '0'; } catch { return true; } };

const TABS = [
  { value: 'sync', label: 'Sync' },
  { value: 'words', label: 'Word by word' },
];
const hasWordTimes = (t) => /<\d{1,3}:\d{2}/.test(t || '') || isTtml(t);
const SAVE_TO = [
  { value: 'tag', label: 'Tag' },
  { value: 'lrc', label: '.lrc file' },
  { value: 'both', label: 'Both' },
];
// ---- LRC timestamp helpers (for syncing by hand)
const STAMP = /^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)/;
const fmtStamp = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
};
const parseStamp = (s) => { const m = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0) : null; };
const NL = String.fromCharCode(10);
const lineAt = (text, pos) => { const start = text.lastIndexOf(NL, pos - 1) + 1; const nl = text.indexOf(NL, pos); return { start, end: nl < 0 ? text.length : nl }; };
const fmtClock = (t) => (t == null ? '--:--.--' : fmtStamp(t).slice(1, -1));

const firstLines = (text, n = 3) => (text || '').split(/\r?\n/).map(l => l.replace(/\[[^\]]*\]|<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, '').trim()) // word times too.filter(Boolean).slice(0, n);

/**
 * Search every lyrics source for a track, pick a result, edit it, save it to the tag and/or a .lrc.
 * `initial` is what the track has now (shown first so it can be edited directly).
 */
const LyricsDialog = ({ file, onClose, onSaved, playingPath, isPlaying, onPlayFile, onTogglePlay, onSeek }) => {
  const m = file?.metadata || {};
  const [title, setTitle] = useState(m.title || file?.name || '');
  const [artist, setArtist] = useState(m.artist || '');
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const [errors, setErrors] = useState({});
  const [pick, setPick] = useState(null); // index into results, or -1 for the current lyrics
  const [text, setText] = useState(m.lyrics || '');
  // word timings pasted or opened as JSON become Enhanced LRC, which other players read too
  const [converted, setConverted] = useState(false);
  const fromWordJson = (value) => {
    if (!looksLikeJson(value)) return value;
    const lrc = enhancedJsonToLrc(value);
    if (!lrc) return value;
    setConverted(true);
    return lrc;
  };
  const [saveTo, setSaveTo] = useState('tag');
  // Sync: plain and line-synced lyrics, edited as text. Word by word: word times, by hand or by Cadence.
  const [tab, setTab] = useState(() => (hasWordTimes(m.lyrics) ? 'words' : 'sync'));
  const [saving, setSaving] = useState(false);
  // the search and its results: a column that folds away, the same in both tabs, so switching tabs moves nothing
  const [side, setSideState] = useState(readSide);
  const setSide = (v) => { setSideState(v); try { localStorage.setItem('lyrics-side', v ? '1' : '0'); } catch { /* this session only */ } };
  const cloudOnly = (file?.storage_type || 'local') === 'cloud' || file?.path?.startsWith('tc://');

  // ---- syncing by hand: play the track, put the cursor on a line, press Sync line (Ctrl+Enter)
  const taRef = useRef(null);
  const original = useRef(m.lyrics || '');
  const history = useRef([]);
  const future = useRef([]); // what Undo took back, for Redo (Ctrl+Y)
  const typedAt = useRef(0); // typing in a burst is one step of Undo
  const [pos, setPos] = useState(null);
  const [caretNo, setCaretNo] = useState(0);   // the line with the cursor, shown as a band over the text
  const [scrollY, setScrollY] = useState(0);
  const [lineH, setLineH] = useState(20.8);
  const [padTop, setPadTop] = useState(13);
  const [seekDraft, setSeekDraft] = useState(null); // where the bar is dragged to, sent when it is let go
  const [follow, setFollowState] = useState(readFollow); // a second band on the line the music is at
  const setFollow = (v) => { setFollowState(v); try { localStorage.setItem('lyrics-follow', v ? '1' : '0'); } catch { /* this session only */ } };
  const userScrolledAt = useRef(0);
  const isThis = playingPath === file?.path;
  useEffect(() => {
    if (!isThis) { setPos(null); return undefined; }
    let alive = true;
    const tick = async () => { const t = await window.ipcRenderer.invoke('player:position').catch(() => null); if (alive) setPos(t); };
    tick();
    const id = setInterval(tick, 100);
    return () => { alive = false; clearInterval(id); };
  }, [isThis]);
  // where the cursor goes after a change, applied once React has put the new text in
  const pendingCaret = useRef(null);
  useLayoutEffect(() => {
    if (tab !== 'sync') return;
    const caret = pendingCaret.current;
    const ta = taRef.current;
    if (caret == null || !ta) return;
    pendingCaret.current = null;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    setCaretNo(text.slice(0, caret).split(NL).length - 1);
    // keep that line in view
    const lineNo = text.slice(0, caret).split(NL).length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    if (lineNo * lh < ta.scrollTop + lh || lineNo * lh > ta.scrollTop + ta.clientHeight - 3 * lh) ta.scrollTop = Math.max(0, lineNo * lh - ta.clientHeight / 2);
    setScrollY(ta.scrollTop);
  }, [text, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const cs = getComputedStyle(ta);
    setLineH(parseFloat(cs.lineHeight) || 20.8);
    setPadTop(ta.clientTop + (parseFloat(cs.paddingTop) || 0)); // where the first line starts, border included
  }, [tab]); // the text box is there only in the Sync tab
  const followCaret = () => { const ta = taRef.current; if (ta) setCaretNo(ta.value.slice(0, ta.selectionStart).split(NL).length - 1); };
  const lines = text.split(NL);
  const currentLine = (lines[caretNo] || '').replace(STAMP, '').replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim(); // without the word times
  const duration = m.duration || 0;
  // the synced lines, as marks along the seek bar
  const marks = useMemo(() => (duration ? lines.map(parseStamp).filter(t => t != null && t <= duration) : []), [text, duration]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownPos = seekDraft ?? (isThis ? pos || 0 : 0);
  // the line the music is at: the latest stamp already reached. Past the last stamp it stays on that line.
  const stamps = useMemo(() => lines.map(parseStamp), [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const playingNo = useMemo(() => {
    if (!follow || !isThis || pos == null) return -1;
    let best = -1;
    stamps.forEach((t, i) => { if (t != null && t <= pos + 0.05 && (best < 0 || t >= stamps[best])) best = i; });
    return best;
  }, [follow, isThis, pos, stamps]);
  // keep that line in view, unless you scrolled away a moment ago
  useEffect(() => {
    const ta = taRef.current;
    if (playingNo < 0 || !ta || Date.now() - userScrolledAt.current < 3000) return;
    const y = playingNo * lineH;
    if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - 2 * lineH) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
  }, [playingNo, lineH]);
  const commitSeek = () => { if (seekDraft != null && isThis) onSeek?.(seekDraft); setSeekDraft(null); };
  const edit = (next, caret) => {
    history.current.push(text);
    future.current = [];
    pendingCaret.current = caret;
    setText(next);
    setPick(null);
  };
  const caretLine = () => { const ta = taRef.current; return lineAt(text, ta ? ta.selectionStart : 0); };
  const syncLine = async () => {
    if (!isThis) return;
    const t = await window.ipcRenderer.invoke('player:position').catch(() => null);
    if (t == null) return;
    const { start, end } = caretLine();
    const line = text.slice(start, end).replace(STAMP, '');
    const next = text.slice(0, start) + fmtStamp(t) + line + text.slice(end);
    // move on to the next line that has words, so the next press syncs it
    let nextStart = start + fmtStamp(t).length + line.length + 1;
    while (nextStart < next.length) {
      const l = lineAt(next, nextStart);
      if (next.slice(l.start, l.end).replace(STAMP, '').trim()) break;
      nextStart = l.end + 1;
    }
    edit(next, Math.min(nextStart, next.length));
  };
  const nudgeLine = (d) => {
    const { start, end } = caretLine();
    const line = text.slice(start, end);
    const t = parseStamp(line);
    if (t == null) return;
    edit(text.slice(0, start) + fmtStamp(t + d) + line.replace(STAMP, '') + text.slice(end), start);
  };
  const offsetAll = (d) => edit(text.replace(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, (mm) => fmtStamp(parseStamp(mm) + d)), null);
  const playLine = () => {
    const t = parseStamp(text.slice(caretLine().start, caretLine().end));
    if (t == null) return;
    if (!isThis) onPlayFile?.(file); else onSeek?.(Math.max(0, t - 0.5));
  };
  const undo = () => { if (history.current.length) { future.current.push(text); setText(history.current.pop()); setPick(null); } };
  const redo = () => { if (future.current.length) { history.current.push(text); setText(future.current.pop()); setPick(null); } };
  const reset = () => { history.current.push(text); future.current = []; setText(original.current); setPick(-1); };
  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) in both tabs; the title and artist boxes keep their own
  const onKeys = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest('input')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  };
  // Edit text (Word by word tab): the Sync tab, with the cursor on that line
  const editTextAt = (time) => {
    let offset = 0, found = null;
    for (const l of text.split(NL)) {
      const stamps = [...l.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)].map(mm => Number(mm[1]) * 60 + Number(mm[2].replace(':', '.')));
      if (stamps.some(t => Math.abs(t - time) < 0.006)) { found = offset + (l.match(STAMP)?.[0].length || 0); break; }
      offset += l.length + 1;
    }
    pendingCaret.current = found ?? 0;
    setTab('sync');
  };

  const run = async () => {
    setBusy(true);
    setErrors({});
    const r = await window.ipcRenderer.invoke('lyrics:search', { all: true, track: { path: file.path, title, artist, album: m.album, duration: m.duration, lyrics: m.lyrics } });
    setResults(r?.results || []);
    setErrors(r?.errors || {});
    setBusy(false);
    // start from the best online match when the track has nothing yet
    if (!m.lyrics && r?.results?.length) { setPick(0); setText(r.results[0].lyrics); }
  };

  useEffect(() => {
    window.ipcRenderer.invoke('lyrics:options').then(o => { setOpts(o); setSaveTo(o?.saveTo || 'tag'); });
    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const label = (id) => opts?.sources?.[id]?.label || id;
  const failed = useMemo(() => Object.entries(errors), [errors]);

  const save = async () => {
    setSaving(true);
    const r = await window.ipcRenderer.invoke('lyrics:save', { path: file.path, lyrics: text, to: saveTo });
    setSaving(false);
    if (r?.success) { onSaved?.(r); onClose(); } else onSaved?.({ error: r?.error || 'Could not save' });
  };

  return (
    <Dialog
      title="Lyrics"
      icon="lyrics"
      width={1220}
      onClose={onClose}
      actions={(
        <>
          {!cloudOnly && <Segmented value={saveTo} onChange={setSaveTo} options={SAVE_TO} size="sm" />}
          {cloudOnly && <span className="cap muted" style={{ marginRight: 'auto' }}>Cloud-only track: lyrics are kept in your library and TeleCloud index.</span>}
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : text.trim() ? 'Save lyrics' : 'Remove lyrics'}</button>
        </>
      )}
    >
      <div className={`lyr ${side ? '' : 'folded'}`} onKeyDown={onKeys}>
        <div className="lyr-side" inert={!side} aria-hidden={!side}>
          <form className="lyr-query" onSubmit={(e) => { e.preventDefault(); run(); }}>
            <input className="input sm" value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
            <input className="input sm" value={artist} onChange={e => setArtist(e.target.value)} placeholder="Artist" aria-label="Artist" />
            <button className="btn-ghost sm" type="submit" disabled={busy}><Icon name="search" />{busy ? 'Searching…' : 'Search'}</button>
          </form>
          <div className="lyr-results">
            {m.lyrics && (
              <button className={`lyr-item ${pick === -1 ? 'on' : ''}`} onClick={() => { setPick(-1); setText(m.lyrics); }}>
                <div className="lyr-top"><b>Current lyrics</b><span className="badge b-local mono">{/^\s*\[\d/m.test(m.lyrics) ? 'Synced' : 'Plain'}</span></div>
                {firstLines(m.lyrics).map((l, i) => <small key={i}>{l}</small>)}
              </button>
            )}
            {results.map((r, i) => (
              <button key={i} className={`lyr-item ${pick === i ? 'on' : ''}`} onClick={() => { if (r.lyrics !== text) { history.current.push(text); future.current = []; } setPick(i); setText(r.lyrics); }}>
                <div className="lyr-top">
                  <b>{label(r.source)}</b>
                  <span className={`badge mono ${r.words ? 'b-hires' : r.synced ? 'b-lossless' : 'b-local'}`}>{r.words ? 'Word by word' : r.synced ? 'Synced' : 'Plain'}</span>
                  {r.score < 0.8 && <span className="badge b-cached mono" title="Title, artist or length differ a little">Close match</span>}
                </div>
                <small className="lyr-match">{r.title} · {r.artist}{r.album ? ` · ${r.album}` : ''}</small>
                {firstLines(r.lyrics).map((l, j) => <small key={j}>{l}</small>)}
              </button>
            ))}
            {!busy && !results.length && <div className="lyr-empty">No lyrics found. Try a shorter title, or type them in.</div>}
            {busy && <div className="lyr-empty"><span className="ring" />Asking {opts ? opts.order.filter(id => !opts.disabled.includes(id)).map(label).join(', ') : 'the sources'}…</div>}
            {failed.length > 0 && <div className="lyr-errors">{failed.map(([id, e]) => <div key={id}>{label(id)}: {e}</div>)}</div>}
          </div>
        </div>
        <div className="lyr-edit">
          <div className="lyr-tabbar">
            <button className={`icon-btn sm lyr-sidebtn ${side ? 'on' : ''}`} onClick={() => setSide(!side)} title={side ? 'Hide the search and results' : 'Show the search and results'} aria-pressed={side}><Icon name="panel" /></button>
            <Segmented value={tab} onChange={setTab} options={TABS} />
            <span className="lyr-kind">{isTtml(text) ? 'TTML: lines and words follow the music' : /<\d{1,3}:\d{2}/.test(text) ? 'Word by word (Enhanced LRC)' : /^\s*\[\d/m.test(text) ? 'Synced lines (LRC)' : text.trim() ? 'Plain text' : 'No lyrics yet'}</span>
          </div>
          <div className={`lyr-sync ${tab === 'words' ? 'compact' : ''}`}>
            <div className="lyr-transport">
              <button className="icon-btn sm" onClick={() => onSeek?.(Math.max(0, (pos || 0) - 5))} disabled={!isThis} title="Back 5 s"><Icon name="prev" /></button>
              <button className="icon-btn sm play" onClick={() => (isThis ? onTogglePlay?.() : onPlayFile?.(file))} title={isThis && isPlaying ? 'Pause' : 'Play this track'}>
                <Icon name={isThis && isPlaying ? 'pause' : 'play'} filled />
              </button>
              <button className="icon-btn sm" onClick={() => onSeek?.((pos || 0) + 5)} disabled={!isThis} title="Forward 5 s"><Icon name="next" /></button>
              <span className="mono lyr-clock">{isThis ? fmtClock(shownPos) : 'Not playing'}</span>
            </div>
            <div className="lyr-seek">
              <div className="lyr-marks" aria-hidden="true">{marks.map((t, i) => <i key={i} style={{ left: `${(t / duration) * 100}%` }} />)}</div>
              <input type="range" className="range full" min="0" max={duration || 1} step="0.01" value={shownPos} disabled={!isThis || !duration} aria-label="Position"
                style={{ '--pct': `${duration ? Math.min(100, (shownPos / duration) * 100) : 0}%` }}
                onChange={(e) => setSeekDraft(Number(e.target.value))} onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} />
              <span className="mono lyr-dur">{duration ? fmtClock(duration).replace(/\.\d+$/, '') : ''}</span>
            </div>
            {tab === 'sync' && <button className="btn-primary lyr-syncbtn" onClick={syncLine} disabled={!isThis} title="Put the current time on the line with the cursor, then go to the next line (Ctrl+Enter)">
              Sync line <kbd>Ctrl+Enter</kbd>
            </button>}
            {tab === 'sync' && <div className="lyr-current" title="The line with the cursor: Sync line puts the time on it">
              <span className="mono">Line {caretNo + 1}</span>
              <b>{currentLine || (lines[caretNo]?.trim() ? lines[caretNo].trim() : 'Empty line')}</b>
              <span className="lyr-follow" title="A green band follows the music, line by line, from the timestamps"><Toggle checked={follow} onChange={setFollow} label="Follow the music" /></span>
            </div>}
            <div className="lyr-tools">
              {tab === 'sync' && (
              <>
              <span>Line</span>
              <button className="btn-ghost sm" onClick={() => nudgeLine(-0.1)} title="Line 0.1 s earlier">−0.1s</button>
              <button className="btn-ghost sm" onClick={() => nudgeLine(0.1)} title="Line 0.1 s later">+0.1s</button>
              <button className="btn-ghost sm" onClick={playLine} title="Play from this line">Play line</button>
              <span>All</span>
              <button className="btn-ghost sm" onClick={() => offsetAll(-0.25)} title="Every line 0.25 s earlier">−0.25s</button>
              <button className="btn-ghost sm" onClick={() => offsetAll(0.25)} title="Every line 0.25 s later">+0.25s</button>
              </>
              )}
              <span className="lyr-sp" />
              <button className="btn-ghost sm" onClick={undo} title="Undo the last change (Ctrl+Z)">Undo</button>
              <button className="btn-ghost sm" onClick={redo} title="Redo what Undo took back (Ctrl+Y)">Redo</button>
              <button className="btn-ghost sm" onClick={reset} title="Back to the lyrics the track had">Reset</button>
              <label className="btn-ghost sm pressable" title="LRC, Enhanced LRC, TTML, or word timings as JSON">
                Open file…
                <input type="file" accept=".lrc,.ttml,.xml,.json,.txt,.md" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; history.current.push(text); future.current = []; setText(fromWordJson(await f.text())); setPick(null); }} />
              </label>
            </div>
          </div>
          {tab === 'words' ? (
            <WordLyricsEditor
              text={text} onEdit={(next) => edit(next, null)} onEditText={editTextAt} file={file} isThis={isThis} isPlaying={isPlaying} pos={pos}
              duration={duration} onSeek={onSeek} onPlayFile={onPlayFile} onTogglePlay={onTogglePlay} cloudOnly={cloudOnly}
            />
          ) : (
          <div className="lyr-area">
            {playingNo >= 0 && <div className="lyr-play" aria-hidden="true" style={{ transform: `translateY(${padTop + playingNo * lineH - scrollY}px)`, height: lineH }} />}
            <div className="lyr-hl" aria-hidden="true" style={{ transform: `translateY(${padTop + caretNo * lineH - scrollY}px)`, height: lineH }} />
            <textarea
              ref={taRef}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); syncLine(); } }}
              onSelect={followCaret}
              onClick={followCaret}
              onKeyUp={followCaret}
              onScroll={(e) => setScrollY(e.currentTarget.scrollTop)}
              onWheel={() => { userScrolledAt.current = Date.now(); }}
              wrap="off"
              className="input mono"
              value={text}
              onChange={e => {
                if (Date.now() - typedAt.current > 800) history.current.push(text);
                typedAt.current = Date.now();
                future.current = [];
                setText(fromWordJson(e.target.value)); setPick(null); followCaret();
              }}
              placeholder={'Type or paste lyrics. Synced lines look like:\n[00:12.40]First line\n[00:16.10]Second line'}
              spellCheck={false}
            />
          </div>
          )}
          {converted && <small className="muted">Word timings (JSON) turned into Enhanced LRC: each word lights up as it is sung.</small>}
        </div>
      </div>
    </Dialog>
  );
};

export default LyricsDialog;
