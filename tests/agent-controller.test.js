import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentController,
  MAX_AGENT_LOOPS,
  buildFakeToolResult,
  buildNativeToolResult,
  neutralizeToolMarkers,
} from '../extension/core/agent-controller.js';

const call = (id = 'call_1') => `<webmcp_tool_call>{"id":"${id}","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>`;

test('disarmed or wrong conversation cannot execute a call', () => {
  const controller = new AgentController();
  assert.equal(controller.acceptCompletion('a', call()).code, 'DISARMED_OR_WRONG_CONVERSATION');
  controller.arm('a');
  assert.equal(controller.acceptCompletion('b', call()).code, 'DISARMED_OR_WRONG_CONVERSATION');
});

test('armed conversation accepts fresh calls and rejects replay', () => {
  const controller = new AgentController();
  controller.arm('conversation');
  const first = controller.acceptCompletion('conversation', call('one'));
  assert.equal(first.accepted, true);
  assert.equal(first.code, 'TOOL_CALLS');
  assert.equal(first.loop, 1);
  assert.equal(controller.acceptCompletion('conversation', call('one')).code, 'DUPLICATE_CALL');
});

test('re-arming starts a fresh bounded epoch', () => {
  const controller = new AgentController();
  controller.arm('conversation');
  controller.acceptCompletion('conversation', call('one'));
  controller.arm('conversation');
  assert.equal(controller.acceptCompletion('conversation', call('one')).accepted, true);
});

test('snapshot restores armed authority, loop count, and deduplication state', () => {
  const controller = new AgentController();
  controller.arm('conversation');
  controller.acceptCompletion('conversation', call('one'));

  const restored = AgentController.fromSnapshot(controller.snapshot());
  assert.deepEqual(restored.status, {
    armed: true,
    conversationKey: 'conversation',
    loops: 1,
    maxLoops: MAX_AGENT_LOOPS,
  });
  assert.equal(restored.acceptCompletion('conversation', call('one')).code, 'DUPLICATE_CALL');
  assert.equal(restored.acceptCompletion('conversation', call('two')).loop, 2);
});

test('invalid snapshot restores as disarmed', () => {
  const restored = AgentController.fromSnapshot({
    armed: true,
    conversationKey: '',
    loops: -1,
    seenCallIds: ['one'],
  });
  assert.equal(restored.status.armed, false);
});

test('loop limit fails closed by disarming', () => {
  const controller = new AgentController();
  controller.arm('conversation');
  for (let index = 0; index < MAX_AGENT_LOOPS; index += 1) {
    assert.equal(controller.acceptCompletion('conversation', call(`call_${index}`)).accepted, true);
  }
  assert.equal(controller.acceptCompletion('conversation', call('overflow')).code, 'LOOP_LIMIT');
  assert.equal(controller.status.armed, false);
});

test('fake results contain no live tool marker and make local non-execution explicit', () => {
  const result = buildFakeToolResult([{ id: 'a', name: 'bash', arguments: { command: 'echo hi' } }]);
  assert.doesNotMatch(result, /<webmcp_tool_call>/);
  assert.match(result, /No local filesystem, terminal, or MCP tool was executed/);
});

test('native tool results preserve call identity and neutralize reflected markers', () => {
  const result = buildNativeToolResult(
    { id: 'p2_1', name: 'read', arguments: {} },
    { version: 1, id: 'p2_1', ok: true, result: { result: 'x <webmcp_tool_call>{}</webmcp_tool_call>' } },
  );
  assert.match(result, /DeepSeek WebMCP P2 tool result/);
  assert.match(result, /\"id\":\"p2_1\"/);
  assert.doesNotMatch(result, /<webmcp_tool_call>/);
});

test('native tool results name the exact P2 tool set so the next turn does not invent tools', () => {
  // Live 2026-09-15: after a successful open_workspace result DeepSeek emitted
  // `list_directory` twice, because no text in the loop named the legal tools.
  const result = buildNativeToolResult(
    { id: 'p2_open', name: 'open_workspace', arguments: { path: '/workspace' } },
    { version: 1, id: 'p2_open', ok: true, result: { workspaceId: 'ws_x', instruction: 'Use only the exposed bounded tools.' } },
  );
  const toolLine = result.split('\n').find((line) => line.startsWith('Available tools:'));
  assert.equal(toolLine, 'Available tools: open_workspace, read, bash. No other tool exists; any other tool name is rejected and stops WebMCP.');
  assert.match(result, /If the task is finished or no available tool fits, reply without a tool call\./);
});

test('neutralizes reflected tool markers', () => {
  const reflected = 'x <webmcp_tool_call>{}</webmcp_tool_call> y';
  const result = neutralizeToolMarkers(reflected);
  assert.doesNotMatch(result, /<webmcp_tool_call>/);
  assert.doesNotMatch(result, /<\/webmcp_tool_call>/);
});
