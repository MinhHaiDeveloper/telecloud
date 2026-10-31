import React, { useState, useMemo, useEffect, useRef, useContext } from 'react';
import Icon from './Icon';
import Cover from './Cover';
import SongActions from './songActions';
import { formatTime, qualityOf, storageOf } from '../utils/audio';
import { SOURCE_HELP, QUALITY_HELP } from '../utils/badges';

const SORTS = [
  { id: 'latest', label: 'Recently added' },
  { id: 'name', label: 'Title' },
  { id: 'name_ignore_the', label: "Title (ignore 'The')" },
  { id: 'artist', label: 'Artist' },
  { id: 'album', label: 'Album' },
  { id: 'quality', label: 'Quality' },
];

const SRC_BADGE = {
  local: <span className="badge b-local" key="l">Local</span>,
  cloud: <span className="badge b-cloud" key="c">Cloud</span>,
  cached: <span className="badge b-cached" key="h">Cached</span>,
};

// Rows have a fixed height, so only the ones near the viewport are rendered (libraries can hold 10k+ tracks)
const ROW_H = 56;
const OVERSCAN = 10;

const scrollParentOf = (el) => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
};

const useRowWindow = (rowsRef, count) => {
  const [range, setRange] = useState({ start: 0, end: 40 });
  useEffect(() => {
    const rows = rowsRef.current;
    const scroller = scrollParentOf(rows);
    if (!rows || !scroller) { setRange({ start: 0, end: count }); return undefined; }
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = rows.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const start = Math.max(0, Math.floor(-top / ROW_H) - OVERSCAN);
      const end = Math.min(count, Math.ceil((scroller.clientHeight - top) / ROW_H) + OVERSCAN);
      setRange(r => (r.start === start && r.end === end ? r : { start, end }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    scroller.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    return () => { scroller.removeEventListener('scroll', schedule); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [rowsRef, count]);
  return range;
};

const HelpRows = ({ rows }) => rows.map((r, i) => (
  <div className="src-help-row" key={i}>
    <span className="tags">{r.tags.map(([cls, label]) => <span key={label} className={`badge ${cls} mono`}>{label}</span>)}</span>
    <span className="txt">{r.text}</span>
  </div>
));

/** Small (i) next to the Source column: what Local / Cloud / Cached mean */
const SourceInfo = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="src-info" ref={ref}>
      <button className={`src-info-btn ${open ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }} aria-label="What do the source tags mean?" aria-expanded={open}>
        <Icon name="info" />
      </button>
      {open && (
        <div className="src-help menu" role="dialog" aria-label="Tags">
          <b>Source</b>
          <HelpRows rows={SOURCE_HELP} />
          <b>Quality</b>
          <HelpRows rows={QUALITY_HELP} />
        </div>
      )}
    </span>
  );
};

const titleOf = (f) => f.metadata?.title || f.name || '';
const qualityRank = (f) => {
  const q = qualityOf(f);
  return (q.tier === 'hires' ? 2e9 : q.tier === 'lossless' ? 1e9 : 0) + (q.bits || 0) * 1e6 + (q.rate || 0);
};

const SongList = ({
  musicFiles, currentFile, isPlaying = true, onPlay, onToggleFavorite, onAddPlaylist: addPlaylistProp, onCheckSpectrum,
  onDeleteSong, onDownloadSong, favorites = [], title, subtitle, showSort = false, onInfoClick, deleteLabel = 'Delete from library',
  onBackupTo: backupToProp, storageNames: storageNamesProp, headerActions, toolbar, onBackupMany: backupManyProp, onRemoveFromCloud: removeFromCloudProp,
  onQueueMany: queueManyProp, onFavoriteMany: favoriteManyProp, onDeleteMany: deleteManyProp,
}) => {
  const ctx = useContext(SongActions);
  const onAddPlaylist = addPlaylistProp || ctx.onAddPlaylist;
  const onBackupTo = backupToProp || ctx.onBackupTo;
  const onBackupMany = backupManyProp || ctx.onBackupMany;
  const onRemoveFromCloud = removeFromCloudProp || ctx.onRemoveFromCloud;
  const storageNames = storageNamesProp || ctx.storageNames;
  const onQueueMany = queueManyProp || ctx.onQueueMany;
  const onFavoriteMany = favoriteManyProp || ctx.onFavoriteMany;
  // library delete only where the list deletes from the library (a playlist passes its own)
  const onDeleteMany = deleteManyProp || (onDeleteSong && deleteLabel === 'Delete from library' ? ctx.onDeleteMany : undefined);
  const [menu, setMenu] = useState(null); // { idx, x, y }
  const [sortOption, setSortOption] = useState(showSort ? 'latest' : 'default');
  const [sortOpen, setSortOpen] = useState(false);
  const [popKey, setPopKey] = useState(null);
  const menuRef = useRef(null);
  const sortRef = useRef(null);
  const rowsRef = useRef(null);
  const favSet = useMemo(() => new Set(favorites.map(f => f.path)), [favorites]);
  // Multi-select: Ctrl/Cmd+click toggles a row, Shift+click selects a run, Ctrl+A all, Esc clears
  const [selected, setSelected] = useState(() => new Set());
  const anchorRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!menu && !sortOpen) return undefined;
    const close = (e) => {
      if (menu && !menuRef.current?.contains(e.target)) setMenu(null);
      if (sortOpen && !sortRef.current?.contains(e.target)) setSortOpen(false);
    };
    // The menu is placed against its row, so only a scroll that moves the list closes it
    // (synced lyrics and the queue scroll by themselves while a track plays)
    const closeOnScroll = (e) => {
      const t = e.target === document ? document.documentElement : e.target;
      if (t.contains?.(rowsRef.current)) setMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', closeOnScroll, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('scroll', closeOnScroll, true); };
  }, [menu, sortOpen]);

  const sorted = useMemo(() => {
    const list = [...musicFiles];
    const noThe = (f) => titleOf(f).toLowerCase().replace(/^the /, '');
    switch (sortOption) {
      case 'name': return list.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
      case 'name_ignore_the': return list.sort((a, b) => noThe(a).localeCompare(noThe(b)));
      case 'artist': return list.sort((a, b) => (a.metadata?.artist || 'Unknown').localeCompare(b.metadata?.artist || 'Unknown'));
      case 'album': return list.sort((a, b) => (a.metadata?.album || 'Unknown').localeCompare(b.metadata?.album || 'Unknown'));
      case 'quality': return list.sort((a, b) => qualityRank(b) - qualityRank(a));
      case 'latest': return list.reverse();
      default: return list;
    }
  }, [musicFiles, sortOption]);

  const { start, end } = useRowWindow(rowsRef, sorted.length);

  // tracks that left the list (deleted, filtered out) leave the selection too
  useEffect(() => {
    if (!selected.size) return;
    const here = new Set(sorted.map(f => f.path));
    if ([...selected].some(p => !here.has(p))) setSelected(new Set([...selected].filter(p => here.has(p))));
  }, [sorted]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedFiles = useMemo(() => sorted.filter(f => selected.has(f.path)), [sorted, selected]);
  const clearSelection = () => { setSelected(new Set()); anchorRef.current = null; };

  const onRowClick = (e, file, idx) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(file.path)) next.delete(file.path); else next.add(file.path);
      setSelected(next);
      anchorRef.current = idx;
      listRef.current?.focus({ preventScroll: true });
      return;
    }
    if (e.shiftKey) {
      const from = anchorRef.current ?? idx;
      const [a, b] = from < idx ? [from, idx] : [idx, from];
      setSelected(new Set(sorted.slice(a, b + 1).map(f => f.path)));
      if (anchorRef.current === null) anchorRef.current = idx;
      listRef.current?.focus({ preventScroll: true });
      return;
    }
    if (selected.size) clearSelection();
    onPlay(file, idx, sorted);
  };

  // Ctrl+A / Esc work whenever focus is in the list or nowhere in particular (e.g. right after a
  // dialog closes and focus falls back to <body>), so the page never selects its own text instead
  useEffect(() => {
    const onKey = (e) => {
      const list = listRef.current;
      if (!list || !list.offsetParent) return; // not on screen
      const t = e.target;
      if (t !== document.body && t !== document.documentElement && !list.contains(t)) return;
      if (document.querySelector('[role="dialog"], .modal-backdrop')) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(sorted.map(f => f.path)));
        list.focus({ preventScroll: true });
      } else if (e.key === 'Escape' && selected.size) {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sorted, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const openMenu = (e, idx) => {
    e.stopPropagation();
    if (menu?.idx === idx) { setMenu(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const h = 230;
    setMenu({ idx, x: Math.max(8, r.right - 210), y: window.innerHeight - r.bottom < h + 100 ? r.top - h - 6 : r.bottom + 6 });
  };

  const menuFile = menu ? sorted[menu.idx] : null;
  const act = (fn) => { if (menuFile && fn) fn(menuFile); setMenu(null); };

  return (
    <div className="track-list" ref={listRef} tabIndex={-1}>
      {(title || showSort) && (
        <div className="page-head">
          {title && <h2>{title}</h2>}
          {onInfoClick && <button className="icon-btn sm" onClick={onInfoClick} title="What do the badges mean?"><Icon name="info" /></button>}
          <span className="sub">{subtitle ?? `${musicFiles.length.toLocaleString()} tracks`}</span>
          {headerActions}
          {showSort && (
            <div className="end" ref={sortRef}>
              <button className="btn-ghost" onClick={() => setSortOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Icon name="sort" style={{ width: 15, height: 15 }} />
                {SORTS.find(s => s.id === sortOption)?.label || 'Default'}
              </button>
              {sortOpen && (
                <div className="menu" style={{ right: 0, top: 'calc(100% + 6px)' }}>
                  {SORTS.map(s => (
                    <button key={s.id} className={`menu-item ${sortOption === s.id ? 'on' : ''}`} onClick={() => { setSortOption(s.id); setSortOpen(false); }}>
                      {sortOption === s.id ? <Icon name="check" /> : <span style={{ width: 16 }} />}{s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {toolbar}
      {sorted.length === 0 ? (
        <div className="empty">No tracks here yet.</div>
      ) : (
        <>
          <div className="track-head">
            <span className="t-num">#</span><span>Title</span><span className="c-album">Album</span>
            <span>Quality</span><span className="c-src src-head">Source<SourceInfo /></span><span style={{ textAlign: 'right' }}>Time</span><span />
          </div>
          <div className="track-rows" ref={rowsRef} style={{ paddingTop: start * ROW_H, height: sorted.length * ROW_H }}>
          {sorted.slice(start, end).map((file, i) => {
            const idx = start + i;
            const active = currentFile?.path === file.path;
            const fav = favSet.has(file.path);
            const q = qualityOf(file);
            return (
              <div
                key={file.path}
                className={`track-row ${active ? 'playing' : ''} ${selected.has(file.path) ? 'selected' : ''}`}
                aria-selected={selected.has(file.path)}
                onMouseDown={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); }}
                onClick={(e) => onRowClick(e, file, idx)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ idx, x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 240) }); }}
              >
                <span className="t-num">
                  {active
                    ? <span className={`eq-bars ${isPlaying ? '' : 'paused'}`}><i /><i /><i /></span>
                    : idx + 1}
                </span>
                <div className="t-main">
                  <Cover file={file} key={file.path + (file.cache_path || '')} />
                  <div className="t-text">
                    <div className="t-title">{titleOf(file)}</div>
                    <div className="t-artist">{file.metadata?.artist || 'Unknown artist'}</div>
                  </div>
                </div>
                <span className="t-album c-album">{file.metadata?.album || '—'}</span>
                <span><span className={`badge b-${q.tier} mono`}>{q.label}</span></span>
                <span className="t-src c-src" title={file.telegram_message_id && storageNames ? `In ${storageNames.get(String(file.telegram_channel_id)) || 'TeleCloud'}` : undefined}>{storageOf(file).map(s => SRC_BADGE[s])}</span>
                <span className="t-dur mono">{formatTime(file.metadata?.duration)}</span>
                <span className="t-act">
                  <button
                    className={`${fav ? 'fav' : ''} ${popKey === file.path ? 'pop' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onToggleFavorite(file); setPopKey(null); requestAnimationFrame(() => setPopKey(file.path)); }}
                    title={fav ? 'Remove from favourites' : 'Add to favourites'}
                  >
                    <Icon name="heart" />
                  </button>
                  <button className={menu?.idx === idx ? 'open' : ''} onClick={(e) => openMenu(e, idx)} title="More"><Icon name="more" /></button>
                </span>
              </div>
            );
          })}
          </div>
        </>
      )}

      {menu && menuFile && (
        <div className="menu" ref={menuRef} style={{ position: 'fixed', left: menu.x, top: menu.y, width: 210 }}>
          <button className="menu-item" onClick={() => act(onToggleFavorite)}><Icon name="heart" />{favSet.has(menuFile.path) ? 'Remove favourite' : 'Add to favourites'}</button>
          {onAddPlaylist && <button className="menu-item" onClick={() => act(onAddPlaylist)}><Icon name="playlist" />Add to playlist</button>}
          {onCheckSpectrum && <button className="menu-item" onClick={() => act(onCheckSpectrum)}><Icon name="spectrum" />Check spectrum</button>}
          {onBackupTo && <button className="menu-item" onClick={() => act(onBackupTo)}><Icon name="cloud" />{menuFile.telegram_message_id ? `In ${storageNames?.get(String(menuFile.telegram_channel_id)) || 'TeleCloud'} · move…` : 'Back up to…'}</button>}
          {onDownloadSong && <button className="menu-item" onClick={() => act(onDownloadSong)}><Icon name="download" />Download</button>}
          {onRemoveFromCloud && menuFile.telegram_message_id && <button className="menu-item danger" onClick={() => { const f = menuFile; setMenu(null); onRemoveFromCloud([f]); }}><Icon name="cloud" />Remove from TeleCloud</button>}
          {onDeleteSong && <>
            <div className="menu-sep" />
            <button className="menu-item danger" onClick={() => act(onDeleteSong)}><Icon name="trash" />{deleteLabel}</button>
          </>}
        </div>
      )}

      {selected.size > 0 && (
        <div className="select-bar" role="toolbar" aria-label="Selected tracks">
          <b>{selected.size.toLocaleString()} selected</b>
          <button className="btn-ghost sm" onClick={() => onPlay(selectedFiles[0], 0, selectedFiles)}><Icon name="play" />Play</button>
          {onQueueMany && <button className="btn-ghost sm" onClick={() => onQueueMany(selectedFiles)}><Icon name="queue" />Add to queue</button>}
          {onAddPlaylist && <button className="btn-ghost sm" onClick={() => onAddPlaylist(selectedFiles[0], selectedFiles)}><Icon name="playlist" />Add to playlist</button>}
          {onFavoriteMany && (() => {
            const allFav = selectedFiles.every(f => favSet.has(f.path));
            return <button className={`icon-btn sm ${allFav ? 'on' : ''}`} onClick={() => onFavoriteMany(selectedFiles, !allFav)} title={allFav ? 'Remove from favourites' : 'Add to favourites'}><Icon name="heart" filled={allFav} /></button>;
          })()}
          {onBackupMany && <button className="icon-btn sm" onClick={() => onBackupMany(selectedFiles, `${selectedFiles.length} selected tracks`)} title="Back up to…"><Icon name="cloud" /></button>}
          {onRemoveFromCloud && selectedFiles.some(f => f.telegram_message_id) && (
            <button className="btn-ghost sm danger" onClick={() => onRemoveFromCloud(selectedFiles.filter(f => f.telegram_message_id))}><Icon name="cloud" />Remove from TeleCloud</button>
          )}
          {onDeleteMany && <button className="icon-btn sm danger" onClick={() => onDeleteMany(selectedFiles)} title={deleteLabel}><Icon name="trash" /></button>}
          <span className="sep" />
          <button className="icon-btn sm" onClick={clearSelection} title="Clear selection (Esc)"><Icon name="close" /></button>
        </div>
      )}
    </div>
  );
};

export default SongList;
