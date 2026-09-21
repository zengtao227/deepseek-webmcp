import { WorkController, buildFormatCorrection, buildNativeToolResult, buildWorkInstructions } from './core/agent-controller.js';
import { BrowserClientError, callBrowserTool, isBrowserToolAllowed } from './browser-client.js';
import { normalizeBlocks } from './answer-blocks.js';
import { callNativeControl, callNativeTool, isToolAllowed } from './native-client.js';

const ORIGIN = 'https://chat.deepseek.com';
const AUTHORITY_PREFIX = 'work.authority.';
// Diagnostics live in session storage too: a reconstructed worker must not
// report `diagnostics: null` for a completion it actually handled.
const DIAGNOSTICS_PREFIX = 'work.diagnostics.';
const TARGET_KEY = 'browser.target';
const ASSISTANT_KEY = 'assistant.session';
const ASSISTANT_VERSION = 1;
const MAX_ANSWER_CHARS = 512 * 1024;
const MAX_PRESENTATION_CHARS = 128 * 1024;
const MAX_ASSISTANT_HISTORY = 20;
const MAX_TOOL_EVENTS = 32;
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

function boundedPresentationText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_PRESENTATION_CHARS) : '';
}

function emptyAssistantPresentation() {
  return {
    history: [],
    reasoning: '',
    answer: '',
    blocks: [],
    generating: false,
    completed: false,
    toolCount: 0,
    tools: [],
    notice: '',
  };
}

// Blocks are only ever a richer view of `answer`; without an answer there is nothing to show.
function historyEntry(item) {
  if (item?.role !== 'assistant') return item;
  return { ...item, blocks: normalizeBlocks(item.blocks) };
}

function normalizeAssistantSession(value) {
  if (!value || value.version !== ASSISTANT_VERSION) return null;
  if (!Number.isInteger(value.workTabId) || !Number.isInteger(value.workWindowId)) return null;
  if (value.providerTabId !== null && !Number.isInteger(value.providerTabId)) return null;
  if (value.providerWindowId !== null && !Number.isInteger(value.providerWindowId)) return null;
  if (!['preparing', 'active', 'paused'].includes(value.state)) return null;

  const presentation = value.presentation && typeof value.presentation === 'object'
    ? value.presentation
    : emptyAssistantPresentation();

  return {
    version: ASSISTANT_VERSION,
    workTabId: value.workTabId,
    workWindowId: value.workWindowId,
    providerTabId: value.providerTabId,
    providerWindowId: value.providerWindowId,
    state: value.state,
    pauseCode: typeof value.pauseCode === 'string' ? value.pauseCode.slice(0, 64) : null,
    presentation: {
      history: Array.isArray(presentation.history)
        ? presentation.history.slice(-MAX_ASSISTANT_HISTORY).map(historyEntry)
        : [],
      reasoning: boundedPresentationText(presentation.reasoning),
      answer: boundedPresentationText(presentation.answer),
      blocks: normalizeBlocks(presentation.blocks),
      generating: presentation.generating === true,
      completed: presentation.completed === true,
      toolCount: Number.isInteger(presentation.toolCount) && presentation.toolCount >= 0
        ? presentation.toolCount
        : 0,
      tools: Array.isArray(presentation.tools)
        ? presentation.tools.slice(-MAX_TOOL_EVENTS)
        : [],
      notice: boundedPresentationText(presentation.notice).slice(0, 500),
    },
  };
}

async function storedAssistantSession() {
  const stored = (await chrome.storage.session.get(ASSISTANT_KEY))[ASSISTANT_KEY];
  return normalizeAssistantSession(stored);
}

// Every assistant.session read and write runs through this one queue. Provider snapshots,
// tool events, status polls and the Side Panel all update the same key; each mutation is
// applied to the latest stored session, never to a copy read earlier, so a slow update can
// no longer overwrite a newer one. Reads are queued too, so a permission check never
// sees a session that a queued Stop/close has already removed. Tasks must only touch
// storage: a task that waits on slow work would stall every other assistant update.
let assistantQueue = Promise.resolve();
function enqueueAssistant(task) {
  const run = assistantQueue.then(task);
  assistantQueue = run.catch(() => {});
  return run;
}

const assistantSession = () => enqueueAssistant(storedAssistantSession);

// `mutate(current)` returns the next session, or null to leave storage untouched. Resolves to
// the saved session, or null when nothing was applied (for example the session was stopped).
function mutateAssistantSession(mutate) {
  return enqueueAssistant(async () => {
    const next = mutate(await storedAssistantSession());
    return next === null ? null : saveAssistantSession(next);
  });
}

// Patches only the session `base` still identifies. A different work tab, or (unless the
// patch is what binds the provider) a different provider, means the session moved on and the
// stale patch is dropped instead of resurrecting or overwriting it.
function patchAssistantSession(base, patch, { bindsProvider = false } = {}) {
  return mutateAssistantSession((current) => {
    if (!current || current.workTabId !== base.workTabId) return null;
    if (!bindsProvider && current.providerTabId !== base.providerTabId) return null;
    return { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
  });
}

// Only the currently bound, active provider may change the presentation.
function patchActiveProviderPresentation(tabId, change) {
  return mutateAssistantSession((current) => {
    if (!current || current.providerTabId !== tabId || current.state !== 'active') return null;
    const presentation = change(current.presentation);
    return presentation === null ? null : { ...current, presentation };
  });
}

function clearAssistantSession(workTabId) {
  return enqueueAssistant(async () => {
    const current = await storedAssistantSession();
    if (!current || (workTabId !== undefined && current.workTabId !== workTabId)) return;
    await chrome.storage.session.remove(ASSISTANT_KEY);
  });
}

async function saveAssistantSession(session) {
  const normalized = normalizeAssistantSession(session);
  if (!normalized) throw new Error('Invalid assistant session.');
  await chrome.storage.session.set({ [ASSISTANT_KEY]: normalized });
  return normalized;
}

async function pauseAssistant(session, code, notice) {
  const message = String(notice ?? 'DeepSeek provider needs attention.').slice(0, 500);
  const paused = await patchAssistantSession(session, (current) => ({
    state: 'paused',
    pauseCode: code,
    presentation: { ...current.presentation, generating: false, notice: message },
  }));
  // A dropped pause means the session already ended or moved to another provider; report the
  // pause to the caller without writing anything back.
  return paused ?? {
    ...session,
    state: 'paused',
    pauseCode: code,
    presentation: { ...session.presentation, generating: false, notice: message },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function providerPageHealth(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'assistant.health' });
    if (reply?.ok !== true) return { ok: false, code: 'PROVIDER_NOT_READY' };
    return {
      ok: true,
      visibility: reply.visibility,
      hasFocus: reply.hasFocus === true,
      generating: reply.generating === true,
      path: typeof reply.path === 'string' ? reply.path.slice(0, 500) : '',
    };
  } catch {
    return { ok: false, code: 'PROVIDER_NOT_READY' };
  }
}

async function providerHealth(session) {
  if (!Number.isInteger(session?.providerTabId) || !Number.isInteger(session?.providerWindowId)) {
    return { ok: false, code: 'PROVIDER_MISSING', message: 'DeepSeek provider is not ready.' };
  }

  let windowInfo;
  let tab;
  try {
    [windowInfo, tab] = await Promise.all([
      chrome.windows.get(session.providerWindowId),
      chrome.tabs.get(session.providerTabId),
    ]);
  } catch {
    return { ok: false, code: 'PROVIDER_CLOSED', message: 'DeepSeek provider was closed.' };
  }

  if (tab.windowId !== session.providerWindowId || !conversationKey(tab.url)) {
    return { ok: false, code: 'PROVIDER_CHANGED', message: 'DeepSeek provider changed unexpectedly.' };
  }
  if (windowInfo.state === 'minimized') {
    return { ok: false, code: 'PROVIDER_MINIMIZED', message: 'DeepSeek provider is minimized.' };
  }
  if (tab.active !== true) {
    return { ok: false, code: 'PROVIDER_TAB_INACTIVE', message: 'DeepSeek must remain the selected tab in its provider window.' };
  }

  const page = await providerPageHealth(session.providerTabId);
  if (!page.ok) return { ok: false, code: page.code, message: 'DeepSeek provider is still loading or unavailable.' };
  if (page.visibility !== 'visible') {
    return { ok: false, code: 'PROVIDER_HIDDEN', message: 'DeepSeek provider is not rendering while hidden.' };
  }
  return { ok: true, page };
}

async function waitForProvider(tabId, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const health = await providerPageHealth(tabId);
    if (health.ok) return health;
    await delay(250);
  }
  return { ok: false, code: 'PROVIDER_NOT_READY' };
}

// Live 2026-09-20: a window created or restored without focus can report
// document.visibilityState === 'hidden' until it has been activated once. Content-script
// readiness is therefore not proof that the provider renders; this waits for visibility itself.
async function waitForProviderVisible(tabId, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    const health = await providerPageHealth(tabId);
    if (health.ok && health.visibility === 'visible') return health;
    await delay(250);
  }
  return { ok: false, code: 'PROVIDER_HIDDEN' };
}

// Gives a hidden provider one temporary focus so it starts rendering, then hands focus back.
// A provider that still is not visible is left for providerHealth() to fail closed.
async function bootstrapProviderVisibility(providerWindowId, providerTabId, workWindowId) {
  const current = await providerPageHealth(providerTabId);
  if (current.ok && current.visibility === 'visible') return;
  await chrome.windows.update(providerWindowId, { focused: true }).catch(() => {});
  await waitForProviderVisible(providerTabId);
  await chrome.windows.update(workWindowId, { focused: true }).catch(() => {});
}

async function createProviderWindow(workWindowId) {
  const created = await chrome.windows.create({
    url: ORIGIN,
    focused: true,
    type: 'normal',
  });
  if (!Number.isInteger(created?.id)) throw new Error('DeepSeek provider window was not created.');

  let providerTab = Array.isArray(created.tabs) ? created.tabs.find((tab) => tab.active) : null;
  if (!Number.isInteger(providerTab?.id)) {
    const tabs = await chrome.tabs.query({ windowId: created.id, active: true });
    providerTab = tabs[0] ?? null;
  }
  if (!Number.isInteger(providerTab?.id)) throw new Error('DeepSeek provider tab was not created.');

  const ready = await waitForProvider(providerTab.id);
  if (!ready.ok) {
    await chrome.windows.update(workWindowId, { focused: true }).catch(() => {});
    throw Object.assign(new Error('DeepSeek provider did not become ready.'), { code: ready.code });
  }
  await waitForProviderVisible(providerTab.id);
  await chrome.windows.update(workWindowId, { focused: true }).catch(() => {});

  return { providerWindowId: created.id, providerTabId: providerTab.id };
}

async function normalizeProviderWindow(session, { createIfMissing = false } = {}) {
  let providerWindowId = session.providerWindowId;
  let providerTabId = session.providerTabId;

  let existing = null;
  if (Number.isInteger(providerWindowId) && Number.isInteger(providerTabId)) {
    try {
      const [windowInfo, tab] = await Promise.all([
        chrome.windows.get(providerWindowId),
        chrome.tabs.get(providerTabId),
      ]);
      if (tab.windowId === providerWindowId && conversationKey(tab.url)) existing = { windowInfo, tab };
    } catch {}
  }

  if (!existing) {
    if (!createIfMissing) throw Object.assign(new Error('DeepSeek provider is unavailable.'), { code: 'PROVIDER_CLOSED' });
    const created = await createProviderWindow(session.workWindowId);
    providerWindowId = created.providerWindowId;
    providerTabId = created.providerTabId;
  } else {
    if (existing.windowInfo.state === 'minimized') {
      await chrome.windows.update(providerWindowId, { state: 'normal', focused: false });
    }
    if (existing.tab.active !== true) await chrome.tabs.update(providerTabId, { active: true });
    const ready = await waitForProvider(providerTabId);
    if (!ready.ok) throw Object.assign(new Error('DeepSeek provider did not become ready.'), { code: ready.code });
    await bootstrapProviderVisibility(providerWindowId, providerTabId, session.workWindowId);
    await chrome.windows.update(session.workWindowId, { focused: true }).catch(() => {});
  }

  return { providerWindowId, providerTabId };
}

function requireApplied(session) {
  if (!session) throw Object.assign(new Error('The assistant session ended.'), { code: 'ASSISTANT_ENDED' });
  return session;
}

const withNotice = (notice) => (current) => ({ presentation: { ...current.presentation, notice } });

async function openAssistantSession() {
  const attached = await attachActiveTarget();
  if (!attached.ok) return attached;

  const workTab = await chrome.tabs.get(attached.target.tabId);
  if (!Number.isInteger(workTab.windowId)) {
    return { ok: false, error: { code: 'WORK_WINDOW_UNAVAILABLE', message: 'The work window is unavailable.' } };
  }

  // Opening is an explicit user action, so it replaces whatever session exists.
  let session = await enqueueAssistant(async () => {
    const previous = await storedAssistantSession();
    const presentation = previous?.workTabId === workTab.id
      ? previous.presentation
      : emptyAssistantPresentation();
    return saveAssistantSession({
      version: ASSISTANT_VERSION,
      workTabId: workTab.id,
      workWindowId: workTab.windowId,
      providerTabId: previous?.providerTabId ?? null,
      providerWindowId: previous?.providerWindowId ?? null,
      state: 'preparing',
      pauseCode: null,
      presentation: { ...presentation, notice: 'Preparing DeepSeek provider…' },
    });
  });

  try {
    const provider = await normalizeProviderWindow(session, { createIfMissing: true });
    session = requireApplied(await patchAssistantSession(session, (current) => ({
      ...provider,
      state: 'preparing',
      pauseCode: null,
      ...withNotice('')(current),
    }), { bindsProvider: true }));
    const work = await workOn(provider.providerTabId);
    if (!work.ok) throw Object.assign(new Error('DeepSeek provider is not on a supported page.'), { code: work.code });

    const health = await providerHealth(session);
    if (!health.ok) {
      session = await pauseAssistant(session, health.code, health.message);
      return { ok: false, session, error: { code: health.code, message: health.message } };
    }

    session = requireApplied(await patchAssistantSession(session, { state: 'active', pauseCode: null }));
    return { ok: true, session };
  } catch (error) {
    session = await pauseAssistant(session, error?.code ?? 'PROVIDER_START_FAILED', error?.message ?? 'DeepSeek provider could not start.');
    return { ok: false, session, error: { code: session.pauseCode, message: session.presentation.notice } };
  }
}

async function restoreAssistantSession() {
  let session = await assistantSession();
  if (!session) return { ok: false, error: { code: 'NO_ASSISTANT_SESSION', message: 'No assistant session is active.' } };

  try {
    session = requireApplied(await patchAssistantSession(session, (current) => ({
      state: 'preparing',
      pauseCode: null,
      ...withNotice('Restoring DeepSeek provider…')(current),
    })));
    const provider = await normalizeProviderWindow(session, { createIfMissing: true });
    session = requireApplied(await patchAssistantSession(session, (current) => ({
      ...provider,
      state: 'preparing',
      ...withNotice('')(current),
    }), { bindsProvider: true }));
    await workOn(provider.providerTabId);
    const health = await providerHealth(session);
    if (!health.ok) {
      session = await pauseAssistant(session, health.code, health.message);
      return { ok: false, session, error: { code: health.code, message: health.message } };
    }
    session = requireApplied(await patchAssistantSession(session, { state: 'active', pauseCode: null }));
    return { ok: true, session };
  } catch (error) {
    session = await pauseAssistant(session, error?.code ?? 'PROVIDER_RESTORE_FAILED', error?.message ?? 'DeepSeek provider could not be restored.');
    return { ok: false, session, error: { code: session.pauseCode, message: session.presentation.notice } };
  }
}

async function stopAssistantSession() {
  const session = await assistantSession();
  if (!session) return { ok: true, session: null };

  if (Number.isInteger(session.providerTabId)) await workOff(session.providerTabId).catch(() => {});
  const target = await targetForBrowserTools();
  if (target?.tabId === session.workTabId) await chrome.storage.session.remove(TARGET_KEY);
  await clearAssistantSession(session.workTabId);
  return { ok: true, session: null };
}

async function assistantStatus({ refreshHealth = true } = {}) {
  let session = await assistantSession();
  if (!session) return { ok: true, session: null, health: null };

  let health = null;
  if (refreshHealth && session.state === 'active') {
    health = await providerHealth(session);
    if (!health.ok) session = await pauseAssistant(session, health.code, health.message);
  } else if (refreshHealth && Number.isInteger(session.providerTabId)) {
    health = await providerHealth(session);
  }

  return { ok: true, session, health };
}

function archiveCompletedAssistantTurn(presentation) {
  if (!presentation.completed || (!presentation.answer && !presentation.reasoning && presentation.toolCount === 0)) {
    return presentation.history;
  }
  const history = [...presentation.history, {
    role: 'assistant',
    reasoning: boundedPresentationText(presentation.reasoning),
    answer: boundedPresentationText(presentation.answer),
    blocks: presentation.blocks,
    toolCount: presentation.toolCount,
    tools: presentation.tools.slice(-MAX_TOOL_EVENTS),
  }];
  return history.slice(-MAX_ASSISTANT_HISTORY);
}

// A prompt is shown in history only while it may still be in flight or was accepted. If
// DeepSeek did not accept it, the bubble is withdrawn again -- unless the provider already
// shows a reply, which proves it was accepted after all.
function withdrawUnacceptedPrompt(session, prompt, notice) {
  const text = boundedPresentationText(prompt);
  return patchAssistantSession(session, (current) => {
    const { presentation } = current;
    const last = presentation.history.at(-1);
    const answered = presentation.generating || presentation.reasoning !== '' || presentation.answer !== '';
    const history = !answered && last?.role === 'user' && last.text === text
      ? presentation.history.slice(0, -1)
      : presentation.history;
    return { presentation: { ...presentation, history, notice: String(notice).slice(0, 500) } };
  });
}

async function sendAssistantPrompt(text) {
  const prompt = typeof text === 'string' ? text.trim() : '';
  if (!prompt || prompt.length > 16384) {
    return { ok: false, error: { code: 'INVALID_PROMPT', message: 'Enter a prompt up to 16,384 characters.' } };
  }

  let session = await assistantSession();
  if (!session || session.state !== 'active') {
    return { ok: false, error: { code: 'ASSISTANT_NOT_ACTIVE', message: 'Restore or open the assistant first.' } };
  }

  const health = await providerHealth(session);
  if (!health.ok) {
    session = await pauseAssistant(session, health.code, health.message);
    return { ok: false, session, error: { code: health.code, message: health.message } };
  }

  let firstPrompt = false;
  session = await patchAssistantSession(session, (current) => {
    firstPrompt = !current.presentation.history.some((item) => item?.role === 'user');
    const history = archiveCompletedAssistantTurn(current.presentation);
    history.push({ role: 'user', text: boundedPresentationText(prompt) });
    return {
      presentation: {
        ...emptyAssistantPresentation(),
        history: history.slice(-MAX_ASSISTANT_HISTORY),
        notice: 'Sending…',
      },
    };
  });
  if (!session) return { ok: false, error: { code: 'ASSISTANT_NOT_ACTIVE', message: 'Restore or open the assistant first.' } };

  try {
    const result = await chrome.tabs.sendMessage(session.providerTabId, { type: 'assistant.prompt', text: prompt, withInstructions: firstPrompt });
    if (result?.ok !== true) {
      const message = result?.message ?? 'DeepSeek did not accept the prompt.';
      session = (await withdrawUnacceptedPrompt(session, prompt, message)) ?? session;
      return { ok: false, session, error: { code: result?.code ?? 'PROMPT_SEND_FAILED', message } };
    }
    session = (await patchAssistantSession(session, withNotice(''))) ?? session;
    return { ok: true, session };
  } catch {
    await withdrawUnacceptedPrompt(session, prompt, 'DeepSeek provider is unavailable.');
    session = await pauseAssistant(session, 'PROVIDER_NOT_READY', 'DeepSeek provider is unavailable.');
    return { ok: false, session, error: { code: 'PROVIDER_NOT_READY', message: session.presentation.notice } };
  }
}

const ASSISTANT_ACTIONS = new Set(['regenerate', 'share']);
const MAX_DIAGNOSTIC_CHARS = 20000;

// The provider page's failure detail is shown in the panel as text and copied by the owner. It is
// passed through only if it is a plain object of bounded size; nothing is stored.
function boundedDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.stringify(value).length <= MAX_DIAGNOSTIC_CHARS ? value : null;
  } catch {
    return null;
  }
}

// Regenerate and Share press DeepSeek's own controls in the bound provider page; nothing is
// re-implemented here. A missing control is reported to the panel instead of failing silently.
async function runAssistantAction(action) {
  if (!ASSISTANT_ACTIONS.has(action)) {
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'Unknown assistant action.' } };
  }
  let session = await assistantSession();
  if (!session || session.state !== 'active') {
    return { ok: false, error: { code: 'ASSISTANT_NOT_ACTIVE', message: 'Restore or open the assistant first.' } };
  }
  if (session.presentation.generating) {
    return { ok: false, error: { code: 'GENERATION_IN_PROGRESS', message: 'DeepSeek is still generating.' } };
  }

  const health = await providerHealth(session);
  if (!health.ok) {
    session = await pauseAssistant(session, health.code, health.message);
    return { ok: false, session, error: { code: health.code, message: health.message } };
  }

  let result;
  try {
    result = await chrome.tabs.sendMessage(session.providerTabId, { type: 'assistant.action', action });
  } catch {
    session = await pauseAssistant(session, 'PROVIDER_NOT_READY', 'DeepSeek provider is unavailable.');
    return { ok: false, session, error: { code: 'PROVIDER_NOT_READY', message: session.presentation.notice } };
  }
  if (result?.ok !== true) {
    const message = String(result?.message ?? 'DeepSeek control could not be used.').slice(0, 500);
    session = (await patchAssistantSession(session, withNotice(message))) ?? session;
    const diagnostics = boundedDiagnostics(result?.diagnostics);
    return {
      ok: false,
      session,
      error: { code: result?.code ?? 'ACTION_FAILED', message },
      ...(diagnostics ? { diagnostics } : {}),
    };
  }

  if (action === 'share') {
    // DeepSeek's share flow may ask for a choice or create a link; the owner finishes it there.
    await chrome.windows.update(session.providerWindowId, { focused: true }).catch(() => {});
    session = (await patchAssistantSession(session, withNotice('Finish sharing in the DeepSeek window.'))) ?? session;
    return { ok: true, session };
  }

  // The regenerated reply replaces the current one, as it does on DeepSeek itself.
  session = (await patchAssistantSession(session, (current) => ({
    presentation: {
      ...current.presentation,
      reasoning: '',
      answer: '',
      blocks: [],
      generating: true,
      completed: false,
      notice: '',
    },
  }))) ?? session;
  return { ok: true, session };
}

async function recordAssistantSnapshot(tabId, snapshot) {
  const rawAnswer = boundedPresentationText(snapshot?.answer);
  const answer = /webmcp_tool_call|｜\s*DSML\s*｜/i.test(rawAnswer) ? '' : rawAnswer;
  const reasoning = boundedPresentationText(snapshot?.reasoning);
  const generating = snapshot?.generating === true;
  // An answer that was filtered out (tool-call text) must never survive as structured blocks.
  const blocks = answer === '' ? [] : normalizeBlocks(snapshot?.blocks);
  await patchActiveProviderPresentation(tabId, (presentation) => {
    // Re-reporting a finished turn unchanged (for example after a route change) must not
    // turn it back into an unfinished one.
    const unchanged = !generating && answer === presentation.answer && reasoning === presentation.reasoning;
    return {
      ...presentation,
      reasoning,
      answer,
      blocks,
      generating,
      completed: unchanged ? presentation.completed : false,
      notice: '',
    };
  });
}

async function recordAssistantTool(tabId, call, status, code = null) {
  const event = {
    id: String(call.id).slice(0, 128),
    name: String(call.name).slice(0, 64),
    status,
    code: typeof code === 'string' ? code.slice(0, 64) : null,
  };
  await patchActiveProviderPresentation(tabId, (presentation) => {
    const tools = [...presentation.tools];
    const existing = tools.findIndex((item) => item.id === event.id);
    if (existing >= 0) tools[existing] = event;
    else tools.push(event);
    return {
      ...presentation,
      answer: '',
      blocks: [],
      toolCount: existing >= 0 ? presentation.toolCount : presentation.toolCount + 1,
      tools: tools.slice(-MAX_TOOL_EVENTS),
      notice: status === 'error' && code ? code : '',
    };
  });
}

async function recordAssistantFinal(tabId, text) {
  await patchActiveProviderPresentation(tabId, (presentation) => {
    const answer = boundedPresentationText(text);
    return {
      ...presentation,
      answer,
      // Blocks came from a snapshot of the same DOM; if the text moved on they are stale.
      blocks: answer === presentation.answer ? presentation.blocks : [],
      generating: false,
      completed: true,
      notice: '',
    };
  });
}

async function assistantProviderGate(tabId) {
  const session = await assistantSession();
  if (!session) return { allowed: true, session: null };
  if (session.providerTabId !== tabId) return { allowed: false, session, code: 'NOT_BOUND_PROVIDER' };
  if (session.state !== 'active') return { allowed: false, session, code: 'ASSISTANT_PAUSED' };
  return { allowed: true, session };
}

async function targetForBrowserTools() {
  const stored = (await chrome.storage.session.get(TARGET_KEY))[TARGET_KEY];
  if (!stored || !Number.isInteger(stored.tabId) || typeof stored.origin !== 'string') return null;
  return stored;
}

async function clearTargetForTab(tabId) {
  const target = await targetForBrowserTools();
  if (target?.tabId === tabId) await chrome.storage.session.remove(TARGET_KEY);
}

async function targetStatus() {
  return { ok: true, target: await targetForBrowserTools() };
}

async function attachActiveTarget() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!Number.isInteger(tab?.id) || typeof tab.url !== 'string') {
    return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'No attachable active browser tab.' } };
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'The active tab URL is not attachable.' } };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === ORIGIN) {
    return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'Attach a normal http(s) webpage, not the DeepSeek planner tab.' } };
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['target-executor.js'] });
    const ping = await chrome.tabs.sendMessage(tab.id, { type: 'webmcp.browser.ping' });
    if (ping?.ok !== true || ping?.result?.ready !== true) throw new Error('Target executor did not answer.');
  } catch {
    return { ok: false, error: { code: 'TARGET_ATTACH_FAILED', message: 'This page cannot be attached. Reload it if needed, then click the extension on that page again.' } };
  }

  const target = {
    tabId: tab.id,
    origin: url.origin,
    title: String(tab.title ?? url.hostname).replace(/\s+/g, ' ').trim().slice(0, 200),
  };
  await chrome.storage.session.set({ [TARGET_KEY]: target });
  return { ok: true, target };
}

async function detachTarget() {
  await chrome.storage.session.remove(TARGET_KEY);
  return { ok: true, target: null };
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

  const gate = await assistantProviderGate(tabId);
  if (!gate.allowed) {
    await setDiagnostics(tabId, { answerLength: text.length, lastCode: gate.code });
    return {};
  }

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
  if (!decision.accepted || decision.code !== 'TOOL_CALLS') {
    if (decision.accepted && decision.code === 'NO_TOOL_CALL') await recordAssistantFinal(tabId, text);
    return {};
  }

  if (decision.calls.length !== 1) {
    await setDiagnostics(tabId, { ...diagnostics, lastCode: 'MULTIPLE_CALLS' });
    return {};
  }
  const [call] = decision.calls;
  const browserTool = isBrowserToolAllowed(call.name);
  if (!browserTool && !isToolAllowed(call.name)) {
    await setDiagnostics(tabId, { ...diagnostics, lastCode: 'TOOL_NOT_ALLOWED' });
    return {};
  }

  await recordAssistantTool(tabId, call, 'running');

  let toolResponse;
  if (browserTool) {
    const target = await targetForBrowserTools();
    if (gate.session && target?.tabId !== gate.session.workTabId) {
      toolResponse = { version: 1, id: call.id, ok: false, error: { code: 'SESSION_TARGET_MISMATCH', message: 'The bound work page is no longer attached.' } };
    } else if (!target) {
      toolResponse = { version: 1, id: call.id, ok: false, error: { code: 'TARGET_NOT_ATTACHED', message: 'No browser target is attached. Open the target page and attach it from the DeepSeek WebMCP popup.' } };
    } else {
      try {
        toolResponse = await callBrowserTool(target.tabId, call);
      } catch (error) {
        if (error instanceof BrowserClientError && error.code === 'TARGET_NOT_ATTACHED') await clearTargetForTab(target.tabId);
        toolResponse = { version: 1, id: call.id, ok: false, error: { code: error?.code ?? 'BROWSER_CALL_FAILED', message: error?.message ?? 'The attached browser target is unavailable.' } };
      }
    }
  } else {
    try {
      toolResponse = await callNativeTool(call);
    } catch (error) {
      toolResponse = { version: 1, id: call.id, ok: false, error: { code: error?.code ?? 'NATIVE_CALL_FAILED', message: 'The local WebMCP runtime is not reachable. Run npm run doctor on the Mac.' } };
    }
  }

  await recordAssistantTool(
    tabId,
    call,
    toolResponse.ok ? 'ok' : 'error',
    toolResponse.ok ? null : (toolResponse.error?.code ?? 'TOOL_ERROR'),
  );

  // Work may have been switched off while the tool ran.
  const current = await controllerFor(tabId);
  if (!current) return {};
  current.setPending(key, buildNativeToolResult(call, toolResponse));
  await persist(tabId, current);
  await setDiagnostics(tabId, { ...diagnostics, lastCode: toolResponse.ok ? 'TOOL_RESULT' : 'TOOL_ERROR' });
  return deliveryFor(current, key);
}

async function arrive(tabId, key) {
  const controller = await controllerFor(tabId);
  await setBadge(tabId, Boolean(controller));
  if (!controller) return { work: false };
  // Without this the contract only says tools act on a tab "I explicitly attached", and the
  // model answers that nothing is attached even though the owner already attached one.
  const pageAttached = (await targetForBrowserTools()) !== null;
  return { work: true, instructions: buildWorkInstructions({ pageAttached }), ...deliveryFor(controller, key) };
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
    // All browsers share one local program. After Uninstall in one browser, the others
    // get Chromium's "Specified native messaging host not found."
    // The popup then removes only this extension itself (that needs its click gesture).
    if (/native messaging host not found/i.test(error?.message ?? '')) {
      return { ok: false, error: { code: 'LOCAL_PROGRAM_MISSING', message: 'The local program was removed (all browsers share it). Uninstall… removes this extension too. To use DeepSeek WebMCP again, copy the install command and paste it into Terminal.' } };
    }
    // The browser's own reason is a fixed browser string and the only clue when one
    // Chromium browser differs from another.
    const reason = typeof error?.message === 'string' ? ` (${error.message.slice(0, 200)})` : '';
    return { ok: false, error: { code: error?.code ?? 'NATIVE_CALL_FAILED', message: `Local runtime not reachable${reason}. Run the install command again.` } };
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

function isSidePanel(sender) {
  return !sender.tab && sender.url === chrome.runtime.getURL('sidepanel.html');
}

function handleMessage(message, sender) {
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
      await patchActiveProviderPresentation(context.tabId, (presentation) => ({
        ...presentation,
        generating: true,
        completed: false,
        notice: '',
      }));
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
  if (message.type === 'assistant.snapshot') {
    const context = senderContext(sender);
    if (!context) return undefined;
    return recordAssistantSnapshot(context.tabId, message).then(() => ({ ok: true }));
  }

  const popup = isPopup(sender);
  const sidePanel = isSidePanel(sender);
  if (!popup && !sidePanel) return undefined;

  if (message.type === 'assistant.status') return assistantStatus();
  if (popup && message.type === 'assistant.open') return openAssistantSession();
  if (sidePanel && message.type === 'assistant.restore') return restoreAssistantSession();
  if (sidePanel && message.type === 'assistant.stop') return stopAssistantSession();
  if (sidePanel && message.type === 'assistant.prompt') return sendAssistantPrompt(message.text);
  if (sidePanel && message.type === 'assistant.action') return runAssistantAction(message.action);

  if (!popup) return undefined;
  if (message.type === 'settings.control' && typeof message.control === 'string') return runControl(message.control, message.arguments);
  if (message.type === 'browser.target-status') return targetStatus();
  if (message.type === 'browser.target-attach') return attachActiveTarget();
  if (message.type === 'browser.target-detach') return detachTarget();
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
}

// Replies go through sendResponse + `return true`. Returning a Promise from the listener
// is only supported from Chrome 148, rolled out gradually (developer.chrome.com messaging
// guide); on Comet (Chromium 141) every Promise reply arrived as undefined.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const reply = handleMessage(message, sender);
  if (reply === undefined) return false;
  Promise.resolve(reply).then(sendResponse, () => sendResponse(undefined));
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-work' && Number.isInteger(tab?.id)) void toggleWork(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  controllers.delete(tabId);
  void chrome.storage.session.remove([authorityKey(tabId), diagnosticsKey(tabId)]);
  void clearTargetForTab(tabId);
  void assistantSession().then(async (session) => {
    if (!session) return;
    if (session.workTabId === tabId) {
      if (Number.isInteger(session.providerTabId)) await workOff(session.providerTabId).catch(() => {});
      await clearAssistantSession(session.workTabId);
      return;
    }
    if (session.providerTabId === tabId) {
      await pauseAssistant(session, 'PROVIDER_CLOSED', 'DeepSeek provider was closed. Use Restore to continue.');
    }
  });
});

// Moving within DeepSeek keeps Work (results wait for their conversation); leaving
// DeepSeek switches it off.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (typeof changeInfo.url === 'string' && conversationKey(changeInfo.url) === null) void workOff(tabId);

  void targetForBrowserTools().then(async (target) => {
    if (target?.tabId !== tabId) return;

    if (typeof changeInfo.url === 'string') {
      let next;
      try {
        next = new URL(changeInfo.url);
      } catch {
        await clearTargetForTab(tabId);
        return;
      }
      if (!['http:', 'https:'].includes(next.protocol) || next.origin !== target.origin) {
        await clearTargetForTab(tabId);
        return;
      }
    }

    if (changeInfo.status !== 'complete') return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['target-executor.js'] });
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'webmcp.browser.ping' });
      if (ping?.ok !== true || ping?.result?.ready !== true) throw new Error('Target executor did not answer.');
      const url = new URL(tab.url);
      await chrome.storage.session.set({
        [TARGET_KEY]: {
          tabId,
          origin: url.origin,
          title: String(tab.title ?? url.hostname).replace(/\s+/g, ' ').trim().slice(0, 200),
        },
      });
    } catch {
      await clearTargetForTab(tabId);
    }
  });
});
