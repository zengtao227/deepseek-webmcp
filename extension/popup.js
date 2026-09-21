const $ = (selector) => document.querySelector(selector);
let fullAccessUntil = null;
let attachedTarget = null;
let popupTab = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  popupTab = tab ?? null;
  return tab;
}

const control = (name, args) => chrome.runtime.sendMessage({ type: 'settings.control', control: name, arguments: args });

function showMessage(text) {
  $('#message').textContent = text;
}

function renderFullAccess() {
  const active = fullAccessUntil !== null && fullAccessUntil > Date.now();
  $('#full-off').hidden = active;
  $('#full-on').hidden = !active;
  if (active) {
    const seconds = Math.round((fullAccessUntil - Date.now()) / 1000);
    $('#full-active').textContent = `Active — ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
  }
}

// A browser extension cannot install the local program itself; the shortest way back
// is the same one-line command the README shows.
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/zengtao227/deepseek-webmcp/main/install.sh | bash';
let localMissing = false;

function applySettings(response) {
  localMissing = response?.error?.code === 'LOCAL_PROGRAM_MISSING';
  $('#copy-install').hidden = !localMissing;
  if (!response?.ok) {
    $('#folder').textContent = localMissing ? 'Local program not installed' : 'Local runtime not reachable';
    showMessage(response?.error?.message ?? 'Local runtime not reachable.');
    return;
  }
  $('#folder').textContent = response.result.folder;
  $('#folder').title = response.result.folder;
  fullAccessUntil = response.result.fullAccessUntil;
  renderFullAccess();
}

async function refreshWork() {
  const tab = await activeTab();
  if (!tab?.id || !tab.url?.startsWith('https://chat.deepseek.com/')) {
    $('#work').disabled = true;
    $('#work').classList.remove('on');
    $('#work').textContent = 'Work';
    $('#summary').textContent = 'Open chat.deepseek.com in this tab to use Work.';
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'work.ui-status', tabId: tab.id });
  const on = result?.status?.work === true;
  $('#work').disabled = false;
  $('#work').classList.toggle('on', on);
  $('#work').textContent = on ? 'Working — click to stop' : 'Work';
  $('#summary').textContent = on ? `Tool calls in this tab: ${result.status.calls}` : 'Off for this tab. Turn on, then type your task normally.';
  $('#status').textContent = JSON.stringify(result, null, 2);
}

async function refreshAssistant() {
  const tab = await activeTab();
  const ordinary = Number.isInteger(tab?.id)
    && /^https?:\/\//.test(tab.url ?? '')
    && !tab.url.startsWith('https://chat.deepseek.com/');
  $('#assistant').disabled = !ordinary;

  const status = await chrome.runtime.sendMessage({ type: 'assistant.status' }).catch(() => null);
  if (status?.session?.workTabId === tab?.id) {
    const state = status.session.state ?? 'preparing';
    $('#assistant-note').textContent = state === 'active'
      ? 'Assistant is bound to this page.'
      : 'Assistant session: ' + state + '.';
    return;
  }
  $('#assistant-note').textContent = ordinary
    ? 'Open the assistant beside this page; DeepSeek is managed in the background.'
    : 'Open an ordinary webpage to use the assistant beside it.';
}

async function refreshTarget() {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({ type: 'browser.target-status' });
  attachedTarget = result?.target ?? null;

  if (attachedTarget) {
    $('#target').textContent = `${attachedTarget.title || 'Attached page'} — ${attachedTarget.origin}`;
  } else {
    $('#target').textContent = 'No target attached.';
  }

  const onDeepSeek = tab?.url?.startsWith('https://chat.deepseek.com/');
  if (attachedTarget && (tab?.id === attachedTarget.tabId || onDeepSeek)) {
    $('#target-action').textContent = tab?.id === attachedTarget.tabId ? 'Detach this tab' : 'Detach target';
    $('#target-action').disabled = false;
    return;
  }

  $('#target-action').textContent = attachedTarget ? 'Attach this tab instead' : 'Attach this tab';
  $('#target-action').disabled = !tab?.id || onDeepSeek || !/^https?:\/\//.test(tab.url ?? '');
}

$('#assistant').addEventListener('click', () => {
  const tab = popupTab;
  if (!Number.isInteger(tab?.id)) return;

  // Keep this call in the synchronous user-gesture path. Provider creation and
  // health checks may take seconds and must not gate Chrome's sidePanel.open().
  const panel = chrome.sidePanel.open({ tabId: tab.id });
  const start = chrome.runtime.sendMessage({ type: 'assistant.open' });

  void Promise.all([panel, start]).then(([, response]) => {
    showMessage(response?.ok ? '' : (response?.error?.message ?? 'Assistant could not start.'));
    void refreshAssistant();
    void refreshTarget();
  }, (error) => {
    showMessage(error?.message ?? 'Assistant could not start.');
  });
});

$('#work').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.runtime.sendMessage({ type: 'work.ui-toggle', tabId: tab.id });
  await refreshWork();
});

$('#target-action').addEventListener('click', async () => {
  const tab = await activeTab();
  const onDeepSeek = tab?.url?.startsWith('https://chat.deepseek.com/');
  let response;
  if (attachedTarget && (tab?.id === attachedTarget.tabId || onDeepSeek)) {
    response = await chrome.runtime.sendMessage({ type: 'browser.target-detach' });
  } else {
    response = await chrome.runtime.sendMessage({ type: 'browser.target-attach' });
  }
  showMessage(response?.ok ? '' : (response?.error?.message ?? 'Target action failed.'));
  await refreshTarget();
});

// macOS dialogs take focus and may close this popup; the background finishes the
// request and the popup shows the result when it is opened again.
$('#choose').addEventListener('click', async () => {
  showMessage('Choose a folder in the macOS dialog…');
  const response = await control('choose-folder');
  applySettings(response);
  if (response?.ok) showMessage(response.result.changed ? 'Folder changed.' : '');
});

$('#grant').addEventListener('click', async () => {
  showMessage('Confirm in the macOS dialog…');
  const response = await control('grant-full-access', { minutes: Number($('#minutes').value) });
  applySettings(response);
  if (response?.ok) showMessage(response.result.changed ? 'Full access is on.' : 'Not changed.');
});

$('#stop').addEventListener('click', async () => {
  applySettings(await control('stop-full-access'));
  showMessage('Back to the folder.');
});

$('#copy-install').addEventListener('click', () => {
  navigator.clipboard.writeText(INSTALL_COMMAND).then(
    () => showMessage('Copied. Paste it into Terminal and press Enter.'),
    () => showMessage(INSTALL_COMMAND),
  );
});

$('#uninstall').addEventListener('click', async () => {
  if (localMissing) {
    // Nothing local is left to remove. Called before any await so it still runs inside
    // this click (Chrome requires a user gesture for uninstall dialogs).
    chrome.management.uninstallSelf({ showConfirmDialog: true }).catch(() => showMessage('The extension was not removed.'));
    return;
  }
  showMessage('Confirm in the macOS dialog…');
  const response = await control('uninstall');
  if (response?.ok && response.result.uninstalled) showMessage('Uninstalled. The extension removes itself now.');
  else showMessage(response?.ok ? 'Not uninstalled.' : (response?.error?.message ?? 'Uninstall failed.'));
});

await Promise.all([refreshWork(), refreshTarget(), refreshAssistant()]);
applySettings(await control('status'));
setInterval(() => {
  void refreshWork();
  void refreshTarget();
  void refreshAssistant();
  renderFullAccess();
}, 1000);
