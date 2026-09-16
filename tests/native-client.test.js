import test from 'node:test';
import assert from 'node:assert/strict';
import { callNativeTool, isToolAllowed } from '../extension/native-client.js';

test('P3 extension allowlist exposes exactly the five bounded coding tools', () => {
  for (const name of ['open_workspace', 'read', 'write', 'edit', 'bash']) {
    assert.equal(isToolAllowed(name), true);
  }
  for (const name of ['list_directory', 'git', 'shell']) {
    assert.equal(isToolAllowed(name), false);
  }
});

test('extension keeps one-shot sendNativeMessage with the narrow envelope', async () => {
  const originalChrome = globalThis.chrome;
  const seen = [];
  globalThis.chrome = {
    runtime: {
      sendNativeMessage: async (host, payload) => {
        seen.push({ host, payload });
        return { version: 1, id: payload.id, ok: true, result: { result: 'P2_OK' } };
      },
    },
  };
  try {
    const response = await callNativeTool({ id: 'p2_1', name: 'bash', arguments: { workspaceId: 'ws_x', command: 'echo P2_OK' } });
    assert.equal(response.ok, true);
    assert.deepEqual(seen, [{
      host: 'com.deepseek.webmcp.native',
      payload: {
        version: 1,
        id: 'p2_1',
        tool: 'bash',
        arguments: { workspaceId: 'ws_x', command: 'echo P2_OK' },
      },
    }]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('extension refuses unknown tools before Native Messaging', async () => {
  await assert.rejects(callNativeTool({ id: 'p3_list', name: 'list_directory', arguments: {} }), (error) => {
    assert.equal(error.code, 'TOOL_NOT_ALLOWED');
    return true;
  });
});

test('a local program that never answers becomes a tool error instead of an unending call', async (t) => {
  const originalChrome = globalThis.chrome;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.chrome = {
    runtime: {
      // The program stayed alive and wrote nothing, which is what a wedged Docker
      // daemon used to produce. Chrome never rejects in that case.
      sendNativeMessage: () => new Promise(() => {}),
    },
  };
  try {
    const call = callNativeTool({ id: 'p2_hang', name: 'read', arguments: { workspaceId: 'ws_x', path: 'x' } });
    t.mock.timers.tick(60_000);
    await assert.rejects(call, (error) => {
      assert.equal(error.code, 'NATIVE_CALL_TIMED_OUT');
      return true;
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});
