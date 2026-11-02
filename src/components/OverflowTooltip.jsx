import { useEffect } from 'react';

// One tooltip for the whole app: hovering any text that is cut off with "…" (single-line
// ellipsis or a line clamp) shows the full text after a short delay. Nothing to add per
// component, and text that fits never gets a tooltip.

const DELAY = 380;
const MAX_DEPTH = 4; // the hovered node can be an icon or <b> inside the truncated element

const truncated = (el) => {
  const cs = getComputedStyle(el);
  if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) return true;
  return cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '' && el.scrollHeight > el.clientHeight + 1;
};

function findTruncated(start) {
  let el = start;
  for (let i = 0; el && el !== document.body && i < MAX_DEPTH; i++, el = el.parentElement) {
    if (el.nodeType !== 1 || el.closest('input, textarea, select, canvas, [data-no-tooltip]')) return null;
    if (truncated(el)) return el;
    // a title on a parent that isn't cut off (e.g. a button's own tooltip) stays the browser's
    if (el.hasAttribute('title') && el !== start) return null;
  }
  return null;
}

const OverflowTooltip = () => {
  useEffect(() => {
    const tip = document.createElement('div');
    tip.className = 'overflow-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    let target = null;
    let timer = null;

    // Truncated text that carries a title attribute: show ours, and park the title meanwhile
    // so the plain system tooltip doesn't pop up on top of it
    // (and on the few ancestors around it, e.g. a menu item whose ellipsis lives in an inner <span>)
    let parked = [];
    const parkTitle = (el) => {
      for (let n = el, i = 0; n && n !== document.body && i < MAX_DEPTH; n = n.parentElement, i++) {
        if (n.hasAttribute('title')) { n.dataset.tipTitle = n.getAttribute('title'); n.removeAttribute('title'); parked.push(n); }
      }
    };
    const restoreTitle = () => {
      parked.forEach(n => { if (n.dataset.tipTitle !== undefined) { n.setAttribute('title', n.dataset.tipTitle); delete n.dataset.tipTitle; } });
      parked = [];
    };
    let watch = null;
    const hide = () => {
      clearInterval(watch);
      clearTimeout(timer);
      timer = null;
      restoreTitle();
      target = null;
      tip.classList.remove('show');
    };
    const show = (el) => {
      const titled = parked.find(n => n === el || n.contains(el));
      const text = (titled?.dataset.tipTitle || el.innerText).replace(/\s+/g, ' ').trim();
      if (!text) return;
      tip.textContent = text;
      tip.style.left = '0px';
      tip.style.top = '0px';
      tip.classList.add('measure');
      const r = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      tip.classList.remove('measure');
      const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left - 10));
      const below = r.bottom + 8 + t.height < window.innerHeight - 8;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(below ? r.bottom + 6 : r.top - t.height - 6)}px`;
      tip.classList.add('show');
      // The hovered text can be replaced (a list re-rendering) or vanish (a menu closing) under
      // the pointer: follow the new copy of it, or hide instead of leaving the tooltip behind
      clearInterval(watch);
      watch = setInterval(() => {
        if (target && target.isConnected) return;
        const el = findTruncated(document.elementFromPoint(pointer.x, pointer.y));
        if (!el) { hide(); return; }
        target = el;
        parkTitle(el);
      }, 250);
    };

    const pointer = { x: 0, y: 0 };
    const onOver = (e) => {
      pointer.x = e.clientX; pointer.y = e.clientY;
      const el = findTruncated(e.target);
      if (el === target) return;
      hide();
      if (!el) return;
      target = el;
      parkTitle(el);
      timer = setTimeout(() => { if (target === el && el.isConnected) show(el); }, DELAY);
    };
    // Only a scroll that moves the hovered text hides it (lyrics and the queue scroll on their own)
    const onScroll = (e) => {
      const box = e.target === document ? document.documentElement : e.target;
      if (target && box.contains?.(target)) hide();
    };
    const onOut = (e) => {
      if (target && !target.contains(e.relatedTarget)) hide();
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', hide);
      tip.remove();
    };
  }, []);
  return null;
};

export default OverflowTooltip;
