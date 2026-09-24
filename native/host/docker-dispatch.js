import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sanitizeJsonRpcEnvelope, sanitizeLogText } from './firewall.js';
import { browserProfileRoots, fullAccessMaskCandidates, leasePath, manifestDirFor } from './local-paths.js';
import { runtimeBootstrapScript } from './runtime-bootstrap.js';

const execFileAsync = promisify(execFile);
const ALLOWED_TOOLS = new Set(['open_workspace', 'read', 'write', 'edit', 'bash', 'host_command']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TOOL_ARGUMENTS = new Map([
  ['open_workspace', new Set(['path'])],
  ['read', new Set(['workspaceId', 'path', 'offset', 'limit'])],
  ['write', new Set(['workspaceId', 'path', 'content'])],
  ['edit', new Set(['workspaceId', 'path', 'edits'])],
  ['bash', new Set(['workspaceId', 'command', 'workingDirectory', 'timeout'])],
  ['host_command', new Set(['action', 'command', 'workingDirectory', 'timeout', 'sessionId', 'stdoutOffset', 'stderrOffset'])],
]);
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const MAX_STDOUT_BYTES = 640 * 1024;
const MAX_BASH_TIMEOUT_SECONDS = 30;
const HOST_DEADLINE_MS = 35_000;
const CLEANUP_DEADLINE_MS = 10_000;

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
  if (typeof request.tool !== 'string' || !ALLOWED_TOOLS.has(request.tool)) fail('Tool is not allowed.', 'TOOL_NOT_ALLOWED');
  exactObject(request.arguments, TOOL_ARGUMENTS.get(request.tool), 'arguments');
  if (request.tool === 'open_workspace' && request.arguments.path !== '/workspace') {
    fail('open_workspace accepts only /workspace.', 'INVALID_WORKSPACE_ROOT');
  }
  if (request.tool === 'bash' && request.arguments.timeout !== undefined) {
    const timeout = Number(request.arguments.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_BASH_TIMEOUT_SECONDS) {
      fail(`bash timeout must be between 0 and ${MAX_BASH_TIMEOUT_SECONDS} seconds.`, 'INVALID_TIMEOUT');
    }
  }
  return request;
}

// This code (and the extension beside it) runs outside the container. Protected
// control-plane paths beneath a broader selected workspace are masked; host executables
// themselves must remain outside the writable workspace.
export const HOST_CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function buildWorkspaceControlPlaneMasks(canonicalRoot, {
  configPath,
  dockerPath,
  home = os.homedir(),
  hostCodeRoot = HOST_CODE_ROOT,
  nodePath = process.execPath,
} = {}) {
  const canonicalHome = await realpath(home).catch(() => path.resolve(home));
  if (canonicalRoot === canonicalHome) {
    fail('For the whole home folder use Full access instead.', 'WORKSPACE_CONTAINS_CONTROL_PLANE');
  }

  for (const target of [nodePath, dockerPath]) {
    const lexical = path.resolve(target);
    const resolved = await realpath(target).catch(() => lexical);
    if (contains(canonicalRoot, resolved) || contains(canonicalRoot, lexical)) {
      fail('Node and Docker must stay outside the model-writable workspace.', 'WORKSPACE_CONTAINS_CONTROL_PLANE');
    }
  }

  const found = [];
  const requiredControlPlane = new Set([
    hostCodeRoot,
    path.dirname(configPath),
    path.join(home, '.docker'),
    ...browserProfileRoots(home).map(manifestDirFor),
  ]);
  const controlPlane = new Set([
    ...requiredControlPlane,
    ...fullAccessMaskCandidates({ home: canonicalHome, hostCodeRoot, nodePath }),
  ]);
  for (const target of controlPlane) {
    const lexical = path.resolve(target);
    const resolved = await realpath(target).catch(() => null);
    let candidate = resolved;
    if (!candidate) {
      let ancestor = path.dirname(lexical);
      while (true) {
        try {
          candidate = path.join(await realpath(ancestor), path.relative(ancestor, lexical));
          break;
        } catch (error) {
          if (error?.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
          ancestor = path.dirname(ancestor);
        }
      }
    }
    if (contains(candidate, canonicalRoot)) {
      fail('The selected workspace must not be inside a protected host path.', 'WORKSPACE_CONTAINS_CONTROL_PLANE');
    }
    if (!contains(canonicalRoot, candidate)) continue;
    if (!resolved) {
      if (requiredControlPlane.has(target)) {
        fail('A protected DeepSeek WebMCP path inside the selected workspace cannot be resolved.', 'CONTROL_PLANE_PATH_UNAVAILABLE');
      }
      continue;
    }
    const info = await lstat(resolved);
    if (!info.isDirectory() && !info.isFile()) {
      fail('A protected DeepSeek WebMCP path must resolve to a regular file or directory.', 'INVALID_CONTROL_PLANE_PATH');
    }
    found.push({
      type: info.isDirectory() ? 'directory' : 'file',
      relative: path.relative(canonicalRoot, resolved),
    });
  }

  found.sort((left, right) => left.relative.localeCompare(right.relative));
  const masks = [];
  for (const item of found) {
    if (masks.some((mask) => mask.type === 'directory' && contains(mask.relative, item.relative))) continue;
    masks.push(item);
  }
  return masks.map(({ type, relative }) => Object.freeze({
    type,
    destination: path.posix.join('/workspace', ...relative.split(path.sep)),
  }));
}

// Full access mounts the home folder writable, so everything in the control plane and
// the credential stores is covered by an empty read-only mount instead of refusing it.
async function buildFullAccessMasks(canonicalHome, home) {
  const found = [];
  for (const candidate of fullAccessMaskCandidates({ home, hostCodeRoot: HOST_CODE_ROOT, nodePath: process.execPath })) {
    let resolved;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      continue;
    }
    if (resolved === canonicalHome || !contains(canonicalHome, resolved)) continue;
    const info = await lstat(resolved);
    found.push({ type: info.isDirectory() ? 'directory' : 'file', relative: path.relative(canonicalHome, resolved) });
  }
  found.sort((left, right) => left.relative.localeCompare(right.relative));
  const masks = [];
  for (const item of found) {
    // A path under an already hidden directory is hidden too; Docker cannot mount inside it.
    if (masks.some((mask) => mask.type === 'directory' && contains(mask.relative, item.relative))) continue;
    masks.push(item);
  }
  return masks.map(({ type, relative }) => Object.freeze({ type, destination: path.posix.join('/workspace', ...relative.split(path.sep)) }));
}

export async function readFullAccessLease({ home = os.homedir(), now = Date.now() } = {}) {
  try {
    const lease = JSON.parse(await readFile(leasePath(home), 'utf8'));
    return Number.isSafeInteger(lease?.expiresAt) && lease.expiresAt > now ? lease.expiresAt : null;
  } catch {
    return null;
  }
}

export async function loadNativeHostConfig(configPath, { home = os.homedir(), now = Date.now() } = {}) {
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
  const fullAccessUntil = await readFullAccessLease({ home, now });
  let canonicalRoot;
  let masks = [];
  if (fullAccessUntil !== null) {
    canonicalRoot = await realpath(home).catch(() => fail('Home folder cannot be resolved.', 'INVALID_CONFIG'));
    masks = await buildFullAccessMasks(canonicalRoot, home);
  } else {
    canonicalRoot = await realpath(parsed.workspaceRoot).catch(() => fail('workspaceRoot cannot be resolved.', 'INVALID_CONFIG'));
    masks = await buildWorkspaceControlPlaneMasks(canonicalRoot, { configPath, dockerPath: parsed.dockerPath, home });
  }
  const runtimeToken = createHash('sha256').update(`${parsed.image}\0${canonicalRoot}`).digest('hex');
  return Object.freeze({ ...parsed, canonicalRoot, runtimeToken, fullAccessUntil, masks: Object.freeze(masks) });
}

// `--mount` is parsed as CSV: a field containing a comma or quote must be quoted.
function mountSpec(fields) {
  return fields.map((field) => (/[",]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field)).join(',');
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
    '--mount', mountSpec(['type=bind', `src=${config.canonicalRoot}`, 'dst=/workspace', 'bind-recursive=disabled']),
    ...(config.masks ?? []).flatMap((mask) => ['--mount', mask.type === 'directory'
      ? mountSpec(['type=tmpfs', `dst=${mask.destination}`, 'readonly', 'tmpfs-mode=000'])
      : mountSpec(['type=bind', 'src=/dev/null', `dst=${mask.destination}`, 'readonly'])]),
    config.image,
    'node', '--input-type=module', '-e', runtimeBootstrapScript(),
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

export async function dispatchNativeRequest(request, config, options = {}) {
  validateNativeRequest(request);
  if (request.tool === 'host_command') fail('Host commands require the separate trusted host dispatcher.', 'TOOL_NOT_ALLOWED');
  return runContainer(request, config, options);
}

function runContainer(request, config, {
  spawnImpl = spawn,
  execFileImpl = execFileAsync,
} = {}) {
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
      // The answer must not depend on cleanup. A wedged Docker daemon is the most
      // likely reason the deadline fired in the first place, and `docker rm -f`
      // then hangs too. Awaiting it here left the whole call unsettled, so the
      // host wrote no response and Chrome's sendNativeMessage never resolved:
      // the page kept showing work in progress that had already failed.
      finish(reject, error);
      try {
        await execFileImpl(config.dockerPath, ['rm', '-f', invocation.name], {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: CLEANUP_DEADLINE_MS,
        });
      } catch {}
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
  let message = error instanceof Error ? error.message : 'Native host failed.';
  try {
    message = sanitizeLogText(message);
  } catch {
    message = 'Native host failed.';
  }
  return {
    version: 1,
    id: typeof requestId === 'string' ? requestId : null,
    ok: false,
    error: {
      code: error instanceof NativeHostError ? error.code : 'HOST_ERROR',
      message,
    },
  };
}
