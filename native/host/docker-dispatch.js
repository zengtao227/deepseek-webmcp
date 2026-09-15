import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { sanitizeJsonRpcEnvelope, sanitizeLogText } from './firewall.js';

const execFileAsync = promisify(execFile);
const ALLOWED_TOOLS = new Set(['open_workspace', 'read', 'bash']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TOOL_ARGUMENTS = new Map([
  ['open_workspace', new Set(['path'])],
  ['read', new Set(['workspaceId', 'path', 'offset', 'limit'])],
  ['bash', new Set(['workspaceId', 'command', 'workingDirectory', 'timeout'])],
]);
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const MAX_STDOUT_BYTES = 640 * 1024;
const MAX_BASH_TIMEOUT_SECONDS = 30;
const HOST_DEADLINE_MS = 35_000;

export class NativeHostError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NativeHostError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new NativeHostError(message, code);
}

function exactObject(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`, 'INVALID_REQUEST');
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowedKeys.has(key)) fail(`${label} contains unsupported field: ${key}`, 'INVALID_REQUEST');
  }
}

export function validateNativeRequest(request) {
  exactObject(request, new Set(['version', 'id', 'tool', 'arguments']), 'request');
  if (request.version !== 1) fail('Unsupported native protocol version.', 'INVALID_VERSION');
  if (typeof request.id !== 'string' || !ID_PATTERN.test(request.id)) fail('Invalid request id.', 'INVALID_ID');
  if (typeof request.tool !== 'string' || !ALLOWED_TOOLS.has(request.tool)) fail('Tool is not allowed in P2.', 'TOOL_NOT_ALLOWED');
  exactObject(request.arguments, TOOL_ARGUMENTS.get(request.tool), 'arguments');
  if (request.tool === 'open_workspace' && request.arguments.path !== '/workspace') {
    fail('P2 open_workspace accepts only /workspace.', 'INVALID_WORKSPACE_ROOT');
  }
  if (request.tool === 'bash' && request.arguments.timeout !== undefined) {
    const timeout = Number(request.arguments.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_BASH_TIMEOUT_SECONDS) {
      fail(`P2 bash timeout must be between 0 and ${MAX_BASH_TIMEOUT_SECONDS} seconds.`, 'INVALID_TIMEOUT');
    }
  }
  return request;
}

export async function loadNativeHostConfig(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) fail('Native host config path must be absolute.', 'INVALID_CONFIG');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    fail('Unable to read native host config.', 'INVALID_CONFIG');
  }
  exactObject(parsed, new Set(['workspaceRoot', 'image', 'dockerPath']), 'config');
  if (typeof parsed.workspaceRoot !== 'string' || !path.isAbsolute(parsed.workspaceRoot)) fail('workspaceRoot must be absolute.', 'INVALID_CONFIG');
  if (typeof parsed.image !== 'string' || !IMAGE_PATTERN.test(parsed.image)) fail('image must be a local sha256 image id.', 'INVALID_CONFIG');
  if (typeof parsed.dockerPath !== 'string' || !path.isAbsolute(parsed.dockerPath)) fail('dockerPath must be absolute.', 'INVALID_CONFIG');
  const canonicalRoot = await realpath(parsed.workspaceRoot).catch(() => fail('workspaceRoot cannot be resolved.', 'INVALID_CONFIG'));
  const runtimeToken = createHash('sha256').update(`${parsed.image}\0${canonicalRoot}`).digest('hex');
  return Object.freeze({ ...parsed, canonicalRoot, runtimeToken });
}

export function buildDockerInvocation(config, request, {
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  gid = typeof process.getgid === 'function' ? process.getgid() : null,
  random = () => randomBytes(8).toString('hex'),
} = {}) {
  validateNativeRequest(request);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) fail('Native host requires a non-root local user.', 'INVALID_RUNTIME_IDENTITY');
  const name = `deepseek-webmcp-call-${random()}`;
  const args = [
    'run', '--rm', '-i', '--pull', 'never', '--name', name,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`,
    '--env', 'HOME=/tmp',
    '--env', `WEBMCP_RUNTIME_TOKEN=${config.runtimeToken}`,
    '--mount', `type=bind,src=${config.canonicalRoot},dst=/workspace,readonly`,
    config.image,
    'node', '/opt/webmcp/native/bin/start.js',
  ];
  return Object.freeze({ name, command: config.dockerPath, args });
}

function toolRpc(request) {
  return {
    jsonrpc: '2.0',
    id: request.id,
    method: 'tools/call',
    params: { name: request.tool, arguments: request.arguments },
  };
}

function mapContainerResponse(request, response) {
  const safe = sanitizeJsonRpcEnvelope(response);
  if (safe.error) {
    return { version: 1, id: request.id, ok: false, error: { code: 'RUNTIME_ERROR', message: String(safe.error.message ?? 'Runtime error') } };
  }
  const result = safe.result;
  if (result?.isError === true) {
    const payload = result.structuredContent ?? {};
    return {
      version: 1,
      id: request.id,
      ok: false,
      error: {
        code: typeof payload.error === 'string' ? payload.error : 'TOOL_ERROR',
        message: typeof payload.message === 'string' ? payload.message : 'Tool failed',
        ...(payload.details === undefined ? {} : { details: payload.details }),
      },
    };
  }
  return { version: 1, id: request.id, ok: true, result: result?.structuredContent ?? result };
}

export async function dispatchNativeRequest(request, config, {
  spawnImpl = spawn,
  execFileImpl = execFileAsync,
} = {}) {
  validateNativeRequest(request);
  const invocation = buildDockerInvocation(config, request);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    let aborting = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const abort = async (error) => {
      if (settled || aborting) return;
      aborting = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      try { await execFileImpl(config.dockerPath, ['rm', '-f', invocation.name], { encoding: 'utf8', maxBuffer: 1024 * 1024 }); } catch {}
      finish(reject, error);
    };
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        void abort(new NativeHostError('Container response exceeded the host limit.', 'RESPONSE_TOO_LARGE'));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => finish(reject, new NativeHostError(`Unable to launch runtime: ${error.message}`, 'RUNTIME_START_FAILED')));
    child.on('close', (code) => {
      if (settled || aborting) return;
      if (code !== 0) {
        const raw = Buffer.concat(stderr).toString('utf8').slice(0, 4096);
        let message = 'Isolated runtime failed.';
        try { message = sanitizeLogText(raw || message); } catch {}
        finish(reject, new NativeHostError(message, 'RUNTIME_FAILED'));
        return;
      }
      const line = Buffer.concat(stdout).toString('utf8').trim();
      let parsed;
      try { parsed = JSON.parse(line); } catch { finish(reject, new NativeHostError('Runtime returned invalid JSON.', 'INVALID_RUNTIME_RESPONSE')); return; }
      try { finish(resolve, mapContainerResponse(request, parsed)); } catch (error) { finish(reject, error); }
    });
    timer = setTimeout(() => void abort(new NativeHostError('Isolated runtime timed out.', 'RUNTIME_TIMEOUT')), HOST_DEADLINE_MS);
    child.stdin.end(`${JSON.stringify(toolRpc(request))}\n`);
  });
}

export function toNativeError(requestId, error) {
  return {
    version: 1,
    id: typeof requestId === 'string' ? requestId : null,
    ok: false,
    error: {
      code: error instanceof NativeHostError ? error.code : 'HOST_ERROR',
      message: error instanceof Error ? error.message : 'Native host failed.',
    },
  };
}
