import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension, waitFor } from 'browser-webmcp-e2e';
import { mockDeepSeek } from './mock-deepseek.mjs';

export const EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const DEEPSEEK = 'https://chat.deepseek.com';

export async function launchDeepSeek({ hosts = {} } = {}) {
  const env = await launchExtension({
    extensionPath: EXTENSION,
    hosts: { 'chat.deepseek.com': mockDeepSeek, ...hosts },
    nativeHostNames: ['com.deepseek.webmcp.native'],
  });

  /** The work page and the real Side Panel; resolves once the assistant is active. */
  env.startAssistant = async (url = env.fixtureUrl('/form')) => {
    const work = await env.openPage(url);
    const panel = await env.openSidePanel(work);
    await waitFor(async () => (await panel.textContent('#state')) === 'DeepSeek Assistant', { message: 'the assistant to become active', timeout: 20_000 });
    return { work, panel };
  };

  env.providerPages = async () => (await env.allPages()).filter((page) => page.url().startsWith(DEEPSEEK));
  env.status = (panel) => panel.evaluate(() => chrome.runtime.sendMessage({ type: 'assistant.status' }));
  env.ensure = (panel) => panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'assistant.ensure', windowId: (await chrome.windows.getCurrent()).id }));
  env.mock = async (provider, script) => provider.evaluate(script);
  return env;
}

export { waitFor };
