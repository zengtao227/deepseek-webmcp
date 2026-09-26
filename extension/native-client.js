const HOST_NAME = 'com.webmcp.extension';
export const TOOL_NAMES = Object.freeze(['open_workspace', 'read', 'write', 'edit', 'bash', 'host_command']);
const ALLOWED_TOOLS = new Set(TOOL_NAMES);

// Model-facing argument shapes. DeepSeek Web has no tools/list channel, so these are
// restated in every tool result; tests pin them to the native runtime inputSchema.
export const TOOL_ARGUMENTS = Object.freeze({
  open_workspace: { required: { path: '/workspace' }, optional: {} },
  read: {
    required: { workspaceId: '<id>', path: '<relative path>' },
    optional: { offset: 'first line number, >= 1', limit: 'line count, max 5000' },
  },
  write: { required: { workspaceId: '<id>', path: '<relative path>', content: '<full file text>' }, optional: {} },
  edit: {
    required: { workspaceId: '<id>', path: '<relative path>', edits: [{ oldText: '<exact existing text>', newText: '<replacement>' }] },
    optional: {},
  },
  bash: {
    required: { workspaceId: '<id>', command: '<bash command>' },
    optional: { workingDirectory: 'relative directory', timeout: 'seconds, max 30' },
  },
  host_command: {
    required: {},
    optional: {
      action: 'run, start, read or cancel; defaults to run',
      command: 'Mac shell command for run/start; max 16384 bytes',
      workingDirectory: 'absolute Mac directory',
      timeout: 'seconds, max 300',
      sessionId: 'id returned by start for read/cancel',
      stdoutOffset: 'output offset for read',
      stderrOffset: 'output offset for read',
    },
  },
});

export function isToolAllowed(name) {
  return typeof name === 'string' && ALLOWED_TOOLS.has(name);
}

export class NativeClientError extends Error {
  constructor(message, code = 'NATIVE_CLIENT_ERROR') {
    super(message);
    this.name = 'NativeClientError';
    this.code = code;
  }
}

// The local program bounds its own container run, but it is a separate process:
// anything that leaves it alive without writing a response leaves this promise
// unsettled forever, and the page then keeps showing work that already failed.
// Control requests are deliberately not bounded here — those wait on a dialog the
// owner is looking at.
const TOOL_CALL_TIMEOUT_MS = 60_000;

export async function callNativeTool(call) {
  if (!call || typeof call !== 'object' || !isToolAllowed(call.name)) {
    throw new NativeClientError('Tool is not allowed.', 'TOOL_NOT_ALLOWED');
  }

  let timer;
  const bound = new Promise((_, rejectBound) => {
    timer = setTimeout(
      () => rejectBound(new NativeClientError('The local WebMCP runtime did not answer in time.', 'NATIVE_CALL_TIMED_OUT')),
      call.name === 'host_command' && (!call.arguments?.action || call.arguments.action === 'run')
        ? 315_000
        : TOOL_CALL_TIMEOUT_MS,
    );
  });

  let response;
  try {
    response = await Promise.race([
      chrome.runtime.sendNativeMessage(HOST_NAME, {
        version: 1,
        id: call.id,
        tool: call.name,
        arguments: call.arguments,
      }),
      bound,
    ]);
  } catch (error) {
    if (error instanceof NativeClientError) throw error;
    throw new NativeClientError(error?.message || 'Native Messaging failed.', 'NATIVE_MESSAGING_FAILED');
  } finally {
    clearTimeout(timer);
  }

  if (!response || response.version !== 1 || response.id !== call.id || typeof response.ok !== 'boolean') {
    throw new NativeClientError('Native host returned an invalid response.', 'INVALID_NATIVE_RESPONSE');
  }
  return response;
}

const CONTROLS = new Set(['status', 'choose-folder', 'stop-host-access', 'uninstall']);

// Owner settings from the popup; never reachable from page content or model output.
export async function callNativeControl(control, args = {}) {
  if (!CONTROLS.has(control)) throw new NativeClientError('Unknown control request.', 'CONTROL_NOT_ALLOWED');
  const id = `control_${Date.now()}`;
  let response;
  try {
    response = await chrome.runtime.sendNativeMessage(HOST_NAME, { version: 1, id, control, arguments: args });
  } catch (error) {
    throw new NativeClientError(error?.message || 'Native Messaging failed.', 'NATIVE_MESSAGING_FAILED');
  }
  if (!response || response.version !== 1 || response.id !== id || typeof response.ok !== 'boolean') {
    throw new NativeClientError('Native host returned an invalid response.', 'INVALID_NATIVE_RESPONSE');
  }
  return response;
}
