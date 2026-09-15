const HOST_NAME = 'com.deepseek.webmcp.native';
export const P2_TOOL_NAMES = Object.freeze(['open_workspace', 'read', 'bash']);
const ALLOWED_TOOLS = new Set(P2_TOOL_NAMES);

export function isP2ToolAllowed(name) {
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
  if (!call || typeof call !== 'object' || !isP2ToolAllowed(call.name)) {
    throw new NativeClientError('Tool is not allowed in P2.', 'TOOL_NOT_ALLOWED');
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
