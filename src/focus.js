// Focus guard. The pill floats above everything, so when the app you're in closes a window,
// macOS sometimes hands activation to agent-bar — and your typing goes nowhere (seen in the
// debug log: activations with no click and no Space change). When that happens, give focus back
// to the app that had it. Not on a Space change: going back there would switch the Space back.
const { execFile } = require('child_process');
const { log } = require('./debug');

const SETTLE_MS = 300; // the Space notification can come a little after the activation

let previous = null; // { bundle, name } of the last app that was active before us
let lastSpaceChange = 0;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? null : String(out)));
  });
}

// Called on every app activation in the system: remember it unless it's us.
async function rememberFront() {
  const asn = await run('lsappinfo', ['front']);
  if (!asn) return;
  const info = await run('lsappinfo', ['info', '-only', 'bundleid,pid,name', asn.trim()]);
  if (!info) return;
  const get = (key) => (info.match(new RegExp(`"${key}"=("?)([^"\\n]*)\\1`)) || [])[2];
  if (Number(get('pid')) === process.pid) return;
  const bundle = get('CFBundleIdentifier');
  if (bundle) previous = { bundle, name: get('LSDisplayName') || bundle };
}

function spaceChanged() {
  lastSpaceChange = Date.now();
}

// cursorOnUs — at the moment of activation the cursor was over the pill, the open list or the
// tray icon: you clicked us, that's a real activation.
function onActivated(cursorOnUs) {
  if (cursorOnUs) return;
  const at = Date.now();
  setTimeout(() => {
    if (Math.abs(lastSpaceChange - at) < SETTLE_MS * 2) return;
    if (!previous) return;
    log('focus taken without a click -> back to', previous.name);
    execFile('open', ['-b', previous.bundle], () => {});
  }, SETTLE_MS);
}

module.exports = { rememberFront, spaceChanged, onActivated };
