import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateNativeRequest } from './docker-dispatch.js';
import { sanitizeJsonRpcEnvelope } from './firewall.js';

const INSTANCE_ID = 'deepseek';
const ARTIFACT_ID = /^[0-9a-f]{40}-[0-9a-f]{64}$/;
const HOST_RUNTIME_ROOT = path.join(os.homedir(), '.local', 'share', 'webmcp', 'host-runtime');

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function moduleAt(releaseRoot, relative) {
  return import(pathToFileURL(path.join(releaseRoot, relative)).href);
}

// The DeepSeek adapter uses the reviewed, immutable WebMCP command/lease code.
// Its existing five Docker tools continue through DeepSeek's own runtime.
async function loadCore({ pinCurrent = false } = {}) {
  const releasesRoot = await realpath(path.join(HOST_RUNTIME_ROOT, 'releases'));
  const current = await realpath(path.join(HOST_RUNTIME_ROOT, 'current'));
  const artifactId = path.basename(current);
  if (!within(releasesRoot, current) || !ARTIFACT_ID.test(artifactId)) {
    throw new Error('Installed WebMCP release is not immutable.');
  }
  const verifier = await moduleAt(current, 'adapter/deploy/deploy-host-runtime.js');
  await verifier.verifyRelease(current, { expectedArtifactId: artifactId, entrypoint: 'native/host/start.js' });
  const { createInstanceContext } = await moduleAt(current, 'native/deploy/instance-context.js');
  const context = createInstanceContext({ instanceId: INSTANCE_ID });
  const releases = await moduleAt(current, 'native/deploy/instance-release.js');
  const pinned = pinCurrent
    ? await releases.pinInstanceToCurrentRelease(context)
    : await releases.verifyPinnedInstanceRelease(context);
  const root = pinned.releaseRoot ?? path.join(releasesRoot, pinned.artifactId);
  return {
    context,
    access: await moduleAt(root, 'native/deploy/elevated-access.js'),
    workspace: await moduleAt(root, 'native/deploy/workspace-config.js'),
    installer: await moduleAt(root, 'native/deploy/installer.js'),
    commands: await moduleAt(root, 'native/host/host-command.js'),
    locks: await moduleAt(root, 'native/deploy/instance-lock.js'),
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

export async function hostAccessStatus({ configFile }) {
  let core;
  try { core = await loadCore(); } catch { return { hostAccessUntil: null, hostAccessState: 'unavailable' }; }
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

export async function grantHostAccess({ configFile, minutes }) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Host access duration must be 1–60 minutes.');
  const root = await selectedRoot(configFile);
  const core = await loadCore({ pinCurrent: true });
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
    await core.installer.requestLocalElevationApproval({
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

export async function revokeHostAccess({ configFile }) {
  const core = await loadCore();
  await core.locks.withInstanceLifecycleLock(core.context, () => core.access.clearElevatedLease(core.context.elevatedLease));
  return hostAccessStatus({ configFile });
}

export async function dispatchHostCommand(request, { configFile }) {
  validateNativeRequest(request);
  if (request.tool !== 'host_command') return denied(request.id, 'TOOL_NOT_ALLOWED', 'Tool is not a host command.');
  let core;
  let state;
  try {
    core = await loadCore();
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
