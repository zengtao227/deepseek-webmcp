import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

// Decision 2026-09-21 (owner): like the ChatGPT Embedded Panel, the assistant works on whatever
// ordinary webpage is open next to the panel, so it needs host access to http(s) pages. Browsing
// history, cookies, network hooks and debugger access stay out; commit-like clicks stay with the owner.
test('page tools use http(s) host access, but no browsing, cookie, network or debugger permissions', () => {
  assert.deepEqual(manifest.host_permissions, ['https://chat.deepseek.com/*', 'https://chatgpt.com/*', 'http://*/*', 'https://*/*']);
  // declarativeNetRequestWithHostAccess (2026-09-25, ChatGPT inside the Side Panel): one session rule
  // removes X-Frame-Options/CSP only for chatgpt.com frames this extension loads (extension/frame-policy.js,
  // copied from the ChatGPT Embedded Panel). Nothing is observed, blocked or originated.
  assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging', 'scripting', 'sidePanel', 'declarativeNetRequestWithHostAccess']);
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.deepEqual(manifest.action, { default_title: 'WebMCP' }, 'the toolbar icon opens the panel; no popup');
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(manifest.permissions.includes('webNavigation'), false);
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.equal(JSON.stringify(manifest).includes('cookies'), false);
  assert.equal(JSON.stringify(manifest).includes('webRequest'), false);
  assert.equal(JSON.stringify(manifest).includes('debugger'), false);
});

// Web Provider Mode: ISOLATED content scripts per provider page. The only MAIN-world script is the
// ChatGPT Embedded Panel's model probe (copied unchanged) on chatgpt.com; DeepSeek pages get none.
test('providers are observed from ISOLATED content scripts; only the ChatGPT model probe runs in MAIN', () => {
  assert.deepEqual(manifest.content_scripts.map(({ matches, js, world }) => ({ matches, js, world })), [
    { matches: ['https://chat.deepseek.com/*'], js: ['content.js'], world: 'ISOLATED' },
    { matches: ['https://chat.deepseek.com/*'], js: ['deepseek-model.js'], world: 'ISOLATED' },
    { matches: ['https://chatgpt.com/*'], js: ['embedded-chatgpt.js'], world: 'ISOLATED' },
    { matches: ['https://chatgpt.com/*'], js: ['model-probe.js'], world: 'MAIN' },
    { matches: ['https://chatgpt.com/*'], js: ['content-chatgpt.js'], world: 'ISOLATED' },
  ]);
  const main = manifest.content_scripts.filter((script) => script.world === 'MAIN');
  assert.deepEqual(main.map((script) => script.matches), [['https://chatgpt.com/*']]);
});
