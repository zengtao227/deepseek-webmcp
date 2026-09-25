import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PAGES, providerOf } from '../extension/panel-header.js';

test('every provider has its own panel page; anything unknown falls back to DeepSeek', () => {
  assert.deepEqual(PROVIDER_PAGES, { deepseek: 'sidepanel.html', chatgpt: 'sidepanel-chatgpt.html' });
  assert.equal(providerOf('chatgpt'), 'chatgpt');
  assert.equal(providerOf('deepseek'), 'deepseek');
  assert.equal(providerOf(undefined), 'deepseek');
  assert.equal(providerOf('toString'), 'deepseek');
});
