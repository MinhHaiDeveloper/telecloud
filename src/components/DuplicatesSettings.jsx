import React, { useContext } from 'react';
import SongActions from './songActions';
import { SettingRow, Toggle } from './ui';
import { t } from '../i18n';

/** Settings → Library: skip extra copies of the same track, and a list of them to clean up */
const DuplicatesSettings = () => {
  const { duplicates, skipDuplicates, setSkipDuplicates, openDuplicates } = useContext(SongActions);
  const n = duplicates?.size || 0;
  return (
    <section className="set-section">
      <h3>{t('Duplicates')}</h3>
      <div className="card set-card">
        <SettingRow icon="queue" title={t('Skip duplicate tracks')} desc={t('The same track in two folders (same title, album, track number and length) plays and counts once, using the best copy. Library still lists every file and marks the extra ones. Your files are not touched.')}>
          <Toggle checked={skipDuplicates} onChange={setSkipDuplicates} />
        </SettingRow>
        <SettingRow icon="library" title={n ? t('{n} extra {n2|copy|copies} found', { n: n.toLocaleString(), n2: n }) : t('No duplicates found')} desc={t('See them in a list, and delete the ones you don\'t need.')}>
          <button className="btn-ghost" onClick={openDuplicates} disabled={!n}>{t('Show')}</button>
        </SettingRow>
      </div>
    </section>
  );
};

export default DuplicatesSettings;
