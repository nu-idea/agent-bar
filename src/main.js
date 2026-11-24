// Main process: owns the floating pill, the list panel, the menu bar icon and the polling loop.
// All file access happens here; windows only render what they are sent.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, nativeImage, ipcMain, screen, systemPreferences, nativeTheme, powerMonitor } = require('electron');
const { collect } = require('./sessions');
const settings = require('./settings');
const alerts = require('./alerts');
const marks = require('./marks');
const { openSession, appOfProcess } = require('./open');
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
// Write to a temp file and rename: a crash or sleep mid-write can't leave half a file behind
// (a broken state.json loses the pill position, names and mutes).
function saveState(state) {
  const file = STATE_FILE();
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    log('state.json not saved:', err.message);
  }
}

function defaultPillPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - PILL.width - 16, y: area.y + 8 };
}

// Is any part of the rectangle on a screen? (getDisplayMatching always returns some display,
// even for a spot where there's none — e.g. the pill was left on a monitor that's unplugged now.)
function onSomeScreen(r) {
  return screen.getAllDisplays().some(({ workArea: a }) => (
    r.x < a.x + a.width && r.x + r.width > a.x && r.y < a.y + a.height && r.y + r.height > a.y
  ));
}

// Monitor unplugged or rearranged: if the pill is left off every screen, bring it back.
// The saved position stays, so it's back in its place after a restart with that monitor.
function keepPillOnScreen() {
  if (!pill || pill.isDestroyed() || onSomeScreen(pill.getBounds())) return;
  const pos = defaultPillPosition();
  log('pill off screen -> move', pos);
  pill.setPosition(pos.x, pos.y, false);
}

// A window's page crashed or hung: reload it instead of leaving a blank or frozen window.
function watchRenderer(win, name) {
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`${name} renderer gone`, details);
    if (!win.isDestroyed()) win.webContents.reload();
  });
  let hungTimer = null;
  win.on('unresponsive', () => {
    log(`${name} unresponsive`);
    // Still frozen a few seconds later: kill the page, 'render-process-gone' reloads it.
    hungTimer = setTimeout(() => { if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); }, 5000);
  });
  win.on('responsive', () => {
    clearTimeout(hungTimer);
    log(`${name} responsive again`);
  });
}

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function createPill() {
  const saved = loadState().pill;
  const pos = saved && onSomeScreen({ ...saved, ...PILL }) ? saved : defaultPillPosition();
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
  watchRenderer(pill, 'pill');
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
    // Hidden most of the time; without this Chromium slows the hidden page's timers down.
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  panel.setAlwaysOnTop(true, 'floating');
  watchRenderer(panel, 'panel');
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
// Seen 20.11 and 23.11 (after the Mac slept): showInactive() runs, the window counts as visible,
// but macOS never puts it on screen — no 'show' event, and it stays that way. If the show isn't
// confirmed in time, throw the window away and show a fresh one.
const SHOW_CONFIRM_MS = 700;
// Seen 23–24.11: the list didn't show, you clicked again ("well?") — and that click closed the list
// that had just been recreated. So: a click while a show is unconfirmed means "try again now", and
// while the recreated list is coming up (and a moment after) a click doesn't close it.
const RECOVER_GRACE_MS = 800;
let unconfirmed = null; // { panel, timer } — showInactive() ran, no 'show' event yet
let recoveringUntil = 0;

// With an anchor — show the fresh window there; without — just have it ready for the next click.
function recreatePanel(anchor = null) {
  const old = panel;
  createPanel();
  old.destroy();
  if (anchor) {
    recoveringUntil = Infinity; // until the new window is shown (see showPanelNear)
    panel.webContents.once('did-finish-load', () => showPanelNear(anchor, true));
    // If the page never loads, clicks must not stay ignored.
    setTimeout(() => { if (recoveringUntil === Infinity) recoveringUntil = 0; }, 3000);
  }
}

// The "never appears" case followed sleep both times it was seen. After wake, unlock or a monitor
// change, swap the hidden list window for a fresh one before anyone clicks.
function refreshPanel(reason) {
  if (!panel || panel.isVisible()) return;
  log(`recreate the panel (${reason})`);
  recreatePanel();
}

function showPanelNear(anchor, retried = false) {
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
  const shownPanel = panel;
  let shown = false;
  const onShow = () => {
    shown = true;
    if (unconfirmed && unconfirmed.panel === shownPanel) unconfirmed = null;
    if (retried) recoveringUntil = Date.now() + RECOVER_GRACE_MS;
  };
  shownPanel.once('show', onShow);
  shownPanel.showInactive();
  const timer = setTimeout(() => {
    if (unconfirmed && unconfirmed.panel === shownPanel) unconfirmed = null;
    if (shownPanel.isDestroyed()) return;
    shownPanel.removeListener('show', onShow);
    if (retried && !shown) recoveringUntil = 0;
    // Hidden again meanwhile — nothing to fix.
    if (shown || !shownPanel.isVisible() || shownPanel !== panel) return;
    if (retried) return log('panel did not appear even after recreating');
    log('panel did not appear -> recreate the window');
    recreatePanel(anchor);
  }, SHOW_CONFIRM_MS);
  unconfirmed = { panel: shownPanel, timer };
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
  if (Date.now() < recoveringUntil) {
    log('  -> ignored: the list is being recreated after a failed show');
    return;
  }
  if (unconfirmed && unconfirmed.panel === panel && panel.isVisible()) {
    log('  -> the list never appeared: recreate it now');
    clearTimeout(unconfirmed.timer);
    unconfirmed = null;
    recreatePanel(anchor);
    return;
  }
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

// Is the app this session runs in the one in front? Then you're looking at it — the sound can wait.
// The Claude app or one VS Code holds many sessions: it's the app that counts, not the session.
const APP_BUNDLE = {
  vscode: 'com.microsoft.VSCode',
  claude: 'com.anthropic.claudefordesktop',
  codex: 'com.openai.codex',
  hermes: 'com.nousresearch.hermes.setup',
};
// Terminal sessions: which .app the process runs under (Ghostty, iTerm, VS Code's terminal…).
// Looked up in the background the first time a session is seen, long before it finishes.
const terminalApps = new Map(); // pid -> .app path, null while looking or not found
function watchTerminals(sessions) {
  const pids = new Set();
  for (const s of sessions) {
    const pid = s.open && s.open.app === 'terminal' && s.open.pid;
    if (!pid) continue;
    pids.add(pid);
    if (terminalApps.has(pid)) continue;
    terminalApps.set(pid, null);
    appOfProcess(pid).then((app) => terminalApps.set(pid, app)).catch(() => {});
  }
  for (const pid of terminalApps.keys()) if (!pids.has(pid)) terminalApps.delete(pid);
}
function inFront(s) {
  const f = focus.frontApp();
  if (!f || !s.open) return false;
  if (APP_BUNDLE[s.open.app]) return f.bundle === APP_BUNDLE[s.open.app];
  if (s.open.app === 'terminal' && s.open.pid) return Boolean(f.path) && terminalApps.get(s.open.pid) === f.path;
  return false;
}

// One bad tick (a half-written file, a window being recreated) must not stop the next one.
function poll() {
  try {
    pollOnce();
  } catch (err) {
    log('poll failed:', err.stack || err.message);
  }
}

function pollOnce() {
  const now = Date.now();
  const current = settings.get();
  // Theme: both windows follow it through prefers-color-scheme, and so does the list's blur.
  if (nativeTheme.themeSource !== current.theme) nativeTheme.themeSource = current.theme;
  latest = marks.apply(collect(current, now), now);
  watchTerminals(latest);
  alerts.check(latest, {
    globalMuted: current.muted,
    isMuted: (id) => Boolean(marks.get(id).muted),
    quiet: (s) => current.quietInFront && inFront(s),
    sound: { waiting: current.soundWaiting, asking: current.soundAsking, volume: current.soundVolume },
    now,
  });
  tray.setTitle(trayTitle(latest));
  pill.webContents.send('summary', summary(latest));
  if (panel.isVisible()) panel.webContents.send('sessions', latest);
  const took = Date.now() - now;
  if (took > 300) log('slow poll', { ms: took });
}

// An error nobody caught: write it down and keep running (by default Electron shows a dialog).
process.on('uncaughtException', (err) => log('UNCAUGHT', err && (err.stack || err.message)));
process.on('unhandledRejection', (err) => log('UNHANDLED REJECTION', err && (err.stack || err.message || String(err))));

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
  focus.rememberFront(); // who's in front at start, before any switch
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
    powerMonitor.on(ev, () => {
      log(`POWER ${ev}`);
      if (ev === 'resume' || ev === 'unlock-screen') refreshPanel(ev);
    });
  }
  screen.on('display-added', () => { log('DISPLAY added'); keepPillOnScreen(); refreshPanel('display added'); });
  screen.on('display-removed', () => { log('DISPLAY removed'); keepPillOnScreen(); refreshPanel('display removed'); });
  screen.on('display-metrics-changed', () => keepPillOnScreen());
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
