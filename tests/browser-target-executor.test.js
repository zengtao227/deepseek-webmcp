import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/target-executor.js', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./fixtures/browser-form.html', import.meta.url), 'utf8');

class FakeElement {
  constructor(tagName, {
    type = '',
    value = '',
    text = '',
    visible = true,
    disabled = false,
    readOnly = false,
    checked,
    attrs = {},
    labels = [],
    options,
    isContentEditable = false,
  } = {}) {
    this.tagName = tagName.toUpperCase();
    this.type = type;
    this.value = value;
    this.textContent = text;
    this.innerText = text;
    this.visible = visible;
    this.disabled = disabled;
    this.readOnly = readOnly;
    this.isConnected = true;
    this.labels = labels;
    this.events = [];
    this.clicks = 0;
    this.attributes = new Map(Object.entries(attrs));
    if (checked !== undefined) this.checked = checked;
    if (options) this.options = options;
    this.multiple = false;
    this.isContentEditable = isContentEditable;
    this.focused = false;
  }

  focus() {
    this.focused = true;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  closest(selector) {
    if (selector === '[inert]' && this.inert) return this;
    if (selector === 'label') return this.wrappingLabel ?? null;
    return null;
  }

  getClientRects() {
    return this.visible ? [{}] : [];
  }

  dispatchEvent(event) {
    this.events.push(event.type);
    return true;
  }

  click() {
    this.clicks += 1;
    if (this.type === 'checkbox') this.checked = !this.checked;
    if (this.type === 'radio') this.checked = true;
  }

  querySelectorAll() {
    return [];
  }
}

class HTMLInputElement extends FakeElement {
  constructor(options) { super('input', options); }
}
class HTMLTextAreaElement extends FakeElement {
  constructor(options) { super('textarea', options); }
}
class HTMLSelectElement extends FakeElement {
  constructor(options) { super('select', options); }
}
class HTMLButtonElement extends FakeElement {
  constructor(options) { super('button', options); }
}

function label(text) {
  return { textContent: text };
}

function option(value, text, selected = false) {
  return { value, textContent: text, label: text, selected, disabled: false };
}

function loadTarget() {
  const employee = new HTMLInputElement({ type: 'text', labels: [label('Employee Name')] });
  const date = new HTMLInputElement({ type: 'date', labels: [label('Travel Date')] });
  const country = new HTMLSelectElement({
    value: '',
    labels: [label('Country')],
    options: [
      option('', 'Choose a country', true),
      option('CH', 'Switzerland'),
      option('SG', 'Singapore'),
    ],
  });
  const amount = new HTMLInputElement({ type: 'number', labels: [label('Amount')] });
  const password = new HTMLInputElement({ type: 'password', value: 'fixture-secret', labels: [label('Approval Password')] });
  const hidden = new HTMLInputElement({ type: 'hidden', value: 'hidden-security-token', visible: false });
  const disabled = new HTMLInputElement({ type: 'text', value: 'do-not-touch', disabled: true, labels: [label('Inactive Field')] });
  const safe = new HTMLButtonElement({ type: 'button', text: 'Show details', attrs: { 'aria-expanded': 'false', 'aria-controls': 'details' } });
  const submit = new HTMLButtonElement({ type: 'submit', text: 'Submit' });
  const mailRow = new FakeElement('tr', {
    text: 'Revolut Action needed: review new Trading T&Cs',
    attrs: { role: 'row' },
  });
  const reply = new HTMLButtonElement({
    type: 'submit',
    text: 'Reply',
    attrs: { 'aria-label': 'Reply' },
  });
  const editor = new FakeElement('div', {
    text: '',
    attrs: { role: 'textbox', contenteditable: 'true', 'aria-label': 'Message Body' },
    isContentEditable: true,
  });

  const formControls = [employee, date, country, amount, password, hidden, disabled, safe, submit, reply, editor];
  const pageInteractives = [...formControls, mailRow];
  const form = new FakeElement('form');
  form.querySelectorAll = () => formControls;

  const document = {
    title: 'Employee Travel Claim',
    body: { innerText: 'Employee Travel Claim Employee Name Travel Date Country Amount Show details Submit Revolut Action needed Reply' },
    getElementById: () => null,
    createRange: undefined,
    execCommand: undefined,
    querySelectorAll(selector) {
      if (selector === 'form') return [form];
      if (selector === 'iframe') return [];
      if (selector.includes('a[href]') || selector.includes('[role="row"]')) return pageInteractives;
      return formControls;
    },
  };

  let onMessage;
  const context = {
    globalThis: null,
    document,
    location: { origin: 'https://fixture.example' },
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLButtonElement,
    InputEvent: class { constructor(type) { this.type = type; } },
    Event: class { constructor(type) { this.type = type; } },
    getComputedStyle: (element) => ({
      display: element.visible ? 'block' : 'none',
      visibility: 'visible',
      opacity: '1',
    }),
    chrome: {
      runtime: {
        id: 'test-extension',
        onMessage: { addListener: (fn) => { onMessage = fn; } },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const send = (tool, args) => new Promise((resolve) => {
    let settled = false;
    const sendResponse = (response) => {
      settled = true;
      resolve(response);
    };
    const keepOpen = onMessage(
      { type: 'webmcp.browser.tool', version: 1, tool, arguments: args },
      { id: 'test-extension' },
      sendResponse,
    );
    if (!settled && keepOpen !== true) resolve(undefined);
  });

  return { send, controls: { employee, date, country, amount, password, hidden, disabled, safe, submit, mailRow, reply, editor } };
}

const byName = (result, name) => result.result.controls.find((control) => control.name === name);

test('browser fixture contains the deterministic V1 form controls', () => {
  for (const text of ['Employee Name', 'Travel Date', 'Country', 'Amount', 'Submit']) {
    assert.match(fixture, new RegExp(text));
  }
});

test('visible form controls are discovered with stable semantic refs; hidden and inactive controls are excluded', async () => {
  const target = loadTarget();
  const first = await target.send('inspect_form', {});
  const second = await target.send('inspect_form', {});

  assert.equal(first.ok, true);
  assert.deepEqual(
    Array.from(first.result.controls, ({ name }) => name),
    ['Employee Name', 'Travel Date', 'Country', 'Amount', 'Approval Password', 'Show details', 'Submit', 'Reply', 'Message Body'],
  );
  assert.equal(first.result.controls.some(({ name }) => name === 'Inactive Field'), false);
  assert.equal(JSON.stringify(first).includes('hidden-security-token'), false);

  const firstRefs = Object.fromEntries(first.result.controls.map(({ name, ref }) => [name, ref]));
  const secondRefs = Object.fromEntries(second.result.controls.map(({ name, ref }) => [name, ref]));
  assert.deepEqual(secondRefs, firstRefs);
  assert.match(firstRefs['Employee Name'], /^e\d+$/);
});

test('password controls are identified but their values are always redacted', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const password = byName(inspected, 'Approval Password');
  assert.equal(password.type, 'password');
  assert.equal(password.value, '[REDACTED]');
  assert.equal(JSON.stringify(inspected).includes('fixture-secret'), false);

  const filled = await target.send('fill', { ref: password.ref, value: 'new-secret' });
  assert.equal(filled.ok, true);
  assert.equal(filled.result.value, '[REDACTED]');
  assert.equal(target.controls.password.value, 'new-secret');
  assert.equal(JSON.stringify(filled).includes('new-secret'), false);
});

test('fill changes only the referenced text-like field', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const employee = byName(inspected, 'Employee Name');
  const amountBefore = target.controls.amount.value;

  const result = await target.send('fill', { ref: employee.ref, value: 'Ada Lovelace' });
  assert.equal(result.ok, true);
  assert.equal(target.controls.employee.value, 'Ada Lovelace');
  assert.equal(target.controls.amount.value, amountBefore);
  assert.deepEqual(target.controls.employee.events, ['input', 'change']);
});

test('select changes only the referenced select and accepts a visible option label', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const country = byName(inspected, 'Country');

  const result = await target.send('select', { ref: country.ref, value: 'Switzerland' });
  assert.equal(result.ok, true);
  assert.equal(target.controls.country.value, 'CH');
  assert.equal(target.controls.employee.value, '');
  assert.equal(target.controls.country.options.find((item) => item.value === 'CH').selected, true);
  assert.deepEqual(target.controls.country.events, ['input', 'change']);
});

test('safe click executes only the referenced non-commit control', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const safe = byName(inspected, 'Show details');

  const result = await target.send('click', { ref: safe.ref });
  assert.equal(result.ok, true);
  assert.equal(target.controls.safe.clicks, 1);
  assert.equal(target.controls.submit.clicks, 0);
});

test('semantic mail row is exposed by inspect_page and can be opened safely', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_page', {});
  const row = inspected.result.elements.find(({ name }) => name.includes('Revolut Action needed'));

  assert.ok(row);
  assert.equal(row.role, 'row');

  const result = await target.send('click', { ref: row.ref });
  assert.equal(result.ok, true);
  assert.equal(target.controls.mailRow.clicks, 1);
});

test('Reply action is allowed even when the site implements it as a submit-like button', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const reply = byName(inspected, 'Reply');

  assert.ok(reply);
  const result = await target.send('click', { ref: reply.ref });
  assert.equal(result.ok, true);
  assert.equal(target.controls.reply.clicks, 1);
});

test('a Reply-labelled action that also commits Send is still confirmation-gated', async () => {
  const target = loadTarget();
  target.controls.reply.textContent = 'Reply and Send';
  target.controls.reply.innerText = 'Reply and Send';
  target.controls.reply.attributes.set('aria-label', 'Reply and Send');

  const inspected = await target.send('inspect_form', {});
  const reply = byName(inspected, 'Reply and Send');
  const result = await target.send('click', { ref: reply.ref });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(target.controls.reply.clicks, 0);
});

test('fill supports contenteditable message bodies used by webmail composers', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const editor = byName(inspected, 'Message Body');

  assert.ok(editor);
  const result = await target.send('fill', { ref: editor.ref, value: 'Thanks, I have reviewed this.' });
  assert.equal(result.ok, true);
  assert.equal(target.controls.editor.textContent, 'Thanks, I have reviewed this.');
  assert.equal(target.controls.editor.focused, true);
  assert.deepEqual(target.controls.editor.events, ['input', 'change']);
});

test('submit-like click fails closed with CONFIRMATION_REQUIRED', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const submit = byName(inspected, 'Submit');

  const result = await target.send('click', { ref: submit.ref });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(target.controls.submit.clicks, 0);
});

test('unclassified button clicks also fail closed instead of trusting an unknown JavaScript action', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const safe = byName(inspected, 'Show details');
  target.controls.safe.attributes.delete('aria-expanded');
  target.controls.safe.attributes.delete('aria-controls');
  target.controls.safe.textContent = 'Mystery action';
  target.controls.safe.innerText = 'Mystery action';

  const result = await target.send('click', { ref: safe.ref });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(result.error.details.reason, 'unclassified click action');
  assert.equal(target.controls.safe.clicks, 0);
});

test('stale and invalid refs fail closed', async () => {
  const target = loadTarget();
  const inspected = await target.send('inspect_form', {});
  const amount = byName(inspected, 'Amount');

  target.controls.amount.isConnected = false;
  assert.equal((await target.send('fill', { ref: amount.ref, value: '99' })).error.code, 'STALE_REF');
  assert.equal((await target.send('fill', { ref: 'e99999', value: '99' })).error.code, 'INVALID_REF');
  assert.equal((await target.send('fill', { ref: 'not-a-ref', value: '99' })).error.code, 'INVALID_REF');
});
