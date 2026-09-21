# Dev-side end-to-end test automation — plan for review

Status: **PLAN ONLY. No code written.** Written 2026-09-21 for review by Codex before any work starts.
Owner request: "if you (Claude) can run the tests yourself, that is best" — testing by hand has been the main cost of every change so far. Also: "do not build something over-designed that we later have to re-integrate."

## 0. What reviewers should challenge

1. Is a **mock DeepSeek page served under the real origin** the right level, or is that already too much?
2. Is **Playwright** the smallest tool, or is raw CDP / puppeteer-core smaller for this?
3. Anything here that is not justified by a bug we actually had (section 3)? Cut it.
4. Should `npm run e2e` stay **outside** `npm run check`?
5. Does the harness stay reusable for the ChatGPT Embedded Panel later (Browser WebMCP core), without being built as a framework now?

## 1. Requirements (from the owner, this project's sessions)

R1. Claude can run the important checks without the owner clicking through Chrome.
R2. Nothing runs against the owner's real Chrome profile, logins, DeepSeek account or files.
R3. No page content, tokens, cookies or credentials go to any model as a side effect of testing. (The owner declined giving DeepSeek network/debug permissions for this reason. **No extension permission is added for testing.**)
R4. Consistent with the Browser WebMCP roadmap: the execution plane (`browser-client.js`, `target-executor.js`, `target-binding.js`, `browser-task.js`) is shared with the ChatGPT Embedded Panel; tests must not fork it.
R5. No over-design: no framework, no page-object layers, no record/replay, no visual regression, no CI service, no cross-browser matrix.
R6. No production code changes made only to help tests. If one seems necessary, it is reported as a finding and decided separately.

## 2. Where the current safety net has holes

`npm run check` = lint + 223 unit tests with a **fake `chrome` API**. That is fast and useful, but every bug found live this month sat in a seam the fake cannot model:

| Live bug (2026-09-20/21) | Why the fake could not catch it |
|---|---|
| Fresh provider window reported `visibilityState: hidden` | needs real windows and a real page |
| Prompt accepted by DeepSeek but panel said "not accepted" | needs the real page DOM contract (composer/send/route behaviour) |
| Regenerate/Share buttons not found (icon-only, no role) | needs the real action-bar DOM shape |
| Task must follow a click that opens a popup/new tab (email) | needs real `tabs.onCreated` with `openerTabId`, real `window.open` |
| Reading a page after Stop still used the old page | needs the full loop: panel → provider page → tool → page |
| Executor could not read the open page | needs real content-script injection (`scripting.executeScript`) |

So the value of E2E is **the integration seams**: real tabs/windows events, real content-script injection (isolated world), real extension-page messaging, real service-worker lifecycle. It is not a replacement for the unit tests and does not duplicate them.

## 3. Scope: scenarios, each tied to a bug or a rule

Priority order. Each scenario states what must be observable.

| # | Scenario | Pass condition |
|---|---|---|
| S1 | Boot | extension loads; service worker is up; `assistant.ensure` (sent from the panel page) creates exactly one provider window on the mock DeepSeek; panel shows an active assistant |
| S2 | Reuse | a second `ensure` creates no window; after the session is lost and the worker restarted, the remembered provider is found, not duplicated |
| S3 | Prompt → answer | panel prompt reaches the mock's composer with the tool contract on the first prompt; mock streams reasoning + answer; panel renders the block structure (heading, list, code, table, link) and Copy/Regenerate/Share appear only when finished |
| S4 | Page read | mock replies with an `inspect_page` call; the fixture page in the work window is locked; the result typed back into the mock contains the page's title/text |
| S5 | Fill, but never submit | `fill`/`select` change the fixture form; a `click` on Submit/Send returns `CONFIRMATION_REQUIRED` and changes nothing (owner rule) |
| S6 | Email handoff | fixture "mail" page: Reply opens a popup / new tab / same-tab navigation; the task follows it (opener + lease); closing it returns to the parent; an unrelated tab is never adopted |
| S7 | Stop semantics | after Stop the task is idle; the next prompt carries the "page released" note once; the next page action locks the page now open |
| S8 | Regenerate / Share | mock action bar with the real icon shapes: exactly one control matched, click observed by the mock; changed/duplicated icon → diagnostic, no click |
| S9 | Provider lifecycle | close provider → session paused, tools refused; Restore re-arms |
| S10 | Visibility fail-closed | mock forces `visibilityState = hidden` → `PROVIDER_HIDDEN`, message includes both windows' state; after a real focus it recovers |

Not in scope (see section 6): real DeepSeek, real macOS occlusion, toolbar-icon click, macOS dialogs, real Docker/native runtime (already covered by `native-*.test.js`; the native call is stubbed in E2E).

## 4. Design (deliberately small)

```text
tests/e2e/
  launch.js          ~1 file: start Chromium with the extension in a temp profile, return { context, worker, extensionId }
  mock-deepseek.html one page + small script: the DeepSeek DOM contract, driven by the test
  fixtures/          form.html, mail.html (Reply opens popup / new tab / same-tab nav), second.html
  *.e2e.test.js      one file per group of scenarios, node:test
```

Mechanics (each to be proven in phase 0, not assumed):

- **Extension loads** in Playwright's Chromium, headed or new-headless, from `extension/`. The manifest `key` gives the fixed id `ekejcladpfhmaghllolijpiakhcffpmp`, so the panel URL is known: `chrome-extension://<id>/sidepanel.html`.
- **Mock DeepSeek under the real origin.** The extension hard-codes `https://chat.deepseek.com` (content-script match, origin checks). `context.route('https://chat.deepseek.com/**', …)` returns the mock HTML, so no production code changes and no real network. The mock implements exactly what `content.js` reads: `textarea[placeholder]`, the circular send/stop control (Stop icon path prefix `M2 4.88`, disabled class `ds-button--disabled`), `.ds-markdown.ds-assistant-message-main-content`, `.ds-think-content`, `.ds-message`, `.md-code-block > pre`, and the six-button action bar with the two recorded icon paths. The test decides what the "model" answers (including `<webmcp_tool_call>` blocks).
- **Panel without a click.** `chrome.sidePanel.open()` needs a user gesture and cannot be automated. The panel page (`sidepanel.html`) is an ordinary extension page: open it in a tab of its own window and drive it with `page.evaluate(() => chrome.runtime.sendMessage({ type: 'assistant.ensure', windowId }))` using the id of the *work* window. This exercises the same background code path the real panel uses.
- **Native runtime stubbed** by overriding `chrome.runtime.sendNativeMessage` in the service worker (`worker.evaluate`). No Docker, no native host, no folder dialog.
- **Waiting by events, never by sleeps.** Poll the observable state (task mode, mock received text, panel DOM) with a timeout.
- **Dependency:** `playwright-core` as a **dev dependency only** (the project has none today). Pin it to a release whose Chromium build is already in `~/Library/Caches/ms-playwright` (`chromium-1223`, `chromium-1234`, `chromium_headless_shell-1234` are present) so nothing large is downloaded. The owner's Chrome 153 is not used (see risks).

## 5. Phases and acceptance

**Phase 0 — feasibility spike (go/no-go, small).** One throwaway script proving:
(a) extension loads and the service worker is reachable;
(b) `context.route` serves the mock for windows created *by the extension* and the content script injects;
(c) the panel page can be opened in a tab and messages reach the background;
(d) `window.open` from a fixture yields a `tabs.onCreated` with `openerTabId`.
Stop and report if (b) or (d) fails; fallbacks are listed in section 7. Nothing is added to the repo except the report.

**Phase 1 — harness + S1, S2, S3.** Acceptance: `npm run e2e` passes on a clean checkout; run time under ~60 s; leaves no processes or temp profiles behind.

**Phase 2 — S4–S7** (the page tools, the owner rules, email handoff, Stop).

**Phase 3 — S8–S10.**

**Phase 4 — mutation proof.** For each scenario, break the matching production behaviour once and confirm the scenario fails (same discipline as the unit tests), then restore.

Each phase ends with `npm run check` green and a short note in `docs/`. Stop when the acceptance is met; do not add scenarios "because they are easy".

## 6. What stays manual (shrinks to a short list)

| Item | Why it cannot be automated |
|---|---|
| Real DeepSeek behaviour (login, provider challenge, real DOM drift) | needs the owner's account; the iframe experiment already showed the challenge; credentials are never entered by tools |
| Toolbar icon opens the panel; `sidePanel.open` | needs a real user gesture |
| macOS folder dialog, Full-access dialog, Uninstall dialog | native dialogs |
| Whether a fully covered provider window turns `hidden` | depends on the owner's macOS/Chrome (full-screen Spaces, occlusion); the new `PROVIDER_HIDDEN` message records both windows' state to explain it |
| Real Docker/native runtime on the owner's folder | covered by `native-*.test.js` + `npm run doctor`; not repeated in E2E |

Optional, only if wanted later: read-only checks on real pages through the existing Chrome tools. Not part of this plan.

## 7. Risks and how the plan limits them

- **Mock drift** (the mock passes while real DeepSeek changed). Mitigation: keep the mock's contract to the selectors `content.js` actually uses, add one unit test that asserts every selector constant in `content.js` is satisfied by the mock, and keep the manual real-DeepSeek check in section 6.
- **Chromium build ≠ owner's Chrome 153.** Behaviour of the APIs used (tabs, windows, scripting, storage, runtime messaging) is stable; occlusion/visibility is the exception and is explicitly manual.
- **Branded Chrome no longer accepts `--load-extension`** (recollection, to be verified in phase 0), which is why Playwright's Chromium is used rather than the installed Chrome.
- **Fallback if `context.route` cannot serve extension-created windows:** serve the mock from a local HTTPS server with a test certificate and map `chat.deepseek.com` to it via Chromium's `--host-resolver-rules`; still no production change.
- **Flakiness.** Event-based waits, fresh temp profile per run, one browser per file, no shared state between tests.
- **Scope creep.** The list in section 3 is the whole scope. New scenarios need a bug or a rule to justify them.

## 8. Decisions needed from the owner

1. Approve adding `playwright-core` as a dev dependency (only new dependency).
2. Keep `npm run e2e` separate from `npm run check` (recommended: check stays fast and offline).
3. Accept that section 6 items stay manual.

## 9. Relation to the Browser WebMCP roadmap

The harness tests the provider shell (DeepSeek) *around* the shared execution plane. Scenarios S4–S7 exercise the shared plane and its owner rules; the same fixtures and launcher can later run the ChatGPT Embedded Panel or a merged panel. Nothing here is a provider abstraction: it is one launcher, one mock page and some fixtures.
