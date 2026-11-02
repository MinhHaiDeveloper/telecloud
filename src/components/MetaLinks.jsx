import React, { useContext } from 'react';
import SongActions from './songActions';

// "A, B & C feat. D" → each artist on its own (the Artists page counts them the same way)
export const splitArtists = (s) => (s || '').split(/,|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+/i).map(a => a.trim()).filter(Boolean);

// Text that opens a page when clicked. Ctrl/Shift clicks fall through to the row (track selection).
const Link = ({ children, onOpen }) => (
  <span
    className="meta-link"
    role="link"
    tabIndex={0}
    onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.stopPropagation(); onOpen(); }}
    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpen(); } }}
  >
    {children}
  </span>
);

/** Artist(s) and, optionally, the album of a track, each one a link to its page */
const MetaLinks = ({ file, album = true, artist = true, fallback = 'Unknown artist' }) => {
  const { openArtist, openAlbum } = useContext(SongActions);
  const m = file?.metadata || {};
  const artists = splitArtists(m.artist).filter(a => a !== 'Unknown Artist');
  const parts = [];
  if (artist) {
    if (!artists.length) parts.push(<React.Fragment key="a">{fallback}</React.Fragment>);
    artists.forEach((a, i) => parts.push(
      <React.Fragment key={`a${i}`}>{i > 0 && ', '}{openArtist ? <Link onOpen={() => openArtist(a)}>{a}</Link> : a}</React.Fragment>,
    ));
  }
  if (album && m.album && m.album !== 'Unknown Album') {
    parts.push(
      <React.Fragment key="al">{parts.length > 0 && ' · '}{openAlbum ? <Link onOpen={() => openAlbum(m.album)}>{m.album}</Link> : m.album}</React.Fragment>,
    );
  }
  return <>{parts}</>;
};

export default MetaLinks;
