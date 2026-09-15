# P1 external reference research

Date: 2026-09-15

Purpose: calibrate the DeepSeek WebMCP P1 browser-loop architecture against working public projects and official browser guidance before making further implementation changes.

## Why this research was started

After the MV3 ARMED-authority bug was fixed and passed a real-browser regression, the simplest strict tool-call test still produced `armed=true`, `loops=0`, `diagnostics=null`. The parser and continuation path therefore have not been reached. Rather than continue adding local instrumentation around an unproven observation design, the next step is to compare with implementations that already automate or observe DeepSeek/LLM web UIs.

## GitHub references

### Naim-Bijapure/ai-council

Repository: https://github.com/Naim-Bijapure/ai-council

Why relevant:
- supports DeepSeek as a real logged-in browser agent;
- maintains DeepSeek-specific selector configuration;
- documents ordered selectors for four explicit browser concepts: `input`, `send`, `response`, `completion`;
- uses the stop-generation UI as the completion signal;
- provides diagnostics before running full automation;
- sends prompts and waits for responses through content-script DOM automation rather than requiring provider-SSE reconstruction for the basic agent loop.

Implication for this project:
- this is the strongest reference for a minimal DOM-first P1 loop;
- exact implementation/selectors should be inspected from source before copying any idea.

### fireflyhoo/deepseek-anti-retract

Repository: https://github.com/fireflyhoo/deepseek-anti-retract

Why relevant:
- DeepSeek-specific Chrome extension;
- uses `MutationObserver` to track streamed assistant output;
- documents `.ds-markdown` as the assistant Markdown container and `.ds-think-content` as reasoning content to exclude;
- documents DeepSeek virtual-list behavior and message identity fallbacks.

Implication:
- current DeepSeek output can be observed from DOM mutations without depending on private completion transport internals;
- virtualized DOM means message identity/dedup must be explicit.

### logicwahid/deepseek-memory

Repository: https://github.com/logicwahid/deepseek-memory

Why relevant:
- DeepSeek-specific MV3 extension;
- uses both MAIN-world fetch/XHR interception and `MutationObserver` DOM scanning/tag cleanup;
- model emits textual tags such as `<BDS:memory_write>` that the extension consumes.

Implication:
- MAIN-world interception is viable when request mutation/interception is actually required;
- textual model tags plus DOM handling are already proven patterns on DeepSeek;
- interception should not be retained merely because it is technically possible.

### EdgeTypE/better-deepseek

Repository: https://github.com/EdgeTypE/better-deepseek

Why relevant:
- mature DeepSeek extension with textual tool tags;
- supports automatic tools and MCP-style calls through tags such as `<BDS:AUTO:MCP ...>`;
- release history specifically mentions send-button detection/retry fixes and escape-character handling fixes;
- shows that browser-side tool-result continuation on DeepSeek is a real product pattern.

Implication:
- this is the closest product-level analogue to DeepSeek WebMCP;
- exact send/composer/tool-tag code should be inspected locally before redesigning our continuation logic.

### xihe-lab/deepseek-mcp-server

Repository: https://github.com/xihe-lab/deepseek-mcp-server

Why relevant:
- automates a logged-in DeepSeek browser through Playwright/CDP;
- supports send/reply/history as MCP tools.

Implication:
- proves real-browser automation is feasible;
- architecture is heavier than the desired extension-first V1 and should be treated as a contrast, not a migration source.

### huermi/dsh-deepseek-web-adapter

Repository: https://github.com/huermi/dsh-deepseek-web-adapter

Why relevant:
- free DeepSeek Web adapter using a persistent real browser;
- implements tool-call text parsing and continuation;
- explicitly states that DeepSeek Web UI changes can break selectors and that multi-turn tool loops are not yet fully validated.

Implication:
- useful evidence about selector brittleness and tool-call formatting;
- its gateway/browser-driver architecture is outside this project's intended boundary.

## General MV3 references

Several current Chrome MV3 projects use a split MAIN-world network hook plus ISOLATED bridge when they genuinely need network capture, including:
- https://github.com/pedro-morago/screen-recorder-qa
- https://github.com/DahamDissanayake/API-sniffer-extension
- https://github.com/cerokuo/token-lens
- https://github.com/deviationist/timegpt

Important lesson: MAIN-world interception is a valid technique, but long-lived stream/capture state should not be assumed safe in a service-worker global. One reference explicitly accumulates recording data outside the service worker because the worker may die mid-recording.

## Official Chrome guidance

Relevant official documentation:
- https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/develop/concepts/messaging

Confirmed points:
- `world: "MAIN"` shares the host page's JavaScript environment and is appropriate when interception of page JS APIs is required;
- ordinary isolated content scripts retain extension APIs and are safer for normal DOM work;
- MV3 service workers are ephemeral and global variables are not durable state;
- state that must survive worker reconstruction belongs in extension storage.

## DeepSeek official guidance and product risk

No official DeepSeek documentation was found that documents a supported browser-extension integration surface for `chat.deepseek.com` internals. DeepSeek's documented developer integration path is its API/Open Platform.

Current DeepSeek Terms of Use:
https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html

The Terms include restrictions concerning reverse engineering and automated capturing/copying of Service content. This creates a compliance/distribution risk for browser automation. Before packaging or public distribution, the project should explicitly review the then-current DeepSeek terms and decide whether the intended product model is acceptable. This is separate from the current local P1 technical experiment.

## Provisional P1 conclusion

The current P1 requirement is narrow:

`completed DeepSeek assistant text -> strict tool-tag parse -> fake result -> normal composer -> normal Send -> next assistant turn`

For that requirement, external evidence currently favors a DOM-first architecture over private-SSE reconstruction:
- observe the assistant DOM with a narrow `MutationObserver` or bounded polling;
- detect generation completion from an explicit stop-generation UI signal plus stable final assistant text;
- extract only the newest completed assistant response;
- parse the existing strict text protocol;
- drive the real composer/send control;
- keep ARMED authority/orchestration in the service worker, but do not move streaming response reconstruction through it.

This is not yet an implementation decision. Before changing code, inspect the exact current DeepSeek adapters/selectors/tool-tag handling in the reference repositories and compare them line-by-line with this repository.

## Source-level inspection (2026-09-15)

Shallow clones outside this repository: ai-council `66512be`, better-deepseek `f78576b`, deepseek-memory `9a50b22`, deepseek-anti-retract `ea97964`, deepseek-mcp-server `1c3952c`, dsh-deepseek-web-adapter `43b4c17`. Nothing was vendored.

| Reference / path | What it does | Relevance |
| --- | --- | --- |
| ai-council `config/selectors/deepseek.json` | `input`: `textarea[placeholder*='Message DeepSeek']` (English-only), `textarea._27c9245` (hash), `textarea.ds-scroll-area`; `send`: `div.ds-button.ds-button--primary.ds-button--filled.ds-button--circle`; `response`: `div.ds-markdown`; `completion`: `div.ds-button--primary.ds-button--circle:not(.ds-button--disabled)` | Confirmed live: circle send/stop control and class-based disabled state. Its `div.ds-markdown` would also match the reasoning block's markdown. |
| ai-council `utils/automation/genericAdapter.ts` `waitForResponseCompletion` | Pure DOM: `MutationObserver(document.body)` + 500 ms `setInterval`; completion = stop control seen then gone for 6 s, else text stable 6–10 s, then 2 s post-verify | No network interception anywhere in the adapter. Lesson adopted: require an observed generation before completion. |
| ai-council `utils/automation/adapterHelpers.ts` `setInputText`, `isDisabled`, `clickElement` | Textarea native value setter + `input`/`change`, deletes React `_valueTracker`; disabled = attribute or `*-disabled` class token | Native setter + `input` alone was sufficient live; `_valueTracker` not needed so far. |
| better-deepseek `src/content/message-processor.svelte.js` (~L630–L800, `isSystemGenerating` ~L1218) | Parses AUTO tags from DOM text of the latest assistant message; runs them only when stop icon (`.ds-icon-stop*` or svg path `M2 4.88…`) is absent; per-message handled-key Sets; documents that the stop icon hides while the composer has text | Closest analogue. Tool detection is DOM-based, not SSE. Stop path `M2 4.88` confirmed live. |
| better-deepseek `src/content/auto.js` `findChatEditor`, `setChatInputText`, `findSendButton`, `sendCurrentChatInputResult` (~L778–L1215) | Composer selectors (`textarea#chat-input` first); send finder via labels, svg paths `M8.3125…`, composer-relative icon buttons; send retries every 200 ms up to 120 s with Enter fallback after 1.2 s and over-limit detection | Retry-until-enabled lesson adopted (bounded to 3 s). `#chat-input` absent in current build. Enter fallback and over-limit fallbacks not adopted (not needed by P1 evidence). |
| better-deepseek `src/content/parser/json-repair.js`, `dom/message-text.js` | Loose JSON repair of mangled escapes; prefers `pre code` textContent because code blocks preserve text verbatim | Confirms DOM escape mangling is real. Loose repair rejected for WebMCP (strict parser); fenced calls adopted instead, verified live. |
| better-deepseek `src/injected/xhr-patch.js`, deepseek-memory `src/injected/xhr-patch.js` | Patch `XMLHttpRequest` (and fetch) to mutate completion requests; better-deepseek also captures the Authorization header | Evidence that DeepSeek uses XHR. Their interception exists to mutate requests/capture tokens, which WebMCP forbids; not adopted. |
| deepseek-anti-retract `content.js` | `MutationObserver` + 300 ms polling over `.ds-markdown`, skip `.ds-think-content`, identity via `[data-virtual-list-item-key]` then hash classes | Virtual-list key exists live but a new message briefly had key `-2`; not used as identity. |
| deepseek-mcp-server `src/tools/chat.ts` | Playwright over `dslc-reply-wrapper` / `dslc-markdown` | Selectors absent in the current build; contrast only. |
| dsh-deepseek-web-adapter `resources/dsweb-gateway.js` | Asks the model to emit tool calls in a ```tool_call fence | Independent support for fenced calls. |

Updated conclusion: the provisional DOM-first recommendation is confirmed and implemented; see `docs/p1-browser-findings.md` Finding 8. SSE observation is not required for P1.

## Better DeepSeek freshness check (2026-09-15, after Finding 10)

Fresh clone of `main`: HEAD `f78576bb8b7dfcf6a20d0ffb4fcf5227817b3ada`, committed 2026-09-11 ("Add Nix extension to text file handling"). Latest release/tag `v0.1.13` (2026-08-26, "Critical Hotfix" for issue #154). Same HEAD as the earlier shallow clone, so the earlier source reading was current.

- The hotfix commit `c0eaf6c` changed DOM-mutation safety (child-host pattern, `withObserverPaused`, `CHAT_OBSERVER_OPTIONS = { subtree, childList, characterData }`). It did **not** change `isSystemGenerating`, the Stop selectors, `auto.js` send detection or send retries.
- Generation detection was last changed in `e1f39f0` (2026-08-15, before the hotfix): `src/content/message-processor.svelte.js` `isSystemGenerating()` = any of `.ds-icon-stop-circle`, `.ds-icon-stop`, `div[role="button"] svg path[d*="M3 3h10v10H3z" | "M6 6h12v12H6z" | "M2 4.88"]` (also `extension/remote-config.json` `selectors.stopButton`), with a composer-text fallback (`.ds-cursor`, `_streaming`, action buttons, text growth within 30 s grace / 5 s idle).
- Auto/tool tags run in `processMessageNode` only when `!isSystemGenerating()`; scans are triggered by the `MutationObserver` in `src/content/scanner.js` `observeChatDom()` (debounced 60–100 ms), with a 3 s re-scan timer if generation is not done.
- Composer: `src/content/auto.js` `findChatEditor()` (`textarea#chat-input`, `.ds-textarea textarea`, …, `textarea[placeholder]`). Send: `findSendButton()` (explicit labels, svg paths `M8.3125`/`M13.12 19.98`, composer-relative icon buttons); disabled via `ds-button--disabled`/`ds-icon-button--disabled`/`*--disabled`; `sendCurrentChatInputResult()` retries every 200 ms up to 120 s with an Enter fallback after 1.2 s.

| Signal | Latest Better DeepSeek | Current live DeepSeek (Finding 11) | Match? |
| --- | --- | --- | --- |
| Stop selector | `.ds-icon-stop*` or `div[role=button] svg path[d*=…]` | no `ds-icon-*` class; only the path | partly (path variant only) |
| Stop SVG/path | `M2 4.88` (plus two square paths) | `M2 4.88C2 3.68…` | yes (`M2 4.88`) |
| Send control | label / svg-path search over `div[role=button], button` | one `div[role=button].ds-button--primary.ds-button--circle`, path `M8.3125…` | yes |
| Disabled state | `ds-button--disabled` / `ds-icon-button--disabled` / `*--disabled` | `ds-button--disabled` | yes |
| Composer selector | `textarea#chat-input` first, `textarea[placeholder]` later | no `#chat-input`; `textarea[placeholder]` | fallback only |
| Final-answer selector | `.ds-message` + role hash classes, `.ds-markdown` after removing `.ds-think-content` | `.ds-markdown.ds-assistant-message-main-content` | compatible, not identical |
| Completion condition | Stop absent, evaluated on MutationObserver-driven scans (+3 s re-scan) | Stop visible 679 ms for a short reply | yes, and it explains why their mutation-driven check works while our polling did not |

Adopted: mutation-triggered evaluation (the condition Better DeepSeek actually runs on). Not adopted: `#chat-input`, `.ds-icon-stop*` (absent live), the composer-text fallback (not needed while P1 keeps the composer empty), send retries beyond 3 s, Enter fallback, loose JSON repair.

## Next recommended action

Use a local coding agent with direct Git/filesystem access to:
1. clone the reference repositories to a temporary location;
2. inspect their actual DeepSeek source, not only READMEs;
3. identify current selectors and completion logic;
4. compare with this repo;
5. recommend the smallest P1 change;
6. only then implement if the evidence is strong.

Do not start P2, modify Base/Plus, commit, or push as part of this research.
