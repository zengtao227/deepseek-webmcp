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

Not covered (see the plan, section 6): real DeepSeek, real macOS window occlusion and dialogs, the toolbar-icon click, a real service-worker restart. These stay a short manual check.
