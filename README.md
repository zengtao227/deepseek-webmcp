# DeepSeek WebMCP

DeepSeek WebMCP is an experimental local coding bridge for the **free, logged-in DeepSeek Web UI** at `https://chat.deepseek.com`.

The goal is to let DeepSeek Web act as the model/governance layer while a separately constrained local runtime provides bounded local coding tools.

## What this is not

- not a DeepSeek API client;
- not DeepSeek Harness;
- not an unofficial DeepSeek API proxy;
- not a generic browser-automation framework;
- not a server-side multi-account service.

## Before you use it

- **Use your own DeepSeek account.** Never share accounts (DeepSeek Terms of Use §2.3).
- **Terms risk is yours.** DeepSeek's Terms of Use §3.5(3) prohibit capturing service content "using any robots, spiders, or other automatic setups". This extension reads DeepSeek's replies in your browser and sends tool results for you, which may fall under that clause and could lead to account restrictions. Use it at your own risk.
- **Personal/small-circle tool.** It is not published on the Chrome Web Store.
- Provided under the MIT License, without warranty.

## Install

The easiest way on **macOS and Windows** is **WebMCP Setup** ([webmcp-setup releases](https://github.com/zengtao227/webmcp-setup/releases/latest)): double-click it, choose DeepSeek, choose a folder. On Windows it installs WSL, Docker Desktop and a private Node.js, runs DeepSeek WebMCP inside WSL, and registers it with Chrome and Edge. On Windows, **Full access** and **Temporary Full Host Access** are not available yet.

### macOS by hand

Requirements: macOS 15 Sequoia or newer (Docker Desktop's minimum), Google Chrome, Microsoft Edge or Comet (or another Chromium browser), [Docker Desktop](https://www.docker.com/products/docker-desktop/) running, Node.js 22+. Git is not needed.

1. Paste this into Terminal:
   ```bash
   cd ~ && curl -fsSLO https://github.com/zengtao227/deepseek-webmcp/releases/latest/download/install.sh && bash install.sh
   ```
   It checks the requirements before changing anything, downloads the pinned, checksum-verified release to `~/deepseek-webmcp`, builds the local runtime and asks once which folder DeepSeek may work in. If something fails it saves `~/deepseek-webmcp-install-report.txt`; send that file to whoever asked you to test.
2. In the browser extensions page that opens, turn on **Developer mode** and drag the `extension` folder (shown in Finder) onto the page.

To update, run the same command again, then click the extension's reload icon and reopen DeepSeek tabs.

## Use

Click the DeepSeek WebMCP icon on any webpage: the Side Panel opens beside it and the assistant starts. DeepSeek itself runs in its own window, which is created once and reused; you work in the panel. **Keep a strip of that window uncovered** (for example at a screen edge): macOS marks a fully covered window hidden and DeepSeek then renders no answer; the panel pauses and tells you to press Restore after you uncover it.

1. Ask in the panel. To read or fill the page in front of you, just say so; the first page action locks the page that is open in this window.
2. The task stays on that page. **Stop** releases it; the next page action locks whichever page is open then, so switching pages means going there and asking again.
3. A click that opens another page (for example Reply in a mail app, or a popup) is followed, and closing that page returns to the one you came from.
4. Page actions use semantic DOM refs; the model cannot choose arbitrary tabs or use selectors/XPath. It may open, read, fill and scroll (a long page or an inner list: `inspect_page` lists what is on screen first, and `scroll` moves the page or the list). **Submit, send, pay, delete and other commit-like clicks are never pressed by the assistant** (`CONFIRMATION_REQUIRED`): you press them.
5. For local files, ask it to work in your folder (see Settings). Coding tools run in an isolated Docker container on that folder only.

The old in-page flow still works: on `chat.deepseek.com` press ⌥⇧W to turn **Work** on for that tab and type your task there.

Use `docs/browser-v1-live-test.md` for the first deterministic browser acceptance run; do not begin with an important production site.

In the panel, **Settings**:

- **Folder / Change…** — the project or parent workspace DeepSeek may read and change; *Change…* opens the macOS folder dialog. If that root contains DeepSeek WebMCP's own control plane, the protected subtree is masked from the container. Choose only a folder you actually want to expose (for example your projects folder), not a test fixture.
- **Full access** — temporarily allow the whole home folder (15 min – 1 h, confirmed in a macOS dialog, with a Stop button). DeepSeek WebMCP itself, browser data, shell startup files, SSH/cloud keys and Keychains stay hidden. Anything DeepSeek reads is sent to DeepSeek.
- **Temporary Full Host Access — High Trust** — a separate owner-approved lease (maximum 60 minutes) enables `host_command` as your Mac user. It can access files, Docker, network, processes and credentials available to that user. `bash` remains in Docker; normal folder/Full access settings are unchanged. Revoke from Settings at any time. This mode requires the installed WebMCP Bridge immutable runtime.

Review changes in your project (for example `git diff`) before running anything on your Mac. Troubleshooting: `cd ~/deepseek-webmcp && npm run doctor`.

## Permissions

The extension asks the browser for:

| Permission | Why |
|---|---|
| `https://chat.deepseek.com/*` | the DeepSeek page it drives in its own window |
| `http://*/*`, `https://*/*` (all sites) | so the assistant can read and fill the page you have open, once you ask it to; nothing is read from a page until your first page request locks it |
| `scripting` | to inject the page reader into that locked page |
| `sidePanel` | the panel you work in |
| `storage` | the panel session and settings |
| `nativeMessaging` | to reach the local runtime for coding tools in Docker |

Not requested: browsing history, cookies, network inspection, debugger, or the general `tabs` permission. The assistant cannot choose arbitrary tabs or run selectors; password field values are not read; Submit, send, pay and delete clicks are left to you.

**What leaves your machine:** everything the assistant reads from the page or from your chosen folder becomes part of the conversation with DeepSeek's website. Choose the narrowest folder, and do not ask it to read pages that show secrets.

## Uninstall

Panel → **Settings** → **Uninstall…** → confirm. This removes the local runtime, settings, Docker image, browser registrations, the `~/deepseek-webmcp` folder and the extension. Your project folders are not touched.

The local part is shared by all browsers: after Uninstall in one browser, the extension in any other browser shows *Local program not installed*, and its **Uninstall…** just removes that extension. To use DeepSeek WebMCP again, run the install command.

## Current phase

**P1, P2, P3, and P4 are CLOSED / PASS in Google Chrome.** P1 proved the browser continuation loop; P2 proved one-shot Native Messaging + the isolated read-only Docker runtime; P3 proved the real writable bounded coding loop in macOS Chrome + Docker; P4 proved a real autonomous coding task (read → bounded fix → tests → git diff → final answer) on a disposable Git repository (`docs/p4-live-test.md`).

P5 (small-circle distribution: one-line install, per-tab Work, in-extension folder / Full access / uninstall, Chromium browsers including Comet, MIT) is implemented per `docs/p5-design.md` and passed live acceptance in Chrome and Comet (`docs/p5-live-test.md`). The Base/Plus DeepSeek cleanup is merged.

The coding architecture remains:

```text
DeepSeek assistant output
  → strict WebMCP tool call
  → Chrome extension
  → one-shot Chrome Native Messaging host
  → fresh isolated Docker runtime
  → bounded real tool result
  → Secret Firewall
  → normal DeepSeek compose/send
```

Browser WebMCP V1 reuses the same DeepSeek planner/continuation loop but dispatches only the five browser tools directly to the one owner-attached tab:

```text
normal DeepSeek Web
  → existing WebMCP one-call loop
  → inspect_page / inspect_form / fill / select / click / scroll / keyboard
  → owner-attached real browser tab
  → semantic DOM
```

No Playwright/Selenium server, screenshot/OCR navigation, generic JavaScript tool, or new native daemon is added for this browser path.

P3 exposes exactly `open_workspace`, `read`, `write`, `edit`, and `bash`. The owner-selected workspace is mounted **writable** so mutations persist, while the container remains network-disabled, non-root, capability-dropped, no-new-privileges, and fresh per tool call via `docker run --rm`. The bind mount does not recursively include nested mounts.

`bash` can also mutate files inside the selected workspace; `write`/`edit` are structured bounded mutation tools, not a claim that they are the only mutation path. Git credentials/publication are not exposed and the product does not auto-commit or push.

P3 automated checks are part of `npm run check`; its successful real Chrome + Docker acceptance is recorded in `docs/p3-live-test.md`.

See `CONTEXT.md` for the product boundary and `docs/development-roadmap.md` for phase gates.
