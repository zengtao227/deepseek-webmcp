(() => {
  'use strict';

  const ANSWER_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
  const COMPOSER_SELECTOR = 'textarea[placeholder]';
  const SEND_SELECTOR = 'div[role="button"].ds-button--primary.ds-button--circle';
  const DISABLED_CLASS = 'ds-button--disabled';
  const MAX_LOGS = 2000;
  const logs = [];

  function textLength(node) {
    return node && node.textContent ? node.textContent.length : 0;
  }

  function latestOf(selector) {
    const nodes = document.querySelectorAll(selector);
    return nodes.length > 0 ? nodes[nodes.length - 1] : null;
  }

  function telemetry() {
    const answers = document.querySelectorAll(ANSWER_SELECTOR);
    const markdown = document.querySelectorAll('.ds-markdown');
    const messages = document.querySelectorAll('.ds-message');
    const thinkBlocks = document.querySelectorAll('.ds-think-content');
    const composer = document.querySelector(COMPOSER_SELECTOR);
    const send = document.querySelector(SEND_SELECTOR);
    const stopIcon = send?.querySelector('path[d^="M2 4.88"]') ?? null;

    return {
      hasFocus: document.hasFocus(),
      answerCount: answers.length,
      answerLength: textLength(answers.length > 0 ? answers[answers.length - 1] : null),
      markdownCount: markdown.length,
      latestMarkdownLength: textLength(latestOf('.ds-markdown')),
      messageCount: messages.length,
      latestMessageLength: textLength(latestOf('.ds-message')),
      thinkCount: thinkBlocks.length,
      latestThinkLength: textLength(latestOf('.ds-think-content')),
      generating: stopIcon !== null,
      composerLength: composer?.value?.length ?? -1,
      sendDisabled: send ? send.classList.contains(DISABLED_CLASS) : null
    };
  }

  function record(kind, extra = {}) {
    logs.push({
      at: Date.now(),
      visibility: document.visibilityState,
      kind,
      ...telemetry(),
      ...extra
    });
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  }

  function writeComposer(input, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, text);
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text
    }));
    return input.value === text;
  }

  function sendWhenEnabled(text) {
    const input = document.querySelector(COMPOSER_SELECTOR);
    if (!input) return { ok: false, code: 'COMPOSER_NOT_FOUND' };
    if (!writeComposer(input, text)) return { ok: false, code: 'COMPOSER_WRITE_FAILED' };

    const tryClick = () => {
      const control = document.querySelector(SEND_SELECTOR);
      if (!control || control.classList.contains(DISABLED_CLASS)) return false;
      control.click();
      record('submit_clicked');
      return true;
    };

    if (tryClick()) return { ok: true, code: 'SUBMIT_CLICKED' };

    const observer = new MutationObserver(() => {
      record('send_wait_mutation');
      if (!tryClick()) return;
      observer.disconnect();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class']
    });
    record('submit_waiting_for_enabled_control');
    return { ok: true, code: 'SUBMIT_WAITING_FOR_ENABLED_CONTROL' };
  }

  new MutationObserver(() => {
    record('mutation');
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'd']
  });

  document.addEventListener('visibilitychange', () => record('visibilitychange'));
  window.addEventListener('focus', () => record('focus'));
  window.addEventListener('blur', () => record('blur'));
  document.addEventListener('freeze', () => record('freeze'));
  document.addEventListener('resume', () => record('resume'));
  window.addEventListener('pagehide', () => record('pagehide'));
  window.addEventListener('pageshow', () => record('pageshow'));

  record('probe_loaded', { wasDiscarded: document.wasDiscarded === true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'probe.ping') {
      sendResponse({
        ok: true,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        href: location.href
      });
      return;
    }

    if (message?.type === 'probe.clear') {
      logs.length = 0;
      record('log_cleared');
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'probe.submit') {
      const text = typeof message.text === 'string' ? message.text : '';
      if (!text.trim()) {
        sendResponse({ ok: false, code: 'EMPTY_PROMPT' });
        return;
      }
      const baseline = telemetry();
      record('submit_received', {
        baselineAnswerCount: baseline.answerCount,
        baselineAnswerLength: baseline.answerLength,
        baselineMarkdownCount: baseline.markdownCount,
        baselineLatestMarkdownLength: baseline.latestMarkdownLength,
        baselineMessageCount: baseline.messageCount,
        baselineLatestMessageLength: baseline.latestMessageLength
      });
      sendResponse(sendWhenEnabled(text));
      return;
    }

    if (message?.type === 'probe.get_log') {
      sendResponse({
        ok: true,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        wasDiscarded: document.wasDiscarded === true,
        logs: logs.slice()
      });
    }
  });
})();
