import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useContext } from 'react';
import SongActions from './songActions';
import Icon from './Icon';
import MetaLinks from './MetaLinks';
import LyricsNote from './LyricsNote';
import Cover from './Cover';
import LyricsView, { parseLyrics } from './LyricsView';
import QueueList from './QueueList';
import { formatTime, qualityOf, formatBytes } from '../utils/audio';

// Small artworks the big cover can fly from / back to
const ORIGINS = {
  player: '.player .cover-btn .cover',
  panel: '.right .np-art',
};
const OPEN_MS = 480;
const CLOSE_MS = 420;
const EASE = 'cubic-bezier(.2, .8, .2, 1)';

const visibleEl = (selector) => {
  const el = selector && document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4 ? el : null;
};

/** Rect of `el` once the player has left compact mode (measured with transitions paused). */
function settledRect(el) {
  const app = document.querySelector('.app');
  if (!app || !app.classList.contains('np-mode')) return el.getBoundingClientRect();
  const moving = [document.querySelector('.player'), document.querySelector('.p-track')].filter(Boolean);
  moving.forEach(m => { m.style.transition = 'none'; });
  app.classList.remove('np-mode');
  const rect = el.getBoundingClientRect();
  app.classList.add('np-mode');
  void app.offsetWidth; // commit the restored state before transitions come back
  moving.forEach(m => { m.style.transition = ''; });
  return rect;
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Fly a copy of the big cover between its own box and a small artwork elsewhere on screen.
 * The copy lives in <body> (fixed, on top) so the player bar can't cover or clip it.
 * Both endpoints stay hidden during the flight, which sells the "same artwork" illusion.
 */
function flyCover(big, small, direction, toRect) {
  const from = big.getBoundingClientRect();
  const to = toRect || small.getBoundingClientRect();
  // On narrow windows the lyrics panel can hide the big cover entirely; just fade then
  if (from.width < 8 || to.width < 8) return Promise.resolve();
  const ghost = big.cloneNode(false);
  // Use whichever end already has the picture decoded; otherwise the placeholder
  const loaded = [small, big].map(el => el.querySelector('img')).find(i => i && i.complete && i.naturalWidth > 0);
  if (loaded) {
    const img = document.createElement('img');
    img.src = loaded.currentSrc || loaded.src;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    ghost.appendChild(img);
  } else {
    const fallback = small.querySelector('.cover-fallback') || big.querySelector('.cover-fallback');
    if (fallback) ghost.appendChild(fallback.cloneNode(true));
  }
  const bigRadius = parseFloat(getComputedStyle(big).borderRadius) || 22;
  // Only `transform` is animated so the GPU compositor runs the flight on its own; a busy
  // main thread (mounting the view, the player morphing) can't make it stutter.
  Object.assign(ghost.style, {
    position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    margin: '0', zIndex: '3000', pointerEvents: 'none', transformOrigin: '0 0', transition: 'none', opacity: '1',
    borderRadius: `${bigRadius}px`, boxShadow: '0 24px 60px rgba(0,0,0,.4)', willChange: 'transform', overflow: 'hidden',
  });
  document.body.appendChild(ghost);

  const scale = to.width / from.width;
  const shrunk = { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scale})` };
  const full = { transform: 'translate(0px, 0px) scale(1)' };

  big.style.opacity = '0';
  small.style.visibility = 'hidden';
  const anim = ghost.animate(direction === 'open' ? [shrunk, full] : [full, shrunk], {
    duration: direction === 'open' ? OPEN_MS : CLOSE_MS,
    easing: EASE,
    fill: 'forwards',
  });
  const cleanup = () => {
    ghost.remove();
    small.style.visibility = '';
    if (direction === 'open') big.style.opacity = '';
  };
  return anim.finished.then(cleanup, cleanup);
}

/**
 * Full-window "now playing". Big artwork in the middle; the Lyrics / Queue buttons open a
 * side panel (50/50). With no panel open, the art is centred with details about the track.
 */
const NowPlayingFullscreen = ({ currentFile, currentTime, onSeek, signal, queueFiles = [], onPlayQueued, onMoveQueued, onRemoveQueued, initialPanel, origin = 'player', closeRequested, onClosingStart, onClose }) => {
  const hasLyrics = !!parseLyrics(currentFile?.metadata?.lyrics).lines.length;
  const [panel, setPanel] = useState(initialPanel !== undefined ? initialPanel : (hasLyrics ? 'lyrics' : null));
  const [phase, setPhase] = useState('entering'); // entering → open → leaving
  const rootRef = useRef(null);
  const { playCounts } = useContext(SongActions);
  const closingRef = useRef(false);
  // Cover only: everything else (top bar, text, panels, the player bar) fades away
  const [coverOnly, setCoverOnly] = useState(false);
  const [peek, setPeek] = useState(false); // the "show all" button while the mouse moves
  useEffect(() => {
    document.documentElement.classList.toggle('np-cover-only', coverOnly);
    return () => document.documentElement.classList.remove('np-cover-only');
  }, [coverOnly]);
  useEffect(() => {
    if (!coverOnly) return undefined;
    let t = null;
    const move = () => { setPeek(true); clearTimeout(t); t = setTimeout(() => setPeek(false), 1800); };
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mousemove', move); clearTimeout(t); setPeek(false); };
  }, [coverOnly]);

  // Opening: the big cover grows out of the small artwork that was clicked
  useLayoutEffect(() => {
    const big = rootRef.current?.querySelector('.np-cover');
    const small = visibleEl(ORIGINS[origin]) || visibleEl(ORIGINS.player);
    if (!big || !small || reducedMotion()) { setPhase('open'); return; }
    flyCover(big, small, 'open').then(() => setPhase('open'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing: shrink back into the artwork it came from (or the player bar's)
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setPhase('leaving');
    const big = rootRef.current?.querySelector('.np-cover');
    const small = visibleEl(ORIGINS[origin]) || visibleEl(ORIGINS.player);
    // The player is about to grow back from its compact form, so measure where its mini
    // cover will end up (not where it is now) and let both animations run together
    const toRect = small && small.closest('.player') ? settledRect(small) : null;
    onClosingStart?.();
    if (!big || !small || reducedMotion()) { onClose(); return; }
    flyCover(big, small, 'close', toRect).then(onClose);
  }, [origin, onClose, onClosingStart]);

  // The player bar's artwork toggles the view too; App asks us to close with the animation
  useEffect(() => { if (closeRequested) requestClose(); }, [closeRequested, requestClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { if (document.documentElement.classList.contains('np-cover-only')) setCoverOnly(false); else requestClose(); return; }
      if (e.target.tagName === 'INPUT' || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'h') setCoverOnly(v => !v);
      if (e.key.toLowerCase() === 'l') setPanel(p => (p === 'lyrics' ? null : 'lyrics'));
      if (e.key.toLowerCase() === 'q') setPanel(p => (p === 'queue' ? null : 'queue'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const m = currentFile?.metadata || {};
  const q = currentFile ? qualityOf(currentFile) : null;
  const toggle = (name) => setPanel(p => (p === name ? null : name));
  const details = [
    m.year && { label: 'Year', value: m.year },
    m.genre && { label: 'Genre', value: m.genre },
    m.track ? { label: 'Track', value: m.disc > 1 ? `${m.disc}-${m.track}` : m.track } : null,
    m.duration && { label: 'Length', value: formatTime(m.duration) },
    { label: 'Plays', value: (playCounts || {})[currentFile?.path] || 0 },
    m.bitrate && { label: 'Bitrate', value: `${Math.round(m.bitrate / 1000).toLocaleString()} kbps` },
    currentFile?.size && { label: 'Size', value: formatBytes(currentFile.size) },
  ].filter(Boolean);

  return (
    <section ref={rootRef} className={`np-full ${panel ? 'with-panel' : ''} np-${phase} ${coverOnly ? 'cover-only' : ''}`} aria-label="Now playing">
      {coverOnly && (
        <button className={`np-reveal ${peek ? 'show' : ''}`} onClick={() => setCoverOnly(false)} title="Show everything (H or Esc)">
          <Icon name="eye" />
        </button>
      )}
      <div className="np-backdrop">
        <Cover file={currentFile} className="np-bg" key={`bg-${currentFile?.path}`} />
      </div>

      <header className="np-top np-fade">
        <button className="icon-btn" onClick={requestClose} title="Close (Esc)"><Icon name="chevron" /></button>
        <div className="np-top-title">
          <span className="eyebrow" style={{ margin: 0 }}>Now playing</span>
          <b>{m.album || 'Unknown album'}</b>
        </div>
        <div className="np-top-actions">
          <button className="np-pill icon-only" onClick={() => setCoverOnly(true)} title="Cover only (H)">
            <Icon name="eyeOff" />
          </button>
          <button className={`np-pill ${panel === 'lyrics' ? 'on' : ''}`} onClick={() => toggle('lyrics')} title="Lyrics (L)">
            <Icon name="lyrics" />Lyrics
          </button>
          <button className={`np-pill ${panel === 'queue' ? 'on' : ''}`} onClick={() => toggle('queue')} title="Queue (Q)">
            <Icon name="queue" />Queue{queueFiles.length ? <span className="np-count">{queueFiles.length}</span> : null}
          </button>
        </div>
      </header>

      <div className="np-body">
        <div className="np-hero">
          <Cover file={currentFile} className="np-cover" key={`c-${currentFile?.path}`} />
          <div className="np-info np-fade">
            <h1 title={m.title || currentFile?.name}>{m.title || currentFile?.name || 'Nothing playing'}</h1>
            <div className="np-sub"><MetaLinks file={currentFile} /></div>
            {currentFile && (
              <div className="np-badges">
                <span className={`badge b-${q.tier} mono`}>{q.label}</span>
                {signal && <span className={`badge ${signal.bitPerfect ? 'b-lossless' : 'b-cached'}`}>{signal.verdict}</span>}
                {signal?.outSpec && <span className="badge b-lossy mono">out {signal.outSpec}</span>}
              </div>
            )}
            {!panel && details.length > 0 && (
              <dl className="np-details">
                {details.map(d => <div key={d.label}><dt>{d.label}</dt><dd className="mono">{d.value}</dd></div>)}
              </dl>
            )}
          </div>
        </div>

        <div className="np-panel np-fade">
          <div className="np-panel-inner">
            {panel === 'lyrics' && (hasLyrics
              ? <><LyricsView lyrics={m.lyrics} currentTime={currentTime} onSeek={onSeek} className="np-lyrics" /><LyricsNote file={currentFile} /></>
              : (
                <div className="np-empty">
                  <Icon name="lyrics" />
                  No lyrics for this track
                  <small>Search the lyrics sources, or type them in.</small>
                  <LyricsNote file={currentFile} />
                </div>
              ))}
            {panel === 'queue' && (
              <div className="np-queue">
                {queueFiles.length > 0 && <div className="section-head" style={{ margin: '0 8px 8px' }}><span>Up next</span><span className="badge b-lossy">{queueFiles.length}</span></div>}
                {queueFiles.length === 0 && (
                  <div className="np-empty">
                    <Icon name="queue" />
                    Nothing queued after this track
                    <small>Play an album, playlist or the library to fill the queue.</small>
                  </div>
                )}
                {queueFiles.length > 0 && <QueueList files={queueFiles} numbered showQuality onPlay={onPlayQueued} onMove={onMoveQueued} onRemove={onRemoveQueued} />}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default NowPlayingFullscreen;
