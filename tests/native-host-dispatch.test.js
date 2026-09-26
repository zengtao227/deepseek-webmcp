import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDockerInvocation, buildWorkspaceControlPlaneMasks, loadNativeHostConfig, toNativeError, validateNativeRequest } from '../native/host/docker-dispatch.js';
import { fullAccessMaskCandidates } from '../native/host/local-paths.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;

function request(tool, args = {}) {
  return { version: 1, id: 'p2_call', tool, arguments: args };
}

test('P3 host allowlist accepts write/edit and still rejects unknown tools, extra fields and long bash timeouts', () => {
  assert.equal(validateNativeRequest(request('write', { workspaceId: 'ws_x', path: 'x.txt', content: 'ok' })).tool, 'write');
  assert.equal(validateNativeRequest(request('edit', { workspaceId: 'ws_x', path: 'x.txt', edits: [{ oldText: 'x', newText: 'y' }] })).tool, 'edit');
  assert.throws(() => validateNativeRequest(request('list_directory', {})), /not allowed/i);
  assert.throws(() => validateNativeRequest({ ...request('read', {}), extra: true }), /unsupported field/i);
  assert.throws(() => validateNativeRequest(request('bash', { workspaceId: 'ws_x', command: 'echo ok', timeout: 31 })), /timeout/i);
});

test('P3 Docker argv is fixed, isolated, writable only at the selected workspace and does not contain model command/path', () => {
  const config = {
    dockerPath: '/usr/local/bin/docker',
    canonicalRoot: '/Users/test/My Project',
    image: IMAGE,
    runtimeToken: 'b'.repeat(64),
  };
  const modelCommand = 'echo MODEL_VALUE && touch /workspace/nope';
  const modelPath = 'some/model/path.txt';
  const invocation = buildDockerInvocation(config, request('bash', {
    workspaceId: 'ws_x',
    command: modelCommand,
    workingDirectory: modelPath,
    timeout: 10,
  }), { uid: 501, gid: 20, random: () => 'cafebabe' });

  assert.equal(invocation.command, '/usr/local/bin/docker');
  assert.equal(invocation.name, 'deepseek-webmcp-call-cafebabe');
  assert.notEqual(invocation.name, 'webmcp-native');
  assert.deepEqual(invocation.args.slice(0, 6), ['run', '--rm', '-i', '--pull', 'never', '--name']);
  assert.ok(invocation.args.includes('none'));
  assert.ok(invocation.args.includes('ALL'));
  assert.ok(invocation.args.includes('no-new-privileges'));
  assert.ok(invocation.args.includes('501:20'));
  assert.ok(invocation.args.includes('type=bind,src=/Users/test/My Project,dst=/workspace,bind-recursive=disabled'));
  assert.equal(invocation.args.some((arg) => arg.includes('dst=/workspace,readonly')), false);
  assert.ok(invocation.args.includes(IMAGE));
  assert.equal(invocation.args.includes(modelCommand), false);
  assert.equal(invocation.args.includes(modelPath), false);
  assert.equal(invocation.args.includes('/var/run/docker.sock'), false);
  assert.equal(invocation.args.includes('--privileged'), false);
});

test('host-level errors are sanitized before they can return to DeepSeek', () => {
  const response = toNativeError('p3_host_error', new Error('password = "p3-host-secret-value"'));
  assert.equal(response.ok, false);
  assert.match(response.error.message, /\[REDACTED/);
  assert.doesNotMatch(response.error.message, /p3-host-secret-value/);
});

test('same local config derives the same stable runtime token across one-shot host invocations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-host-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-workspace-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    workspaceRoot: workspace,
    image: IMAGE,
    dockerPath: '/usr/local/bin/docker',
  }));
  const first = await loadNativeHostConfig(configPath);
  const second = await loadNativeHostConfig(configPath);
  assert.equal(first.runtimeToken, second.runtimeToken);
  assert.match(first.runtimeToken, /^[0-9a-f]{64}$/);
});

test('a parent workspace containing DeepSeek WebMCP stays usable with the checkout masked', async (t) => {
  const hostCodeRoot = path.resolve(import.meta.dirname, '..');
  const workspaceRoot = await realpath(path.dirname(hostCodeRoot));
  if (workspaceRoot === await realpath(os.homedir())) {
    t.skip('The installed checkout sits directly under Home, which is deliberately not a normal workspace.');
    return;
  }
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-state-'));
  const configPath = path.join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoot, image: IMAGE, dockerPath: '/usr/local/bin/docker' }));

  const config = await loadNativeHostConfig(configPath);
  assert.equal(config.canonicalRoot, workspaceRoot);
  assert.deepEqual(config.masks, [{
    type: 'directory',
    destination: path.posix.join('/workspace', path.basename(hostCodeRoot)),
  }]);

  const mounts = buildDockerInvocation(config, request('read', { workspaceId: 'ws_x', path: 'x' }), {
    uid: 501,
    gid: 20,
    random: () => 'r',
  }).args.filter((_, index, args) => args[index - 1] === '--mount');
  assert.ok(mounts.some((mount) => mount.includes(`dst=/workspace/${path.basename(hostCodeRoot)}`)));
});

test('a normal workspace masks existing cross-provider state and rejects roots inside it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-cross-provider-'));
  try {
    const root = path.join(home, '.config');
    const webmcp = path.join(root, 'webmcp');
    const tunnel = path.join(root, 'tunnel-client');
    const gh = path.join(root, 'gh');
    await mkdir(webmcp, { recursive: true });
    const initial = await buildWorkspaceControlPlaneMasks(await realpath(root), {
      home, configPath: path.join(home, '.deepseek-webmcp/config.json'), dockerPath: '/usr/local/bin/docker',
    });
    assert.deepEqual(initial.map((item) => item.destination), ['/workspace/webmcp']);
    await mkdir(tunnel);
    await mkdir(gh);
    await assert.rejects(
      buildWorkspaceControlPlaneMasks(await realpath(webmcp), {
        home, configPath: path.join(home, '.deepseek-webmcp/config.json'), dockerPath: '/usr/local/bin/docker',
      }),
      { code: 'WORKSPACE_CONTAINS_CONTROL_PLANE' },
      'a workspace inside another provider control root must be refused',
    );
    const masks = await buildWorkspaceControlPlaneMasks(await realpath(root), {
      home, configPath: path.join(home, '.deepseek-webmcp/config.json'), dockerPath: '/usr/local/bin/docker',
    });
    assert.deepEqual(masks.map((item) => item.destination), [
      '/workspace/gh', '/workspace/tunnel-client', '/workspace/webmcp',
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('control state in a workspace folder whose name starts with ".." is still masked or refused', async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'deepseek-dotdot-')));
  try {
    const root = path.join(home, 'project');
    await mkdir(path.join(root, '..deepseek-state'), { recursive: true });
    await mkdir(path.join(root, '..bin'), { recursive: true });
    await writeFile(path.join(root, '..bin', 'docker'), '');
    const masks = await buildWorkspaceControlPlaneMasks(root, {
      home, configPath: path.join(root, '..deepseek-state', 'config.json'), dockerPath: '/usr/local/bin/docker',
    });
    assert.ok(masks.some((item) => item.destination === '/workspace/..deepseek-state'), JSON.stringify(masks));
    await assert.rejects(
      buildWorkspaceControlPlaneMasks(root, {
        home, configPath: path.join(home, '.deepseek-webmcp/config.json'), dockerPath: path.join(root, '..bin', 'docker'),
      }),
      { code: 'WORKSPACE_CONTAINS_CONTROL_PLANE' },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('host still refuses exact control-plane roots, host executables, filesystem root and normal home access', async () => {
  const hostCodeRoot = path.resolve(import.meta.dirname, '..');
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-state-'));
  const configPath = path.join(stateDir, 'config.json');
  const cases = [
    ['host code root itself', hostCodeRoot],
    ['directory holding the host config', stateDir],
    ['ancestor of the node binary', path.dirname(process.execPath)],
    ['filesystem root', '/'],
    ['home directory (Full access is required)', os.homedir()],
  ];
  for (const [label, workspaceRoot] of cases) {
    await writeFile(configPath, JSON.stringify({ workspaceRoot, image: IMAGE, dockerPath: '/usr/local/bin/docker' }));
    await assert.rejects(loadNativeHostConfig(configPath), { code: 'WORKSPACE_CONTAINS_CONTROL_PLANE' }, label);
  }
});

test('Full access mounts the home folder with control-plane and credential paths hidden, only while the lease is valid', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-home-'));
  const project = path.join(home, 'projects', 'app');
  await mkdir(project, { recursive: true });
  await mkdir(path.join(home, 'Library/Application Support/Comet/NativeMessagingHosts'), { recursive: true });
  await mkdir(path.join(home, 'Notes, 2026'));
  const files = new Set(['.netrc', '.git-credentials', '.npmrc', '.zshrc', '.zprofile', '.zshenv', '.zsh_history', '.bashrc', '.bash_profile', '.bash_history', '.profile']);
  for (const candidate of fullAccessMaskCandidates({ home, hostCodeRoot: path.resolve(import.meta.dirname, '..'), nodePath: process.execPath })) {
    if (!candidate.startsWith(`${home}${path.sep}`)) continue;
    if (files.has(path.basename(candidate))) {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, 'protected\n');
    } else {
      await mkdir(candidate, { recursive: true });
    }
  }
  const configPath = path.join(home, '.deepseek-webmcp', 'p2-native-config.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoot: project, image: IMAGE, dockerPath: '/usr/local/bin/docker' }));

  const folder = await loadNativeHostConfig(configPath, { home, now: 1000 });
  assert.equal(folder.fullAccessUntil, null);
  assert.equal(folder.canonicalRoot, await (await import('node:fs/promises')).realpath(project));
  assert.deepEqual(folder.masks, []);

  await writeFile(path.join(home, '.deepseek-webmcp', 'full-access.json'), JSON.stringify({ expiresAt: 5000 }));
  const full = await loadNativeHostConfig(configPath, { home, now: 1000 });
  assert.equal(full.fullAccessUntil, 5000);
  const realHome = await (await import('node:fs/promises')).realpath(home);
  assert.equal(full.canonicalRoot, realHome);
  const mounts = buildDockerInvocation(full, request('read', { workspaceId: 'ws_x', path: 'x' }), { uid: 501, gid: 20, random: () => 'r' }).args
    .filter((_, index, args) => args[index - 1] === '--mount');
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/.ssh,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/.deepseek-webmcp,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/.config/webmcp,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/.local/share/webmcp,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/.prism-webmcp,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/.chatgpt-embedded-panel,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/Library/LaunchAgents,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=tmpfs,dst=/workspace/Library/Application Support/tunnel-client,readonly,tmpfs-mode=000'));
  assert.ok(mounts.includes('type=bind,src=/dev/null,dst=/workspace/.zshrc,readonly'));
  assert.equal(mounts.some((mount) => mount.includes('Comet/NativeMessagingHosts')), false);
  assert.equal(mounts.some((mount) => mount.includes('Notes, 2026')), false);

  await rm(path.join(home, '.zprofile'));
  const withoutOptional = await loadNativeHostConfig(configPath, { home, now: 1000 });
  assert.equal(withoutOptional.fullAccessUntil, 5000);
  assert.equal(withoutOptional.masks.some((mask) => mask.destination === '/workspace/.zprofile'), false);

  const expired = await loadNativeHostConfig(configPath, { home, now: 6000 });
  assert.equal(expired.fullAccessUntil, null);
  assert.deepEqual(expired.masks, []);
});

test('Docker --mount fields containing commas are CSV-quoted', () => {
  const config = { dockerPath: '/usr/local/bin/docker', canonicalRoot: '/Users/a/My, Project', image: IMAGE, runtimeToken: 'b'.repeat(64), masks: [] };
  const args = buildDockerInvocation(config, request('read', { workspaceId: 'ws_x', path: 'x' }), { uid: 501, gid: 20, random: () => 'r' }).args;
  assert.ok(args.includes('type=bind,"src=/Users/a/My, Project",dst=/workspace,bind-recursive=disabled'));
});

test('tool and control envelopes are disjoint', async () => {
  const { validateControlRequest } = await import('../native/host/control.js');
  assert.throws(() => validateNativeRequest({ version: 1, id: 'x', tool: 'read', control: 'status', arguments: {} }), /unsupported field/i);
  assert.throws(() => validateControlRequest({ version: 1, id: 'x', control: 'status', tool: 'read', arguments: {} }), /unsupported field/i);
  assert.throws(() => validateControlRequest({ version: 1, id: 'x', control: 'bash', arguments: {} }), { code: 'CONTROL_NOT_ALLOWED' });
  assert.throws(() => validateControlRequest({ version: 1, id: 'x', control: 'grant-full-access', arguments: { minutes: 61 } }), { code: 'INVALID_DURATION' });
  assert.equal(validateControlRequest({ version: 1, id: 'x', control: 'grant-full-access', arguments: { minutes: 30 } }).control, 'grant-full-access');
});

test('Full access and folder changes happen only after the macOS dialog is confirmed', async () => {
  const { mkdir, readFile: read, realpath: real } = await import('node:fs/promises');
  const { handleControlRequest } = await import('../native/host/control.js');
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-control-'));
  const first = path.join(home, 'first');
  const second = path.join(home, 'second');
  await mkdir(first);
  await mkdir(second);
  const configFile = path.join(home, '.deepseek-webmcp', 'p2-native-config.json');
  await mkdir(path.dirname(configFile));
  await writeFile(configFile, JSON.stringify({ workspaceRoot: first, image: IMAGE, dockerPath: '/usr/local/bin/docker' }));
  const control = (name, args = {}, answer) => handleControlRequest(
    { version: 1, id: 'c', control: name, arguments: args },
    { home, configFile, now: 1000, exec: async () => { if (answer instanceof Error) throw answer; return { stdout: answer }; } },
  );
  const cancelled = Object.assign(new Error('cancel'), { stderr: 'execution error: User canceled. (-128)' });

  // Settings' own Full access lease (until Settings drops it); the status reports the instance's.
  const { leasePath } = await import('../native/host/local-paths.js');
  const lease = () => read(leasePath(home), 'utf8').then((text) => JSON.parse(text).expiresAt, () => null);
  assert.equal((await control('grant-full-access', { minutes: 30 }, cancelled)).result.changed, false);
  assert.equal(await lease(), null);
  assert.equal((await control('grant-full-access', { minutes: 30 }, 'button returned:Allow, gave up:true')).result.changed, false);
  assert.equal(await lease(), null);
  assert.equal((await control('grant-full-access', { minutes: 30 }, 'button returned:Allow, gave up:false')).result.changed, true);
  assert.equal(await lease(), 1000 + 30 * 60_000);

  assert.equal((await control('choose-folder', {}, cancelled)).result.changed, false);
  const chosen = await control('choose-folder', {}, `${second}/`);
  assert.equal(chosen.result.folder, await real(second));
  assert.equal(JSON.parse(await read(configFile, 'utf8')).workspaceRoot, await real(second));
  await assert.rejects(control('choose-folder', {}, home), { code: 'INVALID_FOLDER' });
});

test('a mask Docker cannot mount fails closed without retrying with weaker protection', async () => {
  const { dispatchNativeRequest } = await import('../native/host/docker-dispatch.js');
  const { EventEmitter } = await import('node:events');
  const attempts = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    attempts.push(args.filter((_, index) => args[index - 1] === '--mount'));
    child.stdin = {
      end: () => setImmediate(() => {
        const mounts = attempts.at(-1).join(' ');
        if (mounts.includes('/workspace/Library/Cookies')) {
          child.stderr.emit('data', Buffer.from('docker: error mounting "tmpfs" to rootfs at "/workspace/Library/Cookies": create mountpoint: openat2 /workspace/Library/Cookies: operation not permitted'));
          child.emit('close', 125);
          return;
        }
      }),
    };
    return child;
  };
  const config = {
    dockerPath: '/usr/local/bin/docker', canonicalRoot: '/Users/a', image: IMAGE, runtimeToken: 'b'.repeat(64),
    masks: [{ type: 'directory', destination: '/workspace/.ssh' }, { type: 'directory', destination: '/workspace/Library/Cookies' }],
  };
  await assert.rejects(
    dispatchNativeRequest(request('read', { workspaceId: 'ws_x', path: 'x' }), config, { spawnImpl }),
    { code: 'RUNTIME_FAILED' },
  );
  assert.equal(attempts.length, 1);
  assert.ok(attempts[0].some((mount) => mount.includes('/workspace/.ssh')));
});

test('uninstall removes local state only after confirmation and announces itself in a macOS message', async () => {
  const { mkdir, access } = await import('node:fs/promises');
  const { handleControlRequest } = await import('../native/host/control.js');
  const home = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-uninstall-'));
  const configFile = path.join(home, '.deepseek-webmcp', 'p2-native-config.json');
  const manifest = path.join(home, 'Library/Application Support/Comet/NativeMessagingHosts/com.deepseek.webmcp.native.json');
  await mkdir(path.dirname(configFile), { recursive: true });
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(configFile, JSON.stringify({ workspaceRoot: home, image: IMAGE, dockerPath: '/usr/local/bin/docker' }));
  await writeFile(manifest, '{}');
  const messages = [];
  const exists = (file) => access(file).then(() => true, () => false);
  const uninstall = (answer) => handleControlRequest(
    { version: 1, id: 'u', control: 'uninstall', arguments: {} },
    { home, configFile, now: 1000, exec: async () => ({ stdout: answer }), notify: (text) => messages.push(text) },
  );

  assert.equal((await uninstall('button returned:Cancel, gave up:false')).result.uninstalled, false);
  assert.equal(await exists(manifest), true);
  assert.deepEqual(messages, []);

  const done = await uninstall('button returned:Uninstall, gave up:false');
  assert.equal(done.result.uninstalled, true);
  // This test runs from a developer checkout without the install marker: it is kept.
  assert.equal(done.result.removedProgramFolder, false);
  assert.equal(await exists(manifest), false);
  assert.equal(await exists(path.dirname(configFile)), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /uninstalled/);
});

test('an aborted call is answered even when Docker cleanup hangs', async () => {
  const { dispatchNativeRequest } = await import('../native/host/docker-dispatch.js');
  const { EventEmitter } = await import('node:events');

  // A wedged Docker daemon is exactly when cleanup hangs, and it is also the most
  // likely reason a call had to be aborted at all. The answer must not wait for it:
  // an unsettled call writes no response, so Chrome's sendNativeMessage never
  // resolves and the page keeps showing work that already failed.
  let cleanupStarted = false;
  const execFileImpl = () => { cleanupStarted = true; return new Promise(() => {}); };
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      end: () => setImmediate(() => {
        child.stdout.emit('data', Buffer.alloc(641 * 1024, 0x20));
      }),
    };
    return child;
  };

  const config = {
    dockerPath: '/usr/local/bin/docker', canonicalRoot: '/Users/a', image: IMAGE, runtimeToken: 'b'.repeat(64), masks: [],
  };

  await assert.rejects(
    dispatchNativeRequest(request('read', { workspaceId: 'ws_x', path: 'x' }), config, { spawnImpl, execFileImpl }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  assert.equal(cleanupStarted, true);
});

test('only an installed release folder counts as the program folder uninstall may delete', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { isInstalledCodeFolder } = await import('../native/host/control.js');
  const folder = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-program-'));
  assert.equal(await isInstalledCodeFolder(folder), false);
  await writeFile(path.join(folder, '.deepseek-webmcp-installed'), '');
  assert.equal(await isInstalledCodeFolder(folder), false, 'a marker alone does not identify the program');
  await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'deepseek-webmcp' }));
  assert.equal(await isInstalledCodeFolder(folder), true);
  await mkdir(path.join(folder, '.git'));
  assert.equal(await isInstalledCodeFolder(folder), false, 'a Git checkout is a developer folder and is kept');
});
