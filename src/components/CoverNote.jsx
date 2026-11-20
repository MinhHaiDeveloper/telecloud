import React, { useContext } from 'react';
import Icon from './Icon';
import SongActions from './songActions';
import { t } from '../i18n';

/** Under the cover: a cover found online for the playing album, shown before it is saved */
const CoverNote = ({ file }) => {
  const { coverFound, onEditCover, onSaveCoverFound } = useContext(SongActions);
  if (!file || !coverFound || !coverFound.paths.includes(file.path)) return null;
  return (
    <div className="lyrics-note found cover-note">
      <span>{t('Cover from {label} · not saved', { label: coverFound.label })}</span>
      <button className="btn-ghost sm" onClick={() => onSaveCoverFound?.()}><Icon name="check" />{t('Save')}</button>
      <button className="btn-ghost sm" onClick={() => onEditCover?.([file])}><Icon name="search" />{t('Other results')}</button>
    </div>
  );
};

export default CoverNote;
