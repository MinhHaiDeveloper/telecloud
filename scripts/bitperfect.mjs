// Bit-perfect test: does what mpv hands the output match the file, sample for sample?
//   node scripts/bitperfect.mjs
// Makes noise at 16/44.1, 24/96 and 24/192 (every bit in use), stores it as FLAC, plays it the way TeleCloud
// plays when nothing changes the sound (no filters, volume 100, ReplayGain off) into mpv's PCM output, and
// compares those bytes with the samples it made. Also checks that TeleCloud's sound settings, all off, add no
// filter. Exit 1 on any difference.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MPV = path.join(ROOT, 'mpv.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bitperfect-'));
let failed = 0;

// 1. nothing on in Settings > Sound means no filter at all
const sound = require(path.join(ROOT, 'electron', 'soundChain.js'));
const off = sound.soundFilters(sound.normalizeSound({ warmth: 0, bass: 0, treble: 0, width: 100, channels: 'normal', polarity: 'normal', night: 'off', air: 0, tube: 0 }));
const empty = !off.pre.length && !off.post.length;
console.log(`${empty ? 'PASS' : 'FAIL'}  sound settings all off add no filter`);
if (!empty) failed++;

// 2. the samples through mpv
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
function wav(file, rate, bits, frames) {
  const ch = 2, bytes = bits / 8;
  const buf = Buffer.alloc(44 + frames * ch * bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * ch * bytes, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * bytes, 28); buf.writeUInt16LE(ch * bytes, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * ch * bytes, 40);
  const max = 2 ** (bits - 1);
  const samples = new Int32Array(frames * ch);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-max, Math.min(max - 1, Math.floor((rnd() * 2 - 1) * max * 0.9)));
    samples[i] = v;
    buf.writeIntLE(v, 44 + i * bytes, bytes);
  }
  fs.writeFileSync(file, buf);
  return samples;
}
const mpv = (args) => spawnSync(MPV, ['--no-config', '--no-video', '--really-quiet', ...args], { encoding: 'utf8' });

for (const [rate, bits] of [[44100, 16], [96000, 24], [192000, 24]]) {
  const name = `${bits}-${rate / 1000}`;
  const src = path.join(dir, `${name}.wav`), flac = path.join(dir, `${name}.flac`), out = path.join(dir, `${name}.raw`);
  const samples = wav(src, rate, bits, Math.round(rate * 1.5));
  mpv([src, `--o=${flac}`, '--oac=flac', `--audio-format=${bits === 16 ? 's16' : 's32'}`]);
  // as TeleCloud plays: no filters, volume 100 (the most it allows), ReplayGain off, gapless weak
  const fmt = bits === 16 ? 's16' : 's32';
  mpv([flac, '--af=', '--volume=100', '--volume-max=100', '--replaygain=no', '--gapless-audio=weak', `--audio-format=${fmt}`,
    '--ao=pcm', `--ao-pcm-file=${out}`, '--ao-pcm-waveheader=no']);
  if (!fs.existsSync(out)) { console.log(`FAIL  ${bits}-bit ${rate / 1000} kHz: no output`); failed++; continue; }
  const got = fs.readFileSync(out);
  const width = bits === 16 ? 2 : 4;
  const n = Math.min(samples.length, Math.floor(got.length / width));
  let diff = 0, firstDiff = -1;
  for (let i = 0; i < n; i++) {
    const v = width === 2 ? got.readInt16LE(i * 2) : got.readInt32LE(i * 4) >> 8; // 24-bit arrives in the top of 32
    if (v !== samples[i]) { diff++; if (firstDiff < 0) firstDiff = i; }
  }
  const ok = diff === 0 && n === samples.length;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${bits}-bit ${rate / 1000} kHz: ${n.toLocaleString()} of ${samples.length.toLocaleString()} samples compared, ${diff} different${firstDiff >= 0 ? ` (first at ${firstDiff})` : ''}`);
  // the test itself must notice a change: at volume 99 the samples have to differ
  if (rate === 44100) {
    const out99 = path.join(dir, `${name}-99.raw`);
    mpv([flac, '--af=', '--volume=99', '--volume-max=100', '--replaygain=no', `--audio-format=${fmt}`, '--ao=pcm', `--ao-pcm-file=${out99}`, '--ao-pcm-waveheader=no']);
    const g99 = fs.existsSync(out99) ? fs.readFileSync(out99) : Buffer.alloc(0);
    let changed = 0;
    for (let i = 0; i < Math.min(samples.length, g99.length / 2); i++) if (g99.readInt16LE(i * 2) !== samples[i]) changed++;
    const noticed = changed > samples.length / 2;
    if (!noticed) failed++;
    console.log(`${noticed ? 'PASS' : 'FAIL'}  the test notices a change (volume 99: ${changed.toLocaleString()} samples differ)`);
  }
}

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} check(s) failed: the output is not bit-perfect.`); process.exit(1); }
console.log('\nBit-perfect: every sample came out as it went in.');
