# Browser end-to-end tests

Real Chromium, the unpacked extension, the **real Side Panel**, a mock `chat.deepseek.com` and local fixture pages, all through the shared harness [`browser-webmcp-e2e`](https://github.com/zengtao227/browser-webmcp-e2e). Nothing touches your Chrome profile, your DeepSeek account, the network, or your real native host. Plan and scope: `docs/dev-test-automation-plan.md`; feasibility evidence: `docs/dev-test-automation-phase0-report.md`.

```sh
# once: the harness next to this repository, and its browser
git clone https://github.com/zengtao227/browser-webmcp-e2e ../browser-webmcp-e2e   # if not there yet
(cd ../browser-webmcp-e2e && npm install && npm run install-browser)
npm install
npm run e2e          # not part of `npm run check`
```

| File | What it is |
|---|---|
| `mock-deepseek.mjs` | the page content.js talks to; every part is marked with its recorded source or "assumed" |
| `harness.mjs` | launches with the mock, starts the assistant, small helpers |
| `assistant.e2e.mjs` | S1 boot, S2 reuse, S3 prompt to rich answer (incl. the kept-composer regression), S3b very short tool-call reply |
| `page-tools.e2e.mjs` | S4 page read, S5 fill/select and Submit refused, S7 Stop semantics |
| `scroll.e2e.mjs` | the scroll tool on a long page (target past the first 80 controls), an inner scroll container (page does not move) and windowed lists that remount or recycle nodes (old refs stay stale) |
| `handoff.e2e.mjs` | S6 mail handoff: new tab, popup, same-tab navigation, an unrelated tab is never adopted |
| `reload.e2e.mjs` | a real extension reload with the provider window open: the panel recovers the same provider |
| `provider.e2e.mjs` | S8 Regenerate/Share, S10 hidden provider fails closed, S9 provider close, Restore |
| `steps.mjs` | helpers: ask a prompt and wait for the turn, open a tab in the panel's window, override the reported visibility |
| `recorded-action-bar.mjs` | the two recorded action-bar icons the mock draws |

Not covered (see the plan, section 6): real DeepSeek, real macOS window occlusion and dialogs, the toolbar-icon click, a service-worker idle restart without an extension reload. These stay a short manual check. `docs/p6-live-test.md` marks which acceptance rows the suite covers ("E2E 覆盖").
