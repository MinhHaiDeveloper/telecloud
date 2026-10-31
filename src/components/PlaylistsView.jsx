import React, { useState, useMemo, useEffect } from 'react';
import SongList from './SongList';
import Cover from './Cover';
import Icon from './Icon';
import { Select, MoreMenu, confirmDialog } from './ui';
import { formatDuration } from '../utils/audio';

const SORTS = [
  { value: 'latest', label: 'Recently created' },
  { value: 'name', label: 'Name A → Z' },
  { value: 'name-desc', label: 'Name Z → A' },
  { value: 'size', label: 'Most tracks' },
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

const PlaylistsView = ({ playlists, setPlaylists, onSavePlaylists, currentFile, isPlaying, onPlay, onToggleFavorite, favorites, onDeleteSong, onDownloadSong, selectedPlaylistId, onSelectPlaylist, createSignal = 0, onBackupMany, onBackupTo, storageNames, onRemoveFromCloud }) => {
  // Selection lives in App so the sidebar can open a playlist directly
  const setSelectedPlaylistId = onSelectPlaylist;
  const [isCreating, setIsCreating] = useState(createSignal > 0);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [sortBy, setSortBy] = useState('latest');
  useEffect(() => { if (createSignal > 0) setIsCreating(true); }, [createSignal]);

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
      title: 'Delete playlist?',
      message: `"${p.name}" will be removed. The tracks stay in your library.`,
      confirmLabel: 'Delete playlist',
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
        <h2>Playlists</h2>
        <span className="sub">{playlists.length} playlists</span>
        <div className="end">
          <Select variant="ghost" icon="sort" align="right" value={sortBy} options={SORTS} onChange={setSortBy} />
          <button className="btn-primary" onClick={() => setIsCreating(true)}><Icon name="plus" />New playlist</button>
        </div>
      </div>

      <div className="split">
        <div className="card list-panel">
          {isCreating && (
            <form className="inline-form" onSubmit={create}>
              <input className="input sm" autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="Playlist name"
                onKeyDown={e => { if (e.key === 'Escape') { setIsCreating(false); setNewName(''); } }} />
              <button type="submit" className="icon-btn sm on" title="Create"><Icon name="check" /></button>
              <button type="button" className="icon-btn sm" title="Cancel" onClick={() => { setIsCreating(false); setNewName(''); }}><Icon name="close" /></button>
            </form>
          )}
          {sorted.length === 0 && !isCreating && <div className="empty">No playlists yet.</div>}
          {sorted.map(p => (
            <button key={p.id} className={`list-item ${selectedPlaylistId === p.id ? 'on' : ''}`} onClick={() => setSelectedPlaylistId(p.id)}>
              <PlaylistCover songs={p.songs} />
              <div className="meta"><b>{p.name}</b><span>{p.songs.length} tracks</span></div>
            </button>
          ))}
        </div>

        <div style={{ minWidth: 0 }}>
          {selected ? (
            <>
              <div className="detail-head">
                <PlaylistCover songs={selected.songs} />
                <div className="info">
                  <span className="eyebrow">Playlist</span>
                  {renaming?.id === selected.id ? (
                    <form onSubmit={rename} style={{ display: 'flex', gap: 6 }}>
                      <input className="input" autoFocus value={renaming.name} onChange={e => setRenaming({ ...renaming, name: e.target.value })}
                        onBlur={rename} onKeyDown={e => e.key === 'Escape' && setRenaming(null)} style={{ fontSize: 20, fontWeight: 800 }} />
                    </form>
                  ) : <h2>{selected.name}</h2>}
                  <div className="meta">{selected.songs.length} tracks · {formatDuration(total)}</div>
                  <div className="btn-row">
                    <button className="btn-primary" disabled={!selected.songs.length} onClick={() => onPlay(selected.songs[0], 0, selected.songs)}><Icon name="play" filled />Play</button>
                    <button className="btn-ghost" disabled={!selected.songs.length} onClick={() => { const s = [...selected.songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />Shuffle</button>
                    <MoreMenu items={[
                      { label: 'Rename', icon: 'lyrics', onClick: () => setRenaming({ id: selected.id, name: selected.name }) },
                      ...(onBackupMany && selected.songs.length ? [{ label: 'Back up playlist to…', icon: 'cloud', onClick: () => onBackupMany(selected.songs, `“${selected.name}”`) }] : []),
                      ...(onRemoveFromCloud && selected.songs.some(f => f.telegram_message_id) ? [{ label: 'Remove playlist tracks from TeleCloud', icon: 'cloud', danger: true, onClick: () => onRemoveFromCloud(selected.songs.filter(f => f.telegram_message_id)) }] : []),
                      { sep: true },
                      { label: 'Delete playlist', icon: 'trash', danger: true, onClick: () => remove(selected) },
                    ]} />
                  </div>
                </div>
              </div>
              {selected.songs.length === 0 ? (
                <div className="empty">This playlist is empty. Use “Add to playlist” from any track's menu.</div>
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
                  onDeleteSong={(file) => removeTrack(selected, file)}
                  onDeleteMany={(files) => { const gone = new Set(files.map(f => f.path)); save(playlists.map(p => (p.id === selected.id ? { ...p, songs: p.songs.filter(s => !gone.has(s.path)) } : p))); }}
                  deleteLabel="Remove from playlist"
                />
              )}
            </>
          ) : (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
              <Icon name="playlist" style={{ width: 36, height: 36, marginBottom: 10 }} />
              <div>Select a playlist to see its tracks</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default PlaylistsView;
