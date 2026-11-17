import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Cover from './Cover';
import { coverUrl } from '../utils/audio';
import { motionOff, warm, warmCanvases, beginChange, runningChange, playCoverChange } from '../utils/liquid';

// A cover that floods into the next one when the album changes: a growing circle with a wobbling rim,
// rings running through both pictures and the colours splitting at the rim, like paint dropped in water.
// Within one album, or with Reduce motion, it just swaps. Every place showing the cover keeps to one clock,
// so Now Playing opened half-way through picks the change up where it is.

const albumOf = (f) => {
  if (!f) return '';
  const m = f.metadata || {};
  const album = (m.album || '').trim().toLowerCase();
  if (!album || album === 'unknown album') return `dir:${(f.path || '').replace(/[\\/][^\\/]*$/, '').toLowerCase()}`;
  return `${album}|${(m.albumArtist || m.artist || '').trim().toLowerCase()}`;
};

function Liquid({ change, onDone }) {
  const cv = useRef(null);
  useEffect(() => playCoverChange(cv.current, change, onDone), [change]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={cv} className="liquid-host" aria-hidden="true" />;
}

/**
 * Cover with the liquid change between albums. `coverKey` re-creates the inner Cover as before (a new
 * track, a new cached copy); the change itself is drawn over it until the new one is in place.
 */
const LiquidCover = ({ file, className, coverKey, ...rest }) => {
  const url = file ? coverUrl(file) : null;
  const album = albumOf(file);
  const prev = useRef({ url: null, album: null });
  const [run, setRun] = useState(null);
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = { url, album };
    if (!url || motionOff()) { setRun(null); return; }
    if (!was.url) { // just shown: join a change that is still running towards this cover
      const going = runningChange(url);
      if (going) setRun(going);
      return;
    }
    if (was.url === url || was.album === album) return;
    setRun(beginChange(was.url, url));
  }, [url, album]);
  // read the cover ahead, so the next change has it ready
  useEffect(() => { if (url && !motionOff()) { warm(url); warmCanvases(); } }, [url]);
  return (
    <Cover key={coverKey} file={file} className={`${className || ''} ${run ? 'liquid-on' : ''}`} {...rest}>
      {run && <Liquid key={run.id} change={run} onDone={() => setRun(r => (r === run ? null : r))} />}
    </Cover>
  );
};

export default LiquidCover;
export { albumOf };
