import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PAGES, providerOf } from '../extension/panel-header.js';

// Owner decision 2026-09-26: a panel that never chose a provider opens ChatGPT, because opening
// DeepSeek first also opens its provider window.
test('every provider has its own panel page; nothing chosen yet (or anything unknown) opens ChatGPT', () => {
  assert.deepEqual(PROVIDER_PAGES, { deepseek: 'sidepanel.html', chatgpt: 'sidepanel-chatgpt.html' });
  assert.equal(providerOf('chatgpt'), 'chatgpt');
  assert.equal(providerOf('deepseek'), 'deepseek');
  assert.equal(providerOf(undefined), 'chatgpt');
  assert.equal(providerOf('toString'), 'chatgpt');
});

import { accessParts } from '../extension/panel-header.js';

const now = 1_000_000;
const text = (parts) => parts.map((part) => `${part.text}[${part.kind}]`).join(' · ');

test('Access line follows the header contract', () => {
  const base = { folder: '/Users/me/Doc/My code/webmcp-bridge', fullAccessUntil: null, hostAccessUntil: null, hostAccessState: 'inactive' };
  assert.equal(text(accessParts(base, now)), 'webmcp-bridge[mount] · WRITE[write]');
  assert.equal(text(accessParts({ ...base, fullAccessUntil: now + 27 * 60000 }, now)), 'Home[mount] · FULL ACCESS 27m[full]');
  assert.equal(text(accessParts({ ...base, fullAccessUntil: now + 27 * 60000, hostAccessState: 'active', hostAccessUntil: now + 12 * 60000 }, now)),
    'Home[mount] · FULL ACCESS 27m[full] · HOST ACCESS 12m[host]');
  assert.equal(text(accessParts({ ...base, hostAccessState: 'active', hostAccessUntil: now + 12 * 60000 }, now)),
    'webmcp-bridge[mount] · WRITE[write] · HOST ACCESS 12m[host]', 'Host access keeps the folder');
  assert.equal(text(accessParts({ ...base, hostAccessState: 'unverified' }, now)), 'webmcp-bridge[mount] · WRITE[write] · HOST ACCESS UNVERIFIED[host]');
  assert.equal(text(accessParts({ ...base, fullAccessUntil: now - 1, hostAccessState: 'active', hostAccessUntil: now - 1 }, now)),
    'webmcp-bridge[mount] · WRITE[write]', 'expired leases disappear');
  assert.equal(accessParts(null, now), null);
});
