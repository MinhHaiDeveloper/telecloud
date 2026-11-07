import React, { useEffect, useState } from 'react';
import Cover from './Cover';
import { artistImageUrl } from '../utils/audio';

/** An artist's own picture; until they have one, the cover of one of their tracks */
const ArtistPicture = ({ name, file, preview, className = '' }) => {
  const [, refresh] = useState(0);
  const url = preview || artistImageUrl(name);
  const [failed, setFailed] = useState(null); // the address that couldn't be shown
  useEffect(() => {
    const on = (e) => { if (!e.detail || e.detail === name) { setFailed(null); refresh(n => n + 1); } };
    window.addEventListener('telecloud:artists', on);
    return () => window.removeEventListener('telecloud:artists', on);
  }, [name]);
  if (failed === url) return <Cover file={file} className={className} />;
  return (
    <div className={`cover ${className}`}>
      <img src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(url)} />
    </div>
  );
};

export default ArtistPicture;
