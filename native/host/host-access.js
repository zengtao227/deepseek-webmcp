import { readdir, readFile, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateNativeRequest } from './docker-dispatch.js';
import { sanitizeJsonRpcEnvelope } from './firewall.js';

const INSTANCE_ID = 'deepseek';
const ARTIFACT_ID = /^[0-9a-f]{40}-[0-9a-f]{64}$/;

// Uninstall removes only DeepSeek's own WebMCP instance: its pin, lease and settings. Its
// release leaves the shared store only when no other instance pins it and it is not the
// default instance's `current`; other providers' state is never touched.
export async function removeDeepSeekInstance(home = os.homedir()) {
  const dataRoot = path.join(home, '.local', 'share', 'webmcp');
  const ownState = path.join(dataRoot, 'instances', INSTANCE_ID);
  let artifactId = null;
  try {
    artifactId = JSON.parse(await readFile(path.join(ownState, 'host-release.json'), 'utf8')).artifactId;
  } catch {}
  await rm(ownState, { recursive: true, force: true });
  await rm(path.join(home, '.config', 'webmcp', 'instances', INSTANCE_ID), { recursive: true, force: true });
  if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)) return { releaseRemoved: false };

  const releases = path.join(hostRuntimeRoot(home), 'releases');
  const current = await readlink(path.join(hostRuntimeRoot(home), 'current')).catch(() => null);
  if (current !== null && path.basename(current) === artifactId) return { releaseRemoved: false };
  for (const instance of await readdir(path.join(dataRoot, 'instances')).catch(() => [])) {
    let pin;
    try {
      pin = JSON.parse(await readFile(path.join(dataRoot, 'instances', instance, 'host-release.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      // An unreadable pin might pin this release: keep it.
      return { releaseRemoved: false };
    }
    if (pin?.artifactId === artifactId) return { releaseRemoved: false };
  }
  await rm(path.join(releases, artifactId), { recursive: true, force: true });
  return { releaseRemoved: true };
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
    access: await moduleAt(releaseRoot, 'native/deploy/elevated-access.js'),
    workspace: await moduleAt(releaseRoot, 'native/deploy/workspace-config.js'),
    approval: await moduleAt(releaseRoot, 'native/deploy/local-approval.js'),
    commands: await moduleAt(releaseRoot, 'native/host/host-command.js'),
    locks: await moduleAt(releaseRoot, 'native/deploy/instance-lock.js'),
  };
}

async function selectedRoot(configFile) {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (typeof config.workspaceRoot !== 'string' || !path.isAbsolute(config.workspaceRoot)) {
    throw new Error('DeepSeek workspace selection is unavailable.');
  }
  return realpath(config.workspaceRoot);
}

async function leaseState(core, root) {
  const normal = await core.workspace.loadWorkspaceConfig(core.context.workspaceConfig);
  if (normal.hostRoot !== root) return { state: 'config_changed' };
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

export async function hostAccessStatus({ configFile, home, lockFile }) {
  let core;
  try { core = await loadCore({ home, lockFile }); } catch { return { hostAccessUntil: null, hostAccessState: 'unavailable' }; }
  try {
    const state = await leaseState(core, await selectedRoot(configFile));
    return {
      hostAccessUntil: state.state === 'active' && state.lease.accessLevel === 'full-host' ? state.lease.expiresAt : null,
      hostAccessState: state.state,
    };
  } catch {
    return { hostAccessUntil: null, hostAccessState: 'unverified' };
  }
}

export async function grantHostAccess({ configFile, minutes, home, lockFile }) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Host access duration must be 1–60 minutes.');
  const root = await selectedRoot(configFile);
  const core = await loadCore({ home, lockFile });
  return core.locks.withInstanceLifecycleLock(core.context, async () => {
    let existing;
    try {
      existing = await leaseState(core, root);
    } catch (error) {
      if (error?.code !== 'WORKSPACE_CONFIG_UNAVAILABLE' || error?.cause?.code !== 'ENOENT') throw error;
      existing = await core.access.loadElevatedLease(core.context.elevatedLease);
    }
    if (!['absent', 'expired'].includes(existing.state)) {
      throw new Error('Existing Host Access state must be revoked before a new grant.');
    }
    await core.approval.requestLocalElevationApproval({
      root: os.homedir(), durationMs: minutes * 60_000, accessLevel: 'full-host', instanceLabel: 'DeepSeek',
    });
    const normalConfig = await core.workspace.persistWorkspaceConfig(core.context.workspaceConfig, {
      version: 1, hostRoot: root, mode: 'workspace', readOnly: false,
      networkEnabled: false, gitPublicationEnabled: false,
    });
    const [bootSessionId, loginSessionId] = await Promise.all([
      core.access.getBootSessionId(), core.access.getLoginSessionId(),
    ]);
    const lease = core.access.createElevatedLease({
      normalConfig, elevatedRoot: await realpath(os.homedir()),
      bootSessionId, loginSessionId, durationMs: minutes * 60_000,
      accessLevel: 'full-host', instanceId: INSTANCE_ID,
    });
    await core.access.persistElevatedLease(core.context.elevatedLease, lease);
    return { hostAccessUntil: lease.expiresAt, hostAccessState: 'active' };
  });
}

export async function revokeHostAccess({ configFile, home, lockFile }) {
  const core = await loadCore({ home, lockFile });
  await core.locks.withInstanceLifecycleLock(core.context, () => core.access.clearElevatedLease(core.context.elevatedLease));
  return hostAccessStatus({ configFile, home, lockFile });
}

export async function dispatchHostCommand(request, { configFile, home, lockFile }) {
  validateNativeRequest(request);
  if (request.tool !== 'host_command') return denied(request.id, 'TOOL_NOT_ALLOWED', 'Tool is not a host command.');
  let core;
  let state;
  try {
    core = await loadCore({ home, lockFile });
    state = await leaseState(core, await selectedRoot(configFile));
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
