import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

const STATUS = {
  connected: { get label() { return t('Connected to Discord'); }, cls: 'b-lossless' },
  waiting: { get label() { return t('Waiting for Discord'); }, cls: 'b-cached' },
};
const DEFAULT_TEXT = '{track} by {artist}';

/** Settings → General → Discord: show what is playing on your Discord status */
const DiscordSettings = () => {
  const [o, setO] = useState(null);
  const [text, setText] = useState('');
  useEffect(() => {
    window.ipcRenderer.invoke('discord:options').then(v => { setO(v); setText(v.statusText); });
    const onStatus = (e, status) => setO(v => (v ? { ...v, status } : v));
    ipcOn(window.ipcRenderer, 'discord:status', onStatus);
    return () => ipcOff(window.ipcRenderer, 'discord:status', onStatus);
  }, []);
  // the status text is saved shortly after typing stops
  useEffect(() => {
    if (!o || text === o.statusText) return undefined;
    const t = setTimeout(() => set({ statusText: text.trim() ? text : DEFAULT_TEXT }), 500);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o) return null;
  function set(patch) {
    setO(v => ({ ...v, ...patch, status: patch.enabled === false ? 'off' : v.status }));
    window.ipcRenderer.invoke('discord:set-options', patch);
  }
  const badge = STATUS[o.status];
  return (
    <section className="set-section">
      <div className="head-row">
        <h3>Discord</h3>
        {o.enabled && badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
      </div>
      <div className="card set-card">
        <SettingRow icon="user" title={t('Show what you are listening to')} desc={t('On your Discord status, for others to see. Needs the Discord desktop app running on this computer.')}>
          <Toggle checked={o.enabled} onChange={(v) => set({ enabled: v })} />
        </SettingRow>
        <SettingRow icon="queue" title={t('Show while paused')} desc={t('Off: your status clears when the music is paused.')} muted={!o.enabled}>
          <Toggle checked={o.showPaused} onChange={(v) => set({ showPaused: v })} disabled={!o.enabled} />
        </SettingRow>
        <SettingRow icon="clock" title={t('Show the last track played')} desc={t('While TeleCloud is open with nothing loaded, your status shows the last track you played. Discord clears your status when TeleCloud closes.')} muted={!o.enabled}>
          <Toggle checked={o.showLastPlayed} onChange={(v) => set({ showLastPlayed: v })} disabled={!o.enabled} />
        </SettingRow>
        <SettingRow icon="image" title={t('Show the album cover')} desc={t('Looks for the album on the online cover sources and shows their picture. Your files are never uploaded. Albums it can\'t find show the TeleCloud logo. The small artist picture is the one you chose, found again online if needed; one you uploaded yourself isn\'t online, so none shows. Off: always the logo, and no search.')} muted={!o.enabled}>
          <Toggle checked={o.onlineCover} onChange={(v) => set({ onlineCover: v })} disabled={!o.enabled} />
        </SettingRow>
        <SettingRow icon="download" title={t('Show a Get TeleCloud button')} desc={t('A button on your status that opens the TeleCloud website. Others can click it.')} muted={!o.enabled}>
          <Toggle checked={o.showButton} onChange={(v) => set({ showButton: v })} disabled={!o.enabled} />
        </SettingRow>
        <SettingRow icon="lyrics" title={t('Status text')} desc={t('You can use {track}, {artist} and {album}.')} muted={!o.enabled}>
          <input className="input discord-text" value={text} disabled={!o.enabled} placeholder={DEFAULT_TEXT} maxLength={120} aria-label={t('Status text')} onChange={(e) => setText(e.target.value)} />
        </SettingRow>
      </div>
    </section>
  );
};

export default DiscordSettings;
