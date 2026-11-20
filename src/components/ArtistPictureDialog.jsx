import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Cover from './Cover';
import ArtistPicture from './ArtistPicture';
import { Dialog, Progress, confirmDialog } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';


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
    ipcOn(window.ipcRenderer, 'artists:progress', on);
    return () => ipcOff(window.ipcRenderer, 'artists:progress', on);
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
    const r = await window.ipcRenderer.invoke('artists:youtube', { artist }).catch(() => ({ error: t('Could not ask YouTube.') }));
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
    if (!r?.success) { setProblem(r?.error || t('Could not open that picture')); return; }
    if (r.picked) setPick({ image: { file: r.picked.file }, thumb: r.picked.thumb, label: r.picked.name, size: `${r.picked.width} × ${r.picked.height}` });
  };
  const report = (r, did) => {
    if (!r?.success) { setProblem(r?.error || t('Could not do that')); return; }
    if (r.stopped) {
      onSaved?.(r);
      setProblem(t('Stopped. {count|# track|# tracks} of {total} already have it; save again to finish.', { count: r.tags, total: r.total.toLocaleString() }));
      return;
    }
    if (!r.errors?.length) { onSaved?.(r); onClose(); return; }
    const n = r.errors.length;
    const blocked = r.errors.filter(e => e.readOnly).length;
    setReadOnly(blocked);
    setProblem(t('{did} {count|# file|# files} could not be changed: {value}', { did, count: n, value: blocked === n ? (n === 1 ? t('it is read-only.') : t('they are read-only.')) : r.errors[0].error }));
  };
  const save = async (allowReadOnly = false) => {
    setSaving(true);
    setProblem('');
    setReadOnly(0);
    const r = await window.ipcRenderer.invoke('artists:save', { name, image: pick.image, allowReadOnly });
    setSaving(false);
    report(r, t('The picture was saved here, but'));
  };
  const remove = async () => {
    const message = info?.local ? t('It also leaves the tags of {count|# track|# tracks}.{value}', { count: info.local, value: info.backedUp ? t(' Backed-up files that change are uploaded again.') : '' }) : t('The artist goes back to showing an album cover.');
    if (!await confirmDialog({ title: t('Remove the artist picture?'), message, confirmLabel: t('Remove'), danger: true })) return;
    setSaving(true);
    setProblem('');
    const r = await window.ipcRenderer.invoke('artists:remove', { name });
    setSaving(false);
    report(r, t('The picture was removed here, but'));
  };

  const labelOf = (id) => (id === 'youtube' ? 'YouTube' : opts?.sources?.[id]?.label || id);
  const onYoutube = tab === 'youtube';
  const working = onYoutube ? !!yt?.busy : busy;
  const shown = (onYoutube ? yt?.results || [] : results).filter(r => !broken.has(r.thumb));
  const nothing = onYoutube && yt?.needsKey ? t('YouTube needs an API key. Add one in Settings, General, Artist pictures.')
    : onYoutube && yt?.error ? yt.error : t('Nothing found. Try another spelling, or upload a picture.');
  const errorIds = Object.keys(errors);
  let note = '';
  if (info) {
    note = info.local ? t('Saved in the tags of {count|# track|# tracks}.', { count: info.local }) : t('No file here can hold it, so it is kept on this computer only.');
    if (info.skipped) note += t(' {count|# M4A or similar file|# M4A or similar files} left alone: that format would show it as a second album cover.', { count: info.skipped });
    if (info.backedUp) note += t(' {count|# backed-up file|# backed-up files} will be uploaded again.', { count: info.backedUp });
    if (info.cloudOnly) note += t(' {count|# cloud-only track|# cloud-only tracks} {cloudOnly|keeps|keep} it on this computer only.', { count: info.cloudOnly, cloudOnly: info.cloudOnly });
  }

  return (
    <Dialog
      title={t('Artist picture')}
      icon="image"
      width={860}
      onClose={onClose}
      actions={(
        <>
          {hasPicture && <button className="btn-ghost" onClick={remove} disabled={saving} style={{ marginRight: 'auto' }}><Icon name="trash" />{t('Remove')}</button>}
          <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn-primary" onClick={() => save()} disabled={!pick || saving}>{saving ? t('Saving…') : t('Save picture')}</button>
        </>
      )}
    >
      <div className="cov-body">
        <div className="cov-side">
          {pick ? <Cover src={pick.thumb} className="cov-big" /> : <ArtistPicture name={name} file={file} className="cov-big" />}
          <small className="cov-cap">{pick ? `${pick.label}${pick.size ? ` · ${pick.size}` : ''}` : hasPicture ? t('Current picture') : t('No picture yet: this is an album cover')}</small>
          <button className="btn-ghost" onClick={upload}><Icon name="plus" />{t('Upload picture…')}</button>
          <small className="cov-cap">{note}</small>
          {work && work.total > 0 && (
            <div className="artist-progress">
              <Progress value={(work.done / work.total) * 100} />
              <small className="cov-cap">{t('Writing to {done} of', { done: work.done.toLocaleString() })} {t('{n|# track|# tracks}', { n: work.total })}…</small>
              <button className="btn-ghost sm" onClick={() => window.ipcRenderer.invoke('artists:stop')}>{t('Stop')}</button>
            </div>
          )}
          {problem && <small className="cov-problem">{problem}</small>}
          {readOnly > 0 && pick && <button className="btn-ghost sm" onClick={() => save(true)} disabled={saving} title={t('Writes the picture into them, then makes them read-only again')}>{t('Write to them anyway')}</button>}
        </div>
        <div className="cov-main">
          <div className="tabs cov-tabs">
            <button type="button" className={onYoutube ? '' : 'on'} onClick={() => openTab('sources')}>{t('Sources')}</button>
            <button type="button" className={onYoutube ? 'on' : ''} onClick={() => openTab('youtube')}>YouTube</button>
            <div className="tabs-end">
              <button type="button" className="btn-ghost sm" onClick={openVgmdb} title={t('VGMdb has no API, so this opens its search in your browser. Save a picture from there, then use Upload picture.')}><Icon name="search" />{t('Find on VGMdb')}</button>
            </div>
          </div>
          <form className="lyr-query" onSubmit={submit}>
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Artist')} aria-label={t('Artist')} />
            <button className="btn-ghost" type="submit" disabled={working}><Icon name="search" />{t('Search')}</button>
          </form>
          <div className="cov-results">
            {working && <div className="lyr-empty"><span className="ring" />{t('Searching…')}</div>}
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
          {!onYoutube && !busy && errorIds.length > 0 && <div className="lyr-errors">{t('Not reached: {map}', { map: errorIds.map(id => `${labelOf(id)} (${errors[id]})`).join(', ') })}</div>}
        </div>
      </div>
    </Dialog>
  );
};

export default ArtistPictureDialog;
