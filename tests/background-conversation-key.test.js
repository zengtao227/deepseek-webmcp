import test from 'node:test';
import assert from 'node:assert/strict';

const A = 'https://chat.deepseek.com/a/chat/s/d614817b-c883-4c8f-858e-daff65e64427';
const B = 'https://chat.deepseek.com/a/chat/s/00000000-0000-0000-0000-000000000000';
const TAB_ID = 7;
const POPUP = { url: 'chrome-extension://test/popup.html' };
const TOOL_CALL_TEXT = '<webmcp_tool_call>{"id":"p2_open","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>';

let importCounter = 0;

// Loads background.js against a fake chrome API. `tab.url` models the browser-side
// last committed URL, which tracks SPA pushState (what tabs.get/onUpdated report).
async function loadBackground({ tabUrl = A } = {}) {
  const session = new Map();
  const listeners = {};
  const nativeCalls = [];
  const tab = { id: TAB_ID, url: tabUrl };
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (items) => { for (const [key, value] of Object.entries(items)) session.set(key, value); },
        remove: async (keys) => { for (const key of [keys].flat()) session.delete(key); },
      },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    commands: { onCommand: { addListener: (fn) => { listeners.onCommand = fn; } } },
    tabs: {
      get: async () => ({ ...tab }),
      sendMessage: async () => {},
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      onUpdated: { addListener: (fn) => { listeners.onUpdated = fn; } },
    },
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      sendNativeMessage: async (host, payload) => {
        nativeCalls.push(payload);
        return { version: 1, id: payload.id, ok: true, result: { workspaceId: 'ws_test' } };
      },
    },
  };
  importCounter += 1;
  await import(`../extension/background.js?case=${importCounter}`);
  // Models Chromium before 148: only sendResponse + `return true` delivers an async
  // reply; a returned Promise is ignored and the sender gets undefined.
  const send = (message, sender) => new Promise((resolve) => {
    const keepOpen = listeners.onMessage(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
  const from = (url, extra = {}) => ({ tab: { id: TAB_ID, url }, frameId: 0, url, ...extra });
  return { send, from, tab, listeners, nativeCalls };
}

async function working(options) {
  const background = await loadBackground(options);
  const on = await background.send({ type: 'work.ui-toggle', tabId: TAB_ID }, POPUP);
  assert.equal(on.status.work, true);
  return background;
}

test('completion is bound to the SPA route even when sender.url is the stale document-load URL', async () => {
  // Chromium sets MessageSender.url from the content script's ScriptContext URL,
  // captured at context creation; DeepSeek's pushState to /a/chat/s/<uuid> does not update it.
  const background = await working();
  const reply = await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, background.from(A, { url: 'https://chat.deepseek.com/' }));
  assert.equal(background.nativeCalls.length, 1);
  assert.equal(typeof reply.continueWith, 'string');
  assert.equal(reply.conversationPath, new URL(A).pathname);
});

test('nothing executes while Work is off for the tab', async () => {
  const background = await loadBackground();
  const reply = await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, background.from(A));
  assert.deepEqual(reply, {});
  assert.equal(background.nativeCalls.length, 0);
});

test('a result waits for its own conversation and is delivered when the user returns', async () => {
  const background = await working();
  await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, background.from(A));

  const elsewhere = await background.send({ type: 'work.arrive' }, background.from(B));
  assert.equal(elsewhere.work, true);
  assert.equal(elsewhere.continueWith, undefined);

  const back = await background.send({ type: 'work.arrive' }, background.from(A));
  assert.equal(typeof back.continueWith, 'string');
  await background.send({ type: 'work.continuation-result', result: { ok: true, code: 'SEND_CLICKED' }, conversationPath: new URL(A).pathname }, background.from(B));
  const again = await background.send({ type: 'work.arrive' }, background.from(A));
  assert.equal(again.continueWith, undefined);
  assert.equal(background.nativeCalls.length, 1);
});

test('a reply that finished while the user was away is executed once on return, never twice', async () => {
  const background = await working();
  await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, background.from(A));
  await background.send({ type: 'work.continuation-result', result: { ok: true, code: 'SEND_CLICKED' }, conversationPath: new URL(A).pathname }, background.from(A));
  const next = TOOL_CALL_TEXT.replace('p2_open', 'p2_next');
  await background.send({ type: 'work.completion', text: next, resume: true }, background.from(A));
  await background.send({ type: 'work.completion', text: next, resume: true }, background.from(A));
  assert.deepEqual(background.nativeCalls.map((call) => call.id), ['p2_open', 'p2_next']);
});

test('settings-changing messages are accepted only from the extension popup', async () => {
  const background = await loadBackground();
  assert.equal(await background.send({ type: 'work.ui-toggle', tabId: TAB_ID }, background.from(A)), undefined);
  const status = await background.send({ type: 'work.ui-status', tabId: TAB_ID }, POPUP);
  assert.equal(status.status.work, false);
});

test('sub-frames, senders without a tab URL and foreign origins are ignored', async () => {
  const background = await working();
  for (const sender of [
    { tab: { id: TAB_ID, url: A }, frameId: 1, url: A },
    { tab: { id: TAB_ID }, frameId: 0, url: A },
    { tab: { id: TAB_ID, url: 'https://evil.example/a/chat/s/d614817b' }, frameId: 0, url: A },
  ]) {
    assert.equal(await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, sender), undefined);
  }
  assert.equal(background.nativeCalls.length, 0);
});

test('moving inside DeepSeek keeps Work; leaving DeepSeek switches it off', async () => {
  const background = await working();
  background.listeners.onUpdated(TAB_ID, { url: B });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await background.send({ type: 'work.ui-status', tabId: TAB_ID }, POPUP)).status.work, true);
  background.listeners.onUpdated(TAB_ID, { url: 'https://example.com/' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await background.send({ type: 'work.ui-status', tabId: TAB_ID }, POPUP)).status.work, false);
});

test('switching away right after sending the task still resumes the first tool call on return', async () => {
  const background = await working();
  await background.send({ type: 'work.generating' }, background.from(A));
  await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT, resume: true }, background.from(A));
  assert.deepEqual(background.nativeCalls.map((call) => call.id), ['p2_open']);
});


test('local settings controls are relayed only from the popup', async () => {
  const background = await loadBackground();
  assert.equal(await background.send({ type: 'settings.control', control: 'grant-full-access', arguments: { minutes: 60 } }, background.from(A)), undefined);
  assert.equal(background.nativeCalls.length, 0);
  await background.send({ type: 'settings.control', control: 'status' }, POPUP);
  assert.deepEqual(background.nativeCalls.map((call) => call.control), ['status']);
});

test('a DSML reply gets a format correction typed back, and nothing runs natively', async () => {
  const background = await working();
  const reply = await background.send({ type: 'work.completion', text: '<｜｜DSML｜｜ invoke name="bash">' }, background.from(A));
  assert.match(reply.continueWith, /^DeepSeek WebMCP format correction\./);
  assert.equal(reply.conversationPath, new URL(A).pathname);
  assert.equal(background.nativeCalls.length, 0);
});
