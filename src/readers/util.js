const fs = require('fs');

// Read the last `bytes` of a file and return complete JSON lines (oldest first).
function readTailJsonl(file, bytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably cut
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial line */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readHeadJsonl(file, maxLines = 20, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const out = [];
    for (const line of buf.subarray(0, n).toString('utf8').split('\n').slice(0, maxLines)) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

function shorten(text, n = 60) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { readTailJsonl, readHeadJsonl, safeStat, safeReaddir, shorten };
