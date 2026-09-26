import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatchInstanceRequest, dispatchToolRequest, instanceRuntimeToken } from '../native/host/instance-dispatch.js';

const RELEASE = '/Users/me/.local/share/webmcp/host-runtime/releases/abc';

function request(tool, args = {}) {
  return { version: 1, id: 'p2_call', tool, arguments: args };
}

// A fake host relay: records how it was started and answers the one JSON-RPC line it receives.
function fakeRelay(answer) {
  const started = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    started.push({ command, args, env: options.env, child });
    child.stdin = {
      end: (line) => setImmediate(() => {
        const rpc = JSON.parse(line);
        answer(child, rpc);
      }),
    };
    return child;
  };
  return { spawnImpl, started };
}

const options = (spawnImpl, extra = {}) => ({
  dockerPath: '/usr/local/bin/docker',
  home: os.tmpdir(),
  resolveRelease: async () => RELEASE,
  spawnImpl,
  nodePath: '/opt/node/bin/node',
  env: { HOME: '/Users/me', PATH: '/usr/bin:/bin' },
  ...extra,
});

test('a workspace tool runs through the shared runtime\'s deepseek instance relay', async () => {
  const relay = fakeRelay((child, rpc) => {
    assert.deepEqual(rpc, { jsonrpc: '2.0', id: 'p2_call', method: 'tools/call', params: { name: 'read', arguments: { workspaceId: 'ws_x', path: 'a.txt' } } });
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'p2_call', result: { structuredContent: { content: 'hello' } } })}\n`));
    child.emit('close', 0);
  });
  const response = await dispatchInstanceRequest(request('read', { workspaceId: 'ws_x', path: 'a.txt' }), options(relay.spawnImpl));
  assert.deepEqual(response, { version: 1, id: 'p2_call', ok: true, result: { content: 'hello' } });

  const [{ command, args, env }] = relay.started;
  assert.equal(command, '/opt/node/bin/node');
  assert.deepEqual(args, [path.join(RELEASE, 'native', 'host', 'start.js')]);
  assert.equal(env.WEBMCP_INSTANCE_ID, 'deepseek');
  assert.match(env.WEBMCP_RUNTIME_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(env.PATH.split(path.delimiter)[0], '/usr/local/bin', 'Chrome starts native hosts with a PATH that lacks Docker');
});

test('the runtime token is stable for the Mac user, so a workspaceId stays valid across calls', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-instance-token-'));
  try {
    const first = await instanceRuntimeToken(home);
    assert.equal(await instanceRuntimeToken(home), first);
    assert.equal(await instanceRuntimeToken(`${home}/`), first, 'the real path decides');
    assert.notEqual(await instanceRuntimeToken(await realpath(os.tmpdir())), first);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('tool errors, runtime failures, oversized answers and a relay that never answers all become tool errors', async () => {
  const toolError = fakeRelay((child) => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'p2_call', result: { isError: true, structuredContent: { error: 'PATH_ESCAPE', message: 'outside' } } })}\n`));
    child.emit('close', 0);
  });
  assert.deepEqual(
    (await dispatchInstanceRequest(request('read', { workspaceId: 'ws_x', path: '../x' }), options(toolError.spawnImpl))).error,
    { code: 'PATH_ESCAPE', message: 'outside' },
  );

  const failed = fakeRelay((child) => {
    child.stderr.emit('data', Buffer.from('Native runtime exited unexpectedly'));
    child.emit('close', 1);
  });
  await assert.rejects(dispatchInstanceRequest(request('read', { workspaceId: 'ws_x', path: 'a' }), options(failed.spawnImpl)), { code: 'RUNTIME_FAILED' });

  const huge = fakeRelay((child) => {
    child.stdout.emit('data', Buffer.alloc(700 * 1024, 'x'));
  });
  await assert.rejects(dispatchInstanceRequest(request('read', { workspaceId: 'ws_x', path: 'a' }), options(huge.spawnImpl)), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(huge.started[0].child.killed, true);

  const silent = fakeRelay(() => {});
  await assert.rejects(
    dispatchInstanceRequest(request('read', { workspaceId: 'ws_x', path: 'a' }), options(silent.spawnImpl, { deadlineMs: 20 })),
    { code: 'RUNTIME_TIMEOUT' },
  );
  assert.equal(silent.started[0].child.killed, true);
});

test('host_command and unknown tools never reach the instance relay', async () => {
  const relay = fakeRelay(() => assert.fail('relay must not start'));
  await assert.rejects(dispatchInstanceRequest(request('host_command', { command: 'id' }), options(relay.spawnImpl)), { code: 'TOOL_NOT_ALLOWED' });
  await assert.rejects(dispatchInstanceRequest(request('list_directory', {}), options(relay.spawnImpl)), /not allowed/i);
  assert.equal(relay.started.length, 0);
});

test('macOS sends workspace tools to the instance; WSL keeps its own container; host_command has its own gate', async () => {
  const routes = (kind) => {
    const seen = [];
    const record = (route) => async (req) => { seen.push(`${route}:${req.tool}`); return { ok: true }; };
    const options = { configFile: '/c.json', kind, hostCommand: record('host'), legacy: record('legacy'), instance: record('instance') };
    return { seen, run: (tool) => dispatchToolRequest(request(tool), options) };
  };
  const mac = routes('macos');
  await mac.run('read');
  await mac.run('host_command');
  assert.deepEqual(mac.seen, ['instance:read', 'host:host_command']);
  const wsl = routes('wsl');
  await wsl.run('read');
  await wsl.run('host_command');
  assert.deepEqual(wsl.seen, ['legacy:read', 'host:host_command']);
});
