import { parseToolCalls } from '../tool-loop/tool-call-format.js';
import { TOOL_ARGUMENTS, TOOL_NAMES } from '../native-client.js';

export const MAX_AGENT_LOOPS = 6;
const MARKER_OPEN = '<webmcp_tool_call>';
const MARKER_CLOSE = '</webmcp_tool_call>';

export function neutralizeToolMarkers(text) {
  if (typeof text !== 'string') throw new TypeError('Tool result must be text.');
  return text
    .replaceAll(MARKER_OPEN, '<webmcp_tool_call_neutralized>')
    .replaceAll(MARKER_CLOSE, '</webmcp_tool_call_neutralized>');
}

export function buildFakeToolResult(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new TypeError('Fake execution requires at least one tool call.');
  }

  const blocks = calls.map((call) => {
    const payload = {
      id: call.id,
      name: call.name,
      isError: false,
      result: `P1 fake result for ${call.name}. No local filesystem, terminal, or MCP tool was executed.`,
    };
    return JSON.stringify(payload);
  });

  return neutralizeToolMarkers([
    'DeepSeek WebMCP P1 fake tool result.',
    'These are test results only; no local tool was executed.',
    ...blocks,
    'Continue the current task. If another tool is required, emit the next strict WebMCP tool-call block.',
  ].join('\n'));
}

function argumentShapeLine(name) {
  const { required, optional } = TOOL_ARGUMENTS[name];
  const extras = Object.entries(optional).map(([key, hint]) => `${key} (${hint})`);
  return `- ${name} ${JSON.stringify(required)}${extras.length > 0 ? `; optional: ${extras.join(', ')}` : ''}`;
}

export function buildNativeToolResult(call, response) {
  if (!call || typeof call !== 'object' || typeof call.id !== 'string' || typeof call.name !== 'string') {
    throw new TypeError('Tool call is required.');
  }
  if (!response || typeof response !== 'object' || response.id !== call.id || typeof response.ok !== 'boolean') {
    throw new TypeError('Native response is invalid.');
  }

  const payload = response.ok
    ? { id: call.id, name: call.name, isError: false, result: response.result }
    : { id: call.id, name: call.name, isError: true, error: response.error };

  // DeepSeek Web has no tools/list channel; this text is the only place the loop
  // restates the legal tool names and wire format (live: without them it invented
  // `list_directory`, and later sent a bare-JSON call without markers).
  // Only the untrusted payload is neutralized; the fixed instruction below is
  // extension-authored and must show the literal markers. Its template JSON is
  // deliberately invalid, so an echoed template fails closed instead of executing.
  return [
    'DeepSeek WebMCP tool result.',
    neutralizeToolMarkers(JSON.stringify(payload)),
    `Available tools: ${TOOL_NAMES.join(', ')}. No other tool exists; any other tool name is rejected and stops WebMCP.`,
    'Tool arguments (unknown fields are rejected):',
    ...TOOL_NAMES.map(argumentShapeLine),
    'Continue the current task. If another tool is required, reply with exactly one fenced text block and nothing else:',
    '```text',
    `${MARKER_OPEN}{"id":"<new unique id>","name":"<tool name>","arguments":{...}}${MARKER_CLOSE}`,
    '```',
    `Bare JSON without these markers is not a tool call and stops WebMCP.`,
    'If the task is finished or no available tool fits, reply without a tool call.',
  ].join('\n');
}

export class AgentController {
  #armed = false;
  #conversationKey = null;
  #seenCallIds = new Set();
  #loops = 0;

  static fromSnapshot(snapshot) {
    const controller = new AgentController();
    if (
      !snapshot
      || snapshot.armed !== true
      || typeof snapshot.conversationKey !== 'string'
      || snapshot.conversationKey.length === 0
      || !Number.isInteger(snapshot.loops)
      || snapshot.loops < 0
      || snapshot.loops > MAX_AGENT_LOOPS
      || !Array.isArray(snapshot.seenCallIds)
      || snapshot.seenCallIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)
    ) {
      return controller;
    }
    controller.#armed = true;
    controller.#conversationKey = snapshot.conversationKey;
    controller.#loops = snapshot.loops;
    controller.#seenCallIds = new Set(snapshot.seenCallIds);
    return controller;
  }

  snapshot() {
    return Object.freeze({
      armed: this.#armed,
      conversationKey: this.#conversationKey,
      loops: this.#loops,
      seenCallIds: Object.freeze([...this.#seenCallIds]),
    });
  }

  arm(conversationKey) {
    if (typeof conversationKey !== 'string' || conversationKey.length === 0) {
      throw new TypeError('conversationKey is required.');
    }
    this.#armed = true;
    this.#conversationKey = conversationKey;
    this.#seenCallIds.clear();
    this.#loops = 0;
  }

  disarm() {
    this.#armed = false;
    this.#conversationKey = null;
    this.#seenCallIds.clear();
    this.#loops = 0;
  }

  get status() {
    return Object.freeze({
      armed: this.#armed,
      conversationKey: this.#conversationKey,
      loops: this.#loops,
      maxLoops: MAX_AGENT_LOOPS,
    });
  }

  acceptCompletion(conversationKey, text) {
    if (!this.#armed || conversationKey !== this.#conversationKey) {
      return Object.freeze({ accepted: false, code: 'DISARMED_OR_WRONG_CONVERSATION' });
    }
    if (this.#loops >= MAX_AGENT_LOOPS) {
      this.disarm();
      return Object.freeze({ accepted: false, code: 'LOOP_LIMIT' });
    }

    const calls = parseToolCalls(text);
    if (calls.length === 0) {
      return Object.freeze({ accepted: true, code: 'NO_TOOL_CALL', calls });
    }

    const fresh = calls.filter((call) => !this.#seenCallIds.has(call.id));
    if (fresh.length === 0) {
      return Object.freeze({ accepted: false, code: 'DUPLICATE_CALL', calls: Object.freeze([]) });
    }
    if (fresh.length !== calls.length) {
      return Object.freeze({ accepted: false, code: 'MIXED_DUPLICATE_CALLS', calls: Object.freeze([]) });
    }

    for (const call of fresh) this.#seenCallIds.add(call.id);
    this.#loops += 1;
    return Object.freeze({
      accepted: true,
      code: 'TOOL_CALLS',
      calls: Object.freeze(fresh),
      loop: this.#loops,
    });
  }
}
