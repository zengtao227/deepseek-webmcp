import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_ARGUMENTS, TOOL_NAMES } from '../extension/native-client.js';
import { buildNativeToolResult } from '../extension/core/agent-controller.js';
import { createNativeMcpServer } from '../native/src/server.js';

// The extension cannot import native code, so its model-facing argument shapes are
// checked against the runtime's own inputSchema to prevent drift.
test('extension argument shapes match the native runtime inputSchema exactly', async () => {
  const server = createNativeMcpServer({});
  const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const schemas = new Map(listed.result.tools.map((tool) => [tool.name, tool.inputSchema]));
  assert.deepEqual(Object.keys(TOOL_ARGUMENTS), [...TOOL_NAMES]);
  for (const name of TOOL_NAMES) {
    const schema = schemas.get(name);
    assert.ok(schema, `runtime exposes ${name}`);
    const shape = TOOL_ARGUMENTS[name];
    assert.deepEqual(Object.keys(shape.required).sort(), [...schema.required].sort(), `${name} required`);
    assert.deepEqual(
      [...Object.keys(shape.required), ...Object.keys(shape.optional)].sort(),
      Object.keys(schema.properties).sort(),
      `${name} properties`,
    );
  }
});

test('native tool results restate every tool argument shape, including the edits array', () => {
  // Live P3 2026-09-15: without the shape DeepSeek sent edit's oldText/newText at top level.
  const result = buildNativeToolResult(
    { id: 'a1', name: 'open_workspace', arguments: { path: '/workspace' } },
    { version: 1, id: 'a1', ok: true, result: { workspaceId: 'ws_x' } },
  );
  const lines = result.split('\n');
  for (const name of TOOL_NAMES) {
    assert.ok(lines.some((line) => line.startsWith(`- ${name} `)), `shape line for ${name}`);
  }
  assert.ok(lines.includes('- edit {"workspaceId":"<id>","path":"<relative path>","edits":[{"oldText":"<exact existing text>","newText":"<replacement>"}]}'));
  assert.ok(lines.some((line) => line.startsWith('- bash ') && line.includes('timeout') && line.includes('max 30')));
});
