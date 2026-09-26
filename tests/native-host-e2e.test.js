import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeNativeMessage } from '../native/host/chrome-framing.js';
import { writePinnedRelease } from './fixtures/pinned-release.js';
import { hostKind } from '../native/host/local-paths.js';

// The spawned host routes by the real platform: these cover the macOS instance route.
const macOnly = { skip: hostKind() !== 'macos' && 'the instance route runs only on macOS' };

// A relay that answers the one JSON-RPC line with `result`, after checking it runs as the deepseek instance.
function relayAnswering(result) {
  return `
if (process.env.WEBMCP_INSTANCE_ID !== 'deepseek' || !/^[0-9a-f]{64}$/.test(process.env.WEBMCP_RUNTIME_TOKEN ?? '')) process.exit(3);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const rpc = JSON.parse(input.trim());
  if (rpc.method !== 'tools/call') process.exit(4);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: ${JSON.stringify(result)} }) + '\\n');
});
`;
}

async function setupHost(prefix, relaySource) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  const releaseRoot = await writePinnedRelease(home, { 'native/host/start.js': relaySource });
  const relayPath = path.join(releaseRoot, 'native', 'host', 'start.js');
  const configPath = path.join(home, 'config.json');
  await writeFile(configPath, JSON.stringify({ dockerPath: '/usr/local/bin/docker' }));
  return { home, configPath, relayPath };
}

function decodeFrame(buffer) {
  assert.ok(buffer.byteLength >= 4);
  const length = os.endianness() === 'LE' ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
  assert.equal(buffer.byteLength, length + 4);
  return JSON.parse(buffer.subarray(4).toString('utf8'));
}

async function runHost({ home, configPath }, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['native/host/chrome-host.js'], {
      cwd: path.resolve('.'),
      env: { ...process.env, HOME: home, DEEPSEEK_WEBMCP_CONFIG: configPath },
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

test('Chrome framing -> native host -> runtime response -> Secret Firewall -> Chrome frame works end-to-end', macOnly, async () => {
  const host = await setupHost('deepseek-webmcp-e2e-', relayAnswering({
    content: [{ type: 'text', text: 'fixture' }],
    structuredContent: { result: 'known line\npassword = "p2-secret-fixture-value"' },
  }));

  const response = await runHost(host, {
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

test('native host admits P3 write through the deepseek instance relay and still rejects unknown tools before spawn', macOnly, async () => {
  const host = await setupHost('deepseek-webmcp-p3-host-', relayAnswering({ structuredContent: { result: 'WRITE_OK' } }));

  const writeResponse = await runHost(host, {
    version: 1,
    id: 'p3_write',
    tool: 'write',
    arguments: { workspaceId: 'ws_x', path: 'x', content: 'ok' },
  });
  assert.equal(writeResponse.ok, true);
  assert.equal(writeResponse.result.result, 'WRITE_OK');

  await writeFile(host.relayPath, 'process.exit(99);\n');
  const deniedResponse = await runHost(host, {
    version: 1,
    id: 'p3_unknown',
    tool: 'list_directory',
    arguments: {},
  });
  assert.equal(deniedResponse.ok, false);
  assert.equal(deniedResponse.error.code, 'TOOL_NOT_ALLOWED');
});

test('P3 write/edit tool errors still pass through the host Secret Firewall', macOnly, async () => {
  const host = await setupHost('deepseek-webmcp-p3-firewall-', relayAnswering({
    isError: true,
    structuredContent: {
      error: 'write_failed',
      message: 'password = "p3-secret-fixture-value"',
    },
  }));

  const response = await runHost(host, {
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
