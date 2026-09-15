import test from 'node:test';
import assert from 'node:assert/strict';
import { callNativeTool, isP2ToolAllowed } from '../extension/native-client.js';

test('P2 extension allowlist exposes only open_workspace, read and bash', () => {
  assert.equal(isP2ToolAllowed('open_workspace'), true);
  assert.equal(isP2ToolAllowed('read'), true);
  assert.equal(isP2ToolAllowed('bash'), true);
  assert.equal(isP2ToolAllowed('write'), false);
  assert.equal(isP2ToolAllowed('edit'), false);
});

test('P2 extension uses one-shot sendNativeMessage with the narrow envelope', async () => {
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

test('P2 extension refuses denied tools before Native Messaging', async () => {
  await assert.rejects(callNativeTool({ id: 'p2_write', name: 'write', arguments: {} }), (error) => {
    assert.equal(error.code, 'TOOL_NOT_ALLOWED');
    return true;
  });
});
