// DSD over PCM (DoP v1.0). mpv can't send DSD to a DAC, so the DSD bits are packed into 24-bit PCM
// samples here and served to mpv as raw PCM from 127.0.0.1. Each sample carries 16 DSD bits under
// a marker byte that alternates 0x05 / 0xFA; a DoP DAC sees the markers and plays the bits as DSD.
// That only works when not one bit changes on the way: no volume, no EQ, no resampling.
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const MARKERS = [0x05, 0xfa];
const REVERSE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b);
  REVERSE[i] = r;
}

/** What a DSF or DFF file holds, or null when it isn't plain DSD (a DST-compressed DFF, say) */
function probe(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const magic = head.toString('latin1', 0, 4);
    if (magic === 'DSD ') return probeDsf(fd);
    if (magic === 'FRM8' && head.toString('latin1', 12, 16) === 'DSD ') return probeDff(fd, Number(head.readBigUInt64BE(4)) + 12);
    return null;
  } finally { fs.closeSync(fd); }
}

function probeDsf(fd) {
  const fmt = Buffer.alloc(52);
  fs.readSync(fd, fmt, 0, 52, 28);
  if (fmt.toString('latin1', 0, 4) !== 'fmt ') return null;
  const channels = fmt.readUInt32LE(24);
  const rate = fmt.readUInt32LE(28);
  const bitsPerSample = fmt.readUInt32LE(32);
  const samples = Number(fmt.readBigUInt64LE(36));
  const blockSize = fmt.readUInt32LE(44);
  const fmtSize = Number(fmt.readBigUInt64LE(4));
  const data = Buffer.alloc(12);
  fs.readSync(fd, data, 0, 12, 28 + fmtSize);
  if (data.toString('latin1', 0, 4) !== 'data' || !channels || !rate || !blockSize) return null;
  return { kind: 'dsf', channels, rate, samples, blockSize, dataStart: 28 + fmtSize + 12, lsbFirst: bitsPerSample === 1 };
}

function probeDff(fd, end) {
  let pos = 16;
  const info = { kind: 'dff', lsbFirst: false };
  const hdr = Buffer.alloc(12);
  while (pos + 12 <= end) {
    fs.readSync(fd, hdr, 0, 12, pos);
    const id = hdr.toString('latin1', 0, 4);
    const size = Number(hdr.readBigUInt64BE(4));
    const body = pos + 12;
    if (id === 'PROP') {
      let p = body + 4; // "SND "
      while (p + 12 <= body + size) {
        fs.readSync(fd, hdr, 0, 12, p);
        const sid = hdr.toString('latin1', 0, 4);
        const ssize = Number(hdr.readBigUInt64BE(4));
        const b = Buffer.alloc(Math.min(ssize, 64));
        fs.readSync(fd, b, 0, b.length, p + 12);
        if (sid === 'FS  ') info.rate = b.readUInt32BE(0);
        if (sid === 'CHNL') info.channels = b.readUInt16BE(0);
        if (sid === 'CMPR') info.compression = b.toString('latin1', 0, 4);
        p += 12 + ssize + (ssize % 2);
      }
    } else if (id === 'DSD ') {
      info.dataStart = body;
      info.dataBytes = size;
    } else if (id === 'DST ') {
      info.compression = 'DST ';
    }
    pos = body + size + (size % 2);
  }
  if (!info.rate || !info.channels || !info.dataStart || (info.compression && info.compression !== 'DSD ')) return null;
  info.samples = Math.floor(info.dataBytes / info.channels) * 8;
  return info;
}

/** One DoP sample is 16 DSD bits: the PCM rate is the DSD rate / 16 (DSD64 → 176.4 kHz) */
const dopRate = (info) => info.rate / 16;
const frameCount = (info) => Math.floor(info.samples / 16);
const bytesPerFrame = (info) => info.channels * 3;

/** DoP frames [from, from + count) as little-endian 24-bit PCM, channels interleaved */
function readFrames(info, fd, from, count) {
  const ch = info.channels;
  const out = Buffer.alloc(count * ch * 3);
  const firstByte = from * 2; // per channel
  const bytes = count * 2;
  const chans = [];
  if (info.kind === 'dsf') {
    // blocks of blockSize bytes per channel, one channel after the other
    const bs = info.blockSize;
    const b0 = Math.floor(firstByte / bs);
    const b1 = Math.floor((firstByte + bytes - 1) / bs);
    const span = Buffer.alloc((b1 - b0 + 1) * bs * ch);
    fs.readSync(fd, span, 0, span.length, info.dataStart + b0 * bs * ch);
    for (let c = 0; c < ch; c++) {
      const own = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i++) {
        const at = firstByte + i;
        const blk = Math.floor(at / bs) - b0;
        own[i] = span[blk * bs * ch + c * bs + (at % bs)];
      }
      chans.push(own);
    }
  } else {
    // one byte of each channel in turn
    const span = Buffer.alloc(bytes * ch);
    fs.readSync(fd, span, 0, span.length, info.dataStart + firstByte * ch);
    for (let c = 0; c < ch; c++) {
      const own = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i++) own[i] = span[i * ch + c];
      chans.push(own);
    }
  }
  let o = 0;
  for (let f = 0; f < count; f++) {
    const marker = MARKERS[(from + f) & 1];
    for (let c = 0; c < ch; c++) {
      let hi = chans[c][f * 2];
      let lo = chans[c][f * 2 + 1];
      if (info.lsbFirst) { hi = REVERSE[hi]; lo = REVERSE[lo]; } // DoP wants the earliest bit first
      out[o] = lo;
      out[o + 1] = hi;
      out[o + 2] = marker;
      o += 3;
    }
  }
  return out;
}

/**
 * A WAV header for the DoP samples. mpv reads raw PCM only up to 384 kHz, too low for DSD256 as DoP
 * (705.6 kHz); a WAV has no such limit. Past 4 GB a plain WAV can't say its size: that is RF64.
 */
function wavHeader(info, { rf64 = false } = {}) {
  const ch = info.channels;
  const rate = dopRate(info);
  const data = frameCount(info) * ch * 3;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);           // PCM
  fmt.writeUInt16LE(ch, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * ch * 3, 16);
  fmt.writeUInt16LE(ch * 3, 20);
  fmt.writeUInt16LE(24, 22);
  const big = rf64 || data + 36 + 36 > 0xffffffff;
  if (!big) {
    const h = Buffer.alloc(12);
    h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(4 + 24 + 8 + data, 4); h.write('WAVE', 8, 'latin1');
    const d = Buffer.alloc(8); d.write('data', 0, 'latin1'); d.writeUInt32LE(data, 4);
    return Buffer.concat([h, fmt, d]);
  }
  const h = Buffer.alloc(12);
  h.write('RF64', 0, 'latin1'); h.writeUInt32LE(0xffffffff, 4); h.write('WAVE', 8, 'latin1');
  const ds64 = Buffer.alloc(36);
  ds64.write('ds64', 0, 'latin1'); ds64.writeUInt32LE(28, 4);
  ds64.writeBigUInt64LE(BigInt(4 + 36 + 24 + 8 + data), 8); // RIFF size
  ds64.writeBigUInt64LE(BigInt(data), 16);                  // data size
  ds64.writeBigUInt64LE(BigInt(frameCount(info)), 24);      // sample count
  ds64.writeUInt32LE(0, 32);
  const d = Buffer.alloc(8); d.write('data', 0, 'latin1'); d.writeUInt32LE(0xffffffff, 4);
  return Buffer.concat([h, ds64, fmt, d]);
}

// ---------- serving it to mpv
let server = null;
let base = '';
const token = crypto.randomBytes(16).toString('hex');
const files = new Map(); // id -> { path, info }

async function ensureServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    serve(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  base = `http://127.0.0.1:${server.address().port}/${token}/dop/`;
}

async function serve(req, res) {
  const m = new RegExp(`^/${token}/dop/([0-9a-f]+)\\.wav$`).exec(req.url || '');
  const entry = m && files.get(m[1]);
  if (!entry) { res.writeHead(404).end(); return; }
  const { info } = entry;
  const per = bytesPerFrame(info);
  const head = wavHeader(info);
  const size = head.length + frameCount(info) * per;
  let start = 0;
  let end = size - 1;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); } else if (range[2]) start = Math.max(0, size - Number(range[2]));
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
  }
  const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  let left = end - start + 1;
  if (start < head.length) {
    const part = head.subarray(start, Math.min(head.length, end + 1));
    res.write(part);
    left -= part.length;
  }
  const dataStart = Math.max(0, start - head.length);
  const fd = fs.openSync(entry.path, 'r');
  try {
    let frame = Math.floor(dataStart / per);
    let skip = dataStart - frame * per; // a range can begin inside a frame
    const CHUNK = 8192;
    while (left > 0 && !res.destroyed) {
      const n = Math.min(CHUNK, frameCount(info) - frame);
      if (n <= 0) break;
      let buf = readFrames(info, fd, frame, n);
      if (skip) { buf = buf.subarray(skip); skip = 0; }
      if (buf.length > left) buf = buf.subarray(0, left);
      left -= buf.length;
      frame += n;
      if (!res.write(buf)) await new Promise(r => res.once('drain', r));
    }
    res.end();
  } finally { fs.closeSync(fd); }
}

/**
 * The address mpv reads a DSD file from as DoP, with the options that tell it what the bytes are.
 * Null when the file isn't plain DSD.
 */
async function dopSource(file) {
  const info = probe(file);
  if (!info || info.channels > 8) return null;
  await ensureServer();
  const id = crypto.createHash('sha1').update(file).digest('hex').slice(0, 20);
  files.set(id, { path: file, info });
  if (files.size > 64) files.delete(files.keys().next().value);
  const rate = dopRate(info);
  return { url: `${base}${id}.wav`, rate, dsdRate: info.rate, channels: info.channels, options: '' };
}

module.exports = { probe, readFrames, dopRate, frameCount, dopSource, wavHeader, REVERSE, MARKERS };
