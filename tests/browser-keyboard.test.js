import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/target-executor.js', import.meta.url), 'utf8');

class FakeInput {
  constructor(value = 'hello') {
    this.tagName = 'INPUT';
    this.type = 'text';
    this.value = value;
    this.selectionStart = value.length;
    this.selectionEnd = value.length;
    this.selectionDirection = 'none';
    this.textContent = '';
    this.innerText = '';
    this.disabled = false;
    this.readOnly = false;
    this.hidden = false;
    this.isConnected = true;
    this.labels = [{ textContent: 'Editor' }];
    this.attributes = new Map();
    this.events = [];
    this.focused = false;
  }
  focus() { this.focused = true; }
  setSelectionRange(start, end, direction = 'none') {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  closest(selector) { return selector === 'label' ? null : null; }
  getClientRects() { return [{}]; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  querySelectorAll() { return []; }
}

function loadTarget(initial = 'hello') {
  const input = new FakeInput(initial);
  const form = { querySelectorAll: () => [input] };
  const document = {
    title: 'Keyboard Fixture',
    body: { innerText: 'Keyboard Fixture Editor' },
    getElementById: () => null,
    querySelectorAll(selector) {
      if (selector === 'form') return [form];
      if (selector === 'iframe') return [];
      return [input];
    },
  };
  let onMessage;
  class FakeEvent { constructor(type, options = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, options); } }
  const context = {
    globalThis: null,
    document,
    location: { origin: 'https://fixture.example' },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLButtonElement: class {},
    InputEvent: FakeEvent,
    Event: FakeEvent,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener: (fn) => { onMessage = fn; } } } },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  const send = (tool, args) => new Promise((resolve) => {
    const keepOpen = onMessage(
      { type: 'webmcp.browser.tool', version: 1, tool, arguments: args },
      { id: 'test-extension' },
      resolve,
    );
    if (keepOpen === true) throw new Error('keyboard fixture expects synchronous target responses');
  });
  return { input, send };
}

async function editorRef(target) {
  const inspected = await target.send('inspect_form', {});
  assert.equal(inspected.ok, true);
  return inspected.result.controls.find((control) => control.name === 'Editor').ref;
}

test('keyboard can select all, delete and rewrite without exposing a raw page-wide keyboard', async () => {
  const target = loadTarget('wrong value');
  const ref = await editorRef(target);
  const result = await target.send('keyboard', {
    ref,
    actions: [
      { type: 'key', key: 'a', modifiers: ['Meta'] },
      { type: 'key', key: 'Backspace' },
      { type: 'text', text: 'right value' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(target.input.value, 'right value');
  assert.equal(result.result.selection.start, 11);
  assert.equal(result.result.selection.end, 11);
  assert.equal(result.result.selection.direction, 'none');
  assert.equal(target.input.focused, true);
});

test('keyboard supports local caret movement plus Backspace for partial correction', async () => {
  const target = loadTarget('hellp');
  const ref = await editorRef(target);
  const result = await target.send('keyboard', {
    ref,
    actions: [
      { type: 'key', key: 'ArrowLeft' },
      { type: 'key', key: 'Backspace' },
      { type: 'text', text: 'o' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(target.input.value, 'helop');
  assert.equal(result.result.selection.start, 4);
  assert.equal(result.result.selection.end, 4);
  assert.equal(result.result.selection.direction, 'none');
});

test('keyboard supports Shift+Arrow selection and replacement', async () => {
  const target = loadTarget('hello');
  const ref = await editorRef(target);
  const result = await target.send('keyboard', {
    ref,
    actions: [
      { type: 'key', key: 'ArrowLeft', modifiers: ['Shift'], repeat: 2 },
      { type: 'text', text: 'p!' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(target.input.value, 'help!');
});

test('keyboard Delete removes text after the caret', async () => {
  const target = loadTarget('abc');
  const ref = await editorRef(target);
  const result = await target.send('keyboard', {
    ref,
    actions: [
      { type: 'key', key: 'Home' },
      { type: 'key', key: 'Delete' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(target.input.value, 'bc');
});

test('keyboard accepts Ctrl+A as the cross-platform select-all equivalent', async () => {
  const target = loadTarget('abc');
  const ref = await editorRef(target);
  const result = await target.send('keyboard', {
    ref,
    actions: [{ type: 'key', key: 'a', modifiers: ['Control'] }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.selection.start, 0);
  assert.equal(result.result.selection.end, 3);
  assert.equal(result.result.selection.direction, 'forward');
});

test('keyboard fail-closes Enter and Tab so it cannot bypass commit-like click policy', async () => {
  for (const key of ['Enter', 'Tab']) {
    const target = loadTarget('draft');
    const ref = await editorRef(target);
    const result = await target.send('keyboard', { ref, actions: [{ type: 'key', key }] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(target.input.value, 'draft');
  }
});

test('keyboard protocol can represent future shortcuts while current policy rejects unsupported ones', async () => {
  const target = loadTarget('secret-free text');
  const ref = await editorRef(target);
  const result = await target.send('keyboard', {
    ref,
    actions: [{ type: 'key', key: 'c', modifiers: ['Meta'] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'KEY_NOT_SUPPORTED');
  assert.equal(target.input.value, 'secret-free text');
});
