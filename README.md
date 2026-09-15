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

## Install (macOS)

Requirements: macOS, Google Chrome or Comet (or another Chromium browser), [Docker Desktop](https://www.docker.com/products/docker-desktop/) running, Node.js 22+.

1. Paste this into Terminal:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/zengtao227/deepseek-webmcp/main/install.sh | bash
   ```
   It checks the requirements, downloads to `~/deepseek-webmcp`, builds the local runtime and asks once which folder DeepSeek may work in.
2. In the browser extensions page that opens, turn on **Developer mode** and drag the `extension` folder (shown in Finder) onto the page.

To update, run the same command again, then click the extension's reload icon and reopen DeepSeek tabs.

## Use

1. Open `https://chat.deepseek.com`, click the DeepSeek WebMCP icon → **Work** (or press ⌥⇧W).
2. Type your task normally and press Enter. The tool instructions are attached to the first message of each new chat automatically.
3. DeepSeek works on its own. You can switch to other chats meanwhile; the task pauses and continues when you come back. Click **Work** again to stop.

In the popup:

- **Folder / Other…** — the folder DeepSeek may read and change; *Other…* opens the macOS folder dialog.
- **Full access** — temporarily allow the whole home folder (15 min – 1 h, confirmed in a macOS dialog, with a Stop button). DeepSeek WebMCP itself, browser data, shell startup files, SSH/cloud keys and Keychains stay hidden. Anything DeepSeek reads is sent to DeepSeek.

Review changes in your project (for example `git diff`) before running anything on your Mac. Troubleshooting: `cd ~/deepseek-webmcp && npm run doctor`.

## Uninstall

Popup → **Uninstall…** → confirm. This removes the local runtime, settings, Docker image, browser registrations, the `~/deepseek-webmcp` folder and the extension. Your project folders are not touched.

## Current phase

**P1, P2, P3, and P4 are CLOSED / PASS in Google Chrome.** P1 proved the browser continuation loop; P2 proved one-shot Native Messaging + the isolated read-only Docker runtime; P3 proved the real writable bounded coding loop in macOS Chrome + Docker; P4 proved a real autonomous coding task (read → bounded fix → tests → git diff → final answer) on a disposable Git repository (`docs/p4-live-test.md`).

P5 (small-circle distribution: one-line install, per-tab Work, in-extension folder / Full access / uninstall, Chromium browsers including Comet, MIT) is implemented per `docs/p5-design.md`; live acceptance is in progress. The Base/Plus DeepSeek cleanup is merged.

The architecture remains:

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

P3 exposes exactly `open_workspace`, `read`, `write`, `edit`, and `bash`. The owner-selected workspace is mounted **writable** so mutations persist, while the container remains network-disabled, non-root, capability-dropped, no-new-privileges, and fresh per tool call via `docker run --rm`. The bind mount does not recursively include nested mounts.

`bash` can also mutate files inside the selected workspace; `write`/`edit` are structured bounded mutation tools, not a claim that they are the only mutation path. Git credentials/publication are not exposed and the product does not auto-commit or push.

P3 automated checks are part of `npm run check`; its successful real Chrome + Docker acceptance is recorded in `docs/p3-live-test.md`.

See `CONTEXT.md` for the product boundary and `docs/development-roadmap.md` for phase gates.
