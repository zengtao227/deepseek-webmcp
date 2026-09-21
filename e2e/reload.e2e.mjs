import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDeepSeek, waitFor } from './harness.mjs';
import { ask, providerPage, turnDone } from './steps.mjs';

const env = await launchDeepSeek();
test.after(() => env.close());

const windowIds = () => env.worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).map((window) => window.id).sort());

// After an extension reload the open provider tab keeps only a dead copy of the content script. The panel
// has to bring it back by reloading that one tab, not by failing with "did not become ready" and not by
// opening a second DeepSeek window.
test('extension reload with the provider window open: reopening the panel recovers the same provider, no new window', async () => {
  const { work, panel } = await env.startAssistant();
  const before = (await env.status(panel)).session;
  const windowsBefore = await windowIds();
  assert.equal(windowsBefore.length, 2, 'the work window and the provider window');

  await env.reloadExtension();
  await panel.waitForEvent('close', { timeout: 10_000 }).catch(() => {});

  // The precondition this scenario exists for: the provider tab is still open but no longer answers.
  const answers = await env.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'assistant.health' }).then((reply) => reply?.ok === true, () => false), before.providerTabId);
  assert.equal(answers, false, 'the orphaned provider tab must not answer the new extension');
  assert.equal((await env.providerPages()).length, 1);

  const reopened = await env.openSidePanel(work);
  await waitFor(async () => (await reopened.textContent('#state')) === 'DeepSeek Assistant', { message: 'the assistant to become active again', timeout: 30_000 });
  assert.equal(await reopened.textContent('#notice'), '', 'no "did not become ready" failure');

  const after = (await env.status(reopened)).session;
  assert.equal(after.state, 'active');
  assert.equal(after.providerTabId, before.providerTabId, 'the same provider tab');
  assert.equal(after.providerWindowId, before.providerWindowId, 'the same provider window');
  assert.deepEqual(await windowIds(), windowsBefore, 'no new window was opened');
  assert.equal((await env.providerPages()).length, 1);

  // and it really works again: a prompt reaches the provider and the answer comes back
  const provider = await providerPage(env);
  await ask(reopened, provider, 'Are you back?', () => { window.__mock.replies.push({ html: '<p>Yes.</p>' }); });
  const received = await turnDone(env, reopened, provider, 1);
  assert.ok(received[0].startsWith('Are you back?'));
  assert.equal(await reopened.locator('#answer').textContent(), 'Yes.');
});
