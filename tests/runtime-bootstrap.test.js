import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildDockerInvocation } from '../native/host/docker-dispatch.js';
import { DEEPSEEK_CHECKOUT_INSTRUCTION, runtimeBootstrapScript } from '../native/host/runtime-bootstrap.js';

test('the runtime bootstrap refuses to start without a runtime token', () => {
  const env = { ...process.env };
  delete env.WEBMCP_RUNTIME_TOKEN;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', runtimeBootstrapScript('/nonexistent')], { env, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /WEBMCP_RUNTIME_TOKEN is required/);
});

test('each tool call runs the shared runtime through the DeepSeek bootstrap in a locked-down container', () => {
  const invocation = buildDockerInvocation({
    dockerPath: '/usr/local/bin/docker',
    image: `sha256:${'f'.repeat(64)}`,
    runtimeToken: 't'.repeat(64),
    canonicalRoot: '/Users/someone/work',
    masks: [],
  }, { version: 1, id: 'r1', tool: 'open_workspace', arguments: { path: '/workspace' } }, { uid: 501, gid: 20, random: () => 'x' });
  const args = invocation.args;
  for (const flag of [['--network', 'none'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--user', '501:20']]) {
    assert.equal(args[args.indexOf(flag[0]) + 1], flag[1]);
  }
  const script = args.at(-1);
  assert.deepEqual(args.slice(-4, -1), ['node', '--input-type=module', '-e']);
  assert.equal(script, runtimeBootstrapScript());
  assert.ok(script.includes('/opt/webmcp/native/src/workspace.js'));
  assert.ok(script.includes('maxTimeoutMs: 30000'));
  assert.ok(script.includes(JSON.stringify(DEEPSEEK_CHECKOUT_INSTRUCTION)));
});
