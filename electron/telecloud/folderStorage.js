// A folder as TeleCloud storage: a second drive, a NAS share, any path Windows can write to.
// It keeps the same shape as a Telegram chat, numbered objects each with a file and a caption, so
// everything above the worker (the index, covers, the library index, restore, the backup check)
// works the same for both. Runs in the worker process.
//
// Layout of <root> (the folder the user picked, plus "TeleCloud"):
//   <n>.tc        the bytes as stored: encrypted when the caption says so, else the file itself
//   <n>.json      { caption, fileName, size, mime, date }: written last, so a half-written object never shows
//   <n>.tc.part   an upload in progress (or one cut off; old ones are cleaned up)
//   pinned.json   { id } of the library index, like a pinned message
// Numbers are random (2^40 to 2^52, safe as JavaScript numbers) and claimed by creating the .part file
// exclusively. On a NAS the claim is enough; in a folder a sync app copies (OneDrive, Google Drive,
// Dropbox) two computers each see only their own copy, so counting up would make them pick the same
// number and the sync app would keep "conflict" copies; random numbers practically never meet. Since
// numbers say nothing about order, a listing is always the whole folder, oldest first by date.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OBJ = /^(\d+)\.(json|tc|tc\.part)$/;
const STALE_PART_MS = 24 * 3600 * 1000;

const objectPath = (root, id) => path.join(root, `${Number(id)}.tc`);
const metaPath = (root, id) => path.join(root, `${Number(id)}.json`);

function need(root) {
  if (!root) throw new Error('This storage folder is not set');
  if (!fs.existsSync(root)) throw new Error(`The storage folder is not reachable: ${root}`);
}

const newId = () => 2 ** 40 + crypto.randomInt(0, 2 ** 47) * 32 + crypto.randomInt(0, 32);

/** A new number and its .part file, opened for writing */
async function claim(root) {
  need(root);
  for (let tries = 0; tries < 50; tries++) {
    const id = newId();
    if (fs.existsSync(metaPath(root, id)) || fs.existsSync(objectPath(root, id))) continue;
    try {
      const fh = await fs.promises.open(`${objectPath(root, id)}.part`, 'wx');
      return { id, fh, part: `${objectPath(root, id)}.part` };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not claim a number in the storage folder');
}

/** The object is complete: the file under its name, then the caption that makes it visible */
async function commit(root, id, part, { caption, fileName, size, mime }) {
  await fs.promises.rename(part, objectPath(root, id));
  const tmp = `${metaPath(root, id)}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ caption: caption || '', fileName: fileName || '', size, mime: mime || 'application/octet-stream', date: Math.floor(Date.now() / 1000) }));
  await fs.promises.rename(tmp, metaPath(root, id));
  return id;
}

async function meta(root, id) {
  need(root);
  try { return JSON.parse(await fs.promises.readFile(metaPath(root, id), 'utf8')); } catch { return null; }
}

/** Every object, oldest first: { id, caption, size, fileName, date } like a chat's file messages (numbers are random: see the top) */
async function list(root) {
  need(root);
  const out = [];
  const now = Date.now();
  for (const n of await fs.promises.readdir(root)) {
    const m = OBJ.exec(n);
    if (!m) continue;
    const id = Number(m[1]);
    if (m[2] === 'tc.part') {
      // an upload cut off long ago (a crash, a lost connection to the NAS): nothing will finish it
      fs.promises.stat(path.join(root, n)).then(st => { if (now - st.mtimeMs > STALE_PART_MS) fs.promises.rm(path.join(root, n), { force: true }); }).catch(() => {});
      continue;
    }
    if (m[2] !== 'json') continue;
    const info = await meta(root, id);
    if (!info || !fs.existsSync(objectPath(root, id))) continue;
    out.push({ id, caption: info.caption || '', size: Number(info.size) || 0, fileName: info.fileName || '', date: Number(info.date) || 0 });
  }
  return out.sort((a, b) => a.date - b.date || a.id - b.id);
}

/** Bytes [offset, offset + length) of an object, as stored */
async function readRange(root, id, offset, length) {
  need(root);
  const fh = await fs.promises.open(objectPath(root, id), 'r').catch((err) => {
    if (err.code === 'ENOENT') throw new Error('This track is no longer in the storage folder');
    throw err;
  });
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function size(root, id) {
  try { return (await fs.promises.stat(objectPath(root, id))).size; } catch { throw new Error('This track is no longer in the storage folder'); }
}

/** A copy of a stored object (from another storage, bytes as they are) under a new number */
async function putFile(root, src, { caption, fileName, mime }) {
  const { id, fh, part } = await claim(root);
  await fh.close();
  try {
    await fs.promises.copyFile(src, part);
    return await commit(root, id, part, { caption, fileName, size: (await fs.promises.stat(part)).size, mime });
  } catch (err) {
    await fs.promises.rm(part, { force: true });
    throw err;
  }
}

async function remove(root, ids) {
  need(root);
  for (const id of ids) {
    // the caption first: without it the object is gone even if the file can't be removed yet
    await fs.promises.rm(metaPath(root, id), { force: true });
    await fs.promises.rm(objectPath(root, id), { force: true });
  }
  return ids.length;
}

async function pin(root, id) {
  need(root);
  await fs.promises.writeFile(path.join(root, 'pinned.json'), JSON.stringify({ id: Number(id) }));
  return true;
}

module.exports = { claim, commit, meta, list, readRange, size, putFile, remove, pin, objectPath };
