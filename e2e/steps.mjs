import { waitFor } from './harness.mjs';

/** The mock provider page (a single one is expected). */
export const providerPage = async (env) => (await env.providerPages())[0];

/** The page the assistant works on: fixture.test / mail.test tabs and windows, not the panel or DeepSeek. */
export const workPages = async (env) => (await env.allPages()).filter((page) => /^https:\/\/(fixture|mail)\.test/.test(page.url()));

export const pageStatus = (panel) => panel.evaluate(() => chrome.runtime.sendMessage({ type: 'assistant.page-status' }));

/**
 * Sends `prompt` from the real panel. `install(arg)` runs inside the mock DeepSeek page and queues the
 * scripted replies (see mock-deepseek.mjs); `received` is cleared first, so received[0] is this prompt
 * and received[n] is the n-th tool result the extension typed back.
 */
export async function ask(panel, provider, prompt, install, arg) {
  await provider.evaluate(() => { window.__mock.received.length = 0; });
  await provider.evaluate(install, arg);
  await panel.fill('#prompt', prompt);
  await panel.press('#prompt', 'Enter');
}

/** Waits until the mock received `count` messages and the final answer is shown with its actions. */
export async function turnDone(env, panel, provider, count) {
  await waitFor(async () => (await provider.evaluate(() => window.__mock.received.length)) >= count, { message: `${count} messages to reach the mock`, timeout: 30_000 });
  // The actions of an earlier answer can still be on screen, so the turn is only done when the provider has
  // stopped generating and the session says the answer is complete; a prompt sent earlier is refused.
  await waitFor(() => provider.evaluate(() => !document.querySelector('#send path').getAttribute('d').startsWith('M2 4')), { message: 'the mock to stop generating', timeout: 20_000 });
  await waitFor(async () => {
    const presentation = (await env.status(panel)).session?.presentation;
    return presentation?.completed === true && presentation.generating !== true;
  }, { message: 'the session to report the answer complete', timeout: 20_000 });
  await waitFor(() => panel.locator('#answer-actions').isVisible(), { message: 'the final answer with its actions', timeout: 20_000 });
  return provider.evaluate(() => [...window.__mock.received]);
}

/**
 * Opens `url` as the active tab of the panel's own window. `env.openPage` (a new Playwright page) can land in
 * the provider window instead, which then fails the "provider tab is selected" check for a reason that has
 * nothing to do with the product.
 */
export async function openInWorkWindow(env, panel, url) {
  const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  await env.worker.evaluate(({ windowId: id, url: target }) => chrome.tabs.create({ windowId: id, url: target, active: true }), { windowId, url });
  return waitFor(async () => (await env.allPages()).find((page) => page.url() === url), { message: `the tab ${url}` });
}

export const toolPayload = (text) => JSON.parse(text.split('\n')[1]);

/**
 * Makes the extension's content script in `page` report `document.visibilityState === state` (null undoes it).
 * Headless Chromium has no window occlusion to produce a real "hidden", and an override on the page's own
 * `document` is invisible to the content script (separate JavaScript world), so it is set in the extension's
 * isolated world over the debugging connection. Nothing in the extension changes; the override is the
 * test's stand-in for what macOS occlusion does to a real provider window.
 */
export async function overrideReportedVisibility(env, page, state) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
    await cdp.send('Runtime.enable');
    const world = worlds.find((context) => context.origin === `chrome-extension://${env.extensionId}`);
    if (!world) throw new Error('The extension\'s content-script world was not found in the provider page.');
    const expression = state === null
      ? 'delete document.visibilityState'
      : `Object.defineProperty(document, 'visibilityState', { get: () => ${JSON.stringify(state)}, configurable: true })`;
    const { exceptionDetails } = await cdp.send('Runtime.evaluate', { contextId: world.id, expression });
    if (exceptionDetails) throw new Error(`Visibility override failed: ${exceptionDetails.text}`);
  } finally {
    await cdp.detach();
  }
}
