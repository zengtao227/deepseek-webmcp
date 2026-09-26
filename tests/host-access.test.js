import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearInstanceLease, dispatchHostCommand, grantHostAccess, hostRuntimeRoot, instanceLeaseStatus, removeExtensionInstance } from '../native/host/host-access.js';

const PINNED = `${'a'.repeat(40)}-${'b'.repeat(64)}`;
const OTHER = `${'c'.repeat(40)}-${'d'.repeat(64)}`;

// Stub release modules record which release served each call, so the tests can prove
// DeepSeek resolves only through its pinned artifact.
const STUBS = {
  'adapter/deploy/deploy-host-runtime.js': `export async function verifyRelease(root, options) {
    (globalThis.hostAccessCalls ??= []).push(['verify', root, options.expectedArtifactId]);
    return { entrypoint: root + '/native/host/start.js' };
  }`,
  'native/deploy/instance-context.js': `import path from 'node:path';
  export function createInstanceContext({ home, instanceId }) {
    const stateRoot = path.join(home, 'state', instanceId);
    return { instanceId, hostRuntimeRoot: path.join(home, '.local/share/webmcp/host-runtime'), hostReleasePin: path.join(stateRoot, 'host-release.json'), elevatedLease: path.join(stateRoot, 'lease.json'), workspaceConfig: path.join(stateRoot, 'workspace.json') };
  }`,
  'native/deploy/instance-release.js': `import { readFile } from 'node:fs/promises';
  import path from 'node:path';
  export async function verifyPinnedInstanceRelease(context) {
    const pin = JSON.parse(await readFile(context.hostReleasePin, 'utf8'));
    return { artifactId: pin.artifactId, releaseRoot: path.join(context.hostRuntimeRoot, 'releases', pin.artifactId) };
  }`,
  'native/deploy/elevated-access.js': `export async function getBootSessionId() { return 'boot'; }
  export async function getLoginSessionId() { return 'login'; }
  export async function loadElevatedLease(_path, options) {
    (globalThis.hostAccessRecords ??= []).push(['lease', options?.normalConfig?.hostRoot]);
    return globalThis.hostAccessLease ?? { state: 'absent' };
  }
  export function createElevatedLease({ durationMs }) { return { id: 'lease', expiresAt: new Date(Date.now() + durationMs).toISOString() }; }
  export async function persistElevatedLease() {}
  export async function clearElevatedLease() { (globalThis.hostAccessRecords ??= []).push(['clear']); }`,
  'native/deploy/workspace-config.js': `export async function loadWorkspaceConfig() {
    if (globalThis.hostAccessWorkspace) return globalThis.hostAccessWorkspace;
    const error = new Error('absent'); error.code = 'WORKSPACE_CONFIG_UNAVAILABLE'; error.cause = { code: 'ENOENT' }; throw error;
  }
  export async function persistWorkspaceConfig(_path, value) { (globalThis.hostAccessRecords ??= []).push(['persist', value.hostRoot]); return value; }`,
  'native/deploy/local-approval.js': `export async function requestLocalElevationApproval(options) {
    (globalThis.hostAccessCalls ??= []).push(['approve', import.meta.url, options.instanceLabel, Object.keys(options).sort()]);
  }`,
  'native/host/host-command.js': `export function createHostCommandHandler(options) {
    return { call: async () => ({ structuredContent: { ran: options.expectedLeaseId } }) };
  }`,
  'native/deploy/instance-lock.js': 'export async function withInstanceLifecycleLock(_context, run) { return run(); }',
};

async function writeRelease(home, artifactId) {
  const root = path.join(hostRuntimeRoot(home), 'releases', artifactId);
  for (const [file, text] of Object.entries(STUBS)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `${text}\n`);
  }
  return root;
}

async function withHome(run, { lockArtifact = PINNED, pinArtifact = PINNED } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-host-access-'));
  globalThis.hostAccessCalls = [];
  globalThis.hostAccessRecords = [];
  globalThis.hostAccessLease = null;
  globalThis.hostAccessWorkspace = null;
  try {
    const pinnedRoot = await writeRelease(home, PINNED);
    const otherRoot = await writeRelease(home, OTHER);
    // The default instance's current pointer names a different release on purpose.
    await symlink(path.join('releases', OTHER), path.join(hostRuntimeRoot(home), 'current'));
    await mkdir(path.join(home, 'state', 'webmcp'), { recursive: true });
    await writeFile(path.join(home, 'state', 'webmcp', 'host-release.json'), JSON.stringify({ version: 1, artifactId: pinArtifact }));
    const workspace = path.join(home, 'work');
    await mkdir(workspace);
    const configFile = path.join(home, 'config.json');
    await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace }));
    const lockFile = path.join(home, 'runtime.lock.json');
    await writeFile(lockFile, JSON.stringify(lockArtifact ? { artifactId: lockArtifact, archiveSha256: 'e'.repeat(64) } : {}));
    await run({ home, configFile, lockFile, pinnedRoot, otherRoot });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('host access resolves through the pinned artifact, never the shared current pointer', async () => {
  await withHome(async ({ home, configFile, lockFile, otherRoot }) => {
    const granted = await grantHostAccess({ configFile, minutes: 5, home, lockFile });
    assert.equal(granted.hostAccessState, 'active');
    const served = globalThis.hostAccessCalls.map((call) => call[1]);
    assert.ok(served.length > 0);
    assert.ok(served.every((where) => where.includes(PINNED) && !where.includes(OTHER)), served.join('\n'));
    assert.ok(!served.some((where) => where.startsWith(otherRoot)));
    const approve = globalThis.hostAccessCalls.find((call) => call[0] === 'approve');
    // Runtime v0.3.0: Host Access is the only grant, so the approval takes no level or root.
    assert.deepEqual(approve.slice(2), ['DeepSeek', ['durationMs', 'instanceLabel']]);
  });
});

test('host access works when no current pointer exists at all', async () => {
  await withHome(async ({ home, configFile, lockFile }) => {
    await rm(path.join(hostRuntimeRoot(home), 'current'));
    assert.equal((await grantHostAccess({ configFile, minutes: 1, home, lockFile })).hostAccessState, 'active');
  });
});

test('host access fails closed without a pinned artifact or with a mismatched instance pin', async () => {
  const request = { version: 1, id: 'r1', tool: 'host_command', arguments: { command: 'true' } };
  await withHome(async ({ home, configFile, lockFile }) => {
    assert.equal((await dispatchHostCommand(request, { configFile, home, lockFile })).ok, false);
    await assert.rejects(grantHostAccess({ configFile, minutes: 1, home, lockFile }), /does not pin/);
  }, { lockArtifact: null });
  await withHome(async ({ home, configFile, lockFile }) => {
    assert.equal((await dispatchHostCommand(request, { configFile, home, lockFile })).ok, false);
    await assert.rejects(grantHostAccess({ configFile, minutes: 1, home, lockFile }), /does not match/);
  }, { pinArtifact: OTHER });
});

test('host_command and a grant use the instance\'s own folder, which the WebMCP App may have changed', async () => {
  const request = { version: 1, id: 'r1', tool: 'host_command', arguments: { command: 'true' } };
  await withHome(async ({ home, configFile, lockFile }) => {
    globalThis.hostAccessWorkspace = { version: 1, hostRoot: '/Users/me/App-chosen', mode: 'workspace', readOnly: false };
    assert.equal((await dispatchHostCommand(request, { configFile, home, lockFile })).ok, false, 'no lease, no command');

    globalThis.hostAccessLease = { state: 'active', lease: { id: 'lease-1', accessLevel: 'full-host' } };
    const allowed = await dispatchHostCommand(request, { configFile, home, lockFile });
    assert.deepEqual(allowed.result, { ran: 'lease-1' });
    assert.ok(globalThis.hostAccessRecords.some((call) => call[0] === 'lease' && call[1] === '/Users/me/App-chosen'));

    globalThis.hostAccessLease = { state: 'active', lease: { id: 'lease-2', accessLevel: 'docker-full' } };
    assert.equal((await dispatchHostCommand(request, { configFile, home, lockFile })).ok, false, 'Full Working Access is not Host Access');

    globalThis.hostAccessLease = null;
    globalThis.hostAccessRecords = [];
    await grantHostAccess({ configFile, minutes: 1, home, lockFile });
    assert.ok(!globalThis.hostAccessRecords.some((call) => call[0] === 'persist'), 'the App-managed folder is not overwritten');
  });
});

test('the lease is read and cleared without Docker, as host_command reads it', async () => {
  await withHome(async ({ home, lockFile }) => {
    globalThis.hostAccessWorkspace = { version: 1, hostRoot: '/Users/me/p', mode: 'workspace', readOnly: false };
    globalThis.hostAccessLease = { state: 'active', lease: { id: 'l', accessLevel: 'full-host', expiresAt: 5000 } };
    assert.deepEqual(await instanceLeaseStatus({ home, lockFile }), { mode: 'elevated', accessLevel: 'full-host', expiresAt: new Date(5000).toISOString() });
    globalThis.hostAccessLease = { state: 'active', lease: { id: 'l', expiresAt: 5000 } };
    assert.equal((await instanceLeaseStatus({ home, lockFile })).accessLevel, 'docker-full');
    globalThis.hostAccessLease = { state: 'rebooted' };
    assert.deepEqual(await instanceLeaseStatus({ home, lockFile }), { mode: 'stale', leaseState: 'rebooted' });
    await clearInstanceLease({ home, lockFile });
    assert.ok(globalThis.hostAccessRecords.some((call) => call[0] === 'clear'));
  });
});

async function uninstallFixture({ otherPins = {}, currentTo = null } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-uninstall-'));
  const data = path.join(home, '.local/share/webmcp');
  for (const id of [PINNED, OTHER]) await mkdir(path.join(hostRuntimeRoot(home), 'releases', id), { recursive: true });
  if (currentTo) await symlink(path.join('releases', currentTo), path.join(hostRuntimeRoot(home), 'current'));
  for (const [instance, artifactId] of Object.entries({ webmcp: PINNED, ...otherPins })) {
    await mkdir(path.join(data, 'instances', instance), { recursive: true });
    await writeFile(path.join(data, 'instances', instance, 'host-release.json'), JSON.stringify({ version: 1, artifactId }));
  }
  await mkdir(path.join(home, '.config/webmcp/instances/webmcp'), { recursive: true });
  await mkdir(path.join(home, '.config/webmcp/instances/prism'), { recursive: true });
  return home;
}

test('uninstall removes only the extension\'s own instance state and never deletes a shared release', async () => {
  // Whether or not anything else pins DeepSeek's release, whatever current points at, and even
  // when another pin is unreadable: releases and other providers' state stay.
  for (const setup of [{}, { otherPins: { prism: OTHER }, currentTo: OTHER }, { otherPins: { prism: PINNED } }, { currentTo: PINNED }, { otherPins: { prism: '{broken' } }]) {
    const home = await uninstallFixture(setup);
    try {
      await removeExtensionInstance(home);
      await assert.rejects(lstat(path.join(home, '.local/share/webmcp/instances/webmcp')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(home, '.config/webmcp/instances/webmcp')), { code: 'ENOENT' });
      assert.deepEqual((await readdir(path.join(hostRuntimeRoot(home), 'releases'))).sort(), [PINNED, OTHER].sort(), JSON.stringify(setup));
      await lstat(path.join(home, '.config/webmcp/instances/prism'));
      if (setup.otherPins) await lstat(path.join(home, '.local/share/webmcp/instances/prism/host-release.json'));
      if (setup.currentTo) await lstat(path.join(hostRuntimeRoot(home), 'current'));
      await removeExtensionInstance(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
