import React, { useContext, useMemo, useState } from 'react';
import SongList from './SongList';
import SongActions from './songActions';
import Cover from './Cover';
import Icon from './Icon';
import { Select, MoreMenu, BackButton, useDetailScroll } from './ui';
import { qualityOf, formatDuration, sortAlbumTracks } from '../utils/audio';
import { albumIndex, trackCount } from '../utils/albums';

const SORTS = [
  { value: 'name', label: 'Title A → Z' },
  { value: 'name-desc', label: 'Title Z → A' },
  { value: 'artist', label: 'Artist' },
  { value: 'tracks', label: 'Most tracks' },
  { value: 'latest', label: 'Latest added' },
  { value: 'oldest', label: 'Oldest added' },
];

const noThe = (s) => s.toLowerCase().replace(/^the /, '');

/** When each album came into the library. Tracks added in one scan share a time: their order in the library decides. */
const arrivals = (files, albums) => {
  const pos = new Map(files.map((f, i) => [f.path, i]));
  const at = new Map();
  albums.forEach((a) => {
    const time = Math.min(...a.songs.map(s => new Date(s.added_at || 0).getTime() || 0));
    at.set(a, [time, Math.min(...a.songs.map(s => pos.get(s.path) ?? 0))]);
  });
  return (a, b) => (at.get(a)[0] - at.get(b)[0]) || (at.get(a)[1] - at.get(b)[1]);
};

const bestQuality = (songs) => songs.map(qualityOf).sort((a, b) => (b.bits * 1e6 + b.rate) - (a.bits * 1e6 + a.rate))[0];

const AlbumsView = ({ musicFiles, currentFile, isPlaying, onPlay, onToggleFavorite, onAddPlaylist, favorites, onCheckSpectrum, selectedAlbum, setSelectedAlbum, onDeleteSong, onDeleteAlbum, onDownloadSong, onDownloadAlbum, onBackupMany, onBackupTo, storageNames, onRemoveFromCloud }) => {
  const [sortBy, setSortBy] = useState('name');
  const ctx = useContext(SongActions);
  useDetailScroll(selectedAlbum ? (selectedAlbum.key ?? selectedAlbum.name) : null);

  const albums = useMemo(() => {
    const list = [...albumIndex(musicFiles).list];
    switch (sortBy) {
      case 'name-desc': return list.sort((a, b) => noThe(b.name).localeCompare(noThe(a.name)));
      case 'artist': return list.sort((a, b) => noThe(a.artist).localeCompare(noThe(b.artist)));
      case 'tracks': return list.sort((a, b) => b.songs.length - a.songs.length);
      case 'latest': { const older = arrivals(musicFiles, list); return list.sort((a, b) => older(b, a)); }
      case 'oldest': return list.sort(arrivals(musicFiles, list));
      default: return list.sort((a, b) => noThe(a.name).localeCompare(noThe(b.name)));
    }
  }, [musicFiles, sortBy]);

  if (selectedAlbum) {
    // the album as it is in the library now (tracks change while it is open: cached, tagged, removed)
    const idx = albumIndex(musicFiles);
    const current = (selectedAlbum.key && idx.byKey.get(selectedAlbum.key))
      || (selectedAlbum.file && idx.byPath.get(selectedAlbum.file.path))
      || albums.find(a => a.name === selectedAlbum.name) || selectedAlbum;
    const songs = sortAlbumTracks(ctx.dedupe ? ctx.dedupe(current.songs || []) : current.songs || []);
    const q = bestQuality(songs);
    const total = songs.reduce((s, f) => s + (f.metadata?.duration || 0), 0);
    const year = songs.find(f => f.metadata?.year)?.metadata?.year;
    const artist = current.artist || songs[0]?.metadata?.artist || 'Unknown Artist';

    return (
      <>
        <div className="page-head" style={{ marginBottom: 6 }}>
          {selectedAlbum.fromArtist
            ? <BackButton onClick={() => ctx.openArtist?.(selectedAlbum.fromArtist, 'albums')} label={`Back to ${selectedAlbum.fromArtist}`} />
            : <BackButton onClick={() => setSelectedAlbum(null)} label="All albums" />}
          <span className="sub">{selectedAlbum.fromArtist || 'Albums'}</span>
        </div>
        <div className="detail-head">
          <Cover file={selectedAlbum.file || songs[0]} />
          <div className="info">
            <span className="eyebrow">Album</span>
            <h2 title={selectedAlbum.name}>{selectedAlbum.name}</h2>
            <div className="meta">
              <b style={{ color: 'var(--text)' }}>{artist}</b>
              {year && <span>· {year}</span>}
              <span>· {trackCount(songs.length)} · {formatDuration(total)}</span>
              {q && <span className={`badge b-${q.tier} mono`}>{q.label}</span>}
            </div>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => onPlay(songs[0], 0, songs)}><Icon name="play" filled />Play</button>
              <button className="btn-ghost" onClick={() => { const s = [...songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />Shuffle</button>
              <MoreMenu items={[
                ...(onDownloadAlbum ? [{ label: 'Download album', icon: 'download', onClick: () => onDownloadAlbum(songs, name) }] : []),
                ...(onAddPlaylist ? [{ label: 'Add to playlist', icon: 'playlist', onClick: () => onAddPlaylist(songs[0], songs) }] : []),
                ...(ctx.onEditInfo ? [{ label: 'Edit album info…', icon: 'music', onClick: () => ctx.onEditInfo(songs) }] : []),
                ...(ctx.onEditCover ? [{ label: 'Album cover…', icon: 'image', onClick: () => ctx.onEditCover(songs) }] : []),
                ...(onBackupMany ? [{ label: 'Back up album to…', icon: 'cloud', onClick: () => onBackupMany(songs, `“${selectedAlbum.name}”`) }] : []),
                ...(onRemoveFromCloud && songs.some(f => f.telegram_message_id) ? [{ label: 'Remove album from TeleCloud', icon: 'cloud', danger: true, onClick: () => onRemoveFromCloud(songs.filter(f => f.telegram_message_id)) }] : []),
                ...(onDeleteAlbum ? [{ sep: true }, { label: 'Delete album', icon: 'trash', danger: true, onClick: () => onDeleteAlbum({ ...selectedAlbum, songs }) }] : []),
              ]} />
            </div>
          </div>
        </div>
        <SongList
          groupDiscs
          linkAlbum={false}
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
            <div key={album.key} className="tile pressable" role="button" tabIndex={0} onClick={() => setSelectedAlbum(album)} onKeyDown={(e) => e.key === 'Enter' && setSelectedAlbum(album)}>
              <div className="cover-wrap">
                <Cover file={album.file} />
                <button className="play-fab" title="Play album" onClick={(e) => { e.stopPropagation(); const list = sortAlbumTracks(album.songs); onPlay(list[0], 0, list); }}><Icon name="play" /></button>
              </div>
              <b>{album.name}</b>
              <span>{album.artist} · {trackCount(ctx.countUnique ? ctx.countUnique(album.songs) : album.songs.length)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default AlbumsView;
