import { readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateNativeRequest } from './docker-dispatch.js';
import { sanitizeJsonRpcEnvelope } from './firewall.js';

export const INSTANCE_ID = 'webmcp';
// The runtime names a non-default instance's container `webmcp-native-<id>`.
export const INSTANCE_CONTAINER = `webmcp-native-${INSTANCE_ID}`;
const ARTIFACT_ID = /^[0-9a-f]{40}-[0-9a-f]{64}$/;

// Uninstall removes only DeepSeek's own WebMCP instance: its pin, lease and settings. Its
// release stays in the shared store: no lock spans the providers, so a release that looks
// unused here may be getting pinned by another provider's install at this moment. A later
// install of the same release reuses it. Other providers' state is never touched.
export async function removeExtensionInstance(home = os.homedir()) {
  await rm(path.join(home, '.local', 'share', 'webmcp', 'instances', INSTANCE_ID), { recursive: true, force: true });
  await rm(path.join(home, '.config', 'webmcp', 'instances', INSTANCE_ID), { recursive: true, force: true });
}

export function hostRuntimeRoot(home = os.homedir()) {
  return path.join(home, '.local', 'share', 'webmcp', 'host-runtime');
}

async function moduleAt(releaseRoot, relative) {
  return import(pathToFileURL(path.join(releaseRoot, relative)).href);
}

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The runtime release this adapter version was built against. It ships inside the adapter,
// so rolling the adapter folder back also rolls the pinned runtime back.
export async function readRuntimeLock(lockFile = path.join(ADAPTER_ROOT, 'runtime.lock.json')) {
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  if (!ARTIFACT_ID.test(lock.artifactId ?? '') || !/^[0-9a-f]{64}$/.test(lock.archiveSha256 ?? '')) {
    throw new Error('runtime.lock.json does not pin a webmcp-runtime artifact.');
  }
  return lock;
}

// DeepSeek runs the webmcp-runtime artifact pinned by its installer. It never resolves
// through the shared `current` pointer, which belongs to the default ChatGPT instance.
async function loadCore({ home = os.homedir(), lockFile } = {}) {
  const { artifactId } = await readRuntimeLock(lockFile);
  const releasesRoot = await realpath(path.join(hostRuntimeRoot(home), 'releases'));
  const releaseRoot = await realpath(path.join(releasesRoot, artifactId));
  if (path.dirname(releaseRoot) !== releasesRoot || path.basename(releaseRoot) !== artifactId) {
    throw new Error('Pinned WebMCP runtime release is not immutable.');
  }
  const verifier = await moduleAt(releaseRoot, 'adapter/deploy/deploy-host-runtime.js');
  await verifier.verifyRelease(releaseRoot, { expectedArtifactId: artifactId, entrypoint: 'native/host/start.js' });
  const { createInstanceContext } = await moduleAt(releaseRoot, 'native/deploy/instance-context.js');
  const context = createInstanceContext({ home, instanceId: INSTANCE_ID });
  const releases = await moduleAt(releaseRoot, 'native/deploy/instance-release.js');
  const pinned = await releases.verifyPinnedInstanceRelease(context);
  if (pinned.artifactId !== artifactId || await realpath(pinned.releaseRoot) !== releaseRoot) {
    throw new Error('DeepSeek runtime pin does not match its install config.');
  }
  return {
    context,
    releaseRoot,
    access: await moduleAt(releaseRoot, 'native/deploy/elevated-access.js'),
    workspace: await moduleAt(releaseRoot, 'native/deploy/workspace-config.js'),
    approval: await moduleAt(releaseRoot, 'native/deploy/local-approval.js'),
    commands: await moduleAt(releaseRoot, 'native/host/host-command.js'),
    locks: await moduleAt(releaseRoot, 'native/deploy/instance-lock.js'),
  };
}

// The verified release that runs DeepSeek's instance; its host relay executes the workspace tools.
export async function pinnedInstanceRelease({ home = os.homedir(), lockFile } = {}) {
  return (await loadCore({ home, lockFile })).releaseRoot;
}

// Judged against the instance's own workspace config, as its controller and the WebMCP App judge
// it, so the panel, the App and this gate agree on one lease.
async function leaseState(core) {
  const normal = await core.workspace.loadWorkspaceConfig(core.context.workspaceConfig);
  const [bootSessionId, loginSessionId] = await Promise.all([
    core.access.getBootSessionId(),
    core.access.getLoginSessionId(),
  ]);
  return core.access.loadElevatedLease(core.context.elevatedLease, {
    normalConfig: normal,
    bootSessionId,
    loginSessionId,
    instanceId: INSTANCE_ID,
  });
}

function denied(id, code = 'HOST_ACCESS_NOT_GRANTED', message = 'Temporary Full Host Access is not verified for DeepSeek.') {
  return { version: 1, id, ok: false, error: { code, message } };
}

export async function instanceLeaseStatus({ home, lockFile } = {}) {
  const core = await loadCore({ home, lockFile });
  const state = await leaseState(core);
  if (state.state !== 'active') return { mode: 'stale', leaseState: state.state };
  return { mode: 'elevated', accessLevel: state.lease.accessLevel, expiresAt: new Date(state.lease.expiresAt).toISOString() };
}

export async function clearInstanceLease({ home, lockFile } = {}) {
  const core = await loadCore({ home, lockFile });
  await core.locks.withInstanceLifecycleLock(core.context, () => core.access.clearElevatedLease(core.context.elevatedLease));
}

export async function dispatchHostCommand(request, { configFile, home, lockFile }) {
  validateNativeRequest(request);
  if (request.tool !== 'host_command') return denied(request.id, 'TOOL_NOT_ALLOWED', 'Tool is not a host command.');
  let core;
  let state;
  try {
    core = await loadCore({ home, lockFile });
    state = await leaseState(core);
  } catch {
    return denied(request.id);
  }
  if (state.state !== 'active' || state.lease.accessLevel !== 'full-host') return denied(request.id);
  const handler = core.commands.createHostCommandHandler({
    leasePath: core.context.elevatedLease,
    configPath: core.context.workspaceConfig,
    expectedLeaseId: state.lease.id,
    instanceId: INSTANCE_ID,
  });
  const raw = await handler.call(request.arguments);
  const safe = sanitizeJsonRpcEnvelope({ jsonrpc: '2.0', id: request.id, result: raw }).result;
  const payload = safe?.structuredContent ?? {};
  return safe?.isError
    ? {
      version: 1, id: request.id, ok: false,
      error: {
        code: String(payload.error ?? 'HOST_COMMAND_FAILED'),
        message: String(payload.message ?? 'Host command failed.'),
        details: payload,
      },
    }
    : { version: 1, id: request.id, ok: true, result: payload };
}
