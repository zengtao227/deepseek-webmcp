import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDeepSeek, waitFor } from './harness.mjs';
import { ask, openInWorkWindow, pageStatus, providerPage, toolPayload, turnDone, workPages } from './steps.mjs';

const env = await launchDeepSeek();
test.after(() => env.close());

let work;
let panel;
let provider;

test('setup: the assistant is active on the fixture form', async () => {
  ({ work, panel } = await env.startAssistant(env.fixtureUrl('/form')));
  provider = await providerPage(env);
});

// S4 — page read: the first browser tool call locks the page that is open; the result holds what is on it
test('S4: inspect_page locks the open page and the result typed back holds its title and text, with the password redacted', async () => {
  await ask(panel, provider, 'What is on this page?', () => {
    const mock = window.__mock;
    mock.replies.push(() => mock.toolCall('s4_1', 'inspect_page'));
  });
  const received = await turnDone(panel, provider, 2);
  assert.ok(received[1].startsWith('DeepSeek WebMCP tool result.'));
  const payload = toolPayload(received[1]);
  assert.equal(payload.isError, false);
  const shown = JSON.stringify(payload.result);
  assert.ok(shown.includes('Fixture Form'), 'the page title');
  assert.ok(shown.includes('Employee Travel Claim'), 'the page text');
  assert.ok(!received[1].includes('fixture-secret'), 'a password value never leaves the page');

  const status = await pageStatus(panel);
  assert.equal(status.task.mode, 'locked');
  assert.equal(status.task.target.title, 'Fixture Form');
  await waitFor(async () => (await panel.textContent('#target')).startsWith('Working on: Fixture Form'), { message: 'the panel to show the locked page' });
});

// S5 — fill and select change the page; a Submit click is never executed (owner rule)
test('S5: fill and select change the form; clicking Submit returns CONFIRMATION_REQUIRED and submits nothing', async () => {
  await ask(panel, provider, 'Fill in the claim for Ada, Switzerland, and submit it', () => {
    const mock = window.__mock;
    const refOf = (text, name) => mock.resultOf(text).result.controls.find((control) => control.name === name).ref;
    mock.replies.push(() => mock.toolCall('s5_1', 'inspect_form'));
    mock.replies.push((text) => {
      mock.refs = { name: refOf(text, 'Employee name'), country: refOf(text, 'Country'), submit: refOf(text, 'Submit') };
      return mock.toolCall('s5_2', 'fill', { ref: mock.refs.name, value: 'Ada Lovelace' });
    });
    mock.replies.push(() => mock.toolCall('s5_3', 'select', { ref: mock.refs.country, value: 'CH' }));
    mock.replies.push(() => mock.toolCall('s5_4', 'click', { ref: mock.refs.submit }));
  });
  const received = await turnDone(panel, provider, 5);
  const [, filled, selected, clicked] = received.slice(1).map(toolPayload);
  assert.equal(filled.isError, false);
  assert.equal(selected.isError, false);
  assert.equal(clicked.isError, true);
  assert.equal(clicked.error.code, 'CONFIRMATION_REQUIRED');

  const [fixture] = await workPages(env);
  assert.equal(await fixture.inputValue('[name=name]'), 'Ada Lovelace');
  assert.equal(await fixture.inputValue('[name=country]'), 'CH');
  assert.equal(await fixture.title(), 'Fixture Form', 'the form was not submitted (a submit would set the title to SUBMITTED)');
});

// S7 — Stop releases the page; the model is told once; the next page action locks whatever is open now
test('S7: Stop releases the page, the next prompt says so once, and the next page action locks the page that is open now', async () => {
  assert.equal((await pageStatus(panel)).task.mode, 'locked');
  await panel.click('#stop');
  await waitFor(async () => (await pageStatus(panel)).task.mode === 'idle', { message: 'the task to be idle after Stop' });
  assert.equal(await panel.locator('#stop').isHidden(), true, 'no Stop button while nothing is locked');

  const second = await openInWorkWindow(env, panel, env.fixtureUrl('/second'));
  const inspect = () => { const mock = window.__mock; mock.replies.push(() => mock.toolCall('s7_read', 'inspect_page')); };

  await ask(panel, provider, 'Now read this page', inspect);
  const first = await turnDone(panel, provider, 2);
  assert.ok(first[0].includes('the owner pressed Stop'), 'the first prompt after Stop carries the released note');
  const payload = toolPayload(first[1]);
  assert.equal(payload.isError, false);
  assert.ok(JSON.stringify(payload.result).includes('Fixture Second Page'), 'the page that is open now was read, not the old form');
  assert.ok(!JSON.stringify(payload.result).includes('Employee Travel Claim'));
  const status = await pageStatus(panel);
  assert.equal(status.task.mode, 'locked');
  assert.equal(status.task.target.title, 'Fixture Second Page');

  await ask(panel, provider, 'And once more', () => {});
  const later = await turnDone(panel, provider, 1);
  assert.ok(!later[0].includes('the owner pressed Stop'), 'the note is sent once, not on every prompt');
  await second.close();
});
