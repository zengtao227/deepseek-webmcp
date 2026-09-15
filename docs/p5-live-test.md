# P5 live acceptance — small-circle distribution

Status: **PASS in the owner's real macOS Google Chrome and Comet + Docker environment (2026-09-15).** Design: `docs/p5-design.md`.

## Checked live

| Area | Result |
|---|---|
| Work toggle per tab, ⌥⇧W, badge ON | PASS (Chrome) |
| Instructions attached to the first message, user text first | PASS (Chrome) |
| No call limit (7, 10 and 11 calls in one task) | PASS (Chrome) |
| Switch chats and return → auto-resume; switch right after sending → still starts | PASS (Chrome) |
| Folded chat display: instructions, tool calls, tool results as one line; question in the message text color | PASS (Chrome) |
| Popup Folder / Other… (macOS folder dialog) | PASS (Chrome) |
| Popup Full access: dialog, countdown, Stop hides the countdown | PASS (Chrome) |
| Comet: popup reaches the local runtime; Work + tool calls answer correctly | PASS (Comet, Chromium 141) |
| DSML native tool syntax → format correction | automated tests only (not reproduced live after the fix) |
| Uninstall finished message (macOS dialog) | PASS (Comet) |
| Uninstall in one browser, then the other: popup says the shared local program is gone, shows Copy install command; its Uninstall… removes just that extension via Chrome's dialog | PASS (Comet → Chrome) |
| One-line install from GitHub `main` into `~/deepseek-webmcp`; `npm run doctor` all OK | PASS |
| Popup Uninstall: program folder, settings, Docker image, all 7 browser registrations removed; extension removed itself; dev checkout and fixture untouched | PASS |

## Findings fixed during acceptance

1. **Question hidden behind instructions.** DeepSeek collapses long user messages; the task now comes first and the instructions follow a `---` line.
2. **DeepSeek native tool syntax.** After two correct calls DeepSeek once answered with its own `<｜｜DSML｜｜ invoke name="bash">` syntax. It is never executed; a format correction restating the WebMCP contract is sent, at most twice in a row per conversation. Not yet observed live after the fix.
3. **Chat clutter.** DeepSeek Web has no hidden instruction channel, so WebMCP messages are real text. They are folded with data attributes and CSS only (click to expand). Live DOM: visible user text is a `<span>` inside `.ds-message`; the bubble box has color `rgb(128,0,128)` and the text `rgb(249,250,251)`, so the summary takes the text color.
4. **Comet "Local runtime not reachable".** The native host answered `ok:true` (launch log), but every reply to the popup and content script arrived as `undefined`: returning a Promise from `runtime.onMessage` is supported only from Chrome 148, rolled out gradually (developer.chrome.com messaging guide). Replies now use `sendResponse` + `return true`; the test harness models pre-148 behavior. This also protects Chrome users who have not received the rollout.
5. **Orphaned content script error** (`content.js:157`) after an extension reload with DeepSeek open: a synchronous `sendMessage` throw is now caught and ignored.
6. **Popup rows never hid.** `.row { display: flex }` overrode the `hidden` attribute; `[hidden] { display: none !important }` added.
7. **Uninstall showed no confirmation.** The popup closes behind the macOS dialog and the extension removes itself; the host now shows a detached macOS message when it finishes (not yet seen live). Install output no longer prints the next steps twice, and re-running the installer to update says to reload the extension and reopen DeepSeek tabs.

8. **Shared local program.** All browsers use one local program. After Uninstall in Comet, Chrome showed "host not found" and its Uninstall did nothing. The popup now explains the shared program, offers Copy install command, and removes only its own extension. `management.uninstallSelf` with a confirmation dialog did nothing when called from the service worker; it is now called directly in the popup click (Chrome requires a user gesture for uninstall dialogs).

## Notes

- DeepSeek's own "深度思考" (DeepThink) switch is remembered per browser; WebMCP reads only the final answer either way.
- A second browser's copy of the extension (e.g. Comet) is not removed by Uninstall in another browser.
- The fixture is still clean at `8508afa`.
