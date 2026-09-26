import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

// Setup moves DeepSeek's folder into the shared runtime's `deepseek` instance (macOS only), so the
// WebMCP App manages its folders, write switches and access. Every change goes through the pinned
// release's own controller; nothing here writes the instance files itself.
//
// `release` holds the pinned release's modules: controller (local-instance-controller.js), mounts
// (workspace-mount-config.js) and workspace (workspace-config.js).

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const APP_NAME = 'WebMCP Extension';

// Everything that would stop the migration half way is checked here, before setup writes
// anything or moves an image tag. A folder already in the instance keeps its write switch; a
// folder added for DeepSeek gets Write ON, as its old one-shot container mounted it.
// `legacy` names what an older DeepSeek install left: its WebMCP instance context, its state
// folder and its native host manifests. Their folders come along (with their Write switches) and
// the rest is removed once the new install has committed.
export async function planInstanceMigration({ context, workspaceRoot, release, platform = 'darwin', legacy = null }) {
  for (const lease of [context.elevatedLease, legacy?.context?.elevatedLease].filter(Boolean)) {
    if (await exists(lease)) {
      throw new Error(`Host Access is on for "${APP_NAME}" or the old DeepSeek instance. Revoke it in the WebMCP App, then run setup again.`);
    }
  }
  const hasWorkspace = await exists(context.workspaceConfig);
  const hasMounts = await exists(context.workspaceMountConfig);
  if (!hasWorkspace && hasMounts) {
    throw new Error(`"${APP_NAME}" has folders but no workspace settings. Remove its folders in the WebMCP App, then run setup again.`);
  }

  let config = hasMounts
    ? await release.mounts.loadWorkspaceMountConfig(context.workspaceMountConfig)
    : { version: 1, mounts: [] };
  const wanted = [];
  // A legacy instance becomes a multi-folder one; its folder must come along, or it would vanish.
  if (hasWorkspace && !hasMounts) {
    const legacy = await release.workspace.loadWorkspaceConfig(context.workspaceConfig, { platform });
    wanted.push({ root: legacy.hostRoot, write: legacy.readOnly !== true });
  }
  if (legacy) wanted.push(...await legacyFolders(legacy, release, platform));
  wanted.push({ root: workspaceRoot, write: true });

  const additions = [];
  for (const { root, write } of wanted) {
    let next;
    try {
      next = await release.mounts.addWorkspaceMount(config, { hostPath: root, platform, home: context.home });
    } catch (error) {
      if (error?.code === 'DUPLICATE_WORKSPACE_MOUNT_ID') continue;
      throw new Error(`Setup cannot add ${root} to "${APP_NAME}": ${error.message}`);
    }
    additions.push({ root: next.mounts.at(-1).hostPath, write });
    config = next;
  }
  return { provision: !hasWorkspace, root: workspaceRoot, additions, cleanup: await legacyCleanup(legacy) };
}

async function legacyFolders(legacy, release, platform) {
  const folders = [];
  const old = legacy.context;
  if (old && await exists(old.workspaceMountConfig)) {
    const mounts = await release.mounts.loadWorkspaceMountConfig(old.workspaceMountConfig);
    folders.push(...mounts.mounts.map((mount) => ({ root: mount.hostPath, write: mount.writeEnabled === true })));
  } else if (old && await exists(old.workspaceConfig)) {
    const config = await release.workspace.loadWorkspaceConfig(old.workspaceConfig, { platform });
    folders.push({ root: config.hostRoot, write: config.readOnly !== true });
  }
  // The old one-shot container mounted this folder writable.
  const oldConfig = legacy.stateDir ? path.join(legacy.stateDir, 'p2-native-config.json') : null;
  if (oldConfig && await exists(oldConfig)) {
    const { workspaceRoot } = JSON.parse(await readFile(oldConfig, 'utf8'));
    if (typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot)) folders.push({ root: workspaceRoot, write: true });
  }
  return folders;
}

async function legacyCleanup(legacy) {
  const existing = async (paths) => {
    const found = [];
    for (const candidate of paths.filter(Boolean)) if (await exists(candidate)) found.push(candidate);
    return found;
  };
  return {
    folders: await existing([legacy?.context?.configRoot, legacy?.context?.stateRoot, legacy?.stateDir]),
    containers: legacy?.context?.containerName ? [legacy.context.containerName] : [],
    files: await existing(legacy?.manifests ?? []),
  };
}

// Runs after the new install has committed: a failure leaves harmless leftovers, never a broken
// install. Old program folders are not touched here (the old unpacked extension may still use one).
export async function removeLegacy(cleanup, { removeContainer }) {
  for (const name of cleanup.containers) await removeContainer(name);
  for (const folder of cleanup.folders) await rm(folder, { recursive: true, force: true });
  for (const file of cleanup.files) await rm(file, { force: true });
}

// Setup has just rebuilt the extension's image, and the runtime refuses a container whose image differs
// from its pin, so the instance's container goes first; the next step or tool call recreates it.
// The plan has already checked that no lease is on.
export async function migrateToInstance(plan, { context, release, releaseArtifactId, removeContainer, platform = 'darwin' }) {
  const { controller } = release;
  await removeContainer(context.containerName);
  if (plan.provision) {
    // The extension's own freshly built image pin: the default instance's pin is never read here.
    await controller.provisionLocalInstance({ context, root: plan.root, defaultImagePinPath: context.imagePin, releaseArtifactId, platform });
  }
  for (const { root, write } of plan.additions) {
    const state = await controller.addLocalInstanceMountedFolder({ context, root, platform });
    if (!write) continue;
    const mount = state.mounts.find((candidate) => candidate.hostPath === root);
    if (!mount) throw new Error(`"${APP_NAME}" did not list ${root} after adding it.`);
    await controller.setLocalInstanceMountedFolderWrite({ context, id: mount.id, writeEnabled: true, platform });
  }
}
