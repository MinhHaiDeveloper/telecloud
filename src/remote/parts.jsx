// Small pieces the remote page shares
import React, { createContext, useContext, useEffect, useState } from 'react';
import Icon from '../components/Icon';
import useSlidingIndicator from '../hooks/useSlidingIndicator';

/** Bumped by TeleCloud when a cover or an artist picture changes: every picture address changes with it */
export const ArtRev = createContext(0);

/**
 * A picture: the artist's own (pic, its GIF first when motion), then a track's cover (id).
 * The first that answers is shown, fading in; a note when none does.
 */
export const Cover = ({ id, pic, motion = false, className = '', round = false }) => {
  const rev = useContext(ArtRev);
  const r = rev ? `?r=${rev}` : '';
  const srcs = [
    pic && motion && `/api/artist/${pic}?motion=1${rev ? `&r=${rev}` : ''}`,
    pic && `/api/artist/${pic}${r}`,
    id && `/api/cover/${id}${r}`,
  ].filter(Boolean);
  const key = srcs.join('|');
  const [state, setState] = useState({ key: null, at: 0, ok: false });
  const cur = state.key === key ? state : { key, at: 0, ok: false };
  const src = srcs[cur.at];
  return (
    <div className={`rm-cover ${round ? 'round' : ''} ${className}`}>
      {!src && <Icon name="music" />}
      {src && (
        <img key={src} src={src} alt="" draggable={false} className={cur.ok ? 'ok' : ''} loading="lazy"
          onLoad={() => setState({ key, at: cur.at, ok: true })} onError={() => setState({ key, at: cur.at + 1, ok: false })} />
      )}
    </div>
  );
};

const WHERE = {
  cloud: { label: 'Cloud', help: 'Only in TeleCloud: streams from Telegram when it plays' },
  cached: { label: 'Cached', help: 'Only in TeleCloud, already in the cache on the computer: plays at once' },
};
/** A small cloud for tracks that aren't on the computer itself */
export const Where = ({ t }) => (t?.where ? <Icon name="cloud" className={`rm-where ${t.where}`} role="img" aria-label={WHERE[t.where].help} /> : null);

export const Badges = ({ t }) => (
  <span className="rm-badges">
    {t?.where && <span className={`badge mono b-${t.where}`} title={WHERE[t.where].help}>{t.where === 'cached' ? 'Cloud · Cached' : 'Cloud'}</span>}
    {t?.quality && <span className={`badge mono b-${t.tier || 'lossless'}`}>{t.quality}</span>}
    {t?.mqa && <span className={`badge mono ${t.mqa.studio ? 'b-mqa-studio' : 'b-mqa'}`}>{t.mqa.short}</span>}
  </span>
);

/** Pill switcher with the app's stretchy sliding indicator. */
export const Pill = ({ value, options, onChange, className = '' }) => {
  const ref = useSlidingIndicator('x', value);
  return (
    <nav className={`rm-pill slider-host ${className}`} ref={ref} role="tablist">
      <span className="indicator" />
      {options.map(o => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} data-active={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} />}<span>{o.label}</span>
        </button>
      ))}
    </nav>
  );
};

/** Three moving bars on the track that plays. */
export const Playing = ({ paused }) => <span className={`rm-bars ${paused ? 'paused' : ''}`} aria-label="Playing"><i /><i /><i /></span>;

/** A sheet from the bottom (phone) or a small card (wider screens) with a few actions. */
export const Sheet = ({ open, title, sub, actions, onClose }) => {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) { setShown(true); return undefined; }
    const t = setTimeout(() => setShown(false), 220);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!shown) return null;
  return (
    <div className={`rm-sheet-wrap ${open ? 'open' : 'closing'}`} onClick={onClose}>
      <div className="rm-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rm-sheet-head"><b>{title}</b>{sub && <small>{sub}</small>}</div>
        {actions.map(a => (
          <button key={a.label} className="rm-sheet-item" onClick={() => { onClose(); a.run(); }}>
            <Icon name={a.icon} filled={a.filled} />{a.label}
          </button>
        ))}
        <button className="rm-sheet-item cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
};
