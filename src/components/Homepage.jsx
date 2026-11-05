import React, { useContext, useMemo, useRef, useState, useLayoutEffect, useEffect } from 'react';
import Icon from './Icon';
import Cover from './Cover';
import SongActions from './songActions';
import SongList from './SongList';
import { qualityOf, storageOf, formatDuration, formatBytes, sortAlbumTracks } from '../utils/audio';
import { albumIndex, trackCount } from '../utils/albums';

const FORMAT_COLORS = ['var(--accent)', 'var(--ok)', '#9b7bff', 'var(--info)', 'var(--text-3)'];

const groupAlbums = (musicFiles, limit) => {
  const idx = albumIndex(musicFiles);
  const seen = new Set();
  for (let i = musicFiles.length - 1; i >= 0 && seen.size < limit; i--) {
    const album = idx.byPath.get(musicFiles[i].path);
    if (album) seen.add(album);
  }
  return [...seen].map(a => ({ ...a, songs: sortAlbumTracks(a.songs) }));
};

// While a scan streams in thousands of tracks, recompute the page at most every `ms`
// (otherwise the album row would churn and request hundreds of covers)
function useThrottled(value, ms) {
  const [v, setV] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now());
    const t = setTimeout(() => { last.current = Date.now(); setV(value); }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const Homepage = ({ musicFiles, recentPlayed = [], onPlay, onNavClick, setSelectedAlbum, syncStatus, syncProgress, songListProps }) => {
  const ctx = useContext(SongActions);
  const settled = useThrottled(musicFiles, 2500);
  const albums = useMemo(() => groupAlbums(settled, 25), [settled]);

  // How many 140px+ tiles fit in one row at the current width
  const gridRef = useRef(null);
  const [cols, setCols] = useState(6);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return undefined;
    const measure = () => setCols(Math.max(2, Math.floor((el.clientWidth + 18) / (140 + 18))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [albums.length > 1]);
  const latest = albums[0];

  const stats = useMemo(() => {
    const formats = new Map();
    let hires = 0;
    settled.forEach(f => {
      const q = qualityOf(f);
      if (q.tier === 'hires') hires++;
      const key = q.ext.startsWith('DSD') ? 'DSD' : q.ext;
      formats.set(key, (formats.get(key) || 0) + 1);
    });
    const total = settled.length || 1;
    const top = [...formats.entries()].sort((a, b) => b[1] - a[1]);
    const shown = top.slice(0, 4);
    const rest = top.slice(4).reduce((s, [, n]) => s + n, 0);
    if (rest) shown.push(['Other', rest]);
    return {
      tracks: settled.length,
      hires,
      hiresPct: Math.round((hires / total) * 100),
      formats: shown.map(([name, n]) => ({ name, pct: Math.round((n / total) * 100) })),
      artists: new Set(settled.map(f => f.metadata?.artist).filter(Boolean)).size,
    };
  }, [settled]);

  // navigating to Albums clears the selection, so select the album after it
  const openAlbum = (album) => { onNavClick('albums'); setSelectedAlbum(album); };
  const recentDuration = recentPlayed.reduce((s, f) => s + (f.metadata?.duration || 0), 0);
  const latestQuality = latest ? qualityOf(latest.songs[0]) : null;
  const latestStorage = latest ? [...new Set(latest.songs.flatMap(storageOf))] : [];

  return (
    <>
      <section className="hero">
        <div className="card hero-a" onClick={() => recentPlayed.length ? onPlay(recentPlayed[0], 0, recentPlayed) : onNavClick('library')} role="button">
          <div className="eyebrow">
            {recentPlayed.length ? `${recentPlayed.length} tracks · ${formatDuration(recentDuration)}` : `${stats.tracks.toLocaleString()} tracks in your library`}
          </div>
          <div className="hero-title">{recentPlayed.length ? 'Continue listening' : 'Start listening'}</div>
          <Cover file={recentPlayed[0] || settled[settled.length - 1]} />
        </div>

        <div className="card hero-b">
          {latest ? (
            <>
              <Cover file={latest.file} className="hero-bg" />
              <div className="content">
                <div className="eyebrow">Recently added</div>
                <div className="hero-title" title={latest.name}>{latest.name}</div>
                <div className="hero-specs">
                  {latestQuality && <span className={`badge b-${latestQuality.tier} mono`}>{latestQuality.label}</span>}
                  {latestStorage.includes('local') && <span className="badge b-local"><Icon name="monitor" />Local</span>}
                  {latestStorage.includes('cloud') && <span className="badge b-cloud"><Icon name="cloud" />Synced</span>}
                </div>
                <div className="hero-sub">{latest.artist} · {trackCount(ctx.countUnique ? ctx.countUnique(latest.songs) : latest.songs.length)}</div>
                <div className="hero-actions">
                  <button className="btn-primary" onClick={() => onPlay(latest.songs[0], 0, latest.songs)}><Icon name="play" filled />Play album</button>
                  <button className="icon-btn" title="Shuffle album" onClick={() => {
                    const shuffled = [...latest.songs].sort(() => Math.random() - 0.5);
                    onPlay(shuffled[0], 0, shuffled);
                  }}><Icon name="shuffle" /></button>
                  <button className="icon-btn" title="Open album" onClick={() => openAlbum(latest)}><Icon name="disc" /></button>
                </div>
              </div>
              <Cover file={latest.file} />
            </>
          ) : (
            <div className="content">
              <div className="eyebrow">Your library is empty</div>
              <div className="hero-title">Add a music folder</div>
              <div className="hero-sub">Point TeleCloud at the folders holding your FLAC, DSD and other files.</div>
              <div className="hero-actions">
                <button className="btn-primary" onClick={() => onNavClick('settings')}><Icon name="folder" />Open settings</button>
              </div>
            </div>
          )}
        </div>
      </section>

      {albums.length > 1 && (
        <>
          <div className="section-head"><span>Recently added albums</span><button onClick={() => onNavClick('albums')}>See all</button></div>
          <div className="album-grid" ref={gridRef} style={{ '--cols': cols }}>
            {/* Newest first; one row of whatever fits, the rest is on the Albums page */}
            {albums.slice(0, cols).map(a => (
              <button key={a.key} className="album-tile" onClick={() => openAlbum(a)}>
                <Cover file={a.file} />
                <b>{a.name}</b><span>{a.artist}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {recentPlayed.length > 0 && (
        <>
          <div className="section-head"><span>Recently played</span><button onClick={() => onNavClick('recent')}>See all</button></div>
          <div style={{ marginBottom: 28 }}>
            <SongList {...songListProps} musicFiles={recentPlayed.slice(0, 6)} />
          </div>
        </>
      )}

      <section className="bottom-row">
        <div className="card sync-card">
          <div className="sync-head">
            <span className={`live ${syncStatus?.isAuthenticated ? '' : 'off'}`} />
            <h3>TeleCloud Sync</h3>
          </div>
          {syncProgress ? (
            <>
              <div className="sync-sub">Uploading {syncProgress.current} of {syncProgress.total} tracks</div>
              <div className="progress"><span style={{ width: `${Math.round(((syncProgress.current - 1 + (syncProgress.uploadProgress || 0) / 100) / Math.max(1, syncProgress.total)) * 100)}%` }} /></div>
              <div className="sync-sub" style={{ margin: '8px 0 0', fontSize: 12 }}>{syncProgress.currentFile}</div>
            </>
          ) : (
            <div className="sync-sub">
              {syncStatus?.isAuthenticated
                ? `Connected${syncStatus.lastSync ? ` · last sync ${new Date(syncStatus.lastSync).toLocaleString()}` : ''}`
                : 'Back up your library to a private Telegram channel and stream it anywhere.'}
            </div>
          )}
          <div className="sync-stats">
            {syncStatus?.isAuthenticated ? (
              <>
                <div><b>{(syncStatus.syncedItems || 0).toLocaleString()}</b><span>tracks in cloud</span></div>
                <div><b>{formatBytes(syncStatus.storageUsed)}</b><span>stored</span></div>
                <div style={{ marginLeft: 'auto', alignSelf: 'center' }}><button className="btn-ghost" onClick={() => onNavClick('telecloud')}>Open</button></div>
              </>
            ) : (
              <button className="btn-primary" onClick={() => onNavClick('settings')}><Icon name="cloud" />Set up TeleCloud</button>
            )}
          </div>
        </div>

        <div className="stats">
          <div className="section-head" style={{ margin: 0 }}><span>Library</span></div>
          <div className="card stat"><div><small>Tracks</small><b>{stats.tracks.toLocaleString()}</b></div><Icon name="music" /></div>
          <div className="card stat"><div><small>Hi-Res (&gt; 16-bit / 48 kHz)</small><b>{stats.hires.toLocaleString()}</b></div><span className="badge b-hires">{stats.hiresPct}%</span></div>
          <div className="card stat">
            <div>
              <small>Formats</small>
              <div className="fmt-bar">
                {stats.formats.map((f, i) => <i key={f.name} style={{ flex: Math.max(f.pct, 1), background: FORMAT_COLORS[i % FORMAT_COLORS.length] }} />)}
              </div>
            </div>
            <div className="fmt-legend">
              {stats.formats.length ? stats.formats.map(f => `${f.name} ${f.pct}%`).reduce((rows, s, i) => { rows[Math.floor(i / 2)] = rows[Math.floor(i / 2)] ? `${rows[Math.floor(i / 2)]} · ${s}` : s; return rows; }, []).map(r => <div key={r}>{r}</div>) : '—'}
            </div>
          </div>
        </div>
      </section>
    </>
  );
};

export default Homepage;
