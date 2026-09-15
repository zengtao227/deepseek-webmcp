# P1 real-browser findings

Date: 2026-09-15
Environment: logged-in `https://chat.deepseek.com` in Chrome with the unpacked P1 extension.
Conversation used during the experiments:

`https://chat.deepseek.com/a/chat/s/e6272306-d6bc-499f-a3b9-c3e86c3373cf`

This file records observed browser behavior. It is evidence, not a design specification. If later experiments contradict an earlier hypothesis, keep the observation and update the conclusion rather than rewriting history.

## Finding 1 — Initial ARM works

Observed after clicking **Arm this conversation**:

- `armed: true`
- the expected conversation URL was captured as `conversationKey`
- `loops: 0`
- `diagnostics: null`

Conclusion: popup → service worker ARM messaging and initial conversation binding work on the real site.

## Finding 2 — DeepSeek can emit the strict textual tool marker

The user sent the P1 prompt and DeepSeek returned the requested block beginning with:

`<webmcp_tool_call>{"id":"p1_1",...}</webmcp_tool_call>`

Conclusion: the free DeepSeek Web model can follow the textual tool-call convention well enough to reach the extension observation boundary. This does not yet prove automatic continuation.

## Finding 3 — ARMED authority disappeared after a completion

After an ordinary DeepSeek completion, the popup showed:

- `armed: false`
- `conversationKey: null`
- `loops: 0`
- `diagnostics: null`

The final visible conversation URL was unchanged.

At this point there were multiple possible causes, so no fix was applied based on this observation alone.

## Finding 4 — 40 seconds of idle time did not reproduce the loss

Controlled test:

1. arm the conversation;
2. wait about 40 seconds without sending a DeepSeek message;
3. reopen the popup.

Observed:

- `armed` remained `true`;
- conversation URL remained unchanged;
- diagnostics remained null.

Conclusion: idle time alone did not reproduce the failure. This test ruled out treating a generic 30–40 second delay as sufficient evidence for the root cause.

## Finding 5 — Ordinary completion reproduces the loss

Controlled test:

1. arm the same conversation;
2. send `Reply only with: TEST OK`;
3. wait for DeepSeek to finish;
4. reopen the popup.

Observed:

- `armed: false`
- `conversationKey: null`
- `loops: 0`
- `diagnostics: null`
- final visible URL remained the same conversation URL.

A temporary `TAB_URL_CHANGED` diagnostic was added around the existing `tabs.onUpdated(changeInfo.url)` disarm path. The failure reproduced without that diagnostic being observed.

Conclusion: an ordinary completion is enough to trigger the state-loss symptom. A visible conversation change is not required.

## Finding 6 — MV3 service-worker reconstruction is the confirmed cause of the lost in-memory authority

A temporary `workerInstanceId = crypto.randomUUID()` diagnostic was added to the service worker.

Before sending the ordinary completion:

- `armed: true`
- worker instance: `2c8eb764-5dfb-4e8c-aed3-9b6281a73ba4`

After DeepSeek completed:

- `armed: false`
- worker instance: `3dddb473-4f1f-4aee-8ae2-96f016d9c58b`
- diagnostics remained null
- visible conversation URL remained unchanged

The instance ID changed across the completion, proving that Chrome reconstructed the MV3 service worker. The previous implementation stored authority only in module-global `Map` objects, so the reconstructed worker started with empty controller state.

Conclusion: the P1 ARMED authority must not rely solely on service-worker globals.

## Smallest justified fix

Persist only the small P1 authority state needed to survive MV3 worker reconstruction in `chrome.storage.session`:

- tab identity (encoded in the storage key);
- conversation key;
- loop count;
- seen call IDs;
- armed state.

Requirements:

- session memory only; do not use persistent `storage.local` for this authority;
- do not add keep-alive timers, alarms, offscreen documents, or another background mechanism;
- extension reload/update/disable/browser restart should naturally clear the authority;
- content scripts must not receive direct storage access;
- in-memory stream assembly may remain ephemeral unless a real stream-lifecycle failure demonstrates otherwise.

## Fix status

Implemented after Finding 6 and confirmed by a real-browser regression:

- added the Chrome `storage` permission;
- P1 authority snapshot is stored only in `chrome.storage.session`;
- the snapshot contains conversation key, loop count, seen call IDs and armed state;
- module-global controller state remains only a cache;
- temporary worker-instance and URL-change diagnostics were removed from production behavior;
- no keep-alive mechanism or persistent `storage.local` authority was added;
- local unit/static checks pass after the change.

Regression procedure:

1. reload the unpacked extension;
2. open the same existing DeepSeek conversation;
3. arm it and confirm `armed=true`;
4. send ordinary `Reply only with: TEST OK`;
5. wait for the reply;
6. reopen the popup.

Result: **PASS**. The conversation remained armed after the real completion flow.

Conclusion: session-scoped authority persistence fixes the confirmed MV3 service-worker reconstruction failure without adding a keep-alive mechanism or durable local authority.

## Finding 7 — authority regression passes, but the completion observation chain is still not producing diagnostics

After the `chrome.storage.session` authority fix passed its real-browser regression, P1 was retried with a minimal strict tool call:

`<webmcp_tool_call>{"id":"p1_1","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>`

The DeepSeek tab was explicitly reloaded after the unpacked extension reload, the same existing conversation was armed, and DeepSeek produced the requested tool-call text. The popup still reported:

- `armed: true`
- `loops: 0`
- `diagnostics: null`

Conclusion: the confirmed authority-lifetime failure is fixed, but P1 has not yet proven that the current MAIN-world observer sees a real DeepSeek completion and delivers a completed observation to the background worker. The parser and continuation path were not reached in this run.

Do not infer the cause yet. Two live facts must be separated before changing the observer:

1. whether the current page still has the P1 `window.fetch` wrapper installed after load;
2. whether current DeepSeek Web completion traffic still uses a page-level `fetch` to the exact `/api/v0/chat/completion` path that the observer is scoped to.

A separate architectural risk is now explicit: the current implementation stores in-progress stream assembly only in a service-worker global `Map`, while real Chrome testing already proved that the MV3 worker can be reconstructed during the DeepSeek flow. Do not persist or redesign the stream until the two browser facts above show that stream events are actually being observed.

## Finding 8 — root cause of Finding 7 and DOM-first decision (read-only DOM inspection + one probe prompt)

Same conversation, logged-in Chrome, read via DevTools-equivalent page scripting. Observed:

1. **Transport.** `performance.getEntriesByType('resource')` lists every DeepSeek API call (`client/settings`, `users/current`, `chat_session/fetch_page`, `chat/history_messages`, `chat/create_pow_challenge`) with `initiatorType: xmlhttprequest`. After one probe prompt, `/api/v0/chat/completion` also appeared as `xmlhttprequest`. The P1 observer only wrapped `window.fetch`, so it could never see a completion. This fully explains Finding 7 (`loops: 0`, `diagnostics: null`).
2. **Assistant text survives DOM for plain calls.** The Finding 7 reply (virtual-list key `18`) has `.ds-markdown` textContent exactly `<webmcp_tool_call>{"id":"p1_1","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>` — literal tags render as text.
3. **Unfenced escapes do not survive.** The earlier escaped probe (key `16`) renders as `"probe":"中文 quote="x" slash=\ newline=\n"` (2 backslashes, `JSON.parse` fails). Whether the model or the Markdown renderer dropped them is not distinguishable from DOM; either way unfenced escaped JSON is not reliable.
4. **Fenced escapes survive.** Probe reply inside a ```text fence: `pre code` textContent has 6 backslashes and parses to `中文 quote="x" slash=\ newline=\n` (identical to the source value). The whole `.ds-markdown` textContent (including the `text复制下载` code-block banner outside the markers) also parses.
5. **Reasoning vs answer.** The reply had one `.ds-think-content`; it contains its own `.ds-markdown` **without** `ds-assistant-message-main-content`, and is not inside the final answer. `.ds-markdown.ds-assistant-message-main-content` selects only the final answer.
6. **Composer.** One `textarea[placeholder]` (placeholder `给 DeepSeek 发送消息`); `#chat-input` does not exist in this build.
7. **Send/Stop.** One `div[role=button].ds-button.ds-button--primary.ds-button--circle`, no aria-label. Empty composer + idle: class `ds-button--disabled`, icon path `M8.3125…`. After setting the textarea via the native value setter + `input` event the class was removed; `click()` sent the prompt and cleared the composer; 1.5 s later the same control was enabled with icon path `M2 4.88…` (stop).
8. **Identity.** Messages sit in `[data-virtual-list-item-key]`; a just-sent user message temporarily had key `-2`, so keys are not a stable identity during a turn.

Conclusion: the P1 continuation loop does not need network observation. SSE observer, stream accumulator and the MAIN-world script were deleted. The ISOLATED content script now polls every 500 ms, treats "empty composer + enabled send control" as generating, reports the newest final answer only after a generation was observed in this page lifetime and the text stayed unchanged for 2 s, and continues through the textarea + send control. The previous send-button finder (`<button>` with a send/发送 label) could never match this control, so continuation was independently broken.

Unverified: the send-control state during a long reasoning pause, and completion detection while the tab is in the background (timer throttling).

## Secondary review after DOM-first redesign

A second review verified the local implementation after the reference-source investigation:

- the old MAIN-world fetch/SSE observer and stream accumulator are fully removed from the production tree;
- the manifest now injects one ISOLATED content script only;
- background state is limited to session authority, strict parsing/deduplication, fake-result orchestration, and diagnostics;
- no DeepSeek network hook/private completion path remains in `extension/`;
- `npm run check` passes all 21 tests.

One acceptance-evidence bug was found before the live three-turn test: `processCompletion()` replaced the whole diagnostics record on every assistant completion, so the final `P1 COMPLETE` / `NO_TOOL_CALL` record would erase the preceding `continuation.code = SEND_CLICKED`. The implementation now preserves the previous continuation record until a later continuation result replaces it. This does not change the browser loop itself; it keeps the final popup evidence consistent with the documented pass condition.

A remaining reliability risk is intentionally not preemptively changed: the content observer polls every 500 ms and requires seeing a generating state before it will report a new answer. A very short generation could theoretically begin and finish between ticks. The three-turn live test should be run first; redesign this only if real evidence demonstrates a miss.

## Finding 9 — second-turn false completion came from conflating Send and Stop state

Live three-turn run after the DOM-first redesign:

- `p1_1` was observed and parsed successfully;
- the extension generated the fake result, wrote it into the normal composer and clicked the normal DeepSeek control successfully;
- DeepSeek produced the visible fenced `p1_2` tool call;
- the popup then showed `armed=true`, `loops=1`, `continuation.code=SEND_CLICKED`, but `lastCode=NO_TOOL_CALL` with `answerLength=28`.

This proves the first autonomous continuation works and localizes the next failure to response-completion observation on the following turn.

Reference-first review found the current observer was using a weaker heuristic than the working references:

- AI Council separates the DeepSeek `completion` selector from `send` and waits for the stop-generation control to be observed and then disappear before accepting response stability.
- Better DeepSeek processes AUTO/tool tags only when the DeepSeek Stop icon is absent; its current source recognizes `.ds-icon-stop*` and the Stop SVG path beginning `M2 4.88`, which was also confirmed on the live DeepSeek page during the source-level inspection.
- DeepSeek WebMCP instead treated `empty composer + primary circle enabled` as generation, even though DeepSeek reuses the same circle control for Send and Stop.

Smallest borrowed fix:

- keep the DOM-first architecture and existing final-answer selector;
- replace only `isGenerating()` with an explicit Stop-icon check scoped to the existing send/stop control;
- keep the 500 ms polling, 2 s stable-text requirement, strict parser, authority model and continuation logic unchanged;
- add regression coverage proving that an enabled Send control without a Stop icon is not considered generation.

Local validation after this change: `npm run check` = 22 tests passed, 0 failed. Real three-turn browser regression is still required.

## Finding 10 — Stop-icon heuristic remains unverified on the current live page

Live regression after Finding 9 did not observe even the first generated `p1_1` reply:

- the conversation remained `armed=true`;
- `loops=0`;
- `diagnostics=null`;
- the fenced `p1_1` tool call was visibly present in the DeepSeek answer.

Therefore the Finding 9 Stop-icon change is not yet a validated completion detector for the current live DeepSeek page. Do not stack additional heuristics on top of it.

Reference trust is now classified explicitly:

- **Better DeepSeek: primary reference.** It is actively maintained and released a critical hotfix on 2026-08-26 after a DeepSeek UI change. Its current source must be re-fetched before borrowing selectors or completion logic.
- **AI Council: algorithmic reference only.** Its DOM-only `stop seen -> gone -> stable text` pattern is useful, but its own documentation warns that third-party selectors drift.
- **deepseek-anti-retract: supporting evidence only.** Useful for DOM/MutationObserver ideas, not authoritative current selectors.
- **deepseek-memory: transport evidence only.** Useful to confirm XHR-based DeepSeek behavior; its request interception/token-adjacent architecture is outside WebMCP's security boundary.

Next action: compare the **latest current Better DeepSeek implementation** against the current live DeepSeek DOM during generation before making another production change. A reference selector is acceptable only if (a) it comes from a recently working project and (b) the same DOM fact is independently observed on the user's current page.

## Finding 11 — the Stop icon is correct but lives shorter than the polling window

Evidence: one harmless probe `Reply only with: LIVE DOM PROBE` in the test conversation, recorded from the page with a `MutationObserver` (attributes/childList/characterData) plus a 500 ms `setInterval` sampler identical to `content.js`. DOM facts only; no request payloads or credentials were read. (A first identical probe was sent but its capture script hit the 45 s CDP timeout and returned nothing; the second probe was sent with a non-blocking recorder, with user approval.)

Send/Stop control `div[role=button].ds-button.ds-button--primary.ds-button--filled.ds-button--circle` (same element throughout, never replaced):

| t (ms from recorder start) | classes (`ds-button--*` beyond primary/filled/circle/m/icon-relative-m) | `path d` | Our Stop selector | Better DeepSeek Stop selector | composer |
| --- | --- | --- | --- | --- | --- |
| 0 idle | `disabled` | `M8.3125 0.98…` (send) | no | no | 0 |
| 8 typed | — (`tabindex=0`) | `M8.3125…` | no | no | 31 |
| 1134 click | | | | | |
| 1673 pending | `disabled` | `M34,18 C34…` (not a Stop icon) | no | no | 0 |
| **3579 generating** | — (`tabindex=0`) | **`M2 4.88C2 3.68…`** | **yes** | **yes** | 0 |
| 4246 answer text lands | — | `M2 4.88…` | yes | yes | 0 |
| **4258 finished** | `disabled` | `M8.3125…` | no | no | 0 |

- No `aria-label`, `aria-disabled`, `data-*` or `ds-icon-*` class distinguishes Stop; the only differences are the `ds-button--disabled` class and the SVG path. The Stop selector `path[d^="M2 4.88"]` is correct for the current page.
- The Stop state lasted **679 ms**. The final answer node (`.ds-assistant-message-main-content`) received its full 14-character text 12 ms before Stop disappeared; no progressive growth was observable for this short reply.
- `setInterval(500)` samples landed at 1695, 2039, 3054, **5039**, 6033 ms (the tab was `visibilityState: hidden`, so Chrome throttled timers to ≥1 s). **No sample fell inside 3579–4258**, so a polling-only observer never sets `sawGeneration` and never reports — exactly the Finding 10 symptom (`loops=0`, `diagnostics=null`). The `MutationObserver` saw both edges.
- `.ds-assistant-message-main-content` count stayed at 3 while the conversation grew (virtualized list), so element counts are not an identity signal.
- `.ds-think-content` count went 2 → 3 at 4246 ms for this reply.

Root cause: `content.js` detected generation only on timer ticks; the live Stop state of a short tool-call reply is shorter than the (throttled) tick interval.

Fix: call the existing `tick()` from a `MutationObserver` on `document.body` (`subtree`, `childList`, `characterData`, `attributes` filtered to `class`/`d`) in addition to the existing interval. The interval remains only to let the 2 s stable-text timer elapse after the DOM goes quiet. Answer selector, stable-text rule, authority and continuation logic are unchanged. The Stop check was narrowed to `path[d^="M2 4.88"]` only: the Finding 9 `[class*="ds-icon-stop"]` alternative is absent from the live DOM and was removed (a selector must be in the current reference **and** confirmed live). Regression test: `a Stop state shorter than one timer tick is still observed through DOM mutations` (fails without the observer).

Not verified: hidden-tab intensive throttling (>5 min hidden) can delay the stable-text check by up to a minute; this delays but does not drop a report. Keep the tab in front for the live gate.

## Finding 12 — three-turn autonomous browser loop passes live

Real-browser regression after the MutationObserver timing fix PASSED end-to-end.

Observed sequence with the simplified fenced prompt:

1. DeepSeek emitted `p1_1` (`read`).
2. The extension observed and strictly parsed it.
3. The extension generated the fake result, wrote it into the normal DeepSeek composer and clicked the normal Send control.
4. DeepSeek emitted `p1_2` (`bash`) and the same automatic continuation repeated.
5. DeepSeek emitted `p1_3` (`edit`) and the same automatic continuation repeated.
6. After the third fake result, DeepSeek answered `P1 COMPLETE` without further tool calls.

No manual copy/paste, composer editing, or Send action was used after the initial test prompt.

Final popup evidence:

- `armed: true`
- same bound conversation key
- `loops: 3`
- `diagnostics.lastCode: NO_TOOL_CALL`
- `diagnostics.continuation.code: SEND_CLICKED`
- `diagnostics.continuation.ok: true`
- `diagnostics.answerLength: 11` (the final `P1 COMPLETE` response)

Conclusion: the core P1 path is now proven live across three consecutive autonomous turns: DOM observation -> strict tool-call parse -> fake-result construction -> normal composer write -> normal DeepSeek Send -> next assistant turn -> final no-tool completion.

This specifically validates the MutationObserver-based capture of the short Stop window that polling alone missed in Finding 11.

Remaining work before P1 closure is negative/fidelity acceptance only; do not redesign the working main loop unless one of those controls demonstrates a real defect.

## Finding 13 — fenced escape-fidelity check passes live

The separate one-turn escape-fidelity check also PASSED in real Chrome after the three-turn main loop was proven.

Observed popup evidence after the fenced `p1_escape` call and automatic fake-result continuation:

- `armed: true`
- same bound conversation key
- `loops: 1`
- `diagnostics.continuation.code: SEND_CLICKED`
- `diagnostics.continuation.ok: true`
- `diagnostics.lastCode: NO_TOOL_CALL`
- `diagnostics.answerLength: 9`, matching final `ESCAPE OK`

Conclusion: escape-heavy JSON remains valid when the tool call is emitted inside the required fenced code block, while retaining the strict parser and normal composer/Send continuation path. No loose JSON repair is needed.

## Separate compatibility finding — Comet is not yet validated

The user reported that the same unpacked extension installs in the Chromium-based Perplexity Comet browser and its popup opens, but clicking ARM does not produce the expected status/output. The proven Chrome P1 path continues to work.

Treat this as a separate browser-compatibility gate rather than a regression of the Chrome P1 implementation. Chromium engine compatibility does not by itself prove equivalent Chrome Extension API behavior. Current `popup.js` depends on `chrome.tabs.query({ active: true, lastFocusedWindow: true })`, `tab.url`, and `chrome.runtime.sendMessage` without an error-reporting boundary, so a Comet-specific API difference/failure can currently appear as an inert popup.

Do not change production behavior until the exact failing Comet API call is identified from current Comet documentation/runtime evidence.

## Finding 14 — route-change and malformed/unfenced negative controls pass live

Two more Chrome P1 negative controls PASSED.

### Route change

After arming one DeepSeek conversation and navigating to another, the popup showed:

- `armed: false`
- `conversationKey: null`
- `loops: 0`
- `diagnostics: null`

Conclusion: changing conversations revokes the armed authority as intended.

### Malformed / unfenced escape-heavy call

After re-arming, the escape-heavy tool-call instruction was sent without a code fence. DeepSeek rendered broken JSON escapes (`quote="x"` became `quote="x"` text with the JSON quote effectively unescaped, and backslashes were reduced), and the strict parser rejected it.

Popup evidence:

- `armed: false`
- `conversationKey: null`
- `loops: 0`
- `diagnostics.lastCode: INVALID_JSON`
- no continuation was sent

Conclusion: malformed model output fails closed and automatically revokes the armed epoch; no loose JSON repair is required.

## Finding 15 — reload/history replay and DISARMED valid-call controls pass; P1 closes

The two remaining Chrome P1 controls also PASSED.

### Reload / history replay

The DeepSeek page was reloaded and left untouched. No automatic message was sent and no historical tool call was replayed.

### DISARMED valid call

While the extension was explicitly DISARMED, DeepSeek emitted a valid fenced tool call:

`<webmcp_tool_call>{"id":"p1_disarmed","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>`

The popup remained:

- `armed: false`
- `conversationKey: null`
- `loops: 0`

No fake result and no automatic Send occurred. The popup still displayed the previous malformed-test `INVALID_JSON` diagnostics because ignored DISARMED calls do not overwrite diagnostics; this is expected and is not evidence of execution.

## P1 final status — CLOSED / PASS in Google Chrome

P1 is now fully accepted in the baseline browser.

Proven live properties:

- DOM-only completed-answer observation;
- strict tool-call parsing;
- fenced escape fidelity without loose JSON repair;
- malformed/unfenced JSON fails closed and DISARMs;
- ARMED authority survives MV3 service-worker reconstruction through `chrome.storage.session`;
- route change DISARMs;
- reload/history re-render does not replay old calls;
- DISARMED valid calls are ignored;
- normal DeepSeek composer write and normal Send work;
- three consecutive autonomous tool turns complete without user intervention;
- no DeepSeek private completion/network hook or credential extraction exists in the extension.

Chrome is the baseline supported browser. Comet/browser portability remains optional and does not block P2.

P2 may proceed after the design in `docs/p2-review-brief.md` is reviewed.
