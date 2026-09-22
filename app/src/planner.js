// Claude writes the plan: a start URL and a list of small browser steps with the
// literal text to type. It runs through the Claude Code CLI on the user's own
// login (no API key), with tools, MCP servers, skills and settings all switched off.

const { spawn } = require('node:child_process');

const SYSTEM = `You plan browser tasks for a fast executor that can only do these actions:
- click: click one element (button, link, checkbox, radio, tab)
- type: type literal text into one field; set "submit": true to press Enter afterwards
- select: choose one option in a dropdown; "text" is the option to choose
- scroll: scroll down one screen
Each step names ONE target element by what a user would see ("the 'Subscribe' button",
"the email field", "the cheapest nonstop flight's Select button"). Never invent values
the task does not give. Put exact text to type or select in "text".
You cannot see pages you have not been shown, so do not invent filters, tabs or menus. For a page
you have not seen, plan the obvious step (for results, the Select button of the item the task
asks for). If a target turns out to be missing, you will be called again with the live page.
Reply with JSON only, no prose:
{"start_url": "https://...", "steps": [{"action": "click|type|select|scroll", "target": "...", "text": "...", "submit": false}],
 "success_check": "a yes/no question that is true on the final page only if the task succeeded"}
The success_check is answered from the final page's visible text alone. Ask whether the page shows
success in general terms ("Does the page confirm the subscription?"); do not require the page to
repeat values that were typed, since most sites do not echo them back.`;

const REPLAN = `The executor is stuck. Given the task, the steps already done, and the current page,
write the REMAINING steps from here. Same JSON shape; start_url is the current URL.`;

function runClaude(prompt, { model = 'sonnet', timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', model, '--output-format', 'json',
      '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--disable-slash-commands', '--no-session-persistence'];
    const child = spawn(process.env.AUTOPANE_CLAUDE || 'claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err || out}`.slice(0, 500)));
      try {
        resolve(parsePlan(JSON.parse(out).result));
      } catch (e) {
        reject(new Error(`planner returned something unusable: ${e.message}`));
      }
    });
  });
}

function parsePlan(text) {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const plan = JSON.parse(json);
  if (!plan.start_url || !Array.isArray(plan.steps) || !plan.success_check) throw new Error('missing fields');
  for (const step of plan.steps) {
    if (!['click', 'type', 'select', 'scroll'].includes(step.action)) throw new Error(`bad action ${step.action}`);
  }
  return plan;
}

function plan(task, startUrl) {
  const hint = startUrl ? `\nStart at: ${startUrl}` : '';
  return runClaude(`Task: ${task}${hint}`);
}

function replan(task, done, snapshot) {
  const page = snapshot.elements.slice(0, 80).map(describe).join('\n');
  return runClaude(`${REPLAN}\n\nTask: ${task}\nSteps done:\n${done.map((s) => `- ${s.action} ${s.target}`).join('\n') || '- none'}\n` +
    `Current URL: ${snapshot.url}\nPage: ${snapshot.title}\n${snapshot.context.join(' | ')}\nElements:\n${page}`);
}

function describe(el) {
  let s = `[${el.id}] ${el.role} "${el.name}"`;
  if (el.value) s += ` value="${el.value}"`;
  if (el.checked !== undefined) s += el.checked ? ' checked' : ' unchecked';
  if (el.disabled) s += ' disabled';
  return s;
}

module.exports = { plan, replan, parsePlan, describe };
