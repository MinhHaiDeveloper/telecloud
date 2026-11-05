import React, { useContext, useMemo } from 'react';
import SongActions from './songActions';
import { splitArtists } from './MetaLinks';
import SongList from './SongList';
import Cover from './Cover';
import Icon from './Icon';

// Highlight matched text
const HighlightText = ({ text, highlight }) => {
  if (!text) return null;
  if (!highlight.trim()) return <>{text}</>;
  const escaped = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return <>{parts.map((part, i) => (part.toLowerCase() === highlight.toLowerCase() ? <mark key={i} className="hl">{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>))}</>;
};

const SearchView = ({ searchQuery, musicFiles, playlists, onNavClick, setSelectedAlbum, setSearchQuery, onOpenPlaylist, songListProps }) => {
  const q = searchQuery.trim().toLowerCase();
  const { openArtist, countUnique } = useContext(SongActions);

  const results = useMemo(() => {
    const has = (s) => (s || '').toLowerCase().includes(q);
    const songs = musicFiles.filter(f => has(f.metadata?.title) || has(f.name) || has(f.metadata?.artist) || has(f.metadata?.album));

    const artistMap = new Map();
    const albumMap = new Map();
    musicFiles.forEach(f => {
      const artistNames = splitArtists(f.metadata?.artist || 'Unknown Artist');
      const album = f.metadata?.album || 'Unknown Album';
      artistNames.forEach(artist => {
        if (!has(artist)) return;
        if (!artistMap.has(artist)) artistMap.set(artist, { name: artist, file: f, songs: [] });
        artistMap.get(artist).songs.push(f);
      });
      if (has(album) || artistNames.some(has)) {
        if (!albumMap.has(album)) albumMap.set(album, { name: album, artist: f.metadata?.artist || 'Unknown Artist', file: f, songs: [], cover: f.path ? `media://${encodeURIComponent(f.path)}` : f.cover });
        albumMap.get(album).songs.push(f);
      }
    });

    return {
      songs,
      artists: [...artistMap.values()],
      albums: [...albumMap.values()],
      playlists: playlists.filter(p => has(p.name)),
    };
  }, [q, musicFiles, playlists]);

  // navigating to Albums clears the selection, so select the album after it
  const openAlbum = (album) => { setSearchQuery(''); onNavClick('albums'); setSelectedAlbum(album); };
  const nothing = !results.songs.length && !results.artists.length && !results.albums.length && !results.playlists.length;

  return (
    <>
      <div className="page-head">
        <h2>Results for “{searchQuery}”</h2>
        <span className="sub">{results.songs.length.toLocaleString()} tracks · {results.albums.length} albums · {results.artists.length} artists</span>
      </div>

      {nothing && (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          <Icon name="search" style={{ width: 36, height: 36, marginBottom: 10 }} />
          <div>Nothing matches “{searchQuery}”. Try an artist, album or track title.</div>
        </div>
      )}

      {results.albums.length > 0 && (
        <section className="search-section">
          <div className="section-head"><span>Albums</span></div>
          <div className="h-scroll">
            {results.albums.slice(0, 20).map(a => (
              <button key={a.name} className="tile" onClick={() => openAlbum(a)}>
                <Cover file={a.file} />
                <b><HighlightText text={a.name} highlight={q} /></b>
                <span><HighlightText text={a.artist} highlight={q} /></span>
              </button>
            ))}
          </div>
        </section>
      )}

      {(results.artists.length > 0 || results.playlists.length > 0) && (
        <section className="search-section">
          <div className="section-head"><span>Artists & playlists</span></div>
          <div className="h-scroll" style={{ gridAutoColumns: 130 }}>
            {results.artists.slice(0, 20).map(a => (
              <button key={`a-${a.name}`} className="tile round" onClick={() => { setSearchQuery(''); openArtist?.(a.name); }}>
                <Cover file={a.file} />
                <b><HighlightText text={a.name} highlight={q} /></b>
                <span>Artist · {countUnique ? countUnique(a.songs) : a.songs.length} tracks</span>
              </button>
            ))}
            {results.playlists.map(p => (
              <button key={`p-${p.id}`} className="tile" onClick={() => { setSearchQuery(''); onOpenPlaylist(p.id); }}>
                <Cover file={p.songs?.[0]} />
                <b><HighlightText text={p.name} highlight={q} /></b>
                <span>Playlist · {p.songs?.length || 0} tracks</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {results.songs.length > 0 && (
        <section className="search-section">
          <SongList
            {...songListProps}
            title="Tracks"
            subtitle={results.songs.length > 100 ? `Showing 100 of ${results.songs.length.toLocaleString()}` : `${results.songs.length} tracks`}
            musicFiles={results.songs.slice(0, 100)}
          />
        </section>
      )}
    </>
  );
};

export default SearchView;
