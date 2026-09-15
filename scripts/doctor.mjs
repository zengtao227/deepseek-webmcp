#!/usr/bin/env node
// Read-only install check: config, Docker, image, Chrome manifest, one real open_workspace call.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dispatchNativeRequest, loadNativeHostConfig } from '../native/host/docker-dispatch.js';
import { HOST_NAME, installedBrowserProfileRoots, manifestDirFor } from '../native/host/local-paths.js';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(os.homedir(), '.deepseek-webmcp', 'p2-native-config.json');
let failed = false;

async function check(label, run, hint) {
  try {
    const detail = await run();
    process.stdout.write(`OK    ${label}${detail ? `: ${detail}` : ''}\n`);
    return true;
  } catch (error) {
    failed = true;
    process.stdout.write(`FAIL  ${label}: ${error?.message ?? error}\n      → ${hint}\n`);
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

await check('isolated runtime answers open_workspace', async () => {
  if (!config) throw new Error('no config');
  const response = await dispatchNativeRequest({ version: 1, id: 'doctor', tool: 'open_workspace', arguments: { path: '/workspace' } }, config);
  if (!response.ok) throw new Error(response.error?.message ?? 'tool error');
  return response.result.workspaceId.slice(0, 15);
}, 'Check Docker Desktop file sharing includes your project folder, then run setup again.');

process.stdout.write(failed ? '\nSome checks failed.\n' : '\nAll checks passed. Reload the extension and any open DeepSeek tabs if you just ran setup.\n');
process.exitCode = failed ? 1 : 0;
