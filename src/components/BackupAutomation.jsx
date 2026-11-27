import React, { useContext, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import SongActions from './songActions';
import { SettingRow, Toggle, Select, Segmented } from './ui';
import { albumIndex } from '../utils/albums';
import { formatBytes } from '../utils/audio';
import { t } from '../i18n';

// Settings > TeleCloud Sync: backing up new tracks by themselves, the upload window, and what is kept offline.
// The rules live in electron/telecloud/service.js (onTracksAdded, held/nextItem, offlineSets).

const useStorages = () => {
  const [list, setList] = useState([]);
  useEffect(() => { window.ipcRenderer.invoke('telecloud-sync:storages').then(r => { if (r?.success) setList(r.storages); }).catch(() => {}); }, []);
  return list;
};

/** Back up new tracks, and where they go when their album is nowhere yet */
export function AutoBackupRows({ opts, setOption }) {
  const storages = useStorages();
  const fallback = storages.find(s => s.id === opts.autoBackupStorage) || storages.find(s => s.isDefault) || storages[0];
  return (
    <>
      <SettingRow icon="cloud" title={t('Back up new tracks')} desc={t('Tracks that appear in your music folders are backed up by themselves, into the storage their album (or else their folder) is already in. Tracks already backed up are always backed up again when their file changes.')}>
        <Toggle checked={!!opts.autoBackup} onChange={(v) => setOption({ autoBackup: v })} />
      </SettingRow>
      {opts.autoBackup && storages.length > 1 && (
        <SettingRow icon="folder" title={t('New albums go to')} desc={t('For tracks whose album and folder are not in any storage yet.')}>
          <Select value={fallback?.id ?? ''} options={storages.map(s => ({ value: s.id, label: s.title }))} onChange={(v) => setOption({ autoBackupStorage: Number(v) })} align="right" />
        </SettingRow>
      )}
    </>
  );
}

const albumLabel = (a) => (a.artist ? `${a.album} · ${a.artist}` : a.album);

/** The upload window: when backups may run, for everything or for chosen folders and albums */
export function ScheduleSection({ opts, setOption }) {
  const ctx = useContext(SongActions);
  const sch = { on: false, from: '01:00', to: '07:00', scope: 'all', folders: [], albums: [], ...(opts.schedule || {}) };
  const save = (patch) => setOption({ schedule: { ...sch, ...patch } });
  const [pick, setPick] = useState('');
  const albums = useMemo(() => {
    if (sch.scope !== 'chosen') return [];
    const seen = new Set();
    const out = [];
    for (const a of albumIndex(ctx.allFiles || []).list) {
      const f = a.songs?.[0];
      const album = f?.metadata?.album;
      if (!album || album === 'Unknown Album') continue;
      const artist = f.metadata.albumArtist || f.metadata.artist || '';
      const id = `${album}\u0000${artist}`.toLowerCase();
      if (seen.has(id) || sch.albums.some(x => `${x.album}\u0000${x.artist}`.toLowerCase() === id)) continue;
      seen.add(id);
      out.push({ album, artist });
    }
    return out.sort((x, y) => x.album.localeCompare(y.album));
  }, [ctx.allFiles, sch.scope, sch.albums]);
  const addFolder = async () => {
    const folder = await window.ipcRenderer.invoke('select-music-folder');
    if (folder && !sch.folders.includes(folder)) save({ folders: [...sch.folders, folder] });
  };
  const time = (key) => (
    <input className="input mono qs-time" type="time" step="60" value={sch[key]} aria-label={key === 'from' ? t('From') : t('To')}
      onChange={(e) => { if (/^\d\d:\d\d$/.test(e.target.value)) save({ [key]: e.target.value }); }} />
  );
  return (
    <section className="set-section">
      <h3>{t('Upload schedule')}</h3>
      <div className="card set-card">
        <SettingRow icon="clock" title={t('Upload only at set times')} desc={t('Backups wait outside these hours, for example to keep the network free during the day. A backup that is running finishes its track first.')}>
          <Toggle checked={!!sch.on} onChange={(v) => save({ on: v })} />
        </SettingRow>
        {sch.on && (
          <>
            <SettingRow icon="clock" title={t('Upload window')} desc={sch.from === sch.to ? t('The same time twice means all day.') : minutesOf(sch.from) > minutesOf(sch.to) ? t('Runs past midnight, into the next morning.') : t('Every day.')}>
              <div className="row-gap">{time('from')}<span className="muted">{t('to')}</span>{time('to')}</div>
            </SettingRow>
            <SettingRow icon="folder" title={t('Applies to')} desc={sch.scope === 'chosen' ? t('Only these wait for the window; other tracks upload at once.') : t('Every backup waits for the window.')}>
              <Segmented size="sm" value={sch.scope} onChange={(v) => save({ scope: v })} options={[{ value: 'all', label: t('Everything') }, { value: 'chosen', label: t('Chosen folders and albums') }]} />
            </SettingRow>
            {sch.scope === 'chosen' && (
              <div className="set-sub qs-scope">
                {sch.folders.map(f => (
                  <div className="qs-item" key={`f:${f}`}>
                    <Icon name="folder" /><span className="qs-name" title={f}>{f}</span>
                    <button className="icon-btn sm" onClick={() => save({ folders: sch.folders.filter(x => x !== f) })} title={t('Remove')}><Icon name="close" /></button>
                  </div>
                ))}
                {sch.albums.map(a => (
                  <div className="qs-item" key={`a:${a.album}|${a.artist}`}>
                    <Icon name="disc" /><span className="qs-name" title={albumLabel(a)}>{albumLabel(a)}</span>
                    <button className="icon-btn sm" onClick={() => save({ albums: sch.albums.filter(x => x !== a) })} title={t('Remove')}><Icon name="close" /></button>
                  </div>
                ))}
                {!sch.folders.length && !sch.albums.length && <div className="muted qs-empty">{t('Nothing chosen yet: add a folder or an album.')}</div>}
                <div className="row-gap qs-add">
                  <button className="btn-ghost sm" onClick={addFolder}><Icon name="plus" />{t('Add folder…')}</button>
                  {albums.length > 0 && (
                    <Select value={pick} variant="ghost" icon="disc" width={320}
                      options={[{ value: '', label: t('Add album…') }, ...albums.map((a, i) => ({ value: String(i), label: albumLabel(a) }))]}
                      onChange={(v) => { if (v !== '') { save({ albums: [...sch.albums, albums[Number(v)]] }); setPick(''); } }} />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const minutesOf = (hm) => { const [h, m] = String(hm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** Albums and playlists kept offline, in the Cache section */
export function OfflineRows() {
  const ctx = useContext(SongActions);
  const sets = ctx.offlineSets || [];
  if (!sets.length) {
    return <SettingRow icon="disc" title={t('Keep offline')} desc={t('Choose Keep offline in an album\'s or a playlist\'s menu: its cloud tracks download now and stay in the cache, also when the cache is full.')} muted />;
  }
  return (
    <>
      {sets.map(s => (
        <SettingRow key={s.key} icon={s.kind === 'playlist' ? 'playlist' : 'disc'} title={s.label}
          desc={`${s.kind === 'playlist' ? t('Playlist') : t('Album')} · ${t('Kept offline')} · ${s.cloudTracks ? t('{ready} of {total} cloud tracks here', { ready: s.ready, total: s.cloudTracks }) : t('every track is on this computer')}${s.bytes ? ` · ${formatBytes(s.bytes)}` : ''}`}>
          <button className="btn-ghost" onClick={() => ctx.setOffline(s.key, s.label, s.kind, [], false)}>{t('Stop')}</button>
        </SettingRow>
      ))}
    </>
  );
}
