// Window: draws the list it receives from the main process. No file access here.
const list = document.getElementById('list');
const summary = document.getElementById('summary');

const STATUS_TEXT = { working: 'работает', waiting: 'ждёт тебя', asking: 'нужен ответ' };
// What a session asks for, from Claude Code's registry.
const ASKING_TEXT = {
  'input needed': 'вопрос', 'dialog open': 'диалог', 'sandbox request': 'просит сеть',
  'permission prompt': 'разрешение на действие', 'worker request': 'разрешение для субагента', 'goal proposal': 'согласовать цель',
};
// The same split Claude Code makes: these wait for your "yes / no", the rest for an answer.
const PERMISSION = new Set(['permission prompt', 'sandbox request', 'worker request', 'goal proposal']);
const isPermission = (s) => s.status === 'asking' && PERMISSION.has(s.asking);
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
  minus: ['M5 12h14'],
  plus: ['M12 5v14', 'M5 12h14'],
  updown: ['M8 9.5l4-4 4 4', 'M8 14.5l4 4 4-4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
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
// Working: no timer — it would tick on every tool call. Only when it's been silent a long time:
// a long command is fine, anything else may be stuck (e.g. hung after Ctrl+C) — worth a look.
const SILENT_MS = 5 * 60 * 1000;
function headNode(s) {
  const head = el('div', 'head');
  const status = el('span', `status ${s.status}`);
  const label = isPermission(s) ? 'Ждёт разрешения' : STATUS_LABEL[s.status] || s.status;
  status.append(el('span', 'dot'), el('span', '', label));
  if (s.status === 'asking' && ASKING_TEXT[s.asking]) status.title = `Что ждёт: ${ASKING_TEXT[s.asking]}`;
  head.append(status);
  const inBackground = (s.background || []).length + (s.status === 'waiting' ? (s.children || []).length : 0);
  let when = '';
  if (s.status === 'asking') when = ago(s.lastActivity);
  if (s.status === 'waiting') when = inBackground ? `в фоне ${inBackground}` : ago(s.lastActivity);
  if (s.status === 'working') {
    // Subagents write their own files: the session is silent only if they are too.
    const last = Math.max(s.lastActivity, ...(s.children || []).map((c) => c.lastActivity || 0));
    if (Date.now() - last > SILENT_MS) {
      const command = s.detail === 'Bash';
      when = command ? `команда идёт ${ago(last)}` : `тихо ${ago(last)}`;
      status.classList.add('silent');
      status.title = command
        ? `Ждёт, пока закончится команда. Новых записей нет ${ago(last)}`
        : `Новых записей нет ${ago(last)}. Если ты его не ждёшь — возможно, завис, загляни`;
    } else if ((s.background || []).length) {
      when = `в фоне ${s.background.length}`;
    }
  }
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

  node.append(headNode(s), name);
  // The question the session left you in the Claude app's next-step box.
  if (s.question) {
    const q = el('div', 'question');
    q.title = s.question;
    q.append(el('span', 'q-mark', '?'), el('span', 'q-text', s.question));
    node.append(q);
  }
  node.append(meta);
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
    // finally: if saving fails, the list must not stay frozen with redraws paused.
    try {
      if (save) await window.agentBar.renameSession(s.id, input.value);
    } finally {
      editing = false;
      render(lastSessions);
    }
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
  const permits = sessions.filter(isPermission).length;
  const questions = asking - permits;
  const waits = sessions.length - working - asking;
  const chips = [
    // One orange chip: the header has room for three. Its words say what kind when it's one kind.
    asking && el('span', 'chip asking', !questions ? `${permits} ${permits === 1 ? 'разрешение' : 'разрешения'}`
      : !permits ? `${questions} ${questions === 1 ? 'вопрос' : 'вопроса'}` : `${asking} ждут ответа`),
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
const quietFrontInput = document.getElementById('set-quiet-front');
const volumeInput = document.getElementById('set-volume');
const volumeValue = document.getElementById('volume-value');

// --- dropdown: our own menu inside the window. The native <select> popup is drawn by macOS
// outside the page and landed in odd places in this panel window.
const menu = document.getElementById('menu');
let openDropdown = null; // { button, items, value, onPick }
let activeIndex = -1;

function makeDropdown(button, onPick) {
  const dd = { button, items: [], value: '', onPick };
  button.append(el('span', 'dd-value'), icon('updown'));
  button.addEventListener('click', () => (openDropdown === dd ? closeMenu() : openMenu(dd)));
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && openDropdown !== dd) { e.preventDefault(); openMenu(dd); }
  });
  return dd;
}

// items: { label } for a group title, { value, text } for a choice.
function setDropdown(dd, items, value) {
  dd.items = items;
  dd.value = value;
  const chosen = items.find((i) => 'value' in i && i.value === value);
  const text = dd.button.querySelector('.dd-value');
  text.textContent = chosen ? chosen.text : '—';
  dd.button.classList.toggle('empty', !value);
  const play = document.querySelector(`#settings .play[data-key="${dd.button.dataset.key}"]`);
  if (play) play.disabled = !value; // nothing to hear
}

function menuChoices() {
  return [...menu.querySelectorAll('.menu-item')];
}
function setActive(i) {
  const items = menuChoices();
  activeIndex = Math.max(0, Math.min(items.length - 1, i));
  items.forEach((n, k) => n.classList.toggle('active', k === activeIndex));
  if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
}

function openMenu(dd) {
  closeMenu();
  openDropdown = dd;
  dd.button.classList.add('open');
  const nodes = [];
  for (const item of dd.items) {
    if (!('value' in item)) {
      nodes.push(el('div', 'menu-label', item.label));
      continue;
    }
    const row = el('div', `menu-item${item.value === dd.value ? ' selected' : ''}`);
    row.append(icon('check'), el('span', 'menu-text', item.text));
    row.addEventListener('pointermove', () => setActive(menuChoices().indexOf(row)));
    row.addEventListener('click', () => pick(item.value));
    nodes.push(row);
  }
  menu.replaceChildren(...nodes);
  menu.hidden = false;

  // Under the button if it fits, else above; never outside the window.
  const r = dd.button.getBoundingClientRect();
  const width = Math.max(r.width, 180);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const full = menu.scrollHeight;
  const down = full <= below || below >= above;
  const max = Math.min(full, down ? below : above);
  menu.style.maxHeight = `${max}px`;
  menu.style.top = `${down ? r.bottom + 4 : r.top - 4 - max}px`;
  menu.classList.toggle('up', !down);
  setActive(menuChoices().findIndex((n) => n.classList.contains('selected')));
}

function closeMenu() {
  if (!openDropdown) return;
  openDropdown.button.classList.remove('open');
  openDropdown = null;
  menu.hidden = true;
}

function pick(value) {
  const dd = openDropdown;
  closeMenu();
  if (dd && value !== undefined) dd.onPick(value);
}

document.addEventListener('pointerdown', (e) => {
  if (openDropdown && !menu.contains(e.target) && !openDropdown.button.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (!openDropdown) return;
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const row = menuChoices()[activeIndex];
    if (row) row.click();
  }
});
settingsView.addEventListener('scroll', closeMenu);
window.addEventListener('resize', closeMenu);
window.addEventListener('blur', closeMenu);

// Sound list: "без звука", system sounds, your own (~/Library/Sounds). A full path from the
// settings file that isn't in the folders gets its own entry, so it isn't lost on save.
function soundItems(sounds, value) {
  const items = [{ value: '', text: 'Без звука' }, { label: 'Системные' }];
  items.push(...sounds.filter((s) => s.group === 'system').map((s) => ({ value: s.name, text: s.name })));
  const mine = sounds.filter((s) => s.group === 'mine');
  if (mine.length) items.push({ label: 'Мои' }, ...mine.map((s) => ({ value: s.name, text: s.name })));
  if (value && !sounds.some((s) => s.name === value)) items.push({ label: 'Из файла настроек' }, { value, text: value.split('/').pop() });
  return items;
}

const soundDropdowns = {};
for (const button of document.querySelectorAll('#settings .dropdown')) {
  const key = button.dataset.key;
  soundDropdowns[key] = makeDropdown(button, async (value) => {
    const s = await window.agentBar.setSettings({ [key]: value });
    window.agentBar.playSound(value, s.soundVolume); // hear what you picked
    fillSettings(s);
  });
}

// Segmented theme control: a thumb slides under the chosen option.
const themeControl = document.getElementById('set-theme');
const themeThumb = el('span', 'seg-thumb');
themeControl.prepend(themeThumb);
const themeButtons = [...themeControl.querySelectorAll('button')];
function placeThemeThumb(animate) {
  const on = themeButtons.find((b) => b.classList.contains('on'));
  if (!on || !on.offsetWidth) return; // hidden: placed again when shown
  themeThumb.classList.toggle('still', !animate);
  themeThumb.style.width = `${on.offsetWidth}px`;
  themeThumb.style.transform = `translateX(${on.offsetLeft - 2}px)`;
}
for (const b of themeButtons) {
  b.addEventListener('click', async () => fillSettings(await window.agentBar.setSettings({ theme: b.dataset.theme }), true));
}

for (const b of document.querySelectorAll('#settings .play')) {
  b.append(icon('play'));
  b.addEventListener('click', () => {
    window.agentBar.playSound(soundDropdowns[b.dataset.key].value, Number(volumeInput.value) / 100);
    b.classList.remove('ping');
    void b.offsetWidth; // restart the animation
    b.classList.add('ping');
  });
}

// Volume: the filled part of the track follows the thumb; the number next to it too.
function showVolume() {
  volumeInput.style.setProperty('--p', String(volumeInput.value / 100));
  volumeValue.textContent = `${volumeInput.value}%`;
}

async function fillSettings(s, animate = false) {
  for (const b of themeButtons) b.classList.toggle('on', b.dataset.theme === s.theme);
  placeThemeThumb(animate);
  waitingInput.value = s.waitingMinutes;
  showStepLimits();
  systemInput.checked = s.showSystem;
  quietFrontInput.checked = s.quietInFront;
  const sounds = await window.agentBar.listSounds();
  for (const [key, dd] of Object.entries(soundDropdowns)) setDropdown(dd, soundItems(sounds, s[key]), s[key]);
  volumeInput.value = Math.round(s.soundVolume * 100);
  showVolume();
}

volumeInput.addEventListener('input', showVolume);
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
  closeMenu();
  settingsView.hidden = !open;
  list.hidden = open;
  showToggle(open);
  if (open) placeThemeThumb(false); // measurable only once shown
});
async function saveWaiting(n) {
  fillSettings(await window.agentBar.setSettings(n > 0 ? { waitingMinutes: n } : {}));
}
waitingInput.addEventListener('change', () => saveWaiting(Math.round(Number(waitingInput.value))));
// − / +: a minute per click; hold to keep going. The number changes at once, saved on release.
const stepButtons = [...document.querySelectorAll('.stepper .step')];
const showStepLimits = () => { stepButtons[0].disabled = Number(waitingInput.value) <= 1; };
for (const b of stepButtons) {
  b.append(icon(Number(b.dataset.step) < 0 ? 'minus' : 'plus'));
  let timer = null;
  const bump = () => {
    waitingInput.value = Math.max(1, Math.round(Number(waitingInput.value) || 1) + Number(b.dataset.step));
    showStepLimits();
    if (b.disabled) stop(); // a disabled button gets no pointerup
  };
  const stop = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    saveWaiting(Number(waitingInput.value));
  };
  b.addEventListener('pointerdown', () => {
    const repeat = (ms) => { timer = setTimeout(() => { bump(); if (timer !== null) repeat(Math.max(40, ms * 0.8)); }, ms); };
    repeat(400);
    bump();
  });
  b.addEventListener('pointerup', stop);
  b.addEventListener('pointerleave', stop);
}
quietFrontInput.addEventListener('change', async () => {
  fillSettings(await window.agentBar.setSettings({ quietInFront: quietFrontInput.checked }));
});
systemInput.addEventListener('change', async () => {
  fillSettings(await window.agentBar.setSettings({ showSystem: systemInput.checked }));
});

window.agentBar.onSessions(render);
window.agentBar.getSessions().then(render);
