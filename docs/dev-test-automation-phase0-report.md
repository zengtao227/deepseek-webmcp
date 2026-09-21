# Phase 0 report — feasibility of browser-level E2E for the extension

Date: 2026-09-21. Throwaway spike in a temporary directory (nothing added to any repository except this report). Tools: `playwright-core` 1.63.0 with its matching Chromium 153.0.8010.12 (revision 1243), headless (new headless), one temp profile per run.

## Verdict per condition (from `dev-test-automation-plan.md`, phase 0)

| | Condition | Result |
|---|---|---|
| a | Extension loads in a persistent Chromium context; service worker reachable | **PASS** — worker up, extension id is the fixed `ekejcladpfhmaghllolijpiakhcffpmp` |
| b | Allowlist `context.route` serves the mock for windows created *by the extension* | **FAIL as planned.** The extension-created DeepSeek window loaded the **real** `https://chat.deepseek.com/` (CloudFront error page); the route did not see it and nothing was aborted. **Alternative evaluated and PASS:** browser-level host mapping (`--host-resolver-rules="MAP chat.deepseek.com 127.0.0.1:PORT, MAP fixture.test …, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`) + a local HTTPS server with a test certificate + `--ignore-certificate-errors`. The extension-created window received the mock, an external `fetch` failed, and the local server logged every request. This is browser-wide, stronger than a route. |
| c | Unmodified `sidepanel.js`, opened as a tab in the fixture's window, drives the assistant | **FAIL as planned.** `isSidePanel()` requires `!sender.tab`, so a panel opened as a tab has every message refused (`assistant.status` → `undefined`, state stays "Assistant not started"). **Alternative evaluated and PASS:** open the *real* Side Panel with `chrome.sidePanel.open({windowId})` from a click on an extension page (Playwright's click is a trusted user gesture; result `ok`), then reach the panel page through `--remote-debugging-port` + `chromium.connectOverCDP` (it is not in `context.pages()` of the persistent context). Works headless: viewport 360×585, the panel auto-started the assistant, bound the fixture's window, created the provider window on the mock, and `assistant.status` returned the session. No production change. |
| d | `window.open` / `target=_blank` gives `tabs.onCreated` with `openerTabId` | **PASS** — both the new tab and the popup report the clicked mail tab as opener |
| e | The owner's real native host is unreachable from the test profile, also after a restart | **PASS with two notes.** With a temporary `--user-data-dir`, `sendNativeMessage` fails with "Specified native messaging host not found." **Important:** the owner's install *did* register the real host for Chromium (`~/Library/Application Support/Chromium/NativeMessagingHosts/com.deepseek.webmcp.native.json`), so isolation depends on the temp profile and must be asserted (fail closed) at launch and after each test. Restart: `chrome.runtime.reload()` **unloads** a flag-loaded extension (`ERR_BLOCKED_BY_CLIENT`) and `ServiceWorker.stopAllWorkers` did not restart it, so a real worker restart is not automated; the S2 "session lost" case is simulated with `chrome.storage.session.clear()` (same state effect), and no native stub is needed. |
| f | `npm test` runs no browser; `npm run e2e` runs only E2E files | **PASS** (verified with a scratch project): bare `node --test` picks up `tests/e2e/*.e2e.test.js`, not `e2e/*.e2e.mjs`; `node --test e2e/*.e2e.mjs` runs only those |

## End-to-end loop proof (beyond the listed conditions)

With the mechanics above, against the **unmodified extension**: real Side Panel sends a prompt → the mock page receives it **with the tool contract** → the mock answers with an `inspect_page` call → the extension locks the **fixture page** (not the panel or provider tab) and runs the tool → the result, containing the fixture's title, is typed back and sent → the mock receives it. Task state afterwards: `locked` on the fixture. The only local requests were the fixture and the mock.

## What changes in the plan

1. Section 4, network policy: replace the Playwright route with browser-level host mapping to a local HTTPS server (deterministic, browser-wide, logged). The "route coverage" caveat disappears; the certificate flag is confined to the test browser.
2. Section 4, panel: not a tab. Use the real Side Panel opened from an extension-page click, driven over `connectOverCDP`. The launcher must add `--remote-debugging-port` (loopback, random free port).
3. Section 4, native: no stub; assert the real host is unreachable at launch and after each test.
4. S2: "session lost" is `storage.session.clear()`, not a worker restart.
5. Findings for Codex: `sender.tab` refusal (panel as a tab cannot work), the real host registered for Chromium, and Playwright removing an unused cached Chromium build (`chromium-1234`) during install.

## Side effects of the spike on the machine

- Downloaded Chromium 1243 and its headless shell (~200 MB) into `~/Library/Caches/ms-playwright`. `playwright-core install` also **removed the previously cached `chromium-1234` and `chromium_headless_shell-1234`**; other projects that use them will re-download.
- Temporary profiles under the system temp directory (`e2e-profile-*`); no stray browser processes were left.
