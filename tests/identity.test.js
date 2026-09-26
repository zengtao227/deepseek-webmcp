import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HOST_NAME, stateDir } from '../native/host/local-paths.js';
import { INSTANCE_ID } from '../native/host/host-access.js';

test('the extension is WebMCP: one instance, one host, state under the protected WebMCP folder', async () => {
  assert.equal(INSTANCE_ID, 'webmcp');
  assert.equal(HOST_NAME, 'com.webmcp.extension');
  assert.equal(stateDir('/Users/me'), '/Users/me/.local/share/webmcp/extension');
  const client = await readFile(new URL('../extension/native-client.js', import.meta.url), 'utf8');
  assert.match(client, /const HOST_NAME = 'com\.webmcp\.extension';/);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'WebMCP');
});
