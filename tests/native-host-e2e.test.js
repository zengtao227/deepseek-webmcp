import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeNativeMessage } from '../native/host/chrome-framing.js';

const IMAGE = `sha256:${'b'.repeat(64)}`;

function decodeFrame(buffer) {
  assert.ok(buffer.byteLength >= 4);
  const length = os.endianness() === 'LE' ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
  assert.equal(buffer.byteLength, length + 4);
  return JSON.parse(buffer.subarray(4).toString('utf8'));
}

async function runHost(configPath, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['native/host/chrome-host.js'], {
      cwd: path.resolve('.'),
      env: { ...process.env, DEEPSEEK_WEBMCP_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`host exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolve(decodeFrame(Buffer.concat(stdout)));
    });
    child.stdin.end(encodeNativeMessage(request, { maxBytes: 1024 * 1024 }));
  });
}

test('Chrome framing -> native host -> runtime response -> Secret Firewall -> Chrome frame works end-to-end', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-e2e-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-e2e-workspace-'));
  const fakeDocker = path.join(dir, 'fake-docker');
  const configPath = path.join(dir, 'config.json');

  await writeFile(fakeDocker, `#!${process.execPath}\n` + String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const rpc = JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: rpc.id,
    result: {
      content: [{ type: 'text', text: 'fixture' }],
      structuredContent: { result: 'known line\\npassword = "p2-secret-fixture-value"' }
    }
  }) + '\n');
});
`);
  await chmod(fakeDocker, 0o755);
  await writeFile(configPath, JSON.stringify({
    workspaceRoot: workspace,
    image: IMAGE,
    dockerPath: fakeDocker,
  }));

  const response = await runHost(configPath, {
    version: 1,
    id: 'p2_read',
    tool: 'read',
    arguments: { workspaceId: 'ws_test', path: 'fixture.txt' },
  });

  assert.equal(response.version, 1);
  assert.equal(response.id, 'p2_read');
  assert.equal(response.ok, true);
  assert.match(response.result.result, /known line/);
  assert.match(response.result.result, /\[REDACTED/);
  assert.doesNotMatch(response.result.result, /p2-secret-fixture-value/);
});

test('native host admits P3 write through the same one-shot runtime and still rejects unknown tools before spawn', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-p3-host-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-e2e-workspace-'));
  const fakeDocker = path.join(dir, 'fake-docker');
  const configPath = path.join(dir, 'config.json');
  await writeFile(fakeDocker, `#!${process.execPath}\n` + String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const rpc = JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: rpc.id,
    result: { structuredContent: { result: 'WRITE_OK' } }
  }) + '\n');
});
`);
  await chmod(fakeDocker, 0o755);
  await writeFile(configPath, JSON.stringify({ workspaceRoot: workspace, image: IMAGE, dockerPath: fakeDocker }));

  const writeResponse = await runHost(configPath, {
    version: 1,
    id: 'p3_write',
    tool: 'write',
    arguments: { workspaceId: 'ws_x', path: 'x', content: 'ok' },
  });
  assert.equal(writeResponse.ok, true);
  assert.equal(writeResponse.result.result, 'WRITE_OK');

  await writeFile(fakeDocker, `#!${process.execPath}\nprocess.exit(99);\n`);
  await chmod(fakeDocker, 0o755);
  const deniedResponse = await runHost(configPath, {
    version: 1,
    id: 'p3_unknown',
    tool: 'list_directory',
    arguments: {},
  });
  assert.equal(deniedResponse.ok, false);
  assert.equal(deniedResponse.error.code, 'TOOL_NOT_ALLOWED');
});

test('P3 write/edit tool errors still pass through the host Secret Firewall', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-p3-firewall-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'deepseek-webmcp-e2e-workspace-'));
  const fakeDocker = path.join(dir, 'fake-docker');
  const configPath = path.join(dir, 'config.json');
  await writeFile(fakeDocker, `#!${process.execPath}\n` + String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const rpc = JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: rpc.id,
    result: {
      isError: true,
      structuredContent: {
        error: 'write_failed',
        message: 'password = "p3-secret-fixture-value"'
      }
    }
  }) + '\n');
});
`);
  await chmod(fakeDocker, 0o755);
  await writeFile(configPath, JSON.stringify({ workspaceRoot: workspace, image: IMAGE, dockerPath: fakeDocker }));

  const response = await runHost(configPath, {
    version: 1,
    id: 'p3_edit_error',
    tool: 'edit',
    arguments: { workspaceId: 'ws_x', path: 'x', edits: [{ oldText: 'a', newText: 'b' }] },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'write_failed');
  assert.match(response.error.message, /\[REDACTED/);
  assert.doesNotMatch(response.error.message, /p3-secret-fixture-value/);
});
