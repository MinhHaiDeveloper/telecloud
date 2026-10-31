import { useLayoutEffect, useRef } from 'react';

const LEAD = '.28s cubic-bezier(.25,.8,.3,1)';
const TRAIL = '.42s cubic-bezier(.5,0,.2,1) .07s';

/**
 * Moves a `.indicator` element inside `hostRef` to the item marked `[data-active="true"]`.
 * The leading edge reaches the target first and the trailing edge catches up a beat later,
 * so the indicator stretches while it travels.
 *
 * @param {'x'|'y'} axis   direction the items are laid out in
 * @param {*} activeKey    any value that changes when the active item changes
 * @param {number} inset   shrink the indicator by this many px at both ends
 */
export default function useSlidingIndicator(axis, activeKey, inset = 0) {
  const hostRef = useRef(null);
  const last = useRef(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const ind = host.querySelector(':scope > .indicator');
    const [startProp, endProp] = axis === 'y' ? ['top', 'bottom'] : ['left', 'right'];

    const measure = () => {
      const el = host.querySelector(':scope > [data-active="true"]');
      if (!el) return null;
      const start = axis === 'y' ? el.offsetTop : el.offsetLeft;
      const size = axis === 'y' ? el.offsetHeight : el.offsetWidth;
      const hostSize = axis === 'y' ? host.scrollHeight : host.clientWidth;
      return { start: start + inset, end: hostSize - start - size + inset };
    };

    const place = (animate) => {
      const e = measure();
      if (!ind) return;
      if (!e) { ind.style.opacity = '0'; last.current = null; return; }
      if (animate && last.current) {
        const forward = e.start > last.current.start;
        ind.style.transition = forward
          ? `${endProp} ${LEAD}, ${startProp} ${TRAIL}, opacity .2s`
          : `${startProp} ${LEAD}, ${endProp} ${TRAIL}, opacity .2s`;
      } else {
        ind.style.transition = 'opacity .2s';
      }
      ind.style.opacity = '1';
      ind.style[startProp] = `${e.start}px`;
      ind.style[endProp] = `${e.end}px`;
      last.current = e;
    };

    place(true);

    // Re-snap (without animation) whenever the host changes size, e.g. sidebar collapse or font load
    // (the observer also fires once right away; skip that so the click animation survives)
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; }
      place(false);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [axis, activeKey, inset]);

  return hostRef;
}
