import { WorkController, buildFormatCorrection, buildNativeToolResult, buildPageReleasedNote, buildWorkInstructions } from './core/agent-controller.js';
import { BrowserClientError, callBrowserTool, isBrowserToolAllowed } from './browser-client.js';
import { normalizeBlocks } from './answer-blocks.js';
import { createBrowserTask } from './browser-task.js';
import { callNativeControl, callNativeTool, isToolAllowed } from './native-client.js';
import { PANEL_ID, disableFramePolicy, enableFramePolicy, panelFrameHref } from './frame-policy.js';

// Web Provider Mode: each provider is an AI web page driven by its own content script.
// The tool loop, local runtime and approvals below are shared by all of them.
const PROVIDERS = {
  deepseek: { origin: 'https://chat.deepseek.com', conversationPath: /^\/a\/chat\/s\/[A-Za-z0-9-]+$/ },
  chatgpt: { origin: 'https://chatgpt.com', conversationPath: /^\/u?c\/[A-Za-z0-9-]+$/ },
};
const PROVIDER_SETTING_KEY = 'provider.id';
const providerForOrigin = (origin) => Object.values(PROVIDERS).find((provider) => provider.origin === origin) ?? null;

async function selectedProvider() {
  const id = (await chrome.storage.local.get(PROVIDER_SETTING_KEY))[PROVIDER_SETTING_KEY];
  return PROVIDERS[id] ?? PROVIDERS.deepseek;
}
const AUTHORITY_PREFIX = 'work.authority.';
// Diagnostics live in session storage too: a reconstructed worker must not
// report `diagnostics: null` for a completion it actually handled.
const DIAGNOSTICS_PREFIX = 'work.diagnostics.';
const ASSISTANT_KEY = 'assistant.session';
const ASSISTANT_VERSION = 1;
const FOLDER_NAME_KEY = 'workspace.folderName';
const MAX_ANSWER_CHARS = 512 * 1024;
const MAX_PRESENTATION_CHARS = 128 * 1024;
const MAX_ASSISTANT_HISTORY = 20;
const MAX_MODE_TOGGLES = 6;
const MAX_TOOL_EVENTS = 32;
const controllers = new Map();

// The page in front of the owner: the active tab of the window whose Side Panel is open.
async function activeWorkTab() {
  const session = await assistantSession();
  const query = Number.isInteger(session?.workWindowId)
    ? { active: true, windowId: session.workWindowId }
    : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(query);
  return tab ?? null;
}

const browserTask = createBrowserTask({ activeTab: activeWorkTab });
const { readTask, releaseTask, targetStatus, runBrowserTool, considerChildHandoff, handleTargetTabUpdate, handleTaskTabRemoved } = browserTask;

function conversationKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!providerForOrigin(url.origin)) return null;
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
  if (tabId === PANEL_ID) return;
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a7f37' });
  } catch {}
}

async function notifyTab(tabId) {
  try {
    // The panel page relays this into its ChatGPT frame, which content scripts cannot be sent to.
    if (tabId === PANEL_ID) await chrome.runtime.sendMessage({ type: 'panel.work-changed' });
    else await chrome.tabs.sendMessage(tabId, { type: 'work.changed' });
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
  if (!Number.isInteger(value.workWindowId)) return null;
  if (value.providerTabId !== null && !Number.isInteger(value.providerTabId)) return null;
  if (value.providerWindowId !== null && !Number.isInteger(value.providerWindowId)) return null;
  if (!['preparing', 'active', 'paused'].includes(value.state)) return null;

  const presentation = value.presentation && typeof value.presentation === 'object'
    ? value.presentation
    : emptyAssistantPresentation();

  return {
    version: ASSISTANT_VERSION,
    workWindowId: value.workWindowId,
    providerTabId: value.providerTabId,
    providerWindowId: value.providerWindowId,
    state: value.state,
    pageReleased: value.pageReleased === true,
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
      model: normalizeProviderModel(presentation.model),
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
    if (!current || current.workWindowId !== base.workWindowId) return null;
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

function clearAssistantSession(workWindowId) {
  return enqueueAssistant(async () => {
    const current = await storedAssistantSession();
    if (!current || (workWindowId !== undefined && current.workWindowId !== workWindowId)) return;
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

// Why a covered window turns hidden is platform behavior (macOS window occlusion, full-screen
// Spaces); recording both windows' state makes the next occurrence explainable.
const describeWindow = (info) => `${info.state ?? '?'}${info.focused ? ' focused' : ''} ${info.width ?? '?'}x${info.height ?? '?'}@${info.left ?? '?'},${info.top ?? '?'}`;

async function windowStateNote(session, providerInfo) {
  try {
    const work = await chrome.windows.get(session.workWindowId);
    return ` [work: ${describeWindow(work)}; DeepSeek: ${describeWindow(providerInfo)}]`;
  } catch {
    return '';
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
    return { ok: false, code: 'PROVIDER_HIDDEN', message: `The DeepSeek window is hidden (fully covered windows cannot render answers). Leave a strip of it visible, then press Restore.${await windowStateNote(session, windowInfo)}` };
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
    url: (await selectedProvider()).origin,
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
      const selected = await selectedProvider();
      if (tab.windowId === providerWindowId && conversationKey(tab.url) && new URL(tab.url).origin === selected.origin) existing = { windowInfo, tab };
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
    // After an extension reload or update the open provider tab keeps only a dead copy of the
    // content script and never answers. A finished page that stays silent is reloaded once so
    // the manifest injects a live copy; the window and conversation URL are kept.
    if (existing.tab.status !== 'loading' && !(await providerPageHealth(providerTabId)).ok) {
      await chrome.tabs.reload(providerTabId);
    }
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

// The provider window is remembered across sessions (and extension reloads), so opening the panel
// again reuses it instead of creating another DeepSeek window.
const PROVIDER_REF_KEY = 'assistant.provider';

async function rememberedProvider() {
  const stored = (await chrome.storage.local.get(PROVIDER_REF_KEY))[PROVIDER_REF_KEY];
  if (!Number.isInteger(stored?.providerWindowId) || !Number.isInteger(stored?.providerTabId)) return null;
  return { providerWindowId: stored.providerWindowId, providerTabId: stored.providerTabId };
}

const rememberProvider = (provider) => chrome.storage.local.set({ [PROVIDER_REF_KEY]: { providerWindowId: provider.providerWindowId, providerTabId: provider.providerTabId } });

// Called each time the Side Panel opens. Idempotent: a healthy session for this window is returned
// as it is; otherwise the remembered (or a new) provider window is prepared. No page is attached
// here; the first browser tool call locks the page that is active in this window.
async function ensureAssistantSession(windowId) {
  if (!Number.isInteger(windowId)) {
    return { ok: false, error: { code: 'WORK_WINDOW_UNAVAILABLE', message: 'The work window is unavailable.' } };
  }

  const existing = await assistantSession();
  if (existing?.workWindowId === windowId && existing.state === 'active') {
    const health = await providerHealth(existing);
    if (health.ok) return { ok: true, session: existing };
  }

  const remembered = existing?.workWindowId === windowId && Number.isInteger(existing.providerTabId)
    ? { providerWindowId: existing.providerWindowId, providerTabId: existing.providerTabId }
    : await rememberedProvider();

  // Opening is an explicit user action, so it replaces whatever session exists.
  let session = await enqueueAssistant(async () => {
    const previous = await storedAssistantSession();
    const presentation = previous?.workWindowId === windowId ? previous.presentation : emptyAssistantPresentation();
    return saveAssistantSession({
      version: ASSISTANT_VERSION,
      workWindowId: windowId,
      providerTabId: remembered?.providerTabId ?? null,
      providerWindowId: remembered?.providerWindowId ?? null,
      state: 'preparing',
      pauseCode: null,
      presentation: { ...presentation, notice: 'Preparing DeepSeek provider…' },
    });
  });

  try {
    const provider = await normalizeProviderWindow(session, { createIfMissing: true });
    await rememberProvider(provider);
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

// Stop releases the page the task is locked to; the next browser tool call locks whichever page
// is active then. The provider and the conversation stay as they are.
async function stopAssistantTask() {
  await releaseTask();
  await markPageReleased();
  return { ok: true, task: idleTask() };
}

// The model learns of a release with the next prompt (see buildPageReleasedNote).
function markPageReleased() {
  return mutateAssistantSession((current) => (current ? { ...current, pageReleased: true } : null));
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
  let pageNote = '';
  session = await patchAssistantSession(session, (current) => {
    pageNote = current.pageReleased ? buildPageReleasedNote() : '';
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
    const result = await chrome.tabs.sendMessage(session.providerTabId, { type: 'assistant.prompt', text: prompt, withInstructions: firstPrompt, pageNote });
    if (result?.ok !== true) {
      const message = result?.message ?? 'DeepSeek did not accept the prompt.';
      session = (await withdrawUnacceptedPrompt(session, prompt, message)) ?? session;
      return { ok: false, session, error: { code: result?.code ?? 'PROMPT_SEND_FAILED', message } };
    }
    session = (await patchAssistantSession(session, (current) => ({ pageReleased: false, ...withNotice('')(current) }))) ?? session;
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
// Regenerate / Share and the mode switches press a DeepSeek control in the bound provider page: the
// assistant must be active and idle and its page healthy, and an unreachable page pauses it.
// `refuse(session)` rejects a request before the page is probed.
async function relayToProvider(message, { refuse = () => null, fallbackMessage, fallbackCode }) {
  let session = await assistantSession();
  if (!session || session.state !== 'active') {
    return { ok: false, error: { code: 'ASSISTANT_NOT_ACTIVE', message: 'Restore or open the assistant first.' } };
  }
  const refusal = refuse(session);
  if (refusal) return { ok: false, error: refusal };
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
    result = await chrome.tabs.sendMessage(session.providerTabId, message);
  } catch {
    session = await pauseAssistant(session, 'PROVIDER_NOT_READY', 'DeepSeek provider is unavailable.');
    return { ok: false, session, error: { code: 'PROVIDER_NOT_READY', message: session.presentation.notice } };
  }
  if (result?.ok !== true) {
    const notice = String(result?.message ?? fallbackMessage).slice(0, 500);
    session = (await patchAssistantSession(session, withNotice(notice))) ?? session;
    const diagnostics = boundedDiagnostics(result?.diagnostics);
    return {
      ok: false,
      session,
      error: { code: result?.code ?? fallbackCode, message: notice },
      ...(diagnostics ? { diagnostics } : {}),
    };
  }
  return { ok: true, session };
}

async function runAssistantAction(action) {
  if (!ASSISTANT_ACTIONS.has(action)) {
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'Unknown assistant action.' } };
  }
  const relayed = await relayToProvider({ type: 'assistant.action', action }, {
    fallbackMessage: 'DeepSeek control could not be used.',
    fallbackCode: 'ACTION_FAILED',
  });
  if (!relayed.ok) return relayed;
  let { session } = relayed;

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

// C6: the panel's mode switches press DeepSeek's own toggle in the bound provider page, like
// Regenerate does. Only a toggle that page reported is relayed; its next report shows the result.
function runModeToggle(label) {
  return relayToProvider({ type: 'deepseek.mode-toggle', label }, {
    // Only a toggle the provider page reported; checked before the page is probed.
    refuse: (session) => {
      const known = session.presentation.model?.toggles ?? [];
      if (typeof label === 'string' && known.some((toggle) => toggle.label === label)) return null;
      return { code: 'INVALID_MODE', message: 'Unknown DeepSeek mode.' };
    },
    fallbackMessage: 'DeepSeek mode could not be switched.',
    fallbackCode: 'MODE_TOGGLE_FAILED',
  });
}

// deepseek-model.js: the provider page's model and mode, shown in the panel's model line. Only the
// bound provider tab's report is kept (patchActiveProviderPresentation checks that).
// Also applied when the session is saved: without it the model never reached the panel.
function normalizeProviderModel(model) {
  const name = typeof model?.model === 'string' ? model.model.slice(0, 40) : '';
  if (!name) return null;
  const mode = typeof model.mode === 'string' ? model.mode.slice(0, 120) : null;
  const toggles = Array.isArray(model.toggles)
    ? model.toggles
      .filter((toggle) => typeof toggle?.label === 'string' && toggle.label && typeof toggle.on === 'boolean')
      .slice(0, MAX_MODE_TOGGLES)
      .map((toggle) => ({ label: toggle.label.slice(0, 40), on: toggle.on }))
    : [];
  return { model: name, mode, toggles };
}

async function recordProviderModel(tabId, model) {
  const normalized = normalizeProviderModel(model);
  if (!normalized) return;
  await patchActiveProviderPresentation(tabId, (presentation) => ({ ...presentation, model: normalized }));
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


async function statusFor(tabId) {
  const controller = await controllerFor(tabId);
  return controller?.status ?? Object.freeze({ work: false, calls: 0 });
}

async function workOn(tabId) {
  if (tabId !== PANEL_ID) {
    const tab = await chrome.tabs.get(tabId);
    if (!conversationKey(tab.url)) return { ok: false, code: 'NOT_DEEPSEEK' };
  }
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

const panelReply = (work) => work.then((result) => ({ ok: true, result }), (error) => ({ ok: false, error: error?.message ?? 'Extension action failed.' }));

// One provider at a time: the Side Panel opens on DeepSeek first, and its assistant session would
// otherwise refuse every ChatGPT tool call as NOT_BOUND_PROVIDER (live 2026-09-25). Switching back
// to DeepSeek starts a new session.
async function openPanelFrame() {
  const deepseek = await assistantSession();
  if (deepseek) {
    await clearAssistantSession();
    if (Number.isInteger(deepseek.providerTabId)) await workOff(deepseek.providerTabId);
  }
  await enableFramePolicy();
  await workOn(PANEL_ID);
  return { started: true };
}

// Closing the panel ends its ChatGPT session: the page is released, Work disarmed, the rule removed.
async function closePanelFrame() {
  await releaseTask();
  await workOff(PANEL_ID);
  await disableFramePolicy();
  return { stopped: true };
}

// Copied from the ChatGPT Embedded Panel (service-worker.js openCompanionWindow): the recovery
// screen's fallback opens ChatGPT in a small window; here it also gets Work, like the panel.
const LAST_URL_KEY = 'chatgptEmbeddedPanel.lastUrl';
const COMPANION_WINDOW_KEY = 'chatgptEmbeddedPanel.companionWindowId';

function sanitizeChatGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password) return 'https://chatgpt.com/';
    if (/^\/(api|backend-api|cdn)(\/|$)/.test(url.pathname)) return 'https://chatgpt.com/';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return 'https://chatgpt.com/';
  }
}

async function openCompanionWindow() {
  const stored = await chrome.storage.local.get([LAST_URL_KEY, COMPANION_WINDOW_KEY]);
  const existingId = stored[COMPANION_WINDOW_KEY];

  if (Number.isInteger(existingId)) {
    try {
      await chrome.windows.update(existingId, { focused: true });
      return { windowId: existingId, reused: true };
    } catch {
      await chrome.storage.local.remove(COMPANION_WINDOW_KEY);
    }
  }

  const created = await chrome.windows.create({
    url: sanitizeChatGptUrl(stored[LAST_URL_KEY]),
    type: 'popup',
    width: 520,
    height: 760,
    focused: true,
  });
  if (!Number.isInteger(created?.id)) throw new Error('ChatGPT companion window could not be created.');
  await chrome.storage.local.set({ [COMPANION_WINDOW_KEY]: created.id });
  const tabId = created.tabs?.[0]?.id;
  if (Number.isInteger(tabId)) await workOn(tabId).catch(() => {});
  return { windowId: created.id, reused: false };
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

// The model only ever sees "/workspace". Without the folder's real name it searches inside it for a
// folder of that name (live 2026-09-21: "MyCode" not found) instead of listing the folder itself.
async function withWorkspaceFolderName(response) {
  const name = (await chrome.storage.session.get(FOLDER_NAME_KEY))[FOLDER_NAME_KEY];
  if (typeof name !== 'string' || name === '' || typeof response.result !== 'object' || response.result === null) return response;
  return {
    ...response,
    result: {
      ...response.result,
      hostFolderName: name,
      note: `/workspace IS the owner's folder named "${name}" itself. It is not a folder inside it: list /workspace to see what "${name}" contains.`,
    },
  };
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
    toolResponse = await runBrowserTool(call);
  } else {
    try {
      toolResponse = await callNativeTool(call);
      if (call.name === 'open_workspace' && toolResponse.ok) toolResponse = await withWorkspaceFolderName(toolResponse);
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
  // The ChatGPT panel works on the current page of its window, like the ChatGPT Embedded Panel: the
  // first Browser WebMCP call locks it.
  const pageAttached = tabId === PANEL_ID || (await assistantSession()) !== null;
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
  const allowedArgs = control === 'grant-full-access' || control === 'grant-host-access'
    ? { minutes: Number(args?.minutes) }
    : {};
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
  if ((control === 'status' || control === 'choose-folder') && response.ok && typeof response.result?.folder === 'string') {
    // Remembered only so the model can be told what /workspace really is (see open_workspace below).
    const folderName = response.result.folder.split('/').filter(Boolean).pop() ?? '';
    await chrome.storage.session.set({ [FOLDER_NAME_KEY]: folderName.slice(0, 120) });
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
function senderContext(sender, message) {
  const panelHref = panelFrameHref(sender, message?.href);
  if (panelHref !== null) {
    const key = conversationKey(panelHref);
    return key === null ? null : { tabId: PANEL_ID, key };
  }
  if (!sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return null;
  const key = conversationKey(sender.tab.url);
  if (conversationKey(sender.url) === null || key === null) return null;
  return { tabId: sender.tab.id, key };
}

function isSidePanel(sender) {
  return !sender.tab && ['sidepanel.html', 'sidepanel-chatgpt.html'].some((page) => sender.url === chrome.runtime.getURL(page));
}

function handleMessage(message, sender) {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'work.completion' && typeof message.text === 'string') {
    const context = senderContext(sender, message);
    if (!context) return undefined;
    return processCompletion(context.tabId, context.key, message.text, message.resume === true);
  }
  if (message.type === 'work.generating') {
    const context = senderContext(sender, message);
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
    const context = senderContext(sender, message);
    if (!context) return undefined;
    return arrive(context.tabId, context.key);
  }
  if (message.type === 'work.continuation-result') {
    const context = senderContext(sender, message);
    const provider = context ? providerForOrigin(new URL(context.key).origin) : null;
    if (!provider || typeof message.conversationPath !== 'string' || !provider.conversationPath.test(message.conversationPath)) return undefined;
    // The user may already have switched chats; the result belongs to the path it was typed into.
    return recordContinuation(context.tabId, `${provider.origin}${message.conversationPath}`, message.result).then(() => ({ ok: true }));
  }
  if (message.type === 'model.status') {
    const context = senderContext(sender, message);
    if (!context) return undefined;
    return recordProviderModel(context.tabId, message.model).then(() => ({ ok: true }));
  }
  if (message.type === 'assistant.snapshot') {
    const context = senderContext(sender, message);
    if (!context) return undefined;
    return recordAssistantSnapshot(context.tabId, message).then(() => ({ ok: true }));
  }

  if (!isSidePanel(sender)) return undefined;

  if (message.type === 'assistant.status') return assistantStatus();
  if (message.type === 'assistant.ensure') return ensureAssistantSession(message.windowId);
  if (message.type === 'assistant.restore') return restoreAssistantSession();
  if (message.type === 'assistant.stop') return stopAssistantTask();
  if (message.type === 'assistant.prompt') return sendAssistantPrompt(message.text);
  if (message.type === 'assistant.action') return runAssistantAction(message.action);
  if (message.type === 'assistant.mode-toggle') return runModeToggle(message.label);
  if (message.type === 'assistant.page-status') return targetStatus();
  if (message.type === 'assistant.closed') return releaseTask().then(markPageReleased);
  // ChatGPT panel (sidepanel-chatgpt.js, the ChatGPT Embedded Panel's page): replies use its
  // { ok, result } shape. Work is on by default for the embedded ChatGPT and its companion window.
  if (message.type === 'panel.frame-open') return panelReply(openPanelFrame());
  if (message.type === 'panel.open-companion') return panelReply(openCompanionWindow());
  if (message.type === 'panel.closed') return panelReply(closePanelFrame());
  if (message.type === 'panel.target-status') return panelReply(targetStatus());
  if (message.type === 'panel.task-stop') return panelReply(stopAssistantTask());
  if (message.type === 'settings.control' && typeof message.control === 'string') return runControl(message.control, message.arguments);
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
  void handleTaskTabRemoved(tabId);
  void assistantSession().then(async (session) => {
    if (session?.providerTabId === tabId) {
      await pauseAssistant(session, 'PROVIDER_CLOSED', 'DeepSeek provider was closed. Use Restore to continue.');
    }
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  void considerChildHandoff(tab);
});

// Moving within DeepSeek keeps Work (results wait for their conversation); leaving
// DeepSeek switches it off. The same event drives the locked page through navigation and handoff.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (typeof changeInfo.url === 'string' && conversationKey(changeInfo.url) === null) void workOff(tabId);

  void (async () => {
    const childHandled = await considerChildHandoff(tab);
    const task = await readTask();
    if (childHandled && task.mode === 'locked' && task.target.tabId !== tabId) return;
    await handleTargetTabUpdate(tabId, changeInfo, tab);
  })();
});

// The panel opens on a click of the toolbar icon, like the ChatGPT panel; there is no popup.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
