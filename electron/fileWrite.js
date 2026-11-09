// Writing tags into a file can be refused. Say why in plain words, and let the user decide about
// read-only files (common on music copied from a CD) instead of failing with a system error code.
const fs = require('fs');

function isReadOnly(file) {
  try { return !(fs.statSync(file).mode & 0o200); } catch { return false; }
}

/** { error, readOnly } for showing to the user */
function describeWriteError(err, file) {
  const code = err?.code;
  if (code === 'EPERM' || code === 'EACCES') {
    if (isReadOnly(file)) return { error: 'The file is read-only.', readOnly: true };
    return { error: "Windows refused to change the file. Check the folder's permissions, or Controlled folder access in Windows Security.", readOnly: false };
  }
  if (code === 'EBUSY') return { error: 'Another program is using the file.', readOnly: false };
  if (code === 'ENOSPC') return { error: 'The disk is full.', readOnly: false };
  if (code === 'ENOENT') return { error: 'The file is no longer there.', readOnly: false };
  if (/unsupported format/i.test(err?.message || '')) return { error: "This file type can't hold tags.", readOnly: false };
  return { error: err?.message || 'Unknown error', readOnly: false };
}

/** Run a write; with `allow`, a read-only file is opened up for it and made read-only again after */
function withWritable(file, allow, write) {
  const opened = allow && isReadOnly(file);
  if (opened) fs.chmodSync(file, 0o666);
  try {
    return write();
  } finally {
    if (opened) { try { fs.chmodSync(file, 0o444); } catch { /* keep the write that succeeded */ } }
  }
}

module.exports = { isReadOnly, describeWriteError, withWritable };
