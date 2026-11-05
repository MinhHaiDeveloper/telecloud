import React, { useContext, useMemo, useState } from 'react';
import SongList from './SongList';
import ArtistBio from './ArtistBio';
import Cover from './Cover';
import Icon from './Icon';
import { Select, BackButton, Segmented, useDetailScroll } from './ui';
import SongActions from './songActions';
import { formatDuration, sortAlbumTracks } from '../utils/audio';

const SORTS = [
  { value: 'name', label: 'Name A → Z' },
  { value: 'name-desc', label: 'Name Z → A' },
  { value: 'tracks', label: 'Most tracks' },
];

const noThe = (s) => s.toLowerCase().replace(/^the /, '');

const ArtistsView = ({ musicFiles, currentFile, isPlaying, onPlay, onToggleFavorite, onAddPlaylist, favorites, onCheckSpectrum, onDeleteSong, onDownloadSong, selectedArtist, setSelectedArtist, artistTab, setArtistTab }) => {
  const ctx = useContext(SongActions);
  // App owns the open artist (so a click on an artist name anywhere can open it); local state as a fallback
  const [localName, setLocalName] = useState(null);
  const selectedName = setSelectedArtist ? selectedArtist : localName;
  const setSelectedName = setSelectedArtist || setLocalName;
  const [sortBy, setSortBy] = useState('name');
  useDetailScroll(selectedName ?? null);

  const artists = useMemo(() => {
    const map = new Map();
    musicFiles.forEach(file => {
      // "A, B & C feat. D" counts toward each artist
      const names = (file.metadata?.artist || 'Unknown Artist')
        .split(/,|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+/i).map(a => a.trim()).filter(Boolean);
      names.forEach(name => {
        if (!map.has(name)) map.set(name, { name, file, songs: [], albums: new Set() });
        const a = map.get(name);
        a.songs.push(file);
        if (file.metadata?.album) a.albums.add(file.metadata.album);
      });
    });
    const list = [...map.values()];
    switch (sortBy) {
      case 'name-desc': return list.sort((a, b) => noThe(b.name).localeCompare(noThe(a.name)));
      case 'tracks': return list.sort((a, b) => b.songs.length - a.songs.length);
      default: return list.sort((a, b) => noThe(a.name).localeCompare(noThe(b.name)));
    }
  }, [musicFiles, sortBy]);

  const selected = selectedName ? artists.find(a => a.name === selectedName) : null;

  if (selected) {
    const songs = ctx.dedupe ? ctx.dedupe(selected.songs) : selected.songs;
    // this artist's albums, newest first (each with its tracks in album order)
    const byAlbum = new Map();
    songs.forEach(f => {
      const name = f.metadata?.album || 'Unknown Album';
      if (!byAlbum.has(name)) byAlbum.set(name, []);
      byAlbum.get(name).push(f);
    });
    const artistAlbums = [...byAlbum.entries()]
      .map(([name, list]) => ({ name, songs: sortAlbumTracks(list), year: list.find(f => f.metadata?.year)?.metadata?.year || 0 }))
      .sort((a, b) => b.year - a.year || noThe(a.name).localeCompare(noThe(b.name)));
    const tab = artistTab === 'albums' ? 'albums' : 'songs';
    const total = songs.reduce((s, f) => s + (f.metadata?.duration || 0), 0);
    return (
      <>
        <div className="page-head" style={{ marginBottom: 6 }}>
          <BackButton onClick={() => setSelectedName(null)} label="All artists" />
          <span className="sub">Artists</span>
        </div>
        <div className="detail-head">
          <Cover file={selected.file} className="round" />
          <div className="info">
            <span className="eyebrow">Artist</span>
            <h2>{selected.name}</h2>
            <div className="meta">{artistAlbums.length} {artistAlbums.length === 1 ? 'album' : 'albums'} · {songs.length} tracks · {formatDuration(total)}</div>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => onPlay(songs[0], 0, songs)}><Icon name="play" filled />Play</button>
              <button className="btn-ghost" onClick={() => { const s = [...songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />Shuffle</button>
            </div>
          </div>
        </div>
        <ArtistBio name={selected.name} known={new Set(artists.map(a => a.name))} />
        <div className="artist-tabs">
          <Segmented value={tab} onChange={setArtistTab} options={[{ value: 'songs', label: `Songs · ${songs.length.toLocaleString()}` }, { value: 'albums', label: `Albums · ${artistAlbums.length}` }]} />
        </div>
        {tab === 'albums' ? (
          <div className="tile-grid">
            {artistAlbums.map(album => (
              <div key={album.name} className="tile pressable" role="button" tabIndex={0} onClick={() => ctx.openAlbum?.(album.name, selected.name)} onKeyDown={(e) => e.key === 'Enter' && ctx.openAlbum?.(album.name, selected.name)}>
                <div className="cover-wrap">
                  <Cover file={album.songs[0]} />
                  <button className="play-fab" title="Play album" onClick={(e) => { e.stopPropagation(); onPlay(album.songs[0], 0, album.songs); }}><Icon name="play" /></button>
                </div>
                <b>{album.name}</b>
                <span>{album.year ? `${album.year} · ` : ''}{album.songs.length} {album.songs.length === 1 ? 'track' : 'tracks'}</span>
              </div>
            ))}
          </div>
        ) : (
        <SongList
          musicFiles={songs}
          currentFile={currentFile}
          isPlaying={isPlaying}
          onPlay={(file, idx, list) => onPlay(file, idx, list)}
          onToggleFavorite={onToggleFavorite}
          onAddPlaylist={onAddPlaylist}
          favorites={favorites}
          onCheckSpectrum={onCheckSpectrum}
          onDeleteSong={onDeleteSong}
          onDownloadSong={onDownloadSong}
          showSort
        />
        )}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h2>Artists</h2>
        <span className="sub">{artists.length.toLocaleString()} artists</span>
        <div className="end"><Select variant="ghost" icon="sort" align="right" value={sortBy} options={SORTS} onChange={setSortBy} /></div>
      </div>
      {artists.length === 0 ? (
        <div className="empty">No artists in your library yet.</div>
      ) : (
        <div className="tile-grid">
          {artists.map(artist => (
            <div key={artist.name} className="tile round pressable" role="button" tabIndex={0} onClick={() => setSelectedName(artist.name)} onKeyDown={(e) => e.key === 'Enter' && setSelectedName(artist.name)}>
              <div className="cover-wrap" style={{ width: '100%' }}><Cover file={artist.file} /></div>
              <b>{artist.name}</b>
              <span>{ctx.countUnique ? ctx.countUnique(artist.songs) : artist.songs.length} tracks</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default ArtistsView;
