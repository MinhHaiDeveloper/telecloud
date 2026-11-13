import React, { useContext } from 'react';
import SongActions from './songActions';
import { SettingRow, Toggle } from './ui';

/** Settings → Playback: what happens when an album ends */
const ContinueSettings = () => {
  const { autoContinue, setAutoContinue } = useContext(SongActions);
  return (
    <section className="set-section">
      <h3>When an album ends</h3>
      <div className="card set-card">
        <SettingRow icon="queue" title="Keep playing another album" desc="The artist's next album by year plays after it, or else the album beside it in Albums, in the order chosen there. It joins Up next as the last track starts, so there is no gap. Playlists and single tracks stop at the end as before.">
          <Toggle checked={autoContinue !== false} onChange={setAutoContinue} />
        </SettingRow>
      </div>
    </section>
  );
};

export default ContinueSettings;
