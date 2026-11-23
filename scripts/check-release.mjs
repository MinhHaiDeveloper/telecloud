// Before a release: nothing private in git or in the installer.
//   node scripts/check-release.mjs [path to app.asar]     (scripts/release.js runs it after each build)
// Fails (exit 1) when:
//   - git tracks .env, a key file, logs, crash dumps or a library database;
//   - the value of a key (electron/*-key.json, .env) appears in any tracked file;
//   - the installer holds .env, logs, a database, the plans, or test leftovers.
// The app's own API keys (lastfm-key.json, youtube-key.json) belong in the installer: they are listed, not refused.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const problems = [];
const notes = [];

// ---------- git
const tracked = execSync('git ls-files -z', { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean);
const PRIVATE = [
  [/(^|\/)\.env(\..*)?$/i, 'an environment file'],
  [/-key\.json$/i, 'a key file'],
  [/\.(log|dmp)$/i, 'a log or crash dump'],
  [/(^|\/)logs\//i, 'a log folder'],
  [/music-library\.db$|\.sqlite$/i, 'a library database'],
  [/telecloud-sync\.json$|lastfm\.json$|listenbrainz\.json$/i, 'account settings'],
];
for (const f of tracked) { const hit = PRIVATE.find(([re]) => re.test(f)); if (hit) problems.push(`git tracks ${hit[1]}: ${f}`); }

// the keys' values, from the key files and .env, must not be written into anything tracked
const secrets = new Set();
const addSecret = (v) => { if (typeof v === 'string' && v.trim().length >= 16) secrets.add(v.trim()); };
for (const f of ['electron/lastfm-key.json', 'electron/youtube-key.json']) {
  try { Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'))).forEach(addSecret); } catch { /* not here */ }
}
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*[A-Z0-9_]+\s*=\s*"?([^"#\s]+)"?/i.exec(line);
    if (m) addSecret(m[1]);
  }
} catch { /* no .env */ }
if (secrets.size) {
  for (const f of tracked) {
    const p = path.join(ROOT, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
    const text = fs.readFileSync(p).toString('latin1');
    for (const s of secrets) if (text.includes(s)) problems.push(`a key's value is written in ${f}`);
  }
}

// ---------- the installer
const asarArg = process.argv[2];
const asarPath = asarArg || path.join(ROOT, 'out', 'installer', 'win-unpacked', 'resources', 'app.asar');
if (fs.existsSync(asarPath)) {
  const asar = require('@electron/asar');
  const files = asar.listPackage(asarPath).map(f => f.replace(/^[\\/]/, '').replace(/\\/g, '/'));
  const PACKED = [
    [/(^|\/)\.env(\..*)?$/i, 'an environment file'],
    [/\.(log|dmp)$/i, 'a log or crash dump'],
    [/(^|\/)logs\//i, 'a log folder'],
    [/\.db$|\.sqlite$/i, 'a database'],
    [/^plans\//i, 'the plans'],
    [/scratchpad|(^|\/)test-[^/]*\.js$|\.test\.m?js$/i, 'a test leftover'],
    [/telecloud-sync\.json$|lastfm\.json$|listenbrainz\.json$/i, 'account settings'],
  ];
  for (const f of files) {
    if (f.startsWith('node_modules/')) continue;
    const hit = PACKED.find(([re]) => re.test(f));
    if (hit) problems.push(`the installer holds ${hit[1]}: ${f}`);
  }
  const keys = files.filter(f => /^electron\/[^/]*-key\.json$/.test(f));
  notes.push(`installer ${path.relative(ROOT, asarPath)}: ${files.length} files${keys.length ? `; the app's own keys packed as intended: ${keys.join(', ')}` : ''}`);
} else {
  notes.push('no installer built: only git was checked');
}

console.log(`Release check: ${tracked.length} tracked files, ${secrets.size} key values looked for.`);
notes.forEach(n => console.log(`  ${n}`));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  problems.forEach(p => console.error(`  ${p}`));
  process.exit(1);
}
console.log('Nothing private found.');
