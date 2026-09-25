import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/content-chatgpt.js', import.meta.url), 'utf8');

test('an old conversation sends one tool-enabled prompt through the visible ProseMirror editor', async () => {
  const listeners = new Map();
  const messages = [];
  const sent = [];
  const hiddenTextarea = { value: '', getClientRects: () => [] };
  const editor = {
    tagName: 'DIV', innerText: 'Inspect the current page', isConnected: true,
    focus() {}, contains: (target) => target === editor,
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
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(prevented, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Inspect the current page\n\nYou can use owner-approved tools/);
  assert.equal(editor.innerText, '');
  assert.equal(messages.some((message) => message.type === 'work.generating'), true);
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
