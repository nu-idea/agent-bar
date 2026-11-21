// Sound when a session needs you: it finished its turn ("работает" → "ждёт тебя")
// or stopped mid-turn to ask you something ("нужен ответ").
// Sessions already waiting when the widget starts stay quiet; several finishing at once ring once.
const sounds = require('./sounds');

// "Just finished" = the waiting started less than this ago. Guards against old sessions that
// merely became visible (first seen, or after raising "ждёт тебя" minutes in settings).
const FRESH_MS = 30 * 1000;

let previous = null; // id -> { status, lastActivity } from the last poll; null until the first poll

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
// sound = { waiting, asking, volume } from settings. Returns what rang: 'asking', 'waiting' or null.
// Both at once → only the "нужен ответ" sound: it's the more urgent one.
function check(sessions, { globalMuted, isMuted, sound, now = Date.now() }) {
  let ring = null;
  if (previous) {
    for (const s of sessions) {
      if (isMuted(s.id) || !justFinished(s, previous.get(s.id), now)) continue;
      if (s.status === 'asking') ring = 'asking';
      else if (!ring) ring = 'waiting';
    }
  }
  previous = new Map(sessions.map((s) => [s.id, { status: s.status, lastActivity: s.lastActivity }]));
  if (ring && !globalMuted && sound) sounds.play(sound[ring], sound.volume);
  return ring;
}

module.exports = { check };
