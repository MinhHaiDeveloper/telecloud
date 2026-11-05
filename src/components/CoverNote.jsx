import React, { useContext } from 'react';
import Icon from './Icon';
import SongActions from './songActions';

/** Under the cover: a cover found online for the playing album, shown before it is saved */
const CoverNote = ({ file }) => {
  const { coverFound, onEditCover, onSaveCoverFound } = useContext(SongActions);
  if (!file || !coverFound || !coverFound.paths.includes(file.path)) return null;
  return (
    <div className="lyrics-note found cover-note">
      <span>Cover from {coverFound.label} · not saved</span>
      <button className="btn-ghost sm" onClick={() => onSaveCoverFound?.()}><Icon name="check" />Save</button>
      <button className="btn-ghost sm" onClick={() => onEditCover?.([file])}><Icon name="search" />Other results</button>
    </div>
  );
};

export default CoverNote;
