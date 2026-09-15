#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWorkspaceOutsideControlPlane } from '../native/host/docker-dispatch.js';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST_NAME = 'com.deepseek.webmcp.native';
const EXTENSION_ID = /^[a-p]{32}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/i;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write('Usage: node scripts/install-p2-native-host.mjs --extension-id <id> --workspace <absolute-path> [--image <sha256:id>]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { extensionId: null, workspace: null, image: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? usage(`Missing value for ${arg}.`);
    if (arg === '--extension-id') options.extensionId = next();
    else if (arg === '--workspace') options.workspace = next();
    else if (arg === '--image') options.image = next();
    else usage(`Unknown option: ${arg}`);
  }
  if (!EXTENSION_ID.test(options.extensionId ?? '')) usage('Invalid Chrome extension id.');
  if (!options.workspace || !path.isAbsolute(options.workspace)) usage('--workspace must be an absolute host path.');
  if (options.image !== null && !IMAGE_ID.test(options.image)) usage('--image must be a sha256 image id.');
  return options;
}

async function which(binary) {
  const { stdout } = await execFileAsync('/usr/bin/which', [binary], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  const resolved = stdout.trim();
  if (!path.isAbsolute(resolved)) throw new Error(`Unable to resolve ${binary}.`);
  return resolved;
}

async function sourceDigest() {
  const files = [
    'package.json',
    'gateway/path-policy/index.js',
    'native/src/server.js',
    'native/src/stdio.js',
    'native/src/workspace.js',
    'native/bin/start.js',
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(path.join(projectRoot, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function buildImage(dockerPath) {
  const digest = await sourceDigest();
  const tag = 'deepseek-webmcp-p2:dev';
  await execFileAsync(dockerPath, [
    'build',
    '--build-arg', 'WEBMCP_NODE_IMAGE=node:22-bookworm-slim',
    '--build-arg', `WEBMCP_SOURCE_SHA256=${digest}`,
    '-f', path.join(projectRoot, 'native/Dockerfile'),
    '-t', tag,
    projectRoot,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const { stdout } = await execFileAsync(dockerPath, ['image', 'inspect', '--format', '{{.Id}}', tag], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  const image = stdout.trim();
  if (!IMAGE_ID.test(image)) throw new Error('Docker returned an invalid local image id.');
  return image;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

const options = parseArgs(process.argv.slice(2));
if (process.platform !== 'darwin') throw new Error('P2 dev installer currently supports macOS Chrome only.');

const [workspaceRoot, dockerPath] = await Promise.all([realpath(options.workspace), which('docker')]);
const home = os.homedir();
const stateDir = path.join(home, '.deepseek-webmcp');
const configPath = path.join(stateDir, 'p2-native-config.json');
await assertWorkspaceOutsideControlPlane(workspaceRoot, { configPath, dockerPath });
const image = options.image ?? await buildImage(dockerPath);
const launcherPath = path.join(stateDir, 'p2-native-host');
const manifestDir = path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
const hostScript = path.join(projectRoot, 'native/host/chrome-host.js');

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await mkdir(manifestDir, { recursive: true });
await writeFile(configPath, `${JSON.stringify({ workspaceRoot, image, dockerPath }, null, 2)}\n`, { mode: 0o600 });
await chmod(configPath, 0o600);
await writeFile(launcherPath, [
  '#!/bin/sh',
  `export DEEPSEEK_WEBMCP_CONFIG=${shellQuote(configPath)}`,
  `exec ${shellQuote(process.execPath)} ${shellQuote(hostScript)}`,
  '',
].join('\n'), { mode: 0o755 });
await chmod(launcherPath, 0o755);
await writeFile(manifestPath, `${JSON.stringify({
  name: HOST_NAME,
  description: 'DeepSeek WebMCP P2 isolated local runtime',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${options.extensionId}/`],
}, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  installed: true,
  host: HOST_NAME,
  manifestPath,
  launcherPath,
  configPath,
  workspaceRoot,
  image,
  dockerPath,
  extensionOrigin: `chrome-extension://${options.extensionId}/`,
}, null, 2)}\n`);
