import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

// The Browser Execution Plane (docs/browser-webmcp-platform-roadmap.md in the ChatGPT Embedded Panel
// project) is shared by every model provider:
//   task target / handoff state -> runBrowserTool() -> browser-client.js -> target-executor.js
// These files are the same code in both projects, so that merging them later is a move, not a
// reconciliation. Changing one deliberately means changing both projects and these pins together.
const PINNED = {
  'browser-client.js': '6d089ca49c78ae37b5f9f3b0ed2553e977d11f45d446922ea09b42013548ecf8',
  'target-executor.js': '8623b84ecc137eeb9ab91bb19d604be3945d8d8c9fc9b192bfceae3d33054306',
};
// target-binding.js differs only in the one origin it must never attach (the provider's own site).
const BINDING_NORMALIZED = '53f5cdda29dfcfb7e6ff96f915056e0dad20eac4c93c07c348f27ae1b19758f5';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the execution-plane files are pinned to the shared version', async () => {
  for (const file of ['browser-client.js', 'target-executor.js']) {
    assert.equal(sha(await read(`../extension/${file}`)), PINNED[file], `${file} no longer matches the shared Browser Execution Plane`);
  }
  const binding = (await read('../extension/target-binding.js')).replaceAll('https://chat.deepseek.com', '<PROVIDER_ORIGIN>');
  assert.equal(sha(binding), BINDING_NORMALIZED, 'target-binding.js changed beyond the provider origin');
});

test('when the ChatGPT Embedded Panel project is beside this one, its copies are identical', async () => {
  const sibling = new URL('../../chatgpt-embedded-panel/', import.meta.url);
  if (!existsSync(new URL('target-executor.js', sibling))) return;

  for (const file of ['browser-client.js', 'target-executor.js']) {
    assert.equal(await readFile(new URL(file, sibling), 'utf8'), await read(`../extension/${file}`), `${file} differs from chatgpt-embedded-panel`);
  }
  assert.equal(
    (await readFile(new URL('target-binding.js', sibling), 'utf8')).replaceAll('https://chatgpt.com', '<PROVIDER_ORIGIN>'),
    (await read('../extension/target-binding.js')).replaceAll('https://chat.deepseek.com', '<PROVIDER_ORIGIN>'),
    'target-binding.js differs from chatgpt-embedded-panel beyond the provider origin',
  );
});

test('the task and handoff logic is a provider-neutral module; only the active page is injected', async () => {
  const task = await read('../extension/browser-task.js');
  assert.match(task, /export function createBrowserTask\(\{ activeTab \}\)/);
  assert.doesNotMatch(task, /deepseek/i);
  assert.doesNotMatch(task, /assistantSession|providerTabId|chat\.deepseek/);
});
