export const BROWSER_TOOL_NAMES = Object.freeze(['inspect_page', 'inspect_form', 'fill', 'select', 'click', 'scroll', 'keyboard']);

export const BROWSER_TOOL_ARGUMENTS = Object.freeze({
  inspect_page: { required: {}, optional: {} },
  inspect_form: { required: {}, optional: {} },
  fill: { required: { ref: '<element-ref>', value: '<text>' }, optional: {} },
  select: { required: { ref: '<element-ref>', value: '<option value or label>' }, optional: {} },
  click: { required: { ref: '<element-ref>' }, optional: {} },
  scroll: {
    required: { deltaY: '<pixels; positive scrolls down, negative up; at most 3000>' },
    optional: { deltaX: '<pixels; positive scrolls right, negative left; at most 3000>', ref: '<element-ref of an element inside the area to scroll>' },
  },
  keyboard: {
    required: { ref: '<editable element-ref>', actions: '<1-64 keyboard actions>' },
    optional: {},
  },
});

const ALLOWED_BROWSER_TOOLS = new Set(BROWSER_TOOL_NAMES);

export function isBrowserToolAllowed(name) {
  return typeof name === 'string' && ALLOWED_BROWSER_TOOLS.has(name);
}

export class BrowserClientError extends Error {
  constructor(message, code = 'BROWSER_CLIENT_ERROR') {
    super(message);
    this.name = 'BrowserClientError';
    this.code = code;
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

const KEYBOARD_MODIFIERS = new Set(['Alt', 'Control', 'Meta', 'Shift']);

function validKeyboardAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  if (action.type === 'text') {
    return exactKeys(action, ['type', 'text'])
      && typeof action.text === 'string'
      && action.text.length <= 16_384;
  }
  if (action.type !== 'key') return false;
  const allowed = ['type', 'key', 'modifiers', 'repeat'];
  if (!Object.keys(action).every((key) => allowed.includes(key))) return false;
  if (typeof action.key !== 'string' || action.key.length === 0 || action.key.length > 64) return false;
  if (action.modifiers !== undefined) {
    if (!Array.isArray(action.modifiers) || action.modifiers.length > 4) return false;
    if (new Set(action.modifiers).size !== action.modifiers.length) return false;
    if (!action.modifiers.every((modifier) => KEYBOARD_MODIFIERS.has(modifier))) return false;
  }
  if (action.repeat !== undefined && (!Number.isInteger(action.repeat) || action.repeat < 1 || action.repeat > 100)) return false;
  return true;
}

export function validateBrowserToolArguments(name, args) {
  if (!isBrowserToolAllowed(name)) return { code: 'TOOL_NOT_ALLOWED', message: 'Browser tool is not allowed.' };
  if (name === 'inspect_page' || name === 'inspect_form') {
    return exactKeys(args, []) ? null : { code: 'INVALID_ARGUMENTS', message: `${name} accepts no arguments.` };
  }
  if (name === 'scroll') {
    const allowed = ['deltaY', 'deltaX', 'ref'];
    const valid = args
      && typeof args === 'object'
      && !Array.isArray(args)
      && Object.keys(args).every((key) => allowed.includes(key))
      && Number.isFinite(args.deltaY)
      && (args.deltaX === undefined || Number.isFinite(args.deltaX))
      && (args.ref === undefined || (typeof args.ref === 'string' && args.ref.length > 0 && args.ref.length <= 64));
    return valid ? null : { code: 'INVALID_ARGUMENTS', message: 'scroll requires deltaY (number) and accepts optional deltaX (number) and ref (string).' };
  }
  if (name === 'keyboard') {
    const valid = exactKeys(args, ['ref', 'actions'])
      && typeof args.ref === 'string'
      && args.ref.length > 0
      && args.ref.length <= 64
      && Array.isArray(args.actions)
      && args.actions.length >= 1
      && args.actions.length <= 64
      && args.actions.every(validKeyboardAction)
      && args.actions.reduce((total, action) => total + (action.type === 'text' ? action.text.length : 0), 0) <= 16_384;
    return valid ? null : { code: 'INVALID_ARGUMENTS', message: 'keyboard requires ref and 1-64 bounded key/text actions.' };
  }
  if (name === 'click') {
    if (!exactKeys(args, ['ref']) || typeof args.ref !== 'string' || args.ref.length === 0 || args.ref.length > 64) {
      return { code: 'INVALID_ARGUMENTS', message: 'click requires exactly one non-empty ref string.' };
    }
    return null;
  }
  if (
    !exactKeys(args, ['ref', 'value'])
    || typeof args.ref !== 'string'
    || args.ref.length === 0
    || args.ref.length > 64
    || typeof args.value !== 'string'
    || args.value.length > 16_384
  ) {
    return { code: 'INVALID_ARGUMENTS', message: `${name} requires exactly ref and value strings.` };
  }
  return null;
}

const MAX_BROWSER_FRAMES = 32;
const MAX_AGGREGATED_ELEMENTS = 120;
const MAX_AGGREGATED_TEXT_CHARS = 12_000;

function normalizeFrameIds(frameIds) {
  const source = Array.isArray(frameIds) ? frameIds : [0];
  const unique = [...new Set(source.filter((id) => Number.isInteger(id) && id >= 0))];
  if (!unique.includes(0)) unique.unshift(0);
  return unique.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b)).slice(0, MAX_BROWSER_FRAMES);
}

function namespaceRef(frameId, ref) {
  return frameId === 0 ? ref : `f${frameId}:${ref}`;
}

function parseRoutedRef(ref) {
  const match = /^f(\d+):(e\d+)$/.exec(ref);
  if (!match) return { frameId: 0, localRef: ref };
  return { frameId: Number(match[1]), localRef: match[2] };
}

function namespaceResponseRef(frameId, response) {
  if (!response || response.version !== 1 || typeof response.ok !== 'boolean') return response;
  if (response.ok && response.result && typeof response.result === 'object' && typeof response.result.ref === 'string') {
    return { ...response, result: { ...response.result, ref: namespaceRef(frameId, response.result.ref) } };
  }
  if (!response.ok && response.error?.details && typeof response.error.details.ref === 'string') {
    return {
      ...response,
      error: {
        ...response.error,
        details: { ...response.error.details, ref: namespaceRef(frameId, response.error.details.ref) },
      },
    };
  }
  return response;
}

async function sendFrameTool(tabId, frameId, tool, args) {
  return chrome.tabs.sendMessage(tabId, {
    type: 'webmcp.browser.tool',
    version: 1,
    tool,
    arguments: args,
  }, { frameId });
}

function validFrameResponse(response) {
  return Boolean(response && response.version === 1 && typeof response.ok === 'boolean');
}

function frameSummary(frameId, result) {
  return {
    frameId,
    title: typeof result?.title === 'string' ? result.title : '',
    url: typeof result?.url === 'string' ? result.url : '',
  };
}

function boundedText(value, limit = MAX_AGGREGATED_TEXT_CHARS) {
  const text = String(value ?? '');
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true };
}

async function inspectAcrossFrames(tabId, tool, frameIds) {
  const settled = await Promise.all(normalizeFrameIds(frameIds).map(async (frameId) => {
    try {
      const response = await sendFrameTool(tabId, frameId, tool, {});
      return validFrameResponse(response) && response.ok ? { frameId, response } : { frameId, response: null };
    } catch {
      return { frameId, response: null };
    }
  }));

  const available = settled.filter(({ response }) => response !== null);
  const top = available.find(({ frameId }) => frameId === 0);
  if (!top) throw new BrowserClientError('The attached target page is no longer available. Attach it again.', 'TARGET_NOT_ATTACHED');

  const unavailableCount = settled.length - available.length;
  const warnings = unavailableCount > 0
    ? [{ code: 'FRAME_UNAVAILABLE', count: unavailableCount }]
    : [];

  if (tool === 'inspect_form') {
    const controls = [];
    let formCount = 0;
    let truncated = false;
    for (const { frameId, response } of available) {
      const result = response.result ?? {};
      formCount += Number.isFinite(result.formCount) ? result.formCount : 0;
      truncated ||= result.truncated === true;
      for (const control of result.controls ?? []) {
        if (controls.length >= MAX_AGGREGATED_ELEMENTS) {
          truncated = true;
          break;
        }
        controls.push({ ...control, ref: namespaceRef(frameId, control.ref) });
      }
    }
    return {
      version: 1,
      ok: true,
      result: {
        title: top.response.result.title,
        formCount,
        controls,
        truncated,
        frames: available.map(({ frameId, response }) => frameSummary(frameId, response.result)),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }

  const elements = [];
  const textParts = [];
  let truncated = false;
  for (const { frameId, response } of available) {
    const result = response.result ?? {};
    truncated ||= result.truncated === true;
    if (typeof result.text === 'string' && result.text) {
      textParts.push(frameId === 0
        ? result.text
        : `[Embedded frame f${frameId}${result.url ? ` — ${result.url}` : ''}] ${result.text}`);
    }
    for (const element of result.elements ?? []) {
      if (elements.length >= MAX_AGGREGATED_ELEMENTS) {
        truncated = true;
        break;
      }
      elements.push({ ...element, ref: namespaceRef(frameId, element.ref) });
    }
  }
  const combined = boundedText(textParts.join('\n'));
  truncated ||= combined.truncated;

  return {
    version: 1,
    ok: true,
    result: {
      ...top.response.result,
      text: combined.text,
      elements,
      truncated,
      frames: available.map(({ frameId, response }) => frameSummary(frameId, response.result)),
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

export async function callBrowserTool(tabId, call, { frameIds = [0] } = {}) {
  if (!Number.isInteger(tabId)) throw new BrowserClientError('No owner-attached target tab.', 'TARGET_NOT_ATTACHED');
  if (!call || typeof call !== 'object' || typeof call.id !== 'string') {
    throw new BrowserClientError('Browser tool call is invalid.', 'INVALID_TOOL_CALL');
  }
  const argumentError = validateBrowserToolArguments(call.name, call.arguments);
  if (argumentError) {
    return { version: 1, id: call.id, ok: false, error: argumentError };
  }

  if (call.name === 'inspect_page' || call.name === 'inspect_form') {
    const response = await inspectAcrossFrames(tabId, call.name, frameIds);
    return { ...response, id: call.id };
  }

  const routed = typeof call.arguments?.ref === 'string'
    ? parseRoutedRef(call.arguments.ref)
    : { frameId: 0, localRef: null };
  const availableFrames = normalizeFrameIds(frameIds);
  if (!availableFrames.includes(routed.frameId)) {
    return {
      version: 1,
      id: call.id,
      ok: false,
      error: { code: 'FRAME_UNAVAILABLE', message: 'The referenced embedded frame is no longer available.' },
    };
  }

  const args = routed.localRef === null
    ? call.arguments
    : { ...call.arguments, ref: routed.localRef };

  let response;
  try {
    response = await sendFrameTool(tabId, routed.frameId, call.name, args);
  } catch {
    if (routed.frameId !== 0) {
      return {
        version: 1,
        id: call.id,
        ok: false,
        error: { code: 'FRAME_UNAVAILABLE', message: 'The referenced embedded frame is no longer available.' },
      };
    }
    throw new BrowserClientError('The attached target page is no longer available. Attach it again.', 'TARGET_NOT_ATTACHED');
  }

  if (!validFrameResponse(response)) {
    throw new BrowserClientError('Target page returned an invalid browser-tool response.', 'INVALID_BROWSER_RESPONSE');
  }

  response = namespaceResponseRef(routed.frameId, response);
  return response.ok
    ? { version: 1, id: call.id, ok: true, result: response.result }
    : { version: 1, id: call.id, ok: false, error: response.error };
}
