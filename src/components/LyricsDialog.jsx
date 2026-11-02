import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { Dialog, Segmented } from './ui';

const SAVE_TO = [
  { value: 'tag', label: 'Tag' },
  { value: 'lrc', label: '.lrc file' },
  { value: 'both', label: 'Both' },
];
const firstLines = (text, n = 3) => (text || '').split(/\r?\n/).map(l => l.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean).slice(0, n);

/**
 * Search every lyrics source for a track, pick a result, edit it, save it to the tag and/or a .lrc.
 * `initial` is what the track has now (shown first so it can be edited directly).
 */
const LyricsDialog = ({ file, onClose, onSaved }) => {
  const m = file?.metadata || {};
  const [title, setTitle] = useState(m.title || file?.name || '');
  const [artist, setArtist] = useState(m.artist || '');
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const [errors, setErrors] = useState({});
  const [pick, setPick] = useState(null); // index into results, or -1 for the current lyrics
  const [text, setText] = useState(m.lyrics || '');
  const [saveTo, setSaveTo] = useState('tag');
  const [saving, setSaving] = useState(false);
  const cloudOnly = (file?.storage_type || 'local') === 'cloud' || file?.path?.startsWith('tc://');

  const run = async () => {
    setBusy(true);
    setErrors({});
    const r = await window.ipcRenderer.invoke('lyrics:search', { all: true, track: { path: file.path, title, artist, album: m.album, duration: m.duration, lyrics: m.lyrics } });
    setResults(r?.results || []);
    setErrors(r?.errors || {});
    setBusy(false);
    // start from the best online match when the track has nothing yet
    if (!m.lyrics && r?.results?.length) { setPick(0); setText(r.results[0].lyrics); }
  };

  useEffect(() => {
    window.ipcRenderer.invoke('lyrics:options').then(o => { setOpts(o); setSaveTo(o?.saveTo || 'tag'); });
    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const label = (id) => opts?.sources?.[id]?.label || id;
  const failed = useMemo(() => Object.entries(errors), [errors]);

  const save = async () => {
    setSaving(true);
    const r = await window.ipcRenderer.invoke('lyrics:save', { path: file.path, lyrics: text, to: saveTo });
    setSaving(false);
    if (r?.success) { onSaved?.(r); onClose(); } else onSaved?.({ error: r?.error || 'Could not save' });
  };

  return (
    <Dialog
      title="Lyrics"
      icon="lyrics"
      width={940}
      onClose={onClose}
      actions={(
        <>
          {!cloudOnly && <Segmented value={saveTo} onChange={setSaveTo} options={SAVE_TO} size="sm" />}
          {cloudOnly && <span className="cap muted" style={{ marginRight: 'auto' }}>Cloud-only track: lyrics are kept in your library and TeleCloud index.</span>}
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : text.trim() ? 'Save lyrics' : 'Remove lyrics'}</button>
        </>
      )}
    >
      <div className="lyr">
        <div className="lyr-side">
          <form className="lyr-query" onSubmit={(e) => { e.preventDefault(); run(); }}>
            <input className="input sm" value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
            <input className="input sm" value={artist} onChange={e => setArtist(e.target.value)} placeholder="Artist" aria-label="Artist" />
            <button className="btn-ghost sm" type="submit" disabled={busy}><Icon name="search" />{busy ? 'Searching…' : 'Search'}</button>
          </form>
          <div className="lyr-results">
            {m.lyrics && (
              <button className={`lyr-item ${pick === -1 ? 'on' : ''}`} onClick={() => { setPick(-1); setText(m.lyrics); }}>
                <div className="lyr-top"><b>Current lyrics</b><span className="badge b-local mono">{/^\s*\[\d/m.test(m.lyrics) ? 'Synced' : 'Plain'}</span></div>
                {firstLines(m.lyrics).map((l, i) => <small key={i}>{l}</small>)}
              </button>
            )}
            {results.map((r, i) => (
              <button key={i} className={`lyr-item ${pick === i ? 'on' : ''}`} onClick={() => { setPick(i); setText(r.lyrics); }}>
                <div className="lyr-top">
                  <b>{label(r.source)}</b>
                  <span className={`badge mono ${r.synced ? 'b-lossless' : 'b-local'}`}>{r.synced ? 'Synced' : 'Plain'}</span>
                  {r.score < 0.8 && <span className="badge b-cached mono" title="Title, artist or length differ a little">Close match</span>}
                </div>
                <small className="lyr-match">{r.title} · {r.artist}{r.album ? ` · ${r.album}` : ''}</small>
                {firstLines(r.lyrics).map((l, j) => <small key={j}>{l}</small>)}
              </button>
            ))}
            {!busy && !results.length && <div className="lyr-empty">No lyrics found. Try a shorter title, or type them in.</div>}
            {busy && <div className="lyr-empty"><span className="ring" />Asking {opts ? opts.order.filter(id => !opts.disabled.includes(id)).map(label).join(', ') : 'the sources'}…</div>}
            {failed.length > 0 && <div className="lyr-errors">{failed.map(([id, e]) => <div key={id}>{label(id)}: {e}</div>)}</div>}
          </div>
        </div>
        <div className="lyr-edit">
          <textarea
            className="input mono"
            value={text}
            onChange={e => { setText(e.target.value); setPick(null); }}
            placeholder={'Type or paste lyrics. Synced lines look like:\n[00:12.40]First line\n[00:16.10]Second line'}
            spellCheck={false}
          />
          <small className="muted">{/^\s*\[\d/m.test(text) ? 'Synced (LRC): lines follow the music.' : 'Plain text: shown as a static list.'}</small>
        </div>
      </div>
    </Dialog>
  );
};

export default LyricsDialog;
