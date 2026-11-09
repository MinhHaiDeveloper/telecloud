import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Cover from './Cover';
import ArtistPicture from './ArtistPicture';
import { Dialog, Progress, confirmDialog } from './ui';

const plural = (n, one) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

/** Search the sources for an artist (or upload a picture), pick one, save it into their tracks' tags */
const ArtistPictureDialog = ({ name, file, hasPicture, onClose, onSaved }) => {
  const [query, setQuery] = useState(name);
  const [opts, setOpts] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const [errors, setErrors] = useState({});
  const [pick, setPick] = useState(null);
  const [broken, setBroken] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const [readOnly, setReadOnly] = useState(0);
  const [work, setWork] = useState(null); // { done, total } while tags are written
  const [tab, setTab] = useState('sources');
  const [asked, setAsked] = useState(name); // the name searched last, on either tab
  const [yt, setYt] = useState(null); // { query, busy, results, error, needsKey }, asked for only on its tab
  const sourcesAsked = useRef(name);
  useEffect(() => {
    const on = (e, p) => { if (p.name === name) setWork(p.finished ? null : p); };
    window.ipcRenderer.on('artists:progress', on);
    return () => window.ipcRenderer.removeListener?.('artists:progress', on);
  }, [name]);

  const run = async (artist) => {
    setBusy(true);
    setBroken(new Set());
    sourcesAsked.current = artist;
    const r = await window.ipcRenderer.invoke('artists:search', { query: { artist }, all: true }).catch(() => null);
    setResults(r?.results || []);
    setErrors(r?.errors || {});
    setBusy(false);
  };
  const runYoutube = async (artist) => {
    setYt({ query: artist, busy: true, results: [] });
    setBroken(new Set());
    const r = await window.ipcRenderer.invoke('artists:youtube', { artist }).catch(() => ({ error: 'Could not ask YouTube.' }));
    setYt({ query: artist, busy: false, results: r.results || [], error: r.error, needsKey: r.needsKey });
  };
  const openTab = (next) => {
    setTab(next);
    if (next === 'youtube' && !yt?.busy && (!yt || yt.error || yt.needsKey || yt.query !== asked)) runYoutube(asked);
    if (next === 'sources' && !busy && sourcesAsked.current !== asked) run(asked);
  };
  const openVgmdb = () => window.ipcRenderer.invoke('open-external', `https://vgmdb.net/search?q=${encodeURIComponent(query.trim() || name)}`);
  const submit = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setAsked(q);
    if (tab === 'youtube') runYoutube(q); else run(q);
  };
  useEffect(() => {
    window.ipcRenderer.invoke('artists:options').then(setOpts);
    window.ipcRenderer.invoke('artists:targets', { name }).then(setInfo);
    run(name);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async () => {
    setProblem('');
    const r = await window.ipcRenderer.invoke('artists:pick');
    if (!r?.success) { setProblem(r?.error || 'Could not open that picture'); return; }
    if (r.picked) setPick({ image: { file: r.picked.file }, thumb: r.picked.thumb, label: r.picked.name, size: `${r.picked.width} × ${r.picked.height}` });
  };
  const report = (r, did) => {
    if (!r?.success) { setProblem(r?.error || 'Could not do that'); return; }
    if (r.stopped) {
      onSaved?.(r);
      setProblem(`Stopped. ${plural(r.tags, 'track')} of ${r.total.toLocaleString()} already have it; save again to finish.`);
      return;
    }
    if (!r.errors?.length) { onSaved?.(r); onClose(); return; }
    const n = r.errors.length;
    const blocked = r.errors.filter(e => e.readOnly).length;
    setReadOnly(blocked);
    setProblem(`${did} ${plural(n, 'file')} could not be changed: ${blocked === n ? (n === 1 ? 'it is read-only.' : 'they are read-only.') : r.errors[0].error}`);
  };
  const save = async (allowReadOnly = false) => {
    setSaving(true);
    setProblem('');
    setReadOnly(0);
    const r = await window.ipcRenderer.invoke('artists:save', { name, image: pick.image, allowReadOnly });
    setSaving(false);
    report(r, 'The picture was saved here, but');
  };
  const remove = async () => {
    const message = info?.local ? `It also leaves the tags of ${plural(info.local, 'track')}.${info.backedUp ? ' Backed-up files that change are uploaded again.' : ''}` : 'The artist goes back to showing an album cover.';
    if (!await confirmDialog({ title: 'Remove the artist picture?', message, confirmLabel: 'Remove', danger: true })) return;
    setSaving(true);
    setProblem('');
    const r = await window.ipcRenderer.invoke('artists:remove', { name });
    setSaving(false);
    report(r, 'The picture was removed here, but');
  };

  const labelOf = (id) => (id === 'youtube' ? 'YouTube' : opts?.sources?.[id]?.label || id);
  const onYoutube = tab === 'youtube';
  const working = onYoutube ? !!yt?.busy : busy;
  const shown = (onYoutube ? yt?.results || [] : results).filter(r => !broken.has(r.thumb));
  const nothing = onYoutube && yt?.needsKey ? 'YouTube needs an API key. Add one in Settings, General, Artist pictures.'
    : onYoutube && yt?.error ? yt.error : 'Nothing found. Try another spelling, or upload a picture.';
  const errorIds = Object.keys(errors);
  let note = '';
  if (info) {
    note = info.local ? `Saved in the tags of ${plural(info.local, 'track')}.` : 'No file here can hold it, so it is kept on this computer only.';
    if (info.skipped) note += ` ${plural(info.skipped, 'M4A or similar file')} left alone: that format would show it as a second album cover.`;
    if (info.backedUp) note += ` ${plural(info.backedUp, 'backed-up file')} will be uploaded again.`;
    if (info.cloudOnly) note += ` ${plural(info.cloudOnly, 'cloud-only track')} keep${info.cloudOnly === 1 ? 's' : ''} it on this computer only.`;
  }

  return (
    <Dialog
      title="Artist picture"
      icon="image"
      width={860}
      onClose={onClose}
      actions={(
        <>
          {hasPicture && <button className="btn-ghost" onClick={remove} disabled={saving} style={{ marginRight: 'auto' }}><Icon name="trash" />Remove</button>}
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => save()} disabled={!pick || saving}>{saving ? 'Saving…' : 'Save picture'}</button>
        </>
      )}
    >
      <div className="cov-body">
        <div className="cov-side">
          {pick ? <Cover src={pick.thumb} className="cov-big" /> : <ArtistPicture name={name} file={file} className="cov-big" />}
          <small className="cov-cap">{pick ? `${pick.label}${pick.size ? ` · ${pick.size}` : ''}` : hasPicture ? 'Current picture' : 'No picture yet: this is an album cover'}</small>
          <button className="btn-ghost" onClick={upload}><Icon name="plus" />Upload picture…</button>
          <small className="cov-cap">{note}</small>
          {work && work.total > 0 && (
            <div className="artist-progress">
              <Progress value={(work.done / work.total) * 100} />
              <small className="cov-cap">Writing to {work.done.toLocaleString()} of {plural(work.total, 'track')}…</small>
              <button className="btn-ghost sm" onClick={() => window.ipcRenderer.invoke('artists:stop')}>Stop</button>
            </div>
          )}
          {problem && <small className="cov-problem">{problem}</small>}
          {readOnly > 0 && pick && <button className="btn-ghost sm" onClick={() => save(true)} disabled={saving} title="Writes the picture into them, then makes them read-only again">Write to them anyway</button>}
        </div>
        <div className="cov-main">
          <div className="tabs cov-tabs">
            <button type="button" className={onYoutube ? '' : 'on'} onClick={() => openTab('sources')}>Sources</button>
            <button type="button" className={onYoutube ? 'on' : ''} onClick={() => openTab('youtube')}>YouTube</button>
            <div className="tabs-end">
              <button type="button" className="btn-ghost sm" onClick={openVgmdb} title="VGMdb has no API, so this opens its search in your browser. Save a picture from there, then use Upload picture."><Icon name="search" />Find on VGMdb</button>
            </div>
          </div>
          <form className="lyr-query" onSubmit={submit}>
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Artist" aria-label="Artist" />
            <button className="btn-ghost" type="submit" disabled={working}><Icon name="search" />Search</button>
          </form>
          <div className="cov-results">
            {working && <div className="lyr-empty"><span className="ring" />Searching…</div>}
            {!working && !shown.length && <div className="lyr-empty">{nothing}</div>}
            {!working && shown.length > 0 && (
              <div className="cov-grid">
                {shown.map((r, i) => (
                  <button
                    key={`${r.thumb}${i}`}
                    className={`cov-item ${pick?.thumb === r.thumb ? 'on' : ''}`}
                    onClick={() => setPick({ image: r.image, thumb: r.thumb, label: labelOf(r.source), size: r.size })}
                    title={r.artist || ''}
                  >
                    <img src={r.thumb} alt="" loading="lazy" draggable={false} onError={() => setBroken(s => new Set(s).add(r.thumb))} />
                    <span className="badge b-cloud">{labelOf(r.source)}</span>
                    <b>{r.artist}</b>
                    {r.size && <small>{r.size}</small>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!onYoutube && !busy && errorIds.length > 0 && <div className="lyr-errors">Not reached: {errorIds.map(id => `${labelOf(id)} (${errors[id]})`).join(', ')}</div>}
        </div>
      </div>
    </Dialog>
  );
};

export default ArtistPictureDialog;
