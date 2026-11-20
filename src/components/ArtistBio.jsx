import React, { useContext, useEffect, useState } from 'react';
import SongActions from './songActions';
import { t } from '../i18n';

const LABEL = { lastfm: 'Last.fm', qq: 'QQ Music' };

/**
 * Artist page: a short biography. Last.fm's (English, with tags, listeners and similar artists) when it says
 * enough, QQ Music's (Chinese, strongest for Asian artists) otherwise; a switch when both have one.
 */
const ArtistBio = ({ name, known }) => {
  const { openArtist } = useContext(SongActions);
  const [bio, setBio] = useState(null);
  const [from, setFrom] = useState(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let alive = true;
    setBio(null); setFrom(null); setMore(false);
    window.ipcRenderer.invoke('artist:bio', name).then(r => {
      if (!alive || !r?.success || !r.primary) return;
      setBio(r); setFrom(r.primary);
    }).catch(() => {});
    return () => { alive = false; };
  }, [name]);
  const info = bio && from ? bio[from] : null;
  if (!info) return null;
  const both = !!(bio.lastfm && bio.qq);
  const text = more && info.content ? info.content : info.summary;
  const lf = from === 'lastfm';
  return (
    <div className="card artist-bio" data-source={from}>
      <div className="bio-head">
        <b>{t('About {name}', { name: info.name })}</b>
        {lf && info.listeners ? <span>{t('{listeners} listeners on Last.fm', { listeners: info.listeners.toLocaleString() })}</span> : null}
        {!lf && <span>{t('From QQ Music, in Chinese')}</span>}
        {both && (
          <div className="bio-switch" role="tablist" aria-label={t('Biography from')}>
            {['lastfm', 'qq'].map(k => <button key={k} role="tab" aria-selected={from === k} className={from === k ? 'on' : ''} onClick={() => { setFrom(k); setMore(false); }}>{LABEL[k]}</button>)}
          </div>
        )}
      </div>
      <p className={more ? '' : 'clamp'} lang={info.lang || 'en'}>{text}</p>
      <div className="bio-foot">
        {info.content && info.content.length > (info.summary || '').length + 20 && <button className="btn-ghost sm" onClick={() => setMore(m => !m)}>{more ? t('Less') : t('Read more')}</button>}
        {lf && (info.tags || []).map(t => <span key={t} className="badge b-local">{t}</span>)}
        {info.url && <button className="bio-link" onClick={() => window.ipcRenderer.invoke('open-external', info.url)}>{LABEL[from]}</button>}
      </div>
      {lf && info.similar?.length > 0 && (
        <div className="bio-similar">
          <span>{t('Similar:')}</span>
          {info.similar.map(s => (known?.has(s)
            ? <span key={s} className="meta-link" role="link" tabIndex={0} onClick={() => openArtist?.(s)}>{s}</span>
            : <span key={s} className="muted">{s}</span>))}
        </div>
      )}
    </div>
  );
};

export default ArtistBio;
