const workButton = document.querySelector('#work');
const summaryElement = document.querySelector('#summary');
const statusElement = document.querySelector('#status');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function refresh() {
  const tab = await activeTab();
  if (!tab?.id || !tab.url?.startsWith('https://chat.deepseek.com/')) {
    workButton.disabled = true;
    summaryElement.textContent = 'Open chat.deepseek.com in this tab first.';
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'work.ui-status', tabId: tab.id });
  const on = result?.status?.work === true;
  workButton.disabled = false;
  workButton.classList.toggle('on', on);
  workButton.textContent = on ? 'Working — click to stop' : 'Work';
  summaryElement.textContent = on ? `Tool calls in this tab: ${result.status.calls}` : 'Off for this tab.';
  statusElement.textContent = JSON.stringify(result, null, 2);
}

workButton.addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.runtime.sendMessage({ type: 'work.ui-toggle', tabId: tab.id });
  await refresh();
});

await refresh();
setInterval(() => void refresh(), 1000);
