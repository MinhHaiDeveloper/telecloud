import React, { useEffect, useState } from 'react';
import { Dialog, Field } from './ui';

const FIELDS = [
  { key: 'title', label: 'Title', single: true },
  { key: 'artist', label: 'Artist', hint: 'Separate several artists with commas' },
  { key: 'album', label: 'Album' },
  { key: 'albumArtist', label: 'Album artist' },
  { key: 'year', label: 'Year', small: true },
  { key: 'genre', label: 'Genre', small: true },
  { key: 'track', label: 'Track no.', small: true, single: true },
  { key: 'disc', label: 'Disc no.', small: true },
];
const MIXED = '\u0000mixed';

/**
 * Edit tags of one track or many. With several tracks, a field whose values differ shows
 * "Multiple values" and is only written if you type into it.
 */
const MetadataDialog = ({ files, onClose, onDone }) => {
  const many = files.length > 1;
  const [values, setValues] = useState(null);
  const [touched, setTouched] = useState({});
  const [saving, setSaving] = useState(false);
  const cloudOnly = files.filter(f => (f.storage_type || 'local') === 'cloud' || f.path.startsWith('tc://')).length;
  const backedUp = files.filter(f => f.telegram_message_id).length;

  useEffect(() => {
    let alive = true;
    (async () => {
      const all = await Promise.all(files.slice(0, 200).map(f => window.ipcRenderer.invoke('tags:read', { path: f.path }).then(r => r?.tags || {})));
      if (!alive) return;
      const v = {};
      FIELDS.forEach(({ key }) => {
        const set = new Set(all.map(t => String(t[key] ?? '')));
        v[key] = set.size === 1 ? [...set][0] : MIXED;
      });
      setValues(v);
    })();
    return () => { alive = false; };
  }, [files]);

  const save = async () => {
    const changes = Object.fromEntries(Object.keys(touched).map(k => [k, values[k] === MIXED ? '' : values[k]]));
    if (!Object.keys(changes).length) { onClose(); return; }
    setSaving(true);
    const r = await window.ipcRenderer.invoke('tags:edit', { paths: files.map(f => f.path), changes });
    setSaving(false);
    onDone?.(r);
    if (r?.success && !r.errors?.length) onClose();
  };

  return (
    <Dialog
      title={many ? `Edit ${files.length} tracks` : 'Edit track info'}
      icon="music"
      width={620}
      onClose={onClose}
      actions={(
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={!values || saving}>{saving ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      {!values ? <div className="lyr-empty"><span className="ring" />Reading tags…</div> : (
        <div className="meta-form">
          {FIELDS.filter(f => !(many && f.single)).map(f => (
            <div key={f.key} className={f.small ? 'small' : ''}>
              <Field label={f.label} hint={f.hint}>
                <input
                  className={`input ${values[f.key] === MIXED ? 'mixed' : ''}`}
                  value={values[f.key] === MIXED ? '' : values[f.key]}
                  placeholder={values[f.key] === MIXED ? 'Multiple values (unchanged)' : ''}
                  inputMode={['year', 'track', 'disc'].includes(f.key) ? 'numeric' : undefined}
                  onChange={(e) => { setValues(v => ({ ...v, [f.key]: e.target.value })); setTouched(t => ({ ...t, [f.key]: true })); }}
                />
              </Field>
            </div>
          ))}
          <p className="meta-note">
            {cloudOnly ? `${cloudOnly} cloud-only ${cloudOnly === 1 ? 'track changes' : 'tracks change'} in your library and TeleCloud index only. ` : ''}
            {backedUp - cloudOnly > 0 ? 'Backed-up files are uploaded again after the change, so TeleCloud keeps the same tags.' : ''}
            {!cloudOnly && backedUp === 0 ? 'Tags are written into the files.' : ''}
          </p>
        </div>
      )}
    </Dialog>
  );
};

export default MetadataDialog;
