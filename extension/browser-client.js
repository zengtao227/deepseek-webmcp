export const BROWSER_TOOL_NAMES = Object.freeze(['inspect_page', 'inspect_form', 'fill', 'select', 'click', 'scroll']);

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
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
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

export async function callBrowserTool(tabId, call) {
  if (!Number.isInteger(tabId)) throw new BrowserClientError('No owner-attached target tab.', 'TARGET_NOT_ATTACHED');
  if (!call || typeof call !== 'object' || typeof call.id !== 'string') {
    throw new BrowserClientError('Browser tool call is invalid.', 'INVALID_TOOL_CALL');
  }
  const argumentError = validateBrowserToolArguments(call.name, call.arguments);
  if (argumentError) {
    return { version: 1, id: call.id, ok: false, error: argumentError };
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: 'webmcp.browser.tool',
      version: 1,
      tool: call.name,
      arguments: call.arguments,
    });
  } catch {
    throw new BrowserClientError('The attached target page is no longer available. Attach it again.', 'TARGET_NOT_ATTACHED');
  }

  if (!response || response.version !== 1 || typeof response.ok !== 'boolean') {
    throw new BrowserClientError('Target page returned an invalid browser-tool response.', 'INVALID_BROWSER_RESPONSE');
  }

  return response.ok
    ? { version: 1, id: call.id, ok: true, result: response.result }
    : { version: 1, id: call.id, ok: false, error: response.error };
}
