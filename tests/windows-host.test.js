import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertWindowsWorkspace, handleControlRequest } from '../native/host/control.js';
import { WINDOWS_REGISTRY_KEYS, browserProfileRoots, hostKind } from '../native/host/local-paths.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;

// A WSL home with a "Windows user folder" (containing AppData) and a project folder in it.
async function withWsl(run) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'deepseek-wsl-')));
  try {
    const home = path.join(root, 'home');
    const winProfile = path.join(root, 'mnt-c-users-me');
    const project = path.join(winProfile, 'Projects', 'app');
    const windowsDir = path.join(root, 'mnt-c-windows');
    await mkdir(path.join(winProfile, 'AppData', 'Roaming'), { recursive: true });
    await mkdir(path.join(winProfile, 'AppData', 'Local'), { recursive: true });
    await mkdir(windowsDir, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(path.join(home, '.deepseek-webmcp'), { recursive: true });
    const configFile = path.join(home, '.deepseek-webmcp', 'p2-native-config.json');
    await writeFile(configFile, JSON.stringify({ workspaceRoot: project, image: IMAGE, dockerPath: '/usr/bin/docker' }));
    const calls = [];
    let pick = 'C:\\Users\\me\\Projects\\app';
    let folderReport = 'P=C:\\Users\\me\r\nO=C:\\Users\\me\\AppData\\Roaming\r\nO=C:\\Users\\me\\AppData\\Local\r\nO=C:\\Windows\r\nO=\r\n';
    const toWsl = {
      'C:\\Users\\me': winProfile,
      'C:\\Users\\me\\AppData\\Roaming': path.join(winProfile, 'AppData', 'Roaming'),
      'C:\\Users\\me\\AppData\\Local': path.join(winProfile, 'AppData', 'Local'),
      'C:\\Windows': windowsDir,
      'C:\\Users\\me\\Projects\\app': project,
    };
    const exec = async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'powershell.exe') {
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        if (script.includes('FolderBrowserDialog')) return { stdout: `${pick}\r\n` };
        if (script.includes('"P=$env:USERPROFILE"')) {
          if (folderReport === null) throw new Error('interop disabled');
          return { stdout: folderReport };
        }
        if (script.includes('MessageBox')) return { stdout: 'OK\r\n' };
        return { stdout: '' };
      }
      if (command === 'wslpath') return { stdout: `${args[0] === '-u' ? (toWsl[args[1]] ?? path.join(root, 'unmapped', path.win32.basename(args[1]))) : 'C:\\Users\\me\\Projects\\app'}\n` };
      return { stdout: '' };
    };
    const control = (name, args = {}) => handleControlRequest(
      { version: 1, id: 'w1', control: name, arguments: args },
      { home, configFile, now: 1000, exec, kind: 'wsl', notify: () => {} },
    );
    await run({ home, configFile, winProfile, project, calls, control, setPick: (value) => { pick = value; }, setFolderReport: (value) => { folderReport = value; } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('WSL is recognised as a supported host and has no browser folders of its own', () => {
  assert.equal(hostKind({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, release: '6.6.0' }), 'wsl');
  assert.equal(hostKind({ platform: 'linux', env: {}, release: '6.6.87.2-microsoft-standard-WSL2' }), 'wsl');
  assert.equal(hostKind({ platform: 'linux', env: {}, release: '6.8.0-generic' }), 'unsupported');
  assert.deepEqual(browserProfileRoots('/home/me', 'wsl'), []);
});

test('on Windows the panel is told Full access and Host access are not available, and grants are refused', async () => {
  await withWsl(async ({ control }) => {
    assert.deepEqual((await control('status')).result.capabilities, { fullAccess: false, hostAccess: false });
    await assert.rejects(control('grant-full-access', { minutes: 5 }), { code: 'NOT_AVAILABLE_ON_WINDOWS' });
    await assert.rejects(control('grant-host-access', { minutes: 5 }), { code: 'NOT_AVAILABLE_ON_WINDOWS' });
  });
});

test('on Windows the folder is chosen in a Windows dialog, and the whole user folder is refused', async () => {
  await withWsl(async ({ control, configFile, project, setPick }) => {
    const chosen = await control('choose-folder');
    assert.equal(chosen.result.changed, true);
    assert.equal(JSON.parse(await readFile(configFile, 'utf8')).workspaceRoot, project);
    for (const refused of ['C:\\Users\\me', 'C:\\Windows']) {
      setPick(refused);
      await assert.rejects(control('choose-folder'), { code: 'INVALID_FOLDER' }, refused);
    }
    assert.equal(JSON.parse(await readFile(configFile, 'utf8')).workspaceRoot, project);
  });
});

test('uninstall on Windows also removes the Chrome and Edge registrations and the relay folder', async () => {
  await withWsl(async ({ control, calls }) => {
    const done = await control('uninstall');
    assert.equal(done.result.uninstalled, true);
    for (const key of WINDOWS_REGISTRY_KEYS) {
      assert.ok(calls.some(([command, ...args]) => command === 'reg.exe' && args[0] === 'delete' && args[1] === key), key);
    }
    const scripts = calls.filter(([command]) => command === 'powershell.exe').map(([, ...args]) => Buffer.from(args.at(-1), 'base64').toString('utf16le'));
    assert.ok(scripts.some((script) => script.includes('Remove-Item') && script.includes('WebMCP\\DeepSeek')));
  });
});

test('the Windows folder rule ignores case, as drvfs and WebMCP Setup do', async () => {
  await withWsl(async ({ winProfile }) => {
    const folders = { profile: winProfile, others: [path.join(winProfile, 'AppData', 'Roaming')] };
    const upper = (value) => value.replace(/mnt-c-users-me/, 'MNT-C-USERS-ME');
    await assert.rejects(assertWindowsWorkspace(upper(winProfile), { protectedFolders: folders }), { code: 'INVALID_FOLDER' });
    await assert.rejects(assertWindowsWorkspace(path.dirname(upper(winProfile)), { protectedFolders: folders }), { code: 'INVALID_FOLDER' });
    await assert.rejects(assertWindowsWorkspace(upper(path.join(winProfile, 'AppData', 'Roaming', 'Google')), { protectedFolders: folders }), { code: 'INVALID_FOLDER' });
    await assertWindowsWorkspace(upper(path.join(winProfile, 'Projects', 'app')), { protectedFolders: folders });
  });
});

test('a failed or implausible Windows folder lookup refuses every folder and leaves the config alone', async () => {
  for (const report of [
    null, // PowerShell itself fails
    'O=C:\\Windows\r\n', // no user folder reported
    'P=C:\\Users\\J\ufffdrgen\r\n', // garbled name: maps to a folder that does not exist
  ]) {
    await withWsl(async ({ control, configFile, project, setFolderReport }) => {
      setFolderReport(report);
      const before = await readFile(configFile, 'utf8');
      await assert.rejects(control('choose-folder'), { code: 'WINDOWS_FOLDER_CHECK_UNAVAILABLE' }, String(report));
      assert.equal(await readFile(configFile, 'utf8'), before);
      assert.equal(JSON.parse(before).workspaceRoot, project);
    });
  }
});

test('every PowerShell script asks for UTF-8 output, so non-ASCII names survive', async () => {
  await withWsl(async ({ control, calls }) => {
    await control('choose-folder');
    const scripts = calls.filter(([command]) => command === 'powershell.exe')
      .map((call) => Buffer.from(call.at(-1), 'base64').toString('utf16le'));
    assert.ok(scripts.length >= 2);
    for (const script of scripts) assert.ok(script.startsWith('[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); '), script);
  });
});
