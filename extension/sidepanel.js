import { blocksToPlainText } from './answer-blocks.js';
import { renderBlocks } from './answer-render.js';
import { initSettings } from './settings-ui.js';

const $ = (selector) => document.querySelector(selector);

// ChatGPT has its own panel page (the ChatGPT Embedded Panel's); nothing below runs for it.
if ((await chrome.storage.local.get('provider.id'))['provider.id'] === 'chatgpt') {
  location.replace('sidepanel-chatgpt.html');
  await new Promise(() => {});
}

let lastSessionKey = '';
let lastCompleted = false;
let lastGenerating = false;
// The panel polls every 500 ms; history and the current answer are only rebuilt when they
// change, so a click on an action button is never swallowed by a re-render between press and release.
let providerNote = '';
let lastHistorySignature = '';
let lastAnswerSignature = '';

// Rich when the provider sent structure, otherwise the plain answer text.
function renderAnswer(container, answer, blocks) {
  container.replaceChildren();
  const rich = Array.isArray(blocks) && blocks.length > 0;
  container.classList.toggle('rich', rich);
  if (rich) renderBlocks(document, container, blocks);
  else container.textContent = answer;
}

function answerCopyText(answer, blocks) {
  return blocksToPlainText(blocks) || answer;
}

async function copyText(text, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = label; }, 1500);
}

// Failure detail from the provider page, shown as text with a copy button. Not persisted.
function showDiagnostic(diagnostics) {
  const box = $('#diagnostic');
  if (!diagnostics) {
    box.hidden = true;
    box.open = false;
    return;
  }
  $('#diagnostic-text').textContent = JSON.stringify(diagnostics, null, 2);
  box.hidden = false;
}

async function runAnswerAction(action) {
  const response = await chrome.runtime.sendMessage({ type: 'assistant.action', action }).catch(() => null);
  if (!response?.ok) $('#notice').textContent = response?.error?.message ?? 'Action failed.';
  showDiagnostic(response?.ok ? null : response?.diagnostics);
  await refresh();
}

function actionButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// Copy works on any finished answer; Regenerate and Share act on DeepSeek's latest reply only.
function renderActions(container, { text, provider }) {
  container.replaceChildren();
  const copy = actionButton('Copy', () => { void copyText(text, copy); });
  container.append(copy);
  if (provider) {
    container.append(
      actionButton('Regenerate', () => { void runAnswerAction('regenerate'); }),
      actionButton('Share', () => { void runAnswerAction('share'); }),
    );
  }
  container.hidden = false;
}

function addTextBubble(container, role, text, reasoning = '', blocks = []) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (role === 'user' ? 'user' : 'assistant');

  if (role === 'assistant' && reasoning) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking';
    const body = document.createElement('div');
    body.className = 'reasoning';
    body.textContent = reasoning;
    details.append(summary, body);
    bubble.append(details);
  }

  const body = document.createElement('div');
  if (role === 'assistant') renderAnswer(body, text, blocks);
  else body.textContent = text;
  bubble.append(body);

  if (role === 'assistant' && text) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    renderActions(actions, { text: answerCopyText(text, blocks), provider: false });
    bubble.append(actions);
  }
  container.append(bubble);
}

function historySignature(history) {
  let size = 0;
  for (const item of history ?? []) size += (item?.text?.length ?? 0) + (item?.answer?.length ?? 0) + (item?.reasoning?.length ?? 0);
  return `${history?.length ?? 0}:${size}`;
}

function renderHistory(history) {
  const signature = historySignature(history);
  if (signature === lastHistorySignature) return;
  lastHistorySignature = signature;
  const container = $('#history');
  container.replaceChildren();
  for (const item of history ?? []) {
    if (item?.role === 'user' && typeof item.text === 'string') {
      addTextBubble(container, 'user', item.text);
      continue;
    }
    if (item?.role === 'assistant') {
      addTextBubble(
        container,
        'assistant',
        typeof item.answer === 'string' ? item.answer : '',
        typeof item.reasoning === 'string' ? item.reasoning : '',
        Array.isArray(item.blocks) ? item.blocks : [],
      );
    }
  }
}

function renderTools(presentation) {
  const tools = Array.isArray(presentation?.tools) ? presentation.tools : [];
  const count = Number.isInteger(presentation?.toolCount) ? presentation.toolCount : tools.length;
  $('#tools').hidden = count === 0;
  if (count === 0) return;

  const failed = tools.find((tool) => tool?.status === 'error');
  $('#tool-summary').textContent = presentation.generating
    ? 'Working · ' + count + ' tool action' + (count === 1 ? '' : 's')
    : 'Used ' + count + ' tool' + (count === 1 ? '' : 's');

  const list = $('#tool-list');
  list.replaceChildren();
  for (const tool of tools) {
    const item = document.createElement('li');
    const mark = tool.status === 'ok' ? '✓' : tool.status === 'error' ? '✗' : '…';
    item.textContent = (tool.name || 'tool') + ' ' + mark + (tool.code ? ' · ' + tool.code : '');
    if (tool.status === 'error') item.className = 'error';
    list.append(item);
  }

  if (failed) $('#tools').open = true;
}

function render(response) {
  const session = response?.session ?? null;
  const health = response?.health ?? null;

  $('#empty').hidden = Boolean(session);
  $('#restore').hidden = session?.state !== 'paused';

  if (!session) {
    $('#state').textContent = 'Assistant not started';
    $('#history').replaceChildren();
    lastHistorySignature = '';
    lastAnswerSignature = '';
    showDiagnostic(null);
    $('#current').hidden = true;
    $('#tools').hidden = true;
    $('#notice').textContent = '';
    $('#send').disabled = true;
    lastCompleted = false;
    lastGenerating = false;
    return;
  }

  $('#state').textContent = session.state === 'active'
    ? 'DeepSeek Assistant'
    : session.state === 'paused'
      ? 'Assistant paused'
      : 'Preparing Assistant';
  providerNote = health?.page?.visibility ? ' · DeepSeek ' + health.page.visibility : '';

  const presentation = session.presentation ?? {};
  renderHistory(presentation.history);

  const reasoning = typeof presentation.reasoning === 'string' ? presentation.reasoning : '';
  const answer = typeof presentation.answer === 'string' ? presentation.answer : '';
  const hasCurrent = Boolean(reasoning || answer || presentation.generating);
  $('#current').hidden = !hasCurrent;
  $('#thinking').hidden = !reasoning;
  $('#reasoning').textContent = reasoning;
  const blocks = Array.isArray(presentation.blocks) ? presentation.blocks : [];
  const finished = presentation.completed === true && answer !== '';
  const canAct = session.state === 'active' && presentation.generating !== true;
  const answerSignature = [answer.length, blocks.length, finished, canAct].join(':');
  if (answerSignature !== lastAnswerSignature) {
    lastAnswerSignature = answerSignature;
    renderAnswer($('#answer'), answer, blocks);
    if (finished) renderActions($('#answer-actions'), { text: answerCopyText(answer, blocks), provider: canAct });
    else $('#answer-actions').hidden = true;
  }
  if (reasoning && presentation.generating && !lastGenerating) $('#thinking').open = true;
  if (reasoning && presentation.completed && !lastCompleted) $('#thinking').open = false;
  lastGenerating = presentation.generating === true;
  lastCompleted = presentation.completed === true;

  renderTools(presentation);
  $('#notice').textContent = presentation.notice || '';
  $('#send').disabled = session.state !== 'active' || presentation.generating === true;

  const sessionKey = [
    presentation.history?.length ?? 0,
    answer.length,
    reasoning.length,
    presentation.toolCount ?? 0,
  ].join(':');
  if (sessionKey !== lastSessionKey) {
    lastSessionKey = sessionKey;
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
}

// The page the task works on: locked by the first browser tool call, released by Stop.
async function refreshPage() {
  const response = await chrome.runtime.sendMessage({ type: 'assistant.page-status' }).catch(() => null);
  const task = response?.task ?? { mode: 'idle' };
  const candidate = response?.candidate ?? null;
  const stop = $('#stop');

  if (task.mode === 'locked' && task.target) {
    $('#target').textContent = `Working on: ${task.target.title}${providerNote}`;
    $('#target').title = `${task.target.title} — ${task.target.origin}`;
    stop.hidden = false;
  } else if (task.mode === 'blocked' && task.target) {
    $('#target').textContent = `Paused: ${task.target.title}`;
    $('#target').title = `Task page unavailable (${task.reason || 'PAGE_UNAVAILABLE'}). Press Stop to release it.`;
    stop.hidden = false;
    // The "Paused" line above is easy to miss; render() has just written presentation.notice, so only fill an empty notice.
    if (!$('#notice').textContent) $('#notice').textContent = `The page this task was working on is no longer available (${task.reason || 'PAGE_UNAVAILABLE'}). Press Stop, then ask again.`;
  } else {
    $('#target').textContent = (candidate ? `Ready — current page: ${candidate.title}` : 'Ready — open a webpage to work on') + providerNote;
    $('#target').title = 'The first page action locks the page that is open in this window. Stop releases it.';
    stop.hidden = true;
  }
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'assistant.status' }));
    await refreshPage();
  } catch {
    $('#state').textContent = 'Extension unavailable';
    $('#send').disabled = true;
  }
}

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  $('#send').disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'assistant.prompt', text: prompt }).catch(() => null);
  if (response?.ok) $('#prompt').value = '';
  else $('#notice').textContent = response?.error?.message ?? 'Prompt could not be sent.';
  await refresh();
});

$('#prompt').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  $('#composer').requestSubmit();
});

$('#diagnostic-copy').addEventListener('click', (event) => {
  void copyText($('#diagnostic-text').textContent, event.currentTarget);
});

$('#restore').addEventListener('click', async () => {
  $('#restore').disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'assistant.restore' }).catch(() => null);
  if (!response?.ok) $('#notice').textContent = response?.error?.message ?? 'Restore failed.';
  $('#restore').disabled = false;
  await refresh();
});

$('#stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'assistant.stop' }).catch(() => null);
  await refresh();
});

// Closing the panel releases the locked page; the conversation stays for the next time.
window.addEventListener('pagehide', () => {
  void chrome.runtime.sendMessage({ type: 'assistant.closed' }).catch(() => {});
});

// Opening the panel is all it takes: the assistant starts (or is found already running) here.
const currentWindow = await chrome.windows.getCurrent();
void chrome.runtime.sendMessage({ type: 'assistant.ensure', windowId: currentWindow.id })
  .then((response) => { if (!response?.ok) $('#notice').textContent = response?.error?.message ?? 'Assistant could not start.'; })
  .catch(() => {});
await initSettings();
await refresh();
setInterval(() => { void refresh(); }, 500);
