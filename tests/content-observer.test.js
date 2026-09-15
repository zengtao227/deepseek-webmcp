import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

// Minimal fake of the live DeepSeek DOM facts the observer depends on.
function loadPage({ answers = [], generating = false, path = '/a/chat/s/one', replies = {} } = {}) {
  const page = { answers: [...answers], composerValue: '', disabled: !generating, stopVisible: generating, sent: [], clicks: 0 };
  const control = {
    classList: { contains: (name) => name === 'ds-button--disabled' && page.disabled },
    querySelector: () => (page.stopVisible ? {} : null),
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
  const context = {
    location,
    HTMLTextAreaElement,
    InputEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: (fn) => { tick = fn; return 0; },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { onMutation = this.fn; } },
    Date: { now: () => page.now },
    document: {
      body: {},
      querySelector: (selector) => (selector.startsWith('textarea') ? composer : control),
      querySelectorAll: () => page.answers.map((text) => ({ textContent: text })),
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

test('Work pre-fills instructions only into an empty new chat and never overwrites typing', async () => {
  const fresh = loadPage({ path: '/', replies: { 'work.arrive': { work: true, instructions: 'TOOLS\nTask: ' } } });
  await fresh.advance(500, 1);
  assert.equal(fresh.page.composerValue, 'TOOLS\nTask: ');

  const typing = loadPage({ path: '/', replies: { 'work.arrive': { work: true, instructions: 'TOOLS' } } });
  typing.page.composerValue = 'my own text';
  await typing.advance(500, 1);
  assert.equal(typing.page.composerValue, 'my own text');

  const existing = loadPage({ path: '/a/chat/s/one', replies: { 'work.arrive': { work: true, instructions: 'TOOLS' } } });
  await existing.advance(500, 1);
  assert.equal(existing.page.composerValue, '');
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
