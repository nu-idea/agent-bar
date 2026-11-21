// Diagnostic log for the "jumps to another screen" bug: clicks, panel show/hide/blur, which
// display and which app was in front, slow polls. ~/Library/Logs/agent-bar.log, cut at 1 MB.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const FILE = path.join(os.homedir(), 'Library', 'Logs', 'agent-bar.log');
const MAX = 1024 * 1024;

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function log(...parts) {
  const line = `${stamp()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX) fs.writeFileSync(FILE, '');
    fs.appendFileSync(FILE, line);
  } catch { /* logging must never break the widget */ }
}

// The app in front right now (async — logged when it answers, tagged with the event it belongs to).
function logFrontApp(tag) {
  execFile('lsappinfo', ['front'], { timeout: 2000 }, (err, asn) => {
    if (err) return log(`  [${tag}] front app: ?`);
    execFile('lsappinfo', ['info', '-only', 'name', String(asn).trim()], { timeout: 2000 }, (err2, out) => {
      const m = !err2 && String(out).match(/"LSDisplayName"="([^"]*)"/);
      log(`  [${tag}] front app:`, m ? m[1] : '?');
    });
  });
}

module.exports = { log, logFrontApp, FILE };
