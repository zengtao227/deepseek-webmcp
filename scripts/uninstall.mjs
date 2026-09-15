#!/usr/bin/env node
// Removes only what setup created. The project folder you worked on is never touched.
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const home = os.homedir();
const targets = [
  path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.webmcp.native.json'),
  path.join(home, '.deepseek-webmcp'),
];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  process.stdout.write(`removed ${target}\n`);
}

try {
  await execFileAsync('docker', ['image', 'rm', 'deepseek-webmcp-p2:dev'], { timeout: 60_000 });
  process.stdout.write('removed Docker image deepseek-webmcp-p2:dev\n');
} catch {
  process.stdout.write('Docker image deepseek-webmcp-p2:dev not removed (already gone, or Docker is not running)\n');
}

process.stdout.write('\nLast step: chrome://extensions → DeepSeek WebMCP → Remove. You can then delete this folder.\n');
