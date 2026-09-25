(() => {
  'use strict';

  if (window.top === window || location.origin !== 'https://chatgpt.com') return;

  const parentOrigin = `chrome-extension://${chrome.runtime.id}`;
  const ancestorOrigin = location.ancestorOrigins?.[0] || (() => {
    try { return new URL(document.referrer || 'about:blank').origin; }
    catch { return ''; }
  })();
  if (ancestorOrigin !== parentOrigin) return;

  const LAST_URL_KEY = 'chatgptEmbeddedPanel.lastUrl';
  const documentId = crypto.randomUUID();
  let lastPersisted = '';

  function sanitizedCurrentUrl() {
    try {
      const url = new URL(location.href);
      if (url.origin !== 'https://chatgpt.com' || /^\/(api|backend-api|cdn)(\/|$)/.test(url.pathname)) {
        return null;
      }
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function persistCurrentUrl() {
    const href = sanitizedCurrentUrl();
    if (!href || href === lastPersisted) return;
    lastPersisted = href;
    void chrome.storage.local.set({ [LAST_URL_KEY]: href });
  }

  function announce(stage) {
    window.parent.postMessage({
      type: 'chatgpt-embedded-panel:ready',
      documentId,
      stage,
      path: location.pathname,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      readyState: document.readyState,
    }, parentOrigin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const message = event.data;
    if (message?.type !== 'chatgpt-embedded-panel:ping') return;

    window.parent.postMessage({
      type: 'chatgpt-embedded-panel:pong',
      documentId,
      requestId: message.requestId,
      readyState: document.readyState,
      path: location.pathname,
    }, parentOrigin);
  });

  // model-probe.js (MAIN world) posts model-name events to its own window; forward only the
  // whitelisted fields to the panel.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.source !== 'chatgpt-embedded-panel:model') return;
    window.parent.postMessage({
      type: 'chatgpt-embedded-panel:model',
      event: {
        type: message.type,
        turnId: message.turnId,
        requestedModel: message.requestedModel,
        requestedEffort: message.requestedEffort,
        actualModel: message.actualModel,
        actualEffort: message.actualEffort,
        sourceField: message.sourceField,
      },
    }, parentOrigin);
  });

  announce('document_start');
  persistCurrentUrl();

  document.addEventListener('DOMContentLoaded', () => {
    announce('dom_content_loaded');
    persistCurrentUrl();
  }, { once: true });

  window.addEventListener('load', () => {
    announce('window_load');
    persistCurrentUrl();
  }, { once: true });

  window.addEventListener('pageshow', () => {
    announce('pageshow');
    persistCurrentUrl();
  });

  window.addEventListener('popstate', persistCurrentUrl);
  window.addEventListener('hashchange', persistCurrentUrl);
  setInterval(persistCurrentUrl, 500);
})();
