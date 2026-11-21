// Alert sounds: macOS system sounds plus your own files in ~/Library/Sounds.
// A setting holds a sound's name ("Glass", "TD_Default"), a full path to any file, or "" for silence.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const FOLDERS = [
  { group: 'system', dir: '/System/Library/Sounds' },
  { group: 'mine', dir: path.join(os.homedir(), 'Library', 'Sounds') },
];
const EXT = /\.(aiff?|wav|mp3|m4a|caf)$/i;

// [{ name, file, group }], system first. Read every time: a file you drop in shows up at once.
function list() {
  const out = [];
  for (const { group, dir } of FOLDERS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => EXT.test(f)).sort(); } catch { /* no folder */ }
    for (const f of files) out.push({ name: f.replace(EXT, ''), file: path.join(dir, f), group });
  }
  return out;
}

// Setting value → file to play, or null (silence, or nothing found under that name).
function resolve(value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return fs.existsSync(value) ? value : null;
  const found = list().find((s) => s.name === value);
  return found ? found.file : null;
}

// volume 0..1 — afplay's own volume, the Mac's volume is not touched.
function play(value, volume = 1) {
  const file = resolve(value);
  if (!file) return;
  execFile('afplay', ['-v', String(volume), file], () => { /* no sound is not worth an error */ });
}

module.exports = { list, resolve, play };
