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
  let instructions = null;
  let ownSend = false;

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

  const INSTRUCTIONS_START = 'You can use local tools through DeepSeek WebMCP';

  function isNewChat() {
    return !CONVERSATION_PATH.test(location.pathname) && latestAnswer() === null;
  }

  // In a Work tab, the user's first message of a new chat is sent with the tool
  // instructions after it, so the composer stays clean while typing and the question
  // stays visible when DeepSeek collapses long messages. Enter during IME composition
  // (e.g. Chinese input) is never treated as Send.
  function interceptSend(event) {
    if (ownSend || instructions === null || !isNewChat()) return;
    const input = composer();
    if (!input || input.value.trim() === '' || input.value.includes(INSTRUCTIONS_START)) return;
    if (event.type === 'keydown') {
      if (event.target !== input || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    } else if (!event.target?.closest?.(SEND_SELECTOR)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = `${input.value.trimEnd()}\n\n${instructions}`;
    ownSend = true;
    busy = true;
    void sendText(text).finally(() => {
      ownSend = false;
      busy = false;
    });
  }

  async function arrive() {
    busy = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'work.arrive' });
      instructions = reply?.work === true && typeof reply.instructions === 'string' ? reply.instructions : null;
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
    scheduleFold();
    if (location.href !== route) enterRoute();
    if (busy) return;
    if (isGenerating()) {
      if (!sawGeneration) void chrome.runtime.sendMessage({ type: 'work.generating' }).catch(() => {});
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

  // Display only. DeepSeek Web has no hidden instruction channel, so instructions, tool
  // results and tool calls must be real message text; here they are folded into a one-line
  // summary (click to expand). Only data attributes and CSS are used: the text and DOM that
  // DeepSeek's page owns, and the answer text WebMCP reads, stay unchanged.
  const FOLD = 'data-webmcp-fold';
  const OPEN = 'data-webmcp-open';
  const RESULT_START = 'DeepSeek WebMCP tool result.\n';
  const CORRECTION_START = 'DeepSeek WebMCP format correction.\n';
  const INSTRUCTIONS_SEPARATOR = `\n\n---\n${INSTRUCTIONS_START}`;

  const style = document.createElement('style');
  style.textContent = `
    [${FOLD}]:not([${OPEN}]) { font-size: 0 !important; line-height: 0 !important; cursor: pointer; }
    [${FOLD}]:not([${OPEN}]) > * { display: none !important; }
    [${FOLD}]:not([${OPEN}])::before { content: attr(${FOLD}); font-size: 13px; line-height: 20px; opacity: 0.75; white-space: pre-wrap; }
    [${FOLD}][${OPEN}] { cursor: pointer; }
  `;
  (document.head ?? document.documentElement).append(style);

  function toolName(text) {
    return /"name":"([a-z_]{1,32})"/.exec(text)?.[1] ?? 'tool';
  }

  function summaryFor(text) {
    if (text.startsWith(RESULT_START)) return `🔧 ${toolName(text)} ${/"isError":true/.test(text) ? '✗' : '✓'}`;
    if (text.startsWith(CORRECTION_START)) return '🔧 format corrected, retrying';
    const separator = text.indexOf(INSTRUCTIONS_SEPARATOR);
    if (separator > 0) return `${text.slice(0, separator)}\n🔧 WebMCP tools attached`;
    return null;
  }

  function setFold(element, summary) {
    if (element.getAttribute(FOLD) !== summary) element.setAttribute(FOLD, summary);
  }

  let foldScheduled = false;
  function foldMessages() {
    foldScheduled = false;
    // Messages the extension typed: a single text node inside one element (live DOM:
    // a visible <span> plus a hidden <div> copy of each user message).
    for (const element of document.querySelectorAll('div, span')) {
      if (element.childNodes.length !== 1 || element.firstChild.nodeType !== Node.TEXT_NODE) continue;
      if (element.closest(ANSWER_SELECTOR)) continue;
      const summary = summaryFor(element.firstChild.nodeValue ?? '');
      // Fold the whole bubble: DeepSeek's own collapsible box inside it keeps a fixed height.
      if (summary) setFold(element.closest('.ds-message') ?? element, summary);
    }
    for (const answer of document.querySelectorAll(ANSWER_SELECTOR)) {
      const text = answer.textContent ?? '';
      if (/｜\s*DSML\s*｜/.test(text)) {
        setFold(answer, '🔧 DeepSeek used its own tool format (not run)');
        continue;
      }
      for (const block of answer.querySelectorAll('.md-code-block')) {
        const code = block.querySelector('pre')?.textContent ?? '';
        if (code.trimStart().startsWith('<webmcp_tool_call>')) setFold(block, `🔧 ${toolName(code)}`);
      }
    }
  }

  function scheduleFold() {
    if (foldScheduled) return;
    foldScheduled = true;
    requestAnimationFrame(foldMessages);
  }

  document.addEventListener('click', (event) => {
    const folded = event.target?.closest?.(`[${FOLD}]`);
    if (!folded || window.getSelection()?.toString()) return;
    folded.toggleAttribute(OPEN);
  }, true);

  document.addEventListener('keydown', interceptSend, true);
  document.addEventListener('click', interceptSend, true);

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
