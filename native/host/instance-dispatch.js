import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeHostError, dispatchNativeRequest, loadNativeHostConfig, mapContainerResponse, validateNativeRequest } from './docker-dispatch.js';
import { sanitizeLogText } from './firewall.js';
import { INSTANCE_ID, dispatchHostCommand, pinnedInstanceRelease } from './host-access.js';
import { hostKind } from './local-paths.js';

// DeepSeek's workspace tools run in the shared WebMCP runtime's `deepseek` instance (WebMCP roadmap §O:
// Local Workspace and Multi-Mount are shared, never re-implemented per provider). The pinned release's
// host relay owns that instance's folders, write switches, access leases and container, so the WebMCP
// App manages them for DeepSeek as it does for every other instance.
const MAX_STDOUT_BYTES = 640 * 1024;
// bash is bounded to 30 s inside the runtime; the relay may first have to start the instance
// container, and a revoke may recreate it. The extension gives up on a native call after 60 s.
const CALL_DEADLINE_MS = 50_000;

// Stable for this Mac user, so a workspaceId (derived from it by the runtime) stays valid across calls.
export async function instanceRuntimeToken(home) {
  return createHash('sha256').update(`webmcp-instance\0${INSTANCE_ID}\0${await realpath(home)}`).digest('hex');
}

// Only the Docker location is still read from DeepSeek's own config: the folders, write switches and
// access now belong to the instance.
export async function readDockerPath(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw new NativeHostError('Unable to read native host config.', 'INVALID_CONFIG');
  }
  if (typeof parsed?.dockerPath !== 'string' || !path.isAbsolute(parsed.dockerPath)) throw new NativeHostError('dockerPath must be absolute.', 'INVALID_CONFIG');
  return parsed.dockerPath;
}

function toolRpc(request) {
  return { jsonrpc: '2.0', id: request.id, method: 'tools/call', params: { name: request.tool, arguments: request.arguments } };
}

// The relay's answer for this request id; other lines (none are expected) are ignored.
function answerFor(request, stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.id === request.id) return parsed;
  }
  return null;
}

// Runs one script of the pinned release with the instance environment and collects its output.
// Chrome starts native hosts with a minimal PATH; the release finds Docker through it.
export async function runPinnedRelease(script, args, input, {
  dockerPath,
  home = os.homedir(),
  lockFile,
  resolveRelease = () => pinnedInstanceRelease({ home, lockFile }),
  spawnImpl = spawn,
  nodePath = process.execPath,
  env = process.env,
  deadlineMs = CALL_DEADLINE_MS,
} = {}) {
  if (typeof dockerPath !== 'string' || !path.isAbsolute(dockerPath)) throw new NativeHostError('dockerPath must be absolute.', 'INVALID_CONFIG');
  const releaseRoot = await resolveRelease();
  const childEnv = {
    ...env,
    PATH: [path.dirname(dockerPath), env.PATH ?? '/usr/bin:/bin'].join(path.delimiter),
    WEBMCP_INSTANCE_ID: INSTANCE_ID,
    WEBMCP_RUNTIME_TOKEN: await instanceRuntimeToken(home),
  };

  return new Promise((resolve, reject) => {
    const child = spawnImpl(nodePath, [path.join(releaseRoot, script), ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const abort = (error) => {
      try { child.kill('SIGKILL'); } catch {}
      finish(reject, error);
    };
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        abort(new NativeHostError('Runtime response exceeded the host limit.', 'RESPONSE_TOO_LARGE'));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => finish(reject, new NativeHostError(`Unable to launch the WebMCP runtime: ${error.message}`, 'RUNTIME_START_FAILED')));
    child.on('close', (code) => finish(resolve, {
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8').slice(0, 4096),
    }));
    timer = setTimeout(() => abort(new NativeHostError('The WebMCP runtime timed out.', 'RUNTIME_TIMEOUT')), deadlineMs);
    child.stdin.end(input);
  });
}

export function runtimeFailure(stderr, fallback, code) {
  let message = fallback;
  try { message = sanitizeLogText(stderr || fallback); } catch {}
  return new NativeHostError(message, code);
}

export async function dispatchInstanceRequest(request, options = {}) {
  validateNativeRequest(request);
  if (request.tool === 'host_command') throw new NativeHostError('Host commands require the separate trusted host dispatcher.', 'TOOL_NOT_ALLOWED');
  // The relay forwards the line, then lets the runtime finish before it exits.
  const { code, stdout, stderr } = await runPinnedRelease(path.join('native', 'host', 'start.js'), [], `${JSON.stringify(toolRpc(request))}\n`, options);
  const answer = answerFor(request, stdout);
  if (answer === null) throw runtimeFailure(stderr, code === 0 ? 'The WebMCP runtime returned no answer.' : 'The WebMCP runtime failed.', 'RUNTIME_FAILED');
  return mapContainerResponse(request, answer);
}

// On macOS the workspace tools run in the shared runtime's `deepseek` instance, which the WebMCP App
// manages. The App and the instance controller exist only on macOS, so WSL keeps its own one-shot
// container.
export async function dispatchToolRequest(request, {
  configFile,
  kind = hostKind(),
  hostCommand = dispatchHostCommand,
  legacy = async (req) => dispatchNativeRequest(req, await loadNativeHostConfig(configFile)),
  instance = async (req) => dispatchInstanceRequest(req, { dockerPath: await readDockerPath(configFile) }),
} = {}) {
  if (request?.tool === 'host_command') return hostCommand(request, { configFile });
  if (kind !== 'macos') return legacy(request);
  return instance(request);
}
