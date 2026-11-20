import React, { useContext, useMemo } from 'react';
import SongActions from './songActions';
import { albumIndex, albumArtistsOf, artistsOf, trackCount } from '../utils/albums';
import SongList from './SongList';
import Cover from './Cover';
import ArtistPicture from './ArtistPicture';
import Icon from './Icon';
import { t } from '../i18n';

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
    musicFiles.forEach(f => {
      [...artistsOf(f), ...albumArtistsOf(f)].forEach(artist => {
        if (!has(artist)) return;
        if (!artistMap.has(artist)) artistMap.set(artist, { name: artist, file: f, songs: [], paths: new Set() });
        const a = artistMap.get(artist);
        if (!a.paths.has(f.path)) { a.paths.add(f.path); a.songs.push(f); }
      });
    });
    const albums = albumIndex(musicFiles).list.filter(a => has(a.name) || has(a.artist) || a.songs.some(f => artistsOf(f).some(has)));

    return {
      songs,
      artists: [...artistMap.values()],
      albums,
      playlists: playlists.filter(p => has(p.name)),
    };
  }, [q, musicFiles, playlists]);

  // navigating to Albums clears the selection, so select the album after it
  const openAlbum = (album) => { setSearchQuery(''); onNavClick('albums'); setSelectedAlbum(album); };
  const nothing = !results.songs.length && !results.artists.length && !results.albums.length && !results.playlists.length;

  return (
    <>
      <div className="page-head">
        <h2>{t('Results for “{searchQuery}', { searchQuery })}”</h2>
        <span className="sub">{t('{length} tracks · {length2} albums · {length3} artists', { length: results.songs.length.toLocaleString(), length2: results.albums.length, length3: results.artists.length })}</span>
      </div>

      {nothing && (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          <Icon name="search" style={{ width: 36, height: 36, marginBottom: 10 }} />
          <div>{t('Nothing matches “{searchQuery}”. Try an artist, album or track title.', { searchQuery })}</div>
        </div>
      )}

      {results.albums.length > 0 && (
        <section className="search-section">
          <div className="section-head"><span>{t('Albums')}</span></div>
          <div className="h-scroll">
            {results.albums.slice(0, 20).map(a => (
              <button key={a.key} className="tile" onClick={() => openAlbum(a)}>
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
          <div className="section-head"><span>{t('Artists & playlists')}</span></div>
          <div className="h-scroll" style={{ gridAutoColumns: 130 }}>
            {results.artists.slice(0, 20).map(a => (
              <button key={`a-${a.name}`} className="tile round" onClick={() => { setSearchQuery(''); openArtist?.(a.name); }}>
                <ArtistPicture name={a.name} file={a.file} />
                <b><HighlightText text={a.name} highlight={q} /></b>
                <span>{t('Artist · {trackCount}', { trackCount: trackCount(countUnique ? countUnique(a.songs) : a.songs.length) })}</span>
              </button>
            ))}
            {results.playlists.map(p => (
              <button key={`p-${p.id}`} className="tile" onClick={() => { setSearchQuery(''); onOpenPlaylist(p.id); }}>
                <Cover file={p.songs?.[0]} />
                <b><HighlightText text={p.name} highlight={q} /></b>
                <span>{t('Playlist · {value} tracks', { value: p.songs?.length || 0 })}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {results.songs.length > 0 && (
        <section className="search-section">
          <SongList
            {...songListProps}
            title={t('Tracks')}
            subtitle={results.songs.length > 100 ? t('Showing 100 of {length}', { length: results.songs.length.toLocaleString() }) : t('{length} tracks', { length: results.songs.length })}
            musicFiles={results.songs.slice(0, 100)}
          />
        </section>
      )}
    </>
  );
};

export default SearchView;
