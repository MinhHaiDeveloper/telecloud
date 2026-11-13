import React from 'react';

// Stroke icon set used across the app (24x24 grid, styled by the .ico class)
const PATHS = {
  // the app mark: an eighth note with a cloud for its head (same design as public/icon.svg)
  logo: <g fill="currentColor" stroke="none" transform="scale(0.046875) translate(-36 4)"><rect x="288" y="112" width="36" height="250" rx="18" /><path d="M306 112 C 306 112 330 108 348 130 C 384 168 418 196 410 262 C 406 296 392 318 378 330 C 390 300 392 270 372 244 C 356 222 334 214 306 210 Z" /><path d="M6.5 19H17.5A4 4 0 0 0 18.2 11.06A6 6 0 0 0 6.6 9.6A4.7 4.7 0 0 0 6.5 19Z" transform="translate(147.72 249.48) scale(8.8000)" /></g>,
  discover: <path d="M3 12h3l3-8 4 16 3-8h5" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
  library: <path d="M4 19V5M9 19V5M14 19l-1-14M19 19l-3-14" />,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  disc: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></>,
  cloud: <path d="M18 10a6 6 0 0 0-12 0 4 4 0 0 0 0 8h12a4 4 0 0 0 0-8z" />,
  playlist: <path d="M3 6h13M3 12h13M3 18h9M17 15v6l5-3z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  play: <path d="M7 4l13 8-13 8z" />,
  pause: <path d="M7 5h4v14H7zM13 5h4v14h-4z" />,
  prev: <path d="M19 20L9 12l10-8zM5 19V5" />,
  next: <path d="M5 4l10 8-10 8zM19 5v14" />,
  shuffle: <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />,
  repeat: <><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>,
  volume: <><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></>,
  mute: <><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M23 9l-6 6M17 9l6 6" /></>,
  eq: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  queue: <path d="M3 6h13M3 12h13M3 18h9M17 15v6l5-3z" />,
  speaker: <><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="14" r="4" /><circle cx="12" cy="7" r="1" /></>,
  more: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
  chevron: <path d="M6 9l6 6 6-6" />,
  chevronLeft: <path d="M15 18l-6-6 6-6" />,
  expand: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  shrink: <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6" /><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2M3 3l18 18" /></>,
  trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></>,
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  spectrum: <path d="M4 20v-6M9 20V8M14 20v-9M19 20V4" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
  sort: <path d="M3 6h18M6 12h12M10 18h4" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>,
  lyrics: <><path d="M4 6h16M4 10h10M4 14h16M4 18h8" /></>,
  music: <><path d="M9 18V6l11-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></>,
  upload: <path d="M12 21V9M7 14l5-5 5 5M5 3h14" />,
  headphones: <><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  // the letters, drawn as strokes like the rest of the set (not the MQA logo)
  mqa: <g style={{ strokeWidth: 2.6 }}><path d="M1.6 17v-10l3 5.4 3-5.4v10" /><circle cx="12.3" cy="12" r="3.6" /><path d="M13.9 14.7l2 2.3M17.2 17l2.65-10 2.65 10M18.3 14h3.1" /></g>,
  dsd: <g style={{ strokeWidth: 2.6 }}><path d="M1.5 7.5v9h1.75a4.5 4.5 0 0 0 0-9z" /><path d="M14.25 9.2c-.4-.95-1.35-1.7-2.6-1.7-1.45 0-2.5.85-2.5 2.05 0 2.85 5.4 1.6 5.4 4.65 0 1.3-1.15 2.3-2.75 2.3-1.35 0-2.45-.7-2.85-1.75" /><path d="M16.5 7.5v9h1.75a4.5 4.5 0 0 0 0-9z" /></g>,
  // up to a ceiling: the output limit
  limit: <path d="M4 4.5h16M12 20V9M7.5 13.5 12 9l4.5 4.5" />,
};

const Icon = ({ name, filled = false, className = '', ...rest }) => (
  <svg viewBox="0 0 24 24" className={`ico${filled ? ' filled' : ''}${className ? ' ' + className : ''}`} aria-hidden="true" {...rest}>
    {PATHS[name]}
  </svg>
);

export default Icon;
