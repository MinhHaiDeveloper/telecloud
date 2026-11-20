import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

/** Settings → General → Last.fm: connect an account, scrobble on/off */
const LastfmSettings = () => {
  const [s, setS] = useState(null);
  const [step, setStep] = useState('idle'); // idle | waiting (approve in the browser) | busy
  const [error, setError] = useState('');
  const ipc = window.ipcRenderer;
  useEffect(() => {
    ipc.invoke('lastfm:status').then(setS);
    const on = (e, st) => setS(st);
    ipcOn(ipc, 'lastfm:status', on);
    return () => ipcOff(ipc, 'lastfm:status', on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;

  const start = async () => {
    setError('');
    const r = await ipc.invoke('lastfm:connect');
    if (r?.success) setStep('waiting'); else setError(r?.error || t('Could not reach Last.fm'));
  };
  const finish = async () => {
    setStep('busy');
    const r = await ipc.invoke('lastfm:finish');
    if (r?.success) { setStep('idle'); setS(await ipc.invoke('lastfm:status')); } else { setStep('waiting'); setError(r?.error?.includes('authorized') || r?.error?.includes('Unauthorized') ? t('Last.fm has not been allowed yet. Press "Yes, allow access" in the browser first.') : r?.error); }
  };

  return (
    <section className="set-section">
      <h3>Last.fm</h3>
      <div className="card set-card">
        {!s.available ? (
          <SettingRow icon="info" title={t('Not available in this build')} desc={t('Last.fm needs an API key that this build was made without.')} muted />
        ) : s.user ? (
          <>
            <SettingRow icon="user" title={<>{t('Connected as')} <b>{s.user}</b></>} desc={s.pending ? t('{pending|# play|# plays} waiting to be sent', { pending: s.pending }) : t('Plays are sent as soon as they count (half the track or 4 minutes).')}>
              <button className="btn-outline danger" onClick={() => ipc.invoke('lastfm:disconnect')}>{t('Disconnect')}</button>
            </SettingRow>
            <SettingRow icon="chart" title={t('Scrobble plays')} desc={t('Also shows what you are listening to now on your Last.fm profile.')}>
              <Toggle checked={s.scrobble} onChange={(v) => ipc.invoke('lastfm:set-scrobble', v)} />
            </SettingRow>
          </>
        ) : (
          <SettingRow icon="chart" title={t('Scrobble to Last.fm')} desc={step === 'waiting' ? t('Last.fm opened in your browser. Allow TeleCloud there, then come back and finish.') : t('Keep a history of what you play on your Last.fm profile, and get artist biographies.')}>
            {step === 'idle' && <button className="btn-primary" onClick={start}>{t('Connect')}</button>}
            {step !== 'idle' && <button className="btn-primary" onClick={finish} disabled={step === 'busy'}>{step === 'busy' ? t('Connecting…') : t('I allowed it, finish')}</button>}
          </SettingRow>
        )}
        {error && <div className="set-sub" style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </div>
    </section>
  );
};

export default LastfmSettings;
