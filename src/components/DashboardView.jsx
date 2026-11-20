import React, { useContext, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import Cover from './Cover';
import SongActions from './songActions';
import { Segmented } from './ui';
import { OnThisDay } from './ListeningHistory';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

// Listening statistics from the play history (electron/stats.js)

const DAY = 86400000;
const startOfDay = (value) => { const d = new Date(value); d.setHours(0, 0, 0, 0); return d.getTime(); };
const RANGES = [
  { value: 'day', get label() { return t('Today'); } },
  { value: 'week', get label() { return t('7 days'); } },
  { value: 'month', get label() { return t('30 days'); } },
  { value: 'year', get label() { return t('12 months'); } },
  { value: 'all', get label() { return t('All time'); } },
  { value: 'custom', get label() { return t('Pick dates'); } },
];
const dayInput = (value) => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fromInput = (s) => { const [y, m, d] = String(s).split('-').map(Number); return y ? new Date(y, m - 1, d).getTime() : NaN; };

// time window, bucket size and the list of bucket starts (so empty days still show as gaps)
function windowFor(range, first, custom) {
  const now = Date.now();
  const today = startOfDay(now);
  if (range === 'custom' && custom) {
    // days for up to two months, months beyond that
    const from = Math.min(custom.from, custom.to), to = Math.max(custom.from, custom.to) + DAY;
    const n = Math.round((to - from) / DAY);
    if (n <= 62) return { from, to, bucket: 'day', keys: Array.from({ length: n }, (_, i) => startOfDay(from + i * DAY + 3600000 * 3)) };
    const keys = [];
    const d = new Date(from); d.setDate(1);
    while (d.getTime() < to) { keys.push(d.getTime()); d.setMonth(d.getMonth() + 1); }
    return { from, to, bucket: 'month', keys };
  }
  if (range === 'day') return { from: today, to: today + DAY, bucket: 'hour', keys: Array.from({ length: 24 }, (_, h) => today + h * 3600000) };
  if (range === 'week' || range === 'month') {
    const n = range === 'week' ? 7 : 30;
    const keys = Array.from({ length: n }, (_, i) => startOfDay(today - (n - 1 - i) * DAY + 3600000 * 3));
    return { from: keys[0], to: today + DAY, bucket: 'day', keys };
  }
  const months = (from) => {
    const out = [];
    const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0);
    while (d.getTime() <= now) { out.push(d.getTime()); d.setMonth(d.getMonth() + 1); }
    return out;
  };
  if (range === 'year') {
    const d = new Date(today); d.setDate(1); d.setMonth(d.getMonth() - 11);
    const keys = months(d.getTime());
    return { from: keys[0], to: today + DAY, bucket: 'month', keys };
  }
  const keys = months(first || today);
  return { from: 0, to: today + DAY, bucket: 'month', keys: keys.length ? keys : [today] };
}

const fmtDuration = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return t('{m} min', { m });
  const h = Math.floor(m / 60);
  return h < 48 ? t('{h} h {value} min', { h, value: m % 60 }) : `${Math.round(h).toLocaleString()} h`;
};
const bucketLabel = (value, bucket, long = false) => {
  const d = new Date(value);
  if (bucket === 'hour') return long ? `${String(d.getHours()).padStart(2, '0')}:00–${String(d.getHours() + 1).padStart(2, '0')}:00` : String(d.getHours()).padStart(2, '0');
  if (bucket === 'month') return d.toLocaleDateString('en', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  return d.toLocaleDateString('en', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' });
};
// clean y-axis steps (1, 2, 5 × 10^n)
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(k => k * p).find(x => x >= v);
};

/** Single-series column chart with a hover tooltip; values in minutes */
const Columns = ({ data, height = 180, label, tip }) => {
  const [hover, setHover] = useState(null);
  const max = niceMax(Math.max(...data.map(d => d.v), 0));
  const W = 1000, H = height, padL = 34, padB = 22, padT = 8;
  const bw = (W - padL) / data.length;
  const barW = Math.min(24, bw * 0.62);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(data.length / 12);
  return (
    <div className="dash-chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {ticks.map(value => <line key={value} className="grid" x1={padL} x2={W} y1={y(value)} y2={y(value)} />)}
        {data.map((d, i) => {
          const x = padL + i * bw + (bw - barW) / 2;
          const h = Math.max(0, H - padB - y(d.v));
          const r = Math.min(4, h, barW / 2);
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect className="hit" x={padL + i * bw} y={0} width={bw} height={H - padB} />
              {h > 0 && <path className={`bar ${hover === i ? 'on' : ''}`} d={`M${x} ${H - padB}V${H - padB - h + r}q0 ${-r} ${r} ${-r}h${barW - 2 * r}q${r} 0 ${r} ${r}V${H - padB}Z`} />}
            </g>
          );
        })}
      </svg>
      <div className="dash-yaxis">{ticks.slice().reverse().map(value => <span key={value} style={{ top: `${(y(value) / H) * 100}%` }}>{Math.round(value).toLocaleString()}</span>)}</div>
      <div className="dash-xaxis">
        {data.map((d, i) => (i % every === 0 ? <span key={i} style={{ left: `${((padL + (i + 0.5) * bw) / W) * 100}%` }}>{d.x}</span> : null))}
      </div>
      {hover !== null && data[hover] && (
        <div className="dash-tip" style={{ left: `${((padL + (hover + 0.5) * bw) / W) * 100}%` }}>{tip(data[hover])}</div>
      )}
    </div>
  );
};

const QUALITY = [
  { key: 'hires', get label() { return t('Hi-Res'); } },
  { key: 'lossless', get label() { return t('CD lossless'); } },
  { key: 'lossy', get label() { return t('Lossy'); } },
];

const DashboardView = ({ musicFiles, onPlay }) => {
  const { openArtist, openAlbum } = useContext(SongActions);
  const [range, setRange] = useState('week');
  const [data, setData] = useState(null);
  const [first, setFirst] = useState(null);
  const [custom, setCustom] = useState(() => ({ from: startOfDay(Date.now() - 29 * DAY), to: startOfDay(Date.now()) }));
  const win = useMemo(() => windowFor(range, first, custom), [range, first, custom]);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const load = () => window.ipcRenderer.invoke('stats:summary', { from: win.from, to: win.to, bucket: win.bucket }).then(r => {
      if (!alive) return;
      setData(r);
      if (r?.first && r.first !== first) setFirst(r.first);
    }).catch(() => {});
    // new plays, or tracks that moved on disk (their plays are re-attached on the next read)
    const again = () => { clearTimeout(timer); timer = setTimeout(load, 500); };
    load();
    ipcOn(window.ipcRenderer, 'stats:changed', again);
    window.addEventListener('telecloud:library-changed', again);
    return () => { alive = false; clearTimeout(timer); ipcOff(window.ipcRenderer, 'stats:changed', again); window.removeEventListener('telecloud:library-changed', again); };
  }, [win]); // eslint-disable-line react-hooks/exhaustive-deps

  const byPath = useMemo(() => new Map(musicFiles.map(f => [f.path, f])), [musicFiles]);
  const series = useMemo(() => {
    const got = new Map((data?.series || []).map(s => [s.t, s]));
    return win.keys.map(k => ({ t: k, x: bucketLabel(k, win.bucket), v: (got.get(k)?.ms || 0) / 60000, plays: got.get(k)?.plays || 0 }));
  }, [data, win]);
  const hours = (data?.hours || []).map((ms, h) => ({ t: h, x: String(h).padStart(2, '0'), v: ms / 60000 }));
  const qTotal = QUALITY.reduce((s, q) => s + (data?.quality?.[q.key] || 0), 0);
  const totals = data?.totals || { plays: 0, ms: 0, tracks: 0, artists: 0, albums: 0 };

  const playTrack = (p) => {
    const f = byPath.get(p.path);
    if (f) onPlay(f, 0, [f]);
  };
  const maxTrack = data?.topTracks?.[0]?.plays || 1;
  const maxArtist = data?.topArtists?.[0]?.plays || 1;

  return (
    <div className="dash">
      <div className="page-head">
        <h2>{t('Dashboard')}</h2>
        <span className="sub">{t('Your listening, from TeleCloud\'s play history')}</span>
        <div className="end"><Segmented value={range} onChange={setRange} options={RANGES} size="sm" /></div>
      </div>
      {range === 'custom' && (
        <div className="dash-dates">
          <label>{t('From')} <input className="input sm mono" type="date" value={dayInput(custom.from)} max={dayInput(custom.to)} onChange={(e) => { const time = fromInput(e.target.value); if (Number.isFinite(time)) setCustom(c => ({ ...c, from: time })); }} /></label>
          <label>{t('to')} <input className="input sm mono" type="date" value={dayInput(custom.to)} min={dayInput(custom.from)} max={dayInput(Date.now())} onChange={(e) => { const time = fromInput(e.target.value); if (Number.isFinite(time)) setCustom(c => ({ ...c, to: time })); }} /></label>
        </div>
      )}

      {data && totals.plays === 0 ? (
        <div className="card dash-empty">
          <Icon name="clock" />
          <b>{t('No plays in this period yet')}</b>
          <span>{t('A play counts once you\'ve heard half a track or four minutes of it, like Last.fm.')}</span>
        </div>
      ) : (
        <>
          <div className="dash-kpis">
            <div className="card kpi"><small>{t('Listening time')}</small><b>{fmtDuration(totals.ms)}</b></div>
            <div className="card kpi"><small>{t('Plays')}</small><b>{totals.plays.toLocaleString()}</b></div>
            <div className="card kpi"><small>{t('Tracks')}</small><b>{totals.tracks.toLocaleString()}</b></div>
            <div className="card kpi"><small>{t('Artists')}</small><b>{totals.artists.toLocaleString()}</b></div>
            <div className="card kpi"><small>{t('Albums')}</small><b>{totals.albums.toLocaleString()}</b></div>
          </div>

          <div className="card dash-card">
            <div className="dash-head"><b>{t('Minutes listened')}</b><span>{t('{value} · per {bucket}', { value: range === 'custom' ? `${new Date(win.from).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })} – ${new Date(win.to - DAY).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}` : RANGES.find(r => r.value === range).label, bucket: win.bucket })}</span></div>
            <Columns data={series} label={t('Minutes listened over time')} tip={(d) => <><b>{bucketLabel(d.t, win.bucket, true)}</b><span>{t('{round} min · {plays}', { round: Math.round(d.v), plays: d.plays })} {d.plays === 1 ? t('play') : t('plays')}</span></>} />
          </div>

          <div className="dash-grid">
            <div className="card dash-card">
              <div className="dash-head"><b>{t('Top tracks')}</b>{(() => { const files = (data?.topTracks || []).map(p => byPath.get(p.path)).filter(Boolean); return files.length ? <button className="btn-ghost sm" onClick={() => onPlay(files[0], 0, files)}><Icon name="play" filled />{t('Play all')}</button> : null; })()}</div>
              <ol className="dash-list">
                {(data?.topTracks || []).map((p, i) => {
                  const f = byPath.get(p.path);
                  return (
                    <li key={p.path} className={f ? 'playable' : ''} onClick={() => playTrack(p)} title={f ? t('Play') : t('No longer in your library')}>
                      <span className="rank mono">{i + 1}</span>
                      <Cover file={f || null} />
                      <div className="txt"><b>{p.title}</b><span>{p.artist}</span></div>
                      <div className="meter"><span style={{ width: `${(p.plays / maxTrack) * 100}%` }} /></div>
                      <span className="n mono">{p.plays}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <div className="card dash-card">
              <div className="dash-head"><b>{t('Top artists')}</b></div>
              <ol className="dash-list">
                {(data?.topArtists || []).map((a, i) => (
                  <li key={a.name} className="playable" onClick={() => openArtist?.(a.name)} title={t('Open artist')}>
                    <span className="rank mono">{i + 1}</span>
                    <div className="txt"><b>{a.name}</b><span>{fmtDuration(a.ms)}</span></div>
                    <div className="meter"><span style={{ width: `${(a.plays / maxArtist) * 100}%` }} /></div>
                    <span className="n mono">{a.plays}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="card dash-card">
            <div className="dash-head"><b>{t('Top albums')}</b></div>
            <div className="dash-albums">
              {(data?.topAlbums || []).map(a => (
                <button key={`${a.name}-${a.artist}`} className="dash-album" onClick={() => openAlbum?.(byPath.get(a.path) || a.name)}>
                  <Cover file={byPath.get(a.path) || null} />
                  <b>{a.name}</b>
                  <span>{a.plays} {a.plays === 1 ? t('play') : t('plays')}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="dash-grid">
            <div className="card dash-card">
              <div className="dash-head"><b>{t('By quality')}</b><span>{t('share of listening time')}</span></div>
              <div className="qbar" role="img" aria-label={QUALITY.map(q => `${q.label} ${qTotal ? Math.round((data.quality[q.key] / qTotal) * 100) : 0}%`).join(', ')}>
                {QUALITY.map(q => (data?.quality?.[q.key] ? <span key={q.key} className={`q-${q.key}`} style={{ flexGrow: data.quality[q.key] }} title={`${q.label}: ${fmtDuration(data.quality[q.key])}`} /> : null))}
              </div>
              <div className="qlegend">
                {QUALITY.map(q => (
                  <span key={q.key}><i className={`q-${q.key}`} />{q.label}<b>{qTotal ? Math.round((data.quality[q.key] / qTotal) * 100) : 0}%</b></span>
                ))}
              </div>
            </div>
            <div className="card dash-card">
              <div className="dash-head"><b>{t('Time of day')}</b><span>{t('minutes by hour')}</span></div>
              <Columns data={hours} height={120} label={t('Minutes listened by hour of day')} tip={(d) => <><b>{d.x}:00–{String(d.t + 1).padStart(2, '0')}:00</b><span>{t('{round} min', { round: Math.round(d.v) })}</span></>} />
            </div>
          </div>
        </>
      )}
      <OnThisDay byPath={byPath} onPlay={onPlay} />
    </div>
  );
};

export default DashboardView;
