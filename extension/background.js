import { WorkController, buildFormatCorrection, buildNativeToolResult, buildWorkInstructions } from './core/agent-controller.js';
import { callNativeControl, callNativeTool, isToolAllowed } from './native-client.js';

const ORIGIN = 'https://chat.deepseek.com';
const AUTHORITY_PREFIX = 'work.authority.';
// Diagnostics live in session storage too: a reconstructed worker must not
// report `diagnostics: null` for a completion it actually handled.
const DIAGNOSTICS_PREFIX = 'work.diagnostics.';
const MAX_ANSWER_CHARS = 512 * 1024;
const CONVERSATION_PATH = /^\/a\/chat\/s\/[A-Za-z0-9-]+$/;
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

const authorityKey = (tabId) => `${AUTHORITY_PREFIX}${tabId}`;
const diagnosticsKey = (tabId) => `${DIAGNOSTICS_PREFIX}${tabId}`;

async function controllerFor(tabId) {
  const cached = controllers.get(tabId);
  if (cached) return cached;
  const key = authorityKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const controller = WorkController.fromSnapshot(stored[key]);
  if (!controller.status.work) return null;
  controllers.set(tabId, controller);
  return controller;
}

async function persist(tabId, controller) {
  controllers.set(tabId, controller);
  await chrome.storage.session.set({ [authorityKey(tabId)]: controller.snapshot() });
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a7f37' });
  } catch {}
}

async function notifyTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'work.changed' });
  } catch {}
}

async function setDiagnostics(tabId, diagnostics) {
  await chrome.storage.session.set({ [diagnosticsKey(tabId)]: { ...diagnostics, at: Date.now() } });
}

async function statusFor(tabId) {
  const controller = await controllerFor(tabId);
  return controller?.status ?? Object.freeze({ work: false, calls: 0 });
}

async function workOn(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!conversationKey(tab.url)) return { ok: false, code: 'NOT_DEEPSEEK' };
  const controller = (await controllerFor(tabId)) ?? new WorkController();
  controller.enable();
  await persist(tabId, controller);
  await chrome.storage.session.remove(diagnosticsKey(tabId));
  await setBadge(tabId, true);
  await notifyTab(tabId);
  return { ok: true, status: controller.status };
}

async function workOff(tabId) {
  controllers.delete(tabId);
  await chrome.storage.session.remove(authorityKey(tabId));
  await setBadge(tabId, false);
  await notifyTab(tabId);
  return { ok: true, status: await statusFor(tabId) };
}

async function toggleWork(tabId) {
  return (await statusFor(tabId)).work ? workOff(tabId) : workOn(tabId);
}

// A result is always stored as pending for the conversation that produced the call
// and is only handed to the page while that same conversation is displayed.
function deliveryFor(controller, key) {
  const text = controller.pendingFor(key);
  return text === null ? {} : { continueWith: text, conversationPath: new URL(key).pathname };
}

async function processCompletion(tabId, key, text, resume) {
  const controller = await controllerFor(tabId);
  if (!controller) return {};

  const diagnostics = { answerLength: text.length, lastCode: null };
  if (text.length > MAX_ANSWER_CHARS) {
    await setDiagnostics(tabId, { ...diagnostics, lastCode: 'RESPONSE_TOO_LARGE' });
    return {};
  }

  let decision;
  try {
    decision = controller.acceptCompletion(key, text, { resume });
  } catch (error) {
    await persist(tabId, controller);
    await setDiagnostics(tabId, { ...diagnostics, lastCode: error?.code ?? 'TOOL_PARSE_FAILED' });
    return {};
  }
  if (decision.code === 'NOTHING_TO_RESUME') return {};
  await persist(tabId, controller);
  await setDiagnostics(tabId, { ...diagnostics, lastCode: decision.code });
  if (decision.code === 'NATIVE_TOOL_SYNTAX') {
    controller.setPending(key, buildFormatCorrection());
    await persist(tabId, controller);
    return deliveryFor(controller, key);
  }
  if (!decision.accepted || decision.code !== 'TOOL_CALLS') return {};

  if (decision.calls.length !== 1) {
    await setDiagnostics(tabId, { ...diagnostics, lastCode: 'MULTIPLE_CALLS' });
    return {};
  }
  const [call] = decision.calls;
  if (!isToolAllowed(call.name)) {
    await setDiagnostics(tabId, { ...diagnostics, lastCode: 'TOOL_NOT_ALLOWED' });
    return {};
  }

  let nativeResponse;
  try {
    nativeResponse = await callNativeTool(call);
  } catch (error) {
    nativeResponse = { version: 1, id: call.id, ok: false, error: { code: error?.code ?? 'NATIVE_CALL_FAILED', message: 'The local WebMCP runtime is not reachable. Run npm run doctor on the Mac.' } };
  }

  // Work may have been switched off while the tool ran.
  const current = await controllerFor(tabId);
  if (!current) return {};
  current.setPending(key, buildNativeToolResult(call, nativeResponse));
  await persist(tabId, current);
  await setDiagnostics(tabId, { ...diagnostics, lastCode: nativeResponse.ok ? 'TOOL_RESULT' : 'TOOL_ERROR' });
  return deliveryFor(current, key);
}

async function arrive(tabId, key) {
  const controller = await controllerFor(tabId);
  await setBadge(tabId, Boolean(controller));
  if (!controller) return { work: false };
  return { work: true, instructions: buildWorkInstructions(), ...deliveryFor(controller, key) };
}

async function recordContinuation(tabId, key, result) {
  const controller = await controllerFor(tabId);
  if (!controller) return;
  const continuation = { ok: result?.ok === true, code: typeof result?.code === 'string' ? result.code.slice(0, 64) : 'UNKNOWN' };
  // A result that could not be sent stays pending and is retried on the next visit.
  if (continuation.ok && controller.pendingFor(key) !== null) {
    controller.delivered(key);
    await persist(tabId, controller);
  }
  const stored = (await chrome.storage.session.get(diagnosticsKey(tabId)))[diagnosticsKey(tabId)] ?? {};
  await setDiagnostics(tabId, { ...stored, continuation });
}

async function runControl(control, args) {
  const allowedArgs = control === 'grant-full-access' ? { minutes: Number(args?.minutes) } : {};
  let response;
  try {
    response = await callNativeControl(control, allowedArgs);
  } catch (error) {
    return { ok: false, error: { code: error?.code ?? 'NATIVE_CALL_FAILED', message: 'Local runtime not reachable. Run the install command again.' } };
  }
  if (control === 'uninstall' && response.ok && response.result?.uninstalled) {
    // The local side is gone; remove the extension too (no extra permission for self).
    setTimeout(() => chrome.management.uninstallSelf({ showConfirmDialog: false }).catch(() => {}), 500);
  }
  return response;
}

// The conversation key must come from `sender.tab.url`, the same browser-side
// last committed URL that tabs.get and tabs.onUpdated report. `sender.url` is the
// content script's ScriptContext URL fixed at injection (Chromium
// extensions/renderer/ipc_message_sender.cc -> script_context->url()), so it stays
// stale after DeepSeek's SPA pushState to /a/chat/s/<uuid>. Only the top frame may
// speak for the tab's URL.
function senderContext(sender) {
  if (!sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return null;
  const key = conversationKey(sender.tab.url);
  if (conversationKey(sender.url) === null || key === null) return null;
  return { tabId: sender.tab.id, key };
}

function isPopup(sender) {
  return !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'work.completion' && typeof message.text === 'string') {
    const context = senderContext(sender);
    if (!context) return undefined;
    return processCompletion(context.tabId, context.key, message.text, message.resume === true);
  }
  if (message.type === 'work.generating') {
    const context = senderContext(sender);
    if (!context) return undefined;
    return controllerFor(context.tabId).then(async (controller) => {
      if (!controller) return { ok: true };
      controller.generationStarted(context.key);
      await persist(context.tabId, controller);
      return { ok: true };
    });
  }
  if (message.type === 'work.arrive') {
    const context = senderContext(sender);
    if (!context) return undefined;
    return arrive(context.tabId, context.key);
  }
  if (message.type === 'work.continuation-result') {
    const context = senderContext(sender);
    if (!context || typeof message.conversationPath !== 'string' || !CONVERSATION_PATH.test(message.conversationPath)) return undefined;
    // The user may already have switched chats; the result belongs to the path it was typed into.
    return recordContinuation(context.tabId, `${ORIGIN}${message.conversationPath}`, message.result).then(() => ({ ok: true }));
  }

  if (!isPopup(sender)) return undefined;
  if (message.type === 'settings.control' && typeof message.control === 'string') return runControl(message.control, message.arguments);
  if (!Number.isInteger(message.tabId)) return undefined;
  if (message.type === 'work.ui-status') {
    const key = diagnosticsKey(message.tabId);
    return Promise.all([statusFor(message.tabId), chrome.storage.session.get(key)]).then(([status, stored]) => ({
      ok: true,
      status,
      diagnostics: stored[key] ?? null,
    }));
  }
  if (message.type === 'work.ui-toggle') return toggleWork(message.tabId);
  return undefined;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-work' && Number.isInteger(tab?.id)) void toggleWork(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  controllers.delete(tabId);
  void chrome.storage.session.remove([authorityKey(tabId), diagnosticsKey(tabId)]);
});

// Moving within DeepSeek keeps Work (results wait for their conversation); leaving
// DeepSeek switches it off.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === 'string' && conversationKey(changeInfo.url) === null) void workOff(tabId);
});
