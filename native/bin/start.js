#!/usr/bin/env node
import { createNativeMcpServer } from '../src/server.js';
import { createNativeStdioServer } from '../src/stdio.js';
import { createWorkspaceRuntime, NATIVE_WORKSPACE_ROOT } from '../src/workspace.js';

const runtimeToken = process.env.WEBMCP_RUNTIME_TOKEN;
if (!runtimeToken) {
  process.stderr.write('WEBMCP_RUNTIME_TOKEN is required.\n');
  process.exit(2);
}

const runtime = createWorkspaceRuntime({
  root: NATIVE_WORKSPACE_ROOT,
  runtimeToken,
  maxTimeoutMs: 30_000,
});
const server = createNativeMcpServer(runtime, { serverVersion: '0.0.2-p2' });
const stdio = createNativeStdioServer(server);

stdio.start();
