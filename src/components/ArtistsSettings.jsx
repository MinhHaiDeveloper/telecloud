import React, { useContext } from 'react';
import SongActions from './songActions';
import { SettingRow, Toggle } from './ui';

/** Settings → Library: who shows on the Artists page */
const ArtistsSettings = () => {
  const { onlyAlbumArtists, setOnlyAlbumArtists } = useContext(SongActions);
  return (
    <section className="set-section">
      <h3>Artists</h3>
      <div className="card set-card">
        <SettingRow icon="user" title="Only show album artists" desc="Keep the Artists page to people who have their own albums. Guests on a single track stay reachable from that track.">
          <Toggle checked={!!onlyAlbumArtists} onChange={setOnlyAlbumArtists} />
        </SettingRow>
      </div>
    </section>
  );
};

export default ArtistsSettings;
