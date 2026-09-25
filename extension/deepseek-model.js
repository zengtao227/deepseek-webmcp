// DeepSeek model-status adapter for the Side Panel's model line. Reads only the mode buttons next to
// DeepSeek's composer (for example DeepThink / Search) and whether each is switched on; never the
// conversation, and never DeepSeek's network traffic (see AGENTS.md). Reported whenever it changes.
(() => {
  'use strict';

  if (location.origin !== 'https://chat.deepseek.com' || window.top !== window) return;

  const COMPOSER_SELECTOR = 'textarea[placeholder]';
  const SEND_SELECTOR = 'div[role="button"].ds-button--primary.ds-button--circle';
  const BUTTON_SELECTOR = '[role="button"], button, .ds-button';
  const MAX_LEVELS = 6;
  const POLL_MS = 1000;

  const labelOf = (button) => String(button.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const classesOf = (button) => String(button.getAttribute?.('class') ?? '');

  // A toggle is on when it says so (aria-pressed/aria-checked) or carries a selected/active class.
  function isOn(button) {
    if (button.getAttribute?.('aria-pressed') === 'true' || button.getAttribute?.('aria-checked') === 'true') return true;
    return /(^|[\s_-])(selected|active|checked)($|[\s_-])/i.test(classesOf(button));
  }

  // The nearest container around the composer that holds labelled buttons, minus the Send control;
  // a button nested in another candidate counts once.
  function modeButtons() {
    const input = document.querySelector(COMPOSER_SELECTOR);
    let scope = input?.parentElement ?? null;
    for (let level = 0; scope && level < MAX_LEVELS; level += 1, scope = scope.parentElement) {
      const all = [...scope.querySelectorAll(BUTTON_SELECTOR)];
      const found = all.filter((button) => labelOf(button)
        && !button.matches?.(SEND_SELECTOR)
        && !all.some((other) => other !== button && other.contains?.(button)));
      if (found.length > 0) return found;
    }
    return null;
  }

  function readModel() {
    const buttons = modeButtons();
    if (buttons === null) return null;
    const on = buttons.filter(isOn).map(labelOf);
    return { model: 'DeepSeek', mode: on.length > 0 ? on.join(' · ') : 'Default' };
  }

  let last = '';
  function report() {
    if (!chrome.runtime?.id) return;
    const model = readModel();
    const signature = JSON.stringify(model);
    if (model === null || signature === last) return;
    last = signature;
    try {
      void chrome.runtime.sendMessage({ type: 'model.status', model }).catch(() => {});
    } catch {}
  }

  report();
  setInterval(report, POLL_MS);
})();
