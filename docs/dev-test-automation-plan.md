# Dev-side end-to-end test automation — plan for review

Status: **PLAN ONLY (revision 2). No code written.** Written 2026-09-21; revised after Codex review the same day (see section 11).
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

`npm run check` = lint + 223 unit tests with a **fake `chrome` API**. That is fast and useful, but every bug found live this month sat in a seam the current fake does not cover (several, like DOM shape and send confirmation, can and did also get unit regressions afterwards):

| Live bug (2026-09-20/21) | Why the current fake did not cover it |
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
| S3 | Prompt → answer | panel prompt reaches the mock's composer with the tool contract on the first prompt; **the mock keeps the text in the composer after Send (as real DeepSeek did) and only starts generating / changes route**, and the panel must still report success; mock streams reasoning + answer; panel renders the block structure (heading, list, code, table, link); Copy/Regenerate/Share appear only when finished |
| S4 | Page read | mock replies with an `inspect_page` call; the fixture page in the work window is locked; the result typed back into the mock contains the page's title/text |
| S5 | Fill, but never submit | `fill`/`select` change the fixture form; a `click` on Submit/Send returns `CONFIRMATION_REQUIRED` and changes nothing (owner rule) |
| S6 | Email handoff | fixture "mail" page, three separate cases. **Popup** and **new tab**: the task follows it (opener + lease); closing it returns to the parent. **Same-tab navigation**: the task follows the page (same-origin or under a live click lease); there is no child to close, so no return is asserted. An unrelated tab is never adopted |
| S7 | Stop semantics | after Stop the task is idle; the next prompt carries the "page released" note once; the next page action locks the page now open |
| S8 | Regenerate / Share | mock action bar built from the **recorded real bar** (class names and the two icon paths of the 2026-09-21 diagnostic; both mappings were confirmed live by the owner the same day: Regenerate and Share worked): exactly one control matched, click observed by the mock; changed/duplicated icon → diagnostic, no click |
| S9 | Provider lifecycle | close provider → session paused, tools refused; Restore re-arms |
| S10 | Visibility fail-closed | the mock overrides `visibilityState` to `hidden` → the panel shows `PROVIDER_HIDDEN` with both windows' state; the test then **removes the override on the mock** (a real focus does not undo an override) and the Restore flow recovers. Only kept in E2E for the cross-component propagation; the branch logic itself stays a unit test |

Not in scope (see section 6): real DeepSeek, real macOS occlusion, toolbar-icon click, macOS dialogs, real Docker/native runtime (already covered by `native-*.test.js`; the native call is stubbed in E2E).

## 4. Design (deliberately small)

```text
e2e/                       (outside tests/, see "Discovery")
  launch.mjs         start Chromium with the extension in a temp profile, install the network policy, return { context, extensionId }
  mock-deepseek.html one page + small script: the DeepSeek DOM contract, driven by the test
  fixtures/          form.html, mail.html (Reply opens popup / new tab / same-tab nav), second.html
  *.e2e.mjs          one file per group of scenarios, node:test
```

Mechanics (each to be proven in phase 0, not assumed):

- **Extension loads** in Playwright's Chromium, headed or new-headless, from `extension/`. The manifest `key` gives the fixed id `ekejcladpfhmaghllolijpiakhcffpmp`, so the panel URL is known: `chrome-extension://<id>/sidepanel.html`.
- **Mock DeepSeek under the real origin, with a strict network policy.** The extension hard-codes `https://chat.deepseek.com` (content-script match, origin checks). The route is installed **before the panel is opened** and is an allowlist: only the mock page's own URLs (`/` and `/a/chat/s/<id>`) return the mock; every other request to any host except `localhost` fixtures and `chrome-extension://` is aborted **and recorded, and the test fails if anything was aborted**. It is not a blanket "all DeepSeek URLs return the same HTML", which would hide unexpected API calls. Playwright's route has documented limits (requests made by service workers are not covered); the extension makes no fetches of its own (a unit test asserts this), and phase 0 checks the coverage boundary. This is request policy for the test context, not a claim of whole-browser network isolation. The mock implements exactly what `content.js` reads: `textarea[placeholder]`, the circular send/stop control (Stop icon path prefix `M2 4.88`, disabled class `ds-button--disabled`), `.ds-markdown.ds-assistant-message-main-content`, `.ds-think-content`, `.ds-message`, `.md-code-block > pre`, and the six-button action bar with the two recorded icon paths. The test decides what the "model" answers (including `<webmcp_tool_call>` blocks).
- **Panel without a click.** The real Side Panel opens through the toolbar icon (a user gesture); the E2E run does not. `sidepanel.js` starts the assistant itself on load, using the id of *its own window* (`chrome.windows.getCurrent()`, `sidepanel.js:304`). So the panel page is opened as a **background tab in the same window as the fixture page**, unmodified: it binds that window, and the page tools then act on the fixture, which is the active tab. Opening the panel in its own window and passing another window id would bind the wrong window and race the auto-start, so that is not done. Limitation, stated up front: this does not exercise the real Side Panel's focus behavior.
- **Native runtime is out of E2E.** No stub is installed in the worker (an in-memory override would not survive the worker restarts that S2 causes). Instead phase 0 must **prove that the test profile cannot reach the owner's real native host**, before and after a worker restart (Chromium's own profile does not see the manifest the owner registered for Google Chrome; the proof is a native call that fails with host-not-found). If that cannot be proven, stop; there is no silent fallback to the real host. If a scenario later needs native tools, a fake host registered in the temp profile is a separate decision.
- **Waiting by events, never by sleeps.** Poll the observable state (task mode, mock received text, panel DOM) with a timeout.
- **Dependency and browser:** `playwright-core` as a **dev dependency only** (the project has none today), pinned to one exact version together with its matching Chromium build. The cached builds on this Mac are only a convenience, not the basis for choosing the version. A clean checkout needs a documented one-time browser install (`npx playwright-core install chromium`, a download). Extensions need a persistent context and Playwright's Chromium; branded Chrome/Edge no longer accept the command-line side-loading (Playwright documents this), so the owner's Chrome is not used.
- **Discovery.** Bare `node --test` (which `npm test` uses) also discovers `tests/**/*.test.js`; verified 2026-09-21 that `tests/e2e/x.e2e.test.js` is picked up, while `e2e/*.e2e.mjs` is not. So E2E files live outside `tests/` with that name, `npm run e2e` runs them explicitly (`node --test e2e/*.e2e.mjs`), and phase 1 checks that `npm run check` starts no browser.

## 5. Phases and acceptance

**Phase 0 — feasibility spike (go/no-go, small).** One throwaway script proving:
(a) the extension loads in a persistent Chromium context and the service worker is reachable;
(b) with the allowlist route installed *before* the panel opens, the mock is served for windows created **by the extension**, the content script injects, and any other request is aborted and reported;
(c) the **unmodified** `sidepanel.js`, opened as a background tab in the fixture's window, starts the assistant for that window, and a page tool then reads the **fixture** (not the panel tab);
(d) `window.open` / `target=_blank` from a fixture yields `tabs.onCreated` with `openerTabId`;
(e) no call reaches the owner's real native host, before and after killing and restarting the service worker;
(f) `npm test` does not start a browser and `npm run e2e` runs only the E2E files.
Any failed condition means stop and report; the HTTPS/certificate/host-mapping route is a separate evaluation, never an automatic escalation. Nothing is added to the repo except the report.

**Phase 1 — harness + S1, S2, S3.** Acceptance: `npm run e2e` passes on a clean checkout; run time under ~60 s; leaves no processes or temp profiles behind.

**Phase 2 — S4–S7** (the page tools, the owner rules, email handoff, Stop).

**Phase 3 — S8–S10.**

**Phase 4 — targeted fault injection.** For the key assertions (not one per scenario), break the matching behaviour once in a **temporary copy** of the extension and confirm the test fails. Production files are not edited for this.

Each phase ends with `npm run check` green and a short note in `docs/`. Stop when the acceptance is met; do not add scenarios "because they are easy".

## 6. Not automated in this round (shrinks to a short list)

| Item | Why it cannot be automated |
|---|---|
| Real DeepSeek behaviour (login, provider challenge, real DOM drift) | needs the owner's account; the iframe experiment already showed the challenge; credentials are never entered by tools. This is also the only check against real DOM drift |
| Toolbar icon opens the panel; `sidePanel.open` | needs a user gesture. Chrome allows interaction on an extension page to trigger it, so this could be automated later; not in this round |
| macOS folder dialog, Full-access dialog, Uninstall dialog | native dialogs |
| Whether a fully covered provider window turns `hidden` | depends on the owner's macOS/Chrome (full-screen Spaces, occlusion); the new `PROVIDER_HIDDEN` message records both windows' state to explain it |
| Real Docker/native runtime on the owner's folder | the existing native tests include a fake Docker, so they are **not** a real Docker integration acceptance; `npm run doctor` and the owner's live run are. Not repeated in E2E |

Optional, only if wanted later: read-only checks on real pages through the existing Chrome tools. Not part of this plan.

## 7. Risks and how the plan limits them

- **Mock drift** (the mock passes while real DeepSeek changed). A test that only checks the product selectors against the mock proves the two agree, not that either is right, so there is no such test. Instead the mock is built from **minimal real-DOM fixtures with a recorded date and source, stripped of any conversation content** (the action bar from the 2026-09-21 diagnostic; the composer/send/stop/answer contract from the 2026-09-15 live notes, each marked with where it came from). Anything without a recorded source is marked "assumed" in the mock. The manual real-DeepSeek check in section 6 remains the only defence against real drift.
- **Chromium build ≠ owner's Chrome 153.** Behaviour of the APIs used (tabs, windows, scripting, storage, runtime messaging) is stable; occlusion/visibility is the exception and is explicitly manual.
- **Branded Chrome/Edge no longer accept command-line side-loading** (documented by Playwright), which is why its Chromium is used, not the installed Chrome.
- **If the route cannot serve extension-created windows:** stop (phase 0). A local HTTPS server with a test certificate plus `--host-resolver-rules` is a possible route, to be evaluated separately with its own risks.
- **Flakiness.** Event-based waits, fresh temp profile per run, one browser per file, no shared state between tests.
- **Scope creep.** The list in section 3 is the whole scope. New scenarios need a bug or a rule to justify them.

## 8. Decisions needed from the owner

1. Approve adding `playwright-core` as a dev dependency (only new dependency).
2. Keep `npm run e2e` separate from `npm run check` (recommended: check stays fast and offline).
3. Accept that section 6 items stay manual.

## 9. Relation to the Browser WebMCP roadmap

The harness tests the provider shell (DeepSeek) *around* the shared execution plane. Scenarios S4–S7 exercise the shared plane and its owner rules through the existing code only. Nothing here is a provider abstraction and no reuse by another project is promised: it is one launcher, one mock page and some fixtures.

## 10. Where this lives (owner question: separate project, local and GitHub?)

**Recommendation: not a separate project now. Keep it in this repository under `e2e/`.**

- The tests exercise this extension and must change in the same commit as the code they cover (the shared-core pins, the panel flow and the content-script contract move together). A second repository adds a sync step for every change and is exactly the kind of extra structure the owner asked to avoid.
- It is already stored twice once pushed: the local checkout and the GitHub repository `zengtao227/deepseek-webmcp`. Branch `p6-compact-assistant` (with this plan) is **local only at the time of writing**; pushing it is a separate approval.
- When the projects are merged into Browser WebMCP, the launcher and fixtures can be moved to a shared location as part of that integration, when two providers actually need them.

## 11. Revision 2 — changes after Codex review (2026-09-21)

Accepted and applied: panel binds its own window, so the panel tab goes in the fixture's window (section 4, phase 0 c); allowlist network policy installed before the panel opens, with abort-and-fail (section 4, phase 0 b); no in-worker native stub, prove the real host is unreachable across restarts (section 4, phase 0 e); E2E files outside `tests/` and an explicit `npm run e2e`, discovery verified (section 4, phase 0 f); mock-vs-product selector check removed in favour of dated, sourced real-DOM fixtures (section 7); S3 keeps-text regression, S6 split by navigation kind, S8 tied to confirmed icons, S10 controlled restore (section 3); exact Playwright/Chromium pin with a documented install (section 4); targeted fault injection in a temporary copy instead of per-scenario mutation (phase 4); wording fixes in sections 2, 6, 7, 9.
