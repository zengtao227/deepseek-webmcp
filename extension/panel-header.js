// The Provider selector at the top of every WebMCP Side Panel page (Unified Side Panel, U1).
// Each provider has its own page; choosing a provider opens that page in the panel.
export const PROVIDER_KEY = 'provider.id';
export const PROVIDER_PAGES = Object.freeze({ deepseek: 'sidepanel.html', chatgpt: 'sidepanel-chatgpt.html' });

export function providerOf(stored) {
  return Object.hasOwn(PROVIDER_PAGES, stored) ? stored : 'chatgpt';
}

// Opens the selected provider's page when this page is not it. Resolves only when this page stays.
export async function routeToProviderPage(page) {
  const provider = providerOf((await chrome.storage.local.get(PROVIDER_KEY))[PROVIDER_KEY]);
  if (PROVIDER_PAGES[provider] === page) return provider;
  location.replace(PROVIDER_PAGES[provider]);
  return new Promise(() => {});
}

// Owner decision 2026-09-26: high authority belongs to the provider in use. Both providers share one
// local runtime, so switching ends Full / Host Access before the other provider's page opens.
export function mountProviderSelect(select, provider) {
  select.value = provider;
  select.addEventListener('change', async () => {
    const next = providerOf(select.value);
    await revokeHighAccess(await readAccessStatus());
    await chrome.storage.local.set({ [PROVIDER_KEY]: next });
    location.replace(PROVIDER_PAGES[next]);
  });
}

// Header line 4 (Unified Side Panel header contract): the security context of the local runtime,
// from the same status the settings already read. Colors are fixed for every provider:
// WRITE emphasized, FULL ACCESS orange, HOST ACCESS red; an unverified host lease shows in red;
// an expired lease disappears.
const UNVERIFIED_HOST = new Set(['unverified', 'config_changed', 'invalid']);
const minutesLeft = (until, now) => `${Math.max(1, Math.ceil((until - now) / 60000))}m`;
const folderName = (folder) => String(folder ?? '').split('/').filter(Boolean).pop() || String(folder ?? '');

// This runtime always mounts the chosen folder writable (native/host/docker-dispatch.js), so the
// folder carries WRITE. Full access replaces the folder with the home folder; Host access does not.
export function accessParts(status, now) {
  if (!status || typeof status.folder !== 'string') return null;
  const fullOn = Number.isFinite(status.fullAccessUntil) && status.fullAccessUntil > now;
  const hostOn = hostLeaseOn(status, now);
  const parts = fullOn
    ? [{ text: 'Home', kind: 'mount' }, { text: `FULL ACCESS ${minutesLeft(status.fullAccessUntil, now)}`, kind: 'full' }]
    : [{ text: folderName(status.folder), kind: 'mount' }, { text: 'WRITE', kind: 'write' }];
  if (hostOn) parts.push({ text: `HOST ACCESS ${minutesLeft(status.hostAccessUntil, now)}`, kind: 'host' });
  else if (UNVERIFIED_HOST.has(status.hostAccessState)) parts.push({ text: 'HOST ACCESS UNVERIFIED', kind: 'host' });
  return parts;
}

const hostLeaseOn = (status, now) => status?.hostAccessState === 'active' && Number.isFinite(status.hostAccessUntil) && status.hostAccessUntil > now;

// The controls that end Full / Host Access, the most dangerous first. Revoking only lowers
// authority, so the panel may do it; granting stays behind the macOS dialog in Settings.
export function highAccessControls(status, now) {
  if (!status) return [];
  const controls = [];
  if (hostLeaseOn(status, now) || UNVERIFIED_HOST.has(status.hostAccessState)) controls.push('stop-host-access');
  if (Number.isFinite(status.fullAccessUntil) && status.fullAccessUntil > now) controls.push('stop-full-access');
  return controls;
}

async function readAccessStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'settings.control', control: 'status' }).catch(() => null);
  return response?.ok ? response.result : null;
}

async function revokeHighAccess(status) {
  for (const control of highAccessControls(status, Date.now())) {
    await chrome.runtime.sendMessage({ type: 'settings.control', control }).catch(() => null);
  }
}

function renderAccess(element, status, now) {
  const parts = accessParts(status, now);
  if (!parts) {
    element.textContent = 'Access: local runtime not reachable';
    return;
  }
  const nodes = [document.createTextNode('Access: ')];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(document.createTextNode(' · '));
    const span = document.createElement('span');
    span.className = `access-${part.kind}`;
    span.textContent = part.text;
    nodes.push(span);
  });
  element.replaceChildren(...nodes);
}

// Countdowns tick every second; the status itself is re-read every 30 s and whenever the panel
// becomes visible again.
// The Revoke button is rebuilt only when the set of leases changes, never by the 1 s countdown,
// so a click cannot land on a button that is being replaced.
export function startAccessLine(element) {
  let status = null;
  let revokeSignature = '';
  const text = document.createElement('span');
  const revoke = document.createElement('span');
  element.replaceChildren(text, revoke);
  const render = () => {
    const now = Date.now();
    renderAccess(text, status, now);
    const controls = highAccessControls(status, now);
    if (controls.join() === revokeSignature) return;
    revokeSignature = controls.join();
    if (controls.length === 0) {
      revoke.replaceChildren();
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'access-revoke';
    button.textContent = 'Revoke';
    button.title = 'End Full Access / Host Access now';
    button.addEventListener('click', async () => {
      button.disabled = true;
      await revokeHighAccess(status);
      await load();
    });
    revoke.replaceChildren(button);
  };
  const load = async () => {
    status = await readAccessStatus();
    render();
  };
  void load();
  setInterval(render, 1000);
  setInterval(() => { void load(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load(); });
}
