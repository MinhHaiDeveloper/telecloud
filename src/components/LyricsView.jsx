import React, { useMemo, useEffect, useRef } from 'react';

const TIME_TAG = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;

// Parse LRC-style synced lyrics, falling back to plain lines
export const parseLyrics = (lyrics) => {
  if (!lyrics) return { isSynced: false, lines: [] };
  const result = [];
  let hasTime = false;
  lyrics.split(/\r?\n/).forEach((line, index) => {
    const times = [];
    let match;
    TIME_TAG.lastIndex = 0;
    while ((match = TIME_TAG.exec(line)) !== null) {
      hasTime = true;
      times.push(parseInt(match[1], 10) * 60 + parseFloat(match[2]));
    }
    const text = line.replace(TIME_TAG, '').trim();
    if (times.length) times.forEach(t => result.push({ time: t, text: text || '♪' }));
    else if (!hasTime && text) result.push({ time: index, text });
  });
  return hasTime
    ? { isSynced: true, lines: result.sort((a, b) => a.time - b.time) }
    : { isSynced: false, lines: result };
};

/**
 * Lyrics list that keeps the active line centred inside its own scroll container
 * (never scrolls the page around it). Clicking a synced line seeks to it.
 */
const LyricsView = ({ lyrics, currentTime, onSeek, className = 'lyrics-scroll' }) => {
  const scrollRef = useRef(null);
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
    if (activeIndex < 0) { userScrollUntil.current = 0; box.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (Date.now() < userScrollUntil.current) return;
    const el = box.querySelector(`[data-index="${activeIndex}"]`);
    if (el) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
  }, [activeIndex]);

  if (!parsed.lines.length) {
    return <div className="lyrics-empty">No lyrics for this track yet.</div>;
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
            className={`lyric ${idx === activeIndex ? 'active' : ''} ${parsed.isSynced && idx < activeIndex ? 'past' : ''}`}
            style={parsed.isSynced && onSeek ? { cursor: 'pointer' } : undefined}
            onClick={parsed.isSynced && onSeek ? () => { userScrollUntil.current = 0; onSeek(Math.floor(line.time)); } : undefined}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
};

export default LyricsView;
