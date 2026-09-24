import { parseToolCalls } from '../tool-loop/tool-call-format.js';
import { TOOL_ARGUMENTS, TOOL_NAMES } from '../tool-contract.js';

const MARKER_OPEN = '<webmcp_tool_call>';
const MARKER_CLOSE = '</webmcp_tool_call>';

export function neutralizeToolMarkers(text) {
  if (typeof text !== 'string') throw new TypeError('Tool result must be text.');
  return text
    .replaceAll(MARKER_OPEN, '<webmcp_tool_call_neutralized>')
    .replaceAll(MARKER_CLOSE, '</webmcp_tool_call_neutralized>');
}

function argumentShapeLine(name) {
  const { required, optional } = TOOL_ARGUMENTS[name];
  const extras = Object.entries(optional).map(([key, hint]) => `${key} (${hint})`);
  return `- ${name} ${JSON.stringify(required)}${extras.length > 0 ? `; optional: ${extras.join(', ')}` : ''}`;
}

function toolContractLines(callInstruction) {
  return [
    `Available tools: ${TOOL_NAMES.join(', ')}. No other tool exists; any other tool name is rejected and stops WebMCP.`,
    'Tool arguments (unknown fields are rejected):',
    ...TOOL_NAMES.map(argumentShapeLine),
    callInstruction,
    '```text',
    `${MARKER_OPEN}{"id":"<new unique id>","name":"<tool name>","arguments":{...}}${MARKER_CLOSE}`,
    '```',
    'Bare JSON without these markers is not a tool call and stops WebMCP.',
  ];
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
    ...toolContractLines('Continue the current task. If another tool is required, reply with exactly one fenced text block and nothing else:'),
    'If the task is finished or no available tool fits, reply without a tool call.',
  ].join('\n');
}

// DeepSeek's own built-in tool-call syntax (live 2026-09-15: `<｜｜DSML｜｜ invoke name="bash">`
// after two correct WebMCP calls). It is never executed; WebMCP only asks for a resend.
const NATIVE_TOOL_SYNTAX = /｜\s*DSML\s*｜/;
const MAX_FORMAT_CORRECTIONS = 2;

export function usesNativeToolSyntax(text) {
  return typeof text === 'string' && NATIVE_TOOL_SYNTAX.test(text);
}

export function buildFormatCorrection() {
  return [
    'DeepSeek WebMCP format correction.',
    'Your last reply used a different tool-call format, which WebMCP does not run. Nothing was executed.',
    ...toolContractLines('Send the same call again as exactly one fenced text block and nothing else:'),
  ].join('\n');
}

// Appended after the user's first message of a new chat while Work is on, so the
// question stays visible when DeepSeek collapses a long message (the content script
// checks the exact first sentence); every tool result restates the contract.
export function buildWorkInstructions({ pageAttached = false } = {}) {
  return [
    '---',
    'You can use owner-approved tools through DeepSeek WebMCP for the task above. Browser tools act only on the one browser tab I explicitly attached. Coding tools, including bash, run in the isolated Docker workspace. host_command is separate: it runs as the Mac user only during a locally approved Temporary Full Host Access — High Trust lease.',
    ...toolContractLines('To call a tool, reply with exactly one fenced text block and nothing else, then wait for the result:'),
    ...(pageAttached
      ? ['A browser page is already attached for this task; do not ask me to attach one. Requests about "the current page" or "the work page" mean that attached page.']
      : []),
    'For webpage/form tasks, start with inspect_form when the task is about a form, otherwise inspect_page. Use only returned element refs; never invent selectors, XPath, tab ids, or refs.',
    'For coding/filesystem tasks only, start with open_workspace {"path":"/workspace"} and reuse the returned workspaceId in every later coding-tool call. /workspace is the folder the owner chose, whatever its real name; its contents are what the owner means by "my folder".',
    'A page read is a snapshot. After the owner switches pages or presses Stop, read again with inspect_page instead of reusing an earlier result.',
    'inspect_page returns at most 80 controls and lists the ones on screen first. If the control you need is not returned (truncated is true) or the page is longer than the screen, call scroll with deltaY (positive scrolls down, for example 700) and read again with inspect_page. Refs from before a scroll or a page update can be stale: use the refs from your newest read.',
    'A browser click may fail with CONFIRMATION_REQUIRED for a commit-like action. Do not retry it automatically.',
    'Use one tool call per reply. Do not commit or push. When the task is finished, reply normally without a tool call.',
  ].join('\n');
}

// Added to the first prompt after the owner pressed Stop: the model has no other way to learn that
// the page it read earlier is no longer connected, and otherwise answers from the old result.
export function buildPageReleasedNote() {
  return [
    '[DeepSeek WebMCP: the owner pressed Stop, so the connection to the previous page is closed and anything you read from it is out of date.',
    'If this request needs a webpage, call inspect_page again; it connects to the page that is open now.]',
  ].join(' ');
}

const MAX_CONVERSATIONS = 50;
const MAX_SEEN_IDS = 500;
const MAX_PENDING = 8;

function validConversation(value) {
  return Boolean(value)
    && Array.isArray(value.seen)
    && value.seen.length <= MAX_SEEN_IDS
    && value.seen.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    && typeof value.awaiting === 'boolean'
    && (value.pending === null || typeof value.pending === 'string')
    && (value.corrections === undefined || (Number.isInteger(value.corrections) && value.corrections >= 0));
}

// Per-tab Work authority. Pure and serializable so the MV3 worker can rebuild it
// from chrome.storage.session. Deliberately no call-count bound (owner decision);
// stopping is Work off or closing the tab.
export class WorkController {
  #work = false;
  #calls = 0;
  #conversations = new Map();

  static fromSnapshot(snapshot) {
    const controller = new WorkController();
    if (
      !snapshot
      || snapshot.work !== true
      || !Number.isInteger(snapshot.calls)
      || snapshot.calls < 0
      || !snapshot.conversations
      || typeof snapshot.conversations !== 'object'
      || Array.isArray(snapshot.conversations)
    ) {
      return controller;
    }
    const entries = Object.entries(snapshot.conversations);
    if (entries.length > MAX_CONVERSATIONS || !entries.every(([, value]) => validConversation(value))) {
      return controller;
    }
    controller.#work = true;
    controller.#calls = snapshot.calls;
    for (const [key, value] of entries) {
      controller.#conversations.set(key, { seen: [...value.seen], awaiting: value.awaiting, pending: value.pending, corrections: value.corrections ?? 0 });
    }
    return controller;
  }

  snapshot() {
    return {
      work: this.#work,
      calls: this.#calls,
      conversations: Object.fromEntries([...this.#conversations].map(([key, value]) => [key, { ...value, seen: [...value.seen] }])),
    };
  }

  get status() {
    return Object.freeze({ work: this.#work, calls: this.#calls });
  }

  enable() {
    this.#work = true;
  }

  #conversation(key) {
    let conversation = this.#conversations.get(key);
    if (!conversation) {
      conversation = { seen: [], awaiting: false, pending: null, corrections: 0 };
      this.#conversations.set(key, conversation);
      while (this.#conversations.size > MAX_CONVERSATIONS) {
        this.#conversations.delete(this.#conversations.keys().next().value);
      }
    }
    return conversation;
  }

  // `resume` marks a reply that finished while its conversation was not displayed.
  // It is processed only if WebMCP sent a result there and has not seen the reply yet.
  acceptCompletion(conversationKey, text, { resume = false } = {}) {
    if (!this.#work || typeof conversationKey !== 'string') {
      return Object.freeze({ accepted: false, code: 'WORK_OFF' });
    }
    if (resume && this.#conversations.get(conversationKey)?.awaiting !== true) {
      return Object.freeze({ accepted: false, code: 'NOTHING_TO_RESUME' });
    }

    const calls = parseToolCalls(text);
    const conversation = this.#conversation(conversationKey);
    // An already-executed call is the previous reply still on screen, not DeepSeek's
    // answer to the delivered result, so the conversation keeps waiting.
    if (calls.some((call) => conversation.seen.includes(call.id))) {
      return Object.freeze({ accepted: false, code: 'DUPLICATE_CALL', calls: Object.freeze([]) });
    }
    conversation.awaiting = false;
    if (calls.length === 0 && usesNativeToolSyntax(text)) {
      // Bounded so a model that keeps answering in its own syntax cannot loop forever.
      if (conversation.corrections >= MAX_FORMAT_CORRECTIONS) {
        return Object.freeze({ accepted: false, code: 'NATIVE_TOOL_SYNTAX_REPEATED', calls });
      }
      conversation.corrections += 1;
      return Object.freeze({ accepted: true, code: 'NATIVE_TOOL_SYNTAX', calls });
    }
    if (calls.length === 0) return Object.freeze({ accepted: true, code: 'NO_TOOL_CALL', calls });

    conversation.corrections = 0;
    conversation.seen.push(...calls.map((call) => call.id));
    if (conversation.seen.length > MAX_SEEN_IDS) conversation.seen.splice(0, conversation.seen.length - MAX_SEEN_IDS);
    this.#calls += calls.length;
    return Object.freeze({ accepted: true, code: 'TOOL_CALLS', calls: Object.freeze(calls) });
  }

  setPending(conversationKey, text) {
    this.#conversation(conversationKey).pending = text;
    const pending = [...this.#conversations].filter(([, value]) => value.pending !== null);
    for (const [key] of pending.slice(0, Math.max(0, pending.length - MAX_PENDING))) {
      this.#conversations.get(key).pending = null;
    }
  }

  pendingFor(conversationKey) {
    return this.#conversations.get(conversationKey)?.pending ?? null;
  }

  // DeepSeek was seen generating here, so its finished reply may be resumed later even
  // if the user switched chats before any tool call existed.
  generationStarted(conversationKey) {
    if (this.#work) this.#conversation(conversationKey).awaiting = true;
  }

  // The result reached the composer and was sent: wait for DeepSeek's next reply.
  delivered(conversationKey) {
    const conversation = this.#conversation(conversationKey);
    conversation.pending = null;
    conversation.awaiting = true;
  }
}
