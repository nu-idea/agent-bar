// User settings: ~/Library/Application Support/agent-bar/settings.json
// Meant to be edited by hand. Missing file → created with defaults. Edits apply without a restart.
// Broken JSON → keep the last good settings. A bad single value → that key falls back to its default.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  waitingMinutes: 30, // how long a finished session stays in the list as "ждёт тебя"
  showSystem: true, // show runs started by scripts and crons (claude -p, SDK, codex exec)
  muted: false, // the mute button in the list header: no sounds at all
  // Names for system runs: if the run's task contains "match" (any case), the card is called "name".
  // Without a matching rule the card shows the first line of the task.
  systemNames: [],
  // Sounds: a name from the list on the settings screen (system sounds and ~/Library/Sounds),
  // a full path to any sound file, or "" for no sound.
  soundWaiting: 'Glass', // a session finished its turn: "ждёт тебя"
  soundAsking: 'Ping', // a session stopped mid-turn to ask you: "нужен ответ"
  soundVolume: 1, // 0..1, the sound's own volume; the Mac's volume is not touched
  theme: 'system', // "system" follows macOS, or "light" / "dark"
};

const VALID = {
  waitingMinutes: (v) => typeof v === 'number' && v > 0,
  showSystem: (v) => typeof v === 'boolean',
  muted: (v) => typeof v === 'boolean',
  systemNames: (v) => Array.isArray(v)
    && v.every((r) => r && typeof r.match === 'string' && r.match && typeof r.name === 'string' && r.name),
  soundWaiting: (v) => typeof v === 'string',
  soundAsking: (v) => typeof v === 'string',
  soundVolume: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  theme: (v) => ['system', 'light', 'dark'].includes(v),
};

let file = null;
let current = { ...DEFAULTS };

function clean(raw) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (key in raw && VALID[key](raw[key])) out[key] = raw[key];
    else if (key in raw) console.error(`[agent-bar] settings: bad value for "${key}", using ${JSON.stringify(DEFAULTS[key])}`);
  }
  return out;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
    current = { ...DEFAULTS };
    return;
  }
  try {
    current = clean(JSON.parse(text));
  } catch (err) {
    console.error('[agent-bar] settings.json is not valid JSON, keeping previous settings:', err.message);
  }
}

// Call once with the app's data folder. Polling watch: survives editors that replace the file on save.
function init(dir) {
  file = path.join(dir, 'settings.json');
  load();
  fs.watchFile(file, { interval: 1000 }, load);
}

function get() {
  return current;
}

// From the settings screen: merge, validate, write. The file watcher then reloads the same values.
function set(patch) {
  current = clean({ ...current, ...patch });
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  return current;
}

module.exports = { init, get, set, DEFAULTS };
