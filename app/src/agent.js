// The executor. Claude's plan says WHAT to do; for every step the local SemIf model
// decides WHICH element on the live page to do it to, and at the end whether the task
// succeeded. Model cost is ~3 ms per prompt token on an M4, so each decision is kept
// to a short step line plus at most MAX_CANDIDATES one-line element descriptions.

const { plan, replan, describe } = require('./planner');

const MAX_CANDIDATES = 8;
const MIN_CONFIDENCE = 0.35;
const MAX_REPLANS = 2;
const STOP = new Set('a an the to of for in on at with and or into from this that its it field button link box input dropdown menu checkbox'.split(' '));

const words = (s) => (s || '').toLowerCase().match(/[a-z0-9$]+/g)?.filter((w) => !STOP.has(w)) || [];

const FIELDS = ['textbox', 'combobox', 'searchbox', 'select'];

// Typing into a dropdown means picking that option, and choosing in a text field
// means typing it, so type and select both consider every kind of field.
function kindFilter(action) {
  if (action === 'type' || action === 'select') return (el) => FIELDS.includes(el.role);
  return () => true;
}

const wanted = (step) => new Set(words(`${step.target} ${step.action === 'select' ? step.text : ''}`));

// Cheap lexical ranking to cut the page down before the model reads it.
function rank(step, elements) {
  const want = wanted(step);
  const scored = elements.map((el, index) => {
    const own = words(`${el.role} ${el.name} ${el.value || ''}`);
    const near = words(el.near);
    let score = 0;
    for (const w of want) {
      if (own.includes(w)) score += 3;
      else if (near.includes(w)) score += 1;
    }
    if (el.inView) score += 0.5;
    if (el.disabled) score -= 2;
    return { el, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  // Keep page order among the survivors so the model reads the page as laid out.
  return scored.slice(0, MAX_CANDIDATES).sort((a, b) => a.index - b.index).map((s) => s.el);
}

function optionLine(el) {
  let s = `${el.role} "${el.name.slice(0, 50)}"`;
  if (el.value) s += ` value "${el.value.slice(0, 20)}"`;
  if (el.checked !== undefined) s += el.checked ? ' checked' : ' unchecked';
  if (el.disabled) s += ' disabled';
  if (el.near && !el.near.startsWith(el.name)) s += ` | ${el.near.slice(0, 70)}`;
  return s;
}

function stepLine(step) {
  const text = step.text ? ` "${step.text}"` : '';
  if (step.action === 'type') return `type${text} into ${step.target}`;
  if (step.action === 'select') return `choose${text} in ${step.target}`;
  return `${step.action} ${step.target}`;
}

class Agent {
  constructor({ page, engineUrl, emit = () => {} }) {
    this.page = page;
    this.engineUrl = engineUrl;
    this.emit = emit;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  async decide(state, questions) {
    const res = await fetch(`${this.engineUrl}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, questions }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`engine: ${body.error}`);
    return body;
  }

  // Returns { el, confidence, ms, candidates } or null when nothing fits.
  async ground(step, snapshot) {
    const pool = snapshot.elements.filter(kindFilter(step.action));
    if (pool.length === 0) {
      this.emit('trace', { text: `no element of the kind "${step.action}" needs on this page` });
      return null;
    }
    const candidates = rank(step, pool);
    this.emit('trace', { text: `${pool.length} fields/elements fit, ${candidates.length} kept` });
    // Skip the model only when every word of the target is in the sole candidate's own
    // label. Being the only field on the page does not make it the field the step means
    // ("first name" must not match "Passenger full name").
    const own = new Set(words(`${candidates[0].name} ${candidates[0].role}`));
    if (candidates.length === 1 && [...wanted(step)].every((w) => own.has(w))) {
      return { el: candidates[0], confidence: 1, ms: 0, candidates: 1, skipped: true };
    }
    const state = `Page: ${snapshot.title}\nStep: ${stepLine(step)}`;
    const { answers, ms, input_tokens: tokens } = await this.decide(state, [{
      id: 'target', question: `Which element should be used to ${stepLine(step)}?`,
      options: [...candidates.map((el) => ({ id: el.id, description: optionLine(el) })),
        { id: 'none', description: 'None of these elements fits this step' }],
    }]);
    const { choice, confidence } = answers.target;
    if (choice === 'none') return null;
    return { el: candidates.find((el) => el.id === choice), confidence, ms, tokens, candidates: candidates.length };
  }

  async chooseOption(step, el) {
    const exact = el.options.findIndex((o) => o.toLowerCase() === String(step.text).toLowerCase());
    if (exact >= 0) return { index: exact, ms: 0, skipped: true };
    const ranked = el.options.map((o, i) => ({ o, i, s: words(o).filter((w) => words(step.text).includes(w)).length }))
      .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 16).sort((a, b) => a.i - b.i);
    const { answers, ms } = await this.decide(`Dropdown: ${el.name}\nWanted: ${step.text}`, [{
      id: 'option', question: `Which option matches "${step.text}"?`,
      options: ranked.map((r) => ({ id: String(r.i), description: r.o })),
    }]);
    return { index: Number(answers.option.choice), ms, confidence: answers.option.confidence };
  }

  async act(step, el) {
    if (el.role === 'select' && step.action !== 'click') {
      const option = await this.chooseOption(step, el);
      this.emit('decision', { kind: 'option', value: el.options[option.index], ...option });
      return this.page.select(el.id, option.index);
    }
    if (step.action === 'type' || step.action === 'select') {
      return this.page.type(el.id, step.text ?? '', Boolean(step.submit));
    }
    return this.page.click(el.id);
  }

  async run(task, startUrl) {
    const started = Date.now();
    const report = { task, steps: [], decisions: [], replans: 0 };
    this.emit('status', { text: 'Planning with Claude…' });
    let t = Date.now();
    const current = await plan(task, startUrl);
    report.planMs = Date.now() - t;
    report.plan = current;
    this.emit('plan', { lines: current.steps.map(stepLine), ms: report.planMs });
    // A start URL the user gave is used as given; Claude sometimes rewrites http as https.
    await this.page.goto(startUrl || current.start_url);
    return this.execute(task, current, [], report, started);
  }

  async execute(task, current, done, report, started) {
    let t;
    let queue = [...current.steps];
    while (queue.length && !this.stopped) {
      const step = queue[0];
      if (step.action === 'scroll') {
        this.emit('step', { line: stepLine(step) });
        await this.page.scroll();
        this.emit('decision', { chose: 'scrolled one screen', skipped: true });
        done.push(queue.shift());
        continue;
      }
      this.emit('step', { line: stepLine(step) });
      let snapshot = await this.page.snapshot();
      this.emit('trace', { text: `read page: ${snapshot.elements.length} elements` });
      let grounded = await this.ground(step, snapshot);
      if (!grounded || grounded.confidence < MIN_CONFIDENCE) {
        // The target may be below the fold; look once more before asking Claude.
        await this.page.scroll();
        snapshot = await this.page.snapshot();
        grounded = await this.ground(step, snapshot);
      }
      if (!grounded || grounded.confidence < MIN_CONFIDENCE) {
        if (report.replans >= MAX_REPLANS) {
          return this.finish(report, started, false, `could not find: ${step.target}`);
        }
        report.replans += 1;
        this.emit('status', { text: `Stuck on "${step.target}", asking Claude to replan…` });
        t = Date.now();
        current = await replan(task, done, snapshot);
        report.replanMs = (report.replanMs || 0) + Date.now() - t;
        this.emit('plan', { lines: current.steps.map(stepLine), ms: Date.now() - t, replan: true });
        queue = [...current.steps];
        continue;
      }
      const decision = { step: stepLine(step), chose: describe(grounded.el), confidence: grounded.confidence,
        ms: grounded.ms, tokens: grounded.tokens, candidates: grounded.candidates, skipped: Boolean(grounded.skipped) };
      report.decisions.push(decision);
      this.emit('decision', decision);
      t = Date.now();
      this.emit('trace', { text: `acting on [${grounded.el.id}]` });
      await this.act(step, grounded.el);
      report.steps.push({ ...decision, actMs: Date.now() - t });
      done.push(queue.shift());
    }
    if (this.stopped) return this.finish(report, started, false, 'stopped');

    const final = await this.page.snapshot();
    report.finalPage = { title: final.title, context: final.context, text: final.text.slice(0, 300) };
    const verdict = await this.decide(
      `Page: ${final.title}\nURL: ${final.url}\n${final.context.join(' | ')}\n${final.text.slice(0, 300)}`,
      [{ id: 'ok', question: current.success_check,
        options: [{ id: 'yes', description: 'Yes.' }, { id: 'no', description: 'No.' }] }]);
    report.check = { question: current.success_check, ...verdict.answers.ok, ms: verdict.ms };
    const ok = verdict.answers.ok.choice === 'yes';
    if (!ok && report.replans < MAX_REPLANS && !this.stopped) {
      // Plans are written before later pages are seen; one more look usually finishes it.
      report.replans += 1;
      this.emit('status', { text: 'Not done yet, asking Claude for the remaining steps…' });
      t = Date.now();
      current = await replan(task, done, final);
      report.replanMs = (report.replanMs || 0) + Date.now() - t;
      this.emit('plan', { lines: current.steps.map(stepLine), ms: Date.now() - t, replan: true });
      return this.execute(task, current, done, report, started);
    }
    return this.finish(report, started, ok, ok ? 'success check passed' : 'success check failed');
  }

  finish(report, started, ok, reason) {
    report.ok = ok;
    report.reason = reason;
    report.totalMs = Date.now() - started;
    const modelMs = report.decisions.filter((d) => !d.skipped).map((d) => d.ms);
    report.decisionMsMedian = median(modelMs);
    this.emit('done', report);
    return report;
  }
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

module.exports = { Agent, rank, optionLine, stepLine, kindFilter };
