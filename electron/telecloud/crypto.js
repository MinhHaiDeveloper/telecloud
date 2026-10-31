// Client-side encryption for TeleCloud.
//  - Audio: AES-256-CTR. Ciphertext has the same size as the file, and any byte range can be
//    decrypted on its own (needed for streaming and seeking later).
//  - Captions (track info): AES-256-GCM, so tampering or a wrong key is detected.
// One random master key per user; separate sub-keys for files and captions (HKDF). The key is
// shown to the user as a recovery key: without it, encrypted files can't be read anywhere.

const crypto = require('crypto');

const KEY_BYTES = 32;

const newMasterKey = () => crypto.randomBytes(KEY_BYTES);
const subKey = (master, label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `telecloud/${label}`, KEY_BYTES));

/** Short id of a key, stored with every encrypted file so a wrong key is caught before decrypting */
const fingerprint = (master) => crypto.createHmac('sha256', master).update('telecloud/key-check').digest('base64url').slice(0, 11);

// Recovery key: base32-like groups that survive copy/paste and handwriting (no 0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function toRecoveryKey(master) {
  let n = BigInt('0x' + master.toString('hex'));
  let out = '';
  for (let i = 0; i < 52; i++) { out = ALPHABET[Number(n % 31n)] + out; n /= 31n; }
  return out.match(/.{1,4}/g).join('-');
}
function fromRecoveryKey(text) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 52) throw new Error('A recovery key has 52 characters');
  let n = 0n;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`"${ch}" is not used in recovery keys`);
    n = n * 31n + BigInt(v);
  }
  const hex = n.toString(16).padStart(KEY_BYTES * 2, '0');
  if (hex.length > KEY_BYTES * 2) throw new Error('That recovery key is not valid');
  return Buffer.from(hex, 'hex');
}

/** CTR cipher positioned at `offset` bytes into the stream (offset need not be block-aligned) */
function ctrAt(fileKey, iv, offset) {
  const block = BigInt(Math.floor(offset / 16));
  const counter = (BigInt('0x' + iv.toString('hex')) + block) % (1n << 128n);
  const cipher = crypto.createDecipheriv('aes-256-ctr', fileKey, Buffer.from(counter.toString(16).padStart(32, '0'), 'hex'));
  const skip = offset % 16;
  if (skip) cipher.update(Buffer.alloc(skip));
  return cipher;
}
/** Encrypt or decrypt (same operation in CTR) a chunk that starts at `offset` */
const ctrChunk = (fileKey, iv, offset, chunk) => ctrAt(fileKey, iv, offset).update(chunk);

function sealJson(master, obj) {
  const key = subKey(master, 'caption');
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64url');
}
function openJson(master, sealed) {
  const raw = Buffer.from(sealed, 'base64url');
  const key = subKey(master, 'caption');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
}

module.exports = { newMasterKey, subKey, fingerprint, toRecoveryKey, fromRecoveryKey, ctrChunk, ctrAt, sealJson, openJson };
