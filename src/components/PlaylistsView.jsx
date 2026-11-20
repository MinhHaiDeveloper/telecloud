import React, { useState, useMemo, useEffect } from 'react';
import useRemembered from '../hooks/useRemembered';
import SongList from './SongList';
import Cover from './Cover';
import Icon from './Icon';
import { Select, MoreMenu, confirmDialog } from './ui';
import { formatDuration } from '../utils/audio';
import SmartPlaylistDialog from './SmartPlaylistDialog';
import { describe } from '../utils/smartPlaylist';
import { t } from '../i18n';

const SORTS = [
  { value: 'latest', get label() { return t('Recently created'); } },
  { value: 'name', get label() { return t('Name A → Z'); } },
  { value: 'name-desc', get label() { return t('Name Z → A'); } },
  { value: 'size', get label() { return t('Most tracks'); } },
];

// 2x2 grid of the first covers, or a single cover / placeholder
const PlaylistCover = ({ songs = [] }) => {
  if (songs.length >= 4) {
    return (
      <div className="cover"><div className="mosaic">{songs.slice(0, 4).map((s, i) => <Cover key={i} file={s} />)}</div></div>
    );
  }
  return <Cover file={songs[0]} />;
};

const PlaylistsView = ({ playlists, setPlaylists, onSavePlaylists, currentFile, isPlaying, onPlay, onToggleFavorite, favorites, onDeleteSong, onDownloadSong, selectedPlaylistId, onSelectPlaylist, createSignal = 0, onBackupMany, onBackupTo, storageNames, onRemoveFromCloud, smartCtx, allFiles = [], onImport, onExport }) => {
  // Selection lives in App so the sidebar can open a playlist directly
  const setSelectedPlaylistId = onSelectPlaylist;
  const [isCreating, setIsCreating] = useState(createSignal > 0);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [sortBy, setSortBy] = useRemembered('playlists:sort', 'latest', SORTS.map(s => s.value));
  useEffect(() => { if (createSignal > 0) setIsCreating(true); }, [createSignal]);
  const [smartEdit, setSmartEdit] = useState(null); // { playlist } while the rules are being made or changed

  const save = (next) => { setPlaylists(next); onSavePlaylists(next); };

  const create = (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const p = { id: Date.now().toString(), name, songs: [] };
    save([...playlists, p]);
    setNewName('');
    setIsCreating(false);
    setSelectedPlaylistId(p.id);
  };

  const remove = async (p) => {
    const ok = await confirmDialog({
      title: t('Delete playlist?'),
      message: t('"{name}" will be removed. The tracks stay in your library.', { name: p.name }),
      confirmLabel: t('Delete playlist'),
      danger: true,
    });
    if (!ok) return;
    save(playlists.filter(x => x.id !== p.id));
    if (selectedPlaylistId === p.id) setSelectedPlaylistId(null);
  };

  const rename = (e) => {
    e.preventDefault();
    const name = renaming?.name.trim();
    if (name) save(playlists.map(p => (p.id === renaming.id ? { ...p, name } : p)));
    setRenaming(null);
  };

  // a smart playlist made or changed in its dialog
  const saveSmart = ({ name, smart }) => {
    const editing = smartEdit?.playlist;
    if (editing) save(playlists.map(p => (p.id === editing.id ? { ...p, name, smart } : p)));
    else {
      const p = { id: Date.now().toString(), name, smart, songs: [] };
      save([...playlists, p]);
      setSelectedPlaylistId(p.id);
    }
    setSmartEdit(null);
  };
  const reshuffle = (p) => save(playlists.map(x => (x.id === p.id ? { ...x, smart: { ...x.smart, seed: Date.now() } } : x)));

  const removeTrack = (playlist, file) => {
    save(playlists.map(p => (p.id === playlist.id ? { ...p, songs: p.songs.filter(s => s.path !== file.path) } : p)));
  };

  const sorted = useMemo(() => {
    const list = [...playlists];
    switch (sortBy) {
      case 'name': return list.sort((a, b) => a.name.localeCompare(b.name));
      case 'name-desc': return list.sort((a, b) => b.name.localeCompare(a.name));
      case 'size': return list.sort((a, b) => (b.songs?.length || 0) - (a.songs?.length || 0));
      default: return list.reverse();
    }
  }, [playlists, sortBy]);

  const selected = playlists.find(p => p.id === selectedPlaylistId);
  const total = selected ? selected.songs.reduce((s, f) => s + (f.metadata?.duration || 0), 0) : 0;

  return (
    <>
      <div className="page-head">
        <h2>{t('Playlists')}</h2>
        <span className="sub">{t('{length} playlists', { length: playlists.length })}</span>
        <div className="end">
          <Select variant="ghost" icon="sort" align="right" value={sortBy} options={SORTS} onChange={setSortBy} />
          {onImport && <button className="btn-ghost" onClick={onImport} title={t('Make a playlist from an .m3u or .m3u8 file')}><Icon name="fileIn" />{t('Import')}</button>}
          <button className="btn-ghost" onClick={() => setSmartEdit({ playlist: null })} title={t('A playlist made of rules, that keeps itself up to date')}><Icon name="sparkle" />{t('New smart playlist')}</button>
          <button className="btn-primary" onClick={() => setIsCreating(true)}><Icon name="plus" />{t('New playlist')}</button>
        </div>
      </div>

      <div className="split">
        <div className="card list-panel">
          {isCreating && (
            <form className="inline-form" onSubmit={create}>
              <input className="input sm" autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('Playlist name')}
                onKeyDown={e => { if (e.key === 'Escape') { setIsCreating(false); setNewName(''); } }} />
              <button type="submit" className="icon-btn sm on" title={t('Create')}><Icon name="check" /></button>
              <button type="button" className="icon-btn sm" title={t('Cancel')} onClick={() => { setIsCreating(false); setNewName(''); }}><Icon name="close" /></button>
            </form>
          )}
          {sorted.length === 0 && !isCreating && <div className="empty">{t('No playlists yet.')}</div>}
          {sorted.map(p => (
            <button key={p.id} className={`list-item ${selectedPlaylistId === p.id ? 'on' : ''}`} onClick={() => setSelectedPlaylistId(p.id)}>
              <PlaylistCover songs={p.songs} />
              <div className="meta"><b>{p.smart && <Icon name="sparkle" className="sp-mark" />}{p.name}</b><span>{t('{length} tracks{value}', { length: p.songs.length, value: p.smart ? t(' · smart') : '' })}</span></div>
            </button>
          ))}
        </div>

        <div style={{ minWidth: 0 }}>
          {selected ? (
            <>
              <div className="detail-head">
                <PlaylistCover songs={selected.songs} />
                <div className="info">
                  <span className="eyebrow">{selected.smart ? t('Smart playlist') : t('Playlist')}</span>
                  {renaming?.id === selected.id ? (
                    <form onSubmit={rename} style={{ display: 'flex', gap: 6 }}>
                      <input className="input" autoFocus value={renaming.name} onChange={e => setRenaming({ ...renaming, name: e.target.value })}
                        onBlur={rename} onKeyDown={e => e.key === 'Escape' && setRenaming(null)} style={{ fontSize: 20, fontWeight: 800 }} />
                    </form>
                  ) : <h2>{selected.name}</h2>}
                  <div className="meta">{t('{length} tracks · {duration}', { length: selected.songs.length, duration: formatDuration(total) })}</div>
                  {selected.smart && <div className="sp-rules-text muted" title={describe(selected.smart)}>{describe(selected.smart)}</div>}
                  <div className="btn-row">
                    <button className="btn-primary" disabled={!selected.songs.length} onClick={() => onPlay(selected.songs[0], 0, selected.songs)}><Icon name="play" filled />{t('Play')}</button>
                    <button className="btn-ghost" disabled={!selected.songs.length} onClick={() => { const s = [...selected.songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />{t('Shuffle')}</button>
                    {selected.smart && <button className="btn-ghost" onClick={() => setSmartEdit({ playlist: selected })}><Icon name="sparkle" />{t('Edit rules')}</button>}
                    <MoreMenu items={[
                      ...(selected.smart?.sort === 'random' ? [{ label: t('Shuffle again'), icon: 'shuffle', onClick: () => reshuffle(selected) }] : []),
                      { label: t('Rename'), icon: 'lyrics', onClick: () => setRenaming({ id: selected.id, name: selected.name }) },
                      ...(onExport && selected.songs.length ? [{ label: t('Export as .m3u8…'), icon: 'fileOut', onClick: () => onExport(selected) }] : []),
                      ...(onBackupMany && selected.songs.length ? [{ label: t('Back up playlist to…'), icon: 'cloud', onClick: () => onBackupMany(selected.songs, `“${selected.name}”`) }] : []),
                      ...(onRemoveFromCloud && selected.songs.some(f => f.telegram_message_id) ? [{ label: t('Remove playlist tracks from TeleCloud'), icon: 'cloud', danger: true, onClick: () => onRemoveFromCloud(selected.songs.filter(f => f.telegram_message_id)) }] : []),
                      { sep: true },
                      { label: t('Delete playlist'), icon: 'trash', danger: true, onClick: () => remove(selected) },
                    ]} />
                  </div>
                </div>
              </div>
              {selected.songs.length === 0 ? (
                <div className="empty">{selected.smart ? t('No tracks match these rules yet. Edit the rules, or it fills itself as your library and plays grow.') : t('This playlist is empty. Use “Add to playlist” from any track\'s menu.')}</div>
              ) : (
                <SongList
                  musicFiles={selected.songs}
                  currentFile={currentFile}
                  isPlaying={isPlaying}
                  onPlay={(file, idx, list) => onPlay(file, idx, list)}
                  onToggleFavorite={onToggleFavorite}
                  favorites={favorites}
                  onBackupTo={onBackupTo}
                  onBackupMany={onBackupMany}
                  onRemoveFromCloud={onRemoveFromCloud}
                  storageNames={storageNames}
                  onDownloadSong={onDownloadSong}
                  onDeleteSong={selected.smart ? undefined : (file) => removeTrack(selected, file)}
                  onDeleteMany={selected.smart ? undefined : (files) => { const gone = new Set(files.map(f => f.path)); save(playlists.map(p => (p.id === selected.id ? { ...p, songs: p.songs.filter(s => !gone.has(s.path)) } : p))); }}
                  deleteLabel={t('Remove from playlist')}
                />
              )}
            </>
          ) : (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
              <Icon name="playlist" style={{ width: 36, height: 36, marginBottom: 10 }} />
              <div>{t('Select a playlist to see its tracks')}</div>
            </div>
          )}
        </div>
      </div>
      {smartEdit && <SmartPlaylistDialog playlist={smartEdit.playlist} files={allFiles} ctx={smartCtx} onSave={saveSmart} onClose={() => setSmartEdit(null)} />}
    </>
  );
};

export default PlaylistsView;
