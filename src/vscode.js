// Which VS Code window is in front — without any macOS permission.
// Window titles need Accessibility or Screen Recording, so instead: the window list gives the
// front VS Code window's position and size (no permission needed), and VS Code itself keeps every
// open window's folder and position in its storage.json (saved each time a VS Code window loses
// focus). Same position and size, and only one such window → that's its folder.
// Anything unclear (windows stacked exactly on top of each other, a dialog in front) → null.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STORAGE = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/storage.json');

// The topmost on-screen normal window of that process; tiny strips (tab bar, title bar overlays) skipped.
function frontBounds(pid) {
  const script = `ObjC.import('CoreGraphics');
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
const w = list.find((w) => w.kCGWindowOwnerPID === ${Number(pid)} && w.kCGWindowLayer === 0
  && w.kCGWindowBounds.Width >= 200 && w.kCGWindowBounds.Height >= 200);
JSON.stringify(w ? w.kCGWindowBounds : null);`;
  const b = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 1500, encoding: 'utf8' }));
  return b && { x: b.X, y: b.Y, width: b.Width, height: b.Height };
}

function savedWindows() {
  const state = JSON.parse(fs.readFileSync(STORAGE, 'utf8')).windowsState || {};
  const all = [state.lastActiveWindow, ...(state.openedWindows || [])].filter((w) => w && w.folder && w.uiState);
  const byFolder = new Map();
  for (const w of all) {
    if (!w.folder.startsWith('file://')) continue; // remote windows: no local folder to compare
    byFolder.set(decodeURIComponent(new URL(w.folder).pathname).replace(/\/$/, ''), w.uiState);
  }
  return byFolder;
}

// The folder of the VS Code window in front, or null when it can't be told for sure.
function frontFolder(pid) {
  const b = frontBounds(pid);
  if (!b) return null;
  const same = [...savedWindows()].filter(([, s]) => s.x === b.x && s.y === b.y && s.width === b.width && s.height === b.height);
  return same.length === 1 ? same[0][0] : null;
}

module.exports = { frontFolder };
