# Migration / provenance manifest

Canonical source repository: `/workspace/My code/webmcp-bridge`
Canonical source commit: `73249afc364b0ecb363c8a9db4462f91f938fe75`

`webmcp-bridge-plus` is not a source; its relevant provider/browser files were verified identical to Base before this repository was created.

## P0

No production code migrated.

## P1

| Source path at `73249af` | Treatment | Status |
| --- | --- | --- |
| `extension/tool-loop/tool-call-format.js` | copied then trimmed to parser-only surface | migrated |
| `tests/tool-call-format.test.js` | adapted to parser-only P1/P2 surface | migrated |
| `extension/deepseek/page-adapter.js` | initially adapted; removed after DOM-first decision | removed |
| `extension/deepseek/stream-accumulator.js` | initially adapted; removed after DOM-first decision | removed |
| `extension/deepseek/event-controller.js` | reference only | not migrated |
| `extension/deepseek/bridge.js` | trust-boundary reference only | not migrated |
| `extension/mcp/*` | old remote HTTPS/OAuth MCP architecture rejected | not migrated |

## P2 reused Base core

The following provider-neutral Base mechanisms were deliberately reused. Files marked unchanged still match canonical Base byte-for-byte; adapted files have the original Base SHA recorded for provenance.

| Base source path | Base SHA-256 | Target treatment |
| --- | --- | --- |
| `gateway/path-policy/index.js` | `5f3d1994328b42ac61d69fb7e778c2737a459ed6dcaff28db2dda65bea12f52b` | REUSE UNCHANGED |
| `gateway/secret-scanner/index.js` | `db379b94372d9ddd93c6280c74c3e47ac50c54e85980ea1319de1acb5749e465` | REUSE UNCHANGED |
| `native/src/server.js` | `b2acd4c74a926b883e5553c05adf0fb64c35b2c1c3f449b64ad354fee824d0d9` | REUSE UNCHANGED; P2 host blocks `write/edit` before container spawn |
| `native/src/workspace.js` | `b67ea407b35b49678b6a4c836cdc7496fb1297d63750235e2be4a1446e005973` | REUSE/TRIM; provider-specific workspace instruction replaced with neutral P2 text |
| `native/host/firewall.js` | `712d0ed3bb64f16e4eac5c81d5645f99f682c2f166b924a2d98e349526e0e2e8` | REUSE UNCHANGED |
| `native/src/stdio.js` | `29681225f34da0358e131074c698992e8d2be744bd70764558a9aeea59daac3d` | REUSE UNCHANGED |
| `native/bin/start.js` | `820bd99e993e22698178c79d50cf4d3acaf2ddc42d31130956f43dc163ac1022` | REUSE/TRIM; fixed runtime token from env + 30s runtime timeout |
| `native/Dockerfile` | `64c4802472cdeea43b26b7a933f15b11cda48f7707759e885a6f8744f4d4d900` | REUSE UNCHANGED |

Base tests for path policy, secret scanner, host firewall, native server, stdio, and workspace runtime were also ported/adapted into this repository and now run under `npm run check`.

## P2 new DeepSeek-specific adapters

These are new code, not copied from Base:

- `extension/native-client.js` — one-shot `chrome.runtime.sendNativeMessage` client and P2 tool allowlist.
- `native/host/chrome-framing.js` — Chrome Native Messaging framing and 512 KiB response cap.
- `native/host/docker-dispatch.js` — exact request envelope, independent host allowlist, stable workspace token, fixed isolated/no-network Docker argv, one-shot dispatch and result firewall.
- `native/host/chrome-host.js` — one-frame Native Messaging process entrypoint.
- `scripts/install-p2-native-host.mjs` — owner-only macOS Chrome development installer.

## P3 reuse / changes

P3 does not migrate a new subsystem. It reuses the existing five-tool Base runtime already present from P2 and makes the minimum phase-gate changes:

- extension allowlist expands from `open_workspace/read/bash` to exactly `open_workspace/read/write/edit/bash`;
- native-host allowlist expands to the same five tools and keeps exact per-tool top-level argument names;
- the owner-selected `/workspace` Docker bind changes from read-only to writable so mutations persist to the host workspace;
- the writable bind uses Base's existing `bind-recursive=disabled` pattern so nested host mounts are not pulled into the workspace boundary;
- `native/src/workspace.js` write/edit/path/symlink logic is reused rather than replaced;
- Secret Firewall remains after the runtime for both successful results and tool errors.

No Git publication, credentials, extra discovery tools, persistent runtime, or Base/Plus modification is introduced.

## Explicitly not migrated for P2

| Base component | Reason |
| --- | --- |
| `native/deploy/container-controller.js` | long-lived container lifecycle unnecessary; P2 uses fresh `--rm` container per call |
| `native/deploy/image-pin.js`, `workspace-config.js` | P2 installer stores one fixed local image ID and one canonical workspace root |
| `native/host/relay.js`, `native/host/start.js` | long-lived tunnel/relay and elevated lifecycle not needed |
| elevated access / Git publication / control-plane deployment stack | out of scope for P3 |
| menubar app | packaging concern, not P2 |
| remote MCP/OAuth/StreamableHTTP extension code | wrong transport/product architecture |
| OpenAI Tunnel Runtime / tunnel-client | provider/product-specific and unnecessary |

## Base / Plus cleanup timing

Do not remove the old DeepSeek-related code from WebMCP Base or Plus while DeepSeek WebMCP is still being built. Finish DeepSeek WebMCP through its coding E2E gate first; then clean Base and Plus as a separate reviewed task so the new project is the sole DeepSeek implementation and generic reusable mechanisms are not accidentally deleted during migration.

## ChatGPT Embedded Panel reference review

ChatGPT Embedded Panel has been extracted into the independent sibling project `../chatgpt-embedded-panel/`. DeepSeek WebMCP no longer owns or runs that implementation.

Before extraction, `SillySerpent/Dichrome` commit `e927d6a12542dfeb33b275b77cc5ba9c38430632` (Apache-2.0) was reviewed as a reference for session-scoped ChatGPT framing, route persistence, reconnect/recovery, and companion-window fallback. No Dichrome production file was copied.

### Browser WebMCP code lineage

At extraction time, the standalone project copied `extension/browser-client.js` and `extension/target-executor.js` unchanged as the proven Browser WebMCP V1 baseline. The standalone project now owns its own copies, tests, task binding, ChatGPT adapter, and release lifecycle; there is no runtime dependency between it and DeepSeek WebMCP.

## Shared webmcp-runtime consumption (2026-09-24)

DeepSeek consumes the provider-neutral `webmcp-runtime` as a pinned release artifact (`runtime.lock.json`: artifact id, archive sha256 and download URL, the URL filled in when the archive is published), not as copied source. `install.sh` downloads both the adapter and the runtime archive; `scripts/build-release.mjs` packs the adapter with `git archive`.

- Installer (`scripts/install-p2-native-host.mjs`): installs the pinned release into the shared release store without touching the default instance's `current`, pins instance `deepseek` to that artifact id, and builds the image with `buildNativeImageFromRelease` (instance image pin, DeepSeek tag, digest-pinned base image, `safe.directory`).
- Full Host Access (`native/host/host-access.js`): resolves only through the artifact id in the adapter's own `runtime.lock.json` and the `deepseek` instance pin; approval comes from the runtime's `local-approval.js`. There is no dependency on an installed Bridge release or its `installer.js`.
- Tool calls (`native/host/docker-dispatch.js` + `native/host/runtime-bootstrap.js`): DeepSeek keeps its one-shot, network-less, non-root policy wrapper and starts the image's runtime modules with a mandatory runtime token, the 30 s command cap and DeepSeek's workspace instruction.
- `native/src/*`, `native/bin/start.js`, `native/Dockerfile` and `gateway/path-policy` in this repository are no longer used by installs; they are deleted after the browser-core migration (plan step D5).

## ChatGPT Web Adapter (Web Provider Mode, 2026-09-25)

- `extension/content-chatgpt.js`: adapted from this repository's `extension/content.js` (worker protocol, completion detection, answer structuring and folding kept); the page layer (composer, send/stop, answer turn) replaced with selectors and ProseMirror write logic from `chatgpt-embedded-panel-dev` `7ae86f7:embedded-chatgpt.js`, extended for the textarea / `li[data-message-role]` ChatGPT UI seen live on 2026-09-25.
- `extension/frame-policy.js`, `extension/embedded-chatgpt.js`, `extension/model-probe.js`, `extension/model-status.js` (and `tests/model-probe.test.js`, `tests/model-status.test.js`, import paths only): copied unchanged from `chatgpt-embedded-panel` (`frame-policy.js` gains the panel-frame sender check below the copied rule). `scripts/check-panel-copy.mjs` verifies this.
- `extension/sidepanel-chatgpt.html` / `.js`: copied from `chatgpt-embedded-panel` `sidepanel.html` / `sidepanel.js`; changes are listed in `docs/web-provider-dev-plan.html` (message names, Provider selector, Requested line removed on the owner's request, Work-changed relay).
- `openCompanionWindow` in `extension/background.js`: copied from `chatgpt-embedded-panel` `service-worker.js`; the companion ChatGPT tab also gets Work.
- `extension/deepseek-model.js`, `extension/panel-header.js`: new (DeepSeek model/mode adapter; shared Provider selector).
