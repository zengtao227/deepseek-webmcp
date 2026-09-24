// Starts the webmcp-runtime tool server that the pinned image ships under /opt/webmcp,
// with DeepSeek's own policy: the runtime token is mandatory (fail closed), commands are
// bounded to 30 s, and the model receives DeepSeek's workspace instruction.
export const DEEPSEEK_CHECKOUT_INSTRUCTION = 'Workspace opened for bounded DeepSeek WebMCP coding. Use only the exposed tools and remain inside /workspace.';
export const DEEPSEEK_MAX_TIMEOUT_MS = 30_000;
export const DEEPSEEK_SERVER_VERSION = '0.0.2-p2';

export function runtimeBootstrapScript(runtimeRoot = '/opt/webmcp') {
  const at = (relative) => JSON.stringify(`${runtimeRoot}/${relative}`);
  return [
    'const runtimeToken = process.env.WEBMCP_RUNTIME_TOKEN;',
    "if (!runtimeToken) { process.stderr.write('WEBMCP_RUNTIME_TOKEN is required.\\n'); process.exit(2); }",
    `const { createWorkspaceRuntime, NATIVE_WORKSPACE_ROOT } = await import(${at('native/src/workspace.js')});`,
    `const { createNativeMcpServer } = await import(${at('native/src/server.js')});`,
    `const { createNativeStdioServer } = await import(${at('native/src/stdio.js')});`,
    'const runtime = createWorkspaceRuntime({',
    '  root: NATIVE_WORKSPACE_ROOT,',
    '  runtimeToken,',
    `  maxTimeoutMs: ${DEEPSEEK_MAX_TIMEOUT_MS},`,
    `  checkoutInstruction: ${JSON.stringify(DEEPSEEK_CHECKOUT_INSTRUCTION)},`,
    '});',
    `createNativeStdioServer(createNativeMcpServer(runtime, { serverVersion: ${JSON.stringify(DEEPSEEK_SERVER_VERSION)} })).start();`,
  ].join('\n');
}
