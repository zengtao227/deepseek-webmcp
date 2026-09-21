import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDeepSeek, waitFor } from './harness.mjs';
import { ask, overrideReportedVisibility, pageStatus, providerPage, toolPayload, turnDone } from './steps.mjs';

const env = await launchDeepSeek();
test.after(() => env.close());

let panel;
let provider;

const clicks = () => provider.evaluate(() => [...window.__mock.clicks]);
const session = async () => (await env.status(panel)).session;
const windowCount = () => env.worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).length);
const diagnosticsOf = (tabId) => env.worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `work.diagnostics.${tabId}`);
const waitPaused = () => waitFor(async () => (await panel.textContent('#state')) === 'Assistant paused', { message: 'the assistant to pause' });
const waitActive = () => waitFor(async () => (await panel.textContent('#state')) === 'DeepSeek Assistant', { message: 'the assistant to be active', timeout: 30_000 });

test('setup: the assistant is active and one answer is finished', async () => {
  ({ panel } = await env.startAssistant());
  provider = await providerPage(env);
  await ask(panel, provider, 'Say something', () => { window.__mock.replies.push({ html: '<p>First answer</p>' }); });
  await turnDone(panel, provider, 1);
});

// S8 — Regenerate and Share press DeepSeek's own control, only when exactly one control matches
test('S8: Regenerate presses exactly one control and the new answer replaces the old; Share presses exactly one and asks the owner to finish', async () => {
  assert.deepEqual(await clicks(), []);
  await provider.evaluate(() => { window.__mock.replies.push({ html: '<p>Second answer</p>' }); });
  await panel.click('#answer-actions button:has-text("Regenerate")');
  await waitFor(async () => (await panel.textContent('#answer')) === 'Second answer', { message: 'the regenerated answer', timeout: 20_000 });
  await waitFor(() => panel.locator('#answer-actions').isVisible(), { message: 'the actions after regenerating' });
  assert.deepEqual(await clicks(), ['regenerate'], 'exactly one control was pressed');

  await panel.click('#answer-actions button:has-text("Share")');
  await waitFor(async () => (await panel.textContent('#notice')).includes('Finish sharing'), { message: 'the share notice' });
  assert.deepEqual(await clicks(), ['regenerate', 'share']);
});

test('S8: a changed Share icon, or two Regenerate matches, press nothing and show a diagnostic', async () => {
  await provider.evaluate(() => { document.querySelector('[data-action=share] path').setAttribute('d', 'M0 0h1v1z'); });
  await panel.click('#answer-actions button:has-text("Share")');
  await waitFor(async () => (await panel.textContent('#notice')).includes('share control not found'), { message: 'the share failure notice' });
  assert.equal(await panel.locator('#diagnostic').isVisible(), true, 'the diagnostic is shown');
  assert.deepEqual(await clicks(), ['regenerate', 'share'], 'nothing was pressed');

  await provider.evaluate(() => {
    const regenerate = document.querySelector('[data-action=regenerate]');
    regenerate.after(regenerate.cloneNode(true));
  });
  await panel.click('#answer-actions button:has-text("Regenerate")');
  await waitFor(async () => (await panel.textContent('#notice')).includes('regenerate control not found'), { message: 'the regenerate failure notice' });
  assert.deepEqual(await clicks(), ['regenerate', 'share'], 'two matches: nothing was pressed');
});

// S10 — a hidden provider fails closed everywhere, including a tool call that completes while paused
test('S10: a hidden provider pauses the assistant with both windows described, refuses prompts, and a tool call that completes meanwhile is not run', async () => {
  await ask(panel, provider, 'Read the page', () => {
    const mock = window.__mock;
    mock.replies.push({ ...mock.toolCall('s10_1', 'inspect_page'), hold: true });
  });
  await waitFor(async () => (await provider.evaluate(() => window.__mock.received.length)) === 1, { message: 'the prompt to reach the mock' });

  // An override does not undo itself when the window gets focus, which is why the test removes it below.
  await overrideReportedVisibility(env, provider, 'hidden');
  await waitPaused();
  const paused = await session();
  assert.equal(paused.pauseCode, 'PROVIDER_HIDDEN');
  const notice = await panel.textContent('#notice');
  assert.ok(notice.includes('hidden'), notice);
  assert.match(notice, /\[work: .+; DeepSeek: .+\]/, 'both windows\' state is recorded for the next occurrence');
  assert.equal(await panel.locator('#restore').isVisible(), true);
  assert.equal(await panel.locator('#send').isDisabled(), true);
  const refused = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'assistant.prompt', text: 'more' }));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'ASSISTANT_NOT_ACTIVE');

  // The reply that was generating now completes with a tool call.
  await provider.evaluate(() => window.__mock.release());
  await waitFor(async () => (await diagnosticsOf(paused.providerTabId))?.lastCode === 'ASSISTANT_PAUSED', { message: 'the completion to be refused while paused' });
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    assert.equal((await provider.evaluate(() => window.__mock.received.length)), 1, 'no tool result was typed back');
    assert.equal((await pageStatus(panel)).task.mode, 'idle', 'no page was locked');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal((await session()).presentation.toolCount, 0, 'the tool never ran');
});

test('S10: with the override removed, Restore recovers', async () => {
  await overrideReportedVisibility(env, provider, null);
  await panel.click('#restore');
  await waitActive();
  assert.equal((await session()).pauseCode, null);
  assert.equal(await panel.locator('#restore').isHidden(), true);
});

// S9 — closing the provider pauses; Restore opens a new one and tools work again
test('S9: closing the provider window pauses the assistant and refuses prompts', async () => {
  const before = await session();
  await env.worker.evaluate((windowId) => chrome.windows.remove(windowId), before.providerWindowId);
  await waitPaused();
  const paused = await session();
  assert.equal(paused.pauseCode, 'PROVIDER_CLOSED');
  assert.equal(await panel.locator('#restore').isVisible(), true);
  assert.equal(await panel.locator('#send').isDisabled(), true);
  assert.equal((await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'assistant.prompt', text: 'hello' }))).error.code, 'ASSISTANT_NOT_ACTIVE');
  assert.equal((await env.providerPages()).length, 0);
});

test('S9: Restore opens a new provider window and re-arms the tools', async () => {
  const closed = await session();
  await panel.click('#restore');
  await waitActive();
  const restored = await session();
  assert.notEqual(restored.providerTabId, closed.providerTabId, 'a new provider tab');
  assert.equal((await env.providerPages()).length, 1);
  assert.equal(await windowCount(), 2, 'the work window and one provider window');

  provider = await providerPage(env);
  await ask(panel, provider, 'Read the page again', () => { const mock = window.__mock; mock.replies.push(() => mock.toolCall('s9_1', 'inspect_page')); });
  const received = await turnDone(panel, provider, 2);
  const payload = toolPayload(received[1]);
  assert.equal(payload.isError, false);
  assert.ok(JSON.stringify(payload.result).includes('Fixture Form'));
});
