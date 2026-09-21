// Local-runtime settings shown in the Side Panel: workspace folder, Full access, uninstall.
// (These used to live in the toolbar popup; the toolbar icon now opens the panel directly.)

const $ = (selector) => document.querySelector(selector);

// A browser extension cannot install the local program itself; the shortest way back is the
// same one-line command the README shows.
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/zengtao227/deepseek-webmcp/main/install.sh | bash';

let fullAccessUntil = null;
let localMissing = false;

const control = (name, args) => chrome.runtime.sendMessage({ type: 'settings.control', control: name, arguments: args });

function showMessage(text) {
  $('#settings-message').textContent = text;
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

export async function initSettings() {
  // macOS dialogs take focus; the background finishes the request and the panel shows the result.
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

  $('#full-stop').addEventListener('click', async () => {
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
      // Nothing local is left to remove. Called before any await so it still runs inside this
      // click (Chrome requires a user gesture for uninstall dialogs).
      chrome.management.uninstallSelf({ showConfirmDialog: true }).catch(() => showMessage('The extension was not removed.'));
      return;
    }
    showMessage('Confirm in the macOS dialog…');
    const response = await control('uninstall');
    if (response?.ok && response.result.uninstalled) showMessage('Uninstalled. The extension removes itself now.');
    else showMessage(response?.ok ? 'Not uninstalled.' : (response?.error?.message ?? 'Uninstall failed.'));
  });

  applySettings(await control('status'));
  setInterval(renderFullAccess, 1000);
}
