import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

const ago = (time) => {
  if (!time) return '';
  const m = Math.round((Date.now() - time) / 60000);
  return m < 1 ? t('just now') : m < 60 ? t('{m} min ago', { m }) : t('{h} h ago', { h: Math.round(m / 60) });
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
    if (r?.success) { setToken(''); setS(await ipc.invoke('listenbrainz:status')); } else setError(r?.error || t('Could not reach ListenBrainz'));
  };
  const openSettings = () => ipc.invoke('open-external', 'https://listenbrainz.org/settings/');

  const sentLine = s.lastError ? t('Not sent yet: {lastError}. Tried again with the next play.', { lastError: s.lastError })
    : s.pending ? t('{pending|# listen|# listens} waiting to be sent', { pending: s.pending })
      : s.lastSend ? t('Everything sent (last {ago}).', { ago: ago(s.lastSend) }) : t('Listens are sent as soon as they count (half the track or 4 minutes).');

  return (
    <section className="set-section lb-settings">
      <h3>ListenBrainz</h3>
      <div className="card set-card">
        {s.user && s.refused ? (
          <SettingRow icon="info" title={<>{t('ListenBrainz refused the token of')} <b>{s.user}</b></>} desc={t('It was reset or removed on listenbrainz.org. Nothing is sent until you add the new one; your plays wait.')}>
            <button className="btn-outline danger" onClick={() => ipc.invoke('listenbrainz:disconnect')}>{t('Remove')}</button>
          </SettingRow>
        ) : s.user ? (
          <>
            <SettingRow icon="user" title={<>{t('Connected as')} <b>{s.user}</b></>} desc={sentLine}>
              <button className="btn-outline danger" onClick={() => ipc.invoke('listenbrainz:disconnect')}>{t('Disconnect')}</button>
            </SettingRow>
            <SettingRow icon="chart" title={t('Send listens')} desc={t('Also shows what you are listening to now on your ListenBrainz profile. Tracks are matched to MusicBrainz when it is sure, so listens link to the right recording.')}>
              <Toggle checked={s.scrobble} onChange={(v) => ipc.invoke('listenbrainz:set-scrobble', v)} />
            </SettingRow>
          </>
        ) : null}
        {(!s.user || s.refused) && (
          <SettingRow icon="chart" title={s.refused ? t('Add the new token') : t('Send listens to ListenBrainz')} desc={<>{t('Open source and free, run by the MetaBrainz Foundation. Paste your user token from {button}; it stays on this computer, encrypted.', { button: <button className="link-btn" style={{ marginLeft: 0 }} onClick={openSettings}>{t('listenbrainz.org/settings')}</button> })}</>}>
            <form className="lb-token" onSubmit={connect}>
              <input className="input sm mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('User token')} aria-label={t('ListenBrainz user token')} spellCheck={false} autoComplete="off" />
              <button className="btn-primary" type="submit" disabled={busy || !token.trim()}>{busy ? t('Checking…') : t('Connect')}</button>
            </form>
          </SettingRow>
        )}
        {error && <div className="set-sub lb-error" style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </div>
    </section>
  );
};

export default ListenBrainzSettings;
