import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserTask } from '../extension/browser-task.js';

test('Browser WebMCP injects the executor into all accessible frames and inspects them as one page', async () => {
  const previousChrome = globalThis.chrome;
  const stored = {};
  const injections = [];
  const messages = [];

  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: stored[key] }; },
        async set(value) { Object.assign(stored, value); },
      },
    },
    scripting: {
      async executeScript(options) {
        injections.push(options);
        return [{ frameId: 0 }, { frameId: 7 }];
      },
    },
    tabs: {
      async sendMessage(tabId, message, options) {
        messages.push({ tabId, message, options });
        if (message.type === 'webmcp.browser.ping') {
          return { version: 1, ok: true, result: { ready: true } };
        }
        if (options.frameId === 0) {
          return {
            version: 1,
            ok: true,
            result: {
              title: 'Outer',
              url: 'https://example.test/page',
              text: 'Outer text',
              textScope: 'viewport',
              elements: [{ ref: 'e1', role: 'button', name: 'Outer' }],
              truncated: false,
              viewport: { x: 0, y: 0, width: 1000, height: 800, scrollWidth: 1000, scrollHeight: 800 },
            },
          };
        }
        return {
          version: 1,
          ok: true,
          result: {
            title: 'Inner',
            url: 'https://embedded.test/artifact',
            text: 'Inner text',
            textScope: 'viewport',
            elements: [{ ref: 'e1', role: 'button', name: 'Inner' }],
            truncated: false,
            viewport: { x: 0, y: 0, width: 800, height: 600, scrollWidth: 800, scrollHeight: 600 },
          },
        };
      },
    },
  };

  try {
    const task = createBrowserTask({
      activeTab: async () => ({ id: 55, url: 'https://example.test/page', title: 'Example' }),
    });
    const response = await task.runBrowserTool({ id: 'inspect', name: 'inspect_page', arguments: {} });

    assert.equal(response.ok, true);
    assert.match(response.result.text, /Outer text/);
    assert.match(response.result.text, /Inner text/);
    assert.deepEqual(response.result.elements.map(({ ref }) => ref), ['e1', 'f7:e1']);
    assert.ok(injections.length >= 2);
    assert.ok(injections.every(({ target }) => target.tabId === 55 && target.allFrames === true));
    assert.ok(messages.some(({ message, options }) => message.type === 'webmcp.browser.tool' && options.frameId === 7));
  } finally {
    globalThis.chrome = previousChrome;
  }
});
