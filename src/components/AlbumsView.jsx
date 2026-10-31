import React, { useMemo, useState } from 'react';
import SongList from './SongList';
import Cover from './Cover';
import Icon from './Icon';
import { Select, MoreMenu, BackButton, useDetailScroll } from './ui';
import { qualityOf, formatDuration } from '../utils/audio';

const SORTS = [
  { value: 'name', label: 'Title A → Z' },
  { value: 'name-desc', label: 'Title Z → A' },
  { value: 'artist', label: 'Artist' },
  { value: 'tracks', label: 'Most tracks' },
];

const noThe = (s) => s.toLowerCase().replace(/^the /, '');

const bestQuality = (songs) => songs.map(qualityOf).sort((a, b) => (b.bits * 1e6 + b.rate) - (a.bits * 1e6 + a.rate))[0];

const AlbumsView = ({ musicFiles, currentFile, isPlaying, onPlay, onToggleFavorite, onAddPlaylist, favorites, onCheckSpectrum, selectedAlbum, setSelectedAlbum, onDeleteSong, onDeleteAlbum, onDownloadSong, onBackupMany, onBackupTo, storageNames, onRemoveFromCloud }) => {
  const [sortBy, setSortBy] = useState('name');
  useDetailScroll(selectedAlbum?.name ?? null);

  const albums = useMemo(() => {
    const map = new Map();
    musicFiles.forEach(file => {
      const name = file.metadata?.album || 'Unknown Album';
      if (!map.has(name)) map.set(name, { name, artist: file.metadata?.artist || 'Unknown Artist', file, songs: [], cover: file.path ? `media://${encodeURIComponent(file.path)}` : file.cover });
      map.get(name).songs.push(file);
    });
    const list = [...map.values()];
    switch (sortBy) {
      case 'name-desc': return list.sort((a, b) => noThe(b.name).localeCompare(noThe(a.name)));
      case 'artist': return list.sort((a, b) => noThe(a.artist).localeCompare(noThe(b.artist)));
      case 'tracks': return list.sort((a, b) => b.songs.length - a.songs.length);
      default: return list.sort((a, b) => noThe(a.name).localeCompare(noThe(b.name)));
    }
  }, [musicFiles, sortBy]);

  if (selectedAlbum) {
    // the album as it is in the library now (tracks change while it is open: cached, tagged, removed)
    const current = albums.find(a => a.name === selectedAlbum.name) || selectedAlbum;
    const songs = [...current.songs].sort((a, b) => {
      const da = a.metadata?.disc || 0, db = b.metadata?.disc || 0;
      if (da !== db) return da - db;
      const ta = a.metadata?.track || 0, tb = b.metadata?.track || 0;
      return ta !== tb ? ta - tb : (a.name || '').localeCompare(b.name || '');
    });
    const q = bestQuality(songs);
    const total = songs.reduce((s, f) => s + (f.metadata?.duration || 0), 0);
    const year = songs.find(f => f.metadata?.year)?.metadata?.year;
    const artist = selectedAlbum.artist || songs[0]?.metadata?.artist || 'Unknown Artist';

    return (
      <>
        <div className="page-head" style={{ marginBottom: 6 }}>
          <BackButton onClick={() => setSelectedAlbum(null)} label="All albums" />
          <span className="sub">Albums</span>
        </div>
        <div className="detail-head">
          <Cover file={selectedAlbum.file || songs[0]} />
          <div className="info">
            <span className="eyebrow">Album</span>
            <h2 title={selectedAlbum.name}>{selectedAlbum.name}</h2>
            <div className="meta">
              <b style={{ color: 'var(--text)' }}>{artist}</b>
              {year && <span>· {year}</span>}
              <span>· {songs.length} tracks · {formatDuration(total)}</span>
              {q && <span className={`badge b-${q.tier} mono`}>{q.label}</span>}
            </div>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => onPlay(songs[0], 0, songs)}><Icon name="play" filled />Play</button>
              <button className="btn-ghost" onClick={() => { const s = [...songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />Shuffle</button>
              <MoreMenu items={[
                ...(onDownloadSong ? [{ label: 'Download album', icon: 'download', onClick: () => songs.forEach(s => onDownloadSong(s)) }] : []),
                ...(onAddPlaylist ? [{ label: 'Add to playlist', icon: 'playlist', onClick: () => onAddPlaylist(songs[0], songs) }] : []),
                ...(onBackupMany ? [{ label: 'Back up album to…', icon: 'cloud', onClick: () => onBackupMany(songs, `“${selectedAlbum.name}”`) }] : []),
                ...(onRemoveFromCloud && songs.some(f => f.telegram_message_id) ? [{ label: 'Remove album from TeleCloud', icon: 'cloud', danger: true, onClick: () => onRemoveFromCloud(songs.filter(f => f.telegram_message_id)) }] : []),
                ...(onDeleteAlbum ? [{ sep: true }, { label: 'Delete album', icon: 'trash', danger: true, onClick: () => onDeleteAlbum({ ...selectedAlbum, songs }) }] : []),
              ]} />
            </div>
          </div>
        </div>
        <SongList
          onBackupTo={onBackupTo}
          onBackupMany={onBackupMany}
          onRemoveFromCloud={onRemoveFromCloud}
          storageNames={storageNames}
          musicFiles={songs}
          currentFile={currentFile}
          isPlaying={isPlaying}
          onPlay={(file, idx) => onPlay(file, idx, songs)}
          onToggleFavorite={onToggleFavorite}
          onAddPlaylist={onAddPlaylist}
          favorites={favorites}
          onCheckSpectrum={onCheckSpectrum}
          onDeleteSong={onDeleteSong}
          onDownloadSong={onDownloadSong}
        />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h2>Albums</h2>
        <span className="sub">{albums.length.toLocaleString()} albums</span>
        <div className="end"><Select variant="ghost" icon="sort" align="right" value={sortBy} options={SORTS} onChange={setSortBy} /></div>
      </div>
      {albums.length === 0 ? (
        <div className="empty">No albums in your library yet.</div>
      ) : (
        <div className="tile-grid">
          {albums.map(album => (
            <div key={album.name} className="tile pressable" role="button" tabIndex={0} onClick={() => setSelectedAlbum(album)} onKeyDown={(e) => e.key === 'Enter' && setSelectedAlbum(album)}>
              <div className="cover-wrap">
                <Cover file={album.file} />
                <button className="play-fab" title="Play album" onClick={(e) => { e.stopPropagation(); onPlay(album.songs[0], 0, album.songs); }}><Icon name="play" /></button>
              </div>
              <b>{album.name}</b>
              <span>{album.artist} · {album.songs.length} tracks</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default AlbumsView;
