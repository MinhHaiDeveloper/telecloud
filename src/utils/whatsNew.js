// What changed in each version, newest first. About shows it, and so does the note after an update.
// Add an entry here for every release; keep it short and written for people using the app.
export const RELEASES = [
  {
    version: '1.0.0-beta.10',
    items: [
      'Discord status: show what you are listening to, with the album cover. Turn it on in Settings > General.',
      'New Appearance settings: make the full-screen cover tilt with your mouse, and choose the lyrics size, alignment, glow and speed.',
      'Equalizer: import and export Audacity curves.',
      'Clearer messages when a file cannot be changed, with the option to write to read-only files.',
      'Saving a cover no longer fails when the largest picture is missing.',
      "This What's New note, also in Settings > About.",
    ],
  },
  {
    version: '1.0.0-beta.9',
    items: [
      'The Artists page can show album artists only, or everyone.',
      'The disc icon lines up with its heading.',
      'Clearer message when a lyrics or cover source cannot be reached.',
    ],
  },
  {
    version: '1.0.0-beta.8',
    items: [
      'Albums are grouped by album artist: two albums with the same name stay apart, and guests no longer split an album.',
      'Artist pages list albums they only appear on separately.',
      'Files without tags take their details from the file name and folders.',
      'The library also picks up .wma, .aifc, .m4b, .mka and .mpc files.',
    ],
  },
];

const parts = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.?(\d+))?/i.exec(String(v || ''));
  // a plain release comes after its own betas
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])] : null;
};

/** Below 0: a is older than b */
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The notes to show when the app starts. Nothing on a new install, or when this version was seen.
 * Versions before this feature saved nothing: someone with music folders has updated from one.
 */
export function notesToShow(lastSeen, current, hasLibrary, releases = RELEASES) {
  if (!lastSeen) return hasLibrary ? releases.filter(r => compareVersions(r.version, current) === 0) : [];
  if (compareVersions(lastSeen, current) >= 0) return [];
  return releases.filter(r => compareVersions(r.version, lastSeen) > 0 && compareVersions(r.version, current) <= 0);
}

export const shortVersion = (v) => String(v || '').replace(/^1\.0\.0-/, '');
export const RELEASES_URL = 'https://github.com/MinhHaiDeveloper/telecloud/releases';
