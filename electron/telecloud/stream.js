// Streaming for TeleCloud (runs inside the worker process).
// A small HTTP server on 127.0.0.1 serves each cloud track at a secret URL. mpv reads it with
// normal byte-range requests, so seeking works and the bytes are exactly the uploaded file
// (bit-perfect). Behind the server, the file is fetched from Telegram in 512 KB blocks, decrypted
// and written into a block cache on disk: replays and re-seeks don't download again, and once
// every block is there (and the checksum matches) it becomes a normal cached file.

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { subKey, ctrChunk } = require('./crypto');

const PART = 512 * 1024;
const FETCHERS = 3;          // parallel block requests per stream
const ACTIVE_STREAMS = 2;    // the playing track and the prefetched next one keep downloading
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const MIME = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.dsf': 'audio/dsf' };

function createStreamer({ client, peerOf, master, bigInt }, emit) {
  const token = crypto.randomBytes(16).toString('hex');
  const sessions = new Map();
  let server = null;
  let port = 0;

  // ---------- one track ----------
  class Session {
    constructor(o) {
      Object.assign(this, o);
      this.blocks = Math.max(1, Math.ceil(this.size / PART));
      this.have = new Uint8Array(this.blocks);
      this.waiters = new Map();   // block -> [resolve, reject][]
      this.inFlight = new Set();
      this.want = 0;
      this.used = Date.now();
      this.bytesWindow = [];
      this.done = false;
      this.closed = false;
    }

    async open() {
      const mapPath = `${this.partPath}.map`;
      let st = null;
      try { st = await fs.promises.stat(this.partPath); } catch { /* new */ }
      if (st && st.size === this.size) {
        try {
          const saved = await fs.promises.readFile(mapPath);
          if (saved.length === this.blocks) this.have.set(saved);
        } catch { /* no map: start over */ }
      }
      this.fh = await fs.promises.open(this.partPath, st && st.size === this.size ? 'r+' : 'w+');
      if (!st || st.size !== this.size) await this.fh.truncate(this.size);
      this.fileKey = this.iv ? subKey(master(), 'file') : null;
      this.ivBuf = this.iv ? Buffer.from(this.iv, 'base64') : null;
      this.report();
      if (this.have.every(Boolean)) await this.finish();
    }

    async media(refresh) {
      if (!this.msgMedia || refresh) {
        const [msg] = await client().getMessages(peerOf(this.peer), { ids: [Number(this.messageId)] });
        if (!msg?.media?.document) throw new Error('This track is no longer in the Telegram chat');
        this.msgMedia = msg.media;
        this.dcId = msg.media.document.dcId;
      }
      return this.msgMedia;
    }

    /** Download block b from Telegram, decrypt it and store it */
    async fetch(b) {
      this.inFlight.add(b);
      try {
        const offset = b * PART;
        const want = Math.min(PART, this.size - offset);
        let buf = null;
        for (let attempt = 0; attempt < 3 && !buf; attempt++) {
          try {
            const parts = [];
            for await (const chunk of client().iterDownload({ file: await this.media(attempt > 0), offset: bigInt(offset), requestSize: PART, limit: 1, fileSize: bigInt(this.size), dcId: this.dcId })) parts.push(chunk);
            buf = Buffer.concat(parts).subarray(0, want);
            if (buf.length !== want) throw new Error(`Short read (${buf.length}/${want})`);
          } catch (err) {
            buf = null;
            if (attempt === 2 || this.closed) throw err; // FILE_REFERENCE_EXPIRED etc: refetch the message and retry
          }
        }
        const plain = this.fileKey ? ctrChunk(this.fileKey, this.ivBuf, offset, buf) : buf;
        await this.fh.write(plain, 0, plain.length, offset);
        this.have[b] = 1;
        this.count(plain.length);
        const ws = this.waiters.get(b) || [];
        this.waiters.delete(b);
        ws.forEach(([resolve]) => resolve());
        this.saveMap();
        this.report();
      } catch (err) {
        const ws = this.waiters.get(b) || [];
        this.waiters.delete(b);
        ws.forEach(([, reject]) => reject(err));
        this.error = err;
        emit('stream-error', { key: this.key, error: err.message });
      } finally {
        this.inFlight.delete(b);
      }
    }

    count(n) {
      const now = Date.now();
      this.bytesWindow.push([now, n]);
      while (this.bytesWindow.length && now - this.bytesWindow[0][0] > 4000) this.bytesWindow.shift();
    }
    speed() {
      if (this.bytesWindow.length < 2) return 0;
      const span = (Date.now() - this.bytesWindow[0][0]) / 1000 || 1;
      return this.bytesWindow.reduce((a, [, n]) => a + n, 0) / span;
    }

    saveMap() {
      clearTimeout(this.mapTimer);
      this.mapTimer = setTimeout(() => { if (!this.closed && !this.done) fs.promises.writeFile(`${this.partPath}.map`, this.have).catch(() => {}); }, 500);
    }

    /** Downloaded ranges as [start, end] fractions of the file (for the seek bar) */
    ranges() {
      const out = [];
      let start = -1;
      for (let i = 0; i <= this.blocks; i++) {
        if (i < this.blocks && this.have[i]) { if (start < 0) start = i; } else if (start >= 0) { out.push([start / this.blocks, i / this.blocks]); start = -1; }
      }
      return out;
    }
    report() {
      const now = Date.now();
      if (now - (this.lastReport || 0) < 300 && !this.have.every(Boolean)) return;
      this.lastReport = now;
      emit('stream-progress', { key: this.key, ranges: this.ranges(), speed: this.speed(), complete: this.have.every(Boolean) });
    }

    nextMissing() {
      // from the reading position forward first, then the start of the file
      for (let i = this.want; i < this.blocks; i++) if (!this.have[i] && !this.inFlight.has(i)) return i;
      for (let i = 0; i < this.want; i++) if (!this.have[i] && !this.inFlight.has(i)) return i;
      return -1;
    }

    /** Keep FETCHERS requests going while this stream is allowed to download */
    pump() {
      if (this.closed || this.done) return;
      while (this.inFlight.size < FETCHERS && isActive(this)) {
        const b = this.nextMissing();
        if (b < 0) break;
        this.fetch(b).then(() => this.afterFetch(), () => this.afterFetch());
      }
    }
    afterFetch() {
      if (this.closed) return;
      if (this.have.every(Boolean)) { this.finish(); return; }
      if (this.error && !this.waiters.size) { this.error = null; setTimeout(() => this.pump(), 2000); return; }
      this.error = null;
      this.pump();
    }

    /** Wait until block b is on disk (asking for it first if needed) */
    async block(b) {
      this.used = Date.now();
      if (this.have[b]) return;
      this.want = b;
      const p = new Promise((resolve, reject) => {
        if (!this.waiters.has(b)) this.waiters.set(b, []);
        this.waiters.get(b).push([resolve, reject]);
      });
      if (!this.inFlight.has(b)) this.fetch(b).then(() => this.afterFetch(), () => this.afterFetch());
      this.pump();
      return p;
    }

    async read(start, end) {
      const buf = Buffer.alloc(end - start);
      await this.fh.read(buf, 0, buf.length, start);
      return buf;
    }

    async finish() {
      if (this.done || this.finishing) return;
      this.finishing = true;
      clearTimeout(this.mapTimer);
      // check the whole file against the checksum taken before upload
      const hash = crypto.createHash('sha256');
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      for (let off = 0; off < this.size; off += chunk.length) {
        const { bytesRead } = await this.fh.read(chunk, 0, Math.min(chunk.length, this.size - off), off);
        hash.update(chunk.subarray(0, bytesRead));
      }
      const sha = hash.digest('hex');
      if (this.sha256 && sha !== this.sha256) {
        this.have.fill(0);
        this.finishing = false;
        emit('stream-error', { key: this.key, error: this.iv ? 'Downloaded data does not match: wrong recovery key or a damaged upload' : 'Downloaded data does not match the original (checksum)' });
        return;
      }
      this.done = true;
      // It becomes the cache file. The open handle stays valid across the rename (Node opens
      // files with delete/rename sharing), so a read mpv is doing right now isn't cut off.
      await fs.promises.rm(`${this.partPath}.map`, { force: true });
      try {
        await fs.promises.rename(this.partPath, this.finalPath);
      } catch {
        await fs.promises.copyFile(this.partPath, this.finalPath);
      }
      this.report();
      emit('stream-complete', { key: this.key, path: this.finalPath });
      schedule();
    }

    async close() {
      this.closed = true;
      clearTimeout(this.mapTimer);
      if (!this.done) await fs.promises.writeFile(`${this.partPath}.map`, this.have).catch(() => {});
      for (const ws of this.waiters.values()) ws.forEach(([, reject]) => reject(new Error('Stream closed')));
      this.waiters.clear();
      await this.fh?.close().catch(() => {});
    }
  }

  // Only the most recently used streams download in the background
  const isActive = (s) => [...sessions.values()].filter(x => !x.done && !x.closed).sort((a, b) => b.used - a.used).slice(0, ACTIVE_STREAMS).includes(s) || s.waiters.size > 0;
  const schedule = () => { for (const s of sessions.values()) s.pump(); };

  setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) {
      if (now - s.used > IDLE_CLOSE_MS && !s.waiters.size) { sessions.delete(k); s.close(); }
    }
  }, 60 * 1000).unref();

  // ---------- HTTP ----------
  async function serve(req, res) {
    const m = req.url.match(/^\/s\/([0-9a-f]{32})\/([0-9a-z-]+)$/);
    const s = m && m[1] === token ? sessions.get(m[2]) : null;
    if (!s || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404).end(); return; }
    s.used = Date.now();
    let start = 0;
    let end = s.size - 1;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); } else if (range[2]) { start = Math.max(0, s.size - Number(range[2])); }
      if (start > end || start >= s.size) { res.writeHead(416, { 'Content-Range': `bytes */${s.size}` }).end(); return; }
    }
    const headers = { 'Content-Type': MIME[s.ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${s.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    let aborted = false;
    res.on('close', () => { aborted = true; });
    s.want = Math.floor(start / PART);
    schedule();
    try {
      for (let pos = start; pos <= end && !aborted;) {
        const b = Math.floor(pos / PART);
        await s.block(b);
        const blockEnd = Math.min((b + 1) * PART, end + 1);
        const data = await s.read(pos, blockEnd);
        pos = blockEnd;
        s.want = Math.floor(pos / PART);
        if (!res.write(data)) await new Promise(r => res.once('drain', r).once('close', r));
      }
      res.end();
    } catch (err) {
      res.destroy(err);
    }
  }

  async function ensureServer() {
    if (server) return;
    server = http.createServer((req, res) => { serve(req, res).catch(() => res.destroy()); });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    port = server.address().port;
  }

  return {
    /** Start (or reuse) a stream; returns its URL. Blocks already on disk are reused. */
    async open({ key, peer, messageId, iv, sha256, size, ext, partPath, finalPath }) {
      await ensureServer();
      if (iv && !master()) throw new Error('This track is encrypted: enter your recovery key first');
      let s = sessions.get(key);
      if (!s || s.closed) {
        s = new Session({ key, peer, messageId, iv, sha256, size: Number(size), ext, partPath, finalPath });
        sessions.set(key, s);
        await s.open();
      }
      s.used = Date.now();
      schedule();
      return { url: `http://127.0.0.1:${port}/s/${token}/${key}`, prefix: `http://127.0.0.1:${port}/s/${token}/`, complete: s.done };
    },
    async close({ key }) {
      const s = sessions.get(key);
      if (s) { sessions.delete(key); await s.close(); }
      return true;
    },
    status: ({ key }) => {
      const s = sessions.get(key);
      return s ? { ranges: s.ranges(), speed: s.speed(), complete: s.done } : null;
    },
    /** Download speed test: up to `bytes` from the start of a file, nothing is kept */
    async speedTest({ peer, messageId, size, bytes = 16 * 1024 * 1024 }) {
      const [msg] = await client().getMessages(peerOf(peer), { ids: [Number(messageId)] });
      if (!msg?.media?.document) throw new Error('No file to test with');
      const total = Math.min(Number(size), bytes);
      const blocks = Math.ceil(total / PART);
      let next = 0;
      let got = 0;
      const t0 = Date.now();
      let first = 0;
      const run = async () => {
        while (next < blocks) {
          const b = next++;
          for await (const chunk of client().iterDownload({ file: msg.media, offset: bigInt(b * PART), requestSize: PART, limit: 1, fileSize: bigInt(Number(size)), dcId: msg.media.document.dcId })) {
            if (!first) first = Date.now() - t0;
            got += chunk.length;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(FETCHERS, blocks) }, run));
      const secs = (Date.now() - t0) / 1000;
      return { bytes: got, seconds: secs, bytesPerSec: got / secs, firstByteMs: first };
    },
    get prefix() { return server ? `http://127.0.0.1:${port}/s/${token}/` : null; },
  };
}

module.exports = { createStreamer, PART };
