import React, { useState } from 'react';
import Cover from './Cover';
import Icon from './Icon';
import { qualityOf } from '../utils/audio';

/**
 * Tracks after the current one. Click a row to play it, drag rows to reorder.
 * Used by the player bar's queue, Up next in the right panel and the fullscreen queue.
 */
const QueueList = ({ files, onPlay, onMove, onRemove, limit, numbered = false, showQuality = false, className = '' }) => {
  const [drag, setDrag] = useState(null);   // index being dragged
  const [over, setOver] = useState(null);   // { index, after }
  const shown = limit ? files.slice(0, limit) : files;

  const drop = (e) => {
    e.preventDefault();
    if (drag !== null && over) {
      let to = over.after ? over.index + 1 : over.index;
      if (drag < to) to -= 1;
      if (to !== drag) onMove?.(drag, to);
    }
    setDrag(null);
    setOver(null);
  };

  return (
    <div className={`queue-list ${className}`} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}>
      {shown.map((f, i) => {
        const q = showQuality ? qualityOf(f) : null;
        const marker = over && over.index === i ? (over.after ? 'drop-after' : 'drop-before') : '';
        return (
          <div
            key={`${f.path}-${i}`}
            className={`mini q-row ${drag === i ? 'dragging' : ''} ${marker}`}
            role="button" tabIndex={0}
            draggable={!!onMove}
            onClick={() => onPlay?.(i)}
            onKeyDown={(e) => { if (e.key === 'Enter') onPlay?.(i); }}
            onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
            onDragOver={(e) => {
              if (drag === null) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > r.top + r.height / 2;
              if (!over || over.index !== i || over.after !== after) setOver({ index: i, after });
            }}
            onDrop={drop}
            onDragEnd={() => { setDrag(null); setOver(null); }}
          >
            {numbered && <span className="q-num mono">{i + 1}</span>}
            <Cover file={f} />
            <div className="meta"><b>{f.metadata?.title || f.name}</b><span>{f.metadata?.artist || 'Unknown artist'}</span></div>
            {q && <span className={`badge b-${q.tier} mono`}>{q.label}</span>}
            {onRemove && (
              <button className="icon-btn sm q-remove" onClick={(e) => { e.stopPropagation(); onRemove(i); }} title="Remove from queue"><Icon name="close" /></button>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default QueueList;
