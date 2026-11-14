import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import Icon from './Icon';
import useSlidingIndicator from '../hooks/useSlidingIndicator';

// Small shared building blocks so every view uses the same controls

// Grid → detail pages share the view's scroller: open details at the top, and return to
// where the grid was when going back
export const useDetailScroll = (detailKey) => {
  const gridScroll = useRef(0);
  const prevKey = useRef(detailKey);
  // Remember the list's position as it scrolls. Reading it when the detail page opens is too late:
  // the shorter page is already in the DOM by then and the browser has clamped scrollTop.
  useEffect(() => {
    const view = document.querySelector('.view');
    if (!view) return undefined;
    const onScroll = () => { if (prevKey.current == null) gridScroll.current = view.scrollTop; };
    view.addEventListener('scroll', onScroll, { passive: true });
    // the scroll event waits for the next frame, so a quick click can get there first
    view.addEventListener('click', onScroll, true);
    view.addEventListener('keydown', onScroll, true);
    return () => {
      view.removeEventListener('scroll', onScroll);
      view.removeEventListener('click', onScroll, true);
      view.removeEventListener('keydown', onScroll, true);
    };
  }, []);
  useLayoutEffect(() => {
    const view = document.querySelector('.view');
    if (!view || prevKey.current === detailKey) return;
    view.scrollTop = detailKey == null ? gridScroll.current : 0;
    prevKey.current = detailKey;
  }, [detailKey]);
};

export const Toggle = ({ checked, onChange, disabled, label }) => (
  <label className={`toggle ${disabled ? 'disabled' : ''}`}>
    <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span className="track"><span className="thumb" /></span>
    {label && <span className="toggle-label">{label}</span>}
  </label>
);

/** Pill switcher with the stretchy sliding indicator. */
export const Segmented = ({ value, options, onChange, size }) => {
  const ref = useSlidingIndicator('x', String(value));
  return (
    <div className={`segmented slider-host ${size === 'sm' ? 'sm' : ''}`} ref={ref} role="tablist">
      <span className="indicator" />
      {options.map(o => (
        <button key={String(o.value)} type="button" role="tab" className={value === o.value ? 'on' : ''} data-active={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
};

export const useClickOutside = (open, ref, onClose) => {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, ref, onClose]);
};

/** Themed dropdown. `variant="ghost"` renders the compact pill used for sort menus. */
export const Select = ({ value, options, onChange, variant, icon, align = 'left', width }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(open, ref, close);
  const current = options.find(o => o.value === value);

  return (
    <div className={`select ${variant === 'ghost' ? 'ghost' : ''} ${open ? 'open' : ''}`} ref={ref} style={width ? { width } : undefined}>
      <button type="button" className="select-btn" onClick={() => setOpen(o => !o)}>
        {icon && <Icon name={icon} style={{ width: 15, height: 15 }} />}
        <span className="select-val">{current?.label ?? value}</span>
        <Icon name="chevron" className="select-chev" />
      </button>
      {open && (
        <div className="menu" style={{ [align === 'right' ? 'right' : 'left']: 0, top: 'calc(100% + 6px)', minWidth: '100%' }}>
          {options.map(o => (
            <button key={String(o.value)} type="button" className={`menu-item ${o.value === value ? 'on' : ''}`} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.value === value ? <Icon name="check" /> : <span style={{ width: 16, flexShrink: 0 }} />}
              <span>{o.label}</span>
              {o.hint && <span className="menu-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** Overflow (⋯) menu. items: [{ label, icon, onClick, danger, sep }] */
export const MoreMenu = ({ items, title = 'More', trigger }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(open, ref, close);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      {trigger
        ? <button className="btn-ghost" onClick={() => setOpen(o => !o)} title={title}>{trigger}</button>
        : <button className={`icon-btn ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} title={title}><Icon name="more" /></button>}
      {open && (
        <div className="menu" style={{ right: 0, top: 'calc(100% + 6px)', width: 220 }}>
          {items.map((it, i) => it.sep
            ? <div key={i} className="menu-sep" />
            : (
              <button key={i} className={`menu-item ${it.danger ? 'danger' : ''}`} onClick={() => { setOpen(false); it.onClick(); }}>
                {it.icon && <Icon name={it.icon} />}{it.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
};

export const Progress = ({ value = 0, tone }) => (
  <div className={`progress ${tone ? `tone-${tone}` : ''}`}>
    <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </div>
);

export const Callout = ({ tone = 'info', icon, children }) => (
  <div className={`callout ${tone}`}>
    <Icon name={icon || (tone === 'ok' ? 'check' : tone === 'danger' || tone === 'warn' ? 'alert' : 'info')} />
    <div>{children}</div>
  </div>
);

export const Field = ({ label, hint, children }) => (
  <label className="field">
    {label && <span className="field-label">{label}</span>}
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

/** Rows inside a settings card: title + description on the left, control on the right */
export const SettingRow = ({ icon, title, desc, children, muted }) => (
  <div className={`set-row ${muted ? 'muted' : ''}`}>
    {icon && <div className="set-icon"><Icon name={icon} /></div>}
    <div className="set-text">
      <div className="set-title">{title}</div>
      {desc && <div className="set-desc">{desc}</div>}
    </div>
    {children !== undefined && <div className="set-ctl">{children}</div>}
  </div>
);

export const BackButton = ({ onClick, label = 'Back' }) => (
  <button className="icon-btn back-btn" onClick={onClick} title={label} aria-label={label}><Icon name="chevronLeft" /></button>
);

/** Modal dialog shell. Closes on Esc and backdrop click unless `persistent`. */
export const Dialog = ({ open = true, title, icon, tone, onClose, children, actions, width = 440, persistent }) => {
  useEffect(() => {
    if (!open || persistent) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, persistent, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (!persistent && e.target === e.currentTarget) onClose?.(); }}>
      <div className="card dialog" style={{ width }} role="dialog" aria-modal="true">
        <div className="dialog-head">
          {icon && <div className={`dialog-icon ${tone || ''}`}><Icon name={icon} /></div>}
          <h3>{title}</h3>
          {!persistent && onClose && <button className="icon-btn sm" onClick={onClose} aria-label="Close"><Icon name="close" /></button>}
        </div>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
};

// ===== Promise-based confirm / alert that replace window.confirm / window.alert =====
let pushDialog = null;

/** confirmDialog({ title, message, confirmLabel, danger }) → Promise<boolean> */
export const confirmDialog = (opts) => new Promise(resolve => {
  if (!pushDialog) { resolve(window.confirm(opts.message || opts.title)); return; }
  pushDialog({ ...opts, kind: 'confirm', resolve });
});

/** alertDialog({ title, message, tone }) → Promise<void> */
export const alertDialog = (opts) => new Promise(resolve => {
  if (!pushDialog) { window.alert(opts.message || opts.title); resolve(); return; }
  pushDialog({ ...opts, kind: 'alert', resolve });
});

export const DialogHost = () => {
  const [queue, setQueue] = useState([]);
  useEffect(() => {
    // Identical requests share one dialog: a loop (e.g. downloading an album without a folder set)
    // must not stack one per track, each needing its own click
    pushDialog = (d) => setQueue(q => {
      const same = q.find(x => x.kind === d.kind && x.title === d.title && x.message === d.message);
      if (!same) return [...q, d];
      const first = same.resolve;
      same.resolve = (v) => { first(v); d.resolve(v); };
      return q;
    });
    return () => { pushDialog = null; };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const done = (value) => { current.resolve(value); setQueue(q => q.slice(1)); };
  const tone = current.danger ? 'danger' : current.tone || (current.kind === 'confirm' ? 'warn' : 'info');
  const icon = current.icon || (tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'alert');

  return (
    <Dialog
      title={current.title}
      icon={icon}
      tone={tone}
      onClose={() => done(current.kind === 'confirm' ? false : undefined)}
      actions={current.kind === 'confirm' ? (
        <>
          <button className="btn-ghost" onClick={() => done(false)}>{current.cancelLabel || 'Cancel'}</button>
          <button className={current.danger ? 'btn-danger' : 'btn-primary'} onClick={() => done(true)} autoFocus>{current.confirmLabel || 'Confirm'}</button>
        </>
      ) : (
        <button className="btn-primary" onClick={() => done()} autoFocus>{current.okLabel || 'OK'}</button>
      )}
    >
      {typeof current.message === 'string'
        ? current.message.split('\n').map((line, i) => <p key={i}>{line || ' '}</p>)
        : current.message}
    </Dialog>
  );
};
