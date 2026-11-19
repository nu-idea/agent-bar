// Codex: one JSONL rollout per session in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
const path = require('path');
const os = require('os');
const { readTailJsonl, readHeadJsonl, safeStat, safeReaddir, shorten } = require('./util');

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

// Rollouts are filed by start date, so a session started yesterday may still be running.
function dayDirs(now, windowMs) {
  const dirs = [];
  const days = Math.ceil(windowMs / (24 * 3600 * 1000)) + 1;
  for (let offset = 0; offset <= days; offset++) {
    const d = new Date(now - offset * 24 * 3600 * 1000);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dirs.push(path.join(ROOT, y, m, day));
  }
  return dirs;
}

function readCodex({ now = Date.now(), windowMs = 30 * 60 * 1000 } = {}) {
  const sessions = [];
  for (const dir of dayDirs(now, windowMs)) {
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const st = safeStat(file);
      if (!st || now - st.mtimeMs > windowMs) continue;

      const head = readHeadJsonl(file);
      const tail = readTailJsonl(file);
      const meta = (head.find((e) => e.type === 'session_meta') || {}).payload || {};

      let status = null;
      let model = null;
      let title = null;
      let used = null;
      let window = null;
      let lastItem = null;

      for (const e of [...head, ...tail]) {
        const p = e.payload || {};
        if (e.type === 'turn_context' && p.model) model = p.model;
        if (e.type === 'event_msg' && p.type === 'user_message' && p.message) title = p.message;
        if (e.type === 'event_msg' && p.type === 'task_started') status = 'working';
        if (e.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) status = 'waiting';
        if (e.type === 'event_msg' && p.type === 'token_count' && p.info) {
          const last = p.info.last_token_usage;
          if (last) used = last.input_tokens;
          if (p.info.model_context_window) window = p.info.model_context_window;
        }
        if (e.type === 'response_item') lastItem = p;
      }
      if (!status) continue;
      const detail = status === 'working' && lastItem && /tool_call$|^function_call$/.test(lastItem.type || '') ? lastItem.name || null : null;

      const cwd = meta.cwd || null;
      sessions.push({
        id: `codex:${meta.id || name}`,
        agent: 'Codex',
        where: meta.originator === 'codex_vscode' ? 'VS Code' : meta.source || null,
        title: shorten(title || (cwd ? path.basename(cwd) : name), 70),
        cwd,
        model,
        status,
        detail,
        lastActivity: st.mtimeMs,
        context: used ? { used, window, kind: 'context' } : null,
        children: [],
      });
    }
  }
  return sessions;
}

module.exports = { readCodex };
