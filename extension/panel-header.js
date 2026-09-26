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
// An unreadable status means the local program is unreachable, so no provider can use the access and
// the switch goes ahead; a revoke that failed keeps the current provider (owner decision, C2).
export function mountProviderSelect(select, provider, notify = () => {}) {
  select.value = provider;
  select.addEventListener('change', async () => {
    const next = providerOf(select.value);
    if (!(await revokeHighAccess(await readAccessStatus()))) {
      select.value = provider;
      notify('Full / Host Access could not be revoked, so the Provider was not switched. Try again, or revoke it in Settings.');
      return;
    }
    await chrome.storage.local.set({ [PROVIDER_KEY]: next });
    location.replace(PROVIDER_PAGES[next]);
  });
}

// Header line 4 (Unified Side Panel header contract): the security context of the local runtime,
// from the same status the settings already read. Colors are fixed for every provider:
// WRITE emphasized, HOST ACCESS red; a lease that cannot be verified shows in red; an expired
// lease disappears. The only lease is Host Access; when it cannot be verified it is shown (and
// revoked) as ACCESS UNVERIFIED.
const UNVERIFIED_LEASE = new Set(['unverified', 'invalid', 'rebooted', 'login_restarted', 'config_changed', 'instance_changed']);
const minutesLeft = (until, now) => `${Math.max(1, Math.ceil((until - now) / 60000))}m`;
const folderName = (folder) => String(folder ?? '').split('/').filter(Boolean).pop() || String(folder ?? '');
const leaseOn = (until, now) => Number.isFinite(until) && until > now;

// Each folder carries its own write switch. Host Access adds host_command and never changes the
// container, so the folders stay as they are.
export function accessParts(status, now) {
  if (!status || status.leaseState === 'unavailable') return null;
  const parts = folderParts(status.folders);
  if (leaseOn(status.hostAccessUntil, now)) parts.push({ text: `HOST ACCESS ${minutesLeft(status.hostAccessUntil, now)}`, kind: 'host' });
  else if (UNVERIFIED_LEASE.has(status.leaseState)) parts.push({ text: 'ACCESS UNVERIFIED', kind: 'host' });
  return parts;
}

function folderParts(folders) {
  if (!Array.isArray(folders)) return [{ text: 'folders unknown', kind: 'mount' }];
  if (folders.length === 0) return [{ text: 'no folder', kind: 'mount' }];
  return folders.flatMap((folder) => [
    { text: folderName(folder.path), kind: 'mount' },
    folder.write ? { text: 'WRITE', kind: 'write' } : { text: 'READ', kind: 'read' },
  ]);
}

// The control that ends Host Access. Revoking only lowers authority, so the panel may do it;
// granting happens only in the WebMCP App behind the macOS dialog.
export function highAccessControls(status, now) {
  if (!status) return [];
  const controls = [];
  if (leaseOn(status.hostAccessUntil, now) || UNVERIFIED_LEASE.has(status.leaseState)) controls.push('stop-host-access');
  return controls;
}

async function readAccessStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'settings.control', control: 'status' }).catch(() => null);
  return response?.ok ? response.result : null;
}

// True when every lease that was on is now ended.
async function revokeHighAccess(status) {
  let revoked = true;
  for (const control of highAccessControls(status, Date.now())) {
    const response = await chrome.runtime.sendMessage({ type: 'settings.control', control }).catch(() => null);
    if (response?.ok !== true) revoked = false;
  }
  return revoked;
}

function renderAccess(element, status, now) {
  const parts = accessParts(status, now);
  if (!parts) {
    element.textContent = status?.leaseState === 'unavailable' ? 'Access: WebMCP instance not ready' : 'Access: local runtime not reachable';
    return;
  }
  const nodes = [document.createTextNode('Access: ')];
  parts.forEach((part, index) => {
    // A write switch belongs to the folder before it.
    if (index > 0) nodes.push(document.createTextNode(['write', 'read'].includes(part.kind) ? ' ' : ' · '));
    const span = document.createElement('span');
    span.className = `access-${part.kind}`;
    span.textContent = part.text;
    nodes.push(span);
  });
  element.replaceChildren(...nodes);
}

// Countdowns tick every second; the status itself is re-read every 30 s and whenever the panel
// becomes visible again.
// One Revoke button, shown only while Full / Host Access is on.
export function startAccessLine(element) {
  let status = null;
  const text = document.createElement('span');
  const revoke = document.createElement('button');
  revoke.type = 'button';
  revoke.className = 'access-revoke';
  revoke.textContent = 'Revoke';
  revoke.title = 'End Host Access now';
  revoke.hidden = true;
  revoke.addEventListener('click', async () => {
    revoke.disabled = true;
    await revokeHighAccess(status);
    await load();
    revoke.disabled = false;
  });
  element.replaceChildren(text, revoke);
  const render = () => {
    const now = Date.now();
    renderAccess(text, status, now);
    revoke.hidden = highAccessControls(status, now).length === 0;
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
