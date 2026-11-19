import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';

const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Settings → General → ListenBrainz: the user's own token, sending on/off */
const ListenBrainzSettings = () => {
  const [s, setS] = useState(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ipc = window.ipcRenderer;
  useEffect(() => {
    ipc.invoke('listenbrainz:status').then(setS);
    const on = (e, st) => setS(st);
    ipcOn(ipc, 'listenbrainz:status', on);
    return () => ipcOff(ipc, 'listenbrainz:status', on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;

  const connect = async (e) => {
    e?.preventDefault();
    setError(''); setBusy(true);
    const r = await ipc.invoke('listenbrainz:connect', token);
    setBusy(false);
    if (r?.success) { setToken(''); setS(await ipc.invoke('listenbrainz:status')); } else setError(r?.error || 'Could not reach ListenBrainz');
  };
  const openSettings = () => ipc.invoke('open-external', 'https://listenbrainz.org/settings/');

  const sentLine = s.lastError ? `Not sent yet: ${s.lastError}. Tried again with the next play.`
    : s.pending ? `${s.pending} ${s.pending === 1 ? 'listen' : 'listens'} waiting to be sent`
      : s.lastSend ? `Everything sent (last ${ago(s.lastSend)}).` : 'Listens are sent as soon as they count (half the track or 4 minutes).';

  return (
    <section className="set-section lb-settings">
      <h3>ListenBrainz</h3>
      <div className="card set-card">
        {s.user && s.refused ? (
          <SettingRow icon="info" title={<>ListenBrainz refused the token of <b>{s.user}</b></>} desc="It was reset or removed on listenbrainz.org. Nothing is sent until you add the new one; your plays wait.">
            <button className="btn-outline danger" onClick={() => ipc.invoke('listenbrainz:disconnect')}>Remove</button>
          </SettingRow>
        ) : s.user ? (
          <>
            <SettingRow icon="user" title={<>Connected as <b>{s.user}</b></>} desc={sentLine}>
              <button className="btn-outline danger" onClick={() => ipc.invoke('listenbrainz:disconnect')}>Disconnect</button>
            </SettingRow>
            <SettingRow icon="chart" title="Send listens" desc="Also shows what you are listening to now on your ListenBrainz profile. Tracks are matched to MusicBrainz when it is sure, so listens link to the right recording.">
              <Toggle checked={s.scrobble} onChange={(v) => ipc.invoke('listenbrainz:set-scrobble', v)} />
            </SettingRow>
          </>
        ) : null}
        {(!s.user || s.refused) && (
          <SettingRow icon="chart" title={s.refused ? 'Add the new token' : 'Send listens to ListenBrainz'} desc={<>Open source and free, run by the MetaBrainz Foundation. Paste your user token from <button className="link-btn" style={{ marginLeft: 0 }} onClick={openSettings}>listenbrainz.org/settings</button>; it stays on this computer, encrypted.</>}>
            <form className="lb-token" onSubmit={connect}>
              <input className="input sm mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="User token" aria-label="ListenBrainz user token" spellCheck={false} autoComplete="off" />
              <button className="btn-primary" type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
            </form>
          </SettingRow>
        )}
        {error && <div className="set-sub lb-error" style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </div>
    </section>
  );
};

export default ListenBrainzSettings;
