import { useEffect } from 'react';
import { useAppearance } from '../utils/appearance';
import { applyCoverAccent, clearCoverAccent, coverColor } from '../utils/coverAccent';
import { coverUrl } from '../utils/audio';

/**
 * Settings > Appearance > Follow the cover: the accent takes the colour of the cover playing.
 * Must run after the effect that sets data-theme, because the result depends on the theme's colours.
 * The old colour stays until the new one is ready, so a track change doesn't flash the theme's accent.
 */
// whether the liquid cover change can be drawn here (WebGL), asked once, for the log
let webgl = null;
const hasWebgl = () => { if (webgl === null) { try { const g = document.createElement('canvas').getContext('webgl'); webgl = !!g; g?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { webgl = false; } } return webgl; };

export default function useCoverAccent(file, theme, sidePanel = true) {
  const { followCover, reduceMotion, waveSeek } = useAppearance();
  const path = file?.path;
  const revision = file ? coverUrl(file) : ''; // changes when the cover is replaced
  useEffect(() => {
    const coverAnimation = reduceMotion ? 'off' : hasWebgl() ? 'webgl' : 'none';
    window.ipcRenderer.invoke('logs:appearance', { theme, followCover, reduceMotion, waveSeek, sidePanel, coverAnimation }).catch(() => {});
  }, [theme, followCover, reduceMotion, waveSeek, sidePanel]);
  useEffect(() => {
    if (!followCover || !path) { clearCoverAccent(); return undefined; }
    let stale = false;
    coverColor(path, revision)
      .then((color) => { if (!stale) applyCoverAccent(color); })
      .catch((err) => { console.warn('[Appearance] Could not read the cover colour:', err.message); if (!stale) clearCoverAccent(); });
    return () => { stale = true; };
  }, [followCover, path, revision, theme]);
}
