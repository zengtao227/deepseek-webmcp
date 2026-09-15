(() => {
  'use strict';

  const ORIGIN = 'https://chat.deepseek.com';
  // Live DOM 2026-09-15: the final answer carries `ds-assistant-message-main-content`;
  // the reasoning block's own `.ds-markdown` inside `.ds-think-content` does not.
  const ANSWER_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
  const COMPOSER_SELECTOR = 'textarea[placeholder]';
  // Single send/stop control; disabled state is a class, not the `disabled` attribute.
  const SEND_SELECTOR = 'div[role="button"].ds-button--primary.ds-button--circle';
  const DISABLED_CLASS = 'ds-button--disabled';
  const POLL_MS = 500;
  // Reasoning models can pause mid-turn; require the answer text to stay unchanged.
  const STABLE_MS = 2000;
  const SEND_ENABLE_WAIT_MS = 3000;
  const SEND_CONFIRM_WAIT_MS = 5000;

  if (location.origin !== ORIGIN) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const composer = () => document.querySelector(COMPOSER_SELECTOR);
  const sendControl = () => document.querySelector(SEND_SELECTOR);

  // DeepSeek reuses one circle control for Send and Stop. Enabled state alone is
  // ambiguous, so generation is keyed to the Stop icon path inside that control:
  // present in Better DeepSeek v0.1.13 (`path[d*="M2 4.88"]`) and confirmed live
  // 2026-09-15 (Finding 11). No `ds-icon-stop*` class exists on the live page.
  function isGenerating() {
    const control = sendControl();
    if (!control) return false;
    return control.querySelector('path[d^="M2 4.88"]') !== null;
  }

  function latestAnswer() {
    const answers = document.querySelectorAll(ANSWER_SELECTOR);
    return answers.length > 0 ? answers[answers.length - 1] : null;
  }

  let sawGeneration = false;
  let lastText = null;
  let changedAt = 0;
  let continuing = false;

  function writeComposer(input, text) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return input.value === text;
  }

  async function continueConversation(text) {
    const input = composer();
    if (!input) return { ok: false, code: 'COMPOSER_NOT_FOUND' };
    if (!writeComposer(input, text)) return { ok: false, code: 'COMPOSER_WRITE_FAILED' };

    const enableDeadline = Date.now() + SEND_ENABLE_WAIT_MS;
    let control = sendControl();
    while (!control || control.classList.contains(DISABLED_CLASS)) {
      if (Date.now() > enableDeadline) return { ok: false, code: control ? 'SEND_DISABLED' : 'SEND_BUTTON_NOT_FOUND' };
      await sleep(100);
      control = sendControl();
    }
    control.click();

    const confirmDeadline = Date.now() + SEND_CONFIRM_WAIT_MS;
    while (input.value !== '') {
      if (Date.now() > confirmDeadline) return { ok: false, code: 'SEND_NOT_CONFIRMED' };
      await sleep(100);
    }
    return { ok: true, code: 'SEND_CLICKED' };
  }

  async function reportCompletion(text) {
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'p1.completion', text });
    } catch {
      return;
    }
    if (!reply?.continueWith || typeof reply.continueWith !== 'string') return;

    continuing = true;
    try {
      const result = await continueConversation(reply.continueWith);
      await chrome.runtime.sendMessage({ type: 'p1.continuation-result', result }).catch(() => {});
    } finally {
      continuing = false;
    }
  }

  // Only a response whose generation was observed in this page lifetime is
  // eligible, so reloading/re-rendering history never replays an old call.
  function tick() {
    if (continuing) return;
    if (isGenerating()) {
      sawGeneration = true;
      lastText = null;
      return;
    }
    if (!sawGeneration) return;

    const answer = latestAnswer();
    if (!answer) return;
    const text = answer.textContent ?? '';
    const now = Date.now();
    if (text !== lastText) {
      lastText = text;
      changedAt = now;
      return;
    }
    if (now - changedAt < STABLE_MS) return;

    sawGeneration = false;
    lastText = null;
    void reportCompletion(text);
  }

  // Live DOM 2026-09-15: a short reply showed the Stop icon for only ~680 ms,
  // between throttled timer ticks. Mutations catch that transient state; the
  // interval only advances time for the stable-text check after the DOM goes quiet.
  new MutationObserver(tick).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'd'],
  });
  setInterval(tick, POLL_MS);
})();
