import React, { useContext, useEffect, useState } from 'react';
import SongActions from './songActions';

/** Artist page: short biography, tags and similar artists from Last.fm (when available) */
const ArtistBio = ({ name, known }) => {
  const { openArtist } = useContext(SongActions);
  const [info, setInfo] = useState(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    setMore(false);
    window.ipcRenderer.invoke('lastfm:artist', name).then(r => { if (alive && r?.success && r.info?.summary) setInfo(r.info); }).catch(() => {});
    return () => { alive = false; };
  }, [name]);
  if (!info) return null;
  const text = more && info.content ? info.content : info.summary;
  return (
    <div className="card artist-bio">
      <div className="bio-head">
        <b>About {info.name}</b>
        {info.listeners ? <span>{info.listeners.toLocaleString()} listeners on Last.fm</span> : null}
      </div>
      <p className={more ? '' : 'clamp'}>{text}</p>
      <div className="bio-foot">
        {info.content && info.content.length > info.summary.length + 20 && <button className="btn-ghost sm" onClick={() => setMore(m => !m)}>{more ? 'Less' : 'Read more'}</button>}
        {info.tags.map(t => <span key={t} className="badge b-local">{t}</span>)}
        {info.url && <button className="bio-link" onClick={() => window.ipcRenderer.invoke('open-external', info.url)}>Last.fm</button>}
      </div>
      {info.similar.length > 0 && (
        <div className="bio-similar">
          <span>Similar:</span>
          {info.similar.map(s => (known?.has(s)
            ? <span key={s} className="meta-link" role="link" tabIndex={0} onClick={() => openArtist?.(s)}>{s}</span>
            : <span key={s} className="muted">{s}</span>))}
        </div>
      )}
    </div>
  );
};

export default ArtistBio;
