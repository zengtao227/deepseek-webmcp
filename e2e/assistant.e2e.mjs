import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDeepSeek, waitFor } from './harness.mjs';

const env = await launchDeepSeek();
test.after(() => env.close());

const mockHits = () => env.requests.filter((r) => r.host === 'chat.deepseek.com' && r.path === '/').length;
let panel;
let firstProviderTabId;

// S1 — boot: opening the real Side Panel starts the assistant for its window
test('S1: the panel starts the assistant and creates exactly one provider window', async () => {
  ({ panel } = await env.startAssistant());
  assert.equal((await env.providerPages()).length, 1);
  const status = await env.status(panel);
  assert.equal(status.session.state, 'active');
  assert.equal(status.health.ok, true);
  firstProviderTabId = status.session.providerTabId;
  assert.equal(mockHits(), 1, 'the mock page was requested once');
});

// S2 — reuse
test('S2: opening again, and again after the session is lost, finds the same provider', async () => {
  const again = await env.ensure(panel);
  assert.equal(again.ok, true);
  assert.equal(again.session.providerTabId, firstProviderTabId);
  assert.equal((await env.providerPages()).length, 1);
  assert.equal(mockHits(), 1);

  // Session storage is what a browser restart loses. (A service-worker restart is a different case and is not covered here.)
  await env.worker.evaluate(() => chrome.storage.session.clear());
  assert.equal((await env.status(panel)).session, null);
  const restored = await env.ensure(panel);
  assert.equal(restored.ok, true);
  assert.equal(restored.session.providerTabId, firstProviderTabId, 'the remembered provider is reused');
  assert.equal((await env.providerPages()).length, 1, 'no second provider window');
  assert.equal(mockHits(), 1);
});

// S3 — prompt to answer, including the known regression: the composer keeps its text after Send
const RICH = `<h2>Plan</h2>
<p>Use <strong>bold</strong> and <code>x = 1</code>, see <a href="https://example.com/docs">docs</a>.</p>
<ul><li>one</li><li>two</li></ul>
<div class="md-code-block"><div class="md-code-block-banner"><span>python</span><button>Copy</button></div><pre>print(1)</pre></div>
<table><tr><th>Name</th></tr><tr><td>pen</td></tr></table>`;

test('S3: prompt reaches DeepSeek with the tool contract; a kept composer text is not a failed send; the answer is rendered as structure', async () => {
  const provider = (await env.providerPages())[0];
  await provider.evaluate((html) => {
    window.__mock.keepComposerText = true;
    window.__mock.replies.push({ reasoning: 'Thinking about the plan', partialHtml: '<p>Working…</p>', html, hold: true });
  }, RICH);

  await panel.fill('#prompt', 'Explain the plan');
  await panel.press('#prompt', 'Enter');

  await waitFor(async () => (await provider.evaluate(() => window.__mock.received.length)) === 1, { message: 'the prompt to reach the mock' });
  const received = await provider.evaluate(() => window.__mock.received[0]);
  assert.ok(received.startsWith('Explain the plan'));
  assert.ok(received.includes('You can use owner-approved tools'), 'the first prompt carries the tool contract');
  assert.notEqual(await provider.evaluate(() => document.querySelector('textarea').value), '', 'the mock kept the composer text, as real DeepSeek did');

  await waitFor(async () => (await panel.locator('#history .bubble.user').count()) === 1, { message: 'the prompt in history' });
  await waitFor(async () => (await panel.textContent('#notice')) === '', { message: 'no failure notice' });
  // The old check waited 5 s for the composer to empty and then reported the send as failed, withdrawing the
  // prompt. Absence of that failure has to be observed for longer than the wait (5 s) itself.
  const until = Date.now() + 6_500;
  while (Date.now() < until) {
    assert.equal(await panel.locator('#history .bubble.user').count(), 1, 'the prompt stays in history while DeepSeek generates');
    assert.equal(await panel.textContent('#notice'), '', 'no failure notice while DeepSeek generates');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await waitFor(async () => (await panel.textContent('#reasoning')).includes('Thinking about the plan'), { message: 'the reasoning' });
  assert.equal(await panel.locator('#answer-actions').isVisible(), false, 'no actions while generating');

  await provider.evaluate(() => window.__mock.release());
  await waitFor(() => panel.locator('#answer-actions').isVisible(), { message: 'the actions after the answer finished', timeout: 20_000 });

  assert.equal(await panel.locator('#answer').evaluate((node) => node.classList.contains('rich')), true);
  for (const selector of ['h2', 'strong', 'code', 'ul li', 'pre', 'table th', 'a[href="https://example.com/docs"]']) {
    assert.ok((await panel.locator(`#answer ${selector}`).count()) > 0, `#answer ${selector}`);
  }
  assert.equal(await panel.locator('#answer pre').textContent(), 'print(1)', 'the code block has no banner text');
  const buttons = await panel.locator('#answer-actions button').allTextContents();
  assert.deepEqual(buttons, ['Copy', 'Regenerate', 'Share']);

  const hosts = new Set(env.requests.map((r) => r.host));
  assert.deepEqual([...hosts].sort(), ['chat.deepseek.com', 'fixture.test'], 'only the mock and the fixture were requested');
});

// S3b — a reply that starts and ends between two timer ticks (a short tool-call reply) must still be processed.
// Found by this suite: it used to be reported as a history replay and ignored, so the tool never ran.
test('S3b: a very short tool-call reply is processed and its result goes back to DeepSeek', async () => {
  const provider = (await env.providerPages())[0];
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'assistant.stop' }));
  await provider.evaluate(() => {
    window.__mock.received.length = 0;
    window.__mock.replies.push({ html: '<div class="md-code-block"><pre>&lt;webmcp_tool_call&gt;{"id":"short_1","name":"inspect_page","arguments":{}}&lt;/webmcp_tool_call&gt;</pre></div>', delayMs: 60 });
    window.__mock.replies.push({ html: '<p>Done.</p>', delayMs: 60 });
  });
  const fixturePage = (await env.context.pages()).find((page) => page.url().startsWith('https://fixture.test'));
  await fixturePage.bringToFront();

  await panel.fill('#prompt', 'Read the page');
  await panel.press('#prompt', 'Enter');
  await waitFor(async () => (await provider.evaluate(() => window.__mock.received.length)) >= 2, { message: 'the tool result to come back to the mock', timeout: 30_000 });
  const result = await provider.evaluate(() => window.__mock.received[1]);
  assert.ok(result.includes('WebMCP tool result'), 'the second message is the tool result');
  assert.ok(result.includes('Fixture Form'), 'it holds the fixture page that was read');
});
