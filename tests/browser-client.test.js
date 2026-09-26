import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_TOOL_NAMES,
  callBrowserTool,
  validateBrowserToolArguments,
} from '../extension/browser-client.js';

test('Browser WebMCP exposes exactly the seven bounded browser tools', () => {
  assert.deepEqual(BROWSER_TOOL_NAMES, ['inspect_page', 'inspect_form', 'fill', 'select', 'click', 'scroll', 'keyboard']);
});

test('browser tool arguments never let the model choose a tab, URL, selector, XPath, or arbitrary extra field', () => {
  const forbidden = [
    ['inspect_page', { tabId: 9 }],
    ['inspect_form', { url: 'https://example.com' }],
    ['fill', { ref: 'e1', value: 'x', selector: '#name' }],
    ['select', { ref: 'e2', value: 'CH', xpath: '//select' }],
    ['click', { ref: 'e3', tabId: 9 }],
    ['scroll', { deltaY: 100, tabId: 9 }],
    ['scroll', { deltaY: 100, selector: '#feed' }],
    ['scroll', { deltaX: 100 }],
    ['scroll', { deltaY: '100' }],
    ['scroll', { deltaY: Number.NaN }],
    ['scroll', { deltaY: 100, ref: '' }],
    ['scroll', { deltaY: 100, ref: 'e'.repeat(65) }],
    ['scroll', ['deltaY']],
    ['keyboard', { ref: 'e1', actions: [] }],
    ['keyboard', { ref: 'e1', actions: [{ type: 'key', key: 'Backspace', modifiers: ['Meta', 'Meta'] }] }],
    ['keyboard', { ref: 'e1', actions: [{ type: 'key', key: '', repeat: 1 }] }],
    ['keyboard', { ref: 'e1', actions: [{ type: 'key', key: 'Backspace', repeat: 101 }] }],
    ['keyboard', { ref: 'e1', actions: [{ type: 'text', text: 'x', selector: '#field' }] }],
    ['keyboard', { ref: '', actions: [{ type: 'key', key: 'Backspace' }] }],
  ];
  for (const [name, args] of forbidden) {
    assert.equal(validateBrowserToolArguments(name, args)?.code, 'INVALID_ARGUMENTS', name);
  }

  assert.equal(validateBrowserToolArguments('inspect_page', {}), null);
  assert.equal(validateBrowserToolArguments('inspect_form', {}), null);
  assert.equal(validateBrowserToolArguments('fill', { ref: 'e1', value: 'Ada' }), null);
  assert.equal(validateBrowserToolArguments('select', { ref: 'e2', value: 'Switzerland' }), null);
  assert.equal(validateBrowserToolArguments('click', { ref: 'e3' }), null);
  assert.equal(validateBrowserToolArguments('click', { ref: 'f7:e3' }), null);
  assert.equal(validateBrowserToolArguments('scroll', { deltaY: 700 }), null);
  assert.equal(validateBrowserToolArguments('scroll', { deltaY: -700, deltaX: 30, ref: 'e4' }), null);
  assert.equal(validateBrowserToolArguments('keyboard', {
    ref: 'e5',
    actions: [
      { type: 'key', key: 'a', modifiers: ['Meta'] },
      { type: 'key', key: 'Backspace', repeat: 2 },
      { type: 'text', text: 'replacement' },
    ],
  }), null);
});


test('inspect_page aggregates accessible frames and namespaces child-frame refs', async () => {
  const previousChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, message, options) {
        calls.push({ tabId, message, options });
        if (options.frameId === 9) throw new Error('frame navigated');
        if (options.frameId === 0) {
          return {
            version: 1,
            ok: true,
            result: {
              title: 'Outer page',
              url: 'https://outer.example/page',
              text: 'Outer shell',
              textScope: 'viewport',
              elements: [{ ref: 'e1', role: 'button', name: 'Outer action' }],
              truncated: false,
              viewport: { x: 0, y: 0, width: 1000, height: 800, scrollWidth: 1000, scrollHeight: 800 },
            },
          };
        }
        return {
          version: 1,
          ok: true,
          result: {
            title: 'Embedded artifact',
            url: 'https://artifact.example/view',
            text: 'Artifact body',
            textScope: 'viewport',
            elements: [{ ref: 'e1', role: 'button', name: 'Inner action' }],
            truncated: false,
            viewport: { x: 0, y: 0, width: 900, height: 700, scrollWidth: 900, scrollHeight: 1200 },
          },
        };
      },
    },
  };

  try {
    const response = await callBrowserTool(42, {
      id: 'inspect-1',
      name: 'inspect_page',
      arguments: {},
    }, { frameIds: [0, 7, 9] });

    assert.equal(response.ok, true);
    assert.equal(response.result.title, 'Outer page');
    assert.match(response.result.text, /Outer shell/);
    assert.match(response.result.text, /\[Embedded frame f7 — https:\/\/artifact\.example\/view\] Artifact body/);
    assert.deepEqual(response.result.elements.map(({ ref }) => ref), ['e1', 'f7:e1']);
    assert.deepEqual(response.result.frames.map(({ frameId }) => frameId), [0, 7]);
    assert.deepEqual(response.result.warnings, [{ code: 'FRAME_UNAVAILABLE', count: 1 }]);
    assert.deepEqual(calls.map(({ options }) => options.frameId), [0, 7, 9]);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('an embedded-frame ref routes the action only to that frame and remains namespaced', async () => {
  const previousChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, message, options) {
        calls.push({ tabId, message, options });
        return { version: 1, ok: true, result: { ref: message.arguments.ref, name: 'Inner action' } };
      },
    },
  };

  try {
    const response = await callBrowserTool(42, {
      id: 'click-1',
      name: 'click',
      arguments: { ref: 'f7:e3' },
    }, { frameIds: [0, 7] });

    assert.equal(response.ok, true);
    assert.equal(response.result.ref, 'f7:e3');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.frameId, 7);
    assert.equal(calls[0].message.arguments.ref, 'e3');
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('a disappeared embedded frame fails closed without falling back to the top frame', async () => {
  const previousChrome = globalThis.chrome;
  let sent = false;
  globalThis.chrome = { tabs: { sendMessage: async () => { sent = true; return null; } } };

  try {
    const response = await callBrowserTool(42, {
      id: 'click-stale',
      name: 'click',
      arguments: { ref: 'f12:e1' },
    }, { frameIds: [0, 7] });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'FRAME_UNAVAILABLE');
    assert.equal(sent, false);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
