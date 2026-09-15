# DeepSeek WebMCP — Project Context

Status: P1, P2, P3, and P4 are CLOSED/PASS in Google Chrome. Next is a separately reviewed Base/Plus DeepSeek cleanup; P5 packaging/distribution remains behind its policy/terms review gate. Actual code and validated browser behavior remain authoritative when they conflict with an assumption here.

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

## 7. Local runtime (P2+)

Preferred browser-to-local transport is Chrome Native Messaging, subject to real implementation validation.

The local runtime preserves the proven minimal WebMCP development primitives:

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

The Native Messaging edge caps host responses below Chrome's hard limit; the browser-facing bash timeout remains 30 seconds. P3 keeps one fresh network-disabled container per tool call and makes only the owner-selected `/workspace` bind writable. The bind is non-recursive, so nested host mounts are not imported into the writable boundary.

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

P2 is CLOSED/PASS from the owner's real macOS Chrome + Docker acceptance. P3 is also CLOSED/PASS from the owner's real macOS Chrome + Docker acceptance: the same one-shot Native Messaging path exposed exactly `open_workspace`, `read`, `write`, `edit`, and `bash`; writable changes persisted across fresh containers; edit and bash verification succeeded; path-escape write failed closed; no non-allowlisted tool executed; no call containers remained; Base was untouched; and no commit/push occurred. `bash` remains a workspace mutation path, and no Git credentials or automatic publication capability were added. See `docs/p3-live-test.md`. P4 is CLOSED/PASS: on a disposable Git repository DeepSeek autonomously opened the workspace, read the source, made one bounded edit, ran `npm test` (2/2 pass) and inspected `git diff` in the network-disabled runtime, then answered in five tool calls. The runtime image trusts exactly `safe.directory /workspace` because Docker Desktop shows the bind mount point as root-owned. See `docs/p4-live-test.md`.
