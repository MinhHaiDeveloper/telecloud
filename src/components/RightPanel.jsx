import React from 'react';
import Icon from './Icon';
import MetaLinks from './MetaLinks';
import LyricsNote from './LyricsNote';
import Cover from './Cover';
import LyricsView from './LyricsView';
import SignalPathSteps from './SignalPathSteps';
import QueueList from './QueueList';

const RightPanel = ({
  currentFile, currentTime, onSeek, signal, eqEnabled, setEqEnabled, onOpenEq,
  lyricsCollapsed, onToggleLyrics, onExpandLyrics, onOpenNowPlaying, queueFiles = [], onPlayQueued, onMoveQueued,
}) => (
  <aside className="right">
    <div className="section-head"><span>Now playing</span></div>
    <button onClick={onOpenNowPlaying} disabled={!currentFile} title="Open now playing" style={{ display: 'block', width: '100%' }}>
      <Cover file={currentFile} className={`np-art ${currentFile ? 'clickable' : ''}`} key={currentFile?.path + (currentFile?.cache_path || '')} />
    </button>
    <div className="np-title">{currentFile?.metadata?.title || currentFile?.name || 'Nothing playing'}</div>
    <div className="np-artist">
      {currentFile ? <MetaLinks file={currentFile} /> : 'Pick a track from your library'}
    </div>

    {currentFile && signal && (
      <div className="card signal">
        <div className="signal-head">
          <b>Signal path</b>
          <span className={`badge ${signal.bitPerfect ? 'b-lossless' : 'b-cached'}`}>{signal.verdict}</span>
        </div>
        <SignalPathSteps signal={signal} eqEnabled={eqEnabled} setEqEnabled={setEqEnabled} onOpenEq={onOpenEq} />
      </div>
    )}

    <div className={`card lyrics-block ${lyricsCollapsed ? 'collapsed' : ''}`}>
      <div className="lyrics-bar">
        <b>Lyrics</b>
        <button className="icon-btn sm" onClick={onExpandLyrics} title="Expand lyrics" disabled={!currentFile}><Icon name="expand" /></button>
        <button className="icon-btn sm" onClick={onToggleLyrics} title={lyricsCollapsed ? 'Show lyrics' : 'Collapse lyrics'} aria-expanded={!lyricsCollapsed}>
          <Icon name="chevron" className="chev" />
        </button>
      </div>
      <div className="lyrics-body">
        <div>
          {currentFile
            ? <><LyricsView lyrics={currentFile.metadata?.lyrics} currentTime={currentTime} onSeek={onSeek} /><LyricsNote file={currentFile} /></>
            : <div className="lyrics-empty">Lyrics appear here while a track plays.</div>}
        </div>
      </div>
    </div>

    {queueFiles.length > 0 && (
      <>
        <div className="section-head"><span>Up next</span><span className="badge b-lossy">{queueFiles.length}</span></div>
        <QueueList className="mini-list" files={queueFiles} limit={5} onPlay={onPlayQueued} onMove={onMoveQueued} />
      </>
    )}
  </aside>
);

export default RightPanel;
