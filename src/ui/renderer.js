// Window: draws the list it receives from the main process. No file access here.
const list = document.getElementById('list');
const summary = document.getElementById('summary');

const STATUS_TEXT = { working: 'работает', waiting: 'ждёт тебя' };
const AGENT_CLASS = { 'Claude Code': 'claude', Codex: 'codex', Hermes: 'hermes' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

function folder(cwd) {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

// Working: no timer — it would tick on every tool call. Waiting: how long it has been waiting.
function statusNode(status, lastActivity, inBackground = 0) {
  const node = el('span', `status ${status}`);
  let text = STATUS_TEXT[status] || status;
  if (status === 'waiting') text += inBackground ? ` · в фоне ${inBackground}` : ` · ${ago(lastActivity)}`;
  node.append(el('span', 'dot'), el('span', '', text));
  return node;
}

function contextNode(ctx) {
  const wrap = el('div', 'ctx');
  if (ctx.kind === 'context' && ctx.window) {
    const pct = Math.min(100, Math.round((ctx.used / ctx.window) * 100));
    const bar = el('div', 'bar');
    const fill = el('div', `fill${pct >= 80 ? ' hot' : pct >= 50 ? ' warn' : ''}`);
    fill.style.width = `${pct}%`;
    bar.append(fill);
    wrap.append(bar, el('span', 'ctx-label', `${tokens(ctx.used)} / ${tokens(ctx.window)} · ${pct}%`));
  } else if (ctx.kind === 'compacted') {
    wrap.append(el('span', 'ctx-label', `контекст сжат · было ${tokens(ctx.used)}, новый размер — после ответа`));
  } else if (ctx.kind === 'context') {
    wrap.append(el('span', 'ctx-label', `контекст ${tokens(ctx.used)}`));
  } else {
    wrap.append(el('span', 'ctx-label', `всего за сессию ${tokens(ctx.used)}`));
  }
  return wrap;
}

function card(s) {
  const node = el('div', `card ${s.status}`);

  const top = el('div', 'row');
  top.append(
    el('span', `agent ${AGENT_CLASS[s.agent] || ''}`, s.agent),
    el('span', 'meta', [s.where, folder(s.cwd), s.model].filter(Boolean).join(' · ')),
    statusNode(s.status, s.lastActivity, (s.background || []).length + (s.status === 'waiting' ? (s.children || []).length : 0)),
  );

  const title = el('div', 'row');
  title.append(el('span', 'name', s.title));
  node.append(top, title);

  if (s.context) node.append(contextNode(s.context));

  // Subagents and background commands, under the card.
  const rows = [
    ...(s.children || []).map((c) => [`${c.type || 'агент'} — ${c.title}`, 'работает']),
    ...(s.background || []).map((b) => [`в фоне — ${b.title}`, 'идёт']),
  ];
  if (rows.length) {
    const kids = el('div', 'children');
    for (const [text, state] of rows) {
      const row = el('div', 'child');
      const st = el('span', 'status working');
      st.append(el('span', 'dot'), el('span', '', state));
      row.append(el('span', 'meta', text), st);
      kids.append(row);
    }
    node.append(kids);
  }
  return node;
}

function render(sessions) {
  const working = sessions.filter((s) => s.status === 'working').length;
  summary.textContent = sessions.length ? `ждут тебя ${sessions.length - working} · работают ${working}` : '';
  list.replaceChildren(...(sessions.length ? sessions.map(card) : [el('div', 'empty', 'Сейчас никто не работает')]));
}

document.getElementById('quit').addEventListener('click', () => window.agentBar.quit());

// Settings screen: swaps with the list, saves on every change.
const settingsView = document.getElementById('settings');
const toggleSettings = document.getElementById('toggle-settings');
const waitingInput = document.getElementById('set-waiting');
const systemInput = document.getElementById('set-system');

function fillSettings(s) {
  waitingInput.value = s.waitingMinutes;
  systemInput.checked = s.showSystem;
}

toggleSettings.addEventListener('click', async () => {
  const open = settingsView.hidden;
  if (open) fillSettings(await window.agentBar.getSettings());
  settingsView.hidden = !open;
  list.hidden = open;
  toggleSettings.textContent = open ? 'Назад к списку' : 'Настройки';
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
