const { readClaude } = require('./readers/claude');
const { readCodex } = require('./readers/codex');
const { readHermes } = require('./readers/hermes');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS } = require('./settings');
const { shorten } = require('./readers/util');

const READERS = [readClaude, readCodex, readHermes];

// Which files the readers look at: anything written to recently. Claude Code sessions whose
// process is alive are read regardless of age (a single command can run for hours).
const SCAN_WINDOW_MS = 2 * 60 * 60 * 1000;
// "Working" is never hidden by a timer when we know the process is alive (s.alive === true) —
// a dead one the reader already dropped. When the agent gives no way to check (scripts, Codex,
// Hermes: s.alive === null), a session silent for this long is taken for dead.
const UNKNOWN_SILENT_MS = 2 * 60 * 60 * 1000;
// Script runs (claude -p, SDK) that stopped writing mid-turn were killed or hit a limit; nobody
// watches them, so they go quickly.
const SYSTEM_SILENT_MS = 10 * 60 * 1000;

// Scripts often run in a subfolder of a project (…/youtube/knowledge). Name the project instead:
// the nearest folder up that looks like a project root.
const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];
const projectCache = new Map();
function projectRoot(cwd) {
  if (!cwd) return null;
  if (!projectCache.has(cwd)) {
    let dir = cwd;
    while (dir !== os.homedir() && dir !== path.dirname(dir)) {
      if (ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) break;
      dir = path.dirname(dir);
    }
    projectCache.set(cwd, dir === os.homedir() || dir === path.dirname(dir) ? cwd : dir);
  }
  return projectCache.get(cwd);
}

function projectName(cwd) {
  return path.basename(projectRoot(cwd));
}

// System runs have no title of their own. Call them by a rule from settings, else by their task,
// plus the folder they ran in: "лог сессии · youtube".
function systemTitle(s, rules) {
  const task = s.task || s.title;
  const rule = rules.find((r) => task.toLowerCase().includes(r.match.toLowerCase()));
  const name = rule ? rule.name : shorten(task, 50);
  return s.cwd ? `${name} · ${projectName(s.cwd)}` : name;
}

function collect(settings = DEFAULTS, now = Date.now()) {
  const all = [];
  for (const read of READERS) {
    try {
      all.push(...read({ now, windowMs: Math.max(SCAN_WINDOW_MS, settings.waitingMinutes * 60 * 1000) }));
    } catch (err) {
      console.error(`[agent-bar] ${read.name} failed:`, err.message);
    }
  }
  for (const s of all) if (s.system) s.title = systemTitle(s, settings.systemNames);
  const visible = all.filter((s) => {
    if (s.system && !settings.showSystem) return false;
    const age = now - s.lastActivity;
    if (s.status === 'waiting') return age < settings.waitingMinutes * 60 * 1000;
    return s.alive === true || age < (s.system ? SYSTEM_SILENT_MS : UNKNOWN_SILENT_MS);
  });
  const rank = { asking: 0, waiting: 1, working: 2 };
  visible.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
  return visible;
}

module.exports = { collect, projectName, projectRoot };
