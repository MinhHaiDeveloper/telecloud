import React from 'react';
import Icon from './Icon';
import MetaLinks from './MetaLinks';
import LyricsNote from './LyricsNote';
import CoverNote from './CoverNote';
import Cover from './Cover';
import LiquidCover from './LiquidCover';
import LyricsView from './LyricsView';
import SignalPathSteps from './SignalPathSteps';
import QueueList from './QueueList';
import { useAppearance } from '../utils/appearance';
import { t } from '../i18n';

const RightPanel = ({
  currentFile, currentTime, playing = true, onSeek, onHide, floatOpen, onFloatLyrics, signal, eqEnabled, setEqEnabled, onOpenEq,
  lyricsCollapsed, onToggleLyrics, onExpandLyrics, onOpenNowPlaying, queueFiles = [], onPlayQueued, onMoveQueued,
}) => {
  const look = useAppearance();
  return (
  <aside className="right">
    <div className="section-head"><span>{t('Now playing')}</span>{onHide && <button className="icon-btn sm panel-hide" onClick={onHide} title={t('Hide the side panel')} aria-label={t('Hide the side panel')}><Icon name="panel" /></button>}</div>
    <button onClick={onOpenNowPlaying} disabled={!currentFile} title={t('Open now playing')} style={{ display: 'block', width: '100%' }}>
      <LiquidCover file={currentFile} className={`np-art ${currentFile ? 'clickable' : ''}`} coverKey={currentFile?.path + (currentFile?.cache_path || '')} />
    </button>
    <div className="np-title">{currentFile?.metadata?.title || currentFile?.name || t('Nothing playing')}</div>
    <div className="np-artist">
      {currentFile ? <MetaLinks file={currentFile} /> : t('Pick a track from your library')}
    </div>
    <CoverNote file={currentFile} />

    {currentFile && signal && look.signalPath !== 'off' && (
      <div className={`card signal ${look.signalPath === 'compact' ? 'compact' : ''}`}>
        <div className="signal-head">
          <b>{t('Signal path')}</b>
          <span className={`badge ${signal.bitPerfect ? 'b-lossless' : 'b-cached'}`}>{signal.verdict}</span>
        </div>
        {look.signalPath === 'full' && <SignalPathSteps signal={signal} eqEnabled={eqEnabled} setEqEnabled={setEqEnabled} onOpenEq={onOpenEq} />}
      </div>
    )}

    <div className={`card lyrics-block ${lyricsCollapsed ? 'collapsed' : ''}`}>
      <div className="lyrics-bar">
        <b>{t('Lyrics')}</b>
        {onFloatLyrics && <button className={`icon-btn sm ${floatOpen ? 'on' : ''}`} onClick={onFloatLyrics} title={floatOpen ? t('Close the floating lyrics') : t('Floating lyrics, over every window')} aria-pressed={!!floatOpen}><Icon name="pip" /></button>}
        <button className="icon-btn sm" onClick={onExpandLyrics} title={t('Expand lyrics')} disabled={!currentFile}><Icon name="expand" /></button>
        <button className="icon-btn sm" onClick={onToggleLyrics} title={lyricsCollapsed ? t('Show lyrics') : t('Collapse lyrics')} aria-expanded={!lyricsCollapsed}>
          <Icon name="chevron" className="chev" />
        </button>
      </div>
      <div className="lyrics-body">
        <div>
          {currentFile
            ? <><LyricsView lyrics={currentFile.metadata?.lyrics} currentTime={currentTime} playing={playing} onSeek={onSeek} /><LyricsNote file={currentFile} /></>
            : <div className="lyrics-empty">{t('Lyrics appear here while a track plays.')}</div>}
        </div>
      </div>
    </div>

    {queueFiles.length > 0 && (
      <>
        <div className="section-head"><span>{t('Up next')}</span><span className="badge b-lossy">{queueFiles.length}</span></div>
        <QueueList className="mini-list" files={queueFiles} limit={5} onPlay={onPlayQueued} onMove={onMoveQueued} />
      </>
    )}
  </aside>
  );
};

export default RightPanel;
