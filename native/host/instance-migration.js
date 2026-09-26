import { lstat } from 'node:fs/promises';

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

const APP_NAME = 'Web Provider (DeepSeek · ChatGPT web)';

// Everything that would stop the migration half way is checked here, before setup writes
// anything or moves an image tag. A folder already in the instance keeps its write switch; a
// folder added for DeepSeek gets Write ON, as its old one-shot container mounted it.
export async function planInstanceMigration({ context, workspaceRoot, release, platform = 'darwin' }) {
  if (await exists(context.elevatedLease)) {
    throw new Error(`Full Working Access or Host Access is on for "${APP_NAME}". Revoke it in the WebMCP App, then run setup again.`);
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
  return { provision: !hasWorkspace, root: workspaceRoot, additions };
}

// Setup has just rebuilt DeepSeek's image, and the runtime refuses a container whose image differs
// from its pin, so the instance's container goes first; the next step or tool call recreates it.
// The plan has already checked that no lease is on.
export async function migrateToInstance(plan, { context, release, releaseArtifactId, removeContainer, platform = 'darwin' }) {
  const { controller } = release;
  await removeContainer(context.containerName);
  if (plan.provision) {
    // DeepSeek's own freshly built image pin: the default instance's pin is never read here.
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
