const $ = (id) => document.getElementById(id);
const steps = $('steps');
let decisionMs = [];

const fmt = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = `status ${cls}`;
}

function li(what, how = '') {
  const item = document.createElement('li');
  item.innerHTML = '<div class="what"></div><div class="how"></div>';
  item.querySelector('.what').textContent = what;
  item.querySelector('.how').textContent = how;
  steps.append(item);
  return item;
}

// A replan replaces only the steps not yet done; finished ones stay listed.
function showPlan(lines) {
  steps.querySelectorAll('li:not(.done)').forEach((item) => item.remove());
  lines.forEach((line) => li(line));
}

window.autopane.on('engine', ({ state, backend, message }) => {
  const pill = $('engine');
  pill.className = `pill ${state}`;
  pill.textContent = state === 'ready' ? `Model ready · ${backend}` : state === 'error' ? 'Model failed' : 'Loading model…';
  if (state === 'error') setStatus(message, 'bad');
  $('run').disabled = state !== 'ready';
});

window.autopane.on('url', (url) => {
  $('url').textContent = url;
  document.querySelector('.dot').classList.add('live');
});

window.autopane.on('event', ({ type, data }) => {
  if (type === 'status') setStatus(data.text);
  if (type === 'plan') {
    showPlan(data.lines);
    if (!data.replan) $('stat-plan').textContent = fmt(data.ms);
    setStatus(data.replan ? 'Replanned' : 'Running');
  }
  if (type === 'step') {
    const item = steps.querySelector('li:not(.done)');
    if (item) item.classList.add('active');
  }
  if (type === 'decision' && !data.kind) {
    const item = steps.querySelector('li.active');
    if (item) {
      item.classList.replace('active', 'done');
      item.querySelector('.how').textContent = data.skipped
        ? `${data.chose} · no model call needed`
        : `${data.chose} · ${Math.round(data.confidence * 100)}% · ${fmt(data.ms)} · ${data.candidates} candidates`;
    }
    if (!data.skipped) decisionMs.push(data.ms);
    if (!decisionMs.length) return;
    const sorted = [...decisionMs].sort((a, b) => a - b);
    $('stat-decide').textContent = fmt(sorted[Math.floor(sorted.length / 2)]);
    $('stats').hidden = false;
  }
  if (type === 'done') {
    $('stat-total').textContent = fmt(data.totalMs);
    $('stats').hidden = false;
    setStatus(data.ok ? `Done: ${data.reason}` : `Did not finish: ${data.reason}`, data.ok ? 'ok' : 'bad');
    $('run').disabled = false;
    $('stop').disabled = true;
  }
});

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const task = $('task').value.trim();
  if (!task) return;
  decisionMs = [];
  steps.replaceChildren();
  $('stats').hidden = true;
  $('run').disabled = true;
  $('stop').disabled = false;
  window.autopane.run(task, $('start').value.trim());
});

$('stop').addEventListener('click', () => window.autopane.stop());
