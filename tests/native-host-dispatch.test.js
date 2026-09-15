import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDockerInvocation, loadNativeHostConfig, validateNativeRequest } from '../native/host/docker-dispatch.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;

function request(tool, args = {}) {
  return { version: 1, id: 'p2_call', tool, arguments: args };
}

test('P2 host allowlist rejects write/edit, extra fields and bash timeout > 30s', () => {
  assert.throws(() => validateNativeRequest(request('write', {})), /not allowed/i);
  assert.throws(() => validateNativeRequest(request('edit', {})), /not allowed/i);
  assert.throws(() => validateNativeRequest({ ...request('read', {}), extra: true }), /unsupported field/i);
  assert.throws(() => validateNativeRequest(request('bash', { workspaceId: 'ws_x', command: 'echo ok', timeout: 31 })), /timeout/i);
});

test('P2 Docker argv is fixed, isolated, read-only and does not contain model command/path', () => {
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
  assert.ok(invocation.args.includes('type=bind,src=/Users/test/My Project,dst=/workspace,readonly'));
  assert.ok(invocation.args.includes(IMAGE));
  assert.equal(invocation.args.includes(modelCommand), false);
  assert.equal(invocation.args.includes(modelPath), false);
  assert.equal(invocation.args.includes('/var/run/docker.sock'), false);
  assert.equal(invocation.args.includes('--privileged'), false);
});

test('same local config derives the same stable runtime token across one-shot host invocations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-host-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    workspaceRoot: dir,
    image: IMAGE,
    dockerPath: '/usr/local/bin/docker',
  }));
  const first = await loadNativeHostConfig(configPath);
  const second = await loadNativeHostConfig(configPath);
  assert.equal(first.runtimeToken, second.runtimeToken);
  assert.match(first.runtimeToken, /^[0-9a-f]{64}$/);
});
