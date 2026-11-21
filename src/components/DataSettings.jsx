import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle, Callout } from './ui';
import { t } from '../i18n';
import { ipcOn, ipcOff } from '../utils/ipc';

// what of the page's own settings (kept in localStorage) travels with an export
const LOCAL_KEYS = ['tc-appearance', 'tc-theme', 'tc-theme-light', 'tc-theme-dark', 'tc-language'];
const readLocal = () => Object.fromEntries(LOCAL_KEYS.map(k => { try { return [k, localStorage.getItem(k)]; } catch { return [k, null]; } }).filter(([, v]) => v != null));

/** Settings > Library: everything that is yours beyond the music, out to a .zip and back in (electron/dataPort.js) */
const DataSettings = () => {
  const ipc = window.ipcRenderer;
  const [withSettings, setWithSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [picked, setPicked] = useState(null);   // an export chosen, before it is imported
  const [take, setTake] = useState({ history: true, lists: true, settings: false });
  const [report, setReport] = useState(null);
  const [waiting, setWaiting] = useState(0);
  const refresh = () => ipc.invoke('data:waiting').then(n => setWaiting(n || 0)).catch(() => {});
  useEffect(() => {
    refresh();
    ipcOn(ipc, 'data:changed', refresh);
    return () => ipcOff(ipc, 'data:changed', refresh);
  }, []);

  const exportNow = async () => {
    setBusy(true); setSaved(null); setReport(null);
    const r = await ipc.invoke('data:export', { includeSettings: withSettings, local: withSettings ? readLocal() : {} });
    setBusy(false);
    if (!r?.canceled) setSaved(r);
  };
  const pick = async () => {
    setSaved(null); setReport(null);
    const r = await ipc.invoke('data:open');
    if (r?.canceled) return;
    if (!r?.success) { setReport(r); return; }
    setPicked(r);
    setTake({ history: true, lists: true, settings: false });
  };
  const importNow = async () => {
    setBusy(true);
    const r = await ipc.invoke('data:import', take);
    setBusy(false);
    setPicked(null);
    if (r?.success && r.settings) {
      for (const [k, v] of Object.entries(r.settings.local || {})) { try { localStorage.setItem(k, v); } catch { /* kept as it was */ } }
    }
    setReport(r);
    refresh();
  };

  const n = (v) => Number(v || 0).toLocaleString();
  const lines = (r) => [
    r.history && t('{n|# play|# plays} added', { n: n(r.history.added) }) + (r.history.skipped ? t(', {n|# already here|# already here}', { n: n(r.history.skipped) }) : ''),
    r.playlists != null && t('{n|# playlist|# playlists} with {tracks} tracks', { n: n(r.playlists), tracks: n(r.tracks) }),
    r.favourites != null && t('{n|# favourite|# favourites} added', { n: n(r.favourites) }),
    (r.tracksWaiting || r.favouritesWaiting) && t('{n|# track is|# tracks are} not on this computer yet: they join their playlists and favourites when they show up (after adding a folder or restoring from TeleCloud)', { n: n((r.tracksWaiting || 0) + (r.favouritesWaiting || 0)) }),
    r.settings && t('Settings applied. Restart TeleCloud to use all of them.'),
  ].filter(Boolean);

  return (
    <section className="set-section">
      <h3>{t('Your data')}</h3>
      <div className="card set-card">
        <SettingRow icon="download" title={t('Export your data')} desc={t('Listening history, playlists, favourites and a list of the library in one .zip of plain files (JSON, M3U8, CSV), to keep or to take to another computer or app. The history also comes in the ListenBrainz format. Music files, keys and sign-ins are not included.')}>
          <button className="btn-primary" onClick={exportNow} disabled={busy}>{busy && !picked ? t('Saving…') : t('Export…')}</button>
        </SettingRow>
        <SettingRow icon="eq" title={t('Include settings')} desc={t('Sound, EQ, look, shortcuts and the order of lyrics and cover sources. Not what belongs to this computer: folders, devices.')}>
          <Toggle checked={withSettings} onChange={setWithSettings} />
        </SettingRow>
        <SettingRow icon="upload" title={t('Import data')} desc={t('Adds an export to what is here; nothing is replaced, and a play already here is not counted twice. A track this computer does not have yet still counts in Stats, and joins its playlist when it shows up.')}>
          <button className="btn-ghost" onClick={pick} disabled={busy}>{t('Import…')}</button>
        </SettingRow>
        {picked && (
          <>
            <SettingRow icon="chart" title={t('Listening history')} desc={t('{n|# play|# plays}', { n: n(picked.counts.plays) })}>
              <Toggle checked={take.history} onChange={(v) => setTake(x => ({ ...x, history: v }))} />
            </SettingRow>
            <SettingRow icon="playlist" title={t('Playlists and favourites')} desc={t('{playlists} playlists, {favourites} favourites. A playlist with a name already here comes in as "Name (imported)".', { playlists: n(picked.counts.playlists), favourites: n(picked.counts.favourites) })}>
              <Toggle checked={take.lists} onChange={(v) => setTake(x => ({ ...x, lists: v }))} />
            </SettingRow>
            {picked.counts.settings && (
              <SettingRow icon="eq" title={t('Settings from the export')} desc={t('Replace the settings here with the ones in the export.')}>
                <Toggle checked={take.settings} onChange={(v) => setTake(x => ({ ...x, settings: v }))} />
              </SettingRow>
            )}
            <div className="set-sub btn-row">
              <button className="btn-primary" onClick={importNow} disabled={busy || !(take.history || take.lists || take.settings)}>{busy ? t('Importing…') : t('Import')}</button>
              <button className="btn-ghost" onClick={() => setPicked(null)} disabled={busy}>{t('Cancel')}</button>
            </div>
          </>
        )}
        {waiting > 0 && !picked && (
          <SettingRow icon="clock" title={t('{n|# imported track is|# imported tracks are} waiting', { n: n(waiting) })} desc={t('They join their playlists and favourites when they show up on this computer.')} muted />
        )}
      </div>
      {saved?.success && <Callout tone="ok">{t('Saved: {plays} plays, {playlists} playlists, {favourites} favourites.', { plays: n(saved.counts.plays), playlists: n(saved.counts.playlists), favourites: n(saved.counts.favourites) })}</Callout>}
      {saved && !saved.success && <Callout tone="danger">{t('Could not export: {error}', { error: saved.error })}</Callout>}
      {report?.success && (
        <Callout tone="ok">
          {lines(report).map((l, i) => <div key={i}>{l}</div>)}
          {report.settings && <button className="link-btn" onClick={() => ipc.invoke('app:relaunch')}>{t('Restart now')}</button>}
        </Callout>
      )}
      {report && !report.success && <Callout tone="danger">{t('Could not import: {error}', { error: report.error })}</Callout>}
    </section>
  );
};

export default DataSettings;
