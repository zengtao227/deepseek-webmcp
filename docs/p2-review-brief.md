# P2 review brief — Native Messaging + isolated local runtime

Date: 2026-09-15
Status: **historical review; P2 later CLOSED / PASS in macOS Google Chrome + Docker on 2026-09-15**
Baseline browser: **Google Chrome**. Comet compatibility is optional and must not complicate the Chrome path.

## 1. What P1 has already proven

P1 is the browser-loop proof. It intentionally used fake tools only.

Real Chrome acceptance now proves all of the following:

- a logged-in `https://chat.deepseek.com` conversation can be explicitly ARMED;
- completed DeepSeek assistant output can be observed from the rendered DOM without hooking DeepSeek network traffic;
- strict textual WebMCP tool calls can be parsed;
- malformed/unfenced escape-heavy JSON fails closed with `INVALID_JSON` and automatically DISARMs;
- fenced escape-heavy JSON survives rendering and parses correctly;
- fake tool results can be written into the real DeepSeek composer and sent through the normal page control;
- three autonomous turns complete end-to-end: `p1_1 -> p1_2 -> p1_3 -> P1 COMPLETE`;
- final evidence was `loops=3`, `lastCode=NO_TOOL_CALL`, previous continuation `SEND_CLICKED`;
- route change DISARMs;
- page reload/history re-render does not replay old calls;
- a valid tool call while DISARMED is ignored (`armed=false`, `loops=0`, no fake result/automatic Send);
- MV3 service-worker reconstruction was proven in a real browser and authority persistence through `chrome.storage.session` passed regression;
- the extension does not originate or hook DeepSeek completion requests and does not read/export DeepSeek credentials.

### Important P1 lessons that P2 must preserve

1. Do not keep authorization state only in MV3 service-worker globals.
2. Do not rebuild DeepSeek private completion/SSE handling.
3. Do not use loose JSON repair; malformed calls fail closed.
4. Do not infer browser behavior from Chromium alone; Chrome is the supported baseline.
5. Prefer current, live-verified DOM behavior over stale selectors/reference assumptions.
6. Do not add complexity without a demonstrated failure.

## 2. P2 objective

Replace the P1 fake executor with a real but narrowly bounded local execution path:

```text
DeepSeek Web
  -> completed strict tool call
  -> DeepSeek WebMCP Chrome extension
  -> Chrome Native Messaging
  -> fixed local native host
  -> fixed isolated Docker runtime
  -> bounded local tool
  -> Secret Firewall / result limits
  -> Native Messaging response
  -> normal DeepSeek composer + Send
```

P2 is not yet the full coding agent. Its live proof is deliberately limited to:

- `open_workspace`
- harmless `read`
- harmless `bash` such as `echo hello`

`write` and `edit` remain disabled until P3 even though the reused Base runtime already contains implementations.

## 3. First-principles reuse decision

Do not invent a second local runtime. Reuse the already-reviewed generic security/runtime mechanisms from WebMCP Base commit `73249afc364b0ecb363c8a9db4462f91f938fe75`.

Reuse/adapt only the provider-neutral core:

- `gateway/path-policy/index.js`
- `gateway/secret-scanner/index.js`
- `native/src/workspace.js`
- `native/src/server.js`
- `native/host/firewall.js`

Do **not** migrate the Base product lifecycle that is coupled to OpenAI/WebMCP deployment:

- OpenAI Tunnel Runtime / `tunnel-client`;
- old browser remote-MCP/OAuth/StreamableHTTP stack;
- Base installer/canary/pinning lifecycle wholesale;
- menubar application;
- Plus routing/multi-host features;
- temporary elevated access or Git publication for P2.

The architecture should be Base security core + a thin DeepSeek/Chrome-specific transport adapter, not a fork of the entire WebMCP product.

## 4. Current staged migration state

Before this review request, five generic Base files were copied **unchanged** into this repository. They are not yet wired into the extension/runtime path.

| DeepSeek WebMCP path | Base source at `73249af` | Current SHA-256 | State |
| --- | --- | --- | --- |
| `gateway/path-policy/index.js` | same path | `5f3d1994328b42ac61d69fb7e778c2737a459ed6dcaff28db2dda65bea12f52b` | copied unchanged, review-only |
| `gateway/secret-scanner/index.js` | same path | `db379b94372d9ddd93c6280c74c3e47ac50c54e85980ea1319de1acb5749e465` | copied unchanged, review-only |
| `native/src/server.js` | same path | `b2acd4c74a926b883e5553c05adf0fb64c35b2c1c3f449b64ad354fee824d0d9` | copied unchanged, review-only |
| `native/src/workspace.js` | same path | `b67ea407b35b49678b6a4c836cdc7496fb1297d63750235e2be4a1446e005973` | copied unchanged, review-only |
| `native/host/firewall.js` | same path | `712d0ed3bb64f16e4eac5c81d5645f99f682c2f166b924a2d98e349526e0e2e8` | copied unchanged, review-only |

No commit or push has been made.

Current `npm run check` still covers only the existing P1 roots (`extension`, `tests`, `scripts`). Its current 23/23 PASS confirms P1 was not regressed by the documentation/staging work, but it does **not** yet validate the newly staged `gateway/` or `native/` files inside this repository. Extending the check/test surface belongs to P2 implementation after review.

## 5. Proposed P2 architecture

### 5.1 Chrome extension

Add only the `nativeMessaging` permission required for the local bridge.

Browser orchestration remains in the existing background worker:

1. receive a validated, deduplicated tool call from the proven P1 DOM loop;
2. allow only the P2 tool subset (`open_workspace`, `read`, `bash`);
3. send one bounded request to the exact Native Messaging host;
4. receive one bounded response;
5. convert it to the existing tool-result text format;
6. continue through the already-proven normal DeepSeek composer/Send path.

No DeepSeek cookies, session tokens, Authorization headers or PoW material are sent to the native host.

### 5.2 Native Messaging host

The host should be intentionally thin.

Responsibilities:

- parse Chrome Native Messaging framing;
- validate the request envelope and tool allowlist;
- reject unknown fields/tools;
- invoke a **fixed** runtime/container command;
- never accept model-selected host executable, Docker image, host path, argv or entrypoint;
- sanitize the container result through the Secret Firewall;
- enforce a host-to-Chrome response budget;
- write protocol frames to stdout only and diagnostics to stderr only.

Native host manifest:

- exact host name, e.g. `com.deepseek_webmcp.native`;
- exact Chrome extension origin in `allowed_origins`;
- no wildcard origin.

Development installation on macOS should write the manifest only to Chrome's per-user NativeMessagingHosts directory. Packaging/general installer work remains P5.

### 5.3 Request/response shape

Do not expose arbitrary JSON-RPC/MCP methods to the browser. The Native Messaging edge should accept one small product envelope, e.g. conceptually:

```json
{
  "version": 1,
  "id": "call-id",
  "tool": "read",
  "arguments": {}
}
```

The host internally maps the three allowed tools onto the reused Base MCP/runtime implementation. This keeps the browser-facing attack surface smaller than exposing the full MCP server protocol.

### 5.4 Isolated runtime

The runtime should execute inside a fresh/fixed Docker boundary derived from Base's proven policy:

- one owner-selected host root mounted as `/workspace`;
- writable mount because later phases need coding, but P2 browser allowlist still exposes only `open_workspace/read/bash`;
- non-root runtime identity using the host owner's UID:GID;
- `--cap-drop ALL`;
- `--security-opt no-new-privileges`;
- `--network none`;
- no Docker socket;
- no device mounts;
- no Git credential mounts in P2;
- fixed image/entrypoint controlled by the product, not by model output.

The copied Base workspace layer supplies:

- `/workspace` contract;
- workspace IDs;
- lexical + realpath checks;
- symlink escape defense;
- bounded file reads;
- bounded command size/output/time;
- restricted shell environment;
- path policy.

### 5.5 Secret Firewall

The model-controlled runtime is not the final confidentiality boundary. Before any result goes back to DeepSeek, the host applies the reused Secret Firewall to the result envelope.

This is defense in depth only. The user-selected workspace remains the primary confidentiality boundary.

### 5.6 Size/time budgets

Current Chrome Native Messaging constraints to design around:

- Chrome -> native host: large enough that it is not the limiting direction for this P2 request shape;
- native host -> Chrome: 1 MiB maximum message size.

P2 should deliberately cap the serialized host response at **512 KiB** instead of relying on the 1 MiB hard limit. No chunking in P2.

The reused Base workspace supports up to 300 s bash timeouts, but P2 should cap browser-originated bash to **240 s maximum** so it remains materially below the usual long MV3 event boundary and does not encourage very long browser-held work.

The measured DeepSeek composer/input limit is still a later sizing gate; P2 proof commands should produce very small outputs.

## 6. Tool policy

### P2 allowed

- `open_workspace`
- `read`
- `bash`

For `bash`, all execution still occurs inside the isolated, network-disabled container. There is no direct host-user shell.

### P2 denied

- `write`
- `edit`
- any unknown tool;
- arbitrary host command execution;
- arbitrary Docker arguments/image selection;
- arbitrary host filesystem root selection from the model;
- network enablement;
- credentials/Git publication;
- browser/computer-control tools.

`write/edit` are deferred to P3 so P2 can prove the transport/security boundary before enabling mutation.

## 7. Workspace selection

The model must never choose an arbitrary host path through a tool call.

P2 should use an owner-configured workspace root outside the model-controlled protocol. The container maps that fixed root to `/workspace`; the model can only call `open_workspace({"path":"/workspace"})`.

For the first live proof, the configured host root can be the DeepSeek WebMCP project or another disposable test folder selected by the user.

## 8. Native Messaging lifecycle choice

Prefer the simplest lifecycle for P2: one request -> one Native Messaging host invocation -> one response.

A persistent `connectNative()` port is not required for the initial P2 proof. One-shot requests avoid inventing a long-lived host/session lifecycle before there is evidence it is necessary.

To make `workspaceId` usable across one-shot host invocations, the host/runtime must use a stable installation/runtime token owned by local configuration rather than generating a new token for every process launch.

If this stable-token approach creates avoidable complexity, the review should explicitly recommend a persistent-port alternative and explain why it is smaller/safer overall.

## 9. Proposed implementation order — deliberately coarse

### Block A — local boundary

In one coherent implementation pass:

- derive the minimal container policy from Base;
- build/run the network-off isolated runtime;
- add a fixed one-shot container dispatcher;
- add Native Messaging framing/validation/firewall;
- add a development-only macOS Chrome host-manifest installer;
- test host allowlist, framing sizes, Secret Firewall, path escapes and container hardening.

### Block B — browser integration

In one coherent pass:

- add `nativeMessaging` permission;
- add one native client module;
- replace fake execution with real P2 calls only for the three allowed tools;
- preserve existing ARMED, loop limits, deduplication and normal DeepSeek continuation;
- keep a clear error result for unavailable/uninstalled native host.

### Block C — live P2 acceptance

One integrated Chrome/DeepSeek test should prove:

1. ARMED DeepSeek asks for `open_workspace({"path":"/workspace"})` and receives a real workspace ID;
2. DeepSeek uses that ID to `read` a harmless known file and receives real content;
3. DeepSeek calls `bash` with `echo P2_OK` and receives `P2_OK`;
4. DeepSeek reaches a final `P2 COMPLETE` response automatically;
5. container network is `none`;
6. a denied `write` or unknown tool fails closed and does not mutate the workspace;
7. a path escape read is denied;
8. a secret-like fixture returned through the host is redacted;
9. no DeepSeek private network/auth material enters the local protocol.

If this single integrated gate passes, P2 is complete. Do not subdivide it into a large series of manual micro-tests unless a failure needs diagnosis.

## 10. Explicit non-goals in P2

Do not add:

- write/edit browser capability;
- persistent task/session database;
- plugin/provider abstraction;
- generic MCP client/server discovery at the browser boundary;
- remote HTTP/WebSocket transport;
- localhost web server;
- keep-alive hacks;
- Comet-specific compatibility work;
- Git credentials/publication;
- elevated host access;
- packaging/uninstaller/auto-update;
- Base/Plus cleanup.

## 11. Review questions for Claude

Please review the plan from first principles and answer:

1. Is one-shot `sendNativeMessage` + stable local runtime token simpler and safe enough, or is a persistent `connectNative()` port actually the smaller design once workspace/session identity is considered?
2. Should the browser-facing native envelope remain a 3-tool product protocol rather than exposing JSON-RPC/MCP directly?
3. Which Base container-policy/deploy mechanisms are truly required for P2, and which should be omitted to avoid importing product-specific complexity?
4. Is 512 KiB host-response cap appropriate for P2 given Chrome's 1 MiB host->browser limit?
5. Is 240 s an appropriate P2 bash maximum, or should the proof use a materially smaller default/max?
6. Is mounting the selected workspace writable acceptable while the P2 browser allowlist denies `write/edit`, or should the P2 container mount be read-only until P3? Consider that `bash` can mutate files even without explicit write/edit tools.
7. Because `bash` inherently allows mutation, should P2's initial proof use a disposable writable workspace, or should P2 expose a restricted command proof instead of full `bash` until P3?
8. Is the exact-origin Native Messaging host binding plus product-side tool allowlist sufficient for the browser/native trust boundary, or is an additional per-install challenge/token justified now?
9. Identify any place where this plan unnecessarily duplicates something already proven in Base.
10. Give a final verdict: PASS / PASS WITH CHANGES / FAIL, and specify the smallest required changes before implementation resumes.

Review only. Do not commit/push and do not start P3.