import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';

const STATUS = {
  connected: { label: 'Connected to Discord', cls: 'b-lossless' },
  waiting: { label: 'Waiting for Discord', cls: 'b-cached' },
};
const DEFAULT_TEXT = '{track} by {artist}';

/** Settings → General → Discord: show what is playing on your Discord status */
const DiscordSettings = () => {
  const [o, setO] = useState(null);
  const [text, setText] = useState('');
  useEffect(() => {
    window.ipcRenderer.invoke('discord:options').then(v => { setO(v); setText(v.statusText); });
    const onStatus = (e, status) => setO(v => (v ? { ...v, status } : v));
    window.ipcRenderer.on('discord:status', onStatus);
    return () => window.ipcRenderer.removeListener?.('discord:status', onStatus);
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
        <SettingRow icon="user" title="Show what you are listening to" desc="On your Discord status, for others to see. Needs the Discord desktop app running on this computer.">
          <Toggle checked={o.enabled} onChange={(v) => set({ enabled: v })} />
        </SettingRow>
        <SettingRow icon="queue" title="Show while paused" desc="Off: your status clears when the music is paused." muted={!o.enabled}>
          <Toggle checked={o.showPaused} onChange={(v) => set({ showPaused: v })} disabled={!o.enabled} />
        </SettingRow>
        <SettingRow icon="image" title="Show the album cover" desc="Looks for the album on the online cover sources and shows their picture. Your files are never uploaded. Albums it can't find show the TeleCloud logo. Off: always the logo, and no search." muted={!o.enabled}>
          <Toggle checked={o.onlineCover} onChange={(v) => set({ onlineCover: v })} disabled={!o.enabled} />
        </SettingRow>
        <SettingRow icon="download" title="Show a Get TeleCloud button" desc="A button on your status that opens the TeleCloud website. Others can click it." muted={!o.enabled}>
          <Toggle checked={o.showButton} onChange={(v) => set({ showButton: v })} disabled={!o.enabled} />
        </SettingRow>
        <SettingRow icon="lyrics" title="Status text" desc="You can use {track}, {artist} and {album}." muted={!o.enabled}>
          <input className="input discord-text" value={text} disabled={!o.enabled} placeholder={DEFAULT_TEXT} maxLength={120} aria-label="Status text" onChange={(e) => setText(e.target.value)} />
        </SettingRow>
      </div>
    </section>
  );
};

export default DiscordSettings;
