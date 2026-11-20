// node-taglib-sharp opens every format TeleCloud tags except DSF. A DSF file keeps one ID3v2 tag after
// its audio, and its header says where, so that one is read and written here.
const fs = require('fs');
const { tx } = require('./i18n');

const HEADER = 28; // "DSD ", its size, the file's size, where the tag starts

function layout(fd) {
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(HEADER + 12);
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString('latin1', 0, 4) !== 'DSD ' || head.toString('latin1', 28, 32) !== 'fmt ') throw new Error(tx('This is not a DSF file'));
  const dataAt = HEADER + Number(head.readBigUInt64LE(32));
  const chunk = Buffer.alloc(12);
  fs.readSync(fd, chunk, 0, 12, dataAt);
  if (chunk.toString('latin1', 0, 4) !== 'data') throw new Error(tx('This DSF file is damaged'));
  const audioEnd = dataAt + Number(chunk.readBigUInt64LE(4));
  if (audioEnd > size) throw new Error(tx('This DSF file is damaged'));
  const pointer = Number(head.readBigUInt64LE(20));
  return { size, tagAt: pointer >= audioEnd && pointer < size ? pointer : audioEnd };
}

class DsfTags {
  constructor(file) {
    const { Id3v2Tag, ByteVector } = require('node-taglib-sharp');
    this.file = file;
    const fd = fs.openSync(file, 'r');
    try {
      const { size, tagAt } = layout(fd);
      const old = Buffer.alloc(size - tagAt);
      if (old.length) fs.readSync(fd, old, 0, old.length, tagAt);
      this.tag = old.length >= 10 && old.toString('latin1', 0, 3) === 'ID3'
        ? Id3v2Tag.fromData(ByteVector.fromByteArray(old))
        : Id3v2Tag.fromEmpty();
    } finally { fs.closeSync(fd); }
  }

  /** The audio is never touched: only the tag after it and the two numbers in the header change */
  save() {
    const bytes = this.tag.frames.length ? Buffer.from(this.tag.render().toByteArray()) : Buffer.alloc(0);
    const fd = fs.openSync(this.file, 'r+');
    try {
      const { tagAt } = layout(fd);
      if (bytes.length) fs.writeSync(fd, bytes, 0, bytes.length, tagAt);
      fs.ftruncateSync(fd, tagAt + bytes.length);
      const numbers = Buffer.alloc(16);
      numbers.writeBigUInt64LE(BigInt(tagAt + bytes.length), 0);
      numbers.writeBigUInt64LE(bytes.length ? BigInt(tagAt) : 0n, 8);
      fs.writeSync(fd, numbers, 0, 16, 12);
    } finally { fs.closeSync(fd); }
  }

  dispose() { /* nothing stays open */ }
}

/** Opens a file's tags. The result has .tag, .save() and .dispose() for every format. */
function openTags(file) {
  if (/\.dsf$/i.test(file)) return new DsfTags(file);
  return require('node-taglib-sharp').File.createFromPath(file);
}

// ---------- writing a file that is playing
// mpv reads the playing file a little at a time. Saving tags can rewrite the whole file (when the new tags
// don't fit in its padding), so the audio moves a few bytes and mpv, reading on at the old place, skips or
// clicks. Writes to the playing (or paused) file wait until it stops being the current track; the library,
// the screen and the remote already have the new lyrics, cover or tags, so nothing looks different.
const pending = new Map(); // normalised path -> { file, writes: [fn] }
let freeSince = new Map(); // normalised path -> when it stopped being the current track
let timer = null;
const norm = (p) => require('path').resolve(String(p || '')).toLowerCase();
const playing = () => { try { const p = require('./player').playingPath(); return p ? norm(p) : null; } catch { return null; } };

function runWrites(entry) {
  for (const w of entry.writes) {
    try { w(); } catch (err) { console.warn(`[Tags] A held write failed: ${err.message}`); }
  }
}
function check() {
  const now = playing();
  for (const [k, entry] of pending) {
    if (k === now) { freeSince.delete(k); continue; }
    // a few seconds after it stopped: a crossfade or the end of a gapless join still reads it
    if (!freeSince.has(k)) { freeSince.set(k, Date.now()); continue; }
    if (Date.now() - freeSince.get(k) < 3000) continue;
    pending.delete(k); freeSince.delete(k);
    runWrites(entry);
    console.log(`[Tags] Wrote what waited for the track to stop (${entry.writes.length} ${entry.writes.length === 1 ? 'change' : 'changes'})`);
  }
  if (!pending.size) { clearInterval(timer); timer = null; }
}

/**
 * Writes now, or (for the file playing) once it stops playing. Returns { held: true } when it waits.
 * `write` must do the whole job itself (open, change, save, dispose).
 */
function writeWhenFree(file, write) {
  const k = norm(file);
  if (k !== playing() && !pending.has(k)) { write(); return { held: false }; }
  // a read-only file the user did not open up fails now, as a direct write would; one they did (the caller's
  // withWritable made it writable for this call) is opened up again for the held write
  const fw = require('./fileWrite');
  if (fw.isReadOnly(file)) { const e = new Error(`EPERM: operation not permitted, open '${file}'`); e.code = 'EPERM'; throw e; }
  const wasReadOnly = () => { try { return fw.isReadOnly(file); } catch { return false; } };
  const entry = pending.get(k) || { file, writes: [] };
  entry.writes.push(() => fw.withWritable(file, wasReadOnly(), write));
  pending.set(k, entry);
  freeSince.delete(k);
  if (!timer) { timer = setInterval(check, 1000); timer.unref?.(); }
  console.log('[Tags] The track is playing: its tags are written when it stops');
  return { held: true };
}
/** Everything still waiting, now (on quit, after the player has let go) */
function flushAll() {
  for (const [k, entry] of pending) { pending.delete(k); runWrites(entry); }
}
try { require('electron').app.on('will-quit', flushAll); } catch { /* outside Electron (tests of the pure parts) */ }

/** Is this file playing, or has it writes waiting? Then a write to it is held too (in order) */
const isBusy = (file) => { const k = norm(file); return k === playing() || pending.has(k); };

module.exports = { openTags, writeWhenFree, isBusy, flushAll, _pending: () => [...pending.values()].map(e => e.file) };
