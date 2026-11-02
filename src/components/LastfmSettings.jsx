import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';

/** Settings → General → Last.fm: connect an account, scrobble on/off */
const LastfmSettings = () => {
  const [s, setS] = useState(null);
  const [step, setStep] = useState('idle'); // idle | waiting (approve in the browser) | busy
  const [error, setError] = useState('');
  const ipc = window.ipcRenderer;
  useEffect(() => {
    ipc.invoke('lastfm:status').then(setS);
    const on = (e, st) => setS(st);
    ipc.on('lastfm:status', on);
    return () => ipc.removeListener?.('lastfm:status', on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;

  const start = async () => {
    setError('');
    const r = await ipc.invoke('lastfm:connect');
    if (r?.success) setStep('waiting'); else setError(r?.error || 'Could not reach Last.fm');
  };
  const finish = async () => {
    setStep('busy');
    const r = await ipc.invoke('lastfm:finish');
    if (r?.success) { setStep('idle'); setS(await ipc.invoke('lastfm:status')); } else { setStep('waiting'); setError(r?.error?.includes('authorized') || r?.error?.includes('Unauthorized') ? 'Last.fm has not been allowed yet. Press "Yes, allow access" in the browser first.' : r?.error); }
  };

  return (
    <section className="set-section">
      <h3>Last.fm</h3>
      <div className="card set-card">
        {!s.available ? (
          <SettingRow icon="info" title="Not available in this build" desc="Last.fm needs an API key that this build was made without." muted />
        ) : s.user ? (
          <>
            <SettingRow icon="user" title={<>Connected as <b>{s.user}</b></>} desc={s.pending ? `${s.pending} ${s.pending === 1 ? 'play' : 'plays'} waiting to be sent` : 'Plays are sent as soon as they count (half the track or 4 minutes).'}>
              <button className="btn-outline danger" onClick={() => ipc.invoke('lastfm:disconnect')}>Disconnect</button>
            </SettingRow>
            <SettingRow icon="chart" title="Scrobble plays" desc="Also shows what you are listening to now on your Last.fm profile.">
              <Toggle checked={s.scrobble} onChange={(v) => ipc.invoke('lastfm:set-scrobble', v)} />
            </SettingRow>
          </>
        ) : (
          <SettingRow icon="chart" title="Scrobble to Last.fm" desc={step === 'waiting' ? 'Last.fm opened in your browser. Allow TeleCloud there, then come back and finish.' : 'Keep a history of what you play on your Last.fm profile, and get artist biographies.'}>
            {step === 'idle' && <button className="btn-primary" onClick={start}>Connect</button>}
            {step !== 'idle' && <button className="btn-primary" onClick={finish} disabled={step === 'busy'}>{step === 'busy' ? 'Connecting…' : 'I allowed it, finish'}</button>}
          </SettingRow>
        )}
        {error && <div className="set-sub" style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </div>
    </section>
  );
};

export default LastfmSettings;
