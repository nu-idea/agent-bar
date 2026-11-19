const { readClaude } = require('./readers/claude');
const { readCodex } = require('./readers/codex');
const { readHermes } = require('./readers/hermes');

const READERS = [readClaude, readCodex, readHermes];

// A session is shown while it works, and for a while after it finished and waits for you.
const WORK_WINDOW_MS = 30 * 60 * 1000;
const WAITING_WINDOW_MS = 30 * 60 * 1000;
// "Working" but nothing written for this long — the process most likely died or was closed.
const STALE_MS = 10 * 60 * 1000;

function collect(now = Date.now()) {
  const all = [];
  for (const read of READERS) {
    try {
      all.push(...read({ now, windowMs: WORK_WINDOW_MS }));
    } catch (err) {
      console.error(`[agent-bar] ${read.name} failed:`, err.message);
    }
  }
  const visible = all.filter((s) => {
    const age = now - s.lastActivity;
    return s.status === 'waiting' ? age < WAITING_WINDOW_MS : age < STALE_MS;
  });
  const rank = { waiting: 0, working: 1 };
  visible.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
  return visible;
}

module.exports = { collect };
