import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['extension', 'gateway', 'native', 'tests', 'scripts'];
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile() && target.endsWith('.js') || entry.isFile() && target.endsWith('.mjs')) files.push(target);
  }
}

for (const root of roots) await walk(root);
files.sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
