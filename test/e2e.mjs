// End-to-end: real Claude planner, real local model, real Electron app run hidden.
// Passes only if the fixture server recorded the right submission (or, for the live
// site, the agent landed on the right page) while the window stayed hidden and
// unfocused the whole time, which OS-level mouse or keyboard input could not reach.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startFixtures, CHEAPEST_NONSTOP } from './fixtures/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
// The electron package exports its binary's path; spawning it directly avoids a
// shell, which on Windows would split the task text on spaces.
const ELECTRON = createRequire(path.join(APP, 'package.json'))('electron');
const PYTHON = process.platform === 'win32'
  ? path.join(ROOT, 'engine', '.venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'engine', '.venv', 'bin', 'python');
// --fixed-plans: use test/fixed-plans.json instead of calling Claude (for CI machines
// without a Claude login). Everything else, model and app included, is real.
const fixed = process.argv.includes('--fixed-plans');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const PLANS = path.join(ROOT, 'test', 'fixed-plans.json');

function startEngine() {
  const config = fs.readFileSync(path.join(os.homedir(), '.autopane', 'config.json'), 'utf8');
  const child = spawn(PYTHON, [path.join(ROOT, 'engine', 'server.py'), '--config', config, '--exit-with-stdin'], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      const m = String(d).match(/READY (\d+)/);
      if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}` });
    });
    child.on('exit', (code) => reject(new Error(`engine exited ${code}`)));
  });
}

function runApp(task, startUrl, engineUrl) {
  const report = path.join(os.tmpdir(), `autopane-${Date.now()}.json`);
  const args = ['.', '--hidden', '--task', task, '--report', report];
  if (startUrl) args.push('--start-url', startUrl);
  return new Promise((resolve) => {
    const env = { ...process.env, AUTOPANE_ENGINE_URL: engineUrl, ...(fixed ? { AUTOPANE_FIXED_PLANS: PLANS } : {}) };
    const child = spawn(ELECTRON, args, { cwd: APP, env, stdio: 'inherit' });
    child.on('exit', () => resolve(fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : { ok: false, reason: 'no report' }));
  });
}

const fixtures = await startFixtures();
const site = fixtures.url;
const last = (p) => fixtures.records.filter((r) => r.path === p).at(-1)?.data;

const cases = [
  {
    name: 'newsletter',
    task: 'Sign up for the newsletter with the email jane@example.com',
    start: `${site}/newsletter`,
    check: () => last('/api/subscribe')?.email === 'jane@example.com',
  },
  {
    name: 'flights',
    task: 'Search flights from BOS to KEF on 2026-12-30, then book the cheapest nonstop flight for passenger Jane Doe',
    start: `${site}/flights`,
    check: () => last('/api/book')?.id === CHEAPEST_NONSTOP.id && last('/api/book')?.name === 'Jane Doe',
  },
  {
    name: 'settings',
    task: 'Sign in with username demo and password opensesame, go to Settings, turn on email notifications, and save',
    start: `${site}/login`,
    check: () => last('/api/login')?.user === 'demo' && last('/api/login')?.pass === 'opensesame'
      && last('/api/settings')?.notify === 'on' && last('/api/settings')?.dark === 'on',
  },
  {
    name: 'wikipedia (live site)',
    task: 'Search English Wikipedia for Alan Turing and open his article',
    start: 'https://en.wikipedia.org/wiki/Main_Page',
    check: (r) => /\/wiki\/Alan_Turing$/.test(r.finalUrl || ''),
  },
].filter((c) => !only || c.name.startsWith(only));

const engine = process.env.AUTOPANE_ENGINE_URL ? { url: process.env.AUTOPANE_ENGINE_URL } : await startEngine();
const rows = [];
let failures = 0;
for (const c of cases) {
  const r = await runApp(c.task, c.start, engine.url);
  const outcome = c.check(r);
  const isolated = r.windowVisible === false && r.windowFocused === false;
  const pass = outcome && isolated;
  if (!pass) failures += 1;
  const modelCalls = (r.decisions || []).filter((d) => !d.skipped);
  rows.push({
    case: c.name, pass, outcome, agentSaid: r.ok, reason: r.reason, isolated,
    steps: r.decisions?.length ?? 0, modelCalls: modelCalls.length,
    decisionMedianMs: r.decisionMsMedian, decisionMaxMs: modelCalls.length ? Math.max(...modelCalls.map((d) => d.ms)) : null,
    planMs: r.planMs, replans: r.replans, totalMs: r.totalMs,
  });
  if (!pass) console.log(JSON.stringify(r, null, 1).slice(0, 4000));
}
console.table(rows);
engine.child?.kill();
fixtures.server.close();
process.exit(failures ? 1 : 0);
