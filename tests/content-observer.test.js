import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildWorkInstructions } from '../extension/core/agent-controller.js';

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
      if (!page.keepComposerOnClick) page.composerValue = '';
      page.onClick?.();
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
  const logs = [];
  const context = {
    console: { info: (...args) => { logs.push(args.map(String)); } },
    location,
    HTMLTextAreaElement,
    InputEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms) => { if (page.sleepAdvancesClock) page.now += ms; fn(); return 0; },
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
        : page.answers.map((entry) => (typeof entry === 'string'
          ? { textContent: entry, querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null }
          : entry))),
    },
    chrome: {
      runtime: {
        id: 'test-extension',
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
    logs,
    setReply(type, value) { replies[type] = value; },
    navigate(nextPath) { location.pathname = nextPath; },
    notify(message, sender, sendResponse) { return onRuntimeMessage?.(message, sender, sendResponse); },
    press(init) {
      const event = { type: 'keydown', target: composer, key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, defaultPrevented: false, ...init };
      event.preventDefault = () => { event.defaultPrevented = true; };
      event.stopImmediatePropagation = () => {};
      for (const fn of documentListeners.keydown ?? []) fn(event);
      return event;
    },
    mutate() { onMutation?.([]); },
    orphan() {
      // What Chromium does to a content script whose extension was reloaded.
      delete context.chrome.runtime.id;
      context.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    },
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
  const instructions = 'You can use owner-approved tools through WebMCP for the task above.';
  const page = loadPage({
    messages: [
      `帮我跑测试\n\n---\n${instructions}`,
      'WebMCP tool result.\n{"id":"a","name":"bash","isError":false,"result":{}}',
      'WebMCP tool result.\n{"id":"b","name":"read","isError":true,"error":{}}',
      'WebMCP format correction.\nYour last reply used a different tool-call format',
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

test('a page script orphaned by an extension reload stays silent instead of throwing', async () => {
  const page = loadPage({ answers: ['streaming'], generating: true });
  page.orphan();
  await assert.doesNotReject(page.advance(500, 5));
  page.mutate();
});

// Live 2026-09-20: DeepSeek accepted and answered a prompt from the Side Panel while the
// textarea kept its value; the old `composer empty` check reported SEND_NOT_CONFIRMED.
test('send is confirmed when generation starts even though the composer keeps its text', async () => {
  const page = loadPage({ answers: ['old'] });
  page.page.keepComposerOnClick = true;
  page.page.sleepAdvancesClock = true;
  page.page.onClick = () => { page.page.stopVisible = true; page.page.disabled = false; };
  page.setReply('work.completion', { continueWith: 'fake result', conversationPath: '/a/chat/s/one' });
  page.page.stopVisible = true;
  await page.advance(500, 1);
  page.page.stopVisible = false;
  page.page.disabled = true;
  await page.advance(500, 10);
  const result = page.messages.find((message) => message.type === 'work.continuation-result');
  assert.equal(result.result.ok, true);
  assert.equal(result.result.code, 'SEND_CLICKED');
});

test('send is confirmed when a new chat navigates to its conversation route', async () => {
  const page = loadPage({ answers: ['old'], path: '/a/chat/s/one' });
  page.page.keepComposerOnClick = true;
  page.page.sleepAdvancesClock = true;
  page.setReply('work.completion', { continueWith: 'first message', conversationPath: '/a/chat/s/one' });
  page.page.stopVisible = true;
  await page.advance(500, 1);
  page.page.stopVisible = false;
  page.page.disabled = true;
  page.page.onClick = () => { page.navigate('/a/chat/s/two'); };
  await page.advance(500, 10);
  const result = page.messages.find((message) => message.type === 'work.continuation-result');
  assert.equal(result.result.ok, true);
});

test('a send that shows no acknowledgement at all is still reported as not confirmed', async () => {
  const page = loadPage({ answers: ['old'] });
  page.page.keepComposerOnClick = true;
  page.page.sleepAdvancesClock = true;
  page.setReply('work.completion', { continueWith: 'ignored by DeepSeek', conversationPath: '/a/chat/s/one' });
  page.page.stopVisible = true;
  await page.advance(500, 1);
  page.page.stopVisible = false;
  page.page.disabled = true;
  await page.advance(500, 10);
  const result = page.messages.find((message) => message.type === 'work.continuation-result');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.code, 'SEND_NOT_CONFIRMED');
});

test('the instruction marker the page checks is the real first sentence of the tool contract', () => {
  const marker = /const INSTRUCTIONS_START = '([^']+)'/.exec(source)?.[1];
  assert.ok(marker, 'content.js must define INSTRUCTIONS_START');
  assert.ok(buildWorkInstructions().startsWith(`---\n${marker}`));
  assert.ok(buildWorkInstructions({ pageAttached: true }).startsWith(`---\n${marker}`));
});

// Live 2026-09-20: a provider reopened on an existing conversation never got the tool contract,
// because instructions were only appended to the first message of a *new* chat.
test('the first assistant prompt of a session carries the tool contract even in an existing conversation', async () => {
  const contract = buildWorkInstructions({ pageAttached: true });
  const page = loadPage({ answers: ['earlier reply'], path: '/a/chat/s/one', replies: { 'work.arrive': { work: true, instructions: contract } } });
  await page.advance(500, 1);

  const reply = await new Promise((resolve) => {
    page.notify({ type: 'assistant.prompt', text: 'Inspect the work page', withInstructions: true }, {}, resolve);
  });
  assert.equal(reply.ok, true);
  assert.equal(page.page.sent.length, 1);
  assert.ok(page.page.sent[0].startsWith('Inspect the work page'));
  assert.ok(page.page.sent[0].includes('already attached'));
});

test('a later assistant prompt in an existing conversation is sent as typed', async () => {
  const page = loadPage({ answers: ['earlier reply'], path: '/a/chat/s/one', replies: { 'work.arrive': { work: true, instructions: buildWorkInstructions() } } });
  await page.advance(500, 1);

  const reply = await new Promise((resolve) => {
    page.notify({ type: 'assistant.prompt', text: 'And the form controls?' }, {}, resolve);
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(page.page.sent, ['And the form controls?']);
});

// ---- Answer structure and answer actions (Side Panel presentation) ----

// A small DOM: only what the page script reads. Selectors are tag names, `.class` and
// `div[role="button"]`, which is all the script uses.
const fakeText = (value) => ({ nodeType: 3, nodeValue: value, get textContent() { return value; } });
function fakeEl(tag, attrs = {}, ...kids) {
  const children = kids.map((kid) => (typeof kid === 'string' ? fakeText(kid) : kid));
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    parentElement: null,
    clicks: 0,
    attrs: { ...attrs },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value: String(value) })); },
    get textContent() { return this.childNodes.map((child) => child.textContent).join(''); },
    click() { this.clicks += 1; },
    contains(other) { return other === this || this.childNodes.some((child) => child.contains?.(other)); },
    closest: () => null,
    style: { setProperty() {} },
    querySelectorAll(selector) {
      const matchers = selector.split(',').map((part) => part.trim());
      const out = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          const classes = String(child.attrs.class ?? '').split(/\s+/);
          const hit = matchers.some((matcher) => {
            if (matcher.startsWith('.')) return matcher.slice(1).split('.').every((name) => classes.includes(name));
            const role = /^(\w+)\[role="(\w+)"\]$/.exec(matcher);
            if (role) return child.tagName === role[1].toUpperCase() && child.attrs.role === role[2];
            return child.tagName === matcher.toUpperCase();
          });
          if (hit) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  for (const child of children) child.parentElement = el;
  return el;
}
const answerEl = (...kids) => fakeEl('div', { class: 'ds-markdown ds-assistant-message-main-content' }, ...kids);

// Values built inside the vm context are cloned so deepEqual compares plain data.
const snapshots = (page) => page.messages.filter((message) => message.type === 'assistant.snapshot').map((message) => JSON.parse(JSON.stringify(message)));

test('the answer is sent as structure: paragraphs, headings, lists, code, quotes, tables and links', async () => {
  const answer = answerEl(
    fakeEl('h2', {}, 'Plan'),
    fakeEl('p', {}, 'Use ', fakeEl('strong', {}, 'bold'), ' and ', fakeEl('em', {}, 'italic'), ' with ', fakeEl('code', {}, 'x = 1'), ', see ', fakeEl('a', { href: 'https://example.com/docs' }, 'docs'), '.'),
    fakeEl('ul', {}, fakeEl('li', {}, 'one', fakeEl('ol', { start: '3' }, fakeEl('li', {}, 'nested'))), fakeEl('li', {}, fakeEl('p', {}, 'two'))),
    fakeEl('blockquote', {}, fakeEl('p', {}, 'quoted')),
    fakeEl('div', { class: 'md-code-block' }, fakeEl('div', { class: 'banner' }, fakeEl('span', {}, 'python'), fakeEl('button', {}, 'Copy')), fakeEl('pre', { class: 'language-python' }, 'print(1)\n')),
    fakeEl('div', {}, fakeEl('table', {}, fakeEl('tr', {}, fakeEl('th', {}, 'Name'), fakeEl('th', {}, 'Qty')), fakeEl('tr', {}, fakeEl('td', {}, 'pen'), fakeEl('td', {}, '3')))),
    fakeEl('hr'),
  );
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 2);

  const [snapshot] = snapshots(page).slice(-1);
  assert.deepEqual(snapshot.blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'quote', 'code', 'table', 'rule']);
  assert.deepEqual(snapshot.blocks[1].runs, [
    { text: 'Use ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'italic', italic: true }, { text: ' with ' },
    { text: 'x = 1', code: true }, { text: ', see ' }, { text: 'docs', href: 'https://example.com/docs' }, { text: '.' },
  ]);
  const list = snapshot.blocks[2];
  assert.deepEqual(list.items[0].runs, [{ text: 'one' }]);
  assert.deepEqual(list.items[0].blocks[0], { type: 'list', ordered: true, items: [{ runs: [{ text: 'nested' }], blocks: [] }], start: 3 });
  assert.deepEqual(list.items[1].runs, [{ text: 'two' }], 'a loose item paragraph becomes the item text');
  assert.deepEqual(snapshot.blocks[4], { type: 'code', lang: 'python', text: 'print(1)\n' }, 'the banner label and Copy button are not part of the code');
  assert.deepEqual(snapshot.blocks[5].head, [[{ text: 'Name' }], [{ text: 'Qty' }]]);
  assert.deepEqual(snapshot.blocks[5].rows, [[[{ text: 'pen' }], [{ text: '3' }]]]);
  assert.match(snapshot.answer, /Plan/);
  assert.doesNotMatch(JSON.stringify(snapshot.blocks), /Copy|class|ds-markdown/);
});

test('a tool-call answer produces neither text nor structure for the panel', async () => {
  const call = '<webmcp_tool_call>{"id":"a","name":"inspect_page","arguments":{}}</webmcp_tool_call>';
  const page = loadPage({ answers: [answerEl(fakeEl('p', {}, call))] });
  await page.advance(500, 2);
  for (const snapshot of snapshots(page)) {
    assert.equal(snapshot.answer, '');
    assert.deepEqual(snapshot.blocks, []);
  }

  const inCode = loadPage({ answers: [answerEl(fakeEl('div', { class: 'md-code-block' }, fakeEl('pre', {}, call)))] });
  await inCode.advance(500, 2);
  for (const snapshot of snapshots(inCode)) assert.deepEqual(snapshot.blocks, []);
});

test('an answer nested past the limit is flattened instead of sent unbounded', async () => {
  const quote = (depth) => (depth === 0 ? fakeEl('p', {}, 'deep') : fakeEl('blockquote', {}, quote(depth - 1)));
  const page = loadPage({ answers: [answerEl(quote(6))] });
  await page.advance(500, 2);
  const [snapshot] = snapshots(page).slice(-1);
  assert.ok(snapshot.blocks.length > 0);
  assert.equal(JSON.stringify(snapshot.blocks).includes('deep'), true);
  const depthOf = (block) => (block.type === 'quote' ? 1 + Math.max(0, ...block.blocks.map(depthOf)) : 1);
  assert.ok(Math.max(...snapshot.blocks.map(depthOf)) <= 3);
});

function withActionBar(labels) {
  const answer = answerEl(fakeEl('p', {}, 'done'));
  const bar = fakeEl('div', {}, ...labels.map((label) => fakeEl('div', { role: 'button', class: 'ds-icon-button', ...(label ? { 'aria-label': label } : {}) }, fakeEl('svg', {}, fakeEl('path', { d: 'M8.3125 1' })))));
  const message = fakeEl('div', {}, answer, bar);
  message.parentElement = null;
  return { answer, bar, buttons: bar.childNodes };
}
const askAction = (page, action) => new Promise((resolve) => { page.notify({ type: 'assistant.action', action }, {}, resolve); });

test('Regenerate and Share press the matching DeepSeek control under the latest answer', async () => {
  const { answer, buttons } = withActionBar(['Copy', 'Regenerate', 'Share']);
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);

  const regenerate = await askAction(page, 'regenerate');
  assert.equal(regenerate.ok, true);
  assert.deepEqual(buttons.map((button) => button.clicks), [0, 1, 0]);
  const share = await askAction(page, 'share');
  assert.equal(share.ok, true);
  assert.deepEqual(buttons.map((button) => button.clicks), [0, 1, 1]);
});

test('a missing DeepSeek control is reported with what was found instead of failing silently', async () => {
  const { answer, buttons } = withActionBar([null, null]);
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);
  const reply = await askAction(page, 'regenerate');
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'CONTROL_NOT_FOUND');
  assert.match(reply.message, /regenerate control not found/i);
  assert.match(reply.message, /ds-icon-button/);
  assert.match(reply.message, /M8\.3125/);
  assert.deepEqual(buttons.map((button) => button.clicks), [0, 0]);
});

test('no answer control is pressed while DeepSeek is generating, and unknown actions are ignored', async () => {
  const { answer, buttons } = withActionBar(['Regenerate']);
  const page = loadPage({ answers: [answer], generating: true });
  await page.advance(500, 1);
  const busy = await askAction(page, 'regenerate');
  assert.equal(busy.code, 'GENERATION_IN_PROGRESS');
  assert.equal(buttons[0].clicks, 0);
  assert.equal(page.notify({ type: 'assistant.action', action: 'delete-everything' }, {}, () => assert.fail('must not answer')), false);
});

// ---- Action-control failure diagnostic (evidence for selecting DeepSeek's icon-only buttons) ----

const LONG_PATH = 'M8.5 2.15137C7.2 2.15137 6.1 3.1 5.9 4.4L5.5 7.2C5.4 8 5.9 8.7 6.7 8.9L9.9 9.6C10.7 9.8 11.5 9.3 11.7 8.5';
const iconButton = (attrs, path, extra = []) => fakeEl(
  'div',
  { role: 'button', class: 'ds-button ds-button--iconLabelTertiary', ...attrs },
  fakeEl('svg', { viewBox: '0 0 16 16' }, fakeEl('path', { d: path }), ...extra),
);

test('a failed lookup describes the latest answer action bar with identifying attributes and the full first SVG path', async () => {
  const buttons = [
    iconButton({}, LONG_PATH, [fakeEl('path', { d: 'M1 1' })]),
    iconButton({ title: 'Try again', 'aria-describedby': 'tip-1' }, 'M5.5 2.15137'),
    iconButton({ 'aria-label': 'Read aloud', 'data-testid': 'read-btn', 'data-message-id': '3f2b1c9a-1111-4222-8333-444455556666', 'data-link': 'https://chat.deepseek.com/a/chat/s/abc' }, 'M9.31006 14.0'),
    fakeEl('div', { role: 'button', class: 'ds-button ds-button--iconLabelTertiary', 'aria-labelledby': 'lbl-1' }, '朗读', fakeEl('svg', { viewBox: '0 0 20 20' }, fakeEl('path', { d: 'M9.31006 14.5' }))),
  ];
  const bar = fakeEl('div', { class: 'ds-flex actions' }, ...buttons);
  const answer = answerEl(fakeEl('p', {}, 'SECRET-ANSWER-BODY'));
  const message = fakeEl('div', { class: 'message' }, fakeEl('div', {}, 'SECRET-PROMPT-TEXT'), answer, bar);
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);

  const reply = JSON.parse(JSON.stringify(await askAction(page, 'share')));
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'CONTROL_NOT_FOUND');
  assert.deepEqual(reply.diagnostics.controls.map((control) => control.index), [0, 1, 2, 3]);
  assert.equal(reply.diagnostics.count, 4);
  assert.deepEqual(reply.diagnostics.scope, { element: 'div.message', level: 0 });

  const [first, second, third, fourth] = reply.diagnostics.controls;
  assert.equal(first.svg.path, LONG_PATH, 'the whole first path, not a prefix');
  assert.equal(first.svg.pathCount, 2);
  assert.equal(first.svg.viewBox, '0 0 16 16');
  assert.equal(first.tag, 'div');
  assert.equal(first.role, 'button');
  assert.equal(first.class, 'ds-button ds-button--iconLabelTertiary');
  assert.equal(first.parent, 'div.ds-flex actions');
  assert.equal(second.title, 'Try again');
  assert.equal(second.ariaDescribedby, 'tip-1');
  assert.equal(third.ariaLabel, 'Read aloud');
  assert.deepEqual(third.data, { 'data-testid': 'read-btn', 'data-message-id': '[redacted]', 'data-link': '[redacted]' });
  assert.equal(fourth.text, '朗读');
  assert.equal(fourth.ariaLabelledby, 'lbl-1');

  assert.deepEqual(buttons.map((button) => button.clicks), [0, 0, 0, 0], 'nothing is clicked on a guess');
  assert.deepEqual(page.logs.at(-1)[0], '[DeepSeek WebMCP] action control diagnostic');
  assert.deepEqual(JSON.parse(page.logs.at(-1)[1]), reply.diagnostics, 'the console copy is the same data');
  assert.ok(message.contains(answer));
});

test('the diagnostic covers only the latest answer bar and never contains answer, prompt or conversation text', async () => {
  const olderBar = fakeEl('div', { class: 'older-bar' }, iconButton({ 'aria-label': 'older-control' }, 'M0 0'));
  const older = answerEl(fakeEl('p', {}, 'OLDER-ANSWER-BODY'));
  fakeEl('div', {}, older, olderBar);

  const latest = answerEl(fakeEl('p', {}, 'SECRET-ANSWER-BODY'), fakeEl('button', { 'aria-label': 'inside-answer-copy' }, 'Copy'));
  const bar = fakeEl('div', { class: 'latest-bar' }, iconButton({ 'aria-label': 'latest-control' }, 'M8.5 2.1'), iconButton({ 'data-conversation': 'a/chat/s/SECRET-CONVERSATION-ID' }, 'M3 3'));
  const sidebarButton = fakeEl('div', { role: 'button', class: 'sidebar-history', 'aria-label': 'SECRET-SIDEBAR-CHAT' }, 'SECRET-SIDEBAR-TITLE');
  const container = fakeEl('div', { class: 'chat' }, fakeEl('div', {}, 'SECRET-PROMPT-TEXT'), latest, bar);
  fakeEl('div', { class: 'app' }, sidebarButton, container);

  const page = loadPage({ answers: [older, latest] });
  await page.advance(500, 1);
  const reply = JSON.parse(JSON.stringify(await askAction(page, 'regenerate')));

  assert.deepEqual(reply.diagnostics.controls.map((control) => control.ariaLabel), ['latest-control', '']);
  const everything = JSON.stringify(reply) + page.logs.flat().join(' ');
  for (const secret of ['SECRET', 'OLDER', 'older-control', 'inside-answer-copy', 'sidebar']) {
    assert.equal(everything.includes(secret), false, `leaked ${secret}`);
  }
});

test('a malformed page cannot make the diagnostic unbounded', async () => {
  const huge = 'M'.padEnd(5000, '1');
  const buttons = Array.from({ length: 40 }, (_, index) => {
    const data = Object.fromEntries(Array.from({ length: 30 }, (__, key) => [`data-k${key}`, `v${key}`]));
    return iconButton({ ...data, class: `ds-button ${'c'.repeat(500)}`, 'aria-label': 'L'.repeat(500), title: 'T'.repeat(500), 'aria-describedby': 'd'.repeat(500) }, huge);
  });
  const bar = fakeEl('div', { class: 'bar' }, ...buttons);
  const answer = answerEl(fakeEl('p', {}, 'body'));
  fakeEl('div', {}, answer, bar);
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);

  const reply = JSON.parse(JSON.stringify(await askAction(page, 'regenerate')));
  const { diagnostics } = reply;
  assert.equal(diagnostics.count, 40);
  assert.equal(diagnostics.truncated, true);
  assert.ok(JSON.stringify(diagnostics).length <= 16000, `diagnostic is ${JSON.stringify(diagnostics).length} characters`);
  assert.ok(diagnostics.controls.length < 40);
  for (const control of diagnostics.controls) {
    assert.ok(control.svg.path.length <= 1200);
    assert.equal(control.svg.pathTruncated, true, 'a cut path says so');
    assert.equal(control.svg.pathLength, 5000);
    assert.ok(control.class.length <= 200);
    assert.ok(control.ariaLabel.length <= 120 && control.title.length <= 120);
    assert.ok(Object.keys(control.data).length <= 6);
  }
  assert.ok(reply.message.length <= 480, 'the side panel message keeps its existing bound');
});

test('a control that is found is still pressed without any diagnostic', async () => {
  const buttons = [iconButton({ 'aria-label': 'Regenerate' }, 'M1 1'), iconButton({}, 'M2 2')];
  const answer = answerEl(fakeEl('p', {}, 'done'));
  fakeEl('div', {}, answer, fakeEl('div', {}, ...buttons));
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);
  const reply = await askAction(page, 'regenerate');
  assert.equal(reply.ok, true);
  assert.equal(reply.diagnostics, undefined);
  assert.deepEqual(buttons.map((button) => button.clicks), [1, 0]);
  assert.equal(page.logs.length, 0);
});

test('DeepSeek icon buttons without role or icon-button class are candidates, and are pressed when their name matches', async () => {
  const plain = (attrs, path) => fakeEl('div', { class: 'ds-button ds-button--iconLabelTertiary', ...attrs }, fakeEl('svg', { viewBox: '0 0 16 16' }, fakeEl('path', { d: path })));
  const buttons = [plain({}, 'M1 1'), plain({ 'aria-label': 'Regenerate' }, 'M2 2')];
  const answer = answerEl(fakeEl('p', {}, 'done'));
  fakeEl('div', {}, answer, fakeEl('div', { class: 'bar' }, ...buttons));
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);

  const missing = JSON.parse(JSON.stringify(await askAction(page, 'share')));
  assert.equal(missing.code, 'CONTROL_NOT_FOUND');
  assert.equal(missing.diagnostics.count, 2, 'role-less .ds-button controls are seen');
  assert.deepEqual(buttons.map((button) => button.clicks), [0, 0]);

  assert.equal((await askAction(page, 'regenerate')).ok, true);
  assert.deepEqual(buttons.map((button) => button.clicks), [0, 1]);
});

test('the diagnostic shows the ancestors above the answer with their control and answer counts, and long or multi-path icons are marked', async () => {
  const older = answerEl(fakeEl('p', {}, 'older'));
  const latest = answerEl(fakeEl('p', {}, 'latest'));
  const longPath = `M${'1'.repeat(1500)}`;
  const bar = fakeEl('div', { class: 'bar' }, fakeEl('div', { role: 'button', class: 'ds-button' }, fakeEl('svg', { viewBox: '0 0 8 8' }, fakeEl('path', { d: longPath }), fakeEl('path', { d: 'M9 9' }), fakeEl('path', { d: 'M8 8' }))));
  const olderBar = fakeEl('div', { class: 'older-bar' }, fakeEl('div', { role: 'button', class: 'ds-button' }));
  const latestMessage = fakeEl('div', { class: 'msg' }, latest, bar);
  const olderMessage = fakeEl('div', { class: 'msg' }, older, olderBar);
  fakeEl('div', { class: 'thread' }, olderMessage, latestMessage);
  const page = loadPage({ answers: [older, latest] });
  await page.advance(500, 1);

  const { diagnostics } = JSON.parse(JSON.stringify(await askAction(page, 'share')));
  assert.deepEqual(diagnostics.ancestry, [
    { level: 0, element: 'div.msg', controls: 1, answers: 1 },
    { level: 1, element: 'div.thread', controls: 2, answers: 2 },
  ]);
  const [control] = diagnostics.controls;
  assert.equal(control.svg.pathTruncated, true);
  assert.equal(control.svg.pathLength, 1501);
  assert.equal(control.svg.path.length, 1200);
  assert.deepEqual(control.svg.extraPaths, ['M9 9', 'M8 8']);
});

// ---- Regenerate / Share by icon, from the real DeepSeek action bar (diagnostic of 2026-09-21) ----

const ICONS = {
  copy: 'M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106',
  regenerate: 'M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z',
  like: 'M8.27868 0.811572C8.81991 0.142194 9.79022 0.0421835 10.4538 0.557601L10.5823 0.669306',
  dislike: 'M7.72451 15.1086C7.18929 15.7705 6.22975 15.8694 5.57357 15.3597L5.44643 15.2492',
  share: 'M7.95889 1.52285C7.95888 0.826234 8.76055 0.467983 9.27669 0.875208L9.37524 0.967191L15.1317 7.18358C15.5582 7.64419 15.5582 8.35614 15.1317 8.81676L9.37524 15.0331C8.87034 15.578 7.95888 15.2205 7.95889 14.4775V10.8207C7.10614 10.8432 6.31361 10.9316 5.45468 11.2515C4.39484 11.6463 3.18248 12.413 1.64676 13.9425C1.4533 14.135 1.18329 14.1696 0.969086 14.0908C0.74748 14.0091 0.547307 13.7879 0.54859 13.4844L0.55516 13.1315C0.618924 11.3494 1.11153 9.29838 2.27656 7.63787C3.45289 5.96147 5.29554 4.71635 7.95889 4.54797V1.52285ZM9.20911 5.13366C9.20899 5.50567 8.9031 5.77687 8.56523 5.77755C5.99383 5.78282 4.33736 6.8762 3.29964 8.35496C2.54519 9.43014 2.10739 10.7283 1.9152 11.9939C3.04749 11.0323 4.0569 10.4385 5.01917 10.0801C6.29638 9.60449 7.4406 9.56343 8.56429 9.56295C8.9178 9.5628 9.20894 9.84909 9.20911 10.2068L9.20817 13.3737L14.1837 8.00017L9.20817 2.62571L9.20911 5.13366Z',
};
const BUTTON_CLASS = 'ds-button ds-button--iconLabelTertiary ds-button--icon ds-button--capsule ds-button--xs ds-button--icon-relative-l db183363';
const realButton = (paths, attrs = {}, viewBox = '0 0 16 16') => fakeEl(
  'div',
  { role: 'button', class: BUTTON_CLASS, ...attrs },
  fakeEl('svg', { viewBox }, ...paths.map((d) => fakeEl('path', { d }))),
);
const readAloud = () => realButton(['M9.31006 14.8936C9.30005 14.9767 9.26249 15.2257 9.03858 15.4171', 'M11.2036 4.90008C12.9119 6.60839 12.9118 9.37826 11.2036 11.0866L10.2133 10.0964L11.3748 8.93476Z', 'M13.4306 2.67302C16.3689 5.61129 16.3688 10.3753 13.4306 13.3136Z'], { 'aria-label': '朗读' });

// One message as DeepSeek renders it: the answer (with a code block's own buttons) inside
// .ds-message, and the action bar as a sibling under the same wrapper.
function realMessage({ order = ['copy', 'regenerate', 'like', 'dislike', 'read', 'share'], share = [ICONS.share], viewBox } = {}) {
  const made = {
    copy: realButton([ICONS.copy]),
    regenerate: realButton([ICONS.regenerate], {}, viewBox),
    like: realButton([ICONS.like]),
    dislike: realButton([ICONS.dislike]),
    read: readAloud(),
    share: realButton(share, {}, viewBox),
  };
  const answer = answerEl(fakeEl('p', {}, 'answer body'), fakeEl('div', { class: 'md-code-block' }, fakeEl('div', { role: 'button', class: 'ds-button' }, 'Copy'), fakeEl('pre', {}, 'x')));
  const message = fakeEl('div', { class: 'ds-message _63c77b1' }, answer);
  const bar = fakeEl('div', { class: 'ds-flex _965abe9' }, ...order.map((name) => made[name]));
  const wrapper = fakeEl('div', { class: '_4f9bf79 d7dc56a8' }, message, bar);
  return { answer, wrapper, made, bar };
}

const clicksOf = (made) => Object.fromEntries(Object.entries(made).map(([name, button]) => [name, button.clicks]));
const NONE = { copy: 0, regenerate: 0, like: 0, dislike: 0, read: 0, share: 0 };

test('with no labels at all, Regenerate and Share press only the button with their exact icon', async () => {
  const { answer, made } = realMessage();
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);

  assert.equal((await askAction(page, 'regenerate')).ok, true);
  assert.deepEqual(clicksOf(made), { ...NONE, regenerate: 1 });
  assert.equal((await askAction(page, 'share')).ok, true);
  assert.deepEqual(clicksOf(made), { ...NONE, regenerate: 1, share: 1 });
});

test('the icon match does not depend on order or on role="button"', async () => {
  const { answer, made } = realMessage({ order: ['share', 'read', 'dislike', 'like', 'regenerate', 'copy'] });
  for (const button of Object.values(made)) delete button.attrs.role;
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);

  assert.equal((await askAction(page, 'regenerate')).ok, true);
  assert.equal((await askAction(page, 'share')).ok, true);
  assert.deepEqual(clicksOf(made), { ...NONE, regenerate: 1, share: 1 });
});

test('an older answer with the same icons is never pressed', async () => {
  const older = realMessage();
  const latest = realMessage();
  fakeEl('div', { class: 'ds-virtual-list-visible-items' }, older.wrapper, latest.wrapper);
  const page = loadPage({ answers: [older.answer, latest.answer] });
  await page.advance(500, 1);

  assert.equal((await askAction(page, 'share')).ok, true);
  assert.deepEqual(clicksOf(latest.made), { ...NONE, share: 1 });
  assert.deepEqual(clicksOf(older.made), NONE);
});

test('a duplicated, changed or unknown icon fails with the diagnostic and presses nothing', async () => {
  const cases = {
    'changed share path': realMessage({ share: [`${ICONS.share}Z`] }),
    'different viewBox': realMessage({ viewBox: '0 0 24 24' }),
  };
  const duplicate = realMessage();
  duplicate.bar.childNodes.push(realButton([ICONS.share]));
  cases['two share icons'] = duplicate;

  for (const [name, { answer, made, bar }] of Object.entries(cases)) {
    const page = loadPage({ answers: [answer] });
    await page.advance(500, 1);
    const reply = JSON.parse(JSON.stringify(await askAction(page, 'share')));
    assert.equal(reply.ok, false, name);
    assert.equal(reply.code, 'CONTROL_NOT_FOUND', name);
    assert.ok(reply.diagnostics.count >= 6, name);
    assert.deepEqual(clicksOf(made), NONE, name);
    assert.deepEqual(bar.childNodes.filter((button) => button.clicks > 0), [], name);
  }
});

test('when the scope also holds an older answer nothing is pressed, even on an exact icon match', async () => {
  const { answer, wrapper, made } = realMessage();
  const older = answerEl(fakeEl('p', {}, 'older'));
  wrapper.childNodes.unshift(older);
  older.parentElement = wrapper;
  const page = loadPage({ answers: [older, answer] });
  await page.advance(500, 1);

  const reply = JSON.parse(JSON.stringify(await askAction(page, 'regenerate')));
  assert.equal(reply.ok, false);
  assert.equal(reply.diagnostics.ancestry.find((level) => level.element.startsWith('div._4f9bf79')).answers, 2);
  assert.deepEqual(clicksOf(made), NONE);
});

test('a control named by its label is preferred, and two named matches are refused', async () => {
  const { answer, made } = realMessage();
  made.like.attrs['aria-label'] = 'Regenerate';
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 1);
  assert.equal((await askAction(page, 'regenerate')).ok, true);
  assert.deepEqual(clicksOf(made), { ...NONE, like: 1 });

  made.copy.attrs['aria-label'] = 'Regenerate';
  const refused = await askAction(page, 'regenerate');
  assert.equal(refused.ok, false);
  assert.deepEqual(clicksOf(made), { ...NONE, like: 1 });
});

test('a page-released note follows the assistant prompt and precedes the tool contract', async () => {
  const page = loadPage({ answers: ['earlier'], path: '/a/chat/s/one', replies: { 'work.arrive': { work: true, instructions: buildWorkInstructions() } } });
  await page.advance(500, 1);
  const reply = await new Promise((resolve) => {
    page.notify({ type: 'assistant.prompt', text: 'read the other page', withInstructions: true, pageNote: '[NOTE: connection closed]' }, {}, resolve);
  });
  assert.equal(reply.ok, true);
  const sent = page.page.sent[0];
  assert.ok(sent.startsWith('read the other page\n\n[NOTE: connection closed]'));
  assert.ok(sent.indexOf('[NOTE: connection closed]') < sent.indexOf('You can use owner-approved tools'));
});

// Found by the browser E2E suite (2026-09-21): a reply that ends before the first timer tick after
// the send finishes was never seen as a generation, so its completion was reported as a history
// replay and ignored (a short tool-call reply lost). The send itself must count as the start.
test('a reply that starts and ends between the send and the next tick is still reported as the awaited reply', async () => {
  const page = loadPage({ answers: [], path: '/' });
  page.setReply('work.arrive', { work: true, instructions: buildWorkInstructions() });
  await page.advance(500, 1);

  // Sending starts a generation (Stop icon) and moves to the conversation route, like DeepSeek.
  page.page.onClick = () => { page.page.stopVisible = true; page.page.disabled = false; page.navigate('/a/chat/s/new'); };
  page.page.keepComposerOnClick = true;
  const sent = await new Promise((resolve) => page.notify({ type: 'assistant.prompt', text: 'go' }, {}, resolve));
  assert.equal(sent.ok, true);

  // The whole reply happens before any timer tick runs again.
  page.page.stopVisible = false;
  page.page.disabled = true;
  page.page.answers = ['<webmcp_tool_call>{"id":"t1","name":"inspect_page","arguments":{}}</webmcp_tool_call>'];
  page.page.composerValue = '';
  await page.advance(500, 8);

  assert.ok(page.messages.some((message) => message.type === 'work.generating'), 'the worker was told a reply is awaited');
  assert.deepEqual(completions(page.messages).map((message) => message.resume), [false]);
});

// Found by the E2E suite: whitespace between block elements ("\n" text nodes, as in any pretty-printed
// markup) became empty paragraphs, because "\n" was also the marker for <br>.
test('whitespace between blocks makes no empty paragraphs, while <br> still breaks a line', async () => {
  const answer = answerEl(
    fakeEl('h2', {}, 'Plan'), '\n',
    fakeEl('p', {}, 'one', fakeEl('br'), 'two'), '\n  ',
    fakeEl('ul', {}, '\n', fakeEl('li', {}, 'a'), '\n'), '\n',
  );
  const page = loadPage({ answers: [answer] });
  await page.advance(500, 2);
  const [snapshot] = snapshots(page).slice(-1);
  assert.deepEqual(snapshot.blocks.map((block) => block.type), ['heading', 'paragraph', 'list']);
  assert.deepEqual(snapshot.blocks[1].runs, [{ text: 'one' }, { text: '\n' }, { text: 'two' }]);
});
