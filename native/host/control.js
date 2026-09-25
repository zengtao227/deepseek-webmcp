import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOST_CODE_ROOT, NativeHostError, buildWorkspaceControlPlaneMasks, readFullAccessLease } from './docker-dispatch.js';
import { HOST_NAME, IMAGE_TAG, INSTALL_MARKER, WINDOWS_APP_FOLDER, WINDOWS_REGISTRY_KEYS, browserProfileRoots, configPath as defaultConfigPath, hostKind, leasePath, manifestDirFor, stateDir } from './local-paths.js';
import { chooseFolderOnWindows, confirmOnWindows, notifyOnWindows, removeWindowsRegistration, toWindowsPath, toWslPath, windowsProtectedFolders } from './windows-dialogs.js';
import { grantHostAccess, hostAccessStatus, removeDeepSeekInstance, revokeHostAccess } from './host-access.js';

const execFileAsync = promisify(execFile);
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL_ARGUMENTS = new Map([
  ['status', new Set()],
  ['choose-folder', new Set()],
  ['grant-full-access', new Set(['minutes'])],
  ['stop-full-access', new Set()],
  ['grant-host-access', new Set(['minutes'])],
  ['stop-host-access', new Set()],
  ['uninstall', new Set()],
]);
const DIALOG_SECONDS = 120;
function fail(message, code) {
  throw new NativeHostError(message, code);
}

function exactObject(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`, 'INVALID_REQUEST');
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowedKeys.has(key)) fail(`${label} contains unsupported field: ${key}`, 'INVALID_REQUEST');
  }
}

// Owner settings are a separate envelope (`control`) from model tool calls (`tool`);
// each validator rejects the other's discriminator, so they can never be confused.
export function validateControlRequest(request) {
  exactObject(request, new Set(['version', 'id', 'control', 'arguments']), 'request');
  if (request.version !== 1) fail('Unsupported native protocol version.', 'INVALID_VERSION');
  if (typeof request.id !== 'string' || !ID_PATTERN.test(request.id)) fail('Invalid request id.', 'INVALID_ID');
  const allowed = CONTROL_ARGUMENTS.get(request.control);
  if (!allowed) fail('Unknown control request.', 'CONTROL_NOT_ALLOWED');
  exactObject(request.arguments, allowed, 'arguments');
  if (request.control === 'grant-full-access' || request.control === 'grant-host-access') {
    const { minutes } = request.arguments;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) fail('minutes must be an integer from 1 to 60.', 'INVALID_DURATION');
  }
  return request;
}

function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// Every authority change needs a click in a real macOS dialog on this Mac; a page or
// the model can at most make a dialog appear.
async function runAppleScript(script, { exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: (DIALOG_SECONDS + 10) * 1000 });
    return stdout.trim();
  } catch (error) {
    if (/-128|User canceled/i.test(`${error?.stderr ?? ''}${error?.message ?? ''}`)) return null;
    throw new NativeHostError('The macOS dialog could not be shown.', 'DIALOG_FAILED');
  }
}

// Detached so the reply to the browser is not held until the user clicks OK: the popup
// has already closed behind the confirmation dialog and the extension removes itself.
function showDetachedMessage(message) {
  spawn('/usr/bin/osascript', ['-e', `display dialog ${appleScriptString(message)} with title "DeepSeek WebMCP" buttons {"OK"} default button "OK" giving up after 60`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function confirm(message, button, options) {
  if (options.kind === 'wsl') return confirmOnWindows(message, { exec: options.exec, timeoutMs: (DIALOG_SECONDS + 10) * 1000 });
  const answer = await runAppleScript(
    `display dialog ${appleScriptString(message)} with title "DeepSeek WebMCP" buttons {"Cancel", ${appleScriptString(button)}} default button "Cancel" cancel button "Cancel" with icon caution giving up after ${DIALOG_SECONDS}`,
    options,
  );
  return typeof answer === 'string' && answer.includes(`button returned:${button}`) && !answer.includes('gave up:true');
}

async function readConfig(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function status({ home, configFile, now, kind }) {
  const config = await readConfig(configFile);
  return {
    folder: config.workspaceRoot,
    // Full access and Host access exist only on macOS for now. On Windows they are future
    // work, and Host access must then mean the real Windows host, not WSL.
    capabilities: { fullAccess: kind === 'macos', hostAccess: kind === 'macos' },
    fullAccessUntil: await readFullAccessLease({ home, now }),
    ...(await hostAccessStatus({ configFile })),
  };
}

async function pickFolder({ config, exec, kind }) {
  if (kind === 'wsl') {
    const picked = await chooseFolderOnWindows(await toWindowsPath(config.workspaceRoot, { exec }).catch(() => ''), { exec, timeoutMs: (DIALOG_SECONDS + 10) * 1000 });
    return picked === null ? null : toWslPath(picked, { exec });
  }
  return runAppleScript(
    `POSIX path of (choose folder with prompt "Choose the folder DeepSeek WebMCP may read and change" default location (POSIX file ${appleScriptString(config.workspaceRoot)}))`,
    { exec },
  );
}

// Same rule as the WebMCP Setup: not a drive root, not the user folder or anything that
// contains it, and nothing that contains or sits inside AppData, Windows, ProgramData or
// the program folders. `folder` must already be canonical. Any doubt refuses: drvfs is
// case-insensitive (so is the comparison), and a Windows folder that cannot be looked up or
// found would match nothing.
export async function assertWindowsWorkspace(folder, { exec, protectedFolders } = {}) {
  const within = (root, candidate) => {
    const relative = path.relative(root.toLowerCase(), candidate.toLowerCase());
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const refuse = () => fail('Choose a project folder, not a system folder or your whole Windows user folder.', 'INVALID_FOLDER');
  const unchecked = () => fail('Windows folders cannot be checked from WSL, so no folder is accepted.', 'WINDOWS_FOLDER_CHECK_UNAVAILABLE');
  if (/^\/mnt\/[a-z]\/?$/i.test(folder)) refuse();
  let folders;
  try {
    folders = protectedFolders ?? await windowsProtectedFolders({ exec });
  } catch {
    unchecked();
  }
  const real = (candidate) => realpath(candidate).catch(unchecked);
  if (within(folder, await real(folders.profile))) refuse();
  for (const other of folders.others) {
    const resolved = await real(other);
    if (within(folder, resolved) || within(resolved, folder)) refuse();
  }
}

async function chooseFolder({ home, configFile, now, exec, kind }) {
  const config = await readConfig(configFile);
  const picked = await pickFolder({ config, exec, kind });
  if (picked === null) return { changed: false, ...(await status({ home, configFile, now, kind })) };
  const folder = await realpath(picked).catch(() => fail('The chosen folder cannot be resolved.', 'INVALID_FOLDER'));
  if (!(await stat(folder)).isDirectory()) fail('Please choose a folder.', 'INVALID_FOLDER');
  if (folder === await realpath(home)) fail('For the whole home folder use Full access instead.', 'INVALID_FOLDER');
  if (kind === 'wsl') await assertWindowsWorkspace(folder, { exec });
  await buildWorkspaceControlPlaneMasks(folder, { configPath: configFile, dockerPath: config.dockerPath, home });
  await writeJsonAtomic(configFile, { ...config, workspaceRoot: folder });
  return { changed: true, ...(await status({ home, configFile, now, kind })) };
}

function assertMacOnly(kind, what) {
  if (kind !== 'macos') fail(`${what} is not available on Windows yet.`, 'NOT_AVAILABLE_ON_WINDOWS');
}

async function grantFullAccess({ home, configFile, now, exec, kind }, { minutes }) {
  assertMacOnly(kind, 'Full access');
  const allowed = await confirm(
    `Allow DeepSeek to read and change everything in your home folder for ${minutes} minutes?\n\nDeepSeek WebMCP itself, browser data, shell startup files, SSH/cloud keys and Keychains stay hidden. Anything DeepSeek reads is sent to DeepSeek. Network stays off.`,
    'Allow',
    { exec, kind },
  );
  if (allowed) await writeJsonAtomic(leasePath(home), { expiresAt: now + minutes * 60_000 });
  return { changed: allowed, ...(await status({ home, configFile, now, kind })) };
}

async function stopFullAccess({ home, configFile, now, kind }) {
  await rm(leasePath(home), { force: true });
  return { changed: true, ...(await status({ home, configFile, now, kind })) };
}

// install.sh unpacks a DeepSeek WebMCP release archive and marks the folder; a developer
// checkout is a Git repository. Only the former is ever deleted.
export async function isInstalledCodeFolder(folder) {
  const exists = (name) => stat(path.join(folder, name)).then(() => true, () => false);
  if (!(await exists(INSTALL_MARKER)) || (await exists('.git'))) return false;
  try {
    return JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')).name === 'deepseek-webmcp';
  } catch {
    return false;
  }
}

async function uninstall({ home, configFile, exec, notify, kind }) {
  const allowed = await confirm(
    'Uninstall DeepSeek WebMCP?\n\nThis removes the local runtime, its settings, the Docker image, the browser registrations and the DeepSeek WebMCP program folder. Your project folders are not touched.',
    'Uninstall',
    { exec, kind },
  );
  if (!allowed) return { uninstalled: false };
  if (kind === 'wsl') {
    await removeWindowsRegistration({ registryKeys: WINDOWS_REGISTRY_KEYS, appFolder: WINDOWS_APP_FOLDER, exec });
  }
  let dockerPath = 'docker';
  try { dockerPath = (await readConfig(configFile)).dockerPath; } catch {}
  for (const root of browserProfileRoots(home)) {
    await rm(path.join(manifestDirFor(root), `${HOST_NAME}.json`), { force: true });
  }
  try { await exec(dockerPath, ['image', 'rm', IMAGE_TAG], { encoding: 'utf8', timeout: 60_000 }); } catch {}
  await rm(stateDir(home), { recursive: true, force: true });
  await removeDeepSeekInstance(home);
  // Only a folder created by install.sh from this repository is deleted; a developer
  // checkout (no marker) is left alone.
  const removeCode = HOST_CODE_ROOT !== home && await isInstalledCodeFolder(HOST_CODE_ROOT);
  if (removeCode) await rm(HOST_CODE_ROOT, { recursive: true, force: true });
  notify('DeepSeek WebMCP was uninstalled.\n\nIf it is still listed in another browser, remove it there on the extensions page.');
  return { uninstalled: true, removedProgramFolder: removeCode };
}

export async function handleControlRequest(request, {
  home = os.homedir(),
  configFile = defaultConfigPath(home),
  now = Date.now(),
  exec = execFileAsync,
  kind = hostKind(),
  notify = kind === 'wsl' ? notifyOnWindows : showDetachedMessage,
} = {}) {
  validateControlRequest(request);
  const context = { home, configFile, now, exec, notify, kind };
  const handlers = {
    status: () => status(context),
    'choose-folder': () => chooseFolder(context),
    'grant-full-access': () => grantFullAccess(context, request.arguments),
    'stop-full-access': () => stopFullAccess(context),
    'grant-host-access': async () => {
      assertMacOnly(kind, 'Host access');
      return { ...await status(context), ...await grantHostAccess({ configFile, minutes: request.arguments.minutes }) };
    },
    'stop-host-access': async () => ({ ...await status(context), ...await revokeHostAccess({ configFile }) }),
    uninstall: () => uninstall(context),
  };
  const result = await handlers[request.control]();
  return { version: 1, id: request.id, ok: true, result };
}
