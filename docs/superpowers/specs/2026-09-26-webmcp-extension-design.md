# WebMCP Extension — one extension, one App

Date: 2026-09-26. Status: design approved by the owner; not implemented.

## Decision

WebMCP ships as exactly two things:

- **WebMCP Extension** — the only browser extension. Its Side Panel picks a Provider: DeepSeek, ChatGPT web, ChatGPT (MCP mode), Prism, and later providers of the same shape.
- **WebMCP App** — the only local control surface (menu bar): instances, folders, per-folder Write, Host Access grant/revoke.

The standalone DeepSeek, ChatGPT Embedded Panel and Prism extensions stop as release lines. Their mature code is the reuse source. The planned DeepSeek v0.7.1 was cancelled before publishing.

Access has two levels everywhere: mounted folders with per-folder Write, and Temporary Full Host Access — High Trust (`host_command` only; the container never changes). Runtime v0.3.0 implements it.

## Base and repository

- Base: this repository's `feat/web-provider-chatgpt` extension ("WebMCP Web Provider"). It has the most mature tool loop and already carries DeepSeek and ChatGPT web.
- Repository: rename GitHub `deepseek-webmcp` to **`webmcp-extension`** (history kept; GitHub redirects old URLs). `chatgpt-embedded-panel` and `prism-webmcp` are archived once their code has moved.
- The extension keeps its current manifest key (extension ID), so nothing that already trusts it has to change.

## Components

### Browser side (the extension)

| Unit | Source | Role |
|---|---|---|
| Side Panel shell + Provider picker | this repo (`sidepanel*.js`, `panel-header.js`) | one panel; header shows Provider, workspace, Access line with Revoke |
| DeepSeek adapter | this repo `content.js` | web-provider tool loop in a DeepSeek window |
| ChatGPT web adapter | this repo `content-chatgpt.js` + embedded page (`embedded-chatgpt.js`, `frame-policy.js`) | web-provider tool loop inside the panel's embedded chatgpt.com |
| ChatGPT MCP mode | ChatGPT Embedded Panel (embedded page + `chrome-native-bridge.js`) | tools arrive over the Secure MCP Tunnel; the panel only hosts the page and the Browser MCP bridge; no tool loop |
| Prism adapter | `prism-webmcp` `prism-dom.js` | ported from its popup extension to a Provider of the panel |
| Browser tools | `browser-client.js`, `target-executor.js`, `browser-task.js` (frame-aware since 2026-09-26) | one copy; today three byte-identical copies exist |
| Core loop | `core/`, `tool-loop/` | unchanged |

The Side Panel keeps no Folder, Full access or High Trust settings: those live in the App. The panel shows access and offers Revoke only.

### Local side

- One WebMCP instance for the whole extension, id **`webmcp`**, shown in the App as **"WebMCP Extension"**. All web providers share its folders, Write switches and Host Access; switching Provider revokes Host Access.
- The extension's local program (native host `com.webmcp.extension`) runs the workspace tools through that instance's host relay (`start.js`), reads status and revokes through the instance controller, and gates `host_command` on the instance lease. This is the shared-instance work S1–S4 already written on `feat/shared-instance-workspace` (instance id and host name renamed).
- ChatGPT MCP mode keeps the `default` instance and its tunnel service, unchanged.
- The Browser MCP bridge (`com.webmcp.browser` + the browser-tunnel service) stays as it is; the extension connects to it for ChatGPT MCP mode.
- Removed: native hosts `com.deepseek.webmcp.native` and `com.prism.webmcp.native`, the `deepseek` and `prism` instances (migrated), `~/deepseek-webmcp`, `~/.deepseek-webmcp`.

### Migration (owner's Mac first, then Setup)

1. Provision the `webmcp` instance (pinned runtime v0.3.0, its own image pin and container).
2. Move folders into its `workspace-mounts.json`: the old `deepseek` instance root, the old `~/.deepseek-webmcp` folder (Write ON, as it was writable), and the `prism` instance's folders (with their Write switches). A folder already present keeps its switch; a re-run changes nothing.
3. Register `com.webmcp.extension`; remove the two old host registrations; remove the `deepseek` and `prism` instances and old program folders.
4. Everything is checked before the first write (active lease, folders the runtime refuses); a failure rolls back files and removes only the new instance's container.

### Install without Docker Hub (owner decision 2026-09-26)

Some testers' networks block Docker Hub entirely (seen on an Intel Mac: registry-1/auth/CDN time out, IPv4 and IPv6, with or without a proxy-mode VPN). Installs therefore never touch Docker Hub:

- The Dockerfile has no `# syntax=` line (nothing in it needs the external frontend).
- The pinned `node:22-bookworm-slim` base image is served from the WebMCP download server as a `docker save` archive, checked by SHA256, then `docker load`ed; builds use its local tag. Verified: a build `FROM` a local-only tag needs no registry.
- One archive is enough: it holds both amd64 and arm64 (the two per-arch archives made on 2026-09-26 carry identical content).
- The loaded image is accepted if its ID is one of: the index digest `sha256:83f487e0…` (containerd image store), the amd64 config digest `sha256:6e626115…`, or the arm64 config digest `sha256:97aaa653…` (classic store). Pinning only the index digest would refuse installs on the classic store.
- Reference implementation (drafted on the old P1 line, not merged): `~/Doc/webmcp-bridge-work/base-image-reference/` (patches for runtime, Bridge, DeepSeek, Setup; archive builder). Archives: `~/Doc/webmcp-bridge-work/base-images/`.
- Where it lands: the runtime's `buildNativeImageFromRelease` (used by the extension's local program, E1) and the Bridge installer (ChatGPT MCP, E2); Setup downloads, verifies and loads the archive (E4).

## Phases (each accepted on its own)

| Phase | Scope | Accepted when |
|---|---|---|
| E1 | Repo rename; merge `p1/two-access-levels` and S1–S4 into the base; instance `webmcp`; host `com.webmcp.extension`; remove panel settings (S5/U2); migration of the `deepseek` instance and `~/.deepseek-webmcp` | App shows "WebMCP Extension" with Add Folder, Write ON/OFF and Host Access; DeepSeek and ChatGPT web complete a real tool call through the instance |
| E2 | ChatGPT MCP mode moved in (embedded page + Browser MCP bridge); ChatGPT Embedded Panel archived | ChatGPT MCP works from the one extension, including Browser tools and iframes |
| E3 | Prism adapter; Prism folders migrated; `prism-webmcp` archived | Prism completes a real tool call from the panel |
| E4 | WebMCP Setup installs only the App + this extension (base image from the download server, no Docker Hub); migrates old installs (the ChatGPT installer skips an existing install, so migration is explicit); VPS tester links resume | fresh install with Docker Hub unreachable, and migration from the old three-extension layout, both pass in isolation |

## Acceptance (whole)

- The App lists only "ChatGPT Side Panel" (MCP, `default`) and "WebMCP Extension" (`webmcp`).
- Four Providers selectable in one Side Panel, each completing a real tool call.
- Browser tools, including accessible iframes, work for every Provider.
- The three old extensions and their native hosts are gone with no lost capability.

## Constraints

- No new permission level; no provider-specific settings or installers.
- Shared code has one copy; no byte-identical copies across repositories.
- The panel never grants authority; only the App does, behind the macOS approval.
- Nothing is published or distributed before the owner approves each release.
