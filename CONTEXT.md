# DeepSeek WebMCP — Project Context

Status: P1 browser-loop proof is CLOSED/PASS in Google Chrome. P2 Native Messaging + isolated local runtime is implemented and passes automated checks; integrated macOS Chrome + Docker live acceptance is pending. Actual code and validated browser behavior remain authoritative when they conflict with an assumption here.

## 1. Identity

- Product: **DeepSeek WebMCP**
- Repository: `zengtao227/deepseek-webmcp`
- Local project: `~/Doc/My code/deepseek-webmcp` (exposed to WebMCP as `/workspace/My code/deepseek-webmcp`)
- Independent from WebMCP Base and WebMCP Plus
- Not DeepSeek Harness
- Not a DeepSeek API wrapper
- Not a server-side automation service for DeepSeek accounts

## 2. Core objective

Use the user's already logged-in free `https://chat.deepseek.com` web experience as the AI model and governance layer for local coding work.

The intended loop is:

```text
DeepSeek Web
  → completed assistant output
  → strict textual WebMCP tool request
  → DeepSeek WebMCP extension
  → approved local execution boundary (P2+)
  → bounded/sanitized tool result
  → normal DeepSeek Web input + Send
  → DeepSeek continues the same conversation
```

P1 deliberately replaces the local execution step with a fake tool result. The project must prove the browser continuation loop before investing in the local runtime.

## 3. Non-negotiable product choices

- No DeepSeek API key.
- No DeepSeek Harness dependency.
- Do not export browser-managed DeepSeek credentials.
- Do not implement or replay DeepSeek PoW.
- Do not maintain private DeepSeek `parent_message_id`/completion lifecycle ourselves.
- Do not originate DeepSeek private completion requests from the extension.
- Normal webpage request/session mechanics remain the responsibility of `chat.deepseek.com`.
- V1 is local-user software: one user, their browser, their logged-in account, their machine.

## 4. Trust and data boundary

The DeepSeek page and model are not trusted authorization authorities. Page/model output is data to validate, not permission to expand local access.

When a later local runtime is connected, any workspace content that the user authorizes the model to read may be transmitted to DeepSeek. Secret scanning is defense in depth; it is not a proof that confidential source or arbitrary sensitive text cannot leave the selected workspace. The primary confidentiality boundary is therefore the workspace/root the user chooses to expose.

Only mount code/data the user is willing to make available to the DeepSeek model.

## 5. Browser control model

Local tool execution is disabled unless the user explicitly ARMS WebMCP for the current DeepSeek tab/conversation.

P1/P3 invariants:

- ARMED state is scoped to the current tab/conversation.
- MV3 service-worker reconstruction preserves the current armed epoch through session-only extension storage; extension reload/update/disable, browser restart, tab close, or conversation change fails closed to DISARMED.
- Parse only new, completed assistant output produced while ARMED.
- Deduplicate already-seen message/call identities.
- Bound agent-loop iterations and tool calls.
- Tool-result text must neutralize literal tool-call markers before being returned to the page.
- The page cannot grant broader local permissions through prompt content.

V1 aims for autonomous coding after the user arms a conversation; per-tool manual approval is not a default requirement.

## 6. Observation and continuation

Decided 2026-09-15 (see `docs/p1-browser-findings.md` Finding 8): **rendered DOM only**, observed from one ISOLATED content script.

- Passive network/SSE observation was deleted. Live DeepSeek Web sends all `/api/v0/` traffic, including `/api/v0/chat/completion`, through `XMLHttpRequest`; the former `window.fetch` hook never fired. The extension must not hook or originate DeepSeek network traffic.
- Tool calls whose JSON contains escapes must be emitted inside a fenced code block; unfenced Markdown rendering was measured to drop JSON backslash escapes, which then fails closed as invalid JSON.
- Continuation uses the normal DeepSeek Web composer and Send control.

## 7. Local runtime direction (P2+, not implemented in P1)

Preferred browser-to-local transport is Chrome Native Messaging, subject to real implementation validation.

The eventual local runtime should preserve the proven minimal WebMCP development primitives:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

Security direction:

- fixed `/workspace`-style root contract;
- canonical path/symlink checks;
- isolated non-root container;
- `CapDrop=ALL` and `no-new-privileges`;
- no Docker socket mount;
- V1 runtime network disabled;
- result Secret Firewall outside the model-controlled runtime;
- Native Messaging host accepts protocol messages only, never model-selected host argv/container/root paths.

Chrome Native Messaging host-to-extension message size and the measured DeepSeek input limit will jointly determine the real result-size budget. Do not assume Base limits transfer unchanged.

## 8. Explicit non-goals for V1

- DeepSeek API execution
- DeepSeek Harness
- multi-account pools or server farms
- unofficial DeepSeek API proxying
- Plus multi-host routing
- broad browser automation framework
- generic computer control
- plugin ecosystem
- task/session database
- autonomous background daemon platform
- speculative provider abstraction
- extra MCP tools that duplicate `bash`

## 9. Canonical source and migration policy

Initial reusable assets come only from WebMCP Base commit `73249af`.

The old Base DeepSeek spike is evidence and source material, not the target architecture. In particular, its private-completion continuation/PoW direction is rejected for this project.

No runtime dependency from this repository back to a sibling WebMCP checkout is allowed. Any code intentionally reused must be copied/adapted into this repository with provenance recorded in `docs/migration-manifest.md`.

## 10. Current phase gate

P1 is CLOSED/PASS in real Google Chrome. Acceptance evidence includes:

1. three consecutive automatic tool turns completing through the normal DeepSeek composer/Send path;
2. strict malformed/unfenced JSON failing closed;
3. fenced escape-heavy JSON succeeding without loose repair;
4. refresh/re-render not replaying old calls;
5. DISARMED ignoring a valid tool call;
6. route change DISARMing the conversation;
7. no extension-originated DeepSeek private completion request or credential extraction.

P2 is now the active gate. The implemented target is a narrow one-shot Chrome Native Messaging bridge to a fresh, network-disabled, read-only Docker runtime for each call. The live proof is limited to `open_workspace`, harmless `read`, and bounded `bash`; `write/edit` remain P3. See `docs/p2-review-brief.md` and `docs/p2-live-test.md`.
