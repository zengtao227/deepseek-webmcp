# Threat model

## Security objective

Use DeepSeek Web as the reasoning/UI layer without letting page/model content silently obtain broader local authority or browser credentials.

## P1 assets

- DeepSeek browser/session credentials;
- browsing data outside the DeepSeek tab;
- extension ARMED state and deduplication state;
- integrity of the fake tool-loop protocol.

P1 deliberately has no local source-code/filesystem/terminal authority.

## Trust boundaries

```text
untrusted DeepSeek page/model output
        ↓
strict extension parser + ARMED gate
        ↓
P1 fake tool executor
        ↓
marker-neutralized fake result
        ↓
normal DeepSeek compose/send UI
```

## Primary P1 threats

### T1 — Page/model forges a tool call while not authorized

Mitigation: calls are ignored unless the current tab/conversation is explicitly ARMED. The armed epoch is kept only in session-scoped extension storage so MV3 service-worker reconstruction does not silently revoke it; extension reload/update/disable, browser restart, tab close, or conversation change clears authority.

### T2 — Historical/re-rendered message executes again

Mitigation: parse only new completed assistant output in the active armed epoch and deduplicate message/call identity. After extension/browser restart or another authority-clearing event, do not reconstruct execution authority from page history.

### T3 — Malformed or adversarial tool-call payload

Mitigation: strict bounded JSON parser, exact allowed fields, unique bounded call IDs, depth/key/call limits, forbidden prototype-pollution keys and fail-closed malformed markers.

### T4 — Tool-result marker reflection

A returned result can contain the literal WebMCP tool-call marker, especially when inspecting WebMCP-related source/test text.

Mitigation: neutralize literal marker delimiters before inserting results into DeepSeek. Only assistant output, never injected tool-result text itself, is eligible for call parsing.

### T5 — DOM rendering mutates tool-call text

Rendered Markdown/HTML may alter escaping or strip unknown tags.

Measured on live DeepSeek Web: unfenced Markdown drops JSON backslash escapes (`\\"` → `"`), while fenced code blocks preserve them byte-exact.

Mitigation: P1 observes rendered DOM only, requires escaped tool-call JSON to be fenced, and never repairs malformed JSON; mangled calls fail closed as `INVALID_JSON`.

### T6 — Private protocol creep

A passive network observer can slowly become a private DeepSeek client.

Mitigation (P1): no network observer exists. The extension has no MAIN-world script and does not reference `fetch`, `XMLHttpRequest`, `webRequest` or `/api/v0/`; a source test enforces this.

Mitigation: extension code may observe an existing page request if that wins P1, but must not originate completion requests, copy credentials, generate/replay PoW, or manage response lineage.

### T7 — Infinite/expensive loop

Prompt injection or model error repeatedly emits calls.

Mitigation: per-armed-run iteration/call bounds and explicit terminal stop state.

## P2+ threats reserved for later review

Native Messaging framing/identity, host privilege, container isolation, network egress, filesystem scope, Secret Firewall limitations, result-size budgeting and long-running commands are intentionally deferred until P1 passes.
