// node-taglib-sharp opens every format TeleCloud tags except DSF. A DSF file keeps one ID3v2 tag after
// its audio, and its header says where, so that one is read and written here.
const fs = require('fs');

const HEADER = 28; // "DSD ", its size, the file's size, where the tag starts

function layout(fd) {
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(HEADER + 12);
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString('latin1', 0, 4) !== 'DSD ' || head.toString('latin1', 28, 32) !== 'fmt ') throw new Error('This is not a DSF file');
  const dataAt = HEADER + Number(head.readBigUInt64LE(32));
  const chunk = Buffer.alloc(12);
  fs.readSync(fd, chunk, 0, 12, dataAt);
  if (chunk.toString('latin1', 0, 4) !== 'data') throw new Error('This DSF file is damaged');
  const audioEnd = dataAt + Number(chunk.readBigUInt64LE(4));
  if (audioEnd > size) throw new Error('This DSF file is damaged');
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

module.exports = { openTags };
