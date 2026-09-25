import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PAGES, providerOf } from '../extension/panel-header.js';

// Owner decision 2026-09-26: a panel that never chose a provider opens ChatGPT, because opening
// DeepSeek first also opens its provider window.
test('every provider has its own panel page; nothing chosen yet (or anything unknown) opens ChatGPT', () => {
  assert.deepEqual(PROVIDER_PAGES, { deepseek: 'sidepanel.html', chatgpt: 'sidepanel-chatgpt.html' });
  assert.equal(providerOf('chatgpt'), 'chatgpt');
  assert.equal(providerOf('deepseek'), 'deepseek');
  assert.equal(providerOf(undefined), 'chatgpt');
  assert.equal(providerOf('toString'), 'chatgpt');
});

import { accessParts } from '../extension/panel-header.js';

const now = 1_000_000;
const text = (parts) => parts.map((part) => `${part.text}[${part.kind}]`).join(' · ');

test('Access line follows the header contract', () => {
  const base = { folder: '/Users/me/Doc/My code/webmcp-bridge', fullAccessUntil: null, hostAccessUntil: null, hostAccessState: 'inactive' };
  assert.equal(text(accessParts(base, now)), 'webmcp-bridge[mount] · WRITE[write]');
  assert.equal(text(accessParts({ ...base, fullAccessUntil: now + 27 * 60000 }, now)), 'Home[mount] · FULL ACCESS 27m[full]');
  assert.equal(text(accessParts({ ...base, fullAccessUntil: now + 27 * 60000, hostAccessState: 'active', hostAccessUntil: now + 12 * 60000 }, now)),
    'Home[mount] · FULL ACCESS 27m[full] · HOST ACCESS 12m[host]');
  assert.equal(text(accessParts({ ...base, hostAccessState: 'active', hostAccessUntil: now + 12 * 60000 }, now)),
    'webmcp-bridge[mount] · WRITE[write] · HOST ACCESS 12m[host]', 'Host access keeps the folder');
  assert.equal(text(accessParts({ ...base, hostAccessState: 'unverified' }, now)), 'webmcp-bridge[mount] · WRITE[write] · HOST ACCESS UNVERIFIED[host]');
  assert.equal(text(accessParts({ ...base, fullAccessUntil: now - 1, hostAccessState: 'active', hostAccessUntil: now - 1 }, now)),
    'webmcp-bridge[mount] · WRITE[write]', 'expired leases disappear');
  assert.equal(accessParts(null, now), null);
});

import { highAccessControls, mountProviderSelect, startAccessLine } from '../extension/panel-header.js';

// Owner decision 2026-09-26: the panel may revoke Full / Host Access (it only lowers authority);
// granting stays behind the macOS dialog in Settings / the WebMCP App.
test('the controls that end Full / Host Access, the most dangerous first', () => {
  const base = { folder: '/Users/me/Doc/My code', fullAccessUntil: null, hostAccessUntil: null, hostAccessState: 'inactive' };
  assert.deepEqual(highAccessControls(base, now), []);
  assert.deepEqual(highAccessControls({ ...base, fullAccessUntil: now + 60000 }, now), ['stop-full-access']);
  assert.deepEqual(highAccessControls({ ...base, fullAccessUntil: now + 60000, hostAccessState: 'active', hostAccessUntil: now + 60000 }, now), ['stop-host-access', 'stop-full-access']);
  assert.deepEqual(highAccessControls({ ...base, hostAccessState: 'unverified' }, now), ['stop-host-access'], 'an unverified host lease is ended too');
  assert.deepEqual(highAccessControls({ ...base, fullAccessUntil: now - 1, hostAccessState: 'active', hostAccessUntil: now - 1 }, now), []);
  assert.deepEqual(highAccessControls(null, now), []);
});

// Owner decision 2026-09-26 (C2): an unreadable status means the local program is unreachable, so no
// provider can use the access and the switch goes ahead; a failed revoke keeps the current provider.
async function switchProvider({ statusOk = true, stopOk = true } = {}) {
  const calls = [];
  const stored = [];
  const notices = [];
  let opened = null;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        calls.push(message.control);
        if (message.control === 'status') {
          return statusOk ? { ok: true, result: { folder: '/x', fullAccessUntil: Date.now() + 60000, hostAccessState: 'active', hostAccessUntil: Date.now() + 60000 } } : null;
        }
        return { ok: stopOk, result: {} };
      },
    },
    storage: { local: { set: async (items) => { stored.push(items); } } },
  };
  globalThis.location = { replace: (page) => { opened = page; } };
  let onChange;
  const select = { value: '', addEventListener: (_type, handler) => { onChange = handler; } };
  try {
    mountProviderSelect(select, 'chatgpt', (text) => notices.push(text));
    select.value = 'deepseek';
    await onChange();
  } finally {
    delete globalThis.chrome;
    delete globalThis.location;
  }
  return { calls, stored, notices, opened, selected: select.value };
}

test('switching Provider ends Full / Host Access before the other provider\'s page opens', async () => {
  const done = await switchProvider();
  assert.deepEqual(done.calls, ['status', 'stop-host-access', 'stop-full-access']);
  assert.deepEqual(done.stored, [{ 'provider.id': 'deepseek' }]);
  assert.equal(done.opened, 'sidepanel.html');

  const unreachable = await switchProvider({ statusOk: false });
  assert.equal(unreachable.opened, 'sidepanel.html', 'no local program, nothing to revoke');

  const failed = await switchProvider({ stopOk: false });
  assert.equal(failed.opened, null, 'a failed revoke keeps the current provider');
  assert.deepEqual(failed.stored, []);
  assert.equal(failed.selected, 'chatgpt');
  assert.equal(failed.notices.length, 1);
});

// C1: the Revoke button is one persistent button; after a failed revoke it can be pressed again.
test('the Revoke button stays usable after a revoke that failed', async () => {
  const node = (tag) => ({ tagName: tag, hidden: false, disabled: false, children: [], listeners: {},
    replaceChildren(...nodes) { this.children = nodes; }, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const element = node('div');
  const lease = { folder: '/x', fullAccessUntil: Date.now() + 60000, hostAccessState: 'inactive' };
  globalThis.document = { createElement: node, createTextNode: (text) => ({ text }), addEventListener() {} };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  globalThis.chrome = { runtime: { sendMessage: async (message) => (message.control === 'status' ? { ok: true, result: lease } : { ok: false }) } };
  try {
    startAccessLine(element);
    await new Promise(setImmediate);
    const revoke = element.children.find((child) => child.tagName === 'button');
    assert.equal(revoke.hidden, false, 'shown while Full Access is on');
    await revoke.listeners.click();
    assert.equal(revoke.disabled, false);
    assert.equal(revoke.hidden, false);
  } finally {
    globalThis.setInterval = realSetInterval;
    delete globalThis.document;
    delete globalThis.chrome;
  }
});
