// Local-runtime settings shown in the Side Panel: the folder (WSL only), uninstall.
// (These used to live in the toolbar popup; the toolbar icon now opens the panel directly.)

const $ = (selector) => document.querySelector(selector);

// A browser extension cannot install the local program itself; the shortest way back is the
// same one-line command the README shows.
const INSTALL_COMMAND = 'cd ~ && curl -fsSLO https://github.com/zengtao227/deepseek-webmcp/releases/latest/download/install.sh && bash install.sh';

let localMissing = false;

const control = (name, args) => chrome.runtime.sendMessage({ type: 'settings.control', control: name, arguments: args });

function showMessage(text) {
  $('#settings-message').textContent = text;
}

// On macOS the WebMCP App owns folders, Write and Host Access; the panel's header shows them and
// offers Revoke. WSL has no App, so there the panel still chooses the folder.
function applySettings(response) {
  localMissing = response?.error?.code === 'LOCAL_PROGRAM_MISSING';
  $('#copy-install').hidden = !localMissing;
  if (!response?.ok) {
    $('#folder').textContent = localMissing ? 'Local program not installed' : 'Local runtime not reachable';
    showMessage(response?.error?.message ?? 'Local runtime not reachable.');
    return;
  }
  const chooseFolder = response.result.capabilities?.chooseFolder === true;
  $('#choose').hidden = !chooseFolder;
  $('#folder').textContent = chooseFolder ? response.result.folder : 'Folders and Host Access: WebMCP App (menu bar)';
  $('#folder').title = chooseFolder ? response.result.folder : '';
}

export async function initSettings() {
  // The Windows folder dialog takes focus; the background finishes the request and the panel shows the result.
  $('#choose').addEventListener('click', async () => {
    showMessage('Choose a folder in the dialog…');
    const response = await control('choose-folder');
    applySettings(response);
    if (response?.ok) showMessage(response.result.changed ? 'Folder changed.' : '');
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
    showMessage('Confirm in the dialog…');
    const response = await control('uninstall');
    if (response?.ok && response.result.uninstalled) showMessage('Uninstalled. The extension removes itself now.');
    else showMessage(response?.ok ? 'Not uninstalled.' : (response?.error?.message ?? 'Uninstall failed.'));
  });

  applySettings(await control('status'));
}
