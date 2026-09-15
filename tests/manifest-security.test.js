import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('P2 is scoped to DeepSeek Web with only storage and Native Messaging permissions', () => {
  assert.deepEqual(manifest.host_permissions, ['https://chat.deepseek.com/*']);
  assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging']);
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(JSON.stringify(manifest).includes('cookies'), false);
  assert.equal(JSON.stringify(manifest).includes('webRequest'), false);
  assert.equal(JSON.stringify(manifest).includes('debugger'), false);
});

test('P2 observes DeepSeek only from one ISOLATED content script (no MAIN-world page hook)', () => {
  const scripts = manifest.content_scripts;
  assert.equal(scripts.length, 1);
  assert.deepEqual(scripts[0].matches, ['https://chat.deepseek.com/*']);
  assert.equal(scripts[0].world, 'ISOLATED');
  assert.deepEqual(scripts[0].js, ['content.js']);
  assert.equal(JSON.stringify(manifest).includes('"MAIN"'), false);
});
