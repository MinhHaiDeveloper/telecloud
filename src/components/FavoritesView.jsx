import React from 'react';
import SongList from './SongList';
import Icon from './Icon';

const FavoritesView = ({ favorites, currentFile, isPlaying, onPlay, onToggleFavorite, onAddPlaylist, onDeleteSong, onDownloadSong, onCheckSpectrum, onBackupMany, onBackupTo, storageNames, onRemoveFromCloud }) => (
  favorites.length === 0 ? (
    <>
      <div className="page-head"><h2>Favourites</h2></div>
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
        <Icon name="heart" style={{ width: 36, height: 36, marginBottom: 10 }} />
        <div>Tap the heart on any track to keep it here.</div>
      </div>
    </>
  ) : (
    <SongList
      title="Favourites"
      showSort
      musicFiles={favorites}
      currentFile={currentFile}
      isPlaying={isPlaying}
      onPlay={onPlay}
      onToggleFavorite={onToggleFavorite}
      onAddPlaylist={onAddPlaylist}
      onDeleteSong={onDeleteSong}
      onDownloadSong={onDownloadSong}
      onCheckSpectrum={onCheckSpectrum}
      favorites={favorites}
      onBackupTo={onBackupTo}
      onBackupMany={onBackupMany}
      onRemoveFromCloud={onRemoveFromCloud}
      storageNames={storageNames}
      headerActions={onBackupMany && <button className="btn-ghost sm" onClick={() => onBackupMany(favorites, 'your favourites')}><Icon name="cloud" />Back up to…</button>}
    />
  )
);

export default FavoritesView;
