const test = require('node:test');
const assert = require('node:assert');
const { rank, kindFilter, optionLine, stepLine } = require('../src/agent');
const { parsePlan } = require('../src/planner');

const el = (id, role, name, extra = {}) => ({ id, role, name, inView: true, ...extra });

test('type and select consider every kind of field, click considers everything', () => {
  const page = [el('1', 'textbox', 'Date'), el('2', 'select', 'From'), el('3', 'button', 'Go'), el('4', 'link', 'Home')];
  assert.deepEqual(page.filter(kindFilter('type')).map((e) => e.id), ['1', '2']);
  assert.deepEqual(page.filter(kindFilter('select')).map((e) => e.id), ['1', '2']);
  assert.deepEqual(page.filter(kindFilter('click')).map((e) => e.id), ['1', '2', '3', '4']);
});

test('rank keeps the lexically best 8 in page order, using nearby row text', () => {
  const rows = Array.from({ length: 20 }, (_, i) => el(String(i + 1), 'button', 'Select',
    { near: `Airline ${i}, ${i === 13 ? 'Nonstop' : '1 stop'}, $${200 + i}` }));
  const out = rank({ action: 'click', target: 'the nonstop flight Select button' }, rows);
  assert.equal(out.length, 8);
  assert.ok(out.some((e) => e.id === '14'), 'the nonstop row survives the cut');
  const ids = out.map((e) => Number(e.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'page order preserved');
});

test('disabled elements rank below enabled ones with the same text', () => {
  const out = rank({ action: 'click', target: 'Subscribe' },
    [...Array.from({ length: 8 }, (_, i) => el(`e${i}`, 'button', 'Subscribe')), el('d', 'button', 'Subscribe', { disabled: true })]);
  assert.ok(!out.some((e) => e.id === 'd'));
});

test('option and step lines stay short and carry state', () => {
  const line = optionLine(el('1', 'checkbox', 'Email notifications', { checked: false, near: 'Settings Email notifications Dark mode' }));
  assert.match(line, /unchecked/);
  assert.ok(line.length < 160);
  assert.equal(stepLine({ action: 'type', target: 'the email field', text: 'a@b.c' }), 'type "a@b.c" into the email field');
});

test('parsePlan accepts fenced JSON and rejects unknown actions', () => {
  const plan = parsePlan('```json\n{"start_url":"https://x.y","steps":[{"action":"click","target":"Go"}],"success_check":"Done?"}\n```');
  assert.equal(plan.steps[0].action, 'click');
  assert.throws(() => parsePlan('{"start_url":"u","steps":[{"action":"drag","target":"x"}],"success_check":"q"}'));
  assert.throws(() => parsePlan('{"steps":[]}'));
});

test('the single-candidate shortcut needs every target word in the label', async () => {
  const { Agent } = require('../src/agent');
  const calls = [];
  const agent = new Agent({ page: {}, engineUrl: 'http://x' });
  agent.decide = async (state, questions) => {
    calls.push(questions[0].options.map((o) => o.id));
    return { answers: { target: { choice: 'none', confidence: 0.9 } }, ms: 1 };
  };
  const snap = { title: 't', elements: [el('7', 'textbox', 'Passenger full name')] };
  const skipped = await agent.ground({ action: 'type', target: 'the passenger full name field', text: 'x' }, snap);
  assert.equal(skipped.skipped, true);
  const asked = await agent.ground({ action: 'type', target: 'the passenger first name field', text: 'x' }, snap);
  assert.equal(asked, null, 'model answered none');
  assert.deepEqual(calls, [['7', 'none']]);
});
