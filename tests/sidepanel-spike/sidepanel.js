const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const status = document.getElementById('status');
const frameWrap = document.getElementById('frame-wrap');

function setStatus(message) {
  status.textContent = message;
}

document.getElementById('iframe-test').addEventListener('click', () => {
  frameWrap.replaceChildren();
  const frame = document.createElement('iframe');
  frame.src = DEEPSEEK_URL;
  frame.title = 'DeepSeek Web iframe probe';
  frame.addEventListener('load', () => {
    setStatus(
      'A: iframe load event fired. Visually verify whether the real DeepSeek UI rendered, ' +
      'whether you are already logged in, and whether you can send a normal message. ' +
      'A load event alone does NOT prove success.'
    );
  });
  frameWrap.appendChild(frame);
  setStatus(
    'A: Loading https://chat.deepseek.com in an iframe. ' +
    'If Chrome shows a refusal/error/blank frame, record the exact console message.'
  );
});

document.getElementById('top-test').addEventListener('click', () => {
  setStatus('B: Navigating the Side Panel top-level context to DeepSeek now...');
  window.location.assign(DEEPSEEK_URL);
});

document.getElementById('reset').addEventListener('click', () => {
  window.location.reload();
});
