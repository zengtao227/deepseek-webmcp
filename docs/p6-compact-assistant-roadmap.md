# P6 — Compact Assistant / Provider Window Roadmap

Date: 2026-09-20
Status: **IMPLEMENTED IN WORKING TREE — automated checks PASS; real Chrome P6 acceptance pending.**

This phase follows the completed DeepSeek browser/tool-loop work and the 2026-09-19 Side Panel / hidden-tab spikes.

Objective: make DeepSeek WebMCP feel like a compact assistant next to the work page without changing proven browser/local tool execution contracts.

## 1. Facts already established

### Direct embedding is not the path

The direct Side Panel experiments failed: DeepSeek in an iframe hit the provider challenge, and top-level Side Panel navigation was not viable. Chrome's Side Panel API also requires a local extension resource.

Therefore the production panel should be an extension-owned UI, not an attempt to turn the panel into the DeepSeek website.

### Fully hidden DeepSeek is not viable

The hidden-tab spike proved that the content script remains alive, prompt submission succeeds, and generation completes, but answer/reasoning/message DOM does not render while the tab is hidden. The DOM appears almost immediately when the tab becomes visible.

Do not continue trying to make a normal hidden background tab the streaming source.

### Separate provider window is viable

The separate-window spike passed: DeepSeek remains the selected tab in a second non-minimized Chrome window, visibilityState stays visible, document.hasFocus() stays false, and answer DOM grows normally.

The fully-covered variant also passed: the provider window can be completely behind the work window. It only needs to stay non-minimized with DeepSeek as that window's selected tab.

## 2. P6 product goal

User experience:

    work page + extension Side Panel assistant

The user should not manually manage the DeepSeek provider window during normal operation.

Internally:

    Extension Side Panel UI
            |
            v
    background service worker
            |
            +--> managed DeepSeek provider window/tab
            |      -> existing DeepSeek DOM adapter/tool loop
            |
            +--> existing local tools
            +--> existing Browser WebMCP target tools

The real DeepSeek page remains the model/governance layer. The Side Panel is presentation and prompt input only.

## 3. P6.0 — automatic provider-window lifecycle

This is the first implementation target.

When the user opens the Assistant from a work page:

1. find an existing dedicated DeepSeek provider tab/window if healthy;
2. otherwise create a dedicated Chrome window containing DeepSeek;
3. keep DeepSeek as the selected tab in that provider window;
4. leave the provider window non-minimized;
5. return focus to the work window;
6. bind the assistant session to work tab W, provider tab D, provider window P.

The provider window may remain fully behind the work window.

Chrome supports creating an unfocused extension window with chrome.windows.create({ focused: false }).

Do not minimize it, deliberately move it off-screen without a separate empirical test, use private DeepSeek APIs, or automate provider challenges/login.

Provider health must include:

- visibilityState;
- document.hasFocus();
- current route/conversation;
- generation state;
- content-script liveness;
- provider window exists and is not minimized;
- provider tab exists and remains active in that dedicated window.

If health fails, show:

    Assistant paused — DeepSeek provider needs attention
    Restore

Fail closed; never silently retarget another DeepSeek tab.

Acceptance: from one work window, opening Assistant creates/reuses the provider window, restores focus to work, requires no manual window arrangement, and completes one reply while the provider stays completely behind the work window.

## 4. P6.1 — extension-owned Side Panel conversation UI

Add a local Side Panel resource.

Side Panel responsibilities:

- prompt input;
- provider/session status;
- conversation rendering;
- streaming presentation;
- Stop/restore affordances.

It must not own tool authorization, allowlists, target binding rules, filesystem permissions, browser action safety, or replay protection.

V1 supports one active pair only:

    work tab W <-> DeepSeek provider tab D

Store authoritative session identity in background/session storage. Do not infer the work target from whichever tab happens to be active when a tool call arrives.

## 5. P6.2 — reasoning + final answer presentation

The requested UI should distinguish three streams.

### A. Provider-visible reasoning

DeepSeek already renders a visible reasoning block in its UI, observed under .ds-think-content.

The extension may mirror only reasoning content that DeepSeek itself visibly exposes to the user. Do not attempt to extract hidden/private model chain-of-thought.

Presentation:

    Thinking
    [expand/collapse]
    provider-visible reasoning stream

Recommended behavior: expanded while generating, optionally auto-collapse after final completion, user can reopen it, and provider text is never injected through innerHTML.

### B. Final answer

Current final-answer source:

    .ds-markdown.ds-assistant-message-main-content

Presentation: main visual emphasis, stream as it grows, remain visible after completion, and never display WebMCP protocol/tool-result text as final-answer content.

### C. Tool activity

Do not render every request/result as a conversational turn.

Default live presentation:

    Working · 6 tool actions

After completion:

    Used 6 tools · completed

Expandable details may show:

    inspect_page ✓
    fill ✓
    fill ✓
    select ✓
    inspect_form ✓
    click ✓

Always surface tool errors, CONFIRMATION_REQUIRED, target lost, and local runtime unavailable. Successful normal tool traffic stays collapsed.

## 6. Distinguish UI noise from actual tool count

There are two separate problems.

### Problem 1 — too many tool messages on screen

Solve this first with presentation aggregation.

The current DeepSeek transport necessarily uses visible text messages for tool calls, tool results, format corrections, and repeated tool contract. The provider page already folds much of this. The new Side Panel should not reproduce those turns; it has structured background events and can render one activity summary.

### Problem 2 — the model actually calls too many tools

Do not solve this by immediately allowing arbitrary multi-tool replies.

The current one-call-per-reply rule is proven and gives simple sequencing/replay behavior.

First measure traces and reduce unnecessary calls through better information density:

1. prefer inspect_form directly for form tasks;
2. ensure inspect results contain enough current value/label/action context;
3. avoid instructions that encourage redundant re-inspection;
4. keep target state valid across safe operations where already supported;
5. keep tool results compact but sufficient.

Only if traces show repeated independent calls that can safely be combined should a bounded batch operation be considered.

Do not loosen one-call-per-reply merely to make the transcript shorter; transcript noise is a UI problem.

## 7. P6.3 — move timing authority out of the provider page

Current content.js contains polling interval, stable-text timing, and send-enable/send-confirm sleep loops.

The prior architecture review identified the minimum correction:

- keep MutationObserver for DOM change detection;
- let the visible Side Panel/background drive bounded ticks/confirmation;
- avoid depending on provider-page timers for correctness.

Do this only as needed for the managed-provider-window path. Do not rewrite the DeepSeek loop wholesale.

## 8. P6.4 — conversation event model

Use a small structured event stream between provider/background and Side Panel:

    session.state
    reasoning.partial
    answer.partial
    generation.started
    generation.completed
    tool.started
    tool.completed
    tool.error
    confirmation.required
    provider.attention_required

This is presentation state, not a new tool protocol. The existing WebMCP textual protocol remains unchanged until a concrete defect requires changing it.

The Side Panel should rebuild from background/session state after being destroyed/reopened.

## 9. Minimum file-level delta proposed for later implementation

Not yet authorized to implement.

Expected minimal shape:

    CHANGE extension/manifest.json
      + sidePanel permission
      + side_panel default_path

    NEW extension/sidepanel.html
    NEW extension/sidepanel.js

    CHANGE extension/background.js
      + one bound assistant session
      + provider-window create/reuse/health
      + structured presentation events
      + side-panel message handling

    CHANGE extension/content.js
      + reasoning/final partial events
      + provider health state
      + timing changes only where required

    KEEP unchanged
      extension/browser-client.js
      extension/target-executor.js
      native runtime/tool security model
      tool-call parser
      Browser confirmation gate

Do not introduce a provider framework, React/Vue, backend service, DeepSeek API client, or generic browser-automation layer.

## 10. Acceptance sequence

### Gate P6-A — managed provider window

PASS: no manual second-window setup; provider stays visible+unfocused; work window remains usable; one full reply renders while provider is covered.

### Gate P6-B — read-only panel mirror

PASS: prompt can be sent from Side Panel; provider-visible reasoning is mirrored; final answer streams; no tool execution changes yet.

### Gate P6-C — existing tool loop through panel

PASS: current local/browser tools execute unchanged; Side Panel shows one aggregated tool activity item; final answer remains readable; errors/confirmation are explicit.

### Gate P6-D — UX trace review

Run several real tasks and record actual tool-call count, tool activity UI rows, redundant re-inspection rate, and time to final answer.

Only then decide whether actual tool-call reduction needs protocol/tool changes.

## 11. Why this is the next useful DeepSeek work

The browser experiments already eliminated the two tempting but invalid designs: embed DeepSeek directly in Side Panel, or use a fully hidden DeepSeek tab.

The remaining viable architecture is empirically proven: a dedicated, non-minimized, selected DeepSeek provider tab can run completely behind the user's work window.

The next engineering value is UX/productization around that proven constraint, not another attempt to remove the constraint.

## 12. Today's implementation batch

For the next implementation pass, complete P6 in this order:

1. **Baseline**
   - preserve current uncommitted Browser V1 work;
   - run `npm run check`;
   - correct only stale acceptance records.

2. **Managed provider window**
   - one explicit Open Assistant gesture from the existing popup;
   - attach the work tab;
   - create/reuse exactly one recorded DeepSeek provider window;
   - create it unfocused, keep it non-minimized, keep DeepSeek as that window's active tab;
   - restore focus to work;
   - pause/Restore when provider health is lost;
   - never silently adopt another DeepSeek tab.

3. **Side Panel**
   - add the local extension Side Panel;
   - authoritative session remains in background/storage;
   - panel owns prompt/presentation only.

4. **Conversation presentation**
   - Side Panel prompt reuses the existing DeepSeek send path;
   - mirror only provider-visible reasoning;
   - stream final answer separately;
   - safe text rendering only.

5. **Tool activity**
   - aggregate normal successful tool traffic into one expandable activity item;
   - surface errors and `CONFIRMATION_REQUIRED` explicitly;
   - do not change one-call-per-reply yet.

6. **Live acceptance**
   - no-tool prompt;
   - inspect-only Browser task;
   - safe multi-tool form task;
   - commit-like click still blocked;
   - provider minimize/close -> pause;
   - Restore -> healthy;
   - panel close/reopen -> presentation restores;
   - existing Work/local coding flows still work;
   - `npm run check` green.

Do not rewrite provider-page timers unless the new visible+unfocused managed-window path produces a concrete timer failure.

The cross-repository implementation and acceptance details are in:

`/workspace/My code/chatgpt-embedded-panel/docs/next-stage-execution-plan.md`
