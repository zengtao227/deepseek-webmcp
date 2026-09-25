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
