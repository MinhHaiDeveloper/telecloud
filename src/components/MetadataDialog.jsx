import React, { useContext, useEffect, useState } from 'react';
import { Dialog, Field } from './ui';
import Cover from './Cover';
import Icon from './Icon';
import SongActions from './songActions';
import { coverTargets } from '../utils/audio';
import { t } from '../i18n';

const FIELDS = [
  { key: 'title', get label() { return t('Title'); }, single: true },
  { key: 'artist', get label() { return t('Artist'); }, get hint() { return t('Separate several artists with commas'); } },
  { key: 'album', get label() { return t('Album'); } },
  { key: 'albumArtist', get label() { return t('Album artist'); } },
  { key: 'year', get label() { return t('Year'); }, small: true },
  { key: 'genre', get label() { return t('Genre'); }, small: true },
  { key: 'track', get label() { return t('Track no.'); }, small: true, single: true },
  { key: 'disc', get label() { return t('Disc no.'); }, small: true },
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
  const { onEditCover, allFiles } = useContext(SongActions);
  const [newCover, setNewCover] = useState(null); // an uploaded picture, written when you press Save
  const [coverError, setCoverError] = useState('');
  const upload = async () => {
    setCoverError('');
    const r = await window.ipcRenderer.invoke('covers:pick');
    if (!r?.success) setCoverError(r?.error || t('Could not open that picture'));
    else if (r.picked) setNewCover(r.picked);
  };
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

  const [readOnly, setReadOnly] = useState(0); // files that refused only because they are read-only
  const save = async (allowReadOnly = false) => {
    const changes = Object.fromEntries(Object.keys(touched).map(k => [k, values[k] === MIXED ? '' : values[k]]));
    if (!Object.keys(changes).length && !newCover) { onClose(); return; }
    setSaving(true);
    if (newCover) {
      const c = await window.ipcRenderer.invoke('covers:save', { paths: coverTargets(files, allFiles).map(f => f.path), image: { file: newCover.file }, allowReadOnly });
      if (!c?.success || c.errors?.length) {
        setSaving(false);
        setReadOnly(c?.errors?.filter(e => e.readOnly).length || 0);
        setCoverError(c?.error || t('{length|# file|# files} could not be changed: {error}', { length: c.errors.length, error: c.errors[0].error }));
        return;
      }
      if (!Object.keys(changes).length) { setSaving(false); onDone?.({ success: true, files: [], coverOnly: true }); onClose(); return; }
    }
    const r = await window.ipcRenderer.invoke('tags:edit', { paths: files.map(f => f.path), changes, allowReadOnly });
    setSaving(false);
    setReadOnly(r?.errors?.filter(e => e.readOnly).length || 0);
    onDone?.(r);
    if (r?.success && !r.errors?.length) onClose();
  };

  return (
    <Dialog
      title={many ? t('Edit {length} tracks', { length: files.length }) : t('Edit track info')}
      icon="music"
      width={620}
      onClose={onClose}
      actions={(
        <>
          <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
          {readOnly > 0 && <button className="btn-ghost" onClick={() => save(true)} disabled={saving} title={t('Writes the changes, then makes the files read-only again')}>{t('Write to read-only {value}', { value: readOnly === 1 ? t('file') : t('{readOnly} files', { readOnly }) })}</button>}
          <button className="btn-primary" onClick={() => save()} disabled={!values || saving}>{saving ? t('Saving…') : t('Save')}</button>
        </>
      )}
    >
      {!values ? <div className="lyr-empty"><span className="ring" />{t('Reading tags…')}</div> : (
        <div className="meta-form">
          <div className="meta-cover">
            {newCover ? <Cover src={newCover.thumb} /> : <Cover file={files[0]} />}
            <div className="meta-cover-side">
              <small>{newCover ? t('{name} · {width} × {height} · saved when you press Save', { name: newCover.name, width: newCover.width, height: newCover.height }) : t('Album cover')}</small>
              <div className="btn-row">
                <button className="btn-ghost sm" onClick={upload}><Icon name="plus" />{t('Upload picture…')}</button>
                {onEditCover && <button className="btn-ghost sm" onClick={() => onEditCover(files)}><Icon name="search" />{t('Search online…')}</button>}
              </div>
              {coverError && <small className="cov-problem">{coverError}</small>}
            </div>
          </div>
          {FIELDS.filter(f => !(many && f.single)).map(f => (
            <div key={f.key} className={f.small ? 'small' : ''}>
              <Field label={f.label} hint={f.hint}>
                <input
                  className={`input ${values[f.key] === MIXED ? 'mixed' : ''}`}
                  value={values[f.key] === MIXED ? '' : values[f.key]}
                  placeholder={values[f.key] === MIXED ? t('Multiple values (unchanged)') : (!many && files[0].metadata?.inferred?.includes(f.key) ? t('Not in the file. Showing: {value}', { value: files[0].metadata[f.key] }) : '')}
                  inputMode={['year', 'track', 'disc'].includes(f.key) ? 'numeric' : undefined}
                  onChange={(e) => { setValues(v => ({ ...v, [f.key]: e.target.value })); setTouched(t => ({ ...t, [f.key]: true })); }}
                />
              </Field>
            </div>
          ))}
          <p className="meta-note">
            {cloudOnly ? t('{cloudOnly} cloud-only {cloudOnly|track changes|tracks change} in your library and TeleCloud index only. ', { cloudOnly }) : ''}
            {backedUp - cloudOnly > 0 ? t('Backed-up files are uploaded again after the change, so TeleCloud keeps the same tags.') : ''}
            {!cloudOnly && backedUp === 0 ? t('Tags are written into the files.') : ''}
          </p>
        </div>
      )}
    </Dialog>
  );
};

export default MetadataDialog;
