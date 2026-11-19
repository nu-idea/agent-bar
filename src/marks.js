// What you set on a card in the list: mute, your own name, hidden with ×.
// Stored in state.json as { marks: { <session id>: { muted, name, hiddenAt, seen } } }.
//   muted    — no sound from this session
//   name     — shown instead of the agent's title
//   hiddenAt — the session's lastActivity when you pressed ×. It stays hidden while nothing new
//              happens; once it works or finishes another turn, it's back and the mark is dropped.
//   seen     — last time the session was around; marks of sessions gone for a month are forgotten.
const FORGET_MS = 30 * 24 * 3600 * 1000;
const SAVE_EVERY_MS = 10 * 60 * 1000;

let storage = null; // { load, save } for state.json
let marks = {};
let savedAt = 0;

function persist() {
  storage.save({ ...storage.load(), marks, muted: undefined }); // muted: old format, dropped
  savedAt = Date.now();
}

function init(load, save) {
  storage = { load, save };
  const state = load();
  marks = state.marks || {};
  for (const id of Object.keys(state.muted || {})) marks[id] = { ...marks[id], muted: true, seen: Date.now() }; // old format
}

function get(id) {
  return marks[id] || {};
}

// Set or clear fields; false / '' / undefined clear them. A mark with nothing left is removed.
function update(id, patch) {
  const next = { ...get(id), ...patch, seen: Date.now() };
  for (const [k, v] of Object.entries(next)) if (v === false || v === '' || v === undefined) delete next[k];
  if (Object.keys(next).length === 1) delete marks[id];
  else marks[id] = next;
  persist();
}

// Applied to every poll: drops hidden sessions, puts your names and mutes on the rest.
function apply(sessions, now = Date.now()) {
  let dirty = false;
  const out = [];
  for (const s of sessions) {
    const m = marks[s.id];
    if (!m) {
      out.push({ ...s, muted: false });
      continue;
    }
    m.seen = now;
    if (m.hiddenAt !== undefined) {
      if (s.lastActivity <= m.hiddenAt) continue;
      delete m.hiddenAt; // something new happened: show it again
      if (Object.keys(m).length === 1) delete marks[s.id]; // only "seen" left
      dirty = true;
    }
    out.push({ ...s, muted: Boolean(m.muted), title: m.name || s.title, agentTitle: s.title });
  }
  if (now - savedAt > SAVE_EVERY_MS) {
    for (const [id, m] of Object.entries(marks)) if (now - m.seen > FORGET_MS) delete marks[id];
    dirty = true;
  }
  if (dirty) persist();
  return out;
}

module.exports = { init, get, update, apply };
