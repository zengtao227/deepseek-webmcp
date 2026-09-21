# DeepSeek P6 Implementation Handoff

Date: 2026-09-20
Status: P6 implementation complete in working tree; automated tests green; real Chrome P6 acceptance partly done (see `docs/p6-live-test.md`, 2026-09-21). Local Expert implementation is also complete in its repository with automated tests green; its real macOS acceptance remains pending.

## Owner-approved phase order
1. Finish DeepSeek P6.
2. Finish Local Expert/Privacy setup.
3. Start Hosted Browser WebMCP Platform.

## Reviewed plans
Primary execution plan:
/workspace/My code/chatgpt-embedded-panel/docs/next-stage-execution-plan.md

Codex review brief:
/workspace/My code/chatgpt-embedded-panel/docs/codex-next-stage-review-brief.md

DeepSeek detailed P6 plan:
/workspace/My code/deepseek-webmcp/docs/p6-compact-assistant-roadmap.md

Local detailed plan:
/workspace/My code/chatgpt-embedded-panel/docs/local-expert-install-plan.md

Hosted architecture:
/workspace/My code/chatgpt-embedded-panel/docs/hosted-relay-enterprise-architecture.md

Claude hosted review:
/workspace/My code/chatgpt-embedded-panel/docs/hosted-relay-review.md

Browser WebMCP umbrella roadmap:
/workspace/My code/chatgpt-embedded-panel/docs/browser-webmcp-platform-roadmap.md

## Codex review decisions incorporated
- Phase 1 ready to implement.
- Side Panel must open immediately in the popup user-gesture path before provider startup awaits.
- Compact Assistant must exact-bind one provider tab; another Work-enabled DeepSeek tab must not execute its tool calls while an assistant session exists.
- Local setup must perform all profile/config mismatch checks before the first write/runtimes connect.
- Hosted H1 still needs explicit armed-state generation/revocation semantics so Stop/disarm rejects pending calls, old connection callbacks and late results.

## DeepSeek P6 implementation currently present
Runtime changes now in working tree:
- extension/manifest.json: sidePanel permission + local side_panel.default_path.
- extension/popup.html / popup.js: Compact Assistant action.
  - sidePanel.open({tabId}) is called in the direct click path before provider startup awaits.
  - assistant.open runs asynchronously after panel opening begins.
- extension/background.js:
  - assistant.session stored in chrome.storage.session;
  - one workTab/workWindow + providerTab/providerWindow binding;
  - provider window create/reuse/normalize;
  - non-minimized provider health;
  - Pause / Restore / Stop;
  - prompt dispatch to exactly the recorded provider tab;
  - exact provider-tab gate for tool execution;
  - browser target must remain the bound work tab;
  - provider-visible presentation state;
  - compact tool activity state.
- extension/content.js:
  - provider health reply;
  - assistant.prompt reuses the existing composer/Send path;
  - first new-chat prompt still appends existing Work instructions;
  - mirrors DeepSeek-visible .ds-think-content reasoning;
  - mirrors .ds-markdown.ds-assistant-message-main-content final answer;
  - filters tool-call/DSML protocol text from panel answer;
  - sends bounded assistant.snapshot updates;
  - existing timer architecture is unchanged.
- NEW extension/sidepanel.html + sidepanel.js:
  - local extension-owned UI;
  - history, Thinking, final answer, tool aggregation;
  - Restore / Stop;
  - safe textContent rendering only.

## Tests currently present
- existing baseline tests retained;
- background fake Chrome expanded with windows/provider model;
- Compact Assistant create/bind test;
- other Work-enabled DeepSeek tab cannot execute tool call test;
- provider minimized -> paused -> Restore test;
- Side Panel-only prompt + provider-visible snapshot test;
- manifest sidePanel permission/resource test;
- compact assistant UI/source tests exist in tests/compact-assistant-ui.test.js.

Current command result:
npm test -> 143 tests / 143 pass / 0 fail.

Important: npm test is green, but the full real Chrome live acceptance has NOT yet been performed after these P6 code changes.

## Next live gate — finish Phase 1 acceptance

1. Read current uncommitted diff; preserve all existing P1-P5 and Browser V1 work.
2. Run npm run check, not only npm test.
3. Review P6 code for minimality and regressions; do not redesign the Browser executor or one-call-per-reply protocol.
4. Real Chrome P6-A:
   - open an ordinary work page;
   - popup -> Open Assistant;
   - Side Panel must open immediately;
   - provider window auto-created/reused;
   - work window regains focus;
   - provider remains selected/non-minimized/visible+unfocused while fully covered.
5. Real Chrome P6-B:
   - send prompt entirely from Side Panel;
   - verify provider-visible reasoning streams;
   - verify final answer streams separately;
   - no protocol/tool text shown as final answer.
6. Real Chrome P6-C:
   - inspect-only Browser task;
   - safe multi-tool form task;
   - successful tool calls aggregated;
   - CONFIRMATION_REQUIRED remains explicit;
   - another DeepSeek Work tab cannot become provider or execute assistant tool calls.
7. Lifecycle:
   - minimize provider -> paused;
   - Restore -> normal/unfocused and usable;
   - close provider -> fail closed;
   - close/reopen Side Panel -> state reconstructs;
   - work tab close -> assistant session ends safely.
8. Regression:
   - legacy DeepSeek-page Work still works;
   - local coding tools still work;
   - Browser V1 still works;
   - no timer rewrite unless live visible+unfocused provider testing shows an actual timer failure.
9. Update P6 live-test evidence and roadmap only after actual live PASS.

## Phase 2 implementation status
Use /workspace/My code/chatgpt-embedded-panel/docs/local-expert-install-plan.md.

Implemented in the Embedded Panel working tree:
- pre-write existing-profile mismatch guard in both local:setup and the lower LaunchAgent installer;
- `npm run local:setup`;
- `npm run local:doctor`;
- `npm run local:uninstall` with conservative Browser-only ownership;
- canonical README Local Expert / Privacy flow;
- automated ownership, doctor, idempotency-precondition and uninstall tests.

Remaining Phase 2 gate: run doctor on the real Mac, rerun the printed setup command against the already-working installation, rerun doctor, and verify a real ChatGPT `inspect_page` still works.

## Phase 3 after Local PASS
Use Hosted docs above.
Before H1, explicitly define armed session generation/revocation so disarm invalidates pending calls, reconnect callbacks, old sockets and late results. Do not reuse current target Stop semantics directly.

## Safety / source-control boundary
- No commit/push has been made.
- Working trees contain intentional pre-existing uncommitted work.
- Do not reset, clean, checkout-overwrite, or discard unrelated changes.
- Actual filesystem/Git state is authoritative.