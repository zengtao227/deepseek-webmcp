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
    dispatchEvent(event) {
      if (event.type !== 'paste' || !pasteApplies) return true;
      setTimeout(() => { editor.innerText = event.clipboardData.getData('text/plain'); }, 20);
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
        if (message.type === 'work.arrive') return { work: true, instructions: 'You can use owner-approved tools through DeepSeek WebMCP to inspect_page.' };
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
  const result = bubble(textNode('DeepSeek WebMCP tool result.\n{"id":"a","name":"inspect_page","isError":false}\n'), pre(fence), textNode('\nBare JSON is not a tool call.'));
  const contract = bubble(textNode('Can you read the left page?\n\n---\nYou can use owner-approved tools through DeepSeek WebMCP for the task above.\n'), pre(fence), textNode('\nUse one tool call per reply.'));
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
    bubble('DeepSeek WebMCP tool result.\n{"id":"a","name":"inspect_page","isError":false}', resultTurn),
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
