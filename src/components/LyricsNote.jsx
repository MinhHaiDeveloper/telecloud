import React, { useContext } from 'react';
import Icon from './Icon';
import SongActions from './songActions';
import { t } from '../i18n';

/** Under a lyrics panel: where unsaved lyrics came from (Save / Edit), or Search / Edit for the track */
const LyricsNote = ({ file }) => {
  const { lyricsFound, onEditLyrics, onSaveFound } = useContext(SongActions);
  if (!file || !onEditLyrics) return null;
  const found = lyricsFound && lyricsFound.path === file.path ? lyricsFound : null;
  if (found) {
    return (
      <div className="lyrics-note found">
        <span>{t('Found on {label} · not saved', { label: found.label })}</span>
        <button className="btn-ghost sm" onClick={() => onSaveFound?.()}><Icon name="check" />{t('Save')}</button>
        <button className="btn-ghost sm" onClick={() => onEditLyrics(file)}><Icon name="search" />{t('Other results')}</button>
      </div>
    );
  }
  const has = !!file.metadata?.lyrics;
  return (
    <div className="lyrics-note">
      <button className="btn-ghost sm" onClick={() => onEditLyrics(file)}>
        <Icon name={has ? 'lyrics' : 'search'} />{has ? t('Edit lyrics') : t('Search lyrics')}
      </button>
    </div>
  );
};

export default LyricsNote;
