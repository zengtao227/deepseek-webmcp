#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorkspaceControlPlaneMasks } from '../native/host/docker-dispatch.js';
import { HOST_NAME, IMAGE_TAG, configPath as defaultConfigPath, hostKind, installedBrowserProfileRoots, manifestDirFor, stateDir as defaultStateDir } from '../native/host/local-paths.js';
import { assertWindowsWorkspace } from '../native/host/control.js';
import { promisify } from 'node:util';
import { hostRuntimeRoot, readRuntimeLock } from '../native/host/host-access.js';

const execFileAsync = promisify(execFile);
const EXTENSION_ID = /^[a-p]{32}$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write('Usage: npm run setup [-- --workspace <absolute folder>] [--extension-id <id>] [--runtime-archive <file>]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { extensionId: null, workspace: null, runtimeArchive: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? usage(`Missing value for ${arg}.`);
    if (arg === '--extension-id') options.extensionId = next();
    else if (arg === '--workspace') options.workspace = next();
    else if (arg === '--runtime-archive') options.runtimeArchive = path.resolve(next());
    else usage(`Unknown option: ${arg}`);
  }
  if (options.extensionId !== null && !EXTENSION_ID.test(options.extensionId)) usage('Invalid Chrome extension id.');
  if (options.workspace !== null && !path.isAbsolute(options.workspace)) usage('--workspace must be an absolute host path.');
  return options;
}

// The manifest `key` pins the unpacked extension ID, so users never copy it by hand.
async function manifestExtensionId() {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'extension/manifest.json'), 'utf8'));
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
}

async function assertDockerRunning(dockerPath) {
  try {
    await execFileAsync(dockerPath, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20_000 });
  } catch {
    throw new Error('Docker is installed but not running. Start Docker Desktop, wait until it is ready, then run setup again.');
  }
}

async function which(binary) {
  const { stdout } = await execFileAsync('/usr/bin/which', [binary], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  const resolved = stdout.trim();
  if (!path.isAbsolute(resolved)) throw new Error(`Unable to resolve ${binary}.`);
  return resolved;
}

// Installs the pinned runtime release, pins the `deepseek` instance to it and builds the
// DeepSeek image from it. The shared `current` pointer and the default instance's image
// pin and tag are never touched.
async function installRuntime(dockerPath) {
  const lock = await readRuntimeLock();
  // install.sh downloads the pinned archive; the checksum below is what makes it trusted.
  if (!options.runtimeArchive) usage('--runtime-archive <file> is required (install.sh downloads it).');
  const work = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-runtime-'));
  try {
    const archive = options.runtimeArchive;
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    if (digest !== lock.archiveSha256) throw new Error('The WebMCP runtime download does not match its pinned checksum.');
    // The digest is verified, so the archive's own installer can be used to place it.
    const unpacked = path.join(work, 'unpacked');
    await mkdir(unpacked);
    await execFileAsync('tar', ['-xzf', archive, '-C', unpacked, '--no-same-owner']);
    const { installReleaseArchive } = await import(pathToFileURL(path.join(unpacked, 'adapter/deploy/deploy-host-runtime.js')).href);
    const release = await installReleaseArchive({
      archivePath: archive,
      expectedArchiveSha256: lock.archiveSha256,
      expectedArtifactId: lock.artifactId,
      runtimeRoot: hostRuntimeRoot(home),
      entrypoint: 'native/host/start.js',
    });
    const at = (relative) => import(pathToFileURL(path.join(release.releaseDir, relative)).href);
    const { createInstanceContext } = await at('native/deploy/instance-context.js');
    const { pinInstanceToRelease } = await at('native/deploy/instance-release.js');
    const { buildNativeImageFromRelease, DEFAULT_NATIVE_BASE_IMAGE } = await at('native/deploy/build-image.js');
    const context = createInstanceContext({ home, instanceId: 'deepseek' });
    const { image } = await buildNativeImageFromRelease({
      releaseDir: release.releaseDir,
      expectedArtifactId: lock.artifactId,
      baseImage: DEFAULT_NATIVE_BASE_IMAGE,
      outputPin: context.imagePin,
      tag: IMAGE_TAG,
      dockerBin: dockerPath,
    });
    // The caller pins only after every other install write succeeded, so a failed update
    // leaves the previous pin matching the previous adapter's runtime.lock.json.
    return { artifactId: lock.artifactId, image, pin: () => pinInstanceToRelease(context, lock.artifactId) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

const options = parseArgs(process.argv.slice(2));
const kind = hostKind();
if (kind === 'unsupported') throw new Error('DeepSeek WebMCP runs on macOS, or on Windows inside WSL.');

const home = os.homedir();
const stateDir = defaultStateDir(home);
const configPath = defaultConfigPath(home);

// Folder: explicit option, else the folder chosen last time, else ask once with the
// macOS folder dialog. Later changes happen in the extension popup (Other…).
async function chooseWorkspace() {
  if (options.workspace) return options.workspace;
  try {
    return JSON.parse(await readFile(configPath, 'utf8')).workspaceRoot;
  } catch {}
  // Under WSL the Windows setup chooses the folder in a Windows dialog and passes it in.
  if (kind === 'wsl') usage('--workspace <folder> is required under WSL.');
  process.stdout.write('Choose the folder DeepSeek WebMCP may read and change (you can change it later in the extension).\n');
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the folder DeepSeek WebMCP may read and change")'], { encoding: 'utf8' })
    .catch(() => usage('No folder chosen.'));
  return stdout.trim();
}

const requestedWorkspace = await chooseWorkspace();
const workspaceRoot = await realpath(requestedWorkspace).catch(() => usage(`Workspace directory not found: ${requestedWorkspace}`));
if (kind === 'wsl') await assertWindowsWorkspace(workspaceRoot);
const dockerPath = await which('docker').catch(() => {
  throw new Error('Docker was not found. Install Docker Desktop for Mac first: https://www.docker.com/products/docker-desktop/');
});
await assertDockerRunning(dockerPath);
const extensionId = options.extensionId ?? await manifestExtensionId();
await buildWorkspaceControlPlaneMasks(workspaceRoot, { configPath, dockerPath });
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const runtime = await installRuntime(dockerPath);
const image = runtime.image;
const launcherPath = path.join(stateDir, 'p2-native-host');
const browserRoots = await installedBrowserProfileRoots(home);
// Under WSL the browsers are registered on the Windows side (windows/register.ps1).
if (kind === 'macos' && browserRoots.length === 0) browserRoots.push(path.join(home, 'Library/Application Support/Google/Chrome'));
const manifestPaths = browserRoots.map((root) => path.join(manifestDirFor(root), `${HOST_NAME}.json`));
const hostScript = path.join(projectRoot, 'native/host/chrome-host.js');

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await writeFile(configPath, `${JSON.stringify({ workspaceRoot, image, dockerPath }, null, 2)}\n`, { mode: 0o600 });
await chmod(configPath, 0o600);
await writeFile(launcherPath, [
  '#!/bin/sh',
  `export DEEPSEEK_WEBMCP_CONFIG=${shellQuote(configPath)}`,
  `exec ${shellQuote(process.execPath)} ${shellQuote(hostScript)}`,
  '',
].join('\n'), { mode: 0o755 });
await chmod(launcherPath, 0o755);
for (const manifestPath of manifestPaths) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({
    name: HOST_NAME,
    description: 'DeepSeek WebMCP isolated local runtime',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`);
}

await runtime.pin();

process.stdout.write(`${JSON.stringify({
  installed: true,
  extensionDirectory: path.join(projectRoot, 'extension'),
  host: HOST_NAME,
  browsers: browserRoots.map((root) => path.relative(path.join(home, 'Library/Application Support'), root)),
  launcherPath,
  configPath,
  workspaceRoot,
  image,
  runtimeArtifactId: runtime.artifactId,
  dockerPath,
  extensionOrigin: `chrome-extension://${extensionId}/`,
}, null, 2)}\n`);
// install.sh prints its own last steps.
if (process.env.DEEPSEEK_WEBMCP_INSTALLER !== '1') process.stdout.write([
  '',
  'Next:',
  `1. In your browser open chrome://extensions, turn on Developer mode, and drag this folder onto the page: ${path.join(projectRoot, 'extension')}`,
  '   (already loaded? click its reload icon, then close and reopen DeepSeek tabs)',
  '2. Check the install: npm run doctor',
  '',
].join('\n'));
