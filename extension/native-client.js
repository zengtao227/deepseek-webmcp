const HOST_NAME = 'com.deepseek.webmcp.native';
export const TOOL_NAMES = Object.freeze(['open_workspace', 'read', 'write', 'edit', 'bash']);
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

export async function callNativeTool(call) {
  if (!call || typeof call !== 'object' || !isToolAllowed(call.name)) {
    throw new NativeClientError('Tool is not allowed.', 'TOOL_NOT_ALLOWED');
  }

  let response;
  try {
    response = await chrome.runtime.sendNativeMessage(HOST_NAME, {
      version: 1,
      id: call.id,
      tool: call.name,
      arguments: call.arguments,
    });
  } catch (error) {
    throw new NativeClientError(error?.message || 'Native Messaging failed.', 'NATIVE_MESSAGING_FAILED');
  }

  if (!response || response.version !== 1 || response.id !== call.id || typeof response.ok !== 'boolean') {
    throw new NativeClientError('Native host returned an invalid response.', 'INVALID_NATIVE_RESPONSE');
  }
  return response;
}
