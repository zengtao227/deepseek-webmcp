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
| Regenerate under the latest answer starts a new answer | PASS (owner-reported) |
| Share under the latest answer opens DeepSeek's share dialog and a share link was created | PASS (owner-reported) |
| Rich answer rendering (headings, lists, code, quotes, tables, links) and Copy | automated tests only; live result not yet reported |
| Close provider → fails closed; work tab closed → session ends | not yet run live |
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

## Panel-first flow (2026-09-21) — automated only, live run pending

Changed after the owner's feedback: no popup and no Open Assistant step; the toolbar icon opens the Side Panel, which starts the assistant and reuses one remembered provider window. The first browser tool call locks the page active in the panel's window; **Stop** releases it; a click that opens another page is followed (same handoff logic as the ChatGPT Embedded Panel); commit-like clicks stay with the owner. Folder / Full access / Uninstall moved into the panel's Settings. The page module was replaced by the newer shared one (links, rows, editable regions, safe Reply/Open clicks).

| Area | Result |
|---|---|
| Icon click opens the panel and starts the assistant; second click reuses it and the provider window (no new window) | not yet run live |
| Read and fill the open page from the panel; Stop releases it; page action on another page after Stop | not yet run live |
| Email: Reply/compose opens a popup or new tab, the task follows it, closing it returns | not yet run live |
| Local folder: Settings → Change… to the real projects folder, then list its contents | not yet run live |
| Diagnosis of "workspace shows nothing": the configured folder was `deepseek-webmcp-p4-fixture` (a 4-entry test repo); the runtime itself answered correctly when called directly | found 2026-09-21 |

Manifest change, decided by the owner: `host_permissions` now include `http://*/*` and `https://*/*` (as in the ChatGPT Embedded Panel); `activeTab` and the popup are gone. Browsing history, cookies, network and debugger permissions remain absent.
