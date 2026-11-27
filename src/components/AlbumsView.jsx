import React, { useContext, useMemo } from 'react';
import SongList from './SongList';
import SongActions from './songActions';
import Cover from './Cover';
import Icon from './Icon';
import { Select, MoreMenu, BackButton, useDetailScroll } from './ui';
import { qualityOf, formatDuration, sortAlbumTracks } from '../utils/audio';
import { albumIndex, trackCount, sortAlbums } from '../utils/albums';
import useRemembered from '../hooks/useRemembered';
import { t } from '../i18n';

const SORTS = [
  { value: 'name', get label() { return t('Title A → Z'); } },
  { value: 'name-desc', get label() { return t('Title Z → A'); } },
  { value: 'artist', get label() { return t('Artist'); } },
  { value: 'tracks', get label() { return t('Most tracks'); } },
  { value: 'latest', get label() { return t('Latest added'); } },
  { value: 'oldest', get label() { return t('Oldest added'); } },
];

/** Only in TeleCloud: what Keep offline downloads */
const inCloudOnly = (f) => (f.storage_type || 'local') === 'cloud' || f.path?.startsWith('tc://');
const bestQuality = (songs) => songs.map(qualityOf).sort((a, b) => (b.bits * 1e6 + b.rate) - (a.bits * 1e6 + a.rate))[0];

const AlbumsView = ({ musicFiles, currentFile, isPlaying, onPlay, onToggleFavorite, onAddPlaylist, favorites, onCheckSpectrum, selectedAlbum, setSelectedAlbum, onDeleteSong, onDeleteAlbum, onDownloadSong, onDownloadAlbum, onBackupMany, onBackupTo, storageNames, onRemoveFromCloud }) => {
  const [sortBy, setSortBy] = useRemembered('albums:sort', 'name', SORTS.map(s => s.value));
  const ctx = useContext(SongActions);
  useDetailScroll(selectedAlbum ? (selectedAlbum.key ?? selectedAlbum.name) : null);

  const albums = useMemo(() => sortAlbums(albumIndex(musicFiles).list, sortBy, musicFiles), [musicFiles, sortBy]);

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
    const offlineKey = current.key ? `album:${current.key}` : null;
    const keptOffline = !!offlineKey && !!ctx.offlineKeys?.has(offlineKey);

    return (
      <>
        <div className="page-head detail-nav">
          {selectedAlbum.fromArtist
            ? <BackButton onClick={() => ctx.openArtist?.(selectedAlbum.fromArtist, 'albums')} label={t('Back to {fromArtist}', { fromArtist: selectedAlbum.fromArtist })} />
            : <BackButton onClick={() => setSelectedAlbum(null)} label={t('All albums')} />}
          <span className="sub">{selectedAlbum.fromArtist || t('Albums')}</span>
        </div>
        <div className="detail-head">
          <Cover file={selectedAlbum.file || songs[0]} />
          <div className="info">
            <span className="eyebrow">{t('Album')}</span>
            <h2 title={selectedAlbum.name}>{selectedAlbum.name}</h2>
            <div className="meta">
              <b style={{ color: 'var(--text)' }}>{artist}</b>
              {year && <span>· {year}</span>}
              <span>· {trackCount(songs.length)} · {formatDuration(total)}</span>
              {q && <span className={`badge b-${q.tier} mono`}>{q.label}</span>}
              {keptOffline && <span className="badge b-cached" title={t('Its cloud tracks stay in the cache, also when the cache is full')}>{t('Kept offline')}</span>}
            </div>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => onPlay(songs[0], 0, songs)}><Icon name="play" filled />{t('Play')}</button>
              <button className="btn-ghost" onClick={() => { const s = [...songs].sort(() => Math.random() - 0.5); onPlay(s[0], 0, s); }}><Icon name="shuffle" />{t('Shuffle')}</button>
              <MoreMenu items={[
                ...(onDownloadAlbum ? [{ label: t('Download album'), icon: 'download', onClick: () => onDownloadAlbum(songs, selectedAlbum.name) }] : []),
                ...(ctx.setOffline && offlineKey && songs.some(inCloudOnly) ? [{ label: keptOffline ? t('Stop keeping offline') : t('Keep offline'), icon: 'disc', onClick: () => ctx.setOffline(offlineKey, selectedAlbum.name, 'album', songs, !keptOffline) }] : []),
                ...(onAddPlaylist ? [{ label: t('Add to playlist'), icon: 'playlist', onClick: () => onAddPlaylist(songs[0], songs) }] : []),
                ...(ctx.onEditInfo ? [{ label: t('Edit album info…'), icon: 'music', onClick: () => ctx.onEditInfo(songs) }] : []),
                ...(ctx.onEditCover ? [{ label: t('Album cover…'), icon: 'image', onClick: () => ctx.onEditCover(songs) }] : []),
                ...(onBackupMany ? [{ label: t('Back up album to…'), icon: 'cloud', onClick: () => onBackupMany(songs, `“${selectedAlbum.name}”`) }] : []),
                ...(onRemoveFromCloud && songs.some(f => f.telegram_message_id) ? [{ label: t('Remove album from TeleCloud'), icon: 'cloud', danger: true, onClick: () => onRemoveFromCloud(songs.filter(f => f.telegram_message_id)) }] : []),
                ...(onDeleteAlbum ? [{ sep: true }, { label: t('Delete album'), icon: 'trash', danger: true, onClick: () => onDeleteAlbum({ ...selectedAlbum, songs }) }] : []),
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
        <h2>{t('Albums')}</h2>
        <span className="sub">{t('{length} albums', { length: albums.length.toLocaleString() })}</span>
        <div className="end"><Select variant="ghost" icon="sort" align="right" value={sortBy} options={SORTS} onChange={setSortBy} /></div>
      </div>
      {albums.length === 0 ? (
        <div className="empty">{t('No albums in your library yet.')}</div>
      ) : (
        <div className="tile-grid">
          {albums.map(album => (
            <div key={album.key} className="tile pressable" role="button" tabIndex={0} onClick={() => setSelectedAlbum(album)} onKeyDown={(e) => e.key === 'Enter' && setSelectedAlbum(album)}>
              <div className="cover-wrap">
                <Cover file={album.file} />
                <button className="play-fab" title={t('Play album')} onClick={(e) => { e.stopPropagation(); const list = sortAlbumTracks(album.songs); onPlay(list[0], 0, list); }}><Icon name="play" /></button>
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
