import React, { useContext, useMemo, useState, useEffect } from 'react';
import SongList from './SongList';
import ArtistBio from './ArtistBio';
import Cover from './Cover';
import ArtistPicture from './ArtistPicture';
import ArtistPictureDialog from './ArtistPictureDialog';
import Icon from './Icon';
import { Select, BackButton, Segmented, useDetailScroll } from './ui';
import SongActions from './songActions';
import { formatDuration, sortAlbumTracks } from '../utils/audio';
import { albumIndex, artistLabel, artistsOf, trackCount, UNKNOWN_ARTIST, VARIOUS_ARTISTS } from '../utils/albums';

const SORTS = [
  { value: 'name', label: 'Name A → Z' },
  { value: 'name-desc', label: 'Name Z → A' },
  { value: 'tracks', label: 'Most tracks' },
];

const noThe = (s) => s.toLowerCase().replace(/^the /, '');

/** Many albums under one label: a grid of their covers. Two or three repeat, so it stays a square. */
const LabelPicture = ({ albums, className = '' }) => {
  if (albums.length < 2) return <Cover file={albums[0]?.file} className={className} />;
  return (
    <div className={`cover ${className}`}>
      <div className="mosaic">{[0, 1, 2, 3].map(i => <Cover key={i} file={albums[i % albums.length].file} />)}</div>
    </div>
  );
};

const ArtistsView = ({ musicFiles, currentFile, isPlaying, onPlay, onToggleFavorite, onAddPlaylist, favorites, onCheckSpectrum, onDeleteSong, onDownloadSong, selectedArtist, setSelectedArtist, artistTab, setArtistTab }) => {
  const ctx = useContext(SongActions);
  // App owns the open artist (so a click on an artist name anywhere can open it); local state as a fallback
  const [localName, setLocalName] = useState(null);
  const selectedName = setSelectedArtist ? selectedArtist : localName;
  const setSelectedName = setSelectedArtist || setLocalName;
  const [sortBy, setSortBy] = useState('name');
  const [labelTab, setLabelTab] = useState('albums');
  useDetailScroll(selectedName ?? null);

  // Opening an artist without a picture: look for one, like a playing track without a cover
  const [pictureOpen, setPictureOpen] = useState(false);
  const [hasPicture, setHasPicture] = useState(false);
  const [found, setFound] = useState(null); // { name, thumb, image, label }: shown, not saved yet
  useEffect(() => {
    setFound(null);
    setHasPicture(false);
    setLabelTab('albums');
    if (!selectedName || artistLabel(selectedName)) return undefined; // a search would return somebody else's face
    let alive = true;
    (async () => {
      const has = await window.ipcRenderer.invoke('artists:has', { name: selectedName }).catch(() => false);
      if (!alive) return;
      setHasPicture(has);
      if (has) return;
      const o = await window.ipcRenderer.invoke('artists:options').catch(() => null);
      if (!o?.search || !alive) return;
      const r = await window.ipcRenderer.invoke('artists:search', { query: { artist: selectedName }, auto: true }).catch(() => null);
      // only a picture under exactly this name: a wrong face is worse than an album cover
      const best = r?.results?.find(x => x.score >= 0.9);
      if (!alive || !best) return;
      if (o.autoSave) {
        const saved = await window.ipcRenderer.invoke('artists:save', { name: selectedName, image: best.image, onlyMissing: true }).catch(() => null);
        if (alive && saved?.success) setHasPicture(true);
      } else setFound({ name: selectedName, thumb: best.thumb, image: best.image, label: o.sources?.[best.source]?.label || best.source });
    })();
    return () => { alive = false; };
  }, [selectedName]);
  // Saving into thousands of tracks takes a while: say how far it is, here and in the dialog
  const [work, setWork] = useState(null);
  useEffect(() => {
    const on = (e, p) => setWork(p.finished ? null : p);
    window.ipcRenderer.on('artists:progress', on);
    return () => window.ipcRenderer.removeListener?.('artists:progress', on);
  }, []);
  const saveFound = async () => {
    const r = await window.ipcRenderer.invoke('artists:save', { name: found.name, image: found.image }).catch(() => null);
    if (r?.success && !r.errors?.length && !r.stopped) { setFound(null); setHasPicture(true); } else setPictureOpen(true);
  };

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
    const list = [...map.values()].filter(a => !artistLabel(a.name));
    switch (sortBy) {
      case 'name-desc': list.sort((a, b) => noThe(b.name).localeCompare(noThe(a.name))); break;
      case 'tracks': list.sort((a, b) => b.songs.length - a.songs.length); break;
      default: list.sort((a, b) => noThe(a.name).localeCompare(noThe(b.name)));
    }
    // the two labels come first, holding the albums nobody is named on
    const albums = albumIndex(musicFiles).list;
    const labels = [VARIOUS_ARTISTS, UNKNOWN_ARTIST].map((name) => {
      const own = albums.filter(a => artistLabel(a.artist) === name).sort((a, b) => b.year - a.year || noThe(a.name).localeCompare(noThe(b.name)));
      return own.length ? { name, label: true, albums: own, file: own[0].file, songs: own.flatMap(a => a.songs) } : null;
    }).filter(Boolean);
    return [...labels, ...list];
  }, [musicFiles, sortBy]);

  // a track can say "VA" or "Various": they all open the one page
  const wanted = selectedName ? (artistLabel(selectedName) || selectedName) : null;
  const selected = wanted ? artists.find(a => a.name === wanted) : null;
  // the grid shows album artists by default; pages of everyone else stay reachable from their tracks
  const shown = useMemo(() => {
    if (ctx.artistFilter === 'all') return artists;
    const owners = new Set(albumIndex(musicFiles).list.flatMap(a => [...a.owners]));
    return artists.filter(a => a.label || owners.has(a.name.toLowerCase()));
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
    const ownAlbums = (selected.label ? selected.albums : [...touched].filter(a => a.owners.has(who)).sort(newest)).map(view);
    const appearsOn = selected.label ? [] : [...touched].filter(a => !a.owners.has(who)).sort(newest).map(view);
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
    // a label is about its albums; which tab it is on has no bearing on the real artists
    const tab = selected.label ? labelTab : artistTab === 'albums' ? 'albums' : 'songs';
    const total = songs.reduce((s, f) => s + (f.metadata?.duration || 0), 0);
    return (
      <>
        <div className="page-head" style={{ marginBottom: 6 }}>
          <BackButton onClick={() => setSelectedName(null)} label="All artists" />
          <span className="sub">Artists</span>
        </div>
        <div className="detail-head">
          {selected.label ? <LabelPicture albums={selected.albums} className="round" /> : <ArtistPicture name={selected.name} file={selected.file} preview={found?.thumb} animated className="round" />}
          <div className="info">
            <span className="eyebrow">{!selected.label ? 'Artist' : selected.name === VARIOUS_ARTISTS ? 'Albums by many artists' : 'Albums without an artist'}</span>
            <h2>{selected.name}</h2>
            <div className="meta">{albumCount} {albumCount === 1 ? 'album' : 'albums'} · {trackCount(songs.length)} · {formatDuration(total)}</div>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => onPlay(songs[0], 0, songs)}><Icon name="play" filled />Play</button>
              <button className="btn-ghost" onClick={() => { const s = [...songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />Shuffle</button>
              {!selected.label && <button className="btn-ghost" onClick={() => setPictureOpen(true)}><Icon name="image" />Artist picture…</button>}
            </div>
            {work && work.name === selected.name && !pictureOpen && (
              <div className="lyrics-note found artist-note">
                <span>Saving the picture · {work.done.toLocaleString()} of {work.total.toLocaleString()} tracks</span>
                <button className="btn-ghost sm" onClick={() => window.ipcRenderer.invoke('artists:stop')}>Stop</button>
              </div>
            )}
            {found && !(work && work.name === selected.name) && (
              <div className="lyrics-note found artist-note">
                <span>Picture from {found.label} · not saved</span>
                <button className="btn-ghost sm" onClick={saveFound}><Icon name="check" />Save</button>
                <button className="btn-ghost sm" onClick={() => setPictureOpen(true)}><Icon name="search" />Other results</button>
              </div>
            )}
          </div>
        </div>
        {pictureOpen && (
          <ArtistPictureDialog
            name={selected.name}
            file={selected.file}
            hasPicture={hasPicture}
            onClose={() => setPictureOpen(false)}
            onSaved={() => { window.ipcRenderer.invoke('artists:has', { name: selected.name }).then(setHasPicture); setFound(null); }}
          />
        )}
        {!selected.label && <ArtistBio name={selected.name} known={new Set(artists.map(a => a.name))} />}
        <div className="artist-tabs">
          <Segmented value={tab} onChange={selected.label ? setLabelTab : setArtistTab} options={[{ value: 'songs', label: `Songs · ${songs.length.toLocaleString()}` }, { value: 'albums', label: `Albums · ${albumCount}` }]} />
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
        <span className="sub">{(() => { const n = shown.filter(a => !a.label).length; return `${n.toLocaleString()} ${n === 1 ? 'artist' : 'artists'}`; })()}</span>
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
      {shown.every(a => a.label) && (shown.length === 0 || artists.length > shown.length) && (
        <div className="empty">
          {artists.length === 0 ? 'No artists in your library yet.' : (
            <>
              <div>No album artists here yet. The artists in your library are only on compilations.</div>
              <button className="btn-ghost" style={{ marginTop: 12 }} onClick={() => ctx.setArtistFilter?.('all')}>Show all artists</button>
            </>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <div className="tile-grid">
          {shown.map(artist => artist.label ? (
            <div key={artist.name} className="tile round pressable artist-label" role="button" tabIndex={0} onClick={() => setSelectedName(artist.name)} onKeyDown={(e) => e.key === 'Enter' && setSelectedName(artist.name)}>
              <div className="cover-wrap" style={{ width: '100%' }}><LabelPicture albums={artist.albums} /></div>
              <b>{artist.name}</b>
              <span>{artist.albums.length.toLocaleString()} {artist.albums.length === 1 ? 'album' : 'albums'}</span>
            </div>
          ) : (
            <div key={artist.name} className="tile round pressable" role="button" tabIndex={0} onClick={() => setSelectedName(artist.name)} onKeyDown={(e) => e.key === 'Enter' && setSelectedName(artist.name)}>
              <div className="cover-wrap" style={{ width: '100%' }}><ArtistPicture name={artist.name} file={artist.file} /></div>
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
