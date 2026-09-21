# P6 live acceptance — Compact Assistant (Side Panel)

Status: **Partly PASS in the owner's real macOS Google Chrome (2026-09-20 / 2026-09-21).** Several items below are still open. Design: `docs/p6-compact-assistant-roadmap.md`; hand-off: `docs/p6-implementation-handoff.md`.

Results marked "owner-reported" were run and reported by the owner; nothing here is inferred from automated tests unless it says so.

## Checked live

| Area | Result |
|---|---|
| Popup → Open Assistant: Side Panel opens at once, provider window is created, work window regains focus | PASS (owner-reported) |
| Prompt sent entirely from the Side Panel; DeepSeek answers; answer shown in the panel | PASS (owner-reported, after finding 2) |
| Close and reopen the Side Panel: earlier conversation is still there | PASS (owner-reported) |
| Provider minimized → Restore, provider window partly uncovered | PASS (owner-reported) |
| Provider window **completely covered** by the work window | **FAIL — macOS limitation; handled by product rule "keep a strip uncovered"** (finding 1) |
| Browser task from the Side Panel on the attached work page (P6-C1) | PASS (owner-reported) |
| Regenerate under the latest answer starts a new answer | PASS (owner-reported); **E2E 覆盖** (S8, against the mock bar built from the recorded icons) |
| Share under the latest answer opens DeepSeek's share dialog and a share link was created | PASS (owner-reported); **E2E 覆盖** for pressing exactly one control and the changed-icon / duplicate diagnostic (S8); the real share dialog stays manual |
| Rich answer rendering (headings, lists, code, quotes, tables, links) and Copy | PASS (owner-reported 2026-09-21): heading, bold, monospace inline code, clickable link, bullets, code block with background, quote with bar and indent, table with cells all render; Copy pastes the answer text (code block has no banner text). **E2E 覆盖** rendering (S3) |
| Close provider → fails closed | not yet run live. **E2E 覆盖** close provider → paused, prompts refused, Restore opens a new provider and re-arms the tools (S9), and a hidden provider pauses and refuses a completing tool call (S10) |
| Close the page the task is locked to | PASS (owner-reported 2026-09-21): the task becomes blocked, the header shows "Paused: <title>" and Stop stays; the next page action returns `TASK_BLOCKED … Press Stop`; **the assistant itself keeps running** (it does not end the session). The "Paused" line was easy to miss, so the panel now also shows a notice (`aab4e35`). **E2E 覆盖** (S7b) |
| Legacy DeepSeek-page Work, local coding tools, Browser V1 regression | not yet run live |

## Findings fixed during acceptance

1. **Hidden provider window.** A provider window created without focus, or restored from minimized, could report `visibilityState === "hidden"`, and DeepSeek renders no answer DOM while hidden. The window is now focused once, the worker waits until the page reports `visible`, then focus returns to the work window. The `PROVIDER_HIDDEN` fail-closed check is unchanged.
   **Decided 2026-09-21 (owner):** a provider window that is *fully* covered goes hidden again, because macOS window occlusion marks it hidden; it works while some part stays uncovered. Product rule: keep a strip of the provider window uncovered. The panel's PROVIDER_HIDDEN notice and the README say so; there is no automatic placement, because a maximized work window leaves no free area to place it in.
2. **Prompt accepted but reported as not accepted.** `sendText()` only treated an empty composer as confirmation. It now also accepts a detached composer, generation starting, or the route moving to `/a/chat/s/...`.
3. **Session write race.** Snapshots, tool events, pause and status polling each read the whole `assistant.session` and wrote it back, so a slow update could erase a newer one. All access now goes through one queue and applies to the latest stored session; stale updates after Stop or a provider change are dropped.
4. **Failed prompt stayed in history.** A prompt DeepSeek did not accept is withdrawn from the panel history (kept only if the provider already shows a reply).
5. **"No browser tab attached".** The tool contract only said tools act on a tab "I explicitly attached". It now says when a page is attached, and the first assistant prompt of a session carries the contract even in an existing conversation. A stale first-sentence marker in `content.js` (used to fold the instructions) was corrected.
6. **Flattened answers.** The panel now receives a small block structure (paragraphs, headings, lists, code, quotes, tables, links, inline styles), validated again in the worker and rebuilt with `createElement` + `textContent`. Link targets are limited to http, https and mailto.
7. **Regenerate and Share could not find their buttons.** DeepSeek's action bar is six icon-only buttons in one `div.ds-flex`. A diagnostic run identified them from the icon shapes and the owner confirmed both actions work:

   | Button | Icon | Recognised by |
   |---|---|---|
   | Copy | two overlapping rounded squares | not used (Copy is done in the panel) |
   | Regenerate | circular arrow | `viewBox 0 0 16 16` + one path, 582 characters, exact match |
   | Like / Dislike | thumbs up / down | not used |
   | Read aloud | speaker | `aria-label` 朗读, not used |
   | Share | right-curving arrow | `viewBox 0 0 16 16` + one path, 894 characters, exact match |

   A button is pressed only when exactly one control in the latest answer's action bar matches, by its name if it has one, otherwise by its icon. Zero or several matches, or a scope that also holds an older answer, press nothing and show a diagnostic in the panel. Position is never used. If DeepSeek changes these icons the actions stop with a diagnostic; they do not click something else.

## Behavior to know

- Share presses DeepSeek's own control and brings the DeepSeek window forward; the owner finishes or cancels the dialog there. Completing it publishes a **public link** to the conversation.
- Regenerate replaces the current answer, as it does on DeepSeek. History entries only get Copy, because DeepSeek's Regenerate and Share act on its latest reply.
- The panel's polling used to rebuild history every 500 ms; history and the current answer now rebuild only when they change.

## Automated

`npm run check`: 197 tests, 197 pass, 0 fail.

## E2E coverage (2026-09-21)

`npm run e2e` drives a real Chromium, the unpacked extension and its real Side Panel against a mock `chat.deepseek.com` and local fixture pages (`e2e/README.md`, `docs/dev-test-automation-plan.md`). It replaces manual checking of the rows marked **E2E 覆盖** above, **against the mock only**: it cannot tell whether real DeepSeek changed. Still manual, on the owner's machine:

- toolbar icon opens the Side Panel (needs a user gesture)
- the real DeepSeek page: login, DOM changes, the real share dialog, Copy to the clipboard
- whether a fully covered provider window turns hidden (macOS occlusion; E2E only checks the fail-closed reaction to a page that reports hidden)
- provider minimized → Restore; close and reopen the panel keeps the conversation
- local folder picker, Full access and Uninstall dialogs, real Docker runtime

## Panel-first flow (2026-09-21) — automated only, live run pending

Changed after the owner's feedback: no popup and no Open Assistant step; the toolbar icon opens the Side Panel, which starts the assistant and reuses one remembered provider window. The first browser tool call locks the page active in the panel's window; **Stop** releases it; a click that opens another page is followed (same handoff logic as the ChatGPT Embedded Panel); commit-like clicks stay with the owner. Folder / Full access / Uninstall moved into the panel's Settings. The page module was replaced by the newer shared one (links, rows, editable regions, safe Reply/Open clicks).

| Area | Result |
|---|---|
| Icon click opens the panel and starts the assistant; second click reuses it and the provider window (no new window) | PASS (owner-reported 2026-09-21). **E2E 覆盖** start and reuse of the provider window (S1, S2); the toolbar-icon click itself is not covered |
| Read and fill the open page from the panel; Stop releases it; page action on another page after Stop | Partly PASS (owner-reported 2026-09-21): reading a real page worked. Fill, Submit refusal and Stop on a real page were not reported. **E2E 覆盖** (S4 read, S5 fill/select and Submit refused, S7 Stop) on fixture pages |
| Email: Reply/compose opens a popup or new tab, the task follows it, closing it returns | Partly (owner-reported 2026-09-21): on a real webmail the Reply click worked, but the message body could not be filled: the assistant reported the editor is not exposed as a fillable control. **Known gap, cause not investigated** (the executor fills `contenteditable="true"` and `role=textbox` editors, so this webmail's editor is likely in an iframe / shadow DOM or marked differently). Whether the task followed the compose page was not reported. **E2E 覆盖** (S6) on the fixture mail page: new tab, popup, same-tab navigation, an unrelated tab is not adopted |
| Extension reload with the provider window open, then the panel is opened again: same provider, no new window, prompts work | PASS (owner-reported 2026-09-21, real Chrome). **E2E 覆盖** (reload scenario, `e2e/reload.e2e.mjs`) |
| Local folder: Settings → Change… to the real projects folder, then list its contents; local coding tools and Docker on it | PASS (owner-reported 2026-09-21) |
| Uninstall… and Full access… show their confirmation dialogs (cancelled, nothing changed) | PASS (owner-reported 2026-09-21) |
| Diagnosis of "workspace shows nothing": the configured folder was `deepseek-webmcp-p4-fixture` (a 4-entry test repo); the runtime itself answered correctly when called directly | found 2026-09-21 |

Manifest change, decided by the owner: `host_permissions` now include `http://*/*` and `https://*/*` (as in the ChatGPT Embedded Panel); `activeTab` and the popup are gone. Browsing history, cookies, network and debugger permissions remain absent.
