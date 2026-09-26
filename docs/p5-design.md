# P5 design — easy install, one-click Work, in-extension settings

Status: **historical P5 design.** The original design was agreed on 2026-09-15. On 2026-09-26 the access model was simplified: Full access / Full Working Access was retired. The current product has two levels: the chosen folder (writable, set in Settings) and Temporary Full Host Access — High Trust. Several folders with per-folder Write, managed in the WebMCP App, arrive with the shared WebMCP instance. Historical sections below are retained only where useful to explain prior implementation decisions.

Distribution model: **B** — public source on GitHub, MIT, for the owner and a few friends; not on the Chrome Web Store. Every user uses their own DeepSeek account (Terms of Use §2.3) and accepts the §3.5(3) automation risk stated in the README.

## 1. Why DeepSeek behaves differently from ChatGPT WebMCP

ChatGPT calls MCP tools server-side: the tool result goes back to the model inside OpenAI's service, independent of what the browser shows. DeepSeek Web has no tool support, so this extension works **through the visible page**: it reads the reply DeepSeek renders, runs the tool locally, types the result into the visible composer and clicks Send. It can only act on the conversation that is currently displayed in a tab. Every design choice below follows from that.

## 2. Owner decisions

| Topic | Decision |
|---|---|
| Start | A **Work** toggle in the extension popup, plus shortcut ⌥⇧W |
| Scope of Work | Per **tab**, not per conversation |
| New conversation while Work is on | Tool instructions are pre-filled into the empty composer automatically; the user types the task and presses Enter; no `hello`, no second click |
| Switching conversations in the same tab | Work pauses; pending results are kept and delivered when the user returns |
| Viewing another conversation meanwhile | Open it in another tab; the working tab continues (to be verified live, see §8) |
| Tool-call limit | **None**. Stop = Work off or close the tab |
| Workspace default | The folder chosen last time; an **Other…** button opens the macOS folder dialog |
| Access model | **Superseded:** no Full access / Full Working Access tier. Current model = the chosen folder + Temporary Full Host Access — High Trust. |
| Install | One Terminal line (`curl … \| bash`), then drag the `extension` folder into `chrome://extensions` |
| Uninstall | One button in the popup; removes local runtime, config, image **and the code folder**, then the extension removes itself |

## 3. User flows

**Install**
1. Install and start Docker Desktop.
2. Paste one Terminal line. The script checks Docker and Node.js 22+ (and says where to get them), clones to `~/deepseek-webmcp`, builds the runtime image, shows the macOS folder dialog for the default workspace, then opens `chrome://extensions` and the `extension` folder in Finder.
3. Turn on Developer mode and drag the `extension` folder onto the page. The extension ID is pinned by the manifest `key`, so nothing has to be copied.

**Use**
1. On `chat.deepseek.com`, click the icon → **Work** (or ⌥⇧W).
2. In a new chat the instructions are already in the composer; type the task, press Enter.
3. DeepSeek works on its own. Click **Work** again to stop.

**Uninstall**: popup → **Uninstall** → confirm in the macOS dialog.

## 4. Work mode (browser side)

Replaces per-conversation ARM, READY handshake and the six-call loop bound.

- Authority is stored per tab in `chrome.storage.session` (unchanged mechanism): `{ work: true, bindings }`.
- A conversation becomes bound the first time a tool call is observed in it while the tab is in Work mode, including the `/` → `/a/chat/s/<uuid>` transition of a brand-new chat.
- Each tool call is recorded with the conversation URL it came from. Its result is delivered only into that conversation.
- **Pause/resume**: if the tab shows a different conversation when a result arrives, the result is kept (per conversation, session storage). When that conversation is displayed again, the pending result is typed and sent. If DeepSeek finished a reply while the user was away, the newest assistant reply is processed once on return; call-id deduplication per conversation prevents double execution.
- Replay protection stays: history loaded on reload never executes, only replies newer than the conversation's last processed call.
- Strict parser, one call per reply, marker neutralization and the tool contract restated in every result stay unchanged.
- Instruction pre-fill: when Work is on and an empty new-chat composer appears, the contract text (today's starter prompt without the READY line) is inserted; the user's own text is never overwritten.
- `MAX_AGENT_LOOPS` is removed. Stop paths: Work off, tab closed, extension reload.
- Shortcut: `chrome.commands` (no extra permission).

## 5. Settings through the Native host (local side)

The popup sends settings requests through the existing one-shot Native Messaging host. They are **separate from tool calls**: background only forwards them from popup UI messages, never from page content or model output, and the host distinguishes them from tool requests by a fixed envelope type.

| Request | Host action | Human gate |
|---|---|---|
| `status` | return folder, mode, lease expiry | none (read-only) |
| `choose-folder` | macOS `choose folder` dialog, validate, write config | the system dialog itself |
| `uninstall` | confirmation dialog, remove manifest, `~/.deepseek-webmcp`, image and the recorded code folder | system confirmation dialog |

A page or model cannot trigger these silently: dialogs require a physical click on the Mac, and nothing reachable from DeepSeek content sends them.

## 6. Runtime access (container side)

**Folder mode (default)** — the chosen project or parent workspace is the writable bind; protected DeepSeek control-plane subtrees beneath it are masked. Network remains off, execution is non-root with capabilities dropped and `no-new-privileges`, the Docker socket is absent, and each call uses a fresh container.

**No intermediate Full access mode.** The chosen folder is the only Docker filesystem scope; owner Home and protected control-plane roots are refused as the folder, and protected paths inside it are masked. If work genuinely requires direct Mac filesystem/process/network authority outside those mounts, the owner explicitly grants **Temporary Full Host Access — High Trust**, which authorizes `host_command` for a bounded lease without changing the Docker mount policy.

## 7. Install/uninstall scripts

- `install.sh` (one line from README): preflight → download the pinned release archives into `~/deepseek-webmcp` (superseded 2026-09-24: no Git clone; see migration-manifest.md) → `npm run setup` → folder dialog if no previous choice → open Chrome extensions page and Finder.
- `npm run setup` keeps the last folder; `npm run doctor` stays for troubleshooting.
- Uninstall deletes the code folder only if it is the path recorded at install and is a git checkout of `zengtao227/deepseek-webmcp`; it never deletes the workspace folder or the home directory.

## 8. Verification plan

Automated: Work-mode authority and bindings, pause/resume delivery, deduplication across resume, no loop bound, settings envelope separated from tools, the chosen folder's mount and control-plane masks, Host Access lease checks, and uninstall path guards.

Live (owner Mac, Chrome + Docker), one fresh run:
1. uninstall current dev install → one-line install → drag extension → doctor OK;
2. Work → task in a new chat completes with more than six tool calls;
3. switch to another conversation mid-task and back → resumes, no duplicate call;
4. Cmd+click another conversation into a new tab while working → **verify** the background tab keeps continuing (Chrome throttles background tabs; if it does not, document "stay on the tab or come back to resume");
5. Other… folder dialog changes the workspace;
6. the chosen folder is the only mount; granting Temporary Full Host Access leaves it unchanged, enables a bounded host command, and revoke makes a new host command fail;
7. popup Uninstall removes runtime, config, image, code folder and the extension.
