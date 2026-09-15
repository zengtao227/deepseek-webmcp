import test from 'node:test';
import assert from 'node:assert/strict';

const ARMED_URL = 'https://chat.deepseek.com/a/chat/s/d614817b-c883-4c8f-858e-daff65e64427';
const TAB_ID = 7;
const TOOL_CALL_TEXT = '<webmcp_tool_call>{"id":"p2_open","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>';

let importCounter = 0;

// Loads background.js against a fake chrome API. `tabUrl` models the browser-side
// last committed URL, which tracks SPA pushState (what tabs.get/onUpdated report).
async function loadBackground({ tabUrl }) {
  const session = new Map();
  const listeners = {};
  const nativeCalls = [];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (items) => { for (const [key, value] of Object.entries(items)) session.set(key, value); },
        remove: async (key) => { session.delete(key); },
      },
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, url: tabUrl }),
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      onUpdated: { addListener: (fn) => { listeners.onUpdated = fn; } },
    },
    runtime: {
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      sendNativeMessage: async (host, payload) => {
        nativeCalls.push(payload);
        return { version: 1, id: payload.id, ok: true, result: { content: [{ type: 'text', text: 'ws_test' }] } };
      },
    },
  };
  importCounter += 1;
  await import(`../extension/background.js?case=${importCounter}`);
  const send = (message, sender) => listeners.onMessage(message, sender);
  return { send, nativeCalls, session };
}

async function armAndComplete({ tabUrl, sender }) {
  const background = await loadBackground({ tabUrl });
  const armed = await background.send({ type: 'p1.ui-arm', tabId: TAB_ID }, {});
  assert.equal(armed.ok, true);
  assert.equal(armed.status.conversationKey, ARMED_URL);
  const reply = await background.send({ type: 'p1.completion', text: TOOL_CALL_TEXT }, sender);
  const status = await background.send({ type: 'p1.ui-status', tabId: TAB_ID }, {});
  return { reply, status, nativeCalls: background.nativeCalls };
}

test('completion is bound to the SPA route even when sender.url is the stale document-load URL', async () => {
  // Chromium sets MessageSender.url from the content script's ScriptContext URL,
  // captured at context creation; DeepSeek's pushState to /a/chat/s/<uuid> does not update it.
  const { reply, status, nativeCalls } = await armAndComplete({
    tabUrl: ARMED_URL,
    sender: { tab: { id: TAB_ID, url: ARMED_URL }, frameId: 0, url: 'https://chat.deepseek.com/' },
  });
  assert.equal(status.diagnostics.lastCode, 'TOOL_RESULT');
  assert.equal(nativeCalls.length, 1);
  assert.equal(typeof reply.continueWith, 'string');
});

test('completion from a tab now showing another conversation is rejected without a native call', async () => {
  const { reply, status, nativeCalls } = await armAndComplete({
    tabUrl: ARMED_URL,
    sender: {
      tab: { id: TAB_ID, url: 'https://chat.deepseek.com/a/chat/s/00000000-0000-0000-0000-000000000000' },
      frameId: 0,
      url: ARMED_URL,
    },
  });
  assert.equal(status.diagnostics.lastCode, 'DISARMED_OR_WRONG_CONVERSATION');
  assert.equal(nativeCalls.length, 0);
  assert.deepEqual(reply, {});
});

test('completion from a sub-frame or a sender without tab URL is ignored', async () => {
  for (const sender of [
    { tab: { id: TAB_ID, url: ARMED_URL }, frameId: 1, url: ARMED_URL },
    { tab: { id: TAB_ID }, frameId: 0, url: ARMED_URL },
    { tab: { id: TAB_ID, url: 'https://evil.example/a/chat/s/d614817b' }, frameId: 0, url: ARMED_URL },
  ]) {
    const { reply, status, nativeCalls } = await armAndComplete({ tabUrl: ARMED_URL, sender });
    assert.equal(reply, undefined);
    assert.equal(status.diagnostics, null);
    assert.equal(nativeCalls.length, 0);
  }
});
