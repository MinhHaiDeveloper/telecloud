import React, { useMemo, useEffect, useRef } from 'react';

import { parseLyrics, wordEnd } from '../utils/lyrics';
import { t } from '../i18n';

// LRC, Enhanced LRC (a time per word) and TTML are read in utils/lyrics.js
export { parseLyrics };

// the clock between the player's reports: a report a little behind what is shown (it is rounded to 0.1 s
// and a moment old when it arrives) never pulls the fill back; the difference melts away instead, the fill
// running at least a quarter of its speed meanwhile. A bigger difference is a seek and is followed at once.
const JUMP = 0.45;   // s: more than this apart, the report is taken as it is (so a melt never outlasts the 0.6 s carry)
const MIN_MELT = 0.35; // s: the shortest time a difference takes to melt away
const clockAt = (c, ms) => c.t + Math.min(0.6, (ms - c.at) / 1000) + (c.drift ? c.drift * Math.max(0, 1 - (ms - c.at) / 1000 / c.melt) : 0);

/**
 * The line being sung, word by word: each word fills from left to right over its own time. The player
 * reports the position a few times a second; in between it is carried on every frame here (at most
 * 0.6 s ahead), straight on the DOM, so nothing re-renders while it moves.
 */
export const WordLine = ({ line, nextTime, currentTime, playing = true, className = 'words' }) => {
  const box = useRef(null);
  const clock = useRef({ t: currentTime, at: performance.now(), drift: 0, melt: MIN_MELT });
  // the word spans and what each shows now: found once per line, written only when a value changes, so a
  // frame usually touches the one word being sung instead of every word of the line
  const spans = useRef({ line: null, list: [], shown: [] });
  const paint = () => {
    const el = box.current;
    if (!el) return;
    const sp = spans.current;
    if (sp.line !== line || sp.list.length !== line.words.length) {
      sp.line = line; sp.list = [...el.querySelectorAll(':scope > .w')]; sp.shown = [];
    }
    const c = clock.current;
    const now = playing ? clockAt(c, performance.now()) : c.t;
    sp.list.forEach((span, i) => {
      const a = line.words[i].time, b = wordEnd(line, i, nextTime);
      const p = (now <= a ? 0 : now >= b ? 1 : (now - a) / (b - a)).toFixed(3);
      if (sp.shown[i] !== p) { sp.shown[i] = p; span.style.setProperty('--p', p); }
    });
  };
  useEffect(() => {
    const ms = performance.now();
    const shown = playing ? clockAt(clock.current, ms) : clock.current.t;
    const drift = shown - currentTime;
    clock.current = playing && Math.abs(drift) <= JUMP
      ? { t: currentTime, at: ms, drift, melt: Math.max(MIN_MELT, Math.abs(drift) / 0.75) }
      : { t: currentTime, at: ms, drift: 0, melt: MIN_MELT };
    paint();
  }, [currentTime]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing) { paint(); return undefined; }
    let id = 0;
    const loop = () => { paint(); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing, line]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={box} className={className}>{line.words.map((w, i) => <span key={i} className="w">{w.text}</span>)}</span>;
};

/**
 * Lyrics list that keeps the active line centred inside its own scroll container
 * (never scrolls the page around it). Clicking a synced line seeks to it.
 */
const LyricsView = ({ lyrics, currentTime, onSeek, className = 'lyrics-scroll', scrollMs, playing = true }) => {
  const scrollRef = useRef(null);
  const moving = useRef(0); // the running glide (see below)
  const userScrollUntil = useRef(0);
  const parsed = useMemo(() => parseLyrics(lyrics), [lyrics]);

  const activeIndex = useMemo(() => {
    if (!parsed.isSynced) return -1;
    let idx = -1;
    for (let i = 0; i < parsed.lines.length; i++) {
      if (currentTime >= parsed.lines[i].time - 0.3) idx = i;
      else break;
    }
    return idx;
  }, [parsed, currentTime]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    // the track started over (repeat, seek to 0): go back to the first line and wait there
    if (activeIndex < 0) { userScrollUntil.current = 0; cancelAnimationFrame(moving.current); box.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (Date.now() < userScrollUntil.current) return;
    const el = box.querySelector(`[data-index="${activeIndex}"]`);
    if (!el) return;
    const centre = () => el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
    if (scrollMs === undefined) { box.scrollTo({ top: centre(), behavior: 'smooth' }); return; }
    // Glide over a set time. The lines grow and shrink during it, so the target is measured every
    // frame; both finish together and the line ends up exactly in the middle.
    cancelAnimationFrame(moving.current);
    const ms = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : scrollMs;
    const from = box.scrollTop;
    const start = performance.now();
    const step = (now) => {
      const t = ms ? Math.min(1, (now - start) / ms) : 1;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      box.scrollTop = from + (centre() - from) * eased;
      if (t < 1 && Date.now() >= userScrollUntil.current) moving.current = requestAnimationFrame(step);
    };
    moving.current = requestAnimationFrame(step);
  }, [activeIndex, scrollMs]);
  useEffect(() => () => cancelAnimationFrame(moving.current), []);

  if (!parsed.lines.length) {
    return <div className="lyrics-empty">{t('No lyrics for this track yet.')}</div>;
  }

  return (
    <div
      ref={scrollRef}
      className={className}
      // Let the user read ahead for a few seconds before auto-follow resumes
      onWheel={() => { userScrollUntil.current = Date.now() + 4000; }}
    >
      <div className={`lyrics-lines ${parsed.isSynced ? '' : 'plain'}`}>
        {parsed.lines.map((line, idx) => (
          <div
            key={idx}
            data-index={idx}
            className={`lyric ${line.words ? 'has-words' : ''} ${idx === activeIndex ? 'active' : ''} ${parsed.isSynced && idx < activeIndex ? 'past' : ''}`}
            style={parsed.isSynced && onSeek ? { cursor: 'pointer' } : undefined}
            onClick={parsed.isSynced && onSeek ? () => { userScrollUntil.current = 0; onSeek(Math.floor(line.time)); } : undefined}
          >
            {idx === activeIndex && line.words
              ? <WordLine line={line} nextTime={parsed.lines[idx + 1]?.time} currentTime={currentTime} playing={playing} />
              : line.text}
          </div>
        ))}
      </div>
    </div>
  );
};

export default LyricsView;
