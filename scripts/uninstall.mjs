#!/usr/bin/env node
// Removes what setup created. The folders you worked on are never touched. The popup's
// Uninstall… button does the same and also deletes a program folder made by install.sh.
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { removeDeepSeekInstance } from '../native/host/host-access.js';
import { HOST_NAME, IMAGE_TAG, browserProfileRoots, manifestDirFor, stateDir } from '../native/host/local-paths.js';

const execFileAsync = promisify(execFile);

for (const root of browserProfileRoots()) {
  await rm(path.join(manifestDirFor(root), `${HOST_NAME}.json`), { force: true });
}
process.stdout.write('removed browser registrations\n');
await rm(stateDir(), { recursive: true, force: true });
process.stdout.write(`removed ${stateDir()}\n`);
await removeDeepSeekInstance();
process.stdout.write('removed the DeepSeek WebMCP instance state (other WebMCP providers are untouched)\n');
try {
  await execFileAsync('docker', ['image', 'rm', IMAGE_TAG], { timeout: 60_000 });
  process.stdout.write(`removed Docker image ${IMAGE_TAG}\n`);
} catch {
  process.stdout.write(`Docker image ${IMAGE_TAG} not removed (already gone, or Docker is not running)\n`);
}
process.stdout.write('\nLast step: remove DeepSeek WebMCP in chrome://extensions. You can then delete this folder.\n');
