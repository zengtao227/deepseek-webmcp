import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/content-chatgpt.js', import.meta.url), 'utf8');

async function sendThroughComposer({ pasteApplies }) {
  const listeners = new Map();
  const messages = [];
  const sent = [];
  const hiddenTextarea = { value: '', getClientRects: () => [] };
  const inserts = [];
  const editor = {
    tagName: 'DIV', innerText: 'Inspect the current page', isConnected: true,
    focus() {}, contains: (target) => target === editor,
    // Live 2026-09-25: ChatGPT's ProseMirror applies a synthetic paste one task later, not at once.
    // Live 2026-09-26: it pastes at its own caret (the end), ignoring a select-all made just before,
    // so text already in the composer stays in front of the pasted text.
    dispatchEvent(event) {
      if (event.type !== 'paste' || !pasteApplies) return true;
      setTimeout(() => { editor.innerText += event.clipboardData.getData('text/plain'); }, 20);
      return false;
    },
  };
  const sendButton = {
    disabled: false,
    getAttribute: () => null,
    matches: () => false,
    click() {
      sent.push(editor.innerText);
      editor.innerText = '';
    },
  };
  const document = {
    body: {}, head: { append() {} },
    createElement: () => ({ textContent: '' }),
    createRange: () => ({ selectNodeContents() {} }),
    querySelector(selector) {
      // The hidden fallback textarea precedes the actual editor in document order.
      if (selector.includes('form textarea')) return hiddenTextarea;
      if (selector.includes('#prompt-textarea')) return editor;
      if (selector.includes('#composer-submit-button')) return sendButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'form textarea') return [hiddenTextarea];
      return [];
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    execCommand(command, _ui, text) {
      // Native editing acts on the DOM selection (the select-all), which ProseMirror then reads back.
      if (command === 'delete') {
        editor.innerText = '';
        return true;
      }
      assert.equal(command, 'insertText');
      inserts.push(text);
      editor.innerText = text;
      return true;
    },
  };
  const window = { addEventListener() {} };
  window.top = window;
  let tick;
  vm.runInNewContext(source, {
    window, document,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    chrome: { runtime: {
      id: 'test',
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === 'work.arrive') return { work: true, instructions: 'You can use owner-approved tools through WebMCP to inspect_page.' };
        return {};
      },
      onMessage: { addListener() {} },
    } },
    HTMLTextAreaElement: class {},
    DataTransfer: class { #data = new Map(); setData(type, value) { this.#data.set(type, value); } getData(type) { return this.#data.get(type) ?? ''; } },
    ClipboardEvent: class { constructor(type, init) { this.type = type; this.clipboardData = init.clipboardData; } },
    MutationObserver: class { observe() {} },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    requestAnimationFrame: () => {},
    setInterval: (callback) => { tick = callback; },
    setTimeout,
  });
  tick();
  await new Promise(setImmediate);
  assert.equal(messages.some((message) => message.type === 'work.arrive'), true);

  let prevented = false;
  listeners.get('keydown')({
    type: 'keydown', target: editor, key: 'Enter', keyCode: 13,
    preventDefault() { prevented = true; }, stopImmediatePropagation() {},
  });
  await new Promise((resolve) => setTimeout(resolve, pasteApplies ? 300 : 1500));

  assert.equal(prevented, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Inspect the current page\n\nYou can use owner-approved tools/);
  assert.equal(sent[0].split('Inspect the current page').length - 1, 1, 'the owner\'s text is sent once');
  assert.equal(editor.innerText, '');
  assert.equal(messages.some((message) => message.type === 'work.generating'), true);
  return inserts;
}

test('an old conversation sends one tool-enabled prompt through the visible ProseMirror editor', async () => {
  // insertText makes every line its own editor step: 2.6 s for a 12 kB tool result (live 2026-09-25).
  assert.deepEqual(await sendThroughComposer({ pasteApplies: true }), [], 'written by one paste, never also by insertText');
});

test('insertText is the fallback only when the editor ignored the paste', async () => {
  assert.equal((await sendThroughComposer({ pasteApplies: false })).length, 1);
});

// Live DOM 2026-09-25 (free account): ChatGPT renders the fenced example inside a typed tool result
// or tool contract as <pre>, so the message text sits beside a PRE instead of in one text node.
test('typed tool results and the tool contract fold although ChatGPT renders their fenced blocks as PRE', () => {
  const USER = '[data-message-author-role="user"]';
  const textNode = (value) => ({ nodeType: 3, nodeName: '#text', nodeValue: value, textContent: value });
  const pre = (value) => ({ nodeType: 1, nodeName: 'PRE', textContent: value });
  const bubble = (...childNodes) => {
    const attributes = new Map();
    return {
      childNodes,
      firstChild: childNodes[0],
      textContent: childNodes.map((node) => node.textContent).join(''),
      closest: () => null,
      style: { setProperty() {} },
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
    };
  };
  const fence = '```text\n<webmcp_tool_call>{"id":"<new unique id>"}</webmcp_tool_call>\n```';
  const result = bubble(textNode('WebMCP tool result.\n{"id":"a","name":"inspect_page","isError":false}\n'), pre(fence), textNode('\nBare JSON is not a tool call.'));
  const contract = bubble(textNode('Can you read the left page?\n\n---\nYou can use owner-approved tools through WebMCP for the task above.\n'), pre(fence), textNode('\nUse one tool call per reply.'));
  const question = bubble(textNode('Can you read the left page?'));
  let fold;
  const document = {
    body: {}, head: { append() {} },
    createElement: () => ({ textContent: '' }),
    querySelector: () => null,
    // Only a real descendant of a user turn is a candidate, as in the browser.
    querySelectorAll: (selector) => (selector.split(',').some((part) => part.trim() === `${USER} div`) ? [result, contract, question] : []),
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  window.top = window;
  vm.runInNewContext(source, {
    window, document,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    chrome: { runtime: { id: 'test', sendMessage: async () => ({}), onMessage: { addListener() {} } } },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({ color: 'white' }),
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => { fold = callback; },
    setInterval: (callback) => callback(),
    setTimeout,
  });
  fold();
  assert.equal(result.getAttribute('data-webmcp-fold'), '🔧 inspect_page ✓');
  assert.equal(contract.getAttribute('data-webmcp-fold'), '🔧 WebMCP tools attached');
  assert.equal(contract.getAttribute('data-webmcp-question'), 'Can you read the left page?');
  assert.equal(question.getAttribute('data-webmcp-fold'), null);
});

// Live DOM 2026-09-25: each turn is section[data-testid^="conversation-turn"] with its icon row as a
// [role="group"] holding copy-turn-action-button. Only the WebMCP steps lose that row.
test('tool-call replies and typed tool results are marked so their icon rows hide; the final answer keeps its row', () => {
  const turn = () => {
    const attributes = new Map();
    return { getAttribute: (name) => attributes.get(name) ?? null, setAttribute: (name, value) => attributes.set(name, value), hasAttribute: (name) => attributes.has(name) };
  };
  const inTurn = (node, owner) => Object.assign(node, {
    closest: (selector) => (selector.includes('conversation-turn') ? owner : null),
    style: { setProperty() {} },
    getAttribute: node.getAttribute ?? (() => null),
    setAttribute: node.setAttribute ?? (() => {}),
  });
  const toolTurn = turn();
  const resultTurn = turn();
  const questionTurn = turn();
  const finalTurn = turn();
  const text = (value) => ({ nodeType: 3, nodeName: '#text', nodeValue: value, textContent: value });
  const bubble = (value, owner) => inTurn({ childNodes: [text(value)], textContent: value }, owner);
  const call = '<webmcp_tool_call>{"id":"a","name":"inspect_page","arguments":{}}</webmcp_tool_call>';
  const toolPre = inTurn({ textContent: call, querySelector: () => ({ textContent: call }) }, toolTurn);
  const toolReply = inTurn({ textContent: call, querySelectorAll: () => [toolPre], querySelector: () => toolPre }, toolTurn);
  const finalReply = inTurn({ textContent: 'The title is Action.', querySelectorAll: () => [], querySelector: () => null }, finalTurn);
  const users = [
    bubble('WebMCP tool result.\n{"id":"a","name":"inspect_page","isError":false}', resultTurn),
    bubble('Can you read the left page?', questionTurn),
  ];
  let fold;
  let css = '';
  const document = {
    body: {}, head: { append: (node) => { css = node.textContent; } },
    createElement: () => ({ textContent: '' }),
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector.split(',').some((part) => part.trim() === '[data-message-author-role="user"] div')) return users;
      if (selector.includes('data-message-author-role="assistant"')) return [toolReply, finalReply];
      return [];
    },
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  window.top = window;
  vm.runInNewContext(source, {
    window, document,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    chrome: { runtime: { id: 'test', sendMessage: async () => ({}), onMessage: { addListener() {} } } },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({ color: 'white' }),
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => { fold = callback; },
    setInterval: (callback) => callback(),
    setTimeout,
  });
  fold();
  assert.equal(toolTurn.hasAttribute('data-webmcp-step'), true, 'tool-call reply');
  assert.equal(resultTurn.hasAttribute('data-webmcp-step'), true, 'typed tool result');
  assert.equal(questionTurn.hasAttribute('data-webmcp-step'), false, 'the owner\'s own question keeps its icons');
  assert.equal(finalTurn.hasAttribute('data-webmcp-step'), false, 'the final answer keeps Copy / Rate');
  assert.match(css, /\[data-webmcp-step\] \[role="group"\]:has\(button\[data-testid="copy-turn-action-button"\]\) \{ display: none !important; \}/);
});

// Live DOM 2026-09-26 (no role attributes): one exchange holds the owner's message unit, the reply
// unit and, beside them, the reply's .turn-action-controls row. The step's own unit is marked.
test('in the DOM without role attributes, tool steps mark their own message unit and CSS hides only their rows', () => {
  const unit = () => {
    const attributes = new Map();
    return { getAttribute: (name) => attributes.get(name) ?? null, setAttribute: (name, value) => attributes.set(name, value), hasAttribute: (name) => attributes.has(name) };
  };
  const inUnit = (node, owner) => Object.assign(node, {
    closest: (selector) => (selector.includes('data-content-search-unit-key') ? owner : null),
    style: { setProperty() {} },
    getAttribute: node.getAttribute ?? (() => null),
    setAttribute: node.setAttribute ?? (() => {}),
  });
  const toolUnit = unit();
  const resultUnit = unit();
  const questionUnit = unit();
  const finalUnit = unit();
  const text = (value) => ({ nodeType: 3, nodeName: '#text', textContent: value });
  const bubble = (value, owner) => inUnit({ childNodes: [text(value)], textContent: value }, owner);
  const call = '<webmcp_tool_call>{"id":"a","name":"open_workspace","arguments":{}}</webmcp_tool_call>';
  const block = inUnit({ textContent: call, querySelector: () => ({ textContent: call }) }, toolUnit);
  const toolReply = inUnit({ textContent: call, querySelectorAll: () => [block], querySelector: () => block }, toolUnit);
  const finalReply = inUnit({ textContent: 'Write is ON.', querySelectorAll: () => [], querySelector: () => null }, finalUnit);
  const users = [
    bubble('WebMCP tool result.\n{"id":"a","name":"open_workspace","isError":false}', resultUnit),
    bubble('Is Write ON?', questionUnit),
  ];
  let fold;
  let css = '';
  const document = {
    body: {}, head: { append: (node) => { css = node.textContent; } },
    createElement: () => ({ textContent: '' }),
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector.split(',').some((part) => part.trim() === '[data-user-message-bubble="true"] div')) return users;
      if (selector.includes('data-markdown-text-style="assistant-message"')) return [toolReply, finalReply];
      return [];
    },
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  window.top = window;
  vm.runInNewContext(source, {
    window, document,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    chrome: { runtime: { id: 'test', sendMessage: async () => ({}), onMessage: { addListener() {} } } },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({ color: 'white' }),
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => { fold = callback; },
    setInterval: (callback) => callback(),
    setTimeout,
  });
  fold();
  assert.equal(toolUnit.hasAttribute('data-webmcp-step'), true, 'tool-call reply');
  assert.equal(resultUnit.hasAttribute('data-webmcp-step'), true, 'typed tool result');
  assert.equal(questionUnit.hasAttribute('data-webmcp-step'), false, 'the owner\'s question keeps its buttons');
  assert.equal(finalUnit.hasAttribute('data-webmcp-step'), false, 'the final answer keeps Copy / Rate');
  assert.ok(css.includes('[data-content-search-unit-key$=":user"][data-webmcp-step] button { display: none !important; }'));
  assert.ok(css.includes('[data-content-search-turn-key]:has([data-content-search-unit-key$=":assistant"][data-webmcp-step]) .turn-action-controls:not([data-content-search-unit-key$=":user"] *) { display: none !important; }'));
});

// A finished reply that holds a complete tool call is reported as soon as ChatGPT stops generating;
// waiting STABLE_MS (2 s) delayed every tool step. A plain answer still waits for the quiet period.
async function reportDelay(answerText, answerMarker = 'data-message-author-role="assistant"') {
  const clock = { now: 1000 };
  const answer = { textContent: '', querySelector: () => null, querySelectorAll: () => [] };
  const stop = {};
  let generating = false;
  const messages = [];
  let tick;
  const document = {
    body: {}, head: { append() {} },
    createElement: () => ({ textContent: '' }),
    querySelector: (selector) => (selector.includes('stop-button') && generating ? stop : null),
    querySelectorAll: (selector) => (selector.includes(answerMarker) ? [answer] : []),
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  window.top = window;
  vm.runInNewContext(source, {
    window, document, Date: { now: () => clock.now },
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    chrome: { runtime: { id: 'test', sendMessage: async (message) => { messages.push(message); return {}; }, onMessage: { addListener() {} } } },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: () => {},
    setInterval: (callback) => { tick = callback; },
    setTimeout,
  });
  tick();
  await new Promise(setImmediate);
  generating = true;
  answer.textContent = answerText.slice(0, 10);
  tick();
  generating = false;
  answer.textContent = answerText;
  const start = clock.now;
  for (let step = 0; step < 10 && !messages.some((message) => message.type === 'work.completion'); step += 1) {
    tick();
    await new Promise(setImmediate);
    clock.now += 500;
  }
  return clock.now - start;
}

test('a finished reply with a complete tool call is reported at once, not after the 2 s quiet period', async () => {
  const call = 'text\n<webmcp_tool_call>{"id":"a","name":"inspect_page","arguments":{}}</webmcp_tool_call>';
  assert.ok(await reportDelay(call) < 1000, 'tool call reported without the quiet period');
  assert.ok(await reportDelay('The title is Action.') >= 2000, 'a plain answer still waits until it is quiet');
});

// Live DOM 2026-09-26 (Plus account, new and reloaded chats): no role attributes anywhere; each reply
// is one [data-markdown-text-style="assistant-message"] root. The tool call in it was never read.
test('a reply in the DOM without role attributes is read, so its tool call is reported', async () => {
  const call = 'Plain text<webmcp_tool_call>{"id":"a","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>';
  assert.ok(await reportDelay(call, 'data-markdown-text-style="assistant-message"') < 1000);
});

// Same DOM: the user bubble is [data-user-message-bubble], its text sits in one element beside the
// fenced block, and every fenced block is DIV[data-markdown-copy="code-block"] > CODE, not PRE.
test('the tool contract and the tool call fold in the DOM without role attributes', () => {
  const textNode = (value) => ({ nodeType: 3, nodeName: '#text', textContent: value });
  const attributed = (fields) => {
    const attributes = new Map();
    return Object.assign({
      closest: () => null,
      style: { setProperty() {} },
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
    }, fields);
  };
  const codeBlock = (code) => attributed({
    nodeType: 1, nodeName: 'DIV', textContent: `Plain text${code}`,
    matches: (selector) => selector.includes('data-markdown-copy="code-block"'),
    querySelector: (selector) => (selector === 'code' ? { textContent: code } : null),
  });
  const fence = '<webmcp_tool_call>{"id":"<new unique id>","name":"<tool name>","arguments":{...}}</webmcp_tool_call>';
  const contractNodes = [
    textNode('Use WebMCP to call open_workspace.\n\n---\nYou can use owner-approved tools through WebMCP for the task above.\n'),
    codeBlock(fence),
    textNode('\nUse one tool call per reply.'),
  ];
  const contract = attributed({ childNodes: contractNodes, textContent: contractNodes.map((node) => node.textContent).join('') });
  const call = '<webmcp_tool_call>{"id":"ow-001","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>';
  const callBlock = codeBlock(call);
  const reply = attributed({
    textContent: callBlock.textContent,
    querySelectorAll: (selector) => (selector.includes('data-markdown-copy="code-block"') ? [callBlock] : []),
    querySelector: (selector) => (selector.includes('data-markdown-copy="code-block"') ? callBlock : null),
  });
  let fold;
  const document = {
    body: {}, head: { append() {} },
    createElement: () => ({ textContent: '' }),
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector.split(',').some((part) => part.trim() === '[data-user-message-bubble="true"] div')) return [contract];
      if (selector.includes('data-markdown-text-style="assistant-message"')) return [reply];
      return [];
    },
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  window.top = window;
  vm.runInNewContext(source, {
    window, document,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    chrome: { runtime: { id: 'test', sendMessage: async () => ({}), onMessage: { addListener() {} } } },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({ color: 'white' }),
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => { fold = callback; },
    setInterval: (callback) => callback(),
    setTimeout,
  });
  fold();
  assert.equal(contract.getAttribute('data-webmcp-fold'), '🔧 WebMCP tools attached');
  assert.equal(contract.getAttribute('data-webmcp-question'), 'Use WebMCP to call open_workspace.');
  assert.equal(callBlock.getAttribute('data-webmcp-fold'), '🔧 open_workspace');
});

// Live DOM 2026-09-26 (free plan): a sponsored card is a child of the turn's
// [data-conversation-screenshot-content] block, beside the reply, with an "Ad" badge and no link.
test('sponsored cards under ChatGPT replies are marked hidden; the reply itself never is', () => {
  const node = (text, children = []) => {
    const attributes = new Map();
    const self = {
      children, childElementCount: children.length, textContent: text || children.map((child) => child.textContent).join(''),
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      hasAttribute: (name) => attributes.has(name),
      querySelector: (selector) => (selector === '[data-message-author-role]' ? self.all().find((child) => child.isMessage) ?? null : null),
      querySelectorAll: () => self.all(),
      all: () => children.flatMap((child) => [child, ...child.all()]),
    };
    return self;
  };
  const message = Object.assign(node('', [node('The title is Ad')]), { isMessage: true });
  const reply = node('', [message]);
  // A reply that is itself the block (no wrapper) and holds a leaf that reads exactly "Ad".
  const bareReply = Object.assign(node('', [node('Ad')]), { matches: (selector) => selector === '[data-message-author-role]' });
  const card = node('', [node('', [node('ki-checker.ch'), node('Ad')]), node('KI-Sichtbarkeit prüfen')]);
  const actions = node('', [node('Copy')]);
  const content = node('', [reply, bareReply, actions, card]);
  const turn = { querySelector: (selector) => (selector === '[data-conversation-screenshot-content]' ? content : null) };
  let fold;
  let css = '';
  const document = {
    body: {}, head: { append: (element) => { css = element.textContent; } },
    createElement: () => ({ textContent: '' }),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector.includes('[data-turn="assistant"]') ? [turn] : []),
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  window.top = window;
  vm.runInNewContext(source, {
    window, document,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    chrome: { runtime: { id: 'test', sendMessage: async () => ({}), onMessage: { addListener() {} } } },
    Node: { TEXT_NODE: 3 },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => { fold = callback; },
    setInterval: (callback) => callback(),
    setTimeout,
  });
  fold();
  assert.equal(card.hasAttribute('data-webmcp-ad'), true);
  assert.equal(reply.hasAttribute('data-webmcp-ad'), false, 'a reply that mentions "Ad" stays');
  assert.equal(bareReply.hasAttribute('data-webmcp-ad'), false, 'a reply block itself is never taken for a card');
  assert.equal(actions.hasAttribute('data-webmcp-ad'), false);
  assert.match(css, /\[data-webmcp-ad\] \{ display: none !important; \}/);
  assert.match(css, /\[data-webmcp-step\]\[data-turn="user"\] button \{ display: none !important; \}/, 'no empty Show more under a folded tool result');
});
