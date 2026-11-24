// Click on a card: bring up the app where the session runs. Readers say where in `s.open`:
//   { app: 'vscode', folder, exact, claudeSession } — the VS Code window of that folder, then the
//       Claude Code session in it (the extension's vscode://anthropic.claude-code/open?session=…)
//   { app: 'claude', link }  — the Claude app on that session (claude://code/continue?session=local_…)
//   { app: 'terminal', pid } / { app: 'terminal', processName, cwd } — the terminal app it runs in
//   { app: 'codex' } / { app: 'hermes' } — just the app
// Nothing here waits for the result: if an app can't open it, the click does nothing.
const { execFile } = require('child_process');
const { projectRoot } = require('./sessions');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? null : String(out)));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk up the parents of a process to the first one inside a .app — the terminal (or VS Code)
// it was started from. "/Applications/Ghostty.app/Contents/MacOS/ghostty" → "/Applications/Ghostty.app".
async function appOfProcess(pid) {
  for (let i = 0; pid > 1 && i < 20; i++) {
    const out = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
    if (!out) return null;
    const m = out.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) return null;
    const app = m[2].match(/^(.*?\.app)\//);
    if (app) return app[1];
    pid = Number(m[1]);
  }
  return null;
}

// A terminal agent without a recorded pid (Codex): its process with the same working folder.
async function findProcess(name, cwd) {
  const out = await run('pgrep', ['-x', name]);
  if (!out) return null;
  for (const pid of out.split('\n').filter(Boolean)) {
    const info = await run('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
    if (info && info.split('\n').includes(`n${cwd}`)) return Number(pid);
  }
  return null;
}

async function openSession(target) {
  if (!target) return;
  switch (target.app) {
    case 'vscode': {
      const folder = target.exact ? target.folder : projectRoot(target.folder);
      // VS Code brings up the window that already has this folder (or opens one).
      if (folder) await run('open', ['-b', 'com.microsoft.VSCode', folder]);
      if (target.claudeSession) {
        await wait(700); // the link goes to the last active window — let the right one come up first
        await run('open', [`vscode://anthropic.claude-code/open?session=${encodeURIComponent(target.claudeSession)}`]);
      }
      return;
    }
    case 'claude':
      await run('open', target.link ? [target.link] : ['-b', 'com.anthropic.claudefordesktop']);
      return;
    case 'terminal': {
      const pid = target.pid || (target.processName && target.cwd ? await findProcess(target.processName, target.cwd) : null);
      const app = pid ? await appOfProcess(pid) : null;
      if (app) await run('open', ['-a', app]);
      return;
    }
    case 'codex':
      await run('open', ['-a', 'Codex']);
      return;
    case 'hermes':
      await run('open', ['-a', 'Hermes']);
      return;
    default:
  }
}

module.exports = { openSession, appOfProcess };
