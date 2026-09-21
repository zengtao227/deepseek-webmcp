const CHATGPT_URL = 'https://chatgpt.com/';
const status = document.getElementById('status');
const rule = document.getElementById('rule');
const frameWrap = document.getElementById('frame-wrap');
let frame = null;
let handshakes = 0;

function setStatus(message) {
  status.textContent = message;
}

function renderRule(payload) {
  if (!payload?.ok) {
    rule.textContent = 'Rule status failed: ' + (payload?.error ?? 'unknown error');
    return;
  }
  rule.textContent = `mode=${payload.mode}; ruleInstalled=${Boolean(payload.rule)}; runtimeId=${payload.runtimeId}`;
}

async function getRuleStatus() {
  const payload = await chrome.runtime.sendMessage({ type: 'dnr.status' });
  renderRule(payload);
  return payload;
}

function loadFrame() {
  handshakes = 0;
  frameWrap.replaceChildren();
  frame = document.createElement('iframe');
  frame.src = CHATGPT_URL + '?scoped_dnr_spike=' + Date.now();
  frame.title = 'ChatGPT scoped DNR embed probe';
  frame.addEventListener('load', () => {
    setStatus(
      handshakes > 0
        ? `Frame load fired; ${handshakes} ChatGPT subframe handshake(s) received. Visually verify login and normal chat.`
        : 'Frame load fired but no ChatGPT subframe handshake yet. Inspect the frame; load alone is not PASS.'
    );
  });
  frameWrap.appendChild(frame);
  setStatus('Loading ChatGPT with the currently selected scoped rule.');
}

async function setMode(mode) {
  setStatus(`Installing scoped mode: ${mode}…`);
  const payload = await chrome.runtime.sendMessage({ type: 'dnr.set-mode', mode });
  renderRule(payload);
  if (!payload?.ok) {
    setStatus('Could not install rule: ' + (payload?.error ?? 'unknown error'));
    return;
  }
  setStatus(`Mode ${mode} installed. Loading a fresh ChatGPT iframe…`);
  loadFrame();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'chatgpt-dnr-spike.frame-ready' || message.isTop !== false) return;
  handshakes += 1;
  setStatus(
    `PASS candidate: ChatGPT subframe handshake #${handshakes} (${message.stage}). ` +
    `visibility=${message.visibility}; hasFocus=${message.hasFocus}; readyState=${message.readyState}; path=${message.path}. ` +
    'Now verify that your signed-in ChatGPT UI renders and can send/receive a normal message.'
  );
});

document.getElementById('off').addEventListener('click', () => void setMode('off'));
document.getElementById('xfo').addEventListener('click', () => void setMode('xfo'));
document.getElementById('xfo-csp').addEventListener('click', () => void setMode('xfo-csp'));
document.getElementById('reload').addEventListener('click', loadFrame);

await getRuleStatus();
