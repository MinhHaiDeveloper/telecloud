import React, { useCallback, useRef, useState } from 'react';
import Icon from './Icon';
import { useClickOutside } from './ui';

const MINUTES = [15, 30, 45, 60, 90];

/**
 * The player bar's sleep timer: a moon that shows what is left, and a menu above it. The music fades
 * out over the last ~10 seconds; a stop at the end of a track leaves the next one ready, paused.
 */
const SleepTimer = ({ label, active, hasTrack, onSet }) => {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [count, setCount] = useState(3);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(open, ref, close);
  const pick = (opt) => { onSet(opt); setOpen(false); };
  const minutes = Number(custom);
  return (
    <div className="sleep-wrap" ref={ref}>
      <button className={`icon-btn hide-sm sleep-btn ${active ? 'on' : ''}`} onClick={() => setOpen(o => !o)} title={active ? `Sleep timer: ${label}` : 'Sleep timer'} aria-label="Sleep timer" aria-expanded={open}>
        <Icon name="moon" />
        {active && <span className="sleep-left mono">{label}</span>}
      </button>
      {open && (
        <div className="menu sleep-menu" role="menu">
          <div className="sleep-head">Sleep timer{active && <b className="mono">{label}</b>}</div>
          <div className="sleep-grid">
            {MINUTES.map(m => <button key={m} className="chip" onClick={() => pick({ minutes: m })}>{m < 60 ? `${m} min` : m === 60 ? '1 hour' : '1 h 30'}</button>)}
            <form className="sleep-custom" onSubmit={(e) => { e.preventDefault(); if (minutes >= 1 && minutes <= 720) pick({ minutes }); }}>
              <input className="input sm mono" inputMode="numeric" placeholder="min" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 3))} aria-label="Minutes" />
              <button className="chip" type="submit" disabled={!(minutes >= 1 && minutes <= 720)}>Set</button>
            </form>
          </div>
          <div className="menu-sep" />
          <button className="menu-item" disabled={!hasTrack} onClick={() => pick({ kind: 'track' })}><Icon name="music" />End of this track</button>
          <button className="menu-item" disabled={!hasTrack} onClick={() => pick({ kind: 'album' })}><Icon name="disc" />End of this album</button>
          <div className="menu-item sleep-tracks">
            <Icon name="queue" />After
            <button className="step" onClick={() => setCount(c => Math.max(2, c - 1))} aria-label="Fewer">−</button>
            <b className="mono">{count}</b>
            <button className="step" onClick={() => setCount(c => Math.min(50, c + 1))} aria-label="More">+</button>
            tracks
            <button className="chip" disabled={!hasTrack} onClick={() => pick({ kind: 'tracks', count })}>Set</button>
          </div>
          {active && <><div className="menu-sep" /><button className="menu-item danger" onClick={() => pick(null)}><Icon name="close" />Turn off</button></>}
          <div className="sleep-note">The last 10 seconds fade out.</div>
        </div>
      )}
    </div>
  );
};

export default SleepTimer;
