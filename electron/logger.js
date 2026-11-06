// The app's log: one file per day in <userData>/logs, kept on this computer until the user exports
// it (Settings > About). Secrets are removed before anything reaches the disk, and again on export.
// Everything that goes through console.* ends up here, with crashes and the other processes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const KEEP_DAYS = 14;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_PER_DAY = 15 * 1024 * 1024;
const MAX_LINE = 4000;
const FLUSH_MS = 1000;
const FLUSH_BYTES = 64 * 1024;

let dir = null;
let verbose = false;
let queue = [];
let queued = 0;
let timer = null;
let dayFile = null;
let dayBytes = 0;
let dayFull = false;
let last = null; // the previous message, to fold repeats
let repeats = 0;
const original = {};
const secrets = new Set();

// ---------- removing what must never be in a log
const home = os.homedir();
const homes = [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')].filter(Boolean);
const SECRET_KEYS = /("?\b(?:string_?session|session|api_?hash|master_?key|recovery_?key|password|passcode|phone_?number|phone_?code|phone|api_?key|api_?sig|api_?secret|secret|token|authorization|sk)\b"?\s*[:=]\s*)(\[hidden\]|(?:Bearer|Basic)\s+\S+|"[^"]*"|'[^']*'|[^\s,&;})\]]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const CAPTION = /\b(tc1|tcm1|tcc1):\S+/g;
const PHONE = /\+\d{8,15}\b/g;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{48,}/g;
const OTHER_HOME = /([\\/]Users[\\/])[^\\/\s"']+/gi;

/** Remember values that must never appear, wherever they turn up (session, keys, phone number) */
function addSecrets(values) {
  for (const v of [].concat(values || [])) {
    if (typeof v === 'string' && v.length >= 6) { secrets.add(v); secrets.add(v.replace(/\\/g, '\\\\')); }
  }
}

function redact(text) {
  let s = String(text);
  for (const v of secrets) if (s.includes(v)) s = s.split(v).join('[hidden]');
  for (const h of homes) {
    if (s.toLowerCase().includes(h.toLowerCase())) s = s.replace(new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~');
  }
  return s
    .replace(OTHER_HOME, '$1[user]')
    .replace(CAPTION, '$1:[hidden]')
    .replace(BEARER, '$1 [hidden]')
    .replace(SECRET_KEYS, '$1[hidden]')
    .replace(PHONE, '[hidden]')
    .replace(LONG_TOKEN, '[hidden]');
}

// ---------- files
const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function stamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const LINE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) ([+-]\d{2}:\d{2}) /;
const FILE = /^\d{4}-\d{2}-\d{2}\.log$/;

function listFiles() {
  try { return fs.readdirSync(dir).filter(n => FILE.test(n)).sort(); } catch { return []; }
}

/** Oldest days go first when over the time or size limit; today is never removed */
function prune(now = new Date()) {
  const cutoff = dayOf(new Date(now.getTime() - KEEP_DAYS * 86400000));
  const today = dayOf(now);
  let files = listFiles();
  for (const n of files) if (n.slice(0, 10) < cutoff) { try { fs.rmSync(path.join(dir, n)); } catch { /* next time */ } }
  files = listFiles();
  const sizes = files.map(n => { try { return fs.statSync(path.join(dir, n)).size; } catch { return 0; } });
  let total = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < files.length && total > MAX_TOTAL; i++) {
    if (files[i].startsWith(today)) continue;
    try { fs.rmSync(path.join(dir, files[i])); total -= sizes[i]; } catch { /* next time */ }
  }
}

function openDay() {
  const name = `${dayOf()}.log`;
  if (dayFile === name) return;
  dayFile = name;
  dayFull = false;
  try { dayBytes = fs.statSync(path.join(dir, name)).size; } catch { dayBytes = 0; }
  prune();
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length || !dir) return;
  const text = queue.join('');
  queue = [];
  queued = 0;
  try {
    openDay();
    if (dayFull) return;
    let out = text;
    const size = Buffer.byteLength(out);
    if (dayBytes + size > MAX_PER_DAY) {
      dayFull = true;
      out = `${stamp()} WARN  [log] Today's log is full (${Math.round(MAX_PER_DAY / 1048576)} MB). Nothing more is written until tomorrow.\n`;
    }
    fs.appendFileSync(path.join(dir, dayFile), out);
    dayBytes += Buffer.byteLength(out);
  } catch { /* a full or locked disk must never stop the music */ }
}

function push(line, urgent) {
  queue.push(line);
  queued += line.length;
  if (urgent || queued >= FLUSH_BYTES) flush();
  else if (!timer) { timer = setTimeout(flush, FLUSH_MS); timer.unref?.(); }
}

function foldRepeats() {
  if (repeats > 0 && last) push(`${stamp()} ${last.head} ... repeated ${repeats} more ${repeats === 1 ? 'time' : 'times'}\n`);
  repeats = 0;
}

/** level: ERROR, WARN, INFO, DEBUG. DEBUG lines are written only with verbose logging on. */
function write(level, source, message) {
  if (!dir || (level === 'DEBUG' && !verbose)) return;
  let text = redact(message).replace(/\s+$/, '');
  if (!text) return;
  if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)} ... [cut]`;
  const head = `${level.padEnd(5)} [${source}]`;
  if (last && last.head === head && last.text === text) { repeats++; if (level === 'ERROR') flush(); return; }
  foldRepeats();
  last = { head, text };
  push(`${stamp()} ${head} ${text}\n`, level === 'ERROR');
}

/** Lines from another process: buffers partial lines so a chunk can't cut one in half */
function stream(level, source) {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString();
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    lines.forEach(l => { if (l.trim()) write(level, source, l); });
    if (rest.length > MAX_LINE) { write(level, source, rest); rest = ''; }
  };
}

function setVerbose(v) {
  verbose = !!v;
  write('INFO', 'log', `Verbose logging ${verbose ? 'on' : 'off'}`);
}

/** Start logging. Call first thing in the main process. */
function init(logDir) {
  dir = logDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = null; return; }
  openDay();
  for (const [name, level] of [['error', 'ERROR'], ['warn', 'WARN'], ['log', 'INFO'], ['info', 'INFO'], ['debug', 'DEBUG']]) {
    original[name] = console[name].bind(console);
    console[name] = (...args) => { original[name](...args); write(level, 'main', util.format(...args)); };
  }
  // the monitor sees uncaught errors without changing what happens next
  process.on('uncaughtExceptionMonitor', (err, origin) => { write('ERROR', 'crash', `${origin}: ${err?.stack || err}`); flush(); });
  process.on('unhandledRejection', (reason) => { write('ERROR', 'main', `Unhandled promise rejection: ${reason?.stack || reason}`); });
  process.on('exit', () => { foldRepeats(); flush(); });
}

function closeFlush() { foldRepeats(); last = null; flush(); }

module.exports = {
  init, write, stream, flush: closeFlush, redact, addSecrets, setVerbose, isVerbose: () => verbose, listFiles, prune,
  logDir: () => dir, LINE_TIME, KEEP_DAYS, MAX_TOTAL, MAX_PER_DAY, _state: () => ({ dayBytes, dayFull }),
};
