import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

// Minimal fake of the live DeepSeek DOM facts the observer depends on.
function fakeMessage(text) {
  const attributes = {};
  const node = { nodeType: 3, nodeValue: text };
  return {
    attributes,
    childNodes: [node],
    firstChild: node,
    closest: () => null,
    style: { setProperty: (name, value) => { attributes[name] = value; } },
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute: (name, value) => { attributes[name] = value; },
  };
}

function loadPage({ answers = [], generating = false, path = '/a/chat/s/one', replies = {}, messages: typed = [] } = {}) {
  const page = { answers: [...answers], composerValue: '', disabled: !generating, stopVisible: generating, sent: [], clicks: 0, typed: typed.map(fakeMessage) };
  const control = {
    classList: { contains: (name) => name === 'ds-button--disabled' && page.disabled },
    querySelector: () => (page.stopVisible ? {} : null),
    closest: () => control,
    click() {
      page.clicks += 1;
      page.sent.push(page.composerValue);
      page.composerValue = '';
    },
  };
  class HTMLTextAreaElement {
    focus() {}
    get value() { return page.composerValue; }
    dispatchEvent() { page.disabled = page.composerValue === ''; return true; }
  }
  Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
    get() { return page.composerValue; },
    set(text) { page.composerValue = text; },
  });
  const composer = new HTMLTextAreaElement();
  let tick = null;
  let onMutation = null;
  const messages = [];
  const location = { origin: 'https://chat.deepseek.com', pathname: path, get href() { return `https://chat.deepseek.com${this.pathname}`; } };
  let onRuntimeMessage = null;
  const documentListeners = {};
  const context = {
    location,
    HTMLTextAreaElement,
    InputEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: (fn) => { tick = fn; return 0; },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { onMutation = this.fn; } },
    requestAnimationFrame: (fn) => fn(),
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({ color: 'rgb(240, 240, 240)' }),
    window: { getSelection: () => null },
    Date: { now: () => page.now },
    document: {
      body: {},
      head: { append() {} },
      createElement: () => ({}),
      addEventListener: (type, fn) => { (documentListeners[type] ??= []).push(fn); },
      querySelector: (selector) => (selector.startsWith('textarea') ? composer : control),
      querySelectorAll: (selector) => (selector === 'div, span'
        ? page.typed
        : page.answers.map((text) => ({ textContent: text, querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null }))),
    },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          return replies[message.type] ?? { ok: true };
        },
        onMessage: { addListener: (fn) => { onRuntimeMessage = fn; } },
      },
    },
  };
  page.now = 0;
  vm.runInNewContext(source, context);
  return {
    page,
    messages,
    setReply(type, value) { replies[type] = value; },
    navigate(nextPath) { location.pathname = nextPath; },
    notify(message) { onRuntimeMessage?.(message); },
    press(init) {
      const event = { type: 'keydown', target: composer, key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, defaultPrevented: false, ...init };
      event.preventDefault = () => { event.defaultPrevented = true; };
      event.stopImmediatePropagation = () => {};
      for (const fn of documentListeners.keydown ?? []) fn(event);
      return event;
    },
    mutate() { onMutation?.([]); },
    async advance(ms, steps = 1) {
      for (let index = 0; index < steps; index += 1) {
        page.now += ms;
        tick();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

const completions = (messages) => messages.filter((message) => message.type === 'work.completion');

test('existing history is reported only once, flagged as a resume check the worker must approve', async () => {
  const page = loadPage({ answers: ['<webmcp_tool_call>{"id":"old","name":"read","arguments":{}}</webmcp_tool_call>'] });
  await page.advance(500, 20);
  assert.deepEqual(completions(page.messages).map((message) => message.resume), [true]);
});

test('a generation seen in one conversation is never reported after switching to another', async () => {
  const page = loadPage({ answers: ['streaming in one'], generating: true });
  await page.advance(500, 2);
  page.page.stopVisible = false;
  page.navigate('/a/chat/s/two');
  page.page.answers = ['history of two'];
  await page.advance(500, 20);
  assert.deepEqual(completions(page.messages).map((message) => [message.text, message.resume]), [['history of two', true]]);
});

test('a result for another conversation is never typed into the displayed one', async () => {
  const page = loadPage({ answers: ['call'], generating: true, path: '/a/chat/s/two' });
  page.setReply('work.completion', { continueWith: 'result for one', conversationPath: '/a/chat/s/one' });
  await page.advance(500, 1);
  page.page.stopVisible = false;
  await page.advance(500, 10);
  assert.deepEqual(page.page.sent, []);
});

test('returning to a conversation delivers its pending result', async () => {
  const page = loadPage({ answers: ['x'], path: '/a/chat/s/two' });
  page.setReply('work.arrive', { work: true, continueWith: 'pending for one', conversationPath: '/a/chat/s/one' });
  await page.advance(500, 1);
  assert.deepEqual(page.page.sent, []);
  page.navigate('/a/chat/s/one');
  await page.advance(500, 1);
  assert.deepEqual(page.page.sent, ['pending for one']);
  const result = page.messages.find((message) => message.type === 'work.continuation-result');
  assert.equal(result.conversationPath, '/a/chat/s/one');
});

test('an enabled Send control without a Stop icon is not treated as generation', async () => {
  const page = loadPage({ answers: ['not a new answer'] });
  page.page.disabled = false;
  page.page.stopVisible = false;
  await page.advance(500, 20);
  assert.equal(completions(page.messages).filter((message) => !message.resume).length, 0);
});

test('a generated answer is reported once, only after it stays stable', async () => {
  const page = loadPage({ answers: ['partial'], generating: true });
  await page.advance(500, 2);
  page.page.disabled = true;
  page.page.stopVisible = false;
  page.page.answers[0] = 'final answer';
  await page.advance(500, 3);
  assert.equal(completions(page.messages).length, 0);
  await page.advance(500, 10);
  assert.deepEqual(completions(page.messages).map((message) => message.text), ['final answer']);
});

test('continuation writes the returned text into the composer and clicks Send', async () => {
  const page = loadPage({ answers: ['call'], generating: true });
  page.setReply('work.completion', { continueWith: 'fake result', conversationPath: '/a/chat/s/one' });
  await page.advance(500, 1);
  page.page.disabled = true;
  page.page.stopVisible = false;
  await page.advance(500, 10);
  assert.deepEqual(page.page.sent, ['fake result']);
  const result = page.messages.find((message) => message.type === 'work.continuation-result');
  assert.equal(result.result.ok, true);
  assert.equal(result.result.code, 'SEND_CLICKED');
});

test('a Stop state shorter than one timer tick is still observed through DOM mutations', async () => {
  // Live 2026-09-15: Stop icon visible ~680 ms; throttled ticks landed before and after it.
  const page = loadPage({ answers: ['old answer'] });
  await page.advance(1000, 1);
  page.page.stopVisible = true;
  page.page.disabled = false;
  page.mutate();
  page.page.stopVisible = false;
  page.page.disabled = true;
  page.page.answers.push('LIVE DOM PROBE');
  page.mutate();
  await page.advance(1000, 4);
  assert.deepEqual(completions(page.messages).map((message) => message.text), ['LIVE DOM PROBE']);
});

test('observing a generation start tells the worker this conversation is awaiting a reply', async () => {
  const page = loadPage({ answers: ['streaming'], generating: true });
  await page.advance(500, 3);
  assert.equal(page.messages.filter((message) => message.type === 'work.generating').length, 1);
});

test('in a Work tab the first message of a new chat is sent with the tool instructions after it', async () => {
  const page = loadPage({ path: '/', replies: { 'work.arrive': { work: true, instructions: '---\nTOOLS' } } });
  await page.advance(500, 1);
  assert.equal(page.page.composerValue, '');
  page.page.composerValue = '帮我修一下测试';
  const event = page.press();
  assert.equal(event.defaultPrevented, true);
  await page.advance(100, 3);
  assert.deepEqual(page.page.sent, ['帮我修一下测试\n\n---\nTOOLS']);
});

test('Enter is left alone during IME composition, with Shift, in existing chats and when Work is off', async () => {
  const composing = loadPage({ path: '/', replies: { 'work.arrive': { work: true, instructions: 'TOOLS' } } });
  await composing.advance(500, 1);
  composing.page.composerValue = '中文';
  assert.equal(composing.press({ isComposing: true }).defaultPrevented, false);
  assert.equal(composing.press({ keyCode: 229 }).defaultPrevented, false);
  assert.equal(composing.press({ shiftKey: true }).defaultPrevented, false);

  const existing = loadPage({ path: '/a/chat/s/one', answers: ['earlier answer'], replies: { 'work.arrive': { work: true, instructions: 'TOOLS' } } });
  await existing.advance(500, 1);
  existing.page.composerValue = 'follow-up';
  assert.equal(existing.press().defaultPrevented, false);

  const off = loadPage({ path: '/', replies: { 'work.arrive': { work: false } } });
  await off.advance(500, 1);
  off.page.composerValue = 'normal chat';
  assert.equal(off.press().defaultPrevented, false);
  assert.deepEqual(off.page.sent, []);
});


test('extension-typed messages are folded to a one-line summary without changing their text', async () => {
  const instructions = 'You can use local tools through DeepSeek WebMCP for the task above.';
  const page = loadPage({
    messages: [
      `帮我跑测试\n\n---\n${instructions}`,
      'DeepSeek WebMCP tool result.\n{"id":"a","name":"bash","isError":false,"result":{}}',
      'DeepSeek WebMCP tool result.\n{"id":"b","name":"read","isError":true,"error":{}}',
      'DeepSeek WebMCP format correction.\nYour last reply used a different tool-call format',
      'an ordinary message of mine',
    ],
  });
  await page.advance(500, 1);
  const folds = page.page.typed.map((message) => message.getAttribute('data-webmcp-fold'));
  assert.deepEqual(folds, ['🔧 WebMCP tools attached', '🔧 bash ✓', '🔧 read ✗', '🔧 format corrected, retrying', null]);
  assert.equal(page.page.typed[0].getAttribute('data-webmcp-question'), '帮我跑测试');
  // The summary takes the message text color, not the bubble's accent color.
  assert.equal(page.page.typed[0].getAttribute('--webmcp-fold-color'), 'rgb(240, 240, 240)');
  assert.equal(page.page.typed[0].firstChild.nodeValue, `帮我跑测试\n\n---\n${instructions}`);
});
