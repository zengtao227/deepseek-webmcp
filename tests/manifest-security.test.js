import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

// Decision 2026-09-21 (owner): like the ChatGPT Embedded Panel, the assistant works on whatever
// ordinary webpage is open next to the panel, so it needs host access to http(s) pages. Browsing
// history, cookies, network hooks and debugger access stay out; commit-like clicks stay with the owner.
test('page tools use http(s) host access, but no browsing, cookie, network or debugger permissions', () => {
  assert.deepEqual(manifest.host_permissions, ['https://chat.deepseek.com/*', 'http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging', 'scripting', 'sidePanel']);
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.deepEqual(manifest.action, { default_title: 'DeepSeek WebMCP' }, 'the toolbar icon opens the panel; no popup');
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(manifest.permissions.includes('webNavigation'), false);
  assert.equal(manifest.permissions.includes('tabs'), false);
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
