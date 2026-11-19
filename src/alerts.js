// Sound when a session needs you: it finished its turn ("работает" → "ждёт тебя")
// or stopped mid-turn to ask you something ("нужен ответ").
// Sessions already waiting when the widget starts stay quiet; several finishing at once ring once.
const { execFile } = require('child_process');

const SOUND = '/System/Library/Sounds/Glass.aiff';
// "Just finished" = the waiting started less than this ago. Guards against old sessions that
// merely became visible (first seen, or after raising "ждёт тебя" minutes in settings).
const FRESH_MS = 30 * 1000;

let previous = null; // id -> { status, lastActivity } from the last poll; null until the first poll

function play() {
  execFile('afplay', [SOUND], () => { /* no sound is not worth an error */ });
}

// A waiting session finished a turn since the last poll if it was working then, or if its
// "waiting since" moved: a turn shorter than the poll interval (2 s) is never seen as working.
function justFinished(s, before, now) {
  if (s.status === 'asking') return before ? before.status !== 'asking' : now - s.lastActivity < FRESH_MS;
  if (s.status !== 'waiting') return false;
  if (before && before.status === 'working') return true;
  const fresh = now - s.lastActivity < FRESH_MS;
  if (!before) return fresh;
  return fresh && before.lastActivity !== s.lastActivity;
}

// isMuted(id) — per-session mute; globalMuted — the mute in the list header.
function check(sessions, { globalMuted, isMuted, now = Date.now() }) {
  let ring = false;
  if (previous) {
    for (const s of sessions) {
      if (!isMuted(s.id) && justFinished(s, previous.get(s.id), now)) ring = true;
    }
  }
  previous = new Map(sessions.map((s) => [s.id, { status: s.status, lastActivity: s.lastActivity }]));
  if (ring && !globalMuted) play();
  return ring;
}

module.exports = { check, play };
