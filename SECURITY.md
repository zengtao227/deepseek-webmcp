# Security

DeepSeek WebMCP treats the model, page content, repository content, tool requests and raw local tool output as untrusted.

## P1 boundary

P1 must not have filesystem, terminal, Native Messaging or other local execution capability. It works only with fake tool results.

The extension must not read, copy, persist, log or forward:

- DeepSeek cookies;
- Authorization/Bearer values;
- DeepSeek session/account credentials;
- PoW material;
- unrelated browsing data.

The extension must not originate private DeepSeek completion requests.

## Tool-call safety

A tool marker is data until it passes the trusted extension parser. P1/P3 must:

- require explicit ARMED state for the active tab/conversation;
- accept only new completed assistant output during that state;
- bound calls and loop iterations;
- deduplicate already-executed calls/messages;
- fail closed on malformed markers;
- neutralize literal tool-call markers in returned tool results.

## Later local execution

P2+ must not expose arbitrary host-user shell to the browser. The browser may reach only the reviewed local protocol/runtime boundary.

The planned V1 local runtime keeps network disabled. Any future outbound network capability requires a separate security decision.

Secret scanning is defense in depth. The user's selected workspace/root remains the primary data-disclosure boundary because ordinary source text may legitimately be sent to DeepSeek when the model reads it.

See `docs/threat-model.md`.
