# WebMCP Extension E2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ChatGPT MCP mode runs from the one WebMCP Extension with the same permission model as the web providers, and the old ChatGPT Embedded Panel can be retired.

**Architecture:** The extension gains a third Provider, `ChatGPT (MCP)`: the same embedded ChatGPT page as `ChatGPT (Web)`, with the in-page tool loop off and the Browser MCP native bridge on. The Browser MCP host and server move from the old panel repo into this repo unchanged and are installed with the extension. The `default` instance's Host Access is shown and revoked in the panel like `webmcp`, and the runtime refuses `host_command` on `default` unless a WebMCP MCP panel is open.

**Tech Stack:** MV3 extension (JS modules), Node 22 native hosts, webmcp-bridge (App release + Swift menu bar), `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-26-webmcp-extension-design.md` (E2 row and "E2 blocker: MCP Host Access alignment").

## Global Constraints

- Two access levels only: mounted folders (per-folder Write) and Host Access. No new level.
- The panel never grants; grants happen only in the WebMCP App.
- Owner decisions 2026-09-26:
  - A(b): on the `default` instance, `host_command` fails closed unless a WebMCP `ChatGPT (MCP)` panel is open on this Mac. The signal is the Browser MCP socket answering (the host process Chrome runs only while the panel's native port is connected). It proves an open MCP panel on this Mac, not which tab a connector call came from.
  - B: App label `ChatGPT (MCP)`; selector labels `DeepSeek`, `ChatGPT (Web)`, `ChatGPT (MCP)`.
  - C: remove the old panel's browser registration and archive `chatgpt-embedded-panel` only after full acceptance on the owner's Mac.
- Copied files stay byte-identical and are pinned by hash (as in E1).
- Never load OpenAI/Google login pages inside the panel; log in and out happens in normal windows (E1 root cause, `restorableChatGptUrl`).
- Commit per task; push only after the owner-Mac acceptance (Task 9), except the plan itself.
- Nothing is published or distributed without the owner's approval.

## Facts established during E2 orientation (2026-09-26)

- The embedded page, browser tools (`browser-client.js`, `target-executor.js`), `embedded-chatgpt.js`, `model-probe.js`, `model-status.js` are already identical copies in this extension.
- Missing: `chrome-native-bridge.js` (73 lines), `browser-native-protocol.js` (45) and `browser-mcp/` (6 files, 680 lines) from `chatgpt-embedded-panel` 66dac36.
- Today `com.webmcp.browser` is registered only in Google Chrome, only for the old panel's ID, and its launcher runs from the old dev checkout. Comet has no registration.
- The `com.webmcp.browser-tunnel` LaunchAgent runs `tunnel-client --profile browser-mcp`; `~/.config/tunnel-client/browser-mcp.yaml` starts `~/.chatgpt-embedded-panel/browser-mcp-server`, which talks to the host over `~/.chatgpt-embedded-panel/browser-mcp.sock`.
- `host_command` is gated per call in the runtime's `native/host/host-command.js` (`verifiedLease`). The Bridge ships an identical copy; the App release (the extension's pinned runtime) is built from the Bridge.

---

### Task 1: ChatGPT login and logout follow the normal tabs (carried over from E1)

**Files:** `extension/content-chatgpt.js`, `extension/chatgpt-frame.js`, `extension/sidepanel-chatgpt.html`, `extension/sidepanel-chatgpt.js`, `extension/background.js`; tests `tests/chatgpt-frame.test.js`, `tests/content-chatgpt.test.js`, `tests/background-conversation-key.test.js`.

- [ ] Failing tests:
  - `signedOutAction({ state, path, showing })`: `/auth/login` shows the logged-out screen; `state: 'out'` shows it; `state: 'in'` while it shows reloads; `/auth/logout` does nothing (let the logout finish).
  - The panel content script posts `{ type: 'webmcp:session', state: 'in' | 'out' }` from `/api/auth/session`; a failed fetch posts nothing; the tokens never leave the function.
  - `panel.open-login` opens one popup at `https://chatgpt.com/auth/login` without Work; `panel.close-login` closes it.
- [ ] Implement: logged-out overlay ("Logged out of ChatGPT. The panel uses this browser's ChatGPT login." + `Log in to ChatGPT`). Session check every 30 s logged in / 5 s logged out and on request. On `/auth/login` the frame goes to the home page. On `in` the overlay hides, the login window closes, the frame reloads.
- [ ] `npm run check`; commit `feat: ChatGPT login and logout follow the browser's normal tabs`.

### Task 2: Move the Browser MCP code in unchanged

**Files:** create `extension/chrome-native-bridge.js`, `extension/browser-native-protocol.js`, `browser-mcp/{browser-native-host,native-framing,runtime-paths,server,stdio-server,unix-bridge}.js` (copies of 66dac36); `scripts/build-release.mjs` (ship `browser-mcp/`); test `tests/sidepanel-wiring.test.js` (pin the new copies by hash).

- [ ] Copy byte-for-byte; add the hashes to the "copied files are unchanged" test; port the old repo's unit tests for these modules (`tests/native-browser-runtime.test.js` and the browser-mcp tests) unchanged apart from import paths.
- [ ] `npm run check`; commit `feat: bring the Browser MCP bridge into the extension (copied unchanged)`.

### Task 3: Provider `ChatGPT (MCP)`

**Files:** `extension/panel-header.js` (`PROVIDER_PAGES`, labels), `extension/sidepanel-chatgpt.html` / `.js` (mode from the provider), `extension/background.js`; tests `tests/panel-header.test.js`, `tests/background-conversation-key.test.js`, `tests/sidepanel-wiring.test.js`.

- [ ] Failing tests: selector options read `DeepSeek`, `ChatGPT (Web)`, `ChatGPT (MCP)`; the MCP provider uses the ChatGPT page with Work off; opening it connects the native bridge (`connectChromeNativeBridge` with the existing `runBrowserTool`), closing its panel port disconnects it; `ChatGPT (Web)` never connects the bridge; switching provider still revokes first.
- [ ] Implement with provider id `chatgpt-mcp`; the stored provider `chatgpt` keeps meaning ChatGPT (Web).
- [ ] `npm run check`; commit `feat: ChatGPT (MCP) provider with the Browser MCP bridge`.

### Task 4: The extension installer owns the Browser MCP host

**Files:** `scripts/install-p2-native-host.mjs`, `native/host/local-paths.js`, `scripts/uninstall.mjs`, `native/host/control.js` (uninstall), `scripts/doctor.mjs`; tests `tests/install-layout.test.js`, new `tests/browser-mcp-install.test.js`.

- [ ] Failing tests: install writes `com.webmcp.browser.json` in every installed browser root, allowing this extension's ID (and, until Task 10, the old panel's ID); the host launcher runs `app/browser-mcp/browser-native-host.js`; `~/.chatgpt-embedded-panel/browser-mcp-server` is rewritten to run `app/browser-mcp/stdio-server.js` with the same socket, so the tunnel profile is untouched; all these files are covered by the install rollback.
- [ ] Doctor reports the registration and whether the browser-tunnel LaunchAgent is loaded; uninstall removes this extension's ID from `com.webmcp.browser` (and the file when no other ID remains).
- [ ] `npm run check`; commit `feat: the installer registers the Browser MCP host for this extension`.

### Task 5: Host Access for the `default` instance in the panel

**Files:** `native/host/instance-access.js`, `native/host/control.js`, `native/host/host-access.js`, `extension/panel-header.js`, `extension/background.js`; tests `tests/instance-access.test.js`, `tests/native-host-dispatch.test.js`, `tests/panel-header.test.js`, `tests/background-conversation-key.test.js`.

- [ ] Failing tests:
  - `status` also reports the `default` lease (read through the App release's `installer.js elevate-status`, as the App reads it).
  - The access line shows HOST ACCESS in red with the countdown when either instance has a lease.
  - `stop-host-access` revokes both (`access-revoke --instance webmcp` and `installer.js elevate-stop`); if either fails the control fails and the provider switch stays put.
  - Panel close, a new extension session and a provider switch revoke both (E1 paths, unchanged semantics).
- [ ] `npm run check`; commit `feat: the panel shows and revokes the default instance's Host Access`.

### Task 6: Runtime gate – no `host_command` on `default` without an open MCP panel (Bridge)

**Repo:** webmcp-bridge, branch `e2/mcp-panel-gate` from `e1/webmcp-extension-label` (5043533); mirror the same change into webmcp-runtime so the two copies stay identical.

**Files:** `native/host/host-command.js`; test `tests/host-command*.test.js` (Bridge) and the runtime's copy.

- [ ] Failing tests: with a valid `full-host` lease on `default`, `run` returns `HOST_ACCESS_NOT_GRANTED` ("needs an open WebMCP ChatGPT (MCP) panel") when `~/.chatgpt-embedded-panel/browser-mcp.sock` does not accept a connection, and runs when it does; `read`/`cancel` of an already started session follow the same rule; the `webmcp` instance is unaffected.
- [ ] Implement `panelOpen()` (connect with a 1 s timeout, then close) checked after `verifiedLease()` for `instanceId === 'default'`; the socket path is an option with that default.
- [ ] `npm test`; commit.

### Task 7: App label and App release

**Repo:** webmcp-bridge, same branch.

- [ ] Self-test first: `instanceDisplayName("default") == "ChatGPT (MCP)"`; then change the label; `npm run test:menubar`, `npm run lint`, `npm test`.
- [ ] Build the App release archive (as P1: fresh clone, release script, SHA256); record artifact id and checksum.
- [ ] Commit `feat: the App names the default instance "ChatGPT (MCP)"`.

### Task 8: The extension pins the new App release

- [ ] `runtime.lock.json` → the Task 7 artifact (url stays empty until published); verify it with `verifyRelease` and that every module the extension imports loads (as in E1); `npm run check`; commit.

### Task 9: Review and owner-Mac acceptance (needs the owner's go)

- [ ] Independent read-only review of Tasks 1–8 (Codex when available, otherwise a read-only reviewer the owner approves).
- [ ] Back up first (as E1 Task 8): the old panel's `com.webmcp.browser.json` files, `~/.chatgpt-embedded-panel`, `~/.config/tunnel-client/browser-mcp.yaml`, `~/Applications/WebMCP Menu.app`.
- [ ] Install the App release and the extension; doctor passes.
- [ ] Owner checks (Chrome, then Comet):
  1. `ChatGPT (MCP)`: a connector call runs a browser tool on a normal page (inspect_page, click) and on an accessible iframe.
  2. Grant `ChatGPT (MCP)` Host Access in the App → the panel shows HOST ACCESS in red with countdown and Revoke; `host_command pwd` works.
  3. Panel Revoke ends it; closing the panel ends it; reloading the extension ends it; switching provider ends it.
  4. Fail-closed: grant, close the MCP panel, call `host_command` from ChatGPT → `HOST_ACCESS_NOT_GRANTED`.
  5. `ChatGPT (Web)` and `DeepSeek` still complete a tool call; login/logout from a normal tab is followed by the panel.

### Task 10: Retire the old ChatGPT Embedded Panel (only after Task 9 passes)

- [ ] Remove the old panel's ID from `com.webmcp.browser` (installer) and ask the owner to remove the old extension from the browsers.
- [ ] Archive `zengtao227/chatgpt-embedded-panel` on GitHub (owner confirms first); update the spec, `TWO-LEVELS-PLAN.md`, memory.
- [ ] Push `e2/webmcp-extension` and the Bridge branch; post-push sanity (SHAs match, fresh-clone check).
