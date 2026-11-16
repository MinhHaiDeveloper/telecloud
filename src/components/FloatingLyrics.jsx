import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { WordLine } from './LyricsView';
import { parseLyrics } from '../utils/lyrics';

/**
 * The floating lyrics window's page: the line being sung, word by word when the lyrics have word times,
 * and the next one under it. Drag it anywhere; lock it and clicks go through to what is behind.
 */
export default function FloatingLyrics() {
  const [st, setSt] = useState({ lyrics: '', time: 0, playing: false, title: '', artist: '' });
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const ipc = window.ipcRenderer;
    const onUpdate = (e, s) => setSt(x => ({ ...x, ...s }));
    const onChanged = (e, s) => setLocked(!!s?.locked);
    ipc.on('lyrics-float:update', onUpdate);
    ipc.on('lyrics-float:changed', onChanged);
    ipc.invoke('lyrics-float:status').then(s => setLocked(!!s?.locked)).catch(() => {});
    return () => { ipc.removeListener?.('lyrics-float:update', onUpdate); ipc.removeListener?.('lyrics-float:changed', onChanged); };
  }, []);
  // the theme's accent, from the same storage as the main window
  useEffect(() => { try { const t = localStorage.getItem('tc-theme'); if (t) document.documentElement.dataset.theme = t.replace(/"/g, ''); } catch { /* default */ } }, []);

  const parsed = useMemo(() => parseLyrics(st.lyrics), [st.lyrics]);
  let active = -1;
  if (parsed.isSynced) for (let i = 0; i < parsed.lines.length; i++) { if (st.time >= parsed.lines[i].time - 0.3) active = i; else break; }
  const line = active >= 0 ? parsed.lines[active] : null;
  const next = parsed.isSynced ? parsed.lines[active + 1] : null;
  const empty = !parsed.lines.length ? (st.title ? 'No lyrics for this track' : 'Nothing playing') : !parsed.isSynced ? 'These lyrics have no times' : null;

  return (
    <div className={`fl ${locked ? 'locked' : ''}`}>
      <div className="fl-bar">
        <span className="fl-title">{st.title}{st.artist ? ` · ${st.artist}` : ''}</span>
        <button className="fl-btn" onClick={() => window.ipcRenderer.invoke('lyrics-float:lock', true)} title="Lock: clicks go through. Unlock from the tray or the lyrics card."><Icon name="eye" /></button>
        <button className="fl-btn" onClick={() => window.ipcRenderer.invoke('lyrics-float:toggle', false)} title="Close"><Icon name="close" /></button>
      </div>
      <div className="fl-lines">
        {empty ? <p className="fl-now fl-note">{empty}</p> : (
          <>
            <p className="fl-now" key={`now-${active}`}>
              {line?.words
                ? <WordLine line={line} nextTime={next?.time} currentTime={st.time} playing={st.playing} />
                : (line?.text || '♪')}
            </p>
            <p className="fl-next" key={`next-${active}`}>{next?.text || ''}</p>
          </>
        )}
      </div>
    </div>
  );
}
