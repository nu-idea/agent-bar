// Hermes: sessions and messages in the SQLite database ~/.hermes/state.db
// Read through the system sqlite3 CLI, read-only, so the app needs no native modules.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { shorten } = require('./util');

const DB = path.join(os.homedir(), '.hermes', 'state.db');

function query(sql) {
  const attempts = [
    ['-readonly', '-json', DB, sql],
    // Fallback when the WAL index can't be opened: snapshot without the newest uncommitted pages.
    ['-json', `file:${DB}?immutable=1`, sql],
  ];
  for (const args of attempts) {
    try {
      const out = execFileSync('sqlite3', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim() ? JSON.parse(out) : [];
    } catch { /* try next */ }
  }
  return [];
}

function readHermes({ now = Date.now(), windowMs = 30 * 60 * 1000 } = {}) {
  if (!fs.existsSync(DB)) return [];
  const since = (now - windowMs) / 1000;
  const rows = query(`
    SELECT s.id, s.model, s.cwd, s.title, s.source, s.ended_at,
           max(coalesce(s.last_activity_at,0), coalesce(s.ended_at,0), coalesce(s.started_at,0)) AS activity,
           s.last_activity_description AS doing,
           coalesce(s.input_tokens,0) + coalesce(s.cache_read_tokens,0) + coalesce(s.cache_write_tokens,0) AS total,
           (SELECT role FROM messages m WHERE m.session_id = s.id ORDER BY m.timestamp DESC LIMIT 1) AS last_role,
           (SELECT finish_reason FROM messages m WHERE m.session_id = s.id ORDER BY m.timestamp DESC LIMIT 1) AS last_finish,
           (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.timestamp DESC LIMIT 1) AS last_prompt,
           (SELECT max(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_msg
    FROM sessions s
    WHERE max(coalesce(s.last_activity_at,0), coalesce(s.ended_at,0), coalesce(s.started_at,0)) > ${since}
       OR (SELECT max(m.timestamp) FROM messages m WHERE m.session_id = s.id) > ${since}
  `);

  return rows.map((r) => {
    const waiting = r.ended_at || (r.last_role === 'assistant' && r.last_finish === 'stop');
    const status = waiting ? 'waiting' : 'working';

    const activity = Math.max(r.activity || 0, r.last_msg || 0) * 1000;
    return {
      id: `hermes:${r.id}`,
      agent: 'Hermes',
      where: r.source || null,
      system: false, // which Hermes sources are scripts/crons is not checked yet
      alive: null,
      title: shorten(r.title || r.doing || r.last_prompt || (r.cwd ? path.basename(r.cwd) : r.id), 70),
      cwd: r.cwd || null,
      model: r.model || null,
      status,
      detail: null,
      lastActivity: activity,
      // Hermes stores only running totals per session, not the size of the last request.
      context: r.total ? { used: r.total, window: null, kind: 'total' } : null,
      children: [],
    };
  });
}

module.exports = { readHermes };
