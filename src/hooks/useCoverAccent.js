import { useEffect } from 'react';
import { useAppearance } from '../utils/appearance';
import { applyCoverAccent, clearCoverAccent, coverColor } from '../utils/coverAccent';
import { coverUrl } from '../utils/audio';

/**
 * Settings > Appearance > Follow the cover: the accent takes the colour of the cover playing.
 * Must run after the effect that sets data-theme, because the result depends on the theme's colours.
 * The old colour stays until the new one is ready, so a track change doesn't flash the theme's accent.
 */
export default function useCoverAccent(file, theme) {
  const { followCover } = useAppearance();
  const path = file?.path;
  const revision = file ? coverUrl(file) : ''; // changes when the cover is replaced
  useEffect(() => {
    window.ipcRenderer.invoke('logs:appearance', { theme, followCover }).catch(() => {});
  }, [theme, followCover]);
  useEffect(() => {
    if (!followCover || !path) { clearCoverAccent(); return undefined; }
    let stale = false;
    coverColor(path, revision)
      .then((color) => { if (!stale) applyCoverAccent(color); })
      .catch((err) => { console.warn('[Appearance] Could not read the cover colour:', err.message); if (!stale) clearCoverAccent(); });
    return () => { stale = true; };
  }, [followCover, path, revision, theme]);
}
