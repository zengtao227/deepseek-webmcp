import { AgentController, buildNativeToolResult } from './core/agent-controller.js';
import { callNativeTool, isToolAllowed } from './native-client.js';

const ORIGIN = 'https://chat.deepseek.com';
const AUTHORITY_PREFIX = 'p1.authority.';
// Diagnostics live in session storage too: a reconstructed worker must not
// report `diagnostics: null` for a completion it actually handled.
const DIAGNOSTICS_PREFIX = 'p1.diagnostics.';
const MAX_ANSWER_CHARS = 512 * 1024;
const controllers = new Map();

function conversationKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== ORIGIN) return null;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function authorityKey(tabId) {
  return `${AUTHORITY_PREFIX}${tabId}`;
}

function diagnosticsKey(tabId) {
  return `${DIAGNOSTICS_PREFIX}${tabId}`;
}

async function controllerFor(tabId) {
  const cached = controllers.get(tabId);
  if (cached) return cached;

  const key = authorityKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const controller = AgentController.fromSnapshot(stored[key]);
  if (!controller.status.armed) return null;

  controllers.set(tabId, controller);
  return controller;
}

async function persistController(tabId, controller) {
  controllers.set(tabId, controller);
  await chrome.storage.session.set({ [authorityKey(tabId)]: controller.snapshot() });
}

async function clearController(tabId) {
  controllers.delete(tabId);
  await chrome.storage.session.remove(authorityKey(tabId));
}

async function setDiagnostics(tabId, diagnostics) {
  await chrome.storage.session.set({ [diagnosticsKey(tabId)]: { ...diagnostics, at: Date.now() } });
}

async function statusFor(tabId) {
  const controller = await controllerFor(tabId);
  return controller?.status ?? Object.freeze({ armed: false, conversationKey: null, loops: 0, maxLoops: 6 });
}

async function armTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const key = conversationKey(tab.url);
  if (!key) return { ok: false, code: 'NOT_DEEPSEEK' };

  const controller = new AgentController();
  controller.arm(key);
  await persistController(tabId, controller);
  await chrome.storage.session.remove(diagnosticsKey(tabId));
  return { ok: true, status: controller.status };
}

async function disarmTab(tabId) {
  await clearController(tabId);
  return { ok: true, status: await statusFor(tabId) };
}

async function processCompletion(tabId, senderUrl, text) {
  const controller = await controllerFor(tabId);
  if (!controller) return {};

  const diagnosticsStorageKey = diagnosticsKey(tabId);
  const previousDiagnostics = (await chrome.storage.session.get(diagnosticsStorageKey))[diagnosticsStorageKey] ?? {};
  const diagnostics = {
    answerLength: text.length,
    lastCode: null,
    ...(previousDiagnostics.continuation ? { continuation: previousDiagnostics.continuation } : {}),
  };
  if (text.length > MAX_ANSWER_CHARS) {
    diagnostics.lastCode = 'RESPONSE_TOO_LARGE';
    await setDiagnostics(tabId, diagnostics);
    await disarmTab(tabId);
    return {};
  }

  let decision;
  try {
    decision = controller.acceptCompletion(conversationKey(senderUrl), text);
  } catch (error) {
    diagnostics.lastCode = error?.code ?? 'TOOL_PARSE_FAILED';
    await setDiagnostics(tabId, diagnostics);
    await disarmTab(tabId);
    return {};
  }

  diagnostics.lastCode = decision.code;
  await setDiagnostics(tabId, diagnostics);
  if (controller.status.armed) await persistController(tabId, controller);
  else await clearController(tabId);

  if (!decision.accepted || decision.code !== 'TOOL_CALLS') return {};
  if (decision.calls.length !== 1) {
    diagnostics.lastCode = 'MULTIPLE_CALLS';
    await setDiagnostics(tabId, diagnostics);
    await disarmTab(tabId);
    return {};
  }

  const [call] = decision.calls;
  if (!isToolAllowed(call.name)) {
    diagnostics.lastCode = 'TOOL_NOT_ALLOWED';
    await setDiagnostics(tabId, diagnostics);
    await disarmTab(tabId);
    return {};
  }

  let nativeResponse;
  try {
    nativeResponse = await callNativeTool(call);
  } catch (error) {
    diagnostics.lastCode = error?.code ?? 'NATIVE_CALL_FAILED';
    await setDiagnostics(tabId, diagnostics);
    await disarmTab(tabId);
    return {};
  }

  diagnostics.lastCode = nativeResponse.ok ? 'TOOL_RESULT' : 'TOOL_ERROR';
  await setDiagnostics(tabId, diagnostics);
  return { continueWith: buildNativeToolResult(call, nativeResponse) };
}

async function recordContinuation(tabId, result) {
  const key = diagnosticsKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key] ?? {};
  const continuation = { ok: result?.ok === true, code: typeof result?.code === 'string' ? result.code.slice(0, 64) : 'UNKNOWN' };
  await setDiagnostics(tabId, { ...stored, continuation });
  if (!continuation.ok) await disarmTab(tabId);
}

// The conversation key must come from `sender.tab.url`, the same browser-side
// last committed URL that ARM reads via tabs.get and that tabs.onUpdated tracks.
// `sender.url` is the content script's ScriptContext URL fixed at injection
// (Chromium extensions/renderer/ipc_message_sender.cc -> script_context->url()),
// so it stays stale after DeepSeek's SPA pushState to /a/chat/s/<uuid>.
// Only the top frame may speak for the tab's URL.
function senderTabId(sender) {
  if (!sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return null;
  if (conversationKey(sender.url) === null || conversationKey(sender.tab.url) === null) return null;
  return sender.tab.id;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'p1.completion' && typeof message.text === 'string') {
    const tabId = senderTabId(sender);
    if (tabId === null) return undefined;
    return processCompletion(tabId, sender.tab.url, message.text);
  }

  if (message.type === 'p1.continuation-result') {
    const tabId = senderTabId(sender);
    if (tabId === null) return undefined;
    return recordContinuation(tabId, message.result).then(() => ({ ok: true }));
  }

  if (message.type === 'p1.ui-status' && Number.isInteger(message.tabId)) {
    const key = diagnosticsKey(message.tabId);
    return Promise.all([statusFor(message.tabId), chrome.storage.session.get(key)]).then(([status, stored]) => ({
      ok: true,
      status,
      diagnostics: stored[key] ?? null,
    }));
  }

  if (message.type === 'p1.ui-arm' && Number.isInteger(message.tabId)) return armTab(message.tabId);
  if (message.type === 'p1.ui-disarm' && Number.isInteger(message.tabId)) return disarmTab(message.tabId);
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearController(tabId);
  void chrome.storage.session.remove(diagnosticsKey(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === 'string') void disarmTab(tabId);
});
