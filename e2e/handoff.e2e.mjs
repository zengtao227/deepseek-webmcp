import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDeepSeek, waitFor } from './harness.mjs';
import { ask, openInWorkWindow, pageStatus, providerPage, toolPayload, turnDone } from './steps.mjs';

const env = await launchDeepSeek();
test.after(() => env.close());

let mail;
let panel;
let provider;

// A turn that reads the page, clicks the control named `name`, then reads whatever page the task is on.
// Tool-call ids are unique per conversation (a repeated id is rejected as DUPLICATE_CALL), hence `id`.
const readClickRead = (panelPage, prompt, id, name) => ask(panelPage, provider, prompt, ({ id: prefix, name: clickName }) => {
  const mock = window.__mock;
  mock.replies.push(() => mock.toolCall(`${prefix}_1`, 'inspect_page'));
  mock.replies.push((text) => {
    const found = mock.resultOf(text).result.elements.find((element) => element.name === clickName);
    return mock.toolCall(`${prefix}_2`, 'click', { ref: found.ref });
  });
  mock.replies.push(() => mock.toolCall(`${prefix}_3`, 'inspect_page'));
}, { id, name });

const titleOf = (text) => toolPayload(text).result.title;
const currentTitle = async () => (await pageStatus(panel)).task.target?.title;
const stop = async () => {
  await panel.click('#stop');
  await waitFor(async () => (await pageStatus(panel)).task.mode === 'idle', { message: 'the task to be released' });
};

test('setup: the assistant is active on the fixture mail page', async () => {
  ({ work: mail, panel } = await env.startAssistant(env.fixtureUrl('/mail', 'mail.test')));
  provider = await providerPage(env);
});

// S6 — a click that opens a page hands the task over to it, but only that page
test('S6a: Reply that opens a new tab: the task follows the new tab, and closing it returns to the mail page', async () => {
  await readClickRead(panel, 'Reply to this mail', 'newtab', 'Reply (new tab)');
  const received = await turnDone(panel, provider, 4);
  assert.equal(titleOf(received[1]), 'Fixture Mail');
  assert.equal(toolPayload(received[2]).isError, false, 'the safe Reply click was executed');
  assert.equal(titleOf(received[3]), 'Fixture Compose', 'the task follows the tab the click opened');
  assert.equal(await currentTitle(), 'Fixture Compose');

  const compose = (await env.allPages()).find((page) => page.url().endsWith('/popup'));
  await compose.close();
  await waitFor(async () => (await currentTitle()) === 'Fixture Mail', { message: 'the task to return to the mail page' });
  assert.equal((await pageStatus(panel)).task.mode, 'locked');
});

test('S6b: an unrelated tab that no click opened is never adopted', async () => {
  const unrelated = await openInWorkWindow(env, panel, env.fixtureUrl('/second'));
  await ask(panel, provider, 'Read the page again', () => {
    const mock = window.__mock;
    mock.replies.push(() => mock.toolCall('u_1', 'inspect_page'));
  });
  const received = await turnDone(panel, provider, 2);
  assert.equal(titleOf(received[1]), 'Fixture Mail', 'the task stays on the page it is locked to');
  await unrelated.close();
  await mail.bringToFront();
});

test('S6c: Reply that opens a popup window: the task follows it, and closing it returns to the mail page', async () => {
  await readClickRead(panel, 'Reply in a popup', 'popup', 'Reply (popup)');
  const received = await turnDone(panel, provider, 4);
  assert.equal(toolPayload(received[2]).isError, false);
  assert.equal(titleOf(received[3]), 'Fixture Compose');

  const popup = (await env.allPages()).find((page) => page.url().endsWith('/popup'));
  await popup.close();
  await waitFor(async () => (await currentTitle()) === 'Fixture Mail', { message: 'the task to return to the mail page' });
});

test('S6d: a same-tab navigation is followed (there is no child to close, so no return is asserted)', async () => {
  await readClickRead(panel, 'Open the message', 'sametab', 'Open message (same tab)');
  const received = await turnDone(panel, provider, 4);
  assert.equal(toolPayload(received[2]).isError, false);
  assert.equal(titleOf(received[3]), 'Fixture Second Page');
  assert.equal(await currentTitle(), 'Fixture Second Page');
  await stop();
});
