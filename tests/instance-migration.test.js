import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateToInstance, planInstanceMigration, removeLegacy } from '../native/host/instance-migration.js';

// Stand-ins for the pinned release's modules. The mount rules that matter here: a path already
// present is a duplicate, and a folder the runtime refuses (here: the home folder) throws.
function fakeRelease({ refuse = [] } = {}) {
  const calls = [];
  const idFor = (hostPath) => path.basename(hostPath).toLowerCase();
  const mounts = {
    async loadWorkspaceMountConfig(file) {
      const { readFile } = await import('node:fs/promises');
      return JSON.parse(await readFile(file, 'utf8'));
    },
    async addWorkspaceMount(config, { hostPath }) {
      const canonical = path.resolve(hostPath);
      if (refuse.includes(canonical)) throw Object.assign(new Error('Mounted folders cannot contain the owner home directory.'), { code: 'SENSITIVE_WORKSPACE_MOUNT' });
      if (config.mounts.some((mount) => mount.id === idFor(canonical))) throw Object.assign(new Error('duplicate'), { code: 'DUPLICATE_WORKSPACE_MOUNT_ID' });
      return { version: 1, mounts: [...config.mounts, { id: idFor(canonical), hostPath: canonical, writeEnabled: false }] };
    },
  };
  const workspace = {
    async loadWorkspaceConfig(file) {
      const { readFile } = await import('node:fs/promises');
      return JSON.parse(await readFile(file, 'utf8'));
    },
  };
  let listed = [];
  const controller = {
    async provisionLocalInstance(options) {
      calls.push(['provision', options.root, options.defaultImagePinPath, options.releaseArtifactId]);
    },
    async addLocalInstanceMountedFolder({ root }) {
      calls.push(['add', root]);
      listed = [...listed, { id: idFor(root), hostPath: root, writeEnabled: false }];
      return { mode: 'multi-mount', mounts: listed };
    },
    async setLocalInstanceMountedFolderWrite({ id, writeEnabled }) {
      calls.push(['write', id, writeEnabled]);
    },
  };
  const removeContainer = async (name) => { calls.push(['rm', name]); };
  return { calls, removeContainer, release: { controller, mounts, workspace } };
}

async function instanceAt(home, id) {
  const configRoot = path.join(home, '.config/webmcp/instances', id);
  const stateRoot = path.join(home, '.local/share/webmcp/instances', id);
  await mkdir(configRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  return {
    home,
    instanceId: id,
    configRoot,
    stateRoot,
    containerName: `webmcp-native-${id}`,
    workspaceConfig: path.join(configRoot, 'workspace.json'),
    workspaceMountConfig: path.join(configRoot, 'workspace-mounts.json'),
    elevatedLease: path.join(stateRoot, 'elevated-lease.json'),
    imagePin: path.join(stateRoot, 'native-image.json'),
  };
}

async function withInstance(run) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webmcp-migration-')));
  try {
    const context = await instanceAt(home, 'webmcp');
    const folder = path.join(home, 'Projects');
    await mkdir(folder);
    await run({ home, context, folder });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const migrate = async (context, folder, fake) => {
  const plan = await planInstanceMigration({ context, workspaceRoot: folder, release: fake.release });
  await migrateToInstance(plan, { context, release: fake.release, releaseArtifactId: 'artifact', removeContainer: fake.removeContainer });
  return plan;
};

test('a new instance is provisioned from DeepSeek\'s own image pin and gets DeepSeek\'s folder with Write ON', async () => {
  await withInstance(async ({ context, folder }) => {
    const fake = fakeRelease();
    await migrate(context, folder, fake);
    assert.deepEqual(fake.calls, [
      ['rm', 'webmcp-native-webmcp'],
      ['provision', folder, context.imagePin, 'artifact'],
      ['add', folder],
      ['write', 'projects', true],
    ]);
  });
});

test('a legacy instance keeps its own folder and write switch, and DeepSeek\'s folder is added writable', async () => {
  await withInstance(async ({ home, context, folder }) => {
    const appFolder = path.join(home, 'Notes');
    await writeFile(context.workspaceConfig, JSON.stringify({ hostRoot: appFolder, readOnly: true }));
    const fake = fakeRelease();
    await migrate(context, folder, fake);
    assert.deepEqual(fake.calls, [['rm', 'webmcp-native-webmcp'], ['add', appFolder], ['add', folder], ['write', 'projects', true]]);
  });
});

test('a legacy instance whose folder is DeepSeek\'s keeps it once, with its own switch', async () => {
  await withInstance(async ({ context, folder }) => {
    await writeFile(context.workspaceConfig, JSON.stringify({ hostRoot: folder, readOnly: false }));
    const fake = fakeRelease();
    await migrate(context, folder, fake);
    assert.deepEqual(fake.calls, [['rm', 'webmcp-native-webmcp'], ['add', folder], ['write', 'projects', true]]);
  });
});

test('running setup again changes no folder, including a Write switch the owner turned off in the App', async () => {
  await withInstance(async ({ context, folder }) => {
    await writeFile(context.workspaceConfig, JSON.stringify({ hostRoot: folder, readOnly: false }));
    await writeFile(context.workspaceMountConfig, JSON.stringify({ version: 1, mounts: [{ id: 'projects', hostPath: folder, writeEnabled: false }] }));
    const fake = fakeRelease();
    const plan = await migrate(context, folder, fake);
    assert.deepEqual(plan.additions, []);
    assert.deepEqual(fake.calls, [['rm', 'webmcp-native-webmcp']], 'only the container built from the old image goes');
  });
});

test('an active lease, a broken instance or a folder the runtime refuses stops setup before any change', async () => {
  await withInstance(async ({ home, context, folder }) => {
    const fake = fakeRelease({ refuse: [home] });
    await writeFile(context.elevatedLease, '{}');
    await assert.rejects(planInstanceMigration({ context, workspaceRoot: folder, release: fake.release }), /Revoke it in the WebMCP App/);
    await rm(context.elevatedLease);

    await writeFile(context.workspaceMountConfig, JSON.stringify({ version: 1, mounts: [] }));
    await assert.rejects(planInstanceMigration({ context, workspaceRoot: folder, release: fake.release }), /no workspace settings/);
    await rm(context.workspaceMountConfig);

    await writeFile(context.workspaceConfig, JSON.stringify({ hostRoot: home, readOnly: false }));
    await assert.rejects(planInstanceMigration({ context, workspaceRoot: folder, release: fake.release }), /cannot add .* owner home directory/);
    assert.deepEqual(fake.calls, []);
  });
});

test('a failure after the first change surfaces, so the installer rolls the whole install back', async () => {
  await withInstance(async ({ context, folder }) => {
    const fake = fakeRelease();
    fake.release.controller.setLocalInstanceMountedFolderWrite = async () => { throw new Error('INSTANCE_MOUNT_VERIFY_FAILED'); };
    const plan = await planInstanceMigration({ context, workspaceRoot: folder, release: fake.release });
    await assert.rejects(migrateToInstance(plan, { context, release: fake.release, releaseArtifactId: 'artifact', removeContainer: fake.removeContainer }), /INSTANCE_MOUNT_VERIFY_FAILED/);
    assert.deepEqual(fake.calls, [['rm', 'webmcp-native-webmcp'], ['provision', folder, context.imagePin, 'artifact'], ['add', folder]]);
  });
});

// What an older DeepSeek install leaves: its own instance, its state folder with the one folder the
// old container mounted writable, and its native host manifest.
async function legacyAt(home) {
  const context = await instanceAt(home, 'deepseek');
  const stateDir = path.join(home, '.deepseek-webmcp');
  await mkdir(stateDir);
  const manifest = path.join(home, 'NativeMessagingHosts', 'com.deepseek.webmcp.native.json');
  await mkdir(path.dirname(manifest));
  await writeFile(manifest, '{}');
  return { context, stateDir, manifests: [manifest, path.join(home, 'absent', 'com.deepseek.webmcp.native.json')] };
}

test('the old DeepSeek folders come along with their Write switches, and the old state is removed after the install', async () => {
  await withInstance(async ({ home, context, folder }) => {
    const legacy = await legacyAt(home);
    const notes = path.join(home, 'Notes');
    const code = path.join(home, 'Code');
    await writeFile(legacy.context.workspaceConfig, JSON.stringify({ hostRoot: notes, readOnly: false }));
    await writeFile(legacy.context.workspaceMountConfig, JSON.stringify({ version: 1, mounts: [
      { id: 'notes', hostPath: notes, writeEnabled: false },
      { id: 'code', hostPath: code, writeEnabled: true },
    ] }));
    await writeFile(path.join(legacy.stateDir, 'p2-native-config.json'), JSON.stringify({ workspaceRoot: folder }));
    const fake = fakeRelease();
    const plan = await planInstanceMigration({ context, workspaceRoot: folder, release: fake.release, legacy });
    await migrateToInstance(plan, { context, release: fake.release, releaseArtifactId: 'artifact', removeContainer: fake.removeContainer });
    assert.deepEqual(fake.calls, [
      ['rm', 'webmcp-native-webmcp'],
      ['provision', folder, context.imagePin, 'artifact'],
      ['add', notes],
      ['add', code], ['write', 'code', true],
      ['add', folder], ['write', 'projects', true],
    ]);
    assert.deepEqual(plan.cleanup, {
      folders: [legacy.context.configRoot, legacy.context.stateRoot, legacy.stateDir],
      containers: ['webmcp-native-deepseek'],
      files: [legacy.manifests[0]],
    });

    await removeLegacy(plan.cleanup, { removeContainer: fake.removeContainer });
    assert.deepEqual(fake.calls.at(-1), ['rm', 'webmcp-native-deepseek']);
    for (const gone of [...plan.cleanup.folders, ...plan.cleanup.files]) await assert.rejects(lstat(gone), { code: 'ENOENT' });

    // A second run finds nothing old and the webmcp folders already present.
    await writeFile(context.workspaceConfig, JSON.stringify({ hostRoot: folder, readOnly: false }));
    await writeFile(context.workspaceMountConfig, JSON.stringify({ version: 1, mounts: [
      { id: 'notes', hostPath: notes, writeEnabled: false },
      { id: 'code', hostPath: code, writeEnabled: true },
      { id: 'projects', hostPath: folder, writeEnabled: true },
    ] }));
    const again = await planInstanceMigration({ context, workspaceRoot: folder, release: fake.release, legacy });
    assert.deepEqual(again.additions, []);
    assert.deepEqual(again.cleanup, { folders: [], containers: ['webmcp-native-deepseek'], files: [] });
  });
});

test('Host Access on the old DeepSeek instance stops setup before any change', async () => {
  await withInstance(async ({ home, context, folder }) => {
    const legacy = await legacyAt(home);
    await writeFile(legacy.context.elevatedLease, '{}');
    const fake = fakeRelease();
    await assert.rejects(planInstanceMigration({ context, workspaceRoot: folder, release: fake.release, legacy }), /Revoke it in the WebMCP App/);
    assert.deepEqual(fake.calls, []);
  });
});
