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
const { readTailJsonl, readHeadJsonl, safeStat, safeReaddir, shorten } = require('./util');

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

// Interactive sessions whose process is running: sessionId -> { startedAt, asking }.
// asking = what the session waits for right now mid-turn (a question, a dialog), with when it started;
// Claude Code writes it as status "waiting" + waitingFor. null = no registry (older Claude Code).
function liveSessions() {
  const names = safeReaddir(REGISTRY);
  if (!names.length && !safeStat(REGISTRY)) return null;
  const live = new Map();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(REGISTRY, name), 'utf8')); } catch { continue; }
    if (!info.sessionId || !info.pid) continue;
    const entry = {
      startedAt: info.startedAt || 0,
      pid: info.pid,
      cwd: info.cwd || null, // where the session was started: for VS Code, the window's folder
      hostSessionId: info.hostSessionId || null, // the Claude app's id for it: local_…
      asking: info.status === 'waiting'
        ? { reason: info.waitingFor || null, since: info.statusUpdatedAt || info.updatedAt || null }
        : null,
      // When Claude Code marked the session idle: its turn is over.
      idleSince: info.status === 'idle' ? info.statusUpdatedAt || info.updatedAt || null : null,
    };
    try {
      process.kill(info.pid, 0); // signal 0: only checks the process exists
      live.set(info.sessionId, entry);
    } catch (err) {
      if (err.code === 'EPERM') live.set(info.sessionId, entry); // exists, just not ours
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

// What a script run was asked to do: the first line of its first prompt. The head of a file
// never changes, so it's read once per file.
const taskCache = new Map(); // file -> string | null
function firstTask(file) {
  if (taskCache.has(file)) return taskCache.get(file);
  let task = null;
  // Script runs start with a queue entry holding the prompt; the user entry after it can be too big
  // to fit in the head we read (e.g. a whole daily log pasted in), so the queue entry goes first.
  for (const e of readHeadJsonl(file, 50)) {
    const text = e.type === 'queue-operation' && typeof e.content === 'string' ? e.content
      : e.type === 'user' ? userText(e) : '';
    const line = text.split('\n').map((l) => l.trim()).find(Boolean);
    if (line) { task = line; break; }
  }
  // A prompt over the head size (a pasted 1 MB log) breaks even the first line as JSON:
  // take the first line of the first "content" string straight from the raw bytes.
  if (!task) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = /"content":"((?:[^"\\]|\\[^n])*)/.exec(buf.toString('utf8', 0, n));
      if (m) task = JSON.parse(`"${m[1]}"`).trim() || null;
    } catch { /* leave it untitled */ }
  }
  taskCache.set(file, task);
  return task;
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
      // Anchored: Claude Code writes it as the whole message. A message that merely mentions it
      // (e.g. you pasted a log) is a new request, not an interrupt.
      if (/^\[Request interrupted by user/.test(userText(e))) return { status: 'waiting', since: waitingSince(e) };
      return { status: 'working', detail: null };
    }
  }
  return null;
}

// Time of the newest entry with a timestamp.
function lastTimestamp(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = Date.parse(entries[i].timestamp);
    if (t) return t;
  }
  return 0;
}

// The question the session left when it ended its turn through the Claude app's next-step box
// (a wrap_up tool call with "ask"). Looked for only within the last turn.
function lastTurnQuestion(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.isSidechain) continue;
    if (e.type === 'user') {
      const blocks = contentOf(e);
      if (blocks.some((b) => b.type === 'tool_result') || isSilentUserEntry(entries, i)) continue;
      if (userText(e)) return null; // your message: the turn started here
      continue;
    }
    if (e.type !== 'assistant') continue;
    for (const b of contentOf(e)) {
      if (b.type === 'tool_use' && /wrap_up$/.test(b.name || '') && b.input && typeof b.input.ask === 'string' && b.input.ask) {
        return b.input.ask;
      }
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

// Background work the agent is waiting on after its turn ended. Three kinds, each with its own
// line in the tool result when started:
//   Bash with run_in_background — "running in background with ID: X"
//   Workflow (multi-agent run)   — "Workflow launched in background. Task ID: X Summary: …"
//   Agent with run_in_background — "Async agent launched successfully. … agentId: X"
// Finished: a <task-notification> for X with any status but "running", TaskStop on X, or the
// agent's final report ("<agent-message from="X"> [Subagent hand-back]").
// Started before the current process of the session (it was restarted or resumed): dead with it.
// Whatever is started and not finished is still running — the agent will react when it ends.
// Matched only at the very start of a result of that very tool: the same words inside some other
// output (e.g. grepping transcripts) are not a launch.
const STARTED = {
  Bash: /^\s*Command running in background with ID: ([\w-]+)/,
  Workflow: /^\s*Workflow launched in background\. Task ID: ([\w-]+)/,
  Agent: /^\s*Async agent launched successfully[\s\S]*?agentId: ([\w-]+)/,
  Task: /^\s*Async agent launched successfully[\s\S]*?agentId: ([\w-]+)/, // older name of Agent
};

function toolResultText(b) {
  return typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join(' ');
}

function markFinished(text, finished) {
  let n;
  if (text.includes('<task-notification>')) {
    const re = /<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g;
    while ((n = re.exec(text))) if (n[2] !== 'running') finished.add(n[1]);
  }
  const back = /<agent-message from="([\w-]+)">\s*\[Subagent hand-back\]/g;
  while ((n = back.exec(text))) finished.add(n[1]);
}

function backgroundTasks(entries, processStart = 0) {
  const descriptions = new Map(); // tool_use id -> description
  const tools = new Map(); // tool_use id -> tool name
  const started = new Map(); // task id -> description
  const finished = new Set();
  for (const e of entries) {
    if (e.isSidechain) continue;
    for (const b of contentOf(e)) {
      if (e.type === 'assistant' && b.type === 'tool_use' && b.input) {
        descriptions.set(b.id, b.input.description || b.input.command || b.name);
        tools.set(b.id, b.name);
      }
      if (e.type === 'user' && b.type === 'tool_result') {
        const text = toolResultText(b);
        const re = STARTED[tools.get(b.tool_use_id)];
        const m = re && re.exec(text);
        if (m && !(processStart && Date.parse(e.timestamp) < processStart)) {
          const summary = /Summary: (.*?)(?: Transcript dir:|$)/.exec(text.replace(/\s+/g, ' '));
          started.set(m[1], (summary && summary[1]) || descriptions.get(b.tool_use_id) || 'фоновая задача');
        }
        const stopped = tools.get(b.tool_use_id) === 'TaskStop' && /Successfully stopped task: ([\w-]+)/.exec(text);
        if (stopped) finished.add(stopped[1]);
      }
      if (e.type === 'user' && b.type === 'text' && b.text) markFinished(b.text, finished);
    }
    // Notifications that arrive mid-turn are only recorded as a queued message, not as a user entry.
    if (e.type === 'queue-operation' && typeof e.content === 'string') markFinished(e.content, finished);
  }
  return [...started].filter(([id]) => !finished.has(id)).map(([id, title]) => ({ id, title: shorten(title, 70) }));
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

// Where a click on the card should take you (see open.js).
function openTarget(entrypoint, sessionId, reg, cwd) {
  if (entrypoint === 'claude-vscode') {
    return { app: 'vscode', folder: (reg && reg.cwd) || cwd, exact: Boolean(reg && reg.cwd), claudeSession: sessionId };
  }
  if (entrypoint === 'claude-desktop') {
    return { app: 'claude', link: reg && reg.hostSessionId ? `claude://code/continue?session=${reg.hostSessionId}` : null };
  }
  if (entrypoint === 'cli' && reg && reg.pid) return { app: 'terminal', pid: reg.pid };
  return null;
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
      const reg = live ? live.get(sessionId) : null;
      const processStart = reg ? reg.startedAt : 0;
      if (!st || (now - st.mtimeMs > windowMs && !alive)) continue;
      seen.add(file);
      // One odd file (cut mid-write, an unexpected format) must not hide every other session.
      try {
        // Large tool results can push the last turn out of a small tail; widen until found.
        let entries = [];
        let state = null;
        for (const bytes of [512 * 1024, 4 * 1024 * 1024]) {
          entries = readTailCached(file, st, bytes);
          state = turnState(entries);
          if (state) break;
        }
        if (!state) continue;
        // The turn can end on a tool call with no closing message (the Claude app's next-step box):
        // the transcript then looks mid-turn. The registry knows better if it went idle after that.
        if (state.status === 'working' && reg && reg.idleSince && reg.idleSince >= lastTimestamp(entries)) {
          state = { status: 'waiting', since: reg.idleSince };
        }

        // Session process gone: its subagents died with it, even if their transcripts stop mid-turn.
        const children = alive === false ? [] : readSubagents(path.join(projDir, sessionId), now, windowMs);
        // Turn is over but something keeps running in the background: you can write,
        // and the agent will also come back on its own when that finishes.
        const background = state.status === 'waiting' ? backgroundTasks(entries, processStart) : [];

        const entrypoint = lastField(entries, 'entrypoint');
        // One-shot runs from scripts (claude -p, SDK) never wait for you; once done, they're just done.
        const system = /^sdk/.test(entrypoint || '');
        if (state.status === 'waiting' && system) continue;
        // Interactive session that is "working" but its process is gone: closed or crashed mid-turn.
        // Scripts aren't in the registry, so for them we can't tell (alive stays null).
        if (state.status === 'working' && !system && alive === false) continue;
        // Mid-turn and the registry says it waits for you: a question, a dialog. Only mid-turn —
        // a dialog you opened yourself in a finished session is not the agent asking.
        const asking = state.status === 'working' && reg && reg.asking ? reg.asking : null;
        const status = asking ? 'asking' : state.status;

        const { used, model: usageModel, compactedFrom } = lastUsage(entries);
        const model = usageModel || lastModel(entries);
        const cwd = lastField(entries, 'cwd');

        sessions.push({
          id: `claude:${sessionId}`,
          agent: 'Claude Code',
          where: WHERE[entrypoint] || entrypoint || null,
          title: shorten(stableTitle(sessionId, entries, cwd ? path.basename(cwd) : sessionId), 80),
          task: system ? firstTask(file) : null,
          cwd,
          model,
          status,
          asking: asking ? asking.reason : null,
          question: state.status === 'waiting' ? shorten(lastTurnQuestion(entries) || '', 120) || null : null,
          system,
          open: system ? null : openTarget(entrypoint, sessionId, reg, cwd),
          alive: system ? null : alive,
          detail: state.detail || null,
          // For a waiting session, "how long it has been waiting" is the useful time.
          lastActivity: asking && asking.since ? asking.since
            : state.status === 'waiting' && state.since ? state.since : st.mtimeMs,
          context: used
            ? { used, window: contextWindow(model, used), kind: 'context' }
            : compactedFrom
              ? { used: compactedFrom, window: null, kind: 'compacted' }
              : null,
          background,
          children,
        });
      } catch (err) {
        console.error(`[agent-bar] claude: ${name} skipped:`, err.message);
      }
    }
  }
  for (const file of tailCache.keys()) if (!seen.has(file)) tailCache.delete(file); // drop old sessions
  for (const file of taskCache.keys()) if (!seen.has(file)) taskCache.delete(file);
  return sessions;
}

module.exports = { readClaude, turnState, backgroundTasks };
