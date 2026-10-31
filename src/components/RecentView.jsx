import React from 'react';
import SongList from './SongList';
import Icon from './Icon';

const RecentView = ({ recentPlayed, currentFile, isPlaying, onPlay, onToggleFavorite, onAddPlaylist, favorites, onDeleteSong, onDownloadSong, onCheckSpectrum }) => (
  recentPlayed.length === 0 ? (
    <>
      <div className="page-head"><h2>Recently played</h2></div>
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
        <Icon name="clock" style={{ width: 36, height: 36, marginBottom: 10 }} />
        <div>Tracks you play will show up here.</div>
      </div>
    </>
  ) : (
    <SongList
      title="Recently played"
      musicFiles={recentPlayed}
      currentFile={currentFile}
      isPlaying={isPlaying}
      onPlay={onPlay}
      onToggleFavorite={onToggleFavorite}
      onAddPlaylist={onAddPlaylist}
      onDeleteSong={onDeleteSong}
      onDownloadSong={onDownloadSong}
      onCheckSpectrum={onCheckSpectrum}
      favorites={favorites}
    />
  )
);

export default RecentView;
