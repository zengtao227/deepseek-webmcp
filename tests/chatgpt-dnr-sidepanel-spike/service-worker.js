const RULE_ID = 41001;
const MODE_KEY = 'chatgptScopedDnr.mode';
const SIDEPANEL_URL = chrome.runtime.getURL('sidepanel.html');

async function enableActionOpen() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

function responseHeadersFor(mode) {
  if (mode === 'xfo') {
    return [
      { header: 'x-frame-options', operation: 'remove' }
    ];
  }
  if (mode === 'xfo-csp') {
    return [
      { header: 'x-frame-options', operation: 'remove' },
      { header: 'content-security-policy', operation: 'remove' }
    ];
  }
  return null;
}

async function setMode(mode) {
  const responseHeaders = responseHeadersFor(mode);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: responseHeaders ? [{
      id: RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders
      },
      condition: {
        requestDomains: ['chatgpt.com'],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['sub_frame']
      }
    }] : []
  });
  await chrome.storage.session.set({ [MODE_KEY]: mode });
  return status();
}

async function status() {
  const [rules, stored] = await Promise.all([
    chrome.declarativeNetRequest.getSessionRules(),
    chrome.storage.session.get(MODE_KEY)
  ]);
  return {
    ok: true,
    mode: stored[MODE_KEY] ?? 'off',
    runtimeId: chrome.runtime.id,
    rule: rules.find((rule) => rule.id === RULE_ID) ?? null
  };
}

function isSidePanel(sender) {
  return !sender.tab && sender.url === SIDEPANEL_URL;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isSidePanel(sender) || !message || typeof message !== 'object') return false;

  let reply;
  if (message.type === 'dnr.status') reply = status();
  else if (message.type === 'dnr.set-mode' && ['off', 'xfo', 'xfo-csp'].includes(message.mode)) reply = setMode(message.mode);
  else return false;

  Promise.resolve(reply).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: String(error?.message ?? error) });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void enableActionOpen();
});

chrome.runtime.onStartup.addListener(() => {
  void enableActionOpen();
});

void enableActionOpen();
