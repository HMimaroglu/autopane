// The agent's own browser: a WebContentsView driven through the Chrome DevTools
// Protocol. Input goes to this one page only; the OS cursor and keyboard are never
// touched, so it works while the window is hidden or you are using the machine.

const SNAPSHOT_JS = `(() => {
  const SELECTOR = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=combobox],' +
    '[role=textbox],[role=switch],[contenteditable=""],[contenteditable=true],[onclick]';
  const clean = (s, n = 80) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  // First non-empty source wins; hidden <label>s and empty innerText fall through.
  const labelOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    const sources = [
      el.getAttribute('aria-label'),
      by && by.split(' ').map((id) => document.getElementById(id)?.innerText || '').join(' '),
      el.labels && [...el.labels].map((l) => l.innerText).join(' '),
      el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) && el.value,
      el.innerText, el.placeholder, el.title, el.alt, el.querySelector('img')?.alt, el.name,
    ];
    return sources.find((s) => s && s.trim()) || '';
  };
  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'select';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      const t = el.type;
      if (['checkbox', 'radio'].includes(t)) return t;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      return 'textbox';
    }
    return 'button';
  };
  let next = Number(document.body.dataset.apNext || 1);
  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
    if (el.type === 'hidden') continue;
    if (!el.dataset.apId) el.dataset.apId = String(next++);
    const item = {
      id: el.dataset.apId, role: roleOf(el), name: clean(labelOf(el)),
      inView: r.bottom > 0 && r.top < innerHeight,
    };
    // Nearby text (the row or card around a button) is what separates 24 "Select" buttons.
    let up = el.parentElement;
    for (let i = 0; up && i < 5; i++, up = up.parentElement) {
      const t = clean(up.innerText, 160);
      if (t.length > item.name.length + 15) { item.near = t; break; }
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if ('checked' in el && ['checkbox', 'radio'].includes(el.type)) item.checked = el.checked;
    if (item.role === 'textbox') item.value = clean(el.value ?? el.innerText, 40);
    if (el.tagName === 'SELECT') {
      item.value = clean(el.selectedOptions[0]?.text, 40);
      item.options = [...el.options].map((o) => clean(o.text, 40));
    }
    elements.push(item);
  }
  document.body.dataset.apNext = String(next);
  const context = [...document.querySelectorAll('h1,h2,h3,[role=alert],[role=status],.alert,.error,.success')]
    .filter((el) => el.offsetParent !== null).map((el) => clean(el.innerText, 120)).filter(Boolean).slice(0, 8);
  return { url: location.href, title: document.title, context, elements,
           text: clean(document.body.innerText, 400) };
})()`;

const SETTLE_JS = `new Promise((resolve) => {
  let timer = setTimeout(done, 350);
  const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 350); });
  obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const cap = setTimeout(done, 4000);
  function done() { obs.disconnect(); clearTimeout(cap); resolve(document.readyState); }
})`;

class Page {
  constructor(webContents) {
    this.wc = webContents;
    this.cdp = webContents.debugger;
    if (!this.cdp.isAttached()) this.cdp.attach('1.3');
  }

  send(method, params = {}) {
    return this.cdp.sendCommand(method, params);
  }

  // Runs one of this file's fixed scripts inside the agent page (CDP Runtime.evaluate).
  // The only interpolated value is an element id, which sel() forces to digits.
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }

  async goto(url) {
    await this.wc.loadURL(url);
    await this.settle();
  }

  async settle() {
    // Navigation replaces the document mid-wait; retry once on the new one.
    for (let i = 0; i < 20 && this.wc.isLoading(); i++) await sleep(100);
    try {
      await this.eval(SETTLE_JS);
    } catch {
      await sleep(300);
      await this.eval(SETTLE_JS).catch(() => {});
    }
  }

  async snapshot() {
    await this.wake();
    return this.eval(SNAPSHOT_JS);
  }

  async center(id) {
    const box = await this.eval(`(() => {
      const el = document.querySelector('${sel(id)}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`element ${id} is gone`);
    return box;
  }

  // A page in a hidden or unfocused window counts as backgrounded, and Chromium
  // drops mouse input to it. Mark it active and focused before each input; a
  // navigation to a new site gets a fresh renderer, so this is re-sent every time.
  async wake() {
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  }

  async click(id) {
    await this.wake();
    const { x, y } = await this.center(id);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await this.settle();
  }

  async type(id, text, submit = false) {
    await this.click(id);
    // Some sites swap the field for a new one on focus (Wikipedia's search box does);
    // then the focused element is where the keystrokes would go.
    const found = await this.eval(`(() => {
      const el = document.querySelector('${sel(id)}') || document.activeElement;
      if (!el || el === document.body) return false;
      el.focus();
      if ('select' in el) el.select(); else document.execCommand('selectAll');
      return true;
    })()`);
    if (!found) throw new Error(`field ${id} is gone and nothing has focus`);
    await this.send('Input.insertText', { text });
    if (submit) await this.press('Enter');
    await this.settle();
  }

  async select(id, optionIndex) {
    await this.center(id);
    await this.eval(`(() => {
      const el = document.querySelector('${sel(id)}');
      el.selectedIndex = ${Number(optionIndex)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await this.settle();
  }

  async press(key) {
    const codes = { Enter: 13, Tab: 9, Escape: 27 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key === 'Enter' ? '\r' : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await this.settle();
  }

  async scroll(dy = 600) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: dy });
    await sleep(250);
  }
}

const sel = (id) => `[data-ap-id="${String(id).replace(/\D/g, '')}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Page, sleep };
