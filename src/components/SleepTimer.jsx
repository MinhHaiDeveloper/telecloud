import React, { useCallback, useRef, useState } from 'react';
import Icon from './Icon';
import { useClickOutside } from './ui';
import { t } from '../i18n';

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
      <button className={`icon-btn hide-sm sleep-btn ${active ? 'on' : ''}`} onClick={() => setOpen(o => !o)} title={active ? t('Sleep timer: {label}', { label }) : t('Sleep timer')} aria-label={t('Sleep timer')} aria-expanded={open}>
        <Icon name="moon" />
        {active && <span className="sleep-left mono">{label}</span>}
      </button>
      {open && (
        <div className="menu sleep-menu" role="menu">
          <div className="sleep-head">{t('Sleep timer')}{active && <b className="mono">{label}</b>}</div>
          <div className="sleep-grid">
            {MINUTES.map(m => <button key={m} className="chip" onClick={() => pick({ minutes: m })}>{m < 60 ? t('{m} min', { m }) : m === 60 ? t('1 hour') : '1 h 30'}</button>)}
            <form className="sleep-custom" onSubmit={(e) => { e.preventDefault(); if (minutes >= 1 && minutes <= 720) pick({ minutes }); }}>
              <input className="input sm mono" inputMode="numeric" placeholder={t('min')} value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 3))} aria-label={t('Minutes')} />
              <button className="chip" type="submit" disabled={!(minutes >= 1 && minutes <= 720)}>{t('Set')}</button>
            </form>
          </div>
          <div className="menu-sep" />
          <button className="menu-item" disabled={!hasTrack} onClick={() => pick({ kind: 'track' })}><Icon name="music" />{t('End of this track')}</button>
          <button className="menu-item" disabled={!hasTrack} onClick={() => pick({ kind: 'album' })}><Icon name="disc" />{t('End of this album')}</button>
          <div className="menu-item sleep-tracks">
            <Icon name="queue" />{t('After{button}{b}{button2}tracks', { button: <button className="step" onClick={() => setCount(c => Math.max(2, c - 1))} aria-label={t('Fewer')}>−</button>, b: <b className="mono">{count}</b>, button2: <button className="step" onClick={() => setCount(c => Math.min(50, c + 1))} aria-label={t('More')}>+</button> })}
            <button className="chip" disabled={!hasTrack} onClick={() => pick({ kind: 'tracks', count })}>{t('Set')}</button>
          </div>
          {active && <><div className="menu-sep" /><button className="menu-item danger" onClick={() => pick(null)}><Icon name="close" />{t('Turn off')}</button></>}
          <div className="sleep-note">{t('The last 10 seconds fade out.')}</div>
        </div>
      )}
    </div>
  );
};

export default SleepTimer;
