import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import Cover from './Cover';
import { Segmented } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';

// The play history put to use: what you played most lately, and what you were playing around this date in
// earlier years. On Discover and the Dashboard. Tracks no longer in the library are shown, but can't play.

const DAY = 86400000;
const PERIODS = [
  { value: 'week', label: 'Week', days: 7 },
  { value: 'month', label: 'Month', days: 30 },
  { value: 'year', label: 'Year', days: 365 },
];

/** Re-read when the history grows or tracks move */
function useHistory(ask, deps) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true, t = null;
    const load = () => ask().then(r => { if (alive) setData(r || []); }).catch(() => {});
    const again = () => { clearTimeout(t); t = setTimeout(load, 600); };
    load();
    ipcOn(window.ipcRenderer, 'stats:changed', again);
    window.addEventListener('telecloud:library-changed', again);
    return () => { alive = false; clearTimeout(t); ipcOff(window.ipcRenderer, 'stats:changed', again); window.removeEventListener('telecloud:library-changed', again); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

const playable = (rows, byPath) => rows.map(r => byPath.get(r.path)).filter(Boolean);

/** Most played this week, month or year: a row of covers, the play count on each */
export function MostPlayed({ byPath, onPlay, limit = 12 }) {
  const [period, setPeriod] = useState('month');
  const days = PERIODS.find(p => p.value === period).days;
  const rows = useHistory(() => window.ipcRenderer.invoke('stats:top', { from: Date.now() - days * DAY, to: Date.now() + DAY, limit }), [days, limit]);
  const files = useMemo(() => playable(rows || [], byPath), [rows, byPath]);
  if (!rows) return null;
  if (!rows.length && period === 'month') return null; // nothing played lately: no empty shelf
  return (
    <section className="hist">
      <div className="section-head">
        <span>Most played</span>
        <div className="hist-tools">
          <Segmented value={period} onChange={setPeriod} options={PERIODS.map(({ value, label }) => ({ value, label }))} size="sm" />
          <button disabled={!files.length} onClick={() => onPlay(files[0], 0, files)}>Play all</button>
        </div>
      </div>
      {rows.length ? (
        <div className="hist-row">
          {rows.map((r) => {
            const f = byPath.get(r.path);
            return (
              <button key={r.path} className={`hist-tile ${f ? '' : 'gone'}`} disabled={!f} onClick={() => onPlay(f, files.indexOf(f), files)} title={f ? `${r.title} · ${r.plays} plays` : 'No longer in your library'}>
                <Cover file={f || null} />
                <span className="hist-n mono">{r.plays}×</span>
                <b>{r.title || f?.name}</b><span>{r.artist}</span>
              </button>
            );
          })}
        </div>
      ) : <div className="hist-none muted">Nothing played this {period} yet.</div>}
    </section>
  );
}

/** On this day: around today's date in earlier years, one card per year */
export function OnThisDay({ byPath, onPlay }) {
  const years = useHistory(() => window.ipcRenderer.invoke('stats:on-this-day', {}), []);
  if (!years || !years.length) return null;
  const today = new Date().toLocaleDateString('en', { day: 'numeric', month: 'long' });
  return (
    <section className="hist">
      <div className="section-head"><span>On this day</span><span className="hist-sub">around {today}, in earlier years</span></div>
      <div className="otd">
        {years.map(y => {
          const files = playable(y.tracks, byPath);
          return (
            <div key={y.year} className="card otd-card">
              <div className="otd-head">
                <div><b>{y.ago === 1 ? 'A year ago' : `${y.ago} years ago`}</b><span>{y.year} · {y.plays} {y.plays === 1 ? 'play' : 'plays'}</span></div>
                <button className="icon-btn sm" disabled={!files.length} onClick={() => onPlay(files[0], 0, files)} title={`Play what you played then`}><Icon name="play" filled /></button>
              </div>
              <div className="otd-list">
                {y.tracks.slice(0, 5).map(t => {
                  const f = byPath.get(t.path);
                  return (
                    <button key={t.path} className={`otd-track ${f ? '' : 'gone'}`} disabled={!f} onClick={() => onPlay(f, files.indexOf(f), files)} title={f ? 'Play' : 'No longer in your library'}>
                      <Cover file={f || null} />
                      <div className="txt"><b>{t.title || f?.name}</b><span>{t.artist}</span></div>
                      {t.plays > 1 && <span className="mono muted">{t.plays}×</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
