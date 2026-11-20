import React, { useEffect, useMemo, useState } from 'react';
import SongList from './SongList';
import Cover from './Cover';
import Icon from './Icon';
import { formatDuration } from '../utils/audio';
import { t } from '../i18n';

// The library as the folders on disk, for people who keep their music by folder. Built from the library's
// own paths, so it is instant and shows only music TeleCloud knows. Tracks only in TeleCloud have no folder.

const sep = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
const low = (p) => sep(p).toLowerCase();
const base = (p) => sep(p).split('\\').pop() || p;
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const remember = (v) => { try { if (v) sessionStorage.setItem('folders:at', v); else sessionStorage.removeItem('folders:at'); } catch { /* fine */ } };
const recalled = () => { try { return sessionStorage.getItem('folders:at'); } catch { return null; } };

const FoldersView = ({ musicFiles, roots = [], ...songListProps }) => {
  const rootList = useMemo(() => roots.map(sep).filter(Boolean), [roots]);
  const local = useMemo(() => musicFiles.filter(f => !String(f.path).startsWith('tc://') && f.storage_type !== 'cloud'), [musicFiles]);
  // one music folder: start inside it
  const [at, setAt] = useState(() => recalled() || (rootList.length === 1 ? rootList[0] : null));
  useEffect(() => { if (!at && rootList.length === 1) setAt(rootList[0]); }, [rootList, at]);
  const go = (p) => { setAt(p); remember(p); document.querySelector('.view')?.scrollTo?.(0, 0); };

  const root = at ? rootList.find(r => low(at) === low(r) || low(at).startsWith(`${low(r)}\\`)) : null;
  // what is directly in this folder: its sub-folders (with everything under them) and its own tracks
  const { folders, tracks, all } = useMemo(() => {
    if (!at) {
      return {
        folders: rootList.map(r => {
          const under = local.filter(f => low(f.path).startsWith(`${low(r)}\\`));
          return { path: r, name: r, count: under.length, secs: under.reduce((s, f) => s + (f.metadata?.duration || 0), 0), sample: under[0] };
        }),
        tracks: [], all: local,
      };
    }
    const prefix = `${low(at)}\\`;
    const subs = new Map();
    const own = [];
    const inside = [];
    for (const f of local) {
      const lp = low(f.path);
      if (!lp.startsWith(prefix)) continue;
      inside.push(f);
      const rest = sep(f.path).slice(prefix.length);
      const cut = rest.indexOf('\\');
      if (cut < 0) { own.push(f); continue; }
      const name = rest.slice(0, cut);
      const k = name.toLowerCase();
      const e = subs.get(k) || { path: `${sep(at)}\\${name}`, name, count: 0, secs: 0, sample: null };
      e.count++; e.secs += f.metadata?.duration || 0; if (!e.sample || f.hasCover) e.sample = e.sample?.hasCover ? e.sample : f;
      subs.set(k, e);
    }
    own.sort((a, b) => byName(base(a.path), base(b.path)));
    inside.sort((a, b) => byName(low(a.path), low(b.path)));
    return { folders: [...subs.values()].sort((a, b) => byName(a.name, b.name)), tracks: own, all: inside };
  }, [at, local, rootList]);

  // the way back up: the music folder, then each folder under it
  const crumbs = useMemo(() => {
    if (!at || !root) return [];
    const parts = sep(at).slice(root.length).split('\\').filter(Boolean);
    const out = [{ path: root, name: base(root) }];
    let p = root;
    for (const part of parts) { p = `${p}\\${part}`; out.push({ path: p, name: part }); }
    return out;
  }, [at, root]);
  const up = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : (rootList.length > 1 ? null : undefined);
  const { onPlay } = songListProps;
  const shuffle = () => { const s = [...all].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); };
  const total = all.reduce((s, f) => s + (f.metadata?.duration || 0), 0);

  if (!rootList.length) {
    return (
      <>
        <div className="page-head"><h2>{t('Folders')}</h2></div>
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          <Icon name="folder" style={{ width: 36, height: 36, marginBottom: 10 }} />
          <div>{t('Add a music folder in Settings to browse it here.')}</div>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="page-head folders-head">
        {at && up !== undefined && <button className="icon-btn" onClick={() => go(up)} title={t('Up one folder')} aria-label={t('Up one folder')}><Icon name="chevron" style={{ transform: 'rotate(90deg)' }} /></button>}
        <h2>{at ? base(at) : t('Folders')}</h2>
        <span className="sub">{t('{length} tracks{value}', { length: all.length.toLocaleString(), value: total ? ` · ${formatDuration(total)}` : '' })}</span>
        <div className="end">
          <button className="btn-ghost" disabled={!all.length} onClick={shuffle}><Icon name="shuffle" />{t('Shuffle')}</button>
          <button className="btn-primary" disabled={!all.length} onClick={() => onPlay(all[0], 0, all)}><Icon name="play" filled />{t('Play folder')}</button>
        </div>
      </div>
      {(crumbs.length > 1 || (crumbs.length && rootList.length > 1)) && (
        <nav className="crumbs" aria-label={t('Folder')}>
          {rootList.length > 1 && <><button onClick={() => go(null)}>{t('Music folders')}</button><Icon name="chevron" /></>}
          {crumbs.map((c, i) => (
            <React.Fragment key={c.path}>
              {i > 0 && <Icon name="chevron" />}
              <button className={i === crumbs.length - 1 ? 'on' : ''} onClick={() => go(c.path)} title={c.path}>{c.name}</button>
            </React.Fragment>
          ))}
        </nav>
      )}
      {folders.length > 0 && (
        <div className="folder-grid">
          {folders.map(f => (
            <button key={f.path} className="folder-tile" onClick={() => go(f.path)} title={f.path}>
              <span className="folder-art">{f.sample ? <Cover file={f.sample} /> : <Icon name="folder" />}</span>
              <span className="folder-txt"><b>{at ? f.name : base(f.name)}</b><span>{f.count.toLocaleString()} {f.count === 1 ? t('track') : t('tracks')}{!at ? ` · ${f.name}` : ''}</span></span>
            </button>
          ))}
        </div>
      )}
      {tracks.length > 0 && (
        <>
          {folders.length > 0 && <div className="section-head"><span>{t('In this folder')}</span></div>}
          <SongList {...songListProps} musicFiles={tracks} />
        </>
      )}
      {at && !folders.length && !tracks.length && <div className="empty">{t('No music in this folder.')}</div>}
    </>
  );
};

export default FoldersView;
