// TeleCloud worker: runs in its own process (Electron utilityProcess) and does everything that
// talks to Telegram. MTProto encryption and file transfer are CPU-heavy, so keeping them here
// keeps the UI smooth. The main process sends { id, method, params } and gets { id, result } or
// { id, error } back; progress arrives as { event, data }.
//
// Files move in 512 KB parts straight between disk and Telegram (never a whole file in memory),
// optionally encrypted on the fly with AES-256-CTR.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { subKey, ctrChunk } = require('./crypto');
const { createStreamer } = require('./stream');
const folder = require('./folderStorage');

// A storage is a Telegram chat or a folder (folderStorage.js); every call below takes either
const isFolder = (peer) => peer?.kind === 'folder';

const PART = 512 * 1024;
const BIG_FILE = 10 * 1024 * 1024;   // Telegram: bigger files use the "big file" upload calls
const MAX_PARTS = 4000;              // 4000 × 512 KB = 2000 MB (Telegram's limit without Premium)

function loadTelegram() {
  // Tests swap in a fake client; the real one is GramJS
  if (process.env.TELECLOUD_FAKE_CLIENT) return require(process.env.TELECLOUD_FAKE_CLIENT);
  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const { Api } = require('telegram/tl');
  const { computeCheck } = require('telegram/Password');
  return { TelegramClient, StringSession, Api, computeCheck };
}

function createWorker(emit) {
  const tg = loadTelegram();
  const { Api } = tg;
  const bigInt = require('big-integer');
  let client = null;
  let master = null;
  const cancelled = new Set();
  let streamer = null;
  const streams = () => (streamer ||= createStreamer({ client: need, peerOf: (p) => peerOf(p), master: () => master, bigInt, folder }, emit));
  const tmpFile = (tag) => path.join(require('os').tmpdir(), 'telecloud', `tc-${tag}-${crypto.randomBytes(6).toString('hex')}`);

  /** How a login code came: app (another signed-in Telegram), sms, call, flashCall, missedCall, email, ... */
  const codeWay = (type) => (type ? String(type.className || '').replace(/^auth\.SentCodeType/, '').replace(/^./, c => c.toLowerCase()) || 'unknown' : null);
  const sentCode = (r) => {
    if (r instanceof Api.auth.SentCodeSuccess) throw new Error('Signed in already');
    return { phoneCodeHash: r.phoneCodeHash, via: codeWay(r.type), next: codeWay(r.nextType), timeout: r.timeout || null, viaApp: r.type instanceof Api.auth.SentCodeTypeApp };
  };

  const newClient = (session, apiId, apiHash) => new tg.TelegramClient(new tg.StringSession(session || ''), Number(apiId), apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    floodSleepThreshold: 120, // wait out FLOOD_WAIT up to 2 minutes by itself
  });
  const need = () => { if (!client) throw new Error('Not connected to Telegram'); return client; };
  const peerOf = (p) => {
    if (!p || p.kind === 'self') return new Api.InputPeerSelf();
    return new Api.InputPeerChannel({ channelId: bigInt(String(p.id)), accessHash: bigInt(String(p.accessHash)) });
  };
  const randomLong = () => bigInt(crypto.randomBytes(8).readBigInt64LE().toString());

  // Upload speed cap shared by all parts of a transfer (bytes per second; 0 = unlimited)
  const bucket = (rate) => {
    let allowance = rate;
    let last = Date.now();
    return async (n) => {
      if (!rate) return;
      for (;;) {
        const now = Date.now();
        allowance = Math.min(rate, allowance + ((now - last) / 1000) * rate);
        last = now;
        if (allowance >= n || allowance >= rate) { allowance -= n; return; }
        await new Promise(r => setTimeout(r, Math.ceil(((n - allowance) / rate) * 1000)));
      }
    };
  };

  const messageIdFrom = (updates, randomId) => {
    const list = updates?.updates || (updates?.update ? [updates.update] : []);
    for (const u of list) {
      if ((u.className === 'UpdateNewChannelMessage' || u.className === 'UpdateNewMessage') && u.message?.id) return u.message.id;
    }
    const byRandom = list.find(u => u.className === 'UpdateMessageID' && String(u.randomId) === String(randomId));
    if (byRandom) return byRandom.id;
    if (updates?.id) return updates.id; // UpdateShortSentMessage
    throw new Error('Telegram did not return the new message');
  };

  // ---- folders (folderStorage.js): the same parts and the same encryption as an upload to Telegram

  async function uploadToFolder({ jobId, path: file, peer, fileName, mimeType, caption, iv, rateBytes = 0 }) {
    const size = (await fs.promises.stat(file)).size;
    if (iv && !master) throw new Error('Encryption key is missing');
    const fileKey = iv ? subKey(master, 'file') : null;
    const ivBuf = iv ? Buffer.from(iv, 'base64') : null;
    const take = bucket(rateBytes);
    const { id, fh: out, part } = await folder.claim(peer.root);
    const src = await fs.promises.open(file, 'r');
    let lastEmit = 0;
    try {
      for (let offset = 0; offset < size;) {
        if (cancelled.has(jobId)) throw new Error('CANCELLED');
        const length = Math.min(PART, size - offset);
        const buf = Buffer.alloc(length);
        await src.read(buf, 0, length, offset);
        const bytes = fileKey ? ctrChunk(fileKey, ivBuf, offset, buf) : buf;
        await take(length);
        await out.write(bytes, 0, bytes.length, offset);
        offset += length;
        const now = Date.now();
        if (now - lastEmit > 200 || offset === size) { lastEmit = now; emit('progress', { jobId, bytes: offset, size }); }
      }
      await out.close();
    } catch (err) {
      await out.close().catch(() => {});
      await fs.promises.rm(part, { force: true });
      throw err;
    } finally {
      await src.close();
    }
    await folder.commit(peer.root, id, part, { caption, fileName, size, mime: mimeType });
    return { messageId: id, size };
  }

  async function* folderChunks(root, id, size) {
    for (let offset = 0; offset < size; offset += PART) yield await folder.readRange(root, id, offset, Math.min(PART, size - offset));
  }

  /** One stored object into another storage, bytes as they are (see forward) */
  async function copyObject(fromPeer, toPeer, id) {
    let src;
    let meta;
    let tmp = null;
    if (isFolder(fromPeer)) {
      meta = await folder.meta(fromPeer.root, id);
      if (!meta) throw new Error('This track is no longer in the storage folder');
      src = folder.objectPath(fromPeer.root, id);
    } else {
      const [msg] = await need().getMessages(peerOf(fromPeer), { ids: [Number(id)] });
      const doc = msg?.media?.document;
      if (!doc) throw new Error('This track is no longer in the Telegram chat');
      const nameAttr = (doc.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
      meta = { caption: msg.message || '', fileName: nameAttr?.fileName || '', mime: doc.mimeType || 'application/octet-stream' };
      tmp = tmpFile('copy');
      await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
      const out = await fs.promises.open(tmp, 'w');
      try {
        let offset = 0;
        for await (const chunk of client.iterDownload({ file: msg.media, requestSize: PART, fileSize: bigInt(Number(doc.size)), dcId: doc.dcId })) {
          await out.write(chunk, 0, chunk.length, offset);
          offset += chunk.length;
          if (offset >= Number(doc.size)) break;
        }
      } finally { await out.close(); }
      src = tmp;
    }
    try {
      if (isFolder(toPeer)) return await folder.putFile(toPeer.root, src, meta);
      // already encrypted (or plain) as stored: sent without encrypting again
      const r = await handlers.upload({ jobId: `copy-${id}-${Date.now()}`, path: src, peer: toPeer, fileName: meta.fileName, mimeType: meta.mime, caption: meta.caption, iv: null });
      return r.messageId;
    } finally {
      if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }

  const handlers = {
    async connect({ apiId, apiHash, session, masterKey }) {
      if (client) { try { await client.disconnect(); } catch { /* already closed */ } }
      client = newClient(session, apiId, apiHash);
      await client.connect();
      master = masterKey ? Buffer.from(masterKey, 'base64') : null;
      const me = await client.getMe();
      return { userId: String(me.id), username: me.username || null, phone: me.phone || null };
    },

    setKey({ masterKey }) { master = masterKey ? Buffer.from(masterKey, 'base64') : null; return true; },

    // A login code. Telegram says how it sent it (type), how a resend would come (nextType) and after how many
    // seconds a resend may be asked for (timeout). Asking again goes through resendCode on the same request:
    // a fresh sendCode starts over, and Telegram may quietly stop sending codes to a number asked too often.
    async sendCode({ apiId, apiHash, phone }) {
      if (client) { try { await client.disconnect(); } catch { /* ignore */ } }
      client = newClient('', apiId, apiHash);
      await client.connect();
      const ask = () => client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId: Number(apiId), apiHash, settings: new Api.CodeSettings({}) }));
      let r;
      try { r = await ask(); } catch (err) { if (/AUTH_RESTART/.test(err.errorMessage || err.message || '')) r = await ask(); else throw err; }
      return sentCode(r);
    },

    async resendCode({ phone, phoneCodeHash }) {
      return sentCode(await need().invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash })));
    },

    async signIn({ phone, phoneCodeHash, code }) {
      try {
        await need().invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: String(code) }));
      } catch (err) {
        if (/SESSION_PASSWORD_NEEDED/.test(err.message || err.errorMessage || '')) return { passwordNeeded: true };
        throw err;
      }
      return { session: client.session.save() };
    },

    // Two-step verification (cloud password)
    async checkPassword({ password }) {
      const info = await need().invoke(new Api.account.GetPassword());
      const check = await tg.computeCheck(info, password);
      await client.invoke(new Api.auth.CheckPassword({ password: check }));
      return { session: client.session.save() };
    },

    /** Reuse a TeleCloud channel this account created before, or make a new one */
    async ensureChannel({ title, about }) {
      const dialogs = await need().getDialogs({ limit: 500 });
      const found = dialogs.map(d => d.entity).find(e => e && e.className === 'Channel' && e.creator && !e.megagroup && e.title === title);
      if (found) return { id: String(found.id), accessHash: String(found.accessHash), title: found.title, reused: true };
      const res = await client.invoke(new Api.channels.CreateChannel({ title, about, broadcast: true, megagroup: false }));
      const ch = res.chats[0];
      return { id: String(ch.id), accessHash: String(ch.accessHash), title: ch.title, reused: false };
    },

    /** Channels and supergroups this account owns or can post to (candidates for storage) */
    async listChats() {
      const dialogs = await need().getDialogs({ limit: 500 });
      return dialogs.map(d => d.entity)
        .filter(e => e && e.className === 'Channel' && (e.creator || e.adminRights?.postMessages || (e.megagroup && e.adminRights)))
        .map(e => ({ id: String(e.id), accessHash: String(e.accessHash), title: e.title, kind: e.megagroup ? 'group' : 'channel' }));
    },

    /** A new private channel (always new, unlike ensureChannel) */
    async createChannel({ title, about }) {
      const res = await need().invoke(new Api.channels.CreateChannel({ title, about: about || '', broadcast: true, megagroup: false }));
      const ch = res.chats[0];
      return { id: String(ch.id), accessHash: String(ch.accessHash), title: ch.title };
    },

    async renameChat({ peer, title }) {
      if (isFolder(peer)) return true; // a folder's name in TeleCloud is only its title in the database
      await need().invoke(new Api.channels.EditTitle({ channel: peerOf(peer), title }));
      return true;
    },

    /**
     * Copy objects to another storage; returns the new ids in order. Between two Telegram chats, Telegram
     * copies them itself (no re-upload). With a folder on either side, the stored bytes move as they are:
     * an encrypted file stays encrypted with the same key and IV, so its caption still fits it.
     */
    async forward({ fromPeer, toPeer, ids }) {
      if (isFolder(fromPeer) || isFolder(toPeer)) {
        const out = [];
        for (const id of ids) out.push(await copyObject(fromPeer, toPeer, id));
        return out;
      }
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100).map(Number);
        const randomIds = chunk.map(() => randomLong());
        const updates = await need().invoke(new Api.messages.ForwardMessages({
          fromPeer: peerOf(fromPeer), toPeer: peerOf(toPeer), id: chunk, randomId: randomIds, dropAuthor: true, silent: true,
        }));
        const list = updates?.updates || [];
        for (const r of randomIds) {
          const u = list.find(x => x.className === 'UpdateMessageID' && String(x.randomId) === String(r));
          out.push(u ? u.id : null);
        }
      }
      if (out.some(x => !x)) throw new Error('Telegram did not confirm every forwarded message');
      return out;
    },

    /** Look up a channel by id in the dialog list (older setups only saved the id) */
    async findChannel({ id }) {
      const dialogs = await need().getDialogs({ limit: 500 });
      const ch = dialogs.map(d => d.entity).find(e => e && e.className === 'Channel' && String(e.id) === String(id).replace(/^-100/, ''));
      return ch ? { id: String(ch.id), accessHash: String(ch.accessHash), title: ch.title } : null;
    },

    async hashFile({ path: file }) {
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        fs.createReadStream(file, { highWaterMark: 1024 * 1024 }).on('data', d => hash.update(d)).on('end', resolve).on('error', reject);
      });
      return { sha256: hash.digest('hex') };
    },

    async upload(params) {
      const { jobId, path: file, peer, fileName, mimeType, caption, iv, rateBytes = 0, workers = 4 } = params;
      if (isFolder(peer)) return uploadToFolder(params);
      need();
      const size = (await fs.promises.stat(file)).size;
      const parts = Math.max(1, Math.ceil(size / PART));
      if (parts > MAX_PARTS) throw new Error('File is larger than 2000 MB, the Telegram limit');
      if (iv && !master) throw new Error('Encryption key is missing');
      const fileKey = iv ? subKey(master, 'file') : null;
      const ivBuf = iv ? Buffer.from(iv, 'base64') : null;
      const big = size > BIG_FILE;
      const fileId = randomLong();
      const take = bucket(rateBytes);
      const fh = await fs.promises.open(file, 'r');
      let next = 0;
      let sent = 0;
      let lastEmit = 0;
      try {
        const worker = async () => {
          while (next < parts) {
            if (cancelled.has(jobId)) throw new Error('CANCELLED');
            const index = next++;
            const offset = index * PART;
            const length = Math.min(PART, size - offset);
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, offset);
            const bytes = fileKey ? ctrChunk(fileKey, ivBuf, offset, buf) : buf;
            await take(length);
            await client.invoke(big
              ? new Api.upload.SaveBigFilePart({ fileId, filePart: index, fileTotalParts: parts, bytes })
              : new Api.upload.SaveFilePart({ fileId, filePart: index, bytes }));
            sent += length;
            const now = Date.now();
            if (now - lastEmit > 200 || sent === size) { lastEmit = now; emit('progress', { jobId, bytes: sent, size }); }
          }
        };
        await Promise.all(Array.from({ length: Math.min(workers, parts) }, worker));
      } finally {
        await fh.close();
      }
      if (cancelled.has(jobId)) throw new Error('CANCELLED');
      const inputFile = big
        ? new Api.InputFileBig({ id: fileId, parts, name: fileName })
        : new Api.InputFile({ id: fileId, parts, name: fileName, md5Checksum: '' });
      const randomId = randomLong();
      const updates = await client.invoke(new Api.messages.SendMedia({
        peer: peerOf(peer),
        media: new Api.InputMediaUploadedDocument({
          file: inputFile,
          mimeType: mimeType || 'application/octet-stream',
          attributes: [new Api.DocumentAttributeFilename({ fileName })],
          forceFile: true,
        }),
        message: caption || '',
        randomId,
      }));
      return { messageId: messageIdFrom(updates, randomId), size };
    },

    async download({ jobId, peer, messageId, targetPath, iv, sha256 }) {
      let size;
      let chunks;
      if (isFolder(peer)) {
        size = await folder.size(peer.root, messageId);
        chunks = folderChunks(peer.root, messageId, size);
      } else {
        const [msg] = await need().getMessages(peerOf(peer), { ids: [Number(messageId)] });
        const doc = msg?.media?.document;
        if (!doc) throw new Error('This track is no longer in the Telegram chat');
        size = Number(doc.size);
        chunks = client.iterDownload({ file: msg.media, requestSize: PART, fileSize: bigInt(size), dcId: doc.dcId });
      }
      if (iv && !master) throw new Error('This track is encrypted: enter your recovery key first');
      const fileKey = iv ? subKey(master, 'file') : null;
      const ivBuf = iv ? Buffer.from(iv, 'base64') : null;
      const part = `${targetPath}.dl.part`;
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      const out = await fs.promises.open(part, 'w');
      const hash = crypto.createHash('sha256');
      let offset = 0;
      let lastEmit = 0;
      try {
        for await (const chunk of chunks) {
          if (cancelled.has(jobId)) throw new Error('CANCELLED');
          const plain = fileKey ? ctrChunk(fileKey, ivBuf, offset, chunk) : chunk;
          hash.update(plain);
          await out.write(plain, 0, plain.length, offset);
          offset += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 200 || offset >= size) { lastEmit = now; emit('progress', { jobId, bytes: offset, size }); }
          if (offset >= size) break;
        }
      } catch (err) {
        await out.close();
        await fs.promises.rm(part, { force: true });
        throw err;
      }
      await out.close();
      const got = hash.digest('hex');
      if (offset !== size || (sha256 && got !== sha256)) {
        await fs.promises.rm(part, { force: true });
        throw new Error(iv ? 'Downloaded data does not match: wrong recovery key or a damaged upload' : 'Downloaded data does not match the original (checksum)');
      }
      await fs.promises.rename(part, targetPath);
      return { path: targetPath, size, sha256: got };
    },

    // ---- streaming (see stream.js) ----
    openStream(params) { if (!isFolder(params.peer)) need(); return streams().open(params); },
    closeStream(params) { return streamer ? streamer.close(params) : true; },
    streamStatus(params) { return streamer ? streamer.status(params) : null; },
    speedTest(params) { if (!isFolder(params.peer)) need(); return streams().speedTest(params); },

    cancel({ jobId }) { cancelled.add(jobId); return true; },
    forget({ jobId }) { cancelled.delete(jobId); return true; },

    /** File messages newer than minId, oldest first: { id, caption, size, fileName, date } */
    async listMessages({ peer, minId = 0 }) {
      if (isFolder(peer)) return folder.list(peer.root); // a folder is listed whole: its numbers are random
      const out = [];
      for await (const m of need().iterMessages(peerOf(peer), { minId: Number(minId) || 0, reverse: true })) {
        const doc = m.media?.document;
        if (!doc) continue;
        const nameAttr = (doc.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
        out.push({ id: m.id, caption: m.message || '', size: Number(doc.size), fileName: nameAttr?.fileName || '', date: m.date });
        if (out.length % 500 === 0) emit('list-progress', { count: out.length });
      }
      return out;
    },

    /**
     * Pin a message (the library manifest) without notifying anyone, then delete the
     * "… pinned a message" notice Telegram posts for it, plus any older ones left in the chat
     */
    async pin({ peer, id }) {
      if (isFolder(peer)) return folder.pin(peer.root, id);
      const p = peerOf(peer);
      const res = await need().invoke(new Api.messages.UpdatePinnedMessage({ peer: p, id: Number(id), silent: true }));
      const isPinNotice = (m) => m?.className === 'MessageService' && m.action?.className === 'MessageActionPinMessage';
      const notices = new Set((res?.updates || []).map(u => u.message).filter(isPinNotice).map(m => m.id));
      try {
        for await (const m of need().iterMessages(p, { limit: 30 })) if (isPinNotice(m)) notices.add(m.id);
      } catch { /* cleanup only */ }
      if (notices.size) await need().deleteMessages(p, [...notices], { revoke: true }).catch(() => {});
      return true;
    },

    async deleteMessages({ peer, ids }) {
      if (isFolder(peer)) {
        await folder.remove(peer.root, ids);
        emit('delete-progress', { done: ids.length, total: ids.length });
        return { deleted: ids.length };
      }
      let done = 0;
      for (let i = 0; i < ids.length; i += 100) {
        await need().deleteMessages(peerOf(peer), ids.slice(i, i + 100), { revoke: true });
        done += Math.min(100, ids.length - i);
        emit('delete-progress', { done, total: ids.length });
      }
      return { deleted: done };
    },

    /** How many days Telegram keeps a sign-in nobody uses (Settings > Devices > Automatically terminate old sessions) */
    async sessionTtl() {
      const r = await need().invoke(new Api.account.GetAuthorizations());
      return { days: Number(r.authorizationTtlDays) || null };
    },

    async disconnect() {
      if (client) { try { await client.disconnect(); } catch { /* ignore */ } }
      client = null;
      return true;
    },
  };

  return async ({ id, method, params }) => {
    const fn = handlers[method];
    try {
      if (!fn) throw new Error(`Unknown method ${method}`);
      return { id, result: await fn(params || {}) };
    } catch (err) {
      const message = err?.errorMessage || err?.message || String(err);
      const seconds = /FLOOD_WAIT/.test(message) ? err.seconds || Number((message.match(/\d+/) || [])[0]) || null : null;
      return { id, error: message, floodWait: seconds };
    }
  };
}

// Running as a utilityProcess: wire the handler to the parent port
if (process.parentPort) {
  const run = createWorker((event, data) => process.parentPort.postMessage({ event, data }));
  process.parentPort.on('message', async (e) => process.parentPort.postMessage(await run(e.data)));
}

module.exports = { createWorker, PART };
