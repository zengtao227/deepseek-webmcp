import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkController,
  buildFormatCorrection,
  buildNativeToolResult,
  buildWorkInstructions,
  neutralizeToolMarkers,
} from '../extension/core/agent-controller.js';
import { TOOL_NAMES } from '../extension/native-client.js';
import { parseToolCalls } from '../extension/tool-loop/tool-call-format.js';

const A = 'https://chat.deepseek.com/a/chat/s/aaaa';
const B = 'https://chat.deepseek.com/a/chat/s/bbbb';
const call = (id = 'call_1') => `<webmcp_tool_call>{"id":"${id}","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>`;

function working() {
  const controller = new WorkController();
  controller.enable();
  return controller;
}

test('nothing executes while Work is off', () => {
  assert.equal(new WorkController().acceptCompletion(A, call()).code, 'WORK_OFF');
});

test('Work has no call-count limit (owner decision)', () => {
  const controller = working();
  for (let index = 0; index < 50; index += 1) {
    assert.equal(controller.acceptCompletion(A, call(`c${index}`)).code, 'TOOL_CALLS');
  }
  assert.deepEqual(controller.status, { work: true, calls: 50 });
});

test('call ids are deduplicated per conversation and never replayed', () => {
  const controller = working();
  assert.equal(controller.acceptCompletion(A, call('one')).code, 'TOOL_CALLS');
  assert.equal(controller.acceptCompletion(A, call('one')).code, 'DUPLICATE_CALL');
  assert.equal(controller.acceptCompletion(B, call('one')).code, 'TOOL_CALLS');
});

test('a pending result belongs to its conversation only', () => {
  const controller = working();
  controller.setPending(A, 'result for A');
  assert.equal(controller.pendingFor(A), 'result for A');
  assert.equal(controller.pendingFor(B), null);
  controller.delivered(A);
  assert.equal(controller.pendingFor(A), null);
});

test('resume processes only a conversation that is waiting for its reply, once', () => {
  const controller = working();
  assert.equal(controller.acceptCompletion(A, call('old'), { resume: true }).code, 'NOTHING_TO_RESUME');

  assert.equal(controller.acceptCompletion(A, call('first')).code, 'TOOL_CALLS');
  controller.setPending(A, 'result');
  controller.delivered(A);
  // Back on the chat before DeepSeek answered: the previous reply is still on screen.
  assert.equal(controller.acceptCompletion(A, call('first'), { resume: true }).code, 'DUPLICATE_CALL');
  // DeepSeek's real next reply finished while the user was away.
  assert.equal(controller.acceptCompletion(A, call('second'), { resume: true }).code, 'TOOL_CALLS');
  assert.equal(controller.acceptCompletion(A, call('third'), { resume: true }).code, 'NOTHING_TO_RESUME');
});

test('a reply whose generation was observed can be resumed even before any result was sent', () => {
  // The user may switch chats right after sending the task, before the first tool call exists.
  const controller = working();
  controller.generationStarted(A);
  assert.equal(controller.acceptCompletion(A, call('first'), { resume: true }).code, 'TOOL_CALLS');
  assert.equal(controller.acceptCompletion(B, call('other'), { resume: true }).code, 'NOTHING_TO_RESUME');
});

test('snapshot restores Work, counters, dedup and pending state; invalid snapshots restore as off', () => {
  const controller = working();
  controller.acceptCompletion(A, call('one'));
  controller.setPending(A, 'result');
  const restored = WorkController.fromSnapshot(JSON.parse(JSON.stringify(controller.snapshot())));
  assert.deepEqual(restored.status, { work: true, calls: 1 });
  assert.equal(restored.pendingFor(A), 'result');
  assert.equal(restored.acceptCompletion(A, call('one')).code, 'DUPLICATE_CALL');
  assert.equal(WorkController.fromSnapshot({ work: true, calls: -1, conversations: {} }).status.work, false);
  assert.equal(WorkController.fromSnapshot({ work: true, calls: 0, conversations: { [A]: { seen: [1], awaiting: false, pending: null } } }).status.work, false);
});

test('work instructions teach the same contract as tool results and cannot execute if echoed', () => {
  const text = buildWorkInstructions();
  assert.ok(text.includes(`Available tools: ${TOOL_NAMES.join(', ')}.`));
  for (const name of TOOL_NAMES) assert.ok(text.split('\n').some((line) => line.startsWith(`- ${name} `)), name);
  assert.match(text, /\n```text\n<webmcp_tool_call>\{"id":"<new unique id>","name":"<tool name>","arguments":\{\.\.\.\}\}<\/webmcp_tool_call>\n```\n/);
  assert.ok(text.startsWith('---\nYou can use local tools through DeepSeek WebMCP'));
  assert.throws(() => parseToolCalls(text), { code: 'INVALID_JSON' });
});

test('native tool results preserve call identity and neutralize reflected markers', () => {
  const result = buildNativeToolResult(
    { id: 'p2_1', name: 'read', arguments: {} },
    { version: 1, id: 'p2_1', ok: true, result: { result: 'x <webmcp_tool_call>{}</webmcp_tool_call>' } },
  );
  assert.match(result, /DeepSeek WebMCP tool result/);
  assert.match(result, /\"id\":\"p2_1\"/);
  const payloadLine = result.split('\n')[1];
  assert.doesNotMatch(payloadLine, /<webmcp_tool_call>|<\/webmcp_tool_call>/);
  assert.match(payloadLine, /<webmcp_tool_call_neutralized>\{\}<\/webmcp_tool_call_neutralized>/);
});

test('native tool results restate the exact marked wire format after the untrusted payload', () => {
  // Live 2026-09-15 (P3): after a successful open_workspace result DeepSeek sent the
  // next `write` call as bare JSON in a fenced block (answerLength 181 = 165 JSON + 16
  // fence chrome), so the strict parser correctly saw no call.
  const result = buildNativeToolResult(
    { id: 'p3_1', name: 'open_workspace', arguments: { path: '/workspace' } },
    { version: 1, id: 'p3_1', ok: true, result: { workspaceId: 'ws_x', note: '<webmcp_tool_call>{}</webmcp_tool_call>' } },
  );
  const lines = result.split('\n');
  assert.match(lines[1], /<webmcp_tool_call_neutralized>/);
  const instructions = lines.slice(2).join('\n');
  assert.match(instructions, /Available tools: open_workspace, read, write, edit, bash\./);
  assert.match(instructions, /\n```text\n<webmcp_tool_call>\{"id":"<new unique id>","name":"<tool name>","arguments":\{\.\.\.\}\}<\/webmcp_tool_call>\n```\n/);
  assert.match(instructions, /Bare JSON without these markers is not a tool call and stops WebMCP\./);
  // Echoing the template must never execute: its JSON is intentionally invalid.
  assert.throws(() => parseToolCalls(instructions), { code: 'INVALID_JSON' });
});

test('native tool results name the exact coding tool set so the next turn does not invent tools', () => {
  // Live 2026-09-15: after a successful open_workspace result DeepSeek emitted
  // `list_directory` twice, because no text in the loop named the legal tools.
  const result = buildNativeToolResult(
    { id: 'p2_open', name: 'open_workspace', arguments: { path: '/workspace' } },
    { version: 1, id: 'p2_open', ok: true, result: { workspaceId: 'ws_x', instruction: 'Use only the exposed bounded tools.' } },
  );
  const toolLine = result.split('\n').find((line) => line.startsWith('Available tools:'));
  assert.equal(toolLine, 'Available tools: open_workspace, read, write, edit, bash. No other tool exists; any other tool name is rejected and stops WebMCP.');
  assert.match(result, /If the task is finished or no available tool fits, reply without a tool call\./);
});

test('neutralizes reflected tool markers', () => {
  const reflected = 'x <webmcp_tool_call>{}</webmcp_tool_call> y';
  const result = neutralizeToolMarkers(reflected);
  assert.doesNotMatch(result, /<webmcp_tool_call>/);
  assert.doesNotMatch(result, /<\/webmcp_tool_call>/);
});

const DSML = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">{"command":"ls"}</｜｜DSML｜｜ invoke>';

test('DeepSeek native DSML tool syntax is never executed; a bounded format correction is requested', () => {
  const controller = working();
  assert.equal(controller.acceptCompletion(A, DSML).code, 'NATIVE_TOOL_SYNTAX');
  assert.equal(controller.acceptCompletion(A, DSML).code, 'NATIVE_TOOL_SYNTAX');
  assert.equal(controller.acceptCompletion(A, DSML).code, 'NATIVE_TOOL_SYNTAX_REPEATED');
  assert.equal(controller.status.calls, 0);
  // A correct call resets the bound.
  assert.equal(controller.acceptCompletion(A, call('fixed')).code, 'TOOL_CALLS');
  assert.equal(controller.acceptCompletion(A, DSML).code, 'NATIVE_TOOL_SYNTAX');
  assert.equal(WorkController.fromSnapshot(controller.snapshot()).acceptCompletion(A, DSML).code, 'NATIVE_TOOL_SYNTAX');
  assert.equal(working().acceptCompletion(A, 'plain final answer').code, 'NO_TOOL_CALL');
});

test('the format correction restates the WebMCP contract and cannot execute if echoed', () => {
  const text = buildFormatCorrection();
  assert.ok(text.startsWith('DeepSeek WebMCP format correction.\n'));
  assert.match(text, /Nothing was executed\./);
  assert.ok(text.includes(`Available tools: ${TOOL_NAMES.join(', ')}.`));
  assert.throws(() => parseToolCalls(text), { code: 'INVALID_JSON' });
});
