// Lyrics on a remote: the host's lyrics for the track that plays, following the music
import React, { useEffect, useRef, useState } from 'react';
import { browse } from './api';

export default function Lyrics({ trackId, rev, pos, onSeek }) {
  const [st, setSt] = useState({ id: null, lines: [], synced: false, loading: true, error: '' });
  const box = useRef(null);
  const userAt = useRef(0);

  useEffect(() => {
    if (!trackId) { setSt({ id: null, lines: [], synced: false, loading: false, error: '' }); return undefined; }
    let live = true;
    setSt(x => ({ ...x, loading: x.id !== trackId }));
    browse({ kind: 'lyrics' }, { fresh: true })
      .then(r => { if (live) setSt({ id: r.track?.id || trackId, lines: r.lines || [], synced: !!r.synced, loading: false, error: '' }); })
      .catch(err => { if (live) setSt(x => ({ ...x, loading: false, error: err.message })); });
    return () => { live = false; };
  }, [trackId, rev]);

  // the line that is sung now (a moment early, like the app)
  let active = -1;
  if (st.synced) for (let i = 0; i < st.lines.length; i++) { if (st.lines[i].time <= pos + 0.2) active = i; else break; }

  // keep it in the middle, unless the user is reading elsewhere
  useEffect(() => {
    const el = box.current?.querySelector(`[data-i="${active}"]`);
    if (!el || Date.now() - userAt.current < 3000) return;
    const b = box.current;
    b.scrollTo({ top: el.offsetTop - b.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
  }, [active]);

  const mine = st.id === trackId;
  let body;
  if (!trackId) body = <p className="rm-lyr-note">Nothing playing.</p>;
  else if (st.loading && !mine) body = <p className="rm-lyr-note"><span className="rm-ring sm" /></p>;
  else if (st.error) body = <p className="rm-lyr-note">{st.error}</p>;
  else if (!st.lines.length) body = <p className="rm-lyr-note">No lyrics for this track yet. Find them in TeleCloud: Lyrics, then Search.</p>;
  else {
    body = st.lines.map((l, i) => (
      <p key={`${trackId}-${i}`} data-i={i}
        className={`rm-lyr-line ${!st.synced ? 'plain' : i === active ? 'on' : i < active ? 'past' : ''}`}
        onClick={st.synced && onSeek ? () => { userAt.current = 0; onSeek(l.time); } : undefined}>
        {l.text}
      </p>
    ));
  }
  return (
    <div className={`rm-lyrics ${st.synced ? 'synced' : ''}`} ref={box}
      onWheel={() => { userAt.current = Date.now(); }} onTouchMove={() => { userAt.current = Date.now(); }}>
      <div key={trackId || 'none'} className="rm-lyr-inner">{body}</div>
    </div>
  );
}
