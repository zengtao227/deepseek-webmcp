// The Provider selector at the top of every WebMCP Side Panel page (Unified Side Panel, U1).
// Each provider has its own page; choosing a provider opens that page in the panel.
export const PROVIDER_KEY = 'provider.id';
export const PROVIDER_PAGES = Object.freeze({ deepseek: 'sidepanel.html', chatgpt: 'sidepanel-chatgpt.html' });

export function providerOf(stored) {
  return Object.hasOwn(PROVIDER_PAGES, stored) ? stored : 'deepseek';
}

// Opens the selected provider's page when this page is not it. Resolves only when this page stays.
export async function routeToProviderPage(page) {
  const provider = providerOf((await chrome.storage.local.get(PROVIDER_KEY))[PROVIDER_KEY]);
  if (PROVIDER_PAGES[provider] === page) return provider;
  location.replace(PROVIDER_PAGES[provider]);
  return new Promise(() => {});
}

export function mountProviderSelect(select, provider) {
  select.value = provider;
  select.addEventListener('change', async () => {
    const next = providerOf(select.value);
    await chrome.storage.local.set({ [PROVIDER_KEY]: next });
    location.replace(PROVIDER_PAGES[next]);
  });
}
