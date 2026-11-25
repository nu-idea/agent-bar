// Focus guard. The pill floats above everything, so when the app you're in closes a window,
// macOS sometimes hands activation to agent-bar — and your typing goes nowhere (seen in the
// debug log: activations with no click and no Space change). When that happens, give focus back
// to the app that had it. Not on a Space change: going back there would switch the Space back.
const { execFile } = require('child_process');
const { log } = require('./debug');

const SETTLE_MS = 300; // the Space notification can come a little after the activation

let previous = null; // { bundle, name, at } of the last app that was active before us
let front = null; // { bundle, path, pid } of the app in front right now, us included
let lastSpaceChange = 0;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? null : String(out)));
  });
}

// The app in front right now: { bundle, name, path, pid }, or null.
async function queryFront() {
  const asn = await run('lsappinfo', ['front']);
  if (!asn) return null;
  const info = await run('lsappinfo', ['info', '-only', 'bundleid,pid,name,bundlepath', asn.trim()]);
  if (!info) return null;
  const get = (key) => (info.match(new RegExp(`"${key}"=("?)([^"\\n]*)\\1`)) || [])[2];
  const bundle = get('CFBundleIdentifier') || null;
  return { bundle, name: get('LSDisplayName') || bundle, path: get('LSBundlePath') || null, pid: Number(get('pid')) };
}

// Called on every app activation in the system: remember it unless it's us.
async function rememberFront() {
  const app = await queryFront();
  if (!app) return;
  front = { bundle: app.bundle, path: app.path, pid: app.pid };
  if (app.pid === process.pid) return;
  if (app.bundle) previous = { bundle: app.bundle, name: app.name, at: Date.now() };
}

// That process has a normal window on the Space you're on now. The window list needs no macOS
// permission (same as vscode.js).
async function hasWindowHere(pid) {
  const script = `ObjC.import('CoreGraphics');
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
list.some((w) => w.kCGWindowOwnerPID === ${Number(pid)} && w.kCGWindowLayer === 0
  && w.kCGWindowBounds.Width >= 200 && w.kCGWindowBounds.Height >= 200);`;
  const out = await run('osascript', ['-l', 'JavaScript', '-e', script]);
  return out !== null && out.trim() === 'true';
}

// Seen 25.11: VS Code has windows on two Spaces. You switch between them, VS Code stays active,
// macOS sends no activation — so previous.at stays older than the Space change, previousHere()
// says "on another Space", focus isn't given back after a pill click, and macOS jumps Space.
// After a Space change: if the app in front has a window right here, it is here.
async function spaceChanged() {
  const at = Date.now();
  lastSpaceChange = at;
  const app = await queryFront();
  if (!app || !app.bundle || app.pid === process.pid) return;
  const here = await hasWindowHere(app.pid);
  if (lastSpaceChange !== at) return; // switched again meanwhile
  log(`  [space] ${app.name} ${here ? 'has a window here' : 'has no window here'}`);
  if (here) previous = { bundle: app.bundle, name: app.name, at: Date.now() };
}

// cursorOnUs — at the moment of activation the cursor was over the pill, the open list or the
// tray icon: you clicked us, that's a real activation.
function onActivated(cursorOnUs) {
  if (cursorOnUs) return;
  const at = Date.now();
  setTimeout(() => {
    if (Math.abs(lastSpaceChange - at) < SETTLE_MS * 2) return;
    if (!previousHere()) return;
    log('focus taken without a click -> back to', previous.name);
    execFile('open', ['-b', previous.bundle], () => {});
  }, SETTLE_MS);
}

// That app is on another Space if the Space changed after it became active (you moved to a
// desktop where nothing else got activated) — handing focus to it would switch the Space back.
function previousHere() {
  return previous && !(lastSpaceChange - previous.at > 1000);
}

// Right now: a click on the pill made agent-bar active (seen 23.11: showing the list while
// agent-bar is active makes macOS jump to another Space). Returns false if there's nowhere to go.
function giveBack(reason) {
  if (!previousHere()) return false;
  log(`give focus back (${reason}) ->`, previous.name);
  execFile('open', ['-b', previous.bundle], () => {});
  return true;
}

function frontApp() {
  return front;
}

module.exports = { rememberFront, spaceChanged, onActivated, giveBack, frontApp };
