const statusElement = document.querySelector('#status');
const armButton = document.querySelector('#arm');
const disarmButton = document.querySelector('#disarm');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function refresh() {
  const tab = await activeTab();
  if (!tab?.id || !tab.url?.startsWith('https://chat.deepseek.com/')) {
    statusElement.textContent = 'Open a chat.deepseek.com conversation first.';
    armButton.disabled = true;
    disarmButton.disabled = true;
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'p1.ui-status', tabId: tab.id });
  statusElement.textContent = JSON.stringify(result, null, 2);
  armButton.disabled = result?.status?.armed === true;
  disarmButton.disabled = result?.status?.armed !== true;
}

armButton.addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.runtime.sendMessage({ type: 'p1.ui-arm', tabId: tab.id });
  await refresh();
});

disarmButton.addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.runtime.sendMessage({ type: 'p1.ui-disarm', tabId: tab.id });
  await refresh();
});

await refresh();
