// Claude Code: one JSONL transcript per session in ~/.claude/projects/<project>/<sessionId>.jsonl
// Subagents: ~/.claude/projects/<project>/<sessionId>/subagents/agent-*.jsonl (+ .meta.json)
//
// Status is binary on purpose:
//   working — from your message until the model's final answer. Inside, Claude loops
//             "think → call a tool → get the result" every few seconds; that's all "working".
//   waiting — the last answer ended the turn (stop_reason end_turn) and nothing came after:
//             it won't do anything until you write. Same after you interrupt it.
// A finished turn with subagents still running counts as working.
//
// Alive or dead: Claude Code keeps ~/.claude/sessions/<pid>.json for every open interactive
// session. If the session isn't there or its process is gone, it was closed or crashed —
// a "working" transcript of such a session is not shown (no timers needed).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { readTailJsonl, safeStat, safeReaddir, shorten } = require('./util');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const REGISTRY = path.join(os.homedir(), '.claude', 'sessions');

const WHERE = {
  'claude-vscode': 'VS Code',
  'claude-desktop': 'приложение',
  cli: 'терминал',
  'sdk-cli': 'скрипт',
  'sdk-ts': 'скрипт',
  'sdk-py': 'скрипт',
};

// Titles appear only now and then in the file; remember the best one seen per session
// so the card doesn't flip between a title and the folder name.
const titleCache = new Map();

// sessionIds of interactive sessions whose process is running. null = no registry (older Claude Code).
function liveSessions() {
  const names = safeReaddir(REGISTRY);
  if (!names.length && !safeStat(REGISTRY)) return null;
  const live = new Set();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(REGISTRY, name), 'utf8')); } catch { continue; }
    if (!info.sessionId || !info.pid) continue;
    try {
      process.kill(info.pid, 0); // signal 0: only checks the process exists
      live.add(info.sessionId);
    } catch (err) {
      if (err.code === 'EPERM') live.add(info.sessionId); // exists, just not ours
    }
  }
  return live;
}

// Reading the tail of every recent transcript every 2 s is wasteful; reuse it while the file is unchanged.
const tailCache = new Map(); // file -> { key, entries }
function readTailCached(file, st, bytes) {
  const key = `${st.mtimeMs}:${st.size}:${bytes}`;
  const hit = tailCache.get(file);
  if (hit && hit.key === key) return hit.entries;
  const entries = readTailJsonl(file, bytes);
  tailCache.set(file, { key, entries });
  return entries;
}

function contentOf(entry) {
  const c = entry.message && entry.message.content;
  return Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
}

function isTurnEnd(entry) {
  const reason = entry.message && entry.message.stop_reason;
  return reason === 'end_turn' || reason === 'stop_sequence' || reason === 'max_tokens';
}

function userText(entry) {
  return contentOf(entry).map((b) => b.text || '').join(' ').trim();
}

// User-typed entries that don't make the model do anything: the compaction summary,
// meta notes, and local slash commands like /compact (recorded with a "caveat" meta entry
// right before them, and their output after).
function isSilentUserEntry(entries, i) {
  const e = entries[i];
  if (e.isMeta || e.isCompactSummary) return true;
  const text = userText(e);
  if (/^<local-command-(stdout|stderr)>/.test(text)) return true;
  if (/^<command-name>/.test(text)) {
    for (let j = i - 1; j >= 0; j--) {
      const p = entries[j];
      if (p.type !== 'user') continue;
      return Boolean(p.isMeta && /local-command-caveat/.test(userText(p)));
    }
  }
  return false;
}

// Walk back to the last real conversation step.
function turnState(entries) {
  let lastSilent = null; // e.g. a /compact after the answer: "waiting" counts from there
  const waitingSince = (e) => Math.max(Date.parse(e.timestamp) || 0, lastSilent || 0) || null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.isSidechain) continue;
    if (e.type === 'user' && isSilentUserEntry(entries, i)) {
      if (lastSilent === null) lastSilent = Date.parse(e.timestamp) || null;
      continue;
    }
    if (e.type === 'assistant') {
      if (isTurnEnd(e)) return { status: 'waiting', since: waitingSince(e) };
      const tool = contentOf(e).filter((b) => b.type === 'tool_use').pop();
      return { status: 'working', detail: tool ? tool.name : null };
    }
    if (e.type === 'user') {
      if (/Request interrupted by user/.test(userText(e))) return { status: 'waiting', since: waitingSince(e) };
      return { status: 'working', detail: null };
    }
  }
  return null;
}

// Context size = input of the last answer. If the conversation was compacted after that
// answer, the old number is wrong and the new one is unknown until the model answers again.
function lastUsage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const before = e.compactMetadata && e.compactMetadata.preTokens;
      return { used: null, model: null, compactedFrom: before || null };
    }
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const u = e.message && e.message.usage;
    if (!u) continue;
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return { used, model: e.message.model || null };
  }
  return { used: null, model: null };
}

// The transcript doesn't record the window size. Known for sure only when the model says [1m]
// or the session already went past 200k. Otherwise unknown — the UI then shows raw tokens.
function contextWindow(model, used) {
  if (model && model.includes('[1m]')) return 1_000_000;
  if (used && used > 200_000) return 1_000_000;
  return null;
}

function titleFrom(entries) {
  let custom = null;
  let ai = null;
  let name = null;
  let prompt = null;
  for (const e of entries) {
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) ai = e.aiTitle;
    if (e.type === 'agent-name' && e.agentName) name = e.agentName;
    if (e.type === 'last-prompt' && e.lastPrompt) prompt = e.lastPrompt;
  }
  return { strong: custom || ai || name, weak: prompt };
}

function stableTitle(sessionId, entries, fallback) {
  const { strong, weak } = titleFrom(entries);
  const cached = titleCache.get(sessionId);
  if (strong) titleCache.set(sessionId, { text: strong, strong: true });
  else if (weak && !(cached && cached.strong)) titleCache.set(sessionId, { text: weak, strong: false });
  const t = titleCache.get(sessionId);
  return t ? t.text : fallback;
}

// Background commands (Bash with run_in_background): started when a tool result says
// "running in background with ID: X", finished when a <task-notification> for X arrives.
// Whatever is started and not finished is still running — the agent will react when it ends.
function backgroundTasks(entries) {
  const descriptions = new Map(); // tool_use id -> description
  const started = new Map(); // task id -> description
  const finished = new Set();
  for (const e of entries) {
    if (e.isSidechain) continue;
    for (const b of contentOf(e)) {
      if (e.type === 'assistant' && b.type === 'tool_use' && b.input) {
        descriptions.set(b.id, b.input.description || b.input.command || b.name);
      }
      if (e.type === 'user' && b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join(' ');
        const m = /running in background with ID: ([\w-]+)/.exec(text);
        if (m) started.set(m[1], descriptions.get(b.tool_use_id) || 'фоновая команда');
      }
      if (e.type === 'user' && b.type === 'text' && b.text && b.text.includes('<task-notification>')) {
        const re = /<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g;
        let n;
        while ((n = re.exec(b.text))) if (n[2] !== 'running') finished.add(n[1]);
      }
    }
  }
  return [...started].filter(([id]) => !finished.has(id)).map(([id, title]) => ({ id, title }));
}

function lastModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].type === 'assistant' && entries[i].message && entries[i].message.model;
    if (m) return m;
  }
  return null;
}

function lastField(entries, key) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i][key]) return entries[i][key];
  return null;
}

function readSubagents(sessionDir, now, windowMs) {
  const dir = path.join(sessionDir, 'subagents');
  const out = [];
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const st = safeStat(file);
    if (!st || now - st.mtimeMs > windowMs) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* no meta */ }
    if (meta.finished) continue;
    // Subagent transcripts mark every line as sidechain; treat them as a normal conversation.
    const entries = readTailJsonl(file, 128 * 1024).map((e) => ({ ...e, isSidechain: false }));
    const state = turnState(entries);
    if (!state || state.status === 'waiting') continue;
    out.push({
      id: name,
      title: meta.description || (name.includes('acompact') ? 'сжатие контекста' : name),
      type: meta.agentType || null,
      status: 'working',
      detail: state.detail || null,
      lastActivity: st.mtimeMs,
    });
  }
  return out;
}

function readClaude({ now = Date.now(), windowMs = 30 * 60 * 1000 } = {}) {
  const sessions = [];
  const live = liveSessions();
  const seen = new Set();
  for (const project of safeReaddir(ROOT)) {
    const projDir = path.join(ROOT, project);
    for (const name of safeReaddir(projDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projDir, name);
      const st = safeStat(file);
      const sessionId = name.replace(/\.jsonl$/, '');
      const alive = live ? live.has(sessionId) : null;
      if (!st || (now - st.mtimeMs > windowMs && !alive)) continue;
      seen.add(file);

      // Large tool results can push the last turn out of a small tail; widen until found.
      let entries = [];
      let state = null;
      for (const bytes of [512 * 1024, 4 * 1024 * 1024]) {
        entries = readTailCached(file, st, bytes);
        state = turnState(entries);
        if (state) break;
      }
      if (!state) continue;

      const children = readSubagents(path.join(projDir, sessionId), now, windowMs);
      // Turn is over but something keeps running in the background: you can write,
      // and the agent will also come back on its own when that finishes.
      const background = state.status === 'waiting' ? backgroundTasks(entries) : [];

      const entrypoint = lastField(entries, 'entrypoint');
      // One-shot runs from scripts (claude -p, SDK) never wait for you; once done, they're just done.
      const system = /^sdk/.test(entrypoint || '');
      if (state.status === 'waiting' && system) continue;
      // Interactive session that is "working" but its process is gone: closed or crashed mid-turn.
      // Scripts aren't in the registry, so for them we can't tell (alive stays null).
      if (state.status === 'working' && !system && alive === false) continue;

      const { used, model: usageModel, compactedFrom } = lastUsage(entries);
      const model = usageModel || lastModel(entries);
      const cwd = lastField(entries, 'cwd');

      sessions.push({
        id: `claude:${sessionId}`,
        agent: 'Claude Code',
        where: WHERE[entrypoint] || entrypoint || null,
        title: shorten(stableTitle(sessionId, entries, cwd ? path.basename(cwd) : sessionId), 80),
        cwd,
        model,
        status: state.status,
        system,
        alive: system ? null : alive,
        detail: state.detail || null,
        // For a waiting session, "how long it has been waiting" is the useful time.
        lastActivity: state.status === 'waiting' && state.since ? state.since : st.mtimeMs,
        context: used
          ? { used, window: contextWindow(model, used), kind: 'context' }
          : compactedFrom
            ? { used: compactedFrom, window: null, kind: 'compacted' }
            : null,
        background,
        children,
      });
    }
  }
  for (const file of tailCache.keys()) if (!seen.has(file)) tailCache.delete(file); // drop old sessions
  return sessions;
}

module.exports = { readClaude, turnState, backgroundTasks };
