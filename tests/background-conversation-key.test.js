import test from 'node:test';
import assert from 'node:assert/strict';

const A = 'https://chat.deepseek.com/a/chat/s/d614817b-c883-4c8f-858e-daff65e64427';
const B = 'https://chat.deepseek.com/a/chat/s/00000000-0000-0000-0000-000000000000';
const TAB_ID = 7;
const OTHER_TAB_ID = 12;
const PROVIDER_TAB_ID = 21;
const PROVIDER_WINDOW_ID = 20;
const SIDE_PANEL = { url: 'chrome-extension://test/sidepanel.html' };
const TOOL_CALL_TEXT = '<webmcp_tool_call>{"id":"p2_open","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>';
const BROWSER_TOOL_CALL_TEXT = '<webmcp_tool_call>{"id":"browser_1","name":"inspect_form","arguments":{}}</webmcp_tool_call>';

let importCounter = 0;

// Loads background.js against a fake chrome API. `tab.url` models the browser-side
// last committed URL, which tracks SPA pushState (what tabs.get/onUpdated report).
async function loadBackground({ tabUrl = A, nativeError = null, providerStartsHidden = false, slowStorage = false, browserReply = { version: 1, ok: true, result: { controls: [] } } } = {}) {
  const session = new Map();
  const local = new Map();
  const listeners = {};
  const nativeCalls = [];
  const browserMessages = [];
  const scriptingCalls = [];
  const selfUninstalls = [];
  const tab = { id: TAB_ID, url: tabUrl, title: 'DeepSeek', windowId: 1, active: true };
  const otherDeepSeekTab = { id: OTHER_TAB_ID, url: B, title: 'Other DeepSeek', windowId: 3, active: true };
  const targetTab = { id: 9, url: 'https://fixture.example/form', title: 'Employee Travel Claim', windowId: 2, active: true };
  const providerTab = { id: PROVIDER_TAB_ID, url: 'https://chat.deepseek.com/', title: 'DeepSeek Provider', windowId: PROVIDER_WINDOW_ID, active: true };
  const tabs = new Map([[tab.id, tab], [otherDeepSeekTab.id, otherDeepSeekTab], [targetTab.id, targetTab]]);
  const windows = new Map([
    [1, { id: 1, state: 'normal', focused: false }],
    [2, { id: 2, state: 'normal', focused: true }],
    [3, { id: 3, state: 'normal', focused: false }],
  ]);
  // Live 2026-09-20: an unfocused fresh provider window reports 'hidden' until activated once.
  let providerActivated = !providerStartsHidden;
  const focusLog = [];
  let windowsCreated = 0;
  let promptReply = { ok: true, code: 'SEND_CLICKED' };
  let actionReply = { ok: true, code: 'ACTION_CLICKED' };
  const actionCalls = [];
  const modeCalls = [];
  // Every storage round trip yields to the event loop, so concurrent handlers really interleave.
  const yieldToLoop = () => (slowStorage ? new Promise((resolve) => setImmediate(resolve)) : undefined);
  let active = tab;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (local.has(key) ? { [key]: structuredClone(local.get(key)) } : {}),
        set: async (items) => { for (const [key, value] of Object.entries(items)) local.set(key, structuredClone(value)); },
      },
      session: {
        get: async (key) => { await yieldToLoop(); return session.has(key) ? { [key]: structuredClone(session.get(key)) } : {}; },
        set: async (items) => { await yieldToLoop(); for (const [key, value] of Object.entries(items)) session.set(key, structuredClone(value)); },
        remove: async (keys) => { await yieldToLoop(); for (const key of [keys].flat()) session.delete(key); },
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    management: { uninstallSelf: async (options) => { selfUninstalls.push(options); } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    commands: { onCommand: { addListener: (fn) => { listeners.onCommand = fn; } } },
    tabs: {
      get: async (tabId) => {
        const found = tabs.get(tabId);
        if (!found) throw new Error('No tab');
        return { ...found };
      },
      query: async (queryInfo = {}) => {
        if (Number.isInteger(queryInfo.windowId)) {
          return [...tabs.values()].filter((entry) => entry.windowId === queryInfo.windowId && (!queryInfo.active || entry.active)).map((entry) => ({ ...entry }));
        }
        return [{ ...active }];
      },
      update: async (tabId, changes) => {
        const found = tabs.get(tabId);
        if (!found) throw new Error('No tab');
        if (changes?.active === true) {
          for (const candidate of tabs.values()) {
            if (candidate.windowId === found.windowId) candidate.active = candidate.id === tabId;
          }
        }
        Object.assign(found, changes);
        return { ...found };
      },
      sendMessage: async (tabId, message) => {
        if ((tabId === targetTab.id || tabId >= 100) && message?.type === 'webmcp.browser.ping') {
          return { version: 1, ok: true, result: { ready: true } };
        }
        if ((tabId === targetTab.id || tabId >= 100) && message?.type === 'webmcp.browser.tool') {
          browserMessages.push(message);
          return browserReply;
        }
        if (tabId === PROVIDER_TAB_ID && message?.type === 'assistant.health') {
          return { ok: true, visibility: providerActivated ? 'visible' : 'hidden', hasFocus: false, generating: false, path: '/' };
        }
        if (tabId === PROVIDER_TAB_ID && message?.type === 'assistant.prompt') {
          return promptReply;
        }
        if (tabId === PROVIDER_TAB_ID && message?.type === 'deepseek.mode-toggle') {
          modeCalls.push(message.label);
          return { ok: true, code: 'MODE_TOGGLED' };
        }
        if (tabId === PROVIDER_TAB_ID && message?.type === 'assistant.action') {
          actionCalls.push(message.action);
          return actionReply;
        }
        return undefined;
      },
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      onCreated: { addListener: (fn) => { listeners.onCreated = fn; } },
      onUpdated: { addListener: (fn) => { listeners.onUpdated = fn; } },
    },
    windows: {
      create: async (createData) => {
        windowsCreated += 1;
        const created = { id: PROVIDER_WINDOW_ID, state: 'normal', focused: createData?.focused === true, tabs: [providerTab] };
        windows.set(PROVIDER_WINDOW_ID, created);
        tabs.set(PROVIDER_TAB_ID, providerTab);
        if (createData?.focused === true) providerActivated = true;
        focusLog.push(createData?.focused === true ? PROVIDER_WINDOW_ID : null);
        return { ...created, tabs: [{ ...providerTab }] };
      },
      get: async (windowId) => {
        const found = windows.get(windowId);
        if (!found) throw new Error('No window');
        return { ...found };
      },
      update: async (windowId, changes) => {
        const found = windows.get(windowId);
        if (!found) throw new Error('No window');
        if (changes?.focused === true) {
          if (windowId === PROVIDER_WINDOW_ID) providerActivated = true;
          focusLog.push(windowId);
        }
        Object.assign(found, changes);
        return { ...found };
      },
    },
    scripting: {
      executeScript: async (call) => { scriptingCalls.push(call); return []; },
    },
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      sendNativeMessage: async (host, payload) => {
        nativeCalls.push(payload);
        if (nativeError) throw new Error(nativeError);
        if (payload.control === 'status') return { version: 1, id: payload.id, ok: true, result: { folder: '/Users/test/Doc/My code', fullAccessUntil: null } };
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
  return {
    send,
    from,
    tab,
    targetTab,
    otherDeepSeekTab,
    providerTab,
    windows,
    focusLog,
    windowsCreated: () => windowsCreated,
    hideProvider() { providerActivated = false; },
    setPromptReply(next) { promptReply = next; },
    setActionReply(next) { actionReply = next; },
    actionCalls,
    modeCalls,
    session,
    local,
    listeners,
    nativeCalls,
    browserMessages,
    scriptingCalls,
    selfUninstalls,
    setActive(next) { active = next; },
    addTab(added) { tabs.set(added.id, added); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const WORK_WINDOW_ID = 2;

// Work is switched on with the keyboard command (the toolbar icon now opens the panel, not a popup).
async function enableWork(background, tabId) {
  background.listeners.onCommand('toggle-work', { id: tabId });
  await flush();
}

async function working(options) {
  const background = await loadBackground(options);
  await enableWork(background, TAB_ID);
  const arrived = await background.send({ type: 'work.arrive' }, background.from(A));
  assert.equal(arrived.work, true);
  return background;
}

// Opening the Side Panel starts (or finds) the assistant for its window.
const openAssistant = (background, windowId = WORK_WINDOW_ID) => background.send({ type: 'assistant.ensure', windowId }, SIDE_PANEL);
const pageTask = async (background) => (await background.send({ type: 'assistant.page-status' }, SIDE_PANEL)).task;

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

test('panel messages are accepted only from the extension Side Panel', async () => {
  const background = await loadBackground();
  for (const message of [{ type: 'assistant.ensure', windowId: WORK_WINDOW_ID }, { type: 'assistant.stop' }, { type: 'assistant.page-status' }, { type: 'assistant.closed' }]) {
    assert.equal(await background.send(message, background.from(A)), undefined, message.type);
  }
  assert.equal(await background.send({ type: 'assistant.page-status' }, { url: 'chrome-extension://test/popup.html' }), undefined);
  assert.equal((await background.send({ type: 'assistant.page-status' }, SIDE_PANEL)).ok, true);
});

test('the first browser tool call locks the page active in the assistant window; nothing is attached before that', async () => {
  const background = await working();
  background.setActive(background.tab);

  const before = (await background.send({ type: 'assistant.page-status' }, SIDE_PANEL));
  assert.equal(before.task.mode, 'idle');
  assert.equal(before.candidate, null, 'the DeepSeek tab itself is never a candidate');
  assert.deepEqual(background.scriptingCalls, []);

  await openAssistant(background);
  const idle = (await background.send({ type: 'assistant.page-status' }, SIDE_PANEL));
  assert.equal(idle.task.mode, 'idle');
  assert.equal(idle.candidate.tabId, background.targetTab.id, 'the page open in the panel window is the candidate');

  await background.send({ type: 'work.completion', text: BROWSER_TOOL_CALL_TEXT }, providerSenderFor(background));
  const task = await pageTask(background);
  assert.equal(task.mode, 'locked');
  assert.equal(task.target.tabId, background.targetTab.id);
  assert.equal(task.target.origin, 'https://fixture.example');
  assert.ok(background.scriptingCalls.length >= 2);
  assert.ok(background.scriptingCalls.every((call) => (
    call.target.tabId === background.targetTab.id
    && call.target.allFrames === true
    && call.files?.[0] === 'target-executor.js'
  )));
});

test('browser tools act on the locked page and never go through Native Messaging', async () => {
  const background = await working();
  background.setActive(background.targetTab);

  const reply = await background.send({ type: 'work.completion', text: BROWSER_TOOL_CALL_TEXT }, background.from(A));
  assert.equal(background.nativeCalls.length, 0);
  assert.equal(background.browserMessages.length, 1);
  assert.equal(background.browserMessages[0].tool, 'inspect_form');
  assert.match(reply.continueWith, /\"name\":\"inspect_form\"/);
  assert.match(reply.continueWith, /\"isError\":false/);
});

async function lockedPage() {
  const background = await working();
  background.setActive(background.targetTab);
  await background.send({ type: 'work.completion', text: BROWSER_TOOL_CALL_TEXT }, background.from(A));
  assert.equal((await pageTask(background)).mode, 'locked');
  return background;
}

test('a same-origin reload keeps the task on its page and reinjects the executor', async () => {
  const background = await lockedPage();
  const initialInjectionCount = background.scriptingCalls.length;
  const reloaded = { ...background.targetTab, url: 'https://fixture.example/form?reload=1', title: 'Employee Travel Claim Reloaded' };

  background.listeners.onUpdated(background.targetTab.id, { status: 'loading', url: reloaded.url }, reloaded);
  await flush();
  assert.equal((await pageTask(background)).target.tabId, background.targetTab.id);

  background.listeners.onUpdated(background.targetTab.id, { status: 'complete' }, reloaded);
  await flush();
  const task = await pageTask(background);
  assert.equal(task.mode, 'locked');
  assert.equal(task.target.origin, 'https://fixture.example');
  assert.equal(task.target.title, 'Employee Travel Claim Reloaded');
  assert.equal(background.scriptingCalls.length, initialInjectionCount + 1);
});

test('a cross-origin navigation the owner did not cause pauses the task instead of following the page', async () => {
  const background = await lockedPage();
  background.listeners.onUpdated(
    background.targetTab.id,
    { status: 'loading', url: 'https://other.example/form' },
    { ...background.targetTab, url: 'https://other.example/form' },
  );
  await flush();
  const task = await pageTask(background);
  assert.equal(task.mode, 'blocked');
  assert.equal(task.reason, 'ORIGIN_CHANGED');

  const blocked = await background.send({ type: 'work.completion', text: BROWSER_TOOL_CALL_TEXT.replace('browser_1', 'browser_2') }, background.from(A, {}));
  assert.match(blocked.continueWith, /TASK_BLOCKED/);

  await background.send({ type: 'assistant.stop' }, SIDE_PANEL);
  assert.equal((await pageTask(background)).mode, 'idle', 'Stop releases the page');
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
  assert.equal((await background.send({ type: 'work.arrive' }, background.from(B))).work, true);
  background.listeners.onUpdated(TAB_ID, { url: 'https://example.com/' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await background.send({ type: 'work.arrive' }, background.from(B))).work, false);
});

test('switching away right after sending the task still resumes the first tool call on return', async () => {
  const background = await working();
  await background.send({ type: 'work.generating' }, background.from(A));
  await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT, resume: true }, background.from(A));
  assert.deepEqual(background.nativeCalls.map((call) => call.id), ['p2_open']);
});


test('local settings controls are relayed only from the popup', async () => {
  const background = await loadBackground();
  assert.equal(await background.send({ type: 'settings.control', control: 'grant-host-access', arguments: { minutes: 60 } }, background.from(A)), undefined);
  assert.equal(background.nativeCalls.length, 0);
  await background.send({ type: 'settings.control', control: 'status' }, SIDE_PANEL);
  assert.deepEqual(background.nativeCalls.map((call) => call.control), ['status']);
});

test('a DSML reply gets a format correction typed back, and nothing runs natively', async () => {
  const background = await working();
  const reply = await background.send({ type: 'work.completion', text: '<｜｜DSML｜｜ invoke name="bash">' }, background.from(A));
  assert.match(reply.continueWith, /^DeepSeek WebMCP format correction\./);
  assert.equal(reply.conversationPath, new URL(A).pathname);
  assert.equal(background.nativeCalls.length, 0);
});

test('after the shared local program is gone, the popup is told so and the worker removes nothing itself', async () => {
  // Removing the extension is left to the popup click: Chrome needs a user gesture for
  // the uninstall dialog, and a call from the worker did nothing live.
  const background = await loadBackground({ nativeError: 'Specified native messaging host not found.' });
  for (const control of ['status', 'uninstall']) {
    const reply = await background.send({ type: 'settings.control', control }, SIDE_PANEL);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'LOCAL_PROGRAM_MISSING');
    assert.match(reply.error.message, /all browsers share it/);
  }
  assert.deepEqual(background.selfUninstalls, []);
});

test('other native failures never remove the extension', async () => {
  const background = await loadBackground({ nativeError: 'Native host has exited.' });
  const uninstall = await background.send({ type: 'settings.control', control: 'uninstall' }, SIDE_PANEL);
  assert.equal(uninstall.ok, false);
  assert.deepEqual(background.selfUninstalls, []);
});

test('Compact Assistant starts for the panel window with one bound provider session', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);

  const opened = await openAssistant(background);
  assert.equal(opened.ok, true);
  assert.equal(opened.session.workWindowId, WORK_WINDOW_ID);
  assert.equal(opened.session.providerTabId, PROVIDER_TAB_ID);
  assert.equal(opened.session.providerWindowId, PROVIDER_WINDOW_ID);
  assert.equal(opened.session.state, 'active');

  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.session.state, 'active');
  assert.equal(status.health.ok, true);
  assert.equal(status.health.page.visibility, 'visible');
});

test('while Compact Assistant is active, another Work-enabled DeepSeek tab cannot execute a valid tool call', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);

  await enableWork(background, OTHER_TAB_ID);
  const otherArrived = await background.send({ type: 'work.arrive' }, background.from(B, { tab: { ...background.otherDeepSeekTab } }));
  assert.equal(otherArrived.work, true);

  const otherSender = background.from(B, {
    tab: { ...background.otherDeepSeekTab },
  });
  const rejected = await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, otherSender);
  assert.deepEqual(rejected, {});
  assert.equal(background.nativeCalls.length, 0);

  const providerSender = background.from('https://chat.deepseek.com/', {
    tab: { ...background.providerTab },
    url: 'https://chat.deepseek.com/',
  });
  const accepted = await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, providerSender);
  assert.equal(background.nativeCalls.length, 1);
  assert.equal(typeof accepted.continueWith, 'string');

  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.session.presentation.toolCount, 1);
  assert.equal(status.session.presentation.tools[0].name, 'open_workspace');
  assert.equal(status.session.presentation.tools[0].status, 'ok');
});

test('provider minimization pauses Compact Assistant and explicit Restore re-arms the recorded provider only', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);

  background.windows.get(PROVIDER_WINDOW_ID).state = 'minimized';
  const paused = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(paused.session.state, 'paused');
  assert.equal(paused.session.pauseCode, 'PROVIDER_MINIMIZED');

  const restored = await background.send({ type: 'assistant.restore' }, SIDE_PANEL);
  assert.equal(restored.ok, true);
  assert.equal(restored.session.state, 'active');
  assert.equal(restored.session.providerTabId, PROVIDER_TAB_ID);
  assert.equal(background.windows.get(PROVIDER_WINDOW_ID).state, 'normal');
});

test('only the Side Panel may send assistant prompts and provider-visible snapshots update presentation without changing tool authority', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);

  assert.equal(
    await background.send({ type: 'assistant.prompt', text: 'Inspect this page' }, background.from(A)),
    undefined,
  );

  const sent = await background.send({ type: 'assistant.prompt', text: 'Inspect this page' }, SIDE_PANEL);
  assert.equal(sent.ok, true);

  const providerSender = background.from('https://chat.deepseek.com/', {
    tab: { ...background.providerTab },
    url: 'https://chat.deepseek.com/',
  });
  await background.send({
    type: 'assistant.snapshot',
    reasoning: 'Visible DeepSeek reasoning',
    answer: 'A readable partial answer',
    generating: true,
  }, providerSender);

  let status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.session.presentation.reasoning, 'Visible DeepSeek reasoning');
  assert.equal(status.session.presentation.answer, 'A readable partial answer');
  assert.equal(status.session.presentation.generating, true);

  await background.send({ type: 'work.completion', text: 'Final answer for the user' }, providerSender);
  status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.session.presentation.answer, 'Final answer for the user');
  assert.equal(status.session.presentation.completed, true);
});

test('after an extension reload the remembered provider tab has no live content script: it is reloaded once, not duplicated', async () => {
  const background = await loadBackground();
  assert.equal((await openAssistant(background)).ok, true);

  // Extension reload: session state is gone and the open tab keeps only a dead content script.
  background.session.delete('assistant.session');
  let orphaned = true;
  const reloaded = [];
  const originalSend = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, message) => {
    if (orphaned && tabId === PROVIDER_TAB_ID && message?.type === 'assistant.health') return undefined;
    return originalSend(tabId, message);
  };
  globalThis.chrome.tabs.reload = async (tabId) => { reloaded.push(tabId); orphaned = false; };

  const reopened = await openAssistant(background);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.session.state, 'active');
  assert.deepEqual(reloaded, [PROVIDER_TAB_ID]);
  assert.equal(background.windowsCreated(), 1, 'the remembered provider window is reused, never duplicated');
});

test('a fresh provider window that starts hidden is activated once, then focus returns to the work window', async () => {
  const background = await loadBackground({ providerStartsHidden: true });
  background.setActive(background.targetTab);

  const opened = await openAssistant(background);
  assert.equal(opened.ok, true);
  assert.equal(opened.session.state, 'active');

  const providerFocus = background.focusLog.indexOf(PROVIDER_WINDOW_ID);
  assert.notEqual(providerFocus, -1, 'provider window must be focused at least once');
  assert.equal(background.focusLog.at(-1), background.targetTab.windowId, 'work window must regain focus last');
  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.health.page.visibility, 'visible');
});

test('content-script readiness alone does not activate the assistant: a provider that never renders still fails closed', async () => {
  const background = await loadBackground({ providerStartsHidden: true });
  background.setActive(background.targetTab);
  // Focus requests are ignored, so the provider stays hidden even though its content script answers.
  const originalUpdate = globalThis.chrome.windows.update;
  globalThis.chrome.windows.update = async (windowId, changes) => {
    if (windowId === PROVIDER_WINDOW_ID) return { id: windowId };
    return originalUpdate(windowId, changes);
  };
  const create = globalThis.chrome.windows.create;
  globalThis.chrome.windows.create = async (createData) => create({ ...createData, focused: false });

  const opened = await openAssistant(background);
  assert.equal(opened.ok, false);
  assert.equal(opened.error.code, 'PROVIDER_HIDDEN');
  assert.match(opened.error.message, /\[work: .*; DeepSeek: .*\]/, 'both windows\' state is recorded for the next occurrence');
  assert.equal(opened.session.state, 'paused');
});

test('Restore from minimized re-bootstraps a provider that comes back hidden', async () => {
  const background = await loadBackground({ providerStartsHidden: true });
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);

  background.windows.get(PROVIDER_WINDOW_ID).state = 'minimized';
  background.hideProvider();
  const paused = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(paused.session.pauseCode, 'PROVIDER_MINIMIZED');

  background.focusLog.length = 0;
  const restored = await background.send({ type: 'assistant.restore' }, SIDE_PANEL);
  assert.equal(restored.ok, true);
  assert.equal(restored.session.state, 'active');
  assert.ok(background.focusLog.includes(PROVIDER_WINDOW_ID));
  assert.equal(background.focusLog.at(-1), background.targetTab.windowId);
});

const providerSenderFor = (background) => background.from('https://chat.deepseek.com/', {
  tab: { ...background.providerTab },
  url: 'https://chat.deepseek.com/',
});

// Fires `count` snapshots without waiting for one to finish, one per event-loop turn, the way
// DeepSeek's mutation observer does while a reply streams.
async function streamSnapshots(background, provider, count, snapshot) {
  const pending = [];
  for (let index = 0; index < count; index += 1) {
    pending.push(background.send({ type: 'assistant.snapshot', ...snapshot }, provider));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(pending);
}

test('interleaved snapshot, tool and final updates cannot erase one another', async () => {
  const background = await loadBackground({ slowStorage: true });
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  assert.equal((await background.send({ type: 'assistant.prompt', text: 'Open the workspace' }, SIDE_PANEL)).ok, true);
  const provider = providerSenderFor(background);

  // snapshot(generating) -> tool started -> tool completed -> snapshot(done), all in flight together.
  await Promise.all([
    streamSnapshots(background, provider, 40, { reasoning: 'thinking about it', answer: '', generating: true }),
    background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, provider),
  ]);
  await streamSnapshots(background, provider, 3, { reasoning: 'thinking about it', answer: '', generating: false });
  let status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.session.presentation.toolCount, 1);
  assert.deepEqual(status.session.presentation.tools.map((tool) => [tool.name, tool.status]), [['open_workspace', 'ok']]);

  // The next reply streams; once it stops, the final and the closing snapshots race each other.
  await Promise.all([
    background.send({ type: 'work.generating' }, provider),
    streamSnapshots(background, provider, 40, { reasoning: 'thinking about it', answer: 'Workspace is open.', generating: true }),
  ]);
  await Promise.all([
    streamSnapshots(background, provider, 5, { reasoning: 'thinking about it', answer: 'Workspace is open.', generating: false }),
    background.send({ type: 'work.completion', text: 'Workspace is open.' }, provider),
  ]);
  status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  const { presentation } = status.session;
  assert.equal(presentation.toolCount, 1, 'tool count survives later snapshots');
  assert.equal(presentation.tools[0].status, 'ok', 'tool status survives later snapshots');
  assert.equal(presentation.answer, 'Workspace is open.');
  assert.equal(presentation.generating, false);
  assert.equal(presentation.completed, true);
  assert.equal(presentation.reasoning, 'thinking about it');
});

test('an unchanged snapshot re-reported after the final does not reopen the finished turn', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = providerSenderFor(background);

  await background.send({ type: 'work.completion', text: 'All done.' }, provider);
  await background.send({ type: 'assistant.snapshot', reasoning: '', answer: 'All done.', generating: false }, provider);
  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.session.presentation.completed, true);
});

test('Stop releases the locked page but keeps the assistant, its conversation and the provider', async () => {
  const background = await loadBackground({ slowStorage: true });
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = providerSenderFor(background);
  await background.send({ type: 'work.completion', text: BROWSER_TOOL_CALL_TEXT }, provider);
  assert.equal((await pageTask(background)).mode, 'locked');

  await Promise.all([
    background.send({ type: 'assistant.stop' }, SIDE_PANEL),
    background.send({ type: 'assistant.snapshot', reasoning: 'later', answer: 'later answer', generating: false }, provider),
  ]);
  assert.equal((await pageTask(background)).mode, 'idle');
  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.equal(status.session.state, 'active');
  assert.equal(status.session.presentation.answer, 'later answer');
});

test('opening the panel again reuses the running assistant and the remembered provider window', async () => {
  const background = await loadBackground();
  const first = await openAssistant(background);
  assert.equal(first.session.providerWindowId, PROVIDER_WINDOW_ID);
  const created = background.focusLog.length;

  const again = await openAssistant(background);
  assert.equal(again.ok, true);
  assert.equal(again.session.providerTabId, first.session.providerTabId);
  assert.equal(background.focusLog.length, created, 'no window is created or focused a second time');

  // After the session is lost (browser restart) the provider window is still found, not duplicated.
  background.session.delete('assistant.session');
  const restored = await openAssistant(background);
  assert.equal(restored.ok, true);
  assert.equal(restored.session.providerWindowId, PROVIDER_WINDOW_ID);
  assert.equal(background.windowsCreated(), 1);
});

test('a prompt DeepSeek did not accept is withdrawn from history and can be retried without duplicates', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);

  background.setPromptReply({ ok: false, code: 'SEND_NOT_CONFIRMED' });
  const failed = await background.send({ type: 'assistant.prompt', text: 'Explain WebMCP' }, SIDE_PANEL);
  assert.equal(failed.ok, false);
  let status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.deepEqual(status.session.presentation.history, []);
  assert.notEqual(status.session.presentation.notice, '');

  background.setPromptReply({ ok: true, code: 'SEND_CLICKED' });
  assert.equal((await background.send({ type: 'assistant.prompt', text: 'Explain WebMCP' }, SIDE_PANEL)).ok, true);
  status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.deepEqual(status.session.presentation.history.map((item) => item.text), ['Explain WebMCP']);
});

test('a prompt reported as failed stays in history when the provider is already replying to it', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = providerSenderFor(background);

  // The provider's generation is observed while the send acknowledgement is still pending.
  background.setPromptReply({ ok: false, code: 'SEND_NOT_CONFIRMED' });
  const originalSend = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message?.type === 'assistant.prompt') {
      await background.send({ type: 'assistant.snapshot', reasoning: 'already thinking', answer: '', generating: true }, provider);
    }
    return originalSend(tabId, message);
  };
  await background.send({ type: 'assistant.prompt', text: 'Explain WebMCP' }, SIDE_PANEL);
  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.deepEqual(status.session.presentation.history.map((item) => item.text), ['Explain WebMCP']);
});

test('the tool contract tells DeepSeek the owner\'s page is available once the assistant is running', async () => {
  const background = await loadBackground();
  await enableWork(background, TAB_ID);
  const noAssistant = await background.send({ type: 'work.arrive' }, background.from(A));
  assert.ok(!noAssistant.instructions.includes('already attached'));

  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const running = await background.send({ type: 'work.arrive' }, background.from(A));
  assert.ok(running.instructions.includes('already attached'));
});

test('the assistant marks only the first prompt of a session for the tool contract', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);

  const sentMessages = [];
  const original = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message?.type === 'assistant.prompt') sentMessages.push(message);
    return original(tabId, message);
  };
  await background.send({ type: 'assistant.prompt', text: 'first' }, SIDE_PANEL);
  await background.send({ type: 'assistant.prompt', text: 'second' }, SIDE_PANEL);
  assert.deepEqual(sentMessages.map((message) => message.withInstructions), [true, false]);
});

const RICH = [
  { type: 'heading', level: 2, runs: [{ text: 'Plan' }] },
  { type: 'paragraph', runs: [{ text: 'see ' }, { text: 'docs', href: 'https://example.com/' }, { text: 'bad', href: 'javascript:alert(1)' }] },
  { type: 'code', lang: 'js', text: 'a();' },
];

async function finishedAnswer(background, provider, { answer = 'Plan see docsbad a();', blocks = RICH } = {}) {
  await background.send({ type: 'work.generating' }, provider);
  await background.send({ type: 'assistant.snapshot', reasoning: 'why', answer, blocks, generating: false }, provider);
  await background.send({ type: 'work.completion', text: answer }, provider);
  return (await background.send({ type: 'assistant.status' }, SIDE_PANEL)).session.presentation;
}

test('the answer structure is stored re-validated, and a hostile link loses its target', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const presentation = await finishedAnswer(background, providerSenderFor(background));
  assert.deepEqual(presentation.blocks.map((block) => block.type), ['heading', 'paragraph', 'code']);
  assert.deepEqual(presentation.blocks[1].runs.at(-1), { text: 'bad' });
  assert.equal(presentation.blocks[1].runs[1].href, 'https://example.com/');
  assert.equal(presentation.completed, true);
});

test('structure never outlives its text: a filtered answer and a changed final both drop the blocks', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = providerSenderFor(background);

  await background.send({ type: 'assistant.snapshot', reasoning: '', answer: '<webmcp_tool_call>{"id":"x"}</webmcp_tool_call>', blocks: RICH, generating: false }, provider);
  let presentation = (await background.send({ type: 'assistant.status' }, SIDE_PANEL)).session.presentation;
  assert.equal(presentation.answer, '');
  assert.deepEqual(presentation.blocks, []);

  await background.send({ type: 'assistant.snapshot', reasoning: '', answer: 'draft', blocks: RICH, generating: true }, provider);
  await background.send({ type: 'work.completion', text: 'a different final' }, provider);
  presentation = (await background.send({ type: 'assistant.status' }, SIDE_PANEL)).session.presentation;
  assert.equal(presentation.answer, 'a different final');
  assert.deepEqual(presentation.blocks, []);
});

test('a finished answer keeps its structure in history for the next turn, and stored blocks are re-checked on every read', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  await background.send({ type: 'assistant.prompt', text: 'first' }, SIDE_PANEL);
  await finishedAnswer(background, providerSenderFor(background));

  await background.send({ type: 'assistant.prompt', text: 'second' }, SIDE_PANEL);
  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  const archived = status.session.presentation.history.find((item) => item.role === 'assistant');
  assert.deepEqual(archived.blocks.map((block) => block.type), ['heading', 'paragraph', 'code']);
  assert.deepEqual(status.session.presentation.blocks, []);

  const stored = background.session.get('assistant.session');
  stored.presentation.history.find((item) => item.role === 'assistant').blocks = [{ type: 'script' }, { type: 'paragraph', runs: [{ text: 'x', href: 'data:text/html,1' }] }];
  const reread = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.deepEqual(reread.session.presentation.history.find((item) => item.role === 'assistant').blocks, [{ type: 'paragraph', runs: [{ text: 'x' }] }]);
});

test('Regenerate and Share are Side Panel actions on the bound provider only', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);

  for (const sender of [{ url: 'chrome-extension://test/popup.html' }, background.from(A), providerSenderFor(background)]) {
    assert.equal(await background.send({ type: 'assistant.action', action: 'regenerate' }, sender), undefined);
  }
  assert.equal((await background.send({ type: 'assistant.action', action: 'format-disk' }, SIDE_PANEL)).ok, false);
  assert.deepEqual(background.actionCalls, []);

  const idle = await loadBackground();
  const notStarted = await idle.send({ type: 'assistant.action', action: 'regenerate' }, SIDE_PANEL);
  assert.equal(notStarted.error.code, 'ASSISTANT_NOT_ACTIVE');
  assert.deepEqual(idle.actionCalls, []);
});

test('Regenerate replaces the current reply and waits for the new one; it is refused while generating', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = providerSenderFor(background);
  await finishedAnswer(background, provider);

  const done = await background.send({ type: 'assistant.action', action: 'regenerate' }, SIDE_PANEL);
  assert.equal(done.ok, true);
  assert.deepEqual(background.actionCalls, ['regenerate']);
  const { presentation } = done.session;
  assert.equal(presentation.answer, '');
  assert.deepEqual(presentation.blocks, []);
  assert.equal(presentation.generating, true);
  assert.equal(presentation.completed, false);

  const busy = await background.send({ type: 'assistant.action', action: 'regenerate' }, SIDE_PANEL);
  assert.equal(busy.error.code, 'GENERATION_IN_PROGRESS');
  assert.deepEqual(background.actionCalls, ['regenerate']);
});

test('a missing DeepSeek control keeps the answer and tells the panel why', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  await finishedAnswer(background, providerSenderFor(background));

  background.setActionReply({ ok: false, code: 'CONTROL_NOT_FOUND', message: 'DeepSeek regenerate control not found. Controls seen: div.ds-icon-button[|M8.3125]' });
  const failed = await background.send({ type: 'assistant.action', action: 'regenerate' }, SIDE_PANEL);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'CONTROL_NOT_FOUND');
  const { presentation } = (await background.send({ type: 'assistant.status' }, SIDE_PANEL)).session;
  assert.match(presentation.notice, /control not found/);
  assert.equal(presentation.answer, 'Plan see docsbad a();');
  assert.equal(presentation.generating, false);
});

test('Share presses the provider control and brings the DeepSeek window forward for the owner to finish', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  await finishedAnswer(background, providerSenderFor(background));

  background.focusLog.length = 0;
  const shared = await background.send({ type: 'assistant.action', action: 'share' }, SIDE_PANEL);
  assert.equal(shared.ok, true);
  assert.deepEqual(background.actionCalls, ['share']);
  assert.equal(background.focusLog.at(-1), PROVIDER_WINDOW_ID);
  assert.equal(shared.session.presentation.answer, 'Plan see docsbad a();', 'sharing does not touch the answer');
  assert.match(shared.session.presentation.notice, /DeepSeek window/);
});

test('a failed Regenerate/Share hands the provider diagnostic to the panel; success and oversize or malformed detail do not', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  await finishedAnswer(background, providerSenderFor(background));

  const diagnostics = { action: 'share', count: 1, controls: [{ index: 0, svg: { path: 'M8.5 2.15137' } }] };
  background.setActionReply({ ok: false, code: 'CONTROL_NOT_FOUND', message: 'not found', diagnostics });
  const failed = await background.send({ type: 'assistant.action', action: 'share' }, SIDE_PANEL);
  assert.deepEqual(failed.diagnostics, diagnostics);
  assert.equal(failed.error.code, 'CONTROL_NOT_FOUND');

  for (const bad of ['a string', ['array'], null, { blob: 'x'.repeat(20001) }]) {
    background.setActionReply({ ok: false, code: 'CONTROL_NOT_FOUND', message: 'not found', diagnostics: bad });
    const reply = await background.send({ type: 'assistant.action', action: 'share' }, SIDE_PANEL);
    assert.equal('diagnostics' in reply, false, JSON.stringify(bad).slice(0, 30));
  }

  background.setActionReply({ ok: true, code: 'ACTION_CLICKED', diagnostics });
  const done = await background.send({ type: 'assistant.action', action: 'share' }, SIDE_PANEL);
  assert.equal(done.ok, true);
  assert.equal('diagnostics' in done, false);
});

// ---- A click that opens another page (the email case): the task follows it, causally ----

const CLICK_TEXT = (id) => `<webmcp_tool_call>{"id":"${id}","name":"click","arguments":{"ref":"e1"}}</webmcp_tool_call>`;
const COMPOSE = { id: 101, url: 'https://mail.example/compose', title: 'New message', windowId: 2, status: 'complete', active: false };

async function afterClick(options) {
  const background = await lockedPage();
  await background.send({ type: 'work.continuation-result', result: { ok: true, code: 'SEND_CLICKED' }, conversationPath: new URL(A).pathname }, background.from(A));
  await background.send({ type: 'work.completion', text: CLICK_TEXT('c1'), resume: true }, background.from(A));
  return background;
}

test('a click starts a short handoff lease on the page it acts on', async () => {
  const background = await afterClick();
  const task = await pageTask(background);
  assert.equal(task.mode, 'locked');
  assert.equal(task.handoff.sourceTabId, background.targetTab.id);
  assert.equal(task.handoff.destinationTabId, null);
  assert.equal(background.browserMessages.at(-1).tool, 'click');
});

test('a popup or new tab opened by that click is adopted, and closing it returns to the page it came from', async () => {
  const background = await afterClick();
  background.addTab({ ...COMPOSE });

  background.listeners.onCreated({ ...COMPOSE, openerTabId: background.targetTab.id });
  await flush();
  const followed = await pageTask(background);
  assert.equal(followed.mode, 'locked');
  assert.equal(followed.target.tabId, COMPOSE.id);
  assert.equal(followed.target.origin, 'https://mail.example');
  assert.deepEqual(followed.parents.map((parent) => parent.tabId), [background.targetTab.id]);

  background.listeners.onRemoved(COMPOSE.id);
  await flush();
  await flush();
  const back = await pageTask(background);
  assert.equal(back.mode, 'locked');
  assert.equal(back.target.tabId, background.targetTab.id);
});

test('a tab that was not opened by the clicked page, or that appears after the lease, is never adopted', async () => {
  const background = await afterClick();
  background.listeners.onCreated({ ...COMPOSE, openerTabId: 999 });
  background.listeners.onCreated({ ...COMPOSE, id: 102 });
  await flush();
  assert.equal((await pageTask(background)).target.tabId, background.targetTab.id);

  const realNow = Date.now;
  Date.now = () => realNow() + 5000;
  try {
    background.listeners.onCreated({ ...COMPOSE, id: 103, openerTabId: background.targetTab.id });
    await flush();
  } finally {
    Date.now = realNow;
  }
  assert.equal((await pageTask(background)).target.tabId, background.targetTab.id);
});

test('the same tab may cross origin only while the click lease is live; otherwise the task pauses', async () => {
  const live = await afterClick();
  const moved = { ...live.targetTab, url: 'https://accounts.example/login', title: 'Sign in' };
  live.listeners.onUpdated(live.targetTab.id, { status: 'loading', url: moved.url }, moved);
  await flush();
  assert.notEqual((await pageTask(live)).mode, 'blocked');

  const idle = await lockedPage();
  idle.listeners.onUpdated(idle.targetTab.id, { status: 'loading', url: moved.url }, moved);
  await flush();
  assert.equal((await pageTask(idle)).reason, 'ORIGIN_CHANGED');
});

test('a submit-like click is refused by the page module and the page work stays with the owner', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../extension/target-executor.js', import.meta.url), 'utf8');
  assert.match(source, /CONFIRMATION_REQUIRED/);
  assert.match(source, /commitPattern = \/\\b\(submit\|send\|pay/);
});

test('after Stop the next prompt tells DeepSeek the page is disconnected, once, and the next page action locks the page now open', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = providerSenderFor(background);
  await background.send({ type: 'work.completion', text: BROWSER_TOOL_CALL_TEXT }, provider);
  assert.equal((await pageTask(background)).target.tabId, background.targetTab.id);

  const sent = [];
  const original = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message?.type === 'assistant.prompt') sent.push(message);
    return original(tabId, message);
  };

  await background.send({ type: 'assistant.prompt', text: 'read this page' }, SIDE_PANEL);
  await background.send({ type: 'assistant.stop' }, SIDE_PANEL);
  await background.send({ type: 'assistant.prompt', text: 'now read the other page' }, SIDE_PANEL);
  await background.send({ type: 'assistant.prompt', text: 'and summarize' }, SIDE_PANEL);
  assert.deepEqual(sent.map((message) => Boolean(message.pageNote)), [false, true, false]);
  assert.match(sent[1].pageNote, /pressed Stop.*call inspect_page again/);

  // The owner moved to another page in the same window; the task is free to lock it.
  const second = { id: 120, url: 'https://second.example/inbox', title: 'Second page', windowId: WORK_WINDOW_ID, active: true };
  background.addTab(second);
  background.targetTab.active = false;
  background.setActive(second);
  // (a new conversation in the provider, so the first call's pending result does not gate this one)
  const laterConversation = background.from(B, { tab: { ...background.providerTab, url: B }, url: B });
  await background.send({ type: 'work.generating' }, laterConversation);
  await background.send({ type: 'work.completion', text: BROWSER_TOOL_CALL_TEXT.replace('browser_1', 'browser_9') }, laterConversation);
  const task = await pageTask(background);
  assert.equal(task.mode, 'locked');
  assert.equal(task.target.tabId, second.id);
  assert.equal(task.target.origin, 'https://second.example');
});

test('open_workspace tells DeepSeek that /workspace is the owner\'s folder itself, by its real name', async () => {
  const background = await working();
  await background.send({ type: 'settings.control', control: 'status' }, SIDE_PANEL);
  const reply = await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, background.from(A));
  assert.match(reply.continueWith, /\"hostFolderName\":\"My code\"/);
  assert.match(reply.continueWith, /\/workspace IS the owner's folder named \\"My code\\" itself/);

  const other = await working();
  const plain = await other.send({ type: 'work.completion', text: TOOL_CALL_TEXT }, other.from(A));
  assert.doesNotMatch(plain.continueWith, /hostFolderName/, 'nothing is invented when the folder name is not known');
});

// Live 2026-09-25: the Side Panel then opened on DeepSeek first, whose assistant session bound DeepSeek as
// the only provider; after switching to ChatGPT every ChatGPT tool call was refused NOT_BOUND_PROVIDER.
test('opening the ChatGPT panel ends the DeepSeek assistant session, so ChatGPT is the one provider', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  assert.ok(background.session.has(`work.authority.${PROVIDER_TAB_ID}`), 'DeepSeek provider has Work');

  Object.assign(globalThis.chrome.runtime, { id: 'test' });
  globalThis.chrome.declarativeNetRequest = { updateSessionRules: async () => {} };
  const chatgptPanel = { url: 'chrome-extension://test/sidepanel-chatgpt.html' };
  assert.equal((await background.send({ type: 'panel.frame-open' }, chatgptPanel)).ok, true);

  assert.equal(background.session.has('assistant.session'), false);
  assert.equal(background.session.has(`work.authority.${PROVIDER_TAB_ID}`), false, 'DeepSeek provider no longer has Work');

  const frame = { origin: 'https://chatgpt.com', url: 'https://chatgpt.com/' };
  const href = 'https://chatgpt.com/c/6ab6e0d4-357c-83ed-81dd-12919a6482c2';
  assert.equal((await background.send({ type: 'work.arrive', href }, frame)).work, true);
  const reply = await background.send({ type: 'work.completion', text: TOOL_CALL_TEXT, href }, frame);
  assert.equal(background.session.get('work.diagnostics.-2')?.lastCode, 'TOOL_RESULT');
  assert.equal(background.nativeCalls.filter((call) => call.tool === 'open_workspace' || call.name === 'open_workspace').length, 1);
  assert.equal(typeof reply.continueWith, 'string');
});

// C3/C6: deepseek-model.js reports the mode toggles; the saved session must keep them for the panel.
test('the bound DeepSeek provider\'s mode report survives in the assistant session', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = { tab: { id: PROVIDER_TAB_ID, url: A }, frameId: 0, url: A };
  const toggles = [{ label: '深度思考', on: false }, { label: '智能搜索', on: true }];
  await background.send({ type: 'model.status', model: { model: 'DeepSeek', mode: '智能搜索', toggles } }, provider);
  const status = await background.send({ type: 'assistant.status' }, SIDE_PANEL);
  assert.deepEqual(status.session.presentation.model, { model: 'DeepSeek', mode: '智能搜索', toggles });
});

// C6: the panel switches a DeepSeek mode; only a toggle the provider page reported is relayed.
test('the panel switches a DeepSeek mode in the bound provider page, and nothing else', async () => {
  const background = await loadBackground();
  background.setActive(background.targetTab);
  assert.equal((await openAssistant(background)).ok, true);
  const provider = { tab: { id: PROVIDER_TAB_ID, url: A }, frameId: 0, url: A };
  const toggles = [{ label: '深度思考', on: false }, { label: '智能搜索', on: true }];
  await background.send({ type: 'model.status', model: { model: 'DeepSeek', mode: '智能搜索', toggles } }, provider);

  assert.equal(await background.send({ type: 'assistant.mode-toggle', label: '深度思考' }, background.from(A)), undefined, 'a page cannot ask');
  assert.equal((await background.send({ type: 'assistant.mode-toggle', label: 'Delete chat' }, SIDE_PANEL)).error.code, 'INVALID_MODE');
  assert.deepEqual(background.modeCalls, []);

  const done = await background.send({ type: 'assistant.mode-toggle', label: '深度思考' }, SIDE_PANEL);
  assert.equal(done.ok, true);
  assert.deepEqual(background.modeCalls, ['深度思考']);

  await background.send({ type: 'work.generating' }, provider);
  const busy = await background.send({ type: 'assistant.mode-toggle', label: '深度思考' }, SIDE_PANEL);
  assert.equal(busy.error.code, 'GENERATION_IN_PROGRESS');
  assert.deepEqual(background.modeCalls, ['深度思考']);
});
