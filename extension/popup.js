const $ = (selector) => document.querySelector(selector);
let fullAccessUntil = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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

$('#work').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.runtime.sendMessage({ type: 'work.ui-toggle', tabId: tab.id });
  await refreshWork();
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

await refreshWork();
applySettings(await control('status'));
setInterval(() => {
  void refreshWork();
  renderFullAccess();
}, 1000);
