import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleControlRequest } from '../native/host/control.js';
import { instanceAccessStatus, instanceAccessView, revokeInstanceAccess } from '../native/host/instance-access.js';
import { writePinnedRelease } from './fixtures/pinned-release.js';

const MOUNTS = {
  instanceId: 'deepseek',
  mode: 'multi-mount',
  mounts: [
    { id: 'code', hostPath: '/Users/me/Doc/My code', containerPath: '/workspace/mounts/code', writeEnabled: true },
    { id: 'notes', hostPath: '/Users/me/Notes', containerPath: '/workspace/mounts/notes', writeEnabled: false },
  ],
};
const NORMAL = { instanceId: 'deepseek', mode: 'normal', leaseState: 'absent' };
const EXPIRES = '2026-09-26T10:30:00.000Z';

test('the instance\'s folders keep their own write switch; a legacy folder follows its read-only flag', () => {
  assert.deepEqual(instanceAccessView(MOUNTS, NORMAL).folders, [
    { path: '/Users/me/Doc/My code', write: true },
    { path: '/Users/me/Notes', write: false },
  ]);
  const legacy = (legacyReadOnly) => instanceAccessView({ mode: 'legacy', legacyRoot: '/Users/me/p', legacyReadOnly, mounts: [] }, NORMAL).folders;
  assert.deepEqual(legacy(false), [{ path: '/Users/me/p', write: true }]);
  assert.deepEqual(legacy(true), [{ path: '/Users/me/p', write: false }]);
  assert.deepEqual(legacy(undefined), [{ path: '/Users/me/p', write: true }], 'an unknown switch never shows less authority');
});

test('one instance lease: Full Working Access or Host Access, and an unverifiable lease keeps its state name', () => {
  assert.deepEqual(instanceAccessView(MOUNTS, NORMAL), {
    folders: instanceAccessView(MOUNTS, NORMAL).folders,
    fullAccessUntil: null, hostAccessUntil: null, leaseState: 'absent', hostAccessState: 'absent',
  });
  const full = instanceAccessView(MOUNTS, { mode: 'elevated', accessLevel: 'docker-full', expiresAt: EXPIRES });
  assert.equal(full.fullAccessUntil, Date.parse(EXPIRES));
  assert.equal(full.hostAccessUntil, null);
  assert.equal(full.leaseState, 'active');
  assert.equal(full.hostAccessState, 'inactive');
  const host = instanceAccessView(MOUNTS, { mode: 'elevated', accessLevel: 'full-host', expiresAt: EXPIRES });
  assert.equal(host.hostAccessUntil, Date.parse(EXPIRES));
  assert.equal(host.fullAccessUntil, null);
  assert.equal(host.hostAccessState, 'active');
  const stale = instanceAccessView(MOUNTS, { mode: 'stale', leaseState: 'rebooted' });
  assert.equal(stale.leaseState, 'rebooted');
  assert.equal(stale.fullAccessUntil, null);
  assert.equal(stale.hostAccessUntil, null);
});

// A fake instance controller: answers mount-list / access-status from fixture files and records
// every command it ran.
const CONTROLLER = `import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [command, flag, instance] = process.argv.slice(2);
appendFileSync(path.join(here, 'calls.log'), [command, flag, instance].join(' ') + '\\n');
const answers = JSON.parse(readFileSync(path.join(here, 'answers.json'), 'utf8'));
if (!(command in answers)) { process.stderr.write('WebMCP local instance control failed [NOPE]: no'); process.exit(1); }
process.stdout.write(JSON.stringify(answers[command], null, 2) + '\\n');`;

async function withInstance(answers, run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-instance-access-'));
  try {
    const releaseRoot = await writePinnedRelease(home, { 'native/deploy/local-instance-controller.js': CONTROLLER });
    const deploy = path.join(releaseRoot, 'native', 'deploy');
    await writeFile(path.join(deploy, 'answers.json'), JSON.stringify(answers));
    const configFile = path.join(home, 'config.json');
    await writeFile(configFile, JSON.stringify({ workspaceRoot: '/Users/me/old', dockerPath: '/usr/local/bin/docker' }));
    const control = (name) => handleControlRequest({ version: 1, id: 'c', control: name, arguments: {} }, { home, configFile, kind: 'macos' });
    const calls = () => readFile(path.join(deploy, 'calls.log'), 'utf8').then((text) => text.trim().split('\n'), () => []);
    await run({ control, calls });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('on macOS the panel status is the deepseek instance\'s, read with the WebMCP App\'s controller commands', async () => {
  await withInstance({ 'mount-list': MOUNTS, 'access-status': { mode: 'elevated', accessLevel: 'full-host', expiresAt: EXPIRES } }, async ({ control, calls }) => {
    const { result } = await control('status');
    assert.deepEqual(result.folders, [{ path: '/Users/me/Doc/My code', write: true }, { path: '/Users/me/Notes', write: false }]);
    assert.equal(result.hostAccessUntil, Date.parse(EXPIRES));
    assert.equal(result.hostAccessState, 'active');
    assert.equal(result.fullAccessUntil, null);
    assert.deepEqual((await calls()).sort(), ['access-status --instance deepseek', 'mount-list --instance deepseek']);
  });
});

test('both stop controls revoke the instance\'s one lease through the controller', async () => {
  for (const name of ['stop-full-access', 'stop-host-access']) {
    await withInstance({ 'mount-list': MOUNTS, 'access-status': NORMAL, 'access-revoke': { action: 'revoked' } }, async ({ control, calls }) => {
      const { result } = await control(name);
      assert.equal(result.changed, true);
      assert.equal(result.leaseState, 'absent');
      assert.equal((await calls())[0], 'access-revoke --instance deepseek', name);
    });
  }
});

test('a controller that fails makes the status unavailable and a revoke an error, never a silent success', async () => {
  await withInstance({}, async ({ control }) => {
    const { result } = await control('status');
    assert.equal(result.folders, null);
    assert.equal(result.leaseState, 'unavailable');
    await assert.rejects(control('stop-host-access'), { code: 'INSTANCE_CONTROL_FAILED' });
  });
});

test('folders that cannot be read never hide the lease or its Revoke', async () => {
  await withInstance({ 'access-status': { mode: 'elevated', accessLevel: 'full-host', expiresAt: EXPIRES } }, async ({ control }) => {
    const { result } = await control('status');
    assert.equal(result.folders, null);
    assert.equal(result.hostAccessUntil, Date.parse(EXPIRES));
    const { accessParts, highAccessControls } = await import('../extension/panel-header.js');
    const now = Date.parse(EXPIRES) - 5 * 60000;
    assert.deepEqual(accessParts(result, now).map((part) => part.text), ['Home', 'HOST ACCESS 5m']);
    assert.deepEqual(highAccessControls(result, now), ['stop-host-access']);
  });
});

test('a revoke runs the controller once, then the status is read once', async () => {
  await withInstance({ 'mount-list': MOUNTS, 'access-status': NORMAL, 'access-revoke': { action: 'revoked' } }, async ({ control, calls }) => {
    await control('stop-host-access');
    assert.deepEqual((await calls()).slice(1).sort(), ['access-status --instance deepseek', 'mount-list --instance deepseek']);
  });
});

test('when the controller cannot answer (Docker down), the lease file still decides what the panel shows and Revoke clears it', async () => {
  // No pinned release under this home, so every controller call fails.
  const options = { dockerPath: '/usr/local/bin/docker', home: '/nonexistent' };
  const hostLease = async () => ({ mode: 'elevated', accessLevel: 'full-host', expiresAt: EXPIRES });
  assert.equal((await instanceAccessStatus(options, { readLease: hostLease })).hostAccessUntil, Date.parse(EXPIRES));
  assert.equal((await instanceAccessStatus(options, { readLease: async () => { throw new Error('no pin'); } })).leaseState, 'unavailable');

  let cleared = 0;
  await revokeInstanceAccess(options, { clearLease: async () => { cleared += 1; } });
  assert.equal(cleared, 1, 'a failed controller revoke falls back to clearing the lease');
  await assert.rejects(
    revokeInstanceAccess(options, { clearLease: async () => { throw new Error('locked'); } }),
    (error) => error.message !== 'locked',
    'when neither works, the revoke fails with the controller\'s error',
  );
});
