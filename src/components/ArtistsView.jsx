import React, { useContext, useMemo, useState } from 'react';
import SongList from './SongList';
import ArtistBio from './ArtistBio';
import Cover from './Cover';
import Icon from './Icon';
import { Select, BackButton, Segmented, useDetailScroll } from './ui';
import SongActions from './songActions';
import { formatDuration, sortAlbumTracks } from '../utils/audio';
import { albumIndex, artistsOf, trackCount } from '../utils/albums';

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
      artistsOf(file).concat(file.metadata?.artist ? [] : ['Unknown Artist']).forEach(name => {
        if (!map.has(name)) map.set(name, { name, file, songs: [] });
        map.get(name).songs.push(file);
      });
    });
    // someone only named as album artist (a DJ mix, a composer) still has a page
    const low = new Map([...map.keys()].map(n => [n.toLowerCase(), n]));
    albumIndex(musicFiles).list.forEach(album => {
      album.ownerNames.forEach(name => {
        if (!low.has(name.toLowerCase())) { low.set(name.toLowerCase(), name); map.set(name, { name, file: album.file, songs: [...album.songs] }); }
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
  // the grid shows album artists by default; pages of everyone else stay reachable from their tracks
  const shown = useMemo(() => {
    if (ctx.artistFilter === 'all') return artists;
    const owners = new Set(albumIndex(musicFiles).list.flatMap(a => [...a.owners]));
    return artists.filter(a => owners.has(a.name.toLowerCase()));
  }, [artists, ctx.artistFilter, musicFiles]);

  if (selected) {
    const songs = ctx.dedupe ? ctx.dedupe(selected.songs) : selected.songs;
    // albums of their own, then albums they only appear on; newest first
    const idx = albumIndex(musicFiles);
    const who = selected.name.toLowerCase();
    const touched = new Set(songs.map(f => idx.byPath.get(f.path)).filter(Boolean));
    idx.list.forEach(a => { if (a.owners.has(who)) touched.add(a); });
    const newest = (a, b) => b.year - a.year || noThe(a.name).localeCompare(noThe(b.name));
    const view = (a) => { const list = sortAlbumTracks(ctx.dedupe ? ctx.dedupe(a.songs) : a.songs); return { ...a, songs: list }; };
    const ownAlbums = [...touched].filter(a => a.owners.has(who)).sort(newest).map(view);
    const appearsOn = [...touched].filter(a => !a.owners.has(who)).sort(newest).map(view);
    const albumCount = ownAlbums.length + appearsOn.length;
    const tile = (album) => (
      <div key={album.key} className="tile pressable" role="button" tabIndex={0} onClick={() => ctx.openAlbum?.(album, selected.name)} onKeyDown={(e) => e.key === 'Enter' && ctx.openAlbum?.(album, selected.name)}>
        <div className="cover-wrap">
          <Cover file={album.file} />
          <button className="play-fab" title="Play album" onClick={(e) => { e.stopPropagation(); onPlay(album.songs[0], 0, album.songs); }}><Icon name="play" /></button>
        </div>
        <b>{album.name}</b>
        <span>{album.year ? `${album.year} · ` : ''}{album.songs.length} {album.songs.length === 1 ? 'track' : 'tracks'}</span>
      </div>
    );
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
            <div className="meta">{albumCount} {albumCount === 1 ? 'album' : 'albums'} · {trackCount(songs.length)} · {formatDuration(total)}</div>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => onPlay(songs[0], 0, songs)}><Icon name="play" filled />Play</button>
              <button className="btn-ghost" onClick={() => { const s = [...songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />Shuffle</button>
            </div>
          </div>
        </div>
        <ArtistBio name={selected.name} known={new Set(artists.map(a => a.name))} />
        <div className="artist-tabs">
          <Segmented value={tab} onChange={setArtistTab} options={[{ value: 'songs', label: `Songs · ${songs.length.toLocaleString()}` }, { value: 'albums', label: `Albums · ${albumCount}` }]} />
        </div>
        {tab === 'albums' ? (
          <>
            {ownAlbums.length > 0 && <div className="tile-grid">{ownAlbums.map(tile)}</div>}
            {appearsOn.length > 0 && (
              <>
                <div className="section-head artist-appears"><span>Appears on</span></div>
                <div className="tile-grid">{appearsOn.map(tile)}</div>
              </>
            )}
          </>
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
        <span className="sub">{shown.length.toLocaleString()} artists</span>
        <div className="end">
          <Segmented
            size="sm"
            value={ctx.artistFilter === 'all' ? 'all' : 'album'}
            onChange={(v) => { ctx.setArtistFilter?.(v); const view = document.querySelector('.view'); if (view) view.scrollTop = 0; }}
            options={[{ value: 'album', label: 'Album artists' }, { value: 'all', label: 'All artists' }]}
          />
          <Select variant="ghost" icon="sort" align="right" value={sortBy} options={SORTS} onChange={setSortBy} />
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="empty">
          {artists.length === 0 ? 'No artists in your library yet.' : (
            <>
              <div>No album artists here yet. The artists in your library are only on compilations.</div>
              <button className="btn-ghost" style={{ marginTop: 12 }} onClick={() => ctx.setArtistFilter?.('all')}>Show all artists</button>
            </>
          )}
        </div>
      ) : (
        <div className="tile-grid">
          {shown.map(artist => (
            <div key={artist.name} className="tile round pressable" role="button" tabIndex={0} onClick={() => setSelectedName(artist.name)} onKeyDown={(e) => e.key === 'Enter' && setSelectedName(artist.name)}>
              <div className="cover-wrap" style={{ width: '100%' }}><Cover file={artist.file} /></div>
              <b>{artist.name}</b>
              <span>{trackCount(ctx.countUnique ? ctx.countUnique(artist.songs) : artist.songs.length)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default ArtistsView;
