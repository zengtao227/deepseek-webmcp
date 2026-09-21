(() => {
  'use strict';

  chrome.runtime.sendMessage({
    type: 'chatgpt-direct-spike.frame-ready',
    isTop: window.top === window,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    readyState: document.readyState,
    path: location.pathname
  }).catch(() => {});
})();
