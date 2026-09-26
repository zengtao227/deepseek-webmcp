import path from 'node:path';
import { INSTANCE_ID, clearInstanceLease, instanceLeaseStatus } from './host-access.js';
import { runPinnedRelease, runtimeFailure } from './instance-dispatch.js';

// Folders, write switches and access of DeepSeek's instance are read and revoked through the pinned
// release's instance controller: the same commands the WebMCP App runs, so the panel and the App
// always show one state.
const CONTROLLER = path.join('native', 'deploy', 'local-instance-controller.js');

export async function runInstanceControl(command, options = {}) {
  const { code, stdout, stderr } = await runPinnedRelease(CONTROLLER, [command, '--instance', INSTANCE_ID], '', options);
  if (code !== 0) throw runtimeFailure(stderr, 'The WebMCP instance controller failed.', 'INSTANCE_CONTROL_FAILED');
  try {
    return JSON.parse(stdout);
  } catch {
    throw runtimeFailure('', 'The WebMCP instance controller returned no status.', 'INSTANCE_CONTROL_FAILED');
  }
}

// A folder whose write switch cannot be read is shown as writable: the access line must never
// claim less authority than the model has. `null` means the folders could not be read.
function foldersOf(mountList) {
  if (!mountList) return null;
  if (mountList.mode === 'multi-mount' && Array.isArray(mountList.mounts)) {
    return mountList.mounts.map((mount) => ({ path: mount.hostPath, write: mount.writeEnabled !== false }));
  }
  if (typeof mountList.legacyRoot === 'string') return [{ path: mountList.legacyRoot, write: mountList.legacyReadOnly !== true }];
  return null;
}

// One lease per instance, Host Access (`full-host`); it never changes the container.
// A lease the controller cannot verify keeps its state name (rebooted, config_changed, …).
export function instanceAccessView(mountList, accessStatus) {
  const active = accessStatus?.mode === 'elevated';
  const until = active ? Date.parse(accessStatus.expiresAt) : null;
  const level = active ? accessStatus.accessLevel : null;
  const leaseState = active ? 'active' : String(accessStatus?.leaseState ?? 'absent');
  return {
    folders: foldersOf(mountList),
    hostAccessUntil: level === 'full-host' ? until : null,
    leaseState,
    hostAccessState: hostAccessState(level, leaseState),
  };
}

// The field Settings reads until it shows the instance lease itself.
function hostAccessState(level, leaseState) {
  if (level === 'full-host') return 'active';
  if (leaseState === 'active') return 'inactive';
  return leaseState;
}

// The lease is read on its own: a folder list that cannot be read (Docker down, a folder the
// runtime rejects) must not hide a Host Access lease that host_command still honours. When the
// controller cannot answer either, the lease file is read directly, as host_command reads it.
export async function instanceAccessStatus(options = {}, { readLease = instanceLeaseStatus } = {}) {
  const [mountList, accessStatus] = await Promise.allSettled([
    runInstanceControl('mount-list', options),
    runInstanceControl('access-status', options),
  ]);
  const folders = mountList.status === 'fulfilled' ? mountList.value : null;
  if (accessStatus.status === 'fulfilled') return instanceAccessView(folders, accessStatus.value);
  try {
    return instanceAccessView(folders, await readLease({ home: options.home, lockFile: options.lockFile }));
  } catch {
    return { folders: null, hostAccessUntil: null, leaseState: 'unavailable', hostAccessState: 'unavailable' };
  }
}

// The controller's revoke stops the instance's container first and so needs Docker. If it fails,
// the lease file is cleared directly: that alone ends host_command, and the relay restores the
// normal container before its next tool call.
export async function revokeInstanceAccess(options = {}, { clearLease = clearInstanceLease } = {}) {
  try {
    await runInstanceControl('access-revoke', options);
  } catch (error) {
    try {
      await clearLease({ home: options.home, lockFile: options.lockFile });
    } catch {
      throw error;
    }
  }
}
