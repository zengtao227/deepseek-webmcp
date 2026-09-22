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

## Local execution boundary

P2+ must not expose arbitrary host-user shell to the browser. The browser may reach only the reviewed local protocol/runtime boundary.

P3 exposes exactly `open_workspace`, `read`, `write`, `edit`, and `bash`. Each call runs in a fresh fixed Docker container with network disabled, non-root UID:GID, all Linux capabilities dropped, `no-new-privileges`, no Docker socket, no devices, and no Git credential mount. The owner-selected workspace is the only writable host bind and nested host mounts are not recursively included.

`write` and `edit` enforce the Native workspace path/symlink policy, but `bash` can also mutate files inside the writable workspace. Therefore the security claim is bounded container/workspace mutation, not that only the structured mutation tools can write.

Because the workspace is writable, host-executed control-plane material must never be writable through it. A selected parent workspace may contain the DeepSeek WebMCP checkout, host config, `~/.docker`, or Chrome `NativeMessagingHosts`; any such protected subtree is explicitly masked from the container. Selecting the control-plane root itself is refused, Node and Docker executables must remain outside the model-writable workspace, and normal home-directory access remains reserved for locally approved Full access.

Residual risk: anything the model writes into the project (for example `.git/hooks`, `package.json` scripts, build files) runs on the host only if you later run it there yourself. Review the diff before running project commands on the host.

Secret Firewall sanitization remains outside the model-controlled runtime before successful tool results or tool errors return to DeepSeek. Secret scanning is defense in depth. The user's selected workspace/root remains the primary data-disclosure boundary because ordinary source text may legitimately be sent to DeepSeek when the model reads it.

The V1 runtime keeps network disabled. Any future outbound network capability requires a separate security decision. Git credentials, automatic commits, and pushes are not part of P3.

See `docs/threat-model.md`.
