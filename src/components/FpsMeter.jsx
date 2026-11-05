import React, { useEffect, useRef, useState } from 'react';

/** Small frame-rate readout (Settings → General → Performance), to check how smoothly the app draws */
const FpsMeter = () => {
  const [v, setV] = useState({ fps: 0, worst: 0 });
  const frames = useRef([]);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (t) => {
      frames.current.push(t - last);
      last = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const id = setInterval(() => {
      const f = frames.current;
      frames.current = [];
      if (!f.length) return;
      const avg = f.reduce((a, b) => a + b, 0) / f.length;
      setV({ fps: Math.round(1000 / avg), worst: Math.round(Math.max(...f)) });
    }, 500);
    return () => { cancelAnimationFrame(raf); clearInterval(id); };
  }, []);
  return (
    <div className="fps-meter mono" aria-hidden="true">
      <b>{v.fps}</b> fps <span>· slowest {v.worst} ms</span>
    </div>
  );
};

export default FpsMeter;
