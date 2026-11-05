import React, { useContext } from 'react';
import SongActions from './songActions';
import { SettingRow, Toggle } from './ui';

/** Settings → Library: skip extra copies of the same track, and a list of them to clean up */
const DuplicatesSettings = () => {
  const { duplicates, skipDuplicates, setSkipDuplicates, openDuplicates } = useContext(SongActions);
  const n = duplicates?.size || 0;
  return (
    <section className="set-section">
      <h3>Duplicates</h3>
      <div className="card set-card">
        <SettingRow icon="queue" title="Skip duplicate tracks" desc="The same track in two folders (same title, album, track number and length) plays and counts once, using the best copy. Library still lists every file and marks the extra ones. Your files are not touched.">
          <Toggle checked={skipDuplicates} onChange={setSkipDuplicates} />
        </SettingRow>
        <SettingRow icon="library" title={n ? `${n.toLocaleString()} extra ${n === 1 ? 'copy' : 'copies'} found` : 'No duplicates found'} desc="See them in a list, and delete the ones you don't need.">
          <button className="btn-ghost" onClick={openDuplicates} disabled={!n}>Show</button>
        </SettingRow>
      </div>
    </section>
  );
};

export default DuplicatesSettings;
