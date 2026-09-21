const CHATGPT_URL = 'https://chatgpt.com/';
const status = document.getElementById('status');
const frameWrap = document.getElementById('frame-wrap');
let frame = null;
let handshakeSeen = false;

function setStatus(message) {
  status.textContent = message;
}

function loadFrame() {
  handshakeSeen = false;
  frameWrap.replaceChildren();
  frame = document.createElement('iframe');
  frame.src = CHATGPT_URL;
  frame.title = 'ChatGPT Web direct embed probe';
  frame.addEventListener('load', () => {
    setStatus(
      handshakeSeen
        ? 'PASS candidate: iframe loaded and ChatGPT frame handshake was received. Visually verify login and normal chat interaction.'
        : 'iframe load event fired, but no ChatGPT frame handshake yet. Visually inspect the frame; a load event alone does not prove success.'
    );
  });
  frameWrap.appendChild(frame);
  setStatus('Loading https://chatgpt.com directly. No frame-policy/header override is installed by this spike.');
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'chatgpt-direct-spike.frame-ready' || message.isTop !== false) return;
  handshakeSeen = true;
  setStatus(
    'PASS candidate: ChatGPT subframe content script is running. ' +
    `visibility=${message.visibility}; hasFocus=${message.hasFocus}; readyState=${message.readyState}; path=${message.path}. ` +
    'Now visually verify that your signed-in ChatGPT UI is rendered and that you can send a normal message.'
  );
});

document.getElementById('load').addEventListener('click', loadFrame);

document.getElementById('reload').addEventListener('click', () => {
  if (!frame) {
    loadFrame();
    return;
  }
  handshakeSeen = false;
  frame.src = CHATGPT_URL + '?direct_sidepanel_spike=' + Date.now();
  setStatus('Reloading the direct ChatGPT frame.');
});

document.getElementById('reset').addEventListener('click', () => {
  window.location.reload();
});
