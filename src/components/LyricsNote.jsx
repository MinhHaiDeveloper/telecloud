import React, { useContext } from 'react';
import Icon from './Icon';
import SongActions from './songActions';

/** Under a lyrics panel: where unsaved lyrics came from (Save / Edit), or Search / Edit for the track */
const LyricsNote = ({ file }) => {
  const { lyricsFound, onEditLyrics, onSaveFound } = useContext(SongActions);
  if (!file || !onEditLyrics) return null;
  const found = lyricsFound && lyricsFound.path === file.path ? lyricsFound : null;
  if (found) {
    return (
      <div className="lyrics-note found">
        <span>Found on {found.label} · not saved</span>
        <button className="btn-ghost sm" onClick={() => onSaveFound?.()}><Icon name="check" />Save</button>
        <button className="btn-ghost sm" onClick={() => onEditLyrics(file)}><Icon name="search" />Other results</button>
      </div>
    );
  }
  const has = !!file.metadata?.lyrics;
  return (
    <div className="lyrics-note">
      <button className="btn-ghost sm" onClick={() => onEditLyrics(file)}>
        <Icon name={has ? 'lyrics' : 'search'} />{has ? 'Edit lyrics' : 'Search lyrics'}
      </button>
    </div>
  );
};

export default LyricsNote;
