import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertWindowsDrivePath, assertWindowsFolderRule, assertWindowsWorkspace, handleControlRequest } from '../native/host/control.js';
import { windowsFolderQuery, windowsFolderQueryScript } from '../native/host/windows-dialogs.js';
import { WINDOWS_REGISTRY_KEYS, browserProfileRoots, hostKind } from '../native/host/local-paths.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;

function hasPwsh() {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', '1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const PWSH = hasPwsh();

// The real folder query, run by pwsh against a local folder (Unix pwsh marks symlinks
// ReparsePoint as Windows does junctions). Short 8.3 names exist only on Windows: Tester 1 gate.
function realQuery(folder) {
  const encoded = Buffer.from(windowsFolderQueryScript(folder), 'utf16le').toString('base64');
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

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
    const queried = [];
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
        if (script.includes('$original = ')) {
          // The folder query: run the real query against the folder this Windows path stands for.
          const windowsPath = script.match(/\$original = '([^']*)';/)[1];
          queried.push(windowsPath);
          return { stdout: PWSH ? realQuery(toWsl[windowsPath]) : 'PLAIN\r\n' };
        }
        return { stdout: '' };
      }
      if (command === 'wslpath') return { stdout: `${args[0] === '-u' ? (toWsl[args[1]] ?? path.join(root, 'unmapped', path.win32.basename(args[1]))) : 'C:\\Users\\me\\Projects\\app'}\n` };
      return { stdout: '' };
    };
    const control = (name, args = {}) => handleControlRequest(
      { version: 1, id: 'w1', control: name, arguments: args },
      { home, configFile, now: 1000, exec, kind: 'wsl', notify: () => {} },
    );
    await run({ home, configFile, winProfile, project, calls, queried, control, setPick: (value) => { pick = value; }, setFolderReport: (value) => { folderReport = value; } });
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
  await withWsl(async ({ control, configFile, project, setPick, queried }) => {
    const chosen = await control('choose-folder');
    assert.equal(chosen.result.changed, true);
    // The accepted folder went through the real link/alias query.
    assert.deepEqual(queried, ['C:\\Users\\me\\Projects\\app']);
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
    assertWindowsFolderRule(upper(path.join(winProfile, 'Projects', 'app')), folders);
    // A name that merely starts with ".." is still inside, as for Setup's StartsWith(parent + "\\").
    await assert.rejects(assertWindowsWorkspace(path.join(winProfile, 'AppData', 'Roaming', '..cache'), { protectedFolders: folders }), { code: 'INVALID_FOLDER' });
    assertWindowsFolderRule(path.join(winProfile, '..dotted-project'), folders);
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

// Shared with webmcp-bridge (byte-identical fixture) so both implementations keep Setup's rule.
const CASES = JSON.parse(readFileSync(new URL('./fixtures/windows-folder-policy-cases.json', import.meta.url), 'utf8'));

test('Windows folder rule matches WebMCP Setup (shared conformance cases)', () => {
  for (const folder of CASES.wslPaths.refuse) {
    assert.throws(() => assertWindowsFolderRule(folder, CASES.protected), { code: 'INVALID_FOLDER' }, folder);
  }
  for (const folder of CASES.wslPaths.allow) {
    assert.doesNotThrow(() => assertWindowsFolderRule(folder, CASES.protected), folder);
  }
  for (const windowsPath of CASES.windowsPaths.refuse) {
    assert.throws(() => assertWindowsDrivePath(windowsPath), { code: 'INVALID_FOLDER' }, windowsPath);
  }
  for (const windowsPath of CASES.windowsPaths.allow) {
    assert.doesNotThrow(() => assertWindowsDrivePath(windowsPath), windowsPath);
  }
});

test('the folder must map to a drive path, and Windows is asked about links and names; any doubt refuses', async () => {
  await withWsl(async ({ winProfile }) => {
    const folders = { profile: winProfile, others: [] };
    const calls = [];
    const check = (mapped, answer) => assertWindowsWorkspace('/mnt/d/work/app', {
      protectedFolders: folders,
      exec: async (command, args) => {
        calls.push(command);
        if (command === 'wslpath') {
          assert.deepEqual(args, ['-w', '/mnt/d/work/app']);
          if (mapped instanceof Error) throw mapped;
          return { stdout: `${mapped}\n` };
        }
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        assert.match(script, /\$original = 'D:\\work\\app';/);
        if (answer instanceof Error) throw answer;
        return { stdout: answer };
      },
    });
    const drive = 'D:\\work\\app';
    await check(drive, 'PLAIN\r\n');
    await assert.rejects(check(drive, 'LINK\r\n'), { code: 'INVALID_FOLDER' });
    await assert.rejects(check(drive, 'ALIAS\r\n'), { code: 'INVALID_FOLDER' });
    await assert.rejects(check(drive, 'something else\r\n'), { code: 'WINDOWS_FOLDER_CHECK_UNAVAILABLE' });
    await assert.rejects(check(drive, new Error('Get-Item failed')), { code: 'WINDOWS_FOLDER_CHECK_UNAVAILABLE' });
    await assert.rejects(check(new Error('wslpath failed')), { code: 'WINDOWS_FOLDER_CHECK_UNAVAILABLE' });
    calls.length = 0;
    // A folder inside WSL maps to a UNC path and is refused before PowerShell is asked.
    await assert.rejects(check('\\\\wsl.localhost\\Ubuntu\\home\\me\\code'), { code: 'INVALID_FOLDER' });
    assert.deepEqual(calls, ['wslpath']);
  });
});

test('the real Windows query answers PLAIN, LINK or ALIAS, and fails on a missing folder', { skip: !PWSH && 'pwsh not installed' }, async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'deepseek-win-query-')));
  try {
    await mkdir(path.join(base, 'Real', 'Proj'), { recursive: true });
    await mkdir(path.join(base, 'Other'));
    await symlink(path.join(base, 'Other'), path.join(base, 'Real', 'Link'));
    assert.equal(realQuery(path.join(base, 'Real', 'Proj')).trim(), 'PLAIN');
    assert.equal(realQuery(path.join(base, 'real', 'proj')).trim(), 'PLAIN', 'case alone is not an alias');
    assert.equal(realQuery(path.join(base, 'Real', 'Link')).trim(), 'LINK');
    assert.equal(realQuery(`${path.join(base, 'Real', 'Proj')}/../Proj`).trim(), 'ALIAS', 'a spelling Windows maps elsewhere');
    assert.throws(() => realQuery(path.join(base, 'Missing')));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// PowerShell also reads the typographic quotes U+2018-U+201B as single quotes.
const HOSTILE = "D:\\work\\Tom\u2019+(\"INJECTED\")+\u2019s \u2018a\u201Ab\u201Bc'd";

test('a folder name with any PowerShell quote character stays a literal in PowerShell scripts', async () => {
  let script;
  await windowsFolderQuery(HOSTILE, {
    exec: async (command, args) => {
      script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      return { stdout: 'PLAIN\n' };
    },
  });
  const literal = script.match(/\$original = ('(?:[^'\u2018\u2019\u201A\u201B]|['\u2018\u2019\u201A\u201B]{2})*');/)?.[1];
  assert.ok(literal, script);
  if (PWSH) {
    assert.equal(execFileSync('pwsh', ['-NoProfile', '-Command', `$x = ${literal}; $x`], { encoding: 'utf8' }).trim(), HOSTILE);
  }
});
