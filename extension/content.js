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
  const CONVERSATION_PATH = /^\/a\/chat\/s\/[^/]+$/;
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

  let route = null;
  let sawGeneration = false;
  let resumeCheck = false;
  let lastText = null;
  let changedAt = 0;
  let busy = false;
  let prefilledRoute = null;

  function writeComposer(input, text) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return input.value === text;
  }

  async function sendText(text) {
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

  // Background only hands out a result for the conversation that produced it; the
  // page re-checks that the same conversation is still displayed before typing.
  async function deliver(reply) {
    if (typeof reply?.continueWith !== 'string' || reply.conversationPath !== location.pathname) return;
    const result = await sendText(reply.continueWith);
    await chrome.runtime.sendMessage({ type: 'work.continuation-result', result, conversationPath: reply.conversationPath }).catch(() => {});
  }

  function prefill(reply) {
    if (!reply?.work || typeof reply.instructions !== 'string') return;
    if (CONVERSATION_PATH.test(location.pathname) || latestAnswer() || prefilledRoute === location.href) return;
    const input = composer();
    if (!input || input.value !== '') return;
    prefilledRoute = location.href;
    writeComposer(input, reply.instructions);
  }

  async function arrive() {
    busy = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'work.arrive' });
      prefill(reply);
      await deliver(reply);
    } catch {
      // Extension reloaded or worker unavailable; the next route change retries.
    } finally {
      busy = false;
    }
  }

  async function report(text, resume) {
    busy = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'work.completion', text, resume });
      await deliver(reply);
    } catch {
      // Ignore; nothing executes without a reply from the worker.
    } finally {
      busy = false;
    }
  }

  // A new route starts clean: nothing seen in another conversation can be reported
  // here. History is reported only as a one-time resume check, which the worker
  // accepts solely when it is waiting for this conversation's reply.
  function enterRoute() {
    route = location.href;
    sawGeneration = false;
    resumeCheck = true;
    lastText = null;
    void arrive();
  }

  function tick() {
    if (location.href !== route) enterRoute();
    if (busy) return;
    if (isGenerating()) {
      sawGeneration = true;
      resumeCheck = false;
      lastText = null;
      return;
    }
    if (!sawGeneration && !resumeCheck) return;

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

    const resume = !sawGeneration;
    sawGeneration = false;
    resumeCheck = false;
    lastText = null;
    void report(text, resume);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'work.changed') void arrive();
  });

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
