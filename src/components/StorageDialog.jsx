import React, { useMemo, useState } from 'react';
import Icon from './Icon';
import { Dialog, Callout } from './ui';
import { formatBytes } from '../utils/audio';

/**
 * "Back up to…" for a track, an album, a playlist or the favourites. Each track lives in one
 * storage: tracks not in TeleCloud yet are uploaded to the chosen one; tracks already in another
 * storage can be moved there instead (forwarded on Telegram, no re-upload).
 */
const StorageDialog = ({ files, label, storages, onClose, onDone }) => {
  const [target, setTarget] = useState(() => (storages.find(s => s.isDefault) || storages[0])?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const byPeer = useMemo(() => new Map(storages.map(s => [String(s.peerId), s])), [storages]);
  const targetStorage = storages.find(s => s.id === target);

  const plan = useMemo(() => {
    const upload = [];
    const here = [];
    const elsewhere = new Map(); // storage title -> files
    let unavailable = 0;
    for (const f of files) {
      if (f.telegram_message_id) {
        const s = byPeer.get(String(f.telegram_channel_id));
        if (s && s.id === target) here.push(f);
        else {
          const key = s ? s.title : 'another chat';
          if (!elsewhere.has(key)) elsewhere.set(key, []);
          elsewhere.get(key).push(f);
        }
      } else if ((f.storage_type || 'local') === 'cloud' || f.path.startsWith('tc://')) unavailable++;
      else upload.push(f);
    }
    return { upload, here, elsewhere, unavailable, moveCount: [...elsewhere.values()].reduce((a, l) => a + l.length, 0) };
  }, [files, target, byPeer]);

  const run = async (kind) => {
    setBusy(true);
    setError('');
    try {
      const ipc = window.ipcRenderer;
      if (kind === 'upload') {
        const r = await ipc.invoke('telecloud-sync:backup-to', { paths: plan.upload.map(f => f.path), storageId: target });
        if (!r.success) throw new Error(r.error);
        onDone?.(`${r.queued} ${r.queued === 1 ? 'track' : 'tracks'} queued for ${targetStorage.title}`);
      } else {
        const paths = [...plan.elsewhere.values()].flat().map(f => f.path);
        const r = await ipc.invoke('telecloud-sync:move-to', { paths, storageId: target });
        if (!r.success) throw new Error(r.error);
        onDone?.(`Moved ${r.moved} ${r.moved === 1 ? 'track' : 'tracks'} to ${targetStorage.title}`);
      }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const bytes = plan.upload.reduce((a, f) => a + (f.size || 0), 0);
  return (
    <Dialog open title={`Back up ${label}`} icon="cloud" width={520} onClose={onClose}
      actions={<>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        {plan.moveCount > 0 && <button className="btn-ghost" onClick={() => run('move')} disabled={busy}>Move {plan.moveCount} here</button>}
        <button className="btn-primary" onClick={() => run('upload')} disabled={busy || !plan.upload.length}>
          {busy ? 'Working…' : plan.upload.length ? `Back up ${plan.upload.length} ${plan.upload.length === 1 ? 'track' : 'tracks'}` : 'Nothing to back up'}
        </button>
      </>}>
      <div className="storage-pick">
        {storages.map(s => (
          <label key={s.id} className={`radio-card ${target === s.id ? 'on' : ''}`}>
            <input type="radio" name="storage-target" checked={target === s.id} onChange={() => setTarget(s.id)} />
            <span className="radio-dot" />
            <div>
              <b>{s.title}{s.isDefault && <span className="badge b-local" style={{ marginLeft: 8 }}>Default</span>}</b>
              <span>{s.kind === 'self' ? 'Saved Messages' : s.kind === 'group' ? 'Private group' : 'Private channel'} · {s.tracks.toLocaleString()} tracks · {formatBytes(s.bytes)}</span>
            </div>
          </label>
        ))}
      </div>
      <div className="storage-plan">
        {plan.upload.length > 0 && <div><Icon name="upload" /><span><b>{plan.upload.length}</b> {plan.upload.length === 1 ? 'track' : 'tracks'} ({formatBytes(bytes)}) will be uploaded to <b>{targetStorage?.title}</b>.</span></div>}
        {plan.here.length > 0 && <div><Icon name="check" /><span><b>{plan.here.length}</b> already in {targetStorage?.title}.</span></div>}
        {[...plan.elsewhere.entries()].map(([title, list]) => (
          <div key={title}><Icon name="cloud" /><span><b>{list.length}</b> already in <b>{title}</b>: not uploaded again. Use “Move {plan.moveCount} here” to keep them in {targetStorage?.title} instead.</span></div>
        ))}
        {plan.unavailable > 0 && <div><Icon name="alert" /><span><b>{plan.unavailable}</b> not on this computer, so they can't be uploaded.</span></div>}
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
};

export default StorageDialog;
