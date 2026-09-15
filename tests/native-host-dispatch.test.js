import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDockerInvocation, loadNativeHostConfig, toNativeError, validateNativeRequest } from '../native/host/docker-dispatch.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;

function request(tool, args = {}) {
  return { version: 1, id: 'p2_call', tool, arguments: args };
}

test('P3 host allowlist accepts write/edit and still rejects unknown tools, extra fields and long bash timeouts', () => {
  assert.equal(validateNativeRequest(request('write', { workspaceId: 'ws_x', path: 'x.txt', content: 'ok' })).tool, 'write');
  assert.equal(validateNativeRequest(request('edit', { workspaceId: 'ws_x', path: 'x.txt', edits: [{ oldText: 'x', newText: 'y' }] })).tool, 'edit');
  assert.throws(() => validateNativeRequest(request('list_directory', {})), /not allowed/i);
  assert.throws(() => validateNativeRequest({ ...request('read', {}), extra: true }), /unsupported field/i);
  assert.throws(() => validateNativeRequest(request('bash', { workspaceId: 'ws_x', command: 'echo ok', timeout: 31 })), /timeout/i);
});

test('P3 Docker argv is fixed, isolated, writable only at the selected workspace and does not contain model command/path', () => {
  const config = {
    dockerPath: '/usr/local/bin/docker',
    canonicalRoot: '/Users/test/My Project',
    image: IMAGE,
    runtimeToken: 'b'.repeat(64),
  };
  const modelCommand = 'echo MODEL_VALUE && touch /workspace/nope';
  const modelPath = 'some/model/path.txt';
  const invocation = buildDockerInvocation(config, request('bash', {
    workspaceId: 'ws_x',
    command: modelCommand,
    workingDirectory: modelPath,
    timeout: 10,
  }), { uid: 501, gid: 20, random: () => 'cafebabe' });

  assert.equal(invocation.command, '/usr/local/bin/docker');
  assert.equal(invocation.name, 'deepseek-webmcp-call-cafebabe');
  assert.notEqual(invocation.name, 'webmcp-native');
  assert.deepEqual(invocation.args.slice(0, 6), ['run', '--rm', '-i', '--pull', 'never', '--name']);
  assert.ok(invocation.args.includes('none'));
  assert.ok(invocation.args.includes('ALL'));
  assert.ok(invocation.args.includes('no-new-privileges'));
  assert.ok(invocation.args.includes('501:20'));
  assert.ok(invocation.args.includes('type=bind,src=/Users/test/My Project,dst=/workspace,bind-recursive=disabled'));
  assert.equal(invocation.args.some((arg) => arg.includes('dst=/workspace,readonly')), false);
  assert.ok(invocation.args.includes(IMAGE));
  assert.equal(invocation.args.includes(modelCommand), false);
  assert.equal(invocation.args.includes(modelPath), false);
  assert.equal(invocation.args.includes('/var/run/docker.sock'), false);
  assert.equal(invocation.args.includes('--privileged'), false);
});

test('host-level errors are sanitized before they can return to DeepSeek', () => {
  const response = toNativeError('p3_host_error', new Error('password = "p3-host-secret-value"'));
  assert.equal(response.ok, false);
  assert.match(response.error.message, /\[REDACTED/);
  assert.doesNotMatch(response.error.message, /p3-host-secret-value/);
});

test('same local config derives the same stable runtime token across one-shot host invocations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-host-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-workspace-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    workspaceRoot: workspace,
    image: IMAGE,
    dockerPath: '/usr/local/bin/docker',
  }));
  const first = await loadNativeHostConfig(configPath);
  const second = await loadNativeHostConfig(configPath);
  assert.equal(first.runtimeToken, second.runtimeToken);
  assert.match(first.runtimeToken, /^[0-9a-f]{64}$/);
});

test('host refuses a writable workspace that contains its own control plane', async () => {
  // A writable /workspace containing host-executed code, its config, node or docker
  // would let the model rewrite what Chrome runs outside the container.
  const hostCodeRoot = path.resolve(import.meta.dirname, '..');
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-state-'));
  const configPath = path.join(stateDir, 'config.json');
  const cases = [
    ['host code root (this repository)', hostCodeRoot],
    ['directory holding the host config', stateDir],
    ['ancestor of the node binary', path.dirname(process.execPath)],
    ['filesystem root', '/'],
    ['home directory (holds ~/.docker and Chrome manifests)', os.homedir()],
  ];
  for (const [label, workspaceRoot] of cases) {
    await writeFile(configPath, JSON.stringify({ workspaceRoot, image: IMAGE, dockerPath: '/usr/local/bin/docker' }));
    await assert.rejects(loadNativeHostConfig(configPath), { code: 'WORKSPACE_CONTAINS_CONTROL_PLANE' }, label);
  }
});
