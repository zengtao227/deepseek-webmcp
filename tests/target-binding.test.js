import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachablePageUrl,
  blockedTask,
  buildAttachedPage,
  claimHandoff,
  createHandoff,
  idleTask,
  lockedTask,
  normalizeTask,
} from '../extension/target-binding.js';

test('page candidates accept only normal http(s) pages and exclude DeepSeek itself', () => {
  assert.equal(attachablePageUrl('chrome://extensions'), null);
  assert.equal(attachablePageUrl('https://chat.deepseek.com/a/chat/s/abc'), null);
  assert.equal(attachablePageUrl('https://example.com/path')?.origin, 'https://example.com');
});

test('page candidate contains only browser-owned identity and bounded display metadata', () => {
  assert.deepEqual(buildAttachedPage({
    id: 42,
    url: 'https://example.com/a',
    title: '  Example   Page  ',
  }), {
    tabId: 42,
    origin: 'https://example.com',
    title: 'Example Page',
  });
});

test('task state starts locked with an empty parent stack and no handoff', () => {
  const target = buildAttachedPage({ id: 42, url: 'https://example.com/a', title: 'Example' });
  assert.deepEqual(idleTask(), { mode: 'idle', target: null, reason: null });
  assert.deepEqual(lockedTask(target), {
    mode: 'locked',
    target,
    reason: null,
    parents: [],
    handoff: null,
  });
});

test('handoff lease is bound to the currently locked source tab', () => {
  const target = buildAttachedPage({ id: 42, url: 'https://example.com/a', title: 'Example' });
  const lease = createHandoff(target, 1234);
  assert.deepEqual(lease, {
    sourceTabId: 42,
    issuedAt: 1234,
    destinationTabId: null,
    destinationUrl: null,
  });

  const task = lockedTask(target, { handoff: lease });
  assert.deepEqual(task.handoff, lease);
});

test('claimed handoff records the causally-created destination without changing the source yet', () => {
  const target = buildAttachedPage({ id: 42, url: 'https://example.com/a', title: 'Example' });
  const lease = createHandoff(target, 1234);
  const claimed = claimHandoff(lease, 77, 'https://other.example/path');

  assert.deepEqual(claimed, {
    sourceTabId: 42,
    issuedAt: 1234,
    destinationTabId: 77,
    destinationUrl: 'https://other.example/path',
  });

  const task = lockedTask(target, { handoff: claimed });
  assert.equal(task.target.tabId, 42);
  assert.equal(task.handoff.destinationTabId, 77);
});

test('locked task preserves a bounded parent stack for child-page return', () => {
  const root = buildAttachedPage({ id: 1, url: 'https://root.example', title: 'Root' });
  const child = buildAttachedPage({ id: 2, url: 'https://child.example', title: 'Child' });
  const task = lockedTask(child, { parents: [root] });

  assert.deepEqual(task.parents, [root]);
  assert.equal(task.target.tabId, 2);
});

test('blocked task keeps parents but clears handoff authority', () => {
  const root = buildAttachedPage({ id: 1, url: 'https://root.example', title: 'Root' });
  const child = buildAttachedPage({ id: 2, url: 'https://child.example', title: 'Child' });
  const lease = createHandoff(child, 1234);
  const task = blockedTask(child, 'ORIGIN_CHANGED', { parents: [root], handoff: lease });

  assert.deepEqual(task, {
    mode: 'blocked',
    target: child,
    reason: 'ORIGIN_CHANGED',
    parents: [root],
    handoff: null,
  });
});

test('stored legacy locked task normalizes into the new session shape', () => {
  const target = buildAttachedPage({ id: 42, url: 'https://example.com/a', title: 'Example' });
  assert.deepEqual(normalizeTask({
    mode: 'locked',
    target,
    reason: null,
  }), lockedTask(target));
});

test('stored task state fails closed to idle when malformed', () => {
  assert.deepEqual(normalizeTask(null), idleTask());
  assert.deepEqual(normalizeTask({ mode: 'locked', target: { tabId: '42' } }), idleTask());

  const target = buildAttachedPage({ id: 42, url: 'https://example.com/a', title: 'Example' });
  assert.deepEqual(
    normalizeTask({ mode: 'blocked', target, reason: 'TAB_CLOSED', parents: [] }),
    blockedTask(target, 'TAB_CLOSED'),
  );
});
