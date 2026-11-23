// Main process: owns the floating pill, the list panel, the menu bar icon and the polling loop.
// All file access happens here; windows only render what they are sent.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, nativeImage, ipcMain, screen, systemPreferences, nativeTheme } = require('electron');
const { collect } = require('./sessions');
const settings = require('./settings');
const alerts = require('./alerts');
const marks = require('./marks');
const { openSession } = require('./open');
const sounds = require('./sounds');
const focus = require('./focus');
const { log, logFrontApp } = require('./debug');

const POLL_MS = 2000;
const PANEL = { width: 380, height: 520 }; // default; you can resize it, the size is remembered
const PANEL_MIN = { width: 320, height: 260 };
const PILL = { width: 120, height: 30 };
const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');

let tray = null;
let pill = null;
let panel = null;
let latest = [];
let panelHiddenAt = 0;

function summary(sessions) {
  const working = sessions.filter((s) => s.status === 'working').length;
  const asking = sessions.filter((s) => s.status === 'asking').length;
  return { working, asking, waiting: sessions.length - working - asking };
}

function trayTitle(sessions) {
  const { working, asking, waiting } = summary(sessions);
  if (!sessions.length) return ' ◦';
  return ' ' + [asking && `? ${asking}`, working && `● ${working}`, waiting && `✓ ${waiting}`].filter(Boolean).join('  ');
}

// --- pill position is remembered between launches ---
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify(state)); } catch { /* not critical */ }
}

function defaultPillPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - PILL.width - 16, y: area.y + 8 };
}

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function createPill() {
  const saved = loadState().pill;
  const pos = saved && screen.getDisplayMatching({ ...saved, ...PILL }) ? saved : defaultPillPosition();
  pill = new BrowserWindow({
    ...PILL,
    ...pos,
    frame: false,
    transparent: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: true,
    // 'panel' = macOS non-activating panel: clicking it doesn't make agent-bar the active app,
    // so macOS doesn't jump to another Space (e.g. off a fullscreen IDE).
    type: 'panel',
    acceptFirstMouse: true,
    webPreferences,
  });
  pill.setAlwaysOnTop(true, 'floating');
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pill.loadFile(path.join(__dirname, 'ui', 'pill.html'));
}

function createPanel() {
  const saved = loadState().panelSize;
  const size = saved && saved.width >= PANEL_MIN.width && saved.height >= PANEL_MIN.height ? saved : PANEL;
  panel = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: PANEL_MIN.width,
    minHeight: PANEL_MIN.height,
    show: false,
    frame: false,
    resizable: true, // drag an edge or a corner
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    vibrancy: 'popover',
    // The blur looks the same focused or not: by default it turns lighter once you click inside,
    // and the list looked "selected" in the dark theme.
    visualEffectState: 'inactive',
    type: 'panel', // see createPill: opens over a fullscreen app without switching Space
    acceptFirstMouse: true,
    webPreferences,
  });
  panel.setAlwaysOnTop(true, 'floating');
  panel.on('resized', () => {
    const [width, height] = panel.getSize();
    saveState({ ...loadState(), panelSize: { width, height } });
  });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.loadFile(path.join(__dirname, 'ui', 'index.html'));
  panel.on('focus', () => log('panel focus'));
  panel.on('show', () => log('panel show event'));
  panel.on('hide', () => log('panel hide event'));
  panel.on('blur', () => {
    // A non-activating panel can lose focus while you're still clicking inside it; only a click
    // elsewhere should close it.
    const p = screen.getCursorScreenPoint();
    const b = panel.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    log('panel blur', { cursor: p, inside });
    logFrontApp('blur');
    if (inside) return;
    panel.hide();
    panelHiddenAt = Date.now();
  });
}

// Place the panel next to an anchor rectangle (the pill or the tray icon), inside the screen.
function showPanelNear(anchor) {
  const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
  const [width, height] = panel.getSize();
  let x = Math.round(anchor.x + anchor.width / 2 - width / 2);
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
  const below = anchor.y + anchor.height + 6;
  const y = below + height <= area.y + area.height ? below : Math.max(area.y + 8, anchor.y - height - 6);
  panel.setPosition(x, Math.round(y), false);
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  log('panel showInactive', {
    at: { x, y: Math.round(y) },
    display: display.id,
    cursorDisplay: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
    allSpaces: panel.isVisibleOnAllWorkspaces(),
    pillAllSpaces: pill.isVisibleOnAllWorkspaces(),
  });
  // Seen 20.11: after a while the list stops opening on the current Space and shows up on another
  // one — macOS then jumps there. Put it back on every Space before each show.
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  panel.webContents.send('sessions', latest);
  // No focus(): focusing activates the app, and activation is what makes macOS switch Space.
  // The panel becomes focused when you click inside it; after that, clicking elsewhere hides it.
  panel.showInactive();
}

// Set when a click on the pill made agent-bar the active app; cleared when it stops being active.
let activatedByPill = false;
let onResign = [];
function whenNotActive(maxMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    onResign.push(() => { clearTimeout(timer); resolve(); });
  });
}

function togglePanel(anchor, from) {
  const sinceHidden = Date.now() - panelHiddenAt;
  log(`click ${from}`, { visible: panel.isVisible(), sinceHiddenMs: sinceHidden, anchor, cursor: screen.getCursorScreenPoint() });
  logFrontApp(`click ${from}`);
  // A click on the pill first blurs the panel (which hides it); don't reopen it right away.
  if (panel.isVisible() || sinceHidden < 250) {
    log('  -> hide');
    panel.hide();
    return;
  }
  // Showing the list while agent-bar is active is what makes macOS jump Space: wait until the
  // focus went back to your app (see did-become-active), then show it inactive.
  if (activatedByPill) {
    log('  -> wait until focus is back, then show');
    whenNotActive(600).then(() => showPanelNear(anchor));
    return;
  }
  showPanelNear(anchor);
}

function poll() {
  const now = Date.now();
  const current = settings.get();
  // Theme: both windows follow it through prefers-color-scheme, and so does the list's blur.
  if (nativeTheme.themeSource !== current.theme) nativeTheme.themeSource = current.theme;
  latest = marks.apply(collect(current, now), now);
  alerts.check(latest, {
    globalMuted: current.muted,
    isMuted: (id) => Boolean(marks.get(id).muted),
    sound: { waiting: current.soundWaiting, asking: current.soundAsking, volume: current.soundVolume },
    now,
  });
  tray.setTitle(trayTitle(latest));
  pill.webContents.send('summary', summary(latest));
  if (panel.isVisible()) panel.webContents.send('sessions', latest);
  const took = Date.now() - now;
  if (took > 300) log('slow poll', { ms: took });
}

// Only one copy at a time: a second launch just quits.
if (!app.requestSingleInstanceLock()) app.quit();

const cursorOver = (b) => {
  const p = screen.getCursorScreenPoint();
  return Boolean(b) && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
};
function cursorOnUs() {
  return cursorOver(pill && pill.getBounds()) || cursorOver(panel && panel.isVisible() && panel.getBounds()) || cursorOver(tray && tray.getBounds());
}

app.on('did-become-active', () => {
  const onUs = cursorOnUs();
  const onPill = Boolean(pill) && cursorOver(pill.getBounds());
  log('APP became active', { cursorOnUs: onUs, onPill });
  logFrontApp('active');
  // A click on the pill should never make agent-bar active: hand the focus straight back.
  if (onPill && focus.giveBack('pill click')) {
    activatedByPill = true;
    return;
  }
  focus.onActivated(onUs);
});
app.on('did-resign-active', () => {
  log('APP resigned active');
  activatedByPill = false;
  const waiting = onResign;
  onResign = [];
  for (const done of waiting) done();
});

app.whenReady().then(() => {
  log('--- start', { pid: process.pid, bundle: process.env.__CFBundleIdentifier, displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds })) });
  if (app.dock) app.dock.hide(); // no Dock icon
  systemPreferences.subscribeWorkspaceNotification('NSWorkspaceDidActivateApplicationNotification', () => focus.rememberFront());
  systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification', () => {
    focus.spaceChanged();
    log('SPACE changed');
    logFrontApp('space');
  });
  settings.init(app.getPath('userData'));
  marks.init(loadState, saveState);

  // The menu bar icon stays as a second way in; on notched MacBooks it may end up hidden.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('agent-bar');
  tray.on('click', () => togglePanel(tray.getBounds(), 'tray'));

  createPill();
  createPanel();

  ipcMain.handle('get-sessions', () => latest);
  ipcMain.handle('get-summary', () => summary(latest));
  ipcMain.on('pill-move', (_e, { dx, dy }) => {
    const [x, y] = pill.getPosition();
    pill.setPosition(x + dx, y + dy, false);
  });
  ipcMain.on('pill-moved', () => {
    const [x, y] = pill.getPosition();
    saveState({ ...loadState(), pill: { x, y } });
  });
  ipcMain.on('pill-click', () => togglePanel(pill.getBounds(), 'pill'));
  ipcMain.on('quit', () => app.quit());
  ipcMain.handle('get-settings', () => settings.get());
  ipcMain.handle('list-sounds', () => sounds.list().map(({ name, group }) => ({ name, group })));
  // ▶ on the settings screen: plays even with sounds muted — you asked to hear it.
  ipcMain.handle('play-sound', (_e, value, volume) => sounds.play(value, volume));
  ipcMain.handle('toggle-mute', (_e, id) => {
    marks.update(id, { muted: !marks.get(id).muted });
    poll();
  });
  // ×: hidden until the session does something new (see marks.js).
  ipcMain.handle('hide-session', (_e, id) => {
    const s = latest.find((x) => x.id === id);
    if (s) marks.update(id, { hiddenAt: s.lastActivity });
    poll();
  });
  // Empty name = back to the agent's own title.
  // Click on a card: hide the list and bring up the app where the session runs.
  ipcMain.handle('open-session', (_e, id) => {
    const s = latest.find((x) => x.id === id);
    if (!s || !s.open) return;
    log('open-session', s.open.app);
    panel.hide();
    panelHiddenAt = Date.now();
    openSession(s.open).catch((err) => console.error('[agent-bar] open failed:', err.message));
  });
  ipcMain.handle('rename-session', (_e, id, name) => {
    marks.update(id, { name: String(name || '').trim().slice(0, 80) });
    poll();
  });
  ipcMain.handle('set-settings', (_e, patch) => {
    const saved = settings.set(patch);
    poll(); // apply right away, not on the next tick
    return saved;
  });

  poll();
  setInterval(poll, POLL_MS);
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep living
