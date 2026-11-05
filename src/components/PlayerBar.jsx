import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icon';
import MetaLinks from './MetaLinks';
import Cover from './Cover';
import SignalPathSteps from './SignalPathSteps';
import QueueList from './QueueList';
import { formatTime } from '../utils/audio';

// Closes a popover when clicking anywhere outside `ref`
const useOutside = (open, ref, onClose) => {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, ref, onClose]);
};

const PlayerBar = ({
  currentFile, isPlaying, currentTime, onSeek, onTogglePlay, onNext, onPrev,
  volume, onVolumeChange, muted, onToggleMute, selectedDevice,
  loopMode, onToggleLoop, isShuffle, onToggleShuffle,
  isQueueOpen, onToggleQueue, queueFiles = [], onClearQueue, onRemoveFromQueue, onSaveQueueAsPlaylist, onPlayQueued, onMoveQueued,
  onToggleFavorite, isFavorite, eqEnabled, setEqEnabled, onOpenEq, signal, onOpenNowPlaying, stream,
}) => {
  const [signalOpen, setSignalOpen] = useState(false);
  const [favPop, setFavPop] = useState(0);
  const rightRef = useRef(null);
  const exclusive = selectedDevice && selectedDevice !== '-1';

  useOutside(signalOpen, rightRef, () => setSignalOpen(false));
  useOutside(isQueueOpen, rightRef, () => isQueueOpen && onToggleQueue());

  const duration = currentFile?.metadata?.duration || 0;
  const pct = duration ? Math.min(100, (currentTime / duration) * 100) : 0;

  // The player reports the position ~4 times a second; between reports the seek bar keeps moving
  // on its own every frame (no React render), so it glides at any refresh rate (60, 144, 180 Hz…)
  const seekRef = useRef(null);
  const seeking = useRef(false);
  const clock = useRef({ t: 0, at: 0 });
  useEffect(() => { clock.current = { t: currentTime || 0, at: performance.now() }; }, [currentTime]);
  useEffect(() => {
    if (!isPlaying || !duration) return undefined;
    let raf = 0;
    const frame = () => {
      const el = seekRef.current;
      if (el && !seeking.current) {
        const c = clock.current;
        // never run more than half a second ahead of the last report (a stall or a slow stream)
        const t = Math.min(duration, c.t + Math.min(0.5, (performance.now() - c.at) / 1000));
        el.value = String(t);
        el.style.setProperty('--pct', `${(t / duration) * 100}%`);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, duration]);
  // TeleCloud stream: what is already downloaded, drawn behind the played part
  const buffer = stream && !stream.complete && stream.ranges?.length
    ? `linear-gradient(to right, ${stream.ranges.map(([a, b]) => `transparent ${a * 100}%, var(--buffered) ${a * 100}% ${b * 100}%, transparent ${b * 100}%`).join(', ')})`
    : null;

  return (
    <footer className="player">
      <div className="p-track">
        <button className="cover-btn" onClick={onOpenNowPlaying} disabled={!currentFile} title="Open now playing" style={{ borderRadius: 8 }}>
          <Cover file={currentFile} className={currentFile ? 'clickable' : ''} key={currentFile?.path + (currentFile?.cache_path || '')} />
        </button>
        <div className="meta">
          <b>{currentFile?.metadata?.title || currentFile?.name || 'Nothing playing'}</b>
          <span>{currentFile ? <MetaLinks file={currentFile} /> : 'Pick a track to start'}</span>
        </div>
        {currentFile && (
          <button
            className={`icon-btn sm ${isFavorite ? 'on' : ''} ${favPop ? 'pop' : ''}`}
            key={favPop}
            onClick={() => { onToggleFavorite(currentFile); setFavPop(n => n + 1); }}
            title={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
          >
            <Icon name="heart" filled={isFavorite} />
          </button>
        )}
      </div>

      <div className="p-center">
        <div className="p-controls">
          <button className={`icon-btn ${isShuffle ? 'on' : ''}`} onClick={onToggleShuffle} title="Shuffle"><Icon name="shuffle" /></button>
          <button className="icon-btn" onClick={onPrev} title="Previous" disabled={!currentFile}><Icon name="prev" /></button>
          <button className="play-btn" onClick={onTogglePlay} title={isPlaying ? 'Pause' : 'Play'} disabled={!currentFile}>
            <Icon name={isPlaying ? 'pause' : 'play'} />
          </button>
          <button className="icon-btn" onClick={onNext} title="Next" disabled={!currentFile}><Icon name="next" /></button>
          <button className={`icon-btn ${loopMode !== 'none' ? 'on' : ''}`} onClick={onToggleLoop} title={`Repeat: ${loopMode}`}>
            <Icon name="repeat" />{loopMode === 'one' && <span className="one">1</span>}
          </button>
        </div>
        <div className="p-seek">
          <span className="mono">{formatTime(currentTime)}</span>
          <input
            ref={seekRef}
            type="range" className={`range ${buffer ? 'buffered' : ''}`} min="0" max={duration || 100} step="any"
            value={Math.min(currentTime || 0, duration || 100)}
            style={{ '--pct': `${pct}%`, ...(buffer ? { '--buffer': buffer } : {}) }}
            onPointerDown={() => { seeking.current = true; }}
            onPointerUp={() => { seeking.current = false; }}
            onPointerCancel={() => { seeking.current = false; }}
            onChange={(e) => onSeek && onSeek(Math.floor(parseFloat(e.target.value) * 10) / 10)}
            disabled={!currentFile}
            aria-label="Seek"
          />
          <span className="mono">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="p-right" ref={rightRef}>
        {signalOpen && signal && (
          <div className="card popover">
            <h4>{signal.verdict}</h4>
            <p>{signal.bitPerfect
              ? 'Nothing between the file and your DAC changes the samples.'
              : 'Orange steps alter or may alter the samples before they reach your DAC.'}</p>
            <SignalPathSteps signal={signal} eqEnabled={eqEnabled} setEqEnabled={setEqEnabled} onOpenEq={() => { setSignalOpen(false); onOpenEq(); }} />
          </div>
        )}
        {isQueueOpen && (
          <div className="card popover queue-pop">
            <div className="q-head"><b>Up next</b><span className="badge b-lossy">{queueFiles.length}</span></div>
            <div className="q-list">
              {queueFiles.length
                ? <QueueList files={queueFiles} onPlay={onPlayQueued} onMove={onMoveQueued} onRemove={onRemoveFromQueue} />
                : <div className="empty">Queue is empty.</div>}
            </div>
            {queueFiles.length > 1 && <div className="q-hint">Click to play · drag to reorder</div>}
            <div className="q-foot">
              <button className="btn-ghost" onClick={onClearQueue}>Clear</button>
              <button className="btn-primary" onClick={onSaveQueueAsPlaylist}>Save as playlist</button>
            </div>
          </div>
        )}

        {currentFile && signal && (
          <button className={`fmt-pill ${signal.quality.tier === 'lossy' ? 'plain' : ''}`} onClick={() => { setSignalOpen(o => !o); if (isQueueOpen) onToggleQueue(); }} title="Signal path">
            <span className={`bp ${signal.bitPerfect ? '' : 'off'}`} />
            <span className="mono">{signal.quality.label}</span>
          </button>
        )}
        <button className={`icon-btn hide-sm np-hide ${eqEnabled ? 'on' : ''}`} onClick={onOpenEq} title="Equalizer"><Icon name="eq" /></button>
        <button className={`icon-btn hide-sm ${muted ? 'on' : ''}`} onClick={onToggleMute} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
          <Icon name={muted || (volume === 0 && !exclusive) ? 'mute' : 'volume'} />
        </button>
        <input
          type="range" className={`range vol hide-sm ${muted ? 'muted' : ''}`} min="0" max="100"
          value={exclusive ? 100 : volume}
          style={{ '--pct': `${exclusive ? 100 : volume}%` }}
          onChange={(e) => onVolumeChange(parseInt(e.target.value, 10))}
          disabled={exclusive}
          title={exclusive ? 'Volume is bypassed in exclusive mode' : `Volume ${volume}%`}
          aria-label="Volume"
        />
        <button className={`icon-btn np-hide ${isQueueOpen ? 'on' : ''}`} onClick={() => { onToggleQueue(); setSignalOpen(false); }} title="Queue"><Icon name="queue" /></button>
      </div>
    </footer>
  );
};

export default PlayerBar;
