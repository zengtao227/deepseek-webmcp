import { INITIAL_MODEL_STATUS, applyModelEvent, modelStatusLines } from './model-status.js';
import { mountProviderSelect, routeToProviderPage } from './panel-header.js';

// ChatGPT in Web Provider Mode: the ChatGPT Embedded Panel's page. Changes from the original are
// listed in docs/web-provider-dev-plan.html (message names, Provider selector, Work relay).
const provider = await routeToProviderPage('sidepanel-chatgpt.html');

const CHATGPT_HOME = 'https://chatgpt.com/';
const LAST_URL_KEY = 'chatgptEmbeddedPanel.lastUrl';
const TASK_KEY = 'webmcp.pageTask';
const FRAME_TIMEOUT_MS = 15000;

const frame = document.getElementById('chatgpt-frame');
const status = document.getElementById('status');
const attached = document.getElementById('attached');
const stop = document.getElementById('stop');
const recovery = document.getElementById('recovery');

let generation = 0;
let timeoutId = null;
let peer = null;
let retried = false;
let modelStatus = INITIAL_MODEL_STATUS;

function sanitizeChatGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password) return null;
    if (/^\/(api|backend-api|cdn)(\/|$)/.test(url.pathname)) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function setStatus(text = '') {
  status.hidden = !text;
  status.textContent = text;
  status.title = text;
}

function renderModelStatus() {
  const lines = modelStatusLines(modelStatus);
  document.getElementById('model').hidden = !lines;
  if (!lines) return;
  document.getElementById('model-actual').textContent = lines.actual;
  document.getElementById('model-effort').hidden = !lines.effort;
  document.getElementById('model-effort-value').textContent = lines.effort;
  document.getElementById('model-source').textContent = lines.source ? `Source: ${lines.source}` : '';
}

async function runtimeMessage(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error ?? 'Extension action failed.');
  return response.result;
}

function beginConnection() {
  generation += 1;
  peer = null;
  clearTimeout(timeoutId);
  recovery.hidden = true;
  setStatus('Connecting to ChatGPT…');
  const currentGeneration = generation;
  timeoutId = setTimeout(() => {
    if (generation !== currentGeneration || peer) return;
    if (!retried) {
      retried = true;
      void loadFrame({ cacheBust: true });
      return;
    }
    recovery.hidden = false;
    setStatus('');
  }, FRAME_TIMEOUT_MS);
}

async function loadFrame({ cacheBust = false } = {}) {
  beginConnection();
  await runtimeMessage('panel.frame-open');
  const stored = await chrome.storage.local.get(LAST_URL_KEY);
  const base = sanitizeChatGptUrl(stored[LAST_URL_KEY]) || CHATGPT_HOME;
  const url = new URL(base);
  if (cacheBust) url.searchParams.set('chatgpt_embedded_retry', String(Date.now()));
  frame.src = url.href;
}

async function openCompanion() {
  setStatus('Opening ChatGPT window…');
  await runtimeMessage('panel.open-companion');
  setStatus('');
}

async function refreshPageState() {
  const payload = await runtimeMessage('panel.target-status');
  const task = payload?.task ?? { mode: 'idle' };

  if (task.mode === 'locked' && task.target) {
    attached.textContent = `Working on: ${task.target.title}`;
    attached.title = `${task.target.title} — ${task.target.origin}`;
    stop.hidden = false;
    return;
  }

  if (task.mode === 'blocked' && task.target) {
    attached.textContent = `Paused: ${task.target.title}`;
    attached.title = `Task page unavailable (${task.reason || 'PAGE_UNAVAILABLE'}). Stop to release this task.`;
    stop.hidden = false;
    return;
  }

  stop.hidden = true;
  if (payload?.candidate) {
    attached.textContent = `Ready — Current: ${payload.candidate.title}`;
    attached.title = `${payload.candidate.title} — ${payload.candidate.origin}. The first Browser WebMCP call will lock this page.`;
  } else {
    attached.textContent = 'Ready — Current page unavailable';
    attached.title = 'Browser WebMCP works on ordinary http(s) webpages. Open a normal webpage; the first Browser WebMCP call will lock it automatically.';
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== 'https://chatgpt.com') return;
  const message = event.data;

  if (message?.type === 'chatgpt-embedded-panel:ready') {
    if (typeof message.documentId !== 'string' || !message.documentId) return;
    peer = { documentId: message.documentId };
    clearTimeout(timeoutId);
    recovery.hidden = true;
    setStatus('');
    return;
  }

  if (message?.type === 'chatgpt-embedded-panel:model') {
    modelStatus = applyModelEvent(modelStatus, message.event);
    renderModelStatus();
    return;
  }

  if (message?.type === 'chatgpt-embedded-panel:pong' && message.documentId === peer?.documentId) {
    setStatus('');
  }
});

frame.addEventListener('load', () => {
  if (!frame.contentWindow) return;
  const requestId = crypto.randomUUID();
  frame.contentWindow.postMessage({ type: 'chatgpt-embedded-panel:ping', requestId }, 'https://chatgpt.com');
});

stop.addEventListener('click', () => {
  void runtimeMessage('panel.task-stop')
    .then(async () => {
      setStatus('');
      await refreshPageState();
    })
    .catch((error) => setStatus(error.message));
});

document.getElementById('retry').addEventListener('click', () => {
  retried = false;
  void loadFrame({ cacheBust: true }).catch((error) => {
    recovery.hidden = false;
    setStatus(error.message);
  });
});

document.getElementById('fallback').addEventListener('click', () => {
  void openCompanion().catch((error) => setStatus(error.message));
});

window.addEventListener('pagehide', () => {
  void chrome.runtime.sendMessage({ type: 'panel.closed' }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && TASK_KEY in changes) void refreshPageState().catch(() => {});
});

chrome.tabs.onActivated.addListener(() => {
  void refreshPageState().catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || typeof changeInfo.url === 'string' || typeof changeInfo.title === 'string') {
    void refreshPageState().catch(() => {});
  }
});

// The worker cannot message the ChatGPT frame; the panel relays Work changes into it.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'panel.work-changed') frame.contentWindow?.postMessage({ type: 'webmcp:work-changed' }, 'https://chatgpt.com');
  return false;
});

mountProviderSelect(document.getElementById('provider'), provider);

void refreshPageState().catch(() => {});
void loadFrame().catch((error) => {
  recovery.hidden = false;
  setStatus(error.message);
});
