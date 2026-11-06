import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import Cover from './Cover';
import { Dialog, Segmented } from './ui';
import { albumQuery } from '../utils/audio';

const SAVE_TO = [
  { value: 'file', label: 'cover.jpg' },
  { value: 'tag', label: 'Tag' },
  { value: 'both', label: 'Both' },
];

/** Search every cover source for an album (or upload a picture), pick one, save it for all its tracks */
const CoverDialog = ({ files, onClose, onSaved }) => {
  const start = albumQuery(files);
  const [album, setAlbum] = useState(start.album);
  const [artist, setArtist] = useState(start.artist);
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const [errors, setErrors] = useState({});
  const [pick, setPick] = useState(null); // { image, thumb, label }
  const [broken, setBroken] = useState(() => new Set());
  const [saveTo, setSaveTo] = useState('file');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const [readOnly, setReadOnly] = useState(0); // files that refused the tag only because they are read-only
  const [embedded, setEmbedded] = useState(0); // tracks holding a picture inside
  const paths = files.map(f => f.path);
  const anyLocal = files.some(f => !f.path.startsWith('tc://') && (f.storage_type || 'local') !== 'cloud');

  const run = async (q) => {
    setBusy(true);
    setBroken(new Set());
    const r = await window.ipcRenderer.invoke('covers:search', { query: { ...q, paths }, all: true }).catch(() => null);
    setResults(r?.results || []);
    setErrors(r?.errors || {});
    setBusy(false);
  };
  useEffect(() => {
    window.ipcRenderer.invoke('covers:options').then(o => { setOpts(o); setSaveTo(o.saveTo || 'file'); });
    run({ album: start.album, artist: start.artist });
    window.ipcRenderer.invoke('covers:embedded', { paths }).then(n => setEmbedded(n || 0)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async () => {
    setProblem('');
    const r = await window.ipcRenderer.invoke('covers:pick');
    if (!r?.success) { setProblem(r?.error || 'Could not open that picture'); return; }
    if (r.picked) setPick({ image: { file: r.picked.file }, thumb: r.picked.thumb, label: r.picked.name, size: `${r.picked.width} × ${r.picked.height}` });
  };
  const save = async (allowReadOnly = false) => {
    setSaving(true);
    setProblem('');
    setReadOnly(0);
    const r = await window.ipcRenderer.invoke('covers:save', { paths, image: pick.image, to: saveTo, allowReadOnly });
    setSaving(false);
    if (!r?.success) { setProblem(r?.error || 'Could not save the cover'); return; }
    if (r.file || r.tag || r.cloud) onSaved?.(r);
    if (!r.errors?.length) { onClose(); return; }
    const n = r.errors.length;
    const blocked = r.errors.filter(e => e.readOnly).length;
    setReadOnly(blocked);
    setProblem(`${r.file ? 'cover.jpg was saved. ' : ''}${n} ${n === 1 ? 'file' : 'files'} could not be changed: ${blocked === n ? (n === 1 ? 'it is read-only.' : 'they are read-only.') : r.errors[0].error}`);
  };
  const labelOf = (id) => opts?.sources?.[id]?.label || id;
  const shown = results.filter(r => !broken.has(r.thumb));
  const errorIds = Object.keys(errors);
  const backedUp = files.filter(f => f.telegram_message_id && !f.path.startsWith('tc://') && (f.storage_type || 'local') !== 'cloud').length;
  // what saving does to the music files themselves
  const rewrites = saveTo === 'file' ? embedded : backedUp || embedded;
  let fileNote = '';
  if (saveTo === 'file' && embedded) fileNote = ` ${embedded} already ${embedded === 1 ? 'has' : 'have'} a picture inside, which is replaced too.`;
  if (backedUp && rewrites) fileNote += ' Backed-up files that change are uploaded again.';

  return (
    <Dialog
      title="Album cover"
      icon="image"
      width={860}
      onClose={onClose}
      actions={(
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => save()} disabled={!pick || saving}>{saving ? 'Saving…' : 'Save cover'}</button>
        </>
      )}
    >
      <div className="cov-body">
        <div className="cov-side">
          {pick ? <Cover src={pick.thumb} className="cov-big" /> : <Cover file={files[0]} className="cov-big" />}
          <small className="cov-cap">{pick ? `${pick.label}${pick.size ? ` · ${pick.size}` : ''}` : 'Current cover'}</small>
          <button className="btn-ghost" onClick={upload}><Icon name="plus" />Upload picture…</button>
          {anyLocal && (
            <div className="cov-saveto">
              <small>Save to</small>
              <Segmented value={saveTo} onChange={setSaveTo} size="sm" options={SAVE_TO} />
            </div>
          )}
          <small className="cov-cap">
            For {files.length} {files.length === 1 ? 'track' : 'tracks'}.{fileNote}
          </small>
          {problem && <small className="cov-problem">{problem}</small>}
          {readOnly > 0 && pick && <button className="btn-ghost sm" onClick={() => save(true)} disabled={saving} title="Writes the cover into them, then makes them read-only again">Write to them anyway</button>}
        </div>
        <div className="cov-main">
          <form className="lyr-query" onSubmit={(e) => { e.preventDefault(); run({ album, artist }); }}>
            <input className="input" value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="Album" />
            <input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist" />
            <button className="btn-ghost" type="submit" disabled={busy}><Icon name="search" />Search</button>
          </form>
          <div className="cov-results">
            {busy && <div className="lyr-empty"><span className="ring" />Searching…</div>}
            {!busy && !shown.length && <div className="lyr-empty">Nothing found. Try a shorter album name, or upload a picture.</div>}
            {!busy && shown.length > 0 && (
              <div className="cov-grid">
                {shown.map((r, i) => (
                  <button
                    key={`${r.thumb}${i}`}
                    className={`cov-item ${pick?.thumb === r.thumb ? 'on' : ''}`}
                    onClick={() => setPick({ image: r.image, thumb: r.thumb, label: labelOf(r.source), size: r.size })}
                    title={`${r.album || ''} — ${r.artist || ''}`}
                  >
                    <img src={r.thumb} alt="" loading="lazy" draggable={false} onError={() => setBroken(s => new Set(s).add(r.thumb))} />
                    <span className="badge b-cloud">{labelOf(r.source)}</span>
                    <b>{r.album}{r.year ? ` (${r.year})` : ''}</b>
                    <small>{r.artist}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          {!busy && errorIds.length > 0 && <div className="lyr-errors">Not reached: {errorIds.map(id => `${labelOf(id)} (${errors[id]})`).join(', ')}</div>}
        </div>
      </div>
    </Dialog>
  );
};

export default CoverDialog;
