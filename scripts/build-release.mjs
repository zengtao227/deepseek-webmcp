#!/usr/bin/env node
// Developer-side only: packs the adapter files of one commit into a release archive, so
// testers install a pinned, checksum-verified download instead of cloning the repository.
// Usage: node scripts/build-release.mjs --out <dir> [--commit <rev>]
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Only what an installed adapter runs; tests, docs, e2e and the image source stay out.
export const ADAPTER_PAYLOAD = Object.freeze([
  'package.json',
  'LICENSE',
  'runtime.lock.json',
  'extension',
  'native/host',
  'gateway/secret-scanner/index.js',
  'scripts/install-p2-native-host.mjs',
  'scripts/doctor.mjs',
  'scripts/uninstall.mjs',
  // Windows side of a WSL install: the relay source and the Chrome/Edge registration.
  'windows',
]);

async function main() {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? null : args[index + 1];
  };
  if (!option('--out')) throw new Error('--out <dir> is required.');
  const out = path.resolve(option('--out'));
  const git = (gitArgs) => execFileAsync('git', gitArgs, { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 });
  const commit = (await git(['rev-parse', '--verify', `${option('--commit') ?? 'HEAD'}^{commit}`])).stdout.trim();
  await mkdir(out, { recursive: true });
  const archive = path.join(out, `deepseek-webmcp-${commit}.tar.gz`);
  await git(['archive', '--format=tar.gz', `--output=${archive}`, commit, '--', ...ADAPTER_PAYLOAD]);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  process.stdout.write(`${JSON.stringify({ commit, archive, sha256 }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
