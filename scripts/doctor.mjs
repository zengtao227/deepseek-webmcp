#!/usr/bin/env node
// Read-only install check: config, Docker, image, Chrome manifest, one real open_workspace call.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { dispatchNativeRequest, loadNativeHostConfig } from '../native/host/docker-dispatch.js';
import { HOST_NAME, configPath as defaultConfigPath, hostKind, installedBrowserProfileRoots, manifestDirFor } from '../native/host/local-paths.js';
import { hostRuntimeRoot, INSTANCE_ID, readRuntimeLock } from '../native/host/host-access.js';
import { runInstanceControl } from '../native/host/instance-access.js';
import { dispatchInstanceRequest } from '../native/host/instance-dispatch.js';
import { redactSecrets } from '../gateway/secret-scanner/index.js';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = defaultConfigPath(os.homedir());
let failed = false;

// Doctor output is meant to be pasted into a bug report: no home path, no secret values.
function shareable(text) {
  return redactSecrets(String(text).replaceAll(os.homedir(), '~')).text;
}

async function check(label, run, hint) {
  try {
    const detail = await run();
    process.stdout.write(shareable(`OK    ${label}${detail ? `: ${detail}` : ''}\n`));
    return true;
  } catch (error) {
    failed = true;
    process.stdout.write(shareable(`FAIL  ${label}: ${error?.message ?? error}\n      → ${hint}\n`));
    return false;
  }
}

let config = null;
await check('install config', async () => {
  config = await loadNativeHostConfig(configPath);
  return config.canonicalRoot;
}, 'Run: npm run setup -- --workspace "/absolute/path/to/your/project"');

await check('Docker running', async () => {
  const { stdout } = await execFileAsync(config?.dockerPath ?? 'docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
  return `server ${stdout.trim()}`;
}, 'Start Docker Desktop and wait until it is ready.');

await check('runtime image', async () => {
  if (!config) throw new Error('no config');
  await execFileAsync(config.dockerPath, ['image', 'inspect', config.image], { timeout: 20_000 });
  return config.image.slice(0, 19);
}, 'Run setup again to rebuild the image.');

// The image must be built from exactly the pinned webmcp-runtime release: its source label
// equals that release's image-source digest. This is also what host access loads.
await check('shared runtime release', async () => {
  if (!config) throw new Error('no config');
  const { artifactId } = await readRuntimeLock();
  const releaseDir = path.join(hostRuntimeRoot(), 'releases', artifactId);
  const at = (relative) => import(pathToFileURL(path.join(releaseDir, relative)).href);
  const { verifyRelease } = await at('adapter/deploy/deploy-host-runtime.js');
  const { manifest } = await verifyRelease(releaseDir, { expectedArtifactId: artifactId, entrypoint: 'native/host/start.js' });
  const { aggregateSourceDigest, NATIVE_RUNTIME_PAYLOAD } = await at('native/deploy/runtime-payload.js');
  const expected = aggregateSourceDigest(manifest.files.filter((file) => NATIVE_RUNTIME_PAYLOAD.includes(file.path)));
  const { stdout } = await execFileAsync(config.dockerPath, ['image', 'inspect', '--format', '{{index .Config.Labels "com.webmcp.native.source-sha256"}}', config.image], { timeout: 20_000 });
  if (stdout.trim() !== expected) throw new Error('the runtime image was not built from the pinned release');
  return `${artifactId.slice(0, 12)} (image source ${expected.slice(0, 12)})`;
}, 'Run the installer again to install the pinned runtime release and rebuild the image.');

const extension = JSON.parse(await readFile(path.join(projectRoot, 'extension/manifest.json'), 'utf8'));
const digest = createHash('sha256').update(Buffer.from(extension.key, 'base64')).digest('hex').slice(0, 32);
const extensionId = [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
for (const root of await installedBrowserProfileRoots()) {
  const browser = path.relative(path.join(os.homedir(), 'Library/Application Support'), root);
  await check(`${browser} registration`, async () => {
    const manifest = JSON.parse(await readFile(path.join(manifestDirFor(root), `${HOST_NAME}.json`), 'utf8'));
    if (!manifest.allowed_origins?.includes(`chrome-extension://${extensionId}/`)) throw new Error(`does not allow extension ${extensionId}`);
    return `extension ${extensionId}`;
  }, 'Run setup again (browsers installed after setup need it).');
}

const openWorkspace = { version: 1, id: 'doctor', tool: 'open_workspace', arguments: { path: '/workspace' } };
const opened = (response) => {
  if (!response.ok) throw new Error(response.error?.message ?? 'tool error');
  return response.result.workspaceId.slice(0, 15);
};
if (hostKind() === 'macos') {
  // On macOS the tools run in the `webmcp` instance, which the WebMCP App manages.
  const options = { dockerPath: config?.dockerPath };
  await check(`instance "${INSTANCE_ID}" access`, async () => {
    const status = await runInstanceControl('access-status', options);
    return status.mode === 'elevated' ? `Host Access until ${status.expiresAt}` : 'folders only';
  }, 'Run the installer again; it provisions the instance.');
  await check(`instance "${INSTANCE_ID}" folders`, async () => {
    const list = await runInstanceControl('mount-list', options);
    const count = list.mounts?.length ?? (list.legacyRoot ? 1 : 0);
    if (count === 0) throw new Error('no folder');
    return `${count} folder(s)`;
  }, 'Add a folder in the WebMCP App (menu bar) under "WebMCP Extension".');
  await check('instance answers open_workspace', async () => opened(await dispatchInstanceRequest(openWorkspace, options)),
    'Check Docker Desktop is running and file sharing includes your folders, then run the installer again.');
  // Left by the DeepSeek-only installer; the new install never uses it.
  const oldProgram = path.join(os.homedir(), 'deepseek-webmcp');
  if (await readFile(path.join(oldProgram, 'package.json')).then(() => true, () => false)) {
    process.stdout.write(shareable(`NOTE  old DeepSeek program folder ${oldProgram}: remove it after checking the new extension works\n`));
  }
} else {
  await check('isolated runtime answers open_workspace', async () => {
    if (!config) throw new Error('no config');
    return opened(await dispatchNativeRequest(openWorkspace, config));
  }, 'Check Docker Desktop file sharing includes your project folder, then run setup again.');
}

process.stdout.write(failed ? '\nSome checks failed.\n' : '\nAll checks passed. Reload the extension and any open provider tabs if you just ran setup.\n');
process.exitCode = failed ? 1 : 0;
