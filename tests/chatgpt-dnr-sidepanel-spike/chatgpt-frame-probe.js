(() => {
  'use strict';

  function report(stage) {
    chrome.runtime.sendMessage({
      type: 'chatgpt-dnr-spike.frame-ready',
      stage,
      isTop: window.top === window,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      readyState: document.readyState,
      path: location.pathname
    }).catch(() => {});
  }

  report('document_start');
  window.addEventListener('DOMContentLoaded', () => report('dom_content_loaded'), { once: true });
  window.addEventListener('load', () => report('window_load'), { once: true });
})();
