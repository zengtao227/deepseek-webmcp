const BINDING_KEY = 'deepseekHiddenSpike.boundTabId';

const PROMPT = [
  'Please answer this as a normal chat response and do not use tools.',
  'Write a detailed explanation of HTTP/3 and QUIC versus HTTP/2 over TCP,',
  'around 1200 words, organized into 10 numbered sections.',
  'Include handshake behavior, multiplexing, head-of-line blocking, migration,',
  'loss recovery, encryption, deployment, observability, trade-offs, and a conclusion.'
].join(' ');

const status = document.getElementById('status');
const summary = document.getElementById('summary');
const logBox = document.getElementById('log');

function setStatus(value) {
  status.textContent = value;
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function boundTabId() {
  const data = await chrome.storage.session.get(BINDING_KEY);
  return Number.isInteger(data[BINDING_KEY]) ? data[BINDING_KEY] : null;
}

async function respondingDeepSeekTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://chat.deepseek.com/*'] });
  const responding = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { type: 'probe.ping' });
      if (pong?.ok) responding.push({ tab, pong });
    } catch {
      // Tab has not loaded/reloaded the spike content script.
    }
  }
  return responding;
}

async function resolveDeepSeekTabId() {
  const stored = await boundTabId();
  if (stored !== null) {
    try {
      const pong = await chrome.tabs.sendMessage(stored, { type: 'probe.ping' });
      if (pong?.ok) return stored;
    } catch {
      // Stored binding is stale; fall through to discovery.
    }
  }

  const responding = await respondingDeepSeekTabs();
  if (responding.length === 1) {
    const tabId = responding[0].tab.id;
    await chrome.storage.session.set({ [BINDING_KEY]: tabId });
    return tabId;
  }
  if (responding.length === 0) {
    throw new Error('No DeepSeek tab with the spike content script was found. Reload the DeepSeek tab once.');
  }
  throw new Error('Multiple DeepSeek tabs are available. Use Bind current DeepSeek tab on the one you want to test.');
}

async function sendToBound(message) {
  const tabId = await resolveDeepSeekTabId();
  return chrome.tabs.sendMessage(tabId, message);
}

function growthStats(entries, field) {
  let priorMax = -1;
  let events = 0;
  let max = 0;
  let firstAt = null;
  let lastAt = null;

  for (const entry of entries) {
    const value = Number(entry[field]) || 0;
    if (value > priorMax) {
      if (priorMax >= 0 && value > priorMax) {
        events += 1;
        if (firstAt === null) firstAt = entry.at;
        lastAt = entry.at;
      }
      priorMax = value;
    }
    max = Math.max(max, value);
  }

  return { events, max, firstAt, lastAt };
}

function summarize(payload) {
  const logs = Array.isArray(payload && payload.logs) ? payload.logs : [];
  const submitIndex = logs.findIndex((entry) => entry.kind === 'submit_received');
  const afterSubmit = submitIndex >= 0 ? logs.slice(submitIndex) : logs;
  const hidden = afterSubmit.filter((entry) => entry.visibility === 'hidden');
  const visibleUnfocused = afterSubmit.filter((entry) => entry.visibility === 'visible' && entry.hasFocus === false);
  const answer = growthStats(hidden, 'answerLength');
  const markdown = growthStats(hidden, 'latestMarkdownLength');
  const message = growthStats(hidden, 'latestMessageLength');
  const think = growthStats(hidden, 'latestThinkLength');
  const unfocusedAnswer = growthStats(visibleUnfocused, 'answerLength');
  const unfocusedMarkdown = growthStats(visibleUnfocused, 'latestMarkdownLength');
  const unfocusedMessage = growthStats(visibleUnfocused, 'latestMessageLength');
  const generatingSamples = hidden.filter((entry) => entry.generating === true).length;
  const composerClearedSamples = hidden.filter((entry) => entry.composerLength === 0).length;
  const unfocusedGeneratingSamples = visibleUnfocused.filter((entry) => entry.generating === true).length;

  const lifecycle = logs
    .filter((entry) => ['freeze', 'resume', 'pagehide', 'pageshow', 'visibilitychange'].includes(entry.kind))
    .map((entry) => entry.kind + '@' + new Date(entry.at).toISOString() + ':' + entry.visibility);

  let verdict = 'candidate result: NOT PROVEN — inspect telemetry';
  if (unfocusedAnswer.events >= 3 || unfocusedMarkdown.events >= 3 || unfocusedMessage.events >= 3) {
    verdict = 'candidate result: PASS — DeepSeek DOM grew while visible but unfocused in another window';
  } else if (answer.events >= 3) {
    verdict = 'candidate result: PASS — final-answer DOM grew repeatedly while hidden';
  } else if (generatingSamples > 0 && (markdown.events >= 3 || message.events >= 3 || think.events >= 3)) {
    verdict = 'candidate result: STRONG HIDDEN-RENDER EVIDENCE — generation and candidate DOM grew while hidden; final answer selector did not';
  }

  return [
    'current visibility: ' + ((payload && payload.visibility) || 'unknown'),
    'current hasFocus: ' + String(payload && payload.hasFocus),
    'log entries: ' + logs.length,
    'hidden entries after submit: ' + hidden.length,
    'visible+unfocused entries after submit: ' + visibleUnfocused.length,
    'hidden generating samples: ' + generatingSamples,
    'visible+unfocused generating samples: ' + unfocusedGeneratingSamples,
    'hidden composer-cleared samples: ' + composerClearedSamples,
    'final-answer growth events: ' + answer.events + ' (max ' + answer.max + ')',
    'latest .ds-markdown growth events: ' + markdown.events + ' (max ' + markdown.max + ')',
    'latest .ds-message growth events: ' + message.events + ' (max ' + message.max + ')',
    'latest .ds-think-content growth events: ' + think.events + ' (max ' + think.max + ')',
    'unfocused final-answer growth events: ' + unfocusedAnswer.events + ' (max ' + unfocusedAnswer.max + ')',
    'unfocused .ds-markdown growth events: ' + unfocusedMarkdown.events + ' (max ' + unfocusedMarkdown.max + ')',
    'unfocused .ds-message growth events: ' + unfocusedMessage.events + ' (max ' + unfocusedMessage.max + ')',
    answer.firstAt ? 'first final-answer growth: ' + new Date(answer.firstAt).toISOString() : 'first final-answer growth: none',
    answer.lastAt ? 'last final-answer growth: ' + new Date(answer.lastAt).toISOString() : 'last final-answer growth: none',
    lifecycle.length ? 'lifecycle: ' + lifecycle.join(' | ') : 'lifecycle: none recorded',
    verdict
  ].join('\n');
}

async function refresh() {
  try {
    const payload = await sendToBound({ type: 'probe.get_log' });
    summary.textContent = summarize(payload);
    logBox.value = JSON.stringify(payload.logs || [], null, 2);
    setStatus('Log fetched from bound DeepSeek content script.');
  } catch (error) {
    setStatus('Could not fetch log: ' + error.message);
  }
}

document.getElementById('bind').addEventListener('click', async () => {
  try {
    const tab = await currentTab();
    if (!tab || !tab.id) throw new Error('No active tab.');
    const pong = await chrome.tabs.sendMessage(tab.id, { type: 'probe.ping' });
    if (!pong || !pong.ok) throw new Error('Current tab is not responding as DeepSeek.');
    await chrome.storage.session.set({ [BINDING_KEY]: tab.id });
    setStatus('Bound DeepSeek tab ' + tab.id + '. Visibility: ' + pong.visibility + '. hasFocus: ' + pong.hasFocus + '.');
  } catch (error) {
    setStatus('Bind failed: ' + error.message);
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  try {
    await sendToBound({ type: 'probe.clear' });
    summary.textContent = '';
    logBox.value = '';
    setStatus('Probe log cleared.');
  } catch (error) {
    setStatus('Clear failed: ' + error.message);
  }
});

document.getElementById('send').addEventListener('click', async () => {
  try {
    const result = await sendToBound({ type: 'probe.submit', text: PROMPT });
    setStatus('Probe submit result: ' + JSON.stringify(result));
  } catch (error) {
    setStatus('Probe submit failed: ' + error.message);
  }
});

document.getElementById('refresh').addEventListener('click', refresh);

document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logBox.value);
    setStatus('Log copied.');
  } catch (error) {
    setStatus('Copy failed: ' + error.message);
  }
});

(async () => {
  try {
    const tabId = await resolveDeepSeekTabId();
    setStatus('DeepSeek tab ready: ' + tabId + '.');
  } catch (error) {
    setStatus(error.message);
  }
})();
