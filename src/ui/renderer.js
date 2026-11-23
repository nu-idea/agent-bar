// Window: draws the list it receives from the main process. No file access here.
const list = document.getElementById('list');
const summary = document.getElementById('summary');

const STATUS_TEXT = { working: 'работает', waiting: 'ждёт тебя', asking: 'нужен ответ' };
// What a session asks for, from Claude Code's registry.
const ASKING_TEXT = { 'input needed': 'вопрос', 'dialog open': 'диалог', 'sandbox request': 'просит сеть' };
const AGENT_CLASS = { 'Claude Code': 'claude', Codex: 'codex', Hermes: 'hermes' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Line icons (Lucide-style, 24×24 viewBox). Built as SVG nodes: no innerHTML, CSP stays strict.
const ICONS = {
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  sound: ['M11 5 6 9H2v6h4l5 4V5z', 'M15.54 8.46a5 5 0 0 1 0 7.07', 'M19.07 4.93a10 10 0 0 1 0 14.14'],
  muted: ['M11 5 6 9H2v6h4l5 4V5z', 'M22 9l-6 6', 'M16 9l6 6'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  back: ['M15 18l-6-6 6-6'],
  power: ['M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.77.04'],
  play: ['M7 4l13 8-13 8Z'],
};
const SVG = 'http://www.w3.org/2000/svg';
function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
function iconButton(name, title, onClick, extra = '') {
  const b = el('button', `icon-btn${extra ? ` ${extra}` : ''}`);
  b.type = 'button';
  b.title = title;
  b.append(icon(name));
  b.addEventListener('click', onClick);
  return b;
}
const AGENT_SHORT = { 'Claude Code': 'Claude', Codex: 'Codex', Hermes: 'Hermes' };

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} мин` : `${Math.round(m / 60)} ч`;
}

function tokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// Last folder of the path: the project the session runs in.
function folder(cwd) {
  if (!cwd) return '';
  return cwd.split('/').filter(Boolean).pop() || '';
}

const STATUS_LABEL = { working: 'Работает', waiting: 'Ждёт тебя', asking: 'Нужен ответ' };

// Top line: status first, then how long (waiting/asking) or what runs in the background.
// Working: no timer — it would tick on every tool call.
function headNode(s) {
  const head = el('div', 'head');
  const status = el('span', `status ${s.status}`);
  status.append(el('span', 'dot'), el('span', '', STATUS_LABEL[s.status] || s.status));
  if (s.status === 'asking' && ASKING_TEXT[s.asking]) status.title = `Что ждёт: ${ASKING_TEXT[s.asking]}`;
  head.append(status);
  const inBackground = (s.background || []).length + (s.status === 'waiting' ? (s.children || []).length : 0);
  let when = '';
  if (s.status === 'asking') when = ago(s.lastActivity);
  if (s.status === 'waiting') when = inBackground ? `в фоне ${inBackground}` : ago(s.lastActivity);
  if (when) status.append(el('span', 'when', `· ${when}`));
  if (s.muted) {
    const mark = el('span', 'muted-mark');
    mark.title = 'Звук этой сессии выключен';
    mark.append(icon('muted'));
    head.append(mark);
  }
  const load = loadOf(s.context);
  if (load) {
    const right = el('span', 'load');
    right.title = `Контекст: ${tokens(load.used)} из ${tokens(load.window)}`;
    right.append(el('span', 'tokens', tokens(load.used)), el('span', `pct ${load.level}`, `${load.pct}%`));
    head.append(right);
  }
  return head;
}

// How loaded the session is, when the context window is known.
function loadOf(ctx) {
  if (!ctx || ctx.kind !== 'context' || !ctx.window) return null;
  const pct = Math.min(100, Math.round((ctx.used / ctx.window) * 100));
  return { used: ctx.used, window: ctx.window, pct, level: pct >= 80 ? 'hot' : pct >= 50 ? 'warn' : '' };
}

// Load meter along the card's bottom edge; without a known window — a quiet line of text.
function contextNode(ctx) {
  const load = loadOf(ctx);
  if (load) {
    const meter = el('div', 'meter');
    const fill = el('div', `fill ${load.level}`);
    fill.style.width = `${Math.max(load.pct, 1)}%`;
    meter.append(fill);
    return meter;
  }
  if (ctx.kind === 'compacted') return el('div', 'ctx-note', `Контекст сжат · было ${tokens(ctx.used)}, новый размер — после ответа`);
  if (ctx.kind === 'context') return el('div', 'ctx-note', `Контекст ${tokens(ctx.used)}`);
  return el('div', 'ctx-note', `Всего за сессию ${tokens(ctx.used)}`);
}

const OPEN_TEXT = { vscode: 'VS Code', claude: 'приложении Claude', terminal: 'терминале', codex: 'Codex', hermes: 'Hermes' };

function card(s) {
  const node = el('div', `card ${s.status}${s.open ? ' clickable' : ''}`);
  if (s.open) {
    node.title = `Открыть в ${OPEN_TEXT[s.open.app] || 'приложении'}`;
    // The buttons on the card do their own thing; a click anywhere else opens the session.
    node.addEventListener('click', (e) => {
      if (editing || e.target.closest('button, input')) return;
      window.agentBar.openSession(s.id);
    });
  }

  const name = el('div', 'name', s.title);
  name.title = s.agentTitle && s.agentTitle !== s.title ? `Название от агента: ${s.agentTitle}` : s.title;

  // Agent · project · where it runs. The model only in the tooltip.
  const meta = el('div', 'meta');
  meta.title = [s.agent, s.cwd, s.where, s.model].filter(Boolean).join(' · ');
  const parts = [el('span', `agent ${AGENT_CLASS[s.agent] || ''}`, AGENT_SHORT[s.agent] || s.agent)];
  for (const text of [folder(s.cwd), s.where].filter(Boolean)) parts.push(el('span', 'sep', '·'), el('span', '', text));
  meta.append(...parts);

  // Actions show on hover. The sound icon shows the current state, not the action.
  const actions = el('div', 'actions');
  actions.append(
    iconButton('edit', 'Переименовать. Пустое имя — вернуть название от агента', () => startRename(s, name)),
    iconButton(s.muted ? 'muted' : 'sound', s.muted ? 'Звук этой сессии выключен. Нажми, чтобы включить' : 'Звук этой сессии включён. Нажми, чтобы выключить',
      () => window.agentBar.toggleMute(s.id), s.muted ? 'on' : ''),
    iconButton('close', 'Убрать из списка. Вернётся, когда сессия снова что-то сделает', () => window.agentBar.hideSession(s.id)),
  );

  node.append(headNode(s), name, meta);
  if (s.context) node.append(contextNode(s.context));

  // Subagents and background commands, under the card.
  const rows = [
    ...(s.children || []).map((c) => [c.type || 'агент', c.title]),
    ...(s.background || []).map((b) => ['в фоне', b.title]),
  ];
  if (rows.length) {
    const kids = el('div', 'children');
    for (const [kind, what] of rows) {
      const row = el('div', 'child');
      row.append(el('span', 'dot'), el('span', 'kind', kind), el('span', 'what', what));
      row.title = `${kind} — ${what}`;
      kids.append(row);
    }
    node.append(kids);
  }
  node.append(actions);
  return node;
}

// Renaming: the list is redrawn every 2 s, which would wipe the input — pause redraws meanwhile.
let editing = false;
let lastSessions = [];

function startRename(s, nameNode) {
  editing = true;
  const input = el('input', 'rename');
  input.value = s.title;
  input.maxLength = 80;
  nameNode.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save) await window.agentBar.renameSession(s.id, input.value);
    editing = false;
    render(lastSessions);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function render(sessions) {
  lastSessions = sessions;
  if (editing) return;
  const working = sessions.filter((s) => s.status === 'working').length;
  const asking = sessions.filter((s) => s.status === 'asking').length;
  const waits = sessions.length - working - asking;
  const chips = [
    asking && el('span', 'chip asking', `${asking} ${asking === 1 ? 'вопрос' : 'вопроса'}`),
    waits && el('span', 'chip waiting', `${waits} ждут`),
    working && el('span', 'chip', `${working} в работе`),
  ].filter(Boolean);
  summary.replaceChildren(...chips);
  if (sessions.length) {
    list.replaceChildren(...sessions.map(card));
  } else {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', 'Тихо'), el('span', '', 'Сейчас никто не работает'));
    list.replaceChildren(empty);
  }
}

const quitButton = document.getElementById('quit');
quitButton.append(icon('power'), el('span', '', 'Выключить'));
quitButton.addEventListener('click', () => window.agentBar.quit());

// Header mute: all sounds off/on. Stored in settings.json as "muted".
const muteAll = document.getElementById('mute-all');
function showMuteAll(isMuted) {
  // Shows the current state, not the action.
  muteAll.replaceChildren(icon(isMuted ? 'muted' : 'sound'));
  muteAll.title = isMuted ? 'Нажми, чтобы включить все звуки' : 'Нажми, чтобы выключить все звуки';
  muteAll.classList.toggle('on', isMuted);
}
muteAll.addEventListener('click', async () => {
  const s = await window.agentBar.getSettings();
  showMuteAll((await window.agentBar.setSettings({ muted: !s.muted })).muted);
});
window.agentBar.getSettings().then((s) => showMuteAll(s.muted));

// Settings screen: swaps with the list, saves on every change.
const settingsView = document.getElementById('settings');
const toggleSettings = document.getElementById('toggle-settings');
const waitingInput = document.getElementById('set-waiting');
const systemInput = document.getElementById('set-system');
const soundInputs = { soundWaiting: document.getElementById('set-sound-waiting'), soundAsking: document.getElementById('set-sound-asking') };
const volumeInput = document.getElementById('set-volume');

// Sound dropdown: "без звука", system sounds, your own (~/Library/Sounds). A full path from the
// settings file that isn't in the folders gets its own option, so it isn't lost on save.
function fillSoundSelect(select, sounds, value) {
  const option = (val, text) => { const o = el('option', '', text); o.value = val; return o; };
  const group = (label, items) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...items.map((s) => option(s.name, s.name)));
    return g;
  };
  const system = sounds.filter((s) => s.group === 'system');
  const mine = sounds.filter((s) => s.group === 'mine');
  const nodes = [option('', 'без звука'), group('Системные', system)];
  if (mine.length) nodes.push(group('Мои', mine));
  if (value && !sounds.some((s) => s.name === value)) nodes.push(option(value, value.split('/').pop()));
  select.replaceChildren(...nodes);
  select.value = value;
}

const themeButtons = [...document.querySelectorAll('#set-theme button')];
for (const b of themeButtons) {
  b.addEventListener('click', async () => fillSettings(await window.agentBar.setSettings({ theme: b.dataset.theme })));
}
for (const b of document.querySelectorAll('#settings .play')) b.append(icon('play'));

async function fillSettings(s) {
  for (const b of themeButtons) b.classList.toggle('on', b.dataset.theme === s.theme);
  waitingInput.value = s.waitingMinutes;
  systemInput.checked = s.showSystem;
  const sounds = await window.agentBar.listSounds();
  for (const [key, select] of Object.entries(soundInputs)) fillSoundSelect(select, sounds, s[key]);
  volumeInput.value = Math.round(s.soundVolume * 100);
}

for (const [key, select] of Object.entries(soundInputs)) {
  select.addEventListener('change', async () => {
    const s = await window.agentBar.setSettings({ [key]: select.value });
    window.agentBar.playSound(select.value, s.soundVolume); // hear what you picked
    fillSettings(s);
  });
}
for (const btn of document.querySelectorAll('#settings .play')) {
  btn.addEventListener('click', () => {
    window.agentBar.playSound(document.getElementById(btn.dataset.for).value, Number(volumeInput.value) / 100);
  });
}
volumeInput.addEventListener('change', async () => {
  const s = await window.agentBar.setSettings({ soundVolume: Number(volumeInput.value) / 100 });
  window.agentBar.playSound(s.soundWaiting || s.soundAsking, s.soundVolume); // hear the new volume
});

function showToggle(settingsOpen) {
  toggleSettings.replaceChildren(icon(settingsOpen ? 'back' : 'settings'), el('span', '', settingsOpen ? 'К списку' : 'Настройки'));
}
showToggle(false);
toggleSettings.addEventListener('click', async () => {
  const open = settingsView.hidden;
  if (open) await fillSettings(await window.agentBar.getSettings());
  settingsView.hidden = !open;
  list.hidden = open;
  showToggle(open);
});
waitingInput.addEventListener('change', async () => {
  const n = Math.round(Number(waitingInput.value));
  fillSettings(await window.agentBar.setSettings(n > 0 ? { waitingMinutes: n } : {}));
});
systemInput.addEventListener('change', async () => {
  fillSettings(await window.agentBar.setSettings({ showSystem: systemInput.checked }));
});

window.agentBar.onSessions(render);
window.agentBar.getSessions().then(render);
