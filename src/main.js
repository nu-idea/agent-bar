// Main process: owns the floating pill, the list panel, the menu bar icon and the polling loop.
// All file access happens here; windows only render what they are sent.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, nativeImage, ipcMain, screen } = require('electron');
const { collect } = require('./sessions');

const POLL_MS = 2000;
const PANEL = { width: 380, height: 520 };
const PILL = { width: 120, height: 30 };
const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');

let tray = null;
let pill = null;
let panel = null;
let latest = [];
let panelHiddenAt = 0;

function summary(sessions) {
  const working = sessions.filter((s) => s.status === 'working').length;
  return { working, waiting: sessions.length - working };
}

function trayTitle(sessions) {
  const { working, waiting } = summary(sessions);
  if (!sessions.length) return ' ◦';
  return ' ' + [working && `● ${working}`, waiting && `✓ ${waiting}`].filter(Boolean).join('  ');
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
  panel = new BrowserWindow({
    ...PANEL,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    vibrancy: 'popover',
    type: 'panel', // see createPill: opens over a fullscreen app without switching Space
    acceptFirstMouse: true,
    webPreferences,
  });
  panel.setAlwaysOnTop(true, 'floating');
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.loadFile(path.join(__dirname, 'ui', 'index.html'));
  panel.on('blur', () => {
    // A non-activating panel can lose focus while you're still clicking inside it; only a click
    // elsewhere should close it.
    const p = screen.getCursorScreenPoint();
    const b = panel.getBounds();
    if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return;
    panel.hide();
    panelHiddenAt = Date.now();
  });
}

// Place the panel next to an anchor rectangle (the pill or the tray icon), inside the screen.
function showPanelNear(anchor) {
  const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
  let x = Math.round(anchor.x + anchor.width / 2 - PANEL.width / 2);
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - PANEL.width - 8);
  const below = anchor.y + anchor.height + 6;
  const y = below + PANEL.height <= area.y + area.height ? below : Math.max(area.y + 8, anchor.y - PANEL.height - 6);
  panel.setPosition(x, Math.round(y), false);
  panel.webContents.send('sessions', latest);
  // No focus(): focusing activates the app, and activation is what makes macOS switch Space.
  // The panel becomes focused when you click inside it; after that, clicking elsewhere hides it.
  panel.showInactive();
}

function togglePanel(anchor) {
  // A click on the pill first blurs the panel (which hides it); don't reopen it right away.
  if (panel.isVisible() || Date.now() - panelHiddenAt < 250) {
    panel.hide();
    return;
  }
  showPanelNear(anchor);
}

function poll() {
  latest = collect();
  tray.setTitle(trayTitle(latest));
  pill.webContents.send('summary', summary(latest));
  if (panel.isVisible()) panel.webContents.send('sessions', latest);
}

// Only one copy at a time: a second launch just quits.
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  if (app.dock) app.dock.hide(); // no Dock icon

  // The menu bar icon stays as a second way in; on notched MacBooks it may end up hidden.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('agent-bar');
  tray.on('click', () => togglePanel(tray.getBounds()));

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
  ipcMain.on('pill-click', () => togglePanel(pill.getBounds()));
  ipcMain.on('quit', () => app.quit());

  poll();
  setInterval(poll, POLL_MS);
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep living
