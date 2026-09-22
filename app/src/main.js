// Autopane: a window with a control panel on the left and the agent's own browser on
// the right. The browser is a separate WebContentsView with its own cookie jar; the
// agent drives it through CDP, never through the OS mouse or keyboard.
//
// Headless run (used by the tests):
//   electron . --task "..." [--start-url URL] --report out.json --hidden

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Page } = require('./page');
const { Agent } = require('./agent');

const PANEL_WIDTH = 400;
const BAR_HEIGHT = 44;
// Sites lay out for at least this many CSS pixels, whatever the window size, so a
// small window or screen never collapses search boxes and menus into icons.
const LAYOUT_WIDTH = 1300;
const ROOT = path.resolve(__dirname, '..', '..');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const headless = process.argv.includes('--hidden');

let win;
let view;
let page;
let engine;
let engineUrl = process.env.AUTOPANE_ENGINE_URL;
let agent;

function resolveClaude() {
  if (process.env.AUTOPANE_CLAUDE || process.platform === 'win32') return;
  // Apps launched from Finder get a bare PATH; ask the login shell where claude lives.
  try {
    const found = execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
    if (found) process.env.AUTOPANE_CLAUDE = found;
  } catch { /* fall back to PATH */ }
}

function startEngine() {
  if (engineUrl) return Promise.resolve(engineUrl);
  const config = fs.readFileSync(path.join(os.homedir(), '.autopane', 'config.json'), 'utf8');
  const python = process.platform === 'win32'
    ? path.join(ROOT, 'engine', '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, 'engine', '.venv', 'bin', 'python');
  engine = spawn(python, [path.join(ROOT, 'engine', 'server.py'), '--config', config, '--exit-with-stdin'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let log = '';
    engine.stderr.on('data', (d) => { log = (log + d).slice(-2000); });
    engine.stdout.on('data', (d) => {
      const m = String(d).match(/READY (\d+)/);
      if (m) {
        engineUrl = `http://127.0.0.1:${m[1]}`;
        resolve(engineUrl);
      }
    });
    engine.on('exit', (code) => reject(new Error(`engine exited ${code}: ${log}`)));
  });
}

function agentZoom() {
  return Math.min(1, Math.max(1, view.getBounds().width) / LAYOUT_WIDTH);
}

function layout() {
  const [w, h] = win.getContentSize();
  view.setBounds({ x: PANEL_WIDTH, y: BAR_HEIGHT, width: Math.max(0, w - PANEL_WIDTH), height: Math.max(0, h - BAR_HEIGHT) });
  if (view.webContents.getURL()) view.webContents.setZoomFactor(agentZoom());
}

let onDone = () => {};

function send(channel, payload) {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
  if (channel === 'event' && payload.type === 'done') onDone(payload.data);
  // Hidden runs print progress so a CI log shows where a task stalls.
  if (headless && channel === 'event') {
    const d = payload.data;
    const detail = payload.type === 'decision' ? `${d.chose || d.value} ${d.ms ?? 0} ms`
      : payload.type === 'step' ? d.line : payload.type === 'done' ? `${d.ok} ${d.reason}` : d?.text || '';
    console.log(`[autopane] ${payload.type} ${detail}`);
  }
}

// UI test: type the task into the real form, press the real Run button, wait for the
// finished state, then save screenshots of the panel and the agent's browser.
async function uiTest(task, startUrl, outDir) {
  const finished = new Promise((resolve) => { onDone = resolve; });
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('task').value = ${JSON.stringify(task)};
    document.getElementById('start').value = ${JSON.stringify(startUrl || '')};
    document.getElementById('run').click();
  })()`);
  const report = await finished;
  await new Promise((r) => setTimeout(r, 500));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'panel.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(outDir, 'browser.png'), (await view.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(outDir, 'panel-text.txt'), await win.webContents.executeJavaScript('document.body.innerText'));
  return report;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 600, show: !headless,
    title: 'Autopane', backgroundColor: '#f5f5f7',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  view = new WebContentsView({
    webPreferences: { partition: 'persist:autopane-agent', backgroundThrottling: false, sandbox: true },
  });
  win.contentView.addChildView(view);
  layout();
  win.on('resize', layout);
  view.webContents.on('did-finish-load', () => view.webContents.setZoomFactor(agentZoom()));
  view.webContents.on('did-navigate', (_e, url) => send('url', url));
  view.webContents.on('did-navigate-in-page', (_e, url) => send('url', url));
  view.webContents.setWindowOpenHandler(({ url }) => {
    view.webContents.loadURL(url); // keep popups inside the agent's own view
    return { action: 'deny' };
  });
  page = new Page(view.webContents);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

async function runTask(task, startUrl) {
  agent = new Agent({ page, engineUrl, emit: (type, data) => send('event', { type, data }) });
  try {
    return await agent.run(task, startUrl);
  } catch (error) {
    const report = { task, ok: false, reason: `error: ${error.message}` };
    send('event', { type: 'done', data: report });
    return report;
  }
}

ipcMain.handle('run', (_e, { task, startUrl }) => runTask(task, startUrl || undefined));
ipcMain.handle('stop', () => agent?.stop());

app.whenReady().then(async () => {
  resolveClaude();
  await createWindow();
  send('engine', { state: 'loading' });
  try {
    await startEngine();
    const health = await (await fetch(`${engineUrl}/health`)).json();
    send('engine', { state: 'ready', backend: health.backend });
  } catch (error) {
    send('engine', { state: 'error', message: error.message });
    if (headless) {
      console.error(error.message);
      app.exit(2);
    }
    return;
  }
  const task = arg('task');
  if (task) {
    const report = process.env.AUTOPANE_UI_TEST
      ? await uiTest(task, arg('start-url'), process.env.AUTOPANE_UI_TEST)
      : await runTask(task, arg('start-url'));
    report.windowVisible = win.isVisible();
    report.windowFocused = win.isFocused();
    report.finalUrl = view.webContents.getURL();
    if (arg('report')) fs.writeFileSync(arg('report'), JSON.stringify(report, null, 2));
    if (headless) app.exit(report.ok ? 0 : 1);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => engine?.kill());
