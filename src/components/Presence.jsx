import React, { useEffect, useRef, useState } from 'react';

/**
 * Keeps its child on screen for a moment after `show` turns false, with a `leaving` class,
 * so CSS can animate it out instead of it vanishing.
 */
const Presence = ({ show, ms = 300, children }) => {
  const [mounted, setMounted] = useState(show);
  const last = useRef(children);
  if (show) last.current = children;
  useEffect(() => {
    if (show) { setMounted(true); return undefined; }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [show, ms]);
  if (!show && !mounted) return null;
  const child = last.current;
  if (!React.isValidElement(child)) return null;
  return React.cloneElement(child, { className: `${child.props.className || ''}${show ? '' : ' leaving'}` });
};

export default Presence;
